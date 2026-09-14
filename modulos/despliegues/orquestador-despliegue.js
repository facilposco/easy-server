"use strict";
/**
 * Centinela Zeus — Orquestador de despliegue azul/verde para zeus-bot.
 *
 * PROPUESTA AISLADA. No toca producción por sí solo: es un módulo `require()`
 * que no hace nada hasta que otro archivo (ops-server.js) lo instancie y
 * llame a sus funciones desde una ruta HTTP. Ver INTEGRACION-DESPLIEGUES.md
 * para el punto exacto de conexión.
 *
 * Sigue el mismo patrón de bajo acoplamiento que ya usan `db-optimizacion.js`
 * y `seguridad-auditoria.js`: no asume que existen las funciones internas de
 * ops-server.js, las recibe como parámetros explícitos (`sh`, `auditar`,
 * `enviarWhatsapp`, `DIR_DATOS`). Solo usa librería estándar de Node.
 *
 * ── Qué resuelve ──────────────────────────────────────────────────────────
 * El despliegue de hoy (push-deploy.sh) reconstruye la imagen y reemplaza el
 * contenedor `zeus-bot` directamente: hay una ventana real (los ~10-30s que
 * tarda `docker compose up -d`) en la que el bot no contesta, y si el código
 * nuevo tiene un error, el rollback de rollback.sh ya existe pero es MANUAL
 * (`./scripts/rollback.sh backup/TAG`) y actúa sobre GIT + reconstruye de
 * nuevo — no hay una versión ya construida y probada esperando.
 *
 * Este orquestador no reemplaza push-deploy.sh ni rollback.sh: los
 * complementa. Sigue usando el mismo checkout de git en el VPS
 * (CFG.PROYECTO_DIR) y el mismo docker-compose.yml. Lo nuevo es:
 *   1) construir y probar el código nuevo en un contenedor aparte
 *      (`zeus-bot-verde`) ANTES de que reciba tráfico real,
 *   2) mover el tráfico editando el archivo dinámico de Traefik (que ya se
 *      recarga solo, sin reiniciar el proxy),
 *   3) vigilar 10 minutos con criterios numéricos y devolver el tráfico al
 *      contenedor viejo automáticamente si algo empeora,
 *   4) si todo sale bien, promover el verde a `zeus-bot` (el nombre de
 *      siempre) reutilizando la MISMA imagen que ya se probó, sin
 *      reconstruir — así lo que se probó es exactamente lo que queda.
 *
 * ── Supuestos que hay que confirmar antes de usar esto en el VPS real ──────
 * (ver RIESGOS.md para el detalle de cada uno)
 *   - CFG.PROYECTO_DIR es la ruta real del checkout de zeus-app.
 *   - CFG.TRAEFIK_DYNAMIC_FILE es la ruta real del archivo dinámico de
 *     Traefik y CONTIENE literalmente el texto de CFG.URL_AZUL
 *     ("http://zeus-bot:3131"). Si el archivo usa otro formato (otro nombre
 *     de router, IP en vez de nombre de contenedor, etc.) hay que ajustar
 *     CFG.URL_AZUL / CFG.URL_VERDE para que coincidan letra por letra.
 *   - La red "zeus-network" (declarada como `zeus-net` en docker-compose.yml,
 *     con `name: zeus-network`) es la misma que usa el Traefik standalone
 *     (zeus-proxy-compose.yml la declara `external: true`), así que un
 *     contenedor en esa red es alcanzable por Traefik usando su nombre de
 *     contenedor como host. Si el VPS todavía enruta con el Traefik viejo de
 *     Coolify (red "coolify") en vez del zeus-proxy standalone, este diseño
 *     no aplica tal cual — hay que confirmar cuál de los dos está activo.
 */

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

// ── Configuración editable ──────────────────────────────────────────────────
const CFG = {
  // Dónde vive el checkout de zeus-app en el VPS (mismo que usa push-deploy.sh)
  PROYECTO_DIR: "/opt/zeus-app",
  COMPOSE_BASE: "docker-compose.yml",
  COMPOSE_VERDE: "docker-compose.verde.yml", // generado y borrado por este módulo

  CONTENEDOR_AZUL: "zeus-bot",
  CONTENEDOR_VERDE: "zeus-bot-verde",
  SERVICIO_AZUL: "zeus-bot", // nombre del service: en docker-compose.yml
  SERVICIO_VERDE: "zeus-bot-verde",

  // Puertos de host SOLO para pruebas directas del verde (loopback, igual que el azul)
  PUERTO_PANEL_VERDE: 3231,
  PUERTO_WEBHOOK_VERDE: 3232,

  // Archivo dinámico de Traefik (file provider, con watch=true → se recarga solo)
  TRAEFIK_DYNAMIC_FILE: "/opt/zeus-proxy/dynamic/panel_ejemplo.yml",
  URL_AZUL: "http://zeus-bot:3131",
  URL_VERDE: "http://zeus-bot-verde:3131",

  // Ventana de observación
  VENTANA_OBSERVACION_MS: 10 * 60 * 1000,
  INTERVALO_MUESTRA_MS: 30 * 1000,

  // Umbrales (ajustables). Ver RIESGOS.md e INTEGRACION-DESPLIEGUES.md para
  // el razonamiento de cada uno.
  UMBRAL_FALLOS_SALUD_SEGUIDOS: 2, // 2 chequeos activos fallidos seguidos (60s) → mala señal
  UMBRAL_REINICIOS_MAX: 0, // cualquier reinicio del verde en la ventana revierte
  UMBRAL_LATENCIA_MULT: 2.0, // verde no debe tardar más del doble que el azul
  UMBRAL_LATENCIA_PISO_MS: 300, // pero no dispara si ambos son rápidos (ruido)
  UMBRAL_MEMORIA_MULT: 1.5, // verde no debe usar más de 1.5x lo que usaba el azul
  UMBRAL_MEMORIA_PISO_MB: 200, // ni dispara por diferencias pequeñas en absoluto
  UMBRAL_MENSAJES_CAIDA_PCT: 0.7, // si mensajes/min cae por debajo del 70% del azul
  MENSAJES_MINIMOS_PARA_EVALUAR: 3, // si casi no había tráfico, no se evalúa esta señal
};

// ── Utilidades propias (el módulo no depende de las internas de ops-server.js) ─
function shLocal(cmd, timeout = 30000) {
  return new Promise((resolve) => {
    execFile("/bin/bash", ["-lc", cmd], { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, out, errOut) => {
      resolve({ ok: !err, salida: (out || "").trim(), error: (errOut || "").trim() });
    });
  });
}

function leerJsonLocal(archivo, porDefecto) {
  try { return JSON.parse(fs.readFileSync(archivo, "utf8")); } catch (_) { return porDefecto; }
}

function guardarJsonLocal(archivo, obj) {
  try { fs.writeFileSync(archivo, JSON.stringify(obj, null, 2)); } catch (_) {}
}

function dormir(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Convierte "123.4MiB" / "1.2GiB" / "500kB" (formato de `docker stats`) a megabytes. */
function memAMb(txt) {
  const m = String(txt || "").trim().match(/^([\d.]+)\s*([KMG]i?B)$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const u = m[2].toLowerCase();
  if (u.startsWith("g")) return n * 1024;
  if (u.startsWith("k")) return n / 1024;
  return n; // MiB/MB
}

/** Escribe un archivo de forma atómica: nunca deja a Traefik leyendo un archivo a medio escribir. */
function escribirAtomico(rutaFinal, contenido) {
  const tmp = rutaFinal + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, contenido);
  fs.renameSync(tmp, rutaFinal);
}

// ── Fábrica del orquestador ──────────────────────────────────────────────────
/**
 * @param {object} dep
 * @param {function} dep.sh            - igual que sh() en ops-server.js
 * @param {function} dep.auditar       - igual que auditar() en ops-server.js
 * @param {function} dep.enviarWhatsapp- igual que enviarWhatsapp() en ops-server.js
 * @param {string}   dep.DIR_DATOS     - igual que DIR_DATOS en ops-server.js (persistencia)
 */
function crearOrquestadorDespliegue(dep) {
  const sh = dep.sh || shLocal;
  const auditar = dep.auditar || (() => {});
  const enviarWhatsapp = dep.enviarWhatsapp || (async () => ({ ok: false }));
  const F_ESTADO = path.join(dep.DIR_DATOS || ".", "despliegue-estado.json");

  // Estado en memoria del despliegue en curso (además se persiste en disco,
  // así /api/despliegue/estado sigue funcionando si el proceso se reinicia
  // a mitad de camino — aunque el temporizador de la ventana SÍ se pierde,
  // ver RIESGOS.md, punto "reinicio de Centinela durante el despliegue").
  let cancelado = null; // null | "promover" | "revertir"

  function estadoInicial() {
    return {
      fase: "inactivo", // inactivo|construyendo|pruebas|cambiando_trafico|observando|promoviendo|revirtiendo|completado|revertido|error
      quien: null,
      inicio: null,
      fin: null,
      mensaje: "Sin despliegues en curso.",
      pruebas: [],
      muestras: [],
      criterio_fallido: null,
      linea_base: null,
      error: null,
    };
  }

  function estado() {
    return leerJsonLocal(F_ESTADO, estadoInicial());
  }

  function guardarEstado(parcial) {
    const actual = estado();
    const nuevo = Object.assign(actual, parcial);
    guardarJsonLocal(F_ESTADO, nuevo);
    return nuevo;
  }

  function enCurso() {
    const f = estado().fase;
    return !["inactivo", "completado", "revertido", "error"].includes(f);
  }

  // ── Fase 1: construir el verde sin tocar el azul ───────────────────────────

  /**
   * Genera docker-compose.verde.yml extrayendo el bloque real del servicio
   * `zeus-bot` de docker-compose.yml y clonándolo con otro nombre. Se hace
   * así (en vez de escribir el servicio a mano) para no duplicar ~40
   * variables de entorno que se desactualizarían solas cada vez que alguien
   * agregue una nueva al servicio real.
   */
  async function generarComposeVerde() {
    const rutaBase = path.join(CFG.PROYECTO_DIR, CFG.COMPOSE_BASE);
    const texto = fs.readFileSync(rutaBase, "utf8");
    const lineas = texto.split("\n");

    const inicioRe = new RegExp(`^  ${CFG.SERVICIO_AZUL}:\\s*$`);
    const inicio = lineas.findIndex((l) => inicioRe.test(l));
    if (inicio === -1) {
      throw new Error(`No encontré el servicio "${CFG.SERVICIO_AZUL}:" en ${rutaBase}. Ajusta CFG.SERVICIO_AZUL o revisa el archivo a mano.`);
    }
    let fin = lineas.length;
    for (let i = inicio + 1; i < lineas.length; i++) {
      const l = lineas[i];
      if (l.trim() === "") continue; // las líneas en blanco no cierran el bloque
      const indent = l.match(/^ */)[0].length;
      if (indent <= 2) { fin = i; break; } // siguiente clave al mismo nivel (u otra sección)
    }
    const bloque = lineas.slice(inicio, fin);
    if (!bloque.some((l) => /container_name:\s*zeus-bot\s*$/.test(l))) {
      throw new Error("El bloque extraído del servicio zeus-bot no tiene container_name: zeus-bot. Abortando para no generar un compose incorrecto.");
    }

    const clon = bloque
      .map((l, i) => (i === 0 ? `  ${CFG.SERVICIO_VERDE}:` : l))
      .map((l) => l.replace(/container_name:\s*zeus-bot\s*$/, `container_name: ${CFG.CONTENEDOR_VERDE}`))
      .map((l) => l.replace(/"127\.0\.0\.1:3131:3131"/, `"127.0.0.1:${CFG.PUERTO_PANEL_VERDE}:3131"`))
      .map((l) => l.replace(/"127\.0\.0\.1:3132:3132"/, `"127.0.0.1:${CFG.PUERTO_WEBHOOK_VERDE}:3132"`))
      // El verde no debe reiniciarse solo si se cae durante la prueba: así una
      // falla queda visible para las pruebas de humo en vez de disfrazarse
      // con un reinicio automático de Docker.
      .map((l) => l.replace(/restart:\s*(unless-stopped|always)\s*$/, 'restart: "no"'));

    const contenido = "services:\n" + clon.join("\n") + "\n";
    const rutaVerde = path.join(CFG.PROYECTO_DIR, CFG.COMPOSE_VERDE);
    fs.writeFileSync(rutaVerde, contenido);
    return rutaVerde;
  }

  function comandoCompose(sub) {
    return `cd ${CFG.PROYECTO_DIR} && docker compose -f ${CFG.COMPOSE_BASE} -f ${CFG.COMPOSE_VERDE} ${sub}`;
  }

  async function construirVerde() {
    await generarComposeVerde();
    const build = await sh(comandoCompose(`build ${CFG.SERVICIO_VERDE}`), 240000);
    if (!build.ok) {
      return { ok: false, mensaje: "La construcción de la imagen nueva falló", detalle: (build.error || build.salida).slice(-800) };
    }
    // --no-deps: mariadb y chromadb ya están arriba y son compartidos con el
    // azul a propósito (ver RIESGOS.md — "base de datos compartida").
    const up = await sh(comandoCompose(`up -d --no-deps ${CFG.SERVICIO_VERDE}`), 60000);
    if (!up.ok) {
      return { ok: false, mensaje: "No se pudo levantar el contenedor verde", detalle: (up.error || up.salida).slice(-800) };
    }
    // Margen para que Node arranque y las conexiones (Mongo/Mysql/Chroma) se
    // establezcan antes de empezar a probar — igual criterio que
    // start_period: 30s del healthcheck del propio servicio.
    await dormir(15000);
    return { ok: true, mensaje: "Contenedor verde construido y arriba" };
  }

  // ── Fase 2: pruebas de humo ──────────────────────────────────────────────

  async function probarSaludPanel() {
    const r = await sh(`docker exec ${CFG.CONTENEDOR_VERDE} curl -sf -m 5 http://localhost:3131/`, 10000);
    return { nombre: "Panel del bot responde", ok: r.ok, detalle: r.ok ? "HTTP 200 en :3131" : (r.error || "sin respuesta").slice(0, 200) };
  }

  async function probarSaludWebhook() {
    const r = await sh(`docker exec ${CFG.CONTENEDOR_VERDE} curl -sf -m 5 http://localhost:3132/health`, 10000);
    return { nombre: "Webhook de Kapso responde", ok: r.ok, detalle: r.ok ? "HTTP 200 en :3132/health" : (r.error || "sin respuesta").slice(0, 200) };
  }

  async function probarMariaDb() {
    const script = "require('/app/src/agata/db').q('SELECT 1').then(()=>{console.log('OK');process.exit(0);}).catch(e=>{console.error(e.message);process.exit(1);});";
    const r = await sh(`docker exec -w /app ${CFG.CONTENEDOR_VERDE} node -e "${script.replace(/"/g, '\\"')}"`, 15000);
    return { nombre: "Conexión a MariaDB", ok: r.ok, detalle: r.ok ? "SELECT 1 respondió" : (r.error || r.salida || "falló").slice(0, 300) };
  }

  /** Valida las credenciales de Kapso con una consulta de solo lectura (datos del número), sin enviar ningún mensaje. */
  async function probarKapso() {
    const cmd = 'curl -s -o /dev/null -m 8 -w "%{http_code}" -H "X-API-Key: $KAPSO_API_KEY" "$KAPSO_META_URL/$KAPSO_PHONE_NUMBER_ID"';
    const r = await sh(`docker exec -w /app ${CFG.CONTENEDOR_VERDE} sh -c '${cmd}'`, 12000);
    const codigo = (r.salida || "").trim();
    const ok = r.ok && /^2\d\d$/.test(codigo);
    return { nombre: "Credenciales de Kapso (WhatsApp)", ok, detalle: codigo ? `HTTP ${codigo}` : "sin respuesta de Kapso" };
  }

  async function probarLogsSinErrores() {
    const r = await sh(`docker logs ${CFG.CONTENEDOR_VERDE} --since 3m 2>&1 | grep -icE "error|exception|uncaught|fatal|econnrefused" || true`, 10000);
    const n = parseInt((r.salida || "0").trim(), 10) || 0;
    // Un puñado de líneas con la palabra "error" en un log normal no es raro
    // (reintentos, warnings de librerías). Más de 5 en los primeros minutos sí lo es.
    return { nombre: "Sin errores repetidos en el arranque", ok: n <= 5, detalle: `${n} línea(s) con error/excepción en los últimos 3 min` };
  }

  async function pruebasDeHumo() {
    const pruebas = await Promise.all([
      probarSaludPanel(),
      probarSaludWebhook(),
      probarMariaDb(),
      probarKapso(),
      probarLogsSinErrores(),
    ]);
    return { ok: pruebas.every((p) => p.ok), pruebas };
  }

  // ── Fase 3: cambio de tráfico (Traefik, file provider) ─────────────────────

  function cambiarTrafico(destino) {
    // destino: "verde" | "azul"
    const buscar = destino === "verde" ? CFG.URL_AZUL : CFG.URL_VERDE;
    const reemplazo = destino === "verde" ? CFG.URL_VERDE : CFG.URL_AZUL;
    const contenido = fs.readFileSync(CFG.TRAEFIK_DYNAMIC_FILE, "utf8");
    if (!contenido.includes(buscar)) {
      throw new Error(
        `El archivo ${CFG.TRAEFIK_DYNAMIC_FILE} no contiene el texto exacto "${buscar}". ` +
        `Verifica CFG.URL_AZUL/CFG.URL_VERDE contra el contenido real del archivo antes de reintentar.`
      );
    }
    escribirAtomico(CFG.TRAEFIK_DYNAMIC_FILE, contenido.split(buscar).join(reemplazo));
  }

  // ── Fase 4: línea base y observación ────────────────────────────────────────

  async function latenciaMs(puerto) {
    const muestras = [];
    for (let i = 0; i < 3; i++) {
      const r = await sh(`curl -o /dev/null -s -m 5 -w '%{time_total}' http://127.0.0.1:${puerto}/`, 8000);
      const t = parseFloat(r.salida);
      if (!isNaN(t)) muestras.push(t * 1000);
    }
    if (!muestras.length) return null;
    muestras.sort((a, b) => a - b);
    return muestras[Math.floor(muestras.length / 2)]; // mediana
  }

  async function memoriaMb(contenedor) {
    const r = await sh(`docker stats --no-stream --format '{{.MemUsage}}' ${contenedor}`, 10000);
    const mb = memAMb((r.salida || "").split("/")[0].trim());
    return { mb: mb === null ? null : Math.round(mb), fuente: "docker stats" };
  }

  async function restartCount(contenedor) {
    const r = await sh(`docker inspect -f '{{.RestartCount}}' ${contenedor}`, 8000);
    return parseInt((r.salida || "0").trim(), 10) || 0;
  }

  async function metricasBot(contenedor) {
    const r = await sh(`docker exec ${contenedor} cat /app/metrics.json`, 8000);
    if (!r.ok) return null;
    try { return JSON.parse(r.salida); } catch (_) { return null; }
  }

  /**
   * Foto del estado del azul justo antes de mover el tráfico. Sirve de
   * comparación para los 5 criterios durante la ventana de observación.
   *
   * Nota honesta: lo ideal sería comparar contra el promedio de la MISMA
   * hora la semana pasada (como sí hace Centinela con memoria del HOST en
   * prediccion()). Pero Centinela no guarda historial por contenedor —
   * historial.jsonl solo tiene memoria total del servidor — así que para
   * memoria y mensajes/minuto por contenedor no existe ese dato hoy. Se usa
   * en su lugar el estado del azul inmediatamente antes del cambio, que es
   * el dato real más cercano disponible. Ver RIESGOS.md.
   */
  async function medirLineaBase() {
    const [lat, mem, reinicios, metricas] = await Promise.all([
      latenciaMs(3131),
      memoriaMb(CFG.CONTENEDOR_AZUL),
      restartCount(CFG.CONTENEDOR_AZUL),
      metricasBot(CFG.CONTENEDOR_AZUL),
    ]);
    return {
      ts: Date.now(),
      latencia_ms: lat,
      memoria_mb: mem.mb,
      memoria_fuente: mem.fuente,
      reinicios,
      mensajes_in: metricas ? metricas.daily.messagesIn : null,
      mensajes_out: metricas ? metricas.daily.messagesOut : null,
      avg_respuesta_ms: metricas ? metricas.daily.avgResponseMs : null,
    };
  }

  async function medirVerde() {
    const [lat, mem, reinicios, metricas, salud] = await Promise.all([
      latenciaMs(CFG.PUERTO_PANEL_VERDE),
      memoriaMb(CFG.CONTENEDOR_VERDE),
      restartCount(CFG.CONTENEDOR_VERDE),
      metricasBot(CFG.CONTENEDOR_VERDE),
      sh(`docker exec ${CFG.CONTENEDOR_VERDE} curl -sf -m 5 http://localhost:3131/`, 8000),
    ]);
    return {
      ts: Date.now(),
      latencia_ms: lat,
      memoria_mb: mem.mb,
      memoria_fuente: mem.fuente,
      reinicios,
      salud_ok: salud.ok,
      mensajes_in: metricas ? metricas.daily.messagesIn : null,
      mensajes_out: metricas ? metricas.daily.messagesOut : null,
      avg_respuesta_ms: metricas ? metricas.daily.avgResponseMs : null,
    };
  }

  /**
   * Evalúa los 5 criterios comparando la muestra actual del verde contra la
   * línea base del azul y el histórico de fallos de salud acumulado.
   * Devuelve { rompe: bool, criterio, valor, umbral } — o { rompe:false }.
   */
  function evaluarCriterios(base, muestra, fallosSaludSeguidos) {
    // 1) reinicios del contenedor verde
    if (muestra.reinicios > CFG.UMBRAL_REINICIOS_MAX) {
      return { rompe: true, criterio: "Reinicios del contenedor", valor: `${muestra.reinicios} reinicio(s)`, umbral: `> ${CFG.UMBRAL_REINICIOS_MAX}` };
    }
    // 2) fallos de salud seguidos (proxy de "errores 5xx": Traefik no guarda
    //    log de accesos hoy — no hay --accesslog configurado — así que se usa
    //    el mismo chequeo activo que ya hace el healthcheck de Docker, pero
    //    medido por el propio orquestador cada 30s durante la ventana)
    if (fallosSaludSeguidos >= CFG.UMBRAL_FALLOS_SALUD_SEGUIDOS) {
      return { rompe: true, criterio: "Chequeos de salud fallidos (aproxima errores 5xx)", valor: `${fallosSaludSeguidos} seguidos`, umbral: `>= ${CFG.UMBRAL_FALLOS_SALUD_SEGUIDOS}` };
    }
    // 3) tiempo de respuesta
    if (base.latencia_ms && muestra.latencia_ms) {
      const pisoSuperado = muestra.latencia_ms > CFG.UMBRAL_LATENCIA_PISO_MS;
      const multiploSuperado = muestra.latencia_ms > base.latencia_ms * CFG.UMBRAL_LATENCIA_MULT;
      if (pisoSuperado && multiploSuperado) {
        return { rompe: true, criterio: "Tiempo de respuesta", valor: `${Math.round(muestra.latencia_ms)} ms (antes ${Math.round(base.latencia_ms)} ms)`, umbral: `> ${CFG.UMBRAL_LATENCIA_MULT}x` };
      }
    }
    // 4) memoria vs. la que usaba el azul antes del cambio
    if (base.memoria_mb && muestra.memoria_mb) {
      const pisoSuperado = muestra.memoria_mb > CFG.UMBRAL_MEMORIA_PISO_MB;
      const multiploSuperado = muestra.memoria_mb > base.memoria_mb * CFG.UMBRAL_MEMORIA_MULT;
      if (pisoSuperado && multiploSuperado) {
        return { rompe: true, criterio: "Uso de memoria", valor: `${muestra.memoria_mb} MB (antes ${base.memoria_mb} MB)`, umbral: `> ${CFG.UMBRAL_MEMORIA_MULT}x` };
      }
    }
    // 5) mensajes de WhatsApp por minuto, solo si había tráfico suficiente para comparar
    if (base.mensajes_in !== null && muestra.mensajes_in !== null) {
      const minutosTranscurridos = Math.max(1, (muestra.ts - base.ts) / 60000);
      const mensajesEnVentana = muestra.mensajes_in - base.mensajes_in;
      // mensajes_in es un contador diario acumulado desde medianoche: si ya
      // pasó la medianoche entre la línea base y la muestra, el contador se
      // reinició y la resta da negativo — se ignora esa lectura (día nuevo).
      if (mensajesEnVentana >= 0) {
        const porMinutoVerde = mensajesEnVentana / minutosTranscurridos;
        // La "normalidad" con la que se compara es el ritmo de mensajes del
        // azul en lo que va del día (ver nota en medirLineaBase: no existe
        // historial de mensajes/minuto por hora para comparar contra la
        // semana pasada). Si ese ritmo previo era casi nulo, no se evalúa
        // este criterio para no disparar por una tarde de poco tráfico.
        if (base._ritmoPrevioPorMinuto >= (CFG.MENSAJES_MINIMOS_PARA_EVALUAR / 10)) {
          if (porMinutoVerde < base._ritmoPrevioPorMinuto * CFG.UMBRAL_MENSAJES_CAIDA_PCT) {
            return {
              rompe: true, criterio: "Mensajes de WhatsApp procesados",
              valor: `${porMinutoVerde.toFixed(2)}/min (antes ${base._ritmoPrevioPorMinuto.toFixed(2)}/min)`,
              umbral: `< ${Math.round(CFG.UMBRAL_MENSAJES_CAIDA_PCT * 100)}% de lo normal`,
            };
          }
        }
      }
    }
    return { rompe: false };
  }

  async function observar() {
    const base = await medirLineaBase();
    // Aproximación del "ritmo normal": mensajes acumulados hasta el momento
    // del cambio, divididos por los minutos transcurridos desde medianoche.
    // Es un promedio del día, no de los últimos 10 minutos exactos (esa
    // serie no existe hoy) — declarado así de forma explícita para no
    // presentarlo como algo más preciso de lo que es.
    const minutosDesdeMedianoche = (Date.now() - new Date(new Date().toISOString().slice(0, 10) + "T00:00:00.000Z").getTime()) / 60000;
    base._ritmoPrevioPorMinuto = base.mensajes_in && minutosDesdeMedianoche > 0 ? base.mensajes_in / minutosDesdeMedianoche : 0;

    guardarEstado({ fase: "observando", linea_base: base, mensaje: "Vigilando el contenedor verde durante 10 minutos." });
    auditar("despliegue_observando", "agente", "inicio", JSON.stringify(base).slice(0, 300));

    const finVentana = Date.now() + CFG.VENTANA_OBSERVACION_MS;
    let fallosSaludSeguidos = 0;
    const muestras = [];

    while (Date.now() < finVentana) {
      if (cancelado === "promover") return { salida: "promover_manual" };
      if (cancelado === "revertir") return { salida: "revertir_manual" };

      const m = await medirVerde();
      fallosSaludSeguidos = m.salud_ok ? 0 : fallosSaludSeguidos + 1;
      muestras.push(m);
      guardarEstado({ muestras: muestras.slice(-40) });

      const veredicto = evaluarCriterios(base, m, fallosSaludSeguidos);
      if (veredicto.rompe) {
        guardarEstado({ criterio_fallido: veredicto });
        auditar("despliegue_criterio_fallido", "agente", veredicto.criterio, veredicto.valor);
        return { salida: "revertir_automatico", criterio: veredicto };
      }

      await dormir(CFG.INTERVALO_MUESTRA_MS);
    }
    return { salida: "ventana_completa" };
  }

  // ── Fase 5a: revertir ────────────────────────────────────────────────────

  async function apagarVerde() {
    await sh(comandoCompose(`stop ${CFG.SERVICIO_VERDE}`), 30000);
    await sh(comandoCompose(`rm -f ${CFG.SERVICIO_VERDE}`), 15000);
    try { fs.unlinkSync(path.join(CFG.PROYECTO_DIR, CFG.COMPOSE_VERDE)); } catch (_) {}
  }

  async function revertir(quien, motivo) {
    guardarEstado({ fase: "revirtiendo", mensaje: "Devolviendo el tráfico al contenedor anterior." });
    try {
      cambiarTrafico("azul");
    } catch (e) {
      // Si ni siquiera se pudo editar Traefik, es la peor situación posible
      // (el verde, sin probar del todo, puede seguir recibiendo tráfico).
      // Se avisa de inmediato en vez de seguir la secuencia normal.
      auditar("despliegue_revertir_error_critico", "agente", "error", e.message);
      await enviarWhatsapp(
        `Zeus — ALERTA: no pude revertir el tráfico automáticamente\n\n` +
        `Motivo original: ${motivo}\n` +
        `Error al editar Traefik: ${e.message}\n\n` +
        `Entra al servidor cuanto antes: revisa ${CFG.TRAEFIK_DYNAMIC_FILE} a mano.\n\npanel.ejemplo.com`
      ).catch(() => {});
      guardarEstado({ fase: "error", error: e.message, fin: new Date().toISOString() });
      return;
    }
    await apagarVerde();
    const est = guardarEstado({ fase: "revertido", fin: new Date().toISOString(), mensaje: motivo });
    auditar("despliegue_revertido", quien, "ok", motivo);
    await enviarWhatsapp(
      `Zeus — despliegue revertido\n\n` +
      `${motivo}\n\n` +
      `El bot sigue funcionando con la versión anterior. No se perdió ninguna conversación.\n\npanel.ejemplo.com`
    ).catch(() => {});
    return est;
  }

  // ── Fase 5b: promover ────────────────────────────────────────────────────

  /**
   * El verde pasa a llamarse zeus-bot. Reutiliza la MISMA imagen ya probada
   * (se retagea, no se reconstruye) para que lo promovido sea exactamente lo
   * que pasó las pruebas de humo y los 10 minutos de observación.
   */
  async function promover(quien) {
    guardarEstado({ fase: "promoviendo", mensaje: "Promoviendo la versión nueva a definitiva." });

    const tagAzul = await sh(`docker inspect -f '{{.Config.Image}}' ${CFG.CONTENEDOR_AZUL}`, 8000);
    const idVerde = await sh(`docker inspect -f '{{.Image}}' ${CFG.CONTENEDOR_VERDE}`, 8000);
    if (!tagAzul.ok || !idVerde.ok) {
      const err = "No pude leer la imagen de alguno de los dos contenedores; no se promovió nada, el verde sigue sirviendo tráfico.";
      guardarEstado({ fase: "error", error: err, fin: new Date().toISOString() });
      auditar("despliegue_promover_error", quien, "error", err);
      return { ok: false, mensaje: err };
    }
    const nombreImagen = tagAzul.salida.trim();
    await sh(`docker tag ${idVerde.salida.trim()} ${nombreImagen}`, 8000);

    await sh(comandoCompose(`stop ${CFG.SERVICIO_AZUL}`), 30000);
    await sh(comandoCompose(`rm -f ${CFG.SERVICIO_AZUL}`), 15000);
    // Sin --build: compose no reconstruye si la imagen ya existe con ese tag,
    // así que arranca exactamente la imagen recién retageada.
    const up = await sh(comandoCompose(`up -d --no-deps ${CFG.SERVICIO_AZUL}`), 60000);
    if (!up.ok) {
      const err = "El contenedor zeus-bot nuevo no pudo levantarse tras promover. El tráfico sigue en zeus-bot-verde mientras se investiga.";
      guardarEstado({ fase: "error", error: err, fin: new Date().toISOString() });
      auditar("despliegue_promover_error", quien, "error", (up.error || up.salida).slice(0, 300));
      await enviarWhatsapp(`Zeus — ALERTA en la promoción del despliegue\n\n${err}\n\npanel.ejemplo.com`).catch(() => {});
      return { ok: false, mensaje: err };
    }
    await dormir(10000);
    const salud = await sh(`docker exec ${CFG.CONTENEDOR_AZUL} curl -sf -m 5 http://localhost:3131/`, 8000);
    if (!salud.ok) {
      const err = "zeus-bot (recién promovido) no responde. El tráfico sigue en zeus-bot-verde, que sí funciona, mientras se investiga.";
      guardarEstado({ fase: "error", error: err, fin: new Date().toISOString() });
      auditar("despliegue_promover_error", quien, "error", "salud post-promoción falló");
      await enviarWhatsapp(`Zeus — ALERTA en la promoción del despliegue\n\n${err}\n\npanel.ejemplo.com`).catch(() => {});
      return { ok: false, mensaje: err };
    }

    // Recién aquí, con el nuevo zeus-bot confirmado sano, se apaga el verde
    // y se regresa Traefik al nombre permanente "zeus-bot".
    cambiarTrafico("azul");
    await apagarVerde();

    const est = guardarEstado({ fase: "completado", fin: new Date().toISOString(), mensaje: "Despliegue promovido: la versión nueva es ahora la definitiva." });
    auditar("despliegue_promovido", quien, "ok", nombreImagen);
    await enviarWhatsapp(
      `Zeus — despliegue completado\n\n` +
      `La versión nueva del bot ya es la definitiva. Todo funcionó bien durante la prueba.\n\npanel.ejemplo.com`
    ).catch(() => {});
    return { ok: true, mensaje: "Promovido", estado: est };
  }

  // ── Orquestación completa ────────────────────────────────────────────────

  async function iniciar(quien) {
    if (enCurso()) return { ok: false, mensaje: "Ya hay un despliegue en curso." };
    cancelado = null;
    guardarJsonLocal(F_ESTADO, Object.assign(estadoInicial(), {
      fase: "construyendo", quien, inicio: new Date().toISOString(), mensaje: "Construyendo la versión nueva en un contenedor aparte (zeus-bot-verde).",
    }));
    auditar("despliegue_iniciado", quien, "ok", "");

    // Se ejecuta en segundo plano: la llamada HTTP que dispara esto no debe
    // quedar colgada 10+ minutos. El panel consulta el progreso con
    // /api/despliegue/estado (ver INTEGRACION-DESPLIEGUES.md).
    (async () => {
      try {
        const construccion = await construirVerde();
        if (!construccion.ok) {
          guardarEstado({ fase: "error", error: construccion.mensaje, fin: new Date().toISOString() });
          auditar("despliegue_error", quien, "construccion", construccion.detalle || construccion.mensaje);
          await enviarWhatsapp(`Zeus — el despliegue no pudo construirse\n\n${construccion.mensaje}\n\nEl bot sigue con la versión anterior, sin cambios.\n\npanel.ejemplo.com`).catch(() => {});
          return;
        }

        guardarEstado({ fase: "pruebas", mensaje: "Corriendo pruebas de humo sobre el contenedor verde (sin tráfico real todavía)." });
        const pruebas = await pruebasDeHumo();
        guardarEstado({ pruebas: pruebas.pruebas });
        if (!pruebas.ok) {
          auditar("despliegue_pruebas_fallidas", quien, "falló", pruebas.pruebas.filter((p) => !p.ok).map((p) => p.nombre).join(", "));
          await apagarVerde();
          guardarEstado({ fase: "error", error: "Pruebas de humo fallidas", fin: new Date().toISOString() });
          await enviarWhatsapp(
            `Zeus — el despliegue se detuvo en las pruebas\n\n` +
            pruebas.pruebas.filter((p) => !p.ok).map((p) => `- ${p.nombre}: ${p.detalle}`).join("\n") +
            `\n\nEl bot sigue funcionando con la versión anterior, sin ningún cambio.\n\npanel.ejemplo.com`
          ).catch(() => {});
          return;
        }

        guardarEstado({ fase: "cambiando_trafico", mensaje: "Moviendo el tráfico al contenedor verde." });
        cambiarTrafico("verde");
        auditar("despliegue_trafico_verde", quien, "ok", "");
        await dormir(3000); // margen para que Traefik recargue el archivo (watch=true)

        const resultado = await observar();

        if (resultado.salida === "revertir_manual") {
          await revertir(quien, "Reversión manual solicitada desde el panel durante la observación.");
        } else if (resultado.salida === "revertir_automatico") {
          await revertir("agente", `Se revirtió automáticamente. Criterio: ${resultado.criterio.criterio} (${resultado.criterio.valor}, umbral ${resultado.criterio.umbral}).`);
        } else if (resultado.salida === "promover_manual") {
          await promover(quien);
        } else {
          // ventana_completa: los 10 minutos pasaron sin romper ningún criterio
          await promover("agente");
        }
      } catch (e) {
        auditar("despliegue_excepcion", quien, "error", e.message);
        guardarEstado({ fase: "error", error: e.message, fin: new Date().toISOString() });
        // Ante cualquier excepción no prevista, el estado más seguro es dejar
        // el tráfico en el azul: si ya se había movido a verde, se intenta
        // devolver. Si esto también falla, ya se avisó dentro de revertir().
        try {
          const est = estado();
          if (est.fase !== "revertido" && est.fase !== "completado") {
            await revertir(quien, `Reversión de emergencia por un error no previsto: ${e.message}`);
          }
        } catch (_) {}
      }
    })();

    return { ok: true, mensaje: "Despliegue iniciado. Consulta el progreso en el panel." };
  }

  function revertirAhora(quien) {
    if (estado().fase !== "observando") return { ok: false, mensaje: "Solo se puede revertir manualmente durante la ventana de observación." };
    cancelado = "revertir";
    auditar("despliegue_revertir_manual_solicitado", quien, "ok", "");
    return { ok: true, mensaje: "Revirtiendo ahora." };
  }

  function promoverAhora(quien) {
    if (estado().fase !== "observando") return { ok: false, mensaje: "Solo se puede promover manualmente durante la ventana de observación." };
    cancelado = "promover";
    auditar("despliegue_promover_manual_solicitado", quien, "ok", "");
    return { ok: true, mensaje: "Promoviendo ahora, sin esperar el resto de los 10 minutos." };
  }

  return { iniciar, estado, revertirAhora, promoverAhora, CFG };
}

module.exports = { crearOrquestadorDespliegue, CFG };
