"use strict";
/**
 * Centinela Zeus — servicio de control del servidor.
 *
 * Vive en el host bajo systemd, fuera de Docker, para poder administrar los
 * contenedores sin morir con ellos. Traefik lo publica en panel.ejemplo.com
 * detrás de autenticación básica.
 *
 * Sin dependencias externas: solo la librería estándar de Node 20.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { execFile, spawn } = require("child_process");
const dbOptimizacion = require("./modulos/db-optimizacion.js");
const seguridadAuditoria = require("./modulos/seguridad-auditoria.js");
const logClustering = require("./modulos/log-clustering.js");
const dbProcesos = require("./modulos/db-procesos.js");
const kapsoYModo = require("./modulos/kapso-y-modo.js");

// ── Configuración ───────────────────────────────────────────────────────────
const PORT = 4900;
const DIR_DATOS = "/var/lib/zeus-ops";
const F_HIST = path.join(DIR_DATOS, "historial.jsonl");
const F_PATRONES_LOG = path.join(DIR_DATOS, "patrones-log.json");
const F_LATENCIA_KAPSO = path.join(DIR_DATOS, "latencia-kapso.jsonl");
const F_GASTO_WSP = path.join(DIR_DATOS, "gasto-wsp.json");
const F_MODO = path.join(DIR_DATOS, "modo.json");
const F_INCID = path.join(DIR_DATOS, "incidentes.json");
const F_AUDIT = path.join(DIR_DATOS, "auditoria.jsonl");
const F_ESTADO = path.join(DIR_DATOS, "estado-interno.json");
const DIR_RESPALDOS = "/opt/zeus-app/backups";
const PUBLICO = path.join(__dirname, "public");

const env = leerEnv("/opt/zeus-ops/.env");
// Dominio público del panel (para validar el origen de las peticiones POST) y
// nombre de la base de datos que Centinela vigila. Ambos vienen del .env.
const PANEL_ORIGEN = env.PANEL_ORIGEN || "https://panel.ejemplo.com";
const ESQUEMA = (env.DB_ESQUEMA || "negocio").replace(/[^a-zA-Z0-9_]/g, "");
process.env.DB_ESQUEMA = ESQUEMA;
function esOrigenPermitido(origen) { return origen === PANEL_ORIGEN; }
const KAPSO_KEY = env.KAPSO_API_KEY || "";
const KAPSO_URL = env.KAPSO_META_URL || "https://api.kapso.ai/meta/whatsapp/v24.0";
const KAPSO_PID = env.KAPSO_PHONE_NUMBER_ID || "";
const WSP_DESTINO = env.WSP_DESTINO || "";
const WSP_PLANTILLA = env.WSP_PLANTILLA || "centinela_zeus";
const MYSQL_PASS = env.MYSQL_ROOT_PASS || "";
const HORA_RESUMEN_UTC = 13; // 08:00 en Colombia
const HORA_REINICIO_UTC = 9; // 04:00 en Colombia

fs.mkdirSync(DIR_DATOS, { recursive: true });

// Qué hace cada contenedor, en palabras del usuario.
// Contenedores de ESTE proyecto. Solo sobre estos abre incidentes, avisa por
// WhatsApp o intenta reiniciar. Los demás (otro-proyecto-a, otro-proyecto-b, otro-proyecto-c)
// son de otro proyecto del dueño: se muestran en el panel para que los vea,
// pero Centinela no los toca ni alarma por ellos.
const CONTENEDORES_PROPIOS = new Set(["zeus-bot", "zeus-mariadb", "zeus-proxy", "zeus-chromadb"]);

// Cuando el dueño (o un simulacro) reinicia un servicio a propósito, eso NO es
// una falla y no debe generar el aviso "Zeus se cayó". Aquí se anota el nombre
// del contenedor con la hora en que deja de estar en mantenimiento; mientras
// tanto, revisarIncidentes lo ignora por completo.
const enMantenimiento = new Map();
function marcarMantenimiento(nombre, segundos = 180) {
  enMantenimiento.set(nombre, Date.now() + segundos * 1000);
}
function estaEnMantenimiento(nombre) {
  const hasta = enMantenimiento.get(nombre);
  if (!hasta) return false;
  if (Date.now() > hasta) { enMantenimiento.delete(nombre); return false; }
  return true;
}

// El bot se reinicia solo (por cron, fuera del panel) todos los días cerca de
// HORA_REINICIO_UTC — desde que el reinicio diario dejó de ser del servidor
// completo y pasó a ser solo de este contenedor. Como ese reinicio no pasa
// por operar()/marcarMantenimiento (lo dispara crontab con `docker restart`
// directo), sin esta ventana el vigilante de eventos de Docker vería un
// "die" + "start" de zeus-bot cada mañana y lo tomaría como una caída real:
// abriría un incidente falso y mandaría "Zeus se cayó" a las 4am. Ver
// arquitectura.html (Debilidad B) y modulos/contenedores/contenedores.js,
// que usa la misma ventana de ±10 min para clasificar el historial.
function esReinicioBotProgramado(nombre) {
  if (nombre !== "zeus-bot") return false;
  const ahora = new Date();
  const totalMin = ahora.getUTCHours() * 60 + ahora.getUTCMinutes();
  const objetivo = HORA_REINICIO_UTC * 60;
  return Math.abs(totalMin - objetivo) <= 10;
}

const DESCRIPCIONES = {
  "zeus-bot": "El bot de WhatsApp",
  "zeus-mariadb": "Base de datos",
  "zeus-proxy": "Puerta de entrada y certificados",
  "zeus-chromadb": "Memoria de búsqueda del bot",
  "otro-proyecto-a": "Otro proyecto A (ejemplo)",
  "otro-proyecto-b": "Otro proyecto B (ejemplo)",
};

// ── Utilidades ──────────────────────────────────────────────────────────────
function leerEnv(ruta) {
  const out = {};
  try {
    for (const linea of fs.readFileSync(ruta, "utf8").split("\n")) {
      const m = linea.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch (_) {}
  return out;
}

/** Ejecuta un comando fijo. Nunca recibe texto del usuario sin validar antes. */
function sh(cmd, timeout = 25000) {
  return new Promise((resolve) => {
    execFile("/bin/bash", ["-lc", cmd], { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, out, errOut) => {
      resolve({ ok: !err, salida: (out || "").trim(), error: (errOut || "").trim() });
    });
  });
}

function pedirJson(url, timeout = 6000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch (_) { resolve(null); } });
    });
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.on("error", () => resolve(null));
  });
}

const cache = new Map();
async function cacheado(clave, segundos, fn) {
  const hit = cache.get(clave);
  if (hit && Date.now() - hit.t < segundos * 1000) return hit.v;
  const v = await fn();
  cache.set(clave, { t: Date.now(), v });
  return v;
}

function anexar(archivo, obj) {
  try { fs.appendFileSync(archivo, JSON.stringify(obj) + "\n"); } catch (_) {}
}

function leerJsonl(archivo, max = 5000) {
  try {
    const lineas = fs.readFileSync(archivo, "utf8").trim().split("\n").slice(-max);
    return lineas.filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
  } catch (_) { return []; }
}

function leerJson(archivo, porDefecto) {
  try { return JSON.parse(fs.readFileSync(archivo, "utf8")); } catch (_) { return porDefecto; }
}

function guardarJson(archivo, obj) {
  try { fs.writeFileSync(archivo, JSON.stringify(obj, null, 2)); } catch (_) {}
}

function auditar(accion, quien, resultado, detalle) {
  anexar(F_AUDIT, { ts: new Date().toISOString(), accion, quien, resultado, detalle: (detalle || "").slice(0, 400) });
}

// ── WhatsApp por Kapso ──────────────────────────────────────────────────────
function postKapso(payload) {
  return new Promise((resolve) => {
    const cuerpo = JSON.stringify(payload);
    const url = new URL(`${KAPSO_URL}/${KAPSO_PID}/messages`);
    const req = require("https").request(
      { method: "POST", hostname: url.hostname, path: url.pathname,
        headers: { "X-API-Key": KAPSO_KEY, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(cuerpo) },
        timeout: 15000 },
      (res) => { let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve({ ok: res.statusCode < 300, respuesta: d.slice(0, 400) })); }
    );
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, respuesta: "tiempo agotado" }); });
    req.on("error", (e) => resolve({ ok: false, respuesta: e.message }));
    req.end(cuerpo);
  });
}

// Envoltura que mide cuánto tarda Kapso en responder y cuenta los envíos por
// hora. Es el único punto por donde pasan los dos tipos de envío (texto y
// plantilla), así que medir aquí captura el 100% sin duplicar lógica.
const postKapsoMedido = kapsoYModo.envolverPostKapso(postKapso, {
  anexar,
  leerJson,
  guardarJson,
  rutaLatencia: F_LATENCIA_KAPSO,
  rutaGasto: F_GASTO_WSP,
  alGastoAnomalo: (estado) => {
    auditar("gasto_wsp_anomalo", "agente", "aviso", `${estado.envios} envíos en la hora ${estado.hora}`);
    // Usa postKapso crudo a propósito: así este aviso no se cuenta a sí mismo
    // ni alimenta el bucle que está denunciando.
    postKapso({
      messaging_product: "whatsapp", to: WSP_DESTINO, type: "text",
      text: { body: `Zeus detectó muchos mensajes de WhatsApp seguidos (${estado.envios} en la última hora). Puede haber un bucle enviando de más. Revisa el panel.` },
    }).catch(() => {});
  },
});

/**
 * Envía por WhatsApp. Primero como texto normal, que solo funciona si hay una
 * conversación abierta. Si Meta lo rechaza por la ventana de 24 horas, repite
 * con la plantilla aprobada, que sí puede iniciar la conversación.
 * La plantilla no admite saltos de línea, así que el texto se aplana.
 */
async function enviarWhatsappA(numero, texto) {
  if (!KAPSO_KEY || !KAPSO_PID || !numero) return { ok: false, error: "Kapso sin configurar" };

  const directo = await postKapsoMedido({ messaging_product: "whatsapp", to: numero, type: "text", text: { body: texto } });
  if (directo.ok) return { ok: true, via: "texto" };

  const fueraDeVentana = /131047|re-?engagement|24 hours/i.test(directo.respuesta);
  if (!fueraDeVentana && !/error/i.test(directo.respuesta)) return { ok: false, via: "texto", detalle: directo.respuesta };

  const plano = texto.replace(/\n+/g, " · ").replace(/\s{2,}/g, " ").slice(0, 900);
  const conPlantilla = await postKapsoMedido({
    messaging_product: "whatsapp", to: numero, type: "template",
    template: { name: WSP_PLANTILLA, language: { code: "es" },
      components: [{ type: "body", parameters: [{ type: "text", text: plano }] }] },
  });
  if (conPlantilla.ok) return { ok: true, via: "plantilla" };
  return { ok: false, via: "ninguna", detalle: (directo.respuesta + " | " + conPlantilla.respuesta).slice(0, 300) };
}

/** Envío al número del dueño (WSP_DESTINO) — la forma que ya usa todo el proyecto. */
async function enviarWhatsapp(texto) {
  return enviarWhatsappA(WSP_DESTINO, texto);
}

// ── Métricas base ───────────────────────────────────────────────────────────
function leerMemoria() {
  const txt = fs.readFileSync("/proc/meminfo", "utf8");
  const val = (k) => { const m = txt.match(new RegExp("^" + k + ":\\s+(\\d+)", "m")); return m ? parseInt(m[1], 10) * 1024 : 0; };
  const total = val("MemTotal"), disponible = val("MemAvailable");
  const usada = total - disponible;
  return { total, usada, disponible, pct: Math.round((usada / total) * 100) };
}

let cpuPrev = null;
let iowaitPrev = null;
function leerCpu() {
  const linea = fs.readFileSync("/proc/stat", "utf8").split("\n")[0].trim().split(/\s+/).slice(1).map(Number);
  const total = linea.reduce((a, b) => a + b, 0);
  const ocioso = linea[3] + (linea[4] || 0);
  let pct = 0;
  if (cpuPrev) {
    const dt = total - cpuPrev.total, di = ocioso - cpuPrev.ocioso;
    if (dt > 0) pct = Math.max(0, Math.min(100, Math.round((1 - di / dt) * 100)));
  }
  cpuPrev = { total, ocioso };
  const carga = parseFloat(fs.readFileSync("/proc/loadavg", "utf8").split(" ")[0]);
  return { pct, carga };
}

// Igual que leerCpu() pero para el campo iowait de /proc/stat (5ª columna) —
// reemplaza la dependencia de Netdata (nunca estuvo instalado en este servidor).
function leerIowait() {
  const linea = fs.readFileSync("/proc/stat", "utf8").split("\n")[0].trim().split(/\s+/).slice(1).map(Number);
  const total = linea.reduce((a, b) => a + b, 0);
  const iowait = linea[4] || 0;
  let pct = 0;
  if (iowaitPrev) {
    const dt = total - iowaitPrev.total, dw = iowait - iowaitPrev.iowait;
    if (dt > 0) pct = Math.max(0, Math.min(100, (dw / dt) * 100));
  }
  iowaitPrev = { total, iowait };
  return pct;
}

async function leerDisco() {
  const r = await sh("df -B1 --output=size,used,avail / | tail -1");
  const [size, used, avail] = r.salida.split(/\s+/).filter(Boolean).map(Number);
  return { total: size, usado: used, libre: avail, pct: Math.round((used / size) * 100) };
}

async function leerContenedores() {
  return cacheado("contenedores", 15, async () => {
    const ps = await sh("docker ps -a --format '{{.Names}};{{.State}};{{.Status}}'");
    const stats = await sh("docker stats --no-stream --format '{{.Name}};{{.MemUsage}};{{.CPUPerc}}'");
    const insp = await sh("docker ps -aq | xargs -r docker inspect -f '{{.Name}};{{.RestartCount}};{{if .State.Health}}{{.State.Health.Status}}{{else}}sin-chequeo{{end}};{{.HostConfig.RestartPolicy.Name}};{{.State.StartedAt}}'");

    const uso = {}, extra = {};
    for (const l of stats.salida.split("\n").filter(Boolean)) {
      const [n, mem, cpu] = l.split(";");
      uso[n] = { mem: (mem || "").split("/")[0].trim(), cpu: (cpu || "").trim() };
    }
    for (const l of insp.salida.split("\n").filter(Boolean)) {
      const [n, rc, salud, politica, arrancado] = l.split(";");
      // arrancado (State.StartedAt) es la señal fiable de que un contenedor se
      // reinició: RestartCount se queda en cero en varios casos reales, pero
      // esta marca de tiempo cambia siempre que el contenedor vuelve a arrancar.
      extra[n.replace(/^\//, "")] = {
        reinicios: parseInt(rc || "0", 10), salud, politica,
        arrancado_ms: arrancado ? new Date(arrancado).getTime() || 0 : 0,
      };
    }
    return ps.salida.split("\n").filter(Boolean).map((l) => {
      const [nombre, estado, detalle] = l.split(";");
      const e = extra[nombre] || {};
      return {
        nombre, estado, detalle,
        descripcion: DESCRIPCIONES[nombre] || "Servicio del sistema",
        salud: e.salud || "sin-chequeo",
        reinicios: e.reinicios || 0,
        arrancado_ms: e.arrancado_ms || 0,
        politica: e.politica || "no",
        // Un contenedor apagado a propósito, sin política de reinicio, es un
        // resto de algo viejo. No es una falla y no debe dar alarma.
        gestionado: (e.politica || "no") !== "no",
        memoria: (uso[nombre] || {}).mem || "—",
        cpu: (uso[nombre] || {}).cpu || "—",
      };
    }).filter((c) => c.gestionado || c.estado === "running");
  });
}

// ── Estado general ──────────────────────────────────────────────────────────
async function estadoGeneral() {
  const [disco, contenedores] = await Promise.all([leerDisco(), leerContenedores()]);
  const ram = leerMemoria(), cpu = leerCpu();
  const arriba = contenedores.filter((c) => c.estado === "running");
  const enfermos = contenedores.filter((c) => c.estado === "running" && c.salud === "unhealthy");
  const caidos = contenedores.filter((c) => c.estado !== "running");
  const arranque = await cacheado("arranque", 300, async () => (await sh("uptime -s")).salida);

  const avisos = [];
  if (ram.pct >= 90) avisos.push({ nivel: "crit", texto: "La memoria está al límite", detalle: `${ram.pct} % usado` });
  else if (ram.pct >= 80) avisos.push({ nivel: "warn", texto: "La memoria va alta", detalle: `${ram.pct} % usado` });
  if (disco.pct >= 90) avisos.push({ nivel: "crit", texto: "El disco está casi lleno", detalle: `${disco.pct} % usado` });
  else if (disco.pct >= 80) avisos.push({ nivel: "warn", texto: "El disco va llenándose", detalle: `${disco.pct} % usado` });
  for (const c of caidos) avisos.push({ nivel: "crit", texto: `${c.nombre} está detenido`, detalle: c.descripcion });
  for (const c of enfermos) avisos.push({ nivel: "warn", texto: `${c.nombre} no responde bien`, detalle: c.descripcion });

  const respaldo = await estadoRespaldos();
  if (!respaldo.drive.conectado) avisos.push({ nivel: respaldo.drive.es_permiso ? "warn" : "info", texto: respaldo.drive.es_permiso ? "Google Drive desconectado" : "No se pudo confirmar Drive ahora mismo", detalle: respaldo.drive.motivo || "Las copias solo están en este servidor" });
  if (respaldo.ultimo && respaldo.ultimo.horas > 30) avisos.push({ nivel: "crit", texto: "El respaldo no corrió", detalle: `Último hace ${respaldo.ultimo.horas} horas` });
  const bm = botMudo.estado();
  if (bm.episodio) avisos.push({ nivel: "crit", texto: "El bot no está contestando a los clientes", detalle: bm.detalle });

  return {
    host: "Zeus", ip: env.SERVIDOR_IP || "—", arranque,
    ram, cpu, disco, contenedores,
    servicios: { total: contenedores.length, arriba: arriba.length },
    avisos,
    ts: new Date().toISOString(),
  };
}

// ── Historial y predicción ──────────────────────────────────────────────────
function muestrear() {
  Promise.all([leerDisco(), leerContenedores()]).then(([disco, contenedores]) => {
    const ram = leerMemoria(), cpu = leerCpu();
    anexar(F_HIST, {
      t: Math.floor(Date.now() / 1000),
      ram: ram.pct, disco: disco.pct, cpu: cpu.pct, carga: cpu.carga,
      arriba: contenedores.filter((c) => c.estado === "running").length,
      total: contenedores.length,
    });
    revisarIncidentes(contenedores).catch(() => {});
  }).catch(() => {});
}

/** Recorta el historial a 30 días para que no crezca sin control. */
function recortarHistorial() {
  try {
    const lineas = fs.readFileSync(F_HIST, "utf8").trim().split("\n");
    if (lineas.length > 43200) fs.writeFileSync(F_HIST, lineas.slice(-43200).join("\n") + "\n");
  } catch (_) {}
}

/** Regresión lineal simple: devuelve la pendiente por día. */
function pendientePorDia(puntos) {
  if (puntos.length < 10) return null;
  const n = puntos.length;
  const mx = puntos.reduce((a, p) => a + p.t, 0) / n;
  const my = puntos.reduce((a, p) => a + p.v, 0) / n;
  let num = 0, den = 0;
  for (const p of puntos) { num += (p.t - mx) * (p.v - my); den += (p.t - mx) ** 2; }
  if (den === 0) return null;
  return (num / den) * 86400; // puntos porcentuales por día
}

function pronostico(nombre, puntos, actual, umbral = 90, horasAlReinicio = null) {
  const m = pendientePorDia(puntos);
  if (m === null) return { recurso: nombre, texto: "Faltan datos para proyectar", nivel: "info", dias: null };
  if (m <= 0.05) return { recurso: nombre, texto: "Estable, sin tendencia al alza", nivel: "ok", dias: null, ritmo: +m.toFixed(2) };

  const dias = (umbral - actual) / m;
  const horas = dias * 24;
  // El reinicio diario devuelve la memoria a cero, así que si el límite queda
  // más allá del próximo reinicio, la saturación no llega a ocurrir.
  const cortado = horasAlReinicio !== null && horas > horasAlReinicio;

  let nivel = "ok";
  if (!cortado) { if (dias < 2) nivel = "crit"; else if (dias < 10) nivel = "warn"; }
  else if (horas < horasAlReinicio * 2) nivel = "warn";

  let texto;
  if (cortado) {
    texto = `Subiendo ${m.toFixed(1)} puntos al día. Al ritmo actual tocaría el ${umbral} % en ${dias < 1 ? "menos de un día" : Math.round(dias) + " días"}, pero el reinicio de las 4 lo corta antes.`;
  } else {
    texto = horas < 24
      ? `Llega al ${umbral} % en unas ${Math.round(horas)} horas, antes del próximo reinicio`
      : `Llega al ${umbral} % en unos ${Math.round(dias)} días`;
  }
  return { recurso: nombre, texto, nivel, dias: Math.round(dias), ritmo: +m.toFixed(2), cortado };
}

async function prediccion() {
  const hist = leerJsonl(F_HIST, 43200);
  const ahora = Math.floor(Date.now() / 1000);
  const estado = await estadoGeneral();

  // La memoria se reinicia con el servidor, así que su tendencia solo tiene
  // sentido desde el último arranque. El disco, en cambio, sobrevive al reinicio.
  const arranque = Math.floor(new Date(estado.arranque.replace(" ", "T") + "Z").getTime() / 1000) + 300;
  const desdeArranque = hist.filter((h) => h.t > arranque);
  const recientes = hist.filter((h) => ahora - h.t < 7 * 86400);

  const horasAlReinicio = (() => {
    const d = new Date();
    const prox = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), HORA_REINICIO_UTC, 0, 0));
    if (prox < d) prox.setUTCDate(prox.getUTCDate() + 1);
    return (prox - d) / 3600000;
  })();

  const pRam = pronostico("Memoria", desdeArranque.map((h) => ({ t: h.t, v: h.ram })), estado.ram.pct, 90, horasAlReinicio);
  const pDisco = pronostico("Disco", recientes.map((h) => ({ t: h.t, v: h.disco })), estado.disco.pct);

  // Señales tempranas: lo que suele anteceder a una caída.
  const swap = await cacheado("swap", 60, async () => (await sh("free -b | awk '/Swap/{print $3}'")).salida);
  const iowait = leerIowait().toFixed(2);
  const reinicios = estado.contenedores.reduce((a, c) => a + c.reinicios, 0);

  const senales = [
    { t: "Memoria de intercambio sin usar", d: "Cuando empieza a usarse, el servidor se vuelve lento minutos antes de caer.",
      valor: parseInt(swap || "0", 10) > 50 * 1024 * 1024 ? "en uso" : "0 MB",
      nivel: parseInt(swap || "0", 10) > 50 * 1024 * 1024 ? "warn" : "ok" },
    { t: "Memoria libre estable", d: "Una bajada sostenida es la señal clásica de una fuga de memoria.",
      valor: pRam.ritmo !== undefined && pRam.ritmo > 0 ? `+${pRam.ritmo} % al día` : "sin tendencia",
      nivel: pRam.nivel === "ok" ? "ok" : pRam.nivel },
    { t: "Sin esperas de disco", d: "El procesador no se queda esperando al almacenamiento.",
      valor: `${iowait} %`, nivel: parseFloat(iowait) > 10 ? "warn" : "ok" },
    { t: "Sin reinicios inesperados", d: "Un servicio que se reinicia solo repite el problema hasta que se arregla.",
      valor: String(reinicios), nivel: reinicios > 3 ? "warn" : "ok" },
    { t: "Servicios respondiendo", d: "Todos los contenedores en marcha y con chequeo correcto.",
      valor: `${estado.servicios.arriba} de ${estado.servicios.total}`,
      nivel: estado.servicios.arriba === estado.servicios.total ? "ok" : "crit" },
  ];

  // Riesgo 0 a 100: pesa lo que de verdad tumba un servidor.
  let riesgo = 0;
  riesgo += Math.max(0, estado.ram.pct - 70) * 0.9;
  riesgo += Math.max(0, estado.disco.pct - 60) * 0.6;
  if (pRam.dias !== null && pRam.dias < 10 && !pRam.cortado) riesgo += (10 - pRam.dias) * 3;
  if (pDisco.dias !== null && pDisco.dias < 10) riesgo += (10 - pDisco.dias) * 2;
  riesgo += senales.filter((s) => s.nivel === "warn").length * 5;
  riesgo += senales.filter((s) => s.nivel === "crit").length * 20;
  riesgo = Math.max(0, Math.min(100, Math.round(riesgo)));

  const nivel = riesgo >= 60 ? "crit" : riesgo >= 30 ? "warn" : "ok";
  const resumen = nivel === "ok"
    ? "Nada indica una caída en las próximas 48 horas."
    : nivel === "warn"
      ? "Hay una tendencia que conviene vigilar esta semana."
      : "Hay señales de que el servidor puede fallar pronto.";

  return {
    riesgo, nivel, resumen,
    pronosticos: [pRam, pDisco],
    senales,
    muestras: recientes.length,
    desde: recientes.length ? new Date(recientes[0].t * 1000).toISOString() : null,
  };
}

// ── Series para las gráficas (del historial propio — muestreado cada minuto
// por muestrear(), sin depender de nada externo) ────────────────────────────
async function serie(rango) {
  const segundos = rango === "7d" ? 604800 : 86400;
  const puntos = rango === "7d" ? 56 : 48;
  const desde = Math.floor(Date.now() / 1000) - segundos;
  const hist = leerJsonl(F_HIST, 43200).filter((h) => h.t >= desde);

  const paso = Math.max(1, Math.ceil(hist.length / puntos));
  const serieRam = [], serieCpu = [];
  for (let i = 0; i < hist.length; i += paso) {
    const h = hist[i];
    if (h.ram != null) serieRam.push([h.t, h.ram]);
    if (h.cpu != null) serieCpu.push([h.t, h.cpu]);
  }
  return { ram: serieRam, cpu: serieCpu, rango };
}

// ── Incidentes: detección, explicación y aviso ──────────────────────────────
function baseIncidentes() {
  return leerJson(F_INCID, { abierto: null, historial: [] });
}

/** Traduce una caída a lenguaje claro, mirando la evidencia del momento. */
/**
 * Versión detallada: en vez de adivinar con un "motivo" de una palabra, lee el
 * estado real del contenedor (cómo terminó, con qué código, si el sistema lo
 * cortó por memoria, si está congelado, cuántas veces se ha reiniciado) y las
 * últimas líneas que alcanzó a escribir. Así cada aviso dice qué pasó de
 * verdad, en lugar de repetir siempre el mismo texto genérico.
 */
async function explicarDetallado(nombre, ram, disco) {
  const insp = await sh(
    `docker inspect -f '{{.State.Status}};{{.State.ExitCode}};{{.State.OOMKilled}};{{.RestartCount}};{{if .State.Health}}{{.State.Health.Status}}{{else}}sin-chequeo{{end}};{{.State.Error}}' ${nombre}`,
    10000
  );
  const p = (insp.salida || "").trim().split(";");
  const estado = p[0] || "";
  const codigo = parseInt(p[1] || "0", 10);
  const oom = p[2] === "true";
  const reinicios = parseInt(p[3] || "0", 10);
  const salud = p[4] || "sin-chequeo";
  const errorDocker = (p[5] || "").trim();

  // Última línea con contenido que alcanzó a escribir el servicio: es la
  // pista más concreta y la que hace que cada aviso sea distinto y útil.
  let ultimaLinea = "";
  const logs = await sh(`docker logs --tail 12 ${nombre} 2>&1 | tail -6`, 10000);
  const lineas = (logs.salida || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lineas.length) ultimaLinea = lineas[lineas.length - 1].slice(0, 180);

  const conPista = (o) => (ultimaLinea ? { ...o, pista: ultimaLinea } : o);

  // OJO: el código 137 NO significa por sí solo falta de memoria. Es 128+9, o
  // sea "lo mataron a la fuerza", y eso pasa tanto cuando el sistema lo corta
  // por memoria como cuando alguien ejecuta un apagado forzado. Lo único que
  // distingue de verdad es la marca OOMKilled de Docker.
  if (oom) {
    return conPista({
      causa: "Se quedó sin memoria y el sistema lo cortó de golpe.",
      recomienda: "Subir el límite de memoria de ese servicio o corregir la fuga que la consume.",
      tipo: "memoria",
    });
  }
  if (codigo === 137) {
    return conPista({
      causa: "Lo apagaron a la fuerza, sin darle tiempo a cerrarse bien.",
      recomienda: "Si nadie lo apagó a propósito, revisar qué proceso o tarea programada lo está matando.",
      tipo: "apagado_forzado",
    });
  }
  if (estado === "paused") {
    return conPista({
      causa: "Quedó congelado: el proceso existe pero no atiende nada.",
      recomienda: "Descongelarlo. Si no fue a propósito, revisar quién lo congeló.",
      tipo: "congelado",
    });
  }
  if (disco >= 95) {
    return conPista({
      causa: "El disco se llenó y el servicio no pudo seguir escribiendo.",
      recomienda: "Liberar espacio con la limpieza y revisar qué carpeta creció.",
      tipo: "disco",
    });
  }
  if (ram >= 92) {
    return conPista({
      causa: "El servidor se quedó casi sin memoria y el servicio no pudo seguir.",
      recomienda: "Revisar qué servicio está consumiendo de más y reiniciarlo.",
      tipo: "memoria",
    });
  }
  if (reinicios >= 3) {
    return conPista({
      causa: `Se está reiniciando una y otra vez (${reinicios} veces). Arranca y se vuelve a caer.`,
      recomienda: "Esto no se arregla reiniciando: hay que mirar el error que sale al arrancar.",
      tipo: "bucle",
    });
  }
  if (codigo !== 0 && !isNaN(codigo)) {
    return conPista({
      causa: `El programa se cerró con un error interno (código ${codigo})${errorDocker ? `: ${errorDocker.slice(0, 120)}` : ""}.`,
      recomienda: "Revisar el error que quedó en los registros justo antes de cerrarse.",
      tipo: "error",
    });
  }
  if (salud === "unhealthy") {
    return conPista({
      causa: "Sigue encendido pero dejó de responder a su propia prueba de salud.",
      recomienda: "Suele ser saturación o una conexión trabada. Revisar los registros de los minutos previos.",
      tipo: "salud",
    });
  }
  if (estado === "running" && salud !== "unhealthy") {
    // Llegó aquí estando sano: pasó algo breve que ya se corrigió solo.
    return conPista({
      causa: "Tuvo un tropiezo corto y volvió a la normalidad por su cuenta.",
      recomienda: "Si se repite varias veces al día, hay que mirar los registros de esos momentos.",
      tipo: "tropiezo",
    });
  }
  if (estado === "exited" && codigo === 0) {
    return conPista({
      causa: "Se apagó de forma limpia, como si alguien lo hubiera detenido.",
      recomienda: "Confirmar que nadie lo apagó a propósito; si no, revisar tareas programadas.",
      tipo: "apagado",
    });
  }
  return conPista({
    causa: "Se detuvo de forma inesperada y no quedó una causa clara.",
    recomienda: "Revisar los registros del servicio para ver el error exacto.",
    tipo: "desconocido",
  });
}

/** Cuenta en español qué hizo Centinela de verdad durante el incidente, en vez
 * de una frase fija. Si no hizo nada, lo dice; si intentó algo y falló, también. */
function textoAcciones(inc) {
  const acciones = inc.acciones || [];
  if (!acciones.length) return "nada; el servicio volvió por su cuenta.";
  const nombres = { "docker start": "lo volví a encender" };
  const hechas = acciones.map((a) => {
    const que = nombres[a.accion] || a.accion;
    return a.ok ? que : `${que} (no funcionó)`;
  });
  const alguna = acciones.some((a) => a.ok);
  return `${hechas.join(", ")}. ${alguna ? "Con eso volvió a responder." : "Volvió por su cuenta, no por lo que intenté."}`;
}

function explicar(nombre, motivo, ram, disco) {
  if (motivo === "OOMKilled" || ram >= 92)
    return { causa: "Se quedó sin memoria y el sistema lo cortó.",
             recomienda: "Subir el límite de memoria del servicio o corregir la fuga que la consume." };
  if (disco >= 95)
    return { causa: "El disco se llenó y el servicio no pudo seguir escribiendo.",
             recomienda: "Liberar espacio con la optimización y revisar qué carpeta creció." };
  if (motivo === "unhealthy")
    return { causa: "Dejó de responder al chequeo de salud, aunque el proceso seguía vivo.",
             recomienda: "Revisar los registros del servicio en los minutos previos." };
  return { causa: "El servicio se detuvo de forma inesperada.",
           recomienda: "Revisar los registros del servicio para ver el error exacto." };
}

// El muestreo de cada minuto y el vigilante de eventos de Docker pueden
// llamar aquí casi a la vez. Sin este cerrojo, las dos llamadas leen el estado
// anterior antes de que ninguna lo haya escrito y abren el mismo incidente dos
// veces (visto en producción: dos "incidente_detectado" con 9 ms de diferencia).
let revisandoIncidentes = false;
async function revisarIncidentes(contenedores) {
  if (revisandoIncidentes) return;
  revisandoIncidentes = true;
  try {
    return await revisarIncidentesInterno(contenedores);
  } finally {
    revisandoIncidentes = false;
  }
}

// Orden de revisión: primero la infraestructura de la que otros dependen
// (base de datos, memoria de búsqueda), luego el bot, y el proxy al final —
// el proxy no es una dependencia del bot (CLAUDE.md documenta el orden de
// reinicio como DB → chroma → bot → proxy), así que no debía ir antes.
const ORDEN_CAUSA_RAIZ = ["zeus-mariadb", "zeus-chromadb", "zeus-bot", "zeus-proxy"];
function ordenarPorCausaRaiz(lista) {
  return [...lista].sort((a, b) => {
    const ia = ORDEN_CAUSA_RAIZ.indexOf(a.nombre), ib = ORDEN_CAUSA_RAIZ.indexOf(b.nombre);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
}
// A quién culpar primero si este contenedor y su causa raíz caen juntos. El
// orden de revisión (arriba) ya cubre el caso en que ambos caen EN EL MISMO
// muestreo, pero el bot muere al instante (ECONNREFUSED) mientras Docker
// tarda 30-90 s en marcar a mariadb "unhealthy" — así que casi siempre el
// bot ya aparece caído cuando mariadb todavía figura sana. Por eso, antes de
// abrir un incidente a nombre de un contenedor, se revisa el estado ACTUAL
// (no el de la revisión anterior) de sus causas raíz conocidas.
const CAUSA_RAIZ_DE = { "zeus-bot": ["zeus-mariadb", "zeus-chromadb"] };

async function revisarIncidentesInterno(contenedoresSinOrdenar) {
  const contenedores = ordenarPorCausaRaiz(contenedoresSinOrdenar);
  const previo = leerJson(F_ESTADO, { estados: {} });
  const db = baseIncidentes();
  const ram = leerMemoria().pct;
  const disco = (await leerDisco()).pct;
  const estados = {};
  let cambios = false;

  for (const c of contenedores) {
    const sano = c.estado === "running" && c.salud !== "unhealthy";
    estados[c.nombre] = { sano, reinicios: c.reinicios, arrancado_ms: c.arrancado_ms };
    const antes = previo.estados[c.nombre];
    if (!antes) continue;
    // Los contenedores ajenos se registran en el estado (para el panel) pero
    // nunca generan incidente, aviso ni reinicio automático.
    if (!CONTENEDORES_PROPIOS.has(c.nombre)) continue;
    // Reinicio deliberado en curso: no es una falla.
    if (estaEnMantenimiento(c.nombre) || esReinicioBotProgramado(c.nombre)) continue;

    // Reinicio relámpago: el contenedor se murió y la política de reinicio de
    // Docker lo revivió tan rápido que entre dos revisiones nunca lo vimos
    // caído. La única huella que queda es que el contador de reinicios subió.
    // Sin esta comprobación, una caída breve pasa inadvertida y el dueño nunca
    // se entera de que su bot se cayó (lo encontró el simulacro del bot).
    const seReinicio = (c.arrancado_ms && antes.arrancado_ms && c.arrancado_ms > antes.arrancado_ms)
      || c.reinicios > (antes.reinicios || 0);
    if (antes.sano && sano && seReinicio && !db.abierto) {
      const exp = await explicarDetallado(c.nombre, ram, disco);
      const motivo = exp.tipo;
      const ahoraIso = new Date().toISOString();
      const inc = {
        id: Date.now(), servicio: c.nombre, descripcion: c.descripcion,
        inicio: ahoraIso, fin: ahoraIso, duracion_s: 0, motivo, ram, disco, ...exp,
        acciones: [], resuelto: "Volvió solo en segundos",
        relampago: true,
      };
      db.historial.unshift(inc);
      db.historial = db.historial.slice(0, 60);
      cambios = true;
      auditar("incidente_relampago", "agente", "resuelto", `${c.nombre}: ${motivo}`);
      const modoRel = kapsoYModo.obtenerModo(leerJson, F_MODO);
      if (kapsoYModo.debeSilenciar("crit", modoRel, { autoRemediable: true }) || !permisos.permitido("whatsapp", "escritura")) {
        auditar("aviso_silenciado_modo_viaje", "agente", "silenciado", c.nombre);
      } else {
        enviarWhatsapp(
          `Zeus se cayó un momento y ya volvió\n\n` +
          `Qué falló: ${c.descripcion}\n` +
          `Cuánto duró: menos de un minuto\n\n` +
          `Por qué: ${inc.causa}\n` +
          (inc.pista ? `Lo último que alcanzó a decir: ${inc.pista}\n` : "") +
          `\nQué hice: nada; volvió solo antes de que hiciera falta actuar.\n` +
          `Qué recomiendo: ${inc.recomienda}\n\n` +
          `panel.ejemplo.com`
        ).catch(() => {});
      }
    }

    if (antes.sano && !sano) {
      if (!db.abierto) {
        // ¿La causa raíz de este contenedor ya está caída AHORA MISMO (no en
        // la revisión anterior)? Si es así, el incidente se abre a nombre de
        // la causa, no del síntoma, aunque el síntoma se haya detectado primero.
        let causante = c;
        for (const rn of (CAUSA_RAIZ_DE[c.nombre] || [])) {
          if (estados[rn] && estados[rn].sano === false) { causante = contenedores.find((x) => x.nombre === rn) || c; break; }
        }
        const exp = await explicarDetallado(causante.nombre, ram, disco);
        const motivo = exp.tipo;
        // Versión del bot corriendo en el momento de la falla — así, si varios
        // incidentes empiezan justo en el mismo commit, se puede responder
        // "¿esto empezó con el despliegue de tal día?" sin adivinar.
        const versionBot = await sh("git -C /opt/zeus-app rev-parse --short HEAD 2>/dev/null", 5000)
          .then((r) => (r.salida || "").trim() || null).catch(() => null);
        db.abierto = {
          id: Date.now(), servicio: causante.nombre, descripcion: causante.descripcion,
          inicio: new Date().toISOString(), motivo, ram, disco, ...exp, acciones: [],
          afectados: causante.nombre === c.nombre ? [] : [c.nombre],
          version_bot: versionBot,
        };
        cambios = true;
        auditar("incidente_detectado", "agente", "abierto",
          causante.nombre === c.nombre ? `${c.nombre}: ${motivo}` : `${causante.nombre}: ${motivo} (también afecta a ${c.nombre})`);
      } else if (db.abierto.servicio !== c.nombre && (db.abierto.afectados || []).indexOf(c.nombre) === -1) {
        // Otro contenedor propio cayó mientras ya había un incidente abierto
        // — se suma a la lista de afectados en vez de perderse en silencio,
        // para que el aviso final no diga "ya volvió" con este todavía caído.
        db.abierto.afectados = db.abierto.afectados || [];
        db.abierto.afectados.push(c.nombre);
        cambios = true;
        auditar("incidente_afectado_agregado", "agente", "detectado", `${c.nombre} también cayó durante el incidente de ${db.abierto.servicio}`);
      }
    }
  }

  // El incidente solo se cierra cuando el servicio principal Y todos los
  // demás contenedores propios que cayeron con él ya están sanos — cerrarlo
  // con uno todavía caído mandaría "Zeus tuvo una falla y ya volvió" siendo
  // falso (regla del protocolo: "encendido" no es lo mismo que "atendiendo").
  if (db.abierto) {
    const servicioSano = estados[db.abierto.servicio] && estados[db.abierto.servicio].sano;
    const afectados = db.abierto.afectados || [];
    const afectadosSanos = afectados.every((n) => estados[n] && estados[n].sano);
    if (servicioSano && afectadosSanos) {
      const inc = db.abierto;
      inc.fin = new Date().toISOString();
      inc.duracion_s = Math.round((new Date(inc.fin) - new Date(inc.inicio)) / 1000);
      inc.resuelto = inc.acciones.length ? "El agente lo reinició" : "Se recuperó solo";
      db.historial.unshift(inc);
      db.historial = db.historial.slice(0, 60);
      db.abierto = null;
      cambios = true;
      auditar("incidente_cerrado", "agente", "resuelto", `${inc.servicio} en ${inc.duracion_s}s`);
      const modoInc = kapsoYModo.obtenerModo(leerJson, F_MODO);
      if (kapsoYModo.debeSilenciar("crit", modoInc, { autoRemediable: inc.acciones.length > 0 }) || !permisos.permitido("whatsapp", "escritura")) {
        auditar("aviso_silenciado_modo_viaje", "agente", "silenciado", inc.servicio);
      } else {
      enviarWhatsapp(
        `Zeus tuvo una falla y ya volvió\n\n` +
        `Qué falló: ${inc.descripcion}` + (afectados.length ? ` (también afectó a ${afectados.map((n) => DESCRIPCIONES[n] || n).join(", ")})` : "") + `\n` +
        `Cuánto duró: ${inc.duracion_s < 60 ? `${inc.duracion_s} segundos` : `${Math.round(inc.duracion_s / 60)} minuto(s)`}\n\n` +
        `Por qué: ${inc.causa}\n` +
        (inc.pista ? `Lo último que alcanzó a decir: ${inc.pista}\n` : "") +
        `\nQué hice: ${textoAcciones(inc)}\n` +
        `Qué recomiendo: ${inc.recomienda}\n\n` +
        `panel.ejemplo.com`
      ).catch(() => {});
      }
    }
  }

  // Si hay una caída abierta, el agente intenta levantarla: primero el
  // servicio principal (ya es la causa raíz, ver arriba), luego cada
  // contenedor afectado que cayó con él, en ese mismo orden.
  if (db.abierto && !db.abierto.acciones.length) {
    const inc = db.abierto;
    const bloqueado = reglasSeguridad.frenoActivo() || !permisos.permitido("contenedores", "escritura");
    if (bloqueado) {
      for (const nombre of [inc.servicio, ...(inc.afectados || [])]) {
        inc.acciones.push({ ts: new Date().toISOString(), accion: "bloqueado_por_regla", objetivo: nombre, ok: false });
      }
      cambios = true;
    } else {
      for (const nombre of [inc.servicio, ...(inc.afectados || [])]) {
        const r = await sh(`docker start ${nombre}`, 30000);
        inc.acciones.push({ ts: new Date().toISOString(), accion: "docker start", objetivo: nombre, ok: r.ok });
        auditar("auto_recuperacion", "agente", r.ok ? "ok" : "falló", nombre);
      }
      cambios = true;
    }
  }

  if (cambios) guardarJson(F_INCID, db);
  guardarJson(F_ESTADO, { estados, ts: Date.now() });
}

// ── Reinicios ───────────────────────────────────────────────────────────────
async function historialReinicios() {
  return cacheado("reinicios", 120, async () => {
    // LC_ALL=C fija los nombres de mes en inglés; si el idioma del sistema
    // cambiara, el análisis de fechas devolvería una lista vacía sin avisar.
    const r = await sh("LC_ALL=C last -x reboot -F | head -20");
    const filas = [];
    for (const l of r.salida.split("\n")) {
      const m = l.match(/reboot\s+system boot\s+\S+\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})/);
      if (!m) continue;
      const d = new Date(m[1] + " UTC");
      if (isNaN(d)) continue;
      const local = new Date(d.getTime() - 5 * 3600 * 1000); // Colombia
      const hora = local.getUTCHours(), minuto = local.getUTCMinutes();
      const programado = hora === 4 && minuto < 10;
      const antiguo = hora === 3 && minuto >= 25 && minuto <= 40; // el horario anterior, 3:30
      filas.push({
        fecha: local.toISOString().slice(0, 10),
        hora: local.toISOString().slice(11, 16),
        tipo: programado ? "Programado" : antiguo ? "Programado (horario anterior)" : "Manual o inesperado",
        estado: programado || antiguo ? "ok" : "warn",
      });
    }
    const ahora = new Date();
    const prox = new Date(Date.UTC(ahora.getUTCFullYear(), ahora.getUTCMonth(), ahora.getUTCDate(), HORA_REINICIO_UTC, 0, 0));
    if (prox < ahora) prox.setUTCDate(prox.getUTCDate() + 1);
    const faltan = Math.round((prox - ahora) / 60000);
    return {
      proximo: "04:00 hora de Colombia",
      faltan_min: faltan,
      faltan_texto: `${Math.floor(faltan / 60)} h ${faltan % 60} min`,
      historial: filas,
    };
  });
}

// ── Respaldos ───────────────────────────────────────────────────────────────
async function estadoRespaldos() {
  return cacheado("respaldos", 60, async () => {
    let archivos = [];
    try {
      archivos = fs.readdirSync(DIR_RESPALDOS)
        .filter((f) => f.startsWith("db_") && f.endsWith(".sql.gz"))
        .map((f) => {
          const st = fs.statSync(path.join(DIR_RESPALDOS, f));
          return { nombre: f, bytes: st.size, mb: Math.round(st.size / 1048576), ts: st.mtime.toISOString() };
        })
        .sort((a, b) => (a.ts < b.ts ? 1 : -1));
    } catch (_) {}

    // Antes se detectaba con `rclone lsd zeus-drive: | head -3`: la tubería con
    // `head` hacía que el código de salida real de rclone se perdiera (bash
    // devuelve el del último comando, `head`, que casi siempre es 0), así que
    // "conectado" dependía solo de si el texto contenía ciertas palabras. Un
    // simple corte de red pasajero podía verse igual que un permiso vencido de
    // verdad — pasó justo eso el 12 sept: "desconectado" a la 1:33 a.m. y "ok"
    // a las 3:08 a.m. sin que nadie volviera a autorizar nada.
    //
    // Ahora: sin tubería (el código de salida es el real de rclone), un
    // reintento antes de declarar nada, y el mensaje solo dice "permiso
    // vencido" cuando el error es realmente de autenticación — un timeout o
    // problema de red se avisa distinto, sin asustar con algo que no pasó.
    const drive = await cacheado("drive", 600, async () => {
      async function probar() {
        return sh("rclone lsd zeus-drive: --max-depth 1 --low-level-retries 1 --retries 1 2>&1; echo CODIGO_SALIDA:$?", 15000);
      }
      let r = await probar();
      let m = r.salida.match(/CODIGO_SALIDA:(\d+)\s*$/);
      let codigo = m ? Number(m[1]) : 1;
      if (codigo !== 0) {
        // Un solo fallo puede ser un corte de red de un segundo — se repite
        // una vez antes de darlo por caído de verdad.
        await new Promise((res) => setTimeout(res, 3000));
        r = await probar();
        m = r.salida.match(/CODIGO_SALIDA:(\d+)\s*$/);
        codigo = m ? Number(m[1]) : 1;
      }
      if (codigo === 0) return { conectado: true, motivo: "" };
      const texto = r.salida + r.error;
      // OJO: "403" solo, por sí solo, NO significa permiso revocado — rclone
      // usa por defecto una aplicación de Google compartida por miles de
      // usuarios (no hay client_id propio en la config de este servidor), y
      // esa cuota compartida a veces se satura ("Quota exceeded... Requests
      // per minute", rateLimitExceeded). Eso es tráfico, no un permiso
      // vencido, y se resuelve solo en segundos — hay que distinguirlo de un
      // 401/invalid_grant real, que sí exige volver a autorizar a mano.
      const esCuota = /quota exceeded|ratelimitexceeded|requests per minute|rate limit/i.test(texto);
      const esAuth = !esCuota && /(^|[^0-9])401([^0-9]|$)|invalid_grant|invalid_token|token.*expir|unauthorized|access_denied/i.test(texto);
      return {
        conectado: false,
        motivo: esAuth
          ? "El permiso de Google caducó — hay que volver a autorizar el acceso"
          : esCuota
            ? "Google está limitando las peticiones por un momento (cuota compartida) — se resuelve solo"
            : "No se pudo comprobar la conexión con Drive ahora mismo (puede ser un corte de red pasajero)",
        es_permiso: esAuth,
      };
    });

    const ultimo = archivos[0]
      ? { ...archivos[0], horas: Math.round((Date.now() - new Date(archivos[0].ts)) / 3600000) }
      : null;

    return {
      ultimo, archivos: archivos.slice(0, 14), total: archivos.length,
      espacio_mb: Math.round(archivos.reduce((a, f) => a + f.bytes, 0) / 1048576),
      drive, hora: "03:00 hora de Colombia",
    };
  });
}

// ── Base de datos ───────────────────────────────────────────────────────────
function mysql(consulta) {
  // El comando se manda dentro de comillas dobles a `bash -lc` (ver sh()), y
  // dentro de comillas dobles Bash SIGUE interpretando `\`, "$" y las
  // comillas invertidas — estas últimas como si fueran para ejecutar un
  // comando. Cualquier SQL con identificadores entre backticks (el estándar
  // de MySQL: `tabla`, `columna`) se rompía en silencio por esto: Bash
  // intentaba "ejecutar" el nombre de la tabla como si fuera un programa, y
  // la consulta real nunca llegaba a MariaDB. El orden importa: escapar la
  // barra invertida PRIMERO, antes de que las demás reglas metan barras nuevas.
  const escapada = consulta
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/`/g, "\\`")
    .replace(/\$/g, "\\$");
  return sh(`docker exec zeus-mariadb mysql -uroot -p'${MYSQL_PASS}' -N -B -e "${escapada}" 2>/dev/null`, 30000);
}

async function estadoDatos() {
  return cacheado("datos", 120, async () => {
    const tam = await mysql(
      "SELECT table_name, table_rows, ROUND((data_length+index_length)/1048576) mb, ROUND(data_free/1048576) libre " +
      "FROM information_schema.tables WHERE table_schema='" + ESQUEMA + "' ORDER BY (data_length+index_length) DESC LIMIT 8;"
    );
    const tablas = tam.salida.split("\n").filter(Boolean).map((l) => {
      const [nombre, filas, mb, libre] = l.split("\t");
      return { nombre, filas: parseInt(filas || 0, 10), mb: parseInt(mb || 0, 10), desperdicio: parseInt(libre || 0, 10) };
    });

    const est = await mysql("SHOW GLOBAL STATUS WHERE Variable_name IN ('Slow_queries','Threads_connected','Uptime','Questions');");
    const stats = {};
    est.salida.split("\n").filter(Boolean).forEach((l) => { const [k, v] = l.split("\t"); stats[k] = v; });

    // El registro de consultas lentas vive dentro del contenedor. Se lee la
    // cola del archivo y se interpreta en el host con un pequeño script awk,
    // que es mucho más fiable que encadenar comillas dentro de docker exec.
    const lentas = await sh(
      "docker exec zeus-mariadb cat /tmp/mariadb-slow.log 2>/dev/null | tail -4000 " +
      "| awk -f /opt/zeus-ops/slowlog.awk | sort -rn | head -8", 30000
    );
    const consultas = lentas.salida.split("\n").filter(Boolean).map((l) => {
      const [seg, ...resto] = l.split("\t");
      const sql = resto.join(" ").trim();
      // El volcado del respaldo lee tablas enteras y siempre sale lento. Es
      // esperado y no hay nada que optimizar, así que se marca aparte para no
      // confundirlo con una consulta lenta del bot o del punto de venta.
      const deRespaldo = /SQL_NO_CACHE/i.test(sql);
      return {
        segundos: +parseFloat(seg).toFixed(2),
        sql,
        origen: deRespaldo ? "respaldo" : "aplicación",
        accionable: !deRespaldo,
      };
    }).filter((c) => c.sql && !isNaN(c.segundos));

    const totalMb = tablas.reduce((a, t) => a + t.mb, 0);
    const baseViva = tam.ok && tablas.length > 0;
    return {
      base_viva: baseViva,
      error: baseViva ? null : "No se pudo consultar la base de datos. Puede estar caída o reiniciándose.",
      tamano_mb: totalMb,
      tablas,
      consultas_lentas: consultas,
      slow_total: parseInt(stats.Slow_queries || 0, 10),
      conexiones: parseInt(stats.Threads_connected || 0, 10),
      consultas_totales: parseInt(stats.Questions || 0, 10),
      candidatas_desfragmentar: tablas.filter((t) => t.desperdicio > 50).map((t) => t.nombre),
    };
  });
}

// ── Seguridad ───────────────────────────────────────────────────────────────
async function estadoSeguridad() {
  return cacheado("seguridad", 300, async () => {
    const ufw = await sh("ufw status | grep -E '^[0-9]' | head -12");
    const jail = await sh("fail2ban-client status sshd 2>/dev/null | tail -4");
    const apt = await sh("/usr/lib/update-notifier/apt-check --human-readable 2>&1 | grep -E 'updates|security' | head -3");
    const fallidos = await sh("grep -c 'Failed password' /var/log/auth.log 2>/dev/null || echo 0");
    const sshRoot = await sh("sshd -T 2>/dev/null | grep -E '^permitrootlogin|^passwordauthentication|^x11forwarding'");

    const baneadas = (jail.salida.match(/Banned IP list:\s*(.*)/) || [, ""])[1].trim().split(/\s+/).filter(Boolean);
    const actuales = parseInt((jail.salida.match(/Currently banned:\s*(\d+)/) || [, "0"])[1], 10);
    const totales = parseInt((jail.salida.match(/Total banned:\s*(\d+)/) || [, "0"])[1], 10);
    const conf = {};
    sshRoot.salida.split("\n").filter(Boolean).forEach((l) => { const [k, v] = l.split(" "); conf[k] = v; });
    const pendientes = parseInt((apt.salida.match(/(\d+)\s+updates?/) || [, "0"])[1], 10);

    const lista = [
      { t: "Entrada solo con llave", ok: conf.passwordauthentication === "no",
        d: conf.passwordauthentication === "no" ? "La contraseña ya no sirve para entrar." : "El acceso con contraseña sigue activo." },
      { t: "Acceso directo de administrador limitado", ok: conf.permitrootlogin !== "yes",
        d: conf.permitrootlogin === "yes" ? "Conviene restringirlo a llaves." : "Restringido correctamente." },
      { t: "Reenvío gráfico apagado", ok: conf.x11forwarding === "no",
        d: conf.x11forwarding === "no" ? "Apagado, como debe ser." : "Está encendido sin necesidad." },
      { t: "Cortafuegos activo", ok: ufw.salida.includes("ALLOW"),
        d: "Solo entrada web y administración remota." },
      { t: "Bloqueo automático de intrusos", ok: totales > 0 || actuales >= 0,
        d: `${actuales} direcciones bloqueadas ahora mismo.` },
      { t: "Actualizaciones de seguridad al día", ok: pendientes === 0,
        d: pendientes === 0 ? "Sin actualizaciones pendientes." : `${pendientes} actualizaciones esperando.` },
    ];

    return {
      puertos: ufw.salida.split("\n").filter(Boolean).slice(0, 8),
      baneos: { actuales, totales, lista: baneadas.slice(0, 12) },
      intentos_fallidos: parseInt(fallidos.salida || "0", 10),
      actualizaciones: pendientes,
      checklist: lista,
      puntaje: Math.round((lista.filter((x) => x.ok).length / lista.length) * 100),
    };
  });
}

// ── Simulacros (ingeniería del caos) ────────────────────────────────────────
// Se instancia aquí, después de que ya existen todas las funciones que recibe.
const { crearSimulacros } = require("./modulos/simulacros/simulacros.js");

const simulacros = crearSimulacros({
  sh, auditar, enviarWhatsapp, leerContenedores, estadoGeneral, estadoDatos,
  leerDisco, leerMemoria, leerCpu, cache, DIR_DATOS, env, explicar,
  // OJO: el respaldo corre a las 08:00 UTC por cron (3:00 a.m. Colombia). No
  // confundir con HORA_RESUMEN_UTC (13), que es el resumen por WhatsApp.
  HORA_REINICIO_UTC, HORA_RESPALDO_UTC: 8,
});

// ── Contenedores (gestión, consola en vivo, mantenimiento) ─────────────────
const { crearContenedores } = require("./modulos/contenedores/contenedores.js");

const contenedores = crearContenedores({
  sh, auditar, enviarWhatsapp, leerContenedores, leerMemoria, cache, DIR_DATOS, env,
  CONTENEDORES_PROPIOS, DESCRIPCIONES, explicar,
  HORA_REINICIO_UTC, HORA_RESPALDO_UTC: 8,
  hayBloqueoExterno: () => !!simulacros.estado().en_curso,
});

// ── Acciones ────────────────────────────────────────────────────────────────
async function ejecutarAccion(accion, objetivo) {
  const contenedores = await leerContenedores();
  const nombres = contenedores.map((c) => c.nombre);

  switch (accion) {
    case "reiniciar_contenedor": {
      if (!nombres.includes(objetivo)) return { ok: false, mensaje: "Ese servicio no existe" };
      marcarMantenimiento(objetivo, 180);
      const r = await sh(`docker restart ${objetivo}`, 60000);
      auditar("reiniciar_contenedor", "panel", r.ok ? "ok" : "falló", objetivo);
      return { ok: r.ok, mensaje: r.ok ? `${objetivo} reiniciado` : "No se pudo reiniciar", salida: r.salida || r.error };
    }
    case "optimizar": {
      const antes = await leerDisco();
      const pasos = [];
      let r = await sh("docker builder prune -af 2>&1 | tail -2", 180000);
      pasos.push({ paso: "Sobras de despliegues", detalle: r.salida.slice(-120) });
      r = await sh("docker image prune -f 2>&1 | tail -1", 120000);
      pasos.push({ paso: "Imágenes sin usar", detalle: r.salida.slice(-120) });
      r = await sh("journalctl --vacuum-time=14d 2>&1 | tail -1", 60000);
      pasos.push({ paso: "Registros del sistema", detalle: r.salida.slice(-120) });
      r = await sh("find /opt/zeus-app/logs -name '*.log' -size +50M -exec truncate -s 20M {} \\; 2>&1; echo listo", 30000);
      pasos.push({ paso: "Registros del bot", detalle: "recortados a 20 MB" });
      const datos = await estadoDatos();
      for (const t of datos.candidatas_desfragmentar.slice(0, 3)) {
        await mysql(`OPTIMIZE TABLE .\\\`${t}\\\`;`);
        pasos.push({ paso: `Tabla ${t}`, detalle: "desfragmentada" });
      }
      cache.delete("datos"); cache.delete("contenedores");
      const despues = await leerDisco();
      const liberado = Math.round((despues.libre - antes.libre) / 1048576);
      auditar("optimizar", "panel", "ok", `${liberado} MB liberados`);
      return { ok: true, mensaje: `Liberados ${liberado} MB`, liberado_mb: liberado, antes: antes.pct, despues: despues.pct, pasos };
    }
    case "respaldar": {
      const r = await sh("/opt/zeus-app/scripts/backup_db.sh 2>&1 | tail -3", 300000);
      cache.delete("respaldos");
      auditar("respaldar", "panel", r.ok ? "ok" : "falló", r.salida.slice(-120));
      return { ok: r.ok, mensaje: r.ok ? "Respaldo creado" : "El respaldo falló", salida: r.salida };
    }
    case "enviar_wsp": {
      const e = await estadoGeneral();
      const p = await prediccion();
      const r = await enviarWhatsapp(textoResumen(e, p, await estadoRespaldos()));
      auditar("enviar_wsp", "panel", r.ok ? "ok" : "falló", "");
      return { ok: r.ok, mensaje: r.ok ? "Mensaje enviado a tu WhatsApp" : "No se pudo enviar" };
    }
    case "desbanear": {
      if (!/^[0-9.]{7,15}$/.test(objetivo || "")) return { ok: false, mensaje: "Dirección no válida" };
      const r = await sh(`fail2ban-client set sshd unbanip ${objetivo}`, 20000);
      cache.delete("seguridad");
      auditar("desbanear", "panel", r.ok ? "ok" : "falló", objetivo);
      return { ok: r.ok, mensaje: r.ok ? `${objetivo} desbloqueada` : "No se pudo desbloquear" };
    }
    case "actualizar_seguridad": {
      const chequeoPermiso = permisos.verificarEscritura("actualizaciones", "Actualizaciones del sistema");
      if (!chequeoPermiso.ok) return { ok: false, mensaje: chequeoPermiso.mensaje };
      const r = await sh("DEBIAN_FRONTEND=noninteractive apt-get update -qq && unattended-upgrade -d 2>&1 | tail -3", 420000);
      cache.delete("seguridad");
      auditar("actualizar_seguridad", "panel", r.ok ? "ok" : "falló", "");
      return { ok: r.ok, mensaje: r.ok ? "Actualizaciones aplicadas" : "Falló la actualización", salida: r.salida.slice(-300) };
    }
    case "reiniciar_servidor": {
      if (objetivo !== "REINICIAR") return { ok: false, mensaje: "Falta la confirmación escrita" };
      const chequeoPermiso = permisos.verificarEscritura("servidor", "Servidor completo");
      if (!chequeoPermiso.ok) return { ok: false, mensaje: chequeoPermiso.mensaje };
      auditar("reiniciar_servidor", "panel", "ok", "solicitado desde el panel");
      enviarWhatsapp("Reinicio del servidor solicitado desde el panel. Vuelve en unos 2 minutos.").catch(() => {});
      sh("sleep 3 && /sbin/reboot").catch(() => {});
      return { ok: true, mensaje: "El servidor se está reiniciando" };
    }
    case "limpiar_docker": {
      const r = await sh("/opt/zeus-app/scripts/docker_cleanup.sh 2>&1 | tail -3", 180000);
      auditar("limpiar_docker", "panel", r.ok ? "ok" : "falló", "");
      return { ok: r.ok, mensaje: "Limpieza terminada", salida: r.salida };
    }
    default:
      return { ok: false, mensaje: "Acción desconocida" };
  }
}

// ── Resumen diario ──────────────────────────────────────────────────────────
function textoResumen(estado, pred, respaldo) {
  const icono = pred.nivel === "ok" ? "Todo en orden" : pred.nivel === "warn" ? "Con avisos" : "Requiere atención";
  const lineas = [
    `Centinela Zeus — ${icono}`,
    "",
    `Memoria: ${estado.ram.pct} %`,
    `Disco: ${estado.disco.pct} % (${Math.round(estado.disco.libre / 1073741824)} GB libres)`,
    `Servicios: ${estado.servicios.arriba} de ${estado.servicios.total} activos`,
    `Riesgo de falla: ${pred.riesgo} de 100`,
  ];
  if (respaldo.ultimo) lineas.push(`Respaldo: hace ${respaldo.ultimo.horas} h, ${respaldo.ultimo.mb} MB`);
  if (!respaldo.drive.conectado && respaldo.drive.es_permiso) lineas.push("Aviso: Google Drive sigue desconectado, hay que volver a autorizarlo");
  const avisos = estado.avisos.filter((a) => a.nivel === "crit");
  if (avisos.length) { lineas.push(""); lineas.push("Atención:"); avisos.forEach((a) => lineas.push(`- ${a.texto}`)); }
  const pr = pred.pronosticos.find((p) => p.nivel === "warn" || p.nivel === "crit");
  if (pr) { lineas.push(""); lineas.push(`Predicción: ${pr.recurso.toLowerCase()} ${pr.texto.toLowerCase()}`); }
  lineas.push("", "panel.ejemplo.com");
  return lineas.join("\n");
}

let ultimoResumen = "";
async function quizaResumenDiario() {
  const ahora = new Date();
  const hoy = ahora.toISOString().slice(0, 10);
  if (ahora.getUTCHours() !== HORA_RESUMEN_UTC || ultimoResumen === hoy) return;
  ultimoResumen = hoy;
  if (kapsoYModo.debeSilenciar("info", kapsoYModo.obtenerModo(leerJson, F_MODO))) {
    auditar("resumen_diario", "agente", "silenciado_modo_viaje", "");
    latidos.registrar("resumen_diario", { ok: true }, "agente");
    return;
  }
  try {
    const [e, p, r] = [await estadoGeneral(), await prediccion(), await estadoRespaldos()];
    const res = await enviarWhatsapp(textoResumen(e, p, r));
    auditar("resumen_diario", "agente", res.ok ? "enviado" : "falló", "");
    latidos.registrar("resumen_diario", { ok: true }, "agente");
  } catch (e) {
    auditar("resumen_diario", "agente", "error", e.message);
    latidos.registrar("resumen_diario", { ok: false, detalle: e.message }, "agente");
  }
}

/**
 * Verificación posterior al reinicio diario.
 * El servicio arranca con el servidor, así que espera a que todo levante y
 * comprueba que no falte nada. Solo avisa si algo salió mal.
 */
async function verificarArranque() {
  const arrancoHaceMin = process.uptime() / 60;
  if (arrancoHaceMin > 10) return; // no es un arranque reciente
  await new Promise((r) => setTimeout(r, 180000)); // tres minutos de margen
  cache.delete("contenedores");
  const contenedores = await leerContenedores();
  const faltan = contenedores.filter((c) => c.estado !== "running" || c.salud === "unhealthy");
  const registro = {
    ts: new Date().toISOString(),
    total: contenedores.length,
    arriba: contenedores.length - faltan.length,
    faltan: faltan.map((c) => c.nombre),
  };
  anexar(path.join(DIR_DATOS, "arranques.jsonl"), registro);
  auditar("verificacion_arranque", "agente", faltan.length ? "incompleto" : "ok",
    faltan.length ? faltan.map((c) => c.nombre).join(", ") : `${contenedores.length} servicios`);

  if (!faltan.length) {
    latidos.registrar("verificacion_arranque", { ok: true }, "agente");
  }

  if (faltan.length) {
    for (const c of faltan) await sh(`docker start ${c.nombre}`, 30000);
    await new Promise((r) => setTimeout(r, 20000));
    cache.delete("contenedores");
    const segundos = (await leerContenedores()).filter((c) => c.estado !== "running");
    latidos.registrar("verificacion_arranque",
      { ok: segundos.length === 0, detalle: segundos.length ? `no volvieron: ${segundos.map((c) => c.nombre).join(", ")}` : "" },
      "agente");
    const modoArr = kapsoYModo.obtenerModo(leerJson, F_MODO);
    if (kapsoYModo.debeSilenciar("crit", modoArr, { autoRemediable: segundos.length === 0 })) {
      auditar("aviso_silenciado_modo_viaje", "agente", "silenciado", "verificacion de arranque");
      return;
    }
    await enviarWhatsapp(
      `Zeus se reinició y algo no volvió solo\n\n` +
      `No arrancaron: ${faltan.map((c) => c.descripcion).join(", ")}\n` +
      (segundos.length ? `Sigue sin arrancar: ${segundos.map((c) => c.nombre).join(", ")}. Necesita revisión.` : `Los levanté y ya responden.`) +
      `\n\npanel.ejemplo.com`
    );
  }
}

// ── Configuración propia de este módulo ─────────────────────────────────────
// GEMINI_API_KEY debe existir en /opt/zeus-ops/.env (el mismo archivo que ya
// lee `leerEnv` al inicio de ops-server.js). Es una variable NUEVA para ese
// archivo — no confundir con la que usa el bot en su propio .env.
// `env` y `DIR_DATOS` son las variables que ya existen arriba en ops-server.js;
// aquí solo se referencian, no se redeclaran.
const GEMINI_MODEL = "gemini-2.5-flash";
// Gemini gratis rechaza llamadas directas desde la IP del servidor de Linode
// ("User location is not supported"); se reenvía a través del Worker de
// Cloudflare (cloudflare-worker), que sí tiene acceso y guarda la llave real.
const GEMINI_URL = `${env.VIGILANTE_URL || "https://vigilante-zeus.TU-CUENTA.workers.dev"}/gemini-proxy?modelo=${GEMINI_MODEL}`;
const PROXY_SECRETO_GEMINI = env.PROXY_SECRETO_GEMINI || "";
const GEMINI_KEYS = PROXY_SECRETO_GEMINI ? [PROXY_SECRETO_GEMINI] : [];
const RUTA_PERSONA = "/opt/zeus-ops/centinela-persona.md";
// `path` y `DIR_DATOS` ya existen arriba en ops-server.js — no se redeclaran.
const RUTA_GASTO = path.join(DIR_DATOS, "gasto-ia.json"); // /var/lib/zeus-ops/gasto-ia.json
// Subido de 12 a 300 el 12 sept. 2026: ahora hay 5 llaves de Gemini rotando
// en el Worker (antes solo 1), así que el techo real de Google es ~5x más
// alto (~1250/día en total). 300 deja margen amplio para chatear con Centi
// sin acercarse a ese techo, y sigue protegiendo contra un bucle descontrolado.
const LIMITE_CONSULTAS_DIA = 300;

// ── Carga del prompt de sistema ──────────────────────────────────────────────
/**
 * Lee el texto de personalidad/instrucciones de Centinela desde disco en cada
 * llamada (el archivo es pequeño y así un ajuste de texto no requiere
 * reiniciar el servicio). Si no existe, usa un prompt mínimo de respaldo para
 * que el servicio nunca se caiga por falta de ese archivo.
 */
function leerPersonaCentinela() {
  try {
    return fs.readFileSync(RUTA_PERSONA, "utf8");
  } catch (_) {
    return (
      "Eres Centinela, el asistente que vigila el servidor de este negocio. " +
      "Responde en español de Colombia, de forma clara, breve y sin tecnicismos innecesarios."
    );
  }
}

// ── Control de gasto: máximo N consultas al modelo por día ─────────────────
/**
 * Lleva la cuenta de cuántas veces se consultó a Gemini hoy (hora del
 * servidor, que corre en UTC). Se reinicia solo al cambiar la fecha.
 * Se guarda en disco para sobrevivir a un reinicio del proceso.
 */
function leerGastoIA() {
  return leerJson(RUTA_GASTO, { fecha: "", consultas: 0 });
}

function guardarGastoIA(g) {
  guardarJson(RUTA_GASTO, g);
}

/** Devuelve { permitido, restantes } y, si permite la consulta, ya suma el contador. */
function registrarConsultaIA() {
  if (!permisos.permitido("ia", "escritura")) {
    return { permitido: false, restantes: 0, motivo: "IA desactivada en Permisos" };
  }
  const hoy = new Date().toISOString().slice(0, 10);
  let g = leerGastoIA();
  if (g.fecha !== hoy) g = { fecha: hoy, consultas: 0 };

  if (g.consultas >= LIMITE_CONSULTAS_DIA) {
    return { permitido: false, restantes: 0 };
  }
  g.consultas += 1;
  guardarGastoIA(g);
  return { permitido: true, restantes: LIMITE_CONSULTAS_DIA - g.consultas };
}

// ── Llamada a Gemini ─────────────────────────────────────────────────────────
/**
 * Consulta a Gemini con el prompt de sistema, un bloque de contexto (el
 * estado del servidor ya armado por quien llama, como JSON) y la pregunta
 * del dueño. Nunca lanza: ante cualquier falla devuelve un texto de repuesto
 * claro para que el dueño no vea un error técnico por WhatsApp.
 */
async function preguntarAGemini(systemPrompt, contexto, pregunta, opciones = {}) {
  if (!GEMINI_KEYS.length) {
    return "No pude consultar el servidor ahora mismo (falta configurar la llave de IA).";
  }
  const maxOutputTokens = Number(opciones.maxOutputTokens) > 0 ? Number(opciones.maxOutputTokens) : 1500;

  const cuerpo = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [
      {
        role: "user",
        parts: [
          {
            text:
              `Este es el estado actual del servidor, en JSON:\n\n${JSON.stringify(contexto)}\n\n` +
              `Pregunta del dueño del negocio:\n${pregunta}`,
          },
        ],
      },
    ],
    // thinkingBudget: 0 — sin esto, Gemini 2.5 Flash gasta una parte
    // impredecible de maxOutputTokens en "pensar" antes de escribir la
    // respuesta visible, así que el corte a media frase pasaba SIN IMPORTAR
    // qué tan alto se subiera maxOutputTokens (probado con 300/500/700/900/
    // 1100/1200, todos se cortaban igual). Este uso no necesita razonamiento
    // extendido: es explicar en español, no resolver un problema complejo.
    generationConfig: { temperature: 0.3, maxOutputTokens, thinkingConfig: { thinkingBudget: 0 } },
  };

  // Prueba cada llave en orden. Una llave se salta a la siguiente solo ante
  // errores típicos de cuota agotada o límite de velocidad (429) o de llave
  // inválida/vencida (400/403); cualquier otro error corta el intento, para
  // no quemar las siete llaves por un problema que no se va a resolver rotando.
  let ultimoError = "";
  for (let i = 0; i < GEMINI_KEYS.length; i++) {
    const llave = GEMINI_KEYS[i];
    const controlador = new AbortController();
    const vencido = setTimeout(() => controlador.abort(), 20000);
    try {
      const res = await fetch(GEMINI_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Proxy-Secreto": llave },
        body: JSON.stringify(cuerpo),
        signal: controlador.signal,
      });
      clearTimeout(vencido);

      if (!res.ok) {
        ultimoError = `HTTP ${res.status}`;
        if ((res.status === 429 || res.status === 400 || res.status === 403) && i < GEMINI_KEYS.length - 1) {
          auditar("centinela_ia_rotacion", "agente", "siguiente_llave", `llave ${i + 1} de ${GEMINI_KEYS.length}: ${ultimoError}`);
          continue;
        }
        auditar("centinela_ia_error", "agente", "falló", ultimoError);
        return "No pude consultar el servidor ahora mismo. Intenta de nuevo en un momento.";
      }

      const data = await res.json();
      const texto = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("").trim();
      if (!texto) {
        auditar("centinela_ia_error", "agente", "vacío", "Gemini no devolvió texto");
        return "No pude consultar el servidor ahora mismo. Intenta de nuevo en un momento.";
      }
      if (data?.candidates?.[0]?.finishReason === "MAX_TOKENS") {
        return texto + "\n\n…(me quedé sin espacio; pregúntame lo que falta por separado)";
      }
      return texto;
    } catch (e) {
      clearTimeout(vencido);
      ultimoError = e.message;
      if (i < GEMINI_KEYS.length - 1) {
        auditar("centinela_ia_rotacion", "agente", "siguiente_llave", `llave ${i + 1} de ${GEMINI_KEYS.length}: ${ultimoError}`);
        continue;
      }
    }
  }
  auditar("centinela_ia_error", "agente", "excepción", ultimoError);
  return "No pude consultar el servidor ahora mismo. Revisa tu conexión o intenta más tarde.";
}

// ── Contexto completo del servidor (mismo dato para preguntas y auditoría) ──
/** Arma el bloque de contexto reutilizando las funciones ya existentes. */
async function armarContextoCentinela() {
  const [estado, pred, seguridad, respaldos] = await Promise.all([
    estadoGeneral(),
    prediccion(),
    estadoSeguridad(),
    estadoRespaldos(),
  ]);
  return {
    memoria: estado.ram,
    disco: estado.disco,
    servicios: { total: estado.servicios.total, arriba: estado.servicios.arriba, avisos: estado.avisos },
    prediccion: { riesgo: pred.riesgo, nivel: pred.nivel, resumen: pred.resumen, pronosticos: pred.pronosticos },
    seguridad: { puntaje: seguridad.puntaje, checklist: seguridad.checklist, baneos: seguridad.baneos },
    respaldos: { ultimo: respaldos.ultimo, drive: respaldos.drive, total: respaldos.total },
    memoria_incidentes: memoriaIncidentes.resumenParaContexto(),
    ts: new Date().toISOString(),
  };
}

// ── Endpoint: POST /api/centinela/preguntar ─────────────────────────────────
/**
 * Maneja la pregunta del dueño enviada desde el bot de WhatsApp.
 * Devuelve siempre { ok, respuesta } (o { ok:false, mensaje } en error de
 * formato), nunca deja la petición colgada.
 */
async function manejarPreguntaCentinela(req, res) {
  let cuerpo = "", excedido = false;
  req.on("data", (c) => {
    cuerpo += c;
    if (cuerpo.length > 4096 && !excedido) {
      excedido = true;
      json(res, { ok: false, mensaje: "La petición es demasiado grande" }, 413);
      req.destroy();
    }
  });
  req.on("end", async () => {
    if (excedido) return;
    let datos;
    try {
      datos = JSON.parse(cuerpo || "{}");
    } catch (_) {
      return json(res, { ok: false, mensaje: "El contenido enviado no es válido" }, 400);
    }
    const pregunta = String(datos.pregunta || "").trim().slice(0, 1000);
    if (!pregunta) return json(res, { ok: false, mensaje: "Falta la pregunta" }, 400);

    // El intérprete decide por dentro si hace falta la IA: el menú numerado y
    // las preguntas con respuesta directa no gastan ninguna de las 12 del día.
    try {
      const r = await comandosCentinela.manejar(pregunta);
      return json(res, { ok: true, respuesta: r.respuesta });
    } catch (e) {
      auditar("centinela_pregunta", "bot", "error", e.message);
      return json(res, { ok: true, respuesta: "No pude consultar el servidor ahora mismo. Intenta de nuevo en un momento." });
    }
  });
}

// ── Auditoría diaria a las 7:00 a.m. hora de Colombia (12:00 UTC) ──────────
const HORA_CENTINELA_UTC = 12; // 07:00 en Colombia
let ultimaAuditoriaCentinela = "";

/**
 * Sigue EXACTAMENTE el mismo patrón de disparo que `quizaResumenDiario`:
 * se llama una vez por minuto desde un setInterval y decide sola si ya le
 * toca correr hoy, comparando la fecha guardada en memoria.
 */
async function quizaAuditoriaDiariaCentinela() {
  const ahora = new Date();
  const hoy = ahora.toISOString().slice(0, 10);
  if (ahora.getUTCHours() !== HORA_CENTINELA_UTC || ultimaAuditoriaCentinela === hoy) return;
  ultimaAuditoriaCentinela = hoy;
  // Primero la auditoría de seguridad completa (8 revisiones, con evidencia
  // guardada), y SOLO DESPUÉS el resumen por WhatsApp — así, si algo urgente
  // apareció, el resumen del dueño ya puede reflejarlo.
  try {
    const r = await seguridadCompleta.ejecutar("agente");
    if (r.ok && r.resumen.urgentes > 0) {
      const urgentes = r.resumen.hallazgos.filter((h) => h.severidad === "urgente");
      await enviarWhatsapp(
        `La auditoría diaria de seguridad encontró ${urgentes.length} cosa(s) urgente(s)\n\n` +
        urgentes.map((h) => `• ${h.titulo}: ${h.significado}`).join("\n") +
        `\n\npanel.ejemplo.com/seguridad`
      ).catch(() => {});
    }
  } catch (e) {
    auditar("auditoria_completa_diaria", "agente", "error", e.message);
  }
  await auditoriaDiaria7am();
  latidos.registrar("auditoria_seguridad", { ok: true }, "agente");
}

/**
 * Arma el contexto completo, le pide a Gemini un resumen siguiendo el
 * formato de centinela-persona.md, y lo envía por WhatsApp con la función
 * ya existente `enviarWhatsapp(texto)`. No cuenta contra el límite de 12
 * consultas del dueño: es una sola consulta programada al día.
 */
async function auditoriaDiaria7am() {
  try {
    const contexto = await armarContextoCentinela();
    const persona = leerPersonaCentinela();
    const instruccion =
      "Genera el resumen diario de auditoría del servidor para enviar por WhatsApp al dueño del negocio, " +
      "siguiendo exactamente el formato y tono descritos en tus instrucciones de sistema. " +
      "Sé breve y concreto: esto se lee desde el celular.";
    const resumen = await preguntarAGemini(persona, contexto, instruccion);

    const r = await enviarWhatsapp(resumen);
    auditar("centinela_auditoria_diaria", "agente", r.ok ? "enviado" : "falló", r.detalle || "");
  } catch (e) {
    auditar("centinela_auditoria_diaria", "agente", "error", e.message);
  }
}

// ── Resiliencia, runbooks, observación de despliegue y config drift ─────────
// Se instancian aquí porque necesitan funciones que se declaran más arriba,
// incluidas las del bloque de Centinela (preguntarAGemini, armarContexto...).
const { crearResiliencia } = require("./modulos/resiliencia.js");
const { crearRunbooks } = require("./modulos/runbooks.js");
const { crearObservacionDespliegue } = require("./modulos/observacion-despliegue.js");
const { crearConfigDrift } = require("./modulos/config-drift.js");

const resiliencia = crearResiliencia({
  sh, auditar, enviarWhatsapp,
  DIR_DATOS, leerJson, guardarJson,
  leerCpu, prediccion, preguntarAGemini, armarContextoCentinela,
  registrarConsultaIA,
  leerHistorialRam: (horas) => {
    const desde = Math.floor(Date.now() / 1000) - horas * 3600;
    return leerJsonl(F_HIST, 43200).filter((h) => h.t > desde).map((h) => ({ t: h.t, ram: h.ram }));
  },
});

const runbooks = crearRunbooks({});
{
  const chequeo = runbooks.validar([
    "reiniciar_contenedor", "optimizar", "respaldar", "enviar_wsp",
    "desbanear", "actualizar_seguridad", "reiniciar_servidor", "limpiar_docker",
  ]);
  if (!chequeo.ok) console.error("[runbooks] desincronizados:", chequeo.problemas);
}

const observacionDespliegue = crearObservacionDespliegue({
  sh, auditar, enviarWhatsapp, leerContenedores,
  DIR_DATOS, leerJson, guardarJson,
});

const configDrift = crearConfigDrift({ DIR_DATOS, leerJson, guardarJson });

const { crearSeguridadCompleta, repararPermisoArchivo } = require("./modulos/seguridad-completa.js");
const { explicarHallazgo } = require("./modulos/explicador-hallazgos.js");
const seguridadCompleta = crearSeguridadCompleta({ sh, DIR_DATOS, leerJson, guardarJson, auditar });

// Auditoría completa de la base de datos (sección Optimización): solo lee,
// nunca aplica nada. Recibe mysql() y estadoDatos() de este archivo.
const { crearOptimizacionCompleta } = require("./modulos/optimizacion-completa.js");
const optimizacionCompleta = crearOptimizacionCompleta({ esquema: ESQUEMA, sh, mysql, DIR_DATOS, leerJson, guardarJson, auditar, estadoDatos });

const { crearReglasSeguridad } = require("./modulos/reglas-seguridad.js");
const reglasSeguridad = crearReglasSeguridad({ DIR_DATOS, leerJson, guardarJson, auditar });
const { crearPermisos } = require("./modulos/permisos.js");
const permisos = crearPermisos({ DIR_DATOS, leerJson, guardarJson, auditar });

// Latido de cada tarea programada: cada una avisa "terminé" y esto revisa
// cada 10 min si a alguna le tocaba y no llegó (dead man's switch). El
// respaldo estuvo 3 meses sin correr sin que nadie se enterara — esto lo
// generaliza a las demás tareas del calendario.
// (Solo se necesitan los `require` aquí para leer TAREA_LATIDO de cada uno;
// las instancias de verdad — auditoria360, vigia — se construyen más abajo,
// una vez que sos/seguridadCompleta/etc. ya existen.)
const latidosMod = require("./modulos/latidos.js");
const auditoria360Mod = require("./modulos/auditoria360.js");
const vigiaMod = require("./modulos/vigia-tendencias.js");
const latidos = latidosMod.crearLatidos({
  DIR_DATOS, leerJson, guardarJson, auditar,
  enviarWhatsapp, permisos, kapsoYModo, F_MODO,
  tareas: [...latidosMod.TAREAS, auditoria360Mod.TAREA_LATIDO, vigiaMod.TAREA_LATIDO],
});

// Informe semanal para el dueño: junta caídas, SOS, mensajes del bot,
// proyección de disco/memoria y auditorías de seguridad de los últimos 7
// días. Solo lee (reusa prediccion() tal cual, no la reimplementa).
const informeSemanalMod = require("./modulos/informe-semanal.js");
const informeSemanal = informeSemanalMod.crearInformeSemanal({
  DIR_DATOS, leerJson, leerJsonl, guardarJson, anexar, auditar,
  enviarWhatsapp, prediccion, permisos, kapsoYModo, F_MODO, sh, latidos,
});

// Detector de "bot mudo": el bot puede estar corriendo y aun así no
// responderle a ningún cliente (pasó en producción el 12-sep-2026, modelos
// de OpenRouter retirados). Complementa, no duplica, al detector de
// incidentes de contenedores — ese mira si el bot está vivo, este mira si
// contesta.
const botMudoMod = require("./modulos/bot-mudo.js");
const botMudo = botMudoMod.crearBotMudo({
  DIR_DATOS, leerJson, guardarJson, auditar, enviarWhatsapp, sh,
  permisos, kapsoYModo, F_MODO, reglasSeguridad,
});

// Escalada de avisos críticos con acuse: si un aviso grave (SOS sin resolver,
// bot caído >10 min) no se confirma con /centinela ok en 15 min, se reenvía
// al número del técnico (si hay uno configurado) cada 30 min, hasta 3 veces.
const escalamientoMod = require("./modulos/escalamiento.js");
const escalamiento = escalamientoMod.crearEscalamiento({
  DIR_DATOS, leerJson, leerJsonl, guardarJson, auditar,
  enviarWhatsapp, enviarWhatsappA,
  permisos, kapsoYModo, F_MODO, WSP_DESTINO,
});

// Memoria de incidentes: resumen acotado de sos-corridas.jsonl (qué síntoma,
// qué acción, si se restableció) para dar contexto real a la IA de /centinela
// y para sugerir (nunca ejecutar) una guía paso a paso cuando el SOS se rinde.
const memoriaMod = require("./modulos/memoria-incidentes.js");
const memoriaIncidentes = memoriaMod.crearMemoriaIncidentes({
  DIR_DATOS, leerJson, guardarJson, leerJsonl, auditar, enviarWhatsapp,
  runbooks, textos: require("./modulos/sos/textos.js"),
  permisos, kapsoYModo, F_MODO,
});

// ── SOS: el protocolo de emergencia completo ────────────────────────────────
const { crearSos } = require("./modulos/sos/sos.js");

const sos = crearSos({
  sh, auditar, enviarWhatsapp, leerContenedores, leerMemoria, leerCpu, leerDisco,
  mysql, cache, DIR_DATOS, env, leerJson, guardarJson, leerJsonl, anexar,
  baseIncidentes, F_AUDIT, F_HIST, F_MODO,
  simulacros, observacionDespliegue, resiliencia, dbProcesos, kapsoYModo,
  preguntarAGemini, registrarConsultaIA, leerGastoIA,
  HORA_REINICIO_UTC, HORA_RESPALDO_UTC: 8,
  reiniciarEnOrden: contenedores.reiniciarEnOrden,
  porQueSeCayo: contenedores.porQueSeCayo,
  reglasSeguridad, permisos,
  alCerrarCorrida: memoriaIncidentes.registrarCorrida,
});

// Auditoría 360: orquesta en una sola corrida lo que ya existe por separado
// (seguridad, base de datos, config drift, capacidad, servicios, respaldos,
// tareas), consolida un puntaje y aplica sola la única acción reversible ya
// permitida (liberar disco), siempre pasando por el mismo puedeActuar().
const auditoria360 = auditoria360Mod.crearAuditoria360({
  sh, auditar, enviarWhatsapp, DIR_DATOS, leerJson, guardarJson, leerJsonl, anexar,
  estadoGeneral, prediccion, estadoRespaldos, leerDisco, ejecutarAccion,
  seguridadCompleta, optimizacionCompleta, configDrift, latidos, sos, simulacros,
  observacionDespliegue, reglasSeguridad, permisos, kapsoYModo, F_MODO,
  seguridadAuditoria, HORA_REINICIO_UTC, HORA_RESPALDO_UTC: 8,
});

// Vigía de tendencias: una vez al día, reglas deterministas sobre lo que ya
// se guarda (proyección de disco/memoria, p95 de CPU/carga, reinicios por
// contenedor). Si ninguna dispara, no llama a la IA ni avisa nada.
const vigia = vigiaMod.crearVigia({
  DIR_DATOS, leerJson, guardarJson, anexar, leerJsonl, auditar, enviarWhatsapp,
  prediccion, estadoGeneral, F_HIST, F_AUDIT, HORA_REINICIO_UTC,
  preguntarAGemini, registrarConsultaIA, leerPersonaCentinela,
  permisos, kapsoYModo, F_MODO, latidos,
  contenedoresPropios: Array.from(CONTENEDORES_PROPIOS),
});

// ── Intérprete del menú de WhatsApp ─────────────────────────────────────────
const { crearComandosCentinela } = require("./modulos/centinela-comandos.js");
const textosSos = require("./modulos/sos/textos.js");

const comandosCentinela = crearComandosCentinela({
  DIR_DATOS, leerJson, guardarJson, auditar, enviarWhatsapp,
  estadoGeneral, prediccion, estadoRespaldos, estadoDatos, estadoSeguridad,
  ejecutarAccion, baseIncidentes, textoResumen, historialReinicios,
  kapsoYModo, F_MODO,
  preguntarAGemini, armarContextoCentinela, registrarConsultaIA, leerPersonaCentinela,
  sos, textos: textosSos, simulacros,
  LIMITE_CONSULTAS_DIA,
  escalamiento,
  vigia,
  botMudo, seguridadAuditoria, sh, dbProcesos, mysql,
  observacionDespliegue, memoriaIncidentes, leerJsonl, F_HIST,
  CONTENEDORES_PROPIOS,
});

// ── Vigilante por eventos de Docker (sin consultar cada rato) ────────────────
function escucharDocker() {
  const p = spawn("/usr/bin/docker", ["events", "--filter", "type=container", "--format", "{{.Actor.Attributes.name}};{{.Action}}"]);
  p.stdout.on("data", (buf) => {
    for (const l of buf.toString().split("\n").filter(Boolean)) {
      const [nombre, accion] = l.split(";");
      if (/^(die|kill|oom|stop)$/.test(accion) || /unhealthy/.test(accion)) {
        auditar("evento_docker", "agente", accion, nombre);
        cache.delete("contenedores");
        setTimeout(() => leerContenedores().then(revisarIncidentes).catch(() => {}), 2000);
      }
    }
  });
  p.on("close", () => setTimeout(escucharDocker, 10000)); // se vuelve a enganchar solo
}

// ── Servidor HTTP ───────────────────────────────────────────────────────────
function json(res, obj, code = 200) {
  const cuerpo = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(cuerpo);
}

/** Defensa contra peticiones hechas desde otra web. El navegador adjunta solo
 * la contraseña del panel automáticamente, pero NO esta cabecera, así que
 * exigirla (más comprobar el origen) impide que una página ajena dispare una
 * acción en nombre del dueño. */
function csrfOk(req) {
  const origen = req.headers.origin || "";
  const propio = req.headers["x-panel-zeus"] === "1";
  return propio && (!origen || esOrigenPermitido(origen));
}

/** Lee el cuerpo JSON de un POST con tope de tamaño y errores claros, y llama
 * a `alTener(datos)` solo si llegó entero y es válido. */
function leerCuerpo(req, res, alTener) {
  let cuerpo = "", excedido = false;
  req.on("data", (c) => {
    cuerpo += c;
    if (cuerpo.length > 4096 && !excedido) {
      excedido = true;
      json(res, { ok: false, mensaje: "La petición es demasiado grande" }, 413);
      req.destroy();
    }
  });
  req.on("end", async () => {
    if (excedido) return;
    let datos;
    try { datos = JSON.parse(cuerpo || "{}"); }
    catch (_) { return json(res, { ok: false, mensaje: "El contenido enviado no es válido" }, 400); }
    try { await alTener(datos); }
    catch (e) { json(res, { ok: false, mensaje: "No se pudo completar la operación" }, 500); }
  });
}

// Secciones con URL amigable propia (panel.ejemplo.com/simulacros, etc.) —
// el panel es de una sola página, así que estas rutas no son archivos reales:
// se sirve siempre index.html y el navegador (app.js) abre la sección correcta.
const VISTAS_URL_AMIGABLE = new Set([
  "sos", "historial", "registros", "copias", "contenedores", "seguridad",
  "optimizacion", "limpieza", "tecnico", "simulacros", "ajustes", "permisos",
]);

function servirEstatico(res, ruta) {
  let archivo = ruta === "/" ? "index.html" : ruta.replace(/^\//, "").replace(/\.\./g, "");
  if (VISTAS_URL_AMIGABLE.has(archivo)) archivo = "index.html";
  const completo = path.join(PUBLICO, archivo);
  if (!completo.startsWith(PUBLICO) || !fs.existsSync(completo)) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    return res.end("No encontrado");
  }
  const tipo = completo.endsWith(".html") ? "text/html; charset=utf-8"
    : completo.endsWith(".js") ? "application/javascript"
    : completo.endsWith(".css") ? "text/css" : "application/octet-stream";
  res.writeHead(200, { "Content-Type": tipo, "Cache-Control": "no-cache" });
  res.end(fs.readFileSync(completo));
}

const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://local");
  const ruta = url.pathname;

  try {
    if (ruta === "/health") return json(res, { ok: true, servicio: "zeus-ops", ts: new Date().toISOString() });

    if (ruta === "/api/estado") return json(res, await estadoGeneral());
    if (ruta === "/api/prediccion") return json(res, await prediccion());
    if (ruta === "/api/series") return json(res, await serie(url.searchParams.get("rango") || "24h"));
    if (ruta === "/api/incidentes") return json(res, baseIncidentes());
    if (ruta === "/api/reinicios") return json(res, await historialReinicios());
    if (ruta === "/api/respaldos") return json(res, await estadoRespaldos());

    if (ruta === "/api/respaldos/prueba-restauracion") {
      return json(res, await cacheado("prueba_restauracion", 300, async () => {
        const RUTA = "/opt/zeus-app/backups/.last_test_restauracion.json";
        try {
          return { existe: true, ...JSON.parse(fs.readFileSync(RUTA, "utf8")) };
        } catch (_) {
          return { existe: false, mensaje: "Todavía no se ha corrido ninguna prueba de restauración. La primera corre el domingo a las 5:00 a.m." };
        }
      }));
    }
    if (ruta === "/api/datos") return json(res, await estadoDatos());
    if (ruta === "/api/seguridad") return json(res, await estadoSeguridad());
    if (ruta === "/api/optimizacion") {
      return json(res, await cacheado("optimizacion", 120, async () => {
        const datos = await estadoDatos();
        // Sobre una vista (vw_*) no se puede ADD INDEX — sin esto, "Aplicar"
        // fallaba siempre para esas sugerencias sin decir por qué.
        const vistasR = await mysql("SELECT table_name FROM information_schema.views WHERE table_schema='" + ESQUEMA + "';");
        const vistas = (vistasR.ok ? vistasR.salida : "").split("\n").filter(Boolean);
        // Columna líder de cada índice existente por tabla — sin esto,
        // "Aplicar" podía ofrecer un índice que ya existe en la práctica
        // (bug real, encontrado probando en vivo el 14-sep-2026).
        const indicesR = await mysql(
          "SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.STATISTICS " +
          "WHERE TABLE_SCHEMA='" + ESQUEMA + "' AND SEQ_IN_INDEX=1;"
        );
        const columnasIndexadas = {};
        for (const linea of (indicesR.ok ? indicesR.salida : "").split("\n")) {
          if (!linea) continue;
          const [tabla, columna] = linea.split("\t");
          if (!tabla || !columna) continue;
          if (!columnasIndexadas[tabla]) columnasIndexadas[tabla] = new Set();
          columnasIndexadas[tabla].add(columna);
        }
        const sugerencias = dbOptimizacion.analizarPatrones(datos.consultas_lentas, vistas, columnasIndexadas);
        return {
          sugerencias,
          resumen: dbOptimizacion.resumenParaAuditoria(sugerencias),
          generado: new Date().toISOString(),
        };
      }));
    }

    if (ruta === "/api/seguridad/completa") {
      return json(res, await cacheado("seguridad_completa", 300, async () => {
        // Si hay un simulacro o un despliegue en curso, un cambio de
        // configuración es esperado: no hay que alarmar por él.
        const enVentanaExcluida = !!(observacionDespliegue.estado().en_curso || simulacros.estado().en_curso);
        const [base, drift] = await Promise.all([
          seguridadAuditoria.auditoriaCompleta(sh),
          configDrift.revisarDrift(sh, { enVentanaExcluida }),
        ]);
        base.hallazgos = [...base.hallazgos, drift];
        return base;
      }));
    }

    // ── Informe semanal para el dueño ───────────────────────────────────────
    if (ruta === "/api/informe-semanal" && req.method === "GET") {
      const datos = await informeSemanal.armarDatosInforme();
      if (url.searchParams.get("formato") === "texto") {
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        return res.end(informeSemanal.textoInforme(datos));
      }
      return json(res, { ...datos, texto: informeSemanal.textoInforme(datos), envio: informeSemanal.estadoEnvio() });
    }
    if (ruta === "/api/informe-semanal/enviar" && req.method === "POST") {
      if (!csrfOk(req)) return json(res, { ok: false, mensaje: "Petición rechazada por seguridad" }, 403);
      const r = await informeSemanal.enviarInformeSemanal("panel");
      return json(res, r, r.ok ? 200 : 400);
    }
    if (ruta === "/api/informe-semanal/foto" && req.method === "POST") {
      if (!csrfOk(req)) return json(res, { ok: false, mensaje: "Petición rechazada por seguridad" }, 403);
      const registro = await informeSemanal.fotoDiariaMensajes();
      return json(res, registro);
    }

    // ── Escalada de avisos críticos con acuse ───────────────────────────────
    if (ruta === "/api/escalamiento" && req.method === "GET") {
      return json(res, escalamiento.estado());
    }
    if (ruta === "/api/escalamiento/config" && req.method === "GET") {
      return json(res, { ok: true, ...escalamiento.leerConfig() });
    }
    if (ruta === "/api/escalamiento/config" && req.method === "POST") {
      if (!csrfOk(req)) return json(res, { ok: false, mensaje: "Petición rechazada por seguridad" }, 403);
      return leerCuerpo(req, res, async (datos) => {
        const r = escalamiento.guardarConfig(datos, "panel");
        return json(res, r, r.ok ? 200 : 400);
      });
    }
    if (ruta === "/api/escalamiento/acusar" && req.method === "POST") {
      if (!csrfOk(req)) return json(res, { ok: false, mensaje: "Petición rechazada por seguridad" }, 403);
      return json(res, escalamiento.acusar("panel"));
    }
    if (ruta === "/api/escalamiento/abrir" && req.method === "POST") {
      if (!csrfOk(req)) return json(res, { ok: false, mensaje: "Petición rechazada por seguridad" }, 403);
      return leerCuerpo(req, res, async (datos) => {
        const texto = String(datos.texto || "").trim().slice(0, 500);
        if (!texto) return json(res, { ok: false, mensaje: "Falta el texto" }, 400);
        const clave = `manual:prueba-${Math.floor(Date.now() / 1000)}`;
        const r = await escalamiento.abrir(clave, texto);
        return json(res, r);
      });
    }

    // ── Detector de bot mudo ─────────────────────────────────────────────────
    if (ruta === "/api/bot-mudo" && req.method === "GET") {
      return json(res, botMudo.estado());
    }
    if (ruta === "/api/bot-mudo/revisar" && req.method === "POST") {
      if (!csrfOk(req)) return json(res, { ok: false, mensaje: "Petición rechazada por seguridad" }, 403);
      const r = await botMudo.revisar("panel");
      return json(res, { ...r, estado: botMudo.estado() });
    }

    // ── Tareas programadas (latidos) ────────────────────────────────────────
    if (ruta === "/api/latidos" && req.method === "GET") {
      return json(res, latidos.estadoLatidos());
    }
    if (ruta === "/api/latidos/revisar" && req.method === "POST") {
      if (!csrfOk(req)) return json(res, { ok: false, mensaje: "Petición rechazada por seguridad" }, 403);
      const r = await latidos.revisar();
      return json(res, r);
    }
    if (ruta.startsWith("/api/latidos/") && ruta !== "/api/latidos/revisar" && req.method === "POST") {
      if (!csrfOk(req)) return json(res, { ok: false, mensaje: "Petición rechazada por seguridad" }, 403);
      const id = decodeURIComponent(ruta.slice("/api/latidos/".length));
      return leerCuerpo(req, res, async (datos) => {
        const r = latidos.registrar(id, datos, "cron");
        if (!r.ok && r.motivo === "tarea_desconocida") return json(res, r, 404);
        if (!r.ok) return json(res, r, 400);
        return json(res, r, 200);
      });
    }

    // ── Auditoría 360: orquesta seguridad + optimización + config drift +
    // capacidad + servicios + respaldos + tareas en una sola corrida ───────
    if (ruta === "/api/auditoria360") return json(res, auditoria360.estado());
    if (ruta === "/api/auditoria360/historial") return json(res, { corridas: auditoria360.historial() });

    if (ruta === "/api/auditoria360/ejecutar" && req.method === "POST") {
      if (!csrfOk(req)) return json(res, { ok: false, mensaje: "Petición rechazada por seguridad" }, 403);
      const r = await auditoria360.ejecutar("panel");
      return json(res, r, r.code || (r.ok ? 200 : 400));
    }

    if (ruta === "/api/auditoria360/vivo" && req.method === "GET") {
      const runId = url.searchParams.get("run") || "";
      const desdeCrudo = url.searchParams.get("desde");
      const desde = desdeCrudo === null ? NaN : Number(desdeCrudo);
      const ok = auditoria360.vivo(runId, res, Number.isFinite(desde) ? desde : undefined);
      if (!ok) return json(res, { ok: false, mensaje: "No se encontró esa corrida" }, 404);
      return;
    }

    // ── Vigía de tendencias ─────────────────────────────────────────────────
    if (ruta === "/api/vigia") return json(res, vigia.estado());

    if (ruta === "/api/vigia/revisar" && req.method === "POST") {
      if (!csrfOk(req)) return json(res, { ok: false, mensaje: "Petición rechazada por seguridad" }, 403);
      return json(res, await vigia.revisar("panel"));
    }

    if (ruta === "/api/vigia/feedback" && req.method === "POST") {
      if (!csrfOk(req)) return json(res, { ok: false, mensaje: "Petición rechazada por seguridad" }, 403);
      return leerCuerpo(req, res, async (datos) => {
        const r = vigia.registrarFeedback(String(datos.valor || ""), "panel");
        json(res, r, r.ok ? 200 : 400);
      });
    }

    // ── Memoria de incidentes ────────────────────────────────────────────────
    if (ruta === "/api/memoria-incidentes") return json(res, memoriaIncidentes.estado());

    // ── Auditoría de seguridad completa (con consola en vivo) ──────────────
    if (ruta === "/api/seguridad/auditoria/ultima") return json(res, seguridadCompleta.ultima());
    if (ruta === "/api/seguridad/auditoria/historial") return json(res, { corridas: seguridadCompleta.historial() });
    if (ruta === "/api/seguridad/auditoria/estado") return json(res, seguridadCompleta.estado());

    if (ruta === "/api/seguridad/auditoria/ejecutar" && req.method === "POST") {
      if (!csrfOk(req)) return json(res, { ok: false, mensaje: "Petición rechazada por seguridad" }, 403);
      const r = await seguridadCompleta.ejecutar("panel");
      return json(res, r, r.code || (r.ok ? 200 : 400));
    }

    if (ruta === "/api/seguridad/auditoria/vivo" && req.method === "GET") {
      const runId = url.searchParams.get("run") || "";
      const desde = Number(url.searchParams.get("desde"));
      const ok = seguridadCompleta.vivo(runId, res, Number.isFinite(desde) ? desde : undefined);
      if (!ok) return json(res, { ok: false, mensaje: "No se encontró esa corrida" }, 404);
      return;
    }

    // ── Auditoría completa de la base de datos (Optimización, con consola en vivo) ──
    if (ruta === "/api/optimizacion/auditoria/ultima") return json(res, optimizacionCompleta.ultima());
    if (ruta === "/api/optimizacion/auditoria/historial") return json(res, { corridas: optimizacionCompleta.historial() });
    if (ruta === "/api/optimizacion/auditoria/estado") return json(res, optimizacionCompleta.estado());

    if (ruta === "/api/optimizacion/auditoria/ejecutar" && req.method === "POST") {
      if (!csrfOk(req)) return json(res, { ok: false, mensaje: "Petición rechazada por seguridad" }, 403);
      const r = await optimizacionCompleta.ejecutar("panel");
      return json(res, r, r.code || (r.ok ? 200 : 400));
    }

    if (ruta === "/api/optimizacion/auditoria/vivo" && req.method === "GET") {
      const runId = url.searchParams.get("run") || "";
      // Sin `?desde=` se reproduce la corrida desde el primer evento (seq 0);
      // Number(null) daría 0 y se saltaría justamente ese primero.
      const desdeCrudo = url.searchParams.get("desde");
      const desde = desdeCrudo === null ? NaN : Number(desdeCrudo);
      const ok = optimizacionCompleta.vivo(runId, res, Number.isFinite(desde) ? desde : undefined);
      if (!ok) return json(res, { ok: false, mensaje: "No se encontró esa corrida" }, 404);
      return;
    }

    // ── Reglas de seguridad (freno de emergencia, horario comercial) ───────
    if (ruta === "/api/reglas") return json(res, reglasSeguridad.estado());

    if (ruta === "/api/reglas/freno" && req.method === "POST") {
      if (!csrfOk(req)) return json(res, { ok: false, mensaje: "Petición rechazada por seguridad" }, 403);
      return leerCuerpo(req, res, async (datos) => {
        const freno = datos.activo
          ? reglasSeguridad.activarFreno("panel", datos.motivo)
          : reglasSeguridad.desactivarFreno("panel");
        json(res, { ok: true, freno });
      });
    }

    if (ruta === "/api/reglas/horario" && req.method === "POST") {
      if (!csrfOk(req)) return json(res, { ok: false, mensaje: "Petición rechazada por seguridad" }, 403);
      return leerCuerpo(req, res, async (datos) => {
        const horario_comercial = reglasSeguridad.configurarHorario(datos.inicio_utc, datos.fin_utc, datos.activo);
        json(res, { ok: true, horario_comercial });
      });
    }

    // ── Permisos por categoría ──────────────────────────────────────────────
    if (ruta === "/api/permisos" && req.method === "POST") {
      if (!csrfOk(req)) return json(res, { ok: false, mensaje: "Petición rechazada por seguridad" }, 403);
      return leerCuerpo(req, res, async (datos) => {
        permisos.guardar(datos.permisos, "panel");
        json(res, { ok: true, categorias: permisos.estado() });
      });
    }
    if (ruta === "/api/permisos") return json(res, { categorias: permisos.estado() });

    if (ruta === "/api/runbooks") {
      return json(res, { runbooks: runbooks.catalogo() });
    }

    if (ruta === "/api/despliegue/observacion") {
      return json(res, observacionDespliegue.estado());
    }

    if (ruta === "/api/despliegue/observar" && req.method === "POST") {
      const origen = req.headers.origin || "";
      const propio = req.headers["x-panel-zeus"] === "1";
      if (!propio || (origen && !esOrigenPermitido(origen))) {
        auditar("despliegue_observar_rechazado", "desconocido", "bloqueada", `origen: ${origen || "sin origen"}`);
        return json(res, { ok: false, mensaje: "Petición rechazada por seguridad" }, 403);
      }
      let cuerpo = "", excedido = false;
      req.on("data", (c) => {
        cuerpo += c;
        if (cuerpo.length > 4096 && !excedido) {
          excedido = true;
          json(res, { ok: false, mensaje: "La petición es demasiado grande" }, 413);
          req.destroy();
        }
      });
      req.on("end", async () => {
        if (excedido) return;
        let datos;
        try { datos = JSON.parse(cuerpo || "{}"); }
        catch (_) { return json(res, { ok: false, mensaje: "El contenido enviado no es válido" }, 400); }
        const fase = String(datos.fase || "");
        if (fase === "baseline") {
          const r = await observacionDespliegue.capturarBaseline();
          return json(res, r, r.ok ? 200 : (r.code || 400));
        }
        if (fase === "iniciar") {
          const r = await observacionDespliegue.observar(datos.minutos);
          return json(res, r, r.ok ? 200 : (r.code || 400));
        }
        return json(res, { ok: false, mensaje: "El contenido enviado no es válido" }, 400);
      });
      return;
    }

    if (ruta === "/api/simulacros") {
      return json(res, simulacros.estado());
    }

    if (ruta === "/api/simulacros/historial") {
      return json(res, simulacros.historial(String(url.searchParams.get("id") || "")));
    }

    if (ruta === "/api/simulacros/vivo" && req.method === "GET") {
      const runId = url.searchParams.get("run") || "";
      const desde = url.searchParams.has("desde") ? parseInt(url.searchParams.get("desde"), 10) : undefined;
      const ok = simulacros.suscribir(runId, res, desde);
      if (!ok) return json(res, { ok: false, mensaje: "No encontré esa corrida" }, 404);
      return; // queda abierta como stream SSE; simulacros.js la gestiona
    }

    if (ruta === "/api/simulacros/lanzar" && req.method === "POST") {
      const origen = req.headers.origin || "";
      const propio = req.headers["x-panel-zeus"] === "1";
      if (!propio || (origen && !esOrigenPermitido(origen))) {
        auditar("simulacro_rechazado", "desconocido", "bloqueada", `origen: ${origen || "sin origen"}`);
        return json(res, { ok: false, mensaje: "Petición rechazada por seguridad" }, 403);
      }
      let cuerpo = "", excedido = false;
      req.on("data", (c) => {
        cuerpo += c;
        if (cuerpo.length > 4096 && !excedido) {
          excedido = true;
          json(res, { ok: false, mensaje: "La petición es demasiado grande" }, 413);
          req.destroy();
        }
      });
      req.on("end", async () => {
        if (excedido) return;
        let datos;
        try { datos = JSON.parse(cuerpo || "{}"); }
        catch (_) { return json(res, { ok: false, mensaje: "El contenido enviado no es válido" }, 400); }
        const chequeoPermiso = permisos.verificarEscritura("simulacros", "Simulacros");
        if (!chequeoPermiso.ok) return json(res, { ok: false, mensaje: chequeoPermiso.mensaje }, 403);
        const r = await simulacros.lanzar(String(datos.id || ""), String(datos.pin || ""), String(datos.confirmacion || ""), "panel");
        json(res, r, r.code || (r.ok ? 200 : 400));
      });
      return;
    }

    if (ruta === "/api/simulacros/abortar" && req.method === "POST") {
      const origen = req.headers.origin || "";
      const propio = req.headers["x-panel-zeus"] === "1";
      if (!propio || (origen && !esOrigenPermitido(origen))) {
        auditar("simulacro_rechazado", "desconocido", "bloqueada", `origen: ${origen || "sin origen"}`);
        return json(res, { ok: false, mensaje: "Petición rechazada por seguridad" }, 403);
      }
      let cuerpo = "", excedido = false;
      req.on("data", (c) => {
        cuerpo += c;
        if (cuerpo.length > 4096 && !excedido) {
          excedido = true;
          json(res, { ok: false, mensaje: "La petición es demasiado grande" }, 413);
          req.destroy();
        }
      });
      req.on("end", async () => {
        if (excedido) return;
        let datos;
        try { datos = JSON.parse(cuerpo || "{}"); }
        catch (_) { return json(res, { ok: false, mensaje: "El contenido enviado no es válido" }, 400); }
        const r = await simulacros.abortar(String(datos.run_id || ""), "panel");
        json(res, r, r.code || (r.ok ? 200 : 400));
      });
      return;
    }

    // ── Contenedores ──────────────────────────────────────────────────────
    if (ruta === "/api/contenedores") {
      return json(res, await contenedores.listar());
    }

    if (ruta === "/api/contenedores/ficha") {
      const r = await contenedores.ficha(String(url.searchParams.get("nombre") || ""));
      return json(res, r, r.ok ? 200 : (r.code || 400));
    }

    if (ruta === "/api/contenedores/operaciones") {
      return json(res, contenedores.operaciones());
    }

    if (ruta === "/api/contenedores/vivo" && req.method === "GET") {
      const runId = url.searchParams.get("run") || "";
      const desde = url.searchParams.has("desde") ? parseInt(url.searchParams.get("desde"), 10) : undefined;
      const ok = contenedores.suscribir(runId, res, desde);
      if (!ok) return json(res, { ok: false, mensaje: "No encontré esa operación" }, 404);
      return;
    }

    if (ruta === "/api/contenedores/registros" && req.method === "GET") {
      const nombre = String(url.searchParams.get("nombre") || "");
      const lineas = url.searchParams.get("lineas") || "200";
      const r = contenedores.registrosEnVivo(nombre, lineas, res, "panel");
      if (!r.ok) return json(res, r, r.code || 400);
      return;
    }

    if (ruta === "/api/contenedores/accion" && req.method === "POST") {
      if (!csrfOk(req)) {
        auditar("contenedor_rechazado", "desconocido", "bloqueada", `origen: ${req.headers.origin || "sin origen"}`);
        return json(res, { ok: false, mensaje: "Petición rechazada por seguridad" }, 403);
      }
      return leerCuerpo(req, res, async (datos) => {
        const r = await contenedores.operar({
          accion: String(datos.accion || ""),
          nombre: String(datos.nombre || ""),
          en_orden: !!datos.en_orden,
          confirmacion: String(datos.confirmacion || ""),
          pin: String(datos.pin || ""),
        }, "panel");
        json(res, r, r.code || (r.ok ? 200 : 400));
      });
    }

    // ── SOS ───────────────────────────────────────────────────────────────
    if (ruta === "/api/sos") return json(res, sos.estado());

    if (ruta === "/api/sos/lanzar" && req.method === "POST") {
      if (!csrfOk(req)) {
        auditar("sos_rechazado", "desconocido", "bloqueada", `origen: ${req.headers.origin || "sin origen"}`);
        return json(res, { ok: false, mensaje: "Petición rechazada por seguridad" }, 403);
      }
      if (simulacros.estado().en_curso) {
        return json(res, { ok: false, mensaje: "Hay un simulacro en curso; espera a que termine." }, 409);
      }
      const r = await sos.lanzar("panel");
      return json(res, r);
    }

    if (ruta === "/api/sos/vivo" && req.method === "GET") {
      const runId = String(url.searchParams.get("run") || "");
      const desde = Number(url.searchParams.get("desde"));
      const ok = sos.suscribir(runId, res, desde);
      if (!ok) return json(res, { ok: false, mensaje: "No existe esa corrida" }, 404);
      return;
    }

    if (ruta === "/api/sos/corridas") {
      return json(res, sos.corridas(Number(url.searchParams.get("limite")) || 50));
    }

    if (ruta === "/api/sos/corridas/borrar" && req.method === "POST") {
      if (!csrfOk(req)) return json(res, { ok: false, mensaje: "Petición rechazada por seguridad" }, 403);
      return leerCuerpo(req, res, (datos) => {
        const r = sos.borrarCorridas(datos);
        json(res, r, r.ok ? 200 : (r.code || 400));
      });
    }

    if (ruta === "/api/sos/desbloquear" && req.method === "POST") {
      if (!csrfOk(req)) return json(res, { ok: false, mensaje: "Petición rechazada por seguridad" }, 403);
      return leerCuerpo(req, res, (datos) => {
        const r = sos.desbloquear(String(datos.accion || ""), String(datos.confirmacion || ""));
        json(res, r, r.ok ? 200 : (r.code || 400));
      });
    }

    if (ruta.startsWith("/api/sos/corridas/") && req.method === "GET") {
      const runId = decodeURIComponent(ruta.slice("/api/sos/corridas/".length));
      const c = sos.corrida(runId);
      if (!c) return json(res, { ok: false, mensaje: "No existe" }, 404);
      if (url.searchParams.get("formato") === "texto") {
        const textosSos = require("./modulos/sos/textos.js");
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        return res.end(textosSos.reporteCorrida(c));
      }
      return json(res, c);
    }

    if (ruta === "/api/evidencia") return json(res, sos.evidencia.listar());

    if (ruta === "/api/evidencia/borrar" && req.method === "POST") {
      if (!csrfOk(req)) return json(res, { ok: false, mensaje: "Petición rechazada por seguridad" }, 403);
      return leerCuerpo(req, res, (datos) => {
        const enCurso = sos.estado().en_curso;
        const enCursoId = enCurso ? (sos.corrida(enCurso.run_id) || {}).evidencia_id : null;
        const r = sos.evidencia.borrar(datos, { enCursoId });
        json(res, r, r.ok ? 200 : (r.code || 400));
      });
    }

    if (ruta.startsWith("/api/evidencia/") && req.method === "GET") {
      const id = decodeURIComponent(ruta.slice("/api/evidencia/".length));
      const formato = url.searchParams.get("formato") || "json";
      const paquete = sos.evidencia.leer(id, formato);
      if (paquete === null) return json(res, { ok: false, mensaje: "No existe" }, 404);
      if (formato === "json") return json(res, paquete);
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end(paquete);
    }

    if (ruta === "/api/logs/patrones") {
      return json(res, await cacheado("logs_patrones", 60, async () => {
        const conocidos = leerJson(F_PATRONES_LOG, {});
        const analisis = await logClustering.analizarLogs(sh, conocidos, "15m");
        guardarJson(F_PATRONES_LOG, analisis.conocidos);
        return {
          patrones: logClustering.listaParaPanel(analisis.conocidos, 50),
          nuevos: analisis.patrones_nuevos,
          lineas_analizadas: analisis.lineas_analizadas,
          generado: analisis.generado,
        };
      }));
    }

    if (ruta === "/api/bd/procesos") {
      return json(res, await dbProcesos.listarProcesos(mysql));
    }

    if (ruta === "/api/kapso/latencia") {
      return json(res, kapsoYModo.resumenLatencia(leerJsonl, F_LATENCIA_KAPSO));
    }

    if (ruta === "/api/kapso/gasto") {
      return json(res, kapsoYModo.estadoGasto(leerJson, F_GASTO_WSP));
    }

    if (ruta === "/api/modo" && req.method !== "POST") {
      return json(res, kapsoYModo.obtenerModo(leerJson, F_MODO));
    }

    if (ruta === "/api/bd/matar" && req.method === "POST") {
      const origen = req.headers.origin || "";
      const propio = req.headers["x-panel-zeus"] === "1";
      if (!propio || (origen && !esOrigenPermitido(origen))) {
        auditar("bd_matar_rechazado", "desconocido", "bloqueada", `origen: ${origen || "sin origen"}`);
        return json(res, { ok: false, mensaje: "Petición rechazada por seguridad" }, 403);
      }
      let cuerpo = "", excedido = false;
      req.on("data", (c) => {
        cuerpo += c;
        if (cuerpo.length > 4096 && !excedido) {
          excedido = true;
          json(res, { ok: false, mensaje: "La petición es demasiado grande" }, 413);
          req.destroy();
        }
      });
      req.on("end", async () => {
        if (excedido) return;
        let datos;
        try { datos = JSON.parse(cuerpo || "{}"); }
        catch (_) { return json(res, { ok: false, mensaje: "El contenido enviado no es válido" }, 400); }
        const r = await dbProcesos.matarProceso(mysql, datos.id);
        auditar("bd_matar", "panel", r.ok ? "ok" : "falló", `id ${datos.id}`);
        json(res, r, r.ok ? 200 : 400);
      });
      return;
    }

    if (ruta === "/api/modo" && req.method === "POST") {
      const origen = req.headers.origin || "";
      const propio = req.headers["x-panel-zeus"] === "1";
      if (!propio || (origen && !esOrigenPermitido(origen))) {
        auditar("modo_rechazado", "desconocido", "bloqueada", `origen: ${origen || "sin origen"}`);
        return json(res, { ok: false, mensaje: "Petición rechazada por seguridad" }, 403);
      }
      let cuerpo = "", excedido = false;
      req.on("data", (c) => {
        cuerpo += c;
        if (cuerpo.length > 4096 && !excedido) {
          excedido = true;
          json(res, { ok: false, mensaje: "La petición es demasiado grande" }, 413);
          req.destroy();
        }
      });
      req.on("end", async () => {
        if (excedido) return;
        let datos;
        try { datos = JSON.parse(cuerpo || "{}"); }
        catch (_) { return json(res, { ok: false, mensaje: "El contenido enviado no es válido" }, 400); }
        const m = kapsoYModo.fijarModo(guardarJson, F_MODO, !!datos.activo, datos.motivo);
        auditar("modo_viaje", "panel", m.activo ? "activado" : "desactivado", m.motivo || "");
        json(res, { ok: true, modo: m });
      });
      return;
    }

    // Explica en español por qué una sugerencia de índice es lenta y, si
    // encuentra el nombre de la tabla en el código del bot, dice en qué
    // archivo se genera esa consulta. Es la única parte de "optimización"
    // que usa IA — el número de filas/segundos lo mide EXPLAIN, no el modelo.
    if (ruta === "/api/optimizacion/explicar" && req.method === "POST") {
      if (!csrfOk(req)) return json(res, { ok: false, mensaje: "Petición rechazada por seguridad" }, 403);
      return leerCuerpo(req, res, async (datos) => {
        const tabla = String(datos.tabla || "").replace(/[^a-zA-Z0-9_]/g, "");
        const columnas = Array.isArray(datos.columnas) ? datos.columnas.map((c) => String(c).replace(/[^a-zA-Z0-9_]/g, "")) : [];
        const tipoConsulta = String(datos.tipo_consulta || "");
        const ejemploSql = String(datos.ejemplo_sql || "").slice(0, 300);
        if (!tabla) return json(res, { ok: false, mensaje: "Falta la tabla" }, 400);

        // Grep de bajo costo sobre el código del bot: no ejecuta nada, solo
        // busca dónde se menciona la tabla, para darle contexto real a la IA
        // en vez de que adivine. Si no encuentra nada, sigue sin esa pista.
        const grep = await sh(
          `grep -rn --include='*.js' -i '\\b${tabla}\\b' /opt/zeus-app/src 2>/dev/null | grep -v node_modules | head -5`,
          8000
        ).catch(() => ({ ok: false, salida: "" }));
        const ubicaciones = (grep.salida || "").trim();

        const contexto =
          `Tabla: ${tabla}\nColumna(s) involucradas: ${columnas.join(", ") || "(no detectadas)"}\n` +
          `Tipo de consulta lenta: ${tipoConsulta}\nEjemplo de SQL real: ${ejemploSql}\n\n` +
          (ubicaciones
            ? `Dónde aparece "${tabla}" en el código del bot (archivo:línea:texto):\n${ubicaciones}`
            : `No se encontró "${tabla}" mencionada directamente en el código del bot (puede generarse dinámicamente o venir de otro servicio).`);

        const sistema =
          "Eres un DBA de MariaDB explicándole a un dueño de negocio, sin jerga técnica, " +
          "por qué una consulta de su sistema es lenta y qué relación tiene con su código. " +
          "Máximo 4 líneas. No inventes líneas de código que no te dieron.";

        let explicacion;
        try {
          explicacion = await preguntarAGemini(sistema, contexto, "Explica esta consulta lenta y su origen en el código.", { maxOutputTokens: 1200 });
        } catch (e) {
          explicacion = "No se pudo consultar la IA ahora mismo (" + e.message + "). El índice sugerido sigue siendo válido: se calculó con EXPLAIN, no depende de esto.";
        }
        auditar("optimizacion_explicada", "panel", "ok", `${tabla}: ${columnas.join(",")}`);
        json(res, { ok: true, explicacion, ubicaciones_codigo: ubicaciones || null });
      });
    }

    if (ruta === "/api/optimizacion/aplicar" && req.method === "POST") {
      const origen = req.headers.origin || "";
      const propio = req.headers["x-panel-zeus"] === "1";
      if (!propio || (origen && !esOrigenPermitido(origen))) {
        auditar("optimizacion_rechazada", "desconocido", "bloqueada", `origen: ${origen || "sin origen"}`);
        return json(res, { ok: false, mensaje: "Petición rechazada por seguridad" }, 403);
      }
      let cuerpo = "", excedido = false;
      req.on("data", (c) => {
        cuerpo += c;
        if (cuerpo.length > 4096 && !excedido) {
          excedido = true;
          json(res, { ok: false, mensaje: "La petición es demasiado grande" }, 413);
          req.destroy();
        }
      });
      req.on("end", async () => {
        if (excedido) return;
        let datos;
        try { datos = JSON.parse(cuerpo || "{}"); }
        catch (_) { return json(res, { ok: false, mensaje: "El contenido enviado no es válido" }, 400); }
        const chequeoPermiso = permisos.verificarEscritura("base_datos", "Base de datos");
        if (!chequeoPermiso.ok) return json(res, { ok: false, mensaje: chequeoPermiso.mensaje }, 403);
        // Colchón de RAM mientras se crea el índice; se retira apenas termina.
        await resiliencia.crearSwapEfimero("panel").catch(() => {});
        const r = await dbOptimizacion.aplicarIndice(mysql, String(datos.comando || ""));
        await resiliencia.quitarSwapEfimero("panel").catch(() => {});
        if (r.ok) { cache.delete("optimizacion"); cache.delete("datos"); }
        auditar("aplicar_indice", "panel", r.ok ? "ok" : "falló", String(datos.comando || "").slice(0, 200));
        json(res, r, r.ok ? 200 : 400);
      });
      return;
    }

    // Pasa una tabla de MyISAM a InnoDB (ALTER TABLE ... ENGINE=InnoDB). Único
    // cambio de motor/esquema que Centinela sabe hacer sola — mismo patrón de
    // seguridad que /api/optimizacion/aplicar (permiso, swap efímero, auditoría).
    if (ruta === "/api/optimizacion/reparar-motor" && req.method === "POST") {
      if (!csrfOk(req)) return json(res, { ok: false, mensaje: "Petición rechazada por seguridad" }, 403);
      return leerCuerpo(req, res, async (datos) => {
        const chequeoPermiso = permisos.verificarEscritura("base_datos", "Base de datos");
        if (!chequeoPermiso.ok) return json(res, { ok: false, mensaje: chequeoPermiso.mensaje }, 403);
        await resiliencia.crearSwapEfimero("panel").catch(() => {});
        const r = await dbOptimizacion.cambiarMotorInnoDB(mysql, String(datos.tabla || ""));
        await resiliencia.quitarSwapEfimero("panel").catch(() => {});
        if (r.ok) { cache.delete("optimizacion"); cache.delete("datos"); }
        auditar("reparar_motor_tabla", "panel", r.ok ? "ok" : "falló", String(datos.tabla || ""));
        json(res, r, r.ok ? 200 : 400);
      });
    }

    // Desfragmenta una tabla grande (OPTIMIZE TABLE). Mismo patrón de
    // seguridad que reparar-motor: permiso, colchón de RAM, auditoría.
    if (ruta === "/api/optimizacion/optimizar-tabla" && req.method === "POST") {
      if (!csrfOk(req)) return json(res, { ok: false, mensaje: "Petición rechazada por seguridad" }, 403);
      return leerCuerpo(req, res, async (datos) => {
        const chequeoPermiso = permisos.verificarEscritura("base_datos", "Base de datos");
        if (!chequeoPermiso.ok) return json(res, { ok: false, mensaje: chequeoPermiso.mensaje }, 403);
        await resiliencia.crearSwapEfimero("panel").catch(() => {});
        const r = await dbOptimizacion.optimizarTabla(mysql, String(datos.tabla || ""));
        await resiliencia.quitarSwapEfimero("panel").catch(() => {});
        if (r.ok) { cache.delete("optimizacion"); cache.delete("datos"); }
        auditar("optimizar_tabla", "panel", r.ok ? "ok" : "falló", String(datos.tabla || ""));
        json(res, r, r.ok ? 200 : 400);
      });
    }

    // Sube max_connections (SET GLOBAL, dinámico — no reinicia la base).
    if (ruta === "/api/optimizacion/subir-conexiones" && req.method === "POST") {
      if (!csrfOk(req)) return json(res, { ok: false, mensaje: "Petición rechazada por seguridad" }, 403);
      return leerCuerpo(req, res, async (datos) => {
        const chequeoPermiso = permisos.verificarEscritura("base_datos", "Base de datos");
        if (!chequeoPermiso.ok) return json(res, { ok: false, mensaje: chequeoPermiso.mensaje }, 403);
        const r = await dbOptimizacion.subirMaxConnections(mysql, Number(datos.valor));
        if (r.ok) { cache.delete("optimizacion_completa"); cache.delete("datos"); }
        auditar("subir_max_connections", "panel", r.ok ? "ok" : "falló", String(datos.valor || ""));
        json(res, r, r.ok ? 200 : 400);
      });
    }

    // Baja key_buffer_size a 8 MB (SET GLOBAL, dinámico — no reinicia la base).
    if (ruta === "/api/optimizacion/reducir-key-buffer" && req.method === "POST") {
      if (!csrfOk(req)) return json(res, { ok: false, mensaje: "Petición rechazada por seguridad" }, 403);
      return leerCuerpo(req, res, async () => {
        const chequeoPermiso = permisos.verificarEscritura("base_datos", "Base de datos");
        if (!chequeoPermiso.ok) return json(res, { ok: false, mensaje: chequeoPermiso.mensaje }, 403);
        const r = await dbOptimizacion.reducirKeyBuffer(mysql);
        if (r.ok) { cache.delete("optimizacion_completa"); cache.delete("datos"); }
        auditar("reducir_key_buffer", "panel", r.ok ? "ok" : "falló", "");
        json(res, r, r.ok ? 200 : 400);
      });
    }

    // Corrige el permiso de un archivo con contraseñas (chmod 640). Solo
    // acepta una ruta de la lista fija ARCHIVOS_SENSIBLES — repararPermisoArchivo
    // la rechaza si no está ahí, sin importar lo que mande el cliente.
    if (ruta === "/api/seguridad/reparar-permisos" && req.method === "POST") {
      if (!csrfOk(req)) return json(res, { ok: false, mensaje: "Petición rechazada por seguridad" }, 403);
      return leerCuerpo(req, res, async (datos) => {
        const chequeoPermiso = permisos.verificarEscritura("servidor", "Servidor");
        if (!chequeoPermiso.ok) return json(res, { ok: false, mensaje: chequeoPermiso.mensaje }, 403);
        const r = await repararPermisoArchivo(sh, String(datos.archivo || ""));
        if (r.ok) cache.delete("seguridad_completa");
        auditar("reparar_permiso_archivo", "panel", r.ok ? "ok" : "falló", String(datos.archivo || ""));
        json(res, r, r.ok ? 200 : 400);
      });
    }

    // Redacta con Gemini una explicación específica de un hallazgo que
    // Centinela no sabe reparar sola. Nunca toca el servidor — solo texto.
    // No exige permiso de escritura (no ejecuta nada), pero sí CSRF, porque
    // cada llamada gasta una consulta del cupo diario de IA.
    if (ruta === "/api/hallazgo/explicar" && req.method === "POST") {
      if (!csrfOk(req)) return json(res, { ok: false, mensaje: "Petición rechazada por seguridad" }, 403);
      return leerCuerpo(req, res, async (datos) => {
        const r = await explicarHallazgo(preguntarAGemini, registrarConsultaIA, {
          titulo: String((datos && datos.titulo) || "").slice(0, 200),
          significado: String((datos && datos.significado) || "").slice(0, 500),
          detalle: String((datos && datos.detalle) || "").slice(0, 1500),
        });
        json(res, r, r.ok ? 200 : 400);
      });
    }

    if (ruta === "/api/registro") return json(res, leerJsonl(F_AUDIT, 40).reverse());
    if (ruta === "/api/centinela/preguntar" && req.method === "POST") {
      return manejarPreguntaCentinela(req, res);
    }

    if (ruta === "/api/agente") {
      const mem = process.memoryUsage();
      return json(res, {
        memoria_mb: Math.round(mem.rss / 1048576),
        muestras: leerJsonl(F_HIST, 43200).length,
        desde_arranque_s: Math.round(process.uptime()),
      });
    }

    // Aviso interno: solo desde el propio servidor (scripts de respaldo, cron).
    if (ruta === "/api/aviso" && req.method === "POST") {
      const local = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress);
      if (!local) return json(res, { ok: false, error: "solo desde el servidor" }, 403);
      let cuerpo = "";
      req.on("data", (c) => { cuerpo += c; if (cuerpo.length > 4096) req.destroy(); });
      req.on("end", async () => {
        let d = {};
        try { d = JSON.parse(cuerpo || "{}"); } catch (_) {}
        const texto = String(d.texto || "").slice(0, 900);
        if (!texto) return json(res, { ok: false, error: "falta el texto" }, 400);
        auditar("aviso_interno", String(d.origen || "script"), "enviado", texto.slice(0, 80));
        json(res, await enviarWhatsapp(texto));
      });
      return;
    }

    if (ruta === "/api/accion" && req.method === "POST") {
      // Defensa contra peticiones disparadas desde otra web. El navegador manda
      // la contraseña básica sola en cualquier petición a este dominio, así que
      // sin esto bastaría visitar una página maliciosa para reiniciar el servidor.
      // La cabecera propia obliga a una comprobación previa que otro sitio no supera.
      const origen = req.headers.origin || "";
      const propio = req.headers["x-panel-zeus"] === "1";
      if (!propio || (origen && !esOrigenPermitido(origen))) {
        auditar("accion_rechazada", "desconocido", "bloqueada", `origen: ${origen || "sin origen"}`);
        return json(res, { ok: false, mensaje: "Petición rechazada por seguridad" }, 403);
      }
      let cuerpo = "", excedido = false;
      req.on("data", (c) => {
        cuerpo += c;
        if (cuerpo.length > 4096 && !excedido) {
          excedido = true;
          json(res, { ok: false, mensaje: "La petición es demasiado grande" }, 413);
          req.destroy();
        }
      });
      req.on("end", async () => {
        if (excedido) return;
        let datos;
        try { datos = JSON.parse(cuerpo || "{}"); }
        catch (_) { return json(res, { ok: false, mensaje: "El contenido enviado no es válido" }, 400); }
        const r = await ejecutarAccion(String(datos.accion || ""), String(datos.objetivo || ""));
        json(res, r, r.ok ? 200 : 400);
      });
      return;
    }

    return servirEstatico(res, ruta);
  } catch (e) {
    return json(res, { ok: false, error: e.message }, 500);
  }
});

servidor.listen(PORT, "0.0.0.0", () => {
  console.log(`[${new Date().toISOString()}] zeus-ops escuchando en ${PORT}`);
  verificarArranque().catch(() => {});
  simulacros.reconciliarAlArrancar().catch((e) => auditar("simulacro_hombre_muerto", "agente", "error", e.message));
  contenedores.reconciliarAlArrancar().catch((e) => auditar("contenedor_huerfano", "agente", "error", e.message));
  setInterval(() => contenedores.revisarMantenimientos().catch(() => {}), 60000);
  sos.reconciliarAlArrancar().catch(() => {});
  sos.reanudarTrasReinicio().catch(() => {});
  muestrear();
  escucharDocker();
  setInterval(muestrear, 60000);
  setInterval(recortarHistorial, 6 * 3600 * 1000);
  setInterval(quizaResumenDiario, 60000);
  setInterval(quizaAuditoriaDiariaCentinela, 60000);
  setInterval(() => informeSemanal.quizaInformeSemanal().catch(() => {}), 60000);
  setInterval(() => informeSemanal.quizaFotoDiariaMensajes().catch(() => {}), 60000);
  setInterval(() => latidos.revisar().catch(() => {}), latidos.CONSTANTES.INTERVALO_REVISION_MS);
  setInterval(() => botMudo.quizaRevisar().catch(() => {}), 60000);
  setInterval(() => escalamiento.quizaEscalar().catch(() => {}), 60000);
  memoriaIncidentes.sincronizar().catch(() => {});
  setInterval(() => memoriaIncidentes.sincronizar().catch(() => {}), 5 * 60000);
  setInterval(() => auditoria360.quizaCorridaDiaria().catch(() => {}), 60000);
  setInterval(() => vigia.quizaCorridaDiaria().catch(() => {}), 60000);
  // Defensa perimetral (solo aviso): cada 5 minutos.
  setInterval(() => {
    resiliencia.revisarDefensaPerimetral({
      enVentanaExcluida: !!(simulacros.estado().en_curso || observacionDespliegue.estado().en_curso),
    }).catch(() => {});
  }, 5 * 60000);
  // Paquete de evidencia de memoria: una vez por hora basta.
  setInterval(() => {
    resiliencia.quizaArmarPaqueteEvidencia().catch(() => {});
  }, 60 * 60000);
});
