"use strict";
/**
 * Centinela Zeus — anti-bloqueos de base de datos (Top-10 #8).
 *
 * Lee `information_schema.PROCESSLIST` de MariaDB y señala las conexiones
 * que llevan más de un umbral esperando por un bloqueo ("Consulta
 * trabada"), para que el panel avise y ofrezca detenerla con un clic.
 *
 * Sin persistencia: es una foto en vivo, igual que ya hace `estadoDatos()`
 * en ops-server.js con las consultas lentas. Por defecto **solo informa**;
 * el `KILL` es una acción aparte que solo se ejecuta si el panel la llama
 * con aprobación explícita del dueño (ver INTEGRACION-OBSERVABILIDAD.md).
 * Un auto-kill queda fuera de este módulo: matar la consulta equivocada
 * puede tumbar una venta en curso.
 *
 * Recibe `mysql()` de ops-server.js como parámetro, mismo patrón de bajo
 * acoplamiento que ya usa `db-optimizacion.js`.
 */

// Segundos a partir de los cuales una espera por bloqueo se considera
// "trabada" y se avisa. Coincide con lo pedido en el diseño (§4, fila #8).
const UMBRAL_TRABADA_S = 15;

// Estados de MariaDB que indican que la conexión está esperando algo (un
// bloqueo de fila, de tabla o de metadatos), no trabajando de verdad. Una
// consulta larga en "Sending data"/"executing" es lenta, no trabada, así
// que no cuenta aquí (eso ya lo cubre `estadoDatos().consultas_lentas`).
const RE_ESPERANDO = /lock/i;

function segundosATexto(s) {
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)} min ${s % 60}s`;
}

/**
 * Ejecuta la consulta al PROCESSLIST y clasifica cada conexión. Devuelve
 * todo en español claro ("Consulta trabada" en vez de "query locked"),
 * listo para el panel.
 *
 * @param {Function} mysql            mysql(consulta) de ops-server.js
 * @param {number}   [umbralSegundos] por defecto UMBRAL_TRABADA_S
 */
async function listarProcesos(mysql, umbralSegundos) {
  if (typeof mysql !== "function") throw new Error("listarProcesos necesita la función mysql() de ops-server.js");
  const umbral = Number.isFinite(umbralSegundos) ? umbralSegundos : UMBRAL_TRABADA_S;

  const r = await mysql(
    "SELECT Id, User, Host, db, Command, Time, State, " +
    "REPLACE(REPLACE(LEFT(IFNULL(Info,''),300),'\\n',' '),'\\t',' ') AS Consulta " +
    "FROM information_schema.PROCESSLIST ORDER BY Time DESC;"
  );

  if (!r.ok) {
    return {
      ok: false,
      mensaje: "No se pudo consultar la base de datos. Puede estar caída o reiniciándose.",
      umbral_segundos: umbral,
      procesos: [],
      trabadas: [],
      hay_trabadas: false,
      resumen: "Sin datos: no se pudo consultar la base de datos.",
      generado: new Date().toISOString(),
    };
  }

  const procesos = r.salida.split("\n").filter(Boolean).map((linea) => {
    const [id, usuario, host, base, comando, tiempo, estado, consulta] = linea.split("\t");
    const segundos = parseInt(tiempo || "0", 10) || 0;
    const cmd = (comando || "").toLowerCase();
    const trabada = cmd !== "sleep" && segundos >= umbral && RE_ESPERANDO.test(estado || "");
    return {
      id: parseInt(id, 10),
      usuario: usuario || "",
      host: host || "",
      base: base && base !== "NULL" ? base : null,
      comando: comando || "",
      segundos,
      tiempo_texto: segundosATexto(segundos),
      estado: estado || "",
      consulta: consulta && consulta !== "NULL" ? consulta : "",
      trabada,
    };
  }).filter((p) => p.comando.toLowerCase() !== "sleep" || p.trabada); // oculta conexiones inactivas normales

  const trabadas = procesos.filter((p) => p.trabada);

  return {
    ok: true,
    umbral_segundos: umbral,
    procesos,
    trabadas,
    hay_trabadas: trabadas.length > 0,
    resumen: trabadas.length
      ? `${trabadas.length} consulta(s) llevan más de ${umbral} s trabada(s) esperando un bloqueo.`
      : "Ninguna consulta lleva trabada más tiempo del esperado.",
    generado: new Date().toISOString(),
  };
}

/**
 * Detiene una conexión por su Id (`KILL <id>`). Valida que sea un entero
 * positivo antes de tocar nada; nunca interpola texto libre en el SQL.
 *
 * Este es el único punto de este módulo con poder real sobre producción:
 * se espera que quien lo llame ya haya pedido confirmación al dueño en el
 * panel (ver INTEGRACION-OBSERVABILIDAD.md, que documenta el anti-CSRF
 * exacto a aplicar en la ruta HTTP).
 */
async function matarProceso(mysql, id) {
  if (typeof mysql !== "function") throw new Error("matarProceso necesita la función mysql() de ops-server.js");
  const texto = String(id === undefined || id === null ? "" : id).trim();
  const pid = parseInt(texto, 10);
  if (!/^\d+$/.test(texto) || !Number.isInteger(pid) || pid <= 0) {
    return { ok: false, mensaje: "Identificador de proceso no válido" };
  }
  const r = await mysql(`KILL ${pid};`);
  return {
    ok: r.ok,
    mensaje: r.ok ? `Consulta ${pid} detenida` : "No se pudo detener la consulta (puede que ya haya terminado sola)",
    id: pid,
  };
}

module.exports = {
  listarProcesos,
  matarProceso,
  UMBRAL_TRABADA_S,
};
