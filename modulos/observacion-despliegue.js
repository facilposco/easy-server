"use strict";
/**
 * Centinela Zeus — variante liviana de rastreo de despliegues
 * (DISENO-FASE-CAOS.md §4 fila #3 y §5). Fábrica `crearObservacionDespliegue(deps)`.
 *
 * NO levanta un segundo bot. El azul/verde completo ya existe en
 * `modulos/despliegues/orquestador-despliegue.js` pero no cabe en esta
 * máquina (dos bots de ~3 GB en un servidor de 4 GB, ver su RIESGOS.md) y no
 * se usa. Esta variante vigila el despliegue de HOY
 * (`/opt/zeus-app/scripts/push-deploy.sh`: git pull + build + up, con un tag
 * `backup/<fecha>` creado antes de tocar nada) sin segundo contenedor:
 * toma una foto de la versión saliente, y después del despliegue compara la
 * versión nueva contra esa foto con los MISMOS umbrales que ya usa el
 * orquestador azul/verde (se reutilizan importando su `CFG`, no se
 * reinventan ni se duplican).
 *
 * Como Traefik no tiene `--accesslog` activo (confirmado en
 * modulos/despliegues/RIESGOS.md), la "tasa de 5xx" se aproxima igual que
 * allá: reinicios del contenedor + latencia de un chequeo HTTP.
 *
 * Flujo en DOS llamadas (no una), porque el bot saliente deja de existir en
 * cuanto `docker compose up -d` reemplaza el contenedor — no hay forma de
 * medir la versión vieja DESPUÉS de que ya la reemplazaron:
 *   1) `capturarBaseline()` — llamar justo ANTES de correr push-deploy.sh.
 *   2) `observar(minutos)`  — llamar justo DESPUÉS de que push-deploy.sh termine.
 * Ambas cuelgan del mismo endpoint `POST /api/despliegue/observar` con un
 * campo `fase` en el cuerpo (ver INTEGRACION-RESILIENCIA.md para el detalle
 * exacto de cómo se envuelve alrededor de push-deploy.sh sin editarlo).
 *
 * Reversión: reutiliza el mecanismo YA existente. `capturarBaseline()`
 * guarda el commit de git actual (`git rev-parse HEAD`) en el checkout de
 * `/opt/zeus-app` ANTES de que push-deploy.sh haga `git pull`. Como
 * push-deploy.sh crea su tag `backup/<fecha>` apuntando exactamente a ese
 * mismo commit (es su primer paso, antes del pull), al momento de revertir
 * basta con buscar qué tag `backup/*` apunta a ese commit
 * (`git tag --points-at <sha>`) y correr el script de reversión que YA
 * existe: `/opt/zeus-app/scripts/rollback.sh <tag>`. Si por lo que sea no
 * aparece ningún tag apuntando a ese commit (por ejemplo, porque
 * `capturarBaseline()` no se llamó a tiempo), se avisa del problema y NO se
 * intenta una reversión a ciegas.
 */

const path = require("path");

function crearObservacionDespliegue(deps) {
  const { sh, auditar, enviarWhatsapp, leerContenedores, DIR_DATOS, leerJson, guardarJson } = deps || {};
  for (const [nombre, fn] of Object.entries({ sh, auditar, leerContenedores, leerJson, guardarJson })) {
    if (typeof fn !== "function") throw new Error(`crearObservacionDespliegue necesita "${nombre}" de ops-server.js`);
  }
  if (!DIR_DATOS) throw new Error("crearObservacionDespliegue necesita DIR_DATOS");

  const RUTA_ESTADO = path.join(DIR_DATOS, "observacion-despliegue.json");
  const PROYECTO_DIR = "/opt/zeus-app";
  const CONTENEDOR_BOT = "zeus-bot";

  // Reutiliza los umbrales del orquestador azul/verde en vez de duplicarlos.
  // Si ese módulo no está presente por algún motivo, cae a una copia local
  // de los mismos valores (documentados también en su propio archivo), para
  // que este módulo nunca deje de funcionar por una ruta de require rota.
  let CFG_AZULVERDE;
  try {
    CFG_AZULVERDE = require("./despliegues/orquestador-despliegue.js").CFG;
  } catch (_) {
    CFG_AZULVERDE = null;
  }
  const UMBRAL_REINICIOS_MAX = (CFG_AZULVERDE && CFG_AZULVERDE.UMBRAL_REINICIOS_MAX) ?? 0;
  const UMBRAL_LATENCIA_MULT = (CFG_AZULVERDE && CFG_AZULVERDE.UMBRAL_LATENCIA_MULT) ?? 2.0;
  const UMBRAL_LATENCIA_PISO_MS = (CFG_AZULVERDE && CFG_AZULVERDE.UMBRAL_LATENCIA_PISO_MS) ?? 300;
  const UMBRAL_MEMORIA_MULT = (CFG_AZULVERDE && CFG_AZULVERDE.UMBRAL_MEMORIA_MULT) ?? 1.5;
  const UMBRAL_MEMORIA_PISO_MB = (CFG_AZULVERDE && CFG_AZULVERDE.UMBRAL_MEMORIA_PISO_MB) ?? 200;
  // Puerto interno del bot (dentro del propio contenedor), tomado de
  // CFG.URL_AZUL ("http://zeus-bot:3131") para no volver a escribir "3131"
  // suelto en dos archivos distintos.
  let PUERTO_BOT_INTERNO = 3131;
  try {
    if (CFG_AZULVERDE && CFG_AZULVERDE.URL_AZUL) PUERTO_BOT_INTERNO = Number(new URL(CFG_AZULVERDE.URL_AZUL).port) || 3131;
  } catch (_) {}

  const VENTANA_MINUTOS_DEFECTO = 10; // igual que la ventana del azul/verde
  const INTERVALO_MUESTRA_MS = 30000; // igual que el azul/verde
  const MUESTRAS_SOSTENIDAS_PARA_LATENCIA = 2; // exige 2 muestras seguidas, no un pico aislado

  let enCurso = false; // candado en memoria: una sola observación a la vez

  function estadoPersistido() {
    return leerJson(RUTA_ESTADO, { baseline: null, en_curso: null, ultima: null });
  }

  // ── Medición (mismo estilo que orquestador-despliegue.js: latencia por
  //    curl mediana de 3 intentos, memoria por `docker stats`) ────────────

  async function latenciaMsBot() {
    // Se mide DESDE DENTRO del contenedor (docker exec) porque el bot no
    // tiene un puerto de host publicado hacia afuera para pruebas directas
    // (solo lo alcanza Traefik por la red interna de Docker); `curl` ya
    // tiene que estar disponible ahí porque el orquestador azul/verde ya lo
    // usa de la misma forma contra su contenedor verde.
    const muestras = [];
    for (let i = 0; i < 3; i++) {
      const r = await sh(
        `docker exec ${CONTENEDOR_BOT} curl -o /dev/null -s -m 5 -w '%{time_total}' http://localhost:${PUERTO_BOT_INTERNO}/dashboard 2>/dev/null`,
        8000
      );
      const t = parseFloat(r.salida);
      if (!isNaN(t)) muestras.push(t * 1000);
    }
    if (!muestras.length) return null;
    muestras.sort((a, b) => a - b);
    return muestras[Math.floor(muestras.length / 2)];
  }

  async function memoriaMbBot() {
    const r = await sh(`docker stats --no-stream --format '{{.MemUsage}}' ${CONTENEDOR_BOT}`, 10000);
    const txt = (r.salida || "").split("/")[0].trim(); // "123.4MiB" o "1.2GiB"
    const m = txt.match(/^([\d.]+)\s*([kKmMgG]i?B)$/);
    if (!m) return null;
    const valor = parseFloat(m[1]);
    const unidad = m[2].toLowerCase();
    const mult = unidad.startsWith("g") ? 1024 : unidad.startsWith("k") ? 1 / 1024 : 1;
    return Math.round(valor * mult);
  }

  async function reiniciosBot() {
    const contenedores = await leerContenedores();
    const c = contenedores.find((x) => x.nombre === CONTENEDOR_BOT);
    return c ? c.reinicios : 0;
  }

  async function commitActual() {
    const r = await sh(`git -C ${PROYECTO_DIR} rev-parse HEAD 2>/dev/null`);
    return (r.salida || "").trim() || null;
  }

  async function medir() {
    const [latencia_ms, memoria_mb, reinicios] = await Promise.all([latenciaMsBot(), memoriaMbBot(), reiniciosBot()]);
    return { ts: Date.now(), latencia_ms, memoria_mb, reinicios };
  }

  // ── Fase 1: antes del despliegue ─────────────────────────────────────────

  /**
   * Llamar justo ANTES de correr push-deploy.sh. Guarda una foto de la
   * versión saliente y el commit actual (para poder ubicar después el tag
   * `backup/<fecha>` que push-deploy.sh va a crear apuntando a este mismo
   * commit).
   */
  async function capturarBaseline() {
    if (enCurso) return { ok: false, mensaje: "Ya hay una observación en curso", code: 409 };
    const muestra = await medir();
    const commit_sha = await commitActual();
    const baseline = { ...muestra, commit_sha, capturado: new Date().toISOString() };

    const db = estadoPersistido();
    db.baseline = baseline;
    db.en_curso = null;
    guardarJson(RUTA_ESTADO, db);
    auditar("despliegue_baseline", "panel", "ok", `commit ${commit_sha ? commit_sha.slice(0, 8) : "desconocido"}`);
    return { ok: true, mensaje: "Foto tomada antes del despliegue", baseline };
  }

  // ── Reversión (reutiliza rollback.sh, no lo reinventa) ──────────────────

  async function revertir(baseline, motivoTexto) {
    if (!baseline || !baseline.commit_sha) {
      auditar("despliegue_revertido", "agente", "sin_baseline", "no había commit de referencia guardado");
      return { ok: false, mensaje: "No se pudo revertir: no había una foto previa con el commit de referencia" };
    }
    const tagR = await sh(`git -C ${PROYECTO_DIR} tag --points-at ${baseline.commit_sha} 2>/dev/null | grep '^backup/' | head -1`);
    const tag = (tagR.salida || "").trim();
    if (!tag) {
      auditar("despliegue_revertido", "agente", "sin_tag", `commit ${baseline.commit_sha.slice(0, 8)} sin tag backup/ asociado`);
      return { ok: false, mensaje: "No se encontró la versión anterior para revertir (no apareció el tag de respaldo esperado). Revisa manualmente." };
    }
    const r = await sh(`${PROYECTO_DIR}/scripts/rollback.sh ${tag} 2>&1 | tail -6`, 300000);
    auditar("despliegue_revertido", "agente", r.ok ? "ok" : "falló", `${tag}: ${motivoTexto}`);
    return { ok: r.ok, tag, mensaje: r.ok ? `Se volvió a la versión anterior (${tag})` : "La reversión automática falló, revisa el servidor manualmente" };
  }

  // ── Fase 2: después del despliegue ──────────────────────────────────────

  /**
   * Llamar justo DESPUÉS de que push-deploy.sh termine. Vigila la versión
   * nueva durante `minutos` (10 por defecto, igual que el azul/verde),
   * comparando cada muestra contra el baseline. Corre en segundo plano y
   * devuelve de inmediato; el estado se consulta con `estado()`
   * (`GET /api/despliegue/observacion`).
   */
  async function observar(minutos) {
    if (enCurso) return { ok: false, mensaje: "Ya hay una observación en curso", code: 409 };
    const db = estadoPersistido();
    if (!db.baseline) return { ok: false, mensaje: "Falta capturar la foto de antes del despliegue (llama primero a la fase 'baseline')", code: 412 };

    const ventanaMin = Number(minutos) > 0 ? Number(minutos) : VENTANA_MINUTOS_DEFECTO;
    enCurso = true;
    db.en_curso = { inicio: new Date().toISOString(), minutos: ventanaMin };
    guardarJson(RUTA_ESTADO, db);
    auditar("despliegue_observacion_iniciada", "panel", "ok", `${ventanaMin} min`);

    (async () => {
      const baseline = db.baseline;
      const muestras = [];
      let fallosLatenciaSeguidos = 0;
      let veredicto = "aprobado";
      let motivo = "";
      let revirtio = false;
      const finVentana = Date.now() + ventanaMin * 60000;

      try {
        while (Date.now() < finVentana) {
          await new Promise((r) => setTimeout(r, INTERVALO_MUESTRA_MS));
          const m = await medir();
          muestras.push(m);

          // 1) reinicios respecto al baseline
          const reiniciosNuevos = (m.reinicios || 0) - (baseline.reinicios || 0);
          if (reiniciosNuevos > UMBRAL_REINICIOS_MAX) {
            veredicto = "reprobado";
            motivo = `El bot se reinició ${reiniciosNuevos} vez/veces tras el despliegue`;
            break;
          }

          // 2) latencia sostenida
          if (m.latencia_ms !== null && baseline.latencia_ms !== null) {
            const rompe = m.latencia_ms > UMBRAL_LATENCIA_PISO_MS && m.latencia_ms > baseline.latencia_ms * UMBRAL_LATENCIA_MULT;
            fallosLatenciaSeguidos = rompe ? fallosLatenciaSeguidos + 1 : 0;
            if (fallosLatenciaSeguidos >= MUESTRAS_SOSTENIDAS_PARA_LATENCIA) {
              veredicto = "reprobado";
              motivo = `El chequeo /dashboard tardó ${Math.round(m.latencia_ms)} ms de forma sostenida (antes ${Math.round(baseline.latencia_ms)} ms)`;
              break;
            }
          }

          // 3) memoria
          if (m.memoria_mb !== null && baseline.memoria_mb !== null) {
            if (m.memoria_mb > UMBRAL_MEMORIA_PISO_MB && m.memoria_mb > baseline.memoria_mb * UMBRAL_MEMORIA_MULT) {
              veredicto = "reprobado";
              motivo = `El bot está usando ${m.memoria_mb} MB (antes ${baseline.memoria_mb} MB)`;
              break;
            }
          }
        }

        if (veredicto === "reprobado") {
          const r = await revertir(baseline, motivo);
          revirtio = r.ok;
          if (typeof enviarWhatsapp === "function") {
            await enviarWhatsapp(
              `Despliegue revertido automáticamente\n\n${motivo}\n\n` +
              (r.ok ? `Se volvió a la versión anterior sin más pasos.` : `La reversión automática falló: ${r.mensaje}. Revisa el servidor.`) +
              `\n\npanel.ejemplo.com`
            ).catch(() => {});
          }
        }
      } catch (e) {
        veredicto = "error";
        motivo = e.message;
        auditar("despliegue_observacion_excepcion", "agente", "error", e.message);
      } finally {
        enCurso = false;
        const dbFinal = estadoPersistido();
        dbFinal.en_curso = null;
        dbFinal.ultima = {
          ts: new Date().toISOString(),
          veredicto,
          motivo,
          revirtio,
          duracion_min: ventanaMin,
          muestras,
          baseline,
        };
        guardarJson(RUTA_ESTADO, dbFinal);
        auditar("despliegue_observacion_terminada", "agente", veredicto, motivo);
      }
    })();

    return { ok: true, mensaje: `Vigilando el despliegue nuevo por ${ventanaMin} minutos`, minutos: ventanaMin };
  }

  function estado() {
    const db = estadoPersistido();
    return { baseline: db.baseline, en_curso: enCurso ? db.en_curso : null, ultima: db.ultima };
  }

  return { capturarBaseline, observar, estado };
}

module.exports = { crearObservacionDespliegue };
