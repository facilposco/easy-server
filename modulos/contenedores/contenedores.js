"use strict";
/**
 * Centinela Zeus — módulo de gestión de contenedores.
 *
 * PROPUESTA AISLADA, igual que `modulos/simulacros/simulacros.js`: no toca
 * nada hasta que `ops-server.js` lo `require()`, lo instancie con
 * `crearContenedores(deps)` y llame a sus funciones desde rutas HTTP nuevas.
 * Ver `INTEGRACION-CONTENEDORES.md` para los puntos exactos de conexión.
 *
 * Implementado al pie de la letra sobre `DISENO-CONTENEDORES.md`. Cero
 * dependencias externas: solo `fs`, `path`, `crypto` y `child_process.spawn`
 * de Node 20 (el resto de comandos de una sola vez usan `sh()`, inyectada).
 *
 * ── Por qué existe la marca de mantenimiento ─────────────────────────────
 * `revisarIncidentesInterno` (en ops-server.js) audita cualquier `die/kill/
 * stop` de Docker y, si el contenedor no ha vuelto en la siguiente revisión,
 * abre un incidente y avisa por WhatsApp como si el servicio se hubiera
 * caído solo. Un reinicio pedido a propósito desde este módulo no es una
 * falla, así que cada operación deliberada marca el contenedor "en
 * mantenimiento" ANTES de tocarlo; `revisarIncidentesInterno` debe consultar
 * `enMantenimiento(nombre)` y saltárselo mientras la marca esté vigente
 * (edición #3 de INTEGRACION-CONTENEDORES.md).
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

// ── Utilidades locales (mismo estilo que simulacros.js) ─────────────────────

function dormir(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function leerJsonLocal(archivo, porDefecto) {
  try { return JSON.parse(fs.readFileSync(archivo, "utf8")); } catch (_) { return porDefecto; }
}

function guardarJsonLocal(archivo, obj) {
  try { fs.writeFileSync(archivo, JSON.stringify(obj, null, 2)); } catch (_) {}
}

function anexarLocal(archivo, obj) {
  try { fs.appendFileSync(archivo, JSON.stringify(obj) + "\n"); } catch (_) {}
}

function leerJsonlLocal(archivo, max) {
  try {
    const lineas = fs.readFileSync(archivo, "utf8").trim().split("\n").slice(-(max || 20000));
    return lineas.filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
  } catch (_) { return []; }
}

/** Comparación de PIN de longitud constante (copiada de simulacros.js). */
function pinValido(candidato, real) {
  const a = String(candidato == null ? "" : candidato);
  const b = String(real == null ? "" : real);
  const max = Math.max(a.length, b.length, 1);
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < max; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

function minutosHastaHoraUtc(horaUtc) {
  const ahora = new Date();
  const obj = new Date(Date.UTC(ahora.getUTCFullYear(), ahora.getUTCMonth(), ahora.getUTCDate(), horaUtc, 0, 0));
  if (obj < ahora) obj.setUTCDate(obj.getUTCDate() + 1);
  return (obj - ahora) / 60000;
}

/** Minutos hasta el próximo día de reinicio completo del servidor a
 * `horaUtc`:00 UTC — uno de cada tres días (mismo cálculo que
 * modulos/reinicio_diario.sh y esDiaDeReinicioCompleto en contenedores.js). */
function minutosHastaProximoReinicioCompleto(horaUtc) {
  const ahora = new Date();
  let diasHasta = 0;
  while (true) {
    const candidato = new Date(Date.UTC(ahora.getUTCFullYear(), ahora.getUTCMonth(), ahora.getUTCDate() + diasHasta, horaUtc, 0, 0));
    const diaEpoch = Math.floor(candidato.getTime() / 86400000);
    if (diaEpoch % 3 === 0 && candidato >= ahora) return (candidato - ahora) / 60000;
    diasHasta++;
    if (diasHasta > 3) return 0; // no debería pasar nunca, pero evita un bucle infinito
  }
}

/** Nombre de contenedor: solo lo que ya acepta Docker, nunca llega a un shell sin validar. */
const RE_NOMBRE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** "512.3MiB" → bytes. Sufijos que puede devolver `docker stats`. */
function tamanoABytes(txt) {
  const m = String(txt || "").trim().match(/^([\d.]+)\s*([a-zA-Z]+)$/);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const u = m[2].toLowerCase();
  const factores = {
    b: 1,
    kb: 1000, kib: 1024,
    mb: 1000 ** 2, mib: 1024 ** 2,
    gb: 1000 ** 3, gib: 1024 ** 3,
    tb: 1000 ** 4, tib: 1024 ** 4,
  };
  return Math.round(n * (factores[u] || 0));
}

/**
 * Sondea `comprobar()` hasta que devuelva un valor "truthy" o se agote
 * `timeoutMs`. Copiado de simulacros.js (mismo contrato).
 */
async function esperar(comprobar, timeoutMs, intervaloMs, ctx) {
  const inicio = Date.now();
  const paso = intervaloMs || 1000;
  while (Date.now() - inicio < timeoutMs) {
    if (ctx && ctx.abortado) return { logrado: false, ms: Date.now() - inicio, valor: null };
    let v;
    try { v = await comprobar(); } catch (_) { v = null; }
    if (v) return { logrado: true, ms: Date.now() - inicio, valor: v };
    await dormir(paso);
  }
  let v = null;
  try { v = await comprobar(); } catch (_) {}
  return { logrado: !!v, ms: Date.now() - inicio, valor: v };
}

// ── Constantes de política (§3.3 del diseño) ────────────────────────────────

const GRACIA_STOP = { "zeus-mariadb": 90, "zeus-chromadb": 30, "zeus-bot": 20, "zeus-proxy": 10 };
const GRACIA_STOP_POR_DEFECTO = 30;

const ESPERA_SANO_S = { "zeus-mariadb": 120 };
const ESPERA_SANO_POR_DEFECTO_S = 60;
const ESTABLE_SIN_CHEQUEO_S = 10;

const DEPENDIENTES = { "zeus-mariadb": ["zeus-bot"], "zeus-chromadb": ["zeus-bot"] };

const NO_DETENER = new Set(["zeus-proxy", "zeus-mariadb"]);

const CON_HOMBRE_MUERTO = { "zeus-proxy": 120, "zeus-mariadb": 240 };

const MAX_DETENIDO_S = 12 * 3600;

const PALABRA_AJENO = "OTRO-PROYECTO";
const PALABRA_APAGAR = "APAGAR";

// Límites de la vista de registros en vivo (§4.6)
const REGISTROS_MAX_STREAMS = 2;
const REGISTROS_DURACION_MS = 10 * 60 * 1000;
const REGISTROS_MAX_LINEAS = 3000;
const REGISTROS_RAFAGA_MAX = 100;
const REGISTROS_LARGO_LINEA = 500;
const REGISTROS_BUFFER_PARCIAL = 64 * 1024;

// ── Fábrica del módulo ───────────────────────────────────────────────────────
/**
 * @param {object} deps
 * @param {function} deps.sh                igual que sh() en ops-server.js
 * @param {function} deps.auditar           igual que auditar() en ops-server.js
 * @param {function} deps.enviarWhatsapp    igual que enviarWhatsapp() en ops-server.js
 * @param {function} deps.leerContenedores  lista cacheada 15s; única fuente de nombres válidos
 * @param {function} deps.leerMemoria       → {total, usada, disponible, pct}
 * @param {Map}      deps.cache             el Map de caché de ops-server.js
 * @param {string}   deps.DIR_DATOS         "/var/lib/zeus-ops"
 * @param {object}   deps.env               objeto de leerEnv(".env") → PIN_ACCION (nuevo, opcional respaldo PIN_SIMULACRO)
 * @param {Set}      deps.CONTENEDORES_PROPIOS
 * @param {object}   deps.DESCRIPCIONES
 * @param {function} [deps.explicar]        opcional: explicar(nombre,motivo,ram,disco) de ops-server.js
 * @param {number}   [deps.HORA_REINICIO_UTC] por defecto 9
 * @param {number}   [deps.HORA_RESPALDO_UTC]  por defecto 8
 * @param {function} [deps.hayBloqueoExterno]  () => bool; por defecto siempre false
 */
function crearContenedores(deps) {
  if (typeof deps.sh !== "function") throw new Error("crearContenedores necesita la función sh() de ops-server.js");
  if (typeof deps.auditar !== "function") throw new Error("crearContenedores necesita la función auditar() de ops-server.js");
  if (typeof deps.leerContenedores !== "function") throw new Error("crearContenedores necesita leerContenedores() de ops-server.js");
  if (!deps.DIR_DATOS) throw new Error("crearContenedores necesita DIR_DATOS de ops-server.js");
  if (!deps.CONTENEDORES_PROPIOS) throw new Error("crearContenedores necesita CONTENEDORES_PROPIOS de ops-server.js");

  const sh = deps.sh;
  const auditar = deps.auditar;
  const enviarWhatsapp = deps.enviarWhatsapp || (async () => ({ ok: false }));
  const leerContenedoresBase = deps.leerContenedores;
  const leerMemoria = deps.leerMemoria || (() => ({ total: 0, usada: 0, disponible: 0, pct: 0 }));
  const env = deps.env || {};
  const CONTENEDORES_PROPIOS = deps.CONTENEDORES_PROPIOS;
  const DESCRIPCIONES = deps.DESCRIPCIONES || {};
  const explicarFn = typeof deps.explicar === "function" ? deps.explicar : null;
  const HORA_REINICIO_UTC = typeof deps.HORA_REINICIO_UTC === "number" ? deps.HORA_REINICIO_UTC : 9;
  const HORA_RESPALDO_UTC = typeof deps.HORA_RESPALDO_UTC === "number" ? deps.HORA_RESPALDO_UTC : 8;
  const hayBloqueoExterno = typeof deps.hayBloqueoExterno === "function" ? deps.hayBloqueoExterno : () => false;

  const DIR_CONT = path.join(deps.DIR_DATOS, "contenedores");
  const F_OPERACIONES = path.join(deps.DIR_DATOS, "contenedores-operaciones.json");
  const F_MANTENIMIENTO = path.join(deps.DIR_DATOS, "contenedores-mantenimiento.json");

  fs.mkdirSync(DIR_CONT, { recursive: true });

  function descripcionDe(nombre) { return DESCRIPCIONES[nombre] || nombre; }
  function esPropio(nombre) { return CONTENEDORES_PROPIOS.has(nombre); }

  function archivoCorrida(runId) { return path.join(DIR_CONT, runId + ".jsonl"); }

  function invalidarCache() {
    if (!deps.cache || typeof deps.cache.delete !== "function") return;
    deps.cache.delete("contenedores");
    deps.cache.delete("contenedores_vista");
    for (const k of Array.from(deps.cache.keys ? deps.cache.keys() : [])) {
      if (typeof k === "string" && k.startsWith("contenedor_ficha_")) deps.cache.delete(k);
    }
  }

  async function cacheadoLocal(clave, segundos, fn) {
    if (!deps.cache) return fn();
    const hit = deps.cache.get(clave);
    if (hit && Date.now() - hit.t < segundos * 1000) return hit.v;
    const v = await fn();
    deps.cache.set(clave, { t: Date.now(), v });
    return v;
  }

  // ── Marca de mantenimiento (§3.4) ─────────────────────────────────────────
  // nombre -> { motivo:"reinicio"|"detenido", desde:iso, hasta:iso, quien, run_id }
  const mantenimiento = new Map();

  function cargarMantenimientoDeDisco() {
    const disco = leerJsonLocal(F_MANTENIMIENTO, {});
    const ahora = Date.now();
    for (const [nombre, m] of Object.entries(disco || {})) {
      if (m && new Date(m.hasta).getTime() > ahora) mantenimiento.set(nombre, m);
    }
  }
  cargarMantenimientoDeDisco();

  function guardarMantenimientoDisco() {
    const obj = {};
    for (const [nombre, m] of mantenimiento) obj[nombre] = m;
    guardarJsonLocal(F_MANTENIMIENTO, obj);
  }

  /**
   * Marca `nombre` como intervenido a propósito durante `segundos`. La usa
   * toda operación deliberada de este módulo y también el botón viejo de
   * "Reiniciar" de Inicio (edición #5 de la INTEGRACION), para que
   * `revisarIncidentesInterno` no la confunda con una caída real.
   */
  function marcarMantenimiento(nombre, segundos, motivo, quien, runId) {
    const desde = new Date();
    const hasta = new Date(Date.now() + Math.max(1, segundos || 180) * 1000);
    const m = { motivo: motivo || "reinicio", desde: desde.toISOString(), hasta: hasta.toISOString(), quien: quien || "panel", run_id: runId || null };
    mantenimiento.set(nombre, m);
    guardarMantenimientoDisco();
    return m;
  }

  function limpiarMantenimiento(nombre) {
    if (mantenimiento.delete(nombre)) guardarMantenimientoDisco();
  }

  /**
   * Devuelve la marca vigente (objeto) o `null`. Es truthy/falsy tal cual lo
   * necesita `revisarIncidentesInterno` (`if (contenedores.enMantenimiento(n)) continue;`)
   * y a la vez sirve para que `estadoGeneral` (edición #4) sepa el motivo.
   */
  function enMantenimiento(nombre) {
    const m = mantenimiento.get(nombre);
    if (!m) return null;
    if (new Date(m.hasta).getTime() < Date.now()) { mantenimiento.delete(nombre); guardarMantenimientoDisco(); return null; }
    return m;
  }

  // ── Persistencia de operaciones (historial, §4.7) ────────────────────────
  function estadoOperaciones() { return leerJsonLocal(F_OPERACIONES, { en_curso: null, ultimas: [] }); }
  function guardarEstadoOperaciones(o) { guardarJsonLocal(F_OPERACIONES, o); }

  let enCurso = null; // { run_id, operacion, contenedor, propio, en_orden, inicio, ctx }

  function bloqueado() { return !!enCurso; }

  // ── Bus de eventos SSE — formato idéntico a simulacros.js (§5) ───────────
  const suscriptores = new Map();
  const latidos = new Map();
  const contadoresSeq = new Map();

  function siguienteSeq(runId) {
    if (!contadoresSeq.has(runId)) {
      const previos = leerJsonlLocal(archivoCorrida(runId));
      const maxPrevio = previos.reduce((m, e) => (typeof e.seq === "number" && e.seq > m ? e.seq : m), -1);
      contadoresSeq.set(runId, maxPrevio + 1);
    }
    const n = contadoresSeq.get(runId);
    contadoresSeq.set(runId, n + 1);
    return n;
  }

  function emitirEvento(runId, contenedorRef, operacion, fase, nivel, texto, dato) {
    const evento = {
      ts: new Date().toISOString(),
      run_id: runId,
      contenedor: contenedorRef,
      operacion,
      seq: siguienteSeq(runId),
      fase, nivel, texto,
      dato: dato === undefined ? undefined : dato,
    };
    anexarLocal(archivoCorrida(runId), evento);
    const subs = suscriptores.get(runId);
    if (subs && subs.size) {
      const payload = `event: paso\nid: ${evento.seq}\ndata: ${JSON.stringify(evento)}\n\n`;
      for (const res of subs) { try { res.write(payload); } catch (_) {} }
    }
    return evento;
  }

  function cerrarSuscriptores(runId, datoFinal) {
    const subs = suscriptores.get(runId);
    if (subs) {
      const payload = `event: fin\ndata: ${JSON.stringify(datoFinal || {})}\n\n`;
      for (const res of subs) { try { res.write(payload); res.end(); } catch (_) {} }
      suscriptores.delete(runId);
    }
    const latido = latidos.get(runId);
    if (latido) { clearInterval(latido); latidos.delete(runId); }
    contadoresSeq.delete(runId);
  }

  /** Engancha una respuesta HTTP como cliente SSE de una operación. `false` si el run_id no existe. */
  function suscribir(runId, res, desde) {
    const archivo = archivoCorrida(runId);
    if (!fs.existsSync(archivo)) return false;

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write("retry: 3000\n\n");

    const desdeSeq = Number.isFinite(desde) ? desde : -1;
    for (const ev of leerJsonlLocal(archivo)) {
      if (ev.seq > desdeSeq) res.write(`event: paso\nid: ${ev.seq}\ndata: ${JSON.stringify(ev)}\n\n`);
    }

    const activa = enCurso && enCurso.run_id === runId;
    if (!activa) {
      res.write("event: fin\ndata: {}\n\n");
      res.end();
      return true;
    }

    if (!suscriptores.has(runId)) suscriptores.set(runId, new Set());
    suscriptores.get(runId).add(res);
    if (!latidos.has(runId)) {
      latidos.set(runId, setInterval(() => {
        const subs = suscriptores.get(runId);
        if (!subs) return;
        for (const r of subs) { try { r.write(": ping\n\n"); } catch (_) {} }
      }, 15000));
    }
    res.on("close", () => {
      const subs = suscriptores.get(runId);
      if (subs) { subs.delete(res); if (!subs.size) suscriptores.delete(runId); }
    });
    return true;
  }

  function limpiarCorridasViejas() {
    const limite = Date.now() - 30 * 24 * 3600 * 1000;
    let archivos = [];
    try { archivos = fs.readdirSync(DIR_CONT); } catch (_) { return; }
    for (const f of archivos) {
      if (!f.endsWith(".jsonl")) continue;
      const ruta = path.join(DIR_CONT, f);
      try { if (fs.statSync(ruta).mtimeMs < limite) fs.unlinkSync(ruta); } catch (_) {}
    }
  }

  // ── Precondición: ¿el driver de logging soporta `--until`? (§4.4) ────────
  async function driverLogsCompatible() {
    return cacheadoLocal("contenedores_driver_logs", 3600, async () => {
      const r = await sh("docker info --format '{{.LoggingDriver}}'", 10000);
      const d = (r.salida || "").trim();
      return d === "json-file" || d === "local";
    });
  }

  // ── Listado con recursos (§4.1) ───────────────────────────────────────────

  function nivelConfirmacion(nombre, accion, propio, estadoActual) {
    if (accion === "reiniciar") {
      if (!propio) return { confirmacion: "palabra_pin", palabra: PALABRA_AJENO };
      if (nombre === "zeus-mariadb" || nombre === "zeus-proxy") return { confirmacion: "palabra", palabra: nombre };
      return { confirmacion: "hoja", palabra: null };
    }
    if (accion === "detener") {
      if (!propio) return { confirmacion: "palabra_pin", palabra: PALABRA_AJENO };
      return { confirmacion: "palabra", palabra: PALABRA_APAGAR };
    }
    if (accion === "arrancar") {
      if (!propio) return { confirmacion: "hoja", palabra: null };
      return { confirmacion: "ninguna", palabra: null };
    }
    return { confirmacion: "ninguna", palabra: null };
  }

  function avisoReiniciar(nombre) {
    if (nombre === "zeus-mariadb") return "El bot y la tienda no podrán guardar nada durante un minuto aproximadamente.";
    if (nombre === "zeus-proxy") return "La puerta de entrada es por donde entra este panel. Durante unos 10 segundos el panel no responderá y la consola se quedará muda; se reconecta sola.";
    if (nombre === "zeus-bot") return "El bot dejará de contestar en WhatsApp unos segundos mientras reinicia.";
    if (nombre === "zeus-chromadb") return "La memoria de búsqueda del bot estará apagada unos segundos; puede responder un poco peor mientras tanto.";
    return "No sé cuánto tardará este servicio en volver: es de otro proyecto y Centinela no lo vigila.";
  }

  function accionesPara(c, hayOperacionEnCurso) {
    const propio = esPropio(c.nombre);
    const running = c.estado === "running";
    const acciones = {};

    // reiniciar
    {
      const niv = nivelConfirmacion(c.nombre, "reiniciar", propio, c.estado);
      acciones.reiniciar = {
        permitida: !hayOperacionEnCurso,
        confirmacion: niv.confirmacion, palabra: niv.palabra,
        en_orden_disponible: !!DEPENDIENTES[c.nombre],
        aviso: avisoReiniciar(c.nombre),
      };
      if (hayOperacionEnCurso) acciones.reiniciar.motivo = "Hay una operación en curso.";
    }
    // detener
    {
      const niv = nivelConfirmacion(c.nombre, "detener", propio, c.estado);
      if (NO_DETENER.has(c.nombre)) {
        acciones.detener = { permitida: false, motivo: c.nombre === "zeus-proxy"
          ? "La puerta de entrada es por donde entra este panel; no se puede apagar desde aquí."
          : "Apagar la base de datos deja al bot y a la tienda sin funcionar; usa Reiniciar." };
      } else if (!running) {
        acciones.detener = { permitida: false, motivo: "Ya está apagado." };
      } else {
        acciones.detener = { permitida: !hayOperacionEnCurso, confirmacion: niv.confirmacion, palabra: niv.palabra };
        if (hayOperacionEnCurso) acciones.detener.motivo = "Hay una operación en curso.";
      }
    }
    // arrancar
    {
      const niv = nivelConfirmacion(c.nombre, "arrancar", propio, c.estado);
      if (running) {
        acciones.arrancar = { permitida: false, motivo: "Ya está encendida." };
      } else {
        acciones.arrancar = { permitida: !hayOperacionEnCurso, confirmacion: niv.confirmacion, palabra: niv.palabra };
        if (hayOperacionEnCurso) acciones.arrancar.motivo = "Hay una operación en curso.";
      }
    }
    acciones.registros = { permitida: true };
    acciones.ficha = { permitida: true };
    return acciones;
  }

  function estadoTexto(c, mant) {
    if (mant && mant.motivo === "detenido") return "Apagado a propósito";
    if (mant && mant.motivo === "reinicio") return "Reiniciándose";
    if (c.estado === "paused") return "Congelado";
    if (c.estado === "running" && c.salud === "unhealthy") return "No responde";
    if (c.estado === "running") return "Funciona";
    return "Apagado";
  }

  async function listar() {
    const base = await leerContenedoresBase();
    const ram = leerMemoria();

    const stats = await cacheadoLocal("contenedores_vista", 15, async () => {
      const r = await sh("docker stats --no-stream --format '{{.Name}};{{.MemUsage}};{{.MemPerc}};{{.CPUPerc}}'", 20000);
      const mapa = {};
      for (const l of (r.salida || "").split("\n").filter(Boolean)) {
        const [n, memUsage, memPct, cpuPct] = l.split(";");
        const partes = (memUsage || "").split("/");
        mapa[n] = {
          memoria_bytes: tamanoABytes((partes[0] || "").trim()),
          memoria_limite_bytes: tamanoABytes((partes[1] || "").trim()) || ram.total,
          cpu_pct: parseFloat((cpuPct || "0").replace("%", "")) || 0,
        };
      }
      return mapa;
    });

    const hayOperacionEnCurso = bloqueado();
    const propios = [], ajenos = [];
    // RestartCount de Docker no sube con `docker start` manual, solo con la
    // política de auto-reinicio del propio Docker — así que un reinicio hecho
    // desde este panel se cuenta aparte, o el operador ve "sin reinicios"
    // justo después de haber reiniciado algo con sus propios ojos.
    const HACE_24H = Date.now() - 24 * 3600 * 1000;
    const reiniciosPorPanel = {};
    for (const op of (estadoOperaciones().ultimas || [])) {
      if (op.operacion !== "reiniciar" || op.resultado !== "ok") continue;
      if (!op.fin || new Date(op.fin).getTime() < HACE_24H) continue;
      reiniciosPorPanel[op.contenedor] = (reiniciosPorPanel[op.contenedor] || 0) + 1;
    }

    for (const c of base) {
      const mant = enMantenimiento(c.nombre);
      const uso = stats[c.nombre] || { memoria_bytes: 0, memoria_limite_bytes: ram.total, cpu_pct: 0 };
      const obj = {
        nombre: c.nombre,
        descripcion: descripcionDe(c.nombre),
        propio: esPropio(c.nombre),
        estado: c.estado,
        estado_texto: estadoTexto(c, mant),
        salud: c.salud,
        politica: c.politica,
        reinicios: c.reinicios,
        reinicios_por_panel: reiniciosPorPanel[c.nombre] || 0,
        arrancado_ms: c.arrancado_ms,
        encendido_s: c.arrancado_ms ? Math.max(0, Math.round((Date.now() - c.arrancado_ms) / 1000)) : 0,
        memoria_bytes: uso.memoria_bytes,
        memoria_limite_bytes: uso.memoria_limite_bytes,
        memoria_pct_host: ram.total ? Math.round((uso.memoria_bytes / ram.total) * 100) : 0,
        cpu_pct: uso.cpu_pct,
        mantenimiento: mant,
        acciones: accionesPara(c, hayOperacionEnCurso),
      };
      (obj.propio ? propios : ajenos).push(obj);
    }

    return {
      ts: new Date().toISOString(),
      ram_total_bytes: ram.total,
      en_curso: enCurso ? { run_id: enCurso.run_id, operacion: enCurso.operacion, contenedor: enCurso.contenedor, inicio: enCurso.inicio } : null,
      propios, ajenos,
    };
  }

  // ── Ficha + última parada (§4.4) ─────────────────────────────────────────

  function traducirPolitica(pol) {
    if (pol === "unless-stopped" || pol === "always") return "Vuelve solo si se cae";
    if (pol === "on-failure") return "Vuelve solo si falla";
    return "No vuelve solo";
  }

  // Desde que el mantenimiento diario de las 4:00 dejó de reiniciar el
  // servidor completo todos los días (ver DISEÑO reinicio-diario, 13-sep-2026,
  // actualizado a ciclo de 3 días): zeus-bot se reinicia solo todos los días;
  // el resto (mariadb, chromadb, proxy) solo debería pararse ahí el día de
  // reinicio completo, uno de cada tres — mismo cálculo que
  // modulos/reinicio_diario.sh: días desde 1-ene-1970, módulo 3.
  function esDiaDeReinicioCompleto(fecha) {
    const diaEpoch = Math.floor(fecha.getTime() / 86400000);
    return diaEpoch % 3 === 0;
  }
  function clasificarUltimaParada(insp, codigo, oom, cuando, nombre) {
    const ahoraProgramado = (() => {
      if (!cuando) return false;
      const h = cuando.getUTCHours(), m = cuando.getUTCMinutes();
      const totalMin = h * 60 + m;
      const objetivo = HORA_REINICIO_UTC * 60;
      const dentroDeVentana = Math.abs(totalMin - objetivo) <= 10;
      if (!dentroDeVentana) return false;
      return nombre === "zeus-bot" || esDiaDeReinicioCompleto(cuando);
    })();
    if (ahoraProgramado) {
      const titulo = nombre === "zeus-bot"
        ? "Se apagó por el mantenimiento diario del bot (4:00 a. m.). Es normal."
        : "Se apagó por el reinicio completo del servidor (cada 3 días, 4:00 a. m.). Es normal.";
      return { tipo: "reinicio_programado", titulo };
    }
    if (oom) return { tipo: "inesperado", titulo: "Se quedó sin memoria y el sistema lo cortó." };
    if (codigo === 137) return { tipo: "inesperado", titulo: "Lo apagaron a la fuerza: no alcanzó a cerrarse con calma." };
    if (codigo === 143 || codigo === 0) return { tipo: "normal", titulo: "Se apagó con calma, sin error." };
    if (codigo === 139) return { tipo: "inesperado", titulo: "Falló por un error interno del programa." };
    return { tipo: "inesperado", titulo: `Terminó con un error (código ${codigo}). Las últimas líneas de abajo suelen decir cuál.` };
  }

  /** ¿`cuando` coincide (±3 min) con una operación de este módulo o con `reiniciar_contenedor` en la auditoría? */
  function pareceReinicioDelPanel(nombre, cuandoMs) {
    const est = estadoOperaciones();
    const candidatas = (est.ultimas || []).filter((o) => o.contenedor === nombre || (o.pasos || []).some((p) => p.contenedor === nombre));
    for (const o of candidatas) {
      const fin = o.fin ? new Date(o.fin).getTime() : null;
      if (fin && Math.abs(fin - cuandoMs) <= 3 * 60000) return true;
    }
    const F_AUDIT = path.join(deps.DIR_DATOS, "auditoria.jsonl");
    const lineas = leerJsonlLocal(F_AUDIT, 2000);
    return lineas.some((l) => l.accion === "reiniciar_contenedor" && l.detalle === nombre && Math.abs(new Date(l.ts).getTime() - cuandoMs) <= 3 * 60000);
  }

  async function ficha(nombre) {
    if (!RE_NOMBRE.test(nombre || "")) return { ok: false, code: 404, mensaje: "Ese servicio no existe" };
    const base = await leerContenedoresBase();
    const c = base.find((x) => x.nombre === nombre);
    if (!c) return { ok: false, code: 404, mensaje: "Ese servicio no existe" };

    return cacheadoLocal(`contenedor_ficha_${nombre}`, 30, async () => {
      const insp = await sh(`docker inspect ${nombre}`, 15000);
      let data = null;
      try { data = JSON.parse(insp.salida)[0]; } catch (_) {}
      if (!data) return { ok: false, code: 500, mensaje: "No se pudo consultar Docker" };

      const state = data.State || {};
      const hostConfig = data.HostConfig || {};
      const netSettings = data.NetworkSettings || {};

      const puertos = Object.entries(netSettings.Ports || {}).map(([interno, mapeos]) => ({
        interno: parseInt(interno, 10) || interno,
        publico: (mapeos && mapeos[0] && mapeos[0].HostPort) ? parseInt(mapeos[0].HostPort, 10) : null,
        texto: (mapeos && mapeos.length) ? "Accesible desde fuera del servidor" : "Solo accesible desde dentro del servidor",
      }));
      const volumenes = (data.Mounts || []).map((m) => ({
        origen: m.Source, destino: m.Destination,
        texto: `Guarda datos en ${m.Source && m.Source.startsWith("/opt") ? "una carpeta del servidor" : "un volumen de Docker"}`,
      }));
      const redes = Object.keys(netSettings.Networks || {});

      const salida = {
        nombre, descripcion: descripcionDe(nombre), propio: esPropio(nombre),
        imagen: data.Config ? data.Config.Image : null,
        creado: data.Created || null,
        arrancado: state.StartedAt || null,
        encendido_s: state.StartedAt ? Math.max(0, Math.round((Date.now() - new Date(state.StartedAt).getTime()) / 1000)) : 0,
        politica: hostConfig.RestartPolicy ? hostConfig.RestartPolicy.Name : "no",
        politica_texto: traducirPolitica(hostConfig.RestartPolicy ? hostConfig.RestartPolicy.Name : "no"),
        reinicios: data.RestartCount || 0,
        limites: { memoria_bytes: hostConfig.Memory || null, cpus: hostConfig.NanoCpus ? hostConfig.NanoCpus / 1e9 : null },
        puertos, volumenes, redes,
        ultima_parada: { existe: false },
      };

      const finishedAt = state.FinishedAt;
      const nuncaSeApago = !finishedAt || finishedAt.startsWith("0001-01-01");
      if (nuncaSeApago) {
        salida.ultima_parada = { existe: false, tipo: "nunca", titulo: "Nunca se ha apagado desde que se creó." };
        return { ok: true, ...salida };
      }

      const codigo = typeof state.ExitCode === "number" ? state.ExitCode : parseInt(state.ExitCode || "0", 10);
      const oom = !!state.OOMKilled;
      const cuandoMs = new Date(finishedAt).getTime();
      let clasif = clasificarUltimaParada(insp, codigo, oom, new Date(finishedAt), nombre);
      if (clasif.tipo !== "reinicio_programado" && pareceReinicioDelPanel(nombre, cuandoMs)) {
        clasif = { tipo: "reinicio_panel", titulo: "Lo reiniciaste tú desde el panel." };
      }

      let detalle = "";
      if (clasif.tipo === "inesperado" && oom && explicarFn) {
        try {
          const ram = leerMemoria().pct;
          const exp = explicarFn(nombre, "OOMKilled", ram, null);
          if (exp) detalle = `Terminó con código ${codigo} y la marca de falta de memoria. Recomiendo: ${exp.recomienda}`;
        } catch (_) {}
      }
      if (!detalle && clasif.tipo === "inesperado") detalle = `Terminó con el código ${codigo}. Revisa las últimas líneas de abajo para más detalle.`;

      let ultimasLineas = [];
      let lineasDisponibles = false;
      if (await driverLogsCompatible()) {
        const r = await sh(`docker logs --timestamps --until='${state.StartedAt}' --tail 30 ${nombre} 2>&1`, 15000);
        if (r.ok || r.salida) {
          ultimasLineas = (r.salida || "").split("\n").filter(Boolean).slice(-30).map((l) => l.slice(0, 300));
          lineasDisponibles = ultimasLineas.length > 0;
        }
      }

      salida.ultima_parada = {
        existe: true, cuando: finishedAt, codigo_salida: codigo, sin_memoria: oom,
        forzado: codigo === 137,
        tipo: clasif.tipo, titulo: clasif.titulo, detalle,
        ultimas_lineas: ultimasLineas,
        lineas_disponibles: lineasDisponibles,
      };
      if (!lineasDisponibles) salida.ultima_parada.detalle = salida.ultima_parada.detalle || "No hay registros de antes del último arranque.";
      return { ok: true, ...salida };
    });
  }

  // ── Validación y lanzamiento de operaciones (§4.5) ───────────────────────

  function descripcionOperacionEnCurso() {
    if (!enCurso) return "";
    return descripcionDe(enCurso.contenedor);
  }

  async function operar(peticion, quien) {
    quien = quien || "panel";
    const accion = String((peticion && peticion.accion) || "");
    const nombre = String((peticion && peticion.nombre) || "");
    const enOrden = !!(peticion && peticion.en_orden);
    const confirmacion = (peticion && peticion.confirmacion) || "";
    const pin = (peticion && peticion.pin) || "";

    function rechazar(code, mensaje, motivoCorto) {
      auditar("contenedor_rechazado", quien, motivoCorto || "rechazado", `${nombre || "(sin nombre)"}: ${mensaje}`);
      return { ok: false, code, mensaje };
    }

    if (!["reiniciar", "detener", "arrancar"].includes(accion) || !RE_NOMBRE.test(nombre)) {
      return rechazar(400, "El contenido enviado no es válido", "formato");
    }

    const base = await leerContenedoresBase();
    const c = base.find((x) => x.nombre === nombre);
    if (!c) return rechazar(404, "Ese servicio no existe", "no_existe");

    const propio = esPropio(nombre);
    const running = c.estado === "running";

    if (bloqueado()) return rechazar(409, `Ya hay una operación en curso sobre ${descripcionOperacionEnCurso()}`, "operacion_en_curso");
    if (hayBloqueoExterno()) return rechazar(412, "Hay un simulacro en curso; espera a que termine.", "simulacro_en_curso");

    if (accion === "detener") {
      if (NO_DETENER.has(nombre)) {
        return rechazar(412, nombre === "zeus-proxy"
          ? "La puerta de entrada no se puede apagar desde el panel."
          : "La base de datos no se puede apagar desde el panel; usa Reiniciar.", "salvaguarda");
      }
      if (!running) return rechazar(412, "Ya está apagado.", "ya_en_ese_estado");
    }
    if (accion === "arrancar" && running) return rechazar(412, "Ya está encendida.", "ya_en_ese_estado");

    if (accion === "reiniciar" && nombre === "zeus-mariadb") {
      const mResp = minutosHastaHoraUtc(HORA_RESPALDO_UTC);
      const mReinicio = minutosHastaProximoReinicioCompleto(HORA_REINICIO_UTC);
      if (mResp < 20) return rechazar(412, `Faltan ${Math.round(mResp)} minuto(s) para el respaldo diario. Espera a que termine e intenta de nuevo.`, "ventana_sensible");
      if (mReinicio < 20) return rechazar(412, `Faltan ${Math.round(mReinicio)} minuto(s) para el reinicio completo del servidor. Espera a que termine e intenta de nuevo.`, "ventana_sensible");
      const copia = await sh("pgrep -f /opt/zeus-app/scripts/backup_db.sh", 8000);
      if ((copia.salida || "").trim()) return rechazar(412, "Hay una copia de seguridad en curso; espera a que termine.", "copia_en_curso");
    }

    const niv = nivelConfirmacion(nombre, accion, propio, c.estado);
    if (niv.confirmacion === "palabra" || niv.confirmacion === "palabra_pin") {
      if (String(confirmacion || "") !== niv.palabra) return rechazar(422, "Escribe la palabra de confirmación exacta", "confirmacion_incorrecta");
    }
    if (niv.confirmacion === "palabra_pin") {
      const pinReal = env.PIN_ACCION || env.PIN_SIMULACRO || "";
      if (!pinReal) return rechazar(503, "PIN de acción sin configurar", "pin_sin_configurar");
      if (!pinValido(pin, pinReal)) return rechazar(401, "PIN incorrecto", "pin_incorrecto");
    }

    // ── Validaciones superadas: se lanza la operación en segundo plano ─────
    const runId = `cont-${Math.floor(Date.now() / 1000)}-${crypto.randomBytes(2).toString("hex")}`;
    const gracia = GRACIA_STOP[nombre] || GRACIA_STOP_POR_DEFECTO;
    const espera = ESPERA_SANO_S[nombre] || ESPERA_SANO_POR_DEFECTO_S;

    let pasos = [], duracionEstimada = 0;
    if (accion === "reiniciar") {
      pasos = [`Apagar ${descripcionDe(nombre)} con calma`, "Encenderla y esperar a que esté sana"];
      duracionEstimada = gracia + espera;
      if (enOrden && DEPENDIENTES[nombre]) {
        for (const dep of DEPENDIENTES[nombre]) {
          pasos.push(`Reiniciar ${descripcionDe(dep)}`);
          duracionEstimada += (GRACIA_STOP[dep] || GRACIA_STOP_POR_DEFECTO) + (ESPERA_SANO_S[dep] || ESPERA_SANO_POR_DEFECTO_S);
        }
      }
    } else if (accion === "detener") {
      pasos = [`Apagar ${descripcionDe(nombre)} con calma`];
      duracionEstimada = gracia;
    } else {
      pasos = ["Encenderla y esperar a que esté sana"];
      duracionEstimada = espera;
    }

    const inicioIso = new Date().toISOString();
    enCurso = { run_id: runId, operacion: accion, contenedor: nombre, propio, en_orden: enOrden, inicio: inicioIso, ctx: null };
    const est = estadoOperaciones();
    est.en_curso = { run_id: runId, operacion: accion, contenedor: nombre, propio, en_orden: enOrden, inicio: inicioIso };
    guardarEstadoOperaciones(est);
    contadoresSeq.set(runId, 0);

    ejecutarOperacion(runId, accion, nombre, enOrden, quien).catch((e) => {
      auditar("contenedor_excepcion", quien, "error", `${accion} ${nombre}: ${e.message}`);
    });

    return { ok: true, run_id: runId, pasos, duracion_estimada_s: duracionEstimada };
  }

  // ── Ejecución de la operación (§4.5) ──────────────────────────────────────

  async function esperarSano(nombre, ctx, timeoutS) {
    const inicio = Date.now();
    const r = await esperar(async () => {
      const insp = await sh(`docker inspect -f '{{.State.Status}};{{if .State.Health}}{{.State.Health.Status}}{{else}}sin-chequeo{{end}}' ${nombre}`, 10000);
      const [status, salud] = (insp.salida || "").trim().split(";");
      if (status !== "running") return null;
      if (salud === "sin-chequeo") {
        return (Date.now() - inicio) / 1000 >= ESTABLE_SIN_CHEQUEO_S ? { sano: true } : null;
      }
      return salud === "healthy" ? { sano: true } : null;
    }, timeoutS * 1000, 2000, ctx);
    return r;
  }

  async function pararUnContenedor(runId, nombre, ctx) {
    const gracia = GRACIA_STOP[nombre] || GRACIA_STOP_POR_DEFECTO;
    const inicio = Date.now();
    ctx.emitir(nombre, "accion", "info", `Apagando ${descripcionDe(nombre)}…`);
    await sh(`docker stop -t ${gracia} ${nombre}`, (gracia + 20) * 1000);
    const segundos = Math.round((Date.now() - inicio) / 1000);
    const insp = await sh(`docker inspect -f '{{.State.ExitCode}}' ${nombre}`, 10000);
    const codigo = parseInt((insp.salida || "0").trim(), 10) || 0;
    const forzado = codigo === 137;
    ctx.emitir(nombre, "accion", forzado ? "warn" : "ok",
      forzado
        ? `No se apagó a tiempo; hubo que forzarlo a los ${gracia} s (código 137). Al arrancar puede tardar más de lo normal mientras revisa sus datos.`
        : `Se apagó con calma en ${segundos} s.`,
      { comando: `docker stop -t ${gracia} ${nombre}`, codigo_salida: codigo, segundos });
    return { contenedor: nombre, operacion: "detener", resultado: forzado ? "forzado" : "ok", segundos, codigo_salida: codigo };
  }

  async function arrancarUnContenedor(runId, nombre, ctx) {
    const espera = ESPERA_SANO_S[nombre] || ESPERA_SANO_POR_DEFECTO_S;
    ctx.emitir(nombre, "accion", "info", `Encendiendo ${descripcionDe(nombre)}…`);
    let r = await sh(`docker start ${nombre}`, 20000);
    if (!r.ok) {
      ctx.emitir(nombre, "accion", "warn", "No arrancó al primer intento; reintentando en 5 s…");
      await dormir(5000);
      r = await sh(`docker start ${nombre}`, 20000);
    }
    if (!r.ok) {
      ctx.emitir(nombre, "veredicto", "crit", `${descripcionDe(nombre)} no volvió a arrancar. Necesita revisión manual.`);
      return { contenedor: nombre, operacion: "arrancar", resultado: "falló", segundos: 0, codigo_salida: null };
    }
    ctx.emitir(nombre, "espera", "info", `Arrancó. Esperando a que pase su chequeo de salud (hasta ${espera} s)…`, { comando: `docker start ${nombre}`, segundos: espera });
    const sano = await esperarSano(nombre, ctx, espera);
    const segundos = Math.round(sano.ms / 1000);
    if (sano.logrado) {
      ctx.emitir(nombre, "veredicto", "ok", `${descripcionDe(nombre)} responde y está sana (${segundos} s).`, { segundos });
      return { contenedor: nombre, operacion: "arrancar", resultado: "ok", segundos, codigo_salida: null };
    }
    ctx.emitir(nombre, "veredicto", "crit", `${descripcionDe(nombre)} no quedó sana dentro de ${espera} s. Revísala a mano.`, { segundos });
    return { contenedor: nombre, operacion: "arrancar", resultado: "falló", segundos, codigo_salida: null };
  }

  async function avisoWhatsappFinal(nombre, propio, resultado, accion) {
    if (nombre === "zeus-proxy") {
      if (resultado === "ok") {
        await enviarWhatsapp("Listo: la puerta de entrada volvió y el panel ya responde.").catch(() => {});
      } else {
        await enviarWhatsapp(
          "La puerta de entrada no volvió a arrancar después del reinicio. El panel no va a responder.\n" +
          "Avisa al técnico: hace falta entrar por SSH."
        ).catch(() => {});
      }
      return;
    }
    if (propio && resultado === "falló") {
      await enviarWhatsapp(
        `Una operación sobre ${descripcionDe(nombre)} (${nombre}) no terminó bien.\n` +
        `Acción: ${accion}\n\nRevisa el panel para más detalle.`
      ).catch(() => {});
    }
  }

  async function ejecutarOperacion(runId, accion, nombre, enOrden, quien) {
    const ctx = {
      runId, abortado: false,
      emitir: (contenedorRef, fase, nivel, texto, dato) => emitirEvento(runId, contenedorRef, accion, fase, nivel, texto, dato),
    };
    if (enCurso && enCurso.run_id === runId) enCurso.ctx = ctx;

    const inicioMs = Date.now();
    const propio = esPropio(nombre);
    const timerUnidad = CON_HOMBRE_MUERTO[nombre] ? `zeus-cont-${runId}` : null;
    const pasosResultado = [];
    let resultado = "ok";

    try {
      if (accion === "reiniciar") {
        ctx.emitir(nombre, "preparacion", "info", `Voy a reiniciar ${descripcionDe(nombre)}. Le doy hasta ${GRACIA_STOP[nombre] || GRACIA_STOP_POR_DEFECTO} s para que se apague con calma.`);

        if (timerUnidad) {
          const segs = CON_HOMBRE_MUERTO[nombre];
          ctx.emitir(nombre, "preparacion", "info", `Dejé programada una red de seguridad: si algo falla, el sistema la vuelve a encender solo en ${Math.round(segs / 60)} minutos.`);
          const cmd = `docker start ${nombre} 2>/dev/null`;
          const cmdEscapado = cmd.replace(/'/g, "'\\''");
          await sh(`systemd-run --on-active=${segs}s --unit=${timerUnidad} /bin/bash -lc '${cmdEscapado}'`, 15000);
        }

        marcarMantenimiento(nombre, (GRACIA_STOP[nombre] || GRACIA_STOP_POR_DEFECTO) + (ESPERA_SANO_S[nombre] || ESPERA_SANO_POR_DEFECTO_S) + 60, "reinicio", quien, runId);
        ctx.emitir(nombre, "preparacion", "info", "Le avisé a Centinela que esto es a propósito, para que no lo cuente como una caída.");
        invalidarCache();

        const pStop = await pararUnContenedor(runId, nombre, ctx);
        pasosResultado.push(pStop);
        const pStart = await arrancarUnContenedor(runId, nombre, ctx);
        pasosResultado.push(pStart);
        invalidarCache();
        if (pStart.resultado === "falló") resultado = "falló";

        if (resultado !== "falló" && enOrden && DEPENDIENTES[nombre]) {
          for (const dep of DEPENDIENTES[nombre]) {
            ctx.emitir(dep, "preparacion", "info", `Ahora ${descripcionDe(dep)}, para que se vuelva a conectar…`);
            marcarMantenimiento(dep, (GRACIA_STOP[dep] || GRACIA_STOP_POR_DEFECTO) + (ESPERA_SANO_S[dep] || ESPERA_SANO_POR_DEFECTO_S) + 60, "reinicio", quien, runId);
            const dStop = await pararUnContenedor(runId, dep, ctx);
            pasosResultado.push(dStop);
            const dStart = await arrancarUnContenedor(runId, dep, ctx);
            pasosResultado.push(dStart);
            invalidarCache();
            limpiarMantenimiento(dep);
            if (dStart.resultado === "falló") { resultado = "parcial"; break; }
          }
        }

        limpiarMantenimiento(nombre);
        if (timerUnidad) {
          ctx.emitir(nombre, "veredicto", "info", "Quité la red de seguridad: ya no hace falta.");
          await sh(`systemctl stop ${timerUnidad}.timer 2>/dev/null; systemctl reset-failed '${timerUnidad}*' 2>/dev/null`, 15000);
        }
      } else if (accion === "detener") {
        marcarMantenimiento(nombre, MAX_DETENIDO_S, "detenido", quien, runId);
        invalidarCache();
        const pStop = await pararUnContenedor(runId, nombre, ctx);
        pasosResultado.push(pStop);
        if (pStop.resultado === "forzado") pasosResultado[pasosResultado.length - 1].resultado = "ok"; // forzar apagar sigue siendo éxito de la operación "detener"
        invalidarCache();
        ctx.emitir(nombre, "veredicto", "ok", `${descripcionDe(nombre)} quedó apagada. La vuelvo a encender sola en 12 horas si no lo haces antes.`);
      } else { // arrancar
        limpiarMantenimiento(nombre);
        const pStart = await arrancarUnContenedor(runId, nombre, ctx);
        pasosResultado.push(pStart);
        invalidarCache();
        if (pStart.resultado === "falló") resultado = "falló";
      }
    } catch (e) {
      resultado = "falló";
      ctx.emitir(nombre, "veredicto", "crit", `Ocurrió un error durante la operación: ${e.message}`);
    }

    const duracionS = Math.round((Date.now() - inicioMs) / 1000);
    ctx.emitir(nombre, "veredicto", resultado === "ok" ? "ok" : (resultado === "parcial" ? "warn" : "crit"),
      resultado === "ok" ? `Listo: la operación terminó bien. Duró ${Math.floor(duracionS / 60)} min ${duracionS % 60} s.`
        : resultado === "parcial" ? "La operación quedó a medias: revisa los pasos de arriba."
        : "La operación falló: revisa los pasos de arriba.",
      { ok: resultado === "ok", resultado, pasos: pasosResultado, duracion_s: duracionS });

    auditar(`contenedor_${accion}`, quien, resultado, `${propio ? "" : "AJENO "}${nombre}${enOrden ? " en_orden" : ""}`);

    await avisoWhatsappFinal(nombre, propio, resultado, accion);

    const est = estadoOperaciones();
    est.en_curso = null;
    est.ultimas = est.ultimas || [];
    est.ultimas.unshift({
      run_id: runId, operacion: accion, contenedor: nombre, propio, en_orden: enOrden,
      inicio: enCurso ? enCurso.inicio : new Date(inicioMs).toISOString(), fin: new Date().toISOString(),
      resultado, duracion_s: duracionS, pasos: pasosResultado,
    });
    est.ultimas = est.ultimas.slice(0, 30);
    guardarEstadoOperaciones(est);

    enCurso = null;
    cerrarSuscriptores(runId, { ok: resultado === "ok", resultado, pasos: pasosResultado, duracion_s: duracionS });
    limpiarCorridasViejas();
  }

  // ── Registros en vivo (§4.6) ──────────────────────────────────────────────
  let streamsRegistrosActivos = 0;

  function nivelPorTexto(linea) {
    if (/\b(error|exception|fatal|panic|unhandled)\b/i.test(linea)) return "crit";
    if (/\bwarn/i.test(linea)) return "warn";
    return "info";
  }

  /**
   * SSE de `docker logs --follow`, no persistido y no reanudable. Devuelve
   * `{ok:true}` si empezó a transmitir, o `{ok:false, code, mensaje}` si se
   * rechazó antes de escribir cabeceras (nombre inválido o cupo agotado).
   */
  function registrosEnVivo(nombre, lineas, res, quien) {
    quien = quien || "panel";
    if (!RE_NOMBRE.test(nombre || "")) return { ok: false, code: 404, mensaje: "Ese servicio no existe" };
    if (streamsRegistrosActivos >= REGISTROS_MAX_STREAMS) {
      return { ok: false, code: 409, mensaje: "Ya hay dos vistas de registros abiertas; cierra una." };
    }
    const n = Math.max(20, Math.min(500, parseInt(lineas, 10) || 200));
    const runId = `logs-${nombre}-${Math.floor(Date.now() / 1000)}`;

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write("retry: 3000\n\n");

    streamsRegistrosActivos++;
    auditar("contenedor_registros", quien, "abierto", `${nombre} (${n} líneas)`);

    let seq = 0, totalLineas = 0, terminado = false;
    let bufOut = "", bufErr = "";
    let contadorRafaga = 0, ventanaRafagaMs = Date.now();

    function emitirLinea(texto, origen) {
      if (terminado) return;
      let t = texto;
      if (t.length > REGISTROS_LARGO_LINEA) t = t.slice(0, REGISTROS_LARGO_LINEA) + "…";
      const nivel = nivelPorTexto(t);
      const ahora = Date.now();
      if (ahora - ventanaRafagaMs >= 1000) { ventanaRafagaMs = ahora; contadorRafaga = 0; }
      contadorRafaga++;
      if (contadorRafaga > REGISTROS_RAFAGA_MAX) {
        if (contadorRafaga === REGISTROS_RAFAGA_MAX + 1) {
          escribir("warn", "…(líneas omitidas en este segundo por ir demasiado rápido)", {});
        }
        return;
      }
      escribir(nivel, t, { origen });
      totalLineas++;
      if (totalLineas >= REGISTROS_MAX_LINEAS) terminarPorLimite("Cerré la vista en vivo al llegar al tope de 3000 líneas. Vuelve a abrirla si la necesitas.");
    }

    function escribir(nivel, texto, dato) {
      const evento = { ts: new Date().toISOString(), run_id: runId, contenedor: nombre, operacion: "registros", seq: seq++, fase: "registros", nivel, texto, dato };
      try { res.write(`event: paso\nid: ${evento.seq}\ndata: ${JSON.stringify(evento)}\n\n`); } catch (_) { cerrar(); }
    }

    function finEvento(texto) {
      try { res.write(`event: fin\ndata: ${JSON.stringify({ texto })}\n\n`); res.end(); } catch (_) {}
    }

    let child;
    function cerrar() {
      if (terminado) return;
      terminado = true;
      clearInterval(latido);
      streamsRegistrosActivos = Math.max(0, streamsRegistrosActivos - 1);
      if (child && !child.killed) {
        try { child.kill("SIGTERM"); } catch (_) {}
        setTimeout(() => { try { if (!child.killed) child.kill("SIGKILL"); } catch (_) {} }, 3000);
      }
    }

    function terminarPorLimite(texto) {
      escribir("warn", texto, {});
      finEvento(texto);
      cerrar();
    }

    const latido = setInterval(() => { try { res.write(": ping\n\n"); } catch (_) { cerrar(); } }, 15000);
    const timerDuracion = setTimeout(() => terminarPorLimite("Cerré la vista en vivo a los 10 minutos para no cargar el servidor. Vuelve a abrirla si la necesitas."), REGISTROS_DURACION_MS);

    try {
      child = spawn("/usr/bin/docker", ["logs", "--follow", "--timestamps", "--tail", String(n), nombre]);
    } catch (e) {
      clearInterval(latido); clearTimeout(timerDuracion);
      streamsRegistrosActivos = Math.max(0, streamsRegistrosActivos - 1);
      finEvento("No se pudo abrir la vista de registros.");
      return { ok: true }; // ya se escribieron cabeceras SSE; el error se comunica por el propio stream
    }

    function manejarChunk(chunkStr, cual) {
      const buf = cual === "out" ? bufOut : bufErr;
      const combinado = buf + chunkStr;
      const partes = combinado.split("\n");
      const resto = partes.pop();
      if (cual === "out") bufOut = resto; else bufErr = resto;
      for (const linea of partes) {
        // Docker antepone el timestamp ISO seguido de un espacio; se separa
        // para que `texto` sea legible y el timestamp vaya en `dato.ts_linea`.
        const m = linea.match(/^(\S+)\s(.*)$/);
        if (m) emitirLinea(m[2], cual);
        else if (linea) emitirLinea(linea, cual);
      }
      if ((cual === "out" ? bufOut : bufErr).length > REGISTROS_BUFFER_PARCIAL) {
        const parcial = cual === "out" ? bufOut : bufErr;
        if (cual === "out") bufOut = ""; else bufErr = "";
        emitirLinea(parcial, cual);
      }
    }

    child.stdout.on("data", (c) => manejarChunk(c.toString("utf8"), "out"));
    child.stderr.on("data", (c) => manejarChunk(c.toString("utf8"), "err"));
    child.on("close", () => {
      clearTimeout(timerDuracion);
      if (!terminado) finEvento("El servicio dejó de escribir (se apagó o se reinició).");
      cerrar();
    });
    child.on("error", () => {
      clearTimeout(timerDuracion);
      if (!terminado) finEvento("No se pudo leer los registros de este servicio.");
      cerrar();
    });

    res.on("close", () => { clearTimeout(timerDuracion); cerrar(); });

    return { ok: true };
  }

  // ── Historial de operaciones (§4.7) ──────────────────────────────────────
  function operaciones() {
    return estadoOperaciones();
  }

  // ── Revisión periódica de mantenimientos (§3.4, cada minuto) ─────────────
  async function revisarMantenimientos() {
    const ahora = Date.now();
    for (const [nombre, m] of Array.from(mantenimiento.entries())) {
      if (new Date(m.hasta).getTime() > ahora) continue; // sigue vigente

      if (m.motivo === "detenido") {
        const r = await sh(`docker start ${nombre}`, 30000);
        limpiarMantenimiento(nombre);
        invalidarCache();
        auditar("contenedor_reencendido_auto", "agente", r.ok ? "ok" : "falló", nombre);
        if (r.ok && esPropio(nombre)) {
          await enviarWhatsapp(`Volví a encender ${descripcionDe(nombre).toLowerCase()}: llevaba 12 horas apagado desde el panel.`).catch(() => {});
        }
      } else {
        // Marca de "reinicio" que sobrevivió más de lo previsto (la operación
        // debió limpiarla al terminar). Se retira sin más: no es un apagado
        // deliberado que haya que revertir.
        limpiarMantenimiento(nombre);
      }
    }
  }

  // ── Reconciliación al arrancar zeus-ops (§9, riesgo #9) ──────────────────
  async function reconciliarAlArrancar() {
    cargarMantenimientoDeDisco();
    const est = estadoOperaciones();
    if (!est.en_curso) return;

    const { run_id: runId, operacion, contenedor, propio, en_orden: enOrdenPrevio, inicio: inicioPrevio } = est.en_curso;
    auditar("contenedor_huerfano", "agente", "detectado", `${operacion} ${contenedor} (${runId}) — operación huérfana al arrancar`);

    if (CON_HOMBRE_MUERTO[contenedor]) {
      const timerUnidad = `zeus-cont-${runId}`;
      await sh(`systemctl stop ${timerUnidad}.timer 2>/dev/null; systemctl reset-failed '${timerUnidad}*' 2>/dev/null`, 15000).catch(() => {});
    }

    try {
      emitirEvento(runId, contenedor, operacion, "veredicto", "warn",
        "El servicio se reinició durante esta operación. Si el contenedor llevaba red de seguridad, ya debió volver solo; revísalo en la lista.",
        { ok: false, resultado: "interrumpido" });
    } catch (_) {}

    est.en_curso = null;
    est.ultimas = est.ultimas || [];
    est.ultimas.unshift({
      run_id: runId, operacion, contenedor, propio, en_orden: !!enOrdenPrevio,
      inicio: inicioPrevio || new Date().toISOString(), fin: new Date().toISOString(),
      resultado: "interrumpido", duracion_s: 0, pasos: [],
    });
    est.ultimas = est.ultimas.slice(0, 30);
    guardarEstadoOperaciones(est);

    enCurso = null;
    cerrarSuscriptores(runId, { ok: false, resultado: "interrumpido" });
    invalidarCache();
  }

  return {
    listar,
    ficha,
    operar,
    suscribir,
    registrosEnVivo,
    operaciones,
    enMantenimiento,
    marcarMantenimiento,
    revisarMantenimientos,
    reconciliarAlArrancar,
  };
}

module.exports = { crearContenedores };
