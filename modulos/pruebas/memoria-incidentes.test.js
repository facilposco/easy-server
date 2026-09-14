"use strict";
/**
 * modulos/pruebas/memoria-incidentes.test.js
 *
 * Las 12 pruebas exactas de DISENO-AUDITORIA360-PROACTIVA.md §3.8. Todo con
 * dependencias falsas (en memoria): nunca toca un servidor real ni
 * `centinela-db/` de verdad.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const {
  crearMemoriaIncidentes, entradaDesdeCorrida, agregar, elegirRunbook,
} = require("../memoria-incidentes.js");
const textos = require("../sos/textos.js");
const { crearRunbooks } = require("../runbooks.js");

// ── Fábricas de fakes ────────────────────────────────────────────────────

function crearAlmacenFalso() {
  const datos = new Map();
  return {
    leerJson(ruta, porDefecto) { return datos.has(ruta) ? datos.get(ruta) : porDefecto; },
    guardarJson(ruta, obj) { datos.set(ruta, JSON.parse(JSON.stringify(obj))); },
    datos,
  };
}

function crearDepsFalsas(overrides) {
  const almacen = crearAlmacenFalso();
  const enviados = [];
  const auditorias = [];
  let corridasCrudas = [];
  let ahoraMs = Date.parse("2026-09-13T12:00:00.000Z");
  const runbooksReales = crearRunbooks({});

  const deps = {
    DIR_DATOS: path.join("fake", "zeus-ops"),
    leerJson: almacen.leerJson,
    guardarJson: almacen.guardarJson,
    leerJsonl: () => corridasCrudas,
    auditar: (...args) => auditorias.push(args),
    runbooks: runbooksReales,
    textos,
    enviarWhatsapp: async (texto) => { enviados.push(texto); return { ok: true }; },
    permisos: { permitido: () => true },
    kapsoYModo: { obtenerModo: () => ({ activo: false }), debeSilenciar: () => false },
    F_MODO: path.join("fake", "modo-viaje.json"),
    ahora: () => ahoraMs,
  };
  Object.assign(deps, overrides);

  return {
    deps,
    almacen,
    enviados,
    auditorias,
    setCorridas(lista) { corridasCrudas = lista; },
    setAhora(ms) { ahoraMs = ms; },
  };
}

function corrida(datos) {
  return Object.assign({
    run_id: "sos-1-aaaa",
    incidente_sos_id: null,
    origen: "agente",
    inicio: "2026-09-13T11:00:00.000Z",
    fin: "2026-09-13T11:07:00.000Z",
    duracion_s: 420,
    sintoma_principal: "bot_no_responde",
    sintomas_secundarios: [],
    diagnostico: "El bot de WhatsApp está encendido pero no atiende (el bot de WhatsApp).",
    afecta_clientes: "si",
    desde: "2026-09-13T11:00:00.000Z",
    evidencia_id: "ev-1",
    acciones: [
      { peldano: "reiniciar_contenedor", objetivo: "zeus-bot", comando: "docker restart -t 20 zeus-bot", inicio: "", fin: "", ok: true, salida: "", verificacion: { ok: true, segundos: 3 } },
    ],
    resultado: "restablecido",
    limites_tocados: [],
    ia: { usada: false, motivo: "no aplicable" },
    version: 1,
  }, datos);
}

// ── 1. entradaDesdeCorrida: minutos con desde / con inicio ───────────────

test("1. entradaDesdeCorrida calcula minutos con desde, y con inicio si falta desde", () => {
  const c1 = corrida({ desde: "2026-09-13T11:00:00.000Z", fin: "2026-09-13T11:07:00.000Z" });
  const e1 = entradaDesdeCorrida(c1, []);
  assert.equal(e1.minutos_hasta_restablecer, 7);

  const c2 = corrida({ desde: undefined, inicio: "2026-09-13T11:00:00.000Z", fin: "2026-09-13T11:05:00.000Z" });
  const e2 = entradaDesdeCorrida(c2, []);
  assert.equal(e2.minutos_hasta_restablecer, 5);
});

// ── 2. reincidencia a 3 días / 9 días ─────────────────────────────────────

test("2. reincidencia es true a 3 días, false a 9 días", () => {
  const previa3 = entradaDesdeCorrida(corrida({ run_id: "sos-0a", fin: "2026-09-10T11:00:00.000Z" }), []);
  const actual3 = entradaDesdeCorrida(corrida({ run_id: "sos-1a", fin: "2026-09-13T11:00:00.000Z" }), [previa3]);
  assert.equal(actual3.reincidencia, true);

  const previa9 = entradaDesdeCorrida(corrida({ run_id: "sos-0b", fin: "2026-09-04T11:00:00.000Z" }), []);
  const actual9 = entradaDesdeCorrida(corrida({ run_id: "sos-1b", fin: "2026-09-13T11:00:00.000Z" }), [previa9]);
  assert.equal(actual9.reincidencia, false);
});

// ── 3. agregar: ejecutada / restablecido solo en la última acción ────────

test("3. agregar cuenta ejecutada por cada acción y restablecido solo para la última de una corrida restablecida", () => {
  const entradas = [
    entradaDesdeCorrida(corrida({
      run_id: "s1", resultado: "restablecido", sintoma_principal: "disco_lleno",
      acciones: [
        { peldano: "liberar_disco", objetivo: "", ok: true },
        { peldano: "reiniciar_contenedor", objetivo: "zeus-bot", ok: true },
      ],
    }), []),
    entradaDesdeCorrida(corrida({
      run_id: "s2", resultado: "parcial", sintoma_principal: "disco_lleno",
      acciones: [{ peldano: "liberar_disco", objetivo: "", ok: true }],
    }), []),
  ];
  const ag = agregar(entradas);
  assert.deepEqual(ag["disco_lleno|liberar_disco"], { ejecutada: 2, restablecido: 0 });
  assert.deepEqual(ag["disco_lleno|reiniciar_contenedor:zeus-bot"], { ejecutada: 1, restablecido: 1 });
});

// ── 4. sincronizar es idempotente ─────────────────────────────────────────

test("4. sincronizar es idempotente (segunda llamada nuevas:0)", async () => {
  const f = crearDepsFalsas();
  const mem = crearMemoriaIncidentes(f.deps);
  f.setCorridas([corrida({ run_id: "s1", resultado: "restablecido" })]);

  const r1 = await mem.sincronizar();
  assert.equal(r1.nuevas, 1);
  assert.equal(r1.total, 1);

  const r2 = await mem.sincronizar();
  assert.equal(r2.nuevas, 0);
  assert.equal(r2.total, 1);
});

// ── 5. actualizacion:true reemplaza la entrada del mismo run_id ──────────

test("5. actualizacion:true reemplaza la entrada del mismo run_id", async () => {
  const f = crearDepsFalsas();
  const mem = crearMemoriaIncidentes(f.deps);

  f.setCorridas([corrida({ run_id: "s1", resultado: "detenido_pide_ayuda", sintoma_principal: "cpu_saturada" })]);
  await mem.sincronizar();

  f.setCorridas([
    corrida({ run_id: "s1", resultado: "detenido_pide_ayuda", sintoma_principal: "cpu_saturada" }),
    corrida({ run_id: "s1", resultado: "restablecido", sintoma_principal: "cpu_saturada", actualizacion: true }),
  ]);
  await mem.sincronizar();

  const estado = mem.estado();
  assert.equal(estado.total, 1);
  assert.equal(estado.ultima.resultado, "restablecido");
});

// ── 6. recorte a 100 entradas conserva las más recientes ─────────────────

test("6. el recorte a 100 entradas conserva las más recientes", async () => {
  const f = crearDepsFalsas();
  const mem = crearMemoriaIncidentes(f.deps);
  const lista = [];
  for (let i = 1; i <= 120; i++) {
    lista.push(corrida({
      run_id: `s${i}`,
      resultado: "restablecido",
      fin: new Date(Date.parse("2026-01-01T00:00:00.000Z") + i * 60000).toISOString(),
      desde: new Date(Date.parse("2026-01-01T00:00:00.000Z") + i * 60000 - 60000).toISOString(),
    }));
  }
  f.setCorridas(lista);
  const r = await mem.sincronizar();
  assert.equal(r.total, 100);

  const estado = mem.estado();
  assert.equal(estado.total, 100);
  assert.equal(estado.ultima.run_id, "s120");
});

// ── 7. sin_falla / interrumpida_por_reinicio no generan entrada ──────────

test("7. sin_falla e interrumpida_por_reinicio no generan entrada", async () => {
  const f = crearDepsFalsas();
  const mem = crearMemoriaIncidentes(f.deps);
  f.setCorridas([
    corrida({ run_id: "s1", resultado: "sin_falla" }),
    corrida({ run_id: "s2", resultado: "interrumpida_por_reinicio" }),
  ]);
  const r = await mem.sincronizar();
  assert.equal(r.nuevas, 0);
  assert.equal(r.total, 0);
  assert.equal(entradaDesdeCorrida(corrida({ resultado: "sin_falla" }), []), null);
  assert.equal(entradaDesdeCorrida(corrida({ resultado: "interrumpida_por_reinicio" }), []), null);
});

// ── 8. elegirRunbook mapea los 7 síntomas y null para cpu_saturada ────────

test("8. elegirRunbook mapea los 7 síntomas y devuelve null para cpu_saturada", () => {
  assert.equal(elegirRunbook("bot_caido", null), "bot_no_responde");
  assert.equal(elegirRunbook("bot_no_responde", null), "bot_no_responde");
  assert.equal(elegirRunbook("busqueda_caida", null), "memoria_busqueda_caida");
  assert.equal(elegirRunbook("bd_caida", null), "base_datos_no_responde");
  assert.equal(elegirRunbook("puerta_caida", null), "puerta_entrada_caida");
  assert.equal(elegirRunbook("disco_lleno", null), "servidor_lento_disco");
  assert.equal(elegirRunbook("servidor_lento", null), "servidor_lento_disco");
  // Caso especial documentado en §3.6: contenedor_en_bucle solo cuenta si el culpable es zeus-bot.
  assert.equal(elegirRunbook("contenedor_en_bucle", "zeus-bot"), "bot_no_responde");
  assert.equal(elegirRunbook("contenedor_en_bucle", "zeus-mariadb"), null);
  assert.equal(elegirRunbook("cpu_saturada", null), null);
});

// ── 9. detenido_pide_ayuda + runbook → un solo WhatsApp, no se reenvía ───

test("9. con detenido_pide_ayuda y runbook mapeado envía un WhatsApp con el título y \"No la ejecuto sola\"; la segunda sincronización no reenvía", async () => {
  const f = crearDepsFalsas();
  const mem = crearMemoriaIncidentes(f.deps);
  f.setCorridas([corrida({
    run_id: "s1", resultado: "detenido_pide_ayuda", sintoma_principal: "bot_no_responde",
    motivo_detencion: "El bot sigue sin responder tras reiniciarlo.",
  })]);

  await mem.sincronizar();
  assert.equal(f.enviados.length, 1);
  assert.match(f.enviados[0], /El bot de WhatsApp no responde o está lento/);
  assert.match(f.enviados[0], /No la ejecuto sola\./);
  assert.match(f.enviados[0], /el bot de WhatsApp está encendido pero no atiende\./);

  await mem.sincronizar();
  assert.equal(f.enviados.length, 1); // no se reenvía
});

// ── 10. frenos whatsapp / modo viaje: no envía, sí guarda sugerencia ──────

test("10. con el permiso de WhatsApp apagado o en modo viaje no se envía, pero la sugerencia se guarda igual", async () => {
  const fSinPermiso = crearDepsFalsas({ permisos: { permitido: () => false } });
  const memSinPermiso = crearMemoriaIncidentes(fSinPermiso.deps);
  fSinPermiso.setCorridas([corrida({ run_id: "s1", resultado: "detenido_pide_ayuda", sintoma_principal: "bot_no_responde" })]);
  await memSinPermiso.sincronizar();
  assert.equal(fSinPermiso.enviados.length, 0);
  const estadoSinPermiso = memSinPermiso.estado();
  assert.ok(estadoSinPermiso.sugerencia_actual);
  assert.equal(estadoSinPermiso.sugerencia_actual.runbook_id, "bot_no_responde");

  const fModoViaje = crearDepsFalsas({
    kapsoYModo: { obtenerModo: () => ({ activo: true }), debeSilenciar: () => true },
  });
  const memModoViaje = crearMemoriaIncidentes(fModoViaje.deps);
  fModoViaje.setCorridas([corrida({ run_id: "s2", resultado: "parcial", sintoma_principal: "bd_caida" })]);
  await memModoViaje.sincronizar();
  assert.equal(fModoViaje.enviados.length, 0);
  const estadoModoViaje = memModoViaje.estado();
  assert.ok(estadoModoViaje.sugerencia_actual);
  assert.equal(estadoModoViaje.sugerencia_actual.runbook_id, "base_datos_no_responde");
});

// ── 11. resumenParaContexto() < 2000 bytes con 100 entradas ───────────────

test("11. resumenParaContexto() pesa menos de 2000 bytes con 100 entradas", async () => {
  const f = crearDepsFalsas();
  const mem = crearMemoriaIncidentes(f.deps);
  const sintomas = ["bot_no_responde", "disco_lleno", "bd_caida", "puerta_caida", "busqueda_caida"];
  const lista = [];
  for (let i = 1; i <= 100; i++) {
    lista.push(corrida({
      run_id: `s${i}`,
      resultado: i % 3 === 0 ? "parcial" : "restablecido",
      sintoma_principal: sintomas[i % sintomas.length],
      fin: new Date(Date.parse("2026-08-01T00:00:00.000Z") + i * 3600000).toISOString(),
      desde: new Date(Date.parse("2026-08-01T00:00:00.000Z") + i * 3600000 - 300000).toISOString(),
      acciones: [{ peldano: "reiniciar_contenedor", objetivo: "zeus-bot", ok: true }],
    }));
  }
  f.setCorridas(lista);
  await mem.sincronizar();

  const resumen = mem.resumenParaContexto();
  const bytes = Buffer.byteLength(JSON.stringify(resumen), "utf8");
  assert.ok(bytes < 2000, `resumenParaContexto pesa ${bytes} bytes`);
});

// ── 12. sugerenciaActual() devuelve null pasadas 24 h ─────────────────────

test("12. sugerenciaActual() devuelve null pasadas 24 horas", async () => {
  const f = crearDepsFalsas();
  const mem = crearMemoriaIncidentes(f.deps);
  f.setCorridas([corrida({ run_id: "s1", resultado: "detenido_pide_ayuda", sintoma_principal: "puerta_caida" })]);
  await mem.sincronizar();

  assert.ok(mem.sugerenciaActual());
  f.setAhora(Date.parse("2026-09-13T12:00:00.000Z") + 25 * 60 * 60 * 1000);
  assert.equal(mem.sugerenciaActual(), null);
});
