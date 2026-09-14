"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { repararPermisoArchivo, ARCHIVOS_SENSIBLES } = require("../seguridad-completa.js");

// repararPermisoArchivo: corrige el hallazgo "Permisos de archivos con
// contraseñas" (chmod 640). Único punto donde esta acción entra en contacto
// con el sistema de archivos como root, así que la prueba central es que
// SOLO acepta una ruta de la lista fija — nunca una que llegue del cliente.

test("repararPermisoArchivo: acepta una ruta de la lista fija y arma el chmod correcto", async () => {
  let comandoRecibido = null;
  const shFalso = async (c) => { comandoRecibido = c; return { ok: true, salida: "" }; };
  const ruta = ARCHIVOS_SENSIBLES[0];
  const r = await repararPermisoArchivo(shFalso, ruta);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(comandoRecibido, `chmod 640 ${ruta}`);
});

test("repararPermisoArchivo: rechaza cualquier ruta fuera de la lista fija", async () => {
  const shFalso = async () => { throw new Error("no debería llamarse"); };
  const r = await repararPermisoArchivo(shFalso, "/etc/shadow");
  assert.strictEqual(r.ok, false);
  assert.match(r.mensaje, /no está en la lista/);
});

test("repararPermisoArchivo: rechaza un intento de inyección de comando disfrazado de ruta", async () => {
  const shFalso = async () => { throw new Error("no debería llamarse"); };
  const r = await repararPermisoArchivo(shFalso, "/opt/zeus-app/.env; rm -rf /");
  assert.strictEqual(r.ok, false);
});

test("repararPermisoArchivo: propaga el fallo cuando chmod no puede aplicarse", async () => {
  const shFalso = async () => ({ ok: false, error: "permiso denegado" });
  const r = await repararPermisoArchivo(shFalso, ARCHIVOS_SENSIBLES[0]);
  assert.strictEqual(r.ok, false);
  assert.match(r.mensaje, /No se pudo cambiar/);
});
