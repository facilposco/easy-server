"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { tieneArregloDeIndice } = require("../optimizacion-completa.js");

// tieneArregloDeIndice: el paso "escaneos" de la auditoría completa solo debe
// marcar una consulta lenta como "para revisar" si un índice nuevo de verdad
// la ayudaría. Nace de un bug real (14-sep-2026): antes marcaba CUALQUIER
// consulta que leyera muchas filas, aunque fuera una vista que agrega en
// vivo o una columna que ya tenía índice — ese día, ninguna de las 11
// consultas marcadas tenía arreglo posible, y el panel decía "para revisar"
// sin que hubiera nada que revisar.

test("tieneArregloDeIndice: una vista nunca tiene arreglo de índice (no hay columna real que indexar)", () => {
  const sql = "SELECT cliente, total_cop FROM vw_clientes_top ORDER BY total_cop DESC LIMIT 10";
  const r = tieneArregloDeIndice(sql, ["vw_clientes_top"], {});
  assert.strictEqual(r, false);
});

test("tieneArregloDeIndice: una columna que ya es líder de un índice no cuenta como arreglable", () => {
  const sql = "SELECT * FROM phppos_sales WHERE deleted = 0";
  const columnasIndexadas = { phppos_sales: new Set(["deleted"]) };
  const r = tieneArregloDeIndice(sql, [], columnasIndexadas);
  assert.strictEqual(r, false);
});

test("tieneArregloDeIndice: una columna real, sin vista y sin índice previo, sí es arreglable", () => {
  const sql = "SELECT * FROM phppos_items WHERE category = 'bebidas'";
  const r = tieneArregloDeIndice(sql, [], {});
  assert.strictEqual(r, true);
});

test("tieneArregloDeIndice: sin ningún patrón detectable (p.ej. solo agregación), no es arreglable", () => {
  const sql = "SELECT COUNT(*) FROM phppos_sales_items GROUP BY item_id";
  const r = tieneArregloDeIndice(sql, [], {});
  assert.strictEqual(r, false);
});
