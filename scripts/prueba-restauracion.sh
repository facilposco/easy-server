#!/bin/bash
# prueba-restauracion.sh — Prueba semanal de restauración del respaldo de Zeus.
#
# Por qué existe: un respaldo que nunca se restauró es una promesa, no una
# garantía. Este script comprueba, una vez por semana y sin arriesgar el
# servidor real, que el respaldo de la noche anterior de verdad sirve para
# recuperar el negocio: que no está corrupto, que las tablas clave tienen
# las filas que deberían tener, y que se les puede hacer una consulta normal.
#
# Qué hace, en orden:
#   1. Ubica el respaldo comprimido más reciente (el de anoche).
#   2. Verifica que el archivo no esté corrupto o incompleto ANTES de gastar
#      recursos en levantar nada (así una falla se detecta rápido y clara).
#   3. Levanta un contenedor MariaDB temporal y aislado ("zeus-mariadb-prueba"),
#      sin puertos expuestos y con memoria/CPU limitadas, para no competir
#      con el bot ni con los demás contenedores en producción.
#   4. Restaura el respaldo ahí dentro (nunca toca "zeus-mariadb", el real).
#   5. Cuenta filas en 3 tablas clave del negocio y las compara contra el
#      conteo de referencia que quedó guardado la noche del respaldo.
#   6. Corre una consulta de agregación (SUM de ventas de un día) para
#      confirmar que los datos no solo están, sino que se pueden consultar.
#   7. Apaga y borra el contenedor temporal junto con todos sus datos —
#      pase lo que pase, incluso si el script se interrumpe a la mitad
#      (ver la trampa "trap" más abajo).
#   8. Deja constancia del resultado en un historial y avisa por WhatsApp
#      SOLO si algo falló. Si todo sale bien, se queda callado pero el
#      resultado igual queda visible en el panel.
#
# Requisito para que el punto 5 funcione: backup_db.sh necesita guardar el
# conteo de referencia de esas mismas tablas junto con el respaldo. Esa es
# una adición mínima y aparte, propuesta en INTEGRACION-RESTAURACION.md —
# este script NO modifica backup_db.sh. Si ese archivo de referencia todavía
# no existe (por ejemplo, la primera semana antes de aplicar esa adición),
# la prueba igual corre: restaura, cuenta filas y hace la consulta, pero
# avisa que no pudo comparar contra un conteo esperado.
#
# Cron sugerido: 0 10 * * 0  (domingo 5:00 a.m. hora de Colombia; el
# servidor trabaja en UTC — ver INTEGRACION-RESTAURACION.md para el porqué
# de ese horario).

set -u
set -o pipefail

# ── Configuración ─────────────────────────────────────────────────────────
BACKUP_DIR="/opt/zeus-app/backups"
LOG_FILE="/opt/zeus-app/logs/prueba_restauracion.log"
CONTEOS_META="$BACKUP_DIR/.last_backup_counts.json"   # lo escribe backup_db.sh (propuesto)
HIST_JSONL="$BACKUP_DIR/.historial_restauracion.jsonl" # historial completo, una línea por corrida
ULTIMO_JSON="$BACKUP_DIR/.last_test_restauracion.json" # solo la corrida más reciente, para el panel

DB_NAME="${DB_ESQUEMA:-negocio}"
CONTAINER_PROD="zeus-mariadb"        # el real: NUNCA se toca en este script
CONTAINER_TEST="zeus-mariadb-prueba" # el temporal, descartable
TEST_DB_PASS="${TEST_DB_PASS:-PruebaZeus_Temporal_2026}"  # solo existe dentro del contenedor descartable, sin red

OPS="http://127.0.0.1:4900/api/aviso"

MEM_LIMIT="512m"          # tope de memoria del contenedor de prueba (servidor tiene 4 GB en total)
CPU_LIMIT="1"             # como máximo 1 de los 2 CPU del servidor
TIMEOUT_ARRANQUE=90       # segundos máximos de espera a que MariaDB de prueba responda
TIMEOUT_RESTAURACION=600  # 10 minutos: de sobra para ~100 MB comprimidos; si tarda más, algo anda mal
MIN_BYTES_VALIDO=$((1 * 1024 * 1024))  # un respaldo real nunca pesa menos de 1 MB

# Tablas clave del negocio para verificar el conteo de filas tras restaurar.
# Ajustar aquí si el nombre real de alguna tabla difiere en la instalación.
TABLAS_CLAVE=("phppos_sales" "phppos_inventory" "phppos_employee_commissions")

mkdir -p "$BACKUP_DIR" "$(dirname "$LOG_FILE")"

log() { echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] $1" | tee -a "$LOG_FILE"; }

avisar() {
  curl -s --max-time 20 -X POST "$OPS" -H 'Content-Type: application/json' \
    -d "{\"origen\":\"prueba_restauracion\",\"texto\":$(printf '%s' "$1" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')}" >/dev/null 2>&1
}

# Latido para Centinela: avisa que esta tarea terminó (modulos/latidos.js).
# El "|| true" es obligatorio: un latido nunca puede hacer fallar la tarea real.
latir() {  # latir <id> [ok|fallo] [detalle]
  local cuerpo='{}'
  [ "${2:-ok}" = "fallo" ] && cuerpo="{\"ok\":false,\"detalle\":\"${3:-}\"}"
  curl -s -m 10 --retry 3 --retry-delay 20 -X POST \
    -H 'X-Panel-Zeus: 1' -H 'Content-Type: application/json' \
    -d "$cuerpo" "http://127.0.0.1:4900/api/latidos/$1" >/dev/null 2>&1 || true
}

# ── Limpieza garantizada del contenedor temporal ─────────────────────────────
# Este trap corre SIEMPRE que el script termine, sin importar cómo: éxito,
# error, `exit` explícito, o si alguien lo interrumpe (Ctrl+C, timeout,
# reinicio del servidor). Así nunca queda un contenedor de prueba a medio
# arrancar consumiendo memoria, ni datos de prueba ocupando disco.
limpiar() {
  docker rm -f -v "$CONTAINER_TEST" >/dev/null 2>&1
}
trap limpiar EXIT INT TERM

# Por si una corrida anterior murió de forma anómala antes de que existiera
# este trap (por ejemplo, un corte de luz), se limpia cualquier rastro viejo
# antes de empezar.
docker rm -f -v "$CONTAINER_TEST" >/dev/null 2>&1

# ── Registro del resultado (historial + "última corrida" para el panel) ─────
# resultado: "ok" | "fallo"
# motivo: código corto de qué pasó (vacío si resultado="ok")
# detalle: texto legible para humanos con el detalle del motivo
escribir_resultado() { # resultado, motivo, detalle, duracion_seg, conteos_json, agregacion_json
  local resultado="$1" motivo="$2" detalle="$3" duracion="$4" conteos="$5" agregacion="$6"
  local linea
  linea=$(python3 - "$resultado" "$motivo" "$detalle" "$duracion" "$BACKUP_FILE_NOMBRE" "$conteos" "$agregacion" <<'PY'
import json, sys, datetime
resultado, motivo, detalle, duracion, archivo, conteos, agregacion = sys.argv[1:8]
obj = {
    "ts": datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
    "ts_unix_ms": int(datetime.datetime.utcnow().timestamp() * 1000),
    "resultado": resultado,
    "motivo": motivo,
    "detalle": detalle,
    "duracion_seg": int(duracion) if duracion else 0,
    "archivo_probado": archivo,
    "conteos": json.loads(conteos) if conteos else None,
    "agregacion": json.loads(agregacion) if agregacion else None,
}
print(json.dumps(obj, ensure_ascii=False))
PY
)
  echo "$linea" >> "$HIST_JSONL"
  echo "$linea" > "$ULTIMO_JSON"
}

# Corta la ejecución, deja constancia del fallo y avisa por WhatsApp.
# El trap de arriba se encarga de borrar el contenedor de prueba.
fallar() { # motivo, detalle_humano
  local motivo="$1" detalle="$2"
  local duracion=$(( $(date +%s) - INICIO_UNIX ))
  log "ERROR ($motivo): $detalle"
  escribir_resultado "fallo" "$motivo" "$detalle" "$duracion" "${CONTEOS_JSON:-}" "${AGREGACION_JSON:-}"
  avisar "Prueba semanal de restauración del respaldo FALLÓ ($motivo). $detalle Revisa panel.ejemplo.com"
  latir prueba_restauracion fallo "$motivo: $detalle"
  exit 1
}

log "=== Prueba de restauración iniciada ==="
INICIO_UNIX=$(date +%s)
BACKUP_FILE_NOMBRE=""
CONTEOS_JSON=""
AGREGACION_JSON=""

# ── 1. Ubicar el respaldo más reciente ───────────────────────────────────────
BACKUP_FILE=$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'db_*.sql.gz' -printf '%T@ %p\n' 2>/dev/null | sort -n | tail -1 | awk '{print $2}')

if [ -z "$BACKUP_FILE" ]; then
  fallar "sin_respaldo" "No se encontró ningún archivo db_*.sql.gz en $BACKUP_DIR."
fi
BACKUP_FILE_NOMBRE=$(basename "$BACKUP_FILE")
log "Respaldo a probar: $BACKUP_FILE_NOMBRE"

# ── 2. Verificación temprana: descartar un respaldo corrupto o incompleto ───
# Se hace ANTES de levantar el contenedor para no gastar CPU/RAM en un
# archivo que de entrada ya se sabe que está mal.
BYTES=$(stat -c %s "$BACKUP_FILE" 2>/dev/null || echo 0)
if [ "$BYTES" -lt "$MIN_BYTES_VALIDO" ]; then
  fallar "respaldo_incompleto" "El respaldo pesa solo $BYTES bytes, muy por debajo de lo normal (un respaldo real pesa decenas de MB). Parece incompleto."
fi

if ! gzip -t "$BACKUP_FILE" 2>/dev/null; then
  fallar "respaldo_corrupto" "El archivo $BACKUP_FILE_NOMBRE no pasó la verificación de integridad gzip. Está corrupto."
fi
log "Verificación de integridad OK ($((BYTES / 1048576)) MB)"

# ── 3. Cargar el conteo de referencia guardado la noche del respaldo ─────────
# Si el archivo de metadatos no existe todavía (por ejemplo, antes de aplicar
# la adición propuesta a backup_db.sh), la prueba sigue: restaura y consulta
# igual, solo que no podrá comparar contra un número esperado. Eso se avisa
# de forma clara, no se trata como una falla del respaldo.
CONTEOS_REFERENCIA="{}"
SIN_REFERENCIA=1
if [ -f "$CONTEOS_META" ]; then
  REFERENCIA_ARCHIVO=$(python3 -c "import json; print(json.load(open('$CONTEOS_META')).get('archivo',''))" 2>/dev/null)
  if [ "$REFERENCIA_ARCHIVO" = "$BACKUP_FILE_NOMBRE" ]; then
    CONTEOS_REFERENCIA=$(python3 -c "import json; print(json.dumps(json.load(open('$CONTEOS_META')).get('conteos',{})))" 2>/dev/null || echo "{}")
    SIN_REFERENCIA=0
    log "Conteo de referencia cargado desde $(basename "$CONTEOS_META")"
  else
    log "AVISO: el conteo de referencia guardado es de otro archivo ($REFERENCIA_ARCHIVO), no del respaldo de hoy. Se prueba sin comparar conteos."
  fi
else
  log "AVISO: no existe $CONTEOS_META todavía (falta aplicar la adición a backup_db.sh). Se prueba sin comparar conteos."
fi

# ── 4. Levantar el contenedor MariaDB temporal, aislado y liviano ───────────
# - Mismo nombre de imagen que el contenedor real, para restaurar sobre la
#   misma versión de MariaDB (evita sorpresas de compatibilidad).
# - --network none: no expone NINGÚN puerto, ni siquiera hacia los demás
#   contenedores. `docker exec` funciona igual, porque no pasa por la red.
# - --memory / --cpus: topes duros para no competirle recursos al bot real
#   ni a los otros 7 contenedores que ya corren en el servidor.
# - --skip-log-bin y buffer pool chico: la prueba no necesita binlog ni
#   mucha caché, así se restaura más rápido y con menos memoria.
IMAGEN=$(docker inspect --format='{{.Config.Image}}' "$CONTAINER_PROD" 2>/dev/null)
if [ -z "$IMAGEN" ]; then
  IMAGEN="mariadb:10.11"
  log "AVISO: no se pudo leer la imagen de $CONTAINER_PROD, se usa por defecto $IMAGEN"
fi

log "Levantando contenedor temporal '$CONTAINER_TEST' (imagen: $IMAGEN, memoria: $MEM_LIMIT, cpu: $CPU_LIMIT)..."
docker run -d \
  --name "$CONTAINER_TEST" \
  --network none \
  --memory "$MEM_LIMIT" \
  --memory-swap "$MEM_LIMIT" \
  --cpus "$CPU_LIMIT" \
  -e MYSQL_ROOT_PASSWORD="$TEST_DB_PASS" \
  -e MARIADB_ROOT_PASSWORD="$TEST_DB_PASS" \
  -e MYSQL_DATABASE="$DB_NAME" \
  "$IMAGEN" \
  --skip-log-bin --innodb-buffer-pool-size=192M --innodb-flush-log-at-trx-commit=2 --skip-name-resolve \
  >/dev/null 2>>"$LOG_FILE"

if [ $? -ne 0 ]; then
  fallar "contenedor_no_arranco" "docker run devolvió error al crear $CONTAINER_TEST. Puede ser falta de memoria libre o imagen no disponible localmente."
fi

# ── Esperar a que MariaDB de prueba esté lista para recibir conexiones ──────
LISTO=0
INTENTOS=$((TIMEOUT_ARRANQUE / 2))
for i in $(seq 1 "$INTENTOS"); do
  # OJO: no sirve `mysqladmin ping` aquí. Ese comando responde "vivo" en
  # cuanto el servidor contesta algo, incluso si todavía está inicializando y
  # rechaza la contraseña — y entonces la restauración arranca demasiado
  # pronto y muere con "Access denied". Hay que hacer una consulta real, que
  # solo pasa cuando el usuario root ya quedó configurado de verdad.
  if docker exec "$CONTAINER_TEST" mysql -uroot -p"$TEST_DB_PASS" -N -B -e "SELECT 1" >/dev/null 2>&1; then
    LISTO=1
    break
  fi
  # Si el contenedor murió (por ejemplo, sin memoria), no tiene sentido seguir esperando.
  ESTADO=$(docker inspect -f '{{.State.Running}}' "$CONTAINER_TEST" 2>/dev/null)
  if [ "$ESTADO" != "true" ]; then
    break
  fi
  sleep 2
done

if [ "$LISTO" -ne 1 ]; then
  RAZON=$(docker logs "$CONTAINER_TEST" 2>&1 | tail -20)
  fallar "contenedor_no_respondio" "MariaDB de prueba no quedó lista en ${TIMEOUT_ARRANQUE}s. Últimas líneas del contenedor: $(printf '%s' "$RAZON" | tr '\n' ' ' | cut -c1-500)"
fi
log "Contenedor temporal listo para recibir la restauración"

# ── 5. Restaurar el respaldo dentro del contenedor temporal ─────────────────
log "Restaurando $BACKUP_FILE_NOMBRE dentro de $CONTAINER_TEST..."
INICIO_RESTAURACION=$(date +%s)
timeout "$TIMEOUT_RESTAURACION" bash -c "
  gunzip -c '$BACKUP_FILE' | docker exec -i '$CONTAINER_TEST' mysql -uroot -p'$TEST_DB_PASS' '$DB_NAME'
"
CODIGO_RESTAURACION=$?
DURACION_RESTAURACION=$(( $(date +%s) - INICIO_RESTAURACION ))

if [ "$CODIGO_RESTAURACION" -eq 124 ]; then
  fallar "restauracion_muy_lenta" "La restauración no terminó en $((TIMEOUT_RESTAURACION / 60)) minutos y se canceló. Puede indicar un respaldo mucho más grande de lo normal o el servidor muy cargado."
elif [ "$CODIGO_RESTAURACION" -ne 0 ]; then
  fallar "fallo_restauracion" "El volcado se cortó con errores de SQL al restaurarlo (código $CODIGO_RESTAURACION). El respaldo podría estar corrupto en su contenido, aunque el archivo comprimido en sí esté íntegro."
fi
log "Restauración completada en ${DURACION_RESTAURACION}s"

# ── 6. Verificar conteo de filas en las tablas clave ─────────────────────────
CONTEOS_OBTENIDOS="{}"
DIFERENCIAS=""
for TABLA in "${TABLAS_CLAVE[@]}"; do
  CONTEO=$(docker exec "$CONTAINER_TEST" mysql -uroot -p"$TEST_DB_PASS" -N -B -e "SELECT COUNT(*) FROM \`$TABLA\`;" "$DB_NAME" 2>>"$LOG_FILE")
  if [ -z "$CONTEO" ]; then
    fallar "tabla_no_consultable" "La tabla '$TABLA' no se pudo contar tras restaurar (¿no existe en el respaldo, o cambió de nombre?)."
  fi
  CONTEOS_OBTENIDOS=$(python3 -c "
import json
d = json.loads('''$CONTEOS_OBTENIDOS''')
d['$TABLA'] = $CONTEO
print(json.dumps(d))
")
  log "Tabla $TABLA: $CONTEO filas restauradas"

  if [ "$SIN_REFERENCIA" -eq 0 ]; then
    ESPERADO=$(python3 -c "
import json
r = json.loads('''$CONTEOS_REFERENCIA''')
print(r.get('$TABLA', ''))
")
    if [ -n "$ESPERADO" ] && [ "$ESPERADO" != "$CONTEO" ]; then
      DIFERENCIAS="${DIFERENCIAS}${TABLA}: se esperaban ${ESPERADO} filas y se restauraron ${CONTEO}. "
    fi
  fi
done
CONTEOS_JSON="$CONTEOS_OBTENIDOS"

if [ -n "$DIFERENCIAS" ]; then
  fallar "conteo_no_coincide" "El número de filas restauradas no coincide con lo esperado: $DIFERENCIAS"
fi
if [ "$SIN_REFERENCIA" -eq 1 ]; then
  log "AVISO: conteos restaurados sin comparar contra un valor esperado (falta el conteo de referencia de esta noche)."
fi

# ── 7. Confirmar que los datos son CONSULTABLES, no solo que existen ────────
# Una tabla puede tener el número correcto de filas y aun así estar rota
# para efectos prácticos si, por ejemplo, faltan índices o hay columnas
# corruptas que rompen una consulta común. Por eso se corre una agregación
# real: la suma de ventas de un día de negocio.
#
# NOTA: se asume el esquema estándar de PHP Point of Sale para la tabla de
# ventas (columnas "sale_time" y "total" en "phppos_sales"). Verificar estos
# nombres de columna contra la instalación real antes de activar este
# script en producción; si difieren, ajustar la consulta de abajo.
FECHA_BACKUP=$(echo "$BACKUP_FILE_NOMBRE" | sed -E 's/^db_([0-9]{8})_.*/\1/')
if [ -n "$FECHA_BACKUP" ] && [ "$FECHA_BACKUP" != "$BACKUP_FILE_NOMBRE" ]; then
  FECHA_FORMATEADA="${FECHA_BACKUP:0:4}-${FECHA_BACKUP:4:2}-${FECHA_BACKUP:6:2}"
  FECHA_VENTAS=$(date -u -d "${FECHA_FORMATEADA} -1 day" +%Y-%m-%d 2>/dev/null || echo "$FECHA_FORMATEADA")
else
  FECHA_VENTAS=$(date -u -d "yesterday" +%Y-%m-%d)
fi

SUMA_VENTAS=$(docker exec "$CONTAINER_TEST" mysql -uroot -p"$TEST_DB_PASS" -N -B \
  -e "SELECT COALESCE(SUM(total), 0) FROM phppos_sales WHERE DATE(sale_time) = '$FECHA_VENTAS';" "$DB_NAME" 2>>"$LOG_FILE")
CODIGO_AGREGACION=$?

if [ "$CODIGO_AGREGACION" -ne 0 ] || [ -z "$SUMA_VENTAS" ]; then
  fallar "consulta_agregacion_fallo" "La consulta de suma de ventas del $FECHA_VENTAS falló con error de SQL. Las tablas existen pero no se pueden consultar con normalidad (revisar nombres de columna: sale_time/total en phppos_sales)."
fi
log "Consulta de agregación OK: ventas del $FECHA_VENTAS = $SUMA_VENTAS"
AGREGACION_JSON=$(python3 -c "
import json
print(json.dumps({'fecha': '$FECHA_VENTAS', 'suma_ventas': $SUMA_VENTAS}))
")

# ── 8. Todo salió bien ───────────────────────────────────────────────────────
DURACION_TOTAL=$(( $(date +%s) - INICIO_UNIX ))
DETALLE_OK="Restauración y verificación completas en ${DURACION_TOTAL}s. Conteos $( [ "$SIN_REFERENCIA" -eq 0 ] && echo "coinciden con lo esperado" || echo "verificados sin conteo de referencia disponible" )."
log "$DETALLE_OK"
escribir_resultado "ok" "" "$DETALLE_OK" "$DURACION_TOTAL" "$CONTEOS_JSON" "$AGREGACION_JSON"
log "=== Prueba de restauración completada con éxito (sin aviso por WhatsApp, todo bien) ==="
latir prueba_restauracion

# El contenedor temporal y todos sus datos se borran automáticamente al
# salir de aquí, gracias al trap "limpiar" definido arriba.
exit 0
