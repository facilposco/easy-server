# El Worker de Cloudflare: vigilante externo y proxy de IA

Todo lo que corre **dentro** del servidor muere con él. Si el VPS se apaga, se queda sin red o Docker se cuelga, ningún monitor instalado ahí puede avisar. Por eso Centinela tiene una pieza pequeña que vive **fuera**, en la red de Cloudflare, en el plan gratuito: `cloudflare-worker/worker.js`.

Hace dos cosas que no podrían hacerse desde el servidor:

| Función | Por qué fuera del servidor |
|---|---|
| **Vigilante externo** (cron cada minuto) | Sigue avisando por WhatsApp aunque el servidor esté completamente apagado. |
| **Proxy de Gemini** (`/gemini-proxy`) | La capa gratuita de Gemini rechaza llamadas desde IPs de proveedores de VPS ("User location is not supported"). Desde la red de Cloudflare sí acepta. Además la llave real de Gemini vive solo aquí, como secreto, nunca en el servidor. |

## Cómo funciona el vigilante, paso a paso

Cada minuto (`crons = ["* * * * *"]` en `wrangler.toml`) se ejecuta `scheduled()` → `ejecutarVigilancia(env)`:

1. **Lee el estado anterior** de KV (`leerEstado`): cuántos fallos seguidos lleva cada objetivo, si ya se avisó, desde cuándo está caído.
2. **Revisa tres objetivos**, cada uno con su propia función:
   - `revisarServidorPrincipal`: pide `URL_SERVIDOR` (el `/health` del panel, con autenticación básica) y exige que responda `{"ok":true}`. Distingue **"sin respuesta"** (no contestó nada: apagado, sin red, timeout) de **"error HTTP / contenido"** (contestó pero mal).
   - `revisarDashboard`: pide `URL_DASHBOARD` (una página del bot) y solo exige un código HTTP correcto.
   - `revisarWebhookSintetico`: manda al bot un webhook **firmado como uno real** (HMAC-SHA256 con `KAPSO_WEBHOOK_SECRET`, calculado con la Web Crypto API porque en Workers no existe el módulo `crypto` de Node) pero **inocuo**: `event_type: "centinela.sintetico"`, sin campo `message`. Detecta el caso más traicionero: el bot "vivo" (el dashboard responde) pero colgado sin poder atender mensajes.
3. **Decide si avisar** (`procesarObjetivo` / `procesarSintetico`):
   - Solo avisa tras `UMBRAL_FALLOS` fallos seguidos (3 por defecto = 3 minutos). Un tropiezo aislado no genera nada.
   - Avisa **una sola vez** por episodio (`avisoEnviado = true`) y se calla hasta que el servicio vuelva.
   - Al recuperarse manda un segundo mensaje con **cuánto tiempo estuvo caído**.
   - Si WhatsApp falla al avisar, reintenta cada `ESPERA_REINTENTO_MIN` minutos hasta `MAX_INTENTOS_AVISO` veces, y después se rinde para esa caída (nunca se queda en bucle).
4. **Escribe en KV solo si algo cambió.** El plan gratuito de KV permite 1.000 escrituras al día y el cron corre 1.440 veces: escribir en cada corrida se pasaría del límite. Con este diseño, en un día sin incidentes las escrituras son **cero**.

## Cómo avisa (`intentarNotificar`)

Primero intenta un mensaje de texto normal por la API de WhatsApp Business (funciona si hay una conversación abierta en las últimas 24 horas, que es lo habitual porque el dueño le escribe al bot a menudo). Si Meta lo rechaza, recurre a la **plantilla** aprobada (`NOMBRE_PLANTILLA`, por defecto `centinela_zeus`), que sí llega fuera de la ventana de 24 horas. `limpiarParaPlantilla` quita saltos de línea, que Meta no acepta en plantillas.

El código de referencia habla con **Kapso** (`enviarAKapso`). Para usar otro proveedor (Twilio, 360dialog, Meta directo) solo hay que reescribir esa función: recibe un cuerpo ya armado y devuelve `{ ok, detalle }`. Ojo con un detalle real: Kapso puede responder HTTP 200 con un error de Meta dentro del JSON, por eso se revisa también el cuerpo.

## El proxy de Gemini (`proxyGemini`)

`POST /gemini-proxy?modelo=gemini-2.5-flash`, con el header `X-Proxy-Secreto` igual al secreto `PROXY_SECRETO`. El cuerpo (prompt, contexto, `generationConfig`) lo arma el servidor; el Worker solo lo reenvía a `generativelanguage.googleapis.com` con su propia llave y devuelve la respuesta tal cual.

Soporta **varias llaves en rotación** (`GEMINI_API_KEYS`, separadas por coma): si una devuelve 429 (cuota agotada) o 403 (bloqueada), prueba la siguiente. Un 400 (petición mal armada) o un 5xx de Google se devuelven sin rotar, porque cambiar de llave no los arregla. El header de respuesta `X-Llave-Usada` dice cuál atendió.

## Endpoints manuales (solo para probar, protegidos con `TOKEN_PRUEBA`)

| Ruta | Qué hace |
|---|---|
| `/probar-whatsapp?token=…` | Manda un mensaje de prueba. La prueba más importante: confirma proveedor y plantilla. |
| `/probar?token=…` | Corre una ronda de vigilancia ahora mismo y devuelve el resultado en JSON. |
| `/estado?token=…` | Devuelve el estado guardado en KV. El simulacro de "caída general" del servidor lo consulta para comprobar que el vigilante detectó el corte. |
| `/gemini-proxy` | El proxy de IA (protegido con `X-Proxy-Secreto`, no con token). |

## Variables y secretos

**Variables normales** (`[vars]` en `wrangler.toml`, se editan y se vuelve a desplegar): `URL_SERVIDOR`, `URL_DASHBOARD`, `URL_WEBHOOK_SINTETICO`, `UMBRAL_FALLOS`, `TIEMPO_ESPERA_MS`, `MAX_INTENTOS_AVISO`, `ESPERA_REINTENTO_MIN`.

**Secretos** (`wrangler secret put NOMBRE`, nunca en archivos):

| Secreto | Para qué |
|---|---|
| `PANEL_USUARIO`, `PANEL_CLAVE` | Autenticación básica del panel, para leer `/health`. |
| `KAPSO_API_KEY`, `KAPSO_PHONE_NUMBER_ID` | Enviar WhatsApp. |
| `WHATSAPP_DESTINO` | Número del dueño, con código de país, sin `+`. |
| `KAPSO_WEBHOOK_SECRET` | Firmar el webhook sintético (el mismo secreto que valida el bot). |
| `TOKEN_PRUEBA` | Proteger los endpoints manuales. Debe coincidir con `TOKEN_PRUEBA_VIGILANTE` del `.env` del servidor. |
| `PROXY_SECRETO` | Proteger el proxy de Gemini. Debe coincidir con `PROXY_SECRETO_GEMINI` del `.env` del servidor. |
| `GEMINI_API_KEY` o `GEMINI_API_KEYS` | Llave(s) de Google AI Studio. |

## Despliegue en 6 comandos

```
npm install -g wrangler
cd cloudflare-worker
wrangler kv namespace create VIGILANTE_KV      # pega el id que imprime en wrangler.toml
wrangler secret put PANEL_USUARIO             # y así con cada secreto de la tabla
wrangler deploy                               # imprime la URL: pégala en VIGILANTE_URL del .env del servidor
wrangler tail                                 # ver los logs en vivo
```

El [README del Worker](../cloudflare-worker/README.md) tiene la versión larga, pensada para alguien que nunca ha usado Cloudflare.

## Costo

Cero. Workers gratis permite 100.000 peticiones al día (este usa ~1.440 del cron más las llamadas de IA), KV gratis permite 100.000 lecturas y 1.000 escrituras al día (este usa ~1.440 lecturas y casi ninguna escritura).
