"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { crearEnmascarador, filtrarLineasTecnicas } = require("../enmascarar.js");

test("oculta un secreto literal conocido", () => {
  const { enmascarar } = crearEnmascarador([{ nombre: "MYSQL_PASS", valor: "hunter2clave" }]);
  const r = enmascarar("la clave es hunter2clave y ya");
  assert.ok(!r.texto.includes("hunter2clave"));
  assert.ok(r.texto.includes("<secreto:MYSQL_PASS>"));
});

test("oculta patrones de credenciales", () => {
  const { enmascarar } = crearEnmascarador([]);
  const r = enmascarar("password=abcdef1234 Bearer sometoken123");
  assert.ok(r.texto.includes("password=<oculto>"));
  assert.ok(r.texto.includes("Bearer <oculto>"));
});

test("conserva solo los últimos 4 dígitos de un teléfono", () => {
  const { enmascarar } = crearEnmascarador([]);
  const r = enmascarar("contacto 573001234567@s.whatsapp.net");
  assert.ok(r.texto.includes("4567"));
  assert.ok(!r.texto.includes("573001234567"));
});

test("filtra líneas de conversación de los logs del bot", () => {
  const texto = "2024 cliente dice hola\n2024 ERROR mysql connection refused\n2024 cliente dice gracias";
  const r = filtrarLineasTecnicas(texto);
  assert.strictEqual(r.lineas_conservadas, 1);
  assert.ok(r.texto.includes("ERROR"));
  assert.ok(!r.texto.includes("cliente dice"));
});

test("comprobación final omite la sección si un secreto sigue presente", () => {
  const { enmascarar } = crearEnmascarador([{ nombre: "RARO", valor: "valorxyz123" }]);
  // Un valor que ninguna regla anterior toca pero que la lista de secretos conoce.
  const r = enmascarar("dato sin forma reconocible: valorxyz123");
  assert.strictEqual(r.omitida, false); // la regla 1 sí lo captura antes de la comprobación final
});
