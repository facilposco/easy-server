"use strict";
/**
 * modulos/sos/textos.js
 *
 * Todo texto visible para el dueño del negocio sale de aquí (regla P9 y P11
 * de DISENO-SOS.md): mismo texto en el panel y en WhatsApp, sin jerga de
 * Linux. Funciones puras.
 */

const NOMBRES_CLAROS = {
  "zeus-bot": "el bot de WhatsApp",
  "zeus-mariadb": "la base de datos",
  "zeus-chromadb": "la memoria de búsqueda del bot",
  "zeus-proxy": "la puerta de entrada",
  "otro-proyecto-a": "Otro proyecto A (ejemplo)",
  "otro-proyecto-b": "Otro proyecto B (ejemplo)",
  "otro-proyecto-c": "Otro proyecto C (ejemplo)",
};

function nombreClaro(nombre) {
  return NOMBRES_CLAROS[nombre] || nombre || "un servicio";
}

const TITULOS_SINTOMA = {
  simulacro_en_curso: "Hay un simulacro en curso",
  no_diagnosticable: "No pude leer el estado del servidor",
  docker_colgado: "El sistema que arranca los servicios no responde",
  disco_lleno: "El disco está lleno",
  memoria_agotada: "El servidor se quedó sin memoria",
  cpu_saturada: "El procesador está saturado",
  falla_tras_despliegue: "Se rompió justo después de subir una versión nueva",
  bd_caida: "La base de datos no responde",
  busqueda_caida: "La memoria de búsqueda del bot falló",
  puerta_caida: "La puerta de entrada no responde",
  bot_caido: "El bot de WhatsApp está caído",
  bot_no_responde: "El bot de WhatsApp está encendido pero no atiende",
  contenedor_en_bucle: "Un servicio se está apagando y encendiendo solo",
  servidor_lento: "El servidor está lento",
  ajeno_con_problema: "Es de otro proyecto",
  todo_bien: "Todo está funcionando",
};

function tituloSintoma(sintoma) {
  return TITULOS_SINTOMA[sintoma] || "Se detectó un problema";
}

/** "hace 4 minutos" / "hace 2 horas" a partir de una fecha ISO. */
function haceTexto(iso) {
  if (!iso) return "hace un momento";
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.round(ms / 60000);
  if (min <= 0) return "hace un momento";
  if (min < 60) return `hace ${min} minuto${min === 1 ? "" : "s"}`;
  const horas = Math.round(min / 60);
  return `hace ${horas} hora${horas === 1 ? "" : "s"}`;
}

/** Hora de Colombia (UTC-5), formato "2:03 p. m." */
function horaColombia(iso) {
  const d = iso ? new Date(iso) : new Date();
  const local = new Date(d.getTime() - 5 * 3600 * 1000);
  let h = local.getUTCHours();
  const m = local.getUTCMinutes();
  const ampm = h >= 12 ? "p. m." : "a. m.";
  h = h % 12; if (h === 0) h = 12;
  return `${h}:${String(m).padStart(2, "0")} ${ampm}`;
}

const NOMBRES_PELDANO = {
  liberar_disco: "Liberar espacio en el disco",
  reiniciar_contenedor: "Reiniciar",
  reiniciar_en_orden: "Reiniciar los servicios en orden",
  deshacer_despliegue: "Volver a la versión anterior",
  reiniciar_docker: "Reiniciar el sistema de contenedores",
  reiniciar_servidor: "Reiniciar el servidor completo",
  esperar_respaldo: "Esperar a que termine la copia de seguridad",
};

function describirAccion(accion) {
  const base = NOMBRES_PELDANO[accion.peldano] || accion.peldano;
  const obj = accion.objetivo ? ` ${nombreClaro(accion.objetivo)}` : "";
  return `${base}${obj}`.trim();
}

/** Línea de una acción ya ejecutada, para el mensaje final y el reporte. */
function lineaAccion(accion, indice) {
  const estado = accion.ok ? "Listo" : "No funcionó";
  const seg = accion.verificacion && accion.verificacion.segundos != null ? ` en ${accion.verificacion.segundos} s` : "";
  return `${indice}. ${describirAccion(accion)}. ${estado}${seg}.`;
}

/**
 * Construye el mensaje final de una corrida (mismo texto para WhatsApp y
 * panel — P9). `corrida` es una línea de sos-corridas.jsonl.
 */
function mensajeFinal(corrida) {
  const emoji = corrida.resultado === "restablecido" || corrida.resultado === "sin_falla" ? "🟢"
    : corrida.resultado === "parcial" ? "🟡" : "🔴";
  const tituloResultado = {
    sin_falla: "sin novedad",
    restablecido: "restablecido",
    parcial: "parcial",
    detenido_pide_ayuda: "necesito una persona",
    no_diagnosticable: "no pude revisar el servidor",
    reinicio_servidor_en_curso: "reiniciando el servidor",
  }[corrida.resultado] || corrida.resultado;

  const lineas = [`${emoji} SOS terminado: ${tituloResultado}`, ""];

  if (corrida.resultado === "sin_falla") {
    lineas.push("Revisé todo y no encontré nada que reparar.");
  } else if (corrida.diagnostico) {
    lineas.push(`Qué encontré: ${corrida.diagnostico}`);
    if (corrida.afecta_clientes) {
      const impacto = { si: "sí estaban afectados.", parcial: "afectados en parte.", no: "no estaban afectados.", desconocido: "no pude confirmarlo." }[corrida.afecta_clientes] || "";
      lineas.push(`Clientes: ${impacto}`);
    }
  }

  if (corrida.acciones && corrida.acciones.length) {
    lineas.push("", "Qué hice:");
    corrida.acciones.forEach((a, i) => lineas.push(lineaAccion(a, i + 1)));
  }

  if (corrida.resultado === "detenido_pide_ayuda" && corrida.motivo_detencion) {
    lineas.push("", `Por qué me detuve: ${corrida.motivo_detencion}`);
    if (corrida.sugerencia) lineas.push(`Qué haría una persona: ${corrida.sugerencia}`);
  } else if (corrida.en_bucle && corrida.sugerencia) {
    // El repetido restableció el servicio esta vez, pero ya van 3+ caídas
    // del mismo en la última hora — vale la pena avisarlo aunque el SOS
    // haya "tenido éxito" reparándolo otra vez.
    lineas.push("", `⚠️ ${corrida.sugerencia}`);
  }

  if (corrida.ia && corrida.ia.usada) {
    lineas.push("", "Hay hipótesis de la IA en el panel.");
  }

  if (corrida.evidencia_id) {
    lineas.push("", `Todo el detalle está en panel.ejemplo.com → Registros (registro ${corrida.evidencia_id}).`);
  }

  return lineas.join("\n");
}

/** Línea de consola en vivo (una línea de terminal, en español claro). */
function lineaConsola(texto) {
  return String(texto || "").replace(/\s+/g, " ").trim();
}

/** Reporte completo de una corrida (texto plano, para /api/sos/corridas/<id>?formato=texto). */
function reporteCorrida(corrida) {
  const partes = [mensajeFinal(corrida)];
  if (corrida.acciones && corrida.acciones.length) {
    partes.push("", "Detalle de verificaciones:");
    for (const a of corrida.acciones) {
      const v = a.verificacion || {};
      partes.push(`- ${describirAccion(a)}: ${v.detalle || (v.ok ? "verificado" : "sin verificar")}`);
    }
  }
  return partes.join("\n");
}

module.exports = {
  NOMBRES_CLAROS, nombreClaro, tituloSintoma, haceTexto, horaColombia,
  describirAccion, lineaAccion, mensajeFinal, lineaConsola, reporteCorrida,
};
