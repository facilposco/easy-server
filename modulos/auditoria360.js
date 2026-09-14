"use strict";
/**
 * modulos/auditoria360.js
 *
 * Centinela Zeus — Auditoría 360: orquestador delgado que junta en una sola
 * corrida lo que YA existe (seguridad completa, seguridad ampliada, drift de
 * configuración, base de datos completa, predicción, estado general,
 * latidos, respaldos), lo consolida de forma determinista en 7 áreas fijas,
 * aplica sola una única acción reversible (liberar disco, bajo el mismo gate
 * que usa el SOS) y propone el resto con un clic. No reimplementa ninguna
 * revisión: solo llama, junta, puntúa y reporta.
 *
 * Diseño vinculante: DISENO-AUDITORIA360-PROACTIVA.md §0 y §1 (Fable 5.1,
 * 13 sept. 2026). Este archivo lo implementa al pie de la letra; donde el
 * diseño dejaba un grado de libertad (formas exactas de las funciones puras,
 * mensajes, agrupación de fuentes fallidas por área) la decisión tomada se
 * documenta en modulos/INTEGRACION-AUDITORIA360.md.
 *
 * Aislado a propósito: no edita ops-server.js, index.html, app.js, sos.js ni
 * centinela-comandos.js. Recibe TODO por inyección de dependencias — nunca
 * hace `require("./ops-server.js")` — mismo patrón que el resto de
 * modulos/. Cero dependencias externas: solo módulos nativos de Node.
 */

const fs = require("fs");
const path = require("path");
const { crearBus } = require("./sos/bus-sse.js");
const { crearPuedeActuar } = require("./sos/puede-actuar.js");
const { nombreClaro } = require("./sos/textos.js");

// ── Constantes fijas del diseño (§1.3, §1.5, §1.6) ──────────────────────────

const AREAS = ["seguridad", "configuracion", "base_datos", "capacidad", "servicios", "respaldos", "tareas"];

const CONTENEDORES_PROPIOS = ["zeus-bot", "zeus-mariadb", "zeus-chromadb", "zeus-proxy"];

const TAREA_LATIDO = {
  id: "auditoria_360",
  nombre_llano: "Auditoría completa del servidor",
  periodo: "diaria",
  hora_utc: 11,
  minuto_utc: 0,
  gracia_min: 45,
  nivel: "warn",
  origen: "interno",
};

// Cada fuente de la Ola A/B alimenta una o más áreas: si la fuente falla, esa
// o esas áreas quedan con nota:null (§1.5 "área con fuente fallida").
const FUENTE_AREAS = {
  seguridad_completa: ["seguridad"],
  seguridad_auditoria: ["seguridad"],
  config_drift: ["configuracion"],
  optimizacion_completa: ["base_datos"],
  estado_general: ["capacidad", "servicios"],
  prediccion: ["capacidad"],
  estado_respaldos: ["respaldos"],
  latidos: ["tareas"],
};

const NOMBRE_AREA_LLANO = {
  seguridad: "la seguridad",
  configuracion: "la configuración",
  base_datos: "la base de datos",
  capacidad: "la capacidad del servidor",
  servicios: "los servicios",
  respaldos: "las copias",
  tareas: "las tareas programadas",
};

const TOPE_FUENTE_MS = 60000; // tope por fuente en la Ola A (§1.4.2)
const TOPE_ESPERA_BD_MS = 8 * 60000; // tope de optimizacionCompleta.esperar() (§1.4.3)
const TOPE_LIBERAR_DISCO_MS = 5 * 60000; // tope de ejecutarAccion("optimizar") (§1.12)
const MAX_HISTORIAL_LINEAS = 60; // §1.9
const DIAS_CONSERVAR_EVENTOS = 30; // §1.9

// ── Utilidades pequeñas ──────────────────────────────────────────────────────

/** Envuelve una llamada (síncrona o asíncrona) en una promesa, sin perder una excepción síncrona. */
function envolver(fn) {
  return new Promise((resolve, reject) => {
    try { resolve(fn()); } catch (e) { reject(e); }
  });
}

/**
 * `promesa` con un tope de tiempo: si no resuelve a tiempo, rechaza. Limpia
 * el temporizador perdedor en ambos casos — si no, un `setTimeout` de 60 s
 * (o de 8/5 minutos en las otras llamadas) queda vivo de fondo y no deja
 * salir al proceso (crítico para que `node --test` termine solo).
 */
function conTope(promesa, ms) {
  let temporizador;
  const tope = new Promise((_, rej) => { temporizador = setTimeout(() => rej(new Error("tiempo agotado")), ms); });
  return Promise.race([promesa, tope]).finally(() => clearTimeout(temporizador));
}

/** `promesa` con un tope de tiempo que, si vence, resuelve a `valorPorDefecto` en vez de rechazar. */
function conTopeSuave(promesa, ms, valorPorDefecto) {
  let temporizador;
  const tope = new Promise((res) => { temporizador = setTimeout(() => res(valorPorDefecto), ms); });
  return Promise.race([promesa, tope]).finally(() => clearTimeout(temporizador));
}

function etiquetaDeNota(nota) {
  if (nota === null || nota === undefined) return "Sin datos suficientes";
  if (nota >= 9) return "Bien";
  if (nota >= 6) return "Con pendientes";
  if (nota >= 3) return "Necesita atención";
  return "Urgente";
}

// ── §1.5 — consolidación determinista (pura, exportada) ─────────────────────

/**
 * Junta los resultados crudos de cada fuente (Ola A + Ola B) en la lista
 * plana de hallazgos de las 7 áreas fijas, con dedupe por `clave`.
 *
 * Forma esperada de `fuentes` (cada entrada `{ok:true, ...}` o `{ok:false}`):
 *   seguridad_completa:   { ok, hallazgos:[{id,titulo,severidad,significado,detalle}] }
 *   seguridad_auditoria:  { ok, hallazgos:[{id,titulo,severidad,significado,detalle}] }
 *   config_drift:         { ok, hallazgo:{id,titulo,severidad,significado,detalle} }
 *   optimizacion_completa:{ ok, hallazgos:[{id,titulo,severidad,significado,detalle}] }
 *   estado_general:       { ok, valor:{avisos:[{texto,nivel,detalle}], contenedores:[{nombre,estado,salud,reinicios}]} }
 *   prediccion:           { ok, valor:{pronosticos:[{recurso,texto,nivel,dias,cortado}]} }
 *   estado_respaldos:     { ok, valor:{ultimo:{horas}|null, drive:{conectado,es_permiso,motivo}} }
 *   latidos:              { ok, valor:{tareas:[{id,nombre,estado,nivel,mensaje}]} }
 *
 * @returns {{hallazgos:Array, fuentes_fallidas:string[], areas_fallidas:string[]}}
 */
function consolidar(fuentes) {
  fuentes = fuentes || {};
  const hallazgos = [];
  const fuentesFallidas = [];
  const areasFallidas = new Set();

  function marcarFallo(nombre) {
    fuentesFallidas.push(nombre);
    (FUENTE_AREAS[nombre] || []).forEach((a) => areasFallidas.add(a));
  }

  function agregar(area, id, resto) {
    hallazgos.push({ clave: `${area}:${id}`, area, id, ...resto });
  }

  // ── seguridad ──
  const sc = fuentes.seguridad_completa;
  if (sc && sc.ok) {
    for (const h of sc.hallazgos || []) {
      agregar("seguridad", h.id, { titulo: h.titulo, severidad: h.severidad, significado: h.significado, detalle: h.detalle || "" });
    }
  } else marcarFallo("seguridad_completa");

  const sa = fuentes.seguridad_auditoria;
  if (sa && sa.ok) {
    for (const h of sa.hallazgos || []) {
      agregar("seguridad", h.id, { titulo: h.titulo, severidad: h.severidad, significado: h.significado, detalle: h.detalle || "" });
    }
  } else marcarFallo("seguridad_auditoria");

  // ── configuracion ──
  const cd = fuentes.config_drift;
  if (cd && cd.ok && cd.hallazgo) {
    const h = cd.hallazgo;
    agregar("configuracion", h.id, { titulo: h.titulo, severidad: h.severidad, significado: h.significado, detalle: h.detalle || "" });
  } else marcarFallo("config_drift");

  // ── base_datos ──
  const oc = fuentes.optimizacion_completa;
  if (oc && oc.ok) {
    for (const h of oc.hallazgos || []) {
      agregar("base_datos", h.id, { titulo: h.titulo, severidad: h.severidad, significado: h.significado, detalle: h.detalle || "" });
    }
  } else marcarFallo("optimizacion_completa");

  // ── capacidad + servicios (ambas de estado_general; capacidad también de prediccion) ──
  const eg = fuentes.estado_general;
  if (eg && eg.ok) {
    const valor = eg.valor || {};
    const avisos = valor.avisos || [];

    const avisoDe = (prefijo) => avisos.find((a) => a && typeof a.texto === "string" && a.texto.startsWith(prefijo));
    const nivelASeveridad = (nivel) => (nivel === "crit" ? "urgente" : nivel === "warn" ? "atencion" : "ok");

    const avisoRam = avisoDe("La memoria");
    if (avisoRam) {
      agregar("capacidad", "ram", { titulo: "Memoria del servidor", severidad: nivelASeveridad(avisoRam.nivel), significado: avisoRam.texto, detalle: avisoRam.detalle || "" });
    } else {
      const pct = valor.ram && typeof valor.ram.pct === "number" ? valor.ram.pct : null;
      agregar("capacidad", "ram", { titulo: "Memoria del servidor", severidad: "ok", significado: pct == null ? "Sin datos de memoria" : `Memoria al ${pct}%`, detalle: "" });
    }

    const avisoDisco = avisoDe("El disco");
    if (avisoDisco) {
      agregar("capacidad", "disco", { titulo: "Espacio en disco", severidad: nivelASeveridad(avisoDisco.nivel), significado: avisoDisco.texto, detalle: avisoDisco.detalle || "" });
    } else {
      const pct = valor.disco && typeof valor.disco.pct === "number" ? valor.disco.pct : null;
      agregar("capacidad", "disco", { titulo: "Espacio en disco", severidad: "ok", significado: pct == null ? "Sin datos de disco" : `Disco al ${pct}%`, detalle: "" });
    }

    // servicios: contenedores propios
    for (const c of valor.contenedores || []) {
      if (!c || !CONTENEDORES_PROPIOS.includes(c.nombre)) continue;
      const claro = nombreClaro(c.nombre);
      if (c.estado !== "running") {
        agregar("servicios", `caido_${c.nombre}`, { titulo: `${claro} está apagado`, severidad: "urgente", significado: `${claro} no está corriendo (estado: ${c.estado}).`, detalle: c.descripcion || "" });
      } else if (c.salud === "unhealthy") {
        agregar("servicios", `enfermo_${c.nombre}`, { titulo: `${claro} está enfermo`, severidad: "urgente", significado: `${claro} está corriendo pero reporta mala salud.`, detalle: c.descripcion || "" });
      }
      if (typeof c.reinicios === "number" && c.reinicios > 3) {
        agregar("servicios", `reinicios_${c.nombre}`, { titulo: `${claro} se reinició varias veces`, severidad: "atencion", significado: `${claro} lleva ${c.reinicios} reinicios.`, detalle: "" });
      }
    }
    const avisoBot = avisos.find((a) => a && a.texto === "El bot no está contestando a los clientes");
    if (avisoBot) {
      agregar("servicios", "bot_mudo", { titulo: "El bot no está contestando a los clientes", severidad: "urgente", significado: avisoBot.texto, detalle: avisoBot.detalle || "" });
    }
  } else {
    marcarFallo("estado_general");
  }

  const pr = fuentes.prediccion;
  if (pr && pr.ok) {
    const pronosticos = (pr.valor && pr.valor.pronosticos) || [];
    for (const p of pronosticos) {
      const id = p.recurso === "Memoria" ? "prediccion_memoria" : p.recurso === "Disco" ? "prediccion_disco" : null;
      if (!id) continue;
      const severidad = p.cortado === true ? "ok" : p.nivel === "crit" ? "urgente" : p.nivel === "warn" ? "atencion" : "ok";
      agregar("capacidad", id, {
        titulo: p.recurso === "Memoria" ? "Previsión de memoria" : "Previsión de disco",
        severidad, significado: p.texto || "", detalle: p.dias != null ? `${p.dias} día(s)` : "",
      });
    }
  } else {
    marcarFallo("prediccion");
  }

  // ── respaldos ──
  const er = fuentes.estado_respaldos;
  if (er && er.ok) {
    const v = er.valor || {};
    if (v.ultimo === null) {
      agregar("respaldos", "sin_copias", { titulo: "No hay copias de seguridad", severidad: "urgente", significado: "Nunca se ha hecho una copia de seguridad.", detalle: "" });
    } else if (v.ultimo && typeof v.ultimo.horas === "number" && v.ultimo.horas > 30) {
      agregar("respaldos", "copia_vieja", { titulo: "Copia de seguridad atrasada", severidad: "urgente", significado: `La última copia tiene ${v.ultimo.horas} horas.`, detalle: "" });
    }
    if (v.drive && !v.drive.conectado) {
      if (v.drive.es_permiso) {
        agregar("respaldos", "drive_permiso", { titulo: "Google Drive sin autorizar", severidad: "atencion", significado: v.drive.motivo || "Google Drive perdió el permiso para guardar copias.", detalle: "" });
      } else {
        agregar("respaldos", "drive_red", { titulo: "Google Drive sin conexión", severidad: "ok", significado: v.drive.motivo || "Google Drive no está alcanzable por red en este momento.", detalle: "" });
      }
    }
  } else {
    marcarFallo("estado_respaldos");
  }

  // ── tareas ──
  const lt = fuentes.latidos;
  if (lt && lt.ok) {
    const tareas = (lt.valor && lt.valor.tareas) || [];
    for (const t of tareas) {
      if (t.estado !== "falta") continue;
      const severidad = t.nivel === "crit" ? "urgente" : "atencion";
      agregar("tareas", `latido_${t.id}`, { titulo: `${t.nombre} no corrió`, severidad, significado: t.mensaje || `${t.nombre} no corrió cuando debía.`, detalle: "" });
    }
  } else {
    marcarFallo("latidos");
  }

  // Dedupe por clave (§1.5: las fuentes no se solapan por construcción; se
  // conserva la primera para que un cambio futuro no duplique).
  const vistos = new Set();
  const dedup = [];
  for (const h of hallazgos) {
    if (vistos.has(h.clave)) continue;
    vistos.add(h.clave);
    dedup.push(h);
  }

  return { hallazgos: dedup, fuentes_fallidas: fuentesFallidas, areas_fallidas: [...areasFallidas] };
}

// ── §1.5 — notas (pura, exportada) ───────────────────────────────────────────

/**
 * @param {Array} hallazgos       lista consolidada (con `.area` y `.severidad`)
 * @param {string[]} areasFallidas áreas que deben quedar con nota:null
 * @returns {{areas:Object, nota_global:number|null, etiqueta:string}}
 */
function calcularNotas(hallazgos, areasFallidas) {
  hallazgos = hallazgos || [];
  const fallidas = new Set(areasFallidas || []);
  const areas = {};
  for (const area of AREAS) {
    if (fallidas.has(area)) {
      areas[area] = { nota: null, urgentes: 0, atencion: 0 };
      continue;
    }
    const hs = hallazgos.filter((h) => h.area === area);
    const urgentes = hs.filter((h) => h.severidad === "urgente").length;
    const atencion = hs.filter((h) => h.severidad === "atencion").length;
    const nota = Math.max(0, 10 - 3 * urgentes - 1 * atencion);
    areas[area] = { nota, urgentes, atencion };
  }
  const notasValidas = Object.values(areas).map((a) => a.nota).filter((n) => n !== null);
  const nota_global = notasValidas.length ? Math.min(...notasValidas) : null;
  return { areas, nota_global, etiqueta: etiquetaDeNota(nota_global) };
}

// ── §1.6 — cubetas (pura, exportada) ─────────────────────────────────────────

/**
 * Clasifica UN hallazgo ya consolidado en su cubeta ("aplicar" | "proponer" |
 * "reportar") según la tabla de §1.6. No ejecuta nada: solo dice qué cubeta
 * le toca y, si aplica, la `propuesta` que ya sabe ejecutar el panel.
 * @returns {{cubeta:string, propuesta?:Object}}
 */
function clasificarCubeta(h) {
  if (!h) return { cubeta: "reportar" };

  if (h.area === "capacidad" && h.id === "disco" && h.severidad !== "ok") {
    return { cubeta: "aplicar" };
  }

  if (h.area === "seguridad" && h.id === "actualizaciones" && h.severidad !== "ok") {
    return { cubeta: "proponer", propuesta: { tipo: "accion", accion: "actualizar_seguridad", objetivo: "", etiqueta: "Aplicar actualizaciones de seguridad" } };
  }

  if (h.area === "respaldos" && (h.id === "copia_vieja" || h.id === "sin_copias")) {
    return { cubeta: "proponer", propuesta: { tipo: "accion", accion: "respaldar", objetivo: "", etiqueta: "Hacer una copia ahora" } };
  }

  if (h.area === "servicios" && /^(caido_|enfermo_)/.test(h.id)) {
    const nombre = h.id.replace(/^(caido_|enfermo_)/, "");
    const confirmar = /mariadb|chromadb|proxy/.test(nombre) ? "REINICIAR" : null;
    return { cubeta: "proponer", propuesta: { tipo: "accion", accion: "reiniciar_contenedor", objetivo: nombre, confirmar, etiqueta: `Reiniciar ${nombreClaro(nombre)}` } };
  }

  if (h.area === "base_datos" && h.id === "fragmentacion" && h.severidad !== "ok") {
    return { cubeta: "proponer", propuesta: { tipo: "accion", accion: "optimizar", objetivo: "", etiqueta: "Desfragmentar y limpiar" } };
  }

  if (h.area === "base_datos" && h.id === "sugerencias_pendientes" && h.severidad !== "ok") {
    return { cubeta: "proponer", propuesta: { tipo: "ir", vista: "optimizacion", etiqueta: "Ver índices sugeridos" } };
  }

  if (h.area === "respaldos" && h.id === "drive_permiso") {
    return { cubeta: "proponer", propuesta: { tipo: "ir", vista: "copias", etiqueta: "Volver a autorizar Drive" } };
  }

  if (h.area === "servicios" && h.id === "bot_mudo") {
    return { cubeta: "proponer", propuesta: { tipo: "ir", vista: "sos", etiqueta: "Revisar y reparar (SOS)" } };
  }

  if (h.area === "tareas" && /^latido_/.test(h.id)) {
    return { cubeta: "proponer", propuesta: { tipo: "ir", vista: "inicio", ancla: "card-latidos", etiqueta: "Ver tareas programadas" } };
  }

  return { cubeta: "reportar" };
}

// ── §1.7 — comparación con la corrida anterior (pura, exportada) ────────────

function comparar(actual, anterior) {
  if (!anterior) return null;
  const hActual = actual && Array.isArray(actual.hallazgos) ? actual.hallazgos : [];
  const hAnterior = Array.isArray(anterior.hallazgos) ? anterior.hallazgos : [];
  const porClaveAnterior = new Map(hAnterior.map((h) => [h.clave, h]));
  const porClaveActual = new Map(hActual.map((h) => [h.clave, h]));

  const nuevos = [];
  const empeoraron = [];
  for (const [clave, h] of porClaveActual) {
    const prev = porClaveAnterior.get(clave);
    if (h.severidad !== "ok" && (!prev || prev.severidad === "ok")) nuevos.push(clave);
    if (prev && prev.severidad === "atencion" && h.severidad === "urgente") empeoraron.push(clave);
  }

  const resueltos = [];
  for (const [clave, h] of porClaveAnterior) {
    if (h.severidad === "ok") continue;
    const cur = porClaveActual.get(clave);
    if (!cur || cur.severidad === "ok") resueltos.push(clave);
  }

  const notaActual = actual && typeof actual.nota_global === "number" ? actual.nota_global : null;
  const notaAnterior = typeof anterior.nota_global === "number" ? anterior.nota_global : null;
  const delta = notaActual !== null && notaAnterior !== null ? notaActual - notaAnterior : null;

  return {
    anterior_id: anterior.id,
    anterior_ts: anterior.ts,
    nota_anterior: notaAnterior,
    delta,
    nuevos, resueltos, empeoraron,
  };
}

// ── §1.8 — texto de WhatsApp (pura, exportada) ───────────────────────────────

/**
 * Arma el mensaje de WhatsApp de una corrida ya consolidada, aplicada y
 * comparada (`corrida` con `.nota_global`, `.comparacion`, `.hallazgos`
 * (con `.cubeta`/`.propuesta`), `.aplicado`, `.areas`). Decidir SI se manda
 * es responsabilidad de la instancia (§1.8, frenos de permisos/modo viaje);
 * esta función solo redacta.
 */
function textoWhatsapp(corrida) {
  corrida = corrida || {};
  const hallazgos = Array.isArray(corrida.hallazgos) ? corrida.hallazgos : [];
  const comp = corrida.comparacion || null;
  const areas = corrida.areas || {};
  const lineas = [];

  const nota = corrida.nota_global;
  const notaTxt = nota === null || nota === undefined ? "sin calcular" : `${nota} de 10`;
  if (comp && typeof comp.nota_anterior === "number") {
    lineas.push(`Auditoría completa del servidor — nota ${notaTxt} (ayer ${comp.nota_anterior})`);
  } else {
    lineas.push(`Auditoría completa del servidor — nota ${notaTxt}`);
  }
  lineas.push("");

  if (comp && typeof comp.delta === "number" && comp.delta < 0) {
    const claves = [...new Set([...(comp.nuevos || []), ...(comp.empeoraron || [])])];
    const areasBajaron = [...new Set(claves.map((c) => c.split(":")[0]))].filter((a) => areas[a]);
    if (areasBajaron.length) {
      const partes = areasBajaron.map((a) => `${NOMBRE_AREA_LLANO[a] || a} (${areas[a].nota}/10)`);
      lineas.push(`Bajó por: ${partes.join(" y ")}.`);
      lineas.push("");
    }
  }

  const clavesNuevas = new Set((comp && comp.nuevos) || []);
  const nuevosUrgentes = hallazgos.filter((h) => h.severidad === "urgente" && (clavesNuevas.has(h.clave) || !comp));
  if (nuevosUrgentes.length) {
    lineas.push("Nuevo y urgente:");
    for (const h of nuevosUrgentes) lineas.push(`• ${h.significado}`);
    lineas.push("");
  }

  const aplicados = (corrida.aplicado || []).filter((a) => a.ok);
  if (aplicados.length) {
    lineas.push("Lo que arreglé sola:");
    for (const a of aplicados) lineas.push(`• ${a.mensaje}`);
    lineas.push("");
  }

  const propuestos = hallazgos.filter((h) => h.cubeta === "proponer" && h.propuesta && h.propuesta.etiqueta);
  if (propuestos.length) {
    lineas.push("Pendiente de un clic tuyo (en el panel):");
    for (const h of propuestos) lineas.push(`• ${h.propuesta.etiqueta}`);
    lineas.push("");
  }

  lineas.push("panel.ejemplo.com");

  return lineas.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ── Fábrica ───────────────────────────────────────────────────────────────

function crearAuditoria360(deps) {
  deps = deps || {};
  const {
    sh, auditar, enviarWhatsapp, DIR_DATOS, leerJson, guardarJson, leerJsonl, anexar,
    estadoGeneral, prediccion, estadoRespaldos, leerDisco, ejecutarAccion,
    seguridadCompleta, optimizacionCompleta, configDrift, latidos, sos, seguridadAuditoria,
  } = deps;

  const OBLIGATORIAS = {
    sh, auditar, enviarWhatsapp, DIR_DATOS, leerJson, guardarJson, leerJsonl, anexar,
    estadoGeneral, prediccion, estadoRespaldos, leerDisco, ejecutarAccion,
    seguridadCompleta, optimizacionCompleta, configDrift, latidos, sos, seguridadAuditoria,
  };
  for (const [nombre, valor] of Object.entries(OBLIGATORIAS)) {
    if (valor === undefined || valor === null) {
      throw new Error(`crearAuditoria360 necesita '${nombre}'`);
    }
  }

  // Opcionales con degradación (§1.2): si faltan reglasSeguridad/permisos, la
  // cubeta "aplicar" queda desactivada — nunca al revés.
  const simulacros = deps.simulacros || null;
  const observacionDespliegue = deps.observacionDespliegue || null;
  const reglasSeguridad = deps.reglasSeguridad || null;
  const permisos = deps.permisos || null;
  const kapsoYModo = deps.kapsoYModo || null;
  const F_MODO = deps.F_MODO || null;
  const ahora = typeof deps.ahora === "function" ? deps.ahora : Date.now;
  const HORA_REINICIO_UTC = typeof deps.HORA_REINICIO_UTC === "number" ? deps.HORA_REINICIO_UTC : 9;
  const HORA_RESPALDO_UTC = typeof deps.HORA_RESPALDO_UTC === "number" ? deps.HORA_RESPALDO_UTC : 8;

  const aplicarDisponible = !!(reglasSeguridad && permisos);

  // Gate interno (§1.2): comparte sos.limites, así el enfriamiento de 30 min
  // de liberar_disco es el MISMO contador que usa el SOS.
  const { puedeActuar } = crearPuedeActuar({
    limites: sos.limites,
    reglasSeguridad,
    permisos,
    contenedoresPropios: CONTENEDORES_PROPIOS,
    categoriaPorPeldano: { liberar_disco: "disco" },
    horaReinicioUtc: HORA_REINICIO_UTC,
    horaRespaldoUtc: HORA_RESPALDO_UTC,
    ahora,
  });

  const DIR_MODULO = path.join(DIR_DATOS, "auditoria360");
  const DIR_EVENTOS = path.join(DIR_MODULO, "eventos");
  const RUTA_ULTIMA = path.join(DIR_MODULO, "ultima.json");
  const RUTA_HISTORIAL = path.join(DIR_MODULO, "historial.jsonl");
  try { fs.mkdirSync(DIR_MODULO, { recursive: true }); } catch (_) {}

  const bus = crearBus({ dirEventos: DIR_EVENTOS, enCurso: (id) => enCursoId === id });

  let enCursoId = null;
  let corridaEnCurso = null; // {run_id, inicio, fase}
  let corridaPromesa = null;
  let ultimoDiaEjecutado = null; // "YYYY-MM-DD" (UTC) — para quizaCorridaDiaria

  function fase(f) { if (corridaEnCurso) corridaEnCurso.fase = f; }

  // ── §1.4.1 — rechazo previo ────────────────────────────────────────────
  function motivoRechazo() {
    if (enCursoId) return "Ya hay una auditoría 360 en curso; espera a que termine.";
    if (sos.estado().en_curso) return "Hay un SOS en curso; espera a que termine.";
    if (simulacros && typeof simulacros.estado === "function" && simulacros.estado().en_curso) {
      return "Hay un simulacro en curso; espera a que termine.";
    }
    if (seguridadCompleta.estado().en_curso) return "Hay una auditoría de seguridad en curso; espera a que termine.";
    if (optimizacionCompleta.estado().en_curso) return "Hay una auditoría de base de datos en curso; espera a que termine.";
    return null;
  }

  // ── Ola A (§1.4.2) ──────────────────────────────────────────────────────
  async function correrOlaA(runId) {
    bus.emitirEvento(runId, undefined, "paso", "info", "Revisando seguridad, configuración, capacidad, servicios, respaldos y tareas…");

    const enVentanaExcluida = !!(observacionDespliegue && typeof observacionDespliegue.estado === "function" && observacionDespliegue.estado().en_curso);

    const nombres = ["seguridad_auditoria", "config_drift", "prediccion", "estado_general", "latidos", "estado_respaldos"];
    const promesas = [
      conTope(envolver(() => seguridadAuditoria.auditoriaCompleta(sh)), TOPE_FUENTE_MS),
      conTope(envolver(() => configDrift.revisarDrift(sh, { enVentanaExcluida })), TOPE_FUENTE_MS),
      conTope(envolver(() => prediccion()), TOPE_FUENTE_MS),
      conTope(envolver(() => estadoGeneral()), TOPE_FUENTE_MS),
      conTope(envolver(() => latidos.estadoLatidos()), TOPE_FUENTE_MS),
      conTope(envolver(() => estadoRespaldos()), TOPE_FUENTE_MS),
    ];
    const resultados = await Promise.allSettled(promesas);

    const fuentes = {};
    resultados.forEach((r, i) => {
      const nombre = nombres[i];
      if (r.status !== "fulfilled") { fuentes[claveFuente(nombre)] = { ok: false }; return; }
      const valor = r.value;
      if (nombre === "seguridad_auditoria") fuentes.seguridad_auditoria = { ok: true, hallazgos: (valor && valor.hallazgos) || [] };
      else if (nombre === "config_drift") fuentes.config_drift = { ok: true, hallazgo: valor };
      else if (nombre === "prediccion") fuentes.prediccion = { ok: true, valor };
      else if (nombre === "estado_general") fuentes.estado_general = { ok: true, valor };
      else if (nombre === "latidos") fuentes.latidos = { ok: true, valor };
      else if (nombre === "estado_respaldos") fuentes.estado_respaldos = { ok: true, valor };
    });
    return fuentes;
  }
  function claveFuente(nombre) { return nombre; }

  // ── Ola B (§1.4.3) ──────────────────────────────────────────────────────
  async function correrOlaB(runId) {
    bus.emitirEvento(runId, undefined, "paso", "info", "Revisando la seguridad completa del servidor…");
    let fSegCompleta;
    try {
      const r = await seguridadCompleta.ejecutar("agente");
      fSegCompleta = (r && r.ok) ? { ok: true, hallazgos: r.resumen.hallazgos } : { ok: false };
    } catch (_) {
      fSegCompleta = { ok: false };
    }

    bus.emitirEvento(runId, undefined, "paso", "info", "Revisando la base de datos…");
    let fOptCompleta;
    try {
      const r = await optimizacionCompleta.ejecutar("agente");
      if (r && r.ok) {
        const resumen = await conTopeSuave(optimizacionCompleta.esperar(), TOPE_ESPERA_BD_MS, null);
        fOptCompleta = resumen ? { ok: true, hallazgos: resumen.hallazgos } : { ok: false };
      } else {
        fOptCompleta = { ok: false };
      }
    } catch (_) {
      fOptCompleta = { ok: false };
    }

    return { seguridad_completa: fSegCompleta, optimizacion_completa: fOptCompleta };
  }

  // ── §1.6 — aplicar solo (única acción autónoma) ─────────────────────────
  async function aplicarSolo(runId, hallazgos) {
    const aplicado = [];
    const bloqueado = [];
    const discoH = hallazgos.find((h) => h.clave === "capacidad:disco");
    if (!discoH || discoH.cubeta !== "aplicar") return { aplicado, bloqueado };

    if (!aplicarDisponible) {
      // Sin reglasSeguridad/permisos no hay gate completo: nunca se actúa
      // sola, se pasa directo a proponer (§1.2, degradación).
      discoH.cubeta = "proponer";
      discoH.propuesta = { tipo: "accion", accion: "optimizar", objetivo: "", etiqueta: "Liberar espacio en disco" };
      bloqueado.push({ accion: "optimizar", motivo: "Faltan reglas de seguridad o permisos: no se puede verificar el gate.", fuente: "config" });
      return { aplicado, bloqueado };
    }

    const chk = puedeActuar({ peldano: "liberar_disco" }, { incidenteSosId: null });
    if (!chk.ok) {
      bloqueado.push({ accion: "optimizar", motivo: chk.mensaje, fuente: chk.fuente });
      discoH.cubeta = "proponer";
      discoH.propuesta = { tipo: "accion", accion: "optimizar", objetivo: "", etiqueta: "Liberar espacio en disco" };
      return { aplicado, bloqueado };
    }

    bus.emitirEvento(runId, undefined, "paso", "info", "Liberando espacio en disco…");
    let res;
    try {
      res = await conTope(envolver(() => ejecutarAccion("optimizar")), TOPE_LIBERAR_DISCO_MS);
    } catch (e) {
      res = { ok: false, mensaje: "No se pudo liberar espacio: " + e.message };
    }
    sos.limites.registrar("liberar_disco", {});
    auditar("auditoria360_aplicado", "agente", res && res.ok ? "ok" : "falló", "optimizar: " + ((res && res.mensaje) || ""));
    aplicado.push({
      accion: "optimizar", ok: !!(res && res.ok), mensaje: (res && res.mensaje) || "",
      liberado_mb: res && res.liberado_mb, antes: res && res.antes, despues: res && res.despues,
      ts: new Date(ahora()).toISOString(),
    });

    if (res && res.ok) {
      try {
        const d = await envolver(() => leerDisco());
        if (d && typeof d.pct === "number" && d.pct < 80) {
          discoH.severidad = "ok";
          discoH.significado = `Liberé ${res.liberado_mb} MB (de ${res.antes}% a ${d.pct}%).`;
          discoH.cubeta = "reportar";
          delete discoH.propuesta;
        }
      } catch (_) { /* si no se pudo releer, el hallazgo se deja como estaba */ }
    }

    return { aplicado, bloqueado };
  }

  // ── §1.8 — envío de WhatsApp (decide + redacta con textoWhatsapp) ───────
  function decidirMotivoEnvio(corrida) {
    const urgentesActuales = corrida.hallazgos.filter((h) => h.severidad === "urgente");
    if (!corrida.comparacion) {
      return urgentesActuales.length ? "urgente_nuevo" : null;
    }
    const bajoNota = typeof corrida.nota_global === "number" && typeof corrida.comparacion.nota_anterior === "number"
      && corrida.nota_global < corrida.comparacion.nota_anterior;
    const urgenteNuevo = urgentesActuales.some((h) => corrida.comparacion.nuevos.includes(h.clave));
    if (bajoNota) return "nota_bajo";
    if (urgenteNuevo) return "urgente_nuevo";
    return null;
  }

  async function enviarSiHaceFalta(corrida) {
    const motivo = decidirMotivoEnvio(corrida);
    if (!motivo) return { enviado: false, motivo: "sin_disparador" };

    if (permisos && !permisos.permitido("whatsapp", "escritura")) {
      return { enviado: false, motivo: "sin_permiso_whatsapp" };
    }

    if (kapsoYModo && F_MODO) {
      const modo = kapsoYModo.obtenerModo(leerJson, F_MODO);
      const nivel = motivo === "nota_bajo" ? "warn" : "crit";
      if (kapsoYModo.debeSilenciar(nivel, modo)) {
        return { enviado: false, motivo: "silenciado_modo_viaje" };
      }
    }

    const texto = textoWhatsapp(corrida);
    const r = await enviarWhatsapp(texto);
    return { enviado: !!(r && r.ok), motivo };
  }

  // ── limpieza de eventos > 30 días (§1.9) ─────────────────────────────────
  function limpiarEventosViejos() {
    try {
      const limite = Date.now() - DIAS_CONSERVAR_EVENTOS * 86400000;
      for (const archivo of fs.readdirSync(DIR_EVENTOS)) {
        const ruta = path.join(DIR_EVENTOS, archivo);
        try {
          const st = fs.statSync(ruta);
          if (st.mtimeMs < limite) fs.unlinkSync(ruta);
        } catch (_) { /* archivo ya no existe u otro proceso lo tocó */ }
      }
    } catch (_) { /* directorio aún no existe: nada que limpiar */ }
  }

  // ── historial.jsonl recortado a 60 líneas (§1.9) ─────────────────────────
  function anexarHistorial(entrada) {
    anexar(RUTA_HISTORIAL, entrada);
    try {
      const lineas = leerJsonl(RUTA_HISTORIAL, MAX_HISTORIAL_LINEAS * 20);
      const ultimas = lineas.slice(-MAX_HISTORIAL_LINEAS);
      fs.writeFileSync(RUTA_HISTORIAL, ultimas.map((l) => JSON.stringify(l)).join("\n") + (ultimas.length ? "\n" : ""));
    } catch (_) { /* si falla el recorte, la próxima corrida lo reintenta */ }
  }

  // ── §1.4 — flujo completo de una corrida ─────────────────────────────────
  async function correr(runId, quien) {
    const inicioMs = ahora();
    bus.emitirEvento(runId, undefined, "inicio", "info", "Empezando la auditoría completa del servidor…");

    const fuentesA = await correrOlaA(runId);
    const fuentesB = await correrOlaB(runId);
    const fuentes = { ...fuentesA, ...fuentesB };

    fase("consolidando");
    const { hallazgos, fuentes_fallidas, areas_fallidas } = consolidar(fuentes);

    for (const h of hallazgos) {
      const { cubeta, propuesta } = clasificarCubeta(h);
      h.cubeta = cubeta;
      if (propuesta) h.propuesta = propuesta;
    }

    fase("aplicando");
    const { aplicado, bloqueado } = await aplicarSolo(runId, hallazgos);

    const { areas, nota_global, etiqueta } = calcularNotas(hallazgos, areas_fallidas);

    const anterior = leerJson(RUTA_ULTIMA, null);
    const finMs = ahora();

    const corrida = {
      id: runId,
      ts: new Date(inicioMs).toISOString(),
      fin: new Date(finMs).toISOString(),
      quien,
      duracion_s: Math.round((finMs - inicioMs) / 1000),
      nota_global, etiqueta,
      parcial: fuentes_fallidas.length > 0,
      fuentes_fallidas,
      areas,
      hallazgos,
      aplicado,
      bloqueado,
    };
    corrida.comparacion = comparar(corrida, anterior);

    fase("enviando_whatsapp");
    corrida.whatsapp = await enviarSiHaceFalta(corrida);

    guardarJson(RUTA_ULTIMA, corrida);
    anexarHistorial({
      id: corrida.id, ts: corrida.ts, quien: corrida.quien, nota_global: corrida.nota_global,
      areas: Object.fromEntries(AREAS.map((a) => [a, areas[a].nota])),
      urgentes: hallazgos.filter((h) => h.severidad === "urgente").length,
      atencion: hallazgos.filter((h) => h.severidad === "atencion").length,
      aplicadas: aplicado.length,
      parcial: corrida.parcial,
    });
    auditar("auditoria360", quien, nota_global == null ? "parcial" : String(nota_global),
      `urgentes ${hallazgos.filter((h) => h.severidad === "urgente").length}, aplicadas ${aplicado.length}`);

    limpiarEventosViejos();

    const mensajeFin = nota_global == null
      ? "Auditoría terminada: no se pudo calcular la nota (revisión parcial)."
      : `Auditoría terminada: nota ${nota_global}/10.`;
    bus.emitirFin(runId, undefined, mensajeFin, corrida);

    return corrida;
  }

  // ── API pública de la instancia (§1.3) ───────────────────────────────────

  async function ejecutar(quien) {
    const motivo = motivoRechazo();
    if (motivo) return { ok: false, code: 409, mensaje: motivo };

    const runId = `a360-${ahora()}`;
    enCursoId = runId;
    corridaEnCurso = { run_id: runId, inicio: new Date(ahora()).toISOString(), fase: "iniciando" };

    corridaPromesa = correr(runId, quien)
      .catch((e) => {
        bus.emitirFin(runId, undefined, "La auditoría se interrumpió: " + e.message, null);
        return null;
      })
      .finally(() => {
        enCursoId = null;
        corridaEnCurso = null;
      });

    return { ok: true, run_id: runId };
  }

  function esperar() { return corridaPromesa || Promise.resolve(null); }

  function estado() {
    return {
      en_curso: corridaEnCurso ? { ...corridaEnCurso } : null,
      ultima: leerJson(RUTA_ULTIMA, null),
    };
  }

  function historial() {
    return leerJsonl(RUTA_HISTORIAL, MAX_HISTORIAL_LINEAS);
  }

  function vivo(runId, res, desde) {
    return bus.suscribir(runId, res, desde);
  }

  async function quizaCorridaDiaria() {
    const nowMs = ahora();
    const hoy = new Date(nowMs).toISOString().slice(0, 10);
    if (ultimoDiaEjecutado === hoy) return;
    if (new Date(nowMs).getUTCHours() !== TAREA_LATIDO.hora_utc) return;
    ultimoDiaEjecutado = hoy; // marcar antes de esperar: evita doble disparo en el mismo tick

    try {
      const r = await ejecutar("agente");
      if (!r.ok) {
        latidos.registrar(TAREA_LATIDO.id, { ok: false, detalle: r.mensaje || "no se pudo iniciar" }, "agente");
        return;
      }
      const corrida = await esperar();
      latidos.registrar(TAREA_LATIDO.id, { ok: true, detalle: corrida ? `nota ${corrida.nota_global}` : "sin resultado" }, "agente");
    } catch (e) {
      latidos.registrar(TAREA_LATIDO.id, { ok: false, detalle: e.message }, "agente");
    }
  }

  return { ejecutar, esperar, estado, historial, vivo, quizaCorridaDiaria };
}

module.exports = {
  crearAuditoria360,
  TAREA_LATIDO,
  consolidar,
  calcularNotas,
  clasificarCubeta,
  comparar,
  textoWhatsapp,
};
