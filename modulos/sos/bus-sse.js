"use strict";
/**
 * modulos/sos/bus-sse.js
 *
 * Bus SSE reutilizable, copia FUNCIONALMENTE IDÉNTICA del patrón usado por
 * `modulos/simulacros/simulacros.js` (ya probado en producción): cabeceras
 * anti-buffering, `retry`, latido `: ping` cada 15 s, `seq` monótono por
 * corrida, reproducción desde `?desde=<seq>`. `simulacros.js` NO se toca
 * (está en producción); este archivo es independiente y parametrizable por
 * directorio de eventos y nombre del campo de "tipo" (para simulacros ese
 * campo se llama `simulacro`; para el SOS, `fase`/`run_id` ya alcanzan y no
 * hace falta un campo de tipo extra, pero queda soportado por si otro módulo
 * lo necesita — ver DISENO-SOS.md §16, sección "Contenedores").
 *
 * Sin dependencias externas: solo `node:fs` y `node:path`.
 */

const fs = require("fs");
const path = require("path");

function leerJsonlLocal(archivo, max) {
  try {
    const lineas = fs.readFileSync(archivo, "utf8").trim().split("\n").slice(-(max || 20000));
    return lineas.filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
  } catch (_) { return []; }
}

function anexarLocal(archivo, obj) {
  try { fs.appendFileSync(archivo, JSON.stringify(obj) + "\n"); } catch (_) {}
}

/**
 * @param {object} opciones
 * @param {string} opciones.dirEventos   carpeta donde se guarda un .jsonl por run_id
 * @param {string} [opciones.campoTipo]  nombre opcional de un campo adicional de "tipo" a incluir en cada evento (p.ej. "simulacro")
 * @param {function(string):boolean} [opciones.enCurso] dado un run_id, dice si esa corrida sigue activa (para decidir si engancha el stream o lo cierra de inmediato)
 */
function crearBus(opciones) {
  const dirEventos = opciones && opciones.dirEventos;
  if (!dirEventos) throw new Error("crearBus necesita dirEventos");
  const campoTipo = (opciones && opciones.campoTipo) || null;
  const enCursoFn = (opciones && typeof opciones.enCurso === "function") ? opciones.enCurso : () => false;

  fs.mkdirSync(dirEventos, { recursive: true });

  function archivoCorrida(runId) { return path.join(dirEventos, `${runId}.jsonl`); }

  const suscriptores = new Map(); // run_id -> Set<res>
  const latidos = new Map();      // run_id -> intervalId
  const contadoresSeq = new Map(); // run_id -> próximo seq

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

  /**
   * Emite y persiste un evento de una corrida. `tipo` es el valor del
   * `campoTipo` (p.ej. el id del simulacro); se omite si no se configuró.
   */
  function emitirEvento(runId, tipo, fase, nivel, texto, dato) {
    const evento = {
      ts: new Date().toISOString(),
      run_id: runId,
      seq: siguienteSeq(runId),
      fase, nivel, texto,
      dato: dato === undefined ? undefined : dato,
    };
    if (campoTipo && tipo !== undefined) evento[campoTipo] = tipo;
    anexarLocal(archivoCorrida(runId), evento);
    const subs = suscriptores.get(runId);
    if (subs && subs.size) {
      const payload = `event: paso\nid: ${evento.seq}\ndata: ${JSON.stringify(evento)}\n\n`;
      for (const res of subs) { try { res.write(payload); } catch (_) {} }
    }
    return evento;
  }

  /** Emite el evento final `fin` (§12 de DISENO-SOS.md) y cierra los streams. */
  function emitirFin(runId, tipo, texto, dato) {
    const evento = emitirEvento(runId, tipo, "resultado", dato && dato.resultado === "restablecido" ? "ok" : "info", texto, dato);
    const subs = suscriptores.get(runId);
    if (subs && subs.size) {
      const payload = `event: fin\nid: ${evento.seq}\ndata: ${JSON.stringify(evento)}\n\n`;
      for (const res of subs) { try { res.write(payload); res.end(); } catch (_) {} }
    }
    cerrarSuscriptores(runId);
    return evento;
  }

  function cerrarSuscriptores(runId) {
    const subs = suscriptores.get(runId);
    if (subs) {
      for (const res of subs) { try { res.end(); } catch (_) {} }
      suscriptores.delete(runId);
    }
    const latido = latidos.get(runId);
    if (latido) { clearInterval(latido); latidos.delete(runId); }
    contadoresSeq.delete(runId);
  }

  /**
   * Engancha una respuesta HTTP como cliente SSE de una corrida.
   * Devuelve false si el run_id no tiene ningún evento (404 para el llamador).
   */
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

    if (!enCursoFn(runId)) {
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

  function eventosDe(runId) { return leerJsonlLocal(archivoCorrida(runId)); }

  return { emitirEvento, emitirFin, suscribir, cerrarSuscriptores, eventosDe, archivoCorrida };
}

module.exports = { crearBus };
