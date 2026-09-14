"use strict";
/**
 * Centinela Zeus — módulo de resiliencia (Fase Caos, DISENO-FASE-CAOS.md §3).
 *
 * Tres mejoras estructurales, independientes entre sí, en un solo archivo
 * pequeño porque ninguna merece su propio módulo:
 *
 *   §3.1 Swap efímero antes de operaciones pesadas — SE IMPLEMENTA completo.
 *   §3.2 Defensa perimetral ("Under Attack" de Cloudflare) — SOLO AVISO, porque
 *        el CLOUDFLARE_API_TOKEN disponible no tiene permiso de Zona.
 *   §3.3 Perfilado de memoria proactivo — variante viable ("paquete de
 *        evidencia de memoria") porque un heap snapshot real exigiría tocar
 *        el bot, fuera de alcance de esta fase.
 *
 * Sigue el mismo patrón de bajo acoplamiento que `db-optimizacion.js` y
 * `seguridad-auditoria.js`: recibe TODO lo que necesita de ops-server.js por
 * parámetro (fábrica `crearResiliencia(deps)`), no asume que existen
 * funciones internas, y no ejecuta nada por su cuenta hasta que otro archivo
 * llama a una de sus funciones desde una ruta HTTP o un `setInterval`.
 *
 * Cero dependencias externas: solo lo que ya usa ops-server.js.
 */

const path = require("path");

// ── §3.1 Swap efímero ────────────────────────────────────────────────────────

const RUTA_SWAP = "/swapfile-zeus";
const UNIDAD_HOMBRE_MUERTO_SWAP = "zeus-swap-efimero";
const TAMANO_SWAP = "2G";
const TAMANO_SWAP_BYTES = 2 * 1024 * 1024 * 1024;
const ESPACIO_LIBRE_MINIMO_BYTES = 3 * 1024 * 1024 * 1024; // 3 GB, según el diseño
const HOMBRE_MUERTO_SWAP_SEGUNDOS = 1800; // 30 min de tope, por si quien lo pidió muere sin limpiar

/**
 * ¿Por qué puede quedar un archivo de swap huérfano?
 *   1) `zeus-ops` muere justo entre `fallocate` y `swapon` (el archivo existe
 *      pero nunca se activó como swap).
 *   2) `zeus-ops` muere después de `swapon` sin llegar a llamar a
 *      `quitarSwapEfimero()` (el swap queda activo indefinidamente).
 *
 * Cómo se limpia en cada caso:
 *   - Caso 2 (el peor, swap activo y olvidado): lo resuelve el propio sistema
 *     operativo. Al crear el swap se programa SIEMPRE un temporizador de
 *     systemd independiente del proceso (`systemd-run --on-active=1800s`)
 *     que apaga y borra el archivo pase lo que pase con `zeus-ops`. Si el
 *     servidor se reinicia antes de que el temporizador dispare, el swap ya
 *     no está activo de todas formas (el swap no sobrevive un reinicio
 *     porque nunca se agrega a /etc/fstab), así que el riesgo real es cero;
 *     solo puede sobrevivir el ARCHIVO en disco (ver caso 1).
 *   - Caso 1 (archivo en disco, plano, sin swap activo): es inofensivo — solo
 *     ocupa 2 GB de disco. `crearSwapEfimero()` se autolimpia: cada vez que
 *     se le llama, primero comprueba si `/swapfile-zeus` existe SIN estar
 *     activo como swap y, si es así, lo borra antes de seguir. Así el
 *     próximo uso normal del swap efímero limpia el huérfano solo, sin
 *     necesidad de que nadie entre por SSH. Si se prefiere una limpieza
 *     inmediata (no esperar al próximo uso), basta con llamar una vez a
 *     `quitarSwapEfimero()` al arrancar `zeus-ops` (ver INTEGRACION, es
 *     opcional porque el huérfano no representa riesgo, solo espacio).
 */
function crearResiliencia(deps) {
  const { sh, auditar, enviarWhatsapp } = deps || {};
  if (typeof sh !== "function") throw new Error("crearResiliencia necesita sh() de ops-server.js");
  if (typeof auditar !== "function") throw new Error("crearResiliencia necesita auditar() de ops-server.js");

  // ── 3.1 Swap efímero ────────────────────────────────────────────────────

  /** true si /swapfile-zeus está activo como swap ahora mismo. */
  async function swapActivo() {
    const r = await sh(`swapon --show=NAME --noheadings 2>/dev/null | grep -qx '${RUTA_SWAP}' && echo si || echo no`);
    return r.salida.trim() === "si";
  }

  /** Espacio libre real en bytes de la partición "/". */
  async function espacioLibreRaiz() {
    const r = await sh(`df -B1 --output=avail / | tail -1`);
    return parseInt((r.salida || "0").trim(), 10) || 0;
  }

  /**
   * Crea el swap efímero de 2 GB. Idempotente: si ya está activo, no hace
   * nada y devuelve ok. Si hay un archivo huérfano (existe pero no está
   * activo), lo borra primero. Programa el hombre muerto de systemd ANTES
   * de nada que pueda fallar a medio camino, para no depender de que el
   * propio proceso llegue a terminar la creación.
   */
  async function crearSwapEfimero(quien = "agente") {
    if (await swapActivo()) {
      return { ok: true, ya_activo: true, mensaje: "Ya había un swap temporal activo" };
    }

    // Autolimpieza de un huérfano de una corrida anterior (ver comentario de arriba).
    await sh(`rm -f ${RUTA_SWAP}`);

    const libres = await espacioLibreRaiz();
    if (libres < ESPACIO_LIBRE_MINIMO_BYTES) {
      auditar("swap_efimero", quien, "rechazado", `solo ${Math.round(libres / 1048576)} MB libres`);
      return { ok: false, mensaje: "No hay espacio suficiente en disco para el swap temporal (se necesitan al menos 3 GB libres)" };
    }

    // Reversión programada primero: si algo falla en los pasos siguientes,
    // el temporizador de systemd de todas formas intentará apagar/borrar
    // (son comandos inocuos si el swap nunca llegó a activarse).
    await sh(
      `systemd-run --on-active=${HOMBRE_MUERTO_SWAP_SEGUNDOS}s --unit=${UNIDAD_HOMBRE_MUERTO_SWAP} ` +
      `/bin/bash -lc 'swapoff ${RUTA_SWAP} 2>/dev/null; rm -f ${RUTA_SWAP}'`
    );

    const r = await sh(
      `fallocate -l ${TAMANO_SWAP} ${RUTA_SWAP} && chmod 600 ${RUTA_SWAP} && mkswap ${RUTA_SWAP} && swapon ${RUTA_SWAP} ` +
      `|| (rm -f ${RUTA_SWAP}; exit 1)`,
      30000
    );

    if (!r.ok) {
      // La creación falló: cancelamos el hombre muerto (ya no hay nada que revertir)
      // y dejamos constancia. El archivo, si quedó, ya se borró en el `||` de arriba.
      await sh(`systemctl stop ${UNIDAD_HOMBRE_MUERTO_SWAP}.timer 2>/dev/null; systemctl reset-failed '${UNIDAD_HOMBRE_MUERTO_SWAP}*' 2>/dev/null`);
      auditar("swap_efimero", quien, "falló", r.error.slice(0, 200));
      return { ok: false, mensaje: "No se pudo crear el swap temporal" };
    }

    auditar("swap_efimero", quien, "creado", `${TAMANO_SWAP}, hombre muerto en ${HOMBRE_MUERTO_SWAP_SEGUNDOS}s`);
    return { ok: true, ya_activo: false, mensaje: `Swap temporal de ${TAMANO_SWAP} activado por hasta ${Math.round(HOMBRE_MUERTO_SWAP_SEGUNDOS / 60)} minutos` };
  }

  /**
   * Quita el swap efímero y cancela el hombre muerto. Idempotente: seguro
   * de llamar aunque no haya swap activo o el archivo no exista.
   */
  async function quitarSwapEfimero(quien = "agente") {
    await sh(`swapoff ${RUTA_SWAP} 2>/dev/null; rm -f ${RUTA_SWAP}`);
    await sh(`systemctl stop ${UNIDAD_HOMBRE_MUERTO_SWAP}.timer 2>/dev/null; systemctl reset-failed '${UNIDAD_HOMBRE_MUERTO_SWAP}*' 2>/dev/null`);
    auditar("swap_efimero", quien, "quitado", "");
    return { ok: true, mensaje: "Swap temporal retirado" };
  }

  // ── 3.2 Defensa perimetral (solo aviso) ─────────────────────────────────
  //
  // Limitación real: el CLOUDFLARE_API_TOKEN disponible solo tiene permisos
  // de Workers Scripts:Editar, KV:Editar y Cuenta:Leer — NO tiene permiso de
  // Zona, que es el que exige la API para cambiar `security_level` a
  // "under_attack". Por eso hoy esto es SOLO un aviso al dueño con
  // instrucciones claras; no se activa nada por API.
  //
  // Camino de automatización futura (no implementado, documentado en
  // INTEGRACION-RESILIENCIA.md): añadir al token el permiso
  // "Zona → Configuración de zona: Editar" (+ "Zona → Zona: Leer") sobre la
  // zona del dominio, y un endpoint nuevo en el Worker que haga
  // PATCH /zones/<id>/settings/security_level.

  const RUTA_AVISO_PERIMETRAL = deps.DIR_DATOS ? path.join(deps.DIR_DATOS, "aviso-perimetral.json") : null;
  const HORAS_ENTRE_AVISOS = 6; // no repetir el mismo aviso más de una vez cada 6 horas

  function leerUltimoAvisoPerimetral() {
    if (!RUTA_AVISO_PERIMETRAL || typeof deps.leerJson !== "function") return { ts: 0 };
    return deps.leerJson(RUTA_AVISO_PERIMETRAL, { ts: 0 });
  }

  function guardarUltimoAvisoPerimetral(obj) {
    if (!RUTA_AVISO_PERIMETRAL || typeof deps.guardarJson !== "function") return;
    deps.guardarJson(RUTA_AVISO_PERIMETRAL, obj);
  }

  /**
   * Regla simple sobre señales que YA calcula `prediccion()`: pico sostenido
   * de CPU + carga alta, sin que haya una causa interna conocida en curso
   * (`opts.enVentanaExcluida` — el llamador la marca en true durante un
   * respaldo, una optimización o un simulacro, para no autoalarmarse).
   *
   * No hace nada por su cuenta: hay que llamarla desde el ciclo periódico
   * de ops-server.js (ver INTEGRACION-RESILIENCIA.md).
   */
  async function revisarDefensaPerimetral(opts = {}) {
    if (typeof deps.leerCpu !== "function" || typeof enviarWhatsapp !== "function") {
      return { activado: false, motivo: "faltan dependencias (leerCpu/enviarWhatsapp)" };
    }
    if (opts.enVentanaExcluida) return { activado: false, motivo: "ventana excluida (respaldo/optimización/simulacro en curso)" };

    const cpu = deps.leerCpu();
    // Umbrales conservadores para 2 vCPU: CPU sostenida muy alta + carga que
    // ya supera claramente el número de núcleos (síntoma de saturación por
    // tráfico, no de un pico normal de un momento).
    const sospechoso = cpu.pct >= 90 && cpu.carga >= 3.5;
    if (!sospechoso) return { activado: false, motivo: "sin señales de tráfico anómalo" };

    const ultimo = leerUltimoAvisoPerimetral();
    if (Date.now() - (ultimo.ts || 0) < HORAS_ENTRE_AVISOS * 3600000) {
      return { activado: false, motivo: "aviso reciente, no se repite todavía" };
    }

    const texto =
      `Posible tráfico anómalo en el servidor\n\n` +
      `El procesador está muy exigido (${cpu.pct} % de uso, carga ${cpu.carga.toFixed(1)}) ` +
      `sin que haya un respaldo, una optimización o una prueba en curso.\n\n` +
      `Esto puede ser mucho tráfico legítimo o un ataque. Zeus no puede activar por sí solo ` +
      `el modo de protección de Cloudflare (le falta ese permiso), así que si sigue así unos minutos, ` +
      `conviene que entres al panel de Cloudflare y actives "Estoy bajo ataque" (I'm Under Attack Mode) ` +
      `en la pestaña de seguridad del dominio.\n\npanel.ejemplo.com`;

    const r = await enviarWhatsapp(texto);
    guardarUltimoAvisoPerimetral({ ts: Date.now() });
    auditar("aviso_perimetral", "agente", r.ok ? "enviado" : "falló", `cpu ${cpu.pct}% carga ${cpu.carga}`);
    return { activado: true, enviado: r.ok };
  }

  // ── 3.3 Paquete de evidencia de memoria (variante viable, sin tocar el bot) ─
  //
  // Un heap snapshot real exige modificar el bot (inspector de Node o una
  // ruta que llame a v8.writeHeapSnapshot). Eso queda fuera de esta fase.
  // Camino futuro documentado: arrancar el bot con `--report-on-signal` (o
  // una ruta oculta con `v8.writeHeapSnapshot` a un volumen), para pedir un
  // snapshot real por señal/HTTP local. Requiere una línea en el arranque
  // del bot — pendiente coordinado, no implementado aquí.

  const CONTENEDOR_BOT_DEFECTO = "zeus-bot";
  const RUTA_EVIDENCIA_MEMORIA = deps.DIR_DATOS ? path.join(deps.DIR_DATOS, "evidencia-memoria.json") : null;

  /** Arma el paquete crudo (sin IA todavía) desde fuera del contenedor. */
  async function armarPaqueteEvidenciaMemoria(contenedor = CONTENEDOR_BOT_DEFECTO) {
    const [stats, status, fds] = await Promise.all([
      sh(`docker stats --no-stream --format '{{.MemUsage}};{{.MemPerc}}' ${contenedor}`, 10000),
      sh(`docker exec ${contenedor} cat /proc/1/status 2>/dev/null | grep -E 'VmRSS|VmHWM|Threads'`, 8000),
      sh(`docker exec ${contenedor} sh -c 'ls /proc/1/fd 2>/dev/null | wc -l'`, 8000),
    ]);
    const [memUso, memPct] = (stats.salida || "").split(";");
    const serieRam = typeof deps.leerHistorialRam === "function" ? deps.leerHistorialRam(6) : [];

    return {
      contenedor,
      docker_stats: { memoria: (memUso || "").trim(), porcentaje: (memPct || "").trim() },
      proceso_interno: status.salida || "sin datos (¿docker exec falló?)",
      descriptores_abiertos: parseInt((fds.salida || "0").trim(), 10) || 0,
      ram_ultimas_horas: serieRam, // [{t, ram}], ya lo guarda Centinela en su historial
      ts: new Date().toISOString(),
    };
  }

  /**
   * Si la tendencia de RAM (misma regresión lineal que usa `prediccion()`)
   * es agresiva y NO va a quedar cortada por el reinicio diario de las 4:00,
   * arma el paquete de evidencia y le pide a Gemini hipótesis. Respeta el
   * presupuesto diario de consultas a la IA si `deps.registrarConsultaIA`
   * se pasó (ver INTEGRACION-RESILIENCIA.md).
   */
  async function quizaArmarPaqueteEvidencia() {
    if (typeof deps.prediccion !== "function" || typeof deps.preguntarAGemini !== "function") {
      return { generado: false, motivo: "faltan dependencias (prediccion/preguntarAGemini)" };
    }
    const pred = await deps.prediccion();
    const pRam = (pred.pronosticos || []).find((p) => p.recurso === "Memoria");
    if (!pRam || pRam.nivel !== "crit" || pRam.cortado) {
      return { generado: false, motivo: "la tendencia de memoria no es lo bastante agresiva, o el reinicio diario la corta antes" };
    }

    if (typeof deps.registrarConsultaIA === "function") {
      const gasto = deps.registrarConsultaIA();
      if (!gasto.permitido) {
        auditar("evidencia_memoria", "agente", "límite_diario", "sin cupo de consultas a la IA hoy");
        return { generado: false, motivo: "se agotaron las consultas a la IA de hoy" };
      }
    }

    const paquete = await armarPaqueteEvidenciaMemoria();
    const contextoExtra = typeof deps.armarContextoCentinela === "function" ? await deps.armarContextoCentinela() : {};
    const persona =
      "Eres Centinela, el asistente técnico que vigila este servidor. Te dan evidencia recogida DESDE FUERA " +
      "de un contenedor (no hay acceso al código del bot ni a un volcado de memoria real). Da como máximo 3 " +
      "hipótesis breves y concretas de por qué la memoria sube (por ejemplo: hilos que no se cierran, descriptores " +
      "de archivo sin liberar, RSS que no baja tras el trabajo). Responde en español claro, sin tecnicismos innecesarios, " +
      "y deja explícito que es un diagnóstico aproximado, no un volcado de memoria real.";
    const pregunta =
      "La memoria viene subiendo de forma más agresiva de lo normal y hoy no se va a corregir sola con el " +
      "reinicio de las 4 a.m. Con esta evidencia recogida desde fuera del contenedor, ¿qué hipótesis manejarías?";

    const diagnostico = await deps.preguntarAGemini(persona, { ...paquete, servidor: contextoExtra }, pregunta);

    if (RUTA_EVIDENCIA_MEMORIA && typeof deps.guardarJson === "function") {
      deps.guardarJson(RUTA_EVIDENCIA_MEMORIA, { paquete, diagnostico, ts: new Date().toISOString() });
    }
    auditar("evidencia_memoria", "agente", "generado", "paquete + diagnóstico de IA");

    if (typeof enviarWhatsapp === "function") {
      await enviarWhatsapp(
        `Aviso: la memoria del bot viene subiendo rápido\n\n${diagnostico}\n\npanel.ejemplo.com`
      ).catch(() => {});
    }

    return { generado: true, paquete, diagnostico };
  }

  return {
    crearSwapEfimero,
    quitarSwapEfimero,
    revisarDefensaPerimetral,
    armarPaqueteEvidenciaMemoria,
    quizaArmarPaqueteEvidencia,
  };
}

module.exports = { crearResiliencia };
