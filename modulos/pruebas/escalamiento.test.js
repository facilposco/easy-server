"use strict";
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const {
  crearEscalamiento, validarNumero, enmascararNumero, esAcuse, tipoDeClave,
} = require("../escalamiento.js");
const kapsoYModoReal = require("../kapso-y-modo.js");

// Mismas rutas exactas que construye internamente modulos/escalamiento.js
// para DIR_DATOS="/x" — se calculan aquí con path.join (no a mano) para que
// las pruebas no dependan del separador de rutas del sistema operativo.
const DIR_DATOS = "/x";
const RUTA_INCIDENTES = path.join(DIR_DATOS, "incidentes.json");
const RUTA_CORRIDAS = path.join(DIR_DATOS, "centinela-db", "sos-corridas.jsonl");
const RUTA_MODO = path.join(DIR_DATOS, "modo.json");

// ── Fakes (mismo estilo que modulos/pruebas/latidos.test.js y
//    modulos/sos/pruebas/puede-actuar.test.js) ───────────────────────────

function crearAlmacenJson() {
  const datos = {};
  return {
    leerJson(ruta, porDefecto) {
      if (!(ruta in datos)) return porDefecto;
      return JSON.parse(JSON.stringify(datos[ruta])); // simula lectura fresca de disco
    },
    guardarJson(ruta, obj) { datos[ruta] = JSON.parse(JSON.stringify(obj)); },
    datos,
  };
}

function crearAlmacenJsonl() {
  const lineas = {};
  return {
    leerJsonl(ruta, max) {
      const arr = lineas[ruta] || [];
      return arr.slice(-max).map((x) => JSON.parse(JSON.stringify(x)));
    },
    agregar(ruta, obj) {
      lineas[ruta] = lineas[ruta] || [];
      lineas[ruta].push(obj);
    },
  };
}

/** Reloj inyectable mutable: mismo criterio que sos/pruebas y latidos.test.js. */
function relojFalso(msInicial) {
  let actual = msInicial;
  return { ahora: () => actual, avanzarMin: (min) => { actual += min * 60000; } };
}

function crearWhatsapp() {
  const enviados = [];
  return {
    enviados,
    async enviarWhatsapp(texto) { enviados.push({ destino: "dueño", texto }); return { ok: true }; },
    async enviarWhatsappA(numero, texto) { enviados.push({ destino: numero, texto }); return { ok: true }; },
  };
}

const permisosPermisivos = { permitido: () => true };

function construir(overrides = {}) {
  const almacen = crearAlmacenJson();
  const jsonl = crearAlmacenJsonl();
  const auditoria = [];
  const wsp = overrides.wsp || crearWhatsapp();
  const reloj = overrides.reloj || relojFalso(Date.UTC(2026, 8, 12, 14, 0, 0));
  const deps = {
    DIR_DATOS,
    leerJson: almacen.leerJson,
    leerJsonl: jsonl.leerJsonl,
    guardarJson: almacen.guardarJson,
    auditar: (accion, quien, resultado, detalle) => auditoria.push({ accion, quien, resultado, detalle }),
    enviarWhatsapp: wsp.enviarWhatsapp,
    enviarWhatsappA: wsp.enviarWhatsappA,
    permisos: overrides.permisos || permisosPermisivos,
    kapsoYModo: overrides.kapsoYModo,
    F_MODO: overrides.F_MODO,
    WSP_DESTINO: overrides.WSP_DESTINO !== undefined ? overrides.WSP_DESTINO : "573009999999",
    ahora: reloj.ahora,
  };
  const esc = crearEscalamiento(deps);
  return { esc, almacen, jsonl, auditoria, wsp, reloj, deps };
}

// ── 1. Aviso crítico sin "ok" -> a los 15 min reenvía al técnico ─────────

test("aviso crítico sin 'ok' -> a los 15 min reenvía al técnico", async () => {
  const { esc, wsp, reloj } = construir();
  esc.guardarConfig({ tecnico: "573001234567" }, "prueba");

  await esc.abrir("manual:p1", "Falla grave");
  assert.strictEqual(wsp.enviados.length, 1);
  assert.match(wsp.enviados[0].texto, /Responde \*\/centinela ok\*/);

  reloj.avanzarMin(14);
  await esc.quizaEscalar();
  assert.strictEqual(wsp.enviados.length, 1, "a los 14 min todavía no debe reenviar");

  reloj.avanzarMin(1);
  await esc.quizaEscalar();
  assert.strictEqual(wsp.enviados.length, 2, "a los 15 min debe reenviar");
  assert.strictEqual(wsp.enviados[1].destino, "573001234567");

  const est = esc.estado();
  assert.strictEqual(est.pendientes[0].intentos, 1);
});

// ── 2. Con "ok" antes de los 15 min -> no escala y queda auditado ────────

test("acuse ('ok') antes de los 15 min -> no escala y queda auditado", async () => {
  const { esc, wsp, reloj, auditoria } = construir();
  await esc.abrir("manual:p2", "Falla");

  reloj.avanzarMin(5);
  const r = esc.acusar("dueño");
  assert.deepStrictEqual(r.cerradas, ["manual:p2"]);

  reloj.avanzarMin(20);
  await esc.quizaEscalar();

  assert.strictEqual(wsp.enviados.length, 1, "no debe reenviar tras el acuse");
  const est = esc.estado();
  assert.strictEqual(est.pendientes.length, 0);
  assert.strictEqual(est.historial[0].cierre, "acusada");
  assert.strictEqual(est.historial[0].acusada_por, "dueño");
  assert.ok(auditoria.some((a) => a.accion === "escalamiento_acusada" && a.resultado === "ok"));
});

// ── 3. Sin técnico configurado -> reintenta al dueño ─────────────────────

test("sin técnico configurado -> reintenta al mismo número del dueño", async () => {
  const { esc, wsp, reloj } = construir();
  await esc.abrir("manual:p3", "Falla");

  reloj.avanzarMin(15);
  await esc.quizaEscalar();

  assert.strictEqual(wsp.enviados.length, 2);
  assert.strictEqual(wsp.enviados[1].destino, "dueño");
  assert.match(wsp.enviados[1].texto, /Aviso 1 de 3/);
  assert.match(wsp.enviados[1].texto, /Responde \*\/centinela ok\*/);
});

// ── 4. Máximo 3 reintentos y para ─────────────────────────────────────────

test("máximo 3 reintentos y luego se rinde (agotada)", async () => {
  const { esc, wsp, reloj } = construir();
  esc.guardarConfig({ tecnico: "573001234567" }, "prueba");
  await esc.abrir("manual:p4", "Falla");

  // T+15 reenvío 1, T+30 no-op, T+45 reenvío 2, T+60 no-op,
  // T+75 reenvío 3, T+90 no-op, T+105 se agota (sin enviar un 4º mensaje).
  for (let i = 0; i < 7; i++) {
    reloj.avanzarMin(15);
    await esc.quizaEscalar();
  }

  assert.strictEqual(wsp.enviados.length, 4, "inicial + 3 reintentos, nada más");
  const est = esc.estado();
  assert.strictEqual(est.pendientes.length, 0);
  assert.strictEqual(est.historial[0].cierre, "agotada");
  assert.strictEqual(est.historial[0].intentos, 3);
});

// ── 5. cerrar() por recuperación cancela la escalada ─────────────────────

test("cerrar() por recuperación cancela la escalada en curso", async () => {
  const { esc, wsp, reloj } = construir();
  await esc.abrir("manual:p5", "Falla");

  reloj.avanzarMin(10);
  const r = esc.cerrar("manual:p5");
  assert.strictEqual(r.existia, true);

  reloj.avanzarMin(30);
  await esc.quizaEscalar();

  assert.strictEqual(wsp.enviados.length, 1, "no debe reenviar tras cerrar por recuperación");
  assert.strictEqual(esc.estado().historial[0].cierre, "recuperada");
});

test("quizaEscalar cierra sola una escalada de tipo 'caida' cuando el incidente se resuelve", async () => {
  const { esc, almacen, reloj, wsp } = construir();
  almacen.guardarJson(RUTA_INCIDENTES, {
    abierto: { servicio: "zeus-bot", inicio: "2026-09-12T13:40:00.000Z" },
    historial: [],
  }); // 20 min antes de "ahora" (14:00) — ya supera UMBRAL_CAIDA_MIN (10)

  await esc.quizaEscalar();
  let est = esc.estado();
  assert.strictEqual(est.pendientes.length, 1);
  assert.strictEqual(est.pendientes[0].tipo, "caida");
  assert.strictEqual(wsp.enviados.length, 1);

  almacen.guardarJson(RUTA_INCIDENTES, { abierto: null, historial: [] });
  reloj.avanzarMin(1);
  await esc.quizaEscalar();

  est = esc.estado();
  assert.strictEqual(est.pendientes.length, 0);
  assert.strictEqual(est.historial[0].cierre, "recuperada");
  assert.strictEqual(wsp.enviados.length, 1, "la recuperación no manda ningún mensaje nuevo");
});

// ── 6. Permiso whatsapp/escritura apagado -> no envía pero audita ────────

test("permiso whatsapp/escritura apagado -> no envía nada, pero audita todo", async () => {
  const permisos = { permitido: (id, tipo) => !(id === "whatsapp" && tipo === "escritura") };
  const { esc, wsp, reloj, auditoria } = construir({ permisos });

  await esc.abrir("manual:p6", "Falla");
  assert.strictEqual(wsp.enviados.length, 0);

  reloj.avanzarMin(15);
  await esc.quizaEscalar();
  assert.strictEqual(wsp.enviados.length, 0);

  const est = esc.estado();
  assert.strictEqual(est.pendientes[0].intentos, 1, "la máquina de estados avanza igual");
  assert.strictEqual(est.pendientes[0].envios[0].resultado, "sin_permiso_whatsapp");
  assert.strictEqual(est.pendientes[0].envios[1].resultado, "sin_permiso_whatsapp");
  assert.ok(auditoria.some((a) => a.accion === "escalamiento_abierta" && a.resultado === "sin_permiso_whatsapp"));
  assert.ok(auditoria.some((a) => a.accion === "escalamiento_reenvio" && a.resultado === "sin_permiso_whatsapp"));
});

// ── 7. Modo viaje activo -> el recordatorio queda silenciado ─────────────

test("modo viaje activo -> el recordatorio de escalada queda silenciado (kapso-y-modo real)", async () => {
  const { esc, wsp, reloj, almacen } = construir({ kapsoYModo: kapsoYModoReal, F_MODO: RUTA_MODO });
  almacen.guardarJson(RUTA_MODO, { activo: true, desde: "2026-09-01T00:00:00.000Z", motivo: "viaje" });

  await esc.abrir("manual:p7", "Falla");
  assert.strictEqual(wsp.enviados.length, 0);

  reloj.avanzarMin(15);
  await esc.quizaEscalar();
  assert.strictEqual(wsp.enviados.length, 0);

  const est = esc.estado();
  assert.strictEqual(est.pendientes[0].envios[0].resultado, "silenciado_modo_viaje");
  assert.strictEqual(est.pendientes[0].envios[1].resultado, "silenciado_modo_viaje");
});

// ── 8. Número de técnico inválido rechazado en la configuración ──────────

test("número de técnico inválido se rechaza en la configuración, sin guardar", () => {
  const { esc } = construir();
  for (const malo of ["+57 300", "123", "1234567890123456", "57abc", "300 123 4567"]) {
    const r = esc.guardarConfig({ tecnico: malo }, "panel");
    assert.strictEqual(r.ok, false, `debería rechazar "${malo}"`);
    assert.ok(r.mensaje);
  }
  assert.strictEqual(esc.leerConfig().tecnico, null, "ningún número inválido quedó guardado");

  const ok1 = esc.guardarConfig({ tecnico: "573001234567" }, "panel");
  assert.strictEqual(ok1.ok, true);
  assert.strictEqual(esc.leerConfig().tecnico, "573001234567");

  const ok2 = esc.guardarConfig({ tecnico: "" }, "panel");
  assert.strictEqual(ok2.ok, true);
  assert.strictEqual(esc.leerConfig().tecnico, null, "vacío borra el técnico");
});

test("el número del técnico no puede ser igual al del dueño", () => {
  const { esc } = construir({ WSP_DESTINO: "573001234567" });
  const r = esc.guardarConfig({ tecnico: "573001234567" }, "panel");
  assert.strictEqual(r.ok, false);
});

// ── Extras recomendadas por el diseño (no obligatorias) ──────────────────

test("esAcuse reconoce 'ok' y variantes cortas, rechaza texto con más contenido", () => {
  assert.strictEqual(esAcuse("ok"), true);
  assert.strictEqual(esAcuse(" OK. "), true);
  assert.strictEqual(esAcuse("Listo!"), true);
  assert.strictEqual(esAcuse("ok 1"), false);
  assert.strictEqual(esAcuse("okupa"), false);
  assert.strictEqual(esAcuse(""), false);
});

test("validarNumero: vacío borra, dígitos válidos pasan, todo lo demás se rechaza", () => {
  assert.deepStrictEqual(validarNumero(null), { ok: true, numero: null });
  assert.deepStrictEqual(validarNumero(undefined), { ok: true, numero: null });
  assert.deepStrictEqual(validarNumero("  "), { ok: true, numero: null });
  assert.deepStrictEqual(validarNumero("573001234567"), { ok: true, numero: "573001234567" });
  assert.strictEqual(validarNumero("+573001234567").ok, false);
});

test("enmascararNumero nunca deja ver más de los últimos 4 dígitos", () => {
  assert.strictEqual(enmascararNumero("573001234567"), "••• 4567");
  assert.strictEqual(enmascararNumero(null), null);
  assert.strictEqual(enmascararNumero("12"), "•••");
});

test("tipoDeClave clasifica por prefijo", () => {
  assert.strictEqual(tipoDeClave("sos:abc"), "sos");
  assert.strictEqual(tipoDeClave("caida:zeus-bot:2026-09-12T13:00:00.000Z"), "caida");
  assert.strictEqual(tipoDeClave("manual:x"), "manual");
  assert.strictEqual(tipoDeClave("otracosa"), "manual");
});

test("abrir() es idempotente: una clave ya activa no duplica envíos ni reinicia intentos", async () => {
  const { esc, wsp, reloj } = construir();
  await esc.abrir("manual:p9", "Falla");
  reloj.avanzarMin(15);
  await esc.quizaEscalar();

  const r = await esc.abrir("manual:p9", "Falla otra vez, mismo problema");
  assert.strictEqual(r.ya_abierta, true);
  const est = esc.estado();
  assert.strictEqual(est.pendientes.length, 1);
  assert.strictEqual(est.pendientes[0].intentos, 1);
  assert.strictEqual(wsp.enviados.length, 2);
});

test("un SOS detenido reemplaza (absorbe) una caída del bot en curso", async () => {
  const { esc } = construir();
  await esc.abrir("caida:zeus-bot:2026-09-12T13:00:00.000Z", "Caída sin resolver");
  const r = await esc.abrir("sos:sos-1", "SOS detenido");

  assert.strictEqual(r.ya_abierta, false);
  const est = esc.estado();
  assert.strictEqual(est.pendientes.length, 1);
  assert.strictEqual(est.pendientes[0].tipo, "sos");
  assert.strictEqual(est.historial[0].cierre, "absorbida");
});

test("mientras hay un SOS activo, una caída del bot no abre una segunda escalada", async () => {
  const { esc, almacen, reloj } = construir();
  await esc.abrir("sos:sos-1", "SOS detenido");

  almacen.guardarJson(RUTA_INCIDENTES, {
    abierto: { servicio: "zeus-bot", inicio: "2026-09-12T13:40:00.000Z" },
    historial: [],
  });
  await esc.quizaEscalar();

  const est = esc.estado();
  assert.strictEqual(est.pendientes.length, 1);
  assert.strictEqual(est.pendientes[0].tipo, "sos");
});

test("detección por marca de agua: al instalar el módulo no escala corridas de SOS anteriores", async () => {
  const { esc, jsonl, wsp } = construir();
  jsonl.agregar(RUTA_CORRIDAS, {
    run_id: "sos-viejo", fin: "2026-09-12T10:00:00.000Z",
    resultado: "detenido_pide_ayuda", afecta_clientes: "si",
  });

  await esc.quizaEscalar(); // primer tick: fija la marca de agua, no abre nada
  assert.strictEqual(esc.estado().pendientes.length, 0);
  assert.strictEqual(wsp.enviados.length, 0);

  jsonl.agregar(RUTA_CORRIDAS, {
    run_id: "sos-nuevo", fin: "2026-09-12T14:00:00.000Z",
    resultado: "detenido_pide_ayuda", afecta_clientes: "si",
  });
  await esc.quizaEscalar();

  const est = esc.estado();
  assert.strictEqual(est.pendientes.length, 1);
  assert.strictEqual(est.pendientes[0].clave, "sos:sos-nuevo");
});

test("una corrida de SOS restablecida o sin_falla no abre escalada", async () => {
  const { esc, jsonl, wsp } = construir();
  jsonl.agregar(RUTA_CORRIDAS, { run_id: "s1", fin: "2026-09-12T10:00:00.000Z", resultado: "restablecido", afecta_clientes: "si" });
  await esc.quizaEscalar(); // fija la marca en la única corrida existente

  jsonl.agregar(RUTA_CORRIDAS, { run_id: "s2", fin: "2026-09-12T14:00:00.000Z", resultado: "restablecido", afecta_clientes: "si" });
  await esc.quizaEscalar();

  assert.strictEqual(esc.estado().pendientes.length, 0);
  assert.strictEqual(wsp.enviados.length, 0);
});
