"use strict";
/**
 * modulos/sos/puede-actuar.js
 *
 * Punto único de decisión: ¿puede el SOS ejecutar este peldaño POR SU CUENTA
 * ahora mismo? Antes de este módulo, esto se decidía en dos sitios separados
 * de sos.js con sus propios mensajes: `evaluarSeguridadAutonoma` (freno,
 * permisos, horario comercial) y `chequearLimiteYVentanas` (ventanas
 * sensibles y límites duros de limites.js). Diseño de Fable 5.1, 12-sep-2026.
 *
 * Orden de las comprobaciones (de lo absoluto a lo que se resuelve solo con
 * el tiempo):
 *   0. contenedor ajeno   — prohibición absoluta, sin interruptor
 *   1. freno de emergencia — voluntad explícita del dueño, gana siempre
 *   2. permisos            — configuración persistente del dueño
 *   3. horario comercial   — solo reiniciar_servidor / reiniciar_docker
 *   4. ventana sensible    — respaldo o reinicio diario a punto de correr
 *   5. límites duros        — presupuesto/enfriamiento/autobloqueo (limites.js)
 *
 * No sustituye a `limites.js` (los contadores persistentes siguen viviendo
 * ahí) ni a `reglas-seguridad.js`/`permisos.js` (los interruptores del dueño
 * siguen viviendo ahí) — este módulo es el único que conoce a los cuatro y
 * en qué orden se consultan para un peldaño del SOS.
 */

function crearPuedeActuar({
  limites,
  reglasSeguridad = null,
  permisos = null,
  contenedoresPropios,
  categoriaPorPeldano,
  horaReinicioUtc,
  horaRespaldoUtc,
  ahora = () => Date.now(), // inyectable para pruebas de horario/ventanas
}) {
  if (!limites) throw new Error("crearPuedeActuar necesita 'limites'");
  if (!contenedoresPropios) throw new Error("crearPuedeActuar necesita 'contenedoresPropios'");
  if (!categoriaPorPeldano) throw new Error("crearPuedeActuar necesita 'categoriaPorPeldano'");

  const NOMBRES_PELDANO = {
    liberar_disco: "liberar espacio en disco",
    reiniciar_contenedor: "reiniciar el servicio",
    reiniciar_en_orden: "reiniciar los servicios",
    esperar_respaldo: "esperar el respaldo",
    deshacer_despliegue: "deshacer el último despliegue",
    reiniciar_docker: "reiniciar Docker completo",
    reiniciar_servidor: "reiniciar todo el servidor",
  };
  const describir = (peldano) => NOMBRES_PELDANO[peldano] || peldano;

  function minutosHasta(horaUtc) {
    const hoy = new Date(ahora());
    const obj = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth(), hoy.getUTCDate(), horaUtc, 0, 0));
    if (obj < hoy) obj.setUTCDate(obj.getUTCDate() + 1);
    return (obj - hoy) / 60000;
  }

  /** Igual que la `dentroDeVentanaSensible` que ya vivía en sos.js. */
  function ventanaSensible() {
    const mResp = minutosHasta(horaRespaldoUtc);
    const mReinicio = minutosHasta(horaReinicioUtc);
    if (mResp < 20) return `Faltan ${Math.round(mResp)} minuto(s) para el respaldo diario.`;
    if (mReinicio < 20) return `Faltan ${Math.round(mReinicio)} minuto(s) para el reinicio diario del servidor.`;
    return null;
  }

  function mensajeLimite(chk) {
    switch (chk.codigo) {
      case "tope_hora": return "ya lo reinicié varias veces en la última hora — reiniciarlo otra vez no ataca la causa real.";
      case "tope_dia": return "ya se usó el máximo permitido hoy.";
      case "tope_incidente": return "ya se usó para este mismo problema.";
      case "enfriamiento": return `ya se hizo hace poco; me doy un tiempo mínimo entre una vez y otra (faltan ${chk.minutos} minutos).`;
      case "autobloqueo": return "ya se disparó antes y quedó bloqueado hasta que una persona lo permita de nuevo.";
      default: return chk.motivo || "hay un límite de seguridad activo.";
    }
  }

  function sugerenciaLimite(codigo) {
    switch (codigo) {
      case "autobloqueo": return 'Sección SOS del panel, botón "Permitir".';
      case "tope_hora":
      case "tope_dia":
      case "tope_incidente": return "Hace falta que una persona revise qué lo está tumbando.";
      case "enfriamiento": return "Si crees que hace falta antes de tiempo, hazlo tú desde el panel.";
      default: return "Una persona debe intervenir o desbloquear la acción desde el panel.";
    }
  }

  /**
   * @param {{peldano:string, objetivo?:string|string[]}} paso
   * @param {{incidenteSosId?:string|null, S?:object|null, diag?:object|null}} ctx
   * @returns {{ok:true}|{ok:false, fuente:string, motivo:string, mensaje:string, sugerencia:string}}
   */
  function puedeActuar(paso, ctx = {}) {
    const { peldano } = paso;
    const objetivos = Array.isArray(paso.objetivo) ? paso.objetivo : (paso.objetivo ? [paso.objetivo] : []);
    const diag = ctx.diag || null;
    const S = ctx.S || null;
    const accion = describir(peldano);

    // 0 — contenedor ajeno (defensa en profundidad; prohibición absoluta, sin interruptor)
    if (peldano === "reiniciar_contenedor" || peldano === "reiniciar_en_orden") {
      const ajeno = objetivos.find((n) => !contenedoresPropios.includes(n));
      if (ajeno) {
        return {
          ok: false, fuente: "ajeno",
          motivo: `${ajeno} no es de este negocio; no lo toco.`,
          mensaje: `No toqué ${ajeno}: no es de este negocio y nunca lo reinicio sola.`,
          sugerencia: "Avísale a quien administra ese servicio.",
        };
      }
    }

    // 1 — freno de emergencia (voluntad explícita del dueño, gana siempre)
    if (reglasSeguridad && reglasSeguridad.frenoActivo()) {
      return {
        ok: false, fuente: "freno",
        motivo: "El freno de emergencia está activo.",
        mensaje: `No hice "${accion}": el freno de emergencia está puesto. Mientras esté puesto solo diagnostico y aviso.`,
        sugerencia: "Quita el freno en Permisos para que vuelva a reparar sola, o hazlo tú manualmente desde el panel.",
      };
    }

    // 2 — permisos por categoría + permiso general del "Protocolo SOS completo"
    const categoria = categoriaPorPeldano[peldano];
    if (permisos && categoria) {
      const chequeo = permisos.verificarEscritura(categoria, categoria);
      if (!chequeo.ok) {
        return {
          ok: false, fuente: "permisos",
          motivo: chequeo.mensaje,
          mensaje: `No hice "${accion}": en Permisos está apagado que Centinela toque "${categoria}" por su cuenta.`,
          sugerencia: `Enciéndelo en Permisos → ${categoria}, o hazlo tú desde el panel.`,
        };
      }
    }
    if (permisos && !permisos.permitido("sos", "escritura")) {
      return {
        ok: false, fuente: "permisos",
        motivo: 'El "Protocolo SOS completo" tiene la escritura desactivada en Permisos.',
        mensaje: `No hice "${accion}": el "Protocolo SOS completo" tiene apagada la reparación automática en Permisos.`,
        sugerencia: "Enciéndelo en Permisos, o repara tú desde el panel.",
      };
    }

    // 3 — horario comercial: solo los dos pasos más disruptivos, y solo si el
    // bot sigue atendiendo de alguna forma (caída total ignora el horario).
    if ((peldano === "reiniciar_servidor" || peldano === "reiniciar_docker") && reglasSeguridad && reglasSeguridad.enHorarioComercial()) {
      // "Caída total" = los clientes ya no reciben respuesta. `afecta_clientes`
      // lo calcula diagnostico.js para TODOS los síntomas (bot_caido,
      // bot_no_responde, puerta_caida, …), así que cubre también el caso en
      // que el contenedor sigue "running" pero no atiende — "encendido no es
      // atendiendo". "parcial" (p. ej. lento) cuenta como que aún atiende: se
      // espera. El estado del contenedor queda como respaldo si no hay diag.
      const botCaido = !!(S && S.contenedores && S.contenedores["zeus-bot"] && S.contenedores["zeus-bot"].estado !== "running");
      const cayoTotal = (diag && diag.afecta_clientes === "si") || botCaido;
      if (!cayoTotal) {
        return {
          ok: false, fuente: "horario",
          motivo: "Es horario comercial y el bot sigue atendiendo.",
          mensaje: `No hice "${accion}": es horario de atención y el bot sigue respondiendo, así que prefiero no cortar el servicio a los clientes.`,
          sugerencia: "Si de verdad hace falta ahora, hazlo tú desde el panel; si no, vuelve a lanzar el SOS después de que termine la jornada.",
        };
      }
    }

    // 4 — ventana sensible (respaldo / reinicio diario a punto de correr) —
    // solo los 3 peldaños de alto impacto, igual que antes en chequearLimiteYVentanas.
    if (peldano === "reiniciar_docker" || peldano === "deshacer_despliegue" || peldano === "reiniciar_servidor") {
      const ventana = ventanaSensible();
      if (ventana) {
        return {
          ok: false, fuente: "ventana",
          motivo: ventana,
          mensaje: `No hice "${accion}": ${ventana}`,
          sugerencia: "Lanza el SOS otra vez cuando pase esa ventana.",
        };
      }
      if (S && S.respaldoEnCurso) {
        return {
          ok: false, fuente: "ventana",
          motivo: "Hay un respaldo en curso.",
          mensaje: `No hice "${accion}": hay un respaldo en curso y no quiero interrumpirlo.`,
          sugerencia: "Lanza el SOS otra vez cuando termine el respaldo.",
        };
      }
    }

    // 5 — límites duros persistentes (presupuesto/enfriamiento/autobloqueo)
    let chequeoLimite = { ok: true };
    if (peldano === "reiniciar_contenedor") {
      chequeoLimite = limites.puede("reiniciar_contenedor", { objetivo: objetivos[0] });
    } else if (peldano === "reiniciar_en_orden") {
      // Antes no se consultaba aquí — no dolía mientras solo era el peldaño
      // primario de disco lleno; ahora también puede llegar como escalada
      // (CLAUDE.md paso 6), así que cada contenedor de la lista respeta el
      // mismo tope por hora/día que un reinicio individual.
      for (const n of objetivos) {
        const c = limites.puede("reiniciar_contenedor", { objetivo: n });
        if (!c.ok) { chequeoLimite = c; break; }
      }
    } else if (peldano === "liberar_disco") {
      chequeoLimite = limites.puede("liberar_disco", { incidenteId: ctx.incidenteSosId });
    } else if (peldano === "reiniciar_docker" || peldano === "deshacer_despliegue" || peldano === "reiniciar_servidor") {
      chequeoLimite = limites.puede(peldano, { incidenteId: ctx.incidenteSosId, objetivo: objetivos[0] });
    }
    if (!chequeoLimite.ok) {
      return {
        ok: false, fuente: "limite",
        motivo: chequeoLimite.motivo,
        mensaje: `No hice "${accion}": ${mensajeLimite(chequeoLimite)}`,
        sugerencia: sugerenciaLimite(chequeoLimite.codigo),
      };
    }

    return { ok: true };
  }

  return { puedeActuar };
}

module.exports = { crearPuedeActuar };
