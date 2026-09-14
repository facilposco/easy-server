# Centinela Zeus — un ingeniero de servidores senior, en software libre, para negocios pequeños

[![Versión estable](https://img.shields.io/badge/versi%C3%B3n-1.0.0-2ea44f)](CHANGELOG.md) [![Licencia MIT](https://img.shields.io/badge/licencia-MIT-blue)](LICENSE) [![Node 20+](https://img.shields.io/badge/node-%E2%89%A520-339933)](package.json) [![Sin dependencias](https://img.shields.io/badge/dependencias-0-informational)](package.json) [![180 pruebas](https://img.shields.io/badge/pruebas-180%20en%20verde-2ea44f)](modulos/pruebas)

**Centinela Zeus vigila, diagnostica, repara y explica un servidor Linux con Docker — por WhatsApp y con un panel web — para un dueño de negocio que no sabe Linux.** Hace lo que haría un ingeniero de servidores con experiencia: diagnostica antes de tocar, guarda evidencia antes de reparar, repara de lo menos invasivo a lo más invasivo, verifica después de cada paso, y cuando no sabe, se detiene y lo dice.

Está pensado para **pymes, emprendimientos y proyectos con un solo VPS** que no pueden pagar a alguien dedicado a cuidarlo. Es **código abierto (MIT)** y corre hoy en producción, 24/7, cuidando el servidor de un negocio real. Cualquiera puede usarlo, adaptarlo y mejorarlo.

> *Centinela Zeus is an open-source (MIT), self-healing server operations agent for small businesses: it monitors, diagnoses, repairs and explains a Linux VPS with Docker via WhatsApp and a web panel, in plain Spanish, following a strict 9-step incident protocol. Zero dependencies, Node.js 20, plus a free Cloudflare Worker as external watchdog. See the English summary at the end.*

<p align="center"><img src="docs/capturas/inicio.png" alt="Panel de Centinela Zeus: auditoría completa con nota por área, acciones con un clic y hallazgos explicados" width="900"></p>

## ¿Qué problema resuelve?

Un negocio pequeño pone su bot de WhatsApp, su tienda o su API en un VPS y **nadie lo mira**. Un día el disco se llena, la base de datos se traba o un contenedor se cae a las 3 de la mañana, y el dueño se entera porque los clientes dejan de recibir respuesta. Contratar a alguien para vigilar un solo servidor no tiene sentido económico; los servicios de monitoreo avisan pero no arreglan, y hablan en un idioma que el dueño no entiende.

Centinela ocupa ese lugar:

- **Detecta** caídas, disco y memoria llenos, consultas lentas, copias de seguridad que fallan en silencio, puertos abiertos que no deberían, actualizaciones pendientes, tendencias que van a ser un problema en dos semanas.
- **Repara solo lo que es seguro reparar solo** (liberar espacio, reiniciar el servicio que falla, en orden de dependencia) y **pide una palabra escrita** para todo lo que no se puede deshacer con un clic.
- **Explica en español claro**, sin jerga: qué significa cada hallazgo, qué tan grave es de verdad, y qué botón lo arregla. Si no hay botón, dice por qué.
- **Avisa aunque el servidor esté muerto**, gracias a un vigilante externo gratuito en Cloudflare.

## Qué incluye

| Área | Qué hace |
|---|---|
| **SOS** | Protocolo de emergencia de 9 pasos, autónomo con frenos: diagnóstico determinista, evidencia enmascarada antes de tocar nada, reparación escalonada, límites diarios, enfriamiento y autobloqueo. Se lanza desde el panel o escribiendo `sos` por WhatsApp. |
| **Panel web** | 13 secciones: Inicio (Auditoría 360 con nota de 1 a 10 por área), SOS, Historial, Registros (evidencia), Copias de seguridad, Contenedores (consola en vivo), Seguridad, Optimización de base de datos, Limpieza, Datos técnicos, Simulacros, Ajustes, Permisos. Móvil y escritorio. |
| **WhatsApp** | Menú de 19 opciones ordenadas por lo que más falla (`/centinela menu`), preguntas libres a la IA con el estado real del servidor como contexto (`/centinela ¿por qué va lento el bot?`), resumen diario, informe semanal, modo viaje, escalamiento a un técnico si no confirmas un aviso grave. |
| **Auditorías** | Seguridad (SSH, cortafuegos, actualizaciones, usuarios, permisos de archivos con contraseñas, Docker, dependencias, credenciales en el código) y base de datos (10 revisiones de MariaDB: conexiones, memoria caché, motor y claves, fragmentación, recorridos completos, índices redundantes, crecimiento, memoria, bloqueos, sugerencias pendientes). Con botón de arreglo real donde es seguro y "Explicar con IA" donde no. |
| **Prevención** | Vigía de tendencias (proyección de disco y memoria, picos de CPU, reinicios), memoria de incidentes que sugiere guías paso a paso, latidos de todas las tareas programadas, deriva de configuración. |
| **Copias** | Respaldo diario verificado y subido a Google Drive, rotación, y una **prueba semanal de restauración real** en un contenedor descartable. |
| **Simulacros** | Seis fallas controladas (muerte del bot, pico de CPU, agotamiento de memoria, disco lleno, aislamiento de red, congelar la base) que se revierten solas, para comprobar que Centinela reacciona bien antes de que pase de verdad. |
| **Vigilante externo** | Un Cloudflare Worker gratuito revisa el servidor cada minuto desde afuera y avisa por WhatsApp si deja de responder; también sirve de proxy para Gemini. |

## Cómo se ve

| Escritorio | Móvil |
|---|---|
| <img src="docs/capturas/sos.png" alt="Sección SOS: un botón, límites de seguridad y el protocolo paso a paso" width="440"> | <img src="docs/capturas/movil-sos.png" alt="La misma sección SOS en un celular" width="200"> |
| <img src="docs/capturas/optimizacion.png" alt="Auditoría de la base de datos con botones de arreglo por hallazgo" width="440"> | <img src="docs/capturas/movil-inicio.png" alt="Inicio en un celular" width="200"> |

Más capturas en [`docs/capturas/`](docs/capturas/) y una explicación ilustrada de cada sección en [**tutorial.html**](tutorial.html).

## Instalación en 20 minutos

Necesitas un VPS Linux con Docker Compose, Node 20 y un dominio. Sin `npm install`: no hay dependencias.

```bash
sudo git clone https://github.com/facilposco/easy-server.git /opt/zeus-ops
cd /opt/zeus-ops && sudo cp .env.example .env && sudo nano .env      # llena tus datos
sudo cp deploy/zeus-ops.service /etc/systemd/system/ && sudo systemctl enable --now zeus-ops
```

Luego publica el panel con Traefik y contraseña (`deploy/traefik-dynamic.example.yml`), programa las tareas (`deploy/crontab.example`) y despliega el vigilante externo (`cloudflare-worker/`, 6 comandos). Todo está paso a paso en [**docs/INSTALACION.md**](docs/INSTALACION.md).

## Cómo está hecho

- **`server.js`** — un solo proceso Node en el host (fuera de Docker, para poder reiniciar contenedores sin morir con ellos). Sirve el panel, la API y los relojes. Cero dependencias externas.
- **`modulos/`** — cada capacidad es un módulo con fábrica `crearX(deps)`: recibe `sh`, `mysql`, persistencia y notificación por parámetro, así todo se prueba con dobles en memoria. 180 pruebas con `node:test` (`npm test`).
- **`public/`** — el panel, HTML y JavaScript sin frameworks. Toda acción irreversible pasa por un modal de palabra escrita, y una prueba automática falla si alguien agrega un botón de alto riesgo sin él.
- **`cloudflare-worker/`** — el vigilante externo y el proxy de IA, con estado en KV y escritura solo cuando algo cambia (cabe en el plan gratuito).
- **`scripts/`** — respaldo, prueba de restauración y mantenimiento diario, en Bash, que leen la contraseña del `.env` y avisan a Centinela al terminar.

Las reglas que no se negocian están en [**CLAUDE.md**](CLAUDE.md): el diagnóstico es determinista; la IA solo redacta; la evidencia se guarda antes de reparar; se verifica entre cada paso; una sola causa primero; rendirse es una respuesta válida. La arquitectura completa, módulo por módulo, en [**docs/ARQUITECTURA.md**](docs/ARQUITECTURA.md). La parte de Cloudflare, línea a línea, en [**docs/CLOUDFLARE-WORKER.md**](docs/CLOUDFLARE-WORKER.md).

## Preguntas frecuentes

**¿Reemplaza de verdad a un ingeniero?** Reemplaza la vigilancia de todos los días y las reparaciones más comunes (el 90 % de lo que se cae y por qué). Para lo demás, te deja el problema explicado, con la evidencia guardada y la guía paso a paso, para que quien te ayude tarde minutos en vez de horas.

**¿Puede dañar algo?** Nunca borra datos, volúmenes ni copias; nunca toca contenedores de otro proyecto; nunca mata una consulta de la base por su cuenta. Las cuatro acciones de alto impacto (reiniciar el servidor, instalar actualizaciones del sistema, aplicar un índice, lanzar un simulacro) piden una palabra escrita incluso al dueño. Hay un freno de emergencia que deja a Centinela solo mirando.

**¿Qué necesita de IA?** Nada obligatorio. Sin llave de Gemini funciona todo: el SOS, las auditorías, los avisos. La IA solo redacta explicaciones y responde preguntas libres por WhatsApp, con un tope diario de consultas, usando la capa gratuita de Google AI Studio a través del Worker.

**¿Sirve para mi aplicación, que no es un bot de WhatsApp?** Sí. Centinela vigila contenedores de Docker, una base MariaDB y un VPS. Lo que corra dentro del contenedor principal le da igual: cambia los nombres en `CONTENEDORES_PROPIOS` (`server.js`) y `NOMBRES` (`public/app.js`).

**¿Qué proveedor de WhatsApp usa?** El código de referencia usa la API de WhatsApp Business a través de Kapso. Cambiar a Twilio, 360dialog o Meta directo es reescribir una función (`enviarWhatsapp` en `server.js`, `enviarAKapso` en el Worker). Ver [CONTRIBUTING.md](CONTRIBUTING.md).

**¿Cuánto cuesta correrlo?** Cero además del VPS que ya tienes. Cloudflare Workers y KV en plan gratuito, Gemini en capa gratuita.

## Contribuir

Este proyecto existe para que un negocio pequeño tenga lo que antes solo tenían las empresas grandes. Si tienes un caso real de caída, una mejora, una traducción o un adaptador para otro proveedor, lee [CONTRIBUTING.md](CONTRIBUTING.md) y abre un issue o un PR. Las ideas abiertas donde más ayuda hace falta están listadas ahí.

## Licencia

[MIT](LICENSE). Úsalo, modifícalo, véndelo: solo conserva el aviso de licencia.

---

### English summary

**Centinela Zeus** ("Zeus Sentinel") is an open-source (MIT) server-operations agent that gives a small business the judgment of a senior SRE without hiring one. It runs as a single dependency-free Node.js 20 process on a Linux VPS with Docker Compose, plus a free Cloudflare Worker as an external watchdog.

What it does: monitors containers, MariaDB, disk, memory, backups and security; runs a strict 9-step self-healing protocol (diagnose → measure customer impact → save masked evidence → repair least-invasive-first → verify after every step, with hard daily limits and cooldowns); performs daily security and database audits with one-click fixes where safe; predicts trends; tests backup restoration weekly in a disposable container; runs controlled failure drills; and explains everything in plain Spanish over WhatsApp (19-option menu, free-form questions answered by Gemini with real server state as context) and a mobile-friendly web panel. Every irreversible action requires a typed confirmation word. AI never decides — it only explains. 180 automated tests. Docs: [architecture](docs/ARQUITECTURA.md), [installation](docs/INSTALACION.md), [Cloudflare Worker](docs/CLOUDFLARE-WORKER.md), [protocol rules](CLAUDE.md).
