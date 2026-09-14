"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { diagnosticar } = require("../diagnostico.js");

function instantaneaBase() {
  return {
    dockerOk: true,
    memoria: { total: 4e9, usada: 2e9, disponible: 2e9, pct: 50 },
    swapUsadoBytes: 0,
    cpu: { pct: 5, carga: 0.2 },
    iowaitPct: 0,
    disco: { total: 80e9, usado: 30e9, libre: 50e9, pct: 40 },
    inodosPct: 10,
    contenedores: {
      "zeus-mariadb": { estado: "running", detalle: "Up", salud: "healthy" },
      "zeus-chromadb": { estado: "running", detalle: "Up", salud: "healthy" },
      "zeus-bot": { estado: "running", detalle: "Up", salud: "healthy" },
      "zeus-proxy": { estado: "running", detalle: "Up", salud: "healthy" },
    },
    inspect: { "zeus-mariadb": {}, "zeus-chromadb": {}, "zeus-bot": {}, "zeus-proxy": {} },
    sondas: {
      "zeus-mariadb": { ok: true }, "zeus-chromadb": { ok: true },
      "zeus-bot": { ok: true, codigo: 200, tiempo_s: 0.2 }, "zeus-proxy": { ok: true, codigo: 200, tiempo_s: 0.05 },
    },
    eventosDieKill10min: {}, incidenteYaActuado: {},
    respaldoEnCurso: false, simulacroEnCurso: false,
    despliegue: { creadoHaceMs: null, hayObjetivoRollback: false },
    procesosHost: {}, consultasTrabadas: { hay_trabadas: false },
    ajenoConProblema: false, noDiagnosticable: false,
  };
}

test("todo sano -> todo_bien", () => {
  const d = diagnosticar(instantaneaBase());
  assert.strictEqual(d.sintoma_principal, "todo_bien");
  assert.strictEqual(d.afecta_clientes, "no");
});

test("bot caído -> bot_caido, afecta clientes, plan reinicia el bot", () => {
  const S = instantaneaBase();
  S.contenedores["zeus-bot"] = { estado: "exited", detalle: "Exited (1)", salud: "unhealthy" };
  const d = diagnosticar(S);
  assert.strictEqual(d.sintoma_principal, "bot_caido");
  assert.strictEqual(d.afecta_clientes, "si");
  assert.strictEqual(d.plan[0].peldano, "reiniciar_contenedor");
  assert.strictEqual(d.plan[0].objetivo, "zeus-bot");
});

test("disco lleno tiene prioridad sobre el bot caído (causa antes que síntoma)", () => {
  const S = instantaneaBase();
  S.disco = { total: 80e9, usado: 76e9, libre: 1.5e9, pct: 95 };
  S.contenedores["zeus-bot"] = { estado: "exited", detalle: "Exited (1)", salud: "unhealthy" };
  const d = diagnosticar(S);
  assert.strictEqual(d.sintoma_principal, "disco_lleno");
  assert.ok(d.plan.some((p) => p.peldano === "liberar_disco"));
});

test("bd caída antes que bot no responde (dependencia)", () => {
  const S = instantaneaBase();
  S.contenedores["zeus-mariadb"] = { estado: "exited", detalle: "Exited (1)", salud: "unhealthy" };
  S.sondas["zeus-mariadb"] = { ok: false };
  S.contenedores["zeus-bot"] = { estado: "running", detalle: "Up", salud: "unhealthy" };
  S.sondas["zeus-bot"] = { ok: false, codigo: 500 };
  const d = diagnosticar(S);
  assert.strictEqual(d.sintoma_principal, "bd_caida");
});

test("simulacro en curso detiene sin reparar", () => {
  const S = instantaneaBase();
  S.simulacroEnCurso = true;
  const d = diagnosticar(S);
  assert.strictEqual(d.sintoma_principal, "simulacro_en_curso");
  assert.deepStrictEqual(d.plan, []);
});

test("solo contenedor ajeno con problema -> ajeno_con_problema, no repara", () => {
  const S = instantaneaBase();
  S.ajenoConProblema = true;
  const d = diagnosticar(S);
  assert.strictEqual(d.sintoma_principal, "ajeno_con_problema");
  assert.deepStrictEqual(d.plan, []);
});

test("memoria agotada por OOM reciente identifica al culpable", () => {
  const S = instantaneaBase();
  S.memoria = { total: 4e9, usada: 3.9e9, disponible: 100e6, pct: 97 };
  S.inspect["zeus-bot"] = { oomKilled: true, exitCode: 137, finishedAt: new Date().toISOString() };
  const d = diagnosticar(S);
  assert.strictEqual(d.sintoma_principal, "memoria_agotada");
  assert.strictEqual(d.culpable, "zeus-bot");
});
