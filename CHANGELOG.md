# Historial de versiones

## 1.0.0 — 2026-09-14 · Primera versión estable

Primera publicación pública de Centinela Zeus como software libre (MIT).

Incluye todo lo que corre en producción hoy en un VPS real con Docker:

- **Protocolo SOS** de 9 pasos (diagnosticar → medir impacto → guardar evidencia → reparar de menor a mayor → verificar entre cada paso), con límites duros, enfriamiento y autobloqueo.
- **Panel web** de 13 secciones, sin frameworks, con confirmación por palabra escrita para toda acción irreversible, y diseño móvil.
- **Menú de WhatsApp** de 19 opciones para diagnosticar y reparar desde el celular.
- **Auditoría 360** diaria (seguridad, base de datos, capacidad, servicios, copias, tareas) con nota de 1 a 10 por área.
- **Auditoría de seguridad** (SSH, cortafuegos, actualizaciones, usuarios, permisos de archivos, Docker, dependencias, credenciales en el código) y **auditoría de base de datos** (10 revisiones) con botones de arreglo real donde es seguro.
- **Vigía de tendencias** con reglas deterministas y avisos redactados por IA; **memoria de incidentes** que sugiere guías paso a paso.
- **Latidos** de tareas programadas, **simulacros** de caída controlados, **respaldo diario** verificado y **prueba semanal de restauración** en un contenedor descartable.
- **Vigilante externo** en Cloudflare Workers (avisa aunque el servidor esté apagado) y proxy para Gemini.
- 180 pruebas automáticas (`npm test`).
