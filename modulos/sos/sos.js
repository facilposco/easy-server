"use strict";
/**
 * modulos/sos/sos.js
 *
 * Motor del protocolo SOS de Centinela Zeus (DISENO-SOS.md, vinculante).
 * Fábrica `crearSos(deps)`. Orquesta F1→F8, con verificación obligatoria
 * después de CADA peldaño antes de escalar al siguiente, presupuesto de
 * acciones, límites duros (delegados a limites.js) y la lista fija de cosas
 * que el SOS NUNCA hace solo (§1 P7, §5.4 "Nunca").
 *
 * Sin dependencias externas: solo Node 20 estándar.
 */

const fs = require("fs");
const { crearDbCentinela } = require("./db-centinela.js");
const { crearBus } = require("./bus-sse.js");
const { crearLimites } = require("./limites.js");
const { crearPuedeActuar } = require("./puede-actuar.js");
const escalada = require("./escalada.js");
const { crearEvidencia } = require("./evidencia.js");
const { crearEnmascarador } = require("./enmascarar.js");
const diagnostico = require("./diagnostico.js");
const textos = require("./textos.js");

const CONTENEDORES_PROPIOS = ["zeus-mariadb", "zeus-chromadb", "zeus-bot", "zeus-proxy"];
const ORDEN_REINICIO = ["zeus-mariadb", "zeus-chromadb", "zeus-bot", "zeus-proxy"];

// Presupuesto de la corrida (§1 P5, §5.5.2).
const PRESUPUESTO_ACCIONES = 4;
const PRESUPUESTO_MS = 10 * 60 * 1000;

// Espera de verificación por objetivo (§5.2), en ms.
const ESPERA_VERIF = {
  "zeus-bot": 120000,
  "zeus-bot_rollback": 180000,
  "zeus-mariadb": 150000,
  "zeus-chromadb": 60000,
  "zeus-proxy": 30000,
  disco: 0,
  memoria: 30000,
  docker: 180000,
};
const SONDEO_MS = 5000;

// ── Lista blanca fija de peldaños (nada viene del usuario, §5.1) ────────────
const PELDANOS_VALIDOS = new Set([
  "liberar_disco", "reiniciar_contenedor", "reiniciar_en_orden",
  "deshacer_despliegue", "reiniciar_docker", "reiniciar_servidor", "esperar_respaldo",
]);

// ── Lo que el SOS NUNCA hace solo (§1 P7 — documentado y nunca invocado) ────
const NUNCA_SOLO = [
  "Tocar contenedores ajenos (otro-proyecto-b, otro-proyecto-c, otro-proyecto-a)",
  "Borrar datos del negocio",
  "KILL de consultas en la base de datos",
  "docker system prune --volumes",
  "Borrar respaldos",
  "Tocar /etc",
  "Cambiar configuración de Traefik",
  "apt (salvo lo que ya hace liberar_disco, que no toca paquetes)",
];

function dormir(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * @param {object} deps  ver DISENO-SOS.md §19.1 para la lista completa.
 * Requeridas: sh, auditar, enviarWhatsapp, leerContenedores, leerMemoria,
 * leerCpu, leerDisco, mysql, cache, DIR_DATOS, env, leerJson, guardarJson,
 * leerJsonl, anexar, baseIncidentes, F_AUDIT, F_HIST.
 * Opcionales (con reemplazo funcional si faltan): simulacros,
 * observacionDespliegue, resiliencia, dbProcesos, kapsoYModo, F_MODO,
 * preguntarAGemini, registrarConsultaIA, leerGastoIA, HORA_REINICIO_UTC,
 * HORA_RESPALDO_UTC, reiniciarEnOrden, porQueSeCayo.
 */
function crearSos(deps) {
  const requeridas = ["sh", "auditar", "enviarWhatsapp", "leerContenedores", "leerMemoria", "leerCpu", "leerDisco", "mysql", "cache", "DIR_DATOS"];
  for (const r of requeridas) if (typeof deps[r] === "undefined") throw new Error(`crearSos necesita '${r}' de ops-server.js`);

  const { sh, auditar, enviarWhatsapp, leerContenedores, leerMemoria, leerCpu, leerDisco, mysql, cache, DIR_DATOS } = deps;
  const env = deps.env || {};
  // reglasSeguridad y permisos son opcionales a propósito: si algún día se
  // instancia crearSos() sin ellos (una prueba, un entorno viejo), el SOS
  // sigue funcionando exactamente como antes — nunca por falta de estos dos
  // módulos deja de operar. Solo si SÍ están presentes se aplican sus checks.
  const reglasSeguridad = deps.reglasSeguridad || null;
  const permisos = deps.permisos || null;
  // A qué categoría de permisos.js pertenece cada peldaño del SOS.
  const CATEGORIA_POR_PELDANO = {
    liberar_disco: "disco",
    reiniciar_contenedor: "contenedores",
    reiniciar_en_orden: "contenedores",
    esperar_respaldo: "contenedores",
    deshacer_despliegue: "despliegue",
    reiniciar_docker: "contenedores",
    reiniciar_servidor: "servidor",
  };
  const HORA_REINICIO_UTC = typeof deps.HORA_REINICIO_UTC === "number" ? deps.HORA_REINICIO_UTC : 9;
  const HORA_RESPALDO_UTC = typeof deps.HORA_RESPALDO_UTC === "number" ? deps.HORA_RESPALDO_UTC : 8;

  const db = crearDbCentinela(DIR_DATOS);
  const bus = crearBus({ dirEventos: db.DIR_EVENTOS, enCurso: (runId) => !!(enCurso && enCurso.run_id === runId) });
  const limites = crearLimites({ leerJson: db.leerJson, escribirAtomico: db.escribirAtomico, ruta: db.RUTAS.limites });
  // Punto único de decisión (diseño de Fable 5.1, 12-sep-2026): freno →
  // permisos → horario comercial → ventana sensible → límites duros, en ese
  // orden. Reemplaza la lógica que antes vivía repartida entre
  // evaluarSeguridadAutonoma() y chequearLimiteYVentanas() — ver ambas
  // funciones más abajo, ahora envoltorios delgados sobre esto mismo.
  const { puedeActuar } = crearPuedeActuar({
    limites, reglasSeguridad, permisos,
    contenedoresPropios: CONTENEDORES_PROPIOS,
    categoriaPorPeldano: CATEGORIA_POR_PELDANO,
    horaReinicioUtc: HORA_REINICIO_UTC,
    horaRespaldoUtc: HORA_RESPALDO_UTC,
  });

  const secretosConocidos = [
    { nombre: "MYSQL_PASS", valor: env.MYSQL_ROOT_PASS || env.MYSQL_PASS },
    { nombre: "KAPSO_KEY", valor: env.KAPSO_API_KEY },
    { nombre: "PROXY_SECRETO_GEMINI", valor: env.PROXY_SECRETO_GEMINI },
    { nombre: "PIN_SIMULACRO", valor: env.PIN_SIMULACRO },
    { nombre: "TOKEN_PRUEBA_VIGILANTE", valor: env.TOKEN_PRUEBA_VIGILANTE },
    { nombre: "WSP_DESTINO", valor: env.WSP_DESTINO },
    ...Object.entries(env).map(([nombre, valor]) => ({ nombre, valor })),
  ];
  const enmascarador = crearEnmascarador(secretosConocidos);
  const evidencia = crearEvidencia({ db, sh, enmascarador, auditar });

  let enCurso = null; // { run_id, origen, inicio, fase }

  // ── Utilidades de instantánea (F1) ────────────────────────────────────────

  async function docksOk() {
    for (let intento = 0; intento < 2; intento++) {
      const r = await sh("docker info --format '{{.ServerVersion}}'", 8000);
      if (r.ok && r.salida.trim()) return true;
      if (intento === 0) await dormir(3000);
    }
    return false;
  }

  async function sondaBot() {
    const r = await sh("docker exec zeus-bot curl -s -o /dev/null -m 5 -w '%{http_code} %{time_total}' http://localhost:3131/", 8000);
    if (!r.ok || !r.salida.trim()) return { ok: false, sin_dato: true };
    const [codigo, tiempo] = r.salida.trim().split(/\s+/);
    return { ok: parseInt(codigo, 10) < 500, codigo: parseInt(codigo, 10), tiempo_s: parseFloat(tiempo) || 0 };
  }
  async function sondaMariadb() {
    const r = await sh("docker exec zeus-mariadb healthcheck.sh --connect --innodb_initialized", 8000);
    return { ok: r.ok, sin_dato: false };
  }
  async function sondaChroma() {
    const r = await sh("docker exec zeus-chromadb curl -sf -m 5 http://localhost:8000/api/v1/heartbeat", 8000);
    return { ok: r.ok, sin_dato: false };
  }
  async function sondaProxy() {
    const r = await sh("curl -sk -o /dev/null -m 6 -w '%{http_code} %{time_total}' -H 'Host: panel.ejemplo.com' https://127.0.0.1/health", 8000);
    if (!r.ok || !r.salida.trim()) return { ok: false, sin_dato: true };
    const [codigo, tiempo] = r.salida.trim().split(/\s+/);
    // Cualquier respuesta por debajo de 500 demuestra que la puerta de entrada
    // está viva y enrutando: /health está detrás de la contraseña del panel y
    // devuelve 401, que es una respuesta legítima, no una caída. Exigir un 200
    // hacía que el SOS creyera SIEMPRE que la puerta estaba caída y llegara a
    // reiniciar Traefik sin motivo. Lo que sí delata un problema real es un
    // 502/503/504: la puerta contesta pero detrás no hay nadie.
    const n = parseInt(codigo, 10);
    return { ok: n > 0 && n < 500, codigo: n, tiempo_s: parseFloat(tiempo) || 0 };
  }

  async function inspectPropio(nombre) {
    const r = await sh(`docker inspect -f '{{.State.OOMKilled}};{{.State.ExitCode}};{{.State.FinishedAt}};{{.State.StartedAt}}' ${nombre}`, 5000);
    if (!r.ok) return { sin_dato: true };
    const [oom, exitCode, fin, inicio] = r.salida.trim().split(";");
    return { oomKilled: oom === "true", exitCode: parseInt(exitCode, 10) || 0, finishedAt: fin, startedAt: inicio };
  }

  function eventosDieKill10min() {
    const desde = Date.now() - 10 * 60 * 1000;
    const eventos = deps.leerJsonl ? deps.leerJsonl(deps.F_AUDIT, 600) : [];
    const out = {};
    for (const e of eventos) {
      if (e.accion !== "evento_docker" || !/^(die|kill)$/.test(e.resultado)) continue;
      if (new Date(e.ts).getTime() < desde) continue;
      out[e.detalle] = (out[e.detalle] || 0) + 1;
    }
    return out;
  }

  async function leerRespaldoEnCurso() {
    const r = await sh("pgrep -f 'backup_db.sh|mysqldump' | head -3", 3000);
    return !!(r.salida && r.salida.trim());
  }

  async function leerIowait(cpuA) {
    const antes = fs.readFileSync ? null : null;
    return 0; // simplificado: iowait exacto requiere dos muestras de /proc/stat; no crítico para el árbol de decisión principal.
  }

  async function leerDespliegue() {
    const [created, log] = await Promise.all([
      sh("docker inspect -f '{{.Created}}' zeus-bot", 5000),
      sh("git -C /opt/zeus-app log -1 --format='%H %cI'", 5000),
    ]);
    let creadoHaceMs = null;
    if (created.ok && created.salida.trim()) {
      creadoHaceMs = Date.now() - new Date(created.salida.trim()).getTime();
    }
    const estado = deps.observacionDespliegue && typeof deps.observacionDespliegue.estado === "function"
      ? deps.observacionDespliegue.estado() : { baseline: null };
    const objetivo = await elegirObjetivoRollback(estado);
    return { creadoHaceMs, estado, hayObjetivoRollback: !!objetivo, objetivo };
  }

  /** §7.2: el primero que exista gana. */
  async function elegirObjetivoRollback(estadoDespliegue) {
    const headR = await sh("git -C /opt/zeus-app rev-parse HEAD", 5000);
    const head = headR.ok ? headR.salida.trim() : null;

    const baseline = estadoDespliegue && estadoDespliegue.baseline;
    if (baseline && baseline.commit_sha && baseline.capturado &&
      (Date.now() - new Date(baseline.capturado).getTime()) <= 24 * 3600 * 1000 &&
      baseline.commit_sha !== head) {
      return { sha: baseline.commit_sha, origen: "baseline" };
    }

    const tagR = await sh("git -C /opt/zeus-app tag -l 'backup/*' | sort | tail -1", 5000);
    if (tagR.ok && tagR.salida.trim()) {
      const tag = tagR.salida.trim();
      const shaR = await sh(`git -C /opt/zeus-app rev-parse ${tag}`, 5000);
      if (shaR.ok && shaR.salida.trim() && shaR.salida.trim() !== head) {
        return { sha: shaR.salida.trim(), origen: `tag ${tag}` };
      }
    }

    const reflogR = await sh("git -C /opt/zeus-app reflog -1 --date=iso", 5000);
    if (reflogR.ok && /pull|merge/i.test(reflogR.salida)) {
      const prevR = await sh("git -C /opt/zeus-app rev-parse 'HEAD@{1}'", 5000);
      if (prevR.ok && prevR.salida.trim() && prevR.salida.trim() !== head) {
        return { sha: prevR.salida.trim(), origen: "reflog" };
      }
    }
    return null;
  }

  /**
   * F1 completo: construye la instantánea S y clasifica. Presupuesto de
   * diagnóstico: 20 s (§2), con `Promise.all` y timeouts propios por sonda.
   */
  async function diagnosticarF1() {
    cache.delete("contenedores");
    cache.delete("datos");

    const dockerOk = await docksOk();
    if (!dockerOk) {
      const hostOk = await Promise.all([
        sh("cat /proc/meminfo | head -1", 5000),
        sh("df / | tail -1", 5000),
      ]).then((rs) => rs.every((r) => r.ok));
      if (!hostOk) return { S: null, diag: { sintoma_principal: "no_diagnosticable", secundarios: [], culpable: null, afecta_clientes: "desconocido", plan: [] }, noDiagnosticable: true };
    }

    const simEnCurso = !!(deps.simulacros && deps.simulacros.estado && deps.simulacros.estado().en_curso);

    const [contenedoresLista, disco, respaldoEnCurso] = await Promise.all([
      dockerOk ? leerContenedores() : [], dockerOk ? leerDisco() : { pct: 0, libre: Infinity, total: 0, usado: 0 }, leerRespaldoEnCurso(),
    ]);
    const memoria = leerMemoria();
    const cpu1 = leerCpu();
    await dormir(2000);
    const cpu2 = leerCpu();

    const contenedores = {}, inspect = {}, sondas = {};
    if (dockerOk) {
      for (const c of contenedoresLista) contenedores[c.nombre] = c;
      const sondasFns = { "zeus-bot": sondaBot, "zeus-mariadb": sondaMariadb, "zeus-chromadb": sondaChroma, "zeus-proxy": sondaProxy };
      await Promise.all(CONTENEDORES_PROPIOS.map(async (nombre) => {
        inspect[nombre] = contenedores[nombre] ? await inspectPropio(nombre) : { sin_dato: true };
        sondas[nombre] = (contenedores[nombre] && contenedores[nombre].estado === "running") ? await sondasFns[nombre]() : { ok: false, sin_dato: true };
      }));
    }

    const ajenosConProblema = contenedoresLista.filter((c) => !CONTENEDORES_PROPIOS.includes(c.nombre) && (c.estado !== "running" || c.salud === "unhealthy"));
    const propiosTodosSanos = CONTENEDORES_PROPIOS.every((n) => contenedores[n] && contenedores[n].estado === "running" && contenedores[n].salud !== "unhealthy");

    const despliegue = dockerOk ? await leerDespliegue() : { creadoHaceMs: null, hayObjetivoRollback: false };
    const dbProcesosInfo = (dockerOk && deps.dbProcesos && contenedores["zeus-mariadb"] && contenedores["zeus-mariadb"].estado === "running")
      ? await deps.dbProcesos.listarProcesos(mysql).catch(() => ({ hay_trabadas: false })) : { hay_trabadas: false };

    const S = {
      dockerOk, memoria, swapUsadoBytes: 0, cpu: cpu2, iowaitPct: 0, disco, inodosPct: 0,
      contenedores, inspect, sondas,
      eventosDieKill10min: eventosDieKill10min(),
      incidenteYaActuado: {},
      respaldoEnCurso, simulacroEnCurso: simEnCurso,
      despliegue,
      procesosHost: {},
      consultasTrabadas: dbProcesosInfo,
      ajenoConProblema: ajenosConProblema.length > 0 && propiosTodosSanos,
      noDiagnosticable: false,
    };

    const diag = diagnostico.diagnosticar(S);
    return { S, diag, noDiagnosticable: false };
  }

  // ── Impacto (F2) ───────────────────────────────────────────────────────────
  const TEXTOS_IMPACTO = {
    si: { bot_caido: "Los clientes que escriben al WhatsApp no están recibiendo respuesta.", bot_no_responde: "Los clientes que escriben al WhatsApp no están recibiendo respuesta.",
      bd_caida: "El bot no puede consultar ventas ni clientes; responde a medias o nada.", puerta_caida: "Los mensajes de WhatsApp no están llegando al bot y el panel tampoco abre." },
    parcial: { busqueda_caida: "El bot contesta, pero sin la información de documentos y tutoriales." },
    no: { ajeno_con_problema: "Es de otro proyecto. Este negocio no está afectado y Centinela no lo toca.", todo_bien: "Todo funciona con normalidad." },
    desconocido: { no_diagnosticable: "No pude confirmar si los clientes están afectados." },
  };
  function textoImpacto(diag) {
    const grupo = TEXTOS_IMPACTO[diag.afecta_clientes] || {};
    return grupo[diag.sintoma_principal] || (diag.afecta_clientes === "si" ? "Los clientes están afectados." : "Todavía no afecta a los clientes.");
  }

  // ── Verificación tras cada peldaño (§5.2) ────────────────────────────────
  async function verificarObjetivo(objetivo, esperaMs) {
    const inicio = Date.now();
    let ultimo = { ok: false, detalle: "sin verificar" };
    while (Date.now() - inicio < esperaMs) {
      ultimo = await comprobarUno(objetivo);
      if (ultimo.ok) return { ok: true, segundos: Math.round((Date.now() - inicio) / 1000), detalle: ultimo.detalle };
      await dormir(SONDEO_MS);
    }
    ultimo = await comprobarUno(objetivo);
    return { ok: ultimo.ok, segundos: Math.round((Date.now() - inicio) / 1000), detalle: ultimo.detalle };
  }

  async function comprobarUno(objetivo) {
    if (objetivo === "disco") {
      const d = await leerDisco();
      return { ok: d.pct < 90 && d.libre >= 2 * 1024 * 1024 * 1024, detalle: `disco ${d.pct}%` };
    }
    if (objetivo === "memoria") {
      const m = leerMemoria();
      return { ok: m.disponible >= 400 * 1024 * 1024, detalle: `memoria disponible ${Math.round(m.disponible / 1048576)} MB` };
    }
    if (objetivo === "docker") {
      const ok = await docksOk();
      return { ok, detalle: ok ? "Docker responde" : "Docker sigue sin responder" };
    }
    const cs = await leerContenedores();
    const c = cs.find((x) => x.nombre === objetivo);
    if (!c || c.estado !== "running") return { ok: false, detalle: `${objetivo} no está corriendo` };
    if (c.salud === "unhealthy") return { ok: false, detalle: `${objetivo} salud: unhealthy` };
    const sondasFns = { "zeus-bot": sondaBot, "zeus-mariadb": sondaMariadb, "zeus-chromadb": sondaChroma, "zeus-proxy": sondaProxy };
    const sonda = sondasFns[objetivo] ? await sondasFns[objetivo]() : { ok: true };
    if (!sonda.ok) return { ok: false, detalle: `${objetivo} no atiende la sonda` };
    if (sonda.tiempo_s && sonda.tiempo_s > 3 && objetivo === "zeus-bot") return { ok: false, detalle: `${objetivo} responde lento (${sonda.tiempo_s}s)` };
    return { ok: true, detalle: `sonda OK en ${sonda.tiempo_s || 0}s; salud: ${c.salud}` };
  }

  // ── Peldaños (§5.1, lista blanca) ────────────────────────────────────────

  async function ejecutarLiberarDisco(emit) {
    const pasos = [];
    const check = async () => (await leerDisco()).pct < 85;
    const cmds = [
      "rm -f /var/lib/zeus-ops/simulacro-relleno.img",
      "swapon --show=NAME --noheadings | grep -qx /swapfile-zeus || rm -f /swapfile-zeus",
      "docker builder prune -af",
      "docker image prune -af",
      "docker container prune -f",
      "journalctl --vacuum-time=7d --vacuum-size=200M",
      "find /opt/zeus-app/logs -name '*.log' -size +50M -exec truncate -s 20M {} \\;",
      "find /var/log -name '*.gz' -mtime +14 -delete",
    ];
    // Rotación forzada de la propia base de Centinela (paso 3 del diseño).
    evidencia.rotar({ forzarTopesBajos: true });
    for (const cmd of cmds) {
      const r = await sh(cmd, 60000);
      pasos.push({ cmd, ok: r.ok, salida: (r.salida || r.error || "").slice(0, 300) });
      emit("reparacion", "info", `Liberando disco: ${cmd.split(" ")[0]}…`);
      if (await check()) break;
    }
    cache.delete("contenedores"); cache.delete("datos");
    const du = await sh("du -xh -d1 /var /opt 2>/dev/null | sort -rh | head -15", 20000);
    return { pasos, duDisco: du.salida };
  }

  async function ejecutarReiniciarContenedor(nombre) {
    const r = await sh(`docker restart -t 20 ${nombre}`, 60000);
    cache.delete("contenedores");
    return r;
  }

  async function ejecutarReiniciarEnOrden(lista, emit) {
    if (typeof deps.reiniciarEnOrden === "function") {
      return await deps.reiniciarEnOrden(lista, { esperarSalud: true, quien: "sos" });
    }
    const pasos = [];
    for (const nombre of ORDEN_REINICIO.filter((n) => lista.includes(n))) {
      emit("reparacion", "info", `Reiniciando ${textos.nombreClaro(nombre)}…`);
      const r = await ejecutarReiniciarContenedor(nombre);
      const v = await verificarObjetivo(nombre, ESPERA_VERIF[nombre] || 60000);
      pasos.push({ nombre, ok: r.ok && v.ok, segundos: v.segundos, detalle: v.detalle });
      if (!v.ok) break;
    }
    return { ok: pasos.every((p) => p.ok), pasos };
  }

  async function ejecutarDeshacerDespliegue(objetivo, emit) {
    const headAntes = await sh("git -C /opt/zeus-app rev-parse HEAD", 5000);
    emit("reparacion", "info", `Volviendo a la versión anterior del bot (${objetivo.sha.slice(0, 8)})…`);
    const cmd = `cd /opt/zeus-app && git reset --hard ${objetivo.sha} && docker compose build zeus-bot && docker compose up -d zeus-bot`;
    const r = await sh(cmd, 300000);
    cache.delete("contenedores");
    return { ok: r.ok, salida: (r.salida || r.error || "").slice(0, 2000), headAntes: headAntes.ok ? headAntes.salida.trim() : null };
  }

  async function ejecutarReiniciarDocker() {
    // §18 riesgo 11: si algún propio tiene política "no", no se toca ese peldaño.
    const cs = await leerContenedores();
    const sinPolitica = cs.filter((c) => CONTENEDORES_PROPIOS.includes(c.nombre) && c.politica === "no");
    if (sinPolitica.length) {
      return { ok: false, motivo: `${sinPolitica.map((c) => c.nombre).join(", ")} no tiene reinicio automático; no reinicio Docker.` };
    }
    const r = await sh("systemctl restart docker", 60000);
    cache.delete("contenedores");
    return { ok: r.ok, salida: r.salida || r.error };
  }

  // ── Cierre / registro (F8, §10.1) ────────────────────────────────────────

  function registrarCorrida(corrida) {
    db.anexar(db.RUTAS.corridas, corrida);
    db.rotarJsonl(db.RUTAS.corridas, 1000, 365);
    db.limpiarEventosViejos(30);
  }

  function estimarDesde(diag, S) {
    if (!diag) return new Date().toISOString();
    const culpable = diag.culpable;
    if (culpable && S && S.inspect[culpable] && S.inspect[culpable].finishedAt) return S.inspect[culpable].finishedAt;
    return new Date().toISOString();
  }

  /**
   * Lanza una corrida SOS. `origen`: "panel" | "bot" | "agente".
   * Devuelve { ok, run_id, ya_en_curso }.
   */
  async function lanzar(origen) {
    if (enCurso) return { ok: true, run_id: enCurso.run_id, ya_en_curso: true };

    const run_id = `sos-${Math.floor(Date.now() / 1000)}-${Math.random().toString(16).slice(2, 6)}`;
    enCurso = { run_id, origen: origen || "panel", inicio: new Date().toISOString(), fase: "inicio" };
    db.escribirAtomico(db.RUTAS.lock, { run_id, inicio: enCurso.inicio, pid: process.pid });
    auditar("sos_lanzado", origen === "bot" ? "bot" : "panel", "ok", run_id);

    const emit = (fase, nivel, texto, dato) => bus.emitirEvento(run_id, undefined, fase, nivel, textos.lineaConsola(texto), dato);
    emit("inicio", "info", `Iniciando SOS (pedido desde ${origen === "bot" ? "WhatsApp" : "el panel"}).`);

    correrProtocolo(run_id, origen || "panel", emit).catch((e) => {
      auditar("sos_error", "sos", "error", e.message);
      try {
        bus.emitirFin(run_id, undefined, "SOS terminado con un error interno.", { resultado: "detenido_pide_ayuda" });
      } catch (_) {}
      enCurso = null;
      try { fs.unlinkSync(db.RUTAS.lock); } catch (_) {}
    });

    return { ok: true, run_id, ya_en_curso: false };
  }

  /** El motor completo: F1..F8. No lanza excepciones fuera de este archivo. */
  async function correrProtocolo(run_id, origen, emit) {
    const inicioMs = Date.now();
    const acciones = [];
    let accionesUsadas = 0;
    let evidenciaId = null;
    let incidenteSosId = null;
    let ultimoDiag = null, ultimoS = null;

    function presupuestoAgotado() {
      return accionesUsadas >= PRESUPUESTO_ACCIONES || (Date.now() - inicioMs) > PRESUPUESTO_MS;
    }

    // F1 — Diagnóstico
    enCurso.fase = "diagnostico";
    emit("diagnostico", "info", "Paso 1 — Diagnóstico. Leyendo servicios, memoria, disco y procesador…");
    let { S, diag, noDiagnosticable } = await diagnosticarF1();
    ultimoS = S; ultimoDiag = diag;
    const diagOriginal = diag; // el reporte final siempre describe lo que se ENCONTRÓ, no el estado tras reparar (§10.1)

    if (noDiagnosticable) {
      return await cerrarNoDiagnosticable(run_id, origen, emit, diag, inicioMs);
    }
    if (diag.sintoma_principal === "simulacro_en_curso") {
      return await cerrarDetenido(run_id, origen, emit, S, diag, [], null, null,
        "Hay un simulacro en curso; lo que ves puede ser provocado por él.",
        "Espera a que termine o detenlo desde Simulacros.", inicioMs);
    }

    emit("diagnostico", diag.sintoma_principal === "todo_bien" ? "ok" : "crit", `${textos.tituloSintoma(diag.sintoma_principal)}${diag.culpable ? " — " + textos.nombreClaro(diag.culpable) : ""}.`);

    // F2 — Impacto
    enCurso.fase = "impacto";
    emit("impacto", "info", `Paso 2 — Impacto: ${textoImpacto(diag)}`);

    incidenteSosId = limites.incidenteActual(diag.sintoma_principal);

    // Casos que se detienen sin reparar (§4.2 #1, #13, #14 y ajenos con memoria).
    if (diag.detenerInmediato) {
      return await cerrarDetenido(run_id, origen, emit, S, diag, acciones, evidenciaId, incidenteSosId,
        diag.motivo || "El culpable no es de este negocio.", "Revisar el proceso manualmente.", inicioMs);
    }
    if (diag.sintoma_principal === "ajeno_con_problema" || diag.sintoma_principal === "todo_bien") {
      const tipo = diag.sintoma_principal === "todo_bien" ? "sin_falla" : "sin_falla";
      const paquete = await evidencia.armarPaqueteMinimo({ S, diag, run_id, incidente_sos_id: incidenteSosId, origen, tipo });
      const esc = evidencia.escribirPaquete(paquete);
      evidenciaId = esc.ok ? esc.id : null;
      emit("evidencia", "info", "Guardé una foto mínima del estado actual.");
      return await cerrarSinFalla(run_id, origen, emit, S, diag, evidenciaId, inicioMs);
    }

    // F3 — Evidencia (ANTES de tocar nada — P1)
    enCurso.fase = "evidencia";
    emit("evidencia", "info", "Paso 3 — Guardando la evidencia antes de tocar nada…");
    let extras = {};
    if (diag.sintoma_principal === "memoria_agotada" && deps.resiliencia && typeof deps.resiliencia.armarPaqueteEvidenciaMemoria === "function") {
      extras.memoria_bot = await deps.resiliencia.armarPaqueteEvidenciaMemoria("zeus-bot").catch(() => null);
    }
    if (deps.dbProcesos && (diag.sintoma_principal === "bd_caida" || diag.sintoma_principal === "servidor_lento")) {
      const p = await deps.dbProcesos.listarProcesos(mysql).catch(() => null);
      if (p) extras.consultas_bd = JSON.stringify((p.procesos || []).map((x) => ({ Id: x.id, User: x.usuario, Time: x.segundos, State: x.estado, Consulta: (x.consulta || "").slice(0, 80) })), null, 2);
    }
    extras.centinela = {
      auditoria: deps.leerJsonl ? deps.leerJsonl(deps.F_AUDIT, 60) : [],
      incidentes: deps.baseIncidentes ? deps.baseIncidentes() : null,
      historial: deps.leerJsonl && deps.F_HIST ? deps.leerJsonl(deps.F_HIST, 30) : [],
    };

    const paquete = await evidencia.armarPaquete({ S, diag, run_id, incidente_sos_id: incidenteSosId, origen }, extras);
    let esc = evidencia.escribirPaquete(paquete);
    let evidenciaOk = esc.ok;
    if (!esc.ok) {
      // Disco lleno: versión mínima tras rotación forzada.
      evidencia.rotar({ forzarTopesBajos: true });
      const minimo = await evidencia.armarPaqueteMinimo({ S, diag, run_id, incidente_sos_id: incidenteSosId, origen, tipo: "falla" });
      esc = evidencia.escribirPaquete(minimo);
      evidenciaOk = esc.ok;
      auditar("evidencia_no_guardada", "sos", evidenciaOk ? "minima" : "falló", diag.sintoma_principal);
    }
    evidenciaId = esc.ok ? esc.id : null;
    emit("evidencia", evidenciaOk ? "ok" : "warn", evidenciaOk
      ? `Evidencia guardada: ${evidenciaId} (${esc.bytes} bytes, datos sensibles ocultados).`
      : "No pude guardar la evidencia (disco lleno). Sigo solo con liberar espacio.");

    if (!evidenciaOk) {
      // P1: sin evidencia, nunca reinicio de servidor ni reversión; solo liberar_disco si aplica.
      if (diag.sintoma_principal !== "disco_lleno") {
        return await cerrarDetenido(run_id, origen, emit, S, diag, acciones, evidenciaId, incidenteSosId,
          "No pude guardar la evidencia (el disco está lleno) y el peldaño siguiente sería de alto impacto.",
          "Libera espacio a mano o pide a tu técnico que revise el disco.", inicioMs);
      }
    }

    // F4 — Plan (según §4.2, ya calculado en diag.plan)
    enCurso.fase = "plan";
    let plan = (diag.plan || []).filter((p) => PELDANOS_VALIDOS.has(p.peldano));
    emit("plan", "info", `Plan: ${plan.length ? plan.map((p, i) => `${i + 1}) ${p.peldano}${p.objetivo ? " " + (Array.isArray(p.objetivo) ? p.objetivo.join(",") : p.objetivo) : ""}`).join("  ") : "sin peldaños automáticos"}.`);

    if (!plan.length && diag.motivo) {
      return await cerrarDetenido(run_id, origen, emit, S, diag, acciones, evidenciaId, incidenteSosId, diag.motivo, "Revisar manualmente.", inicioMs);
    }

    // F5/F6 — Peldaños + verificación (nunca el mismo peldaño/objetivo dos veces — §1 P4)
    enCurso.fase = "reparacion";
    const yaEjecutado = new Set();
    let detenido = null;

    for (let idx = 0; idx < plan.length; idx++) {
      const paso = plan[idx];
      const clave = `${paso.peldano}:${Array.isArray(paso.objetivo) ? paso.objetivo.join(",") : (paso.objetivo || "")}`;
      if (yaEjecutado.has(clave)) continue;
      yaEjecutado.add(clave);

      if (presupuestoAgotado()) {
        detenido = { motivo: "Se agotó el presupuesto de la corrida (4 acciones o 10 minutos).", sugerencia: "Revisar manualmente desde el panel." };
        break;
      }

      const chequeoLimite = await chequearLimiteYVentanas(paso, incidenteSosId, ultimoS, ultimoDiag);
      if (!chequeoLimite.ok) {
        auditar("sos_bloqueado_por_regla", "agente", "bloqueado", `${paso.peldano}: ${chequeoLimite.motivo}`);
        detenido = { motivo: chequeoLimite.motivo, sugerencia: chequeoLimite.sugerencia || "Una persona debe intervenir o desbloquear la acción desde el panel." };
        break;
      }

      enCurso.fase = "reparacion";
      const resultadoPaso = await ejecutarPeldano(paso, run_id, emit, incidenteSosId, S, diagOriginal.sintoma_principal);
      accionesUsadas++;
      acciones.push(resultadoPaso);

      if (resultadoPaso.peldano === "reiniciar_servidor" && resultadoPaso.ok) {
        // La corrida se cierra al volver del reinicio (§6.3); no seguir aquí.
        return;
      }

      // F6 — Verificación (repetición completa de F1)
      enCurso.fase = "verificacion";
      emit("verificacion", "info", "Paso 9 — Verificación: repitiendo el diagnóstico completo…");
      const re = await diagnosticarF1();
      ultimoS = re.S; ultimoDiag = re.diag;

      const sintomaResuelto = !re.noDiagnosticable && (re.diag.sintoma_principal === "todo_bien" || re.diag.sintoma_principal === "ajeno_con_problema");
      if (sintomaResuelto) {
        emit("verificacion", "ok", "Volví a revisar todo: sin fallas.");
        return await cerrarExito(run_id, origen, emit, S, diagOriginal, acciones, evidenciaId, incidenteSosId, inicioMs);
      }

      if (idx === plan.length - 1) {
        // Último peldaño del plan agotado y sigue sin resolverse: reglas de "si la verificación falla" (§4.2).
        const siguiente = await decidirEscaladaFinal(re.diag, re.S, incidenteSosId, acciones, presupuestoAgotado());
        if (siguiente && siguiente.peldano) {
          plan = plan.concat([siguiente]);
        } else if (siguiente && siguiente.detener) {
          // La escalada (p. ej. reiniciar en orden) decidió parar sola —
          // hoy solo pasa si tocaría insistir sobre la base de datos.
          detenido = { motivo: siguiente.motivo, sugerencia: siguiente.sugerencia };
        } else {
          // Si Centinela quería escalar a algo y algo se lo impidió (freno,
          // permisos, horario, límite), que quede en el mensaje final en vez
          // de solo "el problema persiste".
          const motivoBase = `Tras reparar, ${re.diag.afecta_clientes === "si" ? "un servicio que afecta a los clientes sigue sin atender" : "el problema persiste"}.`;
          detenido = detenido || (siguiente && siguiente.bloqueo
            ? { motivo: `${motivoBase} Quise ${textos.describirAccion({ peldano: siguiente.intentado })}, pero ${siguiente.bloqueo.mensaje.replace(/^No hice "[^"]+": /, "")}`, sugerencia: siguiente.bloqueo.sugerencia }
            : { motivo: motivoBase, sugerencia: "Hace falta que una persona revise el servidor directamente." });
        }
      }
    }

    if (detenido) {
      return await cerrarDetenido(run_id, origen, emit, ultimoS, diagOriginal, acciones, evidenciaId, incidenteSosId, detenido.motivo, detenido.sugerencia, inicioMs);
    }

    // Mejoró parcialmente pero no quedó "todo_bien".
    return await cerrarParcial(run_id, origen, emit, ultimoS, diagOriginal, acciones, evidenciaId, incidenteSosId, inicioMs);
  }

  /**
   * Reglas de límites y ventanas para cada peldaño antes de ejecutarlo.
   * Envoltorio delgado sobre `puedeActuar()` (Fase A del diseño de Fable,
   * 12-sep-2026) — antes tenía su propia copia de la comprobación de
   * "contenedor ajeno" y de ventanas, y NO consultaba freno/permisos/horario,
   * así que esos tres se colaban hasta ejecutarPeldano() y un bloqueo por
   * freno terminaba contando como una acción fallida ("No funcionó") en vez
   * de detenerse limpiamente aquí. Ahora los seis se consultan juntos, en el
   * mismo orden y con el mismo mensaje para el dueño.
   */
  async function chequearLimiteYVentanas(paso, incidenteSosId, S, diag) {
    const r = puedeActuar(paso, { incidenteSosId, S, diag });
    if (r.ok) return { ok: true };
    return { ok: false, motivo: r.mensaje, sugerencia: r.sugerencia, fuente: r.fuente };
  }

  /**
   * Punto único de entrada de seguridad para toda acción autónoma del SOS:
   * envoltorio delgado sobre `puedeActuar()`. Se mantiene como segunda
   * comprobación dentro de ejecutarPeldano() (cinturón y tirantes) aunque
   * chequearLimiteYVentanas() ya cubre esto antes de llegar aquí — por si
   * algún día `ejecutarPeldano` se llama desde otro sitio sin pasar por el
   * bucle principal. Ninguno de los dos bloquea una acción que un humano
   * ejecuta directamente desde el panel (esos botones no pasan por aquí).
   */
  function evaluarSeguridadAutonoma(peldano, S) {
    const r = puedeActuar({ peldano }, { S });
    return r.ok ? { ok: true } : { ok: false, mensaje: r.mensaje };
  }

  async function ejecutarPeldano(paso, run_id, emit, incidenteSosId, S, sintomaPrincipal) {
    const inicio = new Date().toISOString();
    const objetivo = Array.isArray(paso.objetivo) ? paso.objetivo.join(",") : paso.objetivo;
    emit("reparacion", "info", `Paso 4 — ${textos.describirAccion({ peldano: paso.peldano, objetivo: Array.isArray(paso.objetivo) ? null : paso.objetivo })}…`);

    const chequeoSeguridad = evaluarSeguridadAutonoma(paso.peldano, S);
    if (!chequeoSeguridad.ok) {
      emit("reparacion", "crit", chequeoSeguridad.mensaje);
      auditar("sos_bloqueado_por_regla", "agente", "bloqueado", `${paso.peldano}: ${chequeoSeguridad.mensaje}`);
      return {
        orden: 1, peldano: paso.peldano, objetivo, comando: null,
        inicio, fin: new Date().toISOString(), ok: false,
        salida: chequeoSeguridad.mensaje,
        verificacion: { ok: false, detalle: chequeoSeguridad.mensaje },
      };
    }

    let ok = false, salida = "", verificacion = null, comando = null;

    if (paso.peldano === "liberar_disco") {
      const r = await ejecutarLiberarDisco(emit);
      // Antes decía "funcionó" pase lo que pase; ahora refleja si al menos un
      // comando de limpieza corrió de verdad (la verificación de abajo, aparte,
      // confirma si con eso bastó para bajar del 85%).
      ok = r.pasos.some((p) => p.ok);
      salida = JSON.stringify(r.pasos).slice(0, 2000);
      limites.registrar("liberar_disco", { incidenteId: incidenteSosId });
      verificacion = await verificarObjetivo("disco", ESPERA_VERIF.disco);
    } else if (paso.peldano === "reiniciar_contenedor") {
      comando = `docker restart -t 20 ${paso.objetivo}`;
      const r = await ejecutarReiniciarContenedor(paso.objetivo);
      ok = r.ok; salida = (r.salida || r.error || "").slice(0, 2000);
      limites.registrar("reiniciar_contenedor", { objetivo: paso.objetivo });
      verificacion = await verificarObjetivo(paso.objetivo, ESPERA_VERIF[paso.objetivo] || 60000);
    } else if (paso.peldano === "reiniciar_en_orden") {
      const r = await ejecutarReiniciarEnOrden(paso.objetivo, emit);
      ok = r.ok; salida = JSON.stringify(r.pasos).slice(0, 2000);
      for (const n of paso.objetivo) limites.registrar("reiniciar_contenedor", { objetivo: n });
      verificacion = { ok: r.ok, segundos: null, detalle: r.pasos.map((p) => `${p.nombre}: ${p.detalle}`).join("; ") };
    } else if (paso.peldano === "esperar_respaldo") {
      const inicioE = Date.now();
      while (Date.now() - inicioE < 120000) {
        if (!(await leerRespaldoEnCurso())) break;
        await dormir(10000);
      }
      ok = true; salida = "respaldo esperado";
      const sonda = await sondaMariadb();
      verificacion = { ok: sonda.ok, segundos: Math.round((Date.now() - inicioE) / 1000), detalle: sonda.ok ? "la base ya responde" : "la base sigue sin responder" };
      if (!verificacion.ok) {
        const r = await ejecutarReiniciarContenedor("zeus-mariadb");
        ok = r.ok;
        limites.registrar("reiniciar_contenedor", { objetivo: "zeus-mariadb" });
        verificacion = await verificarObjetivo("zeus-mariadb", ESPERA_VERIF["zeus-mariadb"]);
      }
    } else if (paso.peldano === "deshacer_despliegue") {
      const objetivoRollback = S && S.despliegue && S.despliegue.objetivo;
      if (!objetivoRollback) {
        ok = false; salida = "sin versión anterior confiable";
        verificacion = { ok: false, detalle: "no se encontró un commit anterior confiable" };
      } else {
        const r = await ejecutarDeshacerDespliegue(objetivoRollback, emit);
        ok = r.ok; salida = r.salida;
        limites.registrar("deshacer_despliegue", { incidenteId: incidenteSosId });
        verificacion = await verificarObjetivo("zeus-bot", ESPERA_VERIF["zeus-bot_rollback"]);
      }
    } else if (paso.peldano === "reiniciar_docker") {
      const r = await ejecutarReiniciarDocker();
      ok = r.ok; salida = r.salida || r.motivo || "";
      if (ok) limites.registrar("reiniciar_docker", { incidenteId: incidenteSosId });
      verificacion = ok ? await verificarObjetivo("docker", ESPERA_VERIF.docker) : { ok: false, detalle: salida };
    } else if (paso.peldano === "reiniciar_servidor") {
      const r = await ejecutarReinicioServidorCompleto(run_id, S, incidenteSosId, emit, sintomaPrincipal);
      ok = r.ok; salida = r.mensaje || "";
      verificacion = { ok: true, detalle: "reinicio_servidor_en_curso" };
    }

    return {
      orden: 1, peldano: paso.peldano, objetivo, comando,
      inicio, fin: new Date().toISOString(), ok,
      salida: salida.slice(0, 2000),
      verificacion,
    };
  }

  /**
   * §6: reinicio del servidor completo. Condiciones ya validadas por
   * chequearLimiteYVentanas + el llamador (solo se llega aquí cuando ya se
   * agotaron los peldaños de menor impacto y el afectado sigue caído).
   */
  async function ejecutarReinicioServidorCompleto(run_id, S, incidenteSosId, emit, sintomaPrincipal) {
    db.escribirAtomico(db.RUTAS.pendienteReinicio, {
      run_id, incidente_sos_id: incidenteSosId, ts: new Date().toISOString(),
      sintoma_principal: sintomaPrincipal || null,
    });
    limites.registrar("reiniciar_servidor", { incidenteId: incidenteSosId });
    auditar("sos_reinicio_servidor", "sos", "ok", run_id);
    await enviarWhatsapp("Voy a reiniciar el servidor completo (último recurso). Tarda unos 2 minutos. Te escribo al volver.").catch(() => {});
    emit("resultado", "warn", "Voy a reiniciar el servidor completo. Vuelvo en unos minutos.", { resultado: "reinicio_servidor_en_curso" });
    registrarCorrida({
      run_id, incidente_sos_id: incidenteSosId, origen: enCurso.origen, inicio: enCurso.inicio,
      fin: new Date().toISOString(), resultado: "reinicio_servidor_en_curso",
    });
    bus.cerrarSuscriptores(run_id);
    enCurso = null;
    try { fs.unlinkSync(db.RUTAS.lock); } catch (_) {}
    sh("sleep 3 && /sbin/reboot").catch(() => {});
    return { ok: true, mensaje: "El servidor se está reiniciando" };
  }

  /**
   * Tras agotar el plan sin éxito, decide si corresponde escalar — y a QUÉ,
   * siguiendo CLAUDE.md pasos 6→7→8 en orden (reiniciar en orden de
   * dependencia → deshacer el despliegue si aplica → reiniciar el servidor
   * completo como último recurso). La decisión de QUÉ peldaño es pura (ver
   * `escalada.js`, con pruebas propias); aquí solo se consulta si ese
   * peldaño concreto está permitido ahora mismo (freno/permisos/horario/
   * ventana/límites).
   */
  async function decidirEscaladaFinal(diag, S, incidenteSosId, acciones, presupuestoAgotado) {
    const candidato = escalada.siguientePeldano({ diag, S, acciones, presupuestoAgotado });
    if (!candidato || candidato.detener) return candidato;
    const chk = await chequearLimiteYVentanas(candidato, incidenteSosId, S, diag);
    // Antes, si el freno/permisos/horario bloqueaban la escalada, el dueño
    // solo veía "tras reparar, el problema persiste" sin saber que Centinela
    // sí quería actuar y algo se lo impidió. Ahora ese motivo se propaga para
    // que quede en el mensaje final, sin ejecutar el peldaño bloqueado.
    if (!chk.ok) return { bloqueo: chk, intentado: candidato.peldano };
    return candidato;
  }

  // ── Cierres (F8) ───────────────────────────────────────────────────────────

  function completarSeccionAcciones(evidenciaId, acciones) {
    if (!evidenciaId) return;
    try {
      const p = db.leerJson(db.rutaEvidencia(evidenciaId), null);
      if (!p) return;
      const sec = p.secciones.find((s) => s.clave === "acciones");
      if (sec) {
        sec.texto = JSON.stringify(acciones.map((a) => ({ ...a, salida: (a.salida || "").slice(0, 300) })), null, 2).slice(0, 8192);
        sec.bytes = Buffer.byteLength(sec.texto, "utf8");
      }
      db.escribirAtomico(db.rutaEvidencia(evidenciaId), p);
    } catch (_) {}
  }

  async function cerrarComun(run_id, origen, emit, S, diag, acciones, evidenciaId, incidenteSosId, resultado, extra, inicioMs) {
    completarSeccionAcciones(evidenciaId, acciones);
    const corrida = {
      run_id, incidente_sos_id: incidenteSosId, origen, inicio: enCurso.inicio, fin: new Date().toISOString(),
      duracion_s: Math.round((Date.now() - inicioMs) / 1000),
      sintoma_principal: diag ? diag.sintoma_principal : "no_diagnosticable",
      sintomas_secundarios: (diag && diag.secundarios) || [],
      diagnostico: diag ? `${textos.tituloSintoma(diag.sintoma_principal)}${diag.culpable ? " (" + textos.nombreClaro(diag.culpable) + ")" : ""}, ${textoImpacto(diag)}` : "No se pudo diagnosticar.",
      afecta_clientes: diag ? diag.afecta_clientes : "desconocido",
      desde: estimarDesde(diag, S),
      evidencia_id: evidenciaId,
      acciones,
      resultado,
      limites_tocados: acciones.filter((a) => ["reiniciar_docker", "deshacer_despliegue", "reiniciar_servidor"].includes(a.peldano)).map((a) => a.peldano),
      ia: { usada: false, motivo: "no aplicable" },
      version: 1,
      ...extra,
    };
    // Si este mismo servicio ya abrió 3+ incidentes en la última hora,
    // avisa que reiniciarlo de nuevo probablemente no ataca la causa real —
    // sin esto, enBucle() detectaba el patrón pero nadie lo veía nunca.
    if (diag && diag.culpable && acciones.length > 0 && reglasSeguridad && typeof reglasSeguridad.enBucle === "function") {
      const historialIncidentes = (deps.baseIncidentes ? deps.baseIncidentes() : null);
      if (historialIncidentes && reglasSeguridad.enBucle(diag.culpable, historialIncidentes.historial || [])) {
        corrida.en_bucle = true;
        const aviso = `${textos.nombreClaro(diag.culpable)} ya falló 3 veces o más en la última hora — reiniciarlo de nuevo probablemente no resuelve la causa real. Hace falta revisar qué lo está tumbando.`;
        corrida.sugerencia = corrida.sugerencia ? `${corrida.sugerencia} ${aviso}` : aviso;
      }
    }
    corrida.mensaje_final = textos.mensajeFinal(corrida);
    registrarCorrida(corrida);
    if (typeof deps.alCerrarCorrida === "function") {
      try { deps.alCerrarCorrida(corrida); } catch (_) {}
    }

    const debeAvisar = origen === "bot" || acciones.length > 0 || resultado === "detenido_pide_ayuda";
    const modoViaje = deps.kapsoYModo && deps.F_MODO ? deps.kapsoYModo.obtenerModo(deps.leerJson, deps.F_MODO) : null;
    const silenciar = resultado === "sin_falla" && modoViaje && deps.kapsoYModo && deps.kapsoYModo.debeSilenciar("info", modoViaje);
    if (debeAvisar && !silenciar) {
      const r = await enviarWhatsapp(corrida.mensaje_final).catch(() => ({ ok: false }));
      if (!r.ok) auditar("centinela_respuesta_no_entregada", "sos", "aviso", run_id);
    }

    emit("resultado", resultado === "restablecido" || resultado === "sin_falla" ? "ok" : resultado === "parcial" ? "warn" : "crit",
      `SOS terminado: ${resultado}.`);
    bus.emitirFin(run_id, undefined, corrida.mensaje_final, { resultado, evidencia_id: evidenciaId, acciones, mensaje_final: corrida.mensaje_final, afecta_clientes: corrida.afecta_clientes, limites_tocados: corrida.limites_tocados });

    enCurso = null;
    try { fs.unlinkSync(db.RUTAS.lock); } catch (_) {}
  }

  async function cerrarExito(run_id, origen, emit, S, diag, acciones, evidenciaId, incidenteSosId, inicioMs) {
    const resultado = acciones.length ? "restablecido" : "sin_falla";
    return cerrarComun(run_id, origen, emit, S, diag, acciones, evidenciaId, incidenteSosId, resultado, {}, inicioMs);
  }
  async function cerrarSinFalla(run_id, origen, emit, S, diag, evidenciaId, inicioMs) {
    return cerrarComun(run_id, origen, emit, S, diag, [], evidenciaId, null, "sin_falla", {}, inicioMs);
  }
  async function cerrarParcial(run_id, origen, emit, S, diag, acciones, evidenciaId, incidenteSosId, inicioMs) {
    return cerrarComun(run_id, origen, emit, S, diag, acciones, evidenciaId, incidenteSosId, "parcial", {}, inicioMs);
  }
  async function cerrarDetenido(run_id, origen, emit, S, diag, acciones, evidenciaId, incidenteSosId, motivo, sugerencia, inicioMs) {
    return cerrarComun(run_id, origen, emit, S, diag, acciones, evidenciaId, incidenteSosId, "detenido_pide_ayuda", { motivo_detencion: motivo, sugerencia }, inicioMs);
  }
  async function cerrarNoDiagnosticable(run_id, origen, emit, diag, inicioMs) {
    const extras = { centinela: {} };
    const paquete = await evidencia.armarPaqueteMinimo({ S: null, diag, run_id, origen, tipo: "host_solamente" });
    const esc = evidencia.escribirPaquete(paquete);
    emit("diagnostico", "crit", "No pude leer el estado del servidor.");
    return cerrarComun(run_id, origen, emit, null, diag, [], esc.ok ? esc.id : null, null, "no_diagnosticable",
      { motivo_detencion: "No pude leer el estado del servidor.", sugerencia: "Abre el panel; si no carga en 5 min, repite el SOS. Si sigue igual, reinicia desde la consola de Linode." }, inicioMs);
  }

  // ── API de consulta ────────────────────────────────────────────────────────

  function estado() {
    const corridas = db.leerJsonl(db.RUTAS.corridas, 1000);
    const ultima = corridas[corridas.length - 1] || null;
    return {
      en_curso: enCurso ? { run_id: enCurso.run_id, inicio: enCurso.inicio, origen: enCurso.origen, fase: enCurso.fase, lleva_s: Math.round((Date.now() - new Date(enCurso.inicio).getTime()) / 1000) } : null,
      ultima: ultima ? { run_id: ultima.run_id, inicio: ultima.inicio, fin: ultima.fin, resultado: ultima.resultado, sintoma_principal: ultima.sintoma_principal, afecta_clientes: ultima.afecta_clientes, evidencia_id: ultima.evidencia_id, acciones: (ultima.acciones || []).length } : null,
      limites: limites.resumen(),
      simulacro_en_curso: !!(deps.simulacros && deps.simulacros.estado && deps.simulacros.estado().en_curso),
      ts: new Date().toISOString(),
    };
  }

  function suscribir(runId, res, desde) { return bus.suscribir(runId, res, desde); }

  function corridas(limite) {
    const todas = db.leerJsonl(db.RUTAS.corridas, 1000).reverse();
    const n = Math.min(limite || 50, 100);
    return { corridas: todas.slice(0, n).map((c) => { const { mensaje_final, acciones, ...resto } = c; return { ...resto, acciones: (acciones || []).length }; }), total: todas.length };
  }

  function corrida(runId) {
    return db.leerJsonl(db.RUTAS.corridas, 1000).reverse().find((c) => c.run_id === runId) || null;
  }

  function borrarCorridas({ run_id, todos, confirmacion, con_evidencia }) {
    if (todos && confirmacion !== "BORRAR-TODO") return { ok: false, code: 422, mensaje: "Palabra de confirmación incorrecta." };
    if (!todos && confirmacion !== "BORRAR") return { ok: false, code: 422, mensaje: "Palabra de confirmación incorrecta." };
    if (enCurso && (todos || enCurso.run_id === run_id)) return { ok: false, code: 409, mensaje: "Hay una corrida en curso; no se puede borrar." };

    const todas = db.leerJsonl(db.RUTAS.corridas, 1000);
    let borradas = 0, evidenciasBorradas = 0;
    const conservar = [];
    for (const c of todas) {
      const marcar = todos || c.run_id === run_id;
      if (!marcar) { conservar.push(c); continue; }
      borradas++;
      try { fs.unlinkSync(db.rutaEventos(c.run_id)); } catch (_) {}
      if (con_evidencia && c.evidencia_id) {
        const r = evidencia.borrar({ id: c.evidencia_id }, {});
        if (r.ok) evidenciasBorradas++;
      }
    }
    fs.writeFileSync(db.RUTAS.corridas, conservar.map((c) => JSON.stringify(c)).join("\n") + (conservar.length ? "\n" : ""));
    if (!run_id && !todos) return { ok: false, code: 404, mensaje: "No existe." };
    if (!todos && borradas === 0) return { ok: false, code: 404, mensaje: "No existe." };
    return { ok: true, borradas, evidencias_borradas: evidenciasBorradas };
  }

  function desbloquear(accion, confirmacion) {
    if (confirmacion !== "PERMITIR") return { ok: false, code: 422, mensaje: "Palabra de confirmación incorrecta." };
    const r = limites.desbloquear(accion);
    if (!r.ok) return { ok: false, code: 400, mensaje: r.motivo };
    auditar("sos_desbloqueo", "panel", "ok", accion);
    return { ok: true, limites: limites.resumen() };
  }

  /** Se llama en servidor.listen(): cierra un lock huérfano si zeus-ops se reinició a mitad de una corrida. */
  async function reconciliarAlArrancar() {
    if (fs.existsSync(db.RUTAS.pendienteReinicio)) return; // lo maneja reanudarTrasReinicio
    let lock;
    try { lock = JSON.parse(fs.readFileSync(db.RUTAS.lock, "utf8")); } catch (_) { return; }
    if (!lock || !lock.run_id) { try { fs.unlinkSync(db.RUTAS.lock); } catch (_) {} return; }
    auditar("sos_interrumpido", "agente", "detectado", lock.run_id);
    registrarCorrida({
      run_id: lock.run_id, incidente_sos_id: null, origen: "agente", inicio: lock.inicio,
      fin: new Date().toISOString(), resultado: "interrumpida_por_reinicio",
      mensaje_final: "El SOS se interrumpió porque Centinela se reinició a mitad de la corrida. Lanza el SOS de nuevo.",
    });
    try {
      bus.emitirFin(lock.run_id, undefined, "Se interrumpió por un reinicio de Centinela. Lanza el SOS de nuevo.", { resultado: "interrumpida_por_reinicio" });
    } catch (_) {}
    try { fs.unlinkSync(db.RUTAS.lock); } catch (_) {}
  }

  /** Se llama en servidor.listen(): retoma una corrida suspendida por §6.2. */
  async function reanudarTrasReinicio() {
    const pendiente = db.leerJson(db.RUTAS.pendienteReinicio, null);
    if (!pendiente) return;
    await dormir(180000);
    cache.delete("contenedores");
    const { S, diag } = await diagnosticarF1();
    const resultado = (diag.sintoma_principal === "todo_bien") ? "restablecido" : "detenido_pide_ayuda";
    const extras = { centinela: {} };
    const paquete = await evidencia.armarPaqueteMinimo({ S, diag, run_id: pendiente.run_id, incidente_sos_id: pendiente.incidente_sos_id, origen: "agente", tipo: "post_reinicio" });
    const esc = evidencia.escribirPaquete(paquete);

    const corrida = {
      run_id: pendiente.run_id, incidente_sos_id: pendiente.incidente_sos_id, origen: "agente",
      inicio: pendiente.ts, fin: new Date().toISOString(), resultado,
      sintoma_principal: diag.sintoma_principal, afecta_clientes: diag.afecta_clientes,
      diagnostico: resultado === "restablecido" ? "El servidor volvió y todo atiende." : `Reinicié el servidor y ${textos.tituloSintoma(diag.sintoma_principal).toLowerCase()}.`,
      evidencia_id: esc.ok ? esc.id : null, acciones: [],
      motivo_detencion: resultado === "detenido_pide_ayuda" ? "Reinicié el servidor y el problema sigue. No voy a hacer nada más." : undefined,
      sugerencia: resultado === "detenido_pide_ayuda" ? "Hace falta que una persona revise el servidor directamente." : undefined,
      version: 1,
    };
    corrida.mensaje_final = textos.mensajeFinal(corrida);
    registrarCorrida({ ...corrida, actualizacion: true });
    await enviarWhatsapp(corrida.mensaje_final).catch(() => {});
    try { bus.emitirFin(pendiente.run_id, undefined, corrida.mensaje_final, { resultado }); } catch (_) {}
    try { fs.unlinkSync(db.RUTAS.pendienteReinicio); } catch (_) {}
  }

  /** Opción 10 del menú de WhatsApp: reinicio manual del bot con el mismo motor de verificación y límites por hora. */
  // Acción MANUAL (opción 10 del menú de WhatsApp) — a propósito NO pasa por
  // puedeActuar(): freno/permisos/horario nunca bloquean lo que un humano
  // ejecuta directamente (CLAUDE.md, "Capa de seguridad sobre lo autónomo").
  // Solo el límite duro de reinicios por hora/día sigue aplicando, igual que
  // antes. No "unificar" esto con el resto del SOS.
  async function ejecutarReinicioBotManual(origen) {
    const chk = limites.puede("reiniciar_contenedor", { objetivo: "zeus-bot" });
    if (!chk.ok) return { ok: false, mensaje: chk.motivo };
    const r = await ejecutarReiniciarContenedor("zeus-bot");
    limites.registrar("reiniciar_contenedor", { objetivo: "zeus-bot" });
    const v = await verificarObjetivo("zeus-bot", ESPERA_VERIF["zeus-bot"]);
    auditar("reiniciar_contenedor", origen || "bot", r.ok && v.ok ? "ok" : "falló", "zeus-bot (SOS opción 10)");
    return { ok: r.ok && v.ok, mensaje: v.ok ? `El bot se reinició y ya atiende (${v.detalle}).` : `Reinicié el bot y no volvió a atender: ${v.detalle}. Hace falta una persona.` };
  }

  /** Últimos 3 campos de la última corrida, para preguntas libres del dueño (§19.2). */
  function resumenParaContexto() {
    const c = corrida(null) || db.leerJsonl(db.RUTAS.corridas, 1).slice(-1)[0];
    if (!c) return null;
    return { sintoma_principal: c.sintoma_principal, resultado: c.resultado, fin: c.fin };
  }

  return {
    lanzar, estado, suscribir, corridas, corrida, borrarCorridas, desbloquear,
    reconciliarAlArrancar, reanudarTrasReinicio, ejecutarReinicioBotManual, resumenParaContexto,
    evidencia, limites,
    NUNCA_SOLO,
  };
}

module.exports = { crearSos, NUNCA_SOLO, CONTENEDORES_PROPIOS };
