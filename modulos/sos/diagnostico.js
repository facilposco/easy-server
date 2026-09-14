"use strict";
/**
 * modulos/sos/diagnostico.js
 *
 * Árbol de decisión determinista del SOS (DISENO-SOS.md §4). Funciones
 * PURAS: reciben la instantánea `S` ya leída por sos.js (ver forma esperada
 * en `formaInstantanea` más abajo) y devuelven el diagnóstico y el plan de
 * peldaños. Nunca hacen E/S ni llaman IA — regla P2: mismo estado del
 * servidor → mismo diagnóstico → mismo plan.
 */

const CONTENEDORES_PROPIOS = ["zeus-mariadb", "zeus-chromadb", "zeus-bot", "zeus-proxy"];

const UMBRALES = {
  disco: { pct: 90, pctCritico: 95, libreBytes: 2 * 1024 * 1024 * 1024, libreCriticoBytes: 1024 * 1024 * 1024, inodosPct: 95 },
  memoria: { disponibleBytesMin: 200 * 1024 * 1024, ramPctCrit: 93, ramPctAltoConSwap: 85, swapAltoBytes: 256 * 1024 * 1024, disponibleObjetivoBytes: 400 * 1024 * 1024 },
  cpu: { pctSaturado: 90, cargaSaturada: 4.0, pctObjetivo: 70, cargaLenta: 3.0, iowaitLento: 25, swapLentoBytes: 300 * 1024 * 1024 },
  sonda: { tiempoLentoS: 3.0 },
  ventanaDespliegue: 60 * 60 * 1000, // 60 min: causa automática
  ventanaDespliegueAmplia: 24 * 3600 * 1000, // 24 h: rollback como 2º peldaño
  oomVentanaMs: 30 * 60 * 1000,
};

/**
 * Clasifica un contenedor propio según DISENO-SOS.md §3.1 punto 4.
 * @param {object} c        entrada de leerContenedores() (nombre, estado, detalle, salud)
 * @param {object} inspect  { oomKilled, exitCode, finishedAt, startedAt }
 * @param {object} sonda    { ok, codigo, tiempo_s, sin_dato }
 * @param {number} eventosDieKill10min  conteo de eventos die/kill del mismo nombre en 10 min
 * @param {boolean} incidenteYaActuado  incidente abierto de ese servicio con acciones.length >= 1
 * @returns {"sano"|"caido"|"en_bucle"|"no_responde"|"lento"|"sin_dato"}
 */
function clasificarContenedor(c, inspect, sonda, eventosDieKill10min, incidenteYaActuado) {
  if (!c || c.sin_dato) return "sin_dato";
  const detalle = c.detalle || "";
  const enReinicio = /^Restarting/i.test(detalle);
  const enBucleEventos = (eventosDieKill10min || 0) >= 3;

  if (enReinicio || enBucleEventos) return "en_bucle";
  if (c.estado !== "running") return "caido";

  const saludMala = c.salud === "unhealthy";
  const sondaFalla = sonda && !sonda.sin_dato && (!sonda.ok || (sonda.codigo || 0) >= 500);
  const sondaSinDato = sonda && sonda.sin_dato;

  // `incidenteYaActuado` significa "ya intentamos arreglar esto una vez". Eso
  // solo convierte el caso en un bucle si el servicio SIGUE fallando; si ya
  // responde bien, es que el arreglo funcionó y está sano. Antes se devolvía
  // "en_bucle" solo por existir el incidente, y por eso el SOS reparaba el bot
  // correctamente y acto seguido se declaraba incapaz de arreglarlo.
  if (saludMala || sondaFalla || sondaSinDato) {
    return incidenteYaActuado ? "en_bucle" : "no_responde";
  }

  if (sonda && sonda.ok && (sonda.tiempo_s || 0) > UMBRALES.sonda.tiempoLentoS) return "lento";

  return "sano";
}

function bytesADesde(inspect, historial, eventos, incidente) {
  return null; // sos.js completa "desde" con datos reales; diagnostico.js no hace fechas de más.
}

/**
 * @typedef {object} InstantaneaSOS
 * @property {boolean} dockerOk
 * @property {object}  memoria       {total, disponible, pct}
 * @property {number}  swapUsadoBytes
 * @property {object}  cpu           {pct, carga}
 * @property {number}  iowaitPct
 * @property {object}  disco         {total, usado, libre, pct}
 * @property {number}  inodosPct
 * @property {object.<string,object>} contenedores  nombre -> {estado, detalle, salud, sin_dato}
 * @property {object.<string,object>} inspect       nombre -> {oomKilled, exitCode, finishedAt, startedAt}
 * @property {object.<string,object>} sondas        nombre -> {ok, codigo, tiempo_s, sin_dato}
 * @property {object.<string,number>} eventosDieKill10min
 * @property {object.<string,boolean>} incidenteYaActuado
 * @property {boolean} respaldoEnCurso
 * @property {boolean} simulacroEnCurso
 * @property {object}  despliegue    {creadoHaceMs, huboBaseline}
 * @property {object}  procesosHost  {culpableMemoria, culpableCpu, esProcesoPropio(nombre)}
 * @property {object}  consultasTrabadas {hay_trabadas}
 */

/**
 * Ejecuta el árbol de prioridad (§4.1) y produce el diagnóstico.
 * @param {InstantaneaSOS} S
 * @returns {{sintoma_principal:string, secundarios:string[], culpable:string|null, afecta_clientes:string, plan:Array<object>, detalle:object}}
 */
function diagnosticar(S) {
  const secundarios = [];
  const clasif = {};
  for (const nombre of CONTENEDORES_PROPIOS) {
    clasif[nombre] = clasificarContenedor(
      S.contenedores[nombre],
      S.inspect[nombre],
      S.sondas[nombre],
      (S.eventosDieKill10min || {})[nombre] || 0,
      !!(S.incidenteYaActuado || {})[nombre]
    );
  }

  function agregarSecundario(id) { if (id && !secundarios.includes(id)) secundarios.push(id); }

  // 0. simulacro en curso
  if (S.simulacroEnCurso) {
    return cerrar("simulacro_en_curso", [], null, "no", []);
  }

  // 1. no_diagnosticable
  if (S.noDiagnosticable) {
    return cerrar("no_diagnosticable", [], null, "desconocido", []);
  }

  // 2. docker_colgado
  if (!S.dockerOk) {
    return cerrar("docker_colgado", [], null, impactoPorCaidos(clasif), [
      { peldano: "reiniciar_docker" },
    ]);
  }

  // 3. disco_lleno
  const disco = S.disco || {};
  const discoLleno = disco.pct >= UMBRALES.disco.pct || disco.libre < UMBRALES.disco.libreBytes || (S.inodosPct || 0) >= UMBRALES.disco.inodosPct;
  if (discoLleno) {
    const impacto = impactoPorCaidos(clasif) !== "no" ? impactoPorCaidos(clasif) : "no";
    const plan = [{ peldano: "liberar_disco" }];
    const caidos = CONTENEDORES_PROPIOS.filter((n) => clasif[n] === "caido");
    if (caidos.length) plan.push({ peldano: "reiniciar_en_orden", objetivo: caidos });
    return cerrar("disco_lleno", [], null, impacto, plan);
  }

  // 4. memoria_agotada
  const mem = S.memoria || {};
  const swapAlto = (S.swapUsadoBytes || 0) > UMBRALES.memoria.swapAltoBytes;
  const oomReciente = CONTENEDORES_PROPIOS.find((n) => {
    const i = S.inspect[n] || {};
    return i.oomKilled && i.finishedAt && (Date.now() - new Date(i.finishedAt).getTime()) < UMBRALES.oomVentanaMs;
  });
  const memoriaAgotada = (mem.disponible || 0) < UMBRALES.memoria.disponibleBytesMin
    || mem.pct >= UMBRALES.memoria.ramPctCrit
    || (mem.pct >= UMBRALES.memoria.ramPctAltoConSwap && swapAlto)
    || !!oomReciente;
  if (memoriaAgotada) {
    let culpable = oomReciente || null;
    if (!culpable) {
      culpable = (S.procesosHost && S.procesosHost.culpableMemoriaPropio) || null;
    }
    const ajenoCulpable = !culpable && S.procesosHost && S.procesosHost.culpableMemoriaAjeno;
    if (ajenoCulpable) {
      return cerrar("memoria_agotada", [], null, "desconocido", [], {
        detenerInmediato: true,
        motivo: `El proceso que más memoria usa (${S.procesosHost.culpableMemoriaAjeno}) no es de este negocio; no lo toco.`,
      });
    }
    const plan = culpable ? [{ peldano: "reiniciar_contenedor", objetivo: culpable }] : [];
    return cerrar("memoria_agotada", [], culpable, impactoPorCaidos(clasif), plan);
  }

  // 5. cpu_saturada
  const cpu = S.cpu || {};
  const cpuSaturada = (cpu.pct || 0) >= UMBRALES.cpu.pctSaturado && (cpu.carga || 0) >= UMBRALES.cpu.cargaSaturada;
  if (cpuSaturada) {
    const culpableProceso = S.procesosHost && S.procesosHost.culpableCpu;
    const esRespaldo = culpableProceso && /mysqldump|backup_db\.sh|apt|unattended-upgrade/i.test(culpableProceso);
    const culpablePropio = CONTENEDORES_PROPIOS.find((n) => (S.procesosHost && S.procesosHost.culpableCpuContenedor) === n);
    const plan = culpablePropio && !esRespaldo ? [{ peldano: "reiniciar_contenedor", objetivo: culpablePropio }] : [];
    return cerrar("cpu_saturada", [], culpablePropio || culpableProceso || null, "no", plan, {
      motivo: esRespaldo ? `Es el respaldo o una actualización (${culpableProceso}); espera a que termine.` : null,
    });
  }

  // 6. falla_tras_despliegue
  const algunoNoSano = CONTENEDORES_PROPIOS.some((n) => clasif[n] !== "sano" && clasif[n] !== "sin_dato");
  const despliegueReciente = S.despliegue && S.despliegue.creadoHaceMs != null && S.despliegue.creadoHaceMs <= UMBRALES.ventanaDespliegue;
  if (algunoNoSano && despliegueReciente && S.despliegue.hayObjetivoRollback) {
    return cerrar("falla_tras_despliegue", [], "zeus-bot", impactoPorCaidos(clasif), [{ peldano: "deshacer_despliegue" }]);
  }
  if (algunoNoSano && despliegueReciente && !S.despliegue.hayObjetivoRollback) {
    // Cae al peldaño del síntoma subyacente (normalmente bot): sigue evaluando abajo.
    agregarSecundario("falla_tras_despliegue");
  }

  // 7. bd_caida
  if (clasif["zeus-mariadb"] !== "sano" && clasif["zeus-mariadb"] !== "sin_dato") {
    const plan = [];
    if (S.respaldoEnCurso) {
      plan.push({ peldano: "esperar_respaldo", objetivo: "zeus-mariadb" });
    } else {
      plan.push({ peldano: "reiniciar_contenedor", objetivo: "zeus-mariadb" });
      if (clasif["zeus-bot"] !== "sano") plan.push({ peldano: "reiniciar_contenedor", objetivo: "zeus-bot" });
    }
    for (const otro of ["zeus-chromadb", "zeus-proxy", "zeus-bot"]) if (clasif[otro] !== "sano") agregarSecundario(sintomaDe(otro));
    return cerrar("bd_caida", secundarios, "zeus-mariadb", "si", plan);
  }

  // 8. busqueda_caida
  if (clasif["zeus-chromadb"] !== "sano" && clasif["zeus-chromadb"] !== "sin_dato") {
    const plan = [{ peldano: "reiniciar_contenedor", objetivo: "zeus-chromadb" }];
    if (clasif["zeus-bot"] !== "sano") plan.push({ peldano: "reiniciar_contenedor", objetivo: "zeus-bot" });
    const impacto = clasif["zeus-bot"] === "sano" ? "parcial" : "si";
    return cerrar("busqueda_caida", secundarios, "zeus-chromadb", impacto, plan);
  }

  // 9. puerta_caida
  if (clasif["zeus-proxy"] !== "sano" && clasif["zeus-proxy"] !== "sin_dato") {
    return cerrar("puerta_caida", secundarios, "zeus-proxy", "si", [{ peldano: "reiniciar_contenedor", objetivo: "zeus-proxy" }]);
  }

  // 10. bot_caido / bot_no_responde
  if (clasif["zeus-bot"] === "caido" || clasif["zeus-bot"] === "no_responde") {
    const sintoma = clasif["zeus-bot"] === "caido" ? "bot_caido" : "bot_no_responde";
    return cerrar(sintoma, secundarios, "zeus-bot", "si", [{ peldano: "reiniciar_contenedor", objetivo: "zeus-bot" }]);
  }

  // 11. contenedor_en_bucle
  const enBucle = CONTENEDORES_PROPIOS.find((n) => clasif[n] === "en_bucle");
  if (enBucle) {
    const despliegueAmplio = S.despliegue && S.despliegue.creadoHaceMs != null && S.despliegue.creadoHaceMs <= UMBRALES.ventanaDespliegueAmplia;
    const plan = (enBucle === "zeus-bot" && despliegueAmplio && S.despliegue.hayObjetivoRollback) ? [{ peldano: "deshacer_despliegue" }] : [];
    return cerrar("contenedor_en_bucle", secundarios, enBucle, "si", plan);
  }

  // 12. servidor_lento
  const cpuLenta = (cpu.carga || 0) >= UMBRALES.cpu.cargaLenta;
  const iowaitLento = (S.iowaitPct || 0) >= UMBRALES.cpu.iowaitLento;
  const swapLento = (S.swapUsadoBytes || 0) > UMBRALES.cpu.swapLentoBytes;
  const botLento = clasif["zeus-bot"] === "lento";
  const hayTrabadas = S.consultasTrabadas && S.consultasTrabadas.hay_trabadas;
  if (cpuLenta || iowaitLento || swapLento || botLento || hayTrabadas) {
    const plan = [];
    if (botLento && S.memoriaContenedorBotBytes >= 1.2 * 1024 * 1024 * 1024) {
      plan.push({ peldano: "reiniciar_contenedor", objetivo: "zeus-bot" });
    }
    return cerrar("servidor_lento", secundarios, hayTrabadas ? null : "zeus-bot", "no", plan, {
      motivo: hayTrabadas ? "Hay una consulta trabada en la base; no la cancelo (nunca hago KILL). Se puede cancelar desde Datos técnicos → Consultas trabadas." : null,
    });
  }

  // 13. ajeno_con_problema
  if (S.ajenoConProblema) {
    return cerrar("ajeno_con_problema", [], null, "no", []);
  }

  // 14. todo_bien
  return cerrar("todo_bien", [], null, "no", []);

  // ── helpers internos ──
  function sintomaDe(nombre) {
    return { "zeus-mariadb": "bd_caida", "zeus-chromadb": "busqueda_caida", "zeus-proxy": "puerta_caida", "zeus-bot": "bot_caido" }[nombre];
  }
  function impactoPorCaidos(cl) {
    if (cl["zeus-bot"] !== "sano" || cl["zeus-mariadb"] !== "sano" || cl["zeus-proxy"] !== "sano") return "si";
    if (cl["zeus-chromadb"] !== "sano") return "parcial";
    return "no";
  }
  function cerrar(sintoma_principal, secundariosExtra, culpable, afecta_clientes, plan, extra) {
    return {
      sintoma_principal,
      secundarios: Array.from(new Set([...secundarios, ...secundariosExtra])),
      culpable: culpable || null,
      afecta_clientes,
      plan: plan || [],
      clasificacion: clasif,
      ...(extra || {}),
    };
  }
}

module.exports = { clasificarContenedor, diagnosticar, UMBRALES, CONTENEDORES_PROPIOS };
