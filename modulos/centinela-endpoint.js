"use strict";
/**
 * Centinela — módulo de preguntas por WhatsApp y auditoría diaria por IA.
 *
 * PROPUESTA DE PARCHE para agregar a `ops-server.js` (zeus-ops).
 * No reemplaza el archivo: este bloque se AGREGA dentro de él (ver
 * INTEGRACION-CENTINELA.md para el punto exacto de inserción).
 *
 * Reutiliza el estilo y las funciones YA EXISTENTES en ops-server.js:
 *   - `env`            → objeto cargado con leerEnv("/opt/zeus-ops/.env")
 *   - `cacheado(...)`   → no se usa aquí a propósito: cada pregunta del dueño
 *                         debe reflejar el estado más fresco posible.
 *   - `auditar(...)`    → registro de auditoría (ver F_AUDIT)
 *   - `enviarWhatsapp(texto)` → envío por Kapso (firma real: un solo
 *                         parámetro, el texto; ya resuelve destino y plantilla)
 *   - `estadoGeneral()`, `prediccion()`, `estadoSeguridad()`, `estadoRespaldos()`
 *     → funciones async ya definidas en ops-server.js, sin parámetros.
 *   - `json(res, obj, code)` → helper de respuesta HTTP ya definido.
 *
 * Sin dependencias externas: usa `fetch` nativo de Node 20+.
 */

// ── Configuración propia de este módulo ─────────────────────────────────────
// GEMINI_API_KEY debe existir en /opt/zeus-ops/.env (el mismo archivo que ya
// lee `leerEnv` al inicio de ops-server.js). Es una variable NUEVA para ese
// archivo — no confundir con la que usa el bot en su propio .env.
// `env` y `DIR_DATOS` son las variables que ya existen arriba en ops-server.js;
// aquí solo se referencian, no se redeclaran.
const GEMINI_MODEL = "gemini-2.5-flash";
// La API gratuita de Gemini rechaza llamadas hechas directo desde la IP del
// servidor de Linode ("User location is not supported for the API use").
// Por eso la llamada se reenvía a través del Worker de Cloudflare, que ya
// existía como vigilante externo: Cloudflare sí tiene acceso, y la llave real
// de Gemini vive solo ahí (como secreto), no aquí. PROXY_SECRETO_GEMINI es
// nueva en /opt/zeus-ops/.env y debe coincidir con el secreto PROXY_SECRETO
// configurado en el Worker (ver cloudflare-worker/worker.js).
const GEMINI_URL = `${env.VIGILANTE_URL || "https://vigilante-zeus.TU-CUENTA.workers.dev"}/gemini-proxy?modelo=${GEMINI_MODEL}`;
const PROXY_SECRETO_GEMINI = env.PROXY_SECRETO_GEMINI || "";
// Antes se rotaba entre varias llaves; ya no hace falta rotar aquí (el Worker
// tiene su propia llave), se deja un solo intento.
const GEMINI_KEYS = PROXY_SECRETO_GEMINI ? [PROXY_SECRETO_GEMINI] : [];
const RUTA_PERSONA = "/opt/zeus-ops/centinela-persona.md";
// `path` y `DIR_DATOS` ya existen arriba en ops-server.js — no se redeclaran.
const RUTA_GASTO = path.join(DIR_DATOS, "gasto-ia.json"); // /var/lib/zeus-ops/gasto-ia.json
const LIMITE_CONSULTAS_DIA = 12;

// ── Carga del prompt de sistema ──────────────────────────────────────────────
/**
 * Lee el texto de personalidad/instrucciones de Centinela desde disco en cada
 * llamada (el archivo es pequeño y así un ajuste de texto no requiere
 * reiniciar el servicio). Si no existe, usa un prompt mínimo de respaldo para
 * que el servicio nunca se caiga por falta de ese archivo.
 */
function leerPersonaCentinela() {
  try {
    return fs.readFileSync(RUTA_PERSONA, "utf8");
  } catch (_) {
    return (
      "Eres Centinela, el asistente que vigila el servidor de este negocio. " +
      "Responde en español de Colombia, de forma clara, breve y sin tecnicismos innecesarios."
    );
  }
}

// ── Control de gasto: máximo N consultas al modelo por día ─────────────────
/**
 * Lleva la cuenta de cuántas veces se consultó a Gemini hoy (hora del
 * servidor, que corre en UTC). Se reinicia solo al cambiar la fecha.
 * Se guarda en disco para sobrevivir a un reinicio del proceso.
 */
function leerGastoIA() {
  return leerJson(RUTA_GASTO, { fecha: "", consultas: 0 });
}

function guardarGastoIA(g) {
  guardarJson(RUTA_GASTO, g);
}

/** Devuelve { permitido, restantes } y, si permite la consulta, ya suma el contador. */
function registrarConsultaIA() {
  const hoy = new Date().toISOString().slice(0, 10);
  let g = leerGastoIA();
  if (g.fecha !== hoy) g = { fecha: hoy, consultas: 0 };

  if (g.consultas >= LIMITE_CONSULTAS_DIA) {
    return { permitido: false, restantes: 0 };
  }
  g.consultas += 1;
  guardarGastoIA(g);
  return { permitido: true, restantes: LIMITE_CONSULTAS_DIA - g.consultas };
}

// ── Llamada a Gemini ─────────────────────────────────────────────────────────
/**
 * Consulta a Gemini con el prompt de sistema, un bloque de contexto (el
 * estado del servidor ya armado por quien llama, como JSON) y la pregunta
 * del dueño. Nunca lanza: ante cualquier falla devuelve un texto de repuesto
 * claro para que el dueño no vea un error técnico por WhatsApp.
 */
async function preguntarAGemini(systemPrompt, contexto, pregunta) {
  if (!GEMINI_KEYS.length) {
    return "No pude consultar el servidor ahora mismo (falta configurar la llave de IA).";
  }

  const cuerpo = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [
      {
        role: "user",
        parts: [
          {
            text:
              `Este es el estado actual del servidor, en JSON:\n\n${JSON.stringify(contexto)}\n\n` +
              `Pregunta del dueño del negocio:\n${pregunta}`,
          },
        ],
      },
    ],
    generationConfig: { temperature: 0.3, maxOutputTokens: 700 },
  };

  // Prueba cada llave en orden. Una llave se salta a la siguiente solo ante
  // errores típicos de cuota agotada o límite de velocidad (429) o de llave
  // inválida/vencida (400/403); cualquier otro error corta el intento, para
  // no quemar las siete llaves por un problema que no se va a resolver rotando.
  let ultimoError = "";
  for (let i = 0; i < GEMINI_KEYS.length; i++) {
    const llave = GEMINI_KEYS[i];
    const controlador = new AbortController();
    const vencido = setTimeout(() => controlador.abort(), 20000);
    try {
      const res = await fetch(GEMINI_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Proxy-Secreto": llave },
        body: JSON.stringify(cuerpo),
        signal: controlador.signal,
      });
      clearTimeout(vencido);

      if (!res.ok) {
        ultimoError = `HTTP ${res.status}`;
        if ((res.status === 429 || res.status === 400 || res.status === 403) && i < GEMINI_KEYS.length - 1) {
          auditar("centinela_ia_rotacion", "agente", "siguiente_llave", `llave ${i + 1} de ${GEMINI_KEYS.length}: ${ultimoError}`);
          continue;
        }
        auditar("centinela_ia_error", "agente", "falló", ultimoError);
        return "No pude consultar el servidor ahora mismo. Intenta de nuevo en un momento.";
      }

      const data = await res.json();
      const texto = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("").trim();
      if (!texto) {
        auditar("centinela_ia_error", "agente", "vacío", "Gemini no devolvió texto");
        return "No pude consultar el servidor ahora mismo. Intenta de nuevo en un momento.";
      }
      return texto;
    } catch (e) {
      clearTimeout(vencido);
      ultimoError = e.message;
      if (i < GEMINI_KEYS.length - 1) {
        auditar("centinela_ia_rotacion", "agente", "siguiente_llave", `llave ${i + 1} de ${GEMINI_KEYS.length}: ${ultimoError}`);
        continue;
      }
    }
  }
  auditar("centinela_ia_error", "agente", "excepción", ultimoError);
  return "No pude consultar el servidor ahora mismo. Revisa tu conexión o intenta más tarde.";
}

// ── Contexto completo del servidor (mismo dato para preguntas y auditoría) ──
/** Arma el bloque de contexto reutilizando las funciones ya existentes. */
async function armarContextoCentinela() {
  const [estado, pred, seguridad, respaldos] = await Promise.all([
    estadoGeneral(),
    prediccion(),
    estadoSeguridad(),
    estadoRespaldos(),
  ]);
  return {
    memoria: estado.ram,
    disco: estado.disco,
    servicios: { total: estado.servicios.total, arriba: estado.servicios.arriba, avisos: estado.avisos },
    prediccion: { riesgo: pred.riesgo, nivel: pred.nivel, resumen: pred.resumen, pronosticos: pred.pronosticos },
    seguridad: { puntaje: seguridad.puntaje, checklist: seguridad.checklist, baneos: seguridad.baneos },
    respaldos: { ultimo: respaldos.ultimo, drive: respaldos.drive, total: respaldos.total },
    ts: new Date().toISOString(),
  };
}

// ── Endpoint: POST /api/centinela/preguntar ─────────────────────────────────
/**
 * Maneja la pregunta del dueño enviada desde el bot de WhatsApp.
 * Devuelve siempre { ok, respuesta } (o { ok:false, mensaje } en error de
 * formato), nunca deja la petición colgada.
 */
async function manejarPreguntaCentinela(req, res) {
  let cuerpo = "", excedido = false;
  req.on("data", (c) => {
    cuerpo += c;
    if (cuerpo.length > 4096 && !excedido) {
      excedido = true;
      json(res, { ok: false, mensaje: "La petición es demasiado grande" }, 413);
      req.destroy();
    }
  });
  req.on("end", async () => {
    if (excedido) return;
    let datos;
    try {
      datos = JSON.parse(cuerpo || "{}");
    } catch (_) {
      return json(res, { ok: false, mensaje: "El contenido enviado no es válido" }, 400);
    }
    const pregunta = String(datos.pregunta || "").trim().slice(0, 1000);
    if (!pregunta) return json(res, { ok: false, mensaje: "Falta la pregunta" }, 400);

    const gasto = registrarConsultaIA();
    if (!gasto.permitido) {
      auditar("centinela_pregunta", "bot", "límite_diario", pregunta.slice(0, 80));
      return json(res, {
        ok: true,
        respuesta:
          `Ya usamos las ${LIMITE_CONSULTAS_DIA} consultas de hoy a Centinela. ` +
          `El límite se reinicia mañana. Mientras tanto puedes revisar el panel en panel.ejemplo.com`,
      });
    }

    try {
      const contexto = await armarContextoCentinela();
      const respuesta = await preguntarAGemini(leerPersonaCentinela(), contexto, pregunta);
      auditar("centinela_pregunta", "bot", "respondida", pregunta.slice(0, 80));
      return json(res, { ok: true, respuesta });
    } catch (e) {
      auditar("centinela_pregunta", "bot", "error", e.message);
      return json(res, { ok: true, respuesta: "No pude consultar el servidor ahora mismo. Intenta de nuevo en un momento." });
    }
  });
}

// ── Auditoría diaria a las 7:00 a.m. hora de Colombia (12:00 UTC) ──────────
const HORA_CENTINELA_UTC = 12; // 07:00 en Colombia
let ultimaAuditoriaCentinela = "";

/**
 * Sigue EXACTAMENTE el mismo patrón de disparo que `quizaResumenDiario`:
 * se llama una vez por minuto desde un setInterval y decide sola si ya le
 * toca correr hoy, comparando la fecha guardada en memoria.
 */
async function quizaAuditoriaDiariaCentinela() {
  const ahora = new Date();
  const hoy = ahora.toISOString().slice(0, 10);
  if (ahora.getUTCHours() !== HORA_CENTINELA_UTC || ultimaAuditoriaCentinela === hoy) return;
  ultimaAuditoriaCentinela = hoy;
  await auditoriaDiaria7am();
}

/**
 * Arma el contexto completo, le pide a Gemini un resumen siguiendo el
 * formato de centinela-persona.md, y lo envía por WhatsApp con la función
 * ya existente `enviarWhatsapp(texto)`. No cuenta contra el límite de 12
 * consultas del dueño: es una sola consulta programada al día.
 */
async function auditoriaDiaria7am() {
  try {
    const contexto = await armarContextoCentinela();
    const persona = leerPersonaCentinela();
    const instruccion =
      "Genera el resumen diario de auditoría del servidor para enviar por WhatsApp al dueño del negocio, " +
      "siguiendo exactamente el formato y tono descritos en tus instrucciones de sistema. " +
      "Sé breve y concreto: esto se lee desde el celular.";
    const resumen = await preguntarAGemini(persona, contexto, instruccion);

    const r = await enviarWhatsapp(resumen);
    auditar("centinela_auditoria_diaria", "agente", r.ok ? "enviado" : "falló", r.detalle || "");
  } catch (e) {
    auditar("centinela_auditoria_diaria", "agente", "error", e.message);
  }
}

// ── Registro dentro del servidor HTTP existente ─────────────────────────────
// Ver INTEGRACION-CENTINELA.md para la línea exacta donde agregar, dentro del
// mismo bloque de "if (ruta === ...)" que ya tiene /api/estado, /api/accion, etc:
//
//   if (ruta === "/api/centinela/preguntar" && req.method === "POST") {
//     return manejarPreguntaCentinela(req, res);
//   }
//
// Y en el setInterval del arranque del servidor (junto a
// setInterval(quizaResumenDiario, 60000);):
//
//   setInterval(quizaAuditoriaDiariaCentinela, 60000);
//
// Este bloque se pega DENTRO de ops-server.js (mismo scope de archivo), por
// eso reutiliza directamente `fs`, `path`, `env`, `DIR_DATOS`, `json`,
// `auditar`, `leerJson`, `guardarJson`, `enviarWhatsapp`, `estadoGeneral`,
// `prediccion`, `estadoSeguridad` y `estadoRespaldos` ya definidos en ese
// archivo. No lleva `module.exports`: ops-server.js no exporta nada, es un
// script que arranca su propio servidor HTTP.
