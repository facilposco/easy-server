"use strict";
/**
 * modulos/sos/db-centinela.js
 *
 * La base de datos propia de Centinela (DISENO-SOS.md §10). NO usa MariaDB
 * (es uno de los servicios que el SOS repara) ni SQLite: son archivos
 * JSON/JSONL bajo /var/lib/zeus-ops/centinela-db/, con el mismo patrón que
 * `historial.jsonl` / `incidentes.json` de ops-server.js y las corridas de
 * simulacros. Este módulo concentra las rutas, la E/S atómica y la rotación
 * que usan `sos.js`, `evidencia.js` y `limites.js`, para no duplicar esa
 * lógica tres veces.
 *
 * Sin dependencias externas: solo `node:fs` y `node:path`.
 */

const fs = require("fs");
const path = require("path");

/**
 * @param {string} dirDatos DIR_DATOS de ops-server.js ("/var/lib/zeus-ops")
 */
function crearDbCentinela(dirDatos) {
  if (!dirDatos) throw new Error("crearDbCentinela necesita DIR_DATOS de ops-server.js");

  const DIR = path.join(dirDatos, "centinela-db");
  const DIR_EVENTOS = path.join(DIR, "sos-eventos");
  const DIR_EVIDENCIA = path.join(DIR, "evidencia");

  fs.mkdirSync(DIR, { recursive: true });
  fs.mkdirSync(DIR_EVENTOS, { recursive: true });
  fs.mkdirSync(DIR_EVIDENCIA, { recursive: true });

  const RUTAS = {
    corridas: path.join(DIR, "sos-corridas.jsonl"),
    limites: path.join(DIR, "sos-limites.json"),
    lock: path.join(DIR, "sos-en-curso.lock"),
    pendienteReinicio: path.join(DIR, "sos-pendiente-reinicio.json"),
    pendienteWhatsapp: path.join(DIR, "centinela-pendiente.json"),
    indiceEvidencia: path.join(DIR_EVIDENCIA, "indice.json"),
  };

  function leerJson(archivo, porDefecto) {
    try { return JSON.parse(fs.readFileSync(archivo, "utf8")); } catch (_) { return porDefecto; }
  }

  /** Escritura atómica (tmp + rename): nunca deja un índice a medio escribir. */
  function escribirAtomico(rutaFinal, obj) {
    try {
      const contenido = typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
      const tmp = `${rutaFinal}.tmp-${process.pid}-${Date.now()}`;
      fs.writeFileSync(tmp, contenido);
      fs.renameSync(tmp, rutaFinal);
      return true;
    } catch (_) { return false; }
  }

  function anexar(archivo, obj) {
    try { fs.appendFileSync(archivo, JSON.stringify(obj) + "\n"); return true; } catch (_) { return false; }
  }

  function leerJsonl(archivo, max = 5000) {
    try {
      const lineas = fs.readFileSync(archivo, "utf8").trim().split("\n").slice(-max);
      return lineas.filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
    } catch (_) { return []; }
  }

  /**
   * Recorta un .jsonl a lo sumo `maxLineas` y descarta líneas cuyo campo
   * `ts` (ISO) sea más viejo que `maxDias`. Reescribe el archivo entero
   * (son archivos de a lo sumo unos MB, cabe en memoria sin problema).
   */
  function rotarJsonl(archivo, maxLineas, maxDias) {
    const todas = leerJsonl(archivo, Math.max(maxLineas * 4, 5000));
    const limiteMs = maxDias ? Date.now() - maxDias * 86400000 : 0;
    let vivas = todas.filter((l) => !limiteMs || !l.ts || new Date(l.ts).getTime() >= limiteMs);
    if (maxLineas && vivas.length > maxLineas) vivas = vivas.slice(-maxLineas);
    if (vivas.length === todas.length) return { recortadas: 0 };
    try {
      fs.writeFileSync(archivo, vivas.map((v) => JSON.stringify(v)).join("\n") + (vivas.length ? "\n" : ""));
    } catch (_) {}
    return { recortadas: todas.length - vivas.length };
  }

  function rutaEventos(runId) { return path.join(DIR_EVENTOS, `${runId}.jsonl`); }
  function rutaEvidencia(id) { return path.join(DIR_EVIDENCIA, `${id}.json`); }

  /** Borra archivos de eventos de corridas con más de `dias` días. */
  function limpiarEventosViejos(dias) {
    const limite = Date.now() - dias * 86400000;
    let archivos = [];
    try { archivos = fs.readdirSync(DIR_EVENTOS); } catch (_) { return; }
    for (const f of archivos) {
      if (!f.endsWith(".jsonl")) continue;
      const ruta = path.join(DIR_EVENTOS, f);
      try { if (fs.statSync(ruta).mtimeMs < limite) fs.unlinkSync(ruta); } catch (_) {}
    }
  }

  return {
    DIR, DIR_EVENTOS, DIR_EVIDENCIA, RUTAS,
    leerJson, escribirAtomico, anexar, leerJsonl, rotarJsonl,
    rutaEventos, rutaEvidencia, limpiarEventosViejos,
  };
}

module.exports = { crearDbCentinela };
