"use strict";
/**
 * Centinela Zeus — reglas de seguridad para lo que el agente hace SOLO
 * (sin que una persona confirme cada paso). No reemplaza los límites que ya
 * existen en `modulos/sos/limites.js` (presupuesto de acciones, enfriamiento
 * por acción peligrosa, autobloqueo) — se SUMA a ellos, como una capa más
 * arriba: primero se pregunta aquí "¿puedo actuar en general ahora mismo?",
 * y solo si la respuesta es sí se entra al presupuesto/límites de siempre.
 *
 * Tres reglas:
 *   1. Freno de emergencia global — un interruptor manual: si está activo,
 *      NADA autónomo actúa (sigue diagnosticando y avisando). Solo lo
 *      desactiva una persona desde el panel.
 *   2. Detección de bucle — si el mismo servicio causó 3+ incidentes en la
 *      última hora, se repara la primera vez y luego se deja de intentar:
 *      reintentar en bucle esconde la causa real y desgasta el servidor.
 *   3. Horario comercial — solo se aplica al paso más disruptivo (reiniciar
 *      el servidor completo): si no es una caída total y estamos en horario
 *      de atención, se prefiere esperar/escalar antes que forzar un corte
 *      de servicio a los clientes.
 *
 * Ninguna de las tres bloquea una acción MANUAL (un humano hizo clic en un
 * botón del panel) — ahí ya hay una persona presente decidiendo; estas
 * reglas son para lo que Centinela decide y ejecuta por su cuenta.
 */

const path = require("path");

// Horario comercial por defecto: 8 a.m. a 8 p.m. hora de Colombia (UTC-5).
const HORA_INICIO_COMERCIAL_UTC_DEFECTO = 13; // 08:00 Colombia
const HORA_FIN_COMERCIAL_UTC_DEFECTO = 1; // 20:00 Colombia (cruza medianoche UTC)
const VENTANA_BUCLE_MS = 60 * 60 * 1000; // 1 hora
const UMBRAL_BUCLE = 3; // incidentes del mismo servicio en la ventana

function crearReglasSeguridad(deps) {
  const { DIR_DATOS, leerJson, guardarJson, auditar } = deps || {};
  if (!DIR_DATOS || typeof leerJson !== "function" || typeof guardarJson !== "function" || typeof auditar !== "function") {
    throw new Error("crearReglasSeguridad necesita DIR_DATOS, leerJson, guardarJson y auditar de ops-server.js");
  }
  const RUTA = path.join(DIR_DATOS, "reglas-seguridad.json");

  function leer() {
    return leerJson(RUTA, {
      freno: { activo: false, quien: "", motivo: "", ts: "" },
      horario_comercial: { inicio_utc: HORA_INICIO_COMERCIAL_UTC_DEFECTO, fin_utc: HORA_FIN_COMERCIAL_UTC_DEFECTO, activo: true },
    });
  }

  // ── 1. Freno de emergencia ──────────────────────────────────────────────
  function frenoActivo() { return !!leer().freno.activo; }

  function activarFreno(quien, motivo) {
    const s = leer();
    s.freno = { activo: true, quien: quien || "panel", motivo: motivo || "", ts: new Date().toISOString() };
    guardarJson(RUTA, s);
    auditar("freno_emergencia", quien || "panel", "activado", motivo || "");
    return s.freno;
  }
  function desactivarFreno(quien) {
    const s = leer();
    s.freno = { activo: false, quien: "", motivo: "", ts: "" };
    guardarJson(RUTA, s);
    auditar("freno_emergencia", quien || "panel", "desactivado", "");
    return s.freno;
  }

  // ── 2. Detección de bucle ───────────────────────────────────────────────
  /**
   * @param {string} servicio nombre del contenedor/servicio causante
   * @param {Array}  historialIncidentes db.historial de baseIncidentes()
   * @returns {boolean} true si hay que dejar de reintentar y escalar
   */
  function enBucle(servicio, historialIncidentes) {
    if (!servicio || !Array.isArray(historialIncidentes)) return false;
    const desde = Date.now() - VENTANA_BUCLE_MS;
    const recientes = historialIncidentes.filter((inc) => inc && inc.servicio === servicio && new Date(inc.inicio).getTime() >= desde);
    return recientes.length >= UMBRAL_BUCLE;
  }

  // ── 3. Horario comercial ────────────────────────────────────────────────
  function enHorarioComercial() {
    const s = leer();
    const hc = s.horario_comercial || {};
    if (hc.activo === false) return false;
    const inicio = Number.isFinite(hc.inicio_utc) ? hc.inicio_utc : HORA_INICIO_COMERCIAL_UTC_DEFECTO;
    const fin = Number.isFinite(hc.fin_utc) ? hc.fin_utc : HORA_FIN_COMERCIAL_UTC_DEFECTO;
    const hora = new Date().getUTCHours();
    // La ventana puede cruzar medianoche UTC (ej. 13 → 1): si inicio > fin,
    // está "adentro" cuando la hora es >= inicio O < fin.
    if (inicio <= fin) return hora >= inicio && hora < fin;
    return hora >= inicio || hora < fin;
  }

  function configurarHorario(inicio_utc, fin_utc, activo) {
    const s = leer();
    s.horario_comercial = {
      inicio_utc: Number.isFinite(inicio_utc) ? inicio_utc : HORA_INICIO_COMERCIAL_UTC_DEFECTO,
      fin_utc: Number.isFinite(fin_utc) ? fin_utc : HORA_FIN_COMERCIAL_UTC_DEFECTO,
      activo: activo !== false,
    };
    guardarJson(RUTA, s);
    auditar("horario_comercial", "panel", "configurado", `${s.horario_comercial.inicio_utc}-${s.horario_comercial.fin_utc} UTC`);
    return s.horario_comercial;
  }

  function estado() { return leer(); }

  return { frenoActivo, activarFreno, desactivarFreno, enBucle, enHorarioComercial, configurarHorario, estado };
}

module.exports = { crearReglasSeguridad };
