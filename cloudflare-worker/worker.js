/**
 * VIGILANTE EXTERNO - Cloudflare Worker
 * ======================================
 *
 * Que hace: revisa cada minuto si el servidor principal (panel.ejemplo.com)
 * y el bot de WhatsApp (bot.ejemplo.com/dashboard) responden bien. Si alguno
 * deja de responder (o responde con error) durante varias revisiones seguidas,
 * manda UN aviso por WhatsApp. Cuando el servicio vuelve, manda un aviso de
 * recuperacion con cuanto tiempo estuvo caido.
 *
 * Por que existe: si el servidor muere por completo, cualquier monitoreo que
 * viva DENTRO del servidor muere con el. Este vigilante corre en la red de
 * Cloudflare, totalmente separado, y por eso puede avisar aunque el servidor
 * este completamente apagado.
 *
 * Diseno del guardado de estado (KV):
 *   Se guarda un solo documento JSON bajo la clave "estado" con la info de
 *   los dos objetivos vigilados. Solo se reescribe en KV cuando algo REALMENTE
 *   cambia (empieza una caida, se alcanza el umbral de avisos, se manda un
 *   aviso, o se recupera). Mientras un objetivo esta sano, o mientras sigue
 *   caido y ya se aviso una vez, NO se vuelve a escribir en KV. Esto es
 *   intencional: el plan gratuito de Cloudflare KV permite 1000 escrituras
 *   por dia, y el cron corre 1440 veces al dia (cada minuto). Si se escribiera
 *   en cada ejecucion nos pasariamos del limite gratuito. Con este diseno,
 *   en un dia normal (todo sano) el numero de escrituras es CERO.
 *
 * Anti-bucle de avisos:
 *   - Un aviso de "caido" se manda una sola vez por episodio (se marca
 *     avisoEnviado = true y no se vuelve a mandar hasta que se recupera).
 *   - Si el envio a Kapso falla, se reintenta con espera entre intentos
 *     (ESPERA_REINTENTO_MIN) y un tope maximo de intentos (MAX_INTENTOS_AVISO).
 *     Agotados los intentos, el Worker se rinde y sigue funcionando con
 *     normalidad (no se queda reintentando para siempre).
 */

// ---------------------------------------------------------------------------
// Utilidades generales
// ---------------------------------------------------------------------------

/** Hace un fetch pero lo cancela si tarda mas de "milisegundos". */
async function fetchConTiempoLimite(url, opciones, milisegundos) {
  const controlador = new AbortController();
  const temporizador = setTimeout(() => controlador.abort(), milisegundos);
  try {
    return await fetch(url, { ...opciones, signal: controlador.signal });
  } finally {
    clearTimeout(temporizador);
  }
}

/** Convierte milisegundos en un texto legible en espanol, ej: "2 horas y 5 minutos". */
function formatearDuracion(ms) {
  const totalMinutos = Math.max(0, Math.round(ms / 60000));
  const horas = Math.floor(totalMinutos / 60);
  const minutos = totalMinutos % 60;
  if (horas === 0) return `${minutos} minuto${minutos === 1 ? '' : 's'}`;
  if (minutos === 0) return `${horas} hora${horas === 1 ? '' : 's'}`;
  return `${horas} hora${horas === 1 ? '' : 's'} y ${minutos} minuto${minutos === 1 ? '' : 's'}`;
}

/**
 * Las plantillas de WhatsApp no aceptan saltos de linea ni espacios raros.
 * Esta funcion limpia el texto para que la plantilla "centinela_zeus" no
 * sea rechazada por Meta.
 */
function limpiarParaPlantilla(texto) {
  return String(texto || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 300);
}

// ---------------------------------------------------------------------------
// Revision de los dos objetivos
// ---------------------------------------------------------------------------

/**
 * Revisa el servidor principal (con autenticacion basica) y su endpoint
 * /health. Devuelve {ok:true} si todo esta bien, o {ok:false, tipo, detalle}
 * distinguiendo entre "sin_respuesta" (no contesto nada) y "error_http" /
 * "error_contenido" (contesto pero mal).
 */
async function revisarServidorPrincipal(env) {
  const credenciales = btoa(`${env.PANEL_USUARIO}:${env.PANEL_CLAVE}`);
  try {
    const resp = await fetchConTiempoLimite(
      env.URL_SERVIDOR,
      { headers: { Authorization: `Basic ${credenciales}` } },
      Number(env.TIEMPO_ESPERA_MS)
    );
    if (!resp.ok) {
      return { ok: false, tipo: 'error_http', detalle: `codigo HTTP ${resp.status}` };
    }
    let datos;
    try {
      datos = await resp.json();
    } catch (e) {
      return { ok: false, tipo: 'error_contenido', detalle: 'la respuesta no es JSON valido' };
    }
    if (datos && datos.ok === true) {
      return { ok: true };
    }
    return { ok: false, tipo: 'error_contenido', detalle: 'el JSON no reporta ok:true' };
  } catch (err) {
    // fetch lanza excepcion cuando hay timeout, DNS caido, conexion rechazada, etc.
    // Es decir: el servidor NO respondio en absoluto.
    return { ok: false, tipo: 'sin_respuesta', detalle: (err && err.message) || 'sin respuesta' };
  }
}

/**
 * Revisa el dashboard del bot de WhatsApp. No usa autenticacion basica
 * (es una pagina web normal), solo comprueba que conteste con un codigo
 * HTTP correcto.
 */
async function revisarDashboard(env) {
  try {
    const resp = await fetchConTiempoLimite(env.URL_DASHBOARD, {}, Number(env.TIEMPO_ESPERA_MS));
    if (!resp.ok) {
      return { ok: false, tipo: 'error_http', detalle: `codigo HTTP ${resp.status}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, tipo: 'sin_respuesta', detalle: (err && err.message) || 'sin respuesta' };
  }
}

/**
 * Calcula el HMAC-SHA256 de un texto usando la Web Crypto API (no el modulo
 * "crypto" de Node, que no existe en el runtime de Cloudflare Workers).
 * Devuelve el resultado en hexadecimal minuscula, el mismo formato que
 * produce `crypto.createHmac('sha256', secreto).update(texto).digest('hex')`
 * en Node, que es como el bot valida la firma de los webhooks entrantes.
 */
async function calcularHmacHex(secreto, textoPlano) {
  const codificador = new TextEncoder();
  const clave = await crypto.subtle.importKey(
    'raw',
    codificador.encode(secreto),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const firma = await crypto.subtle.sign('HMAC', clave, codificador.encode(textoPlano));
  return Array.from(new Uint8Array(firma))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Monitoreo sintetico: manda un webhook falso (pero firmado, como uno real)
 * al endpoint del bot que SI procesa mensajes de WhatsApp
 * (https://app.ejemplo.com/webhook/kapso), para detectar el caso en que
 * el bot esta "vivo" (el dashboard responde) pero colgado sin poder atender
 * webhooks de verdad.
 *
 * El cuerpo es deliberadamente inocuo: event_type "centinela.sintetico" (NO
 * "whatsapp.message.received") y SIN campo "message". Asi el bot nunca lo
 * confunde con un mensaje real de un cliente: valida la firma, responde 200,
 * lo registra en su log, y no dispara ninguna logica de IA ni respuesta real
 * de WhatsApp (ver README/CLAUDE.md del bot para el detalle de ese filtro).
 */
async function revisarWebhookSintetico(env) {
  try {
    const cuerpo = JSON.stringify({ event_type: 'centinela.sintetico', ts: Date.now() });
    const firma = await calcularHmacHex(env.KAPSO_WEBHOOK_SECRET, cuerpo);
    const resp = await fetchConTiempoLimite(
      env.URL_WEBHOOK_SINTETICO,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Webhook-Signature': firma },
        body: cuerpo,
      },
      9000
    );
    if (!resp.ok) {
      return { ok: false, tipo: 'error_http', detalle: `codigo HTTP ${resp.status}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, tipo: 'sin_respuesta', detalle: (err && err.message) || 'sin respuesta' };
  }
}

// ---------------------------------------------------------------------------
// Envio de avisos por WhatsApp (via Kapso)
// ---------------------------------------------------------------------------

/**
 * Manda un mensaje usando la plantilla aprobada "centinela_zeus". Se usa
 * SIEMPRE una plantilla (nunca texto libre) porque el Worker manda avisos
 * por su cuenta, sin que el dueno haya escrito antes por WhatsApp, y fuera
 * de la ventana de 24 horas de Meta un mensaje de texto libre simplemente
 * no se entregaria. Con plantilla, el aviso llega siempre.
 *
 * Nunca lanza una excepcion hacia afuera: si algo falla, devuelve false y
 * deja el registro en los logs. Asi el que llama decide como reintentar,
 * sin que un error de red aqui rompa el resto del vigilante.
 */
/** Manda un cuerpo ya armado a Kapso. Devuelve {ok, detalle}.
 * Kapso puede responder 200 con un error de Meta dentro del JSON, asi que no
 * basta con mirar el codigo HTTP: hay que revisar tambien el cuerpo. */
async function enviarAKapso(env, cuerpo) {
  const resp = await fetchConTiempoLimite(
    `https://api.kapso.ai/meta/whatsapp/v24.0/${env.KAPSO_PHONE_NUMBER_ID}/messages`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': env.KAPSO_API_KEY },
      body: JSON.stringify(cuerpo),
    },
    Number(env.TIEMPO_ESPERA_MS)
  );
  const texto = await resp.text().catch(() => '');
  if (!resp.ok || /"error"/.test(texto)) {
    return { ok: false, detalle: `HTTP ${resp.status}: ${texto.slice(0, 300)}` };
  }
  return { ok: true, detalle: '' };
}

/**
 * Avisa por WhatsApp. Intenta PRIMERO como texto normal y solo si Meta lo
 * rechaza recurre a la plantilla.
 *
 * Por que en ese orden: el texto normal solo funciona si hay una conversacion
 * abierta (ventana de 24 horas), pero ese es el caso habitual, porque el dueno
 * le escribe al bot a menudo. La plantilla, en cambio, depende de que Meta la
 * tenga aprobada, y hoy NO lo esta (probado: "Template name does not exist").
 * Ir directo a la plantilla, como se hacia antes, significaba que el vigilante
 * no podia avisar nunca. Con este orden avisa siempre que haya ventana abierta,
 * y queda listo para usar la plantilla en cuanto Meta la apruebe.
 */
async function intentarNotificar(env, textoParametro) {
  try {
    const directo = await enviarAKapso(env, {
      messaging_product: 'whatsapp',
      to: env.WHATSAPP_DESTINO,
      type: 'text',
      text: { body: textoParametro },
    });
    if (directo.ok) return true;
    console.error(`Kapso rechazo el texto normal, se intenta con plantilla. ${directo.detalle}`);

    const conPlantilla = await enviarAKapso(env, {
      messaging_product: 'whatsapp',
      to: env.WHATSAPP_DESTINO,
      type: 'template',
      template: {
        name: env.NOMBRE_PLANTILLA || 'centinela_zeus',
        language: { code: 'es' },
        components: [
          { type: 'body', parameters: [{ type: 'text', text: limpiarParaPlantilla(textoParametro) }] },
        ],
      },
    });
    if (conPlantilla.ok) return true;
    console.error(`Kapso tampoco acepto la plantilla. ${conPlantilla.detalle}`);
    return false;
  } catch (err) {
    console.error('No se pudo enviar el aviso por WhatsApp:', (err && err.message) || err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Estado guardado en KV
// ---------------------------------------------------------------------------

function estadoInicialObjetivo() {
  return {
    fallosSeguidos: 0,
    avisoEnviado: false,
    caidoDesde: null, // marca de tiempo (ms) de la primera falla del episodio actual
    intentosAviso: 0,
    ultimoIntentoAviso: null,
  };
}

async function leerEstado(env) {
  const crudo = await env.VIGILANTE_KV.get('estado');
  if (!crudo) {
    return {
      servidor: estadoInicialObjetivo(),
      dashboard: estadoInicialObjetivo(),
      sintetico: estadoInicialObjetivo(),
    };
  }
  try {
    const datos = JSON.parse(crudo);
    return {
      servidor: { ...estadoInicialObjetivo(), ...(datos.servidor || {}) },
      dashboard: { ...estadoInicialObjetivo(), ...(datos.dashboard || {}) },
      sintetico: { ...estadoInicialObjetivo(), ...(datos.sintetico || {}) },
    };
  } catch (e) {
    // Si el JSON guardado esta corrupto por alguna razon, se arranca de cero
    // en vez de romper el vigilante.
    return {
      servidor: estadoInicialObjetivo(),
      dashboard: estadoInicialObjetivo(),
      sintetico: estadoInicialObjetivo(),
    };
  }
}

async function guardarEstado(env, estado) {
  await env.VIGILANTE_KV.put('estado', JSON.stringify(estado));
}

// ---------------------------------------------------------------------------
// Logica principal: decide si hay que avisar, y actualiza el estado
// ---------------------------------------------------------------------------

/**
 * Procesa el resultado de una revision para UN objetivo (servidor o
 * dashboard) contra su estado anterior. Devuelve el nuevo estado y si algo
 * cambio de verdad (para decidir si vale la pena escribir en KV).
 */
async function procesarObjetivo(nombreVisible, resultado, subEstadoAnterior, env) {
  const ahora = Date.now();
  const umbral = Number(env.UMBRAL_FALLOS);
  const maxIntentos = Number(env.MAX_INTENTOS_AVISO);
  const esperaReintentoMs = Number(env.ESPERA_REINTENTO_MIN) * 60 * 1000;
  const nuevo = { ...subEstadoAnterior };

  // ----- Caso: la revision salio BIEN -----
  if (resultado.ok) {
    if (nuevo.avisoEnviado) {
      // Estaba caido y ya habiamos avisado -> ahora toca avisar que se recupero.
      const duracionMs = ahora - (nuevo.caidoDesde || ahora);
      await intentarNotificar(
        env,
        `RECUPERADO: ${nombreVisible} volvio a responder con normalidad. Estuvo caido ${formatearDuracion(duracionMs)}.`
      );
      return { estado: estadoInicialObjetivo(), cambio: true };
    }
    if (nuevo.fallosSeguidos !== 0 || nuevo.caidoDesde !== null) {
      // Hubo fallas sueltas que nunca llegaron al umbral (ej. un timeout
      // aislado). No se avisa nada: es justamente lo que evita falsas
      // alarmas. Se reinicia el contador en silencio.
      return { estado: estadoInicialObjetivo(), cambio: true };
    }
    // Todo normal, nada que cambiar, nada que escribir en KV.
    return { estado: nuevo, cambio: false };
  }

  // ----- Caso: la revision salio MAL -----
  let cambio = false;

  if (nuevo.fallosSeguidos === 0) {
    nuevo.caidoDesde = ahora;
    cambio = true;
  }
  if (nuevo.fallosSeguidos < umbral) {
    nuevo.fallosSeguidos += 1;
    cambio = true;
  }
  // Nota: una vez fallosSeguidos llega al umbral, se deja de incrementar a
  // proposito. Asi, mientras el servicio siga caido y el aviso ya se haya
  // mandado, el objeto de estado no vuelve a cambiar y no se vuelve a
  // escribir en KV cada minuto (ver comentario grande al inicio del archivo).

  if (nuevo.fallosSeguidos >= umbral && !nuevo.avisoEnviado) {
    const puedeIntentarAhora =
      !nuevo.ultimoIntentoAviso || ahora - nuevo.ultimoIntentoAviso >= esperaReintentoMs;

    if (puedeIntentarAhora) {
      if (nuevo.intentosAviso >= maxIntentos) {
        // Se agotaron los intentos de avisar (Kapso debe estar fallando).
        // Nos rendimos para esta caida: se marca como "avisado" igual, para
        // que el Worker no se quede reintentando en bucle para siempre.
        // Cuando el servicio se recupere, igual se mandara el aviso de
        // recuperacion (con la duracion real), asi que el dueno se entera
        // aunque tarde.
        console.error(
          `Se agotaron los ${maxIntentos} intentos de aviso para "${nombreVisible}". Se deja de intentar para esta caida.`
        );
        nuevo.avisoEnviado = true;
        cambio = true;
      } else {
        const tipoTexto =
          resultado.tipo === 'sin_respuesta' ? 'no responde en absoluto' : 'responde pero con error';
        const mensaje =
          `ALERTA: ${nombreVisible} ${tipoTexto} desde hace ` +
          `${formatearDuracion(ahora - nuevo.caidoDesde)}. Detalle: ${resultado.detalle || 'sin detalle'}.`;

        const enviado = await intentarNotificar(env, mensaje);
        nuevo.ultimoIntentoAviso = ahora;
        nuevo.intentosAviso += 1;
        if (enviado) {
          nuevo.avisoEnviado = true;
        }
        cambio = true;
      }
    }
  }

  return { estado: nuevo, cambio };
}

// El monitoreo sintetico usa un umbral FIJO de 2 fallos seguidos (no el
// UMBRAL_FALLOS configurable de servidor/dashboard): la consigna es no
// avisar al primer fallo (para no generar falsa alarma por una red lenta
// puntual), pero tampoco esperar tanto como para el servidor/dashboard,
// porque un bot colgado sin caerse es mas dificil de notar por otras vias.
const UMBRAL_FALLOS_SINTETICO = 2;

/**
 * Version simplificada de `procesarObjetivo` para el webhook sintetico: no
 * hace falta el mensaje de "RECUPERADO" con duracion (no es un objetivo que
 * el dueno vigile por su cuenta como panel.ejemplo.com), solo el aviso de
 * alerta cuando se cruza el umbral. Reutiliza `intentarNotificar` (la misma
 * funcion de WhatsApp que usa el resto del vigilante).
 */
async function procesarSintetico(resultado, subEstadoAnterior, env) {
  const nuevo = { ...subEstadoAnterior };

  if (resultado.ok) {
    if (nuevo.fallosSeguidos !== 0 || nuevo.avisoEnviado) {
      // Se recupero (o hubo un fallo suelto que no llego al umbral):
      // se reinicia el contador en silencio, sin avisos de recuperacion.
      return { estado: estadoInicialObjetivo(), cambio: true };
    }
    return { estado: nuevo, cambio: false };
  }

  let cambio = false;
  if (nuevo.fallosSeguidos < UMBRAL_FALLOS_SINTETICO) {
    nuevo.fallosSeguidos += 1;
    cambio = true;
  }

  if (nuevo.fallosSeguidos >= UMBRAL_FALLOS_SINTETICO && !nuevo.avisoEnviado) {
    const enviado = await intentarNotificar(
      env,
      'El bot no esta respondiendo a los mensajes de WhatsApp (aunque el ' +
        'servidor si responde). Puede que el bot este colgado sin caerse. ' +
        'Revisa el panel: panel.ejemplo.com'
    );
    if (enviado) {
      nuevo.avisoEnviado = true;
      cambio = true;
    }
  }

  return { estado: nuevo, cambio };
}

/** Corre una ronda completa: revisa los dos objetivos y guarda el estado si hizo falta. */
async function ejecutarVigilancia(env) {
  const estadoCompleto = await leerEstado(env);

  const resultadoServidor = await revisarServidorPrincipal(env);
  const resultadoDashboard = await revisarDashboard(env);
  let resultadoSintetico;
  try {
    resultadoSintetico = await revisarWebhookSintetico(env);
  } catch (err) {
    // Nunca dejar que una excepcion aqui tumbe el resto del cron.
    resultadoSintetico = { ok: false, tipo: 'sin_respuesta', detalle: (err && err.message) || 'error inesperado' };
  }

  const procServidor = await procesarObjetivo(
    'El servidor principal de Zeus Ops (panel.ejemplo.com)',
    resultadoServidor,
    estadoCompleto.servidor,
    env
  );
  const procDashboard = await procesarObjetivo(
    'El bot de WhatsApp del negocio (bot.ejemplo.com/dashboard)',
    resultadoDashboard,
    estadoCompleto.dashboard,
    env
  );
  const procSintetico = await procesarSintetico(resultadoSintetico, estadoCompleto.sintetico, env);

  if (procServidor.cambio || procDashboard.cambio || procSintetico.cambio) {
    await guardarEstado(env, {
      servidor: procServidor.estado,
      dashboard: procDashboard.estado,
      sintetico: procSintetico.estado,
    });
  }

  return {
    servidor: { resultado: resultadoServidor, estado: procServidor.estado },
    dashboard: { resultado: resultadoDashboard, estado: procDashboard.estado },
    sintetico: { resultado: resultadoSintetico, estado: procSintetico.estado },
  };
}

// ---------------------------------------------------------------------------
// Punto de entrada del Worker
// ---------------------------------------------------------------------------

/** Compara el token de la URL contra el secreto TOKEN_PRUEBA, para que los
 * endpoints de prueba no queden abiertos a cualquiera en internet. */
function tokenValido(url, env) {
  const recibido = url.searchParams.get('token');
  return Boolean(env.TOKEN_PRUEBA) && recibido === env.TOKEN_PRUEBA;
}

/**
 * Reenvia una consulta a Gemini (Google AI Studio) sin pasar por la IP del
 * servidor de Linode: la API de Gemini en su capa gratuita rechaza llamadas
 * desde IPs de proveedores de servidores (mensaje "User location is not
 * supported"), pero SI acepta llamadas desde la red de Cloudflare. El cuerpo
 * de la peticion (modelo, prompt, contexto) lo arma el servidor como siempre;
 * este Worker solo la reenvia usando su propia llave (GEMINI_API_KEY, guardada
 * como secreto aqui) y la devuelve tal cual. Protegido con un secreto propio
 * (PROXY_SECRETO) para que nadie mas use la llave a traves de este Worker.
 */
/**
 * Lista de llaves de Gemini a rotar. `GEMINI_API_KEYS` (plural) es un secret
 * nuevo con varias llaves separadas por coma; si no existe, cae a la unica
 * `GEMINI_API_KEY` de siempre (compatibilidad con lo que ya habia).
 */
function listaLlavesGemini(env) {
  if (env.GEMINI_API_KEYS) {
    return env.GEMINI_API_KEYS.split(',').map((k) => k.trim()).filter(Boolean);
  }
  return env.GEMINI_API_KEY ? [env.GEMINI_API_KEY] : [];
}

async function proxyGemini(peticion, env) {
  if (peticion.method !== 'POST') {
    return new Response('Metodo no permitido', { status: 405 });
  }
  const secretoRecibido = peticion.headers.get('X-Proxy-Secreto');
  if (!env.PROXY_SECRETO || secretoRecibido !== env.PROXY_SECRETO) {
    return new Response('No autorizado', { status: 401 });
  }
  const llaves = listaLlavesGemini(env);
  if (!llaves.length) {
    return new Response(JSON.stringify({ error: { message: 'Worker sin GEMINI_API_KEY(S) configurada' } }), {
      status: 500,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }

  const url = new URL(peticion.url);
  const modelo = url.searchParams.get('modelo') || 'gemini-2.5-flash';
  const cuerpo = await peticion.text();

  // Prueba cada llave en orden; si una esta agotada (429) o rechazada (403),
  // pasa a la siguiente en vez de devolver el error al instante. Solo se
  // reintenta con la SIGUIENTE llave ante esos dos codigos especificos: un
  // error de la propia peticion (400 por payload, 5xx de Google) no se
  // arregla cambiando de llave, asi que se devuelve tal cual.
  let ultimaRespuesta = null;
  for (let i = 0; i < llaves.length; i++) {
    try {
      const respuesta = await fetchConTiempoLimite(
        `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${encodeURIComponent(llaves[i])}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: cuerpo },
        20000
      );
      if ((respuesta.status === 429 || respuesta.status === 403) && i < llaves.length - 1) {
        ultimaRespuesta = respuesta;
        continue; // esta llave esta agotada o bloqueada: prueba la siguiente
      }
      const texto = await respuesta.text();
      return new Response(texto, {
        status: respuesta.status,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Llave-Usada': String(i + 1) },
      });
    } catch (e) {
      if (i < llaves.length - 1) continue; // fallo de red con esta llave: prueba la siguiente
      return new Response(JSON.stringify({ error: { message: `Fallo al contactar Gemini: ${e.message}` } }), {
        status: 502,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    }
  }
  // Todas las llaves devolvieron 429/403: se devuelve la ultima respuesta tal cual.
  const texto = ultimaRespuesta ? await ultimaRespuesta.text() : JSON.stringify({ error: { message: 'Todas las llaves de Gemini estan agotadas' } });
  return new Response(texto, {
    status: ultimaRespuesta ? ultimaRespuesta.status : 429,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

export default {
  // Se ejecuta solo, cada minuto, segun el cron definido en wrangler.toml.
  async scheduled(evento, env, ctx) {
    ctx.waitUntil(
      ejecutarVigilancia(env).catch((error) => {
        console.error('Error en la ejecucion programada del vigilante:', error);
      })
    );
  },

  // Endpoints manuales, solo para pruebas humanas (ver README.md).
  async fetch(peticion, env, ctx) {
    const url = new URL(peticion.url);

    if (url.pathname === '/estado') {
      if (!tokenValido(url, env)) return new Response('No autorizado', { status: 401 });
      const estado = await leerEstado(env);
      return new Response(JSON.stringify(estado, null, 2), {
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    }

    if (url.pathname === '/probar') {
      if (!tokenValido(url, env)) return new Response('No autorizado', { status: 401 });
      const resultado = await ejecutarVigilancia(env);
      return new Response(JSON.stringify(resultado, null, 2), {
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    }

    if (url.pathname === '/gemini-proxy') {
      return proxyGemini(peticion, env);
    }

    if (url.pathname === '/probar-whatsapp') {
      if (!tokenValido(url, env)) return new Response('No autorizado', { status: 401 });
      const enviado = await intentarNotificar(
        env,
        'Prueba manual del vigilante: si ves este mensaje en WhatsApp, la conexion con Kapso funciona bien.'
      );
      return new Response(
        enviado
          ? 'Mensaje de prueba enviado. Revisa el WhatsApp del numero configurado.'
          : 'No se pudo enviar el mensaje de prueba. Revisa los secretos KAPSO_API_KEY y KAPSO_PHONE_NUMBER_ID, y que la plantilla centinela_zeus este aprobada.',
        { status: enviado ? 200 : 500 }
      );
    }

    return new Response(
      'Vigilante Zeus activo. Revisa el servidor y el dashboard cada minuto, en segundo plano.',
      { status: 200 }
    );
  },
};
