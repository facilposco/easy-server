# AGENTS.md — cómo instalar Centinela Zeus (guía para agentes de IA y programadores)

Este archivo es para quien va a **instalar Centinela en un servidor** sin haber participado en su desarrollo: Claude Code, Codex, otro agente de IA, o una persona técnica. Si eres un agente, léelo completo antes de ejecutar nada y sigue el orden. Cada paso tiene una **comprobación**: no avances al siguiente si la comprobación falla.

La explicación para humanos, con más contexto, está en [docs/INSTALACION.md](docs/INSTALACION.md). Este archivo no la reemplaza: la convierte en una lista de verificación ejecutable. Las reglas del protocolo de reparación están en [CLAUDE.md](CLAUDE.md) y la arquitectura en [docs/ARQUITECTURA.md](docs/ARQUITECTURA.md).

---

## Qué es y qué NO incluye

- **Centinela** es un solo proceso Node.js 20 (`server.js`, sin dependencias, sin `npm install`) que corre en el **host** con systemd, no dentro de Docker, y vigila/repara contenedores Docker de una aplicación.
- Incluye: el servidor y sus módulos (`modulos/`), el panel web (`public/`), scripts de respaldo y mantenimiento (`scripts/`), plantillas de despliegue (`deploy/`) y un Worker de Cloudflare (`cloudflare-worker/`) que vigila desde afuera.
- **No incluye el bot de WhatsApp.** Centinela manda avisos por WhatsApp directamente (API de Kapso), pero los comandos `/centinela` que escribe el dueño los recibe **su bot**, que tiene que reenviarlos a Centinela (paso 9). Si el servidor no tiene un bot, todo lo demás funciona igual; solo `/centinela` no.

## Reglas que un agente no puede romper

1. **Nunca dejes el puerto 4900 abierto a internet.** La API de Centinela no pide contraseña y puede reiniciar servicios y el servidor. Su protección es el cortafuegos (paso 5) más la autenticación básica de Traefik (paso 6). Si no puedes configurar el cortafuegos, detente y díselo a la persona.
2. **Nunca subas ni muestres el `.env`** ni ningún secreto (contraseñas, llaves de API, tokens). No los pegues en commits, issues, logs ni en tu respuesta final. Para confirmar que una variable existe, muestra su nombre, no su valor.
3. **No actives la regla `ufw` por defecto `deny` sin haber permitido SSH antes.** Te quedarías fuera del servidor.
4. **No toques contenedores, volúmenes ni bases de datos que no sean de la aplicación** que se va a vigilar. No borres datos. No reinicies el servidor completo durante la instalación.
5. **No inventes valores.** Si falta un dato de la tabla del paso 0, pregúntalo. No uses valores de ejemplo (`panel.ejemplo.com`, `cambia-esto`, `203.0.113.10`) en producción.
6. **Corre `npm test` antes de dar por terminada cualquier modificación de código.** Deben pasar las 180 pruebas.

---

## Paso 0 — Datos que hay que pedirle a la persona antes de empezar

| Dato | Para qué | Dónde termina |
|---|---|---|
| Acceso SSH como root (o sudo) al VPS | Todo | — |
| Dominio del panel, ya apuntando por DNS a la IP del VPS | Publicar el panel con HTTPS | `PANEL_ORIGEN` en `.env` y regla de Traefik |
| IP pública del VPS (opcional) | Mostrarla en el panel | `SERVIDOR_IP` |
| Nombres de los contenedores de la aplicación | Qué vigila y puede reparar Centinela | `CONTENEDORES_PROPIOS` en `server.js`, `NOMBRES` en `public/app.js` |
| Carpeta de la aplicación (con su `docker-compose.yml`) | Scripts de respaldo y mantenimiento | por defecto `/opt/zeus-app` |
| Contraseña de root de MariaDB y nombre del esquema | Auditorías, respaldos, restauración | `MYSQL_ROOT_PASS`, `DB_ESQUEMA` |
| Llave de API de Kapso y `phone_number_id` | Mandar avisos por WhatsApp | `KAPSO_API_KEY`, `KAPSO_PHONE_NUMBER_ID` |
| Número de WhatsApp del dueño (con código de país, sin `+`) | Destino de los avisos | `WSP_DESTINO` |
| Nombre de la plantilla de WhatsApp aprobada por Meta | Avisos fuera de la ventana de 24 h | `WSP_PLANTILLA` |
| Contraseña para el panel (usuario `zeus`) | Autenticación básica de Traefik | hash en la regla de Traefik |
| Cuenta de Cloudflare (Account ID y permiso de Workers) y llave de Gemini | Vigilante externo y la IA | ver `cloudflare-worker/README.md` |
| PIN para acciones delicadas y para simulacros | Confirmaciones | `PIN_ACCION`, `PIN_SIMULACRO` |
| (Opcional) remoto de rclone a Google Drive | Subir los respaldos | remoto `zeus-drive` |

Lo que no se sepa se puede dejar para después, **excepto** `PANEL_ORIGEN`, `MYSQL_ROOT_PASS` y `DB_ESQUEMA`: sin ellos Centinela arranca pero la mitad de las auditorías fallan.

---

## Paso 1 — Comprobar el servidor

```bash
cat /etc/os-release | head -2          # Ubuntu 22.04 o similar
docker --version && docker compose version
node --version                         # v20 o superior
docker ps --format '{{.Names}}\t{{.Status}}'
command -v ufw
```

**Comprobación:** Docker y Docker Compose responden, Node es ≥ 20, los contenedores de la aplicación aparecen en `docker ps`, `ufw` existe.
Si falta Node 20: `curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs`.
Si falta `ufw`: `sudo apt-get install -y ufw`.

## Paso 2 — Copiar el código y comprobar que está sano

```bash
sudo git clone https://github.com/facilposco/easy-server.git /opt/zeus-ops
sudo mkdir -p /var/lib/zeus-ops
cd /opt/zeus-ops && npm test
```

**Comprobación:** `npm test` termina con `pass 180` y `fail 0`.

## Paso 3 — Adaptar nombres y rutas (solo si difieren)

Los nombres de referencia son `zeus-bot` (aplicación), `zeus-mariadb`, `zeus-chromadb` (opcional) y `zeus-proxy` (Traefik), y la aplicación vive en `/opt/zeus-app`. Si el servidor usa otros:

- Contenedores: edita `CONTENEDORES_PROPIOS` y `DESCRIPCIONES` al inicio de `server.js`, y `NOMBRES` al inicio de `public/app.js`. Centinela nunca toca un contenedor que no esté en `CONTENEDORES_PROPIOS`.
- Ruta de la aplicación: `grep -rn /opt/zeus-app server.js modulos scripts deploy` y reemplaza en cada coincidencia.
- Carpeta dinámica de Traefik: `grep -rn /opt/zeus-proxy server.js modulos` (la usan los simulacros de red).

**Comprobación:** `npm test` sigue en `pass 180`, y `grep -rn` de los nombres viejos ya no encuentra nada que deba cambiar.

## Paso 4 — `.env` y arranque

```bash
cd /opt/zeus-ops
sudo cp .env.example .env && sudo chmod 640 .env
# llena .env con los datos del paso 0 (cada variable está explicada en el archivo)
sudo sed -i 's/\[NombreDelNegocio\]/NOMBRE REAL/g' centinela-persona.md
sudo cp deploy/zeus-ops.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now zeus-ops
curl -s http://127.0.0.1:4900/health
```

**Comprobación:** `/health` responde `{"ok":true,"servicio":"zeus-ops",...}` y `systemctl is-active zeus-ops` dice `active`. Si no: `sudo journalctl -u zeus-ops -n 50`.
Comprueba que no quedaron valores de ejemplo, sin imprimir secretos:

```bash
grep -nE 'ejemplo\.com|cambia-esto|TU-CUENTA|57XXXXXXXXXX' /opt/zeus-ops/.env && echo "QUEDAN VALORES DE EJEMPLO" || echo "sin valores de ejemplo"
```

## Paso 5 — Cortafuegos: cerrar el 4900 (obligatorio)

Centinela escucha en `0.0.0.0:4900` porque Traefik y el bot la alcanzan desde Docker. Averigua la red de Docker de Traefik y del bot:

```bash
docker inspect zeus-proxy zeus-bot -f '{{.Name}}: {{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}'
docker network inspect NOMBRE_RED -f '{{(index .IPAM.Config 0).Subnet}} gw={{(index .IPAM.Config 0).Gateway}}'
```

Con la subred obtenida (ejemplo `10.0.2.0/24`), **en este orden**:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow from 10.0.2.0/24 to any port 4900 proto tcp comment 'centinela desde docker'
sudo ufw default deny incoming
sudo ufw --force enable
sudo ufw status numbered
```

Si Traefik y el bot están en redes distintas, agrega una regla `allow from` por cada subred.

**Comprobación (obligatoria, desde FUERA del servidor):** `curl -m 8 http://IP_DEL_VPS:4900/health` tiene que **fallar por tiempo agotado**. Si responde, el puerto está expuesto: no sigas. Y una nueva sesión SSH tiene que seguir entrando.

## Paso 6 — Publicar el panel con Traefik

```bash
docker run --rm httpd:2.4-alpine htpasswd -nbB zeus 'CONTRASEÑA_DEL_PASO_0'
```

Copia `deploy/traefik-dynamic.example.yml` a la carpeta dinámica de Traefik, pega el hash en `users`, cambia `panel.ejemplo.com` por el dominio, y cambia la `url` del servicio por `http://GATEWAY_DEL_PASO_5:4900`.

**Comprobación:** `curl -s -o /dev/null -w '%{http_code}' https://DOMINIO/` devuelve `401` sin usuario y `200` con `-u zeus:CONTRASEÑA`. El entryPoint TLS de Traefik puede llamarse `https` o `websecure`: usa el que tenga el Traefik real (`docker inspect zeus-proxy`).

## Paso 7 — Vigilante externo en Cloudflare

Sigue `cloudflare-worker/README.md`. Al terminar:

- pega la URL del Worker en `VIGILANTE_URL` del `.env`;
- `PROXY_SECRETO_GEMINI` del `.env` debe ser **igual** al secreto `PROXY_SECRETO` del Worker, y `TOKEN_PRUEBA_VIGILANTE` igual a `TOKEN_PRUEBA`;
- `sudo systemctl restart zeus-ops`.

**Comprobación:** `curl -s "https://URL_DEL_WORKER/probar?token=TOKEN_PRUEBA"` devuelve un JSON donde el servidor y el panel figuran como respondiendo (el token va en la URL: no lo pegues en tu respuesta final). Sin token debe responder `401`.

## Paso 8 — Tareas programadas

```bash
sudo mkdir -p /opt/zeus-app/scripts
sudo cp /opt/zeus-ops/scripts/*.sh /opt/zeus-app/scripts/ && sudo chmod +x /opt/zeus-app/scripts/*.sh
sudo crontab -l 2>/dev/null > /tmp/cron.actual; cat /tmp/cron.actual /opt/zeus-ops/deploy/crontab.example | sudo crontab -
sudo crontab -l
```

**Comprobación:** `crontab -l` muestra las tareas nuevas **y** las que ya existían (no borres el crontab de la persona). Opcional: `sudo /opt/zeus-app/scripts/backup_db.sh` termina sin error y el panel muestra la copia en **Copias de seguridad**.

## Paso 9 — Conectar el bot de WhatsApp con `/centinela`

Solo si el servidor tiene un bot y la persona quiere los comandos por WhatsApp. El contrato, un ejemplo de código y una trampa de Kapso ya documentada están en [docs/INSTALACION.md, paso 7b](docs/INSTALACION.md#7b-conectar-tu-bot-de-whatsapp-con-centinela). En resumen:

- el bot, cuando el **dueño** escribe algo que empieza con `/centinela`, hace `POST http://GATEWAY:4900/api/centinela/preguntar` con `{"pregunta": "<lo que va después de /centinela>"}` y responde por WhatsApp el campo `respuesta`;
- si entre Kapso y el bot hay un intermediario, el tipo de evento está en la cabecera `X-Webhook-Event`, no en el cuerpo.

**Comprobación, en este orden:**

```bash
# 1) Centinela sola, desde el servidor:
curl -s -X POST http://127.0.0.1:4900/api/centinela/preguntar -H 'Content-Type: application/json' -d '{"pregunta":"menu"}'
# 2) Desde dentro del contenedor del bot (prueba la red y el cortafuegos):
docker exec zeus-bot node -e "fetch('http://GATEWAY:4900/health').then(r=>r.text()).then(console.log)"
```

1 debe devolver el menú de 19 opciones; 2 debe devolver `{"ok":true,...}`. Después, que el dueño escriba `/centinela menu` por WhatsApp.

---

## Paso 10 — Aceptación final

La instalación está terminada solo si todo esto es cierto:

- [ ] `npm test` → `pass 180`, `fail 0`.
- [ ] `systemctl is-active zeus-ops` → `active`; `/health` local responde `ok`.
- [ ] Desde fuera del servidor, `http://IP_DEL_VPS:4900/health` **no** responde.
- [ ] `https://DOMINIO/` pide usuario y contraseña, y con ellos abre el panel.
- [ ] En el panel, **Inicio → Auditar todo** devuelve notas por área sin errores de conexión a la base.
- [ ] En **Ajustes → Enviarme el estado por WhatsApp** llega el mensaje al dueño.
- [ ] `crontab -l` tiene las tareas de Centinela y conserva las que ya había.
- [ ] (Si hay bot) `/centinela menu` por WhatsApp responde el menú.
- [ ] (Opcional, con permiso de la persona) **Simulacros → Muerte súbita del bot** termina en APROBADO.
- [ ] `.env` tiene permisos `640`, no está en git (`git -C /opt/zeus-ops status --short` no lo muestra) y no quedan valores de ejemplo.

En el resumen final a la persona, di qué quedó listo, qué quedó pendiente y por qué. No incluyas ningún secreto.

---

## Si algo falla

| Síntoma | Qué revisar primero |
|---|---|
| `zeus-ops` no arranca | `journalctl -u zeus-ops -n 50`; `node --check /opt/zeus-ops/server.js`; versión de Node |
| El panel da 502 / 504 | La `url` del servicio en Traefik tiene que ser el gateway de la red de Traefik, y el cortafuegos tiene que permitir esa subred al 4900 |
| Las auditorías de base de datos fallan | `MYSQL_ROOT_PASS` y `DB_ESQUEMA`; que el contenedor se llame como en `CONTENEDORES_PROPIOS` |
| No llegan avisos por WhatsApp | `KAPSO_API_KEY`, `KAPSO_PHONE_NUMBER_ID`, `WSP_DESTINO`; fuera de la ventana de 24 h, que `WSP_PLANTILLA` esté aprobada por Meta |
| `/centinela` no responde | Las dos comprobaciones del paso 9, en orden; si ambas pasan, el problema está entre WhatsApp y el bot (revisa sus logs y, si hay intermediario, la cabecera `X-Webhook-Event`) |
| El servidor entero dejó de responder (SSH y HTTPS a la vez) y el vigilante externo avisa | Antes de buscar una falla técnica, revisa en el proveedor del VPS que la cuenta no esté suspendida por falta de pago |
| La IA no responde | `VIGILANTE_URL` y que `PROXY_SECRETO_GEMINI` coincida con el secreto del Worker; el resto de Centinela funciona sin IA |

## Actualizar una instalación existente

```bash
cd /opt/zeus-ops && sudo git pull && npm test && sudo systemctl restart zeus-ops
```

Si `npm test` falla, **no** reinicies: el servicio sigue corriendo con la versión anterior.
