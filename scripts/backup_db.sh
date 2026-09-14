#!/bin/bash
# backup_db.sh — Respaldo de la base de datos de Zeus.
#
# Qué hace, en orden:
#   1. Vuelca la base desde el contenedor y la comprime.
#   2. Verifica que el archivo comprimido no esté corrupto.
#   3. Lo sube a Google Drive y comprueba que llegó del mismo tamaño.
#   4. Rota las copias locales para no pasar de 5 GB.
#   5. Deja constancia en .last_backup.json y avisa por WhatsApp si algo falla.
#
# Cron: 0 8 * * *  (03:00 hora de Colombia; el servidor trabaja en UTC)

BACKUP_DIR="/opt/zeus-app/backups"
LOG_FILE="/opt/zeus-app/logs/backup_db.log"
META="$BACKUP_DIR/.last_backup.json"
DB_NAME="${DB_ESQUEMA:-negocio}"
CONTAINER="zeus-mariadb"
DB_USER="root"
# La contraseña NUNCA va escrita aquí — se lee del .env de zeus-ops en cada
# corrida (mismo archivo que ya usa el resto de Centinela para hablar con la
# base). Antes esta línea traía la contraseña real en texto plano dentro del
# script (encontrado revisando en vivo el 14-sep-2026, mientras se preparaba
# la copia pública del código: el mismo archivo vive además horneado dentro
# de varias capas de la imagen Docker del bot, así que sacarlo de aquí reduce
# cuántas copias en texto plano existen del secreto).
DB_PASS="$(grep -oP '^MYSQL_ROOT_PASS=\K.*' /opt/zeus-ops/.env)"
if [ -z "$DB_PASS" ]; then
  echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] ERROR: no se pudo leer MYSQL_ROOT_PASS de /opt/zeus-ops/.env" >&2
  exit 1
fi
REMOTO="zeus-drive:BackupVPS"
MAX_SIZE_BYTES=$((5 * 1024 * 1024 * 1024))
OPS="http://127.0.0.1:4900/api/aviso"

mkdir -p "$BACKUP_DIR" "$(dirname "$LOG_FILE")"

log() { echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] $1" | tee -a "$LOG_FILE"; }

avisar() {
  curl -s --max-time 20 -X POST "$OPS" -H 'Content-Type: application/json' \
    -d "{\"origen\":\"respaldo\",\"texto\":$(printf '%s' "$1" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')}" >/dev/null 2>&1
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

escribir_meta() { # estado, bytes, drive
  cat > "$META" <<JSON
{"ts":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","ts_unix_ms":$(date +%s%3N),"estado":"$1","bytes":$2,"drive":"$3"}
JSON
}


guardar_conteos_referencia() { # archivo
  local archivo_base
  archivo_base=$(basename "$1")
  local c1 c2 c3
  c1=$(docker exec "$CONTAINER" mysql -u"$DB_USER" -p"$DB_PASS" -N -B -e "SELECT COUNT(*) FROM phppos_sales;" "$DB_NAME" 2>/dev/null)
  c2=$(docker exec "$CONTAINER" mysql -u"$DB_USER" -p"$DB_PASS" -N -B -e "SELECT COUNT(*) FROM phppos_inventory;" "$DB_NAME" 2>/dev/null)
  c3=$(docker exec "$CONTAINER" mysql -u"$DB_USER" -p"$DB_PASS" -N -B -e "SELECT COUNT(*) FROM phppos_employee_commissions;" "$DB_NAME" 2>/dev/null)
  cat > "$BACKUP_DIR/.last_backup_counts.json" <<JSON
{"ts":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","archivo":"$archivo_base","conteos":{"phppos_sales":${c1:-0},"phppos_inventory":${c2:-0},"phppos_employee_commissions":${c3:-0}}}
JSON
}

log "=== Respaldo iniciado ==="
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
BACKUP_FILE="${BACKUP_DIR}/db_${TIMESTAMP}.sql.gz"

# ── 1. Volcado ───────────────────────────────────────────────────────────────
docker exec "$CONTAINER" mysqldump -u"$DB_USER" -p"$DB_PASS" --single-transaction "$DB_NAME" 2>/dev/null | gzip > "$BACKUP_FILE"
EXIT_CODE=${PIPESTATUS[0]}

if [ "$EXIT_CODE" -ne 0 ]; then
  log "ERROR: el volcado falló con código $EXIT_CODE"
  rm -f "$BACKUP_FILE"
  escribir_meta "fallo_volcado" 0 "no"
  avisar "El respaldo de la base de datos FALLÓ. El volcado no se pudo completar. Revisa panel.ejemplo.com"
  latir respaldo_bd fallo "volcado falló con código $EXIT_CODE"
  exit 1
fi

# ── 2. Verificación de integridad ────────────────────────────────────────────
if ! gzip -t "$BACKUP_FILE" 2>/dev/null; then
  log "ERROR: el archivo quedó corrupto"
  rm -f "$BACKUP_FILE"
  escribir_meta "corrupto" 0 "no"
  avisar "El respaldo de hoy salió corrupto y se descartó. Revisa panel.ejemplo.com"
  latir respaldo_bd fallo "archivo corrupto"
  exit 1
fi

BYTES=$(stat -c %s "$BACKUP_FILE")
MB=$((BYTES / 1048576))
log "Copia creada: $BACKUP_FILE (${MB} MB), integridad verificada"
guardar_conteos_referencia "$BACKUP_FILE"

# Una copia mucho más pequeña que la anterior es sospechosa.
ANTERIOR=$(find "$BACKUP_DIR" -maxdepth 1 -name 'db_*.sql.gz' ! -name "$(basename "$BACKUP_FILE")" -printf '%s\n' | sort -n | tail -1)
if [ -n "$ANTERIOR" ] && [ "$BYTES" -lt $((ANTERIOR / 2)) ]; then
  log "AVISO: la copia pesa menos de la mitad que la anterior"
  avisar "El respaldo de hoy pesa ${MB} MB, menos de la mitad que el anterior. Conviene revisar la base de datos."
fi

# ── 3. Subida a Drive ────────────────────────────────────────────────────────
DRIVE="no"
if rclone lsd zeus-drive: >/dev/null 2>&1; then
  log "Subiendo a Drive..."
  if rclone copy "$BACKUP_FILE" "$REMOTO" --transfers 1 --retries 3 >>"$LOG_FILE" 2>&1; then
    REMOTO_BYTES=$(rclone size "$REMOTO/$(basename "$BACKUP_FILE")" --json 2>/dev/null | grep -o '"bytes":[0-9]*' | cut -d: -f2)
    if [ "$REMOTO_BYTES" = "$BYTES" ]; then
      DRIVE="ok"
      log "Subida verificada en Drive ($REMOTO_BYTES bytes)"
      # Conservar 14 copias en Drive
      rclone delete "$REMOTO" --min-age 14d >>"$LOG_FILE" 2>&1
    else
      DRIVE="tamano_distinto"
      log "ERROR: el tamaño en Drive no coincide"
      avisar "El respaldo subió a Drive incompleto. En el servidor sí quedó bien (${MB} MB)."
    fi
  else
    DRIVE="fallo"
    log "ERROR: la subida a Drive falló"
    avisar "El respaldo de hoy quedó en el servidor (${MB} MB) pero NO se pudo subir a Drive."
  fi
else
  DRIVE="desconectado"
  log "Drive sin conexión, se omite la subida"
fi

# ── 4. Rotación local ────────────────────────────────────────────────────────
tam_dir() { du -sb "$BACKUP_DIR" 2>/dev/null | awk '{print $1}'; }
while [ "$(tam_dir)" -gt "$MAX_SIZE_BYTES" ]; do
  VIEJO=$(find "$BACKUP_DIR" -maxdepth 1 -type f -name "db_*.sql.gz" -printf "%T@ %p\n" | sort -n | head -1 | awk '{print $2}')
  [ -z "$VIEJO" ] && break
  log "Borrando copia antigua: $VIEJO"
  rm -f "$VIEJO"
done

# ── 5. Constancia ────────────────────────────────────────────────────────────
escribir_meta "ok" "$BYTES" "$DRIVE"
COPIAS=$(find "$BACKUP_DIR" -maxdepth 1 -name "db_*.sql.gz" | wc -l)
log "Terminado. ${MB} MB, drive=$DRIVE, copias locales=$COPIAS"
log "=== Respaldo completado ==="
latir respaldo_bd
