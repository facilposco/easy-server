"use strict";
/**
 * Centinela Zeus — permisos por categoría: qué puede VIGILAR (lectura) y qué
 * puede ARREGLAR SOLA (escritura) cada parte del sistema, sin pedir
 * confirmación. Todo empieza en `true` (el comportamiento de siempre): esto
 * no resta nada hasta que el dueño apague algo a propósito desde el panel.
 *
 * Estos permisos se consultan en los puntos reales donde cada acción se
 * ejecuta (ver `INTEGRACION-PERMISOS.md`), nunca se inventan ni se simulan:
 * si `escritura` está apagada para una categoría, esa acción se rechaza con
 * un mensaje claro en vez de fallar en silencio.
 */

const path = require("path");

const CATEGORIAS = [
  { id: "contenedores", titulo: "Contenedores", descripcion: "Reiniciar o detener zeus-bot, zeus-mariadb, zeus-chromadb, zeus-proxy" },
  { id: "base_datos", titulo: "Base de datos", descripcion: "Aplicar índices de optimización, detener consultas trabadas" },
  { id: "servidor", titulo: "Servidor completo", descripcion: "Reiniciar todo el servidor (último recurso del SOS)" },
  { id: "despliegue", titulo: "Despliegues", descripcion: "Deshacer el último despliegue del bot si lo causó" },
  { id: "disco", titulo: "Espacio en disco", descripcion: "Liberar archivos sobrantes cuando el disco se llena" },
  { id: "actualizaciones", titulo: "Actualizaciones del sistema", descripcion: "Instalar actualizaciones de seguridad del sistema operativo" },
  { id: "whatsapp", titulo: "Avisos por WhatsApp", descripcion: "Mandar solo los avisos automáticos de caídas (no afecta al menú /centinela)" },
  { id: "simulacros", titulo: "Simulacros", descripcion: "Lanzar pruebas de emergencia controladas" },
  { id: "ia", titulo: "Consultas a la IA", descripcion: "Preguntar a Gemini para explicar o redactar" },
  { id: "sos", titulo: "Protocolo SOS completo", descripcion: "Ejecutar el diagnóstico y reparación automática de punta a punta" },
];

function crearPermisos(deps) {
  const { DIR_DATOS, leerJson, guardarJson, auditar } = deps || {};
  if (!DIR_DATOS || typeof leerJson !== "function" || typeof guardarJson !== "function" || typeof auditar !== "function") {
    throw new Error("crearPermisos necesita DIR_DATOS, leerJson, guardarJson y auditar de ops-server.js");
  }
  const RUTA = path.join(DIR_DATOS, "permisos.json");

  function defecto() {
    const m = {};
    for (const c of CATEGORIAS) m[c.id] = { lectura: true, escritura: true };
    return m;
  }

  function leer() {
    const guardado = leerJson(RUTA, null);
    const base = defecto();
    if (!guardado) return base;
    // Combina con la base: si se agrega una categoría nueva en el futuro,
    // no rompe lo guardado — simplemente aparece habilitada por defecto.
    for (const c of CATEGORIAS) {
      if (guardado[c.id]) base[c.id] = { lectura: guardado[c.id].lectura !== false, escritura: guardado[c.id].escritura !== false };
    }
    return base;
  }

  /** ¿Se puede hacer `tipo` ("lectura"|"escritura") en la categoría `id`? */
  function permitido(id, tipo) {
    const m = leer();
    if (!m[id]) return true; // categoría desconocida: no se bloquea por error de nombre
    return m[id][tipo] !== false;
  }

  /** Igual que `permitido`, pero pensado para el punto donde se va a actuar:
   * si no hay permiso de escritura, devuelve el mensaje listo para mostrar. */
  function verificarEscritura(id, etiqueta) {
    if (permitido(id, "escritura")) return { ok: true };
    return { ok: false, mensaje: `"${etiqueta || id}" tiene la escritura desactivada en Permisos — Centinela no puede actuar ahí sola. Actívala en el panel o hazlo tú manualmente.` };
  }

  function guardar(nuevo, quien) {
    const actual = leer();
    for (const c of CATEGORIAS) {
      if (nuevo && nuevo[c.id]) {
        actual[c.id] = { lectura: nuevo[c.id].lectura !== false, escritura: nuevo[c.id].escritura !== false };
      }
    }
    guardarJson(RUTA, actual);
    auditar("permisos_cambiados", quien || "panel", "ok", JSON.stringify(actual));
    return actual;
  }

  function estado() {
    const m = leer();
    return CATEGORIAS.map((c) => ({ ...c, lectura: m[c.id].lectura, escritura: m[c.id].escritura }));
  }

  return { CATEGORIAS, permitido, verificarEscritura, guardar, estado };
}

module.exports = { crearPermisos };
