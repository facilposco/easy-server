"use strict";
/**
 * modulos/memoria-incidentes.js
 *
 * Módulo C de DISENO-AUDITORIA360-PROACTIVA.md §3. Lee (nunca escribe)
 * `DIR_DATOS/centinela-db/sos-corridas.jsonl` — la misma ruta que ya usa
 * `informe-semanal.js` — y arma un resumen acotado (100 entradas) para tres
 * usos: contexto de la IA de /centinela, sugerencia de runbook cuando el SOS
 * se rinde, y una tarjeta de estado en el panel.
 *
 * Aislado a propósito (AGENTS.md): archivo nuevo, no toca sos.js ni
 * ops-server.js. La integración exacta queda descrita en
 * modulos/INTEGRACION-MEMORIA.md.
 *
 * Reglas duras del diseño (no negociables aquí):
 * - Nunca decide ni reordena el plan del SOS (§3.7: "ordenar peldaños por
 *   tasa de éxito" quedó descartado a propósito).
 * - Nunca ejecuta un runbook. Solo lo sugiere; el dueño lo dispara con un
 *   clic desde el panel (Técnico → Guías paso a paso), que ya existe.
 * - Nunca escribe en `centinela-db/` (esa carpeta es del SOS).
 */

const path = require("path");

const ARCHIVO_MEMORIA = "memoria-incidentes.json";
const MAX_ENTRADAS = 100; // §3.1: "archivo acotado (100 entradas)"
const MAX_LINEAS_LEIDAS = 1000; // mismo tope que usa sos.js al releer sus propias corridas

const SIETE_DIAS_MS = 7 * 24 * 60 * 60 * 1000;
const VEINTICUATRO_HORAS_MS = 24 * 60 * 60 * 1000;
const TREINTA_DIAS_MS = 30 * 24 * 60 * 60 * 1000;

// Estos dos resultados no son incidentes (§3.3): no generan entrada.
const RESULTADOS_IGNORADOS = new Set(["sin_falla", "interrumpida_por_reinicio"]);

// Solo estos dos resultados justifican ofrecer una guía paso a paso (§3.6):
// el SOS se rindió, o reparó solo una parte.
const RESULTADOS_SUGIEREN_RUNBOOK = new Set(["detenido_pide_ayuda", "parcial"]);

// Copia deliberada de sos.js `CONTENEDORES_PROPIOS` (["zeus-mariadb",
// "zeus-chromadb", "zeus-bot", "zeus-proxy"]). El diseño (§3.2) no pasa esta
// lista como dependencia de la fábrica, así que se fija aquí igual que
// auditoria360.js la fija en su propio `crearPuedeActuar` (§1.2). Si algún
// día se agrega un contenedor propio nuevo, hay que actualizar las dos
// copias — documentado en INTEGRACION-MEMORIA.md.
const CONTENEDORES_PROPIOS = ["zeus-mariadb", "zeus-chromadb", "zeus-bot", "zeus-proxy"];

// §3.6: síntoma → id de runbook (modulos/runbooks.js). "contenedor_en_bucle"
// no vive aquí a propósito: solo cuenta como "bot_no_responde" cuando el
// culpable es zeus-bot, así que se resuelve aparte en `elegirRunbook`.
const MAPA_SINTOMA_RUNBOOK = {
  bot_caido: "bot_no_responde",
  bot_no_responde: "bot_no_responde",
  busqueda_caida: "memoria_busqueda_caida",
  bd_caida: "base_datos_no_responde",
  puerta_caida: "puerta_entrada_caida",
  disco_lleno: "servidor_lento_disco",
  servidor_lento: "servidor_lento_disco",
};

/** Clave de agregado: "<sintoma>|<peldano>[:<objetivo>]" (§3.3, ejemplo). */
function claveAgregado(sintoma, accion) {
  const objetivo = accion.objetivo ? `:${accion.objetivo}` : "";
  return `${sintoma}|${accion.peldano}${objetivo}`;
}

/**
 * Culpable = objetivo de la primera acción de la corrida que apunte a un
 * contenedor propio (§3.3). El JSONL no guarda un campo "culpable" propio;
 * se infiere así porque es lo único determinista disponible sin ampliar el
 * parche a sos.js (ver §6 del diseño). Si ninguna acción califica, `null`.
 */
function culpableDeAcciones(acciones) {
  for (const accion of acciones || []) {
    if (accion && accion.objetivo && CONTENEDORES_PROPIOS.includes(accion.objetivo)) return accion.objetivo;
  }
  return null;
}

/** minutos_hasta_restablecer: solo tiene sentido si la corrida se restableció. */
function calcularMinutos(corrida) {
  if (corrida.resultado !== "restablecido") return null;
  const finMs = new Date(corrida.fin).getTime();
  const desdeMs = new Date(corrida.desde || corrida.inicio).getTime();
  if (!Number.isFinite(finMs) || !Number.isFinite(desdeMs)) return null;
  return Math.round((finMs - desdeMs) / 60000);
}

/** true si hay una entrada previa con el mismo síntoma dentro de los 7 días anteriores a `fechaActualIso`. */
function calcularReincidencia(sintoma, fechaActualIso, entradasPrevias) {
  const actual = new Date(fechaActualIso).getTime();
  if (!Number.isFinite(actual)) return false;
  const limite = actual - SIETE_DIAS_MS;
  return (entradasPrevias || []).some((e) => {
    if (!e || e.sintoma !== sintoma) return false;
    const t = new Date(e.fecha).getTime();
    return Number.isFinite(t) && t >= limite && t < actual;
  });
}

/**
 * Arma la entrada de memoria (§3.3) a partir de una línea cruda de
 * sos-corridas.jsonl. `entradasPrevias` es la lista de entradas YA
 * procesadas (para calcular reincidencia). Devuelve `null` si la corrida no
 * cuenta como incidente (§3.3: sin_falla / interrumpida_por_reinicio) o si
 * no trae `run_id`.
 */
function entradaDesdeCorrida(corrida, entradasPrevias) {
  if (!corrida || !corrida.run_id) return null;
  if (RESULTADOS_IGNORADOS.has(corrida.resultado)) return null;

  const sintoma = corrida.sintoma_principal || "no_diagnosticable";
  const acciones = Array.isArray(corrida.acciones)
    ? corrida.acciones.map((a) => ({ peldano: a.peldano, objetivo: a.objetivo || "", ok: !!a.ok }))
    : [];
  const fecha = corrida.fin || corrida.inicio || new Date().toISOString();

  return {
    run_id: corrida.run_id,
    fecha,
    sintoma,
    culpable: culpableDeAcciones(acciones),
    acciones,
    resultado: corrida.resultado,
    minutos_hasta_restablecer: calcularMinutos(corrida),
    reincidencia: calcularReincidencia(sintoma, fecha, entradasPrevias),
    afecta_clientes: corrida.afecta_clientes || "desconocido",
    evidencia_id: corrida.evidencia_id || null,
    runbook_sugerido: null,
  };
}

/**
 * Recalcula el agregado ENTERO desde cero a partir de la lista de entradas
 * actual (§3.3: "recalculando desde cero"). Por cada acción de cada
 * entrada suma 1 a `ejecutada`; suma 1 a `restablecido` solo cuando esa
 * acción es la ÚLTIMA de una corrida cuyo resultado fue "restablecido"
 * (en sos.js el éxito se declara justo tras verificar ese peldaño).
 */
function agregar(entradas) {
  const agregado = {};
  for (const entrada of entradas || []) {
    const acciones = entrada.acciones || [];
    acciones.forEach((accion, indice) => {
      const clave = claveAgregado(entrada.sintoma, accion);
      if (!agregado[clave]) agregado[clave] = { ejecutada: 0, restablecido: 0 };
      agregado[clave].ejecutada += 1;
      const esUltimaAccion = indice === acciones.length - 1;
      if (esUltimaAccion && entrada.resultado === "restablecido") agregado[clave].restablecido += 1;
    });
  }
  return agregado;
}

/**
 * Síntoma (+ culpable) → id de runbook, o `null` si no hay uno mapeado
 * (§3.6). Pura a propósito: no comprueba si el id existe de verdad en
 * `runbooks.catalogo()` — esa comprobación (que sí depende de una
 * dependencia inyectada) la hace quien llama, justo antes de ofrecer la
 * sugerencia, para poder probar el mapeo puro sin fabricar un catálogo.
 */
function elegirRunbook(sintoma, culpable) {
  if (sintoma === "contenedor_en_bucle" && culpable === "zeus-bot") return "bot_no_responde";
  return MAPA_SINTOMA_RUNBOOK[sintoma] || null;
}

function crearMemoriaIncidentes(deps) {
  const { DIR_DATOS, leerJson, guardarJson, leerJsonl, auditar, runbooks, textos } = deps || {};
  if (
    !DIR_DATOS || typeof leerJson !== "function" || typeof guardarJson !== "function"
    || typeof leerJsonl !== "function" || typeof auditar !== "function"
    || !runbooks || typeof runbooks.catalogo !== "function" || !textos
  ) {
    throw new Error("crearMemoriaIncidentes necesita DIR_DATOS, leerJson, guardarJson, leerJsonl, auditar, runbooks y textos de ops-server.js");
  }
  // Opcionales: sin enviarWhatsapp no se manda nada (solo se guarda la
  // sugerencia); sin permisos/kapsoYModo/F_MODO no hay freno que aplicar
  // (se envía si hay enviarWhatsapp) — igual patrón de degradación que
  // auditoria360.js y vigia-tendencias.js.
  const { enviarWhatsapp, permisos, kapsoYModo, F_MODO } = deps;
  const ahora = typeof deps.ahora === "function" ? deps.ahora : () => Date.now();

  const RUTA_CORRIDAS = path.join(DIR_DATOS, "centinela-db", "sos-corridas.jsonl");
  const RUTA_MEMORIA = path.join(DIR_DATOS, ARCHIVO_MEMORIA);

  function estadoVacio() {
    return { version: 1, ultimo_run_id: null, entradas: [], agregado: {}, sugerencia_actual: null };
  }

  function leerEstado() {
    const guardado = leerJson(RUTA_MEMORIA, null);
    if (!guardado || !Array.isArray(guardado.entradas)) return estadoVacio();
    return {
      version: guardado.version || 1,
      ultimo_run_id: guardado.ultimo_run_id || null,
      entradas: guardado.entradas,
      agregado: guardado.agregado || {},
      sugerencia_actual: guardado.sugerencia_actual || null,
    };
  }

  function permisoWhatsappOk() {
    if (!permisos || typeof permisos.permitido !== "function") return true;
    return permisos.permitido("whatsapp", "escritura");
  }

  function silenciadoPorModoViaje() {
    if (!kapsoYModo || !F_MODO || typeof kapsoYModo.obtenerModo !== "function" || typeof kapsoYModo.debeSilenciar !== "function") return false;
    const modo = kapsoYModo.obtenerModo(leerJson, F_MODO);
    return kapsoYModo.debeSilenciar("warn", modo);
  }

  /** Mismo mensaje para todos los resultados que ofrecen guía (§3.6: el diseño solo da un ejemplo, para "detenido_pide_ayuda"; se reutiliza igual para "parcial" — no hay un segundo texto definido). */
  function textoWhatsappRunbook(entrada, runbook) {
    const motivo = textos.tituloSintoma(entrada.sintoma);
    const motivoMinuscula = motivo.charAt(0).toLowerCase() + motivo.slice(1);
    const pasos = runbook.pasos.map((p) => `${p.orden}. ${p.etiqueta}`).join("\n");
    return [
      "Hay una guía paso a paso para lo que el SOS no pudo resolver",
      "",
      `El SOS se detuvo con: ${motivoMinuscula}.`,
      `Guía sugerida: "${runbook.titulo}" (${runbook.pasos.length} pasos):`,
      pasos,
      "",
      "No la ejecuto sola. La lanzas tú con un clic en panel.ejemplo.com → Técnico → Guías paso a paso.",
    ].join("\n");
  }

  /**
   * Procesa una lista de corridas crudas (en orden cronológico, igual que
   * las devuelve leerJsonl) sobre un estado existente. Compartida por
   * `sincronizar()` (toda la cola) y `registrarCorrida()` (una sola).
   */
  async function procesarCorridas(estadoActual, corridasCrudas) {
    const porRunId = new Map(estadoActual.entradas.map((e) => [e.run_id, e]));
    let nuevas = 0;
    let sugerenciaActualNueva = estadoActual.sugerencia_actual || null;

    for (const corrida of corridasCrudas) {
      if (!corrida || !corrida.run_id) continue;
      const yaExiste = porRunId.has(corrida.run_id);
      // Idempotente: una corrida ya vista no se reprocesa, salvo que llegue
      // marcada actualizacion:true (reanudarTrasReinicio en sos.js).
      if (yaExiste && !corrida.actualizacion) continue;

      const entradasPrevias = Array.from(porRunId.values());
      const entrada = entradaDesdeCorrida(corrida, entradasPrevias);
      if (!entrada) continue;

      if (RESULTADOS_SUGIEREN_RUNBOOK.has(corrida.resultado)) {
        const idRunbook = elegirRunbook(entrada.sintoma, entrada.culpable);
        const idsCatalogo = new Set(runbooks.catalogo().map((r) => r.id));
        if (idRunbook && idsCatalogo.has(idRunbook)) {
          const runbook = runbooks.catalogo().find((r) => r.id === idRunbook);
          entrada.runbook_sugerido = idRunbook;
          sugerenciaActualNueva = {
            run_id: corrida.run_id,
            ts: new Date(ahora()).toISOString(),
            runbook_id: runbook.id,
            titulo: runbook.titulo,
            pasos: runbook.pasos.length,
            motivo: corrida.motivo_detencion || textos.tituloSintoma(entrada.sintoma),
          };
          auditar("memoria_incidentes_runbook_sugerido", "agente", "ok", `${corrida.run_id}:${idRunbook}`);
          if (typeof enviarWhatsapp === "function" && permisoWhatsappOk() && !silenciadoPorModoViaje()) {
            try { await enviarWhatsapp(textoWhatsappRunbook(entrada, runbook)); } catch (_) { /* nunca romper la sincronización por un fallo de envío */ }
          }
        }
      }

      porRunId.set(corrida.run_id, entrada);
      nuevas++;
    }

    let entradas = Array.from(porRunId.values());
    if (entradas.length > MAX_ENTRADAS) entradas = entradas.slice(-MAX_ENTRADAS);
    const agregado = agregar(entradas);

    return {
      nuevas,
      estado: {
        version: 1,
        ultimo_run_id: entradas.length ? entradas[entradas.length - 1].run_id : estadoActual.ultimo_run_id,
        entradas,
        agregado,
        sugerencia_actual: sugerenciaActualNueva,
      },
    };
  }

  /** Lee sos-corridas.jsonl entero (hasta 1000 líneas) y procesa lo nuevo. */
  async function sincronizar() {
    const estadoActual = leerEstado();
    const corridasCrudas = leerJsonl(RUTA_CORRIDAS, MAX_LINEAS_LEIDAS);
    const { estado, nuevas } = await procesarCorridas(estadoActual, corridasCrudas);
    guardarJson(RUTA_MEMORIA, estado);
    return { nuevas, total: estado.entradas.length };
  }

  /** Gancho opcional desde sos.js (§5.4). Mismo camino que sincronizar(), para una sola corrida. */
  async function registrarCorrida(corrida) {
    const estadoActual = leerEstado();
    const { estado, nuevas } = await procesarCorridas(estadoActual, [corrida]);
    guardarJson(RUTA_MEMORIA, estado);
    return { nuevas, total: estado.entradas.length };
  }

  /** Cálculo compartido entre resumenParaContexto() y estado(). */
  function calcularResumen(estado) {
    const ahoraMs = ahora();
    const entradas30 = estado.entradas.filter((e) => ahoraMs - new Date(e.fecha).getTime() <= TREINTA_DIAS_MS);
    const corridas_30_dias = {
      total: entradas30.length,
      restablecidas: entradas30.filter((e) => e.resultado === "restablecido").length,
      detenidas: entradas30.filter((e) => e.resultado === "detenido_pide_ayuda").length,
    };

    const porSintoma = new Map();
    for (const e of estado.entradas) {
      const previo = porSintoma.get(e.sintoma);
      if (!previo) {
        porSintoma.set(e.sintoma, { sintoma: e.sintoma, titulo: textos.tituloSintoma(e.sintoma), veces: 1, ultima: e.fecha });
      } else {
        previo.veces += 1;
        if (new Date(e.fecha).getTime() > new Date(previo.ultima).getTime()) previo.ultima = e.fecha;
      }
    }
    const sintomas_frecuentes = Array.from(porSintoma.values()).sort((a, b) => b.veces - a.veces).slice(0, 5);

    const tasas = Object.entries(estado.agregado)
      .map(([clave, valor]) => {
        const separador = clave.indexOf("|");
        const sintoma = clave.slice(0, separador);
        const accion = clave.slice(separador + 1);
        const tasa_pct = valor.ejecutada ? Math.round((valor.restablecido / valor.ejecutada) * 100) : 0;
        return { sintoma, accion, ejecutada: valor.ejecutada, restablecido: valor.restablecido, tasa_pct };
      })
      .sort((a, b) => b.ejecutada - a.ejecutada)
      .slice(0, 8);

    const ultimas = estado.entradas.slice(-5).reverse().map((e) => ({
      fecha: e.fecha, titulo: textos.tituloSintoma(e.sintoma), resultado: e.resultado, minutos: e.minutos_hasta_restablecer,
    }));

    return { corridas_30_dias, sintomas_frecuentes, tasas, ultimas };
  }

  /** ≤ ~1,5 KB, para inyectar en armarContextoCentinela() (§3.5). */
  function resumenParaContexto() {
    return calcularResumen(leerEstado());
  }

  /** Sugerencia vigente, o null si ya pasó de 24 h (§3.4). */
  function sugerenciaActual() {
    const estado = leerEstado();
    if (!estado.sugerencia_actual) return null;
    const ts = new Date(estado.sugerencia_actual.ts).getTime();
    if (!Number.isFinite(ts) || ahora() - ts > VEINTICUATRO_HORAS_MS) return null;
    return estado.sugerencia_actual;
  }

  /** Para GET /api/memoria-incidentes (§3.4, §3.8). */
  function estado() {
    const estadoGuardado = leerEstado();
    const resumen = calcularResumen(estadoGuardado);
    return {
      total: estadoGuardado.entradas.length,
      ultima: estadoGuardado.entradas.length ? estadoGuardado.entradas[estadoGuardado.entradas.length - 1] : null,
      sintomas_frecuentes: resumen.sintomas_frecuentes,
      tasas: resumen.tasas,
      sugerencia_actual: sugerenciaActual(),
    };
  }

  return { sincronizar, registrarCorrida, resumenParaContexto, sugerenciaActual, estado };
}

module.exports = { crearMemoriaIncidentes, entradaDesdeCorrida, agregar, elegirRunbook, MAPA_SINTOMA_RUNBOOK };
