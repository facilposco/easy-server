"use strict";
/**
 * Centinela Zeus — Config drift (DISENO-FASE-CAOS.md §4 fila #6).
 *
 * El diseño dice que esto se AÑADE a `seguridad-auditoria.js`. Ese archivo
 * ya existe y lo está usando producción, así que a propósito NO se edita
 * aquí: este módulo vive aparte y expone un hallazgo con la MISMA forma que
 * ya usan `revisarCertificado`/`revisarPuertosInesperados`/
 * `revisarPicoIntentos` en seguridad-auditoria.js —
 * `{ id, titulo, severidad, significado, automatico, detalle }`, con las
 * mismas tres severidades que ese archivo ya usa: "ok" | "atencion" | "urgente".
 * La línea exacta para incorporarlo a `auditoriaCompleta()` está en
 * `INTEGRACION-RESILIENCIA.md`.
 *
 * Qué vigila: la huella (SHA-256) de los archivos dinámicos de Traefik en
 * `/opt/zeus-proxy/dynamic/` y de `config.json` (configuración estática de
 * Traefik, junto a ese mismo directorio). Se usa una lista FIJA de archivos
 * conocidos, no un glob `*.yml`, a propósito: así un archivo nuevo que
 * aparezca ahí (por ejemplo el `zzz-simulacro-503.yml` que crea el
 * simulacro de aislamiento, u otro que aparezca en el futuro) no dispara un
 * hallazgo por su sola existencia — solo se avisa si cambia uno de los
 * archivos que YA se conocían.
 *
 * Contenedores ajenos: `otro-proyecto-a_ejemplo.yml` y `otro-proyecto-b_ejemplo.yml`
 * pertenecen a otro proyecto del dueño (otro-proyecto-a, otro-proyecto-b). Este
 * módulo los vigila igual que los propios (avisa si cambian) pero JAMÁS los
 * toca ni sugiere una acción automática sobre ellos — `automatico` es
 * siempre `false` para cualquier hallazgo de este módulo, y el texto deja
 * claro cuando el archivo cambiado es ajeno.
 *
 * Mismo patrón de bajo acoplamiento que el resto: recibe `sh()` de
 * ops-server.js por parámetro, no ejecuta nada por su cuenta, no se conecta
 * a nada por SSH.
 */

const path = require("path");

const DIR_DYNAMIC = "/opt/zeus-proxy/dynamic";
const RUTA_CONFIG_JSON = "/opt/zeus-proxy/config.json";

// Lista fija y conocida (verificada contra el contexto real del servidor).
// Los dos primeros son de OTRO proyecto del dueño: nunca se tocan, solo se
// vigilan para avisar.
const ARCHIVOS_VIGILADOS = [
  { archivo: path.posix.join(DIR_DYNAMIC, "otro-proyecto-b_ejemplo.yml"), propio: false },
  { archivo: path.posix.join(DIR_DYNAMIC, "otro-proyecto-a_ejemplo.yml"), propio: false },
  { archivo: path.posix.join(DIR_DYNAMIC, "panel_ejemplo.yml"), propio: true },
  { archivo: path.posix.join(DIR_DYNAMIC, "servidor_ejemplo.yml"), propio: true },
  { archivo: path.posix.join(DIR_DYNAMIC, "ventas_ejemplo.yml"), propio: true },
  { archivo: path.posix.join(DIR_DYNAMIC, "zeus_ejemplo.yml"), propio: true },
  { archivo: RUTA_CONFIG_JSON, propio: true },
  // Agregados el 12 sept. 2026: son justo los archivos que se tocaron al
  // rotar las contraseñas de MariaDB — si alguien los cambia por fuera de un
  // despliegue conocido (a mano, por error, o por un acceso indebido), antes
  // no había forma de enterarse. Solo se guarda el hash (sha256), nunca el
  // contenido: nunca se expone ninguna contraseña con esto.
  { archivo: "/opt/zeus-app/docker-compose.yml", propio: true },
  { archivo: "/opt/zeus-app/.env", propio: true },
  { archivo: "/opt/zeus-ops/.env", propio: true },
];

function crearConfigDrift(deps) {
  const { DIR_DATOS, leerJson, guardarJson } = deps || {};
  if (!DIR_DATOS || typeof leerJson !== "function" || typeof guardarJson !== "function") {
    throw new Error("crearConfigDrift necesita DIR_DATOS, leerJson y guardarJson de ops-server.js");
  }
  const RUTA_HASHES = path.join(DIR_DATOS, "hashes-config.json");

  /**
   * Calcula sha256 de cada archivo vigilado que exista. `sh()` se pasa en
   * cada llamada (no en la fábrica) porque así este módulo puede usarse
   * igual que `seguridadAuditoria.auditoriaCompleta(sh)`, recibiéndolo tal
   * cual lo tiene ops-server.js.
   *
   * @param {Function} sh función sh() de ops-server.js
   * @param {Object} [opciones]
   * @param {boolean} [opciones.enVentanaExcluida] true si hay un simulacro
   *   de aislamiento o un despliegue en curso (el llamador lo decide
   *   consultando esos otros módulos); en ese caso un cambio SOLO en
   *   archivos propios se reporta como "atencion" en vez de "urgente",
   *   porque es un cambio esperado.
   */
  async function revisarDrift(sh, opciones) {
    if (typeof sh !== "function") throw new Error("revisarDrift necesita la función sh() de ops-server.js");
    const opts = opciones || {};

    const rutas = ARCHIVOS_VIGILADOS.map((a) => a.archivo).join(" ");
    const r = await sh(`sha256sum ${rutas} 2>/dev/null`);
    const hashesActuales = {};
    for (const linea of r.salida.split("\n").filter(Boolean)) {
      const m = linea.match(/^([0-9a-f]{64})\s+\S*?([^/\s]+\/[^/\s]+)$/) || linea.match(/^([0-9a-f]{64})\s+(.+)$/);
      if (!m) continue;
      // Nos quedamos con la ruta completa que pasamos, no con la que devuelve
      // sha256sum, para no depender de si viene relativa o absoluta.
      const rutaCoincidente = ARCHIVOS_VIGILADOS.find((a) => linea.includes(a.archivo));
      if (rutaCoincidente) hashesActuales[rutaCoincidente.archivo] = m[1];
    }

    const previos = leerJson(RUTA_HASHES, {});
    const cambios = [];
    const faltantes = [];

    for (const { archivo, propio } of ARCHIVOS_VIGILADOS) {
      const actual = hashesActuales[archivo];
      const previo = previos[archivo];
      if (!actual) {
        faltantes.push(archivo);
        continue;
      }
      if (previo && previo !== actual) {
        cambios.push({ archivo, propio, antes: previo.slice(0, 12), ahora: actual.slice(0, 12) });
      }
    }

    // Guarda la huella actual como línea base para la próxima comprobación
    // (primera vez: guarda sin avisar nada, es la foto inicial).
    const esPrimeraVez = Object.keys(previos).length === 0;
    guardarJson(RUTA_HASHES, { ...previos, ...hashesActuales });

    if (esPrimeraVez) {
      return {
        id: "config_drift",
        titulo: "Cambios fuera de lo esperado en la configuración de la puerta de entrada",
        severidad: "ok",
        significado: "Se guardó la huella inicial de la configuración de Traefik. Los próximos cambios sin explicación se avisarán aquí.",
        automatico: false,
        detalle: `Archivos vigilados: ${ARCHIVOS_VIGILADOS.length}${faltantes.length ? ` · No encontrados: ${faltantes.join(", ")}` : ""}`,
      };
    }

    if (!cambios.length) {
      return {
        id: "config_drift",
        titulo: "Cambios fuera de lo esperado en la configuración de la puerta de entrada",
        severidad: "ok",
        significado: "La configuración de Traefik no cambió desde la última revisión.",
        automatico: false,
        detalle: `${ARCHIVOS_VIGILADOS.length} archivo(s) vigilados, sin cambios.`,
      };
    }

    const cambiosPropios = cambios.filter((c) => c.propio);
    const cambiosAjenos = cambios.filter((c) => !c.propio);
    const hayPropiosSinVentana = cambiosPropios.length > 0 && !opts.enVentanaExcluida;

    let severidad = "atencion";
    if (hayPropiosSinVentana) severidad = "urgente";

    const partes = [];
    if (cambiosPropios.length) {
      partes.push(
        opts.enVentanaExcluida
          ? `Cambió la configuración propia de ${cambiosPropios.map((c) => path.basename(c.archivo)).join(", ")}, dentro de una ventana esperada (despliegue o prueba en curso).`
          : `Cambió la configuración propia de ${cambiosPropios.map((c) => path.basename(c.archivo)).join(", ")} sin que hubiera un despliegue o una prueba en curso. Si nadie lo tocó a propósito, conviene revisarlo.`
      );
    }
    if (cambiosAjenos.length) {
      partes.push(
        `También cambió ${cambiosAjenos.map((c) => path.basename(c.archivo)).join(", ")}, que es de otro proyecto del dueño (no se toca desde aquí, solo se avisa).`
      );
    }

    return {
      id: "config_drift",
      titulo: "Cambios fuera de lo esperado en la configuración de la puerta de entrada",
      severidad,
      significado: partes.join(" "),
      automatico: false, // nunca se corrige solo: alguien tiene que confirmar si el cambio era intencional
      detalle: cambios.map((c) => `${path.basename(c.archivo)}: ${c.antes} → ${c.ahora}${c.propio ? "" : " (ajeno)"}`).join(" · "),
    };
  }

  return { revisarDrift };
}

module.exports = { crearConfigDrift, ARCHIVOS_VIGILADOS };
