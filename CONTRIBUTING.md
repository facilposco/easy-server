# Cómo contribuir

Centinela Zeus es software libre (MIT) y se construye con una meta concreta: que un negocio pequeño tenga el criterio de un ingeniero de servidores senior sin tener que contratar uno. Toda contribución que acerque a esa meta es bienvenida: código, documentación, traducciones, casos de falla reales, reportes de errores.

## Antes de escribir código

Lee [CLAUDE.md](CLAUDE.md) (el protocolo SOS y las reglas que no se negocian) y [docs/ARQUITECTURA.md](docs/ARQUITECTURA.md). Hay decisiones de diseño que parecen arbitrarias y no lo son: el diagnóstico es determinista, la IA solo redacta, cada acción irreversible pide una palabra escrita, y Centinela nunca toca contenedores que no son suyos. Un cambio que rompa una de esas reglas no se acepta aunque funcione.

## Reglas de la casa

1. **Sin dependencias externas.** `server.js` y los módulos usan solo la librería estándar de Node 20. Si necesitas una librería, abre una discusión primero.
2. **Cada módulo recibe sus dependencias por parámetro** (`crearX({ sh, mysql, leerJson, ... })`). Nada lee el disco ni ejecuta comandos por su cuenta. Así todo se prueba con dobles en memoria.
3. **Pruebas con `node:test`.** Un cambio de lógica trae su prueba en `modulos/pruebas/` o `modulos/sos/pruebas/`. Corre `npm test` antes de abrir el PR: debe seguir en verde.
4. **Todo comando de shell o SQL que reciba texto de fuera se valida con una lista blanca o una expresión estricta.** Mira `db-optimizacion.js` (`RE_COMANDO_PERMITIDO`) o `seguridad-completa.js` (`repararPermisoArchivo`) como referencia.
5. **Toda acción que cambie el servidor y no sea reversible con un clic pide confirmación por palabra escrita** en el panel. La prueba `modulos/pruebas/panel-confirmaciones.test.js` falla si agregas un botón de alto riesgo sin ella.
6. **El texto que ve el dueño está en español claro, sin jerga.** Si una palabra exige saber Linux para entenderse, explícala en la misma frase.
7. **Nunca subas secretos.** Ni contraseñas, ni tokens, ni números de teléfono, ni IPs reales, ni dominios propios: usa `.env.example` y los marcadores `panel.ejemplo.com`, `negocio`, `57XXXXXXXXXX`.

## Flujo

1. Abre un issue describiendo el problema o la mejora (con el caso real si es una falla del servidor: qué pasó, qué debió pasar).
2. Haz un fork y una rama (`fix/nombre-corto` o `feat/nombre-corto`).
3. Cambia el código, agrega la prueba, corre `npm test` y `npm run check`.
4. Abre el PR explicando el **por qué**, no solo el qué. Si tocas el SOS, cita el paso del protocolo que afecta.

## Ideas abiertas donde se agradece ayuda

- Adaptadores para otros proveedores de WhatsApp (Twilio, 360dialog, Meta directo). Hoy el código de referencia usa Kapso; la lógica está aislada en `server.js` (`enviarWhatsapp`) y en `cloudflare-worker/worker.js` (`enviarAKapso`).
- Soporte para PostgreSQL además de MariaDB en las auditorías de base de datos.
- Traducciones del panel y de los textos de WhatsApp.
- Un flujo seguro de "reconstruir la imagen del bot y probarla antes de reemplazar la que atiende" para arreglar dependencias vulnerables con un clic.
- Tomar una foto (snapshot) del VPS antes de las acciones de mayor riesgo, con la API del proveedor.
