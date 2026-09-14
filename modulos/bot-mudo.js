"use strict";
/**
 * modulos/bot-mudo.js
 *
 * Centinela Zeus — detector de "bot mudo": el bot puede estar `running`, con
 * `/dashboard` en 200 y el webhook firmado en 200, y aun así no responderle
 * a ningún cliente real (pasó en producción: los modelos de OpenRouter
 * configurados ya no existían). Ningún chequeo de contenedor mira eso — este
 * módulo sí. "Encendido no es lo mismo que atendiendo" (CLAUDE.md, paso 9).
 *
 * Aislado a propósito: nada de aquí corre solo. Nunca hace `require` de
 * ops-server.js; recibe `DIR_DATOS`, `leerJson`, `guardarJson`, `auditar`,
 * `enviarWhatsapp`, `sh` (obligatorias) y `permisos`, `kapsoYModo`, `F_MODO`,
 * `reglasSeguridad`, `ahora` (opcionales) como parámetros — mismo patrón de
 * bajo acoplamiento que `informe-semanal.js` — hasta que `ops-server.js` lo
 * construye y lo engancha a un `setInterval` (ver `INTEGRACION-BOT-MUDO.md`).
 *
 * Diseño vinculante producido en Fable 5.1 (regla de AGENTS.md: "Arquitectura
 * y diseño → Fable 5.1, siempre"). Este archivo es la implementación de ese
 * diseño: los contratos (nombres de función, forma de los datos, umbrales,
 * tabla de decisión, textos) no se cambian por iniciativa propia. La única
 * duda abierta que el diseño deja pendiente de verificar contra el
 * `ops-server.js` real (no hay copia local) es el nombre exacto de la
 * función que arma `avisos` para el panel — ver `INTEGRACION-BOT-MUDO.md`.
 *
 * 100% determinista (regla 1 del SOS en CLAUDE.md): números y umbrales,
 * nunca opinión de IA. No usa MariaDB. No depende de ningún paquete externo:
 * solo `node:path`.
 *
 * Complementa, no duplica, al detector de incidentes de contenedores de
 * `ops-server.js` (`revisarIncidentesInterno`, cada 60s): ese mira si el
 * contenedor `zeus-bot` está vivo; este mira si, estando vivo, le contesta a
 * alguien. Si `docker exec` falla o `incidentes.json` ya tiene un incidente
 * abierto para `zeus-bot`, este módulo se aparta: eso es del otro detector.
 *
 * Limitación conocida (no se resuelve, se documenta): `messagesOut` cuenta
 * cualquier mensaje que el bot mande, incluido uno programado si lo hubiera.
 * Es el dato real que existe en metrics.json; no se inventa otro.
 */

const path = require("path");

// ── Constantes (contrato del diseño) ────────────────────────────────────────

const CONTENEDOR_BOT = "zeus-bot";
const INTERVALO_MIN = 5; // cada cuánto corre quizaRevisar()
const MAX_MUESTRAS = 12; // 60 min de historia en el ring buffer
const MIN_MUESTRAS = 3; // al menos 2 intervalos observados antes de opinar
const MIN_RECIBIDOS = 2; // 1 mensaje sin respuesta puede ser un sticker/reacción; 2 ya es raro
const SILENCIO_MIN = 10; // minutos desde el primer mensaje sin respuesta para hablar de silencio real
const ENFRIAMIENTO_APERTURA_MIN = 30; // no se manda un WhatsApp de apertura más de una vez cada 30 min
const CADUCIDAD_MIN = 120; // 2 h sin poder confirmar mudez -> se cierra como "caducado"
const MAX_INTENTOS_AVISO = 3; // reintentos del WhatsApp de apertura si Kapso falla
const MAX_EDAD_MUESTRA_MIN = 60; // buffer más viejo que esto (proceso caído) se descarta
const TOLERANCIA_RELOJ_MS = 60000; // margen antes de descartar el buffer por reloj atrasado
const TIMEOUT_SH_MS = 8000; // igual que fotoDiariaMensajes en informe-semanal.js
const HORA_INICIO_UTC_DEFECTO = 13; // 08:00 Colombia — horario comercial por defecto si no hay reglasSeguridad
const HORA_FIN_UTC_DEFECTO = 1; // 20:00 Colombia (cruza medianoche UTC)

const MESES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

function plural(n, singular, plural_) { return n === 1 ? singular : plural_; }

function ESTADO_VACIO() {
  return {
    version: 1,
    ultima_revision: null, // { ts, clave, resultado, motivo, quien }
    muestras: [], // ring buffer, máx MAX_MUESTRAS, cronológico (última = más nueva)
    episodio: null,
    ultimo_episodio: null,
    ultimo_aviso_apertura_ts: null,
    lectura_fallida: null, // { desde, ultimo_ts, motivo, seguidos }
  };
}

// ── Hora en español llano (Colombia, UTC-5, sin horario de verano) ─────────

function horaColombia(iso, ahoraMs) {
  if (!iso) return "una hora sin registrar";
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return "una hora sin registrar";
  const ahora = typeof ahoraMs === "number" ? ahoraMs : Date.now();
  const co = new Date(ms - 5 * 3600000);
  const conow = new Date(ahora - 5 * 3600000);
  let h = co.getUTCHours();
  const min = co.getUTCMinutes();
  const ampm = h < 12 ? "a. m." : "p. m.";
  let h12 = h % 12; if (h12 === 0) h12 = 12;
  const horaTxt = `${h12}:${String(min).padStart(2, "0")} ${ampm}`;
  const diaCo = Date.UTC(co.getUTCFullYear(), co.getUTCMonth(), co.getUTCDate());
  const diaNow = Date.UTC(conow.getUTCFullYear(), conow.getUTCMonth(), conow.getUTCDate());
  const diffDias = Math.round((diaNow - diaCo) / 86400000);
  if (diffDias === 0) return horaTxt;
  if (diffDias === 1) return `ayer a las ${horaTxt}`;
  return `el ${co.getUTCDate()} de ${MESES[co.getUTCMonth()]} a las ${horaTxt}`;
}

// ── Funciones puras (sin sh, sin disco) ─────────────────────────────────────

/**
 * Interpreta la salida de `sh("docker exec zeus-bot cat /app/metrics.json")`
 * — mismas reglas exactas que `fotoDiariaMensajes()` de informe-semanal.js.
 */
function interpretarMetrics(resultadoSh, tsIso) {
  if (!resultadoSh || !resultadoSh.ok) return { ok: false, motivo: "docker exec falló" };
  let metrics;
  try { metrics = JSON.parse(resultadoSh.salida); } catch (_) { return { ok: false, motivo: "JSON inválido" }; }
  if (!metrics || !metrics.daily) return { ok: false, motivo: "sin campo daily" };
  const d = metrics.daily;
  const muestra = {
    ts: tsIso,
    fecha: String(d.date || ""),
    recibidos: Math.max(0, Number(d.messagesIn) || 0),
    enviados: Math.max(0, Number(d.messagesOut) || 0),
    errores: Math.max(0, Number(d.errors) || 0),
  };
  return { ok: true, muestra };
}

/**
 * Agrega una muestra al ring buffer, descartando el buffer entero cuando no
 * es comparable con lo anterior (reloj atrasado, proceso caído mucho tiempo,
 * o reinicio del contador — cambio de fecha o un contador que baja).
 */
function agregarMuestra(muestras, muestra, ahoraMs) {
  for (const m of muestras) {
    if (new Date(m.ts).getTime() > ahoraMs + TOLERANCIA_RELOJ_MS) {
      return { muestras: [muestra], motivo: "reloj" };
    }
  }
  if (muestras.length) {
    const ultima = muestras[muestras.length - 1];
    if (ahoraMs - new Date(ultima.ts).getTime() > MAX_EDAD_MUESTRA_MIN * 60000) {
      return { muestras: [muestra], motivo: "muestras_viejas" };
    }
    if (muestra.fecha !== ultima.fecha || muestra.recibidos < ultima.recibidos || muestra.enviados < ultima.enviados) {
      return { muestras: [muestra], motivo: "reinicio_contador" };
    }
  }
  const nuevas = muestras.concat([muestra]);
  while (nuevas.length > MAX_MUESTRAS) nuevas.shift();
  return { muestras: nuevas, motivo: "" };
}

/**
 * Evalúa el buffer: busca el "ancla" (última muestra donde `enviados` creció,
 * es decir la última respuesta vista) y mide cuánto quedó sin responder desde
 * ahí. Con contadores acumulados (no una serie de eventos) esto es lo único
 * que permite manejar tráfico escaso sin una ventana fija que "olvide" el
 * primer mensaje sin responder.
 */
function evaluar(muestras, ahoraMs) {
  if (!Array.isArray(muestras) || muestras.length < MIN_MUESTRAS) {
    return {
      veredicto: "sin_datos", ancla: null, ancla_real: false,
      recibidos_sin_respuesta: 0, errores_sin_respuesta: 0,
      primera_sin_respuesta_ts: null, minutos_silencio: null,
      respondio_en_ultima: false, minutos_desde_ultima_respuesta: null,
    };
  }
  let anclaIdx = 0;
  let anclaReal = false;
  for (let i = muestras.length - 1; i >= 1; i--) {
    if (muestras[i].enviados > muestras[i - 1].enviados) { anclaIdx = i; anclaReal = true; break; }
  }
  const ancla = muestras[anclaIdx];
  const ultima = muestras[muestras.length - 1];
  const recibidos_sin_respuesta = Math.max(0, ultima.recibidos - ancla.recibidos);
  const errores_sin_respuesta = Math.max(0, ultima.errores - ancla.errores);

  let primera_sin_respuesta_ts = null;
  for (let i = anclaIdx + 1; i < muestras.length; i++) {
    if (muestras[i].recibidos > ancla.recibidos) { primera_sin_respuesta_ts = muestras[i].ts; break; }
  }
  const minutos_silencio = primera_sin_respuesta_ts != null
    ? Math.round((ahoraMs - new Date(primera_sin_respuesta_ts).getTime()) / 60000)
    : null;

  const penultima = muestras[muestras.length - 2];
  const respondio_en_ultima = !!(penultima && ultima.enviados > penultima.enviados);
  const minutos_desde_ultima_respuesta = anclaReal
    ? Math.round((ahoraMs - new Date(ancla.ts).getTime()) / 60000)
    : null;

  let veredicto = "normal";
  if (recibidos_sin_respuesta >= MIN_RECIBIDOS && minutos_silencio != null && minutos_silencio >= SILENCIO_MIN) {
    veredicto = "mudo";
  } else if (recibidos_sin_respuesta >= 1 && minutos_silencio != null && minutos_silencio >= SILENCIO_MIN) {
    veredicto = "sospechoso";
  }

  return {
    veredicto, ancla, ancla_real: anclaReal,
    recibidos_sin_respuesta, errores_sin_respuesta,
    primera_sin_respuesta_ts, minutos_silencio,
    respondio_en_ultima, minutos_desde_ultima_respuesta,
  };
}

function episodioNuevo(tsIso, ev) {
  return {
    inicio: tsIso,
    primera_sin_respuesta_ts: ev.primera_sin_respuesta_ts,
    ultima_confirmacion: tsIso,
    recibidos_base: ev.ancla.recibidos,
    recibidos_previos: 0,
    errores_base: ev.ancla.errores,
    errores_previos: 0,
    recibidos_sin_respuesta: ev.recibidos_sin_respuesta,
    errores: ev.errores_sin_respuesta,
    aviso: { estado: "pendiente", motivo_pendiente: "", ts: null, intentos: 0, detalle: "" },
  };
}

function cerrarEpisodio(ep, tsIso, ahoraMs, cierre, ultimaMuestra) {
  const recibidos = ep.recibidos_previos + Math.max(0, (ultimaMuestra ? ultimaMuestra.recibidos : ep.recibidos_base) - ep.recibidos_base);
  const errores = ep.errores_previos + Math.max(0, (ultimaMuestra ? ultimaMuestra.errores : ep.errores_base) - ep.errores_base);
  const duracion_min = Math.max(0, Math.round((ahoraMs - new Date(ep.inicio).getTime()) / 60000));
  const avisado = ep.aviso.estado === "enviado" || ep.aviso.estado === "enviando";
  return { inicio: ep.inicio, fin: tsIso, cierre, duracion_min, recibidos_sin_respuesta: recibidos, errores, avisado, cierre_avisado: false };
}

/**
 * Tabla de decisión completa (pura): dado el estado persistido (ya con el
 * buffer actualizado), el veredicto de `evaluar()` y el contexto (horario,
 * permisos, modo viaje, si el contenedor está caído según incidentes.json),
 * decide si se abre/actualiza/cierra un episodio y qué WhatsApp mandar. No
 * muta la entrada.
 *
 * ctx = { ahoraMs, tsIso, ultimaMuestra, ultimaMuestraAnterior, enHorario,
 *         botCaido, permisoWhatsapp, silenciarCrit, motivoBuffer }
 */
function decidir(estadoIn, ev, ctx) {
  const estado = JSON.parse(JSON.stringify(estadoIn));
  const acciones = [];
  const { ahoraMs, tsIso } = ctx;

  if (!estado.episodio) {
    if (ev.veredicto !== "mudo") return { estado, acciones };
    if (ctx.botCaido) return { estado, acciones }; // del otro detector, no se abre nada
    estado.episodio = episodioNuevo(tsIso, ev);
    acciones.push({
      tipo: "auditar", resultado: "abierto",
      detalle: `${ev.recibidos_sin_respuesta} ${plural(ev.recibidos_sin_respuesta, "mensaje", "mensajes")} sin respuesta desde las ${horaColombia(ev.primera_sin_respuesta_ts, ahoraMs)}`,
    });
  } else {
    const ep = estado.episodio;

    if (ctx.motivoBuffer === "reinicio_contador" && ctx.ultimaMuestraAnterior) {
      ep.recibidos_previos += Math.max(0, ctx.ultimaMuestraAnterior.recibidos - ep.recibidos_base);
      ep.recibidos_base = 0;
      ep.errores_previos += Math.max(0, ctx.ultimaMuestraAnterior.errores - ep.errores_base);
      ep.errores_base = 0;
    }

    if (ev.respondio_en_ultima) {
      const cerrado = cerrarEpisodio(ep, tsIso, ahoraMs, "recuperado", ctx.ultimaMuestra);
      estado.ultimo_episodio = cerrado;
      estado.episodio = null;
      acciones.push({ tipo: "auditar", resultado: "recuperado", detalle: `${cerrado.recibidos_sin_respuesta} sin respuesta, ${cerrado.duracion_min} min` });
      if (cerrado.avisado) {
        acciones.push({ tipo: "whatsapp", clase: "recuperacion", datos: { inicio: cerrado.inicio, fin: cerrado.fin, duracion_min: cerrado.duracion_min, recibidos_sin_respuesta: cerrado.recibidos_sin_respuesta, errores: cerrado.errores, ahoraMs } });
      }
      return { estado, acciones };
    }

    if (ev.veredicto !== "mudo") {
      if (ahoraMs - new Date(ep.ultima_confirmacion).getTime() >= CADUCIDAD_MIN * 60000) {
        const cerrado = cerrarEpisodio(ep, tsIso, ahoraMs, "caducado", ctx.ultimaMuestra);
        estado.ultimo_episodio = cerrado;
        estado.episodio = null;
        acciones.push({ tipo: "auditar", resultado: "caducado", detalle: `sin confirmación desde las ${horaColombia(ep.ultima_confirmacion, ahoraMs)}` });
        if (cerrado.avisado) {
          acciones.push({ tipo: "whatsapp", clase: "caducidad", datos: { inicio: cerrado.inicio, ultima_confirmacion: ep.ultima_confirmacion, ahoraMs } });
        }
      }
      return { estado, acciones };
    }

    // sigue mudo: refresca confirmación y contadores, cae a la sección común de abajo
    ep.ultima_confirmacion = tsIso;
    ep.recibidos_sin_respuesta = ep.recibidos_previos + Math.max(0, ctx.ultimaMuestra.recibidos - ep.recibidos_base);
    ep.errores = ep.errores_previos + Math.max(0, ctx.ultimaMuestra.errores - ep.errores_base);
  }

  // Común a "recién abierto" y a "sigue mudo": decidir si toca mandar WhatsApp.
  const ep = estado.episodio;
  if (ep && (ep.aviso.estado === "pendiente" || ep.aviso.estado === "fallo")) {
    let motivo = "";
    if (ep.aviso.estado === "fallo" && ep.aviso.intentos >= MAX_INTENTOS_AVISO) motivo = "agotado";
    else if (ctx.botCaido) motivo = "bot_caido";
    else if (!ctx.enHorario) motivo = "fuera_horario";
    else if (estado.ultimo_aviso_apertura_ts && (ahoraMs - new Date(estado.ultimo_aviso_apertura_ts).getTime()) < ENFRIAMIENTO_APERTURA_MIN * 60000) motivo = "enfriamiento";
    else if (!ctx.permisoWhatsapp) motivo = "sin_permiso_whatsapp";
    else if (ctx.silenciarCrit) motivo = "silenciado_modo_viaje";

    if (motivo !== ep.aviso.motivo_pendiente) {
      if (motivo !== "") acciones.push({ tipo: "auditar", resultado: "aviso_pendiente", detalle: motivo });
      ep.aviso.motivo_pendiente = motivo;
    }
    if (motivo === "") {
      acciones.push({
        tipo: "whatsapp", clase: "apertura",
        datos: { inicio: ep.inicio, primera_sin_respuesta_ts: ep.primera_sin_respuesta_ts, recibidos_sin_respuesta: ep.recibidos_sin_respuesta, errores: ep.errores, ahoraMs },
      });
    }
  }

  return { estado, acciones };
}

// ── Textos en español llano (WhatsApp) ──────────────────────────────────────

function textoApertura(datos) {
  const hora = horaColombia(datos.primera_sin_respuesta_ts, datos.ahoraMs);
  const n = datos.recibidos_sin_respuesta;
  const lineas = [
    "🔇 Centinela: el bot no está contestando a los clientes",
    "",
    `Desde las ${hora} ${n === 1 ? "ha escrito 1 cliente" : `han escrito ${n} clientes`} y el bot no ha respondido ninguno. El bot está encendido, pero no contesta.`,
  ];
  if (datos.errores > 0) lineas.push(`Además registró ${datos.errores} ${plural(datos.errores, "error", "errores")} en ese rato.`);
  lineas.push("");
  lineas.push("Qué puedes hacer ahora:");
  lineas.push("1. Escríbele al bot desde tu celular y mira si te contesta.");
  lineas.push('2. Si no contesta, entra a panel.ejemplo.com → SOS y pulsa "Revisar y reparar".');
  lineas.push("3. Si sigue igual, revisa la cuenta del servicio de inteligencia artificial que usa el bot para contestar: es la causa más común (se venció, se quedó sin saldo o cambió el plan).");
  lineas.push("");
  lineas.push("Te aviso apenas vuelva a responder.");
  return lineas.join("\n");
}

function textoRecuperacion(datos) {
  const hIni = horaColombia(datos.inicio, datos.ahoraMs);
  const hFin = horaColombia(datos.fin, datos.ahoraMs);
  const n = datos.recibidos_sin_respuesta;
  const quienes = n === 1 ? "escribió 1 cliente" : `escribieron ${n} clientes`;
  return [
    "✅ Centinela: el bot volvió a contestar",
    "",
    `Estuvo sin responder desde las ${hIni} hasta las ${hFin} (${datos.duracion_min} min). En ese rato ${quienes} que puede que no ${n === 1 ? "haya" : "hayan"} recibido respuesta: conviene revisar${n === 1 ? "lo" : "los"} y contestar${n === 1 ? "le" : "les"} a mano.`,
    "",
    "Ya no hace falta hacer nada más con el bot.",
  ].join("\n");
}

function textoCaducidad(datos) {
  const hUlt = horaColombia(datos.ultima_confirmacion, datos.ahoraMs);
  const hIni = horaColombia(datos.inicio, datos.ahoraMs);
  return [
    "ℹ️ Centinela: cierro el aviso del bot sin contestar",
    "",
    `Desde las ${hUlt} no han entrado mensajes de clientes, así que no puedo confirmar si el bot ya contesta. Doy por terminado el aviso de las ${hIni}. Si vuelve a quedarse sin contestar, te aviso otra vez.`,
  ].join("\n");
}

const MOTIVO_LLANO = {
  fuera_horario: "te aviso en horario comercial",
  enfriamiento: "ya te avisé hace poco",
  sin_permiso_whatsapp: "los avisos por WhatsApp están apagados en Permisos",
  silenciado_modo_viaje: "modo viaje",
  bot_caido: "el bot está caído",
  agotado: "no pude mandar el WhatsApp",
  fallo: "reintentando el WhatsApp",
};
function motivoLlano(m) { return MOTIVO_LLANO[m] || "revisando"; }

function horarioPorDefecto(ahoraMs) {
  const hora = new Date(ahoraMs).getUTCHours();
  if (HORA_INICIO_UTC_DEFECTO <= HORA_FIN_UTC_DEFECTO) return hora >= HORA_INICIO_UTC_DEFECTO && hora < HORA_FIN_UTC_DEFECTO;
  return hora >= HORA_INICIO_UTC_DEFECTO || hora < HORA_FIN_UTC_DEFECTO;
}

// ── Fábrica ─────────────────────────────────────────────────────────────────

/**
 * @param {Object}   deps
 * @param {string}   deps.DIR_DATOS        "/var/lib/zeus-ops"                        — OBLIGATORIA
 * @param {Function} deps.leerJson         leerJson(archivo, porDefecto)              — OBLIGATORIA
 * @param {Function} deps.guardarJson      guardarJson(archivo, obj)                  — OBLIGATORIA
 * @param {Function} deps.auditar          auditar(accion, quien, resultado, detalle) — OBLIGATORIA
 * @param {Function} deps.enviarWhatsapp   enviarWhatsapp(texto) async → {ok, detalle} — OBLIGATORIA
 * @param {Function} deps.sh               sh(comando, timeoutMs) async → {ok, salida} — OBLIGATORIA
 * @param {Object}   [deps.permisos]       crearPermisos(...): permisos.permitido(id, tipo)
 * @param {Object}   [deps.kapsoYModo]     require("./modulos/kapso-y-modo.js")
 * @param {string}   [deps.F_MODO]         path.join(DIR_DATOS, "modo.json")
 * @param {Object}   [deps.reglasSeguridad] crearReglasSeguridad(...): reglasSeguridad.enHorarioComercial()
 * @param {Function} [deps.ahora]          () => ms epoch; por defecto Date.now — solo para pruebas
 */
function crearBotMudo(deps) {
  const { DIR_DATOS, leerJson, guardarJson, auditar, enviarWhatsapp, sh, permisos, kapsoYModo, F_MODO, reglasSeguridad } = deps || {};
  if (!DIR_DATOS || typeof leerJson !== "function" || typeof guardarJson !== "function" || typeof auditar !== "function") {
    throw new Error("crearBotMudo necesita DIR_DATOS, leerJson, guardarJson y auditar de ops-server.js");
  }
  if (typeof enviarWhatsapp !== "function" || typeof sh !== "function") {
    throw new Error("crearBotMudo necesita enviarWhatsapp() y sh() de ops-server.js");
  }
  const ahoraFn = typeof deps.ahora === "function" ? deps.ahora : () => Date.now();

  const rutas = {
    estado: path.join(DIR_DATOS, "bot-mudo.json"),
    incidentes: path.join(DIR_DATOS, "incidentes.json"),
  };

  function leer() {
    const g = leerJson(rutas.estado, null);
    if (!g || g.version !== 1 || !Array.isArray(g.muestras)) return ESTADO_VACIO();
    return g;
  }

  function detectarBotCaido() {
    try {
      const inc = leerJson(rutas.incidentes, null);
      return !!(inc && inc.abierto && inc.abierto.servicio === CONTENEDOR_BOT);
    } catch (_) { return false; }
  }

  function calcularEnHorario() {
    if (reglasSeguridad && typeof reglasSeguridad.enHorarioComercial === "function") {
      try { return !!reglasSeguridad.enHorarioComercial(); } catch (_) { /* cae al horario por defecto */ }
    }
    return horarioPorDefecto(ahoraFn());
  }

  function calcularPermisoWhatsapp() {
    if (!permisos || typeof permisos.permitido !== "function") return true;
    try { return permisos.permitido("whatsapp", "escritura") !== false; } catch (_) { return true; }
  }

  function calcularSilenciarCrit() {
    if (!kapsoYModo || !F_MODO || typeof kapsoYModo.obtenerModo !== "function" || typeof kapsoYModo.debeSilenciar !== "function") return false;
    try {
      const modo = kapsoYModo.obtenerModo(leerJson, F_MODO);
      return !!kapsoYModo.debeSilenciar("crit", modo, { autoRemediable: false });
    } catch (_) { return false; }
  }

  /**
   * Corre una revisión completa: lee metrics.json, actualiza el buffer,
   * evalúa, decide y aplica (auditar, WhatsApp). Nunca lanza: cualquier
   * fallo termina en un objeto de resultado con `ok:false`.
   */
  async function revisar(quien) {
    const quienFinal = quien || "agente";
    try {
      const ahoraMs = ahoraFn();
      const tsIso = new Date(ahoraMs).toISOString();
      const clave = tsIso.slice(0, 16);
      const est = leer();
      const botCaido = detectarBotCaido();

      let r;
      try { r = await sh(`docker exec ${CONTENEDOR_BOT} cat /app/metrics.json`, TIMEOUT_SH_MS); }
      catch (e) { r = { ok: false, salida: "", error: e && e.message }; }
      const lect = interpretarMetrics(r, tsIso);

      if (!lect.ok) {
        const primera = !est.lectura_fallida;
        est.lectura_fallida = est.lectura_fallida
          ? { ...est.lectura_fallida, ultimo_ts: tsIso, seguidos: est.lectura_fallida.seguidos + 1 }
          : { desde: tsIso, ultimo_ts: tsIso, motivo: lect.motivo, seguidos: 1 };
        if (primera) auditar("bot_mudo", quienFinal, "sin_lectura", lect.motivo);
        est.ultima_revision = { ts: tsIso, clave, resultado: "sin_lectura", motivo: lect.motivo, quien: quienFinal };
        guardarJson(rutas.estado, est);
        return { ok: false, resultado: "sin_lectura", motivo: lect.motivo, episodio: est.episodio, enviado: null };
      }

      est.lectura_fallida = null;
      const ultimaMuestraAnterior = est.muestras.length ? est.muestras[est.muestras.length - 1] : null;
      const agregado = agregarMuestra(est.muestras, lect.muestra, ahoraMs);
      est.muestras = agregado.muestras;
      const motivoBuffer = agregado.motivo;

      const ev = evaluar(est.muestras, ahoraMs);
      const ctx = {
        ahoraMs, tsIso, ultimaMuestra: lect.muestra, ultimaMuestraAnterior,
        enHorario: calcularEnHorario(), botCaido,
        permisoWhatsapp: calcularPermisoWhatsapp(), silenciarCrit: calcularSilenciarCrit(),
        motivoBuffer,
      };

      const { estado: nuevo, acciones } = decidir(est, ev, ctx);

      let resultadoFinal = ev.veredicto;
      if (botCaido && ev.veredicto === "mudo" && !nuevo.episodio) resultadoFinal = "bot_caido";
      nuevo.ultima_revision = { ts: tsIso, clave, resultado: resultadoFinal, motivo: motivoBuffer, quien: quienFinal };
      guardarJson(rutas.estado, nuevo);

      let enviado = null;
      for (const accion of acciones) {
        if (accion.tipo === "auditar") {
          auditar("bot_mudo", quienFinal, accion.resultado, accion.detalle);
          continue;
        }
        if (accion.tipo === "whatsapp" && accion.clase === "apertura") {
          nuevo.episodio.aviso.estado = "enviando";
          nuevo.episodio.aviso.motivo_pendiente = "";
          nuevo.episodio.aviso.ts = tsIso;
          nuevo.episodio.aviso.intentos += 1;
          nuevo.ultimo_aviso_apertura_ts = tsIso;
          guardarJson(rutas.estado, nuevo);
          try {
            const rw = await enviarWhatsapp(textoApertura(accion.datos));
            if (rw && rw.ok) {
              nuevo.episodio.aviso.estado = "enviado";
              nuevo.episodio.aviso.detalle = rw.detalle || "";
              auditar("bot_mudo", quienFinal, "aviso_enviado", `${accion.datos.recibidos_sin_respuesta} sin respuesta desde las ${horaColombia(accion.datos.primera_sin_respuesta_ts, ahoraMs)}`);
              enviado = "apertura";
            } else {
              nuevo.episodio.aviso.estado = "fallo";
              nuevo.episodio.aviso.detalle = (rw && rw.detalle) || "";
              if (nuevo.episodio.aviso.intentos >= MAX_INTENTOS_AVISO) nuevo.episodio.aviso.motivo_pendiente = "agotado";
              auditar("bot_mudo", quienFinal, "aviso_fallo", (rw && rw.detalle) || "sin detalle");
            }
          } catch (e) {
            nuevo.episodio.aviso.estado = "fallo";
            nuevo.episodio.aviso.detalle = e.message;
            if (nuevo.episodio.aviso.intentos >= MAX_INTENTOS_AVISO) nuevo.episodio.aviso.motivo_pendiente = "agotado";
            auditar("bot_mudo", quienFinal, "aviso_fallo", e.message);
          }
          guardarJson(rutas.estado, nuevo);
          continue;
        }
        if (accion.tipo === "whatsapp" && (accion.clase === "recuperacion" || accion.clase === "caducidad")) {
          if (!ctx.permisoWhatsapp) {
            auditar("bot_mudo", quienFinal, "sin_permiso_whatsapp", `cierre ${accion.clase}`);
            continue;
          }
          try {
            const texto = accion.clase === "recuperacion" ? textoRecuperacion(accion.datos) : textoCaducidad(accion.datos);
            const rw = await enviarWhatsapp(texto);
            if (nuevo.ultimo_episodio) nuevo.ultimo_episodio.cierre_avisado = !!(rw && rw.ok);
            auditar("bot_mudo", quienFinal, (rw && rw.ok) ? "cierre_avisado" : "cierre_fallo", accion.clase);
            if (rw && rw.ok) enviado = accion.clase;
          } catch (e) {
            if (nuevo.ultimo_episodio) nuevo.ultimo_episodio.cierre_avisado = false;
            auditar("bot_mudo", quienFinal, "cierre_fallo", accion.clase);
          }
          guardarJson(rutas.estado, nuevo);
        }
      }

      return { ok: true, resultado: nuevo.ultima_revision.resultado, motivo: motivoBuffer, episodio: nuevo.episodio, enviado };
    } catch (e) {
      try {
        const est = leer();
        est.ultima_revision = { ts: new Date(ahoraFn()).toISOString(), clave: "", resultado: "error", motivo: e.message, quien: quienFinal };
        guardarJson(rutas.estado, est);
      } catch (_) { /* no romper por no poder ni guardar el error */ }
      auditar("bot_mudo", quienFinal, "error", e.message);
      return { ok: false, resultado: "error", motivo: e.message, episodio: null, enviado: null };
    }
  }

  let enCurso = false;
  /**
   * Se llama una vez por minuto desde un setInterval (mismo patrón que
   * `quizaInformeSemanal`). Solo revisa en minutos múltiplos de
   * INTERVALO_MIN, y la clave de "ya revisé este minuto" queda persistida
   * para que un reinicio del proceso no repita la revisión del mismo minuto.
   */
  async function quizaRevisar() {
    const ahoraMs = ahoraFn();
    const d = new Date(ahoraMs);
    if (d.getUTCMinutes() % INTERVALO_MIN !== 0) return;
    const clave = d.toISOString().slice(0, 16);
    const est = leer();
    if (est.ultima_revision && est.ultima_revision.clave === clave) return;
    if (enCurso) return;
    enCurso = true;
    try { await revisar("agente"); } finally { enCurso = false; }
  }

  /** Solo lee bot-mudo.json — nunca ejecuta docker exec. Para el panel. */
  function estado() {
    const est = leer();
    const ahoraMs = ahoraFn();
    const ev = evaluar(est.muestras, ahoraMs);
    const ultimaRevisionTs = est.ultima_revision ? est.ultima_revision.ts : null;
    const minutos_desde_revision = ultimaRevisionTs ? Math.round((ahoraMs - new Date(ultimaRevisionTs).getTime()) / 60000) : null;

    let nivel = "ok";
    let titulo = "Contestando con normalidad";
    let detalle = "";

    if (est.episodio) {
      nivel = "crit";
      titulo = "No está contestando";
      const n = est.episodio.recibidos_sin_respuesta;
      const avisoTxt = est.episodio.aviso.estado === "enviado"
        ? "Ya te avisé por WhatsApp"
        : `Aviso pendiente: ${motivoLlano(est.episodio.aviso.motivo_pendiente || "fallo")}`;
      detalle = `Desde las ${horaColombia(est.episodio.primera_sin_respuesta_ts || est.episodio.inicio, ahoraMs)} · ${n} ${plural(n, "mensaje", "mensajes")} sin respuesta · ${avisoTxt}`;
    } else if (!est.ultima_revision) {
      nivel = "mute"; titulo = "Sin datos todavía"; detalle = "Empiezo a revisar en unos minutos.";
    } else if (minutos_desde_revision != null && minutos_desde_revision > 15) {
      nivel = "mute"; titulo = `Sin revisar desde hace ${minutos_desde_revision} min`; detalle = "La revisión automática no está corriendo.";
    } else if (est.lectura_fallida) {
      nivel = "mute"; titulo = "No pude leer el contador del bot";
      detalle = `Desde las ${horaColombia(est.lectura_fallida.desde, ahoraMs)}. Si el bot está caído, ese aviso llega por separado.`;
    } else if (est.ultima_revision.resultado === "bot_caido") {
      nivel = "mute"; titulo = "El bot está caído"; detalle = "Ese aviso lo maneja el detector de caídas.";
    } else if (ev.veredicto === "sin_datos") {
      nivel = "mute"; titulo = "Recopilando datos"; detalle = "Listo en unos 10 minutos.";
    } else if (ev.veredicto === "sospechoso") {
      nivel = "warn"; titulo = "Vigilando";
      detalle = `1 mensaje sin respuesta desde hace ${ev.minutos_silencio} min. Si llega otro y tampoco lo contesta, te aviso.`;
    } else {
      nivel = "ok"; titulo = "Contestando con normalidad";
      detalle = ev.minutos_desde_ultima_respuesta != null
        ? `Última respuesta vista hace ${ev.minutos_desde_ultima_respuesta} min.`
        : "Sin mensajes de clientes en la última hora, nada pendiente.";
      if (est.ultimo_episodio && (ahoraMs - new Date(est.ultimo_episodio.fin).getTime()) < 2 * 3600000) {
        detalle += ` Hoy estuvo sin contestar de ${horaColombia(est.ultimo_episodio.inicio, ahoraMs)} a ${horaColombia(est.ultimo_episodio.fin, ahoraMs)}.`;
      }
    }

    return {
      generado: new Date().toISOString(),
      nivel, titulo, detalle,
      veredicto: est.episodio ? "mudo" : (est.ultima_revision ? est.ultima_revision.resultado : "sin_revisar"),
      ultima_revision: ultimaRevisionTs,
      minutos_desde_revision,
      muestras: est.muestras.length,
      ventana: {
        recibidos_sin_respuesta: ev.recibidos_sin_respuesta, errores_sin_respuesta: ev.errores_sin_respuesta,
        primera_sin_respuesta_ts: ev.primera_sin_respuesta_ts, minutos_silencio: ev.minutos_silencio,
        minutos_desde_ultima_respuesta: ev.minutos_desde_ultima_respuesta,
      },
      episodio: est.episodio ? {
        inicio: est.episodio.inicio, primera_sin_respuesta_ts: est.episodio.primera_sin_respuesta_ts,
        recibidos_sin_respuesta: est.episodio.recibidos_sin_respuesta, errores: est.episodio.errores,
        ultima_confirmacion: est.episodio.ultima_confirmacion,
        aviso: { estado: est.episodio.aviso.estado, motivo_pendiente: est.episodio.aviso.motivo_pendiente, ts: est.episodio.aviso.ts, intentos: est.episodio.aviso.intentos },
      } : null,
      ultimo_episodio: est.ultimo_episodio,
      lectura_fallida: est.lectura_fallida,
      umbrales: { intervalo_min: INTERVALO_MIN, min_recibidos: MIN_RECIBIDOS, silencio_min: SILENCIO_MIN, enfriamiento_min: ENFRIAMIENTO_APERTURA_MIN, caducidad_min: CADUCIDAD_MIN },
    };
  }

  return {
    revisar,
    quizaRevisar,
    estado,
    // puras, expuestas para pruebas y para reutilizar en el panel si hiciera falta
    interpretarMetrics,
    agregarMuestra,
    evaluar,
    decidir,
    textoApertura,
    textoRecuperacion,
    textoCaducidad,
    CONSTANTES: {
      CONTENEDOR_BOT, INTERVALO_MIN, MAX_MUESTRAS, MIN_MUESTRAS, MIN_RECIBIDOS, SILENCIO_MIN,
      ENFRIAMIENTO_APERTURA_MIN, CADUCIDAD_MIN, MAX_INTENTOS_AVISO, MAX_EDAD_MUESTRA_MIN,
      TOLERANCIA_RELOJ_MS, TIMEOUT_SH_MS, rutas,
    },
  };
}

module.exports = { crearBotMudo, horaColombia };
