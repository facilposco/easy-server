"use strict";
/**
 * modulos/sos/escalada.js
 *
 * Qué peldaño sigue cuando el SOS agota su plan sin resolver el síntoma
 * (CLAUDE.md pasos 6→7→8: reiniciar en orden de dependencia → deshacer el
 * despliegue si aplica → reiniciar el servidor completo, como último
 * recurso). Antes esto vivía directo en `decidirEscaladaFinal` (sos.js) y
 * saltaba los pasos 6 y 7 sin más — el código nunca cumplió lo que dice
 * CLAUDE.md. Función pura, sin E/S, para poder probarla sin tocar el
 * servidor real. Diseño de Fable 5.1, 12-sep-2026.
 */

const { UMBRALES } = require("./diagnostico.js");

const ORDEN_REINICIO = ["zeus-mariadb", "zeus-chromadb", "zeus-bot", "zeus-proxy"];
const CANDIDATOS = new Set(["docker_colgado", "memoria_agotada", "bd_caida", "puerta_caida", "bot_caido", "bot_no_responde"]);
// "en_bucle" no se reinicia aquí (ya lo maneja Docker); "lento" todavía atiende.
const REINICIABLES = new Set(["caido", "no_responde"]);

/** Contenedores que esta corrida ya reinició de una forma u otra. */
function contenedoresYaReiniciados(acciones) {
  const out = new Set();
  for (const a of acciones || []) {
    if (a.peldano === "reiniciar_contenedor" || a.peldano === "reiniciar_en_orden") {
      for (const n of String(a.objetivo || "").split(",")) if (n) out.add(n);
    } else if (a.peldano === "esperar_respaldo") {
      out.add("zeus-mariadb");
    } else if (a.peldano === "deshacer_despliegue") {
      out.add("zeus-bot");
    }
  }
  return out;
}

/**
 * Siguiente peldaño tras agotar el plan sin éxito.
 * @returns {null | {peldano:string, objetivo?:string[]} | {detener:true, motivo:string, sugerencia:string}}
 */
function siguientePeldano({ diag, S, acciones, presupuestoAgotado }) {
  if (presupuestoAgotado) return null;
  if (!diag || diag.afecta_clientes !== "si") return null;
  if (!CANDIDATOS.has(diag.sintoma_principal)) return null;
  if (diag.sintoma_principal === "bd_caida") return null; // §5.5.6: nunca se insiste sobre la BD

  const yaProbo = (p) => (acciones || []).some((a) => a.peldano === p);
  if (yaProbo("reiniciar_servidor")) return null;

  if (diag.sintoma_principal === "docker_colgado") {
    return yaProbo("reiniciar_docker") ? { peldano: "reiniciar_servidor" } : null;
  }

  const reiniciados = contenedoresYaReiniciados(acciones);
  const clasif = diag.clasificacion || {};

  // Paso 6 — reiniciar en orden de dependencia, solo lo que de verdad no atiende.
  if (!yaProbo("reiniciar_en_orden")) {
    const noAtienden = ORDEN_REINICIO.filter((n) => REINICIABLES.has(clasif[n]));
    if (noAtienden.includes("zeus-mariadb") && reiniciados.has("zeus-mariadb")) {
      return {
        detener: true,
        motivo: "La base de datos no volvió después de reiniciarla y no la voy a tocar más para no dañar datos.",
        sugerencia: "Revisa el registro guardado (últimas líneas de la base) o pide a tu técnico que la revise.",
      };
    }
    if (noAtienden.length && noAtienden.some((n) => !reiniciados.has(n))) {
      return { peldano: "reiniciar_en_orden", objetivo: noAtienden };
    }
  }

  // Paso 7 — deshacer el despliegue: solo si falla el bot y se desplegó hace poco.
  const d = S && S.despliegue;
  const reciente = !!(d && d.objetivo && d.creadoHaceMs != null && d.creadoHaceMs <= UMBRALES.ventanaDespliegueAmplia);
  if (!yaProbo("deshacer_despliegue") && diag.culpable === "zeus-bot" && reciente) {
    return { peldano: "deshacer_despliegue" };
  }

  // Paso 8 — último recurso.
  return { peldano: "reiniciar_servidor" };
}

module.exports = { siguientePeldano, contenedoresYaReiniciados, ORDEN_REINICIO };
