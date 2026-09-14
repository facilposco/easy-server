"use strict";
/**
 * Centinela Zeus — agrupación de patrones de log del bot (Top-10 #2).
 *
 * Lee la cola reciente de `docker logs zeus-bot`, normaliza cada línea
 * (quita timestamps, ids, uuids y números que cambian de un mensaje a otro)
 * para obtener un "patrón" comparable, y lleva la cuenta de cuántas veces
 * se vio cada uno. Si aparece un patrón completamente nuevo, lo marca para
 * que el panel lo resalte — suele ser la primera señal de un error nuevo.
 *
 * Memoria acotada a propósito: solo se lee la cola de los últimos minutos
 * (`docker logs --since=`), nunca el log completo.
 *
 * Aislado: no lee logs ni escribe nada hasta que se lo llama. Recibe `sh()`
 * de ops-server.js como parámetro, siguiendo el mismo patrón de bajo
 * acoplamiento que ya usan `db-optimizacion.js` y `seguridad-auditoria.js`
 * (funciones sueltas que reciben sus dependencias, no una fábrica con
 * estado propio). No se conecta a ningún contenedor ajeno: solo lee
 * `zeus-bot`.
 */

const crypto = require("crypto");

const CONTENEDOR = "zeus-bot";
const VENTANA_DEFECTO = "15m"; // ventana corta: se llama seguido, no hace falta más
const MAX_LINEAS = 2000; // tope duro además de --since, para no cargar de más
const MAX_PATRONES_GUARDADOS = 300; // recorte del archivo persistido

// ── Normalización ────────────────────────────────────────────────────────

/**
 * Reduce una línea de log a su "forma", quitando lo que varía entre
 * ocurrencias de un mismo tipo de mensaje: timestamps ISO, horas sueltas,
 * uuids, números largos (ids de pedido/cliente/teléfono) y correos. El
 * resultado es una plantilla comparable entre líneas parecidas.
 */
function normalizarLinea(linea) {
  return String(linea || "")
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?/g, "<ts>")
    .replace(/\b\d{2}:\d{2}:\d{2}\b/g, "<hora>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, "<correo>")
    .replace(/\b\+?\d{7,15}\b/g, "<numero>")
    .replace(/\b\d+\b/g, "<n>")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Hash corto y estable de una plantilla ya normalizada, para usar como clave. */
function hashPatron(plantilla) {
  return crypto.createHash("sha1").update(plantilla).digest("hex").slice(0, 12);
}

// ── Lectura de la cola de logs ───────────────────────────────────────────

/**
 * Trae las últimas líneas del bot dentro de la ventana pedida. `--since`
 * hace que Docker filtre en origen (memoria acotada); `tail` recorta por
 * si la ventana trajera de más.
 */
async function leerColaLogs(sh, ventana) {
  const v = /^[0-9]+[smh]$/.test(ventana || "") ? ventana : VENTANA_DEFECTO;
  const r = await sh(
    `docker logs --since=${v} --timestamps ${CONTENEDOR} 2>&1 | tail -n ${MAX_LINEAS}`,
    20000
  );
  if (!r.salida) return [];
  return r.salida.split("\n").filter(Boolean).slice(-MAX_LINEAS);
}

// ── Análisis ─────────────────────────────────────────────────────────────

/**
 * Agrupa las líneas de la ventana por patrón normalizado y las combina con
 * los patrones ya conocidos (el objeto persistido). No escribe a disco:
 * quien llama guarda el resultado con `guardarJson(RUTA, resultado.conocidos)`.
 *
 * @param {Function} sh         sh() de ops-server.js
 * @param {Object}   conocidos  mapa persistido, normalmente `leerJson(RUTA_PATRONES, {})`
 * @param {string}   [ventana]  ventana para `docker logs --since`, p.ej. "15m"
 * @returns {Promise<{conocidos:Object, patrones_nuevos:Array, lineas_analizadas:number, patrones_en_ventana:number, generado:string}>}
 */
async function analizarLogs(sh, conocidos, ventana) {
  if (typeof sh !== "function") throw new Error("analizarLogs necesita la función sh() de ops-server.js");
  const base = conocidos && typeof conocidos === "object" ? conocidos : {};
  const lineas = await leerColaLogs(sh, ventana);

  const vistosAhora = new Map(); // hash -> {plantilla, veces, ejemplo}
  for (const linea of lineas) {
    const plantilla = normalizarLinea(linea);
    if (!plantilla) continue;
    const hash = hashPatron(plantilla);
    if (!vistosAhora.has(hash)) vistosAhora.set(hash, { plantilla, veces: 0, ejemplo: linea.slice(0, 300) });
    vistosAhora.get(hash).veces += 1;
  }

  const ahoraIso = new Date().toISOString();
  const nuevos = [];
  const actualizados = { ...base };

  for (const [hash, info] of vistosAhora) {
    const previo = actualizados[hash];
    if (!previo) {
      actualizados[hash] = {
        plantilla: info.plantilla,
        primera_vez: ahoraIso,
        ultima_vez: ahoraIso,
        veces_total: info.veces,
        veces_ultima_pasada: info.veces,
        ejemplo: info.ejemplo,
        nuevo: true,
      };
      nuevos.push({ id: hash, ...actualizados[hash] });
    } else {
      previo.ultima_vez = ahoraIso;
      previo.veces_total = (previo.veces_total || 0) + info.veces;
      previo.veces_ultima_pasada = info.veces;
      previo.nuevo = false;
    }
  }

  // Recorte: si hay demasiados patrones acumulados, se descartan los menos
  // vistos y más viejos (casi siempre ruido de una sola vez).
  const claves = Object.keys(actualizados);
  if (claves.length > MAX_PATRONES_GUARDADOS) {
    const orden = claves
      .map((k) => ({ k, veces: actualizados[k].veces_total || 0, ultima: actualizados[k].ultima_vez || "" }))
      .sort((a, b) => b.veces - a.veces || (b.ultima < a.ultima ? -1 : 1));
    const conservar = new Set(orden.slice(0, MAX_PATRONES_GUARDADOS).map((o) => o.k));
    for (const k of claves) if (!conservar.has(k)) delete actualizados[k];
  }

  return {
    conocidos: actualizados,
    patrones_nuevos: nuevos,
    lineas_analizadas: lineas.length,
    patrones_en_ventana: vistosAhora.size,
    generado: ahoraIso,
  };
}

// ── Vista para el panel ──────────────────────────────────────────────────

/**
 * Convierte el mapa de patrones persistido en una lista ordenada (más
 * frecuentes primero), lista para servir por la API.
 */
function listaParaPanel(conocidos, limite) {
  const base = conocidos && typeof conocidos === "object" ? conocidos : {};
  return Object.entries(base)
    .map(([hash, p]) => ({
      id: hash,
      patron: p.plantilla,
      ejemplo: p.ejemplo,
      veces_total: p.veces_total || 0,
      veces_ultima_pasada: p.veces_ultima_pasada || 0,
      primera_vez: p.primera_vez || null,
      ultima_vez: p.ultima_vez || null,
      es_nuevo: !!p.nuevo,
    }))
    .sort((a, b) => b.veces_total - a.veces_total)
    .slice(0, limite || 50);
}

module.exports = {
  analizarLogs,
  listaParaPanel,
  // Exportadas para pruebas y reutilización por otro módulo.
  _interno: { normalizarLinea, hashPatron, leerColaLogs },
};
