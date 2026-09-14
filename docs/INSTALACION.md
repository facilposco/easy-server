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

Centinela escucha solo en `127.0.0.1:4900`. Nadie de afuera puede hablarle sin pasar por el siguiente paso.

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

## 8. Comprobar que todo quedó bien

1. Entra al panel. En **Inicio** pulsa **Auditar todo**: en unos segundos tendrás la nota de 1 a 10 de cada área.
2. En **Ajustes** pulsa **Enviarme el estado por WhatsApp**: debe llegarte un mensaje.
3. Escribe por WhatsApp al número de tu bot `/centinela menu`: debe responder el menú de 19 opciones.
4. En **Simulacros** lanza **Muerte súbita del bot** (escribe la palabra que pide): Centinela debe detectarlo, revivirlo y avisarte, todo solo, en un minuto.

Si algo no responde, `sudo journalctl -u zeus-ops -n 50` muestra qué pasó.

## Actualizar a una versión nueva

```bash
cd /opt/zeus-ops && sudo git pull && npm test && sudo systemctl restart zeus-ops
```

`npm test` corre las 180 pruebas en tu propio servidor antes de reiniciar: si algo falla, no reinicies.
