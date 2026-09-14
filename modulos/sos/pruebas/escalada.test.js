"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { siguientePeldano, contenedoresYaReiniciados } = require("../escalada.js");

function diagDe(sintoma, clasificacion, extra) {
  return { sintoma_principal: sintoma, afecta_clientes: "si", culpable: "zeus-bot", clasificacion: clasificacion || {}, ...extra };
}

function sDespliegue(horasAtras, conObjetivo) {
  return { despliegue: conObjetivo ? { objetivo: "abc123", creadoHaceMs: horasAtras * 3600 * 1000 } : { objetivo: null, creadoHaceMs: null } };
}

test("presupuesto agotado -> null sin importar el resto", () => {
  const r = siguientePeldano({ diag: diagDe("bot_caido"), S: {}, acciones: [], presupuestoAgotado: true });
  assert.strictEqual(r, null);
});

test("afecta_clientes distinto de 'si' -> null", () => {
  const r = siguientePeldano({ diag: { ...diagDe("bot_caido"), afecta_clientes: "parcial" }, S: {}, acciones: [], presupuestoAgotado: false });
  assert.strictEqual(r, null);
});

test("bd_caida nunca escala (§5.5.6)", () => {
  const r = siguientePeldano({ diag: diagDe("bd_caida"), S: {}, acciones: [], presupuestoAgotado: false });
  assert.strictEqual(r, null);
});

test("docker_colgado: sin haber probado reiniciar_docker -> null; habiéndolo probado -> reiniciar_servidor", () => {
  const diag = diagDe("docker_colgado");
  const sinProbar = siguientePeldano({ diag, S: {}, acciones: [], presupuestoAgotado: false });
  assert.strictEqual(sinProbar, null);
  const yaProbado = siguientePeldano({ diag, S: {}, acciones: [{ peldano: "reiniciar_docker", ok: false }], presupuestoAgotado: false });
  assert.deepStrictEqual(yaProbado, { peldano: "reiniciar_servidor" });
});

test("paso 6: reinicia en orden de dependencia lo que no atiende, incluyendo al bot repetido tras su dependencia", () => {
  const diag = diagDe("bot_caido", { "zeus-mariadb": "sano", "zeus-chromadb": "no_responde", "zeus-bot": "caido", "zeus-proxy": "sano" });
  const acciones = [{ peldano: "reiniciar_contenedor", objetivo: "zeus-bot", ok: false }];
  const r = siguientePeldano({ diag, S: {}, acciones, presupuestoAgotado: false });
  assert.deepStrictEqual(r, { peldano: "reiniciar_en_orden", objetivo: ["zeus-chromadb", "zeus-bot"] });
});

test("paso 6 omitido si todos los que no atienden ya se reiniciaron -> pasa al 7 (o al 8)", () => {
  const diag = diagDe("bot_caido", { "zeus-bot": "caido" });
  const acciones = [{ peldano: "reiniciar_contenedor", objetivo: "zeus-bot", ok: false }];
  const conDespliegue = siguientePeldano({ diag, S: sDespliegue(3, true), acciones, presupuestoAgotado: false });
  assert.deepStrictEqual(conDespliegue, { peldano: "deshacer_despliegue" });
});

test("paso 7: deshacer_despliegue solo si el culpable es el bot, hay objetivo y el despliegue es reciente (<=24h)", () => {
  const diag = diagDe("bot_caido", { "zeus-bot": "caido" });
  const acciones = [{ peldano: "reiniciar_contenedor", objetivo: "zeus-bot", ok: false }];
  const reciente = siguientePeldano({ diag, S: sDespliegue(3, true), acciones, presupuestoAgotado: false });
  assert.deepStrictEqual(reciente, { peldano: "deshacer_despliegue" });

  const viejo = siguientePeldano({ diag, S: sDespliegue(30, true), acciones, presupuestoAgotado: false });
  assert.deepStrictEqual(viejo, { peldano: "reiniciar_servidor" });

  const sinObjetivo = siguientePeldano({ diag, S: sDespliegue(3, false), acciones, presupuestoAgotado: false });
  assert.deepStrictEqual(sinObjetivo, { peldano: "reiniciar_servidor" });
});

test("paso 7 no aplica si el culpable no es el bot, aunque haya despliegue reciente", () => {
  const diag = { ...diagDe("puerta_caida", { "zeus-proxy": "caido" }), culpable: "zeus-proxy" };
  const acciones = [{ peldano: "reiniciar_contenedor", objetivo: "zeus-proxy", ok: false }];
  const r = siguientePeldano({ diag, S: sDespliegue(2, true), acciones, presupuestoAgotado: false });
  assert.deepStrictEqual(r, { peldano: "reiniciar_servidor" });
});

test("nunca se insiste sobre la base de datos: si ya se reinició y sigue sin atender, se detiene", () => {
  const diag = diagDe("memoria_agotada", { "zeus-mariadb": "caido" });
  const acciones = [{ peldano: "esperar_respaldo", ok: true }];
  const r = siguientePeldano({ diag, S: {}, acciones, presupuestoAgotado: false });
  assert.strictEqual(r.detener, true);
  assert.match(r.motivo, /base de datos/i);
});

test("deshacer_despliegue ya intentado no se vuelve a proponer aunque el despliegue siga reciente", () => {
  const diag = diagDe("bot_caido", { "zeus-bot": "caido" });
  const acciones = [
    { peldano: "reiniciar_contenedor", objetivo: "zeus-bot", ok: false },
    { peldano: "deshacer_despliegue", ok: false },
  ];
  const r = siguientePeldano({ diag, S: sDespliegue(1, true), acciones, presupuestoAgotado: false });
  assert.deepStrictEqual(r, { peldano: "reiniciar_servidor" });
});

test("cadena completa: en_orden -> deshacer_despliegue -> reiniciar_servidor -> null", () => {
  // Dos contenedores sin atender desde el arranque (nada reiniciado todavía),
  // así el paso 6 sí aporta algo nuevo antes de pasar al 7 y al 8.
  const diag = diagDe("bot_caido", { "zeus-chromadb": "no_responde", "zeus-bot": "caido" });
  const acciones = [];
  const S = sDespliegue(2, true);

  const paso6 = siguientePeldano({ diag, S, acciones, presupuestoAgotado: false });
  assert.deepStrictEqual(paso6, { peldano: "reiniciar_en_orden", objetivo: ["zeus-chromadb", "zeus-bot"] });
  acciones.push({ peldano: paso6.peldano, objetivo: paso6.objetivo.join(","), ok: false });

  const paso7 = siguientePeldano({ diag, S, acciones, presupuestoAgotado: false });
  assert.deepStrictEqual(paso7, { peldano: "deshacer_despliegue" });
  acciones.push({ peldano: paso7.peldano, ok: false });

  const paso8 = siguientePeldano({ diag, S, acciones, presupuestoAgotado: false });
  assert.deepStrictEqual(paso8, { peldano: "reiniciar_servidor" });
  acciones.push({ peldano: paso8.peldano, ok: false });

  const fin = siguientePeldano({ diag, S, acciones, presupuestoAgotado: false });
  assert.strictEqual(fin, null);
});

test("contenedoresYaReiniciados junta reiniciar_contenedor, reiniciar_en_orden, esperar_respaldo y deshacer_despliegue", () => {
  const set = contenedoresYaReiniciados([
    { peldano: "reiniciar_contenedor", objetivo: "zeus-proxy" },
    { peldano: "reiniciar_en_orden", objetivo: "zeus-mariadb,zeus-bot" },
    { peldano: "esperar_respaldo" },
    { peldano: "deshacer_despliegue" },
  ]);
  assert.deepStrictEqual([...set].sort(), ["zeus-bot", "zeus-mariadb", "zeus-proxy"]);
});
