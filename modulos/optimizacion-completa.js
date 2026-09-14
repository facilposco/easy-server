"use strict";
/**
 * Centinela Zeus — auditoría completa de la base de datos, con consola en vivo.
 *
 * Es el hermano de `seguridad-completa.js` pero para MariaDB: mismo patrón
 * (pasos secuenciales, cada uno devuelve {titulo, severidad, significado,
 * detalle}; consola en vivo por SSE con bus-sse.js; historial en un JSON
 * local) y misma regla de oro: SOLO LEE. Nunca ejecuta ALTER, DROP, OPTIMIZE
 * ni cambia una variable del servidor. Cada hallazgo explica qué significa y
 * qué convendría hacer; decidirlo sigue siendo trabajo de una persona.
 *
 * No reemplaza las sugerencias de índices que ya existen en la sección
 * Optimización (`db-optimizacion.js`, que trabaja sobre el registro de
 * consultas lentas): las complementa con lo que un ingeniero de bases de
 * datos revisaría en una máquina chica (4 GB de RAM) que comparte MariaDB
 * con el bot de WhatsApp y ChromaDB:
 *
 *  1. Conexiones abiertas vs. el tope, y conexiones abortadas.
 *  2. Aciertos del buffer pool de InnoDB (la métrica más importante aquí).
 *  3. Tablas sin clave primaria o en motor MyISAM.
 *  4. Fragmentación (espacio desperdiciado) en tablas grandes.
 *  5. Consultas que recorren tablas enteras una y otra vez.
 *  6. Índices duplicados o redundantes.
 *  7. Crecimiento de las tablas frente a la línea base guardada.
 *  8. Memoria reservada para la base frente a la RAM real de la máquina.
 *  9. Bloqueos y consultas trabadas.
 * 10. Sugerencias de índice ya generadas que siguen sin aplicarse.
 *
 * Recibe `mysql()` y `sh()` de ops-server.js por inyección, igual que
 * db-optimizacion.js y db-procesos.js: no abre conexiones por su cuenta y
 * reutiliza el escapado que ya está probado en producción.
 */

const path = require("path");
const { crearBus } = require("./sos/bus-sse.js");
const dbOptimizacion = require("./db-optimizacion.js");
const dbProcesos = require("./db-procesos.js");

const ESQUEMA_POR_DEFECTO = process.env.DB_ESQUEMA || "negocio";
const MB = 1048576;

// ── Utilidades de lectura (salida -N -B de mysql: columnas separadas por tab) ──

function filas(r) {
  if (!r || !r.ok) return [];
  return String(r.salida || "").split("\n").filter(Boolean).map((l) => l.split("\t"));
}

/** Convierte "SHOW ... STATUS/VARIABLES" (clave<tab>valor) en un objeto. */
function mapa(r) {
  const m = {};
  for (const [k, v] of filas(r)) m[k] = v;
  return m;
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function pct(parte, total) { return total > 0 ? Math.round((parte / total) * 1000) / 10 : 0; }
function mb(bytes) { return Math.round(num(bytes) / MB); }
function lista(arr, max = 6) {
  const a = arr.slice(0, max);
  return a.join(", ") + (arr.length > max ? ` y ${arr.length - max} más` : "");
}
function comillasSql(s) { return "'" + String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'"; }

/**
 * ¿Hay de verdad un índice nuevo que aceleraría esta consulta? Reutiliza el
 * mismo análisis que el panel de sugerencias (extraerPatrones de
 * db-optimizacion.js): si la tabla es una vista, o si la primera columna del
 * patrón ya es líder de un índice existente, un índice nuevo no cambia nada
 * — MariaDB ya lo tiene disponible y de todos modos barre la tabla porque le
 * conviene (columna poco selectiva) o porque el filtro real es un valor
 * calculado (SUM/MAX/COUNT de una vista), no una columna.
 */
function tieneArregloDeIndice(sql, vistas, columnasIndexadas) {
  const patrones = dbOptimizacion._interno.extraerPatrones(sql);
  return patrones.some((p) => {
    if (vistas.includes(p.tabla)) return false;
    const lideres = columnasIndexadas[p.tabla];
    return !(lideres && lideres.has(p.columnas[0]));
  });
}

/** Deja la consulta comparable: sin literales, sin espacios repetidos. */
function normalizarSql(sql) {
  return String(sql || "")
    .replace(/\s+/g, " ")
    .replace(/'[^']*'/g, "?")
    .replace(/"[^"]*"/g, "?")
    .replace(/\b\d+(\.\d+)?\b/g, "?")
    .trim()
    .slice(0, 300);
}

/**
 * Lee el registro de consultas lentas de MariaDB (vive dentro del
 * contenedor) y devuelve cada entrada con filas examinadas/enviadas. No usa
 * slowlog.awk porque ese script descarta justamente las líneas "# Rows_sent /
 * Rows_examined" que aquí son el dato central.
 */
function interpretarSlowLog(texto) {
  const entradas = [];
  let actual = null;
  for (const cruda of String(texto || "").split("\n")) {
    const linea = cruda.trim();
    if (!linea) continue;
    if (linea.startsWith("# Query_time:")) {
      const t = linea.match(/Query_time:\s*([\d.]+)/);
      const enviadas = linea.match(/Rows_sent:\s*(\d+)/);
      const examinadas = linea.match(/Rows_examined:\s*(\d+)/);
      actual = { segundos: t ? parseFloat(t[1]) : 0, enviadas: enviadas ? +enviadas[1] : 0, examinadas: examinadas ? +examinadas[1] : 0, sql: "" };
      continue;
    }
    if (linea.startsWith("#") || /^SET timestamp/i.test(linea) || /^use /i.test(linea) || linea.startsWith("/")) continue;
    if (!actual) continue;
    actual.sql = actual.sql ? actual.sql + " " + linea : linea;
    if (linea.endsWith(";")) { entradas.push(actual); actual = null; }
  }
  return entradas;
}

function crearOptimizacionCompleta(deps) {
  const { sh, mysql, DIR_DATOS, leerJson, guardarJson, auditar, estadoDatos } = deps || {};
  if (typeof sh !== "function" || typeof mysql !== "function" || !DIR_DATOS || typeof leerJson !== "function" || typeof guardarJson !== "function" || typeof auditar !== "function" || typeof estadoDatos !== "function") {
    throw new Error("crearOptimizacionCompleta necesita sh, mysql, DIR_DATOS, leerJson, guardarJson, auditar y estadoDatos de ops-server.js");
  }
  const ESQUEMA = (deps.esquema || ESQUEMA_POR_DEFECTO).replace(/[^a-zA-Z0-9_]/g, "");
  const ESQ = comillasSql(ESQUEMA);
  const RUTA_HIST = path.join(DIR_DATOS, "optimizacion-completa.json");
  let enCurso = null;
  let corridaActual = null; // promesa de la corrida en curso (para pruebas y para el cierre limpio)
  const bus = crearBus({ dirEventos: path.join(DIR_DATOS, "optimizacion-eventos"), enCurso: (id) => enCurso === id });

  // Datos que se leen una vez por corrida y comparten varios pasos.
  let ctx = {};

  async function cargarContexto() {
    const est = mapa(await mysql("SHOW GLOBAL STATUS WHERE Variable_name IN ('Threads_connected','Max_used_connections','Aborted_connects','Aborted_clients','Connections','Uptime','Innodb_buffer_pool_read_requests','Innodb_buffer_pool_reads','Innodb_buffer_pool_pages_total','Innodb_buffer_pool_pages_free','Innodb_buffer_pool_pages_data','Innodb_buffer_pool_wait_free','Select_scan','Select_full_join','Questions','Created_tmp_disk_tables','Created_tmp_tables','Innodb_row_lock_waits','Innodb_row_lock_time_max','Innodb_row_lock_current_waits','Innodb_deadlocks','Table_locks_waited','Slow_queries');"));
    const vars = mapa(await mysql("SHOW GLOBAL VARIABLES WHERE Variable_name IN ('max_connections','innodb_buffer_pool_size','performance_schema','slow_query_log','slow_query_log_file','long_query_time','key_buffer_size','tmp_table_size','max_heap_table_size','innodb_file_per_table','version');"));
    const tablas = filas(await mysql(
      "SELECT TABLE_NAME, ENGINE, IFNULL(TABLE_ROWS,0), IFNULL(DATA_LENGTH,0), IFNULL(INDEX_LENGTH,0), IFNULL(DATA_FREE,0), TABLE_TYPE " +
      `FROM information_schema.TABLES WHERE TABLE_SCHEMA=${ESQ} ORDER BY DATA_LENGTH+INDEX_LENGTH DESC;`
    )).map(([nombre, motor, filasN, datos, indices, libre, tipo]) => ({
      nombre, motor: motor === "NULL" ? null : motor, filas: num(filasN), datos_b: num(datos), indices_b: num(indices), libre_b: num(libre),
      es_vista: tipo === "VIEW",
    }));
    // Columna líder de cada índice existente por tabla (incluida PRIMARY) —
    // por la regla del prefijo izquierdo, ese índice ya cubre un filtro
    // simple sobre esa columna. Sin esto, el paso 5 (escaneos) no puede
    // distinguir "aquí un índice ayudaría de verdad" de "esto ya está
    // indexado y MariaDB decide barrer la tabla a propósito" (encontrado
    // revisando en vivo el 14-sep-2026: el 100% de lo marcado "para revisar"
    // ese día resultó no tener arreglo posible con un índice).
    const columnasIndexadas = {};
    for (const [tabla, columna] of filas(await mysql(
      `SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=${ESQ} AND SEQ_IN_INDEX=1;`
    ))) {
      if (!columnasIndexadas[tabla]) columnasIndexadas[tabla] = new Set();
      columnasIndexadas[tabla].add(columna);
    }
    ctx = { est, vars, tablas: tablas.filter((t) => !t.es_vista), vistas: tablas.filter((t) => t.es_vista).map((t) => t.nombre), columnasIndexadas };
    ctx.total_b = ctx.tablas.reduce((a, t) => a + t.datos_b + t.indices_b, 0);
    if (!Object.keys(est).length) throw new Error("MariaDB no respondió; puede estar caída o reiniciándose");
  }

  // ── Paso 1: conexiones ────────────────────────────────────────────────────
  async function pasoConexiones() {
    const { est, vars } = ctx;
    const abiertas = num(est.Threads_connected), tope = num(vars.max_connections), pico = num(est.Max_used_connections);
    const totales = num(est.Connections), abortadasConexion = num(est.Aborted_connects), abortadasCliente = num(est.Aborted_clients);
    const usoPct = pct(abiertas, tope), picoPct = pct(pico, tope);
    const fallidasPct = pct(abortadasConexion, totales), cortadasPct = pct(abortadasCliente, totales);
    const problemas = [];
    let severidad = "ok";
    let topeBajo = false;
    if (usoPct >= 85) { severidad = "urgente"; problemas.push(`hay ${abiertas} conexiones abiertas de ${tope} permitidas (${usoPct}%): a punto de rechazar conexiones nuevas`); topeBajo = true; }
    else if (picoPct >= 70) { severidad = "atencion"; problemas.push(`el pico desde el último arranque llegó a ${pico} de ${tope} (${picoPct}%)`); topeBajo = true; }
    if (fallidasPct > 5 && totales >= 100) { severidad = severidad === "urgente" ? "urgente" : "atencion"; problemas.push(`${abortadasConexion} intentos de conexión fallaron (${fallidasPct}%): contraseña equivocada, tope alcanzado o alguien probando`); }
    if (cortadasPct > 10 && totales >= 100) { severidad = severidad === "urgente" ? "urgente" : "atencion"; problemas.push(`${abortadasCliente} conexiones se cortaron sin cerrar bien (${cortadasPct}%): alguna aplicación no cierra sus conexiones`); }
    // Solo cuando el tope de verdad se está quedando corto (no cuando el
    // problema es autenticación o conexiones mal cerradas, que subir el tope
    // no arregla): sugiere +50%, redondeado a 50, sin pasar el techo duro de
    // subirMaxConnections (una máquina de 4 GB no aguanta cualquier número).
    const valorSugerido = topeBajo
      ? Math.min(dbOptimizacion.TECHO_MAX_CONNECTIONS, Math.round((tope * 1.5) / 50) * 50)
      : null;
    return {
      titulo: "Conexiones a la base de datos",
      severidad,
      significado: problemas.length ? "Las conexiones necesitan revisión" : "Las conexiones están holgadas",
      detalle: (problemas.length ? problemas.join("; ") + ". " : "") +
        `Ahora: ${abiertas} abiertas de ${tope} permitidas · pico ${pico} · ${totales} conexiones desde el último arranque · ` +
        `${abortadasConexion} fallidas (${fallidasPct}%) · ${abortadasCliente} cortadas sin cerrar (${cortadasPct}%).` +
        (valorSugerido ? ` Qué hacer: subir max_connections a ${valorSugerido} — se aplica sin reiniciar la base.` : ""),
      // Centinela sabe reparar esto sola (SET GLOBAL, dinámico, sin
      // reiniciar): el panel ofrece un botón cuando el tope es el problema.
      datos: valorSugerido ? { valor_actual: tope, valor_sugerido: valorSugerido } : null,
    };
  }

  // ── Paso 2: buffer pool ───────────────────────────────────────────────────
  async function pasoBufferPool() {
    const { est, vars } = ctx;
    const pedidas = num(est.Innodb_buffer_pool_read_requests), deDisco = num(est.Innodb_buffer_pool_reads);
    const aciertos = pedidas > 0 ? Math.round((1 - deDisco / pedidas) * 10000) / 100 : null;
    const total = num(est.Innodb_buffer_pool_pages_total), libres = num(est.Innodb_buffer_pool_pages_free), conDatos = num(est.Innodb_buffer_pool_pages_data);
    const esperas = num(est.Innodb_buffer_pool_wait_free);
    const tamMb = mb(vars.innodb_buffer_pool_size);
    const usadoMb = total > 0 ? Math.round(tamMb * conDatos / total) : 0;
    const librePct = pct(libres, total);
    const pocosDatos = pedidas < 10000;
    let severidad = "ok", significado = "La base atiende casi todo desde memoria, sin ir al disco";
    if (pocosDatos) { significado = "Todavía hay pocas lecturas para juzgar (la base arrancó hace poco)"; }
    else if (aciertos < 95) { severidad = "urgente"; significado = "La base está yendo al disco demasiado: la memoria reservada le queda chica"; }
    else if (aciertos < 99) { severidad = "atencion"; significado = "La base va al disco más de lo deseable"; }
    if (esperas > 0 && severidad === "ok") { severidad = "atencion"; significado = "La base tuvo que esperar por páginas libres en memoria"; }
    const horas = Math.round(num(est.Uptime) / 3600);
    return {
      titulo: "Memoria caché de InnoDB (buffer pool)",
      severidad,
      significado,
      detalle: `${aciertos === null ? "Sin lecturas aún" : aciertos + "% de aciertos en memoria"} (${deDisco.toLocaleString("es-CO")} lecturas de disco de ${pedidas.toLocaleString("es-CO")} pedidas en ${horas} h) · ` +
        `${usadoMb} MB con datos de ${tamMb} MB reservados (${librePct}% libre) · ${esperas} esperas por página libre.` +
        (severidad === "urgente" ? " Qué hacer: subir innodb_buffer_pool_size con cuidado (ver la revisión de memoria más abajo) o repartir mejor la RAM entre los servicios." : ""),
    };
  }

  // ── Paso 3: motor y claves primarias ──────────────────────────────────────
  async function pasoMotorYClaves() {
    const conPk = new Set(filas(await mysql(
      `SELECT TABLE_NAME FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA=${ESQ} AND CONSTRAINT_TYPE='PRIMARY KEY';`
    )).map((f) => f[0]));
    const sinPk = ctx.tablas.filter((t) => !conPk.has(t.nombre));
    const myisam = ctx.tablas.filter((t) => (t.motor || "").toUpperCase() === "MYISAM");
    const otrosMotores = ctx.tablas.filter((t) => t.motor && !["INNODB", "MYISAM"].includes(t.motor.toUpperCase()));
    const grave = myisam.some((t) => t.filas >= 1000) || sinPk.some((t) => t.filas >= 100000);
    const hay = sinPk.length || myisam.length || otrosMotores.length;
    const partes = [];
    if (sinPk.length) partes.push(`Sin clave primaria: ${lista(sinPk.map((t) => `${t.nombre} (${t.filas.toLocaleString("es-CO")} filas)`))}. Sin ella, InnoDB inventa una clave oculta, las actualizaciones y borrados son más lentos y las réplicas y copias incrementales sufren.`);
    if (myisam.length) partes.push(`En motor MyISAM: ${lista(myisam.map((t) => `${t.nombre} (${t.filas.toLocaleString("es-CO")} filas)`))}. MyISAM no es resistente a cortes de luz ni a transacciones; conviene pasarlas a InnoDB (ALTER TABLE … ENGINE=InnoDB, en horario de baja actividad).`);
    if (otrosMotores.length) partes.push(`Con otro motor: ${lista(otrosMotores.map((t) => `${t.nombre} (${t.motor})`))}.`);
    return {
      titulo: "Motor de almacenamiento y claves primarias",
      severidad: !hay ? "ok" : grave ? "urgente" : "atencion",
      significado: !hay ? "Todas las tablas usan InnoDB y tienen clave primaria" : `${sinPk.length} tabla(s) sin clave primaria y ${myisam.length} en MyISAM`,
      detalle: partes.join(" ") || `${ctx.tablas.length} tablas revisadas.`,
      // `myisam`: Centinela sabe arreglarlo sola (ALTER TABLE ... ENGINE=InnoDB,
      // un único comando seguro) — el panel ofrece un botón por tabla.
      // `sin_pk`: no hay botón; elegir qué columna es la llave primaria le
      // toca a una persona, no hay una forma genérica y segura de adivinarla.
      datos: {
        myisam: myisam.map((t) => ({ tabla: t.nombre, filas: t.filas })),
        sin_pk: sinPk.map((t) => ({ tabla: t.nombre, filas: t.filas })),
      },
    };
  }

  // ── Paso 4: fragmentación ─────────────────────────────────────────────────
  async function pasoFragmentacion() {
    const porTabla = ctx.vars.innodb_file_per_table === "ON";
    const grandes = ctx.tablas.filter((t) => t.datos_b + t.indices_b >= 20 * MB);
    const fragmentadas = grandes
      .map((t) => ({ ...t, pct: pct(t.libre_b, t.datos_b + t.indices_b) }))
      .filter((t) => t.pct >= 25 && t.libre_b >= 20 * MB)
      .sort((a, b) => b.libre_b - a.libre_b);
    const grave = fragmentadas.some((t) => t.pct >= 50 && t.libre_b >= 200 * MB);
    const libreTotalMb = mb(ctx.tablas.reduce((a, t) => a + t.libre_b, 0));
    return {
      titulo: "Fragmentación de tablas grandes",
      severidad: !fragmentadas.length ? "ok" : grave ? "urgente" : "atencion",
      significado: !fragmentadas.length ? "Las tablas grandes no tienen espacio desperdiciado de importancia" : `${fragmentadas.length} tabla(s) grande(s) con mucho espacio desperdiciado`,
      detalle: (fragmentadas.length
        ? `${lista(fragmentadas.map((t) => `${t.nombre}: ${mb(t.libre_b)} MB libres dentro de ${mb(t.datos_b + t.indices_b)} MB (${t.pct}%)`))}. Qué hacer: OPTIMIZE TABLE, en horario de baja actividad (reconstruye la tabla y bloquea escrituras mientras dura, unos minutos en una tabla grande). `
        : "") +
      `${grandes.length} tablas de más de 20 MB revisadas · ${libreTotalMb} MB desperdiciados en total en toda la base` +
      (porTabla ? "." : ". Ojo: innodb_file_per_table está apagado, así que la cifra de espacio libre es del archivo compartido, no de cada tabla."),
      // Centinela sabe reparar esto sola (OPTIMIZE TABLE, un único comando
      // seguro y reversible): el panel ofrece un botón por tabla.
      datos: fragmentadas.map((t) => ({ tabla: t.nombre, mb_libres: mb(t.libre_b), pct: t.pct })),
    };
  }

  // ── Paso 5: consultas que recorren tablas enteras ─────────────────────────
  //
  // Leer muchas filas por cada una que se devuelve no significa por sí solo
  // que un índice lo vaya a arreglar: puede ser una vista que agrega en vivo
  // (SUM/MAX/COUNT no son columnas, no hay nada que indexar), o una columna
  // que YA tiene índice y MariaDB decide saltárselo a propósito porque casi
  // todas las filas lo cumplen (un índice ahí sería más lento que barrer la
  // tabla). Antes este paso marcaba "para revisar" cualquier consulta que
  // leyera mucho, con un "qué hacer: un índice…" que no aplicaba — el
  // 14-sep-2026, revisando en vivo, NINGUNA de las 11 consultas marcadas ese
  // día tenía arreglo posible con un índice. Ahora cada grupo se reclasifica
  // con el mismo análisis que ya usa el panel de sugerencias (extraerPatrones
  // + vistas + columnasIndexadas): solo cuenta como "para revisar" si de
  // verdad hay un índice nuevo que ayudaría.
  async function pasoEscaneos() {
    const { est, vars } = ctx;
    const perfSchema = vars.performance_schema === "ON";
    const archivo = (vars.slow_query_log_file || "/tmp/mariadb-slow.log").replace(/[^a-zA-Z0-9_./-]/g, "");
    const crudo = await sh(`docker exec zeus-mariadb cat ${archivo} 2>/dev/null | tail -8000`, 30000);
    const entradas = interpretarSlowLog(crudo.salida).filter((e) => !/SQL_NO_CACHE/i.test(e.sql));
    const grupos = new Map();
    for (const e of entradas) {
      if (e.examinadas < 10000) continue;
      const ratio = e.examinadas / Math.max(e.enviadas, 1);
      if (ratio < 1000) continue; // lee mil filas o más por cada una que devuelve: eso es recorrer la tabla entera
      const clave = normalizarSql(e.sql);
      if (!grupos.has(clave)) grupos.set(clave, { sql: clave, veces: 0, examinadas: 0, segundos: 0, max_examinadas: 0 });
      const g = grupos.get(clave);
      g.veces += 1; g.examinadas += e.examinadas; g.segundos += e.segundos; g.max_examinadas = Math.max(g.max_examinadas, e.examinadas);
    }
    const todas = [...grupos.values()].sort((a, b) => b.examinadas - a.examinadas);
    const ofensoras = todas.filter((g) => tieneArregloDeIndice(g.sql, ctx.vistas, ctx.columnasIndexadas));
    const pesadasPorDiseno = todas.length - ofensoras.length;
    const grave = ofensoras.some((g) => g.veces >= 10 && g.max_examinadas >= 100000);
    const scans = num(est.Select_scan), fullJoin = num(est.Select_full_join), preguntas = num(est.Questions);
    const fuente = vars.slow_query_log === "ON"
      ? `Fuente: registro de consultas lentas (más de ${num(vars.long_query_time)} s)` + (perfSchema ? " y performance_schema" : "; performance_schema está apagado (correcto en una máquina de 4 GB: consume memoria)")
      : "Ojo: el registro de consultas lentas está apagado, así que solo se ven los contadores globales";
    // "escaneos" lee hasta 8000 líneas del registro crudo; el panel de
    // sugerencias (analizarPatrones) trabaja sobre una muestra más chica y
    // distinta (estadoDatos().consultas_lentas, las 8 consultas más lentas
    // por duración). Puede pasar que una consulta SÍ tenga arreglo posible
    // pero la sugerencia todavía no haya aparecido en esa muestra más chica
    // — sin este chequeo, el texto prometía "aplícalo más abajo" y el botón
    // no estaba (bug real, encontrado probando en vivo el 14-sep-2026).
    let sugerenciaConfirmada = false;
    if (ofensoras.length) {
      try {
        const datos = await estadoDatos();
        const sugerencias = dbOptimizacion.analizarPatrones((datos && datos.consultas_lentas) || [], ctx.vistas, ctx.columnasIndexadas);
        sugerenciaConfirmada = sugerencias.some((s) => s.comando);
      } catch (_) { /* si falla la verificación, mejor el texto prudente que uno roto */ }
    }
    return {
      titulo: "Consultas que recorren tablas enteras",
      severidad: !ofensoras.length ? "ok" : grave ? "urgente" : "atencion",
      significado: !ofensoras.length ? "Ninguna consulta lenta necesita un índice nuevo" : `${ofensoras.length} consulta(s) leen miles de filas por cada una que devuelven y sí se arreglan con un índice`,
      detalle: (ofensoras.length
        ? lista(ofensoras.map((g) => `«${g.sql.slice(0, 110)}${g.sql.length > 110 ? "…" : ""}» ${g.veces} vez/veces, hasta ${g.max_examinadas.toLocaleString("es-CO")} filas leídas por corrida, ${g.segundos.toFixed(1)} s acumulados`), 3) +
          (sugerenciaConfirmada
            ? ". Qué hacer: aplicar el índice sugerido más abajo (columna del WHERE/ORDER BY/JOIN). "
            : ". Qué hacer: un índice sobre la columna del WHERE/ORDER BY/JOIN ayudaría — todavía no alcanzó a aparecer en las sugerencias de más abajo, vuelve a auditar más tarde para verla ahí. ")
        : "") +
      `Recorridos completos desde el arranque: ${scans.toLocaleString("es-CO")} de ${preguntas.toLocaleString("es-CO")} consultas · ${fullJoin} JOIN sin índice · ${entradas.length} entradas del registro analizadas. ${fuente}` +
      (pesadasPorDiseno ? ` · ${pesadasPorDiseno} consulta(s) pesada(s) más, pero por diseño (reportes o vistas que agregan en vivo): ningún índice las acelera.` : "."),
    };
  }

  // ── Paso 6: índices redundantes ───────────────────────────────────────────
  async function pasoIndicesRedundantes() {
    const r = await mysql(
      "SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, INDEX_TYPE, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ',') " +
      `FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=${ESQ} GROUP BY TABLE_NAME, INDEX_NAME, NON_UNIQUE, INDEX_TYPE;`
    );
    const porTabla = new Map();
    let totalIndices = 0;
    for (const [tabla, nombre, noUnico, tipo, cols] of filas(r)) {
      if (tipo === "FULLTEXT" || tipo === "SPATIAL") continue;
      totalIndices += 1;
      if (!porTabla.has(tabla)) porTabla.set(tabla, []);
      porTabla.get(tabla).push({ nombre, unico: noUnico === "0", columnas: (cols || "").split(",") });
    }
    const redundantes = [];
    for (const [tabla, indices] of porTabla) {
      for (const a of indices) {
        if (a.nombre === "PRIMARY") continue;
        for (const b of indices) {
          if (a === b) continue;
          const esPrefijo = a.columnas.length <= b.columnas.length && a.columnas.every((c, i) => c === b.columnas[i]);
          if (!esPrefijo) continue;
          const mismasCols = a.columnas.length === b.columnas.length;
          // A sobra si: es prefijo estricto de B y no es único; o tiene las
          // mismas columnas que B y (B es único o ambos no únicos y A va después
          // por nombre, para reportar el par una sola vez).
          const sobra = !mismasCols ? !a.unico : (b.unico && !a.unico) || (a.unico === b.unico && b.nombre === "PRIMARY") || (a.unico === b.unico && b.nombre !== "PRIMARY" && a.nombre > b.nombre);
          if (sobra) { redundantes.push({ tabla, indice: a.nombre, columnas: a.columnas.join(","), cubierto_por: b.nombre }); break; }
        }
      }
    }
    return {
      titulo: "Índices duplicados o redundantes",
      severidad: redundantes.length ? "atencion" : "ok",
      significado: redundantes.length ? `${redundantes.length} índice(s) sobran: otro índice ya cubre las mismas columnas` : "No hay índices repetidos",
      detalle: (redundantes.length
        ? `${lista(redundantes.map((x) => `${x.tabla}.${x.indice} (${x.columnas}) ya lo cubre ${x.cubierto_por}`), 8)}. Cada índice de más hace más lentas las escrituras y ocupa memoria. Qué hacer: DROP INDEX con calma, uno a uno; si una llave foránea lo usa, MariaDB no lo dejará borrar y hay que dejarlo. `
        : "") + `${totalIndices} índices revisados en ${porTabla.size} tablas.`,
      datos: redundantes.slice(0, 20),
    };
  }

  // ── Paso 7: crecimiento frente a la línea base ────────────────────────────
  function instantanea() {
    return {
      ts: new Date().toISOString(),
      total_mb: mb(ctx.total_b),
      tablas: ctx.tablas.slice(0, 25).map((t) => ({ nombre: t.nombre, filas: t.filas, mb: mb(t.datos_b + t.indices_b) })),
    };
  }
  async function pasoCrecimiento() {
    const hist = leerJson(RUTA_HIST, { corridas: [], lineas_base: [] });
    const bases = Array.isArray(hist.lineas_base) ? hist.lineas_base : [];
    const ahora = instantanea();
    const dias = (b) => (Date.now() - new Date(b.ts).getTime()) / 86400000;
    // La referencia ideal es la más cercana a 30 días atrás; si no hay tan
    // vieja, la más antigua que exista, siempre que tenga al menos un día.
    const candidatas = bases.filter((b) => dias(b) >= 1).sort((a, b) => Math.abs(dias(a) - 30) - Math.abs(dias(b) - 30));
    const base = candidatas[0] || null;
    if (!base) {
      return {
        titulo: "Crecimiento de las tablas",
        severidad: "ok",
        significado: "Línea base guardada: la próxima auditoría ya podrá comparar",
        detalle: `Hoy la base ocupa ${ahora.total_mb} MB en ${ctx.tablas.length} tablas. Las más grandes: ${lista(ahora.tablas.slice(0, 5).map((t) => `${t.nombre} ${t.mb} MB`), 5)}.`,
      };
    }
    const d = Math.round(dias(base));
    const previas = new Map(base.tablas.map((t) => [t.nombre, t]));
    const crecidas = ahora.tablas
      .map((t) => { const p = previas.get(t.nombre); return p ? { ...t, antes_mb: p.mb, delta_mb: t.mb - p.mb, delta_pct: pct(t.mb - p.mb, p.mb || 1) } : null; })
      .filter((t) => t && t.delta_mb >= 20 && t.delta_pct >= 50)
      .sort((a, b) => b.delta_mb - a.delta_mb);
    const deltaTotal = ahora.total_mb - base.total_mb, deltaTotalPct = pct(deltaTotal, base.total_mb || 1);
    const severidad = deltaTotalPct >= 100 || crecidas.some((t) => t.delta_pct >= 200 && t.delta_mb >= 100) ? "urgente" : (crecidas.length || deltaTotalPct >= 30) ? "atencion" : "ok";
    return {
      titulo: "Crecimiento de las tablas",
      severidad,
      significado: severidad === "ok" ? `Crecimiento normal en ${d} día(s)` : `Alguna tabla creció más de lo esperado en ${d} día(s)`,
      detalle: `De ${base.total_mb} MB a ${ahora.total_mb} MB (${deltaTotal >= 0 ? "+" : ""}${deltaTotal} MB, ${deltaTotalPct}%) desde el ${base.ts.slice(0, 10)}. ` +
        (crecidas.length ? `Crecieron mucho: ${lista(crecidas.map((t) => `${t.nombre} ${t.antes_mb}→${t.mb} MB (+${t.delta_pct}%)`))}. Qué hacer: revisar si es actividad real del negocio o un registro/bitácora que nadie depura.` : "Ninguna tabla se disparó."),
    };
  }

  // ── Paso 8: memoria reservada vs. RAM real ────────────────────────────────
  async function pasoMemoria() {
    const { est, vars } = ctx;
    const ramB = num((await sh("free -b | awk '/Mem:/{print $2}'")).salida);
    const limiteB = num((await sh("docker inspect -f '{{.HostConfig.Memory}}' zeus-mariadb 2>/dev/null")).salida);
    const poolMb = mb(vars.innodb_buffer_pool_size), ramMb = mb(ramB), datosMb = mb(ctx.total_b);
    const keyMb = mb(vars.key_buffer_size);
    const myisamB = ctx.tablas.filter((t) => (t.motor || "").toUpperCase() === "MYISAM").reduce((a, t) => a + t.indices_b, 0);
    const tmpDisco = num(est.Created_tmp_disk_tables), tmpTotal = num(est.Created_tmp_tables), tmpPct = pct(tmpDisco, tmpTotal);
    const poolPct = ramMb ? pct(poolMb, ramMb) : 0;
    const pedidas = num(est.Innodb_buffer_pool_read_requests), deDisco = num(est.Innodb_buffer_pool_reads);
    const aciertos = pedidas > 0 ? (1 - deDisco / pedidas) * 100 : 100;
    const problemas = [];
    let severidad = "ok";
    let keyBufferDesperdiciado = false;
    if (poolPct >= 50) { severidad = "urgente"; problemas.push(`el buffer pool se lleva ${poolMb} MB de los ${ramMb} MB de la máquina (${poolPct}%): deja sin aire al bot, a ChromaDB y a los demás contenedores, y el servidor termina usando swap`); }
    else if (poolPct >= 35) { severidad = "atencion"; problemas.push(`el buffer pool ocupa ${poolPct}% de la RAM; en una máquina compartida es el límite prudente`); }
    if (poolMb < datosMb && aciertos < 99 && pedidas >= 10000) { if (severidad === "ok") severidad = "atencion"; problemas.push(`el buffer pool (${poolMb} MB) es menor que los datos (${datosMb} MB) y la tasa de aciertos ya lo nota`); }
    if (keyMb >= 32 && myisamB < 8 * MB) {
      if (severidad === "ok") severidad = "atencion";
      problemas.push(`key_buffer_size reserva ${keyMb} MB para índices MyISAM, pero casi no hay tablas MyISAM (${mb(myisamB)} MB de índices): es memoria que no sirve para nada; con 8 MB sobra`);
      keyBufferDesperdiciado = true;
    }
    if (tmpPct >= 25 && tmpTotal >= 500) { if (severidad === "ok") severidad = "atencion"; problemas.push(`${tmpPct}% de las tablas temporales se crean en disco (${tmpDisco} de ${tmpTotal}); subir tmp_table_size/max_heap_table_size (hoy ${mb(vars.tmp_table_size)} MB) ayudaría`); }
    // key_buffer_size es dinámica (SET GLOBAL, sin reiniciar) — las demás sí
    // requieren editar docker-compose.yml y reiniciar el contenedor.
    const soloKeyBuffer = problemas.length === 1 && keyBufferDesperdiciado;
    return {
      titulo: "Memoria reservada para la base",
      severidad,
      significado: problemas.length ? "El reparto de memoria se puede afinar" : "La memoria de la base está bien dimensionada para esta máquina",
      detalle: (problemas.length ? problemas.join("; ") + ". " : "") +
        `RAM total ${ramMb} MB · buffer pool ${poolMb} MB (${poolPct}%) · datos+índices ${datosMb} MB · key_buffer ${keyMb} MB · tablas temporales en disco ${tmpPct}% · ` +
        (limiteB > 0 ? `tope de memoria del contenedor ${mb(limiteB)} MB.` : "el contenedor de MariaDB no tiene tope de memoria (puede crecer hasta agotar la máquina).") +
        (soloKeyBuffer ? " Qué hacer: bajar key_buffer_size a 8 MB — se aplica sin reiniciar la base." :
          problemas.length ? " El resto de estos cambios los aplica una persona en docker-compose.yml y requiere reiniciar MariaDB." : ""),
      // Centinela sabe reparar sola el caso de key_buffer_size desperdiciado
      // (SET GLOBAL, dinámico) — solo cuando es el ÚNICO problema: si además
      // hay que tocar el buffer pool o tmp_table_size, esos si necesitan a
      // una persona y no tiene sentido ofrecer un arreglo parcial.
      datos: soloKeyBuffer ? { key_buffer_desperdiciado: true } : null,
    };
  }

  // ── Paso 9: bloqueos ──────────────────────────────────────────────────────
  async function pasoBloqueos() {
    const { est } = ctx;
    const procesos = await dbProcesos.listarProcesos(mysql);
    const trabadas = (procesos && procesos.trabadas) || [];
    const esperasAhora = num(est.Innodb_row_lock_current_waits), esperas = num(est.Innodb_row_lock_waits);
    const maxMs = num(est.Innodb_row_lock_time_max), deadlocks = num(est.Innodb_deadlocks), tablaEsperas = num(est.Table_locks_waited);
    const horas = Math.max(num(est.Uptime) / 3600, 1);
    let severidad = "ok", significado = "Nadie está esperando por un bloqueo";
    if (trabadas.length || esperasAhora > 0) { severidad = "urgente"; significado = `${trabadas.length || esperasAhora} consulta(s) esperando un bloqueo en este momento`; }
    else if (deadlocks > 0 || esperas / horas > 10 || maxMs > 5000) { severidad = "atencion"; significado = "Hubo bloqueos que vale la pena mirar"; }
    return {
      titulo: "Bloqueos y consultas trabadas",
      severidad,
      significado,
      detalle: (trabadas.length ? `Trabadas ahora: ${lista(trabadas.map((p) => `#${p.id} ${p.usuario} (${p.tiempo_texto}) ${p.consulta.slice(0, 80)}`), 3)}. ` : "") +
        `Desde el arranque (${Math.round(horas)} h): ${esperas} esperas por fila · máxima ${(maxMs / 1000).toFixed(1)} s · ${deadlocks} interbloqueos · ${tablaEsperas} esperas por tabla · ${procesos.procesos ? procesos.procesos.length : 0} conexiones activas ahora.` +
        (severidad !== "ok" ? " Recuerda: Centinela nunca mata una consulta sola; se hace desde Datos técnicos, con confirmación." : ""),
    };
  }

  // ── Paso 10: sugerencias de índice que siguen sin aplicar ─────────────────
  async function pasoSugerenciasPendientes() {
    const datos = await estadoDatos();
    const sugerencias = dbOptimizacion.analizarPatrones((datos && datos.consultas_lentas) || []);
    if (!sugerencias.length) {
      return { titulo: "Sugerencias de índice pendientes", severidad: "ok", significado: "No hay sugerencias de índice pendientes", detalle: "El registro de consultas lentas no muestra consultas repetidas que necesiten un índice nuevo." };
    }
    const indices = filas(await mysql(
      "SELECT TABLE_NAME, INDEX_NAME, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ',') " +
      `FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=${ESQ} GROUP BY TABLE_NAME, INDEX_NAME;`
    )).map(([tabla, nombre, cols]) => ({ tabla, nombre, columnas: (cols || "").split(",") }));
    const vistas = new Set(ctx.vistas);
    const pendientes = [], cubiertas = [], sobreVistas = [];
    for (const s of sugerencias) {
      if (vistas.has(s.tabla)) { sobreVistas.push(s); continue; }
      const cubierta = indices.some((i) => i.tabla === s.tabla && s.columnas.every((c, k) => i.columnas[k] === c));
      (cubierta ? cubiertas : pendientes).push(s);
    }
    const severidad = pendientes.length >= 5 ? "urgente" : pendientes.length ? "atencion" : "ok";
    return {
      titulo: "Sugerencias de índice pendientes",
      severidad,
      significado: pendientes.length ? `${pendientes.length} sugerencia(s) de índice siguen sin aplicarse` : "Las sugerencias de índice ya están cubiertas",
      detalle: (pendientes.length ? `Pendientes: ${lista(pendientes.map((s) => `${s.tabla} (${s.columnas.join(", ")}), se repite ${s.repeticiones} vez/veces`))}. Se aplican con el botón "Aplicar" de esta misma sección; primero "Explicar" dice qué gana cada una. ` : "") +
        (cubiertas.length ? `${cubiertas.length} ya tienen índice. ` : "") +
        (sobreVistas.length ? `${sobreVistas.length} apuntan a una vista (${lista(sobreVistas.map((s) => s.tabla), 3)}): ahí el índice no se puede crear, iría en la tabla base que usa la vista.` : ""),
    };
  }

  const PASOS = [
    { id: "conexiones", fn: pasoConexiones },
    { id: "buffer_pool", fn: pasoBufferPool },
    { id: "motor_claves", fn: pasoMotorYClaves },
    { id: "fragmentacion", fn: pasoFragmentacion },
    { id: "escaneos", fn: pasoEscaneos },
    { id: "indices_redundantes", fn: pasoIndicesRedundantes },
    { id: "crecimiento", fn: pasoCrecimiento },
    { id: "memoria", fn: pasoMemoria },
    { id: "bloqueos", fn: pasoBloqueos },
    { id: "sugerencias_pendientes", fn: pasoSugerenciasPendientes },
  ];
  const NOMBRES = {
    conexiones: "conexiones", buffer_pool: "memoria caché de InnoDB", motor_claves: "motor y claves primarias",
    fragmentacion: "fragmentación", escaneos: "consultas que recorren tablas enteras", indices_redundantes: "índices redundantes",
    crecimiento: "crecimiento de las tablas", memoria: "memoria reservada", bloqueos: "bloqueos", sugerencias_pendientes: "sugerencias pendientes",
  };

  function estado() { return { en_curso: !!enCurso, run_id: enCurso }; }

  async function correr(runId, quien) {
    const hallazgos = [];
    try {
      bus.emitirEvento(runId, undefined, "inicio", "info", "Empezando la auditoría completa de la base de datos…");
      try { await cargarContexto(); }
      catch (e) {
        bus.emitirEvento(runId, undefined, "resultado", "crit", "No se pudo leer el estado de MariaDB: " + e.message);
        for (const paso of PASOS) hallazgos.push({ id: paso.id, titulo: NOMBRES[paso.id], severidad: "atencion", significado: "No se pudo revisar: la base no respondió", detalle: "" });
      }
      if (Object.keys(ctx.est || {}).length) {
        for (const paso of PASOS) {
          bus.emitirEvento(runId, undefined, "paso", "info", `Revisando: ${NOMBRES[paso.id]}…`);
          let r;
          try { r = await paso.fn(); }
          catch (e) { r = { titulo: NOMBRES[paso.id], severidad: "atencion", significado: "No se pudo completar esta revisión: " + e.message, detalle: "" }; }
          hallazgos.push({ id: paso.id, ...r });
          bus.emitirEvento(runId, undefined, "resultado", r.severidad === "urgente" ? "crit" : r.severidad === "atencion" ? "warn" : "ok",
            `${r.titulo}: ${r.significado}`, { hallazgo: { id: paso.id, ...r } });
        }
      }
    } finally {
      enCurso = null;
    }
    const urgentes = hallazgos.filter((h) => h.severidad === "urgente").length;
    const atencion = hallazgos.filter((h) => h.severidad === "atencion").length;
    const puntaje = hallazgos.length ? Math.round((hallazgos.filter((h) => h.severidad === "ok").length / hallazgos.length) * 100) : 0;
    const resumen = { id: runId, ts: new Date().toISOString(), quien, hallazgos, puntaje, urgentes, atencion, tamano_mb: mb(ctx.total_b || 0) };

    const hist = leerJson(RUTA_HIST, { corridas: [], lineas_base: [] });
    hist.corridas = hist.corridas || [];
    hist.corridas.unshift(resumen);
    hist.corridas = hist.corridas.slice(0, 30);
    // Una instantánea de tamaños por día (la primera del día), hasta 120 días:
    // es lo que usa el paso de crecimiento como línea base.
    if (ctx.tablas && ctx.tablas.length) {
      hist.lineas_base = Array.isArray(hist.lineas_base) ? hist.lineas_base : [];
      const hoy = new Date().toISOString().slice(0, 10);
      if (!hist.lineas_base.some((b) => String(b.ts || "").slice(0, 10) === hoy)) {
        hist.lineas_base.push(instantanea());
        hist.lineas_base = hist.lineas_base.slice(-120);
      }
    }
    guardarJson(RUTA_HIST, hist);

    auditar("auditoria_bd", quien, urgentes ? "urgente" : atencion ? "atencion" : "ok", `puntaje ${puntaje}`);
    bus.emitirFin(runId, undefined, `Auditoría terminada: ${urgentes} urgente(s), ${atencion} para revisar.`, resumen);
    return resumen;
  }

  /**
   * Arranca una corrida y responde de inmediato con el run_id: la consola en
   * vivo (SSE) va mostrando cada paso mientras corre, y el evento `fin` trae
   * el resumen. `esperar()` devuelve la promesa de la corrida en curso (para
   * pruebas o para quien prefiera bloquear hasta el final).
   */
  async function ejecutar(quien) {
    if (enCurso) return { ok: false, code: 409, mensaje: "Ya hay una auditoría en curso" };
    const runId = `bd-${Date.now()}`;
    enCurso = runId;
    ctx = {};
    corridaActual = correr(runId, quien).catch((e) => {
      enCurso = null;
      bus.emitirFin(runId, undefined, "La auditoría se interrumpió: " + e.message, null);
      return null;
    });
    return { ok: true, run_id: runId };
  }

  function esperar() { return corridaActual || Promise.resolve(null); }

  function ultima() {
    const hist = leerJson(RUTA_HIST, { corridas: [] });
    return (hist.corridas && hist.corridas[0]) || null;
  }
  function historial() {
    const hist = leerJson(RUTA_HIST, { corridas: [] });
    return hist.corridas || [];
  }

  return { ejecutar, esperar, estado, vivo: bus.suscribir, ultima, historial };
}

module.exports = { crearOptimizacionCompleta, interpretarSlowLog, normalizarSql, tieneArregloDeIndice };
