# Centinela Zeus — protocolo de emergencia (SOS)

Este archivo documenta el **protocolo estricto** que sigue Centinela cuando algo falla en el servidor. Es la regla de oro del proyecto: cualquier cambio al SOS tiene que respetar este orden.

Las reglas de cómo se desarrolla en este proyecto están en [CONTRIBUTING.md](CONTRIBUTING.md). La arquitectura completa, en [docs/ARQUITECTURA.md](docs/ARQUITECTURA.md).

**Si te pidieron instalar Centinela en un servidor, empieza por [AGENTS.md](AGENTS.md)**: pasos en orden, una comprobación después de cada uno y las reglas de seguridad de la instalación.

---

## El orden es el protocolo

Lo diseñó siguiendo lo que haría un ingeniero de servidores con experiencia. **Los tres primeros pasos no arreglan nada a propósito**, y ese es justamente el punto: actuar antes de entender es lo que convierte una falla pequeña en una caída larga.

| Orden | Paso | Por qué va ahí |
|---|---|---|
| 1 | **Diagnosticar** qué está roto y desde cuándo | Actuar a ciegas es cambiar repuestos sin revisar el carro |
| 2 | **Medir el impacto**: ¿afecta a clientes? | No es lo mismo que caiga el bot (clientes sin respuesta) a que falle algo interno |
| 3 | **Guardar la evidencia antes de tocar nada** | Reiniciar borra el rastro. Si reinicias primero, pierdes la causa para siempre y te vuelve a pasar |
| 4 | Reiniciar **solo** el servicio que falla | Lo menos invasivo que resuelve el caso más común |
| 5 | Si es falta de espacio o memoria, **liberar primero** | Reiniciar con el disco lleno no arregla nada: se cae otra vez en minutos |
| 6 | Si hay que reiniciar varios, **en orden de dependencia** | Base de datos → memoria de búsqueda → bot → puerta de entrada. Al revés provoca fallas nuevas |
| 7 | Si se rompió justo tras un cambio, **deshacerlo** | Si falló al subir una versión, el culpable es el cambio, no el servidor |
| 8 | **Reiniciar el servidor completo** | Último recurso: dos minutos caído y encima borra el rastro |
| 9 | **Confirmar que de verdad volvió** | "Encendido" no es lo mismo que "atendiendo" |

El paso 9 no es el final: se ejecuta **entre cada peldaño**. Después de cada acción se repite el diagnóstico completo, y solo si ya no hay síntomas se declara restablecido.

---

## Qué hace solo y qué no

El SOS es **autónomo**: con un solo comando diagnostica, guarda evidencia, repara y restablece. Pero la autonomía tiene frenos, porque un agente que repara solo y se equivoca hace más daño que uno que no existe.

**Hace solo, sin preguntar** (reversible, impacto bajo o medio):
- Liberar espacio en disco (sin borrar datos del negocio)
- Reiniciar un servicio propio
- Reiniciar varios en orden de dependencia

**Hace solo, pero con límite duro** (alto impacto):

| Acción | Por incidente | Enfriamiento | Por día | Se autobloquea |
|---|---|---|---|---|
| Reiniciar el servidor | 1 | 6 horas | 1 | Sí, hasta que una persona lo vuelva a permitir |
| Deshacer el último despliegue | 1 | 6 horas | 1 | Sí, igual |
| Reiniciar Docker | 1 | 6 horas | 2 | No |
| Reiniciar un servicio | 1 por corrida | 2 por hora | 8 | No |

**Nunca hace solo, bajo ninguna circunstancia:**
- Tocar los contenedores de otro proyecto (`otro-proyecto-a`, `otro-proyecto-c`, `otro-proyecto-b`)
- Borrar datos, volúmenes o copias de seguridad
- Matar consultas de la base de datos
- Cualquier cosa irreversible

**Se detiene y pide una persona cuando:**
- No logra diagnosticar (nunca reinicia "a ver si se arregla")
- Agotó su presupuesto de acciones (4 acciones o 10 minutos por corrida)
- La acción que tocaba está bloqueada o en enfriamiento
- El culpable es un contenedor ajeno
- Tras reparar, el servicio sigue sin atender

---

## Dónde queda el registro

Todo lo que hace el SOS se guarda en la **base de datos de Centinela**: `/var/lib/zeus-ops/centinela-db/`.

Son archivos locales, **no MariaDB**, y es una decisión deliberada: MariaDB es uno de los servicios que el SOS tiene que reparar. Si la base está caída, el SOS no podría ni registrar lo que está haciendo, que es exactamente cuando más falta hace.

La evidencia se **enmascara antes de escribirse a disco**, no después, porque el dueño la va a copiar y pegar fuera del servidor para pedir ayuda.

Se consulta desde el panel, en la sección **Registros**: ver, copiar y borrar.

---

## Cómo se invoca

| Desde | Cómo |
|---|---|
| Panel web | Sección **SOS**, la primera de todas. Consola en vivo con el paso a paso |
| WhatsApp | `/centinela sos`, o la opción **1** del menú |

En ambos casos muestra lo mismo: qué falló, qué hizo y si el sistema quedó bien.

---

## Reglas que no se negocian

1. **El diagnóstico es determinista.** Se basa en datos reales y umbrales numéricos, nunca en lo que opine el modelo de IA. La IA solo redacta o aporta hipótesis, y el SOS tiene que funcionar igual si no responde o si se agotó el tope diario de consultas.
2. **La evidencia se guarda antes de reparar.** Sin excepción.
3. **Verificación entre cada peldaño.** No se escala al siguiente sin comprobar si el anterior funcionó.
4. **Una sola causa primero.** Si hay varios síntomas, se ataca la causa, no el síntoma: disco lleno y bot caído significa arreglar el disco.
5. **Rendirse es una respuesta válida.** Mejor detenerse y avisar con claridad que reintentar en bucle.

---

## Capa de seguridad sobre lo autónomo (agregada 12 sept. 2026)

Se suma a los límites que ya existen (`modulos/sos/limites.js`: presupuesto de acciones, enfriamiento, autobloqueo) — no los reemplaza. Vive en `modulos/reglas-seguridad.js` y `modulos/permisos.js`, y se consulta desde un único punto: al principio de `ejecutarPeldano()` en `modulos/sos/sos.js`, antes de cualquier paso de reparación.

**Nunca bloquea una acción manual** (un botón que un humano pulsa en el panel) — solo lo que Centinela decide y ejecuta por su cuenta. Las únicas excepciones manuales que sí se gatean con permisos son 4 acciones de alto riesgo (reiniciar el servidor, instalar actualizaciones del sistema, aplicar un índice de base de datos, lanzar un simulacro): ahí el permiso protege incluso al dueño de un clic accidental, porque el daño potencial es alto.

- **Freno de emergencia** — un interruptor único: activo, Centinela diagnostica y avisa pero no repara nada sola, hasta que una persona lo apague desde **Permisos**. Se controla desde el panel.
- **Horario comercial** — se aplica solo al paso más disruptivo del SOS (reiniciar el servidor completo). Si el bot sigue atendiendo de alguna forma y estamos en horario de atención, espera en vez de forzar un corte de servicio; ante una caída total, procede igual que siempre.
- **Permisos por categoría** — 10 áreas (contenedores, base de datos, servidor, despliegues, disco, actualizaciones, WhatsApp, simulacros, IA, SOS), cada una con `lectura` (vigilar) y `escritura` (reparar sola) independientes. Todo empieza en `true`: nada cambia hasta que el dueño apague algo a propósito. "Matar una consulta trabada" nunca tiene interruptor — sigue prohibido siempre, sin excepción, esté lo que esté configurado en Permisos.

Se controla todo desde la sección **Permisos** del panel (`panel.ejemplo.com/permisos`).
