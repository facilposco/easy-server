"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

/**
 * Auditoría automática de los botones de alto riesgo del panel.
 *
 * Nace de un bug real (14-sep-2026): el botón "Instalar" de actualizaciones
 * de seguridad ejecutaba la acción real al primer clic, sin pasar por el
 * modal de palabra escrita — se le olvidó `data-confirmar` al agregarlo.
 * CLAUDE.md es explícito: reiniciar el servidor, instalar actualizaciones
 * del sistema, aplicar un índice de base de datos y lanzar un simulacro son
 * las 4 acciones manuales que SIEMPRE deben pedir la palabra de confirmación
 * — ni siquiera al dueño se le deja hacerlas con un clic accidental.
 *
 * Esta prueba no ejecuta el panel (es HTML+JS de navegador, no un módulo
 * Node importable): lee app.js como texto y verifica, con reglas simples
 * pero deliberadamente estrictas, que cada mecanismo de alto riesgo sigue
 * pasando por el modal de confirmación. Si alguien agrega un botón nuevo de
 * alto riesgo sin cablear la confirmación, esta prueba debe fallar.
 */

const RUTA_APP_JS = path.join(__dirname, "..", "..", "public", "app.js");
const app = fs.readFileSync(RUTA_APP_JS, "utf8");

// ── Mecanismo 1: data-accion="X" + ejecutar()/abrirConfirmar por data-confirmar ──
// Toda acción de alto riesgo que se dispara con data-accion debe traer
// data-confirmar en la MISMA línea del botón (así es como ejecutar() decide
// si abre el modal).
const ACCIONES_ALTO_RIESGO = ["reiniciar_servidor", "actualizar_seguridad"];

test("botones data-accion de alto riesgo siempre traen data-confirmar", () => {
  for (const accion of ACCIONES_ALTO_RIESGO) {
    const lineas = app.split("\n").filter((l) => l.includes(`data-accion="${accion}"`));
    assert.ok(lineas.length > 0, `no se encontró ningún botón con data-accion="${accion}" — ¿cambió el nombre de la acción?`);
    for (const linea of lineas) {
      assert.ok(
        /data-confirmar\s*=/.test(linea),
        `el botón de "${accion}" no tiene data-confirmar en su misma línea — se ejecutaría sin pedir la palabra de confirmación:\n${linea.trim()}`
      );
    }
  }
});

// ── Mecanismo 2: data-X + abrirConfirmar(...) dentro del propio handler ─────
// Acciones que no usan data-accion genérico sino su propio manejador de
// click, pero que igual deben abrir el modal de palabra escrita antes de
// llamar a la API.
const HANDLERS_CON_ABRIR_CONFIRMAR = [
  { marcador: "[data-optim-aplicar]", motivo: "aplicar un índice de base de datos" },
  { marcador: "[data-eliminar-indice]", motivo: "eliminar un índice de base de datos" },
  { marcador: "[data-reparar-motor]", motivo: "cambiar el motor de una tabla (MyISAM → InnoDB)" },
  { marcador: "[data-optimizar-tabla]", motivo: "desfragmentar una tabla (OPTIMIZE TABLE)" },
  { marcador: "[data-reparar-permiso]", motivo: "corregir el permiso de un archivo sensible (chmod)" },
  { marcador: "[data-subir-conexiones]", motivo: "subir max_connections" },
  { marcador: "[data-reducir-key-buffer]", motivo: "bajar key_buffer_size" },
];

function bloqueDelHandler(marcador) {
  const inicio = app.indexOf(marcador);
  assert.ok(inicio >= 0, `no se encontró el manejador de ${marcador} — ¿se renombró?`);
  // El siguiente manejador de clic empieza con "var algo = e.target.closest(",
  // en la misma indentación de 4 espacios que usa todo este bloque de clicks.
  const siguiente = app.indexOf("\n    var ", inicio + marcador.length);
  return app.slice(inicio, siguiente > 0 ? siguiente : inicio + 2000);
}

test("los manejadores de clic de alto riesgo abren el modal de confirmación antes de llamar a la API", () => {
  for (const { marcador, motivo } of HANDLERS_CON_ABRIR_CONFIRMAR) {
    const bloque = bloqueDelHandler(marcador);
    assert.ok(
      /abrirConfirmar\s*\(/.test(bloque),
      `el manejador de ${marcador} (${motivo}) no llama a abrirConfirmar(...) — ejecutaría la acción sin pedir confirmación`
    );
    // La llamada a la API tiene que quedar DENTRO del callback de
    // abrirConfirmar, no antes: si postZeus/fetch aparece antes del propio
    // abrirConfirmar en el texto, la acción se dispararía sin esperar la
    // palabra escrita.
    const idxConfirmar = bloque.search(/abrirConfirmar\s*\(/);
    const idxPost = bloque.search(/\b(postZeus|fetch)\s*\(/);
    assert.ok(
      idxPost === -1 || idxPost > idxConfirmar,
      `el manejador de ${marcador} llama a la API antes (o fuera) de abrirConfirmar(...)`
    );
  }
});

// ── Mecanismo 3: simulacros, con su propio modal dedicado (sim-modal) ───────
test("lanzar un simulacro pasa por el modal dedicado, no ejecuta directo", () => {
  const inicio = app.indexOf('e.target.closest("[data-simulacro]")');
  assert.ok(inicio >= 0, "no se encontró el manejador de [data-simulacro] — ¿se renombró?");
  const bloque = app.slice(inicio, inicio + 300);
  assert.ok(
    /abrirModalSimulacro\s*\(/.test(bloque),
    "el manejador de [data-simulacro] no abre abrirModalSimulacro — podría lanzar el simulacro sin pedir la palabra de confirmación"
  );
  // Dentro del modal, el botón de lanzar debe seguir deshabilitado hasta que
  // el texto escrito coincida exactamente con la palabra pedida.
  assert.ok(
    /simOkBtn\.disabled\s*=\s*!confirmarPendiente|confirmarInput\.value\s*!==\s*confirmarPendiente\.palabra|simConfInput\.value\.trim\(\)\s*!==|simOkBtn\.disabled\s*=\s*.*simPalabra/.test(app) ||
      app.includes("simConfInput.addEventListener"),
    "no se encontró la validación de la palabra escrita para simulacros"
  );
});
