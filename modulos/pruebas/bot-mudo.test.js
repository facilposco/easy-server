"use strict";
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const { crearBotMudo } = require("../bot-mudo.js");

// El módulo arma sus rutas con path.join(DIR_DATOS, "...") — en Windows eso
// usa backslash, así que las pruebas que escriben directo en el "disco" fake
// (p. ej. incidentes.json) tienen que calcular la misma clave, no asumir "/".
const RUTA_INCIDENTES = path.join("/datos", "incidentes.json");
const RUTA_BOT_MUDO = path.join("/datos", "bot-mudo.json");

// ── Arnés: almacén en memoria + reloj y contador de metrics.json controlables ──
// Mismo estilo que modulos/sos/pruebas/puede-actuar.test.js y
// modulos/pruebas/latidos.test.js: fakes simples, sin dependencias externas.

function crearArnes(opciones = {}) {
  const disco = new Map();
  const auditoria = [];
  const enviados = [];
  let reloj = Date.UTC(2026, 8, 12, 16, 0, 0); // 11:00 a. m. Colombia — dentro de horario comercial
  let contador = { date: "2026-09-12", messagesIn: 100, messagesOut: 100, errors: 0 };
  let fallaSh = false;
  let permitirWhatsapp = true;

  const deps = {
    DIR_DATOS: "/datos",
    leerJson: (ruta, def) => (disco.has(ruta) ? JSON.parse(JSON.stringify(disco.get(ruta))) : def),
    guardarJson: (ruta, obj) => disco.set(ruta, JSON.parse(JSON.stringify(obj))),
    auditar: (accion, quien, resultado, detalle) => auditoria.push({ accion, quien, resultado, detalle }),
    enviarWhatsapp: async (texto) => {
      enviados.push(texto);
      return opciones.whatsappFalla ? { ok: false, detalle: "kapso 500" } : { ok: true, detalle: "" };
    },
    sh: async () => {
      if (fallaSh) return { ok: false, salida: "" };
      return { ok: true, salida: JSON.stringify({ daily: contador }) };
    },
    permisos: { permitido: (id, tipo) => !(id === "whatsapp" && tipo === "escritura" && !permitirWhatsapp) },
    reglasSeguridad: { enHorarioComercial: () => (opciones.horario == null ? true : opciones.horario()) },
    ahora: () => reloj,
  };
  if (opciones.deps) Object.assign(deps, opciones.deps);

  const mod = crearBotMudo(deps);

  return {
    mod, disco, auditoria, enviados, deps,
    avanzar: (min) => { reloj += min * 60000; },
    fijarReloj: (ms) => { reloj = ms; },
    entra: (n) => { contador = { ...contador, messagesIn: contador.messagesIn + n }; },
    sale: (n) => { contador = { ...contador, messagesOut: contador.messagesOut + n }; },
    error: (n) => { contador = { ...contador, errors: contador.errors + n }; },
    fijarContador: (c) => { contador = c; },
    fallaSh: (v) => { fallaSh = v; },
    permitirWhatsapp: (v) => { permitirWhatsapp = v; },
    // avanza INTERVALO_MIN minutos y corre una revisión (patrón de "ciclo de 5 min")
    ciclo: () => { reloj += 5 * 60000; return mod.revisar("agente"); },
  };
}

test("fábrica: tira si falta una dependencia obligatoria", () => {
  assert.throws(() => crearBotMudo({}), /crearBotMudo necesita/);
  assert.throws(() => crearBotMudo({ DIR_DATOS: "/x", leerJson: () => {}, guardarJson: () => {}, auditar: () => {} }), /crearBotMudo necesita/);
});

test("primer arranque: una sola muestra, sin episodio, veredicto sin_datos, no manda nada", async () => {
  const a = crearArnes();
  const r = await a.mod.revisar("agente");
  assert.strictEqual(r.resultado, "sin_datos");
  assert.strictEqual(r.episodio, null);
  assert.strictEqual(a.enviados.length, 0);
  const e = a.mod.estado();
  assert.strictEqual(e.nivel, "mute");
  assert.strictEqual(e.muestras, 1);
});

test("silencio real detectado: 2 mensajes sin respuesta durante 15 min abre episodio y manda el aviso una sola vez", async () => {
  const a = crearArnes();
  await a.mod.revisar("agente");
  a.entra(2);
  await a.ciclo(); // +5 min: entra la evidencia
  await a.ciclo(); // +10 min: todavía no llega a 10 min de silencio real
  const r = await a.ciclo(); // +15 min: silencio confirmado
  assert.strictEqual(r.resultado, "mudo");
  assert.ok(r.episodio);
  assert.strictEqual(a.enviados.length, 1);
  assert.match(a.enviados[0], /no está contestando/);
  assert.match(a.enviados[0], /2 clientes/);
  assert.ok(a.auditoria.some((x) => x.resultado === "abierto"));
  assert.ok(a.auditoria.some((x) => x.resultado === "aviso_enviado"));

  // Sigue mudo en los siguientes ciclos: no repite el envío.
  await a.ciclo();
  await a.ciclo();
  assert.strictEqual(a.enviados.length, 1);
  assert.strictEqual(a.mod.estado().episodio.aviso.estado, "enviado");
});

test("no-falsa-alarma: una sola entrada sin salida todavía no abre episodio ni avisa", async () => {
  const a = crearArnes();
  await a.mod.revisar("agente");
  a.entra(1);
  for (let i = 0; i < 4; i++) await a.ciclo();
  assert.strictEqual(a.mod.estado().episodio, null);
  assert.strictEqual(a.enviados.length, 0);
});

test("no-falsa-alarma: un mensaje que se contesta al ciclo siguiente queda en normal", async () => {
  const a = crearArnes();
  await a.mod.revisar("agente");
  a.entra(1);
  await a.ciclo();
  a.sale(1);
  await a.ciclo();
  await a.ciclo();
  const e = a.mod.estado();
  assert.strictEqual(e.nivel, "ok");
  assert.strictEqual(e.episodio, null);
});

test("no-falsa-alarma: dos mensajes recién llegados (menos de 10 min) no abren episodio todavía", async () => {
  const a = crearArnes();
  await a.mod.revisar("agente");
  await a.ciclo();
  a.entra(2);
  const r1 = await a.ciclo(); // primera muestra con la evidencia: recién nace, 0 min de silencio
  assert.notStrictEqual(r1.resultado, "mudo");
  assert.strictEqual(a.mod.estado().episodio, null);
});

test("fuera de horario: abre episodio y audita, pero no manda WhatsApp hasta que entra en horario", async () => {
  let horarioAbierto = false;
  const a = crearArnes({ horario: () => horarioAbierto });
  await a.mod.revisar("agente");
  a.entra(2);
  await a.ciclo();
  await a.ciclo();
  const r = await a.ciclo(); // silencio confirmado, pero fuera de horario
  assert.ok(r.episodio);
  assert.strictEqual(a.enviados.length, 0);
  assert.strictEqual(r.episodio.aviso.motivo_pendiente, "fuera_horario");

  // No repite la auditoría de "aviso_pendiente" en cada ciclo mientras el motivo no cambia.
  await a.ciclo();
  await a.ciclo();
  const pendientes = a.auditoria.filter((x) => x.resultado === "aviso_pendiente" && x.detalle === "fuera_horario");
  assert.strictEqual(pendientes.length, 1);

  // Al entrar en horario y seguir mudo, manda el aviso.
  horarioAbierto = true;
  a.entra(1);
  const r2 = await a.ciclo();
  assert.strictEqual(a.enviados.length, 1);
  assert.strictEqual(r2.episodio.aviso.estado, "enviado");
});

test("fuera de horario: si se recupera de noche sin haber avisado, cierra sin mandar nada", async () => {
  const a = crearArnes({ horario: () => false });
  await a.mod.revisar("agente");
  a.entra(2);
  await a.ciclo();
  await a.ciclo();
  await a.ciclo(); // episodio abierto, sin avisar (fuera de horario)
  assert.ok(a.mod.estado().episodio);
  a.sale(2);
  await a.ciclo();
  assert.strictEqual(a.mod.estado().episodio, null);
  assert.strictEqual(a.enviados.length, 0);
  assert.ok(a.auditoria.some((x) => x.resultado === "recuperado"));
});

test("bot caído (sh falla): no toma muestra nueva, no abre episodio, no avisa como mudo", async () => {
  const a = crearArnes();
  await a.mod.revisar("agente");
  a.entra(3);
  a.fallaSh(true);
  for (let i = 0; i < 3; i++) await a.ciclo();
  const e = a.mod.estado();
  assert.strictEqual(e.muestras, 1); // el buffer no avanzó
  assert.strictEqual(e.episodio, null);
  assert.strictEqual(a.enviados.length, 0);
  const sinLectura = a.auditoria.filter((x) => x.resultado === "sin_lectura");
  assert.strictEqual(sinLectura.length, 1); // solo la primera de la racha se audita

  a.fallaSh(false);
  const r = await a.ciclo();
  assert.notStrictEqual(r.resultado, "sin_lectura");
});

test("bot caído según incidentes.json: no abre episodio como 'mudo' aunque el contador lo sugiera", async () => {
  const a = crearArnes();
  a.disco.set(RUTA_INCIDENTES, { abierto: { servicio: "zeus-bot", inicio: new Date().toISOString() }, historial: [] });
  await a.mod.revisar("agente");
  a.entra(2);
  await a.ciclo();
  await a.ciclo();
  const r = await a.ciclo();
  assert.strictEqual(r.resultado, "bot_caido");
  assert.strictEqual(a.mod.estado().episodio, null);
  assert.strictEqual(a.enviados.length, 0);
});

test("recuperación cierra el episodio y manda el aviso con la duración y los mensajes sin respuesta", async () => {
  const a = crearArnes();
  await a.mod.revisar("agente");
  a.entra(2);
  await a.ciclo();
  await a.ciclo();
  await a.ciclo(); // mudo, aviso 1 enviado
  assert.strictEqual(a.enviados.length, 1);

  a.entra(2); // total 4 sin respuesta
  await a.ciclo();
  a.sale(1);
  await a.ciclo();

  const e = a.mod.estado();
  assert.strictEqual(e.episodio, null);
  assert.strictEqual(e.ultimo_episodio.cierre, "recuperado");
  assert.strictEqual(e.ultimo_episodio.recibidos_sin_respuesta, 4);
  assert.strictEqual(a.enviados.length, 2);
  assert.match(a.enviados[1], /volvió a contestar/);
  assert.match(a.enviados[1], /4 clientes/);
  assert.strictEqual(e.nivel, "ok");
});

test("no repite el aviso dentro del enfriamiento (30 min): un segundo episodio pronto no vuelve a avisar", async () => {
  const a = crearArnes();
  await a.mod.revisar("agente");
  a.entra(2);
  await a.ciclo();
  await a.ciclo();
  await a.ciclo(); // aviso de apertura #1
  assert.strictEqual(a.enviados.length, 1);
  a.sale(2);
  await a.ciclo(); // recuperación -> aviso #2
  assert.strictEqual(a.enviados.length, 2);

  a.entra(2);
  await a.ciclo();
  await a.ciclo();
  const r = await a.ciclo(); // nuevo episodio mudo, pero dentro del enfriamiento de 30 min
  assert.ok(r.episodio);
  assert.strictEqual(a.enviados.length, 2);
  assert.strictEqual(r.episodio.aviso.motivo_pendiente, "enfriamiento");

  a.avanzar(20); // ya pasaron >30 min desde el aviso #1
  a.entra(1);
  const r2 = await a.ciclo();
  assert.strictEqual(a.enviados.length, 3);
  assert.strictEqual(r2.episodio.aviso.estado, "enviado");
});

test("permiso de whatsapp apagado: abre episodio y audita, pero no envía; al reactivarlo, envía", async () => {
  const a = crearArnes();
  a.permitirWhatsapp(false);
  await a.mod.revisar("agente");
  a.entra(2);
  await a.ciclo();
  await a.ciclo();
  const r = await a.ciclo();
  assert.ok(r.episodio);
  assert.strictEqual(a.enviados.length, 0);
  assert.strictEqual(r.episodio.aviso.motivo_pendiente, "sin_permiso_whatsapp");
  assert.ok(a.auditoria.some((x) => x.resultado === "aviso_pendiente" && x.detalle === "sin_permiso_whatsapp"));

  a.permitirWhatsapp(true);
  a.entra(1);
  const r2 = await a.ciclo();
  assert.strictEqual(a.enviados.length, 1);
  assert.strictEqual(r2.episodio.aviso.estado, "enviado");
});

test("permiso de whatsapp apagado también bloquea el aviso de cierre, pero se audita", async () => {
  const a = crearArnes();
  await a.mod.revisar("agente");
  a.entra(2);
  await a.ciclo();
  await a.ciclo();
  await a.ciclo(); // abierto y avisado
  assert.strictEqual(a.enviados.length, 1);

  a.permitirWhatsapp(false);
  a.sale(2);
  await a.ciclo(); // se recupera, pero sin permiso no manda el cierre
  assert.strictEqual(a.enviados.length, 1);
  assert.ok(a.auditoria.some((x) => x.resultado === "sin_permiso_whatsapp" && x.detalle === "cierre recuperacion"));
  assert.strictEqual(a.mod.estado().ultimo_episodio.cierre, "recuperado");
});

test("modo viaje activo no silencia el aviso de bot mudo (es crítico y no se arregla sola)", async () => {
  const kapsoYModo = require("../kapso-y-modo.js");
  const a = crearArnes({ deps: { kapsoYModo, F_MODO: "/datos/modo.json" } });
  a.disco.set("/datos/modo.json", { activo: true, desde: new Date().toISOString(), motivo: "vacaciones" });
  await a.mod.revisar("agente");
  a.entra(2);
  await a.ciclo();
  await a.ciclo();
  await a.ciclo();
  assert.strictEqual(a.enviados.length, 1);
  a.sale(2);
  await a.ciclo();
  assert.strictEqual(a.enviados.length, 2);
});

test("reinicio del proceso a mitad de un episodio: el estado en disco evita reenviar la apertura", async () => {
  const a = crearArnes();
  await a.mod.revisar("agente");
  a.entra(2);
  await a.ciclo();
  await a.ciclo();
  await a.ciclo();
  assert.strictEqual(a.enviados.length, 1);

  // Un segundo módulo, "recién arrancado", comparte el mismo disco y reloj.
  const mod2 = crearBotMudo(a.deps);
  const r = await mod2.revisar("agente");
  assert.ok(r.episodio);
  assert.strictEqual(r.episodio.aviso.estado, "enviado");
  assert.strictEqual(a.enviados.length, 1); // no reenvía
});

test("reinicio de contador (cambio de fecha) descarta el buffer y no abre episodio con datos viejos", async () => {
  const a = crearArnes();
  await a.mod.revisar("agente");
  a.entra(2);
  await a.ciclo();
  await a.ciclo(); // buffer con evidencia pendiente, todavía sin confirmar (2 ciclos, <10 min)

  a.fijarContador({ date: "2026-09-13", messagesIn: 1, messagesOut: 0, errors: 0 });
  const r = await a.ciclo();
  assert.strictEqual(r.motivo, "reinicio_contador");
  assert.strictEqual(a.mod.estado().muestras, 1);
  assert.strictEqual(a.mod.estado().episodio, null);
});

test("medianoche sin actividad: contador con fecha vieja y contadores quietos no se confunde con mudo", async () => {
  const a = crearArnes();
  a.fijarContador({ date: "2026-09-11", messagesIn: 50, messagesOut: 50, errors: 0 });
  await a.mod.revisar("agente");
  for (let i = 0; i < 4; i++) await a.ciclo();
  assert.strictEqual(a.mod.estado().episodio, null);
  assert.strictEqual(a.enviados.length, 0);
});

test("metrics.json sin campo daily o con JSON inválido se trata como sin_lectura, nunca como mudo", async () => {
  const disco = new Map();
  const auditoria = [];
  let salida = "{}";
  const deps = {
    DIR_DATOS: "/datos",
    leerJson: (r, d) => (disco.has(r) ? disco.get(r) : d),
    guardarJson: (r, o) => disco.set(r, o),
    auditar: (a1, a2, r, d) => auditoria.push({ resultado: r, detalle: d }),
    enviarWhatsapp: async () => ({ ok: true }),
    sh: async () => ({ ok: true, salida }),
    ahora: () => Date.now(),
  };
  const mod = crearBotMudo(deps);
  let r = await mod.revisar("agente");
  assert.strictEqual(r.resultado, "sin_lectura");
  assert.strictEqual(r.motivo, "sin campo daily");

  salida = "esto no es json";
  r = await mod.revisar("agente");
  assert.strictEqual(r.motivo, "JSON inválido");
});

test("sh que lanza una excepción nunca rompe revisar(): se trata como sin_lectura", async () => {
  const a = crearArnes({ deps: { sh: async () => { throw new Error("boom"); } } });
  const r = await a.mod.revisar("agente");
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.resultado, "sin_lectura");
});

test("bot-mudo.json corrupto en disco se ignora y arranca limpio sin lanzar", async () => {
  const a = crearArnes();
  a.disco.set(RUTA_BOT_MUDO, { version: 99, muestras: "no-es-array" });
  const r = await a.mod.revisar("agente");
  assert.strictEqual(r.ok, true);
  assert.strictEqual(a.mod.estado().muestras, 1);
});

test("estado() nunca ejecuta docker exec (es una lectura pura del archivo persistido)", async () => {
  let llamadas = 0;
  const a = crearArnes({ deps: { sh: async () => { llamadas++; return { ok: true, salida: JSON.stringify({ daily: { date: "2026-09-12", messagesIn: 1, messagesOut: 1, errors: 0 } }) }; } } });
  await a.mod.revisar("agente");
  llamadas = 0;
  a.mod.estado(); a.mod.estado(); a.mod.estado();
  assert.strictEqual(llamadas, 0);
});

test("caducidad: un episodio confirmado 'mudo' sin pausa NUNCA caduca por sí solo (sigue confirmándose)", async () => {
  // Mientras el mismo silencio siga viéndose cada 5 min, el episodio se
  // reconfirma "mudo" una y otra vez (fila 8 de la tabla de decisión) — la
  // caducidad no es un timeout ciego, es "dejé de poder confirmar mudez".
  const a = crearArnes();
  await a.mod.revisar("agente");
  a.entra(2);
  await a.ciclo();
  await a.ciclo();
  await a.ciclo(); // avisado
  assert.strictEqual(a.enviados.length, 1);
  for (let i = 0; i < 30; i++) await a.ciclo(); // ~150 min más de ciclos normales, cada 5 min
  const e = a.mod.estado();
  assert.ok(e.episodio); // sigue abierto: se sigue confirmando mudo cada ciclo
  assert.strictEqual(a.enviados.length, 1); // no repite el aviso (mismo episodio)
});

test("caducidad: un vacío real de revisiones (>2h sin poder confirmar) cierra el episodio y avisa", async () => {
  // El caso real: el proceso deja de revisar por un buen rato (más de
  // MAX_EDAD_MUESTRA_MIN=60 min) — al volver, el buffer se descarta por
  // viejo, el veredicto cae a sin_datos, y como ya pasaron más de 2 h desde
  // la última confirmación, el episodio se cierra como "caducado".
  const a = crearArnes();
  await a.mod.revisar("agente");
  a.entra(2);
  await a.ciclo();
  await a.ciclo();
  await a.ciclo(); // avisado
  assert.strictEqual(a.enviados.length, 1);

  a.avanzar(130); // más de 2 h sin ninguna revisión
  const r = await a.mod.revisar("agente");
  assert.strictEqual(r.motivo, "muestras_viejas");
  const e = a.mod.estado();
  assert.strictEqual(e.episodio, null);
  assert.ok(e.ultimo_episodio);
  assert.strictEqual(e.ultimo_episodio.cierre, "caducado");
  assert.strictEqual(a.enviados.length, 2);
  assert.match(a.enviados[1], /cierro el aviso/);
});

test("quizaRevisar: solo corre en minutos múltiplos de 5 y no repite el mismo minuto", async () => {
  const a = crearArnes();
  a.fijarReloj(Date.UTC(2026, 8, 12, 15, 5, 0));
  await a.mod.quizaRevisar();
  assert.strictEqual(a.mod.estado().muestras, 1);

  await a.mod.quizaRevisar(); // mismo minuto: no repite
  assert.strictEqual(a.mod.estado().muestras, 1);

  a.fijarReloj(Date.UTC(2026, 8, 12, 15, 7, 0)); // no es múltiplo de 5
  await a.mod.quizaRevisar();
  assert.strictEqual(a.mod.estado().muestras, 1);

  a.fijarReloj(Date.UTC(2026, 8, 12, 15, 10, 0));
  await a.mod.quizaRevisar();
  assert.strictEqual(a.mod.estado().muestras, 2);
});

test("sin reglasSeguridad: usa el horario comercial por defecto (13-01 UTC, Colombia)", async () => {
  const a = crearArnes({ deps: { reglasSeguridad: null } });
  a.fijarReloj(Date.UTC(2026, 8, 12, 6, 0, 0)); // 1:00 a. m. Colombia, fuera de horario
  await a.mod.revisar("agente");
  a.entra(2);
  await a.ciclo();
  await a.ciclo();
  const r = await a.ciclo();
  assert.ok(r.episodio);
  assert.strictEqual(a.enviados.length, 0);
  assert.strictEqual(r.episodio.aviso.motivo_pendiente, "fuera_horario");
});

// ── Pruebas de las funciones puras ─────────────────────────────────────────

test("evaluar (pura): el ancla es la última muestra donde 'enviados' creció", () => {
  const { evaluar } = crearBotMudo({
    DIR_DATOS: "/x", leerJson: () => {}, guardarJson: () => {}, auditar: () => {},
    enviarWhatsapp: async () => ({ ok: true }), sh: async () => ({ ok: true, salida: "{}" }),
  });
  const base = Date.UTC(2026, 8, 12, 12, 0, 0);
  const muestras = [
    { ts: new Date(base).toISOString(), fecha: "2026-09-12", recibidos: 10, enviados: 10, errores: 0 },
    { ts: new Date(base + 5 * 60000).toISOString(), fecha: "2026-09-12", recibidos: 10, enviados: 11, errores: 0 }, // ancla
    { ts: new Date(base + 10 * 60000).toISOString(), fecha: "2026-09-12", recibidos: 12, enviados: 11, errores: 0 }, // primera sin respuesta
    { ts: new Date(base + 15 * 60000).toISOString(), fecha: "2026-09-12", recibidos: 12, enviados: 11, errores: 0 },
    { ts: new Date(base + 20 * 60000).toISOString(), fecha: "2026-09-12", recibidos: 12, enviados: 11, errores: 0 },
  ];
  const ev = evaluar(muestras, base + 20 * 60000);
  assert.strictEqual(ev.ancla_real, true);
  assert.strictEqual(ev.ancla.ts, muestras[1].ts);
  assert.strictEqual(ev.recibidos_sin_respuesta, 2);
  assert.strictEqual(ev.primera_sin_respuesta_ts, muestras[2].ts);
  assert.strictEqual(ev.veredicto, "mudo");
});

test("evaluar (pura): con menos del mínimo de muestras, veredicto es sin_datos", () => {
  const { evaluar } = crearBotMudo({
    DIR_DATOS: "/x", leerJson: () => {}, guardarJson: () => {}, auditar: () => {},
    enviarWhatsapp: async () => ({ ok: true }), sh: async () => ({ ok: true, salida: "{}" }),
  });
  const ev = evaluar([{ ts: new Date().toISOString(), fecha: "x", recibidos: 1, enviados: 0, errores: 0 }], Date.now());
  assert.strictEqual(ev.veredicto, "sin_datos");
});

test("horaColombia: formato de 12 horas y referencia a 'ayer'", () => {
  const { horaColombia } = require("../bot-mudo.js");
  const ahora = Date.UTC(2026, 8, 12, 20, 0, 0);
  assert.strictEqual(horaColombia("2026-09-12T19:15:00.000Z", ahora), "2:15 p. m.");
  assert.strictEqual(horaColombia("2026-09-12T13:05:00.000Z", ahora), "8:05 a. m.");
  const ayer = "2026-09-11T19:15:00.000Z";
  assert.match(horaColombia(ayer, ahora), /^ayer a las/);
});
