"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { analizarPatrones, optimizarTabla, subirMaxConnections, reducirKeyBuffer, _interno } = require("../db-optimizacion.js");
const { extraerPatrones, aliasDeTablas } = _interno;

// Regresión de dos bugs reales encontrados probando en vivo el 14-sep-2026:
//  1. Un JOIN cortado a mitad de la consulta (el propio log de MariaDB
//     trunca el texto) hacía que se extrajera el alias de una tabla ("a")
//     como si fuera columna, generando una sugerencia de índice falsa.
//  2. `analizarPatrones` no sabía qué índices ya existían: sugería crear un
//     índice que ya estaba cubierto por uno existente (incluida PRIMARY).

test("aliasDeTablas: reconoce los alias de FROM y JOIN", () => {
  const sql = "SELECT a.name FROM phppos_sales_items a JOIN phppos_sales s ON s.sale_id=a.sale_id";
  const alias = aliasDeTablas(sql);
  assert.ok(alias.has("a"));
  assert.ok(alias.has("s"));
});

test("extraerPatrones: no confunde un alias de tabla con una columna en un JOIN cortado", () => {
  // Consulta real truncada tal como llega del log lento (corte a mitad del
  // segundo JOIN, justo después de "=a").
  const sql = "SELECT ia.name producto1, ib.name producto2, COUNT(*) veces_juntos " +
    "FROM phppos_sales_items a JOIN phppos_sales_items b ON a.sale_id=b.sale_id " +
    "AND a.item_id<b.item_id JOIN phppos_sales s ON s.sale_id=a";
  const hallazgos = extraerPatrones(sql);
  const columnaBasura = hallazgos.find((h) => h.columnas.includes("a"));
  assert.strictEqual(columnaBasura, undefined, "no debe sugerir 'a' como columna: es un alias de tabla");
  // La parte del JOIN que sí se alcanzó a leer completa sigue generando su
  // sugerencia legítima.
  assert.ok(hallazgos.some((h) => h.tabla === "phppos_sales_items" && h.columnas.includes("sale_id")));
});

test("analizarPatrones: marca ya_cubierto y no ofrece comando cuando la columna ya es líder de un índice", () => {
  const consultas = [
    { sql: "SELECT * FROM phppos_sales WHERE deleted = 0", segundos: 5, accionable: true },
  ];
  const columnasIndexadas = { phppos_sales: new Set(["sale_id", "deleted"]) };
  const [sug] = analizarPatrones(consultas, [], columnasIndexadas);
  assert.strictEqual(sug.ya_cubierto, true);
  assert.strictEqual(sug.comando, null);
});

test("analizarPatrones: sin columnasIndexadas, sigue sugiriendo comando normalmente (compatibilidad)", () => {
  const consultas = [
    { sql: "SELECT * FROM phppos_sales WHERE deleted = 0", segundos: 5, accionable: true },
  ];
  const [sug] = analizarPatrones(consultas);
  assert.strictEqual(sug.ya_cubierto, false);
  assert.ok(sug.comando && /ADD INDEX/i.test(sug.comando));
});

test("analizarPatrones: una vista nunca queda marcada ya_cubierto (es_vista manda)", () => {
  const consultas = [
    { sql: "SELECT * FROM vw_clientes_top WHERE dias_inactividad > 90", segundos: 5, accionable: true },
  ];
  const columnasIndexadas = { vw_clientes_top: new Set(["dias_inactividad"]) };
  const [sug] = analizarPatrones(consultas, ["vw_clientes_top"], columnasIndexadas);
  assert.strictEqual(sug.es_vista, true);
  assert.strictEqual(sug.ya_cubierto, false);
  assert.strictEqual(sug.comando, null);
});

// ── optimizarTabla: OPTIMIZE TABLE, mismo patrón de seguridad que cambiarMotorInnoDB ──

test("optimizarTabla: arma el comando con el esquema fijo y acepta un nombre válido", async () => {
  let comandoRecibido = null;
  const mysqlFalso = async (c) => { comandoRecibido = c; return { ok: true, salida: "" }; };
  const r = await optimizarTabla(mysqlFalso, "phppos_sales");
  assert.strictEqual(r.ok, true);
  assert.strictEqual(comandoRecibido, "OPTIMIZE TABLE `negocio`.`phppos_sales`;");
});

test("optimizarTabla: rechaza un nombre de tabla con caracteres fuera de lo permitido", async () => {
  const mysqlFalso = async () => { throw new Error("no debería llamarse"); };
  const r = await optimizarTabla(mysqlFalso, "phppos_sales; DROP TABLE phppos_sales");
  assert.strictEqual(r.ok, false);
  assert.match(r.mensaje, /no válido/);
});

test("optimizarTabla: propaga el fallo cuando mysql() no puede ejecutar el comando", async () => {
  const mysqlFalso = async () => ({ ok: false, error: "tabla bloqueada" });
  const r = await optimizarTabla(mysqlFalso, "phppos_receivings");
  assert.strictEqual(r.ok, false);
  assert.match(r.mensaje, /No se pudo desfragmentar/);
});

// ── subirMaxConnections / reducirKeyBuffer: ajustes dinámicos, sin reiniciar ──

test("subirMaxConnections: acepta un valor dentro del rango y arma el SET GLOBAL correcto", async () => {
  let comandoRecibido = null;
  const mysqlFalso = async (c) => { comandoRecibido = c; return { ok: true, salida: "" }; };
  const r = await subirMaxConnections(mysqlFalso, 450);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(comandoRecibido, "SET GLOBAL max_connections = 450;");
});

test("subirMaxConnections: rechaza un valor por encima del techo duro (500)", async () => {
  const mysqlFalso = async () => { throw new Error("no debería llamarse"); };
  const r = await subirMaxConnections(mysqlFalso, 5000);
  assert.strictEqual(r.ok, false);
  assert.match(r.mensaje, /entre 50 y 500/);
});

test("subirMaxConnections: rechaza un valor no entero (intento de inyección)", async () => {
  const mysqlFalso = async () => { throw new Error("no debería llamarse"); };
  const r = await subirMaxConnections(mysqlFalso, "300; DROP TABLE phppos_sales");
  assert.strictEqual(r.ok, false);
});

test("reducirKeyBuffer: siempre manda el mismo comando fijo (8 MB), sin aceptar un valor externo", async () => {
  let comandoRecibido = null;
  const mysqlFalso = async (c) => { comandoRecibido = c; return { ok: true, salida: "" }; };
  const r = await reducirKeyBuffer(mysqlFalso);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(comandoRecibido, "SET GLOBAL key_buffer_size = 8388608;");
});

test("reducirKeyBuffer: propaga el fallo si mysql() no puede aplicarlo", async () => {
  const mysqlFalso = async () => ({ ok: false, error: "sin permiso" });
  const r = await reducirKeyBuffer(mysqlFalso);
  assert.strictEqual(r.ok, false);
});
