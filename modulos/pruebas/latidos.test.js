"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { crearLatidos, calcularUltimaEsperada, evaluarTarea } = require("../latidos.js");

// ── Tabla de prueba: una tarea diaria y una semanal, igual de forma a TAREAS
// pero con ids propios para no depender del calendario real. ───────────────
const DIARIA = { id: "diaria_test", nombre_llano: "Tarea diaria de prueba", periodo: "diaria", hora_utc: 8, minuto_utc: 0, gracia_min: 45, nivel: "warn", origen: "cron" };
const SEMANAL = { id: "semanal_test", nombre_llano: "Tarea semanal de prueba", periodo: "semanal", dia_semana: 0, hora_utc: 10, minuto_utc: 0, gracia_min: 90, nivel: "warn", origen: "interno" };
const TAREAS_PRUEBA = [DIARIA, SEMANAL];

// ── Fakes ────────────────────────────────────────────────────────────────

function crearAlmacen() {
  const datos = {};
  return {
    leerJson(ruta, porDefecto) {
      if (!(ruta in datos)) return porDefecto;
      return JSON.parse(JSON.stringify(datos[ruta])); // simula lectura fresca de disco
    },
    guardarJson(ruta, obj) { datos[ruta] = JSON.parse(JSON.stringify(obj)); },
  };
}

function crearWhatsapp(comportamiento) {
  const enviados = [];
  return {
    enviados,
    async enviarWhatsapp(texto) {
      enviados.push(texto);
      if (comportamiento === "falla") return { ok: false, detalle: "Kapso no respondió" };
      return { ok: true, detalle: "enviado" };
    },
  };
}

/** Reloj inyectable: mismo criterio que sos/pruebas/puede-actuar.test.js
 * (la fábrica recibe `ahora` como función), pero mutable dentro de una
 * prueba para simular el paso del tiempo entre llamadas. */
function relojFalso(msInicial) {
  let actual = msInicial;
  return { ahora: () => actual, avanzar: (ms) => { actual = ms; } };
}

const permisosPermisivos = { permitido: () => true };

function construir(overrides = {}) {
  const almacen = crearAlmacen();
  const auditoria = [];
  const wsp = crearWhatsapp(overrides.whatsapp);
  const reloj = relojFalso(overrides.ahoraInicial != null ? overrides.ahoraInicial : Date.UTC(2026, 8, 13, 12, 0, 0));
  const deps = {
    DIR_DATOS: "/var/lib/zeus-ops-prueba",
    leerJson: almacen.leerJson,
    guardarJson: almacen.guardarJson,
    auditar: (accion, quien, resultado, detalle) => auditoria.push({ accion, quien, resultado, detalle }),
    enviarWhatsapp: wsp.enviarWhatsapp,
    permisos: overrides.permisos || permisosPermisivos,
    kapsoYModo: overrides.kapsoYModo,
    F_MODO: "/var/lib/zeus-ops-prueba/modo.json",
    ahora: reloj.ahora,
    tareas: overrides.tareas || TAREAS_PRUEBA,
  };
  const latidos = crearLatidos(deps);
  return { latidos, auditoria, enviados: wsp.enviados, reloj };
}

// ── Fórmula pura: calcularUltimaEsperada ────────────────────────────────────

test("calcularUltimaEsperada: diaria a las 00:05 UTC -> la de ayer 23:50", () => {
  const tarea = { periodo: "diaria", hora_utc: 23, minuto_utc: 50 };
  const ahoraMs = Date.UTC(2026, 8, 14, 0, 5, 0); // lunes 00:05 UTC
  const esperada = calcularUltimaEsperada(tarea, ahoraMs);
  assert.strictEqual(new Date(esperada).toISOString(), new Date(Date.UTC(2026, 8, 13, 23, 50, 0)).toISOString());
});

test("calcularUltimaEsperada: semanal (domingo 10:00) evaluada el martes -> el domingo pasado, no 'hoy'", () => {
  const tarea = { periodo: "semanal", dia_semana: 0, hora_utc: 10, minuto_utc: 0 };
  const ahoraMs = Date.UTC(2026, 8, 15, 8, 0, 0); // martes 15 sept., 08:00 UTC
  const esperada = calcularUltimaEsperada(tarea, ahoraMs);
  assert.strictEqual(new Date(esperada).toISOString(), new Date(Date.UTC(2026, 8, 13, 10, 0, 0)).toISOString()); // domingo 13
});

test("calcularUltimaEsperada: semanal (lunes 12:00) evaluada el lunes antes de la hora -> el lunes anterior", () => {
  const tarea = { periodo: "semanal", dia_semana: 1, hora_utc: 12, minuto_utc: 0 };
  const ahoraMs = Date.UTC(2026, 8, 14, 8, 0, 0); // lunes 14 sept., antes de las 12:00
  const esperada = calcularUltimaEsperada(tarea, ahoraMs);
  assert.strictEqual(new Date(esperada).toISOString(), new Date(Date.UTC(2026, 8, 7, 12, 0, 0)).toISOString()); // lunes anterior
});

// ── 1. Primer arranque: sin avalancha ───────────────────────────────────────

test("primer arranque: revisar() siembra las tareas sin avisar de nada, aunque su hora ya haya pasado", async () => {
  const { latidos, enviados, auditoria } = construir({ ahoraInicial: Date.UTC(2026, 8, 13, 12, 0, 0) }); // domingo 12:00 UTC, ya pasaron las 08:00 y 10:00 de hoy
  const r = await latidos.revisar();

  assert.deepStrictEqual(r.sembradas.sort(), ["diaria_test", "semanal_test"]);
  assert.strictEqual(r.faltas_nuevas.length, 0);
  assert.strictEqual(enviados.length, 0, "no debe mandar ningún WhatsApp en el primer arranque");
  assert.strictEqual(auditoria.filter((a) => a.accion === "latido_falta").length, 0);

  const estado = latidos.estadoLatidos();
  assert.strictEqual(estado.resumen.faltan, 0);
  assert.strictEqual(estado.resumen.sin_datos, 2);
  for (const t of estado.tareas) assert.strictEqual(t.estado, "sin_datos");
});

// ── 2. Diaria que sí latió -> sin aviso ─────────────────────────────────────

test("diaria que sí latió dentro de la gracia: no manda ningún aviso", async () => {
  const { latidos, enviados, reloj } = construir({ ahoraInicial: Date.UTC(2026, 8, 14, 0, 0, 0) }); // lunes 00:00 UTC
  await latidos.revisar(); // siembra

  reloj.avanzar(Date.UTC(2026, 8, 14, 8, 5, 0)); // lunes 08:05 UTC: la tarea diaria terminó bien
  latidos.registrar("diaria_test", { ok: true, detalle: "todo bien" }, "cron");

  reloj.avanzar(Date.UTC(2026, 8, 14, 9, 0, 0)); // lunes 09:00 UTC: ya pasó la gracia (08:45) pero SÍ latió a tiempo
  const r = await latidos.revisar();

  assert.strictEqual(r.faltas_nuevas.length, 0);
  assert.strictEqual(enviados.length, 0);
  const estado = latidos.estadoLatidos();
  const diaria = estado.tareas.find((t) => t.id === "diaria_test");
  assert.strictEqual(diaria.estado, "ok");
});

// ── 3. Diaria que no latió pasada la gracia -> 1 aviso, no se repite ────────

test("diaria que no latió pasada la gracia: manda 1 aviso y no lo repite en el siguiente tick", async () => {
  const { latidos, enviados, auditoria, reloj } = construir({ ahoraInicial: Date.UTC(2026, 8, 14, 0, 0, 0) }); // lunes 00:00 UTC
  await latidos.revisar(); // siembra (sembrado_ts = lunes 00:00, antes de la esperada de hoy 08:00)

  reloj.avanzar(Date.UTC(2026, 8, 14, 8, 50, 0)); // 08:00 + 45 min de gracia = 08:45 -> ya venció
  const r1 = await latidos.revisar();
  assert.deepStrictEqual(r1.faltas_nuevas, ["diaria_test"]);
  assert.strictEqual(enviados.length, 1);
  assert.match(enviados[0], /Tarea diaria de prueba/);
  assert.strictEqual(auditoria.filter((a) => a.accion === "latido_falta" && a.resultado === "enviado").length, 1);

  reloj.avanzar(Date.UTC(2026, 8, 14, 9, 30, 0)); // sigue sin latir, mismo día
  const r2 = await latidos.revisar();
  assert.strictEqual(r2.faltas_nuevas.length, 0, "no debe contarla de nuevo como falta nueva");
  assert.strictEqual(enviados.length, 1, "no debe repetir el aviso");

  const estado = latidos.estadoLatidos();
  const diaria = estado.tareas.find((t) => t.id === "diaria_test");
  assert.strictEqual(diaria.estado, "falta");
  assert.strictEqual(diaria.aviso.estado, "enviado");
});

// ── 4. Semanal en día equivocado -> no aplica ───────────────────────────────

test("semanal que sí corrió el domingo no se marca como falta el martes, aunque hoy no sea su día", async () => {
  const { latidos, enviados, reloj } = construir({ ahoraInicial: Date.UTC(2026, 8, 13, 9, 0, 0) }); // domingo 09:00, antes de las 10:00
  await latidos.revisar(); // siembra

  reloj.avanzar(Date.UTC(2026, 8, 13, 10, 5, 0)); // domingo 10:05: la semanal terminó bien
  latidos.registrar("semanal_test", { ok: true }, "interno");

  reloj.avanzar(Date.UTC(2026, 8, 15, 8, 0, 0)); // martes 08:00: no es domingo, no le toca hoy
  const r = await latidos.revisar();

  assert.strictEqual(r.faltas_nuevas.length, 0);
  assert.strictEqual(enviados.length, 0);
  const estado = latidos.estadoLatidos();
  const semanal = estado.tareas.find((t) => t.id === "semanal_test");
  assert.strictEqual(semanal.estado, "ok", "la última ocurrencia (el domingo) sí latió: no es una falta");
});

// ── 5. Recuperación -> aviso de "volvió" ────────────────────────────────────

test("recuperación: tras una falta avisada, un latido posterior manda 'volvió a correr' y limpia el aviso", async () => {
  const { latidos, enviados, auditoria, reloj } = construir({ ahoraInicial: Date.UTC(2026, 8, 14, 0, 0, 0) });
  await latidos.revisar(); // siembra

  reloj.avanzar(Date.UTC(2026, 8, 14, 8, 50, 0));
  await latidos.revisar(); // detecta la falta, manda el aviso (1er WhatsApp)
  assert.strictEqual(enviados.length, 1);

  reloj.avanzar(Date.UTC(2026, 8, 14, 10, 0, 0));
  latidos.registrar("diaria_test", { ok: true }, "cron"); // por fin late

  reloj.avanzar(Date.UTC(2026, 8, 14, 10, 5, 0));
  const r = await latidos.revisar();

  assert.deepStrictEqual(r.recuperadas, ["diaria_test"]);
  assert.strictEqual(enviados.length, 2, "debe mandar un segundo WhatsApp: la confirmación de que volvió");
  assert.match(enviados[1], /Volvió a correr/);
  assert.strictEqual(auditoria.filter((a) => a.accion === "latido_recuperado").length, 1);

  const estado = latidos.estadoLatidos();
  const diaria = estado.tareas.find((t) => t.id === "diaria_test");
  assert.strictEqual(diaria.estado, "ok");
  assert.strictEqual(diaria.aviso, null);

  // Un tick más tarde no debe volver a mandar nada.
  reloj.avanzar(Date.UTC(2026, 8, 14, 10, 15, 0));
  await latidos.revisar();
  assert.strictEqual(enviados.length, 2);
});

// ── 6. Permiso de WhatsApp apagado -> audita, no envía; se recupera al reactivar ─

test("con el permiso de WhatsApp apagado: audita la falta pero no manda nada; al reactivarlo, reintenta y envía", async () => {
  let permisoWhatsapp = false;
  const permisos = { permitido: (cat) => (cat === "whatsapp" ? permisoWhatsapp : true) };
  const { latidos, enviados, auditoria, reloj } = construir({ ahoraInicial: Date.UTC(2026, 8, 14, 0, 0, 0), permisos });
  await latidos.revisar(); // siembra

  reloj.avanzar(Date.UTC(2026, 8, 14, 8, 50, 0));
  const r1 = await latidos.revisar();
  assert.deepStrictEqual(r1.faltas_nuevas, ["diaria_test"]);
  assert.strictEqual(enviados.length, 0, "sin permiso, no debe mandar ningún WhatsApp real");
  const filaSinPermiso = auditoria.find((a) => a.accion === "latido_falta" && a.resultado === "sin_permiso_whatsapp");
  assert.ok(filaSinPermiso, "debe quedar auditada la falta aunque no se haya podido avisar");

  const estado1 = latidos.estadoLatidos();
  assert.strictEqual(estado1.tareas.find((t) => t.id === "diaria_test").aviso.estado, "sin_permiso_whatsapp");

  // El dueño reactiva el permiso; el siguiente tick debe reintentar y esta vez sí enviar.
  permisoWhatsapp = true;
  reloj.avanzar(Date.UTC(2026, 8, 14, 9, 0, 0));
  const r2 = await latidos.revisar();
  assert.deepStrictEqual(r2.reintentos, ["diaria_test"]);
  assert.strictEqual(enviados.length, 1);
  assert.ok(auditoria.find((a) => a.accion === "latido_falta" && a.resultado === "enviado"));
});

// ── Extra: falla con error (ok:false) queda registrada y se explica distinto ─

test("una tarea que corrió pero terminó con error: el aviso lo dice y queda auditado como latido_fallo", async () => {
  const { latidos, enviados, auditoria, reloj } = construir({ ahoraInicial: Date.UTC(2026, 8, 14, 0, 0, 0) });
  await latidos.revisar(); // siembra

  reloj.avanzar(Date.UTC(2026, 8, 14, 8, 5, 0));
  latidos.registrar("diaria_test", { ok: false, detalle: "subida a Drive falló" }, "cron");
  assert.ok(auditoria.find((a) => a.accion === "latido_fallo" && /subida a Drive falló/.test(a.detalle)));

  reloj.avanzar(Date.UTC(2026, 8, 14, 8, 50, 0));
  await latidos.revisar();
  assert.strictEqual(enviados.length, 1);
  assert.match(enviados[0], /terminó con error: subida a Drive falló/);
});

// ── Extra: modo viaje silencia un aviso "warn" y lo manda cuando se apaga ────

test("modo viaje silencia un aviso de nivel warn; al apagar el modo viaje, se envía", async () => {
  let modoActivo = true;
  const kapsoYModo = {
    obtenerModo: () => ({ activo: modoActivo }),
    debeSilenciar: (nivel, modo) => !!(modo && modo.activo) && nivel !== "crit",
  };
  const { latidos, enviados, reloj } = construir({ ahoraInicial: Date.UTC(2026, 8, 14, 0, 0, 0), kapsoYModo });
  await latidos.revisar();

  reloj.avanzar(Date.UTC(2026, 8, 14, 8, 50, 0));
  const r1 = await latidos.revisar();
  assert.deepStrictEqual(r1.faltas_nuevas, ["diaria_test"]);
  assert.strictEqual(enviados.length, 0, "en modo viaje, un aviso warn se silencia");

  modoActivo = false;
  reloj.avanzar(Date.UTC(2026, 8, 14, 9, 0, 0));
  const r2 = await latidos.revisar();
  assert.deepStrictEqual(r2.reintentos, ["diaria_test"]);
  assert.strictEqual(enviados.length, 1, "al apagar el modo viaje, el siguiente tick sí envía");
});

// ── Extra: id desconocido o inválido no crea entradas fantasma ──────────────

test("registrar con un id desconocido o inválido no crea ninguna entrada y queda auditado", () => {
  const { latidos, auditoria } = construir();
  const r1 = latidos.registrar("tarea_que_no_existe", { ok: true }, "cron");
  assert.strictEqual(r1.ok, false);
  assert.strictEqual(r1.motivo, "tarea_desconocida");
  assert.ok(auditoria.find((a) => a.accion === "latido_desconocido"));

  const r2 = latidos.registrar("MAYUS-no-valido", { ok: true }, "cron");
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(r2.motivo, "id_invalido");
  assert.ok(auditoria.find((a) => a.accion === "latido_rechazado"));

  const estado = latidos.estadoLatidos();
  assert.strictEqual(estado.tareas.length, 2, "solo las tareas de la tabla, ninguna fantasma");
});

// ── evaluarTarea (pura): estados básicos ────────────────────────────────────

test("evaluarTarea: sin ningún registro -> sin_datos (nunca 'falta' antes de sembrar)", () => {
  const ev = evaluarTarea(DIARIA, null, Date.UTC(2026, 8, 20, 12, 0, 0));
  assert.strictEqual(ev.estado, "sin_datos");
});

test("evaluarTarea: dentro de la ventana de gracia -> esperando", () => {
  const registro = { sembrado_ts: new Date(Date.UTC(2026, 8, 1)).toISOString(), ultimo_ok_ts: null, ultimo_fallo_ts: null };
  const ahoraMs = Date.UTC(2026, 8, 14, 8, 20, 0); // 20 min después de las 08:00, gracia 45
  const ev = evaluarTarea(DIARIA, registro, ahoraMs);
  assert.strictEqual(ev.estado, "esperando");
});
