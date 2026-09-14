# Arquitectura de Centinela Zeus

Este documento está escrito para dos lectores: un programador que descarga el repositorio y quiere entenderlo en una tarde, y un modelo de IA al que se le pide instalarlo, extenderlo o auditarlo. Por eso cada módulo dice qué recibe, qué devuelve y qué regla protege.

## Idea central

Un negocio pequeño tiene un VPS con Docker y nadie que lo cuide. Centinela ocupa ese lugar con el criterio de un ingeniero senior, pero con una diferencia deliberada: **todo lo que decide es determinista** (umbrales numéricos, reglas escritas, listas blancas), y **la inteligencia artificial solo redacta y explica**. Un agente que "decide" con un modelo de lenguaje y se equivoca hace más daño que uno que no existe.

## Las tres piezas

```
                 ┌──────────────────────────────────────────────────────┐
   WhatsApp ◄────┤  server.js  (Node 20, sin dependencias, systemd)     ├────► Docker
   (dueño)  ────►│  · panel web  · API  · SOS  · auditorías  · latidos │      MariaDB
                 │  · /centinela <pregunta>  · resumen diario  · vigía  │      Traefik
                 └───────────────▲──────────────────────────────────────┘
                                 │ /health cada minuto · /gemini-proxy
                 ┌───────────────┴──────────────────────────────────────┐
                 │  cloudflare-worker/worker.js  (Cloudflare Workers)    │
                 │  vigilante externo (avisa aunque el VPS esté apagado) │
                 │  proxy de Gemini (la llave de IA vive solo aquí)      │
                 └──────────────────────────────────────────────────────┘
```

1. **`server.js`** — un solo proceso en el host (fuera de Docker, para poder reiniciar contenedores sin morir con ellos). Sirve el panel estático de `public/`, expone la API `/api/*`, corre los relojes internos (auditoría diaria, resumen de WhatsApp, vigía) y compone los módulos de `modulos/` inyectándoles sus dependencias.
2. **`public/`** — el panel: `index.html` (estilos y estructura) y `app.js` (una IIFE sin frameworks). Trece secciones, modal de confirmación por palabra escrita, consolas en vivo por SSE, diseño móvil.
3. **`cloudflare-worker/`** — el vigilante externo y el proxy de IA. Explicado en [CLOUDFLARE-WORKER.md](CLOUDFLARE-WORKER.md).

## Cómo se componen los módulos

Cada módulo exporta una fábrica `crearX(deps)` que recibe **solo funciones y rutas**: `sh` (ejecutar un comando fijo), `mysql` (una consulta), `leerJson`/`guardarJson`/`anexar`/`leerJsonl` (persistencia en `/var/lib/zeus-ops`), `auditar` (bitácora), `enviarWhatsapp`, `permisos`, etc. Nada abre conexiones ni lee disco por su cuenta. Consecuencias:

- Toda la lógica se prueba con dobles en memoria (`modulos/pruebas/`, `modulos/sos/pruebas/`, 180 pruebas con `node:test`).
- Cambiar de proveedor (otro WhatsApp, otra base) es cambiar una función en `server.js`, no tocar los módulos.
- Un módulo puede fallar sin tumbar el proceso: `server.js` envuelve cada reloj en `.catch(() => {})`.

## Mapa de módulos

| Módulo | Qué hace | Regla que protege |
|---|---|---|
| `sos/` | El protocolo de emergencia de 9 pasos. `diagnostico.js` (determinista), `evidencia.js` (guarda y enmascara antes de tocar), `escalada.js` (elige el siguiente peldaño), `limites.js` (presupuesto, enfriamiento, autobloqueo), `puede-actuar.js` (el único punto de decisión: ajeno → freno → permisos → horario → ventana → límites), `sos.js` (orquesta), `bus-sse.js` (consola en vivo), `db-centinela.js` (archivos locales, no MariaDB: si la base cae, el SOS tiene que poder registrar igual). | Nunca reinicia "a ver si se arregla". Rendirse es una respuesta válida. |
| `reglas-seguridad.js`, `permisos.js` | Freno de emergencia, horario comercial, permisos de lectura/escritura por categoría (10 áreas). | Nunca bloquean una acción manual del dueño; solo lo autónomo. Matar una consulta jamás tiene interruptor. |
| `auditoria360.js` | Corre en dos olas todas las fuentes (seguridad, base, capacidad, servicios, copias, tareas), consolida, califica de 1 a 10 por área, aplica solo lo seguro (`liberar_disco`), compara con la corrida anterior y avisa si empeoró. | Aplica solo lo reversible. |
| `seguridad-completa.js`, `seguridad-auditoria.js` | Auditoría de SSH, cortafuegos, actualizaciones, usuarios, permisos de archivos con contraseñas, Docker, dependencias, credenciales en el código; y la revisión rápida cada 5 minutos (certificado, puertos, intentos fallidos, deriva de Traefik). | `repararPermisoArchivo` solo acepta rutas de una lista fija. |
| `optimizacion-completa.js`, `db-optimizacion.js`, `db-procesos.js` | Diez revisiones de MariaDB (conexiones, buffer pool, motor y claves, fragmentación, recorridos completos, índices redundantes, crecimiento, memoria, bloqueos, sugerencias pendientes); sugerencias de índice a partir del registro de consultas lentas; acciones seguras (`aplicarIndice`, `cambiarMotorInnoDB`, `optimizarTabla`, `subirMaxConnections`, `reducirKeyBuffer`). | Solo `CREATE/DROP INDEX` y `ALTER TABLE ADD INDEX` pasan la expresión `RE_COMANDO_PERMITIDO`; nombres de tabla con `^[a-zA-Z0-9_]+$`; una sugerencia sobre una vista o una columna ya indexada no ofrece botón. |
| `vigia-tendencias.js` | Reglas deterministas sobre el historial (proyección de disco y memoria, p95 de CPU y carga, reinicios por contenedor). Cuando una dispara, la IA redacta el aviso. El dueño responde `util` o `ruido` y la sensibilidad de esa regla se ajusta. | La IA nunca decide si hay tendencia; solo la explica. |
| `memoria-incidentes.js`, `runbooks.js` | Aprende de las corridas del SOS y, cuando se rinde, sugiere una guía paso a paso. Nunca la ejecuta sola. | Sugerir ≠ ejecutar. |
| `latidos.js` | Cada tarea programada (respaldo, mantenimiento, prueba de restauración, auditorías…) manda una señal al terminar; si falta, el panel y WhatsApp lo dicen. | Un latido nunca puede hacer fallar la tarea real. |
| `contenedores/`, `despliegues/`, `observacion-despliegue.js`, `config-drift.js` | Reiniciar/detener con consola en vivo, historial; despliegue canario del bot con vuelta atrás; observación de las 24 h siguientes a un despliegue; deriva de la configuración de Traefik. | Contenedores ajenos: se muestran, no se tocan. |
| `simulacros/` | Seis fallas provocadas a propósito (muerte del bot, CPU, OOM, disco lleno, aislamiento de red, congelar la base) que se revierten solas, con PIN o palabra escrita. | Todo simulacro tiene vuelta atrás automática y "hombre muerto" al reiniciar. |
| `centinela-comandos.js`, `centinela-endpoint.js`, `bot-mudo.js`, `escalamiento.js`, `informe-semanal.js`, `kapso-y-modo.js` | El menú de 19 opciones de WhatsApp, las preguntas libres a la IA con el estado real del servidor como contexto, detección del bot mudo, reenvío de avisos graves a un técnico si el dueño no confirma, informe semanal, modo viaje y control de gasto de mensajes. | Las opciones que cambian algo piden confirmación (`sí`/PIN). |
| `resiliencia.js`, `log-clustering.js`, `explicador-hallazgos.js` | Swap efímero antes de operaciones pesadas, agrupado de patrones del registro del bot, explicación con IA de un hallazgo que Centinela no sabe reparar sola. | La explicación es texto; no genera comandos. |

## El panel

`public/app.js` habla solo con `/api/*`. Tres mecanismos de confirmación conviven y una prueba (`panel-confirmaciones.test.js`) los audita para que ningún botón de alto riesgo se quede sin uno:

1. Botones `data-accion="…" data-confirmar="PALABRA"` → `ejecutar()` abre el modal antes de `POST /api/accion`.
2. Manejadores propios (`[data-optim-aplicar]`, `[data-eliminar-indice]`, `[data-reparar-motor]`, `[data-optimizar-tabla]`, `[data-reparar-permiso]`, `[data-subir-conexiones]`, `[data-reducir-key-buffer]`) → llaman `abrirConfirmar(palabra, descripción, callback)`.
3. Simulacros → modal dedicado con su propia palabra.

Toda petición `POST` lleva el header `X-Panel-Zeus: 1` y un `Origin` igual a `PANEL_ORIGEN` (`csrfOk` / `esOrigenPermitido` en `server.js`).

## Persistencia

Todo vive en archivos JSON/JSONL bajo `/var/lib/zeus-ops` (`historial.jsonl`, `auditoria.jsonl`, `incidentes.json`, `permisos.json`, `sos-corridas.jsonl`, `centinela-db/` con la evidencia enmascarada…). Es una decisión: MariaDB es uno de los servicios que el SOS repara, así que no puede ser también donde el SOS anota lo que hace.

## Relojes

| Cuándo (UTC) | Qué | Dónde |
|---|---|---|
| cada 60 s | foto del servidor, incidentes, latidos, mantenimientos | `server.js` |
| cada 5 min | revisión rápida de seguridad, sincronizar memoria de incidentes | `server.js` |
| 11:00 | Auditoría 360 | `auditoria360.js` (`TAREA_LATIDO`) |
| 12:00 / 13:00 | auditoría de seguridad, resumen diario por WhatsApp | `server.js` |
| 14:00 | Vigía de tendencias | `vigia-tendencias.js` |
| lunes 12:00 | informe semanal | `informe-semanal.js` |
| cron del sistema | respaldo (08:00), mantenimiento (09:00), prueba de restauración (dom 10:00) | `scripts/` + `deploy/crontab.example` |

## Decisiones que conviene conocer antes de cambiar algo

- **`mysql()` no selecciona base por defecto.** Todo SQL lleva el esquema explícito (`${esquema()}` / `ESQUEMA`); sin él, MariaDB no encuentra la tabla y el error se pierde (`2>/dev/null`).
- **Los identificadores SQL entre backticks se escapan** antes de pasar por `bash -lc` (ver el comentario en `mysql()`): sin eso, Bash intenta ejecutar el nombre de la tabla como un comando.
- **`gestionado: true` en un contenedor significa "tiene política de reinicio"**, no "es nuestro". Lo nuestro es `CONTENEDORES_PROPIOS`.
- **Dos muestras distintas del registro de consultas lentas**: `estadoDatos()` (las 8 más lentas, vía `slowlog.awk`) alimenta las sugerencias de índice; `pasoEscaneos` lee hasta 8.000 líneas crudas. El hallazgo "consultas que recorren tablas enteras" verifica contra la primera antes de prometer un botón.
- **El heartbeat `verificacion_arranque` se dispara 3 minutos después de cada arranque del proceso**, no a una hora fija: si reinicias `zeus-ops` muchas veces en un día, el panel puede marcarlo como "sin señal" hasta el reinicio programado siguiente.

## Cómo extenderlo

- **Otro proveedor de WhatsApp:** reescribe `enviarWhatsapp` en `server.js` y `enviarAKapso` en el Worker.
- **Otra base de datos:** `db-optimizacion.js`, `optimizacion-completa.js` y `db-procesos.js` asumen MariaDB/MySQL (`information_schema`, `SHOW GLOBAL STATUS`). El resto no depende de la base.
- **Un módulo nuevo:** sigue el patrón fábrica, recibe deps, exporta funciones puras para probar, y si agrega una acción que cambia el servidor, pasa por `abrirConfirmar` en el panel y por `permisos.verificarEscritura` en la API.
