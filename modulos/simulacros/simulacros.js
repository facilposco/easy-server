"use strict";
/**
 * Centinela Zeus — módulo de simulacros (ingeniería del caos).
 *
 * PROPUESTA AISLADA, igual que `db-optimizacion.js`, `seguridad-auditoria.js`
 * y `orquestador-despliegue.js`: no toca nada hasta que `ops-server.js` lo
 * `require()`, lo instancie con `crearSimulacros(deps)` y llame a sus
 * funciones desde una ruta HTTP. Ver `INTEGRACION-SIMULACROS.md` para el
 * punto exacto de conexión.
 *
 * Sigue el mismo patrón de bajo acoplamiento que `orquestador-despliegue.js`:
 * recibe por parámetro las funciones que ya existen en `ops-server.js` (`sh`,
 * `auditar`, `enviarWhatsapp`, `leerContenedores`, `estadoGeneral`,
 * `estadoDatos`, `leerDisco`, `leerMemoria`, `leerCpu`, `cache`, `DIR_DATOS`,
 * `env`), y usa sus propias utilidades locales (`fs`, `path`, `https`,
 * `crypto`) para todo lo demás. Cero dependencias externas: solo librería
 * estándar de Node 20.
 *
 * ── Qué es cada simulacro ────────────────────────────────────────────────
 * Provoca a propósito una falla pequeña y acotada (matar el bot, cargar la
 * CPU, forzar un OOM dentro de un contenedor desechable, llenar el disco al
 * 91%, forzar un 5xx en dos hosts de Traefik, o pausar MariaDB 45 s) para
 * comprobar que Centinela la detecta y se recupera solo. Cada simulacro
 * programa su propia reversión como unidad `systemd-run --on-active=…`
 * ANTES de causar el daño: si este proceso muere, si se reinicia, o si el
 * servidor queda aislado, la reversión ocurre igual a nivel de sistema
 * operativo (ver §2.5 del diseño). `reconciliarAlArrancar()` cierra
 * cualquier corrida huérfana que haya dejado un reinicio a mitad de camino.
 *
 * ── Corrección aplicada sobre el diseño original ─────────────────────────
 * El diseño (DISENO-FASE-CAOS.md) supone que el entryPoint TLS de Traefik se
 * llama `websecure`. Verificado contra `docker inspect zeus-proxy` en el
 * servidor real: es falso. Los entryPoints reales son `http` (:80) y
 * `https` (:443). El simulacro de red (§2.6 #5) usa `https` en el YAML que
 * escribe, no `websecure`.
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const crypto = require("crypto");

// ── Utilidades locales (el módulo no depende de las internas de ops-server) ─

function dormir(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function leerJsonLocal(archivo, porDefecto) {
  try { return JSON.parse(fs.readFileSync(archivo, "utf8")); } catch (_) { return porDefecto; }
}

function guardarJsonLocal(archivo, obj) {
  try { fs.writeFileSync(archivo, JSON.stringify(obj, null, 2)); } catch (_) {}
}

function anexarLocal(archivo, obj) {
  try { fs.appendFileSync(archivo, JSON.stringify(obj) + "\n"); } catch (_) {}
}

function leerJsonlLocal(archivo, max) {
  try {
    const lineas = fs.readFileSync(archivo, "utf8").trim().split("\n").slice(-(max || 20000));
    return lineas.filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
  } catch (_) { return []; }
}

/** Escribe un archivo de forma atómica: nunca deja a Traefik (o a quien lea) a medio archivo. */
function escribirAtomico(rutaFinal, contenido) {
  const tmp = rutaFinal + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, contenido);
  fs.renameSync(tmp, rutaFinal);
}

/** GET https:// que devuelve JSON o null ante cualquier fallo. Para el vigilante externo. */
function pedirJsonHttps(url, timeout) {
  return new Promise((resolve) => {
    const req = https.get(url, { timeout: timeout || 8000 }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch (_) { resolve(null); } });
    });
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.on("error", () => resolve(null));
  });
}

/** Comparación de PIN de longitud constante (evita side-channel por tiempo). */
function pinValido(candidato, real) {
  const a = String(candidato == null ? "" : candidato);
  const b = String(real == null ? "" : real);
  const max = Math.max(a.length, b.length, 1);
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < max; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/**
 * Sondea `comprobar()` hasta que devuelva un valor "truthy" o se agote
 * `timeoutMs`. Si `ctx.abortado` se vuelve true (petición de aborto manual),
 * corta de inmediato. Devuelve { logrado, ms, valor }.
 */
async function esperar(comprobar, timeoutMs, intervaloMs, ctx) {
  const inicio = Date.now();
  const paso = intervaloMs || 1000;
  while (Date.now() - inicio < timeoutMs) {
    if (ctx && ctx.abortado) return { logrado: false, ms: Date.now() - inicio, valor: null, abortado: true };
    let v;
    try { v = await comprobar(); } catch (_) { v = null; }
    if (v) return { logrado: true, ms: Date.now() - inicio, valor: v };
    await dormir(paso);
  }
  let v = null;
  try { v = await comprobar(); } catch (_) {}
  return { logrado: !!v, ms: Date.now() - inicio, valor: v };
}

function minutosHastaHoraUtc(horaUtc) {
  const ahora = new Date();
  const obj = new Date(Date.UTC(ahora.getUTCFullYear(), ahora.getUTCMonth(), ahora.getUTCDate(), horaUtc, 0, 0));
  if (obj < ahora) obj.setUTCDate(obj.getUTCDate() + 1);
  return (obj - ahora) / 60000;
}

// ── Fábrica del módulo ───────────────────────────────────────────────────────
/**
 * @param {object} deps
 * @param {function} deps.sh               igual que sh() en ops-server.js
 * @param {function} deps.auditar          igual que auditar() en ops-server.js
 * @param {function} deps.enviarWhatsapp   igual que enviarWhatsapp() en ops-server.js
 * @param {function} deps.leerContenedores igual que leerContenedores() en ops-server.js
 * @param {function} deps.estadoGeneral    igual que estadoGeneral() en ops-server.js
 * @param {function} deps.estadoDatos      igual que estadoDatos() en ops-server.js
 * @param {function} deps.leerDisco        igual que leerDisco() en ops-server.js
 * @param {function} deps.leerMemoria      igual que leerMemoria() en ops-server.js
 * @param {function} deps.leerCpu          igual que leerCpu() en ops-server.js
 * @param {Map}      deps.cache            el Map de caché de ops-server.js
 * @param {string}   deps.DIR_DATOS        "/var/lib/zeus-ops"
 * @param {object}   deps.env              objeto de leerEnv("/opt/zeus-ops/.env") → PIN_SIMULACRO, TOKEN_PRUEBA_VIGILANTE
 * @param {function} [deps.explicar]       opcional: explicar(nombre,motivo,ram,disco) de ops-server.js (ver nota en INTEGRACION-SIMULACROS.md — no estaba en la lista original de dependencias del diseño §2.1)
 * @param {number}   [deps.HORA_REINICIO_UTC] opcional, por defecto 9 (04:00 Colombia)
 * @param {number}   [deps.HORA_RESPALDO_UTC]  opcional, por defecto 8 (03:00 Colombia)
 */
function crearSimulacros(deps) {
  if (typeof deps.sh !== "function") throw new Error("crearSimulacros necesita la función sh() de ops-server.js");
  if (typeof deps.auditar !== "function") throw new Error("crearSimulacros necesita la función auditar() de ops-server.js");
  if (!deps.DIR_DATOS) throw new Error("crearSimulacros necesita DIR_DATOS de ops-server.js");

  const sh = deps.sh;
  const auditar = deps.auditar;
  const enviarWhatsapp = deps.enviarWhatsapp || (async () => ({ ok: false }));
  const env = deps.env || {};
  const HORA_REINICIO_UTC = typeof deps.HORA_REINICIO_UTC === "number" ? deps.HORA_REINICIO_UTC : 9;
  const HORA_RESPALDO_UTC = typeof deps.HORA_RESPALDO_UTC === "number" ? deps.HORA_RESPALDO_UTC : 8;

  const DIR_SIMULACROS = path.join(deps.DIR_DATOS, "simulacros");
  const F_LOCK = path.join(deps.DIR_DATOS, "simulacro.lock");
  const F_ESTADO = path.join(deps.DIR_DATOS, "simulacros.json");
  const F_AUDIT = path.join(deps.DIR_DATOS, "auditoria.jsonl"); // ya existe, solo lectura desde aquí
  const F_INCID = path.join(deps.DIR_DATOS, "incidentes.json"); // ya existe, solo lectura desde aquí

  fs.mkdirSync(DIR_SIMULACROS, { recursive: true });

  function archivoCorrida(runId) { return path.join(DIR_SIMULACROS, runId + ".jsonl"); }

  function estadoPersistido() { return leerJsonLocal(F_ESTADO, { en_curso: null, ultimos: {} }); }
  function guardarEstadoPersistido(obj) { guardarJsonLocal(F_ESTADO, obj); }

  function invalidarCache() {
    if (deps.cache && typeof deps.cache.delete === "function") {
      deps.cache.delete("contenedores");
      deps.cache.delete("datos");
    }
  }

  function dentroDeVentanaSensible() {
    const mResp = minutosHastaHoraUtc(HORA_RESPALDO_UTC);
    const mReinicio = minutosHastaHoraUtc(HORA_REINICIO_UTC);
    if (mResp < 20) return `Faltan ${Math.round(mResp)} minuto(s) para el respaldo diario. Espera a que termine e intenta de nuevo.`;
    if (mReinicio < 20) return `Faltan ${Math.round(mReinicio)} minuto(s) para el reinicio diario del servidor. Espera a que termine e intenta de nuevo.`;
    return null;
  }

  // ── Bus de eventos SSE (§2.2) ──────────────────────────────────────────────
  const suscriptores = new Map(); // run_id -> Set<res>
  const latidos = new Map(); // run_id -> intervalId
  const contadoresSeq = new Map(); // run_id -> próximo seq

  function siguienteSeq(runId) {
    if (!contadoresSeq.has(runId)) {
      // Primer evento que este proceso emite para esta corrida: si el archivo
      // ya tenía líneas (por ejemplo, una corrida huérfana reconciliada tras
      // un reinicio de zeus-ops), se continúa la numeración en vez de
      // reiniciarla en 0, para no duplicar "seq" dentro del mismo .jsonl.
      const previos = leerJsonlLocal(archivoCorrida(runId));
      const maxPrevio = previos.reduce((m, e) => (typeof e.seq === "number" && e.seq > m ? e.seq : m), -1);
      contadoresSeq.set(runId, maxPrevio + 1);
    }
    const n = contadoresSeq.get(runId);
    contadoresSeq.set(runId, n + 1);
    return n;
  }

  function emitirEvento(runId, simulacroId, fase, nivel, texto, dato) {
    const evento = {
      ts: new Date().toISOString(),
      run_id: runId,
      simulacro: simulacroId,
      seq: siguienteSeq(runId),
      fase, nivel, texto,
      dato: dato === undefined ? undefined : dato,
    };
    anexarLocal(archivoCorrida(runId), evento);
    const subs = suscriptores.get(runId);
    if (subs && subs.size) {
      const payload = `event: paso\nid: ${evento.seq}\ndata: ${JSON.stringify(evento)}\n\n`;
      for (const res of subs) { try { res.write(payload); } catch (_) {} }
    }
    return evento;
  }

  function cerrarSuscriptores(runId) {
    const subs = suscriptores.get(runId);
    if (subs) {
      for (const res of subs) { try { res.write("event: fin\ndata: {}\n\n"); res.end(); } catch (_) {} }
      suscriptores.delete(runId);
    }
    const latido = latidos.get(runId);
    if (latido) { clearInterval(latido); latidos.delete(runId); }
    contadoresSeq.delete(runId);
  }

  /** Engancha una respuesta HTTP como cliente SSE de una corrida. Devuelve false si el run_id no existe. */
  function suscribir(runId, res, desde) {
    const archivo = archivoCorrida(runId);
    if (!fs.existsSync(archivo)) return false;

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write("retry: 3000\n\n");

    const desdeSeq = Number.isFinite(desde) ? desde : -1;
    for (const ev of leerJsonlLocal(archivo)) {
      if (ev.seq > desdeSeq) res.write(`event: paso\nid: ${ev.seq}\ndata: ${JSON.stringify(ev)}\n\n`);
    }

    const activa = enCurso && enCurso.run_id === runId;
    if (!activa) {
      res.write("event: fin\ndata: {}\n\n");
      res.end();
      return true;
    }

    if (!suscriptores.has(runId)) suscriptores.set(runId, new Set());
    suscriptores.get(runId).add(res);
    if (!latidos.has(runId)) {
      latidos.set(runId, setInterval(() => {
        const subs = suscriptores.get(runId);
        if (!subs) return;
        for (const r of subs) { try { r.write(": ping\n\n"); } catch (_) {} }
      }, 15000));
    }
    res.on("close", () => {
      const subs = suscriptores.get(runId);
      if (subs) { subs.delete(res); if (!subs.size) suscriptores.delete(runId); }
    });
    return true;
  }

  // ── Recorte de corridas viejas (§2.4) ───────────────────────────────────────
  function limpiarCorridasViejas() {
    const limite = Date.now() - 30 * 24 * 3600 * 1000;
    let archivos = [];
    try { archivos = fs.readdirSync(DIR_SIMULACROS); } catch (_) { return; }
    for (const f of archivos) {
      if (!f.endsWith(".jsonl")) continue;
      const ruta = path.join(DIR_SIMULACROS, f);
      try { if (fs.statSync(ruta).mtimeMs < limite) fs.unlinkSync(ruta); } catch (_) {}
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // §2.6 — Catálogo de los 6 simulacros
  // ══════════════════════════════════════════════════════════════════════════

  // ── 1. Muerte súbita del bot ─────────────────────────────────────────────
  const RE_EVENTO_DOCKER_BOT = /^(kill|die)$/;

  async function ejecutarBot(dep, ctx) {
    const inicioDano = Date.now();
    ctx.emitir("dano", "info", "Apagando el bot de golpe (docker kill zeus-bot).");
    await sh("docker kill zeus-bot", 15000);
    invalidarCache();
    ctx.emitir("dano", "info", "El bot quedó apagado. Esperando a que Centinela lo detecte.");

    const deteccion = await esperar(() => {
      const ev = leerJsonlLocal(F_AUDIT, 400).find((e) =>
        e.accion === "evento_docker" && RE_EVENTO_DOCKER_BOT.test(e.resultado) && e.detalle === "zeus-bot" &&
        new Date(e.ts).getTime() >= inicioDano - 500
      );
      return ev || null;
    }, 6000, 300, ctx);
    const msDeteccion = deteccion.logrado ? new Date(deteccion.valor.ts).getTime() - inicioDano : null;
    ctx.emitir("deteccion", deteccion.logrado && msDeteccion < 3000 ? "ok" : "warn",
      deteccion.logrado ? `Centinela registró la caída en ${msDeteccion} ms.` : "Centinela no registró la caída del bot a tiempo.");

    const incidente = await esperar(() => {
      const db = leerJsonLocal(F_INCID, { abierto: null, historial: [] });
      const h = (db.historial || [])[0];
      return (h && h.servicio === "zeus-bot" && new Date(h.inicio).getTime() >= inicioDano - 3000) ? h : null;
    }, 50000, 2000, ctx);
    ctx.emitir("deteccion", incidente.logrado ? "ok" : "warn",
      incidente.logrado ? `Centinela abrió y cerró el incidente en ${incidente.valor.duracion_s} s.` : "No se detectó la apertura y el cierre del incidente a tiempo.");

    const recuperado = await esperar(async () => {
      const cs = await dep.leerContenedores();
      const bot = cs.find((c) => c.nombre === "zeus-bot");
      return (bot && bot.estado === "running" && bot.salud !== "unhealthy") ? bot : null;
    }, 45000, 3000, ctx);
    ctx.emitir("reversion", recuperado.logrado ? "ok" : "crit",
      recuperado.logrado ? `El bot volvió a estar sano en ${Math.round(recuperado.ms / 1000)} s.` : "El bot no volvió a estar sano dentro de 45 s. Revísalo a mano.");

    return [
      { texto: "Centinela detectó la caída en menos de 3 s", ok: !!(deteccion.logrado && msDeteccion < 3000), detalle: deteccion.logrado ? `${msDeteccion} ms` : "sin evento registrado" },
      { texto: "Centinela abrió y cerró el incidente", ok: incidente.logrado, detalle: incidente.logrado ? `${incidente.valor.duracion_s} s` : "no se detectó" },
      { texto: "El bot volvió a estar sano en menos de 45 s", ok: recuperado.logrado, detalle: recuperado.logrado ? `${Math.round(recuperado.ms / 1000)} s` : "no se recuperó a tiempo (Docker debería haberlo reiniciado solo; revisar)" },
      { texto: "Hubo intento de aviso por WhatsApp", ok: incidente.logrado, detalle: incidente.logrado ? "línea incidente_cerrado en la auditoría" : "no se registró" },
    ];
  }

  // ── 2. CPU al 100% (versión acotada, sin tocar el bot ni Traefik) ────────
  async function ejecutarCpu(dep, ctx) {
    ctx.emitir("dano", "info", "Generando carga de CPU acotada en el host (90% de cuota, 100 s). Deja más de 1 vCPU libre para MariaDB y el bot.");
    const cmd = `systemd-run --unit=zeus-sim-cpu-${ctx.runId} -p CPUQuota=90% /bin/bash -lc 'timeout 100 bash -c "while :; do :; done"'`;
    const r = await sh(cmd, 10000);
    if (!r.ok) {
      ctx.emitir("dano", "crit", "No se pudo iniciar la carga de CPU.");
      return [{ texto: "Se generó la carga de CPU acotada", ok: false, detalle: r.error || r.salida || "systemd-run falló" }];
    }

    let pico = 0;
    const finVentana = Date.now() + ctx.def.duracion_s * 1000;
    while (Date.now() < finVentana && !ctx.abortado) {
      const c = dep.leerCpu();
      pico = Math.max(pico, c.pct);
      ctx.emitir("dano", "info", `CPU al ${c.pct}% · carga ${c.carga}`, { pct: c.pct, carga: c.carga });
      await dormir(10000);
    }
    // El generador de carga es un solo proceso con CPUQuota=90%, o sea 0.9 de
    // un núcleo. En una máquina de 2 vCPU eso son ~45% del total, nunca 70%:
    // pedir 70% era un criterio imposible de cumplir sin dejar al servidor sin
    // CPU libre. Lo que importa es que el pico se distinga con claridad del
    // reposo (que ronda el 7%), no saturar la máquina.
    return [{ texto: "El uso de CPU subió claramente por encima de lo normal (más del 35%)", ok: pico >= 35, detalle: `pico observado: ${pico}%` }];
  }

  function comandoReversionCpu(runId) {
    return `systemctl stop zeus-sim-cpu-${runId}.service 2>/dev/null; systemctl reset-failed 'zeus-sim-cpu-${runId}*' 2>/dev/null`;
  }

  async function verificarDespuesCpu(dep, ctx) {
    await dormir(5000);
    const c = dep.leerCpu();
    return [{ texto: "El uso de CPU volvió a lo normal tras la reversión", ok: c.pct < 50, detalle: `${c.pct}% tras revertir` }];
  }

  // ── 3. Agotamiento de RAM / OOM (dentro de un contenedor desechable) ─────
  const NOMBRE_CONTENEDOR_OOM = "zeus-simulacro-oom";

  function explicarFallbackOom(motivo, ram) {
    // Reproduce solo la rama de explicar(...) de ops-server.js que aplica aquí
    // (OOMKilled). Se documenta en INTEGRACION-SIMULACROS.md que lo ideal es
    // recibir la función real `explicar` como dependencia opcional.
    if (motivo === "OOMKilled" || ram >= 92) {
      return { causa: "Se quedó sin memoria y el sistema lo cortó.", recomienda: "Subir el límite de memoria del servicio o corregir la fuga que la consume." };
    }
    return { causa: "El servicio se detuvo de forma inesperada.", recomienda: "Revisar los registros del servicio para ver el error exacto." };
  }

  async function ejecutarOom(dep, ctx) {
    ctx.emitir("dano", "info", "Levantando un contenedor desechable con tope de 256 MB para forzar un OOM controlado. El host nunca corre riesgo: el límite es del cgroup de ese contenedor, no del sistema.");
    const img = await sh("docker inspect -f '{{.Config.Image}}' zeus-bot", 10000);
    if (!img.ok || !img.salida.trim()) {
      return [{ texto: "Se creó el contenedor de prueba", ok: false, detalle: "no se pudo leer la imagen de zeus-bot para reutilizarla" }];
    }
    const imagen = img.salida.trim();
    // El segundo argumento de Buffer.alloc (el relleno) NO es decorativo: sin
    // él, las páginas quedan sin escribir y el núcleo nunca entrega memoria
    // física de verdad, así que el tope del contenedor jamás se alcanza y el
    // simulacro esperaba para siempre un corte que no iba a llegar.
    const cmd = `docker rm -f ${NOMBRE_CONTENEDOR_OOM} 2>/dev/null; docker run -d --name ${NOMBRE_CONTENEDOR_OOM} --network none --memory=256m --memory-swap=256m --restart=no ${imagen} node -e 'const a=[];setInterval(()=>a.push(Buffer.alloc(10*1024*1024,1)),20)'`;
    const r = await sh(cmd, 20000);
    if (!r.ok) {
      return [{ texto: "Se creó el contenedor de prueba", ok: false, detalle: r.error || r.salida || "docker run falló" }];
    }

    const muerto = await esperar(async () => {
      const insp = await sh(`docker inspect -f '{{.State.OOMKilled}} {{.State.ExitCode}}' ${NOMBRE_CONTENEDOR_OOM}`, 8000);
      const partes = (insp.salida || "").trim().split(/\s+/);
      return (partes[0] === "true" && partes[1] === "137") ? { oom: true, codigo: partes[1] } : null;
    }, 40000, 2000, ctx);
    ctx.emitir("deteccion", muerto.logrado ? "ok" : "warn",
      muerto.logrado ? "El sistema cortó el proceso al quedarse sin memoria (OOMKilled)." : "El contenedor de prueba no fue cortado por el sistema a tiempo.");

    const eventoDocker = await esperar(() => {
      const ev = leerJsonlLocal(F_AUDIT, 400).find((e) => e.accion === "evento_docker" && /^(oom|die)$/.test(e.resultado) && e.detalle === NOMBRE_CONTENEDOR_OOM);
      return ev || null;
    }, 15000, 1000, ctx);

    const ram = dep.leerMemoria().pct;
    const explicarFn = typeof dep.explicar === "function" ? dep.explicar : (nombre, motivo, ramPct) => explicarFallbackOom(motivo, ramPct);
    const explicacion = muerto.logrado ? explicarFn(NOMBRE_CONTENEDOR_OOM, "OOMKilled", ram, null) : null;
    ctx.emitir("deteccion", explicacion ? "ok" : "info", explicacion ? `Diagnóstico: ${explicacion.causa}` : "Sin diagnóstico automático disponible.");

    return [
      { texto: "El sistema cortó el proceso al llegar a 256 MB (OOMKilled)", ok: muerto.logrado, detalle: muerto.logrado ? "OOMKilled=true, ExitCode=137" : "no se detectó" },
      { texto: "Quedó registrado el evento en la auditoría del servidor", ok: eventoDocker.logrado, detalle: eventoDocker.logrado ? `evento_docker: ${eventoDocker.valor.resultado}` : "no se registró" },
      { texto: "El diagnóstico automático identifica la falta de memoria como causa", ok: !!(explicacion && /sin memoria/i.test(explicacion.causa)), detalle: explicacion ? explicacion.causa : "sin diagnóstico" },
    ];
  }

  function comandoReversionOom() {
    return `docker rm -f ${NOMBRE_CONTENEDOR_OOM} 2>/dev/null`;
  }

  // ── 4. Disco lleno ────────────────────────────────────────────────────────
  const RUTA_RELLENO = path.join(deps.DIR_DATOS, "simulacro-relleno.img");

  async function validarSalvaguardasDisco() {
    const motivoVentana = dentroDeVentanaSensible();
    if (motivoVentana) return { ok: false, mensaje: motivoVentana };

    const tipo = await sh(`df -T ${deps.DIR_DATOS} 2>/dev/null | tail -1 | awk '{print $2}'`, 10000);
    if ((tipo.salida || "").trim().toLowerCase() === "tmpfs") {
      return { ok: false, mensaje: "El almacenamiento donde vive Centinela es temporal (tmpfs); este simulacro no puede correr aquí." };
    }

    const disco = await deps.leerDisco();
    const objetivoBytes = Math.round(disco.total * 0.91) - disco.usado;
    if (objetivoBytes <= 0) return { ok: false, mensaje: "El disco ya está por encima del 91%; no se puede ni hace falta llenarlo más para la prueba." };
    // Piso de seguridad: 3 GB libres de verdad.
    //
    // Por qué 3 y no 5: el aviso crítico de Centinela salta al 90% del tamaño
    // de la partición, pero ~4 GB de esa partición están reservados para root
    // y no aparecen como espacio disponible. La cuenta no cierra: llegar al
    // 90% deja por fuerza unos 3.9 GB disponibles. Con un piso de 5 GB el
    // simulacro nunca podría alcanzar el umbral que existe para comprobar, y
    // quedaría siendo una prueba que no prueba nada.
    //
    // El riesgo real de esos 3.9 GB es bajo y acotado: el espacio se reserva
    // con fallocate (instantáneo, no escribe datos), se libera borrando un
    // archivo (instantáneo), la ventana es de un par de minutos, y en ese rato
    // el único que escribe de verdad es MariaDB, con unos pocos MB. Además el
    // simulacro se niega a correr dentro de las ventanas de respaldo y reinicio.
    const libreTrasReserva = disco.libre - objetivoBytes;
    if (libreTrasReserva < 3 * 1024 * 1024 * 1024) {
      return { ok: false, mensaje: "La prueba dejaría menos de 3 GB libres reales en el disco; se cancela por seguridad." };
    }
    return { ok: true };
  }

  async function ejecutarDisco(dep, ctx) {
    const baseline = await dep.leerDisco();
    ctx.baselineDiscoPct = baseline.pct;
    const objetivoBytes = Math.round(baseline.total * 0.91) - baseline.usado;
    ctx.emitir("dano", "info", `Reservando espacio en la misma partición de / (no en /tmp) hasta llevar el disco a ~91% (hoy ${baseline.pct}%).`);
    const r = await sh(`fallocate -l ${objetivoBytes} ${RUTA_RELLENO}`, 30000);
    if (!r.ok) {
      return [{ texto: "Se reservó el espacio de la prueba", ok: false, detalle: r.error || r.salida || "fallocate falló" }];
    }

    const lleno = await esperar(async () => {
      const [d, e] = await Promise.all([dep.leerDisco(), dep.estadoGeneral()]);
      const avisoCrit = (e.avisos || []).some((a) => a.nivel === "crit" && /disco/i.test(a.texto));
      return (d.pct >= 90 && avisoCrit) ? { pct: d.pct } : null;
    }, 20000, 2000, ctx);
    ctx.emitir("deteccion", lleno.logrado ? "ok" : "warn",
      lleno.logrado ? `El disco llegó al ${lleno.valor.pct}% y Centinela mostró el aviso de disco casi lleno.` : "El disco no llegó al umbral esperado o Centinela no mostró el aviso.");

    return [{ texto: "El disco superó el 90% y apareció el aviso de Centinela", ok: lleno.logrado, detalle: lleno.logrado ? `${lleno.valor.pct}%` : "no se cumplió" }];
  }

  function comandoReversionDisco() {
    return `rm -f ${RUTA_RELLENO}`;
  }

  async function verificarDespuesDisco(dep, ctx) {
    await dormir(3000);
    const d = await dep.leerDisco();
    const base = typeof ctx.baselineDiscoPct === "number" ? ctx.baselineDiscoPct : null;
    const vuelveANormal = base === null ? d.pct < 90 : d.pct <= base + 3;
    return [{ texto: "El disco volvió a su nivel de antes tras la reversión", ok: vuelveANormal, detalle: `${d.pct}%` + (base !== null ? ` (antes ${base}%)` : "") }];
  }

  // ── 5. Caída general / aislamiento de red (503 dirigido en Traefik) ─────
  const DIR_TRAEFIK_DYNAMIC = "/opt/zeus-proxy/dynamic";
  const RUTA_TRAEFIK_503 = path.join(DIR_TRAEFIK_DYNAMIC, "zzz-simulacro-503.yml");

  function contenidoYamlRed() {
    // CORREGIDO respecto al diseño original: el entryPoint TLS real de este
    // servidor es "https" (verificado con `docker inspect zeus-proxy`), no
    // "websecure" como suponía el borrador de diseño.
    return [
      "http:",
      "  routers:",
      "    zeus-simulacro-503:",
      '      rule: "Host(`panel.ejemplo.com`) || Host(`bot.ejemplo.com`)"',
      "      priority: 100000",
      '      entryPoints: ["https"]',
      "      service: zeus-simulacro-vacio",
      "      tls: {}",
      "  services:",
      "    zeus-simulacro-vacio:",
      "      loadBalancer:",
      "        servers:",
      '          - url: "http://127.0.0.1:1"',
      "",
    ].join("\n");
  }

  async function validarSalvaguardasRed() {
    if (!fs.existsSync(DIR_TRAEFIK_DYNAMIC)) {
      return { ok: false, mensaje: "No se encontró la carpeta de configuración de Traefik; no se puede continuar con este simulacro." };
    }
    return { ok: true };
  }

  function consultarVigilante() {
    const token = env.TOKEN_PRUEBA_VIGILANTE;
    if (!token) return Promise.resolve(null);
    const url = `${env.VIGILANTE_URL || "https://vigilante-zeus.TU-CUENTA.workers.dev"}/estado?token=${encodeURIComponent(token)}`;
    return pedirJsonHttps(url, 8000).then((d) => (d && d.servidor) ? d.servidor : null);
  }

  async function ejecutarRed(dep, ctx) {
    ctx.emitir("dano", "info", "Escribiendo una ruta de prioridad máxima en Traefik para forzar un error 5xx solo en panel.ejemplo.com y bot.ejemplo.com. El resto del tráfico sigue igual.");
    escribirAtomico(RUTA_TRAEFIK_503, contenidoYamlRed());
    await dormir(3000); // Traefik relee el directorio dinámico solo

    const local = await esperar(async () => {
      const r = await sh("curl -sk -o /dev/null -m 6 -w '%{http_code}' -H 'Host: panel.ejemplo.com' https://127.0.0.1/health", 10000);
      const codigo = parseInt((r.salida || "").trim(), 10);
      return codigo >= 500 ? codigo : null;
    }, 20000, 2000, ctx);
    ctx.emitir("deteccion", local.logrado ? "ok" : "warn",
      local.logrado ? `El panel respondió con un error ${local.valor}, como se esperaba.` : "No se confirmó un error 5xx local dentro de 20 s.");

    if (!env.TOKEN_PRUEBA_VIGILANTE) {
      ctx.emitir("deteccion", "info", "TOKEN_PRUEBA_VIGILANTE no está configurado: no se puede consultar al vigilante externo para confirmar el aviso.");
      return [
        { texto: "Una petición local devolvió un error 5xx", ok: local.logrado, detalle: local.logrado ? `HTTP ${local.valor}` : "sin 5xx confirmado" },
        { texto: "El vigilante externo confirmó el aviso", ok: false, detalle: "TOKEN_PRUEBA_VIGILANTE no configurado en /opt/zeus-ops/.env" },
      ];
    }

    const finVentana = Date.now() + ctx.def.duracion_s * 1000;
    let vigilanteOk = false, ultimaLectura = null;
    while (Date.now() < finVentana && !ctx.abortado) {
      ultimaLectura = await consultarVigilante();
      if (ultimaLectura && ultimaLectura.avisoEnviado) { vigilanteOk = true; break; }
      ctx.emitir("deteccion", "info", ultimaLectura
        ? `Vigilante externo: ${ultimaLectura.fallosSeguidos || 0} fallo(s) seguido(s) hasta ahora.`
        : "No se pudo consultar al vigilante externo todavía.");
      await dormir(20000);
    }
    ctx.emitir("deteccion", vigilanteOk ? "ok" : "warn",
      vigilanteOk ? "El vigilante externo detectó la caída y ya envió el aviso." : "El vigilante externo no confirmó el aviso dentro de la ventana.");

    return [
      { texto: "Una petición local devolvió un error 5xx", ok: local.logrado, detalle: local.logrado ? `HTTP ${local.valor}` : "sin 5xx confirmado" },
      { texto: "El vigilante externo detectó la caída y avisó", ok: vigilanteOk, detalle: ultimaLectura ? `fallosSeguidos=${ultimaLectura.fallosSeguidos}, avisoEnviado=${!!ultimaLectura.avisoEnviado}` : "sin datos del vigilante" },
    ];
  }

  function comandoReversionRed() {
    return `rm -f ${RUTA_TRAEFIK_503}`;
  }

  // ── 6. Fallo de base de datos ─────────────────────────────────────────────
  async function validarSalvaguardasBd() {
    const motivoVentana = dentroDeVentanaSensible();
    if (motivoVentana) return { ok: false, mensaje: motivoVentana };
    return { ok: true };
  }

  async function ejecutarBd(dep, ctx) {
    const inicioPausa = Date.now();
    ctx.emitir("dano", "info", "Congelando MariaDB 45 s (docker pause zeus-mariadb). El bot y la tienda seguirán intentando conectarse, pero se recuperan solos.");
    await sh("docker pause zeus-mariadb", 15000);
    invalidarCache();

    await dormir(3000);
    const datos = await dep.estadoDatos();
    const congelada = datos.base_viva === false;
    ctx.emitir("deteccion", congelada ? "ok" : "warn",
      congelada ? "La base de datos no responde mientras está pausada, como se esperaba." : "La base de datos siguió respondiendo; puede que la pausa no haya surtido efecto.");

    const restante = 45000 - (Date.now() - inicioPausa);
    if (restante > 0 && !ctx.abortado) await dormir(restante);

    ctx.ventanaBdInicio = inicioPausa;
    return [{ texto: "La base de datos dejó de responder durante la pausa", ok: congelada, detalle: congelada ? "base_viva=false" : "base_viva=true (no se detectó la caída)" }];
  }

  function comandoReversionBd() {
    return "docker unpause zeus-mariadb 2>/dev/null";
  }

  async function verificarDespuesBd(dep, ctx) {
    const sana = await esperar(async () => {
      const cs = await dep.leerContenedores();
      const db = cs.find((c) => c.nombre === "zeus-mariadb");
      return (db && db.estado === "running" && db.salud !== "unhealthy") ? db : null;
    // MariaDB revisa su propia salud cada 30 s. Tras descongelarla, el estado
    // sigue marcado "unhealthy" hasta el siguiente chequeo, así que esperar
    // solo 30 s medía más rápido de lo que el contenedor puede responder y
    // reprobaba siempre. Con 150 s caben varios ciclos de chequeo.
    }, 150000, 5000, ctx);

    let incidentesEnVentana = 0;
    if (ctx.ventanaBdInicio) {
      const db = leerJsonLocal(F_INCID, { abierto: null, historial: [] });
      const desde = ctx.ventanaBdInicio - 2000;
      incidentesEnVentana = (db.historial || []).filter((h) => new Date(h.inicio).getTime() >= desde).length;
      if (db.abierto && new Date(db.abierto.inicio).getTime() >= desde) incidentesEnVentana += 1;
    }

    return [
      { texto: "MariaDB volvió a estar sana tras descongelarla", ok: sana.logrado, detalle: sana.logrado ? `${Math.round(sana.ms / 1000)} s` : "no se recuperó a tiempo" },
      { texto: "No hubo tormenta de notificaciones (a lo sumo un incidente)", ok: incidentesEnVentana <= 1, detalle: `${incidentesEnVentana} incidente(s) durante la ventana` },
    ];
  }

  // ── Catálogo completo ────────────────────────────────────────────────────
  const CATALOGO_INTERNO = {
    bot: {
      id: "bot", titulo: "Muerte súbita del bot", impacto: "medio", palabra: "SIMULACRO-BOT",
      duracion_s: 60, timerSegundos: 150,
      descripcion: "Apaga el bot de golpe para comprobar que Centinela lo detecta y lo revive.",
      aprobado_si: "Centinela abre y cierra el incidente y el bot vuelve solo.",
      ejecutar: ejecutarBot,
      comandoReversion: () => "docker start zeus-bot",
    },
    cpu: {
      id: "cpu", titulo: "Pico de uso del procesador", impacto: "medio", palabra: "SIMULACRO-CPU",
      duracion_s: 100, timerSegundos: 140,
      descripcion: "Pone a trabajar el procesador a propósito, sin tocar el bot ni la tienda, para comprobar que Centinela lo registra. Deja más de un núcleo libre.",
      aprobado_si: "El uso del procesador sube muy por encima de lo normal durante la prueba y vuelve a bajar después.",
      ejecutar: ejecutarCpu,
      comandoReversion: comandoReversionCpu,
      verificarDespues: verificarDespuesCpu,
    },
    oom: {
      id: "oom", titulo: "Agotamiento de memoria (OOM controlado)", impacto: "alto", palabra: "SIMULACRO-OOM",
      duracion_s: 60, timerSegundos: 120,
      descripcion: "Levanta un contenedor de prueba, desechable, con un límite de memoria de 256 MB, hasta que el sistema lo corta. El servidor nunca se acerca a quedarse sin memoria.",
      aprobado_si: "El sistema corta el contenedor de prueba por falta de memoria (OOMKilled) y queda registrado.",
      ejecutar: ejecutarOom,
      comandoReversion: comandoReversionOom,
    },
    disco: {
      id: "disco", titulo: "Disco lleno", impacto: "alto", palabra: "SIMULACRO-DISCO",
      duracion_s: 120, timerSegundos: 120,
      descripcion: "Reserva espacio en el disco hasta llevarlo a ~91% de uso, para comprobar que Centinela avisa a tiempo.",
      aprobado_si: "Aparece el aviso de 'disco casi lleno' y, al terminar, el disco vuelve a su nivel de antes.",
      ejecutar: ejecutarDisco,
      comandoReversion: comandoReversionDisco,
      verificarDespues: verificarDespuesDisco,
      validarSalvaguardas: validarSalvaguardasDisco,
    },
    red: {
      id: "red", titulo: "Caída general (aislamiento de red)", impacto: "critico", palabra: "SIMULACRO-RED",
      duracion_s: 240, timerSegundos: 280,
      descripcion: "Fuerza un error de conexión (5xx) solo en panel.ejemplo.com y bot.ejemplo.com, sin apagar nada, para comprobar que el vigilante externo lo detecta y avisa.",
      aprobado_si: "Una petición local devuelve un error 5xx y el vigilante externo confirma que mandó el aviso.",
      ejecutar: ejecutarRed,
      comandoReversion: comandoReversionRed,
      validarSalvaguardas: validarSalvaguardasRed,
    },
    bd: {
      id: "bd", titulo: "Fallo de base de datos", impacto: "alto", palabra: "SIMULACRO-BD",
      duracion_s: 45, timerSegundos: 90,
      descripcion: "Congela la base de datos 45 segundos para comprobar que el bot y la tienda lo resisten sin generar una tormenta de avisos.",
      aprobado_si: "La base de datos deja de responder durante la pausa, vuelve a estar sana después, y no hubo más de un incidente por la cascada de fallos.",
      ejecutar: ejecutarBd,
      comandoReversion: comandoReversionBd,
      verificarDespues: verificarDespuesBd,
      validarSalvaguardas: validarSalvaguardasBd,
    },
  };
  const ORDEN_CATALOGO = ["bot", "cpu", "oom", "disco", "red", "bd"];

  function catalogo() {
    return ORDEN_CATALOGO.map((id) => {
      const d = CATALOGO_INTERNO[id];
      return {
        id: d.id, titulo: d.titulo, impacto: d.impacto, palabra: d.palabra,
        duracion_s: d.duracion_s, descripcion: d.descripcion, aprobado_si: d.aprobado_si,
      };
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Ejecutor con hombre muerto (§2.5) y bloqueo (§2.3)
  // ══════════════════════════════════════════════════════════════════════════

  let enCurso = null; // { run_id, simulacro, inicio, pid, ctx }

  function bloqueado() {
    return !!enCurso || fs.existsSync(F_LOCK);
  }

  async function lanzar(id, pin, confirmacion, quien) {
    quien = quien || "panel";

    const def = CATALOGO_INTERNO[id];
    if (!def) return { ok: false, code: 400, mensaje: "El contenido enviado no es válido" };

    if (bloqueado()) return { ok: false, code: 409, mensaje: "Ya hay un simulacro en curso" };

    // Antes pedía PIN además de la palabra de confirmación; se quitó el PIN
    // a petición del dueño (12 sept. 2026) — con escribir el nombre del
    // simulacro en mayúsculas basta, es un panel de un solo operador.
    if (String(confirmacion || "") !== def.palabra) {
      auditar("simulacro_rechazado", quien, "confirmacion_incorrecta", id);
      return { ok: false, code: 422, mensaje: "Escribe la palabra de confirmación exacta" };
    }

    if (def.validarSalvaguardas) {
      let chequeo;
      try { chequeo = await def.validarSalvaguardas(); }
      catch (e) { chequeo = { ok: false, mensaje: "No se pudo comprobar si es seguro lanzar este simulacro: " + e.message }; }
      if (!chequeo.ok) {
        auditar("simulacro_rechazado", quien, "salvaguarda", `${id}: ${chequeo.mensaje}`);
        return { ok: false, code: 412, mensaje: chequeo.mensaje };
      }
    }

    const runId = `sim-${Math.floor(Date.now() / 1000)}-${crypto.randomBytes(2).toString("hex")}`;
    const inicioIso = new Date().toISOString();
    enCurso = { run_id: runId, simulacro: id, inicio: inicioIso, pid: process.pid, ctx: null };
    guardarJsonLocal(F_LOCK, { run_id: runId, simulacro: id, pid: process.pid, inicio: inicioIso });

    const persist = estadoPersistido();
    persist.en_curso = { run_id: runId, simulacro: id, inicio: inicioIso };
    guardarEstadoPersistido(persist);
    contadoresSeq.set(runId, 0);

    auditar("simulacro_iniciado", quien, "ok", id);

    // Se ejecuta en segundo plano: la llamada HTTP que lanza esto no debe
    // quedar colgada minutos. El panel abre el SSE (/api/simulacros/vivo)
    // justo después con el run_id devuelto aquí.
    ejecutarCorrida(def, runId, quien).catch((e) => {
      auditar("simulacro_excepcion", quien, "error", `${id}: ${e.message}`);
    });

    return { ok: true, run_id: runId };
  }

  async function ejecutarCorrida(def, runId, quien) {
    const ctx = {
      runId, def, abortado: false,
      emitir: (fase, nivel, texto, dato) => emitirEvento(runId, def.id, fase, nivel, texto, dato),
    };
    if (enCurso && enCurso.run_id === runId) enCurso.ctx = ctx;

    const inicioMs = Date.now();
    const timerUnidad = `zeus-sim-${runId}`;
    const cmdRevierte = def.comandoReversion(runId);

    ctx.emitir("preparacion", "info", `Programando la reversión automática de seguridad (a los ${def.timerSegundos} s) antes de causar el daño. Si este proceso muere, la reversión ocurre igual.`);
    const cmdEscapado = cmdRevierte.replace(/'/g, "'\\''");
    await sh(`systemd-run --on-active=${def.timerSegundos}s --unit=${timerUnidad} /bin/bash -lc '${cmdEscapado}'`, 15000);

    let criteriosDurante = [];
    let errorTexto = null;
    try {
      criteriosDurante = (await def.ejecutar(deps, ctx)) || [];
    } catch (e) {
      errorTexto = e.message;
      ctx.emitir("dano", "crit", `Ocurrió un error durante el simulacro: ${e.message}`);
    }

    if (ctx.abortado) {
      // abortar() ya se encargó de revertir, auditar, persistir y cerrar el
      // SSE. Esta promesa solo debe terminar en silencio, sin pisar ese estado.
      return;
    }

    ctx.emitir("reversion", "info", "Revirtiendo el daño ahora mismo (sin esperar a la reversión automática).");
    await sh(cmdRevierte, 30000);
    await sh(`systemctl stop ${timerUnidad}.timer 2>/dev/null; systemctl reset-failed '${timerUnidad}*' 2>/dev/null`, 15000);
    invalidarCache();

    let criteriosDespues = [];
    if (!errorTexto && def.verificarDespues) {
      try { criteriosDespues = (await def.verificarDespues(deps, ctx)) || []; }
      catch (e) { criteriosDespues = [{ texto: "Verificación posterior a la reversión", ok: false, detalle: e.message }]; }
    }

    const criterios = criteriosDurante.concat(criteriosDespues);
    const aprobado = !errorTexto && criterios.length > 0 && criterios.every((c) => c.ok);
    const duracionS = Math.round((Date.now() - inicioMs) / 1000);
    const resultado = errorTexto ? "error" : (aprobado ? "aprobado" : "reprobado");

    ctx.emitir("veredicto", aprobado ? "ok" : (errorTexto ? "crit" : "warn"),
      errorTexto
        ? `El simulacro no pudo completarse: ${errorTexto}. El daño ya fue revertido.`
        : (aprobado ? "APROBADO: Centinela se comportó como se esperaba." : "REPROBADO: revisa los criterios que no se cumplieron."),
      { aprobado, criterios, error: errorTexto });

    auditar(aprobado ? "simulacro_aprobado" : "simulacro_reprobado", quien, resultado,
      `${def.id}: ${criterios.map((c) => `${c.ok ? "OK" : "FALLO"} ${c.texto}`).join(" | ")}`);
    auditar("simulacro_revertido", quien, "ok", def.id);

    const persist = estadoPersistido();
    persist.en_curso = null;
    persist.ultimos = persist.ultimos || {};
    persist.ultimos[def.id] = { run_id: runId, ts: new Date().toISOString(), resultado, aprobado, duracion_s: duracionS };
    guardarEstadoPersistido(persist);

    enCurso = null;
    try { fs.unlinkSync(F_LOCK); } catch (_) {}

    cerrarSuscriptores(runId);
    limpiarCorridasViejas();
  }

  async function abortar(runId, quien) {
    quien = quien || "panel";
    if (!enCurso || enCurso.run_id !== runId) {
      return { ok: false, code: 404, mensaje: "No hay ningún simulacro con ese identificador en curso" };
    }

    const simulacroId = enCurso.simulacro;
    const def = CATALOGO_INTERNO[simulacroId];
    const timerUnidad = `zeus-sim-${runId}`;
    if (enCurso.ctx) enCurso.ctx.abortado = true;

    emitirEvento(runId, simulacroId, "reversion", "warn", "Se pidió abortar el simulacro desde el panel. Revirtiendo de inmediato.");
    if (def) await sh(def.comandoReversion(runId), 30000);
    await sh(`systemctl stop ${timerUnidad}.timer 2>/dev/null; systemctl reset-failed '${timerUnidad}*' 2>/dev/null`, 15000);
    invalidarCache();

    const inicioMs = new Date(enCurso.inicio).getTime();
    const persist = estadoPersistido();
    persist.en_curso = null;
    persist.ultimos = persist.ultimos || {};
    persist.ultimos[simulacroId] = {
      run_id: runId, ts: new Date().toISOString(), resultado: "abortado", aprobado: false,
      duracion_s: Math.round((Date.now() - inicioMs) / 1000),
    };
    guardarEstadoPersistido(persist);

    auditar("simulacro_abortado", quien, "ok", simulacroId);
    emitirEvento(runId, simulacroId, "veredicto", "warn", "Simulacro abortado por el dueño. El daño ya fue revertido.", { aprobado: false, abortado: true });

    enCurso = null;
    try { fs.unlinkSync(F_LOCK); } catch (_) {}
    cerrarSuscriptores(runId);

    return { ok: true, mensaje: "Simulacro revertido" };
  }

  function estado() {
    const persist = estadoPersistido();
    return {
      en_curso: enCurso ? { run_id: enCurso.run_id, simulacro: enCurso.simulacro, inicio: enCurso.inicio } : null,
      catalogo: catalogo(),
      ultimos: persist.ultimos || {},
    };
  }

  function historial(id) {
    let archivos = [];
    try { archivos = fs.readdirSync(DIR_SIMULACROS).filter((f) => f.endsWith(".jsonl")); } catch (_) {}

    const corridas = [];
    for (const f of archivos) {
      const eventos = leerJsonlLocal(path.join(DIR_SIMULACROS, f));
      if (!eventos.length || eventos[0].simulacro !== id) continue;
      const veredicto = eventos.slice().reverse().find((e) => e.fase === "veredicto");
      const runId = eventos[0].run_id;
      const inicioTs = eventos[0].ts;
      let resultado = "en_curso", aprobado = null, duracionS = null;
      if (veredicto) {
        aprobado = !!(veredicto.dato && veredicto.dato.aprobado);
        resultado = (veredicto.dato && veredicto.dato.abortado) ? "abortado" : (aprobado ? "aprobado" : "reprobado");
        duracionS = Math.round((new Date(veredicto.ts).getTime() - new Date(inicioTs).getTime()) / 1000);
      }
      corridas.push({ run_id: runId, ts: inicioTs, resultado, aprobado, duracion_s: duracionS });
    }
    corridas.sort((a, b) => (a.ts < b.ts ? 1 : -1));
    return { id, corridas: corridas.slice(0, 20) };
  }

  /**
   * Se llama una vez, en `servidor.listen(...)`, junto a `verificarArranque()`.
   * Si `zeus-ops` se reinició a mitad de un simulacro, el lock en disco sigue
   * ahí: la corrida quedó huérfana. Se marca como revertida por el hombre
   * muerto, se ejecuta la reversión otra vez (idempotente, por si el timer de
   * systemd todavía no disparó) y se borra el lock.
   */
  async function reconciliarAlArrancar() {
    let lock;
    try { lock = JSON.parse(fs.readFileSync(F_LOCK, "utf8")); } catch (_) { return; }
    if (!lock || !lock.run_id || !lock.simulacro) { try { fs.unlinkSync(F_LOCK); } catch (_) {} return; }

    const def = CATALOGO_INTERNO[lock.simulacro];
    auditar("simulacro_hombre_muerto", "agente", "detectado", `${lock.simulacro} (${lock.run_id}) — corrida huérfana al arrancar`);

    if (def) {
      try { await sh(def.comandoReversion(lock.run_id), 30000); } catch (_) {}
    }
    try {
      await sh(`systemctl stop zeus-sim-${lock.run_id}.timer 2>/dev/null; systemctl reset-failed 'zeus-sim-${lock.run_id}*' 2>/dev/null`, 15000);
      if (lock.simulacro === "cpu") await sh(`systemctl stop zeus-sim-cpu-${lock.run_id}.service 2>/dev/null; systemctl reset-failed 'zeus-sim-cpu-${lock.run_id}*' 2>/dev/null`, 15000);
    } catch (_) {}
    invalidarCache();

    try {
      emitirEvento(lock.run_id, lock.simulacro, "veredicto", "warn",
        "El servicio se reinició durante este simulacro. La reversión automática (hombre muerto) se aplicó igual.",
        { aprobado: false, resultado: "revertido_por_hombre_muerto" });
    } catch (_) {}

    const persist = estadoPersistido();
    persist.en_curso = null;
    persist.ultimos = persist.ultimos || {};
    persist.ultimos[lock.simulacro] = {
      run_id: lock.run_id, ts: new Date().toISOString(), resultado: "revertido_por_hombre_muerto", aprobado: false,
      duracion_s: Math.round((Date.now() - new Date(lock.inicio).getTime()) / 1000),
    };
    guardarEstadoPersistido(persist);

    enCurso = null;
    try { fs.unlinkSync(F_LOCK); } catch (_) {}
    auditar("simulacro_hombre_muerto", "agente", "revertido", `${lock.simulacro} (${lock.run_id})`);
  }

  return {
    catalogo,
    estado,
    lanzar,
    suscribir,
    abortar,
    historial,
    reconciliarAlArrancar,
  };
}

module.exports = { crearSimulacros };
