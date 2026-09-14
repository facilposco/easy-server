"use strict";
/**
 * modulos/latidos.js
 *
 * Centinela Zeus — "latido esperado de cada tarea programada" (recomendación
 * #2 de la auditoría del 12 sept. 2026, utilidad 9/10; idea de Healthchecks.io
 * / Cronitor: dead man's switch con período + gracia). El disparador real:
 * el respaldo de base de datos estuvo TRES MESES sin correr sin que nadie se
 * enterara — hoy solo el respaldo tiene un vigilante externo, ad-hoc. Este
 * módulo generaliza esa vigilancia a las tareas programadas de
 * Centinela: cada una avisa "terminé" (un latido, con hora), y `revisar()`
 * corre cada 10 minutos calculando para cada una cuál era su última hora de
 * latido esperada; si no llegó (pasada una gracia), avisa por WhatsApp UNA
 * sola vez por falta, y confirma cuando vuelve a correr.
 *
 * Diseño vinculante producido en Fable 5.1 (regla de AGENTS.md: "Arquitectura
 * y diseño → Fable 5.1, siempre"). Este archivo implementa ese diseño al pie
 * de la letra: contratos de función, forma de `latidos.json`, calendario y
 * fórmula de "última hora esperada" son los que fijó el documento de diseño,
 * no se cambiaron por iniciativa propia. Donde el diseño dejaba una duda
 * anotada (ver DUDAS al final del documento de diseño), este archivo la deja
 * igual en `INTEGRACION-LATIDOS.md`, para que quien integre la verifique
 * contra `ops-server.js` real.
 *
 * Aislado a propósito: nada de aquí corre solo. No usa MariaDB, no llama a
 * ningún modelo de IA (100% determinista: calendario y umbrales, nunca
 * opinión — regla 1 del SOS en CLAUDE.md), y no depende de ningún paquete
 * externo: solo `node:path`. Recibe todo lo que necesita de `ops-server.js`
 * por inyección de dependencias — nunca hace `require("./ops-server.js")` —
 * mismo patrón de bajo acoplamiento que ya usan `informe-semanal.js`,
 * `db-optimizacion.js` y `kapso-y-modo.js`.
 */

const path = require("path");

// ── Calendario (§0-1 del diseño) ────────────────────────────────────────────
// Corrección de calendario dejada asentada por el diseño: la tarea original
// que motivó este módulo decía "auditoría de seguridad a las 07:00 UTC", pero
// es un error — el código real (modulos/centinela-endpoint.js) tiene
// `HORA_CENTINELA_UTC = 12` (12:00 UTC = 7:00 a. m. Colombia). Esta tabla usa
// el valor real verificado, 12:00 UTC. No "corregir" de vuelta a 07:00 UTC.
//
// Todas las horas son UTC (hora del servidor). Colombia = UTC-5.
const TAREAS = [
  { id: "respaldo_bd", nombre_llano: "Respaldo de la base de datos", periodo: "diaria", hora_utc: 8, minuto_utc: 0, gracia_min: 45, nivel: "crit", origen: "cron" },
  { id: "mantenimiento_nocturno", nombre_llano: "Mantenimiento nocturno del servidor", periodo: "diaria", hora_utc: 9, minuto_utc: 0, gracia_min: 20, nivel: "warn", origen: "cron" },
  { id: "verificacion_arranque", nombre_llano: "Revisión después del mantenimiento", periodo: "diaria", hora_utc: 9, minuto_utc: 3, gracia_min: 30, nivel: "warn", origen: "interno" },
  { id: "prueba_restauracion", nombre_llano: "Prueba de que el respaldo se puede restaurar", periodo: "semanal", dia_semana: 0, hora_utc: 10, minuto_utc: 0, gracia_min: 90, nivel: "warn", origen: "cron" },
  // "Revisión de consultas lentas" NO es una tarea programada de verdad —
  // arquitectura.html la listaba en el calendario, pero es solo la ruta bajo
  // demanda /api/optimizacion (dbOptimizacion.analizarPatrones, cacheada
  // 120s), sin ningún setInterval/cron detrás. Se deja fuera para no mostrar
  // un "nunca corrió" permanente y engañoso; el documento debe corregirse
  // aparte.
  { id: "limpieza_docker", nombre_llano: "Limpieza de archivos sobrantes del servidor", periodo: "semanal", dia_semana: 2, hora_utc: 7, minuto_utc: 0, gracia_min: 30, nivel: "warn", origen: "cron" },
  { id: "auditoria_seguridad", nombre_llano: "Auditoría de seguridad diaria", periodo: "diaria", hora_utc: 12, minuto_utc: 0, gracia_min: 20, nivel: "warn", origen: "interno" },
  { id: "resumen_diario", nombre_llano: "Resumen diario por WhatsApp", periodo: "diaria", hora_utc: 13, minuto_utc: 0, gracia_min: 20, nivel: "warn", origen: "interno" },
  { id: "informe_semanal", nombre_llano: "Informe semanal", periodo: "semanal", dia_semana: 1, hora_utc: 12, minuto_utc: 0, gracia_min: 20, nivel: "warn", origen: "interno" },
  { id: "foto_mensajes", nombre_llano: "Conteo diario de mensajes del bot", periodo: "diaria", hora_utc: 23, minuto_utc: 50, gracia_min: 20, nivel: "warn", origen: "interno" },
];

const INTERVALO_REVISION_MS = 600000; // 10 minutos
const DESFASE_COLOMBIA_H = -5; // Colombia = UTC-5, sin horario de verano
const ID_VALIDO = /^[a-z0-9_]{1,40}$/;

// ── Utilidades de fecha/hora (todo en UTC internamente; textos en hora de
//    Colombia, sin Intl — mismo criterio que ya usa informe-semanal.js) ────

const DIAS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const DIAS_PLURAL = ["domingos", "lunes", "martes", "miércoles", "jueves", "viernes", "sábados"];
const MESES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

function horaAmPm(hCo, mCo) {
  const sufijo = hCo < 12 ? "a. m." : "p. m.";
  let h12 = hCo % 12;
  if (h12 === 0) h12 = 12;
  return `${h12}:${String(mCo).padStart(2, "0")} ${sufijo}`;
}

/** Hora de Colombia (texto "3:00 a. m.") de una hora:minuto UTC del calendario. */
function horaAmPmUtc(hUtc, mUtc) {
  const hCo = ((hUtc + DESFASE_COLOMBIA_H) % 24 + 24) % 24;
  return horaAmPm(hCo, mUtc);
}

/** Hora de Colombia de un instante (ms epoch). */
function horaAmPmDeMs(ms) {
  const d = new Date(ms + DESFASE_COLOMBIA_H * 3600000);
  return horaAmPm(d.getUTCHours(), d.getUTCMinutes());
}

function claveDiaCo(ms) {
  const d = new Date(ms + DESFASE_COLOMBIA_H * 3600000);
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
}

function fechaLargaDeMs(ms) {
  const d = new Date(ms + DESFASE_COLOMBIA_H * 3600000);
  return `${DIAS[d.getUTCDay()]} ${d.getUTCDate()} de ${MESES[d.getUTCMonth()]}`;
}

/** "hoy 3:06 a. m." / "ayer 3:06 a. m." / "el lunes 7 de septiembre, 7:00 a. m." */
function fechaHoraTexto(ms, ahoraMs) {
  const horaTxt = horaAmPmDeMs(ms);
  if (claveDiaCo(ms) === claveDiaCo(ahoraMs)) return `hoy ${horaTxt}`;
  if (claveDiaCo(ms) === claveDiaCo(ahoraMs - 86400000)) return `ayer ${horaTxt}`;
  return `el ${fechaLargaDeMs(ms)}, ${horaTxt}`;
}

/** "todos los días a las 3:00 a. m." / "los martes a las 2:00 a. m." */
function cuandoTexto(tarea) {
  const horaTxt = horaAmPmUtc(tarea.hora_utc, tarea.minuto_utc);
  if (tarea.periodo === "diaria") return `todos los días a las ${horaTxt}`;
  return `los ${DIAS_PLURAL[tarea.dia_semana]} a las ${horaTxt}`;
}

/** "5 minutos" / "3 horas" / "2 días" — para el mensaje de recuperación. */
function duracionTexto(ms) {
  const min = Math.max(1, Math.round(ms / 60000));
  if (min < 120) return `${min} minuto${min === 1 ? "" : "s"}`;
  const horas = Math.round(ms / 3600000);
  if (horas < 48) return `${horas} hora${horas === 1 ? "" : "s"}`;
  const dias = Math.round(ms / 86400000);
  return `${dias} día${dias === 1 ? "" : "s"}`;
}

// ── §4.1 — "última hora en que debió correr" (pura, exportada) ─────────────

function calcularUltimaEsperada(tarea, ahoraMs) {
  const d = new Date(ahoraMs);
  let candidata = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), tarea.hora_utc, tarea.minuto_utc, 0, 0);
  if (tarea.periodo === "diaria") {
    if (candidata > ahoraMs) candidata -= 86400000;
    return candidata;
  }
  // semanal
  const retroceso = (d.getUTCDay() - tarea.dia_semana + 7) % 7;
  candidata -= retroceso * 86400000;
  if (candidata > ahoraMs) candidata -= 7 * 86400000;
  return candidata;
}

// ── §4.2 — estado de una tarea dado su registro (pura, exportada) ──────────

/**
 * @param {Object} tarea    entrada de TAREAS
 * @param {Object|null} registro  entrada de latidos.json para esa tarea (o null si nunca se vio)
 * @param {number} ahoraMs
 * @returns {{estado:"ok"|"esperando"|"sin_datos"|"falta", esperada:number, vence:number, retraso_min:number, con_error:boolean}}
 */
function evaluarTarea(tarea, registro, ahoraMs) {
  const esperada = calcularUltimaEsperada(tarea, ahoraMs);
  const vence = esperada + tarea.gracia_min * 60000;

  const okTs = registro && registro.ultimo_ok_ts ? new Date(registro.ultimo_ok_ts).getTime() : null;
  const sembradoTs = registro && registro.sembrado_ts ? new Date(registro.sembrado_ts).getTime() : null;
  const referenciaTs = okTs != null ? okTs : sembradoTs;

  if (referenciaTs == null) {
    // Nunca se vio la tarea (ni siquiera sembrada): revisar() la sembrará en
    // el próximo tick. Tratarla como "sin datos" es lo más honesto mientras
    // tanto — nunca "falta".
    return { estado: "sin_datos", esperada, vence, retraso_min: 0, con_error: false };
  }

  if (referenciaTs >= esperada) {
    return { estado: okTs != null ? "ok" : "sin_datos", esperada, vence, retraso_min: 0, con_error: false };
  }

  if (ahoraMs < vence) {
    return { estado: "esperando", esperada, vence, retraso_min: 0, con_error: false };
  }

  const falloTs = registro && registro.ultimo_fallo_ts ? new Date(registro.ultimo_fallo_ts).getTime() : null;
  const conError = falloTs != null && falloTs >= esperada;
  const retraso_min = Math.max(0, Math.round((ahoraMs - esperada) / 60000));
  return { estado: "falta", esperada, vence, retraso_min, con_error: conError };
}

// ── Textos de WhatsApp (puros — §9 del diseño) ──────────────────────────────

function textoAvisoFalta(tarea, ev, registro, ahoraMs) {
  const emoji = tarea.nivel === "crit" ? "🔴" : "⚠️";
  const lineas = [`${emoji} Una tarea programada no corrió: ${tarea.nombre_llano}.`];

  if (ev.con_error) {
    const cuando = registro && registro.ultimo_fallo_ts ? fechaHoraTexto(new Date(registro.ultimo_fallo_ts).getTime(), ahoraMs) : "hace poco";
    lineas.push(`Corrió ${cuando} pero terminó con error: ${registro.ultimo_fallo_detalle || "sin detalle"}.`);
  } else {
    lineas.push(`Debió correr ${fechaHoraTexto(ev.esperada, ahoraMs)} y ya pasaron ${ev.retraso_min} minutos sin señal de que terminara.`);
  }

  if (registro && registro.ultimo_ok_ts) {
    // fechaHoraTexto() ya termina en "a. m."/"p. m.": no se le agrega otro punto encima.
    lineas.push(`Último que sí terminó bien: ${fechaHoraTexto(new Date(registro.ultimo_ok_ts).getTime(), ahoraMs)}`);
  } else {
    const desde = registro && registro.sembrado_ts ? fechaLargaDeMs(new Date(registro.sembrado_ts).getTime()) : "que empecé a vigilarla";
    lineas.push(`Nunca la he visto terminar desde el ${desde}.`);
  }

  lineas.push("Te aviso una sola vez; cuando vuelva a correr te lo confirmo.");
  lineas.push("Detalle en panel.ejemplo.com → Inicio → Tareas programadas.");
  return lineas.join("\n");
}

function textoAvisoRecuperacion(tarea, registro, aviso, ahoraMs) {
  const okMs = new Date(registro.ultimo_ok_ts).getTime();
  const esperadaMs = new Date(aviso.esperada_ts).getTime();
  const llevaba = duracionTexto(Math.max(0, okMs - esperadaMs));
  // fechaHoraTexto() ya termina en "a. m."/"p. m.": ese punto hace de punto final.
  return [
    `✅ Volvió a correr: ${tarea.nombre_llano}.`,
    `Terminó ${fechaHoraTexto(okMs, ahoraMs)} Llevaba ${llevaba} sin correr.`,
  ].join("\n");
}

// ── Fábrica ─────────────────────────────────────────────────────────────────

/**
 * @param {Object} deps
 * @param {string}   deps.DIR_DATOS   "/var/lib/zeus-ops"
 * @param {Function} deps.leerJson    leerJson(archivo, porDefecto) de ops-server.js
 * @param {Function} deps.guardarJson guardarJson(archivo, obj) de ops-server.js
 * @param {Function} deps.auditar     auditar(accion, quien, resultado, detalle) de ops-server.js
 * @param {Function} deps.enviarWhatsapp  enviarWhatsapp(texto) → {ok, detalle}, ya existente
 * @param {Object}   [deps.permisos]    objeto de crearPermisos(...): usa permisos.permitido(id, tipo). Opcional: si falta, no se aplica el freno de permisos (igual que informe-semanal.js).
 * @param {Object}   [deps.kapsoYModo]  require("./modulos/kapso-y-modo.js"). Opcional.
 * @param {string}   [deps.F_MODO]      ruta a modo.json. Opcional.
 * @param {Function} [deps.ahora]       () => ms epoch. Por defecto Date.now. Mismo patrón inyectable que sos/puede-actuar.js.
 * @param {Array}    [deps.tareas]      tabla de tareas a vigilar. Por defecto TAREAS. Las pruebas inyectan tablas chicas.
 */
function crearLatidos(deps) {
  const { DIR_DATOS, leerJson, guardarJson, auditar, enviarWhatsapp } = deps || {};
  if (!DIR_DATOS || typeof leerJson !== "function" || typeof guardarJson !== "function" || typeof auditar !== "function") {
    throw new Error("crearLatidos necesita DIR_DATOS, leerJson, guardarJson y auditar de ops-server.js");
  }
  if (typeof enviarWhatsapp !== "function") {
    throw new Error("crearLatidos necesita enviarWhatsapp() de ops-server.js");
  }
  const permisos = deps.permisos || null;
  const kapsoYModo = deps.kapsoYModo || null;
  const F_MODO = deps.F_MODO || null;
  const ahora = typeof deps.ahora === "function" ? deps.ahora : Date.now;
  const tareasList = Array.isArray(deps.tareas) ? deps.tareas : TAREAS;
  const tareasPorId = new Map(tareasList.map((t) => [t.id, t]));

  const RUTA_ESTADO = path.join(DIR_DATOS, "latidos.json");

  function plantillaEstado() { return { version: 1, tareas: {} }; }

  /** Única vía de escritura: lee, aplica `fn` de forma síncrona, guarda.
   * Nunca hay un `await` entre la lectura y la escritura (§4.5 del diseño),
   * así que un `registrar()` que llegue mientras `revisar()` está esperando
   * un `enviarWhatsapp()` nunca se pierde. */
  function mutar(fn) {
    const estado = leerJson(RUTA_ESTADO, plantillaEstado());
    if (!estado.tareas) estado.tareas = {};
    fn(estado);
    guardarJson(RUTA_ESTADO, estado);
    return estado;
  }

  function leerEstado() {
    const estado = leerJson(RUTA_ESTADO, plantillaEstado());
    if (!estado.tareas) estado.tareas = {};
    return estado;
  }

  // ── registrar() — §3 del diseño ───────────────────────────────────────────

  function registrar(id, resultado, quien) {
    const quienFinal = quien || "agente";
    if (typeof id !== "string" || !ID_VALIDO.test(id)) {
      auditar("latido_rechazado", quienFinal, "rechazado", "id inválido");
      return { ok: false, motivo: "id_invalido" };
    }
    const tarea = tareasPorId.get(id);
    if (!tarea) {
      auditar("latido_desconocido", quienFinal, "rechazado", id);
      return { ok: false, motivo: "tarea_desconocida", mensaje: "No conozco ninguna tarea programada con ese nombre." };
    }

    const ok = !(resultado && resultado.ok === false);
    const detalle = String((resultado && resultado.detalle) || "").slice(0, 200);
    const nowIso = new Date(ahora()).toISOString();

    const estado = mutar((s) => {
      if (!s.tareas[id]) {
        s.tareas[id] = {
          sembrado_ts: nowIso, ultimo_ok_ts: null, ultimo_ok_detalle: "", ultimo_ok_quien: "",
          ultimo_fallo_ts: null, ultimo_fallo_detalle: "", aviso: null,
        };
      }
      const reg = s.tareas[id];
      if (ok) {
        reg.ultimo_ok_ts = nowIso; reg.ultimo_ok_detalle = detalle; reg.ultimo_ok_quien = quienFinal;
      } else {
        reg.ultimo_fallo_ts = nowIso; reg.ultimo_fallo_detalle = detalle;
      }
    });

    if (!ok) auditar("latido_fallo", quienFinal, "fallo", `${tarea.nombre_llano}: ${detalle}`);

    const reg = estado.tareas[id];
    return { ok: true, id, nombre: tarea.nombre_llano, ultimo_ok_ts: reg.ultimo_ok_ts, ultimo_fallo_ts: reg.ultimo_fallo_ts };
  }

  // ── Frenos de envío — mismo camino que enviarInformeSemanal ───────────────

  async function enviarConFrenos(texto, nivel) {
    if (permisos && typeof permisos.permitido === "function" && !permisos.permitido("whatsapp", "escritura")) {
      return { estado: "sin_permiso_whatsapp" };
    }
    if (kapsoYModo && F_MODO && typeof kapsoYModo.obtenerModo === "function" && typeof kapsoYModo.debeSilenciar === "function") {
      const modo = kapsoYModo.obtenerModo(leerJson, F_MODO);
      if (kapsoYModo.debeSilenciar(nivel, modo)) return { estado: "silenciado_modo_viaje" };
    }
    const r = await enviarWhatsapp(texto);
    return { estado: r && r.ok ? "enviado" : "fallo_envio" };
  }

  // ── revisar() — §4 del diseño ──────────────────────────────────────────────

  let enRevision = false;

  async function revisar() {
    if (enRevision) return { revisadas: 0, sembradas: [], faltas_nuevas: [], recuperadas: [], reintentos: [] };
    enRevision = true;
    try {
      const ahoraMs = ahora();
      const sembradas = [];
      const faltasNuevas = [];
      const recuperadas = [];
      const reintentos = [];

      // Sembrar de una sola vez las tareas que nunca se vieron.
      mutar((s) => {
        for (const t of tareasList) {
          if (!s.tareas[t.id]) {
            s.tareas[t.id] = {
              sembrado_ts: new Date(ahoraMs).toISOString(), ultimo_ok_ts: null, ultimo_ok_detalle: "", ultimo_ok_quien: "",
              ultimo_fallo_ts: null, ultimo_fallo_detalle: "", aviso: null,
            };
            sembradas.push(t.id);
          }
        }
      });

      for (const tarea of tareasList) {
        // Snapshot fresco antes de cada decisión (§4.5): un registrar() que
        // llegó mientras se procesaba la tarea anterior no se pierde.
        let registro = leerEstado().tareas[tarea.id];
        if (!registro) continue; // no debería pasar tras sembrar, defensivo
        const ev = evaluarTarea(tarea, registro, ahoraMs);

        // (c) Recuperación primero: si hay un aviso pendiente y el último OK
        // ya es posterior a la ocurrencia que faltó, se confirma y se limpia
        // el aviso sin importar si el envío se pudo mandar.
        const avisoPrevio = registro.aviso;
        if (avisoPrevio) {
          const okTs = registro.ultimo_ok_ts ? new Date(registro.ultimo_ok_ts).getTime() : null;
          const esperadaAviso = new Date(avisoPrevio.esperada_ts).getTime();
          if (okTs != null && okTs >= esperadaAviso) {
            const texto = textoAvisoRecuperacion(tarea, registro, avisoPrevio, ahoraMs);
            const r = await enviarConFrenos(texto, "info");
            mutar((s) => { s.tareas[tarea.id].aviso = null; });
            auditar("latido_recuperado", "agente", r.estado, tarea.nombre_llano);
            recuperadas.push(tarea.id);
            registro = leerEstado().tareas[tarea.id]; // releer: aviso ya es null
          }
        }

        if (ev.estado !== "falta") continue;

        const avisoActual = registro.aviso;
        if (!avisoActual) {
          // (b) Falta nueva.
          const nuevoAviso = { esperada_ts: new Date(ev.esperada).toISOString(), detectado_ts: new Date(ahoraMs).toISOString(), estado: "pendiente", ultimo_intento_ts: null, intentos: 0 };
          mutar((s) => { s.tareas[tarea.id].aviso = nuevoAviso; });
          const texto = textoAvisoFalta(tarea, ev, registro, ahoraMs);
          const r = await enviarConFrenos(texto, tarea.nivel);
          mutar((s) => {
            const a = s.tareas[tarea.id].aviso;
            a.estado = r.estado; a.ultimo_intento_ts = new Date(ahoraMs).toISOString(); a.intentos += 1;
          });
          auditar("latido_falta", "agente", r.estado, `${tarea.nombre_llano} · esperada ${nuevoAviso.esperada_ts}`);
          faltasNuevas.push(tarea.id);
        } else if (avisoActual.estado !== "enviado") {
          // (b') Falta ya avisada, pero el envío anterior no se logró: reintentar.
          const estadoPrevio = avisoActual.estado;
          const texto = textoAvisoFalta(tarea, ev, registro, ahoraMs);
          const r = await enviarConFrenos(texto, tarea.nivel);
          mutar((s) => {
            const a = s.tareas[tarea.id].aviso;
            a.estado = r.estado; a.ultimo_intento_ts = new Date(ahoraMs).toISOString(); a.intentos += 1;
          });
          if (r.estado !== estadoPrevio) {
            auditar("latido_falta", "agente", r.estado, `${tarea.nombre_llano} · esperada ${avisoActual.esperada_ts}`);
          }
          reintentos.push(tarea.id);
        }
        // else: ya se avisó y sigue en falta -> no repetir (regla de oro: un aviso por falta).
      }

      return { revisadas: tareasList.length, sembradas, faltas_nuevas: faltasNuevas, recuperadas, reintentos };
    } finally {
      enRevision = false;
    }
  }

  // ── estadoLatidos() — GET /api/latidos, §8 del diseño ───────────────────────

  // fechaHoraTexto() y cuandoTexto() ya terminan en "a. m."/"p. m." (con su
  // propio punto): cuando quedan al final de la frase, ESE punto hace de
  // punto final y no se le agrega otro encima (mismo criterio ya usado en
  // panel-final/app.js: "...a las 3:00 a. m. se guarda una copia...").
  function mensajeTarea(tarea, ev, registro, ahoraMs) {
    if (ev.estado === "ok") return `Corrió ${fechaHoraTexto(new Date(registro.ultimo_ok_ts).getTime(), ahoraMs)}`;
    if (ev.estado === "sin_datos") return `Todavía no ha corrido desde que empecé a vigilarla; le toca ${cuandoTexto(tarea)}`;
    if (ev.estado === "esperando") return `Le toca ahora (${horaAmPmUtc(tarea.hora_utc, tarea.minuto_utc)}); esperando que termine.`;
    // falta
    if (ev.con_error) {
      const cuando = registro.ultimo_fallo_ts ? fechaHoraTexto(new Date(registro.ultimo_fallo_ts).getTime(), ahoraMs) : "hace poco";
      return `Corrió ${cuando} pero terminó con error: ${registro.ultimo_fallo_detalle || "sin detalle"}.`;
    }
    if (!registro.ultimo_ok_ts) {
      const desde = registro.sembrado_ts ? fechaLargaDeMs(new Date(registro.sembrado_ts).getTime()) : "que empecé a vigilarla";
      return `Nunca la he visto terminar desde el ${desde}; le toca ${cuandoTexto(tarea)}`;
    }
    return `Debió correr ${fechaHoraTexto(ev.esperada, ahoraMs)} y lleva ${ev.retraso_min} minutos sin señal. Último OK: ${fechaHoraTexto(new Date(registro.ultimo_ok_ts).getTime(), ahoraMs)}`;
  }

  function estadoLatidos() {
    const ahoraMs = ahora();
    const estadoArchivo = leerEstado();
    const resumen = { total: tareasList.length, ok: 0, esperando: 0, sin_datos: 0, faltan: 0 };
    let peorNivel = "ok";
    const conFalta = [];

    const tareas = tareasList.map((tarea) => {
      const registro = estadoArchivo.tareas[tarea.id] || null;
      const ev = evaluarTarea(tarea, registro, ahoraMs);

      if (ev.estado === "ok") resumen.ok += 1;
      else if (ev.estado === "esperando") resumen.esperando += 1;
      else if (ev.estado === "sin_datos") resumen.sin_datos += 1;
      else { resumen.faltan += 1; conFalta.push(tarea.nombre_llano); }

      const nivel = ev.estado === "falta" ? tarea.nivel : "ok";
      if (nivel === "crit") peorNivel = "crit";
      else if (nivel === "warn" && peorNivel !== "crit") peorNivel = "warn";

      return {
        id: tarea.id,
        nombre: tarea.nombre_llano,
        cuando: cuandoTexto(tarea),
        estado: ev.estado,
        nivel,
        mensaje: mensajeTarea(tarea, ev, registro || { ultimo_ok_ts: null, ultimo_fallo_ts: null, sembrado_ts: null }, ahoraMs),
        ultimo_ok: registro && registro.ultimo_ok_ts ? registro.ultimo_ok_ts : null,
        ultimo_ok_texto: registro && registro.ultimo_ok_ts ? fechaHoraTexto(new Date(registro.ultimo_ok_ts).getTime(), ahoraMs) : null,
        esperada: new Date(ev.esperada).toISOString(),
        esperada_texto: fechaHoraTexto(ev.esperada, ahoraMs),
        retraso_min: ev.retraso_min,
        ultimo_fallo: registro && registro.ultimo_fallo_ts
          ? { ts: registro.ultimo_fallo_ts, texto: fechaHoraTexto(new Date(registro.ultimo_fallo_ts).getTime(), ahoraMs), detalle: registro.ultimo_fallo_detalle || "" }
          : null,
        aviso: registro && registro.aviso
          ? { estado: registro.aviso.estado, detectado: registro.aviso.detectado_ts, intentos: registro.aviso.intentos }
          : null,
      };
    });

    const mensaje = conFalta.length
      ? `${conFalta.length} de ${resumen.total} tareas programadas no ${conFalta.length === 1 ? "corrió" : "corrieron"}: ${conFalta.join(", ")}.`
      : (resumen.sin_datos
        ? `Las tareas programadas corrieron a tiempo; ${resumen.sin_datos} todavía no ${resumen.sin_datos === 1 ? "ha corrido" : "han corrido"} desde que empecé a vigilarlas.`
        : `Las ${resumen.total} tareas programadas corrieron a tiempo.`);

    return { generado: new Date(ahoraMs).toISOString(), nivel: peorNivel, mensaje, resumen, tareas };
  }

  return {
    registrar,
    revisar,
    estadoLatidos,
    textoAvisoFalta,
    textoAvisoRecuperacion,
    CONSTANTES: { TAREAS: tareasList, INTERVALO_REVISION_MS, DESFASE_COLOMBIA_H, rutas: { estado: RUTA_ESTADO } },
  };
}

module.exports = { crearLatidos, TAREAS, calcularUltimaEsperada, evaluarTarea, INTERVALO_REVISION_MS };
