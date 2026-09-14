"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { crearPuedeActuar } = require("../puede-actuar.js");

const CONTENEDORES_PROPIOS = ["zeus-mariadb", "zeus-chromadb", "zeus-bot", "zeus-proxy"];
const CATEGORIA_POR_PELDANO = {
  liberar_disco: "disco",
  reiniciar_contenedor: "contenedores",
  reiniciar_en_orden: "contenedores",
  esperar_respaldo: "contenedores",
  deshacer_despliegue: "despliegue",
  reiniciar_docker: "contenedores",
  reiniciar_servidor: "servidor",
};

// Colaboradores "todo permitido" por defecto — igual al estado real por
// defecto de reglas-seguridad.js/permisos.js (todo en `true` hasta que el
// dueño apague algo a propósito).
function reglasPermisivas(overrides = {}) {
  return {
    frenoActivo: () => false,
    enHorarioComercial: () => false,
    ...overrides,
  };
}
function permisosPermisivos(overrides = {}) {
  return {
    verificarEscritura: () => ({ ok: true }),
    permitido: () => true,
    ...overrides,
  };
}
function limitesPermisivos(overrides = {}) {
  return { puede: () => ({ ok: true }), ...overrides };
}

// Mediodía UTC fijo por defecto: lejos de horaRespaldoUtc=8 y horaReinicioUtc=9
// (las ventanas de 20 min), para que las pruebas no dependan de la hora real.
const AHORA_SEGURO = () => Date.UTC(2026, 8, 12, 12, 0, 0);

function crear({ reglasSeguridad = reglasPermisivas(), permisos = permisosPermisivos(), limites = limitesPermisivos(), horaReinicioUtc = 9, horaRespaldoUtc = 8, ahora = AHORA_SEGURO } = {}) {
  return crearPuedeActuar({
    limites, reglasSeguridad, permisos,
    contenedoresPropios: CONTENEDORES_PROPIOS,
    categoriaPorPeldano: CATEGORIA_POR_PELDANO,
    horaReinicioUtc, horaRespaldoUtc, ahora,
  }).puedeActuar;
}

const S_BOT_ARRIBA = { contenedores: { "zeus-bot": { estado: "running" } } };
const S_BOT_CAIDO = { contenedores: { "zeus-bot": { estado: "exited" } } };

test("camino feliz: todo permisivo -> ok:true para cualquier peldaño", () => {
  const puedeActuar = crear();
  for (const peldano of ["liberar_disco", "reiniciar_contenedor", "reiniciar_en_orden", "esperar_respaldo", "deshacer_despliegue", "reiniciar_docker", "reiniciar_servidor"]) {
    const r = puedeActuar({ peldano, objetivo: peldano === "reiniciar_en_orden" ? ["zeus-bot"] : "zeus-bot" }, { S: S_BOT_ARRIBA });
    assert.strictEqual(r.ok, true, `${peldano} debería estar permitido en el camino feliz`);
  }
});

test("contenedor ajeno: nunca se toca, sin importar freno/permisos", () => {
  const puedeActuar = crear();
  const r = puedeActuar({ peldano: "reiniciar_contenedor", objetivo: "otro-proyecto-c" }, {});
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.fuente, "ajeno");
  assert.match(r.mensaje, /no es de este negocio/);
});

test("reiniciar_en_orden con un contenedor ajeno en la lista -> bloqueado", () => {
  const puedeActuar = crear();
  const r = puedeActuar({ peldano: "reiniciar_en_orden", objetivo: ["zeus-mariadb", "otro-proyecto-a"] }, {});
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.fuente, "ajeno");
});

test("freno de emergencia activo bloquea cualquier peldaño", () => {
  const puedeActuar = crear({ reglasSeguridad: reglasPermisivas({ frenoActivo: () => true }) });
  const r = puedeActuar({ peldano: "reiniciar_contenedor", objetivo: "zeus-bot" }, {});
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.fuente, "freno");
});

test("permiso de categoría apagado bloquea ese peldaño", () => {
  const puedeActuar = crear({
    permisos: permisosPermisivos({ verificarEscritura: (cat) => (cat === "contenedores" ? { ok: false, mensaje: "apagado" } : { ok: true }) }),
  });
  const r = puedeActuar({ peldano: "reiniciar_contenedor", objetivo: "zeus-bot" }, {});
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.fuente, "permisos");
});

test("permiso general de SOS apagado bloquea aunque la categoría esté encendida", () => {
  const puedeActuar = crear({
    permisos: permisosPermisivos({ permitido: (cat) => !(cat === "sos") }),
  });
  const r = puedeActuar({ peldano: "reiniciar_contenedor", objetivo: "zeus-bot" }, {});
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.fuente, "permisos");
});

test("horario comercial bloquea reiniciar_servidor si el bot sigue arriba", () => {
  const puedeActuar = crear({ reglasSeguridad: reglasPermisivas({ enHorarioComercial: () => true }) });
  const r = puedeActuar({ peldano: "reiniciar_servidor" }, { S: S_BOT_ARRIBA, diag: { sintoma_principal: "servidor_lento" } });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.fuente, "horario");
});

test("horario comercial también bloquea reiniciar_docker si el bot sigue arriba", () => {
  const puedeActuar = crear({ reglasSeguridad: reglasPermisivas({ enHorarioComercial: () => true }) });
  const r = puedeActuar({ peldano: "reiniciar_docker" }, { S: S_BOT_ARRIBA, diag: { sintoma_principal: "docker_colgado" } });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.fuente, "horario");
});

// Regresión H1: antes de este módulo, `S.sintoma_principal`/`S.bot` no
// existían nunca (vivían en `diag`, o simplemente no existían) — así que
// "cayó total" daba siempre false y el horario comercial bloqueaba el
// reinicio del servidor incluso con TODO caído, 13 horas al día.
// "Encendido no es atendiendo": el contenedor sigue "running" pero no responde
// (bot_no_responde) o nadie entra desde internet (puerta_caida). En ambos
// casos diagnostico.js marca afecta_clientes = "si", y eso debe bastar para
// que el horario comercial no frene la reparación.
test("H1 corregido: bot 'running' pero sin atender (afecta_clientes=si) ignora el horario comercial", () => {
  const puedeActuar = crear({ reglasSeguridad: reglasPermisivas({ enHorarioComercial: () => true }) });
  for (const sintoma of ["bot_no_responde", "puerta_caida", "bot_caido"]) {
    const r = puedeActuar({ peldano: "reiniciar_servidor" }, { S: S_BOT_ARRIBA, diag: { sintoma_principal: sintoma, afecta_clientes: "si" } });
    assert.strictEqual(r.ok, true, sintoma);
  }
});

test("horario comercial: si los clientes solo están afectados en parte (bot lento), sí espera", () => {
  const puedeActuar = crear({ reglasSeguridad: reglasPermisivas({ enHorarioComercial: () => true }) });
  const r = puedeActuar({ peldano: "reiniciar_servidor" }, { S: S_BOT_ARRIBA, diag: { sintoma_principal: "servidor_lento", afecta_clientes: "parcial" } });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.fuente, "horario");
});

test("H1 corregido: bot caído (contenedor no 'running') ignora el horario comercial", () => {
  const puedeActuar = crear({ reglasSeguridad: reglasPermisivas({ enHorarioComercial: () => true }) });
  const r = puedeActuar({ peldano: "reiniciar_docker" }, { S: S_BOT_CAIDO, diag: { sintoma_principal: "docker_colgado" } });
  assert.strictEqual(r.ok, true);
});

test("horario comercial no aplica a peldaños de bajo impacto (reiniciar_contenedor)", () => {
  const puedeActuar = crear({ reglasSeguridad: reglasPermisivas({ enHorarioComercial: () => true }) });
  const r = puedeActuar({ peldano: "reiniciar_contenedor", objetivo: "zeus-bot" }, { S: S_BOT_ARRIBA });
  assert.strictEqual(r.ok, true);
});

test("ventana sensible (respaldo a punto de correr) bloquea los 3 peldaños de alto impacto", () => {
  // "Ahora" fijo: 07:50 UTC. Respaldo a las 08:00 UTC -> faltan 10 min (<20).
  const ahoraFijo = () => Date.UTC(2026, 8, 12, 7, 50, 0);
  const puedeActuar = crear({ horaRespaldoUtc: 8, horaReinicioUtc: 20, ahora: ahoraFijo });
  for (const peldano of ["reiniciar_docker", "deshacer_despliegue", "reiniciar_servidor"]) {
    const r = puedeActuar({ peldano }, { S: S_BOT_ARRIBA });
    assert.strictEqual(r.ok, false, peldano);
    assert.strictEqual(r.fuente, "ventana", peldano);
  }
});

test("respaldo en curso bloquea los peldaños de alto impacto", () => {
  const puedeActuar = crear();
  const r = puedeActuar({ peldano: "reiniciar_docker" }, { S: { ...S_BOT_ARRIBA, respaldoEnCurso: true } });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.fuente, "ventana");
});

test("límite duro (enfriamiento) bloquea y trae el mensaje traducido", () => {
  const puedeActuar = crear({
    limites: limitesPermisivos({ puede: () => ({ ok: false, codigo: "enfriamiento", minutos: 38, motivo: "reiniciar_servidor está en enfriamiento; faltan 38 minutos." }) }),
  });
  const r = puedeActuar({ peldano: "reiniciar_servidor" }, { S: S_BOT_ARRIBA });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.fuente, "limite");
  assert.match(r.mensaje, /faltan 38 minutos/);
  assert.doesNotMatch(r.mensaje, /reiniciar_servidor está en enfriamiento/); // sin el identificador interno crudo
});

test("límite duro (autobloqueo) sugiere el botón Permitir", () => {
  const puedeActuar = crear({
    limites: limitesPermisivos({ puede: () => ({ ok: false, codigo: "autobloqueo", motivo: "bloqueado" }) }),
  });
  const r = puedeActuar({ peldano: "reiniciar_servidor" }, { S: S_BOT_ARRIBA });
  assert.strictEqual(r.ok, false);
  assert.match(r.sugerencia, /Permitir/);
});

test("sin colaboradores opcionales (reglasSeguridad y permisos null) -> solo ajeno/ventana/límites aplican", () => {
  const puedeActuar = crearPuedeActuar({
    limites: limitesPermisivos(), reglasSeguridad: null, permisos: null,
    contenedoresPropios: CONTENEDORES_PROPIOS, categoriaPorPeldano: CATEGORIA_POR_PELDANO,
    horaReinicioUtc: 9, horaRespaldoUtc: 8, ahora: AHORA_SEGURO,
  }).puedeActuar;
  const r = puedeActuar({ peldano: "reiniciar_servidor" }, { S: S_BOT_ARRIBA });
  assert.strictEqual(r.ok, true);
});

test("reiniciar_en_orden respeta el límite por contenedor (antes no se consultaba)", () => {
  const puedeActuar = crear({
    limites: limitesPermisivos({ puede: (_accion, ctx) => (ctx.objetivo === "zeus-chromadb" ? { ok: false, codigo: "tope_hora", motivo: "tope" } : { ok: true }) }),
  });
  const r = puedeActuar({ peldano: "reiniciar_en_orden", objetivo: ["zeus-mariadb", "zeus-chromadb", "zeus-bot"] }, { S: S_BOT_ARRIBA });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.fuente, "limite");
});

test("reiniciar_en_orden permitido cuando todos los contenedores están dentro del límite", () => {
  const puedeActuar = crear();
  const r = puedeActuar({ peldano: "reiniciar_en_orden", objetivo: ["zeus-mariadb", "zeus-bot"] }, { S: S_BOT_ARRIBA });
  assert.strictEqual(r.ok, true);
});

test("orden de precedencia: freno gana aunque también falten permisos", () => {
  const puedeActuar = crear({
    reglasSeguridad: reglasPermisivas({ frenoActivo: () => true }),
    permisos: permisosPermisivos({ verificarEscritura: () => ({ ok: false, mensaje: "apagado" }) }),
  });
  const r = puedeActuar({ peldano: "reiniciar_contenedor", objetivo: "zeus-bot" }, {});
  assert.strictEqual(r.fuente, "freno");
});
