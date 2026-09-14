"use strict";
/**
 * modulos/centinela-comandos.js
 *
 * Intérprete del menú de WhatsApp de Centinela (DISENO-SOS.md §14) y del
 * lenguaje natural del dueño. Corre DENTRO de ops-server.js, en el HOST
 * (Node 20, cero dependencias externas — solo "path" del núcleo).
 *
 * Lo que resuelve:
 *  - El menú numerado de 19 opciones, con confirmación para las que ejecutan
 *    algo (4, 8, 12, 14, 19).
 *  - Lenguaje natural: reconoce intención sin gastar IA cuando puede
 *    contestar con datos reales, y SIEMPRE pide confirmación por número
 *    antes de ejecutar cualquier acción que cambie algo, sin excepción.
 *  - Varias preguntas en un solo mensaje (el fallo real: "solo contesta la
 *    primera"): se parte el texto y cada pedazo se resuelve; las preguntas
 *    libres se agrupan en una sola llamada a Gemini.
 *  - El menú numerado NUNCA gasta consultas de IA. Solo el lenguaje natural
 *    que no tiene respuesta determinista la usa, y solo si queda cupo.
 *
 * Contrato de dependencias (todas ya existen en ops-server.js u otro módulo
 * ya integrado; nada se inventa aquí):
 *
 *   sh, auditar, enviarWhatsapp                    — núcleo de ops-server.js
 *   DIR_DATOS, leerJson, guardarJson                — núcleo de ops-server.js
 *   estadoGeneral, prediccion, estadoRespaldos,
 *   estadoDatos, estadoSeguridad, ejecutarAccion,
 *   baseIncidentes, textoResumen                    — funciones ya existentes de ops-server.js
 *   historialReinicios                              — opcional; si no se pasa, esa
 *                                                      pregunta puntual cae a lenguaje libre
 *   kapsoYModo, F_MODO                               — modulos/kapso-y-modo.js
 *   preguntarAGemini(persona, contexto, pregunta, opciones)
 *   armarContextoCentinela, registrarConsultaIA,
 *   leerPersonaCentinela, LIMITE_CONSULTAS_DIA        — bloque Centinela de ops-server.js
 *   sos            — objeto devuelto por crearSos() (modulos/sos/sos.js):
 *                    { lanzar, corridas, corrida, evidencia:{listar}, ejecutarReinicioBotManual, resumenParaContexto }
 *   textos         — modulos/sos/textos.js (nombreClaro, tituloSintoma, haceTexto, horaColombia)
 *   simulacros     — modulos/simulacros/simulacros.js ya instanciado (para el aviso de "no por WhatsApp")
 *
 * Nada de esto se ejecuta si no se llama a `manejar(pregunta)`. El módulo no
 * guarda estado propio en memoria entre llamadas (todo lo que necesita
 * sobrevivir un reinicio del proceso, como la confirmación pendiente, se
 * guarda en disco con guardarJson/leerJson, igual que el resto de Centinela).
 */

const path = require("path");
const { esAcuse } = require("./escalamiento.js");

// ── Vocabulario del menú (§14.2 de DISENO-SOS.md, texto exacto) ────────────

const TEXTO_MENU = [
  "Centinela — escribe /centinela y el número",
  "",
  "1  SOS: revisar y reparar todo (automático)",
  "2  ¿Cómo va todo ahora?",
  "3  El bot no está contestando",
  "4  Reiniciar el bot de WhatsApp",
  "5  Hay una consulta trabada en la base",
  "6  Fallas y reparaciones recientes",
  "7  Deshacer el último cambio",
  "8  La puerta de entrada no responde",
  "9  El servicio va y viene solo",
  "10 Conexiones a la base de datos",
  "11 Copias de seguridad",
  "12 Hacer una copia ahora",
  "13 El certificado del sitio",
  "14 Liberar espacio en el disco",
  "15 ¿La memoria del bot viene subiendo?",
  "16 Seguridad",
  "17 ¿Hubo alguna caída corta?",
  "18 Registros guardados",
  "19 Modo viaje (encender o apagar)",
  "",
  "Las opciones 4, 8, 12, 14 y 19 piden confirmar: /centinela 4 si",
  "También puedes preguntarme en tus palabras: /centinela ¿por qué está lento?",
].join("\n");

// Opciones que ejecutan algo y por eso piden confirmación explícita.
const OPCIONES_CONFIRMAN = new Set([4, 8, 12, 14, 19]);
const OPCIONES_VALIDAS = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);

const CINCO_MINUTOS_MS = 5 * 60 * 1000;
const QUINCE_MINUTOS_MS = 15 * 60 * 1000;

// ── Utilidades puras (fáciles de probar sin montar el servidor) ────────────

/** Normaliza el texto de confirmación a "si" | "no" | null. */
function normalizarConfirmacion(token) {
  if (!token) return null;
  const t = token.trim().toLowerCase();
  if (t === "no") return "no";
  if (t === "si" || t === "sí" || t === "reiniciar") return "si";
  return null;
}

/**
 * Clasifica un fragmento de texto según la gramática exacta de §14.4.
 * Devuelve una de:
 *   { tipo: "menu" }
 *   { tipo: "opcion", n, confirmacion: "si"|"no"|null }
 *   { tipo: "libre", texto }
 * Nunca lanza. `texto` ya debe venir recortado (trim).
 */
function clasificarGramatica(texto) {
  const t = (texto || "").trim();
  if (t === "" || /^(menu|ayuda|0)$/i.test(t)) return { tipo: "menu" };
  if (/^sos\b/i.test(t)) return { tipo: "opcion", n: 1, confirmacion: null };
  const m = t.match(/^(\d{1,2})\s*(si|sí|no|reiniciar)?\s*$/i);
  if (m) return { tipo: "opcion", n: parseInt(m[1], 10), confirmacion: normalizarConfirmacion(m[2]) };
  return { tipo: "libre", texto: t };
}

/**
 * Parte un mensaje en varios fragmentos cuando el dueño hizo varias
 * preguntas juntas (el fallo real reportado). Reglas, en este orden:
 *   1. Saltos de línea.
 *   2. Ocurrencias repetidas de "/centinela" (por si el dueño copia y pega
 *      varios comandos seguidos).
 *   3. Enumeración propia del dueño dentro de una misma línea, del estilo
 *      "1) ...", "2. ...", "3 ...": es la forma real en que llegó el
 *      mensaje que reveló el problema ("hay algo de qué preocuparme y
 *      2) cómo va el servidor 3) cuándo fue el último backup").
 * Los marcadores de enumeración del dueño NO son números de opción del
 * menú (eso ya se resolvió en clasificarGramatica para el mensaje
 * completo); aquí solo se usan para cortar el texto, y el número se
 * descarta.
 * Devuelve un arreglo de strings ya recortados, sin vacíos. Si el mensaje
 * no tiene más de un fragmento real, devuelve un arreglo de un solo
 * elemento con el texto original (sin partir nada).
 */
function partirFragmentos(texto) {
  const original = (texto || "").trim();
  if (!original) return [];

  let piezas = original.split(/\r?\n+/);
  piezas = piezas.flatMap((p) => p.split(/\/centinela\b/i));
  piezas = piezas.flatMap((p) => p.split(/(?:^|\s)\d{1,2}[)\.]\s+/));

  const limpias = piezas.map((p) => p.trim()).filter(Boolean);
  return limpias.length ? limpias : [original];
}

// ── Fábrica principal ───────────────────────────────────────────────────────

function crearComandosCentinela(deps) {
  const {
    DIR_DATOS, leerJson, guardarJson, auditar, enviarWhatsapp,
    estadoGeneral, prediccion, estadoRespaldos, estadoDatos, estadoSeguridad,
    ejecutarAccion, baseIncidentes, textoResumen,
    historialReinicios,
    kapsoYModo, F_MODO,
    preguntarAGemini, armarContextoCentinela, registrarConsultaIA, leerPersonaCentinela,
    sos, textos, simulacros,
    LIMITE_CONSULTAS_DIA,
    escalamiento, // opcional: modulos/escalamiento.js (acuse de avisos críticos)
    vigia, // opcional: modulos/vigia-tendencias.js (feedback "util"/"ruido", tendencia de memoria)
    // Opcionales del menú ampliado (11-19-item): cada uno se apoya en un módulo
    // que ya existe y ya se probó por su cuenta — nada de esto reimplementa
    // detección, solo la expone en español llano por WhatsApp.
    botMudo, // modulos/bot-mudo.js
    seguridadAuditoria, sh, // modulos/seguridad-auditoria.js (certificado real)
    dbProcesos, mysql, // modulos/db-procesos.js (consultas trabadas)
    observacionDespliegue, // modulos/observacion-despliegue.js (último despliegue)
    memoriaIncidentes, // modulos/memoria-incidentes.js (guía sugerida si hay bucle)
    leerJsonl, F_HIST, // historial.jsonl (caídas cortas recientes)
    CONTENEDORES_PROPIOS, // Set con los 4 nombres propios (para el chequeo de bucle)
  } = deps;

  const RUTA_PENDIENTE = path.join(DIR_DATOS, "centinela-pendiente.json");

  function leerPendiente() {
    return leerJson(RUTA_PENDIENTE, null);
  }
  function guardarPendiente(opcion) {
    guardarJson(RUTA_PENDIENTE, { opcion, ts: Date.now() });
  }
  function borrarPendiente() {
    guardarJson(RUTA_PENDIENTE, null);
  }

  /** true si hay una confirmación pendiente vigente (< 5 min) para esa opción. */
  function hayPendienteVigente(n) {
    const p = leerPendiente();
    return !!(p && p.opcion === n && Date.now() - p.ts < CINCO_MINUTOS_MS);
  }

  /**
   * Excepción de §14.4: opción 4 (reiniciar el bot) sin pendiente, pero el
   * último SOS (< 15 min) terminó `detenido_pide_ayuda` con el bot como
   * afectado. Así el dueño puede reaccionar al mensaje del SOS con
   * "/centinela 4 si" sin tener que pedir la opción sin confirmar primero.
   */
  function ultimoSosJustificaReinicioBot() {
    if (!sos || typeof sos.corridas !== "function") return false;
    try {
      const ultima = (sos.corridas(1).corridas || [])[0];
      if (!ultima || !ultima.fin) return false;
      const haceMs = Date.now() - new Date(ultima.fin).getTime();
      return haceMs >= 0 && haceMs < QUINCE_MINUTOS_MS &&
        ultima.resultado === "detenido_pide_ayuda" &&
        ultima.sintoma_principal === "bot_caido";
    } catch (_) {
      return false;
    }
  }

  // ── Textos deterministas de cada opción (sin IA) ─────────────────────────

  async function textoOpcion2() {
    const [estado, pred, respaldo] = await Promise.all([estadoGeneral(), prediccion(), estadoRespaldos()]);
    let texto = textoResumen(estado, pred, respaldo);
    if (sos && typeof sos.resumenParaContexto === "function") {
      const r = sos.resumenParaContexto();
      if (r && r.fin && new Date(r.fin).toISOString().slice(0, 10) === new Date().toISOString().slice(0, 10)) {
        texto += `\n\nÚltima revisión SOS de hoy: ${textos.tituloSintoma(r.sintoma_principal).toLowerCase()} (${r.resultado}).`;
      }
    }
    return texto;
  }

  async function textoOpcion3() {
    const lineas = ["Fallas y reparaciones recientes", ""];
    const base = baseIncidentes ? baseIncidentes() : { historial: [] };
    const historial = (base.historial || []).slice(-5).reverse();
    if (historial.length) {
      lineas.push("Incidentes:");
      historial.forEach((h) => {
        const nombre = textos.nombreClaro(h.servicio || h.nombre || "");
        lineas.push(`- ${nombre}: ${h.resumen || h.motivo || "revisado"} (${textos.haceTexto(h.fin || h.inicio)})`);
      });
    }
    if (sos && typeof sos.corridas === "function") {
      const ultimas = (sos.corridas(3).corridas || []);
      if (ultimas.length) {
        lineas.push("", "Últimas corridas de SOS:");
        ultimas.forEach((c) => {
          lineas.push(`- ${textos.tituloSintoma(c.sintoma_principal)}: ${c.resultado} (${textos.haceTexto(c.fin || c.inicio)})`);
        });
      }
    }
    if (historial.length === 0 && (!sos || !(sos.corridas(3).corridas || []).length)) {
      lineas.push("Sin fallas registradas recientemente.");
    }
    return lineas.join("\n");
  }

  async function textoOpcion4() {
    const r = await estadoRespaldos();
    const lineas = ["Copias de seguridad", ""];
    if (r.ultimo) {
      lineas.push(`Última copia: hace ${r.ultimo.horas} horas, ${r.ultimo.mb} MB.`);
    } else {
      lineas.push("Todavía no hay ninguna copia guardada en este servidor.");
    }
    lineas.push(`Google Drive: ${r.drive.conectado ? "conectado" : "desconectado — " + r.drive.motivo}.`);
    lineas.push(`Copias guardadas en el servidor: ${r.total} (${r.espacio_mb} MB en total).`);
    lineas.push(`Próxima copia automática: ${r.hora}.`);
    return lineas.join("\n");
  }

  async function textoOpcion7() {
    const s = await estadoSeguridad();
    const lineas = [`Seguridad — puntaje ${s.puntaje} de 100`, ""];
    s.checklist.forEach((c) => lineas.push(`${c.ok ? "✓" : "✕"} ${c.t}: ${c.d}`));
    if (s.baneos.actuales > 0) lineas.push("", `Direcciones bloqueadas ahora mismo: ${s.baneos.actuales}.`);
    return lineas.join("\n");
  }

  async function textoOpcion8() {
    if (!sos || !sos.evidencia || typeof sos.evidencia.listar !== "function") {
      return "No hay registros guardados todavía.";
    }
    const idx = sos.evidencia.listar();
    const paquetes = (idx.paquetes || []).slice(0, 5);
    const lineas = ["Registros guardados", ""];
    if (!paquetes.length) {
      lineas.push("Todavía no hay ningún registro guardado.");
    } else {
      paquetes.forEach((p) => {
        lineas.push(`- ${textos.haceTexto(p.ts)}: ${p.titulo || textos.tituloSintoma(p.sintoma_principal)} (${Math.round((p.bytes || 0) / 1024)} KB)`);
      });
    }
    lineas.push("", "Para verlos y copiarlos: panel.ejemplo.com → Registros.");
    return lineas.join("\n");
  }

  // ── Menú ampliado (11 → 19 opciones): cada texto se apoya en un módulo que
  // ya existe y ya se probó por su cuenta; nada aquí reimplementa detección.

  async function textoOpcionBotMudo() {
    if (!botMudo || typeof botMudo.estado !== "function") return "No tengo esa información ahora mismo.";
    const b = botMudo.estado();
    return `${b.titulo}${b.detalle ? "\n\n" + b.detalle : ""}` +
      (b.nivel === "crit" ? "\n\nEscribe /centinela 4 si para reiniciarlo, o /centinela 1 para que lo revise y repare todo." : "");
  }

  async function textoOpcionConsultaTrabada() {
    if (!dbProcesos || typeof mysql !== "function") return "No tengo esa información ahora mismo.";
    const r = await dbProcesos.listarProcesos(mysql);
    if (!r.ok) return r.mensaje;
    if (!r.hay_trabadas) return "Ninguna consulta lleva trabada más tiempo del esperado.";
    const lineas = [r.resumen, ""];
    r.trabadas.slice(0, 5).forEach((p) => {
      lineas.push(`- #${p.id} (${p.tiempo_texto}, ${p.base || "sin base"}): ${p.consulta.slice(0, 100) || "(sin detalle)"}`);
    });
    lineas.push("", "Para detenerla: panel.ejemplo.com → Optimización.");
    return lineas.join("\n");
  }

  async function textoOpcionUltimoDespliegue() {
    if (!observacionDespliegue || typeof observacionDespliegue.estado !== "function") return "No tengo esa información ahora mismo.";
    const e = observacionDespliegue.estado();
    if (e.en_curso) {
      return "Estoy vigilando un despliegue reciente por si hace falta deshacerlo. Si detecto que causó una falla, el SOS (opción 1) lo revierte solo.";
    }
    if (!e.ultima) return "No tengo un despliegue reciente para mostrar.";
    const u = e.ultima;
    return (
      `Último despliegue observado: ${textos.haceTexto(u.ts || u.fin)}.\n` +
      `${u.revirtio ? "Se tuvo que deshacer (causó una falla)." : "Quedó estable, sin problemas."}` +
      (u.veredicto ? `\n${u.veredicto}` : "") +
      "\n\nSi un despliegue reciente rompió algo ahora mismo, escribe /centinela 1 (SOS): si el culpable es un despliegue de menos de 24 horas, lo deshace sola."
    );
  }

  async function textoOpcionPuerta() {
    const estado = await estadoGeneral();
    const c = (estado.contenedores || []).find((x) => x.nombre === "zeus-proxy");
    if (!c) return "No encuentro información de la puerta de entrada ahora mismo.";
    if (c.estado === "running" && c.salud !== "unhealthy") {
      return "La puerta de entrada (zeus-proxy) está funcionando con normalidad.";
    }
    return `La puerta de entrada no está bien: ${c.estado !== "running" ? "está apagada" : "no pasa su chequeo de salud"}.\n\nEscribe /centinela 8 si para reiniciarla (no toca el bot, la base ni la memoria de búsqueda).`;
  }

  async function textoOpcionBucle() {
    const estado = await estadoGeneral();
    const propios = CONTENEDORES_PROPIOS ? Array.from(CONTENEDORES_PROPIOS) : ["zeus-bot", "zeus-mariadb", "zeus-chromadb", "zeus-proxy"];
    const enBucle = (estado.contenedores || []).filter((c) => propios.includes(c.nombre) && (c.reinicios || 0) > 3);
    if (!enBucle.length) {
      const sug = memoriaIncidentes && typeof memoriaIncidentes.sugerenciaActual === "function" ? memoriaIncidentes.sugerenciaActual() : null;
      if (sug) return `No veo ningún servicio en bucle ahora mismo.\n\nSí tengo una guía sugerida de un problema reciente: "${sug.titulo}". Para verla: panel.ejemplo.com → Datos técnicos.`;
      return "No veo ningún servicio apagándose y encendiéndose solo.";
    }
    const nombres = enBucle.map((c) => textos.nombreClaro(c.nombre)).join(", ");
    return `${nombres} ${enBucle.length === 1 ? "lleva" : "llevan"} varios reinicios seguidos — probablemente algo lo sigue tumbando, no basta con reiniciar otra vez.\n\nEscribe /centinela 1 (SOS) para que revise la causa en vez de reiniciar en bucle.`;
  }

  async function textoOpcionConexiones() {
    if (!dbProcesos || typeof mysql !== "function") return "No tengo esa información ahora mismo.";
    const r = await dbProcesos.listarProcesos(mysql);
    if (!r.ok) return r.mensaje;
    const activas = r.procesos.length;
    return (
      `Conexiones abiertas a la base de datos ahora mismo: ${activas}.\n` +
      (r.hay_trabadas
        ? `${r.trabadas.length} de ellas están trabadas esperando un bloqueo. Escribe /centinela 5 para verlas.`
        : "Ninguna está trabada.")
    );
  }

  async function textoOpcionCertificado() {
    if (!seguridadAuditoria || typeof sh !== "function") return "No tengo esa información ahora mismo.";
    try {
      const r = await seguridadAuditoria.auditoriaCompleta(sh);
      const h = (r.hallazgos || []).find((x) => x.id === "certificado_ssl");
      if (!h) return "No pude revisar el certificado ahora mismo.";
      return `${h.significado}${h.detalle ? "\n" + h.detalle : ""}`;
    } catch (_) {
      return "No pude revisar el certificado ahora mismo.";
    }
  }

  async function textoOpcionMemoriaBot() {
    const [estado, pred] = await Promise.all([estadoGeneral(), prediccion()]);
    const c = (estado.contenedores || []).find((x) => x.nombre === "zeus-bot");
    const pronMem = (pred.pronosticos || []).find((p) => p && p.recurso === "Memoria");
    const lineas = [`Memoria del servidor: ${estado.ram.pct} % usada.${c ? ` El bot usa ${c.memoria} ahora mismo.` : ""}`];
    if (pronMem && pronMem.dias != null) {
      lineas.push(pronMem.cortado
        ? `Viene subiendo ${pronMem.ritmo} al día, pero el reinicio diario del bot la corta antes de ser un problema.`
        : `Viene subiendo ${pronMem.ritmo} al día — al ritmo actual llegaría al 90 % en ${pronMem.dias} día(s).`);
      if (!pronMem.cortado && pronMem.dias <= 3) {
        lineas.push("", "Escribe /centinela 4 si para reiniciar el bot ahora, antes de que se quede sin memoria.");
      }
    } else {
      lineas.push("Todavía no tengo suficiente historial para ver la tendencia.");
    }
    return lineas.join("\n");
  }

  async function textoOpcionCaidaCorta() {
    if (typeof leerJsonl !== "function" || !F_HIST) return "No tengo esa información ahora mismo.";
    const muestras = (leerJsonl(F_HIST, 180) || []).slice(-180); // últimas ~3 horas (1 muestra/min)
    if (!muestras.length) return "Todavía no tengo suficiente historial para revisar esto.";
    const pico = muestras.reduce((m, s) => (s && s.cpu > (m ? m.cpu : -1) ? s : m), null);
    if (!pico || pico.cpu < 80) return "No veo ningún pico raro de procesador en las últimas 3 horas.";
    const hace = Math.round((Date.now() - pico.t * 1000) / 60000);
    return `Hace ${hace} minuto(s) el procesador llegó a ${pico.cpu} % (carga ${pico.carga}). Si ya volvió a lo normal, no hace falta hacer nada — si sigue lento, escribe /centinela 1 (SOS).`;
  }

  async function textoOpcionEspacioInformativo() {
    const estado = await estadoGeneral();
    const gb = (b) => Math.round(b / 1073741824);
    return (
      `Disco: ${estado.disco.pct} % usado, ${gb(estado.disco.libre)} GB libres.\n` +
      `Memoria: ${estado.ram.pct} % usada.` +
      (estado.disco.pct >= 80 ? "\n\nConviene liberar espacio pronto: escribe /centinela 14 si para hacerlo." : "")
    );
  }

  async function textoUltimoReinicioServidor() {
    if (typeof historialReinicios !== "function") return null;
    const h = await historialReinicios();
    const ultimo = (h.historial || [])[0];
    if (!ultimo) return `No encontré reinicios recientes del servidor. Próximo reinicio programado: ${h.proximo}.`;
    return (
      `El servidor se detuvo por última vez el ${ultimo.fecha} a las ${ultimo.hora} (${ultimo.tipo === "Manual o inesperado" ? "no fue el programado" : "reinicio programado"}).\n` +
      `Próximo reinicio programado: ${h.proximo}.`
    );
  }

  // ── Vista previa + ejecución de las opciones que confirman ──────────────

  function textoPreviaOpcion(n) {
    switch (n) {
      case 4:
        return "Voy a reiniciar el bot de WhatsApp. Corta las conversaciones en curso por unos 20 segundos y luego vuelve solo.";
      case 8:
        return "Voy a reiniciar la puerta de entrada (zeus-proxy). El panel y las visitas quedan sin responder unos 10 segundos; el bot, la base y la memoria de búsqueda no se tocan.";
      case 12:
        return "Voy a iniciar una copia de seguridad de la base de datos. Tarda unos minutos y no interrumpe el servicio.";
      case 14:
        return "Voy a liberar espacio en el disco: borro archivos temporales y sobras de actualizaciones. No toco tus datos ni tus copias de seguridad.";
      case 19: {
        const modo = kapsoYModo.obtenerModo(leerJson, F_MODO);
        return modo.activo
          ? "Voy a apagar el modo viaje (vuelven todos los avisos normales)."
          : "Voy a encender el modo viaje (silencia los avisos que no sean urgentes).";
      }
      default:
        return "Voy a ejecutar esa opción.";
    }
  }

  /** Ejecuta una opción con confirmación ya validada. Devuelve el texto de respuesta inmediata. */
  async function ejecutarOpcionConfirmada(n) {
    if (n === 19) {
      // Rápido: no hace falta diferir.
      const modo = kapsoYModo.obtenerModo(leerJson, F_MODO);
      const nuevo = kapsoYModo.fijarModo(guardarJson, F_MODO, !modo.activo, "desde WhatsApp");
      auditar("modo_viaje", "bot", "ok", nuevo.activo ? "encendido" : "apagado");
      return nuevo.activo
        ? "Listo: modo viaje encendido. Solo te avisaré de caídas que no pueda resolver solo."
        : "Listo: modo viaje apagado. Vuelves a recibir todos los avisos.";
    }

    if (n === 12) {
      ejecutarAccion("respaldar").then(async (r) => {
        auditar("centinela_menu_respaldar", "bot", r.ok ? "ok" : "falló", r.mensaje || "");
        await enviarWhatsapp(r.ok ? `✅ Copia de seguridad terminada. ${r.mensaje}` : `⚠️ La copia de seguridad falló. ${r.mensaje}`).catch(() => {});
      }).catch(async (e) => {
        await enviarWhatsapp(`⚠️ La copia de seguridad falló: ${e.message}`).catch(() => {});
      });
      return "Iniciando la copia de seguridad. Te aviso por aquí cuando termine (puede tardar unos minutos).";
    }

    if (n === 14) {
      ejecutarAccion("optimizar").then(async (r) => {
        auditar("centinela_menu_optimizar", "bot", r.ok ? "ok" : "falló", r.mensaje || "");
        await enviarWhatsapp(r.ok ? `✅ Espacio liberado. ${r.mensaje}` : `⚠️ No pude liberar espacio. ${r.mensaje}`).catch(() => {});
      }).catch(async (e) => {
        await enviarWhatsapp(`⚠️ No pude liberar espacio: ${e.message}`).catch(() => {});
      });
      return "Liberando espacio en el disco. Te aviso por aquí cuando termine.";
    }

    if (n === 4) {
      if (!sos || typeof sos.ejecutarReinicioBotManual !== "function") {
        return "No puedo reiniciar el bot en este momento (falta el módulo del SOS). Hazlo desde el panel.";
      }
      sos.ejecutarReinicioBotManual("bot").then(async (r) => {
        await enviarWhatsapp(r.mensaje).catch(() => {});
      }).catch(async (e) => {
        await enviarWhatsapp(`⚠️ No pude reiniciar el bot: ${e.message}`).catch(() => {});
      });
      return "Voy a reiniciar el bot de WhatsApp. Tarda unos 20 segundos. Te aviso por aquí cuando esté listo.";
    }

    if (n === 8) {
      ejecutarAccion("reiniciar_contenedor", "zeus-proxy").then(async (r) => {
        auditar("centinela_menu_reiniciar_proxy", "bot", r.ok ? "ok" : "falló", r.mensaje || "");
        await enviarWhatsapp(r.ok ? `✅ Puerta de entrada reiniciada. ${r.mensaje || ""}` : `⚠️ No pude reiniciar la puerta de entrada. ${r.mensaje || ""}`).catch(() => {});
      }).catch(async (e) => {
        await enviarWhatsapp(`⚠️ No pude reiniciar la puerta de entrada: ${e.message}`).catch(() => {});
      });
      return "Voy a reiniciar la puerta de entrada. Tarda unos segundos. Te aviso por aquí cuando esté listo.";
    }

    return "No sé cómo ejecutar esa opción.";
  }

  /** Opción 1 (SOS) y su alias "sos": respuesta inmediata, el resultado final lo manda el propio SOS. */
  async function ejecutarSos() {
    if (simulacros && typeof simulacros.estado === "function" && simulacros.estado().en_curso) {
      return "Hay un simulacro en curso ahora mismo; espera a que termine antes de lanzar el SOS (o detenlo desde el panel).";
    }
    const r = await sos.lanzar("bot");
    auditar("centinela_menu_sos", "bot", "ok", r.ya_en_curso ? "ya_en_curso" : r.run_id);
    return r.ya_en_curso
      ? "Ya hay un SOS en curso; sigo revisando. Te aviso apenas termine."
      : "🆘 SOS iniciado. Reviso todo el servidor, reparo lo que pueda y te aviso apenas termine (puede tardar varios minutos).";
  }

  /** Resuelve una opción del menú (1 a 19) ya sin ambigüedad de confirmación. */
  async function resolverOpcion(n, confirmacion) {
    if (!OPCIONES_VALIDAS.has(n)) {
      return "No conozco esa opción. Escribe /centinela menu para ver las 19 opciones.";
    }

    if (n === 1) return ejecutarSos();

    if (OPCIONES_CONFIRMAN.has(n)) {
      if (confirmacion === "no") {
        const p = leerPendiente();
        if (p && p.opcion === n) { borrarPendiente(); return "Cancelado. No hice nada."; }
        return "No había nada pendiente para esa opción.";
      }
      const confirmado = confirmacion === "si" && (hayPendienteVigente(n) || (n === 4 && ultimoSosJustificaReinicioBot()));
      if (confirmado) {
        borrarPendiente();
        return ejecutarOpcionConfirmada(n);
      }
      if (confirmacion === "si") {
        return "Primero pide la opción sin el 'si', para que veas qué hace.";
      }
      guardarPendiente(n);
      return `${textoPreviaOpcion(n)}\n\nPara confirmar responde: /centinela ${n} si (vale por 5 minutos).`;
    }

    // Opciones informativas: 2, 3, 5, 6, 7, 9, 10, 11, 13, 16, 17, 18 — sin confirmación, sin IA.
    switch (n) {
      case 2: return textoOpcion2();
      case 3: return textoOpcionBotMudo();
      case 5: return textoOpcionConsultaTrabada();
      case 6: return textoOpcion3();
      case 7: return textoOpcionUltimoDespliegue();
      case 9: return textoOpcionBucle();
      case 10: return textoOpcionConexiones();
      case 11: return textoOpcion4();
      case 13: return textoOpcionCertificado();
      case 15: return textoOpcionMemoriaBot();
      case 16: return textoOpcion7();
      case 17: return textoOpcionCaidaCorta();
      case 18: return textoOpcion8();
      default: return "No conozco esa opción.";
    }
  }

  // ── Reconocimiento de intención en lenguaje natural (sin IA) ────────────
  // Regla dura: una intención de ACCIÓN nunca se ejecuta directo; se resuelve
  // exactamente como si el dueño hubiera escrito el número de esa opción sin
  // confirmar (queda pendiente, pide "/centinela N si").

  const INTENCIONES_ACCION = [
    { n: 12, patron: /\b(hacer|haz|hazme|sacar|generar)\b.*\b(backup|copia)\b|\bbackup\s+ahora\b|\brespaldar\s+ahora\b/i },
    { n: 14, patron: /\b(liberar|limpiar|libera|limpia)\b.*\b(espacio|disco)\b/i },
    { n: 19, patron: /\bmodo\s+viaje\b/i },
    { n: 4, patron: /\b(reinicia|reiniciar|reinícia)\b.*\bbot\b|\bbot\b.*\b(reinicia|reiniciar)\b/i },
  ];

  const INTENCIONES_INFO = [
    { fn: "espacio", patron: /\b(espacio|disco)\b/i, excluye: /\b(liberar|limpiar)\b/i },
    { fn: "backup_ultimo", patron: /\b(cu[aá]ndo|hace\s+cu[aá]nto)\b.*\b(backup|copia|respaldo)\b|\b(backup|copia|respaldo)\b.*\b(cu[aá]ndo)\b/i },
    { fn: "resumen", patron: /\bc[oó]mo\s+(va|est[aá])\b.*\b(servidor|todo|negocio)\b|\balgo\s+de\s+qu[eé]\s+preocuparme\b|\bpreocuparme\b/i },
    { fn: "reinicio_servidor", patron: /\b[uú]ltima\s+vez\b.*\b(deten|ca[ií]|reinici)/i },
    { fn: "fallas", patron: /\bfallas?\b|\bqu[eé]\s+pas[oó]\b|\bqu[eé]\s+fall[oó]\b/i },
  ];

  // Palabras que indican una acción de riesgo que NO está en el menú de
  // WhatsApp (por diseño: DISENO-SOS.md §14.3). Nunca se ejecutan; solo se
  // explica dónde hacerlas.
  const PATRON_SIMULACRO = /\bsimulacro\b/i;
  const PATRON_REINICIO_SERVIDOR_COMPLETO = /\breinicia?r?\b.*\bservidor\b(?!.*\bbot\b)/i;
  const PATRON_VERBOS_RIESGO = /\b(borrar|eliminar|apagar|tumbar|restaurar|revertir|deshacer|actualizar)\b/i;

  /**
   * Intenta resolver una frase en lenguaje natural sin usar IA: primero
   * comprueba si pide algo peligroso fuera del menú, luego si coincide con
   * una acción del menú (nunca se ejecuta directo) y por último si coincide
   * con una pregunta informativa determinista.
   * Devuelve un string con la respuesta si pudo resolverla localmente, o
   * `null` si hay que mandarla a la IA (pregunta libre).
   */
  async function resolverLenguajeNatural(texto) {
    if (PATRON_SIMULACRO.test(texto)) {
      return (
        "Un simulacro real no se puede lanzar por WhatsApp, por seguridad: solo desde el panel " +
        "(panel.ejemplo.com → Simulacros), donde además pide un código antes de arrancar. " +
        "Aquí por WhatsApp sí puedo revisar y reparar de verdad con la opción 1 (SOS)."
      );
    }
    if (PATRON_REINICIO_SERVIDOR_COMPLETO.test(texto)) {
      return (
        "Reiniciar el servidor completo no está disponible por WhatsApp (si el servidor está colgado, " +
        "el mensaje tampoco me llegaría). Si el bot está fallando, escribe /centinela 4 para reiniciar solo el bot, " +
        "o /centinela 1 para que revise y repare todo automáticamente. El reinicio completo del servidor se hace " +
        "desde el panel (panel.ejemplo.com) escribiendo la palabra REINICIAR."
      );
    }

    for (const { n, patron } of INTENCIONES_ACCION) {
      if (patron.test(texto)) return resolverOpcion(n, null);
    }

    for (const item of INTENCIONES_INFO) {
      if (!item.patron.test(texto)) continue;
      if (item.excluye && item.excluye.test(texto)) continue;
      if (item.fn === "espacio") return textoOpcionEspacioInformativo();
      if (item.fn === "backup_ultimo") return textoOpcion4();
      if (item.fn === "resumen") return textoOpcion2();
      if (item.fn === "fallas") return textoOpcion3();
      if (item.fn === "reinicio_servidor") {
        const t = await textoUltimoReinicioServidor();
        if (t) return t;
        // Sin dato local: cae a pregunta libre (return null más abajo).
      }
    }

    if (PATRON_VERBOS_RIESGO.test(texto)) {
      return (
        "Eso cambiaría algo del servidor y no lo hago solo por interpretar tu mensaje. " +
        "Escribe /centinela menu para ver las opciones disponibles y su número, y confírmala explícitamente."
      );
    }

    return null; // pregunta libre: la resuelve la IA
  }

  // ── Preguntas libres (IA), con agrupación para varias preguntas juntas ──

  async function responderConIA(preguntas) {
    if (!preguntas.length) return "";
    const gasto = registrarConsultaIA();
    if (!gasto.permitido) {
      auditar("centinela_pregunta", "bot", "límite_diario", preguntas.join(" | ").slice(0, 80));
      return (
        `Ya usamos las ${LIMITE_CONSULTAS_DIA} consultas de hoy a Centinela. El límite se reinicia mañana. ` +
        `El menú numerado sigue funcionando igual (escribe /centinela menu); solo tus preguntas en tus ` +
        `palabras tienen que esperar a mañana o revisar el panel en panel.ejemplo.com.`
      );
    }

    const contexto = await armarContextoCentinela();
    const persona = leerPersonaCentinela();
    const maxOutputTokens = preguntas.length >= 2 ? 1100 : 900;

    let preguntaFinal;
    if (preguntas.length === 1) {
      preguntaFinal = preguntas[0];
    } else {
      preguntaFinal =
        `El dueño hizo ${preguntas.length} preguntas. Responde cada una en un párrafo corto, numerado, ` +
        `en el mismo orden. Máximo 12 líneas en total.\n\n` +
        preguntas.map((p, i) => `${i + 1}) ${p}`).join("\n");
    }

    const respuesta = await preguntarAGemini(persona, contexto, preguntaFinal, { maxOutputTokens });
    auditar("centinela_pregunta", "bot", "respondida", preguntas.join(" | ").slice(0, 80));
    return respuesta;
  }

  // ── Resolución de un único fragmento (para el modo de varias preguntas) ─

  /** Devuelve { texto } si pudo resolverlo sin IA, o { libre: texto } si necesita IA. */
  async function resolverFragmento(fragTexto) {
    const clas = clasificarGramatica(fragTexto);
    if (clas.tipo === "menu") return { texto: TEXTO_MENU };
    if (clas.tipo === "opcion") return { texto: await resolverOpcion(clas.n, clas.confirmacion) };
    const resuelto = await resolverLenguajeNatural(clas.texto);
    if (resuelto !== null) return { texto: resuelto };
    return { libre: clas.texto };
  }

  // ── Punto de entrada único ───────────────────────────────────────────────

  /**
   * Procesa el texto que llegó tras "/centinela " (o la transcripción de un
   * audio que empezaba por "centinela"). Nunca lanza: cualquier fallo se
   * convierte en un texto claro para el dueño.
   * @returns {Promise<{ respuesta: string }>}
   */
  async function manejar(pregunta) {
    const texto = String(pregunta || "").trim();

    try {
      // Cualquier mensaje del dueño por /centinela cuenta como "ya lo vi":
      // cierra las escaladas pendientes (si las hay) antes de interpretar
      // nada más. Un fallo aquí nunca debe dejar al dueño sin menú.
      let acuse = { ok: true, cerradas: [] };
      if (escalamiento && typeof escalamiento.acusar === "function") {
        try { acuse = escalamiento.acusar("dueño"); } catch (_) { /* no bloquea el menú */ }
      }
      // "ok" y variantes cortas: respuesta breve y determinista, sin IA.
      if (esAcuse(texto)) {
        return {
          respuesta: acuse.cerradas.length
            ? "Listo, quedó confirmado que viste el aviso. No vuelvo a insistir por este problema."
            : "No hay ningún aviso pendiente de confirmar. Escribe /centinela menu para ver las opciones.",
        };
      }

      // Feedback de la Vigía de tendencias ("¿Te sirvió?" en el WhatsApp del
      // último aviso). No pasa por la gramática de opciones ni por la IA.
      if (vigia && /^(util|útil|ruido)$/i.test(texto)) {
        const r = vigia.registrarFeedback(/^r/i.test(texto) ? "ruido" : "util", "bot");
        return { respuesta: r.mensaje };
      }

      const clasCompleta = clasificarGramatica(texto);
      if (clasCompleta.tipo === "menu") return { respuesta: TEXTO_MENU };
      if (clasCompleta.tipo === "opcion") {
        return { respuesta: await resolverOpcion(clasCompleta.n, clasCompleta.confirmacion) };
      }

      // No es un comando puro: puede ser una sola pregunta libre o varias juntas.
      const fragmentos = partirFragmentos(texto);

      if (fragmentos.length <= 1) {
        const resuelto = await resolverLenguajeNatural(texto);
        if (resuelto !== null) return { respuesta: resuelto };
        return { respuesta: await responderConIA([texto]) };
      }

      // Varias preguntas/comandos juntos: se resuelve cada uno en orden y
      // las preguntas libres se agrupan en una sola consulta a la IA.
      const partes = [];
      const libres = [];
      const huecos = [];
      for (const frag of fragmentos) {
        const r = await resolverFragmento(frag);
        if (r.libre !== undefined) {
          huecos.push(partes.length);
          libres.push(r.libre);
          partes.push(null); // se completa después
        } else {
          partes.push(r.texto);
        }
      }
      if (libres.length) {
        const respuestaIA = await responderConIA(libres);
        // Todas las preguntas libres comparten una única respuesta numerada;
        // se coloca una sola vez, en el primer hueco, y se quitan los demás.
        partes[huecos[0]] = respuestaIA;
        for (let i = 1; i < huecos.length; i++) partes[huecos[i]] = null;
      }
      // Varias frases del dueño en un mismo mensaje a veces piden lo mismo
      // con otras palabras (p. ej. "hay algo de qué preocuparme" y "cómo va
      // el servidor" caen las dos en el mismo resumen). Se evita repetir el
      // mismo bloque de respuesta dos veces seguidas.
      const sinVacios = partes.filter((p) => p !== null && p !== "");
      const sinRepetidosSeguidos = sinVacios.filter((p, i) => i === 0 || p !== sinVacios[i - 1]);
      const respuesta = sinRepetidosSeguidos.join("\n\n");
      return { respuesta: respuesta || "No entendí tu mensaje. Escribe /centinela menu para ver las opciones." };
    } catch (e) {
      auditar("centinela_menu_error", "bot", "error", e.message);
      return { respuesta: "No pude procesar tu mensaje ahora mismo. Intenta de nuevo en un momento." };
    }
  }

  return { manejar };
}

module.exports = {
  crearComandosCentinela,
  // Exportadas para pruebas unitarias sin depender de ops-server.js:
  clasificarGramatica,
  partirFragmentos,
  normalizarConfirmacion,
  TEXTO_MENU,
};
