"use strict";
/**
 * modulos/pruebas/auditoria360.test.js
 *
 * Pruebas de modulos/auditoria360.js (node:test + node:assert), con
 * dependencias falsas inyectadas — nunca toca un servidor real. Cubre las
 * 14 pruebas de DISENO-AUDITORIA360-PROACTIVA.md §1.13.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  crearAuditoria360, TAREA_LATIDO, consolidar, calcularNotas, clasificarCubeta, comparar, textoWhatsapp,
} = require("../auditoria360.js");

// ── Helpers de E/S reales sobre un directorio temporal (mismo contrato que
//    leerJson/guardarJson/leerJsonl/anexar de ops-server.js) ────────────────

function leerJson(archivo, porDefecto) {
  try { return JSON.parse(fs.readFileSync(archivo, "utf8")); } catch (_) { return porDefecto; }
}
function guardarJson(archivo, obj) {
  fs.mkdirSync(path.dirname(archivo), { recursive: true });
  fs.writeFileSync(archivo, JSON.stringify(obj));
}
function leerJsonl(archivo, max) {
  try {
    const lineas = fs.readFileSync(archivo, "utf8").trim().split("\n").filter(Boolean);
    return lineas.slice(-(max || 5000)).map((l) => JSON.parse(l));
  } catch (_) { return []; }
}
function anexar(archivo, obj) {
  fs.mkdirSync(path.dirname(archivo), { recursive: true });
  fs.appendFileSync(archivo, JSON.stringify(obj) + "\n");
}

function dirTemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "a360-test-"));
}

// ── Fábrica de dependencias falsas (todas "sanas" por defecto) ──────────────

function crearDeps(dirDatos, overrides) {
  const calls = {
    ejecutarAccion: [], limitesRegistrar: [], limitesPuede: [], auditar: [],
    latidosRegistrar: [], enviarWhatsapp: [],
  };

  const base = {
    sh: async () => ({ ok: true, salida: "" }),
    auditar: (accion, quien, resultado, detalle) => { calls.auditar.push({ accion, quien, resultado, detalle }); },
    enviarWhatsapp: async (texto) => { calls.enviarWhatsapp.push(texto); return { ok: true, via: "test" }; },
    DIR_DATOS: dirDatos,
    leerJson, guardarJson, leerJsonl, anexar,

    estadoGeneral: () => ({
      avisos: [],
      contenedores: [
        { nombre: "zeus-bot", estado: "running", salud: "healthy", reinicios: 0 },
        { nombre: "zeus-mariadb", estado: "running", salud: "healthy", reinicios: 0 },
        { nombre: "zeus-chromadb", estado: "running", salud: "healthy", reinicios: 0 },
        { nombre: "zeus-proxy", estado: "running", salud: "healthy", reinicios: 0 },
      ],
      ram: { pct: 40 }, disco: { pct: 50 },
    }),
    prediccion: () => ({ pronosticos: [] }),
    estadoRespaldos: () => ({ ultimo: { horas: 5 }, drive: { conectado: true } }),
    leerDisco: () => ({ pct: 50 }),
    ejecutarAccion: async (accion, objetivo) => {
      calls.ejecutarAccion.push({ accion, objetivo });
      return { ok: true, mensaje: "Liberados 1000 MB", liberado_mb: 1000, antes: 83, despues: 70 };
    },

    seguridadCompleta: {
      estado: () => ({ en_curso: false }),
      ejecutar: async () => ({ ok: true, resumen: { hallazgos: [] } }),
    },
    optimizacionCompleta: {
      estado: () => ({ en_curso: false }),
      ejecutar: async () => ({ ok: true, run_id: "bd-1" }),
      esperar: async () => ({ hallazgos: [] }),
    },
    configDrift: {
      revisarDrift: async () => ({ id: "config_drift", titulo: "Configuración", severidad: "ok", significado: "Sin cambios", detalle: "" }),
    },
    latidos: {
      estadoLatidos: () => ({ tareas: [] }),
      registrar: (id, resultado, quien) => { calls.latidosRegistrar.push({ id, resultado, quien }); },
    },
    sos: {
      estado: () => ({ en_curso: null }),
      limites: {
        puede: (accion, ctx) => { calls.limitesPuede.push({ accion, ctx }); return { ok: true }; },
        registrar: (accion, ctx) => { calls.limitesRegistrar.push({ accion, ctx }); },
      },
    },
    seguridadAuditoria: {
      auditoriaCompleta: async () => ({ hallazgos: [], severidad_general: "ok", ts: new Date().toISOString() }),
    },

    reglasSeguridad: { frenoActivo: () => false, enHorarioComercial: () => false },
    permisos: { permitido: () => true, verificarEscritura: () => ({ ok: true }) },
    simulacros: { estado: () => ({ en_curso: null }) },
    observacionDespliegue: { estado: () => ({ en_curso: null }) },
    kapsoYModo: { obtenerModo: () => ({ activo: false }), debeSilenciar: () => false },
    F_MODO: path.join(dirDatos, "modo.json"),
    ahora: () => Date.now(),
  };

  const deps = { ...base, ...(overrides || {}) };
  return { deps, calls };
}

// ── 1. consolidar mapea los 7 orígenes a las 7 áreas ────────────────────────

test("consolidar mapea los orígenes a las 7 áreas con las claves exactas", () => {
  const fuentes = {
    seguridad_completa: { ok: true, hallazgos: [{ id: "ssh", titulo: "SSH", severidad: "ok", significado: "bien", detalle: "" }] },
    seguridad_auditoria: { ok: true, hallazgos: [{ id: "certificado_ssl", titulo: "Cert", severidad: "ok", significado: "bien", detalle: "" }] },
    config_drift: { ok: true, hallazgo: { id: "config_drift", titulo: "Config", severidad: "ok", significado: "sin cambios", detalle: "" } },
    optimizacion_completa: { ok: true, hallazgos: [{ id: "conexiones", titulo: "Conexiones", severidad: "ok", significado: "bien", detalle: "" }] },
    estado_general: {
      ok: true,
      valor: {
        avisos: [{ texto: "El disco está casi lleno", nivel: "warn", detalle: "" }],
        contenedores: [{ nombre: "zeus-mariadb", estado: "exited", salud: "unhealthy", reinicios: 1 }],
        ram: { pct: 40 }, disco: { pct: 83 },
      },
    },
    prediccion: { ok: true, valor: { pronosticos: [{ recurso: "Disco", texto: "Llega al 90% en 5 días", nivel: "warn", dias: 5, cortado: false }] } },
    estado_respaldos: { ok: true, valor: { ultimo: { horas: 40 }, drive: { conectado: true } } },
    latidos: { ok: true, valor: { tareas: [{ id: "respaldo_bd", nombre: "Respaldo de la base de datos", estado: "falta", nivel: "crit", mensaje: "No corrió" }] } },
  };

  const { hallazgos, fuentes_fallidas } = consolidar(fuentes);
  assert.deepEqual(fuentes_fallidas, []);

  const areas = new Set(hallazgos.map((h) => h.area));
  assert.deepEqual([...areas].sort(), ["base_datos", "capacidad", "configuracion", "respaldos", "seguridad", "servicios", "tareas"]);

  const claves = hallazgos.map((h) => h.clave);
  assert.ok(claves.includes("seguridad:ssh"));
  assert.ok(claves.includes("seguridad:certificado_ssl"));
  assert.ok(claves.includes("configuracion:config_drift"));
  assert.ok(claves.includes("base_datos:conexiones"));
  assert.ok(claves.includes("capacidad:disco"));
  assert.ok(claves.includes("capacidad:ram"));
  assert.ok(claves.includes("capacidad:prediccion_disco"));
  assert.ok(claves.includes("servicios:caido_zeus-mariadb"));
  assert.ok(claves.includes("respaldos:copia_vieja"));
  assert.ok(claves.includes("tareas:latido_respaldo_bd"));
});

// ── 2 y 3. calcularNotas: piso, fuente fallida, nota_global mínimo ──────────

test("calcularNotas: 2 urgentes -> 4; 1 urgente+1 atención -> 6; 4 urgentes -> 0 (piso); fuente fallida -> null sin bajar la global", () => {
  const hallazgos = [
    { area: "seguridad", severidad: "urgente" }, { area: "seguridad", severidad: "urgente" },
    { area: "configuracion", severidad: "urgente" }, { area: "configuracion", severidad: "atencion" },
    { area: "base_datos", severidad: "urgente" }, { area: "base_datos", severidad: "urgente" },
    { area: "base_datos", severidad: "urgente" }, { area: "base_datos", severidad: "urgente" },
    { area: "respaldos", severidad: "urgente" }, // este hallazgo existe pero el área está marcada como fallida
  ];
  const { areas, nota_global } = calcularNotas(hallazgos, ["respaldos"]);

  assert.equal(areas.seguridad.nota, 4);
  assert.equal(areas.configuracion.nota, 6);
  assert.equal(areas.base_datos.nota, 0);
  assert.equal(areas.respaldos.nota, null);
  assert.equal(areas.capacidad.nota, 10);
  assert.equal(areas.servicios.nota, 10);
  assert.equal(areas.tareas.nota, 10);
  // el mínimo es 0 (base_datos), la null de respaldos no participa
  assert.equal(nota_global, 0);
});

test("calcularNotas: si todas las áreas fallan, nota_global es null", () => {
  const { nota_global, etiqueta } = calcularNotas([], [
    "seguridad", "configuracion", "base_datos", "capacidad", "servicios", "respaldos", "tareas",
  ]);
  assert.equal(nota_global, null);
  assert.equal(etiqueta, "Sin datos suficientes");
});

// ── 4. clasificarCubeta ──────────────────────────────────────────────────

test("clasificarCubeta: disco 83% -> aplicar; actualizaciones -> proponer; mariadb caída -> proponer con confirmar; certificado -> reportar", () => {
  const disco = { clave: "capacidad:disco", area: "capacidad", id: "disco", severidad: "atencion" };
  assert.equal(clasificarCubeta(disco).cubeta, "aplicar");

  const actualizaciones = { clave: "seguridad:actualizaciones", area: "seguridad", id: "actualizaciones", severidad: "atencion" };
  const rActualizaciones = clasificarCubeta(actualizaciones);
  assert.equal(rActualizaciones.cubeta, "proponer");
  assert.equal(rActualizaciones.propuesta.accion, "actualizar_seguridad");

  const mariadbCaida = { clave: "servicios:caido_zeus-mariadb", area: "servicios", id: "caido_zeus-mariadb", severidad: "urgente" };
  const rMariadb = clasificarCubeta(mariadbCaida);
  assert.equal(rMariadb.cubeta, "proponer");
  assert.equal(rMariadb.propuesta.confirmar, "REINICIAR");
  assert.equal(rMariadb.propuesta.objetivo, "zeus-mariadb");

  const certificado = { clave: "seguridad:certificado_ssl", area: "seguridad", id: "certificado_ssl", severidad: "atencion" };
  assert.equal(clasificarCubeta(certificado).cubeta, "reportar");
});

// ── 5 y 6. Aplicar solo (única acción autónoma) ─────────────────────────────

test("aplicar solo: llama ejecutarAccion('optimizar') una vez y luego sos.limites.registrar('liberar_disco') cuando puedeActuar da ok", async () => {
  const dirDatos = dirTemp();
  const { deps, calls } = crearDeps(dirDatos, {
    estadoGeneral: () => ({
      avisos: [{ texto: "El disco está casi lleno (83%)", nivel: "warn", detalle: "" }],
      contenedores: [], ram: { pct: 40 }, disco: { pct: 83 },
    }),
  });
  const instancia = crearAuditoria360(deps);
  const r = await instancia.ejecutar("panel");
  assert.equal(r.ok, true);
  const corrida = await instancia.esperar();

  assert.equal(calls.ejecutarAccion.length, 1);
  assert.equal(calls.ejecutarAccion[0].accion, "optimizar");
  assert.equal(calls.limitesRegistrar.length, 1);
  assert.equal(calls.limitesRegistrar[0].accion, "liberar_disco");

  const discoH = corrida.hallazgos.find((h) => h.clave === "capacidad:disco");
  assert.equal(discoH.severidad, "ok"); // el disco bajó de 83% a 70% (leerDisco falso da 50%)
  assert.equal(corrida.aplicado.length, 1);
  assert.equal(corrida.aplicado[0].ok, true);
});

test("aplicar solo: si puedeActuar da {ok:false, fuente:'freno'}, no se llama ejecutarAccion y el hallazgo va a proponer + bloqueado", async () => {
  const dirDatos = dirTemp();
  const { deps, calls } = crearDeps(dirDatos, {
    estadoGeneral: () => ({
      avisos: [{ texto: "El disco está casi lleno (83%)", nivel: "warn", detalle: "" }],
      contenedores: [], ram: { pct: 40 }, disco: { pct: 83 },
    }),
    reglasSeguridad: { frenoActivo: () => true, enHorarioComercial: () => false },
  });
  const instancia = crearAuditoria360(deps);
  await instancia.ejecutar("panel");
  const corrida = await instancia.esperar();

  assert.equal(calls.ejecutarAccion.length, 0);
  const discoH = corrida.hallazgos.find((h) => h.clave === "capacidad:disco");
  assert.equal(discoH.cubeta, "proponer");
  assert.equal(corrida.bloqueado.length, 1);
  assert.equal(corrida.bloqueado[0].fuente, "freno");
});

// ── 7. Rechazo 409 ──────────────────────────────────────────────────────────

test("rechazo 409 si hay un SOS/simulacro/seguridad completa/optimización completa/corrida propia en curso", async () => {
  {
    const dirDatos = dirTemp();
    const { deps } = crearDeps(dirDatos, { sos: { estado: () => ({ en_curso: { run_id: "sos-1" } }), limites: crearDeps(dirDatos).deps.sos.limites } });
    const instancia = crearAuditoria360(deps);
    const r = await instancia.ejecutar("panel");
    assert.equal(r.ok, false);
    assert.equal(r.code, 409);
  }
  {
    const dirDatos = dirTemp();
    const { deps } = crearDeps(dirDatos, { simulacros: { estado: () => ({ en_curso: { run_id: "sim-1" } }) } });
    const instancia = crearAuditoria360(deps);
    const r = await instancia.ejecutar("panel");
    assert.equal(r.ok, false);
    assert.equal(r.code, 409);
  }
  {
    const dirDatos = dirTemp();
    const { deps } = crearDeps(dirDatos, { seguridadCompleta: { estado: () => ({ en_curso: true }), ejecutar: async () => ({ ok: true, resumen: { hallazgos: [] } }) } });
    const instancia = crearAuditoria360(deps);
    const r = await instancia.ejecutar("panel");
    assert.equal(r.ok, false);
    assert.equal(r.code, 409);
  }
  {
    const dirDatos = dirTemp();
    const { deps } = crearDeps(dirDatos, { optimizacionCompleta: { estado: () => ({ en_curso: true }), ejecutar: async () => ({ ok: true }), esperar: async () => ({ hallazgos: [] }) } });
    const instancia = crearAuditoria360(deps);
    const r = await instancia.ejecutar("panel");
    assert.equal(r.ok, false);
    assert.equal(r.code, 409);
  }
  {
    // corrida propia en curso: seguridadCompleta.ejecutar tarda un poco, así
    // que cuando se llama ejecutar() por segunda vez la primera sigue viva.
    const dirDatos = dirTemp();
    const { deps } = crearDeps(dirDatos, {
      seguridadCompleta: {
        estado: () => ({ en_curso: false }),
        ejecutar: () => new Promise((res) => setTimeout(() => res({ ok: true, resumen: { hallazgos: [] } }), 30)),
      },
    });
    const instancia = crearAuditoria360(deps);
    const r1 = await instancia.ejecutar("panel");
    assert.equal(r1.ok, true);
    const r2 = await instancia.ejecutar("panel");
    assert.equal(r2.ok, false);
    assert.equal(r2.code, 409);
    await instancia.esperar();
  }
});

// ── 8. Ola B: seguridadCompleta 409 -> fuente fallida y la corrida termina ──

test("Ola B: seguridadCompleta.ejecutar devuelve 409 -> fuentes_fallidas incluye seguridad_completa y la corrida termina", async () => {
  const dirDatos = dirTemp();
  const { deps } = crearDeps(dirDatos, {
    seguridadCompleta: { estado: () => ({ en_curso: false }), ejecutar: async () => ({ ok: false, code: 409, mensaje: "Ya hay una auditoría en curso" }) },
  });
  const instancia = crearAuditoria360(deps);
  await instancia.ejecutar("panel");
  const corrida = await instancia.esperar();

  assert.ok(corrida, "la corrida debe terminar y devolver un resultado");
  assert.ok(corrida.fuentes_fallidas.includes("seguridad_completa"));
  assert.equal(corrida.parcial, true);
  assert.equal(corrida.areas.seguridad.nota, null);
});

// ── 9. optimizacionCompleta.esperar() -> null: base_datos null, parcial true

test("optimizacionCompleta.esperar() -> null: área base_datos queda null y la corrida es parcial", async () => {
  const dirDatos = dirTemp();
  const { deps } = crearDeps(dirDatos, {
    optimizacionCompleta: { estado: () => ({ en_curso: false }), ejecutar: async () => ({ ok: true, run_id: "bd-1" }), esperar: async () => null },
  });
  const instancia = crearAuditoria360(deps);
  await instancia.ejecutar("panel");
  const corrida = await instancia.esperar();

  assert.equal(corrida.areas.base_datos.nota, null);
  assert.equal(corrida.parcial, true);
  assert.ok(corrida.fuentes_fallidas.includes("optimizacion_completa"));
});

// ── 10. comparar: nuevos/resueltos/empeoraron y delta ──────────────────────

test("comparar detecta nuevos, resueltos, empeoraron y delta", () => {
  const anterior = {
    id: "a360-1", ts: "2026-09-12T11:00:00.000Z", nota_global: 9,
    hallazgos: [
      { clave: "respaldos:copia_vieja", severidad: "ok" },
      { clave: "base_datos:fragmentacion", severidad: "atencion" },
      { clave: "seguridad:actualizaciones", severidad: "atencion" },
    ],
  };
  const actual = {
    id: "a360-2", ts: "2026-09-13T11:00:00.000Z", nota_global: 6,
    hallazgos: [
      { clave: "respaldos:copia_vieja", severidad: "urgente" }, // nuevo
      { clave: "base_datos:fragmentacion", severidad: "urgente" }, // empeoró
      { clave: "seguridad:actualizaciones", severidad: "ok" }, // resuelto
    ],
  };
  const cmp = comparar(actual, anterior);
  assert.equal(cmp.anterior_id, "a360-1");
  assert.equal(cmp.nota_anterior, 9);
  assert.equal(cmp.delta, -3);
  assert.deepEqual(cmp.nuevos, ["respaldos:copia_vieja"]);
  assert.deepEqual(cmp.resueltos, ["seguridad:actualizaciones"]);
  assert.deepEqual(cmp.empeoraron, ["base_datos:fragmentacion"]);
  assert.equal(comparar(actual, null), null);
});

// ── 11. WhatsApp: se envía / no se envía según las reglas de §1.8 ──────────

test("WhatsApp: se envía si bajó la nota", async () => {
  const dirDatos = dirTemp();
  // Ojo: no se usa "capacidad:disco" para bajar la nota aquí, porque esa es
  // justo la única cubeta "aplicar" — con los permisos falsos por defecto,
  // el disco se arreglaría solo y volvería a "ok" antes de calcular la nota.
  // Se usa una atención de seguridad (que no se autoaplica) para el escenario.
  const { deps, calls } = crearDeps(dirDatos, {
    seguridadCompleta: {
      estado: () => ({ en_curso: false }),
      ejecutar: async () => ({ ok: true, resumen: { hallazgos: [{ id: "actualizaciones", titulo: "Actualizaciones del sistema", severidad: "atencion", significado: "Hay 3 actualizaciones esperando", detalle: "" }] } }),
    },
  });
  guardarJson(path.join(dirDatos, "auditoria360", "ultima.json"), {
    id: "a360-old", ts: "2026-09-12T11:00:00.000Z", nota_global: 10,
    hallazgos: [
      { clave: "capacidad:disco", area: "capacidad", id: "disco", severidad: "ok" },
      { clave: "capacidad:ram", area: "capacidad", id: "ram", severidad: "ok" },
      { clave: "seguridad:actualizaciones", area: "seguridad", id: "actualizaciones", severidad: "ok" },
    ],
  });
  const instancia = crearAuditoria360(deps);
  await instancia.ejecutar("panel");
  const corrida = await instancia.esperar();

  assert.equal(corrida.nota_global, 9);
  assert.equal(calls.enviarWhatsapp.length, 1);
  assert.equal(corrida.whatsapp.enviado, true);
  assert.equal(corrida.whatsapp.motivo, "nota_bajo");
});

test("WhatsApp: se envía si hay un urgente nuevo (primera corrida)", async () => {
  const dirDatos = dirTemp();
  const { deps, calls } = crearDeps(dirDatos, {
    estadoGeneral: () => ({
      avisos: [],
      contenedores: [{ nombre: "zeus-bot", estado: "exited", salud: "unhealthy", reinicios: 0 }],
      ram: { pct: 40 }, disco: { pct: 50 },
    }),
  });
  const instancia = crearAuditoria360(deps);
  await instancia.ejecutar("panel");
  const corrida = await instancia.esperar();

  assert.equal(corrida.comparacion, null); // primera corrida
  assert.equal(calls.enviarWhatsapp.length, 1);
  assert.equal(corrida.whatsapp.enviado, true);
  assert.equal(corrida.whatsapp.motivo, "urgente_nuevo");
});

test("WhatsApp: no se envía si la nota es igual y no hay urgentes nuevos", async () => {
  const dirDatos = dirTemp();
  const { deps, calls } = crearDeps(dirDatos, {});
  guardarJson(path.join(dirDatos, "auditoria360", "ultima.json"), {
    id: "a360-old", ts: "2026-09-12T11:00:00.000Z", nota_global: 10,
    hallazgos: [{ clave: "capacidad:disco", area: "capacidad", id: "disco", severidad: "ok" }, { clave: "capacidad:ram", area: "capacidad", id: "ram", severidad: "ok" }],
  });
  const instancia = crearAuditoria360(deps);
  await instancia.ejecutar("panel");
  const corrida = await instancia.esperar();

  assert.equal(corrida.comparacion.delta, 0);
  assert.equal(calls.enviarWhatsapp.length, 0);
  assert.equal(corrida.whatsapp.enviado, false);
  assert.equal(corrida.whatsapp.motivo, "sin_disparador");
});

test("WhatsApp: no se envía sin permiso de whatsapp, aunque haya un disparador", async () => {
  const dirDatos = dirTemp();
  const { deps, calls } = crearDeps(dirDatos, {
    estadoGeneral: () => ({
      avisos: [], contenedores: [{ nombre: "zeus-bot", estado: "exited", salud: "unhealthy", reinicios: 0 }],
      ram: { pct: 40 }, disco: { pct: 50 },
    }),
    permisos: { permitido: (id, tipo) => !(id === "whatsapp" && tipo === "escritura"), verificarEscritura: () => ({ ok: true }) },
  });
  const instancia = crearAuditoria360(deps);
  await instancia.ejecutar("panel");
  const corrida = await instancia.esperar();

  assert.equal(calls.enviarWhatsapp.length, 0);
  assert.equal(corrida.whatsapp.enviado, false);
  assert.equal(corrida.whatsapp.motivo, "sin_permiso_whatsapp");
});

// ── 12. quizaCorridaDiaria: una sola vez al día, registra latido ───────────

test("quizaCorridaDiaria corre una sola vez al día a las 11:00 UTC y registra el latido auditoria_360", async () => {
  const dirDatos = dirTemp();
  const eleven = Date.UTC(2026, 8, 13, 11, 5, 0); // 13 sept 2026, 11:05 UTC
  const { deps, calls } = crearDeps(dirDatos, { ahora: () => eleven });
  const instancia = crearAuditoria360(deps);

  await instancia.quizaCorridaDiaria();
  await instancia.quizaCorridaDiaria();

  const corridasAuditadas = calls.auditar.filter((c) => c.accion === "auditoria360");
  assert.equal(corridasAuditadas.length, 1);
  const latidoLlamado = calls.latidosRegistrar.filter((c) => c.id === TAREA_LATIDO.id);
  assert.equal(latidoLlamado.length, 1);
  assert.equal(latidoLlamado[0].resultado.ok, true);
});

// ── 13. historial.jsonl se recorta a 60 líneas ─────────────────────────────

test("historial.jsonl se recorta a 60 líneas", async () => {
  const dirDatos = dirTemp();
  const { deps } = crearDeps(dirDatos, {});
  const instancia = crearAuditoria360(deps);

  for (let i = 0; i < 65; i++) {
    await instancia.ejecutar("panel");
    await instancia.esperar();
  }

  assert.equal(instancia.historial().length, 60);
});

// ── 14. textoWhatsapp no usa jerga técnica ─────────────────────────────────

test("textoWhatsapp no contiene palabras técnicas de la lista negra", () => {
  const corrida = {
    nota_global: 6,
    comparacion: { nota_anterior: 9, delta: -3, nuevos: ["respaldos:copia_vieja"], resueltos: [], empeoraron: [] },
    areas: { respaldos: { nota: 4, urgentes: 1, atencion: 0 }, base_datos: { nota: 7, urgentes: 0, atencion: 1 } },
    hallazgos: [
      { clave: "respaldos:copia_vieja", area: "respaldos", id: "copia_vieja", severidad: "urgente", significado: "La última copia de seguridad tiene 41 horas. Toca hacer una ahora.", cubeta: "proponer", propuesta: { etiqueta: "Hacer una copia ahora" } },
      { clave: "seguridad:actualizaciones", area: "seguridad", id: "actualizaciones", severidad: "atencion", significado: "Hay actualizaciones pendientes", cubeta: "proponer", propuesta: { etiqueta: "Aplicar actualizaciones de seguridad" } },
    ],
    aplicado: [{ accion: "optimizar", ok: true, mensaje: "Liberé 1.240 MB del disco (de 83% a 71%)." }],
  };
  const texto = textoWhatsapp(corrida);
  const prohibidas = ["docker", "systemctl", "apt", "sha256"];
  for (const palabra of prohibidas) {
    assert.ok(!texto.toLowerCase().includes(palabra), `no debería contener "${palabra}": ${texto}`);
  }
});
