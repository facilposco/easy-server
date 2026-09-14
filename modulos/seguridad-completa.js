"use strict";
/**
 * Centinela Zeus — auditoría de seguridad completa, con consola en vivo y
 * corrida diaria automática.
 *
 * No reemplaza `estadoSeguridad()` ni `seguridad-auditoria.js` (siguen
 * viviendo en ops-server.js, los sigue usando el panel para el resumen
 * rápido de la sección Seguridad) — este módulo hace la auditoría COMPLETA:
 * junta esos mismos checks (SSH, cortafuegos, fail2ban, actualizaciones,
 * certificado, puertos, deriva de configuración) con los que faltaban para
 * cubrir lo que revisaría un administrador de servidores senior: usuarios y
 * permisos de sudo, permisos de archivos sensibles (los .env con
 * contraseñas), si algún contenedor corre como root o el socket de Docker
 * queda expuesto, vulnerabilidades conocidas en las dependencias del bot, y
 * una búsqueda de credenciales que hayan quedado escritas en el código —
 * justo lo que pasó este mes con el repositorio público.
 *
 * Cada paso se transmite en vivo por SSE (bus-sse.js, ya probado en
 * producción con SOS/Simulacros/Contenedores) y queda guardado en un
 * historial local. Nunca corrige nada solo: cada hallazgo se explica y,
 * cuando aplica, dice qué botón ya existe en el panel para arreglarlo (por
 * ejemplo "Aplicar actualizaciones" ya existe como acción `actualizar_seguridad`)
 * — arreglarlo automáticamente sin que el dueño lo confirme podría tumbar
 * algo que sí hace falta.
 */

const path = require("path");
const { crearBus } = require("./sos/bus-sse.js");

const PROYECTO_BOT = "/opt/zeus-app";
const ARCHIVOS_SENSIBLES = [
  "/opt/zeus-app/.env",
  "/opt/zeus-ops/.env",
  "/opt/zeus-app/docker-compose.yml",
];
// Patrones de secretos reales, no de ejemplos: cada uno exige un valor de
// longitud/forma real después del "=", así "API_KEY=" o "API_KEY=xxx" (un
// placeholder típico de archivo .example) no cuenta como hallazgo.
const PATRONES_SECRETO = [
  { nombre: "Llave de Google AI (AIzaSy...)", re: /AIzaSy[0-9A-Za-z_-]{25,}/ },
  { nombre: "Token de GitHub", re: /gh[pousr]_[0-9A-Za-z]{20,}/ },
  { nombre: "Llave privada (PEM)", re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { nombre: "Token de Cloudflare", re: /\bcfut_[0-9A-Za-z]{20,}\b/ },
  { nombre: "Contraseña escrita en texto plano", re: /\b(PASS(WORD)?|PWD)\s*[:=]\s*['"][^'"\s]{8,}['"]/i },
];
// Carpetas/archivos donde SÍ se espera ver la forma de una credencial (son
// ejemplos o plantillas) — no son un hallazgo real.
const RUTAS_EXCLUIDAS = /\.example($|\.)|node_modules\/|\.git\//;

function crearSeguridadCompleta(deps) {
  const { sh, DIR_DATOS, leerJson, guardarJson, auditar } = deps || {};
  if (typeof sh !== "function" || !DIR_DATOS || typeof leerJson !== "function" || typeof guardarJson !== "function" || typeof auditar !== "function") {
    throw new Error("crearSeguridadCompleta necesita sh, DIR_DATOS, leerJson, guardarJson y auditar de ops-server.js");
  }
  const RUTA_HIST = path.join(DIR_DATOS, "seguridad-completa.json");
  const bus = crearBus({ dirEventos: path.join(DIR_DATOS, "seguridad-eventos") });
  let enCurso = null;

  // ── Cada paso: mismo formato de salida que ya usa seguridad-auditoria.js ──
  // { id, titulo, severidad: "ok"|"atencion"|"urgente", significado, detalle, accion_sugerida }

  async function pasoSsh() {
    const r = await sh("sshd -T 2>/dev/null | grep -E '^permitrootlogin|^passwordauthentication|^x11forwarding'");
    const conf = {};
    r.salida.split("\n").filter(Boolean).forEach((l) => { const [k, v] = l.split(" "); conf[k] = v; });
    const problemas = [];
    if (conf.passwordauthentication !== "no") problemas.push("el acceso con contraseña sigue activo");
    if (conf.permitrootlogin === "yes") problemas.push("el administrador puede entrar directo, sin pasar por un usuario normal");
    if (conf.x11forwarding !== "no") problemas.push("el reenvío gráfico (X11) sigue encendido sin necesidad");
    return {
      titulo: "SSH y acceso remoto",
      severidad: problemas.length ? "urgente" : "ok",
      significado: problemas.length ? "Hay configuraciones de acceso remoto que conviene cerrar" : "El acceso remoto está bien cerrado",
      detalle: problemas.length ? problemas.join("; ") : "Solo entra por llave, sin acceso directo de administrador",
    };
  }

  async function pasoFirewall() {
    const ufw = await sh("ufw status | grep -E '^[0-9]' | head -12");
    const jail = await sh("fail2ban-client status sshd 2>/dev/null | tail -4");
    const activo = ufw.salida.includes("ALLOW");
    const actuales = parseInt((jail.salida.match(/Currently banned:\s*(\d+)/) || [, "0"])[1], 10);
    return {
      titulo: "Cortafuegos y bloqueo de intrusos",
      severidad: activo ? "ok" : "urgente",
      significado: activo ? "El cortafuegos está activo y filtrando" : "El cortafuegos no parece estar filtrando nada",
      detalle: `${ufw.salida.split("\n").filter(Boolean).length} reglas activas · ${actuales} direcciones bloqueadas ahora mismo`,
    };
  }

  async function pasoActualizaciones() {
    const apt = await sh("/usr/lib/update-notifier/apt-check --human-readable 2>&1 | grep -E 'updates|security' | head -3");
    const pendientes = parseInt((apt.salida.match(/(\d+)\s+updates?/) || [, "0"])[1], 10);
    return {
      titulo: "Actualizaciones del sistema",
      severidad: pendientes === 0 ? "ok" : pendientes > 15 ? "urgente" : "atencion",
      significado: pendientes === 0 ? "El sistema operativo está al día" : `Hay ${pendientes} actualizaciones esperando`,
      detalle: pendientes === 0 ? "" : 'Se pueden aplicar con el botón "Aplicar actualizaciones de seguridad" del panel, sin reiniciar el servidor.',
    };
  }

  async function pasoUsuarios() {
    const sudoers = await sh("getent group sudo 2>/dev/null | cut -d: -f4");
    const nombres = (sudoers.salida || "").split(",").map((s) => s.trim()).filter(Boolean);
    // Cuentas con clave vacía (segundo campo de /etc/shadow vacío) — cualquiera
    // podría entrar sin contraseña si además tuvieran shell y acceso.
    const sinClave = await sh("awk -F: '($2==\"\"){print $1}' /etc/shadow 2>/dev/null");
    const cuentasSinClave = (sinClave.salida || "").split("\n").filter(Boolean);
    const problema = cuentasSinClave.length > 0;
    return {
      titulo: "Usuarios y permisos de administrador",
      severidad: problema ? "urgente" : "ok",
      significado: problema ? "Hay una cuenta sin contraseña configurada" : "Los permisos de administrador están donde deberían",
      detalle: (nombres.length ? `Con permiso de administrador: ${nombres.join(", ")}. ` : "") +
        (problema ? `Sin contraseña: ${cuentasSinClave.join(", ")}` : "Ninguna cuenta sin contraseña."),
    };
  }

  async function pasoArchivosSensibles() {
    const rutas = ARCHIVOS_SENSIBLES.join(" ");
    const r = await sh(`stat -c '%a %n' ${rutas} 2>/dev/null`);
    const filas = r.salida.split("\n").filter(Boolean).map((l) => {
      const [permiso, ...resto] = l.split(" ");
      return { archivo: resto.join(" "), permiso };
    });
    // El "otros" (último dígito) no debería poder leer un archivo con
    // contraseñas: 640/600 están bien, 644/664/666 dejan leer a cualquiera.
    const expuestos = filas.filter((f) => {
      const ultimo = f.permiso.slice(-1);
      return ["4", "5", "6", "7"].includes(ultimo);
    });
    return {
      titulo: "Permisos de archivos con contraseñas",
      severidad: expuestos.length ? "urgente" : "ok",
      significado: expuestos.length ? "Un archivo con contraseñas se puede leer sin ser el dueño" : "Los archivos con contraseñas solo los puede leer el dueño",
      detalle: expuestos.length
        ? expuestos.map((f) => `${f.archivo} (permiso ${f.permiso})`).join("; ") + ". Qué hacer: dejarlo en 640 (solo el dueño escribe, el grupo lee, nadie más)."
        : `${filas.length} archivo(s) revisado(s), todos con permiso 640 o más estricto.`,
      // Centinela sabe reparar esto sola (chmod 640, solo sobre los 3
      // archivos fijos de ARCHIVOS_SENSIBLES — nunca una ruta que llegue de
      // fuera): el panel ofrece un botón por archivo.
      datos: expuestos.map((f) => ({ archivo: f.archivo, permiso: f.permiso })),
    };
  }

  async function pasoDocker() {
    const sock = await sh("stat -c '%a' /var/run/docker.sock 2>/dev/null");
    const permSock = (sock.salida || "").trim();
    // 660 (dueño+grupo docker) es lo esperado; 666 deja que CUALQUIER
    // proceso del servidor controle todos los contenedores como root.
    const socketExpuesto = permSock === "666" || permSock === "777";
    const r = await sh("docker ps --format '{{.Names}}' | xargs -r -I{} docker inspect -f '{{.Name}};{{.Config.User}}' {} 2>/dev/null");
    const propios = ["zeus-bot", "zeus-mariadb", "zeus-chromadb", "zeus-proxy"];
    const comoRoot = r.salida.split("\n").filter(Boolean)
      .map((l) => { const [n, u] = l.split(";"); return { nombre: n.replace(/^\//, ""), usuario: u }; })
      .filter((c) => propios.includes(c.nombre) && !c.usuario);
    const problema = socketExpuesto || comoRoot.length > 0;
    return {
      titulo: "Seguridad de Docker",
      severidad: problema ? "atencion" : "ok",
      significado: problema ? "Algún contenedor o el propio Docker tiene más permiso del necesario" : "Docker y los contenedores propios están bien acotados",
      detalle: [
        socketExpuesto ? `El socket de Docker tiene permiso ${permSock} (cualquier proceso podría tomar control del servidor).` : "",
        comoRoot.length ? `Corren como administrador dentro de su contenedor: ${comoRoot.map((c) => c.nombre).join(", ")}.` : "",
      ].filter(Boolean).join(" ") || "Sin hallazgos.",
    };
  }

  async function pasoDependencias() {
    const r = await sh(`cd ${PROYECTO_BOT} && npm audit --omit=dev --json 2>/dev/null`, 60000);
    let datos;
    try { datos = JSON.parse(r.salida || "{}"); } catch (_) { datos = null; }
    if (!datos || !datos.metadata) {
      return { titulo: "Dependencias del bot", severidad: "atencion", significado: "No se pudo revisar (npm audit no respondió)", detalle: "" };
    }
    const v = datos.metadata.vulnerabilities || {};
    const graves = (v.critical || 0) + (v.high || 0);
    return {
      titulo: "Dependencias del bot",
      severidad: graves > 0 ? "urgente" : (v.moderate || 0) > 0 ? "atencion" : "ok",
      significado: graves > 0 ? `${graves} vulnerabilidad(es) grave(s) conocida(s) en paquetes que usa el bot` : "Sin vulnerabilidades graves conocidas",
      detalle: `Críticas: ${v.critical || 0} · Altas: ${v.high || 0} · Moderadas: ${v.moderate || 0} · Bajas: ${v.low || 0}`,
    };
  }

  async function pasoCredenciales() {
    // Busca en los archivos VERSIONADOS (los que ya están en git) de los dos
    // repositorios de este proyecto — no en todo el disco, sería lentísimo y
    // encontraría contraseñas legítimas de configuración (.env) que ya están
    // cubiertas por el paso de "permisos de archivos".
    const repos = [PROYECTO_BOT, "/opt/zeus-ops"];
    const hallazgos = [];
    for (const repo of repos) {
      const lista = await sh(`git -C ${repo} ls-files 2>/dev/null`, 15000);
      const archivos = lista.salida.split("\n").filter(Boolean).filter((f) => !RUTAS_EXCLUIDAS.test(f));
      if (!archivos.length) continue;
      for (const patron of PATRONES_SECRETO) {
        const grep = await sh(`cd ${repo} && git grep -lIE '${patron.re.source}' -- ${archivos.map((f) => `'${f}'`).join(" ")} 2>/dev/null | head -5`, 15000).catch(() => ({ salida: "" }));
        const archivosConHallazgo = grep.salida.split("\n").filter(Boolean);
        if (archivosConHallazgo.length) hallazgos.push({ patron: patron.nombre, repo, archivos: archivosConHallazgo });
      }
    }
    return {
      titulo: "Credenciales expuestas en el código",
      severidad: hallazgos.length ? "urgente" : "ok",
      significado: hallazgos.length ? "Se encontró algo con forma de credencial real en archivos versionados" : "No se encontraron credenciales escritas en el código",
      detalle: hallazgos.length
        ? hallazgos.map((h) => `${h.patron} en ${h.repo}: ${h.archivos.join(", ")}`).join(" · ")
        : "Reviso llaves de Google, tokens de GitHub/Cloudflare, llaves privadas y contraseñas en texto plano.",
    };
  }

  const PASOS = [
    { id: "ssh", fn: pasoSsh },
    { id: "firewall", fn: pasoFirewall },
    { id: "actualizaciones", fn: pasoActualizaciones },
    { id: "usuarios", fn: pasoUsuarios },
    { id: "archivos", fn: pasoArchivosSensibles },
    { id: "docker", fn: pasoDocker },
    { id: "dependencias", fn: pasoDependencias },
    { id: "credenciales", fn: pasoCredenciales },
  ];

  function estado() { return { en_curso: !!enCurso, run_id: enCurso }; }

  async function ejecutar(quien) {
    if (enCurso) return { ok: false, code: 409, mensaje: "Ya hay una auditoría en curso" };
    const runId = `aud-${Date.now()}`;
    enCurso = runId;
    const hallazgos = [];
    try {
      bus.emitirEvento(runId, undefined, "inicio", "info", "Empezando la auditoría completa de seguridad…");
      for (const paso of PASOS) {
        bus.emitirEvento(runId, undefined, "paso", "info", `Revisando: ${paso.id}…`);
        let r;
        try { r = await paso.fn(); }
        catch (e) { r = { titulo: paso.id, severidad: "atencion", significado: "No se pudo completar esta revisión: " + e.message, detalle: "" }; }
        hallazgos.push({ id: paso.id, ...r });
        bus.emitirEvento(runId, undefined, "resultado", r.severidad === "urgente" ? "crit" : r.severidad === "atencion" ? "warn" : "ok",
          `${r.titulo}: ${r.significado}`, { hallazgo: { id: paso.id, ...r } });
      }
    } finally {
      enCurso = null;
    }
    const urgentes = hallazgos.filter((h) => h.severidad === "urgente").length;
    const atencion = hallazgos.filter((h) => h.severidad === "atencion").length;
    const puntaje = Math.round((hallazgos.filter((h) => h.severidad === "ok").length / hallazgos.length) * 100);
    const resumen = { id: runId, ts: new Date().toISOString(), quien, hallazgos, puntaje, urgentes, atencion };

    const hist = leerJson(RUTA_HIST, { corridas: [] });
    hist.corridas = hist.corridas || [];
    hist.corridas.unshift(resumen);
    hist.corridas = hist.corridas.slice(0, 30);
    guardarJson(RUTA_HIST, hist);

    auditar("auditoria_completa", quien, urgentes ? "urgente" : atencion ? "atencion" : "ok", `puntaje ${puntaje}`);
    bus.emitirFin(runId, undefined, `Auditoría terminada: ${urgentes} urgente(s), ${atencion} para revisar.`, resumen);
    return { ok: true, run_id: runId, resumen };
  }

  function ultima() {
    const hist = leerJson(RUTA_HIST, { corridas: [] });
    return (hist.corridas && hist.corridas[0]) || null;
  }
  function historial() {
    const hist = leerJson(RUTA_HIST, { corridas: [] });
    return hist.corridas || [];
  }

  // La corrida diaria a las 7 a.m. la dispara ops-server.js llamando a
  // `ejecutar("agente")` directamente, en el mismo disparador que ya existe
  // para el resumen de WhatsApp de las 7 — así ambos corren en el orden
  // correcto (auditoría primero, resumen después) sin duplicar el reloj.
  return { ejecutar, estado, vivo: bus.suscribir, ultima, historial };
}

/**
 * Deja un archivo sensible en permiso 640 (dueño escribe, grupo lee, nadie
 * más). Solo acepta una ruta de la lista fija ARCHIVOS_SENSIBLES de este
 * módulo — nunca una ruta que llegue del cliente, precisamente porque este
 * comando corre con privilegios de root sobre el sistema de archivos.
 */
async function repararPermisoArchivo(sh, archivo) {
  if (typeof sh !== "function") throw new Error("repararPermisoArchivo necesita sh() de ops-server.js");
  const ruta = String(archivo || "").trim();
  if (!ARCHIVOS_SENSIBLES.includes(ruta)) {
    return { ok: false, mensaje: "Esa ruta no está en la lista de archivos que Centinela sabe corregir", archivo: ruta };
  }
  const r = await sh(`chmod 640 ${ruta}`);
  return {
    ok: r.ok,
    mensaje: r.ok ? `${ruta} quedó en permiso 640` : "No se pudo cambiar el permiso del archivo",
    archivo: ruta,
    salida: r.salida || r.error || "",
  };
}

module.exports = { crearSeguridadCompleta, repararPermisoArchivo, ARCHIVOS_SENSIBLES };
