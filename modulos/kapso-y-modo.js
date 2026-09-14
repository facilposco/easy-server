"use strict";
/**
 * Centinela Zeus — envíos y avisos: latencia de la API de Kapso (Top-10 #9),
 * alertas de gasto de WhatsApp (Top-10 #10) y modo viaje (Top-10 #4).
 *
 * Los tres viven en un solo archivo porque son pequeños y comparten el
 * mismo tema. #9 y #10 además comparten el mismo punto de enganche: la
 * función `postKapso(payload)` de ops-server.js, por donde pasan TODOS los
 * envíos salientes a Kapso (el mensaje de texto directo y, si Meta lo
 * rechaza por la ventana de 24 horas, el reintento con plantilla que hace
 * `enviarWhatsapp`). Envolver ese único punto mide la latencia y cuenta el
 * gasto sin tocar `enviarWhatsapp` ni `postKapso`.
 *
 * Aislado a propósito: nada de aquí corre solo. `envolverPostKapso` no
 * mide ni cuenta nada hasta que ops-server.js sustituye su `postKapso` por
 * el que devuelve esta función (ver INTEGRACION-OBSERVABILIDAD.md). Recibe
 * `postKapso`, `anexar`, `leerJson`, `guardarJson` como parámetros, mismo
 * patrón de bajo acoplamiento que ya usan `db-optimizacion.js` y
 * `seguridad-auditoria.js`.
 */

// ── #9 · Latencia de la API de Kapso ─────────────────────────────────────

const MAX_LINEAS_LATENCIA = 5000; // varios días de envíos; de sobra para graficar

/**
 * Envuelve `postKapso` (de ops-server.js) para medir cuánto tarda cada
 * llamada real a Kapso y, de paso, contar el envío para la alerta de gasto
 * (#10). Devuelve una función con la MISMA firma que `postKapso(payload)`,
 * lista para sustituir a la original.
 *
 * @param {Function} postKapsoOriginal   postKapso(payload) tal cual existe hoy en ops-server.js
 * @param {Object}   deps
 * @param {Function} deps.anexar         anexar(archivo, obj) de ops-server.js
 * @param {Function} deps.leerJson       leerJson(archivo, porDefecto) de ops-server.js
 * @param {Function} deps.guardarJson    guardarJson(archivo, obj) de ops-server.js
 * @param {string}   deps.rutaLatencia   ruta al .jsonl de latencia, p.ej. path.join(DIR_DATOS,"latencia-kapso.jsonl")
 * @param {string}   deps.rutaGasto      ruta al .json del contador de gasto, p.ej. path.join(DIR_DATOS,"gasto-wsp.json")
 * @param {Function} [deps.alGastoAnomalo]  callback(estado) opcional; se llama como mucho una vez por hora cuando la tasa de envíos dispara
 */
function envolverPostKapso(postKapsoOriginal, deps) {
  if (typeof postKapsoOriginal !== "function") {
    throw new Error("envolverPostKapso necesita la función postKapso() de ops-server.js");
  }
  const { anexar, leerJson, guardarJson, rutaLatencia, rutaGasto, alGastoAnomalo } = deps || {};
  if (typeof anexar !== "function" || typeof leerJson !== "function" || typeof guardarJson !== "function") {
    throw new Error("envolverPostKapso necesita anexar(), leerJson() y guardarJson() de ops-server.js");
  }
  if (!rutaLatencia || !rutaGasto) {
    throw new Error("envolverPostKapso necesita rutaLatencia y rutaGasto");
  }

  return async function postKapsoMedido(payload) {
    const inicio = Date.now();
    const resultado = await postKapsoOriginal(payload);
    const ms = Date.now() - inicio;

    try {
      anexar(rutaLatencia, {
        ts: new Date().toISOString(),
        ms,
        ok: !!(resultado && resultado.ok),
        tipo: (payload && payload.type) || "desconocido",
      });
    } catch (_) { /* nunca romper el envío real por un fallo al medir */ }

    try {
      const estado = registrarEnvio(leerJson, guardarJson, rutaGasto);
      if (estado.anomalo && typeof alGastoAnomalo === "function") alGastoAnomalo(estado);
    } catch (_) { /* idem */ }

    return resultado;
  };
}

/**
 * Resume la serie de latencia ya persistida: últimas muestras, promedio y
 * máximo de la última hora, y cuántos fallos hubo. Solo lee: no recorta ni
 * escribe el archivo (el recorte natural lo da el límite de `leerJsonl`).
 *
 * @param {Function} leerJsonl   leerJsonl(archivo, max) de ops-server.js
 * @param {string}   rutaLatencia
 */
function resumenLatencia(leerJsonl, rutaLatencia) {
  if (typeof leerJsonl !== "function") throw new Error("resumenLatencia necesita la función leerJsonl() de ops-server.js");
  const serie = leerJsonl(rutaLatencia, MAX_LINEAS_LATENCIA);
  const haceUnaHora = Date.now() - 3600000;
  const ultimaHora = serie.filter((m) => m && m.ts && new Date(m.ts).getTime() >= haceUnaHora);

  const promedio = (lista) => (lista.length ? Math.round(lista.reduce((a, m) => a + (m.ms || 0), 0) / lista.length) : null);
  const maximo = (lista) => (lista.length ? Math.max(...lista.map((m) => m.ms || 0)) : null);
  const fallos = ultimaHora.filter((m) => !m.ok).length;

  return {
    muestras_total: serie.length,
    ultima_hora: {
      envios: ultimaHora.length,
      promedio_ms: promedio(ultimaHora),
      maximo_ms: maximo(ultimaHora),
      fallos,
    },
    // Serie corta para graficar sin cargar todo a memoria del lado del panel.
    serie: serie.slice(-200).map((m) => ({ ts: m.ts, ms: m.ms, ok: m.ok })),
    generado: new Date().toISOString(),
  };
}

// ── #10 · Alertas de costo de WhatsApp ───────────────────────────────────

// Un negocio normal manda unas pocas decenas de mensajes por hora como
// mucho. Un bucle de reenvíos (por ejemplo el bot respondiéndose solo)
// puede disparar esto a cientos en minutos y quemar saldo de Kapso. El
// umbral es conservador a propósito: mejor un aviso de más que uno de menos.
const UMBRAL_ENVIOS_HORA = 60;

/** Trunca a la hora (UTC) para un contador "por hora" simple. */
function horaActualIso() {
  return new Date().toISOString().slice(0, 13); // "2026-09-12T14"
}

/**
 * Suma un envío al contador de la hora actual y decide si la tasa es
 * anómala. Se guarda en disco para sobrevivir a un reinicio del proceso,
 * igual que `leerGastoIA`/`guardarGastoIA` ya hacen en ops-server.js para
 * el gasto de consultas a la IA.
 */
function registrarEnvio(leerJson, guardarJson, rutaGasto) {
  const horaActual = horaActualIso();
  let g = leerJson(rutaGasto, { hora: "", envios: 0, avisado_hora: "" });
  if (g.hora !== horaActual) g = { hora: horaActual, envios: 0, avisado_hora: g.avisado_hora || "" };

  g.envios += 1;
  // Como mucho un aviso por hora, para no terminar avisando por WhatsApp de
  // que se están mandando demasiados WhatsApp.
  const anomalo = g.envios >= UMBRAL_ENVIOS_HORA && g.avisado_hora !== horaActual;
  if (anomalo) g.avisado_hora = horaActual;

  guardarJson(rutaGasto, g);
  return { hora: horaActual, envios: g.envios, umbral: UMBRAL_ENVIOS_HORA, anomalo };
}

/** Estado actual del contador para el endpoint del panel. Solo lee. */
function estadoGasto(leerJson, rutaGasto) {
  const horaActual = horaActualIso();
  const g = leerJson(rutaGasto, { hora: "", envios: 0, avisado_hora: "" });
  const envios = g.hora === horaActual ? g.envios : 0;
  const nivel = envios >= UMBRAL_ENVIOS_HORA ? "crit" : envios >= Math.round(UMBRAL_ENVIOS_HORA * 0.7) ? "warn" : "ok";
  return {
    hora: horaActual,
    envios_esta_hora: envios,
    umbral: UMBRAL_ENVIOS_HORA,
    nivel,
    mensaje: nivel === "crit"
      ? `Se enviaron ${envios} mensajes en la última hora, muy por encima de lo normal. Puede haber un bucle mandando WhatsApps de más.`
      : nivel === "warn"
        ? `${envios} mensajes enviados en la última hora, acercándose al límite de aviso (${UMBRAL_ENVIOS_HORA}).`
        : `${envios} mensajes enviados en la última hora, dentro de lo normal.`,
    generado: new Date().toISOString(),
  };
}

// ── #4 · Modo viaje ───────────────────────────────────────────────────────

/**
 * Lee la bandera de modo viaje. Si el archivo todavía no existe, el modo
 * viaje está apagado (comportamiento actual, sin cambios de conducta).
 */
function obtenerModo(leerJson, rutaModo) {
  const m = leerJson(rutaModo, { activo: false, desde: null, motivo: "" });
  return { activo: !!m.activo, desde: m.desde || null, motivo: m.motivo || "" };
}

/** Enciende o apaga el modo viaje y lo persiste. */
function fijarModo(guardarJson, rutaModo, activo, motivo) {
  const m = {
    activo: !!activo,
    desde: activo ? new Date().toISOString() : null,
    motivo: activo ? String(motivo || "").slice(0, 200) : "",
  };
  guardarJson(rutaModo, m);
  return m;
}

/**
 * Decide si un aviso debe silenciarse por estar en modo viaje. Regla del
 * diseño: en modo viaje solo se notifican caídas totales que el agente NO
 * pudo resolver por su cuenta; todo lo demás (memoria/disco altos,
 * incidentes que ya se auto-recuperaron, avisos informativos) se silencia.
 *
 * @param {string} nivel     "info" | "ok" | "warn" | "crit" — mismo vocabulario que ya usan los avisos de estadoGeneral()
 * @param {Object} modo      lo que devuelve obtenerModo()
 * @param {Object} [opciones]
 * @param {boolean} [opciones.autoRemediable]  true si el propio agente ya resolvió esto o puede resolverlo solo (p.ej. reinició el contenedor)
 * @returns {boolean} true si el aviso NO debe enviarse
 */
function debeSilenciar(nivel, modo, opciones) {
  if (!modo || !modo.activo) return false;
  if (nivel !== "crit") return true; // info/ok/warn: siempre se silencian en modo viaje
  return !!(opciones && opciones.autoRemediable); // crit: solo se silencia si ya se resolvió sola
}

module.exports = {
  envolverPostKapso,
  resumenLatencia,
  registrarEnvio,
  estadoGasto,
  obtenerModo,
  fijarModo,
  debeSilenciar,
  UMBRAL_ENVIOS_HORA,
};
