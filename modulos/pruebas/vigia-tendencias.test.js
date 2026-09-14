"use strict";
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const {
  crearVigia, evaluarReglas, p95, mediaDiaria, contarReinicios, evaluarAviso, aplicarFeedback,
} = require("../vigia-tendencias.js");

// Mismo estilo de arnés que modulos/pruebas/latidos.test.js y
// modulos/pruebas/bot-mudo.test.js: fakes en memoria, sin tocar disco real ni
// llamar IA de verdad, con reloj inyectable.

const DIR_DATOS = "/datos";
const F_HIST = "/datos/historial.jsonl";
const F_AUDIT = "/datos/auditoria.jsonl";
const RUTA_ESTADO = path.join(DIR_DATOS, "vigia", "estado.json");
const LINEA_FEEDBACK = "¿Te sirvió? Responde /centinela util o /centinela ruido";
const AHORA0 = Date.UTC(2026, 8, 14, 12, 0, 0); // 14 sept. 2026, 12:00 UTC

function crearArnes(opciones = {}) {
  const disco = new Map();
  const auditoria = [];
  const enviados = [];
  const llamadasIA = [];
  let reloj = opciones.ahoraInicial != null ? opciones.ahoraInicial : AHORA0;
  let histArr = opciones.histArr || [];
  let auditArr = opciones.auditArr || [];
  let pred = opciones.prediccion !== undefined ? opciones.prediccion : null;
  let estG = opciones.estadoGeneral !== undefined ? opciones.estadoGeneral : null;
  let permitirWhatsapp = opciones.permitirWhatsapp !== false;
  let iaPermitida = opciones.iaPermitida !== false;
  let respuestaIA = opciones.respuestaIA !== undefined ? opciones.respuestaIA : "Texto de la IA sobre las tendencias.";
  let whatsappOk = opciones.whatsappOk !== false;

  const deps = {
    DIR_DATOS,
    leerJson: (ruta, def) => (disco.has(ruta) ? JSON.parse(JSON.stringify(disco.get(ruta))) : def),
    guardarJson: (ruta, obj) => disco.set(ruta, JSON.parse(JSON.stringify(obj))),
    anexar: () => {}, // el módulo no lo usa (avisos se guardan como arreglo vía guardarJson; ver comentario en vigia-tendencias.js)
    leerJsonl: (archivo, max) => {
      if (archivo === F_HIST) return histArr.slice(-max);
      if (archivo === F_AUDIT) return auditArr.slice(-max);
      return [];
    },
    auditar: (accion, quien, resultado, detalle) => auditoria.push({ accion, quien, resultado, detalle }),
    enviarWhatsapp: async (texto) => {
      enviados.push(texto);
      return whatsappOk ? { ok: true, detalle: "" } : { ok: false, detalle: "kapso 500" };
    },
    prediccion: async () => pred,
    estadoGeneral: async () => estG,
    F_HIST, F_AUDIT,
    HORA_REINICIO_UTC: 9,
    permisos: { permitido: (id, tipo) => !(id === "whatsapp" && tipo === "escritura" && !permitirWhatsapp) },
    ahora: () => reloj,
  };

  if (opciones.conIA !== false) {
    deps.preguntarAGemini = async (persona, contexto, pregunta, opts) => {
      llamadasIA.push({ persona, contexto, pregunta, opts });
      return respuestaIA;
    };
    deps.registrarConsultaIA = () => ({ permitido: iaPermitida, restantes: iaPermitida ? 10 : 0 });
    deps.leerPersonaCentinela = () => "Eres Centinela.";
  }
  if (opciones.latidos) deps.latidos = opciones.latidos;
  if (opciones.deps) Object.assign(deps, opciones.deps);

  const vigia = crearVigia(deps);
  return {
    vigia, disco, auditoria, enviados, llamadasIA, deps,
    fijarReloj: (ms) => { reloj = ms; },
    fijarAudit: (arr) => { auditArr = arr; },
    fijarPrediccion: (p) => { pred = p; },
    fijarEstadoGeneral: (e) => { estG = e; },
  };
}

// ── Helpers de datos sintéticos ─────────────────────────────────────────

function construirMuestrasDia(y, m, d, cantidadMin, valorCpu) {
  const base = Date.UTC(y, m - 1, d, 0, 0, 0) / 1000;
  const arr = [];
  for (let i = 0; i < cantidadMin; i++) arr.push({ t: base + i * 60, cpu: valorCpu, carga: valorCpu });
  return arr;
}

function eventoReinicio(tsIso, contenedor, resultado) {
  return { ts: tsIso, accion: "evento_docker", resultado: resultado || "die", detalle: contenedor };
}

function generarEventosReinicio(ahoraMs, contenedor, nEsta, nAnterior) {
  const eventos = [eventoReinicio(new Date(ahoraMs - 20 * 86400000).toISOString(), contenedor)]; // cobertura de 14 días
  for (let i = 0; i < nAnterior; i++) eventos.push(eventoReinicio(new Date(ahoraMs - 10 * 86400000 - i * 60000).toISOString(), contenedor));
  for (let i = 0; i < nEsta; i++) eventos.push(eventoReinicio(new Date(ahoraMs - 2 * 86400000 - i * 60000).toISOString(), contenedor));
  return eventos;
}

// ── 1. p95 con 100 valores -> índice 95 ─────────────────────────────────

test("p95: con 100 valores usa el índice 95 del arreglo ordenado", () => {
  const valores = [];
  for (let i = 99; i >= 0; i--) valores.push(i); // desordenados a propósito: 99..0
  assert.strictEqual(p95(valores), 95);
});

// ── 2. mediaDiaria agrupa por día UTC y descarta el día en curso ────────

test("mediaDiaria: agrupa por día UTC y descarta el día en curso", () => {
  const ahoraMs = Date.UTC(2026, 8, 14, 15, 0, 0); // hoy = 2026-09-14
  const muestras = [
    { t: Date.UTC(2026, 8, 12, 0, 0, 0) / 1000, cpu: 10 },
    { t: Date.UTC(2026, 8, 12, 12, 0, 0) / 1000, cpu: 20 }, // día 12 -> media 15
    { t: Date.UTC(2026, 8, 13, 0, 0, 0) / 1000, cpu: 30 },
    { t: Date.UTC(2026, 8, 13, 12, 0, 0) / 1000, cpu: 50 }, // día 13 -> media 40
    { t: Date.UTC(2026, 8, 14, 1, 0, 0) / 1000, cpu: 999 }, // hoy -> se descarta
  ];
  const r = mediaDiaria(muestras, "cpu", ahoraMs);
  assert.strictEqual(r.length, 2);
  assert.strictEqual(r[0].dia, "2026-09-12");
  assert.strictEqual(r[0].media, 15);
  assert.strictEqual(r[1].dia, "2026-09-13");
  assert.strictEqual(r[1].media, 40);
});

// ── 3. p95_cpu dispara solo si los 3 días superan p95×factor; con 2 de 3 no ──

test("p95_cpu: dispara solo si los 3 días recientes superan p95×factor; con 2 de 3 no dispara", () => {
  const ahoraMs = Date.UTC(2026, 8, 14, 12, 0, 0); // hoy 14 sept.
  let hist = [];
  for (let dia = 2; dia <= 8; dia++) hist = hist.concat(construirMuestrasDia(2026, 9, dia, 1440, 20)); // línea base: 7 días, cpu=20
  hist = hist.concat(construirMuestrasDia(2026, 9, 11, 200, 90));
  hist = hist.concat(construirMuestrasDia(2026, 9, 12, 200, 90));
  hist = hist.concat(construirMuestrasDia(2026, 9, 13, 200, 90));

  let ins = { prediccion: null, estadoGeneral: null, muestrasHist: hist, eventosAudit: [], horaReinicioUtc: 9 };
  let r = evaluarReglas(ins, {}, ahoraMs);
  assert.ok(r.disparadas.some((x) => x.id === "p95_cpu"), "debería disparar con los 3 días altos");

  // Ahora solo 2 de los 3 días recientes superan el umbral (el día 13 baja).
  const histBase = hist.slice(0, hist.length - 200); // quita las 200 muestras del día 13
  const hist2 = histBase.concat(construirMuestrasDia(2026, 9, 13, 200, 15));
  r = evaluarReglas({ ...ins, muestrasHist: hist2 }, {}, ahoraMs);
  assert.ok(!r.disparadas.some((x) => x.id === "p95_cpu"), "no debería disparar con solo 2 de 3 días altos");
});

// ── 4. Menos de 7 días base -> sin_datos ────────────────────────────────

test("p95: menos de 7 días de línea base produce sin_datos", () => {
  const ahoraMs = Date.UTC(2026, 8, 14, 12, 0, 0);
  let hist = [];
  for (let dia = 5; dia <= 9; dia++) hist = hist.concat(construirMuestrasDia(2026, 9, dia, 1440, 20)); // solo 5 días base
  hist = hist.concat(construirMuestrasDia(2026, 9, 11, 200, 90));
  hist = hist.concat(construirMuestrasDia(2026, 9, 12, 200, 90));
  hist = hist.concat(construirMuestrasDia(2026, 9, 13, 200, 90));

  const ins = { prediccion: null, estadoGeneral: null, muestrasHist: hist, eventosAudit: [], horaReinicioUtc: 9 };
  const r = evaluarReglas(ins, {}, ahoraMs);
  assert.ok(r.sinDatos.includes("p95_cpu"));
  assert.ok(r.sinDatos.includes("p95_carga"));
});

// ── 5. contarReinicios excluye zeus-bot ±10 min de las 09:00 UTC y cuenta die/kill/oom, no stop ──

test("contarReinicios: excluye el reinicio programado de zeus-bot y no cuenta 'stop'", () => {
  const ahoraMs = Date.UTC(2026, 8, 14, 12, 0, 0);
  const eventos = [
    eventoReinicio("2026-08-25T00:00:00.000Z", "zeus-bot"), // cobertura de 14 días (el más viejo, primero)
    eventoReinicio("2026-09-05T09:20:00.000Z", "zeus-bot", "kill"), // semana anterior, 20 min de las 09:00 -> cuenta
    eventoReinicio("2026-09-11T09:05:00.000Z", "zeus-bot", "die"), // 5 min de las 09:00 -> EXCLUIDO (programado)
    eventoReinicio("2026-09-11T09:15:00.000Z", "zeus-bot", "die"), // 15 min de las 09:00 -> cuenta
    eventoReinicio("2026-09-11T10:00:00.000Z", "zeus-bot", "stop"), // stop -> nunca cuenta
  ];
  const r = contarReinicios(eventos, "zeus-bot", 9, ahoraMs);
  assert.strictEqual(r.sinDatos, false);
  assert.strictEqual(r.esta, 1);
  assert.strictEqual(r.anterior, 1);
});

// ── 6. reinicios_*: 4 vs 1 dispara; 2 vs 1 no (mínimo 3); 4 vs 4 no ─────

test("reinicios_*: 4 vs 1 dispara; 2 vs 1 no alcanza el mínimo; 4 vs 4 no supera lo anterior", () => {
  const ahoraMs = AHORA0;
  const estG = { contenedores: [{ nombre: "zeus-chromadb", gestionado: true }] };
  let ins = { prediccion: null, estadoGeneral: estG, muestrasHist: [], eventosAudit: generarEventosReinicio(ahoraMs, "zeus-chromadb", 4, 1), horaReinicioUtc: 9 };
  let r = evaluarReglas(ins, {}, ahoraMs);
  assert.ok(r.disparadas.some((x) => x.id === "reinicios_zeus-chromadb"));

  ins = { ...ins, eventosAudit: generarEventosReinicio(ahoraMs, "zeus-chromadb", 2, 1) };
  r = evaluarReglas(ins, {}, ahoraMs);
  assert.ok(!r.disparadas.some((x) => x.id === "reinicios_zeus-chromadb"));

  ins = { ...ins, eventosAudit: generarEventosReinicio(ahoraMs, "zeus-chromadb", 4, 4) };
  r = evaluarReglas(ins, {}, ahoraMs);
  assert.ok(!r.disparadas.some((x) => x.id === "reinicios_zeus-chromadb"));
});

// ── 6b. Regresión: "gestionado" no es "propio" — un contenedor de otro
// proyecto (con política de reinicio, por tanto gestionado:true) nunca debe
// disparar una regla, tenga o no `contenedoresPropios` en insumos ─────────

test("reinicios_*: un contenedor ajeno (gestionado:true) nunca dispara, con o sin contenedoresPropios explícito", () => {
  const ahoraMs = AHORA0;
  const estGConAjeno = { contenedores: [{ nombre: "otro-proyecto-a", gestionado: true }] };
  const eventosAjeno = generarEventosReinicio(ahoraMs, "otro-proyecto-a", 9, 0);

  // Sin lista explícita: cae al valor por defecto (los 4 propios de Zeus) y "otro-proyecto-a" queda fuera.
  let ins = { prediccion: null, estadoGeneral: estGConAjeno, muestrasHist: [], eventosAudit: eventosAjeno, horaReinicioUtc: 9 };
  let r = evaluarReglas(ins, {}, ahoraMs);
  assert.ok(!r.disparadas.some((x) => x.id === "reinicios_otro-proyecto-a"));

  // Con lista explícita que tampoco incluye "otro-proyecto-a": mismo resultado.
  ins = { ...ins, contenedoresPropios: ["zeus-mariadb", "zeus-chromadb", "zeus-bot", "zeus-proxy"] };
  r = evaluarReglas(ins, {}, ahoraMs);
  assert.ok(!r.disparadas.some((x) => x.id === "reinicios_otro-proyecto-a"));
});

// ── 7. proyeccion_disco: dias 12 -> tier 14; dias 6 -> tier 7; cortado -> no dispara ──

test("proyeccion_disco/memoria: elige el tier más ajustado; memoria cortada no dispara", () => {
  const ahoraMs = AHORA0;
  const estG = { disco: { pct: 83 }, ram: { pct: 60 }, arranque: "2026-09-14T04:00:00.000Z", contenedores: [] };
  let pred = { pronosticos: [{ recurso: "Disco", dias: 12, ritmo: 1.2 }, { recurso: "Memoria", dias: 5, ritmo: 2, cortado: true }] };
  let ins = { prediccion: pred, estadoGeneral: estG, muestrasHist: [], eventosAudit: [], horaReinicioUtc: 9 };
  let r = evaluarReglas(ins, {}, ahoraMs);
  const disco12 = r.disparadas.find((x) => x.id === "proyeccion_disco");
  assert.ok(disco12);
  assert.strictEqual(disco12.datos.tier, 14);
  assert.ok(!r.disparadas.some((x) => x.id === "proyeccion_memoria"), "cortado:true no debe disparar");

  pred = { pronosticos: [{ recurso: "Disco", dias: 6, ritmo: 1.5 }, { recurso: "Memoria", dias: null }] };
  r = evaluarReglas({ ...ins, prediccion: pred }, {}, ahoraMs);
  const disco6 = r.disparadas.find((x) => x.id === "proyeccion_disco");
  assert.ok(disco6);
  assert.strictEqual(disco6.datos.tier, 7);
});

// ── 8. Dedupe: misma clave dentro de 7 días no reenvía; tier distinto sí ──

test("revisar(): dedupe por clave 7 días; un tier distinto sí reenvía", async () => {
  const a = crearArnes({ conIA: false });
  a.fijarEstadoGeneral({ disco: { pct: 83 }, ram: { pct: 50 }, arranque: "t0", contenedores: [] });
  a.fijarPrediccion({ pronosticos: [{ recurso: "Disco", dias: 12, ritmo: 1.2 }] });

  const r1 = await a.vigia.revisar("panel");
  assert.strictEqual(r1.enviado, true);
  assert.strictEqual(a.enviados.length, 1);

  const r2 = await a.vigia.revisar("panel"); // misma clave (tier 14)
  assert.strictEqual(a.enviados.length, 1, "no debe reenviar la misma clave");
  assert.ok(r2.omitidas_dedupe.includes("proyeccion_disco:14"));

  a.fijarPrediccion({ pronosticos: [{ recurso: "Disco", dias: 6, ritmo: 1.5 }] }); // tier distinto -> clave distinta
  const r3 = await a.vigia.revisar("panel");
  assert.strictEqual(a.enviados.length, 2, "un tier distinto sí debe reenviar");
  assert.strictEqual(r3.enviado, true);
});

// ── 9. Sin disparos -> no se llama a la IA ni a WhatsApp ────────────────

test("revisar(): sin disparos no llama a la IA ni a WhatsApp", async () => {
  const a = crearArnes({});
  const r = await a.vigia.revisar("panel");
  assert.strictEqual(r.disparadas.length, 0);
  assert.strictEqual(a.llamadasIA.length, 0);
  assert.strictEqual(a.enviados.length, 0);
});

// ── 10. Con disparos y registrarConsultaIA -> {permitido:false} -> plantilla y un WhatsApp ──

test("revisar(): sin cupo de IA usa la plantilla y manda un solo WhatsApp", async () => {
  const a = crearArnes({ iaPermitida: false });
  a.fijarEstadoGeneral({ contenedores: [{ nombre: "zeus-chromadb", gestionado: true }] });
  a.fijarAudit(generarEventosReinicio(AHORA0, "zeus-chromadb", 4, 1));

  const r = await a.vigia.revisar("panel");
  assert.strictEqual(r.enviado, true);
  assert.strictEqual(a.enviados.length, 1);
  assert.strictEqual(a.llamadasIA.length, 0);
});

// ── 11. Con IA: una sola llamada, maxOutputTokens:500, mensaje termina en la línea de feedback ──

test("revisar(): con IA disponible hace una sola llamada con maxOutputTokens 500", async () => {
  const a = crearArnes({ iaPermitida: true, respuestaIA: "Aquí va el resumen humano de la IA." });
  a.fijarEstadoGeneral({ contenedores: [{ nombre: "zeus-chromadb", gestionado: true }] });
  a.fijarAudit(generarEventosReinicio(AHORA0, "zeus-chromadb", 4, 1));

  const r = await a.vigia.revisar("panel");
  assert.strictEqual(a.llamadasIA.length, 1);
  assert.strictEqual(a.llamadasIA[0].opts.maxOutputTokens, 500);
  const lineas = r.mensaje.split("\n");
  assert.strictEqual(lineas[lineas.length - 1], LINEA_FEEDBACK);
});

// ── 12. aplicarFeedback: 3 ruido seguidos sube nivel y reinicia contador; util baja nivel ──

test("aplicarFeedback: 3 ruido seguidos sube el nivel y reinicia el contador; util lo baja", () => {
  let ajustes = {};
  ajustes = aplicarFeedback(ajustes, "p95_cpu", "ruido");
  assert.deepStrictEqual(ajustes.p95_cpu, { nivel: 0, ruido_seguidos: 1 });
  ajustes = aplicarFeedback(ajustes, "p95_cpu", "ruido");
  assert.deepStrictEqual(ajustes.p95_cpu, { nivel: 0, ruido_seguidos: 2 });
  ajustes = aplicarFeedback(ajustes, "p95_cpu", "ruido");
  assert.deepStrictEqual(ajustes.p95_cpu, { nivel: 1, ruido_seguidos: 0 });

  ajustes = aplicarFeedback(ajustes, "p95_cpu", "util");
  assert.deepStrictEqual(ajustes.p95_cpu, { nivel: 0, ruido_seguidos: 0 });
});

// ── 13. Nivel 3 silencia la regla (no envía, sí registra) ───────────────

test("revisar(): nivel 3 silencia la regla — no envía, pero queda registrada", async () => {
  const a = crearArnes({ conIA: false });
  a.disco.set(RUTA_ESTADO, {
    version: 1, ajustes: { "reinicios_zeus-chromadb": { nivel: 3, ruido_seguidos: 0 } },
    ultima_corrida: null, ultima_corrida_diaria: null, dias_historial: null,
  });
  a.fijarEstadoGeneral({ contenedores: [{ nombre: "zeus-chromadb", gestionado: true }] });
  // Nivel 3 reutiliza el umbral del nivel 2 para poder seguir evaluando
  // (§2.5, ver comentario en vigia-tendencias.js): mínimo semanal 8, así que
  // hacen falta 9 reinicios para que la condición dispare de verdad.
  a.fijarAudit(generarEventosReinicio(AHORA0, "zeus-chromadb", 9, 1));

  const r = await a.vigia.revisar("panel");
  assert.ok(r.disparadas.some((x) => x.id === "reinicios_zeus-chromadb"), "debe quedar registrada");
  assert.strictEqual(a.enviados.length, 0, "no debe enviarse");
  assert.strictEqual(r.enviado, false);
});

// ── 14. evaluarAviso: acertó/falló/sin_datos para cada tipo, incluida memoria con arranque posterior ──

test("evaluarAviso: acertó/falló/sin_datos por tipo de regla", () => {
  let r = evaluarAviso({ id: "proyeccion_disco", datos: { pct: 80 } }, { pctActual: 85, coberturaVentana: true });
  assert.strictEqual(r.resultado, "acerto");
  r = evaluarAviso({ id: "proyeccion_disco", datos: { pct: 80 } }, { pctActual: 75, coberturaVentana: true });
  assert.strictEqual(r.resultado, "fallo");
  r = evaluarAviso({ id: "proyeccion_disco", datos: { pct: 80 } }, { pctActual: 85, coberturaVentana: false });
  assert.strictEqual(r.resultado, "sin_datos");

  // memoria: el servidor se reinició después del aviso -> sin_datos
  r = evaluarAviso(
    { id: "proyeccion_memoria", datos: { pct: 70, arranque: "2026-09-10T04:00:00.000Z" } },
    { pctActual: 90, coberturaVentana: true, arranqueActual: "2026-09-12T04:00:00.000Z" },
  );
  assert.strictEqual(r.resultado, "sin_datos");
  // memoria: mismo arranque -> se puede juzgar con normalidad
  r = evaluarAviso(
    { id: "proyeccion_memoria", datos: { pct: 70, arranque: "2026-09-10T04:00:00.000Z" } },
    { pctActual: 90, coberturaVentana: true, arranqueActual: "2026-09-10T04:00:00.000Z" },
  );
  assert.strictEqual(r.resultado, "acerto");

  r = evaluarAviso({ id: "p95_cpu", datos: { p95: 50 } }, { muestrasVentana: [60, 70, 55], coberturaVentana: true });
  assert.strictEqual(r.resultado, "acerto");
  r = evaluarAviso({ id: "p95_cpu", datos: { p95: 50 } }, { muestrasVentana: [10, 20], coberturaVentana: true });
  assert.strictEqual(r.resultado, "fallo");
  r = evaluarAviso({ id: "p95_cpu", datos: { p95: 50 } }, { muestrasVentana: [], coberturaVentana: false });
  assert.strictEqual(r.resultado, "sin_datos");

  r = evaluarAviso({ id: "reinicios_zeus-chromadb", datos: { contenedor: "zeus-chromadb" } }, { eventosVentana: 2, coberturaVentana: true });
  assert.strictEqual(r.resultado, "acerto");
  r = evaluarAviso({ id: "reinicios_zeus-chromadb", datos: { contenedor: "zeus-chromadb" } }, { eventosVentana: 0, coberturaVentana: true });
  assert.strictEqual(r.resultado, "fallo");
  r = evaluarAviso({ id: "reinicios_zeus-chromadb", datos: { contenedor: "zeus-chromadb" } }, { eventosVentana: 0, coberturaVentana: false });
  assert.strictEqual(r.resultado, "sin_datos");
});

// ── 15. Frenos whatsapp/modo viaje: guardan enviado:false y cuentan para dedupe ──

test("revisar(): freno de permiso de WhatsApp guarda enviado:false y cuenta para dedupe", async () => {
  const a = crearArnes({ conIA: false, permitirWhatsapp: false });
  a.fijarEstadoGeneral({ disco: { pct: 83 }, ram: { pct: 50 }, arranque: "t0", contenedores: [] });
  a.fijarPrediccion({ pronosticos: [{ recurso: "Disco", dias: 12, ritmo: 1.2 }] });

  const r1 = await a.vigia.revisar("panel");
  assert.strictEqual(r1.enviado, false);
  assert.strictEqual(r1.motivo, "sin_permiso_whatsapp");
  assert.strictEqual(a.enviados.length, 0);

  const r2 = await a.vigia.revisar("panel"); // mismo día, misma clave: debe contar para dedupe igual
  assert.ok(r2.omitidas_dedupe.includes("proyeccion_disco:14"));
  assert.strictEqual(a.enviados.length, 0);
});

// ── 16. quizaCorridaDiaria a las 14 UTC corre una vez y registra el latido ──

test("quizaCorridaDiaria: a las 14 UTC corre una sola vez y registra el latido", async () => {
  const registros = [];
  const latidosFake = { registrar: (id, resultado, quien) => registros.push({ id, resultado, quien }) };
  const a = crearArnes({ conIA: false, ahoraInicial: Date.UTC(2026, 8, 14, 14, 5, 0), latidos: latidosFake });

  await a.vigia.quizaCorridaDiaria();
  await a.vigia.quizaCorridaDiaria();

  assert.strictEqual(registros.length, 1);
  assert.strictEqual(registros[0].id, "vigia_tendencias");
  assert.strictEqual(a.auditoria.filter((x) => x.accion === "vigia").length, 1);
});
