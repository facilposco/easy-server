"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { explicarHallazgo } = require("../explicador-hallazgos.js");

// explicarHallazgo: reemplaza el texto genérico "copiar para tu técnico" por
// algo redactado por Gemini y específico al hallazgo real. Regla central del
// proyecto: la IA solo redacta, nunca ejecuta — estas pruebas verifican que
// la función respeta el límite diario/los permisos ANTES de gastar una
// consulta, y que nunca toca nada del servidor (no recibe sh/mysql).

test("explicarHallazgo: consulta a Gemini con el hallazgo real y devuelve su texto", async () => {
  let contextoRecibido = null, preguntaRecibida = null;
  const preguntarFalso = async (sys, contexto, pregunta) => {
    contextoRecibido = contexto; preguntaRecibida = pregunta;
    return "Esto significa que el firewall tiene un puerto abierto de más...";
  };
  const registrarFalso = () => ({ permitido: true, restantes: 299 });
  const r = await explicarHallazgo(preguntarFalso, registrarFalso, {
    titulo: "Cortafuegos y bloqueo de intrusos",
    significado: "Hay un puerto abierto que no debería estarlo",
    detalle: "Puerto 19223 abierto",
  });
  assert.strictEqual(r.ok, true);
  assert.match(r.texto, /firewall/);
  assert.strictEqual(contextoRecibido.hallazgo.titulo, "Cortafuegos y bloqueo de intrusos");
  assert.match(preguntaRecibida, /Explica/);
});

test("explicarHallazgo: respeta el límite diario de IA sin gastar la consulta", async () => {
  const preguntarFalso = async () => { throw new Error("no debería llamarse: se acabó el cupo"); };
  const registrarFalso = () => ({ permitido: false, restantes: 0, motivo: "Se acabaron las 300 consultas de hoy" });
  const r = await explicarHallazgo(preguntarFalso, registrarFalso, { titulo: "SSH y acceso remoto" });
  assert.strictEqual(r.ok, false);
  assert.match(r.mensaje, /consultas de hoy/);
});

test("explicarHallazgo: rechaza un hallazgo vacío sin llamar a Gemini", async () => {
  const preguntarFalso = async () => { throw new Error("no debería llamarse"); };
  const registrarFalso = () => ({ permitido: true, restantes: 299 });
  const r = await explicarHallazgo(preguntarFalso, registrarFalso, null);
  assert.strictEqual(r.ok, false);
});

test("explicarHallazgo: el prompt de sistema prohíbe insinuar que Centinela ejecuta el cambio", async () => {
  let systemPromptRecibido = null;
  const preguntarFalso = async (sys) => { systemPromptRecibido = sys; return "texto"; };
  const registrarFalso = () => ({ permitido: true, restantes: 299 });
  await explicarHallazgo(preguntarFalso, registrarFalso, { titulo: "Usuarios y permisos de administrador" });
  assert.match(systemPromptRecibido, /no ejecuta esto autom/i);
});
