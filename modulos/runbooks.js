"use strict";
/**
 * Centinela Zeus — módulo de runbooks guiados (DISENO-FASE-CAOS.md §4, fila #5).
 *
 * Adaptación deliberada: el documento original habla de "runbooks
 * autónomos". Aquí se implementan GUIADOS, no autónomos, porque la
 * autonomía total contradice la filosofía del proyecto (el dueño aprueba
 * las acciones de riesgo; la única acción autónoma que existe hoy es el
 * único auto-reinicio de `revisarIncidentes` en ops-server.js).
 *
 * Un runbook es una cadena de pasos, cada uno una acción YA existente y ya
 * aprobada en la lista blanca de `ejecutarAccion` de ops-server.js. Este
 * módulo NO ejecuta nada: solo describe las cadenas. El panel las muestra,
 * el dueño las dispara con un clic, y el propio panel llama al endpoint que
 * YA existe (`POST /api/accion`, con su mismo anti-CSRF y su misma
 * auditoría) una vez por paso, en orden. No se agrega ningún endpoint de
 * ejecución nuevo: eso mantiene la superficie de ataque igual a la de hoy.
 *
 * Aislado a propósito: no se conecta a nada, no se ejecuta solo. Otro
 * ingeniero decide cuándo conectarlo (ver INTEGRACION-RESILIENCIA.md).
 */

// Espejo EXACTO del switch de `ejecutarAccion` en ops-server.js (verificado
// leyendo el archivo completo). Si algún día se agrega o se quita una acción
// allá, hay que actualizar esta lista aquí también: `validar()` (más abajo)
// existe justamente para detectar ese desfase antes de que llegue al panel.
const ACCIONES_VALIDAS = [
  "reiniciar_contenedor",
  "optimizar",
  "respaldar",
  "enviar_wsp",
  "desbanear",
  "actualizar_seguridad",
  "reiniciar_servidor",
  "limpiar_docker",
];

/**
 * Catálogo declarativo. Cada runbook trae los pasos en orden; cada paso es
 * literalmente el cuerpo que el panel debe mandar a `POST /api/accion`
 * (`{ accion, objetivo }`), más metadatos para mostrarlo en claro.
 *
 * `objetivo_fijo: false` marca un paso que necesita que el dueño escriba un
 * valor (por ejemplo una dirección IP) antes de disparar ese paso — en ese
 * caso `objetivo` es `null` y el panel debe pedirlo. Ningún runbook de este
 * catálogo lo usa hoy (se dejó fuera "desbanear" precisamente por eso: pedir
 * una IP a mitad de una cadena de un clic no encaja con "guiado, un clic";
 * desbanear una IP puntual ya tiene su propio botón en la sección Seguridad).
 *
 * `reiniciar_servidor` tampoco aparece en ningún runbook: ya exige su propia
 * confirmación escrita ("REINICIAR") como objetivo, y es una acción tan
 * grande que no debe quedar escondida dentro de una cadena de un clic.
 */
const CATALOGO = [
  {
    id: "bot_no_responde",
    titulo: "El bot de WhatsApp no responde o está lento",
    impacto: "bajo",
    cuando_usarlo: "El bot dejó de contestar mensajes, o tarda mucho, y ya se revisó que no es un problema de la base de datos.",
    pasos: [
      { orden: 1, etiqueta: "Reiniciar el bot", accion: "reiniciar_contenedor", objetivo: "zeus-bot", objetivo_fijo: true, nota: "Corta y retoma las conversaciones en curso; tarda unos segundos." },
      { orden: 2, etiqueta: "Avisar por WhatsApp que ya se revisó", accion: "enviar_wsp", objetivo: "", objetivo_fijo: true, nota: "Manda el resumen actual del servidor para confirmar que todo quedó bien." },
    ],
  },
  {
    id: "memoria_busqueda_caida",
    titulo: "La memoria de búsqueda del bot (ChromaDB) falló",
    impacto: "medio",
    cuando_usarlo: "El bot responde raro o dice no encontrar información que sí debería tener, y ChromaDB aparece caído o enfermo en el panel.",
    pasos: [
      { orden: 1, etiqueta: "Reiniciar la memoria de búsqueda", accion: "reiniciar_contenedor", objetivo: "zeus-chromadb", objetivo_fijo: true, nota: "" },
      { orden: 2, etiqueta: "Reiniciar el bot para que reconecte", accion: "reiniciar_contenedor", objetivo: "zeus-bot", objetivo_fijo: true, nota: "El bot guarda la conexión en memoria; si no se reinicia, puede seguir apuntando a la conexión vieja." },
      { orden: 3, etiqueta: "Avisar por WhatsApp que ya se revisó", accion: "enviar_wsp", objetivo: "", objetivo_fijo: true, nota: "" },
    ],
  },
  {
    id: "base_datos_no_responde",
    titulo: "La base de datos no responde",
    impacto: "alto",
    cuando_usarlo: "El panel muestra la base de datos caída o el bot no puede consultar ventas/clientes.",
    pasos: [
      { orden: 1, etiqueta: "Reiniciar la base de datos", accion: "reiniciar_contenedor", objetivo: "zeus-mariadb", objetivo_fijo: true, nota: "Puede tardar más que los demás servicios en volver a estar lista." },
      { orden: 2, etiqueta: "Reiniciar el bot para que reconecte", accion: "reiniciar_contenedor", objetivo: "zeus-bot", objetivo_fijo: true, nota: "" },
      { orden: 3, etiqueta: "Avisar por WhatsApp que ya se revisó", accion: "enviar_wsp", objetivo: "", objetivo_fijo: true, nota: "" },
    ],
  },
  {
    id: "puerta_entrada_caida",
    titulo: "La puerta de entrada (Traefik) no responde",
    impacto: "alto",
    cuando_usarlo: "Ni el panel ni el bot son alcanzables desde afuera, pero el servidor sigue prendido (se puede entrar por SSH).",
    pasos: [
      { orden: 1, etiqueta: "Reiniciar la puerta de entrada", accion: "reiniciar_contenedor", objetivo: "zeus-proxy", objetivo_fijo: true, nota: "Corta el acceso web unos segundos mientras vuelve a arrancar." },
      { orden: 2, etiqueta: "Avisar por WhatsApp que ya se revisó", accion: "enviar_wsp", objetivo: "", objetivo_fijo: true, nota: "" },
    ],
  },
  {
    id: "servidor_lento_disco",
    titulo: "El servidor va lento o el disco se está llenando",
    impacto: "bajo",
    cuando_usarlo: "El disco aparece en amarillo o rojo, o todo se siente lento sin que ningún servicio esté caído.",
    pasos: [
      { orden: 1, etiqueta: "Limpiar sobras de despliegues, imágenes y registros", accion: "optimizar", objetivo: "", objetivo_fijo: true, nota: "No borra datos del negocio; libera espacio de cosas viejas." },
      { orden: 2, etiqueta: "Limpieza adicional de Docker", accion: "limpiar_docker", objetivo: "", objetivo_fijo: true, nota: "" },
      { orden: 3, etiqueta: "Avisar por WhatsApp cuánto se liberó", accion: "enviar_wsp", objetivo: "", objetivo_fijo: true, nota: "" },
    ],
  },
  {
    id: "aplicar_parches_seguridad",
    titulo: "Hay actualizaciones de seguridad pendientes",
    impacto: "medio",
    cuando_usarlo: "La sección Seguridad avisa actualizaciones pendientes y se quiere aplicarlas ya, en vez de esperar al mantenimiento automático.",
    pasos: [
      { orden: 1, etiqueta: "Aplicar actualizaciones de seguridad", accion: "actualizar_seguridad", objetivo: "", objetivo_fijo: true, nota: "Puede tardar varios minutos; no reinicia el servidor por sí sola." },
      { orden: 2, etiqueta: "Avisar por WhatsApp que ya se aplicaron", accion: "enviar_wsp", objetivo: "", objetivo_fijo: true, nota: "" },
    ],
  },
];

/**
 * Comprueba que todo paso de todo runbook use una acción de la lista
 * blanca. No se ejecuta sola: quien integra este módulo puede llamarla una
 * vez al arrancar `ops-server.js` y solo registrar un aviso en consola/
 * auditoría si algo no cuadra (nunca debe tumbar el servicio por esto).
 *
 * @param {string[]} [accionesPermitidas] lista real vigente en ejecutarAccion;
 *   si no se pasa, se compara contra la copia local ACCIONES_VALIDAS.
 */
function validar(accionesPermitidas) {
  const permitidas = new Set(accionesPermitidas && accionesPermitidas.length ? accionesPermitidas : ACCIONES_VALIDAS);
  const problemas = [];
  for (const rb of CATALOGO) {
    for (const paso of rb.pasos) {
      if (!permitidas.has(paso.accion)) {
        problemas.push(`Runbook "${rb.id}", paso ${paso.orden}: la acción "${paso.accion}" no está en la lista blanca`);
      }
    }
  }
  return { ok: problemas.length === 0, problemas };
}

function crearRunbooks(deps) {
  const accionesPermitidas = (deps && deps.accionesPermitidas) || ACCIONES_VALIDAS;

  function catalogo() {
    return CATALOGO;
  }

  return {
    catalogo,
    validar: () => validar(accionesPermitidas),
  };
}

module.exports = { crearRunbooks, ACCIONES_VALIDAS, CATALOGO, validar };
