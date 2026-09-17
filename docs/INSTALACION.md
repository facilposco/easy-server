# Instalación paso a paso

Tiempo estimado: 20 a 30 minutos si ya tienes un VPS con Docker. No hace falta saber Linux a fondo: cada paso es un comando que se copia y se pega.

## Lo que se da por sentado

Centinela vigila **un VPS Linux (Ubuntu 22.04 o similar) donde tu aplicación corre con Docker Compose**. El diseño de referencia (el que corre en producción) es:

| Contenedor | Qué es | Nombre esperado |
|---|---|---|
| Tu aplicación (el bot, la tienda, la API…) | Lo que atiende a tus clientes | `zeus-bot` |
| MariaDB | La base de datos de la aplicación | `zeus-mariadb` |
| ChromaDB (opcional) | Memoria vectorial, si tu app usa IA | `zeus-chromadb` |
| Traefik | Puerta de entrada HTTPS con certificados automáticos | `zeus-proxy` |

Si tus contenedores se llaman distinto, cambia la lista `CONTENEDORES_PROPIOS` y `DESCRIPCIONES` al inicio de `server.js` y el mapa `NOMBRES` al inicio de `public/app.js`. Centinela **nunca toca** un contenedor que no esté en esa lista.

Tu aplicación vive en `/opt/zeus-app` (con su `docker-compose.yml`, su `.env` y una carpeta `scripts/`). Si vive en otra ruta, busca y reemplaza `/opt/zeus-app` en `server.js`, `modulos/` y `scripts/`.

## 1. Copiar Centinela al servidor

```bash
sudo mkdir -p /opt/zeus-ops /var/lib/zeus-ops
sudo git clone https://github.com/facilposco/easy-server.git /opt/zeus-ops
cd /opt/zeus-ops
node --version   # necesita Node 20 o superior; no hay npm install: cero dependencias
```

Si no tienes Node 20: `curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs`.

## 2. Configurar el `.env`

```bash
sudo cp .env.example .env
sudo chmod 640 .env
sudo nano .env
```

Llena al menos `PANEL_ORIGEN`, `MYSQL_ROOT_PASS`, `DB_ESQUEMA`, `WSP_DESTINO` y las llaves de tu proveedor de WhatsApp. Las de IA (`VIGILANTE_URL`, `PROXY_SECRETO_GEMINI`) las llenas en el paso 6. Cada variable está explicada dentro del archivo.

## 3. Personalizar la voz de Centinela

`centinela-persona.md` son las instrucciones que recibe la IA cuando el dueño le escribe por WhatsApp. Busca `[NombreDelNegocio]` y reemplázalo por el nombre real. Lee el archivo completo una vez: define qué sabe, cómo habla y qué no hace nunca.

## 4. Dejarlo corriendo con systemd

```bash
sudo cp deploy/zeus-ops.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now zeus-ops
curl -s http://127.0.0.1:4900/health     # debe responder {"ok":true,...}
```

Centinela escucha en el puerto `4900` de **todas** las interfaces (`0.0.0.0`), no solo en `127.0.0.1`: tiene que ser así para que tu bot, que corre dentro de Docker, pueda hablarle. Esa API **no pide contraseña** y puede reiniciar servicios y el servidor, así que el paso siguiente no es opcional.

## 4b. Cerrar el puerto 4900 con el cortafuegos (obligatorio)

La contraseña del panel la pone Traefik (paso 5), no Centinela. Si el puerto `4900` queda abierto a internet, cualquiera puede saltarse esa contraseña y hablarle directo a la API. Ciérralo y déjalo abierto solo para la red Docker donde viven Traefik y tu bot (lo normal es que sea la misma red; si están en redes distintas, repite la regla `allow` para cada subred).

Primero averigua la subred y el gateway de esa red Docker:

```bash
docker inspect zeus-bot -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}'
docker network inspect NOMBRE_DE_LA_RED -f '{{(index .IPAM.Config 0).Subnet}} gw={{(index .IPAM.Config 0).Gateway}}'
# ejemplo de salida: 10.0.2.0/24 gw=10.0.2.1
```

Luego aplica el cortafuegos (cambia `10.0.2.0/24` por tu subred; **no cierres SSH antes de permitirlo**):

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow from 10.0.2.0/24 to any port 4900 proto tcp comment 'centinela desde la red docker'
sudo ufw default deny incoming
sudo ufw enable
```

Compruébalo **desde otro equipo** (tu computador, no el servidor): esto tiene que fallar por tiempo agotado.

```bash
curl -m 8 http://IP_DE_TU_SERVIDOR:4900/health    # debe fallar; si responde, el puerto está expuesto
```

Anota la IP del gateway (`gw=`, en el ejemplo `10.0.2.1`): es la dirección con la que Traefik (la `url` del servicio en el paso 5) y tu bot (paso 7b) le hablan a Centinela.

## 5. Publicar el panel con Traefik y contraseña

`deploy/traefik-dynamic.example.yml` trae el router, el middleware de autenticación básica y el servicio. Genera el hash de la contraseña:

```bash
docker run --rm httpd:2.4-alpine htpasswd -nbB zeus 'una-contraseña-larga'
```

Pega la línea que imprime en `users`, cambia `panel.ejemplo.com` por tu dominio (apuntado por DNS al VPS) y copia el archivo a la carpeta dinámica de tu Traefik. En un minuto tendrás `https://tu-dominio` pidiendo usuario y contraseña.

## 6. Desplegar el vigilante externo en Cloudflare

Es la pieza que avisa aunque el servidor esté apagado y la que da acceso a Gemini. Sigue [cloudflare-worker/README.md](../cloudflare-worker/README.md) (6 comandos) o la explicación técnica en [CLOUDFLARE-WORKER.md](CLOUDFLARE-WORKER.md). Al terminar, `wrangler deploy` imprime la URL del Worker: pégala en `VIGILANTE_URL` del `.env`, y asegúrate de que `PROXY_SECRETO_GEMINI` y `TOKEN_PRUEBA_VIGILANTE` del `.env` sean iguales a los secretos `PROXY_SECRETO` y `TOKEN_PRUEBA` del Worker. Luego `sudo systemctl restart zeus-ops`.

## 7. Programar las tareas

```bash
sudo cp scripts/*.sh /opt/zeus-app/scripts/
sudo chmod +x /opt/zeus-app/scripts/*.sh
sudo crontab -e     # pega el contenido de deploy/crontab.example
```

Los scripts leen la contraseña de la base desde `/opt/zeus-ops/.env` (nunca la llevan escrita) y avisan a Centinela cada vez que corren, así el panel sabe si un día faltó una copia.

Para subir las copias a Google Drive, instala [rclone](https://rclone.org) y configura un remoto llamado `zeus-drive`. Si no está configurado, el respaldo se guarda solo en el servidor y el panel lo avisa.

## 7b. Conectar tu bot de WhatsApp con `/centinela`

Centinela **no recibe** los mensajes de WhatsApp: los recibe tu bot. Para que `/centinela` funcione, tu bot tiene que reenviar a Centinela los mensajes del dueño que empiezan con `/centinela` y contestar con lo que Centinela devuelva. Este repositorio no incluye tu bot; esto es lo que tienes que agregarle.

**El contrato** (una sola petición, sin autenticación, por eso importa el paso 4b):

```http
POST http://GATEWAY_DOCKER:4900/api/centinela/preguntar
Content-Type: application/json

{ "pregunta": "menu" }
```

Respuesta: `{ "ok": true, "respuesta": "texto listo para mandar por WhatsApp" }`. La `pregunta` es lo que el dueño escribió **después** de `/centinela` (`menu`, `2`, `4 si`, `¿por qué está lento?`). Centinela decide solo si usa la IA; el menú y las opciones numeradas nunca la gastan.

Un ejemplo mínimo en Node.js para el manejador de mensajes de tu bot:

```js
const CENTINELA_URL = 'http://10.0.2.1:4900/api/centinela/preguntar'; // gateway de tu red docker (paso 4b)
const DUENO = process.env.ADMIN_PHONE; // solo el dueño puede usar /centinela

async function manejarCentinela(telefono, texto) {
  if (!DUENO || !telefono.startsWith(DUENO.replace(/\D/g, ''))) return null; // otros: flujo normal del bot
  if (!/^\/centinela\b/i.test(texto.trim())) return null;
  const pregunta = texto.trim().slice('/centinela'.length).trim() || 'menu';
  const controlador = new AbortController();
  const vencido = setTimeout(() => controlador.abort(), 30000); // la IA puede tardar hasta ~15 s
  try {
    const r = await fetch(CENTINELA_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pregunta }), signal: controlador.signal,
    });
    const datos = await r.json();
    return datos.ok ? datos.respuesta : 'Centinela no pudo responder ahora mismo.';
  } catch (_) {
    return 'Centinela no está disponible ahora mismo.';
  } finally {
    clearTimeout(vencido);
  }
}
```

**Si usas Kapso (o cualquier proveedor con webhooks) detrás de un intermediario** — un Worker de Cloudflare, un proxy, una cola —, ojo con esto, que costó horas encontrarlo en producción: Kapso manda el tipo de evento (`whatsapp.message.received`, `whatsapp.message.sent`…) **solo en la cabecera HTTP `X-Webhook-Event`**, nunca en el cuerpo. Y el cuerpo trae un objeto `message` arriba **también** en los eventos de estado (enviado, entregado). Un intermediario que busque el tipo en el cuerpo no encuentra nada, trata cada mensaje real como un estado y no lo reenvía; mientras tanto, el panel de Kapso muestra "delivered 200" como si todo estuviera bien. Lee el tipo de la cabecera. Las pruebas hechas a mano con `"type"` en el cuerpo pasan igual, así que no sirven para detectar este error: prueba con la cabecera.

## 8. Comprobar que todo quedó bien

1. Entra al panel. En **Inicio** pulsa **Auditar todo**: en unos segundos tendrás la nota de 1 a 10 de cada área.
2. En **Ajustes** pulsa **Enviarme el estado por WhatsApp**: debe llegarte un mensaje.
3. Escribe por WhatsApp al número de tu bot `/centinela menu`: debe responder el menú de 19 opciones. Si no responde, prueba primero la API sin WhatsApp desde el servidor: `curl -s -X POST http://127.0.0.1:4900/api/centinela/preguntar -H 'Content-Type: application/json' -d '{"pregunta":"menu"}'`. Si eso devuelve el menú, el problema está entre WhatsApp y tu bot (paso 7b), no en Centinela.
4. Desde tu computador, `curl -m 8 http://IP_DE_TU_SERVIDOR:4900/health` **tiene que fallar** (paso 4b).
5. En **Simulacros** lanza **Muerte súbita del bot** (escribe la palabra que pide): Centinela debe detectarlo, revivirlo y avisarte, todo solo, en un minuto.

Si algo no responde, `sudo journalctl -u zeus-ops -n 50` muestra qué pasó.

## Actualizar a una versión nueva

```bash
cd /opt/zeus-ops && sudo git pull && npm test && sudo systemctl restart zeus-ops
```

`npm test` corre las 180 pruebas en tu propio servidor antes de reiniciar: si algo falla, no reinicies.
