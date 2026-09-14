"use strict";
/**
 * Centinela Zeus — explicación de hallazgos con IA.
 *
 * Para los hallazgos que Centinela NO sabe reparar sola (SSH, cortafuegos,
 * usuarios sin contraseña, dependencias del bot, docker corriendo como
 * root, memoria/crecimiento cuando hace falta editar docker-compose.yml) el
 * panel solo ofrecía "copiar para tu técnico" con el texto genérico de la
 * auditoría — un dueño sin técnico se queda sin poder avanzar. Esta función
 * usa Gemini para redactar algo específico al hallazgo real: qué significa,
 * qué tan urgente es, y qué pasos seguiría alguien para arreglarlo.
 *
 * Misma regla de todo el proyecto (ver CLAUDE.md / arquitectura.html): la
 * IA solo redacta, nunca decide ni ejecuta. Esta función no toca el
 * servidor, no genera un comando para aplicar, y el prompt de sistema le
 * prohíbe explícitamente insinuar que Centinela lo va a hacer sola.
 */

async function explicarHallazgo(preguntarAGemini, registrarConsultaIA, hallazgo) {
  if (typeof preguntarAGemini !== "function" || typeof registrarConsultaIA !== "function") {
    throw new Error("explicarHallazgo necesita preguntarAGemini y registrarConsultaIA de ops-server.js");
  }
  if (!hallazgo || !hallazgo.titulo) {
    return { ok: false, mensaje: "Falta el hallazgo a explicar" };
  }
  const chequeo = registrarConsultaIA();
  if (!chequeo.permitido) {
    return { ok: false, mensaje: chequeo.motivo || "Se acabaron las consultas de IA de hoy. Vuelve a intentarlo mañana." };
  }
  const systemPrompt =
    "Eres un ingeniero de servidores senior explicándole un hallazgo técnico al dueño de un negocio sin " +
    "conocimientos de servidores. Responde en español de Colombia, en 3 a 5 líneas, sin tecnicismos sin " +
    "explicar. Estructura la respuesta en: (1) qué significa esto en la práctica, (2) qué tan urgente es de " +
    "verdad, (3) qué pasos seguiría un técnico para arreglarlo. Nunca digas que tú o Centinela van a aplicar " +
    "el cambio — Centinela no ejecuta esto automáticamente, solo está ayudando a entenderlo. No inventes " +
    "datos que no estén en el hallazgo.";
  const contexto = {
    hallazgo: {
      titulo: hallazgo.titulo,
      significado: hallazgo.significado || "",
      detalle: hallazgo.detalle || "",
    },
  };
  const texto = await preguntarAGemini(systemPrompt, contexto, "Explica este hallazgo de la auditoría del servidor.", { maxOutputTokens: 500 });
  return { ok: true, texto };
}

module.exports = { explicarHallazgo };
