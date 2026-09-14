"use strict";
// Nombre de la base de datos que se vigila. Se lee en cada llamada (no al cargar
// el módulo) porque server.js lo fija desde el .env después de los require.
const esquema = () => process.env.DB_ESQUEMA || "negocio";
/**
 * Centinela Zeus — módulo de optimización de base de datos.
 *
 * Trabaja sobre las consultas lentas que ya detecta `estadoDatos()` en
 * ops-server.js (que a su vez usa /opt/zeus-ops/slowlog.awk para separar
 * las consultas de respaldo, marcadas con SQL_NO_CACHE, de las consultas
 * reales de la aplicación). Este módulo NO vuelve a parsear el log: recibe
 * la lista ya parseada y solo mira el texto SQL para detectar patrones
 * típicos de falta de índice.
 *
 * No se conecta a MariaDB por su cuenta. Todas las funciones que necesitan
 * hablar con la base reciben la función `mysql()` de ops-server.js como
 * parámetro, siguiendo el mismo patrón de bajo acoplamiento que ya usa
 * `medirImpacto` en el diseño de este módulo.
 *
 * Aislado a propósito: nada de lo que hay aquí se ejecuta solo. Otro
 * ingeniero decide cuándo conectarlo (ver modulos/INTEGRACION.md).
 */

// ── Detección de patrones ────────────────────────────────────────────────────

// Palabras reservadas de SQL que nunca son nombre de columna o de tabla.
const RESERVADAS = new Set([
  "and", "or", "not", "null", "is", "in", "like", "between", "exists",
  "select", "from", "where", "order", "group", "by", "limit", "join",
  "inner", "left", "right", "outer", "on", "as", "distinct", "having",
  "asc", "desc", "true", "false", "now",
]);

function limpiarIdentificador(s) {
  return (s || "").replace(/[`'"]/g, "").trim();
}

/**
 * Lista los alias de tabla usados en un FROM/JOIN ("... phppos_sales_items a
 * JOIN phppos_sales_items b ON ..."). El registro lento que llega desde el
 * log a veces está cortado a la mitad de un JOIN (el propio log lo trunca),
 * y ahí el patrón de columna de JOIN puede capturar el alias de una tabla
 * ("a") como si fuera nombre de columna. Se usa para descartar esos casos:
 * un identificador que en la misma consulta es alias de tabla nunca es
 * columna (bug real, encontrado probando en vivo el 14-sep-2026: generaba
 * la sugerencia falsa "tabla phppos_sales, columna a").
 */
function aliasDeTablas(sql) {
  const alias = new Set();
  const re = /\b(?:from|join)\s+[a-zA-Z0-9_.`]+\s+(?:as\s+)?([a-zA-Z0-9_]+)/gi;
  let m;
  while ((m = re.exec(sql))) {
    const a = limpiarIdentificador(m[1]);
    if (a && !RESERVADAS.has(a.toLowerCase())) alias.add(a);
  }
  return alias;
}

/** Saca el nombre de la tabla principal de un SELECT/UPDATE/DELETE simple. */
function tablaPrincipal(sql) {
  const m = sql.match(/\bfrom\s+([a-zA-Z0-9_.`]+)/i) || sql.match(/\bupdate\s+([a-zA-Z0-9_.`]+)/i);
  if (!m) return null;
  const cruda = limpiarIdentificador(m[1]);
  return cruda.split(".").pop(); // quita el prefijo de esquema si lo trae
}

/**
 * Detecta columnas usadas en WHERE con comparación de igualdad o rango,
 * columnas de ORDER BY, y la llave del lado derecho de un JOIN.
 * Son expresiones simples a propósito: el objetivo es encontrar candidatos
 * a revisar, no reemplazar un EXPLAIN real (eso lo hace medirImpacto).
 */
function extraerPatrones(sql) {
  const hallazgos = [];
  const tabla = tablaPrincipal(sql);
  if (!tabla) return hallazgos;
  const alias = aliasDeTablas(sql);
  const esColumnaValida = (col) => col && !RESERVADAS.has(col.toLowerCase()) && !alias.has(col);

  // WHERE columna = / > / < / >= / <= valor  (o comparada con ?)
  const reWhere = /\bwhere\b([\s\S]*?)(?:\bgroup\s+by\b|\border\s+by\b|\blimit\b|$)/i;
  const bloqueWhere = (sql.match(reWhere) || [, ""])[1];
  const reCol = /([a-zA-Z0-9_`]+)\s*(=|>=|<=|>|<|<>|!=)\s*(\?|'[^']*'|"[^"]*"|\d+)/g;
  let m;
  while ((m = reCol.exec(bloqueWhere))) {
    const col = limpiarIdentificador(m[1]).split(".").pop();
    if (!esColumnaValida(col)) continue;
    hallazgos.push({ tabla, columnas: [col], tipo: "where_igualdad" });
  }

  // WHERE columna IN (...)
  const reIn = /([a-zA-Z0-9_`]+)\s+in\s*\(/gi;
  while ((m = reIn.exec(bloqueWhere))) {
    const col = limpiarIdentificador(m[1]).split(".").pop();
    if (!esColumnaValida(col)) continue;
    hallazgos.push({ tabla, columnas: [col], tipo: "where_in" });
  }

  // ORDER BY columna(s)
  const reOrder = /\border\s+by\s+([a-zA-Z0-9_`.,\s]+?)(?:\blimit\b|$)/i;
  const ob = sql.match(reOrder);
  if (ob) {
    const cols = ob[1].split(",").map((c) => limpiarIdentificador(c.replace(/\b(asc|desc)\b/gi, "")).trim().split(".").pop()).filter(esColumnaValida);
    if (cols.length) hallazgos.push({ tabla, columnas: cols, tipo: "order_by" });
  }

  // JOIN otra_tabla ON a.x = b.y  → candidato en la llave foránea del lado unido
  const reJoin = /\bjoin\s+([a-zA-Z0-9_.`]+)(?:\s+(?:as\s+)?([a-zA-Z0-9_]+))?\s+on\s+([a-zA-Z0-9_`.]+)\s*=\s*([a-zA-Z0-9_`.]+)/gi;
  while ((m = reJoin.exec(sql))) {
    const tablaUnida = limpiarIdentificador(m[1]).split(".").pop();
    const aliasUnida = m[2];
    const izq = limpiarIdentificador(m[3]);
    const der = limpiarIdentificador(m[4]);
    // Se queda con la columna del lado que corresponde a la tabla recién unida.
    for (const lado of [izq, der]) {
      const [pref, col] = lado.includes(".") ? lado.split(".") : [null, lado];
      if (!esColumnaValida(col)) continue;
      if (pref === tablaUnida || pref === aliasUnida || pref === null) {
        hallazgos.push({ tabla: tablaUnida, columnas: [col], tipo: "join_llave" });
      }
    }
  }

  return hallazgos;
}

const ETIQUETA_TIPO = {
  where_igualdad: "Búsqueda por igualdad o rango (WHERE)",
  where_in: "Búsqueda por lista de valores (WHERE ... IN)",
  order_by: "Ordenamiento (ORDER BY)",
  join_llave: "Combinación de tablas (JOIN)",
};

/**
 * Analiza una lista de consultas lentas ya parseadas (con { sql, segundos,
 * accionable, ... } como las devuelve estadoDatos() en ops-server.js) y
 * agrupa los patrones repetidos en sugerencias de índice.
 *
 * No toca la base de datos: es análisis de texto puro.
 */
/**
 * @param {Array}  consultasLentas
 * @param {Array}  [vistas] nombres de VIEW (no tabla) de este esquema. Sobre
 *   una vista no se puede ADD INDEX — MariaDB lo rechaza siempre. Sin esta
 *   lista, `comando` se genera igual y el botón "Aplicar" del panel falla en
 *   cada intento sin explicar por qué (bug real, encontrado probando en vivo
 *   el 13-sep-2026). Con la lista, la sugerencia sale marcada `es_vista` y
 *   sin `comando`, y el panel no ofrece un botón que sabe que va a fallar.
 * @param {Object} [columnasIndexadas] mapa tabla → Set de columnas que ya son
 *   la columna líder de algún índice existente (incluida PRIMARY). Sin esto,
 *   `analizarPatrones` puede sugerir un índice que ya existe en la práctica
 *   (bug real, encontrado probando en vivo el 14-sep-2026: de 5 sugerencias
 *   "reales" ese día, las 5 ya estaban cubiertas por un índice existente).
 *   Con el mapa, la sugerencia sale marcada `ya_cubierto` y sin `comando`.
 */
function analizarPatrones(consultasLentas, vistas, columnasIndexadas) {
  const lista = Array.isArray(consultasLentas) ? consultasLentas : [];
  const setVistas = new Set(Array.isArray(vistas) ? vistas : []);
  const indexadas = columnasIndexadas && typeof columnasIndexadas === "object" ? columnasIndexadas : {};
  const grupos = new Map(); // clave: tabla|col1,col2|tipo

  for (const c of lista) {
    if (!c || !c.sql) continue;
    if (c.accionable === false) continue; // respaldo: no hay nada que indexar ahí
    const patrones = extraerPatrones(c.sql);
    for (const p of patrones) {
      const clave = `${p.tabla}|${p.columnas.join(",")}|${p.tipo}`;
      if (!grupos.has(clave)) {
        grupos.set(clave, {
          tabla: p.tabla,
          columnas: p.columnas,
          tipo: p.tipo,
          repeticiones: 0,
          segundos_total: 0,
          ejemplo_sql: c.sql.slice(0, 200),
        });
      }
      const g = grupos.get(clave);
      g.repeticiones += 1;
      g.segundos_total += Number(c.segundos) || 0;
    }
  }

  const sugerencias = [...grupos.values()]
    .filter((g) => g.repeticiones >= 1)
    .map((g) => {
      const nombreIndice = `idx_${g.tabla}_${g.columnas.join("_")}`.slice(0, 64).replace(/[^a-zA-Z0-9_]/g, "_");
      const columnasSql = g.columnas.map((c) => `\`${c}\``).join(", ");
      const esVista = setVistas.has(g.tabla);
      // Basta con que la primera columna ya sea líder de un índice existente:
      // por la regla del prefijo izquierdo, ese índice ya acelera este caso.
      const colLideresTabla = indexadas[g.tabla];
      const yaCubierto = !esVista && colLideresTabla && colLideresTabla.has
        ? colLideresTabla.has(g.columnas[0])
        : false;
      return {
        tabla: g.tabla,
        columnas: g.columnas,
        tipo_consulta: ETIQUETA_TIPO[g.tipo] || g.tipo,
        repeticiones: g.repeticiones,
        segundos_acumulados: +g.segundos_total.toFixed(2),
        ejemplo_sql: g.ejemplo_sql,
        es_vista: esVista,
        ya_cubierto: yaCubierto,
        comando: (esVista || yaCubierto) ? null : `ALTER TABLE \`${esquema()}\`.\`${g.tabla}\` ADD INDEX \`${nombreIndice}\` (${columnasSql}), ALGORITHM=INPLACE, LOCK=NONE;`,
      };
    })
    .sort((a, b) => b.segundos_acumulados - a.segundos_acumulados || b.repeticiones - a.repeticiones);

  return sugerencias;
}

// ── Medición de impacto (antes / después) ───────────────────────────────────

/** Extrae "rows" del EXPLAIN en formato tabular (-N -B de mysql). */
function filasExaminadas(salidaExplain) {
  // Con -N -B, EXPLAIN devuelve columnas separadas por tabulador en el orden
  // fijo: id, select_type, table, ..., rows, Extra (varía según versión, así
  // que se busca el primer campo puramente numérico razonable como filas).
  const filas = salidaExplain.split("\n").filter(Boolean);
  if (!filas.length) return null;
  const campos = filas[0].split("\t");
  // La columna "rows" suele ser la única numérica grande entre 'ref' y 'Extra'.
  const candidatos = campos.filter((c) => /^\d+$/.test(c)).map(Number);
  return candidatos.length ? Math.max(...candidatos) : null;
}

/**
 * Ejecuta EXPLAIN sobre una consulta de ejemplo (SELECT * FROM tabla WHERE
 * columna = valor de muestra LIMIT 1) antes y después de crear un índice
 * candidato, y compara las filas examinadas.
 *
 * Recibe `mysql` (la función de ops-server.js) para no acoplarse a la
 * conexión real: en producción se le pasa la de verdad, en pruebas se le
 * puede pasar una función simulada.
 *
 * No crea el índice: solo mide. La creación real la hace `aplicarIndice`.
 */
async function medirImpacto(mysql, tabla, columna) {
  if (typeof mysql !== "function") throw new Error("medirImpacto necesita la función mysql() de ops-server.js");
  if (!/^[a-zA-Z0-9_]+$/.test(tabla) || !/^[a-zA-Z0-9_]+$/.test(columna)) {
    return { ok: false, error: "Nombre de tabla o columna no válido" };
  }

  // Valor de muestra: el primero que exista en esa columna, para que el
  // EXPLAIN sea representativo y no un caso vacío.
  const muestra = await mysql(`SELECT \`${columna}\` FROM \`${esquema()}\`.\`${tabla}\` WHERE \`${columna}\` IS NOT NULL LIMIT 1;`);
  const valor = (muestra.salida || "").split("\n")[0];
  if (!muestra.ok || valor === undefined || valor === "") {
    return { ok: false, error: "No se pudo obtener un valor de muestra de esa columna" };
  }
  const valorEscapado = valor.replace(/'/g, "''");
  const consulta = `EXPLAIN SELECT * FROM \`${esquema()}\`.\`${tabla}\` WHERE \`${columna}\` = '${valorEscapado}';`;

  const antes = await mysql(consulta);
  const filasAntes = filasExaminadas(antes.salida);

  return {
    ok: true,
    tabla, columna,
    filas_antes: filasAntes,
    // El "después" solo tiene sentido una vez aplicado el índice real; se
    // deja como función aparte para no crear nada por accidente al medir.
    medirDespues: async () => {
      const despues = await mysql(consulta);
      const filasDespues = filasExaminadas(despues.salida);
      return {
        ok: true, tabla, columna,
        filas_antes: filasAntes,
        filas_despues: filasDespues,
        mejora_pct: filasAntes && filasDespues !== null && filasAntes > 0
          ? Math.round((1 - filasDespues / filasAntes) * 100)
          : null,
      };
    },
  };
}

// ── Aplicación segura del índice ─────────────────────────────────────────────

/**
 * Solo permite CREATE INDEX o DROP INDEX, con o sin ALGORITHM/LOCK, y solo
 * sobre identificadores simples (letras, números, guión bajo, backticks y
 * puntos para el esquema). Cualquier otra cosa se rechaza sin ejecutar nada.
 *
 * Este código corre con privilegios de root sobre la base de datos, así que
 * la validación es deliberadamente estricta: mejor rechazar un comando
 * válido raro que dejar pasar algo que no sea un índice.
 */
const RE_COMANDO_PERMITIDO = new RegExp(
  "^\\s*(CREATE\\s+(UNIQUE\\s+)?INDEX\\s+`?[a-zA-Z0-9_]+`?\\s+ON\\s+`?[a-zA-Z0-9_]+`?\\.?`?[a-zA-Z0-9_]*`?\\s*\\(\\s*`?[a-zA-Z0-9_]+`?(\\s*,\\s*`?[a-zA-Z0-9_]+`?)*\\s*\\)\\s*(,?\\s*ALGORITHM\\s*=\\s*(INPLACE|COPY|DEFAULT))?\\s*(,?\\s*LOCK\\s*=\\s*(NONE|SHARED|EXCLUSIVE|DEFAULT))?" +
  "|ALTER\\s+TABLE\\s+`?[a-zA-Z0-9_]+`?\\.?`?[a-zA-Z0-9_]*`?\\s+ADD\\s+(UNIQUE\\s+)?INDEX\\s+`?[a-zA-Z0-9_]+`?\\s*\\(\\s*`?[a-zA-Z0-9_]+`?(\\s*,\\s*`?[a-zA-Z0-9_]+`?)*\\s*\\)\\s*(,\\s*ALGORITHM\\s*=\\s*(INPLACE|COPY|DEFAULT))?\\s*(,\\s*LOCK\\s*=\\s*(NONE|SHARED|EXCLUSIVE|DEFAULT))?" +
  "|DROP\\s+INDEX\\s+`?[a-zA-Z0-9_]+`?\\s+ON\\s+`?[a-zA-Z0-9_]+`?\\.?`?[a-zA-Z0-9_]*`?\\s*(,?\\s*ALGORITHM\\s*=\\s*(INPLACE|COPY|DEFAULT))?\\s*(,?\\s*LOCK\\s*=\\s*(NONE|SHARED|EXCLUSIVE|DEFAULT))?)" +
  "\\s*;?\\s*$",
  "i"
);

/**
 * Ejecuta un CREATE INDEX / ALTER TABLE ADD INDEX / DROP INDEX ya validado,
 * con ALGORITHM=INPLACE, LOCK=NONE cuando aplica, mide cuánto tardó y
 * devuelve éxito o fracaso con el detalle. Nunca ejecuta nada que no pase
 * la expresión regular estricta de arriba.
 */
async function aplicarIndice(mysql, comandoSQL) {
  if (typeof mysql !== "function") throw new Error("aplicarIndice necesita la función mysql() de ops-server.js");
  const comando = String(comandoSQL || "").trim();

  if (!RE_COMANDO_PERMITIDO.test(comando)) {
    return { ok: false, mensaje: "Comando rechazado: solo se permite CREATE INDEX, ALTER TABLE ADD INDEX o DROP INDEX", comando };
  }
  // Defensa adicional: ni una sola palabra clave peligrosa, ni separador de
  // sentencias, puede colarse aunque la forma general calce con el patrón.
  if (/;.*\S/.test(comando.replace(/;\s*$/, "")) || /\b(DROP\s+TABLE|DROP\s+DATABASE|DELETE|UPDATE|INSERT|GRANT|TRUNCATE|SHUTDOWN)\b/i.test(comando)) {
    return { ok: false, mensaje: "Comando rechazado: contiene una instrucción no permitida", comando };
  }

  const inicio = Date.now();
  const r = await mysql(comando);
  const ms = Date.now() - inicio;

  return {
    ok: r.ok,
    mensaje: r.ok ? `Índice aplicado en ${(ms / 1000).toFixed(1)} s` : "Falló al aplicar el índice",
    ms,
    comando,
    salida: r.salida || r.error || "",
  };
}

// ── Pasar una tabla MyISAM a InnoDB ──────────────────────────────────────────

// Nombre de tabla simple: letras, números, guión bajo. Nada de puntos ni
// backticks — a diferencia de `aplicarIndice`, aquí el nombre lo arma esta
// función (no llega un comando completo de fuera), así que el identificador
// puede ser aún más estricto.
const RE_TABLA_SIMPLE = /^[a-zA-Z0-9_]+$/;

/**
 * Convierte una tabla de MyISAM a InnoDB (`ALTER TABLE … ENGINE=InnoDB`).
 * Es el único cambio de motor que este módulo sabe hacer — nunca toca el
 * esquema de ninguna otra forma (no agrega columnas, no crea llaves
 * primarias: eso requiere elegir qué columna es la llave, y eso le toca a
 * una persona, no a Centinela). Bloquea escrituras en esa tabla mientras
 * corre; en una tabla grande puede tardar.
 */
async function cambiarMotorInnoDB(mysql, tabla) {
  if (typeof mysql !== "function") throw new Error("cambiarMotorInnoDB necesita la función mysql() de ops-server.js");
  const nombre = String(tabla || "").trim();
  if (!RE_TABLA_SIMPLE.test(nombre)) {
    return { ok: false, mensaje: "Nombre de tabla no válido", tabla: nombre };
  }
  // La base no queda seleccionada por defecto en la conexión de mysql() — sin
  // el esquema explícito, MariaDB no encuentra la tabla (mismo motivo por el
  // que el índice sugerido de más arriba, línea ~153, también lo lleva).
  const comando = `ALTER TABLE \`${esquema()}\`.\`${nombre}\` ENGINE=InnoDB;`;
  const inicio = Date.now();
  const r = await mysql(comando);
  const ms = Date.now() - inicio;
  return {
    ok: r.ok,
    mensaje: r.ok ? `${nombre} pasó a InnoDB en ${(ms / 1000).toFixed(1)} s` : "No se pudo cambiar el motor de la tabla",
    ms,
    comando,
    tabla: nombre,
    salida: r.salida || r.error || "",
  };
}

// ── OPTIMIZE TABLE (desfragmentar una tabla grande) ─────────────────────────

/**
 * Reconstruye una tabla para recuperar el espacio libre que dejaron los
 * borrados/actualizaciones (`OPTIMIZE TABLE`). En InnoDB equivale a un
 * `ALTER TABLE ... ENGINE=InnoDB` por debajo: copia la tabla a un archivo
 * nuevo y sustituye la vieja — no borra filas, no cambia datos. Bloquea
 * escrituras en esa tabla mientras corre; en una tabla grande puede tardar
 * varios minutos. Mismo patrón de seguridad que `cambiarMotorInnoDB`: nombre
 * de tabla estricto, sin aceptar un comando armado fuera de esta función.
 */
async function optimizarTabla(mysql, tabla) {
  if (typeof mysql !== "function") throw new Error("optimizarTabla necesita la función mysql() de ops-server.js");
  const nombre = String(tabla || "").trim();
  if (!RE_TABLA_SIMPLE.test(nombre)) {
    return { ok: false, mensaje: "Nombre de tabla no válido", tabla: nombre };
  }
  const comando = `OPTIMIZE TABLE \`${esquema()}\`.\`${nombre}\`;`;
  const inicio = Date.now();
  const r = await mysql(comando);
  const ms = Date.now() - inicio;
  return {
    ok: r.ok,
    mensaje: r.ok ? `${nombre} quedó desfragmentada en ${(ms / 1000).toFixed(1)} s` : "No se pudo desfragmentar la tabla",
    ms,
    comando,
    tabla: nombre,
    salida: r.salida || r.error || "",
  };
}

// ── Ajustes de variables globales, sin reiniciar MariaDB ────────────────────
//
// max_connections y key_buffer_size son variables DINÁMICAS: SET GLOBAL las
// cambia de inmediato en el proceso que ya corre, sin bloquear tablas ni
// reiniciar el contenedor (a diferencia de innodb_buffer_pool_size — que sí
// puede cambiar en caliente pero dispara un realojo interno costoso en una
// máquina de 4 GB, así que ese no se toca sin que lo decida una persona).

// Techo duro: en una máquina de 4 GB compartida con el bot y ChromaDB, cada
// conexión reserva memoria — subir esto sin límite puede agotar la RAM.
const TECHO_MAX_CONNECTIONS = 500;

/**
 * Sube max_connections cuando el tope real se está quedando corto. El valor
 * lo calcula pasoConexiones() en optimizacion-completa.js (con base en el
 * pico real de uso); aquí solo se aplica, con el techo duro de arriba como
 * última línea de defensa contra un valor absurdo.
 */
async function subirMaxConnections(mysql, valor) {
  if (typeof mysql !== "function") throw new Error("subirMaxConnections necesita la función mysql() de ops-server.js");
  const n = Number(valor);
  if (!Number.isInteger(n) || n < 50 || n > TECHO_MAX_CONNECTIONS) {
    return { ok: false, mensaje: `El valor debe ser un entero entre 50 y ${TECHO_MAX_CONNECTIONS}`, valor };
  }
  const comando = `SET GLOBAL max_connections = ${n};`;
  const r = await mysql(comando);
  return {
    ok: r.ok,
    mensaje: r.ok ? `max_connections quedó en ${n}. No hizo falta reiniciar la base.` : "No se pudo subir max_connections",
    comando,
    valor: n,
    salida: r.salida || r.error || "",
  };
}

/**
 * Baja key_buffer_size a 8 MB cuando casi no hay tablas MyISAM (ver
 * pasoMemoria): esa memoria reservada no sirve para nada y se le puede
 * devolver al resto del servidor. Siempre el mismo valor fijo — no acepta
 * uno distinto desde fuera: si algún día hace falta MÁS key_buffer es porque
 * hay más tablas MyISAM, y decidir cuánto le toca a una persona, no a un
 * botón genérico.
 */
async function reducirKeyBuffer(mysql) {
  if (typeof mysql !== "function") throw new Error("reducirKeyBuffer necesita la función mysql() de ops-server.js");
  const comando = "SET GLOBAL key_buffer_size = 8388608;"; // 8 MB
  const r = await mysql(comando);
  return {
    ok: r.ok,
    mensaje: r.ok ? "key_buffer_size quedó en 8 MB. No hizo falta reiniciar la base." : "No se pudo bajar key_buffer_size",
    comando,
    salida: r.salida || r.error || "",
  };
}

// ── Resumen para la auditoría diaria ────────────────────────────────────────

/**
 * Arma un texto corto en español con las top 3 sugerencias de índice (si
 * las hay), listo para insertar en el resumen diario de Centinela.
 */
function resumenParaAuditoria(sugerencias) {
  const lista = Array.isArray(sugerencias) ? sugerencias : [];
  if (!lista.length) return "Optimización de base de datos: sin sugerencias nuevas.";

  const top3 = lista.slice(0, 3);
  const lineas = [`Optimización de base de datos: ${lista.length} ${lista.length === 1 ? "sugerencia" : "sugerencias"} de índice.`];
  top3.forEach((s, i) => {
    lineas.push(`${i + 1}. Tabla ${s.tabla}, columna(s) ${s.columnas.join(", ")} — se repite ${s.repeticiones} ${s.repeticiones === 1 ? "vez" : "veces"} en consultas lentas (${s.tipo_consulta.toLowerCase()}).`);
  });
  return lineas.join("\n");
}

module.exports = {
  analizarPatrones,
  medirImpacto,
  aplicarIndice,
  cambiarMotorInnoDB,
  optimizarTabla,
  subirMaxConnections,
  reducirKeyBuffer,
  TECHO_MAX_CONNECTIONS,
  resumenParaAuditoria,
  // Exportadas para pruebas y para que otro módulo pueda reutilizarlas.
  _interno: { extraerPatrones, tablaPrincipal, filasExaminadas, aliasDeTablas, RE_COMANDO_PERMITIDO, RE_TABLA_SIMPLE },
};
