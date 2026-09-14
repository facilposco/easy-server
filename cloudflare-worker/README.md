# Vigilante externo de Zeus Ops

Este Worker vive en la red de Cloudflare (no en tu servidor) y cada minuto
revisa si el servidor principal y el bot de WhatsApp responden. Si alguno
deja de responder, te avisa por WhatsApp. Como corre por fuera, sigue
avisando aunque el servidor se apague por completo.

No hace falta saber Linux para instalarlo: son comandos que se copian y
pegan, uno por uno, y cada uno te dice si funciono o no.

## Que vas a necesitar antes de empezar

- El token de API de Cloudflare que ya tienes (permisos de Workers).
- El ID de cuenta de Cloudflare (Account ID). Lo encuentras en
  https://dash.cloudflare.com, en la pagina principal de tu cuenta, a la
  derecha, dice "Account ID".
- La contrasena del usuario `zeus` del panel del servidor.
- La llave de API de Kapso (`X-API-Key`) y el `phone_number_id` de WhatsApp.
- Node.js instalado en tu computador (para poder usar el comando `wrangler`).
  Si no lo tienes, descargalo de https://nodejs.org (version LTS).

## Paso 1: Instalar la herramienta de despliegue (wrangler)

Abre una terminal (en Windows, PowerShell) y escribe:

```
npm install -g wrangler
```

Cuando termine, comprueba que quedo instalada:

```
wrangler --version
```

## Paso 2: Darle a wrangler tu token de Cloudflare

En vez de iniciar sesion con el navegador, usamos directamente el token que
ya tienes (el que solo tiene permisos de Workers). En PowerShell, en la
misma ventana donde vas a trabajar, escribe (reemplazando los valores):

```
$env:CLOUDFLARE_API_TOKEN = "aqui-va-tu-token"
$env:CLOUDFLARE_ACCOUNT_ID = "aqui-va-tu-account-id"
```

Ojo: estas dos lineas solo valen para la ventana de PowerShell que tengas
abierta. Si la cierras, hay que volver a escribirlas antes de usar `wrangler`
otra vez.

## Paso 3: Entrar a la carpeta del proyecto

```
cd cloudflare-worker
```

Ahi deben estar los tres archivos: `worker.js`, `wrangler.toml` y este
`README.md`.

## Paso 4: Crear el espacio de almacenamiento (KV)

El Worker necesita un lugar donde recordar, entre una revision y la
siguiente, si el servidor ya estaba caido y si ya se aviso. Eso se llama
"KV" en Cloudflare. Para crearlo:

```
wrangler kv namespace create VIGILANTE_KV
```

Esto imprime algo como:

```
[[kv_namespaces]]
binding = "VIGILANTE_KV"
id = "0f1e2d3c4b5a..."
```

Copia ese `id` (el tuyo va a ser distinto) y pegalo en el archivo
`wrangler.toml`, en la linea que dice:

```
id = "PON_AQUI_EL_ID_DEL_KV"
```

**Si el comando falla con un error de permisos** (porque el token solo
tiene permisos de Workers y no de KV), no hay problema: crea el namespace a
mano desde el panel web:

1. Entra a https://dash.cloudflare.com
2. Ve a "Workers & Pages" > "KV"
3. Click en "Create a namespace"
4. Ponle de nombre `vigilante-zeus-estado` y crealo
5. Copia el ID que te muestra y pegalo en `wrangler.toml` igual que arriba

## Paso 5: Cargar los secretos (datos sensibles)

Estos datos NUNCA se escriben en el codigo. Se cargan uno por uno con este
comando, y wrangler te va a preguntar el valor (lo escribes y das Enter; no
se ve en pantalla mientras escribes, es normal):

```
wrangler secret put PANEL_USUARIO
wrangler secret put PANEL_CLAVE
wrangler secret put KAPSO_API_KEY
wrangler secret put KAPSO_PHONE_NUMBER_ID
wrangler secret put WHATSAPP_DESTINO
wrangler secret put TOKEN_PRUEBA
```

Que va en cada uno:

- `PANEL_USUARIO`: `zeus`
- `PANEL_CLAVE`: la contrasena real del usuario `zeus` en el servidor
- `KAPSO_API_KEY`: la llave que Kapso te dio para el header `X-API-Key`
- `KAPSO_PHONE_NUMBER_ID`: el ID de numero de WhatsApp que usa Kapso (el que
  va en la URL `.../whatsapp/v24.0/{phone_number_id}/messages`)
- `WHATSAPP_DESTINO`: `57XXXXXXXXXX` (el numero que debe recibir los avisos)
- `TOKEN_PRUEBA`: invéntate una clave larga y rara, por ejemplo
  `zeus-prueba-8x7k2m9qw` (la vas a usar tu mismo, mas adelante, para
  probar el Worker manualmente sin que cualquiera en internet pueda
  activarlo)

## Paso 6: Desplegar

```
wrangler deploy
```

Si todo sale bien, va a mostrar una URL parecida a:

```
https://vigilante-zeus.tu-usuario.workers.dev
```

Guarda esa URL, la vas a usar para las pruebas del paso 8.

## Paso 7: Confirmar que el disparador de cada minuto quedo activo

1. Entra a https://dash.cloudflare.com
2. Ve a "Workers & Pages" > click en `vigilante-zeus`
3. Pestana "Triggers" (Disparadores)
4. Debe aparecer un "Cron Trigger" con el valor `* * * * *` (significa
   "cada minuto")

## Paso 8: Probar que funciona

Todas las pruebas de abajo se hacen simplemente pegando una direccion en el
navegador (reemplaza `TU_URL` por la que te dio el paso 6, y `TU_TOKEN` por
el valor que pusiste en `TOKEN_PRUEBA`):

**a) Probar el envio de WhatsApp directamente** (la prueba mas importante,
confirma que Kapso y la plantilla funcionan):

```
TU_URL/probar-whatsapp?token=TU_TOKEN
```

Deberias recibir en el WhatsApp `57XXXXXXXXXX` un mensaje de prueba en
menos de un minuto. Si la pagina dice que no se pudo enviar, revisa que
`KAPSO_API_KEY` y `KAPSO_PHONE_NUMBER_ID` esten bien escritos (puedes
volver a cargarlos con `wrangler secret put NOMBRE`), y que la plantilla
`centinela_zeus` este aprobada en tu cuenta de Meta/Kapso.

**b) Ver el resultado de una revision ahora mismo** (sin esperar al minuto
del cron):

```
TU_URL/probar?token=TU_TOKEN
```

Esto te muestra en texto (formato JSON) si el servidor y el dashboard
respondieron bien en este momento.

**c) Ver el estado interno guardado** (cuantos fallos seguidos lleva cada
uno, si ya se aviso, desde cuando esta caido):

```
TU_URL/estado?token=TU_TOKEN
```

Al principio, antes de cualquier falla, ambos deben mostrar
`"fallosSeguidos": 0` y `"avisoEnviado": false`.

**d) Probar el aviso real de caida y recuperacion**: esto requiere que el
servidor realmente deje de responder unos minutos (por ejemplo, durante un
reinicio o mantenimiento que ya tengas planeado). No hace falta que lo
apagues a proposito solo para probar: la primera vez que el servidor tenga
una caida real de 3 minutos o mas, el vigilante ya va a avisar solo. Si
quieres verlo en accion mas rapido, puedes bajar temporalmente
`UMBRAL_FALLOS` a `"1"` en `wrangler.toml`, correr `wrangler deploy` de
nuevo, y esperar al proximo mantenimiento; luego no olvides devolverlo a
`"3"` y volver a desplegar.

**e) Ver los logs en vivo** (util si algo no cuadra):

```
wrangler tail
```

Dejalo corriendo un minuto o dos y vas a ver, cada minuto, si el Worker se
ejecuto y si encontro algun error.

## Como se distingue "no responde" de "responde con error"

El mensaje de alerta siempre dice una de estas dos frases, para que sepas
que tan grave es:

- **"no responde en absoluto"**: no se pudo ni siquiera conectar (el
  servidor esta apagado, sin internet, o tardo demasiado en contestar).
- **"responde pero con error"**: el servidor SI contesto, pero con un
  codigo de error HTTP o con un contenido que no es el esperado (por
  ejemplo, el `/health` no devolvio `{"ok":true,...}`).

## Como evitar falsas alarmas y avisos repetidos

- Solo se avisa despues de `UMBRAL_FALLOS` revisiones seguidas fallidas
  (por defecto 3, o sea 3 minutos seguidos fallando). Un solo tropiezo no
  genera ningun mensaje.
- Una vez se avisa de una caida, no se vuelve a avisar de lo mismo cada
  minuto: se espera hasta que el servicio se recupere.
- Cuando se recupera, llega un mensaje aparte diciendo cuanto tiempo estuvo
  caido.
- Si el envio del aviso por WhatsApp falla (por ejemplo, Kapso esta caido
  en ese momento), el Worker reintenta cada `ESPERA_REINTENTO_MIN` minutos
  (por defecto 5), hasta `MAX_INTENTOS_AVISO` veces (por defecto 5, o sea
  unos 25 minutos en total). Si se agotan los intentos, el Worker deja de
  intentar para esa caida especifica (no se queda reintentando para
  siempre), pero sigue funcionando con normalidad y va a avisar de la
  recuperacion cuando el servicio vuelva.

## Como comprobar que no te pasas del plan gratuito

Cloudflare Workers (plan gratuito) permite hasta 100.000 peticiones por dia
al Worker, y el KV gratuito permite hasta 100.000 lecturas y 1.000
escrituras por dia.

Este vigilante corre 1.440 veces al dia (una vez por minuto). Cada
ejecucion hace 1 lectura de KV, asi que son unas 1.440 lecturas al dia:
muy por debajo del limite de 100.000. En cuanto a escrituras, el Worker
solo escribe en KV cuando algo realmente cambia (empieza una caida, se
manda un aviso, o se recupera): en un dia normal sin incidentes, las
escrituras son practicamente cero, y aun en un dia con varias caidas reales
va a quedar muy lejos de las 1.000 escrituras permitidas.

Para verlo con tus propios ojos en el panel de Cloudflare:

1. Entra a https://dash.cloudflare.com > "Workers & Pages"
2. Click en `vigilante-zeus` > pestana "Metrics" (Metricas): ahi ves
   cuantas veces se ha ejecutado el Worker hoy y en los ultimos dias.
3. Ve a "Workers & Pages" > "KV" > click en el namespace que creaste en el
   Paso 4 > pestana "Metrics": ahi ves las lecturas y escrituras del dia.

Si algun dia ves que las escrituras de KV se disparan de forma rara, revisa
los logs con `wrangler tail`: probablemente el servidor este teniendo
muchas caidas cortas seguidas (lo cual, de por si, ya seria una senal de
que algo anda mal con el servidor).

## Si necesitas cambiar algo despues

- Cambiar la contrasena del panel, la llave de Kapso, el numero de destino,
  etc: vuelve a correr `wrangler secret put NOMBRE_DEL_SECRETO` con el
  valor nuevo, y luego `wrangler deploy`.
- Cambiar el umbral de fallos, los tiempos de espera, o las URLs vigiladas:
  edita las lineas correspondientes en `wrangler.toml` (seccion `[vars]`) y
  vuelve a correr `wrangler deploy`.
- Cambiar el codigo de la logica: edita `worker.js` y vuelve a correr
  `wrangler deploy`.
