"use strict";
/**
 * modulos/escalamiento.js
 *
 * Centinela Zeus — escalada de avisos críticos con acuse (2 niveles, idea de
 * PagerDuty/Opsgenie: recomendación #4 de la auditoría). Hoy todos los
 * avisos van siempre al mismo número (el dueño); si duerme o viaja, nadie se
 * entera de una caída que el SOS no pudo resolver. Este módulo exige acuse
 * SOLO para avisos críticos y, si no llega en 15 minutos, reenvía al
 * "número del técnico" (configurable; si no hay, reintenta al dueño) cada
 * 30 minutos, máximo 3 veces. Cualquier interacción del dueño con el menú de
 * WhatsApp o la recuperación del incidente cierran la escalada.
 *
 * Diseño vinculante producido en Fable 5.1 (regla de AGENTS.md: "Arquitectura
 * y diseño → Fable 5.1, siempre", 12-sep-2026). Este archivo es la
 * implementación literal de ese diseño. Los contratos (nombres de función,
 * forma de los datos, rutas, constantes) no se cambian por iniciativa propia
 * — donde este archivo se aparta de una duda del diseño, queda anotado en el
 * comentario del punto exacto para que quien integre lo verifique contra
 * `ops-server.js` (ver también `modulos/INTEGRACION-ESCALAMIENTO.md` §12,
 * "Puntos de verificación consolidados").
 *
 * Cinco decisiones de arquitectura del diseño (D1-D5), imprescindibles para
 * entender el porqué de este código:
 *
 *  D1 — El bot de WhatsApp SOLO reenvía a Centinela los mensajes del dueño
 *       que empiezan por "/centinela" (o audio que empieza diciendo
 *       "centinela"). Un "ok" suelto nunca llega aquí. Por eso la coletilla
 *       de los avisos pide "/centinela ok", no "ok" a secas.
 *  D2 — El recordatorio de escalamiento (NO el aviso base, que ya lo manda
 *       `sos.js`/`ops-server.js` sin filtro para una caída sin resolver) se
 *       silencia en modo viaje llamando `debeSilenciar("warn", modo)`, sin
 *       `autoRemediable`: es un recordatorio redundante de un aviso crítico
 *       que ya salió, y por eso se trata como nivel inferior a "crit". Con
 *       modo viaje activo, el técnico tampoco recibe reenvíos (limitación
 *       documentada en el panel).
 *  D3 — El permiso `whatsapp`/`escritura` apagado tiene el mismo trato que
 *       D2: no se envía nada, pero la máquina de estados avanza igual y
 *       queda todo auditado (nunca se acumula una ráfaga al reactivar).
 *  D4 — El aviso "servidor caído" del Worker de Cloudflare queda FUERA de
 *       alcance a propósito: se dispara justo cuando el VPS (y con él este
 *       módulo y el intérprete de WhatsApp) está apagado, así que nadie ahí
 *       puede reenviar ni recibir el acuse. El dueño sigue recibiendo ese
 *       aviso directo del Worker como hoy, sin cambios.
 *  D5 — Las detecciones (SOS detenido y caída sin resolver) se leen DENTRO
 *       de este módulo desde los archivos que ya existen
 *       (`centinela-db/sos-corridas.jsonl`, `incidentes.json`), igual que ya
 *       hace `modulos/informe-semanal.js`. `ops-server.js` no resuelve nada
 *       por su cuenta: solo construye la fábrica y engancha `quizaEscalar()`
 *       a un `setInterval` de 60 s.
 *
 * Cero dependencias externas: solo `node:path` y `./sos/textos.js` (ya
 * existente) para nombres claros y la hora en español. No usa IA: todo es
 * determinista (datos y umbrales), regla 1 del SOS en CLAUDE.md.
 */

const path = require("path");
const { nombreClaro, horaColombia } = require("./sos/textos.js");

// ── Constantes del diseño (§1) ─────────────────────────────────────────────
const UMBRAL_CAIDA_MIN = 10; // presupuesto máximo de una corrida de SOS (CLAUDE.md)
const ESPERA_ACUSE_MIN = 15;
const INTERVALO_REINTENTO_MIN = 30;
const MAX_REINTENTOS = 3;
const MAX_EDAD_CORRIDA_MIN = 60; // no escalar un SOS viejo si el proceso estuvo apagado horas
const MAX_LINEAS_SOS = 200;
const MAX_HISTORIAL = 50;
const SERVICIOS_BOT = new Set(["zeus-bot", "zeus-proxy"]); // mismo criterio que informe-semanal.js
const NIVEL_MODO_VIAJE = "warn"; // D2
const COLETILLA_ACUSE = "Responde */centinela ok* para confirmar que lo viste."; // D1

const CONSTANTES = Object.freeze({
  UMBRAL_CAIDA_MIN, ESPERA_ACUSE_MIN, INTERVALO_REINTENTO_MIN, MAX_REINTENTOS,
  MAX_EDAD_CORRIDA_MIN, MAX_LINEAS_SOS, MAX_HISTORIAL,
  SERVICIOS_BOT, NIVEL_MODO_VIAJE, COLETILLA_ACUSE,
});

// ── Utilidades puras (exportadas: sin fábrica, para pruebas y para el patch
//    de centinela-comandos.js que reconoce "ok" sin gastar IA) ─────────────

/**
 * Valida el número del técnico. `null`/`undefined`/vacío -> válido, borra el
 * técnico (vuelve a reintentar siempre al dueño). Cualquier otra cosa debe
 * ser solo dígitos, 10 a 15, código de país incluido y sin "+": no se limpia
 * ni se adivina el formato, se rechaza y el dueño lo corrige (más seguro).
 */
function validarNumero(valor) {
  if (valor === null || valor === undefined) return { ok: true, numero: null };
  const s = String(valor).trim();
  if (s === "") return { ok: true, numero: null };
  if (!/^\d{10,15}$/.test(s)) {
    return {
      ok: false,
      mensaje: "El número del técnico debe tener solo dígitos, entre 10 y 15, con el código del país y sin el signo +. Ejemplo: 573001234567",
    };
  }
  return { ok: true, numero: s };
}

/** "••• 8901" a partir de cualquier número; nunca se guarda uno completo en escalamiento.json. */
function enmascararNumero(numero) {
  if (numero === null || numero === undefined) return null;
  const digitos = String(numero).replace(/\D/g, "");
  if (digitos.length >= 4) return `••• ${digitos.slice(-4)}`;
  return "•••";
}

// "ok"/variantes cortas del dueño: cierran la escalada sin gastar una
// consulta de IA (ver el patch a centinela-comandos.js en
// INTEGRACION-ESCALAMIENTO.md). "ok 1" o "ok, ¿cómo va el servidor?" NO
// matchean aquí (siguen su camino normal) pero igual cierran la escalada,
// porque manejar() llama a acusar() de forma incondicional en cada mensaje.
const PATRON_ACUSE = /^(ok|okey|okay|oka|listo|visto|recibido|enterado|entendido|ya lo vi|ya vi)[\s.!]*$/i;
function esAcuse(texto) {
  return PATRON_ACUSE.test(String(texto || "").trim());
}

/** "sos:<run_id>" -> "sos", "caida:<servicio>:<inicio>" -> "caida", cualquier otra cosa -> "manual". */
function tipoDeClave(clave) {
  const c = String(clave || "");
  if (c.startsWith("sos:")) return "sos";
  if (c.startsWith("caida:")) return "caida";
  return "manual";
}

// ── Fábrica ─────────────────────────────────────────────────────────────────

/**
 * @param {Object} deps
 * @param {string}   deps.DIR_DATOS        "/var/lib/zeus-ops"
 * @param {Function} deps.leerJson         leerJson(archivo, porDefecto) de ops-server.js
 * @param {Function} deps.leerJsonl        leerJsonl(archivo, max) de ops-server.js
 * @param {Function} deps.guardarJson      guardarJson(archivo, obj) de ops-server.js
 * @param {Function} deps.auditar          auditar(accion, quien, resultado, detalle) de ops-server.js
 * @param {Function} deps.enviarWhatsapp   enviarWhatsapp(texto) → {ok, detalle?}, manda al dueño (ya existente)
 * @param {Function} deps.enviarWhatsappA  enviarWhatsappA(numero, texto) → {ok, detalle?}, manda a un número
 *                                         arbitrario — nueva, la construye ops-server.js (ver §5 del diseño /
 *                                         INTEGRACION-ESCALAMIENTO.md §1)
 * @param {Object}   [deps.permisos]       objeto de crearPermisos(...): usa permisos.permitido("whatsapp","escritura")
 * @param {Object}   [deps.kapsoYModo]     require("./kapso-y-modo.js")
 * @param {string}   [deps.F_MODO]         ruta a modo.json
 * @param {string}   [deps.WSP_DESTINO]    número del dueño (env), solo para enmascarar y para no permitir que el
 *                                         técnico se configure igual al dueño
 * @param {Function} [deps.ahora]          () => number (ms); reloj inyectable para pruebas. Default Date.now.
 */
function crearEscalamiento(deps) {
  const {
    DIR_DATOS, leerJson, leerJsonl, guardarJson, auditar, enviarWhatsapp, enviarWhatsappA,
  } = deps || {};
  if (!DIR_DATOS || typeof leerJson !== "function" || typeof leerJsonl !== "function"
    || typeof guardarJson !== "function" || typeof auditar !== "function"
    || typeof enviarWhatsapp !== "function" || typeof enviarWhatsappA !== "function") {
    throw new Error("crearEscalamiento necesita DIR_DATOS, leerJson, leerJsonl, guardarJson, auditar, enviarWhatsapp y enviarWhatsappA de ops-server.js");
  }
  const permisos = deps.permisos || null;
  const kapsoYModo = deps.kapsoYModo || null;
  const F_MODO = deps.F_MODO || null;
  const WSP_DESTINO = deps.WSP_DESTINO || null;
  const ahora = typeof deps.ahora === "function" ? deps.ahora : () => Date.now();

  const rutas = {
    estado: path.join(DIR_DATOS, "escalamiento.json"),
    config: path.join(DIR_DATOS, "escalamiento-config.json"),
    incidentes: path.join(DIR_DATOS, "incidentes.json"),
    corridasSos: path.join(DIR_DATOS, "centinela-db", "sos-corridas.jsonl"),
  };

  // ── Persistencia ──────────────────────────────────────────────────────────

  function estadoVacio() {
    return { version: 1, pendientes: [], historial: [], vistos: { ultimo_sos_fin: null, ultimo_sos_run_id: null } };
  }
  function leerEstado() {
    const db = leerJson(rutas.estado, null);
    if (!db) return estadoVacio();
    return {
      version: 1,
      pendientes: Array.isArray(db.pendientes) ? db.pendientes : [],
      historial: Array.isArray(db.historial) ? db.historial : [],
      vistos: {
        ultimo_sos_fin: (db.vistos && db.vistos.ultimo_sos_fin) || null,
        ultimo_sos_run_id: (db.vistos && db.vistos.ultimo_sos_run_id) || null,
      },
    };
  }
  function guardarEstado(db) { guardarJson(rutas.estado, db); }

  function configVacia() { return { activo: true, tecnico: null, actualizado_ts: null, actualizado_por: null }; }
  function leerConfig() {
    const c = leerJson(rutas.config, null);
    if (!c) return configVacia();
    return {
      activo: c.activo !== false,
      tecnico: c.tecnico || null,
      actualizado_ts: c.actualizado_ts || null,
      actualizado_por: c.actualizado_por || null,
    };
  }
  function guardarConfigDisk(c) { guardarJson(rutas.config, c); }

  // ── Cierre de una pendiente (no persiste por sí sola: el llamador guarda) ─

  function cerrarInterno(db, pendiente, cierre, acusadaPor) {
    const idx = db.pendientes.findIndex((p) => p.clave === pendiente.clave);
    if (idx !== -1) db.pendientes.splice(idx, 1);
    const cerrada = {
      ...pendiente,
      cierre,
      cerrada_ts: new Date(ahora()).toISOString(),
      acusada_por: cierre === "acusada" ? (acusadaPor || null) : null,
    };
    db.historial.unshift(cerrada);
    if (db.historial.length > MAX_HISTORIAL) db.historial.length = MAX_HISTORIAL;
    return cerrada;
  }

  // ── Envío (única puerta de salida de WhatsApp de este módulo, §3.3) ──────

  async function enviarSeguro(destino, texto, numero) {
    if (permisos && typeof permisos.permitido === "function" && !permisos.permitido("whatsapp", "escritura")) {
      return "sin_permiso_whatsapp";
    }
    if (kapsoYModo && F_MODO && typeof kapsoYModo.obtenerModo === "function" && typeof kapsoYModo.debeSilenciar === "function") {
      const modo = kapsoYModo.obtenerModo(leerJson, F_MODO);
      if (kapsoYModo.debeSilenciar(NIVEL_MODO_VIAJE, modo)) return "silenciado_modo_viaje";
    }
    try {
      const r = destino === "tecnico" ? await enviarWhatsappA(numero, texto) : await enviarWhatsapp(texto);
      return r && r.ok ? "enviado" : "falló";
    } catch (_) {
      return "error";
    }
  }

  // ── abrir(clave, texto) — E1..E5 ──────────────────────────────────────────

  async function abrir(clave, texto) {
    const config = leerConfig();
    if (config.activo === false) {
      auditar("escalamiento_omitida", "agente", "desactivado", clave);
      return { ok: false, clave, ya_abierta: false, motivo: "escalamiento_desactivado" };
    }

    const tipo = tipoDeClave(clave);
    let db = leerEstado();

    if (db.pendientes.some((p) => p.clave === clave)) {
      return { ok: true, clave, ya_abierta: true }; // E2
    }
    if (tipo === "sos" && db.pendientes.some((p) => p.tipo === "sos")) {
      return { ok: true, clave, ya_abierta: true, motivo: "ya_hay_sos_activa" }; // E3
    }
    if (tipo === "caida" && db.pendientes.some((p) => p.tipo === "sos")) {
      // Regla de convivencia §1(4): una caída de bot no compite con un SOS ya
      // escalado sobre el mismo problema.
      return { ok: true, clave, ya_abierta: true, motivo: "hay_sos_activa" };
    }

    if (tipo === "sos") {
      // E4: un SOS más específico reemplaza cualquier "caida" en curso.
      const absorbidas = db.pendientes.filter((p) => p.tipo === "caida");
      if (absorbidas.length) {
        for (const p of absorbidas) cerrarInterno(db, p, "absorbida");
        guardarEstado(db);
        for (const p of absorbidas) auditar("escalamiento_cerrada", "agente", "absorbida", p.clave);
        db = leerEstado();
      }
    }

    // E5: se crea, se persiste, y SOLO DESPUÉS se manda (evidencia antes de
    // actuar es la regla del SOS; aquí el equivalente es no perder el
    // registro de que la escalada existe aunque el envío falle o tarde).
    const pendiente = {
      clave, tipo, texto,
      abierta_ts: new Date(ahora()).toISOString(),
      intentos: 0,
      ultimo_envio_ts: null,
      proximo_ts: new Date(ahora() + ESPERA_ACUSE_MIN * 60000).toISOString(),
      envios: [],
    };
    db.pendientes.push(pendiente);
    guardarEstado(db);

    const mensaje = `${texto}\n\n${COLETILLA_ACUSE}`;
    const resultado = await enviarSeguro("dueño", mensaje, WSP_DESTINO);

    // Se relee tras el await por si algo cerró la pendiente mientras se
    // enviaba (acuse casi simultáneo, freno desde el panel, etc.) — no se
    // resucita una pendiente que ya se cerró.
    const dbTrasEnvio = leerEstado();
    const pTrasEnvio = dbTrasEnvio.pendientes.find((p) => p.clave === clave);
    if (pTrasEnvio) {
      const ts = new Date(ahora()).toISOString();
      pTrasEnvio.ultimo_envio_ts = ts;
      pTrasEnvio.envios.push({ ts, intento: 0, destino: "dueño", numero: enmascararNumero(WSP_DESTINO) || "dueño", resultado });
      guardarEstado(dbTrasEnvio);
    }
    auditar("escalamiento_abierta", "agente", resultado, clave);
    return { ok: true, clave, ya_abierta: false, envio: resultado };
  }

  // ── acusar(quien) — E8/E9 ─────────────────────────────────────────────────

  function acusar(quien) {
    const db = leerEstado();
    if (!db.pendientes.length) return { ok: true, cerradas: [] };
    const quienFinal = String(quien || "desconocido");
    const cerradas = [];
    const detalles = [];
    for (const p of db.pendientes.slice()) {
      const cerrada = cerrarInterno(db, p, "acusada", quienFinal);
      cerradas.push(p.clave);
      detalles.push({ clave: p.clave, intentos: cerrada.intentos });
    }
    guardarEstado(db);
    for (const d of detalles) {
      auditar("escalamiento_acusada", quienFinal, "ok", `${d.clave} · tras ${d.intentos} reenvíos`);
    }
    return { ok: true, cerradas };
  }

  // ── cerrar(clave, cierre) — E10/E11 ──────────────────────────────────────

  function cerrar(clave, cierre) {
    const cierreFinal = cierre || "recuperada";
    const db = leerEstado();
    const p = db.pendientes.find((x) => x.clave === clave);
    if (!p) return { ok: true, existia: false };
    cerrarInterno(db, p, cierreFinal);
    guardarEstado(db);
    auditar("escalamiento_cerrada", "agente", cierreFinal, clave);
    return { ok: true, existia: true };
  }

  // ── Detección C1 — SOS detenido con clientes afectados ───────────────────
  // Sync, con efecto secundario (avanza y persiste la marca de agua). Se
  // aparta levemente de la forma "string[]" sugerida por el diseño: devuelve
  // los pares {clave, texto} que necesita quizaEscalar para llamar a abrir()
  // sin tener que reconstruir el texto en dos sitios — el diseño la marca
  // como "expuesta para pruebas", no como contrato cerrado de tipos.

  function detectarSos() {
    const corridas = leerJsonl(rutas.corridasSos, MAX_LINEAS_SOS).filter((c) => c && c.fin);
    if (!corridas.length) return [];
    corridas.sort((a, b) => (a.fin < b.fin ? -1 : a.fin > b.fin ? 1 : 0));

    const db = leerEstado();
    const marca = db.vistos.ultimo_sos_fin;

    if (marca == null) {
      // Primer arranque: fija la marca en lo más reciente que exista, sin
      // escalar nada del historial previo a instalar este módulo.
      const ultima = corridas[corridas.length - 1];
      db.vistos = { ultimo_sos_fin: ultima.fin, ultimo_sos_run_id: ultima.run_id || null };
      guardarEstado(db);
      return [];
    }

    const nuevas = corridas.filter((c) => c.fin > marca);
    if (!nuevas.length) return [];

    const ahoraMs = ahora();
    const candidatas = [];
    for (const c of nuevas) {
      const edadMs = ahoraMs - Date.parse(c.fin);
      if (c.resultado === "detenido_pide_ayuda" && c.afecta_clientes === "si" && edadMs <= MAX_EDAD_CORRIDA_MIN * 60000) {
        const diagLinea = typeof c.diagnostico === "string" && c.diagnostico.trim() ? `\n${c.diagnostico.trim()}` : "";
        const texto = `Seguimiento del SOS de las ${horaColombia(c.fin)}: se detuvo sin resolver la falla y los clientes están afectados.${diagLinea}\nNecesito que una persona revise el servidor.`;
        candidatas.push({ clave: `sos:${c.run_id}`, texto });
      }
    }
    // La marca de agua avanza aunque no se abra nada (corridas ya vistas,
    // sin afectar clientes, o demasiado viejas): así el próximo tick no
    // vuelve a mirarlas.
    const ultima = nuevas[nuevas.length - 1];
    db.vistos = { ultimo_sos_fin: ultima.fin, ultimo_sos_run_id: ultima.run_id || null };
    guardarEstado(db);
    return candidatas;
  }

  // ── Detección C2 — caída del bot no resuelta ─────────────────────────────

  function detectarCaida() {
    const db = leerEstado();
    if (db.pendientes.some((p) => p.tipo === "sos")) return []; // §1 regla 4
    const incidentes = leerJson(rutas.incidentes, { abierto: null, historial: [] });
    const abierto = incidentes && incidentes.abierto;
    if (!abierto || !abierto.servicio || !abierto.inicio || !SERVICIOS_BOT.has(abierto.servicio)) return [];
    const edadMin = (ahora() - Date.parse(abierto.inicio)) / 60000;
    if (edadMin < UMBRAL_CAIDA_MIN) return [];
    const clave = `caida:${abierto.servicio}:${abierto.inicio}`;
    if (db.pendientes.some((p) => p.clave === clave)) return [];
    const minutos = Math.floor(edadMin);
    const texto = `${nombreClaro(abierto.servicio)} lleva ${minutos} minutos sin atender a los clientes y no se ha recuperado. Necesito que una persona revise el servidor.`;
    return [{ clave, texto }];
  }

  // ── Recuperaciones (antes de mandar nada en cada tick, §1 tabla) ─────────

  function cerrarRecuperadas() {
    const db = leerEstado();
    if (!db.pendientes.length) return [];
    const incidentes = leerJson(rutas.incidentes, { abierto: null, historial: [] });
    const corridasSos = leerJsonl(rutas.corridasSos, MAX_LINEAS_SOS);
    const cerradas = [];
    let cambio = false;
    for (const p of db.pendientes.slice()) {
      let recuperada = false;
      if (p.tipo === "caida") {
        // La clave es "caida:<servicio>:<inicioISO>" y el ISO trae ":" — no
        // se puede desestructurar con un split(":") simple, hay que volver a
        // unir todo lo que va después del segundo ":".
        const partes = p.clave.split(":");
        const servicio = partes[1];
        const inicio = partes.slice(2).join(":");
        const abierto = incidentes && incidentes.abierto;
        recuperada = !abierto || abierto.inicio !== inicio || abierto.servicio !== servicio;
      } else if (p.tipo === "sos") {
        recuperada = corridasSos.some((c) => c && c.fin && c.fin > p.abierta_ts
          && (c.resultado === "restablecido" || c.resultado === "sin_falla"));
      }
      if (recuperada) {
        cerrarInterno(db, p, "recuperada");
        cerradas.push(p.clave);
        cambio = true;
      }
    }
    if (cambio) guardarEstado(db);
    for (const clave of cerradas) auditar("escalamiento_cerrada", "agente", "recuperada", clave);
    return cerradas;
  }

  // ── quizaEscalar() — un tick, llamado cada 60s desde setInterval ─────────

  let enCurso = false;

  async function quizaEscalar() {
    if (enCurso) return { abiertas: [], reenviadas: [], cerradas: [], agotadas: [], omitido: "tick_anterior_en_curso" };
    enCurso = true;
    try {
      const config = leerConfig();
      if (!config.activo) return { abiertas: [], reenviadas: [], cerradas: [], agotadas: [], omitido: "desactivado" };

      const cerradas = cerrarRecuperadas();

      const abiertas = [];
      for (const cand of detectarSos()) {
        const r = await abrir(cand.clave, cand.texto);
        if (r.ok && !r.ya_abierta) abiertas.push(cand.clave);
      }
      for (const cand of detectarCaida()) {
        const r = await abrir(cand.clave, cand.texto);
        if (r.ok && !r.ya_abierta) abiertas.push(cand.clave);
      }

      const reenviadas = [];
      const agotadas = [];
      const clavesActivas = leerEstado().pendientes.map((p) => p.clave);
      for (const clave of clavesActivas) {
        const db = leerEstado(); // se relee en cada vuelta: pudo cambiar en la anterior
        const p = db.pendientes.find((x) => x.clave === clave);
        if (!p) continue; // se cerró mientras tanto
        if (ahora() < Date.parse(p.proximo_ts)) continue;

        if (p.intentos >= MAX_REINTENTOS) {
          cerrarInterno(db, p, "agotada");
          guardarEstado(db);
          auditar("escalamiento_agotada", "agente", "sin_respuesta", `${clave} · ${p.intentos} reenvíos`);
          agotadas.push(clave);
          continue;
        }

        const destino = config.tecnico ? "tecnico" : "dueño";
        const numeroDestino = destino === "tecnico" ? config.tecnico : WSP_DESTINO;
        const intentoNum = p.intentos + 1;
        const minutosDesdeApertura = Math.floor((ahora() - Date.parse(p.abierta_ts)) / 60000);
        const textoReenvio = destino === "tecnico"
          ? `Aviso de Centinela Zeus (servidor del bot de WhatsApp): el dueño no ha confirmado este aviso en ${minutosDesdeApertura} minutos. Aviso ${intentoNum} de ${MAX_REINTENTOS}.\n\n${p.texto}\n\nSi puedes, revisa el servidor o comunícate con el dueño.`
          : `Sigo sin confirmación de este aviso (${minutosDesdeApertura} min). Aviso ${intentoNum} de ${MAX_REINTENTOS}.\n\n${p.texto}\n\n${COLETILLA_ACUSE}`;

        const resultado = await enviarSeguro(destino, textoReenvio, numeroDestino);

        const dbTrasEnvio = leerEstado();
        const pTrasEnvio = dbTrasEnvio.pendientes.find((x) => x.clave === clave);
        if (!pTrasEnvio) {
          auditar("escalamiento_reenvio", "agente", resultado, `${clave} · descartado (ya no estaba activa)`);
          continue;
        }
        const ts = new Date(ahora()).toISOString();
        pTrasEnvio.intentos = intentoNum;
        pTrasEnvio.ultimo_envio_ts = ts;
        pTrasEnvio.proximo_ts = new Date(ahora() + INTERVALO_REINTENTO_MIN * 60000).toISOString();
        pTrasEnvio.envios.push({ ts, intento: intentoNum, destino, numero: enmascararNumero(numeroDestino) || destino, resultado });
        guardarEstado(dbTrasEnvio);
        auditar("escalamiento_reenvio", "agente", resultado, `${clave} · aviso ${intentoNum} de ${MAX_REINTENTOS} · ${destino}`);
        reenviadas.push(clave);
      }

      return { abiertas, reenviadas, cerradas, agotadas };
    } catch (e) {
      auditar("escalamiento_error", "agente", "error", e.message);
      return { abiertas: [], reenviadas: [], cerradas: [], agotadas: [] };
    } finally {
      enCurso = false;
    }
  }

  // ── Configuración del número del técnico (GET/POST /api/escalamiento/config) ─

  function guardarConfig(cambios, quien) {
    const datos = cambios || {};
    const actual = leerConfig();
    let nuevoTecnico = actual.tecnico;

    if (Object.prototype.hasOwnProperty.call(datos, "tecnico")) {
      const v = validarNumero(datos.tecnico);
      if (!v.ok) {
        auditar("escalamiento_config", quien || "panel", "rechazada", "número inválido");
        return { ok: false, mensaje: v.mensaje };
      }
      if (WSP_DESTINO && v.numero && v.numero === String(WSP_DESTINO)) {
        auditar("escalamiento_config", quien || "panel", "rechazada", "número inválido");
        return { ok: false, mensaje: "El número del técnico no puede ser el mismo del dueño." };
      }
      nuevoTecnico = v.numero;
    }

    let nuevoActivo = actual.activo;
    if (Object.prototype.hasOwnProperty.call(datos, "activo")) {
      if (typeof datos.activo !== "boolean") {
        return { ok: false, mensaje: "El interruptor debe ser sí o no." };
      }
      nuevoActivo = datos.activo;
    }

    guardarConfigDisk({
      activo: nuevoActivo, tecnico: nuevoTecnico,
      actualizado_ts: new Date(ahora()).toISOString(), actualizado_por: quien || null,
    });

    if (nuevoActivo === false && actual.activo !== false) {
      // E12: apagar la función cierra cualquier escalada en curso.
      const db = leerEstado();
      if (db.pendientes.length) {
        const claves = db.pendientes.map((p) => p.clave);
        for (const p of db.pendientes.slice()) cerrarInterno(db, p, "desactivada");
        guardarEstado(db);
        for (const clave of claves) auditar("escalamiento_cerrada", "panel", "desactivada", clave);
      }
    }

    auditar("escalamiento_config", quien || "panel", "guardada", `activo: ${nuevoActivo} · técnico: ${enmascararNumero(nuevoTecnico) || "ninguno"}`);
    return { ok: true, activo: nuevoActivo, tecnico: nuevoTecnico };
  }

  // ── estado() — GET /api/escalamiento, para el panel ──────────────────────

  function estado() {
    const db = leerEstado();
    const config = leerConfig();
    const ahoraMs = ahora();
    const pendientes = db.pendientes.map((p) => ({
      ...p,
      destino_siguiente: config.tecnico ? "tecnico" : "dueño",
      minutos_abierta: Math.floor((ahoraMs - Date.parse(p.abierta_ts)) / 60000),
      minutos_para_proximo: Math.max(0, Math.ceil((Date.parse(p.proximo_ts) - ahoraMs) / 60000)),
    }));
    return {
      ok: true,
      activo: config.activo,
      tecnico_configurado: !!config.tecnico,
      tecnico_enmascarado: enmascararNumero(config.tecnico),
      dueno_enmascarado: WSP_DESTINO ? enmascararNumero(WSP_DESTINO) : "dueño",
      pendientes,
      historial: db.historial,
      constantes: { ESPERA_ACUSE_MIN, INTERVALO_REINTENTO_MIN, MAX_REINTENTOS, UMBRAL_CAIDA_MIN },
    };
  }

  return {
    abrir, acusar, cerrar, quizaEscalar, estado,
    leerConfig, guardarConfig,
    detectarSos, detectarCaida,
    CONSTANTES,
  };
}

module.exports = { crearEscalamiento, validarNumero, enmascararNumero, esAcuse, tipoDeClave, COLETILLA_ACUSE };
