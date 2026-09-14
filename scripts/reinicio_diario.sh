#!/bin/bash
# reinicio_diario.sh — Mantenimiento programado del servidor Zeus.
#
# Antes esto era "/sbin/reboot" todos los días — reiniciaba el servidor
# completo (los 4 contenedores) a diario, aunque solo el bot lo necesitaba.
#
# Ahora:
#   - Cada 3 días: reinicio COMPLETO del servidor (equivale a lo de antes).
#   - Los otros días: solo se reinicia el contenedor del bot (zeus-bot),
#     mucho menos disruptivo — mariadb, chromadb y el proxy no se tocan.
# En los dos casos: siempre avisa por WhatsApp y deja rastro para el panel
# (latidos.js — tarjeta "Tareas programadas").
#
# El día de reinicio completo se calcula con los días transcurridos desde el
# 1 de enero de 1970 (módulo 3) — así no hace falta un archivo de estado que
# se pueda corromper o perder: es el mismo cálculo sin importar qué pasó ayer.
#
# Cron: 0 9 * * *  (04:00 hora de Colombia; el servidor trabaja en UTC)

LOG_FILE="/opt/zeus-app/logs/reinicio_diario.log"
OPS="http://127.0.0.1:4900"

mkdir -p "$(dirname "$LOG_FILE")"

log() { echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] $1" | tee -a "$LOG_FILE"; }

avisar() {
  curl -s --max-time 20 -X POST "$OPS/api/aviso" -H 'Content-Type: application/json' \
    -d "{\"origen\":\"mantenimiento\",\"texto\":$(printf '%s' "$1" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')}" >/dev/null 2>&1
}

# Latido para Centinela: avisa que esta tarea terminó (modulos/latidos.js).
# El "|| true" es obligatorio: un latido nunca puede hacer fallar la tarea real.
latir() {  # latir <id> [ok|fallo] [detalle]
  local cuerpo='{}'
  [ "${2:-ok}" = "fallo" ] && cuerpo="{\"ok\":false,\"detalle\":\"${3:-}\"}"
  curl -s -m 10 --retry 3 --retry-delay 20 -X POST \
    -H 'X-Panel-Zeus: 1' -H 'Content-Type: application/json' \
    -d "$cuerpo" "$OPS/api/latidos/$1" >/dev/null 2>&1 || true
}

DIA_EPOCH=$(( $(date -u +%s) / 86400 ))

if (( DIA_EPOCH % 3 == 0 )); then
  # ── Día de reinicio completo del servidor (cada 3 días) ─────────────────────
  log "=== Mantenimiento: reinicio COMPLETO del servidor (ciclo de 3 días) ==="
  avisar "🔄 Voy a reiniciar el servidor completo (mantenimiento cada 3 días). Vuelvo en 1-2 minutos; te confirmo apenas todo esté funcionando de nuevo."
  latir mantenimiento_nocturno ok "reinicio_completo"
  log "Reiniciando el servidor ahora."
  /sbin/reboot
  # No hay código después de esto: el reboot corta el proceso. La confirmación
  # de que todo volvió bien la manda verificarArranque() en ops-server.js, que
  # ya corre solo cada vez que el servicio arranca (incluye el caso de un
  # reinicio completo del servidor).
else
  # ── Día normal: solo el bot ──────────────────────────────────────────────────
  log "=== Mantenimiento: reinicio del bot (día $((DIA_EPOCH % 3)) de 3 del ciclo) ==="
  if docker restart -t 20 zeus-bot >>"$LOG_FILE" 2>&1; then
    sleep 8
    RUNNING=$(docker inspect -f '{{.State.Running}}' zeus-bot 2>/dev/null)
    SALUD=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}sin_chequeo{{end}}' zeus-bot 2>/dev/null)
    if [ "$RUNNING" = "true" ] && [ "$SALUD" != "unhealthy" ]; then
      log "Bot reiniciado y sano (estado=$RUNNING, salud=$SALUD)."
      avisar "🔄 Reinicié el bot (mantenimiento diario). Ya está funcionando normal."
      latir mantenimiento_nocturno ok "reinicio_bot"
    else
      log "Bot reiniciado pero con estado dudoso (estado=$RUNNING, salud=$SALUD)."
      avisar "⚠️ Reinicié el bot (mantenimiento diario) pero después de reiniciar su estado es raro (corriendo=$RUNNING, salud=$SALUD). Reviso el panel: panel.ejemplo.com/contenedores"
      latir mantenimiento_nocturno fallo "tras reiniciar: corriendo=$RUNNING salud=$SALUD"
    fi
  else
    log "ERROR: docker restart del bot falló"
    avisar "🔴 El reinicio diario del bot FALLÓ (docker restart no funcionó). Revisa panel.ejemplo.com"
    latir mantenimiento_nocturno fallo "docker restart falló"
  fi
fi
