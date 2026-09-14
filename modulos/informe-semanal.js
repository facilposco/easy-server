"use strict";
/**
 * modulos/informe-semanal.js
 *
 * Centinela Zeus — informe semanal para el dueño (no técnico). Junta seis
 * datos ya reales del servidor (caídas, SOS, mensajes del bot, disco/memoria,
 * seguridad) en un solo objeto, y de ahí sale tanto el texto de WhatsApp
 * como el JSON que pinta el panel. Aislado a propósito: nada de aquí corre
 * solo hasta que `ops-server.js` construye este módulo con sus funciones
 * reales y lo engancha a un `setInterval` (ver `INTEGRACION-INFORME-SEMANAL.md`).
 *
 * Diseño vinculante producido en Fable 5.1 (regla de AGENTS.md: "Arquitectura
 * y diseño → Fable 5.1, siempre"). Este archivo es la implementación de ese
 * diseño; los contratos (nombres de función, forma de los datos, rutas,
 * constantes de hora) no se cambian por iniciativa propia — donde este
 * archivo se aparta de una duda del diseño (p. ej. qué etiqueta de `recurso`
 * usa `prediccion()` de verdad), queda anotado en el comentario del punto
 * exacto para que quien integre lo verifique contra `ops-server.js`.
 *
 * No usa MariaDB, no llama a ningún modelo de IA (el informe es 100%
 * determinista: datos y umbrales, nunca opinión — regla 1 del SOS en
 * CLAUDE.md), y no depende de ningún paquete externo: solo `node:path` y
 * `./sos/textos.js` (ya existente) para nombres claros y descripciones de
 * acciones en español llano.
 */

const path = require("path");
const { nombreClaro, describirAccion } = require("./sos/textos.js");

// ── Constantes de calendario (fijadas por el diseño / arquitectura.html) ───
const DIA_INFORME_UTC = 1; // lunes (0 = domingo, 1 = lunes, en UTC)
const HORA_INFORME_UTC = 12; // 12:00 UTC = 7:00 a. m. Colombia
const HORA_FOTO_UTC = 23; // 23:xx UTC = ~6 p. m. Colombia
const MINUTO_FOTO_UTC = 50; // 23:50 UTC, justo antes de que metrics.json del bot se reinicie a las 00:00 UTC
const MAX_LINEAS_FOTOS = 120; // ~4 meses de fotos diarias; de sobra para comparar dos semanas
const MAX_LINEAS_SOS = 3000; // corridas de SOS a inspeccionar hacia atrás; de sobra para varias semanas
const CONTENEDOR_BOT = "zeus-bot"; // se lee siempre el azul/estable, ver DISEÑO §4.4

// Servicios cuya caída significa "el bot no atendió a un cliente".
// zeus-mariadb / zeus-chromadb degradan pero no cortan la respuesta.
const SERVICIOS_BOT = new Set(["zeus-bot", "zeus-proxy"]);

const RESULTADOS_SOS_CONOCIDOS = [
  "restablecido", "sin_falla", "parcial", "detenido_pide_ayuda", "no_diagnosticable",
];

const MESES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];
const MESES_ABR = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const DIAS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

// ── Utilidades de fecha (todo en UTC; sin Intl para no depender de datos de
//    localización del build de Node, mismo criterio que ya usa textos.js) ──

function aFechaISO(d) { return d.toISOString().slice(0, 10); }

function sumarDiasISO(fechaISO, n) {
  const d = new Date(`${fechaISO}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d;
}

/** El lunes en o después de `d` (si `d` ya es lunes, devuelve `d`). */
function siguienteLunes(d) {
  const dia = d.getUTCDay(); // 0 domingo .. 6 sábado
  const faltan = dia === 1 ? 0 : (8 - dia) % 7;
  const r = new Date(d.getTime());
  r.setUTCDate(r.getUTCDate() + faltan);
  return r;
}

function fechaLarga(d) { return `${d.getUTCDate()} de ${MESES[d.getUTCMonth()]}`; }

function fechaCorta(iso) {
  const d = new Date(iso);
  return `${String(d.getUTCDate()).padStart(2, "0")} ${MESES_ABR[d.getUTCMonth()]}`;
}

function etiquetaPeriodo(desde, hastaInclusive) {
  const p1 = `${DIAS[desde.getUTCDay()]} ${desde.getUTCDate()}`;
  const p2 = `${DIAS[hastaInclusive.getUTCDay()]} ${hastaInclusive.getUTCDate()}`;
  if (desde.getUTCMonth() === hastaInclusive.getUTCMonth()) {
    return `del ${p1} al ${p2} de ${MESES[hastaInclusive.getUTCMonth()]}`;
  }
  return `del ${p1} de ${MESES[desde.getUTCMonth()]} al ${p2} de ${MESES[hastaInclusive.getUTCMonth()]}`;
}

/**
 * Lunes (UTC) de la semana que contiene `fecha`, como "YYYY-MM-DD". Se usa
 * como clave para "¿ya se envió el informe de esta semana?" — sobrevive un
 * reinicio del proceso a mitad de semana, a diferencia de una variable en
 * memoria (ver DISEÑO §2.1).
 */
function claveSemana(fecha) {
  const d = new Date(Date.UTC(fecha.getUTCFullYear(), fecha.getUTCMonth(), fecha.getUTCDate()));
  const retroceso = (d.getUTCDay() + 6) % 7; // lunes → 0 ... domingo → 6
  d.setUTCDate(d.getUTCDate() - retroceso);
  return aFechaISO(d);
}

/**
 * Los dos períodos de 7 días UTC completos: el que termina justo antes de
 * `hastaParam` (normalmente "ahora") y el anterior a ese. Igual para
 * WhatsApp y panel — un solo cálculo, ver DISEÑO §4.
 */
function calcularPeriodos(hastaParam) {
  const hastaBoundary = new Date(Date.UTC(hastaParam.getUTCFullYear(), hastaParam.getUTCMonth(), hastaParam.getUTCDate()));
  const desdeBoundary = new Date(hastaBoundary.getTime() - 7 * 86400000);
  const desdeAntBoundary = new Date(desdeBoundary.getTime() - 7 * 86400000);
  const hastaInclusive = new Date(hastaBoundary.getTime() - 86400000);
  const hastaAntInclusive = new Date(desdeBoundary.getTime() - 86400000);
  return {
    actual: {
      desdeBoundary, hastaBoundary,
      desde: aFechaISO(desdeBoundary), hasta: aFechaISO(hastaInclusive),
      etiqueta: etiquetaPeriodo(desdeBoundary, hastaInclusive),
    },
    anterior: {
      desdeBoundary: desdeAntBoundary, hastaBoundary: desdeBoundary,
      desde: aFechaISO(desdeAntBoundary), hasta: aFechaISO(hastaAntInclusive),
    },
  };
}

function dentroDe(fechaIso, periodo) {
  if (!fechaIso) return false;
  const t = new Date(fechaIso).getTime();
  if (Number.isNaN(t)) return false;
  return t >= periodo.desdeBoundary.getTime() && t < periodo.hastaBoundary.getTime();
}

// ── Fábrica ─────────────────────────────────────────────────────────────────

/**
 * @param {Object} deps
 * @param {string}   deps.DIR_DATOS   "/var/lib/zeus-ops"
 * @param {Function} deps.leerJson    leerJson(archivo, porDefecto) de ops-server.js
 * @param {Function} deps.leerJsonl   leerJsonl(archivo, max) de ops-server.js
 * @param {Function} deps.guardarJson guardarJson(archivo, obj) de ops-server.js
 * @param {Function} deps.anexar      anexar(archivo, obj) de ops-server.js
 * @param {Function} deps.auditar     auditar(accion, quien, resultado, detalle) de ops-server.js
 * @param {Function} deps.enviarWhatsapp  enviarWhatsapp(texto) → {ok, detalle}, ya existente
 * @param {Function} deps.prediccion  prediccion() async → {riesgo, pronosticos, ...}, ya existente
 * @param {Object}   deps.permisos    objeto de crearPermisos(...): usa permisos.permitido(id, tipo)
 * @param {Object}   deps.kapsoYModo  require("./modulos/kapso-y-modo.js")
 * @param {string}   deps.F_MODO      ruta a modo.json (path.join(DIR_DATOS, "modo.json"))
 * @param {Function} deps.sh          sh(comando, timeoutMs) async → {ok, salida}, ya existente
 */
function crearInformeSemanal(deps) {
  const { DIR_DATOS, leerJson, leerJsonl, guardarJson, anexar, auditar, enviarWhatsapp, prediccion } = deps || {};
  if (!DIR_DATOS || typeof leerJson !== "function" || typeof leerJsonl !== "function"
    || typeof guardarJson !== "function" || typeof anexar !== "function" || typeof auditar !== "function") {
    throw new Error("crearInformeSemanal necesita DIR_DATOS, leerJson, leerJsonl, guardarJson, anexar y auditar de ops-server.js");
  }
  if (typeof enviarWhatsapp !== "function" || typeof prediccion !== "function") {
    throw new Error("crearInformeSemanal necesita enviarWhatsapp() y prediccion() de ops-server.js");
  }

  const rutas = {
    incidentes: path.join(DIR_DATOS, "incidentes.json"),
    corridasSos: path.join(DIR_DATOS, "centinela-db", "sos-corridas.jsonl"),
    seguridad: path.join(DIR_DATOS, "seguridad-completa.json"),
    fotos: path.join(DIR_DATOS, "mensajes-bot-diario.jsonl"),
    estado: path.join(DIR_DATOS, "informe-semanal.json"),
  };

  let ultimaFoto = ""; // guarda "YYYY-MM-DD" en memoria; un duplicado no ensucia nada (ver leerFotosDedup)

  // ── Sección 1 y 2 — caídas del bot (incidentes.json) ──────────────────────

  function fusionarYSumarMinutos(intervalos) {
    if (!intervalos.length) return 0;
    const ord = intervalos.slice().sort((a, b) => a.inicio - b.inicio);
    let totalMs = 0;
    let curInicio = ord[0].inicio, curFin = ord[0].fin;
    for (let i = 1; i < ord.length; i++) {
      const iv = ord[i];
      if (iv.inicio <= curFin) { curFin = Math.max(curFin, iv.fin); }
      else { totalMs += curFin - curInicio; curInicio = iv.inicio; curFin = iv.fin; }
    }
    totalMs += curFin - curInicio;
    return Math.max(0, Math.round(totalMs / 60000));
  }

  function calcularCaidas(periodo, generadoMs) {
    const incidentes = leerJson(rutas.incidentes, { abierto: null, historial: [] });
    const historial = Array.isArray(incidentes.historial) ? incidentes.historial : [];
    const filtradas = historial.filter((i) => i && SERVICIOS_BOT.has(i.servicio) && dentroDe(i.inicio, periodo));

    const intervalos = filtradas.map((i) => ({
      inicio: new Date(i.inicio).getTime(),
      fin: i.fin ? new Date(i.fin).getTime() : generadoMs,
    }));

    let en_curso = false;
    const abierto = incidentes.abierto;
    if (abierto && SERVICIOS_BOT.has(abierto.servicio) && dentroDe(abierto.inicio, periodo)) {
      en_curso = true;
      intervalos.push({ inicio: new Date(abierto.inicio).getTime(), fin: generadoMs });
    }

    const minutos = fusionarYSumarMinutos(intervalos);
    const lista = filtradas
      .slice()
      .sort((a, b) => new Date(a.inicio) - new Date(b.inicio))
      .map((i) => ({
        cuando: i.inicio,
        servicio: i.servicio,
        nombre: nombreClaro(i.servicio),
        minutos: Math.max(1, Math.round((i.duracion_s || 0) / 60)),
        causa: i.causa || "",
        descripcion: i.descripcion || "",
        resuelto: i.resuelto || "",
      }));

    return {
      bot_sin_atender: { minutos, caidas: filtradas.length + (en_curso ? 1 : 0), en_curso },
      caidas: {
        total: lista.length,
        resueltas: lista.filter((i) => i.resuelto).length,
        lista,
      },
    };
  }

  // ── Sección 3 — SOS (sos-corridas.jsonl) ──────────────────────────────────

  function calcularSos(periodo) {
    const todas = leerJsonl(rutas.corridasSos, MAX_LINEAS_SOS);
    const filtradas = todas.filter((c) => c && dentroDe(c.inicio, periodo));

    const por_resultado = {};
    RESULTADOS_SOS_CONOCIDOS.forEach((r) => { por_resultado[r] = 0; });

    let acciones_fallidas = 0;
    let afectaron_clientes = 0;
    const reparacionesMap = new Map();

    for (const c of filtradas) {
      const res = c.resultado || "desconocido";
      por_resultado[res] = (por_resultado[res] || 0) + 1;
      if (c.afecta_clientes === "si") afectaron_clientes += 1;
      const acciones = Array.isArray(c.acciones) ? c.acciones : [];
      for (const a of acciones) {
        if (!a) continue;
        if (a.ok) {
          const texto = describirAccion(a);
          reparacionesMap.set(texto, (reparacionesMap.get(texto) || 0) + 1);
        } else {
          acciones_fallidas += 1;
        }
      }
    }

    return {
      corridas: filtradas.length,
      por_resultado,
      reparaciones: Array.from(reparacionesMap.entries()).map(([que, veces]) => ({ que, veces })),
      acciones_fallidas,
      afectaron_clientes,
    };
  }

  // ── Sección 4 — mensajes del bot (foto diaria de metrics.json) ───────────

  function leerFotosDedup() {
    const lineas = leerJsonl(rutas.fotos, MAX_LINEAS_FOTOS);
    const porFecha = new Map();
    for (const l of lineas) { if (l && l.fecha) porFecha.set(l.fecha, l); } // última línea por fecha gana
    return porFecha;
  }

  function sumarRango(porFecha, desdeISO, hastaInclusiveISO) {
    let enviados = 0, recibidos = 0, dias_con_datos = 0;
    let cursor = new Date(`${desdeISO}T00:00:00.000Z`);
    const fin = new Date(`${hastaInclusiveISO}T00:00:00.000Z`);
    while (cursor.getTime() <= fin.getTime()) {
      const f = aFechaISO(cursor);
      const reg = porFecha.get(f);
      if (reg && reg.ok) { enviados += reg.enviados || 0; recibidos += reg.recibidos || 0; dias_con_datos += 1; }
      cursor = new Date(cursor.getTime() + 86400000);
    }
    return { enviados, recibidos, dias_con_datos };
  }

  function notaMensajes(estado, semana, primeraFoto) {
    if (estado === "completo") return "";
    if (estado === "sin_datos") {
      if (!primeraFoto) {
        return "Todavía no tengo datos de mensajes: empiezo a contarlos cada día a las 6:50 p. m. Vuelve la próxima semana.";
      }
      const listo = siguienteLunes(sumarDiasISO(primeraFoto, 7));
      return `Todavía no tengo datos de mensajes de esta semana. En el informe del lunes ${fechaLarga(listo)} ya podré decirte cuántos mensajes atendió el bot.`;
    }
    const listoComparacion = siguienteLunes(sumarDiasISO(primeraFoto, 14));
    return `Llevo ${semana.dias_con_datos} de 7 días contando mensajes esta semana (${semana.enviados} enviados hasta ahora). La comparación con la semana anterior estará lista el lunes ${fechaLarga(listoComparacion)}.`;
  }

  function calcularMensajes(periodo, periodoAnterior) {
    const porFecha = leerFotosDedup();
    const semana = sumarRango(porFecha, periodo.desde, periodo.hasta);
    const anterior = sumarRango(porFecha, periodoAnterior.desde, periodoAnterior.hasta);

    let estado = "sin_datos";
    if (semana.dias_con_datos === 7 && anterior.dias_con_datos === 7) estado = "completo";
    else if (semana.dias_con_datos > 0 || anterior.dias_con_datos > 0) estado = "parcial";

    const variacion_pct = (estado === "completo" && anterior.enviados > 0)
      ? Math.round((semana.enviados - anterior.enviados) / anterior.enviados * 100)
      : null;

    let primera_foto = null;
    for (const reg of porFecha.values()) { if (!primera_foto || reg.fecha < primera_foto) primera_foto = reg.fecha; }

    return { estado, semana, anterior, variacion_pct, primera_foto, nota: notaMensajes(estado, semana, primera_foto) };
  }

  /**
   * Foto de hoy de metrics.json del bot. Nunca lanza: cualquier fallo (bot
   * caído, docker exec falla, JSON inválido) se anexa igual con ok:false y
   * un motivo, para que el informe sepa que ese día no tiene dato real en
   * vez de mostrar un cero engañoso (ver DISEÑO §4.4, decisión (a)).
   */
  async function fotoDiariaMensajes() {
    const ts = new Date().toISOString();
    const hoy = ts.slice(0, 10);
    let registro;
    try {
      if (typeof deps.sh !== "function") throw new Error("falta sh() en las dependencias");
      const r = await deps.sh(`docker exec ${CONTENEDOR_BOT} cat /app/metrics.json`, 8000);
      if (!r || !r.ok) {
        registro = { ts, fecha: hoy, ok: false, recibidos: null, enviados: null, errores: null, respuesta_prom_ms: null, motivo: "docker exec falló" };
      } else {
        let metrics = null;
        try { metrics = JSON.parse(r.salida); } catch (_) { metrics = null; }
        if (!metrics || !metrics.daily) {
          registro = { ts, fecha: hoy, ok: false, recibidos: null, enviados: null, errores: null, respuesta_prom_ms: null, motivo: metrics ? "sin campo daily" : "JSON inválido" };
        } else {
          const d = metrics.daily;
          if (d.date === hoy) {
            registro = {
              ts, fecha: hoy, ok: true,
              recibidos: d.messagesIn || 0, enviados: d.messagesOut || 0, errores: d.errors || 0,
              respuesta_prom_ms: d.avgResponseMs != null ? d.avgResponseMs : null, nota: "",
            };
          } else {
            // La fecha del contador del bot no es la de hoy: no se registró ni
            // un mensaje ni un error en todo el día (checkDayReset del bot
            // solo corre al recibir actividad). Es un dato real (cero), no
            // una falta de dato — ver DISEÑO §4.4.
            registro = { ts, fecha: hoy, ok: true, recibidos: 0, enviados: 0, errores: 0, respuesta_prom_ms: null, nota: "sin actividad registrada ese día" };
          }
        }
      }
    } catch (e) {
      registro = { ts, fecha: hoy, ok: false, recibidos: null, enviados: null, errores: null, respuesta_prom_ms: null, motivo: e.message };
    }
    anexar(rutas.fotos, registro);
    auditar("foto_mensajes_bot", "agente", registro.ok ? "ok" : "sin_datos",
      registro.ok ? `${registro.recibidos} recibidos, ${registro.enviados} enviados` : (registro.motivo || ""));
    return registro;
  }

  async function quizaFotoDiariaMensajes() {
    const ahora = new Date();
    const hoy = ahora.toISOString().slice(0, 10);
    if (ahora.getUTCHours() !== HORA_FOTO_UTC || ahora.getUTCMinutes() < MINUTO_FOTO_UTC || ultimaFoto === hoy) return;
    ultimaFoto = hoy;
    const registro = await fotoDiariaMensajes();
    if (deps.latidos && typeof deps.latidos.registrar === "function") {
      deps.latidos.registrar("foto_mensajes", { ok: registro.ok, detalle: registro.motivo || "" }, "agente");
    }
  }

  // ── Sección 5 — proyección de disco/memoria (reusa prediccion(), no la reimplementa) ──

  function entradaProyeccionVacia() {
    return { dias: null, fecha: null, nivel: "info", texto: "Sin datos de esta métrica.", ritmo: null };
  }

  function convertirEntrada(entrada, generadoMs) {
    if (!entrada) return entradaProyeccionVacia();
    const dias = entrada.dias == null ? null : entrada.dias;
    return {
      dias,
      fecha: dias == null ? null : new Date(generadoMs + dias * 86400000).toISOString().slice(0, 10),
      nivel: entrada.nivel || "info",
      texto: entrada.texto || "",
      ritmo: entrada.ritmo != null ? entrada.ritmo : null,
    };
  }

  async function calcularProyeccion(generadoMs) {
    try {
      const p = await prediccion();
      const pronosticos = Array.isArray(p && p.pronosticos) ? p.pronosticos : [];
      // NOTA PARA QUIEN INTEGRE: estas expresiones son un punto de
      // verificación, no un contrato cerrado — confirmar contra las
      // etiquetas "recurso" reales que arma prediccion() en ops-server.js
      // (ver panel-final/app.js, pintarPrediccion) y ajustar solo estas dos
      // líneas si no calzan. El resto del módulo no depende de esto.
      const disco = pronosticos.find((x) => /disco/i.test((x && x.recurso) || ""));
      const memoria = pronosticos.find((x) => /memoria|ram/i.test((x && x.recurso) || ""));
      return {
        disponible: !!(disco || memoria),
        riesgo: typeof (p && p.riesgo) === "number" ? p.riesgo : null,
        disco: convertirEntrada(disco, generadoMs),
        memoria: convertirEntrada(memoria, generadoMs),
      };
    } catch (_) {
      return { disponible: false, riesgo: null, disco: entradaProyeccionVacia(), memoria: entradaProyeccionVacia() };
    }
  }

  // ── Sección 6 — auditorías de seguridad ───────────────────────────────────

  function calcularSeguridad(periodo) {
    const seg = leerJson(rutas.seguridad, { corridas: [] });
    const todas = Array.isArray(seg.corridas) ? seg.corridas : [];
    const enPeriodo = todas.filter((c) => c && dentroDe(c.ts, periodo));
    const ordenadas = todas.slice().sort((a, b) => new Date(b.ts) - new Date(a.ts));
    const ultimaCorrida = ordenadas[0] || null;
    const ultima = ultimaCorrida
      ? { ts: ultimaCorrida.ts, puntaje: ultimaCorrida.puntaje, urgentes: ultimaCorrida.urgentes, atencion: ultimaCorrida.atencion }
      : null;
    return {
      corridas: enPeriodo.length,
      ultima,
      ultima_en_periodo: !!(ultimaCorrida && dentroDe(ultimaCorrida.ts, periodo)),
      peor_puntaje: enPeriodo.length ? Math.min(...enPeriodo.map((c) => c.puntaje)) : null,
    };
  }

  // ── Armado completo ───────────────────────────────────────────────────────

  /**
   * Arma el objeto InformeSemanal completo (ver DISEÑO §4). Solo lee: nunca
   * envía WhatsApp, nunca audita, nunca escribe en disco. Reutilizable por
   * WhatsApp y por el panel — un solo camino de código para los seis datos.
   */
  async function armarDatosInforme(opciones) {
    const hastaParam = (opciones && opciones.hasta instanceof Date) ? opciones.hasta : new Date();
    const generadoMs = Date.now();
    const { actual, anterior } = calcularPeriodos(hastaParam);

    const { bot_sin_atender, caidas } = calcularCaidas(actual, generadoMs);
    const sos = calcularSos(actual);
    const periodo = { desde: actual.desde, hasta: actual.hasta, etiqueta: actual.etiqueta };
    const periodo_anterior = { desde: anterior.desde, hasta: anterior.hasta };
    const mensajes = calcularMensajes(periodo, periodo_anterior);
    const proyeccion = await calcularProyeccion(generadoMs);
    const seguridad = calcularSeguridad(actual);

    return {
      generado: new Date(generadoMs).toISOString(),
      periodo, periodo_anterior,
      bot_sin_atender, caidas, sos, mensajes, proyeccion, seguridad,
    };
  }

  // ── Texto en español llano (WhatsApp y "ver como texto" del panel) ───────

  function textoMensajes(m) {
    if (m.estado !== "completo") return m.nota;
    const signo = m.variacion_pct == null ? "" : (m.variacion_pct > 0 ? "más" : m.variacion_pct < 0 ? "menos" : "igual");
    const pct = m.variacion_pct == null ? "" : ` (${Math.abs(m.variacion_pct)}% ${signo} que la semana pasada)`;
    return `${m.semana.enviados} mensajes enviados, ${m.semana.recibidos} recibidos${pct}.`;
  }

  function textoProyeccionRecurso(nombre, entrada) {
    if (entrada.dias == null) return `${nombre}: ${entrada.texto || "estable, sin fecha de riesgo."}`;
    return `${nombre}: ${entrada.texto} (se llenaría hacia el ${entrada.fecha}, en unos ${entrada.dias} días si sigue igual).`;
  }

  /** Pura: mismo texto para WhatsApp y para `?formato=texto` del panel. */
  function textoInforme(datos) {
    const lineas = [`📊 Informe semanal de Centinela — ${datos.periodo.etiqueta}`, ""];

    lineas.push(`Bot sin atender: ${datos.bot_sin_atender.minutos} min (${datos.bot_sin_atender.caidas} caída${datos.bot_sin_atender.caidas === 1 ? "" : "s"})`);
    if (datos.bot_sin_atender.en_curso) lineas.push("⚠️ Hay una falla en curso ahora mismo.");
    lineas.push("");

    lineas.push(`Caídas de la semana: ${datos.caidas.total}`);
    if (datos.caidas.total === 0) {
      lineas.push("Ninguna caída esta semana.");
    } else {
      datos.caidas.lista.slice(0, 5).forEach((c, i) => {
        lineas.push(`${i + 1}. ${fechaCorta(c.cuando)} — ${c.nombre} (${c.minutos} min): ${c.causa || "sin causa registrada"}`);
      });
      if (datos.caidas.lista.length > 5) lineas.push(`+${datos.caidas.lista.length - 5} más en el panel.`);
    }
    lineas.push("");

    lineas.push(`SOS: actuó ${datos.sos.corridas} ${datos.sos.corridas === 1 ? "vez" : "veces"}`);
    if (datos.sos.corridas === 0) {
      lineas.push("No tuvo que intervenir esta semana.");
    } else if (datos.sos.reparaciones.length) {
      datos.sos.reparaciones.forEach((r) => lineas.push(`- ${r.que} ×${r.veces}`));
    }
    if (datos.sos.por_resultado.detenido_pide_ayuda > 0) {
      lineas.push(`Necesitó ayuda de una persona ${datos.sos.por_resultado.detenido_pide_ayuda} ${datos.sos.por_resultado.detenido_pide_ayuda === 1 ? "vez" : "veces"}.`);
    }
    lineas.push("");

    lineas.push(`Mensajes del bot: ${textoMensajes(datos.mensajes)}`);
    lineas.push("");

    lineas.push(textoProyeccionRecurso("Disco", datos.proyeccion.disco));
    lineas.push(textoProyeccionRecurso("Memoria", datos.proyeccion.memoria));
    lineas.push("");

    if (datos.seguridad.ultima) {
      lineas.push(`Seguridad: ${datos.seguridad.corridas} auditoría${datos.seguridad.corridas === 1 ? "" : "s"} esta semana. Último puntaje: ${datos.seguridad.ultima.puntaje} de 100.`);
    } else {
      lineas.push("Seguridad: sin auditorías registradas todavía.");
    }
    lineas.push("");

    lineas.push("Todo el detalle en panel.ejemplo.com → Inicio → Informe de la semana.");
    return lineas.join("\n");
  }

  // ── Envío y disparador semanal ─────────────────────────────────────────────

  function guardarEstadoEnvio(semana, resultado) {
    guardarJson(rutas.estado, { semana, ts: new Date().toISOString(), resultado });
  }

  /**
   * Aplica los frenos (permisos, modo viaje), arma el informe, lo envía por
   * WhatsApp y audita. Es lo que llama tanto el reloj semanal como la ruta
   * manual de prueba — mismo camino de código para ambos casos.
   */
  async function enviarInformeSemanal(quien) {
    const quienFinal = quien || "agente";
    const semana = claveSemana(new Date());
    try {
      if (deps.permisos && typeof deps.permisos.permitido === "function" && !deps.permisos.permitido("whatsapp", "escritura")) {
        guardarEstadoEnvio(semana, "sin_permiso_whatsapp");
        auditar("informe_semanal", quienFinal, "sin_permiso_whatsapp", semana);
        return { ok: false, motivo: "sin_permiso_whatsapp" };
      }
      if (deps.kapsoYModo && typeof deps.kapsoYModo.obtenerModo === "function" && typeof deps.kapsoYModo.debeSilenciar === "function") {
        const modo = deps.kapsoYModo.obtenerModo(leerJson, deps.F_MODO);
        if (deps.kapsoYModo.debeSilenciar("info", modo)) {
          guardarEstadoEnvio(semana, "silenciado_modo_viaje");
          auditar("informe_semanal", quienFinal, "silenciado_modo_viaje", semana);
          return { ok: false, motivo: "silenciado_modo_viaje" };
        }
      }

      const datos = await armarDatosInforme();
      const texto = textoInforme(datos);
      guardarEstadoEnvio(semana, "enviando");
      const r = await enviarWhatsapp(texto);
      guardarEstadoEnvio(semana, r && r.ok ? "enviado" : "falló");
      auditar("informe_semanal", quienFinal, r && r.ok ? "enviado" : "falló", (r && r.detalle) || semana);
      return { ok: !!(r && r.ok), motivo: r && r.ok ? "enviado" : "falló", datos };
    } catch (e) {
      guardarEstadoEnvio(semana, "error");
      auditar("informe_semanal", quienFinal, "error", e.message);
      return { ok: false, motivo: "error", error: e.message };
    }
  }

  /**
   * Se llama una vez por minuto desde un setInterval (mismo patrón que
   * `quizaAuditoriaDiariaCentinela`). Solo decide si ya toca: la clave de
   * "ya se hizo" es el lunes de la semana, persistido en disco, para que un
   * reinicio del proceso a mitad del lunes no reenvíe el informe.
   */
  async function quizaInformeSemanal() {
    const ahora = new Date();
    if (ahora.getUTCDay() !== DIA_INFORME_UTC || ahora.getUTCHours() !== HORA_INFORME_UTC) return;
    const semana = claveSemana(ahora);
    const estado = leerJson(rutas.estado, null);
    if (estado && estado.semana === semana) return;
    const r = await enviarInformeSemanal("agente");
    if (deps.latidos && typeof deps.latidos.registrar === "function") {
      deps.latidos.registrar("informe_semanal", { ok: r.motivo !== "error", detalle: r.motivo }, "agente");
    }
  }

  function estadoEnvio() {
    return leerJson(rutas.estado, null);
  }

  return {
    armarDatosInforme,
    textoInforme,
    enviarInformeSemanal,
    quizaInformeSemanal,
    fotoDiariaMensajes,
    quizaFotoDiariaMensajes,
    estadoEnvio,
    CONSTANTES: {
      DIA_INFORME_UTC, HORA_INFORME_UTC, HORA_FOTO_UTC, MINUTO_FOTO_UTC,
      rutas,
    },
  };
}

module.exports = { crearInformeSemanal, claveSemana };
