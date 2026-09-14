"use strict";
/**
 * modulos/sos/limites.js
 *
 * Límites duros del SOS (DISENO-SOS.md §5.3, §10.3). Esto es la salvaguarda
 * más importante del encargo: cuenta y bloquea `reiniciar_servidor`,
 * `deshacer_despliegue`, `reiniciar_docker`, `reiniciar_contenedor` y
 * `liberar_disco` de forma persistente en `sos-limites.json`, INDEPENDIENTE
 * de si Centinela se reinicia entre corridas.
 *
 * Tabla de límites (no negociable, DISENO-SOS.md §5.3):
 *   reiniciar_servidor   → 1 por incidente, 6 h de enfriamiento, 1 por día, autobloqueo
 *   deshacer_despliegue  → 1 por incidente, 6 h de enfriamiento, 1 por día, autobloqueo
 *   reiniciar_docker     → 1 por incidente, 6 h de enfriamiento, 2 por día, sin autobloqueo
 *   reiniciar_contenedor(X) → 1 por corrida, 2 por hora por contenedor (entre corridas),
 *                             8 por contenedor por día, sin autobloqueo
 *   liberar_disco        → 1 por corrida, 30 min de enfriamiento, sin autobloqueo
 *
 * "Incidente" = incidente_sos_id: una corrida se une al incidente anterior si
 * el síntoma principal es el mismo y la corrida anterior empezó hace < 6 h;
 * si no, abre uno nuevo (inc-<epoch>).
 *
 * "Borrar todos los registros" desde el panel NUNCA toca este archivo (§10.5):
 * los límites duros sobreviven a una limpieza de registros.
 */

const ENFRIAMIENTO_MS = {
  reiniciar_servidor: 6 * 3600 * 1000,
  deshacer_despliegue: 6 * 3600 * 1000,
  reiniciar_docker: 6 * 3600 * 1000,
  liberar_disco: 30 * 60 * 1000,
};

const AUTOBLOQUEO = new Set(["reiniciar_servidor", "deshacer_despliegue"]);
const TOPE_POR_DIA = { reiniciar_servidor: 1, deshacer_despliegue: 1, reiniciar_docker: 2 };
const TOPE_POR_INCIDENTE = { reiniciar_servidor: 1, deshacer_despliegue: 1, reiniciar_docker: 1, liberar_disco: 1 };
const TOPE_CONTENEDOR_HORA = 2;
const TOPE_CONTENEDOR_DIA = 8;
const DIAS_CONSERVAR_POR_DIA = 7;

// "Día" en hora Colombia (UTC-5), no UTC: para el dueño el día cambia a
// medianoche de Bogotá, no a las 7 p. m. — antes los topes "por día" se
// reiniciaban 5 horas antes de lo que él esperaba.
function hoyCO(ts) { return new Date((ts || Date.now()) - 5 * 3600 * 1000).toISOString().slice(0, 10); }

/**
 * @param {object} deps
 * @param {function} deps.leerJson
 * @param {function} deps.escribirAtomico  (ruta, obj) => boolean — de db-centinela.js
 * @param {string}   deps.ruta             ruta a sos-limites.json
 */
function crearLimites(deps) {
  if (typeof deps.leerJson !== "function") throw new Error("crearLimites necesita leerJson");
  if (typeof deps.escribirAtomico !== "function") throw new Error("crearLimites necesita escribirAtomico");
  if (!deps.ruta) throw new Error("crearLimites necesita ruta");

  const { leerJson, escribirAtomico, ruta } = deps;

  function vacio() {
    return {
      version: 1,
      incidente_actual: null,
      acciones: {
        reiniciar_servidor: { bloqueado: false, ultimo_ts: null, por_incidente: {}, por_dia: {}, motivo_bloqueo: "" },
        deshacer_despliegue: { bloqueado: false, ultimo_ts: null, por_incidente: {}, por_dia: {}, motivo_bloqueo: "" },
        reiniciar_docker: { bloqueado: false, ultimo_ts: null, por_incidente: {}, por_dia: {} },
        liberar_disco: { ultimo_ts: null, por_incidente: {} },
        reiniciar_contenedor: {},
      },
    };
  }

  function leer() {
    const db = leerJson(ruta, null);
    if (!db || !db.acciones) return vacio();
    // Migración suave: asegura que existan todas las claves esperadas.
    const base = vacio();
    return {
      ...base, ...db,
      acciones: { ...base.acciones, ...db.acciones },
    };
  }

  function guardar(db) {
    // Poda por_dia a 7 días (§10.4) en cada escritura.
    const limite = hoyCO(Date.now() - DIAS_CONSERVAR_POR_DIA * 86400000);
    for (const clave of Object.keys(db.acciones)) {
      const a = db.acciones[clave];
      if (a && a.por_dia) {
        for (const dia of Object.keys(a.por_dia)) if (dia < limite) delete a.por_dia[dia];
      }
    }
    // Listas de reiniciar_contenedor: solo las últimas 24 h.
    const cont = db.acciones.reiniciar_contenedor || {};
    const desde24h = Date.now() - 24 * 3600 * 1000;
    for (const nombre of Object.keys(cont)) {
      cont[nombre] = (cont[nombre] || []).filter((ts) => new Date(ts).getTime() >= desde24h);
    }
    return escribirAtomico(ruta, db);
  }

  /**
   * Calcula (o continúa) el incidente_sos_id para un síntoma dado.
   * Regla: se une al incidente anterior si el síntoma es el mismo y esa
   * corrida empezó hace < 6 h; si no, abre uno nuevo.
   */
  function incidenteActual(sintoma) {
    const db = leer();
    const ic = db.incidente_actual;
    if (ic && ic.sintoma === sintoma && Date.now() - new Date(ic.inicio).getTime() < 6 * 3600 * 1000) {
      ic.corridas = (ic.corridas || 0) + 1;
      guardar(db);
      return ic.id;
    }
    const nuevo = { id: `inc-${Math.floor(Date.now() / 1000)}`, sintoma, inicio: new Date().toISOString(), corridas: 1 };
    db.incidente_actual = nuevo;
    guardar(db);
    return nuevo.id;
  }

  /**
   * ¿Se puede ejecutar `accion` ahora? `contexto = { objetivo, incidenteId }`.
   * Devuelve { ok, motivo }.
   */
  function puede(accion, contexto = {}) {
    const db = leer();

    if (accion === "reiniciar_contenedor") {
      const nombre = contexto.objetivo;
      const lista = (db.acciones.reiniciar_contenedor || {})[nombre] || [];
      const haceUnaHora = Date.now() - 3600 * 1000;
      const enUltimaHora = lista.filter((ts) => new Date(ts).getTime() >= haceUnaHora).length;
      if (enUltimaHora >= TOPE_CONTENEDOR_HORA) {
        return { ok: false, codigo: "tope_hora", motivo: `Ya reinicié ${nombre} ${enUltimaHora} veces en la última hora. Hace falta una persona.` };
      }
      const hoy = hoyCO();
      const enHoy = lista.filter((ts) => hoyCO(ts) === hoy).length;
      if (enHoy >= TOPE_CONTENEDOR_DIA) {
        return { ok: false, codigo: "tope_dia", motivo: `Ya reinicié ${nombre} ${enHoy} veces hoy. Hace falta una persona.` };
      }
      return { ok: true };
    }

    const reg = db.acciones[accion];
    if (!reg) return { ok: true }; // acción sin límite duro registrado (p.ej. no debería llegar aquí)

    if (AUTOBLOQUEO.has(accion) && reg.bloqueado) {
      return { ok: false, codigo: "autobloqueo", motivo: reg.motivo_bloqueo || `${accion} está bloqueado tras dispararse antes. Una persona debe permitirlo de nuevo en el panel.` };
    }

    const enfriamiento = ENFRIAMIENTO_MS[accion];
    if (enfriamiento && reg.ultimo_ts) {
      const faltan = enfriamiento - (Date.now() - new Date(reg.ultimo_ts).getTime());
      if (faltan > 0) {
        const minutos = Math.ceil(faltan / 60000);
        return { ok: false, codigo: "enfriamiento", minutos, motivo: `${accion} está en enfriamiento; faltan ${minutos} minutos.` };
      }
    }

    const topeDia = TOPE_POR_DIA[accion];
    if (topeDia) {
      const usadoHoy = (reg.por_dia && reg.por_dia[hoyCO()]) || 0;
      if (usadoHoy >= topeDia) {
        return { ok: false, codigo: "tope_dia", motivo: `${accion} ya se usó el máximo permitido hoy (${topeDia}).` };
      }
    }

    const topeInc = TOPE_POR_INCIDENTE[accion];
    if (topeInc && contexto.incidenteId) {
      const usadoInc = (reg.por_incidente && reg.por_incidente[contexto.incidenteId]) || 0;
      if (usadoInc >= topeInc) {
        return { ok: false, codigo: "tope_incidente", motivo: `${accion} ya se usó en este incidente (máximo ${topeInc} por incidente).` };
      }
    }

    return { ok: true };
  }

  /** Registra el uso efectivo de una acción (llamar solo tras ejecutarla). */
  function registrar(accion, contexto = {}) {
    const db = leer();

    if (accion === "reiniciar_contenedor") {
      const nombre = contexto.objetivo;
      db.acciones.reiniciar_contenedor[nombre] = db.acciones.reiniciar_contenedor[nombre] || [];
      db.acciones.reiniciar_contenedor[nombre].push(new Date().toISOString());
      guardar(db);
      return;
    }

    const reg = db.acciones[accion];
    if (!reg) return;
    reg.ultimo_ts = new Date().toISOString();
    reg.por_dia = reg.por_dia || {};
    const hoy = hoyCO();
    reg.por_dia[hoy] = (reg.por_dia[hoy] || 0) + 1;
    if (contexto.incidenteId) {
      reg.por_incidente = reg.por_incidente || {};
      reg.por_incidente[contexto.incidenteId] = (reg.por_incidente[contexto.incidenteId] || 0) + 1;
    }
    if (AUTOBLOQUEO.has(accion)) {
      reg.bloqueado = true;
      reg.motivo_bloqueo = `Se disparó ${accion} el ${reg.ultimo_ts}. Necesita que una persona lo vuelva a permitir desde el panel (palabra PERMITIR).`;
    }
    guardar(db);
  }

  /** Desbloqueo manual desde el panel (solo quita `bloqueado`, no reinicia contadores). */
  function desbloquear(accion) {
    if (!AUTOBLOQUEO.has(accion)) return { ok: false, motivo: "Esa acción no tiene autobloqueo." };
    const db = leer();
    const reg = db.acciones[accion];
    if (!reg) return { ok: false, motivo: "Acción desconocida." };
    reg.bloqueado = false;
    reg.motivo_bloqueo = "";
    guardar(db);
    return { ok: true, limites: resumen() };
  }

  /** Resumen para GET /api/sos (§13.1). */
  function resumen() {
    const db = leer();
    const out = {};
    for (const accion of ["reiniciar_servidor", "deshacer_despliegue", "reiniciar_docker"]) {
      const reg = db.acciones[accion];
      const enfriamiento = ENFRIAMIENTO_MS[accion];
      let restante = 0;
      if (enfriamiento && reg.ultimo_ts) {
        restante = Math.max(0, Math.ceil((enfriamiento - (Date.now() - new Date(reg.ultimo_ts).getTime())) / 60000));
      }
      out[accion] = {
        bloqueado: !!reg.bloqueado,
        ultimo_ts: reg.ultimo_ts || null,
        hoy: (reg.por_dia && reg.por_dia[hoyCO()]) || 0,
        enfriamiento_restante_min: restante,
        ...(reg.motivo_bloqueo ? { motivo_bloqueo: reg.motivo_bloqueo } : {}),
      };
    }
    return out;
  }

  return { leer, guardar, incidenteActual, puede, registrar, desbloquear, resumen, bloquear: (accion, motivo) => {
    const db = leer();
    const reg = db.acciones[accion];
    if (!reg) return;
    reg.bloqueado = true;
    reg.motivo_bloqueo = motivo || reg.motivo_bloqueo;
    guardar(db);
  } };
}

module.exports = { crearLimites, ENFRIAMIENTO_MS, AUTOBLOQUEO, TOPE_POR_DIA, TOPE_POR_INCIDENTE, TOPE_CONTENEDOR_HORA, TOPE_CONTENEDOR_DIA };
