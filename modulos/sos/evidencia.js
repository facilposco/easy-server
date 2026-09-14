"use strict";
/**
 * modulos/sos/evidencia.js
 *
 * Paquete de evidencia del SOS (DISENO-SOS.md §9). REGLA DE ORO: el
 * enmascarado (modulos/sos/enmascarar.js) se aplica a cada sección ANTES de
 * que exista el objeto final que se escribe a disco — nunca después, nunca
 * como paso separado. `armarPaquete` ya devuelve texto enmascarado;
 * `escribirPaquete` solo serializa lo que ya viene limpio.
 *
 * Tope total del paquete: 256 KB tras enmascarar (§9.2). Si se excede, se
 * recorta por orden: sistema_registros, logs_* de servicios sanos,
 * puerta_entrada, centinela.
 */

const fs = require("fs");
const path = require("path");

const TOPE_PAQUETE_BYTES = 256 * 1024;
const ORDEN_RECORTE = ["sistema_registros", "puerta_entrada", "centinela"]; // logs_* de sanos se recortan aparte

function bytesDe(texto) { return Buffer.byteLength(String(texto || ""), "utf8"); }

/**
 * @param {object} deps
 * @param {object} deps.db          instancia de db-centinela.js (crearDbCentinela)
 * @param {function} deps.sh
 * @param {object} deps.enmascarador  { enmascarar, contiene } de crearEnmascarador(...)
 * @param {function} [deps.auditar]
 */
function crearEvidencia(deps) {
  if (typeof deps.sh !== "function") throw new Error("crearEvidencia necesita sh()");
  if (!deps.db) throw new Error("crearEvidencia necesita db (db-centinela.js)");
  if (!deps.enmascarador) throw new Error("crearEvidencia necesita el enmascarador");

  const { db, sh, enmascarador } = deps;
  const auditar = deps.auditar || (() => {});

  function nuevoId() {
    return `ev-${Math.floor(Date.now() / 1000)}-${Math.random().toString(16).slice(2, 6)}`;
  }

  /**
   * Arma una sección: corre el comando (si lo hay), enmascara el resultado y
   * lo recorta al tope indicado. `opciones.esLogBot` activa el filtro de
   * líneas técnicas (regla 4 del enmascarado) antes de lo demás.
   */
  async function seccion(clave, titulo, comandoOrTexto, topeBytes, opciones = {}) {
    let crudo = "";
    let comandoTxt = null;
    if (typeof comandoOrTexto === "function") {
      try { crudo = await comandoOrTexto(); } catch (e) { crudo = `[error obteniendo la sección: ${e.message}]`; }
    } else if (comandoOrTexto && comandoOrTexto.comando) {
      comandoTxt = comandoOrTexto.comando;
      const r = await sh(comandoOrTexto.comando, comandoOrTexto.timeout || 10000);
      crudo = (r.salida || "") + (r.error ? `\n${r.error}` : "");
    } else {
      crudo = String(comandoOrTexto || "");
    }

    const contador = opciones.contador || null;
    const enm = enmascarador.enmascarar(crudo, { esLogBot: !!opciones.esLogBot, contador });
    let texto = enm.texto;
    let recortado = false;
    if (bytesDe(texto) > topeBytes) {
      texto = Buffer.from(texto, "utf8").slice(0, topeBytes).toString("utf8") + "\n…[recortado]";
      recortado = true;
    }
    if (enm.omitida) auditar("evidencia_seccion_omitida", "sos", "aviso", clave);

    return {
      clave, titulo, comando: comandoTxt,
      texto, bytes: bytesDe(texto), recortado,
      ...(enm.lineas_totales != null ? { lineas_totales: enm.lineas_totales, lineas_conservadas: enm.lineas_conservadas } : {}),
    };
  }

  /**
   * Arma el paquete completo (§9.2). `ctx` trae todo lo ya leído por sos.js
   * en F1/F3 para no repetir E/S: { S, diag, run_id, incidente_sos_id,
   * incidente_id, origen, secretos, tipo }.
   * `extras` opcional: { memoria_bot, du_disco }.
   */
  async function armarPaquete(ctx, extras = {}) {
    const { S, diag, run_id, incidente_sos_id, incidente_id, origen, tipo } = ctx;
    const contador = { secretos: 0, credenciales: 0, personales: 0, sql: 0, barrido: 0 };
    const secciones = [];

    secciones.push(await seccion("resumen", "Qué encontró Centinela",
      JSON.stringify({ diagnostico: diag, S: resumirInstantanea(S) }, null, 2), 8 * 1024, { contador }));

    secciones.push(await seccion("servicios", "Estado de los servicios",
      { comando: "docker ps -a --format '{{.Names}};{{.State}};{{.Status}};{{.RunningFor}}'" }, 4 * 1024, { contador }));

    secciones.push(await seccion("detalle_servicios", "Detalle de cada servicio propio", {
      comando: "docker inspect -f '{{.Name}} estado={{.State.Status}} salida={{.State.ExitCode}} sin_memoria={{.State.OOMKilled}} inicio={{.State.StartedAt}} fin={{.State.FinishedAt}} reinicios={{.RestartCount}} salud={{if .State.Health}}{{.State.Health.Status}}{{else}}sin-chequeo{{end}} creado={{.Created}} imagen={{.Config.Image}}' zeus-bot zeus-mariadb zeus-chromadb zeus-proxy",
    }, 4 * 1024, { contador }));

    const noSanos = Object.entries((diag && diag.clasificacion) || {}).filter(([, v]) => v !== "sano").map(([k]) => k);
    for (const nombre of noSanos) {
      secciones.push(await seccion(`chequeos_salud_${nombre}`, `Últimos chequeos de salud (${nombre})`, {
        comando: `docker inspect -f '{{range .State.Health.Log}}{{.Start}} codigo={{.ExitCode}} {{.Output}}{{"\\n"}}{{end}}' ${nombre}`,
      }, 2 * 1024, { contador }));
    }

    // Logs: bot siempre; los demás si no sanos o son el culpable.
    const necesitanLogs = new Set(["zeus-bot", ...noSanos, ...(diag && diag.culpable ? [diag.culpable] : [])]);
    for (const nombre of necesitanLogs) {
      if (!["zeus-bot", "zeus-mariadb", "zeus-chromadb", "zeus-proxy"].includes(nombre)) continue;
      secciones.push(await seccion(`logs_${nombre}`, `Registro de ${nombre}`, {
        comando: `docker logs --tail 300 --timestamps ${nombre} 2>&1`,
      }, 48 * 1024, { contador, esLogBot: nombre === "zeus-bot" }));
    }

    secciones.push(await seccion("sistema", "Memoria, disco y procesos", {
      comando: "free -m; df -h /; df -i /; uptime; ps -eo pid,pcpu,pmem,rss,etime,comm --sort=-pmem | head -12; ps -eo pid,pcpu,comm --sort=-pcpu | head -8; docker stats --no-stream --format '{{.Name}};{{.MemUsage}};{{.CPUPerc}}'",
      timeout: 15000,
    }, 8 * 1024, { contador }));

    secciones.push(await seccion("nucleo", "Avisos del sistema", {
      comando: "dmesg -T 2>/dev/null | grep -iE 'oom|killed process|out of memory|i/o error|ext4|blocked for more' | tail -40",
    }, 6 * 1024, { contador }));

    secciones.push(await seccion("sistema_registros", "Registro del sistema", {
      comando: "journalctl -p warning -n 120 --no-pager -o short-iso; echo '---docker---'; journalctl -u docker -n 60 --no-pager -o short-iso",
      timeout: 15000,
    }, 16 * 1024, { contador }));

    if (diag && diag.sintoma_principal === "disco_lleno") {
      secciones.push(await seccion("disco_detalle", "Qué ocupa el disco",
        extras.du_disco || { comando: "du -xh -d1 /var /opt 2>/dev/null | sort -rh | head -15; docker system df", timeout: 20000 },
        4 * 1024, { contador }));
    }

    if (extras.consultas_bd) {
      secciones.push(await seccion("base_datos", "Conexiones de la base de datos", extras.consultas_bd, 6 * 1024, { contador }));
    }

    if (extras.memoria_bot) {
      secciones.push(await seccion("memoria_bot", "Memoria del bot", JSON.stringify(extras.memoria_bot, null, 2), 8 * 1024, { contador }));
    }

    secciones.push(await seccion("despliegue", "Versión del bot", {
      comando: "git -C /opt/zeus-app log -5 --format='%h %cI %s'; echo '---tags---'; git -C /opt/zeus-app tag -l 'backup/*' | sort | tail -5; echo '---status---'; git -C /opt/zeus-app status --porcelain | head -20",
    }, 4 * 1024, { contador }));

    if (diag && diag.sintoma_principal === "puerta_caida") {
      secciones.push(await seccion("puerta_entrada", "Puerta de entrada", {
        comando: "docker logs --tail 100 --timestamps zeus-proxy 2>&1; echo '---dynamic---'; ls -la --time-style=long-iso /opt/zeus-proxy/dynamic 2>/dev/null",
      }, 16 * 1024, { contador }));
    }

    secciones.push(await seccion("centinela", "Lo que Centinela ya sabía", JSON.stringify(extras.centinela || {}, null, 2), 16 * 1024, { contador }));

    // acciones: se completa al cerrar la corrida (§9.2); placeholder aquí.
    secciones.push({ clave: "acciones", titulo: "Qué hizo el SOS", comando: null, texto: "[se completa al cerrar la corrida]", bytes: 0, recortado: false });

    let total = secciones.reduce((a, s) => a + s.bytes, 0);
    for (const clave of ORDEN_RECORTE) {
      if (total <= TOPE_PAQUETE_BYTES) break;
      const idx = secciones.findIndex((s) => s.clave === clave);
      if (idx >= 0 && secciones[idx].texto !== "[recortado por espacio]") {
        total -= secciones[idx].bytes;
        secciones[idx] = { ...secciones[idx], texto: "[recortado por espacio]", bytes: 0, recortado: true };
      }
    }

    const paquete = {
      id: nuevoId(),
      version: 1,
      ts: new Date().toISOString(),
      tipo: tipo || (diag && diag.sintoma_principal === "todo_bien" ? "sin_falla" : "falla"),
      run_id, incidente_sos_id: incidente_sos_id || null, incidente_id: incidente_id || null,
      origen: origen || "panel",
      sintoma_principal: diag ? diag.sintoma_principal : "no_diagnosticable",
      sintomas_secundarios: (diag && diag.secundarios) || [],
      afecta_clientes: diag ? diag.afecta_clientes : "desconocido",
      secciones,
      enmascarado: { version: 1, reemplazos: contador },
      bytes_total: total,
    };
    return paquete;
  }

  /** Arma un paquete mínimo (≤ 4 KB) para "sin_falla" o "no_diagnosticable" (§8). */
  async function armarPaqueteMinimo(ctx) {
    const resumen = await seccion("resumen", "Qué encontró Centinela",
      JSON.stringify({ diagnostico: ctx.diag, S: resumirInstantanea(ctx.S) }, null, 2), 4 * 1024, {});
    return {
      id: nuevoId(), version: 1, ts: new Date().toISOString(),
      tipo: ctx.tipo || "sin_falla",
      run_id: ctx.run_id, incidente_sos_id: ctx.incidente_sos_id || null, incidente_id: ctx.incidente_id || null,
      origen: ctx.origen || "panel",
      sintoma_principal: ctx.diag ? ctx.diag.sintoma_principal : "no_diagnosticable",
      sintomas_secundarios: [],
      afecta_clientes: ctx.diag ? ctx.diag.afecta_clientes : "desconocido",
      secciones: [resumen],
      enmascarado: { version: 1, reemplazos: { secretos: 0, credenciales: 0, personales: 0, sql: 0, barrido: 0 } },
      bytes_total: resumen.bytes,
    };
  }

  function resumirInstantanea(S) {
    if (!S) return {};
    return { memoria: S.memoria, disco: S.disco, cpu: S.cpu, contenedores: S.contenedores };
  }

  // ── Escritura, índice y rotación ──────────────────────────────────────────

  function leerIndice() {
    return db.leerJson(db.RUTAS.indiceEvidencia, { version: 1, paquetes: [], bytes_total: 0 });
  }

  function guardarIndice(idx) { db.escribirAtomico(db.RUTAS.indiceEvidencia, idx); }

  function reconstruirIndice() {
    let archivos = [];
    try { archivos = fs.readdirSync(db.DIR_EVIDENCIA).filter((f) => f.endsWith(".json") && f !== "indice.json"); } catch (_) {}
    const paquetes = [];
    let total = 0;
    for (const f of archivos) {
      const p = db.leerJson(path.join(db.DIR_EVIDENCIA, f), null);
      if (!p) continue;
      paquetes.push(resumenIndice(p));
      total += p.bytes_total || 0;
    }
    paquetes.sort((a, b) => (a.ts < b.ts ? 1 : -1));
    const idx = { version: 1, paquetes, bytes_total: total };
    guardarIndice(idx);
    return idx;
  }

  function resumenIndice(p) {
    return {
      id: p.id, ts: p.ts, tipo: p.tipo, titulo: tituloDe(p), sintoma_principal: p.sintoma_principal,
      afecta_clientes: p.afecta_clientes, run_id: p.run_id, incidente_id: p.incidente_id, bytes: p.bytes_total,
    };
  }

  function tituloDe(p) {
    const textos = require("./textos.js");
    return textos.tituloSintoma(p.sintoma_principal);
  }

  /**
   * Escribe el paquete a disco (ya enmascarado por armarPaquete) y actualiza
   * el índice + rotación. Devuelve { ok, id, bytes } o { ok:false, motivo }
   * si ni siquiera la versión mínima cupo (disco lleno).
   */
  function escribirPaquete(paquete, opciones = {}) {
    const ok = db.escribirAtomico(db.rutaEvidencia(paquete.id), paquete);
    if (!ok) return { ok: false, motivo: "no se pudo escribir en disco" };
    const idx = leerIndice();
    idx.paquetes.unshift(resumenIndice(paquete));
    idx.bytes_total += paquete.bytes_total || 0;
    guardarIndice(idx);
    rotar({ incidenteAbiertoId: opciones.incidenteAbiertoId, incidenteActualId: opciones.incidenteActualId, forzarTopesBajos: opciones.forzarTopesBajos });
    return { ok: true, id: paquete.id, bytes: paquete.bytes_total };
  }

  /**
   * Rotación (§10.4): máx 40 paquetes / 30 días / 25 MB; sin_falla máx 5;
   * nunca borra el vinculado a un incidente abierto. `forzarTopesBajos` la
   * usa `liberar_disco` (10 paquetes / 10 MB mientras el disco esté >= 90 %).
   */
  function rotar(opciones = {}) {
    const idx = leerIndice();
    const topes = opciones.forzarTopesBajos
      ? { paquetes: 10, bytes: 10 * 1024 * 1024, dias: 30 }
      : { paquetes: 40, bytes: 25 * 1024 * 1024, dias: 30 };
    const limiteMs = Date.now() - topes.dias * 86400000;
    const protegido = (p) => p.incidente_id && (p.incidente_id === opciones.incidenteAbiertoId || p.id === opciones.incidenteActualId);

    let paquetes = idx.paquetes.slice();
    // 1. máximo 5 "sin_falla".
    const sinFalla = paquetes.filter((p) => p.tipo === "sin_falla").sort((a, b) => (a.ts < b.ts ? 1 : -1));
    const sinFallaBorrar = sinFalla.slice(5).filter((p) => !protegido(p));
    // 2. por edad.
    const viejos = paquetes.filter((p) => new Date(p.ts).getTime() < limiteMs && !protegido(p));
    // 3. por cantidad / bytes totales: borra los más viejos primero (sin_falla antes que el resto).
    let aBorrar = new Set([...sinFallaBorrar, ...viejos].map((p) => p.id));

    let restantes = paquetes.filter((p) => !aBorrar.has(p.id));
    restantes.sort((a, b) => (a.ts < b.ts ? -1 : 1)); // más viejos primero
    let total = restantes.reduce((a, p) => a + (p.bytes || 0), 0);
    let i = 0;
    while ((restantes.length - i > topes.paquetes || total > topes.bytes) && i < restantes.length) {
      const p = restantes[i];
      if (!protegido(p)) { aBorrar.add(p.id); total -= (p.bytes || 0); }
      i++;
    }

    for (const id of aBorrar) {
      try { fs.unlinkSync(db.rutaEvidencia(id)); } catch (_) {}
    }
    if (aBorrar.size) {
      const nuevo = { version: 1, paquetes: paquetes.filter((p) => !aBorrar.has(p.id)), bytes_total: 0 };
      nuevo.bytes_total = nuevo.paquetes.reduce((a, p) => a + (p.bytes || 0), 0);
      guardarIndice(nuevo);
    }
    return { borrados: aBorrar.size };
  }

  function listar() {
    const idx = leerIndice();
    return { paquetes: idx.paquetes, bytes_total: idx.bytes_total, limites: { paquetes: 40, dias: 30, bytes: 25 * 1024 * 1024 } };
  }

  function leer(id, formato) {
    if (!/^ev-\d{9,11}-[0-9a-f]{4}$/.test(id)) return null;
    const p = db.leerJson(db.rutaEvidencia(id), null);
    if (!p) return null;
    if (!formato || formato === "json") return p;
    if (formato === "texto") return renderTexto(p);
    if (formato === "resumen") return renderResumen(p);
    return p;
  }

  function renderTexto(p) {
    const textos = require("./textos.js");
    const lineas = [
      `CENTINELA ZEUS — REGISTRO DE EVIDENCIA ${p.id}`,
      `Fecha: ${textos.horaColombia(p.ts)} (Colombia)`,
      `Falla: ${textos.tituloSintoma(p.sintoma_principal)}`,
      `Clientes afectados: ${p.afecta_clientes}`,
      "Servidor: Zeus (Linode) · 2 CPU · 4 GB", "",
    ];
    for (const s of p.secciones) {
      lineas.push(`== ${s.titulo} ==`);
      if (s.comando) lineas.push(`$ ${s.comando}`);
      lineas.push(s.texto, "");
    }
    return lineas.join("\n");
  }

  function renderResumen(p) {
    const claves = ["resumen", "servicios", "detalle_servicios", "acciones"];
    const partes = p.secciones.filter((s) => claves.includes(s.clave));
    const culpableLog = p.secciones.find((s) => s.clave.startsWith("logs_"));
    if (culpableLog) {
      const ultimas40 = culpableLog.texto.split("\n").slice(-40).join("\n");
      partes.push({ ...culpableLog, texto: ultimas40 });
    }
    let texto = partes.map((s) => `== ${s.titulo} ==\n${s.texto}`).join("\n\n");
    if (texto.length > 3000) texto = texto.slice(0, 3000) + "\n…[recortado]";
    return texto;
  }

  /** Borrado manual (§10.5). `todos:true` borra todo salvo el paquete en curso. */
  function borrar({ id, todos }, opciones = {}) {
    const idx = leerIndice();
    if (todos) {
      let bytes = 0, n = 0;
      for (const p of idx.paquetes) {
        if (opciones.enCursoId && p.id === opciones.enCursoId) continue;
        try { fs.unlinkSync(db.rutaEvidencia(p.id)); n++; bytes += p.bytes || 0; } catch (_) {}
      }
      guardarIndice({ version: 1, paquetes: opciones.enCursoId ? idx.paquetes.filter((p) => p.id === opciones.enCursoId) : [], bytes_total: 0 });
      return { ok: true, borrados: n, bytes_liberados: bytes };
    }
    if (opciones.enCursoId && id === opciones.enCursoId) return { ok: false, code: 409, mensaje: "El paquete de la corrida en curso no se puede borrar." };
    const p = idx.paquetes.find((x) => x.id === id);
    if (!p) return { ok: false, code: 404, mensaje: "No existe." };
    try { fs.unlinkSync(db.rutaEvidencia(id)); } catch (_) {}
    const nuevo = { version: 1, paquetes: idx.paquetes.filter((x) => x.id !== id), bytes_total: idx.bytes_total - (p.bytes || 0) };
    guardarIndice(nuevo);
    return { ok: true, borrados: 1, bytes_liberados: p.bytes || 0 };
  }

  return { armarPaquete, armarPaqueteMinimo, escribirPaquete, listar, leer, borrar, rotar, reconstruirIndice, renderTexto, renderResumen, TOPE_PAQUETE_BYTES };
}

module.exports = { crearEvidencia, TOPE_PAQUETE_BYTES };
