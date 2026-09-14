"use strict";
/**
 * modulos/vigia-tendencias.js
 *
 * Centinela Zeus — Módulo B del diseño "Auditoría 360, Vigía de tendencias y
 * Memoria de incidentes" (DISENO-AUDITORIA360-PROACTIVA.md §2, Fable 5.1,
 * 13 sept. 2026). Una vez al día evalúa reglas 100% deterministas sobre datos
 * que el servidor ya guarda (regla 1 del SOS en CLAUDE.md: nunca opinión de
 * IA). Si ninguna regla dispara, no llama a la IA ni manda nada — solo deja
 * constancia. Si alguna dispara, la IA se usa ÚNICAMENTE para redactar el
 * texto en español llano (nunca para decidir si avisar), con plantilla de
 * respaldo si no hay IA o se agotó el cupo.
 *
 * Tres reglas, las tres verificadas contra §0 del diseño:
 *   - proyeccion_disco / proyeccion_memoria: prediccion().pronosticos.
 *   - p95_cpu / p95_carga: F_HIST (historial.jsonl), percentil 95 sobre una
 *     línea base de 27 días comparado con la media de los últimos 3.
 *   - reinicios_<contenedor>: F_AUDIT (auditoria.jsonl), eventos die/kill/oom,
 *     excluyendo el reinicio programado de zeus-bot.
 * La cuarta fuente que el diseño evaluó ("errores de log por hora") queda
 * FUERA a propósito: §2.2 del diseño concluye que no existe hoy una fuente
 * fiable para eso. No se implementa aquí.
 *
 * Aislado a propósito: nada de aquí corre solo. Nunca hace `require` de
 * ops-server.js; recibe todo por inyección de dependencias, mismo patrón de
 * bajo acoplamiento que `informe-semanal.js`, `latidos.js` y `bot-mudo.js` —
 * hasta que `ops-server.js` construye este módulo y lo engancha a un
 * `setInterval` (ver `INTEGRACION-VIGIA.md`).
 *
 * Diseño vinculante: los contratos (nombres de función, forma de los datos,
 * fábrica, exportaciones, tabla de ajuste por feedback) no se cambian por
 * iniciativa propia. Donde el diseño deja un grado de libertad o una
 * ambigüedad, la decisión tomada queda anotada aquí mismo, junto al punto
 * exacto, y resumida otra vez en `INTEGRACION-VIGIA.md` para que quien
 * integre la verifique contra el `ops-server.js` real.
 *
 * Cero dependencias externas: solo `node:path`.
 */

const path = require("path");

// ── Constantes ───────────────────────────────────────────────────────────

const MAX_HIST = 43200; // F_HIST: 30 días a 1 muestra/min (§0 del diseño)

// Lista de respaldo cuando `insumos.contenedoresPropios` no llega (p. ej.
// pruebas viejas que no la pasan): los mismos 4 nombres que usan sos.js y
// auditoria360.js. La fábrica real (crearVigia) SIEMPRE la pasa de forma
// explícita — ver el fix de "gestionado no es propio" más abajo.
const CONTENEDORES_PROPIOS_DEFECTO = ["zeus-mariadb", "zeus-chromadb", "zeus-bot", "zeus-proxy"];
const MAX_AUDIT = 20000; // F_AUDIT: tope de líneas a inspeccionar (§2.2, §2.11)
const MAX_AVISOS = 200; // recorte de avisos guardados (§2.9)
const MS_48H = 48 * 3600000;
const MS_7D = 7 * 86400000;
const RESULTADOS_REINICIO = new Set(["die", "kill", "oom"]);

const TAREA_LATIDO = {
  id: "vigia_tendencias",
  nombre_llano: "Vigía de tendencias",
  periodo: "diaria",
  hora_utc: 14,
  minuto_utc: 0,
  gracia_min: 20,
  nivel: "warn",
  origen: "interno",
};

// Tabla estática de las 4 reglas "de nombre fijo" (§2.2). Las de
// `reinicios_<contenedor>` son dinámicas (una por contenedor propio, según
// `estadoGeneral().contenedores[].gestionado`, §0) y no tienen entrada aquí:
// se identifican por el prefijo "reinicios_".
const REGLAS = {
  proyeccion_disco: { familia: "proyeccion", recurso: "Disco", nombre: "Proyección de disco" },
  proyeccion_memoria: { familia: "proyeccion", recurso: "Memoria", nombre: "Proyección de memoria" },
  p95_cpu: { familia: "p95", campo: "cpu", nombre: "Uso alto de CPU" },
  p95_carga: { familia: "p95", campo: "carga", nombre: "Carga alta del sistema" },
};

// ── Ajuste por feedback (§2.5) — tiers/factores/mínimos exactos de la tabla.
// Nivel 3 ("silenciada") reutiliza el umbral del nivel 2 para poder seguir
// EVALUANDO la condición (así se puede "registrar sin mandar", §2.5) — el
// filtro real de silenciado se aplica aparte, en `revisar()`, no aquí.
const TABLA_TIERS_PROYECCION = [[14, 7, 3], [7, 3], [3], [3]];
const TABLA_FACTOR_P95 = [1.00, 1.15, 1.30, 1.30];
const TABLA_MINIMO_REINICIOS = [3, 5, 8, 8];

function clampNivel(nivel) {
  const n = Number.isFinite(nivel) ? nivel : 0;
  return Math.max(0, Math.min(3, n));
}
function tiersActivos(nivel) { return TABLA_TIERS_PROYECCION[clampNivel(nivel)]; }
function factorP95(nivel) { return TABLA_FACTOR_P95[clampNivel(nivel)]; }
function minimoReinicios(nivel) { return TABLA_MINIMO_REINICIOS[clampNivel(nivel)]; }
function esSilenciada(nivel) { return clampNivel(nivel) >= 3; }

function nivelDe(ajustes, id) {
  return (ajustes && ajustes[id] && typeof ajustes[id].nivel === "number") ? ajustes[id].nivel : 0;
}

// ── p95 (§2.2, §2.12 prueba 1) — percentil por interpolación simple sobre un
// array ordenado: índice floor(0.95·n), exactamente como dice el diseño. ───

function p95(valores) {
  const nums = (Array.isArray(valores) ? valores : [])
    .filter((v) => typeof v === "number" && Number.isFinite(v))
    .slice()
    .sort((a, b) => a - b);
  if (!nums.length) return null;
  const idx = Math.min(nums.length - 1, Math.floor(0.95 * nums.length));
  return nums[idx];
}

// ── Agrupación por día UTC (§2.2, §2.12 prueba 2) — descarta el día en curso:
// no tiene sentido comparar un día a medias contra días completos. ────────

function claveDiaUTC(tsMs) {
  const d = new Date(tsMs);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function agruparPorDiaUTC(muestras, campo, ahoraMs) {
  const hoy = claveDiaUTC(ahoraMs);
  const porDia = new Map();
  for (const m of muestras || []) {
    if (!m || typeof m.t !== "number" || typeof m[campo] !== "number") continue;
    const dia = claveDiaUTC(m.t * 1000);
    if (dia === hoy) continue;
    if (!porDia.has(dia)) porDia.set(dia, []);
    porDia.get(dia).push(m[campo]);
  }
  return porDia;
}

function mediaDiaria(muestras, campo, ahoraMs) {
  const porDia = agruparPorDiaUTC(muestras, campo, ahoraMs);
  return Array.from(porDia.entries())
    .map(([dia, valores]) => ({ dia, media: valores.reduce((a, b) => a + b, 0) / valores.length, n: valores.length }))
    .sort((a, b) => (a.dia < b.dia ? -1 : a.dia > b.dia ? 1 : 0));
}

/**
 * Evalúa la regla p95_cpu / p95_carga (§2.2): últimos 3 días completos
 * (media diaria de cada uno) contra el p95 de la línea base (muestras por
 * minuto de los días más viejos que esos 3, mínimo 7 días y 5000 muestras).
 * Decisión de implementación (no fijada literalmente por el diseño): en vez
 * de contar calendario "-4 a -30" de forma rígida, la línea base es "todos
 * los días observados más allá de los 3 más recientes" — con F_HIST
 * muestreado cada minuto sin huecos, esto da el mismo resultado que contar
 * offsets de calendario, y es robusto a que el historial tenga menos de 30
 * días o algún hueco por caída del servidor. Ver INTEGRACION-VIGIA.md.
 */
function evaluarP95Regla(muestrasHist, campo, nivel, ahoraMs) {
  const grupos = agruparPorDiaUTC(muestrasHist, campo, ahoraMs);
  const diasDesc = Array.from(grupos.keys()).sort().reverse(); // más reciente primero
  if (diasDesc.length < 3) return { sinDatos: true };

  const mediaDia = (dia) => { const vs = grupos.get(dia); return vs.reduce((a, b) => a + b, 0) / vs.length; };
  const ultimos3 = diasDesc.slice(0, 3);
  const medias = ultimos3.map(mediaDia).reverse(); // cronológico, más antiguo primero

  const diasBase = diasDesc.slice(3);
  if (diasBase.length < 7) return { sinDatos: true };
  let baseline = [];
  for (const dia of diasBase) baseline = baseline.concat(grupos.get(dia));
  if (baseline.length < 5000) return { sinDatos: true };

  const p95v = p95(baseline);
  const factor = factorP95(nivel);
  const disparo = medias.every((m) => m > p95v * factor);
  return { sinDatos: false, disparo, datos: { medias, p95: p95v, factor, dias_base: diasBase.length } };
}

/** El tier "activo más ajustado" que dias satisface: el menor tier >= dias
 * entre los tiers activos (§2.2: dias 12 -> tier 14; dias 6 -> tier 7). */
function tierProyeccion(dias, tiers) {
  if (dias == null) return null;
  const candidatos = (tiers || []).filter((t) => dias <= t).sort((a, b) => a - b);
  return candidatos.length ? candidatos[0] : null;
}

// ── reinicios_<contenedor> (§2.2, §2.12 pruebas 5-6) ──────────────────────

/** Mismo patrón que `esReinicioBotProgramado` de ops-server.js (no importado:
 * este módulo nunca hace require de ops-server.js — se reimplementa aquí,
 * como pide la tarea): ¿el evento cae a ±10 minutos de HORA_REINICIO_UTC:00? */
function esReinicioBotProgramado(tsIso, horaReinicioUtc) {
  const ms = new Date(tsIso).getTime();
  if (Number.isNaN(ms)) return false;
  const d = new Date(ms);
  const minutosDia = d.getUTCHours() * 60 + d.getUTCMinutes();
  const objetivo = ((typeof horaReinicioUtc === "number" ? horaReinicioUtc : 9) * 60) % 1440;
  const diff = Math.abs(minutosDia - objetivo);
  return Math.min(diff, 1440 - diff) <= 10;
}

/**
 * Cuenta eventos die/kill/oom de `contenedor` en la semana actual (7 días) y
 * la anterior (7-14 días), excluyendo el reinicio programado de zeus-bot.
 * `eventos` es el `leerJsonl(F_AUDIT, ...)` completo (no solo los del
 * contenedor): se usa para decidir cobertura de 14 días con la línea más
 * vieja LEÍDA, tal como dice §2.2 ("si la línea más vieja leída es posterior
 * a hace 14 días -> sin_datos").
 */
function contarReinicios(eventos, contenedor, horaReinicioUtc, ahoraMs) {
  const lista = Array.isArray(eventos) ? eventos : [];
  const sinDatos = !(lista.length && (ahoraMs - new Date(lista[0].ts).getTime()) >= 14 * 86400000);

  const haceUnaSemana = ahoraMs - 7 * 86400000;
  const haceDosSemanas = ahoraMs - 14 * 86400000;
  let esta = 0;
  let anterior = 0;
  for (const e of lista) {
    if (!e || e.accion !== "evento_docker" || !RESULTADOS_REINICIO.has(e.resultado) || e.detalle !== contenedor) continue;
    if (contenedor === "zeus-bot" && esReinicioBotProgramado(e.ts, horaReinicioUtc)) continue;
    const t = new Date(e.ts).getTime();
    if (Number.isNaN(t)) continue;
    if (t >= haceUnaSemana && t <= ahoraMs) esta++;
    else if (t >= haceDosSemanas && t < haceUnaSemana) anterior++;
  }
  return { esta, anterior, sinDatos };
}

// ── evaluarReglas (§2.2) — pura: recibe los insumos ya leídos, nunca hace E/S.
//
// insumos = {
//   prediccion:       resultado de prediccion(), o null si prediccion() lanzó
//                      (§2.11: "prediccion() lanza -> proyeccion_* = sin_datos").
//                      OJO: distinto de un pronóstico con dias:null (eso NO
//                      es sin_datos, es "no hay suficiente historial todavía"
//                      y simplemente no dispara — "primer mes casi mudo").
//   estadoGeneral:    resultado de estadoGeneral(), o null si falló.
//   muestrasHist:     leerJsonl(F_HIST, 43200).
//   eventosAudit:     leerJsonl(F_AUDIT, 20000).
//   horaReinicioUtc:  número (HORA_REINICIO_UTC).
// }
// ajustes = { <reglaId>: { nivel, ruido_seguidos } } (estado.json).
// ──────────────────────────────────────────────────────────────────────────

function evaluarReglas(insumos, ajustes, ahoraMs) {
  const datos = insumos || {};
  const disparadas = [];
  const sinDatos = [];

  // proyeccion_disco / proyeccion_memoria
  const pred = datos.prediccion;
  const estG = datos.estadoGeneral;
  if (!pred || !Array.isArray(pred.pronosticos)) {
    sinDatos.push("proyeccion_disco", "proyeccion_memoria");
  } else {
    const pronDisco = pred.pronosticos.find((p) => p && p.recurso === "Disco");
    if (pronDisco && pronDisco.dias != null) {
      const tier = tierProyeccion(pronDisco.dias, tiersActivos(nivelDe(ajustes, "proyeccion_disco")));
      if (tier != null) {
        disparadas.push({
          id: "proyeccion_disco",
          clave: `proyeccion_disco:${tier}`,
          datos: { pct: estG && estG.disco ? estG.disco.pct : null, ritmo: pronDisco.ritmo, dias: pronDisco.dias, tier },
        });
      }
    }
    const pronMem = pred.pronosticos.find((p) => p && p.recurso === "Memoria");
    if (pronMem && pronMem.dias != null && pronMem.cortado !== true) {
      const tier = tierProyeccion(pronMem.dias, tiersActivos(nivelDe(ajustes, "proyeccion_memoria")));
      if (tier != null) {
        disparadas.push({
          id: "proyeccion_memoria",
          clave: `proyeccion_memoria:${tier}`,
          datos: {
            pct: estG && estG.ram ? estG.ram.pct : null, ritmo: pronMem.ritmo, dias: pronMem.dias, tier,
            arranque: estG ? estG.arranque : null,
          },
        });
      }
    }
  }

  // p95_cpu / p95_carga
  for (const [id, campo] of [["p95_cpu", "cpu"], ["p95_carga", "carga"]]) {
    if (!Array.isArray(datos.muestrasHist) || !datos.muestrasHist.length) { sinDatos.push(id); continue; }
    const r = evaluarP95Regla(datos.muestrasHist, campo, nivelDe(ajustes, id), ahoraMs);
    if (r.sinDatos) { sinDatos.push(id); continue; }
    if (r.disparo) disparadas.push({ id, clave: id, datos: r.datos });
  }

  // reinicios_<contenedor> — contenedores propios. `gestionado` (§0) marca
  // "tiene política de reinicio", NO "es de este proyecto": un contenedor de
  // otro proyecto (otro-proyecto-a, otro-proyecto-c...) en el mismo host también sale
  // gestionado:true. Por eso se exige la lista explícita `contenedoresPropios`
  // (nombres) vía `insumos`; sin ella no se evalúa ninguna regla de reinicios
  // (mejor "sin datos" que avisar sobre un contenedor ajeno).
  const propios = Array.isArray(datos.contenedoresPropios) ? datos.contenedoresPropios : CONTENEDORES_PROPIOS_DEFECTO;
  const contenedores = (estG && Array.isArray(estG.contenedores))
    ? estG.contenedores.filter((c) => c && propios.indexOf(c.nombre) !== -1)
    : [];
  for (const c of contenedores) {
    const r = contarReinicios(datos.eventosAudit || [], c.nombre, datos.horaReinicioUtc, ahoraMs);
    const id = `reinicios_${c.nombre}`;
    if (r.sinDatos) { sinDatos.push(id); continue; }
    const minimo = minimoReinicios(nivelDe(ajustes, id));
    if (r.esta >= minimo && r.esta > r.anterior) {
      disparadas.push({ id, clave: id, datos: { esta: r.esta, anterior: r.anterior, contenedor: c.nombre } });
    }
  }

  return { disparadas, sinDatos };
}

// ── evaluarAviso (§2.8) — pura: evaluación a 48 h de un aviso ya enviado. ──
//
// `regla` = una entrada de `aviso.reglas` ({id, clave, datos}).
// `ctx` = {
//   pctActual, arranqueActual: valores ACTUALES (§2.8) de estadoGeneral();
//   muestrasVentana: valores crudos de F_HIST dentro de las 48 h siguientes al aviso (p95_*);
//   eventosVentana:  cuenta de die/kill/oom del contenedor en esas 48 h (reinicios_*);
//   coberturaVentana: bool — ¿hay datos que cubran esa ventana?
// }
// ────────────────────────────────────────────────────────────────────────

function evaluarAviso(regla, ctx) {
  const c = ctx || {};
  const id = regla && regla.id;
  const rdatos = (regla && regla.datos) || {};

  if (id === "proyeccion_disco" || id === "proyeccion_memoria") {
    if (id === "proyeccion_memoria" && rdatos.arranque && c.arranqueActual && c.arranqueActual !== rdatos.arranque) {
      return { resultado: "sin_datos", detalle: "el servidor se reinició después del aviso" };
    }
    if (!c.coberturaVentana) return { resultado: "sin_datos", detalle: "sin muestras en las 48 h siguientes" };
    if (c.pctActual == null) return { resultado: "sin_datos", detalle: "sin dato actual" };
    return c.pctActual > rdatos.pct
      ? { resultado: "acerto", detalle: `${c.pctActual}% ahora vs ${rdatos.pct}% en el aviso` }
      : { resultado: "fallo", detalle: `${c.pctActual}% ahora vs ${rdatos.pct}% en el aviso` };
  }

  if (id === "p95_cpu" || id === "p95_carga") {
    if (!c.coberturaVentana || !c.muestrasVentana || !c.muestrasVentana.length) {
      return { resultado: "sin_datos", detalle: "sin muestras en las 48 h siguientes" };
    }
    const media = c.muestrasVentana.reduce((a, b) => a + b, 0) / c.muestrasVentana.length;
    return media > rdatos.p95
      ? { resultado: "acerto", detalle: `media ${media.toFixed(1)} > p95 ${rdatos.p95}` }
      : { resultado: "fallo", detalle: `media ${media.toFixed(1)} <= p95 ${rdatos.p95}` };
  }

  if (typeof id === "string" && id.indexOf("reinicios_") === 0) {
    if (!c.coberturaVentana) return { resultado: "sin_datos", detalle: "el registro de auditoría no cubre esas 48 h" };
    return (c.eventosVentana || 0) >= 1
      ? { resultado: "acerto", detalle: `${c.eventosVentana} evento(s) en las 48 h siguientes` }
      : { resultado: "fallo", detalle: "0 eventos en las 48 h siguientes" };
  }

  return { resultado: "sin_datos", detalle: "regla desconocida" };
}

// ── aplicarFeedback (§2.5) — pura ─────────────────────────────────────────

function aplicarFeedback(ajustes, reglaId, valor) {
  const actual = (ajustes && ajustes[reglaId]) || { nivel: 0, ruido_seguidos: 0 };
  let nivel = actual.nivel || 0;
  let ruido_seguidos = actual.ruido_seguidos || 0;
  if (valor === "ruido") {
    ruido_seguidos += 1;
    if (ruido_seguidos >= 3) { nivel = Math.min(3, nivel + 1); ruido_seguidos = 0; }
  } else if (valor === "util") {
    ruido_seguidos = 0;
    nivel = Math.max(0, nivel - 1);
  }
  return { ...(ajustes || {}), [reglaId]: { nivel, ruido_seguidos } };
}

// ── Textos (§2.6, §2.7) — plantilla determinista y ensamblado del mensaje ──

function formatearNumero(n, decimales) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "?";
  return n.toFixed(decimales == null ? 1 : decimales).replace(".", ",");
}

function promedioMedias(medias) {
  if (!Array.isArray(medias) || !medias.length) return null;
  return medias.reduce((a, b) => a + b, 0) / medias.length;
}

/** Frase en español llano por regla, para el cuerpo del mensaje cuando no
 * hay IA (o no hay cupo). La IA, cuando se usa, reemplaza este texto pero
 * nunca el encabezado ni el bloque de datos (§2.6: "la IA solo escribe"). */
function fraseRegla(d) {
  const dt = (d && d.datos) || {};
  if (d.id === "proyeccion_disco") {
    return `El disco viene llenándose a un ritmo de ${formatearNumero(dt.ritmo)} puntos por día; si sigue así, en unos ${dt.dias} días llega al 90 % y los servicios dejan de escribir.`;
  }
  if (d.id === "proyeccion_memoria") {
    return `La memoria viene subiendo a un ritmo de ${formatearNumero(dt.ritmo)} puntos por día; si sigue así, en unos ${dt.dias} días se queda sin memoria disponible.`;
  }
  if (d.id === "p95_cpu") {
    return `El uso de CPU lleva 3 días seguidos por encima de lo normal (promedio ${formatearNumero(promedioMedias(dt.medias))} % frente a lo habitual); vale la pena revisar qué está consumiendo tanto.`;
  }
  if (d.id === "p95_carga") {
    return `La carga del sistema lleva 3 días seguidos por encima de lo normal; vale la pena revisar qué le está exigiendo tanto al servidor.`;
  }
  if (typeof d.id === "string" && d.id.indexOf("reinicios_") === 0) {
    const vez = dt.esta === 1 ? "vez" : "veces";
    return `${dt.contenedor} se reinició ${dt.esta} ${vez} esta semana (la anterior, ${dt.anterior}): algo la está tumbando y vale la pena revisar por qué antes de que pase en horario de atención.`;
  }
  return "Hay una tendencia que conviene revisar.";
}

function textoPlantilla(disparadas) {
  const lista = Array.isArray(disparadas) ? disparadas : [];
  if (!lista.length) return "";
  return lista.map(fraseRegla).join(" ");
}

function lineaDato(d) {
  const dt = (d && d.datos) || {};
  if (d.id === "proyeccion_disco" || d.id === "proyeccion_memoria") {
    const nombre = d.id === "proyeccion_disco" ? "Disco" : "Memoria";
    const pctTxt = dt.pct != null ? dt.pct : "?";
    return `• ${nombre}: ${pctTxt} % hoy, +${formatearNumero(dt.ritmo)} % al día, llega al 90 % en ${dt.dias} días.`;
  }
  if (d.id === "p95_cpu" || d.id === "p95_carga") {
    const nombre = d.id === "p95_cpu" ? "CPU" : "Carga del sistema";
    return `• ${nombre}: promedio de los últimos 3 días ${formatearNumero(promedioMedias(dt.medias))}, contra un habitual de ${formatearNumero(dt.p95)}.`;
  }
  if (typeof d.id === "string" && d.id.indexOf("reinicios_") === 0) {
    return `• Reinicios de ${dt.contenedor}: ${dt.esta} esta semana, ${dt.anterior} la anterior.`;
  }
  return `• ${d.id}`;
}

const LINEA_FEEDBACK = "¿Te sirvió? Responde /centinela util o /centinela ruido";

function encabezado(n) {
  return n === 1 ? "Vigía de tendencias — 1 cosa que conviene mirar" : `Vigía de tendencias — ${n} cosas que conviene mirar`;
}

/** Ensambla el mensaje final: encabezado determinista + texto (IA o
 * plantilla) + bloque de datos determinista + línea de feedback (§2.6). No
 * exportada: no es parte de la lista de funciones puras del diseño, pero se
 * apoya en `textoPlantilla` que sí lo es. */
function construirMensaje(disparadas, cuerpo) {
  return [
    encabezado(disparadas.length), "", cuerpo, "", "Datos:", ...disparadas.map(lineaDato), "", LINEA_FEEDBACK,
  ].join("\n");
}

// ── Fábrica ─────────────────────────────────────────────────────────────

/**
 * @param {Object}   deps
 * @param {string}   deps.DIR_DATOS        "/var/lib/zeus-ops"                        — OBLIGATORIA
 * @param {Function} deps.leerJson         leerJson(archivo, porDefecto)              — OBLIGATORIA
 * @param {Function} deps.guardarJson      guardarJson(archivo, obj)                  — OBLIGATORIA
 * @param {Function} deps.anexar           anexar(archivo, obj) — validada por contrato
 *   (§2.3 la lista como obligatoria); esta implementación guarda los avisos como un
 *   arreglo JSON completo vía leerJson/guardarJson (ver nota en INTEGRACION-VIGIA.md
 *   sobre por qué, y por eso `anexar` no se llama en el cuerpo del módulo)   — OBLIGATORIA
 * @param {Function} deps.leerJsonl        leerJsonl(archivo, max)                    — OBLIGATORIA
 * @param {Function} deps.auditar          auditar(accion, quien, resultado, detalle) — OBLIGATORIA
 * @param {Function} deps.enviarWhatsapp   enviarWhatsapp(texto) async → {ok, detalle} — OBLIGATORIA
 * @param {Function} deps.prediccion       prediccion() → {..., pronosticos:[...]}    — OBLIGATORIA
 * @param {Function} deps.estadoGeneral    estadoGeneral() → {ram, disco, contenedores, arranque, ...} — OBLIGATORIA
 * @param {string}   deps.F_HIST           ruta a historial.jsonl                     — OBLIGATORIA
 * @param {string}   deps.F_AUDIT          ruta a auditoria.jsonl                     — OBLIGATORIA
 * @param {number}   [deps.HORA_REINICIO_UTC]  por defecto 9
 * @param {Function} [deps.preguntarAGemini]     preguntarAGemini(persona, contexto, pregunta, {maxOutputTokens})
 * @param {Function} [deps.registrarConsultaIA]  registrarConsultaIA() → {permitido, restantes}
 * @param {Function} [deps.leerPersonaCentinela] leerPersonaCentinela() → string
 *   (si falta cualquiera de estas 3, siempre se usa la plantilla, nunca se llama a la IA)
 * @param {Object}   [deps.permisos]     crearPermisos(...): permisos.permitido(id, tipo)
 * @param {Object}   [deps.kapsoYModo]   require("./modulos/kapso-y-modo.js")
 * @param {string}   [deps.F_MODO]       path.join(DIR_DATOS, "modo.json")
 * @param {Object}   [deps.latidos]      crearLatidos(...): latidos.registrar(id, resultado, quien)
 * @param {Function} [deps.ahora]        () => ms epoch; por defecto Date.now — solo para pruebas
 */
function crearVigia(deps) {
  const d = deps || {};
  const { DIR_DATOS, leerJson, guardarJson, anexar, leerJsonl, auditar, enviarWhatsapp, prediccion, estadoGeneral, F_HIST, F_AUDIT } = d;

  if (!DIR_DATOS || typeof leerJson !== "function" || typeof guardarJson !== "function"
    || typeof anexar !== "function" || typeof leerJsonl !== "function" || typeof auditar !== "function") {
    throw new Error("crearVigia necesita DIR_DATOS, leerJson, guardarJson, anexar, leerJsonl y auditar de ops-server.js");
  }
  if (typeof enviarWhatsapp !== "function" || typeof prediccion !== "function" || typeof estadoGeneral !== "function") {
    throw new Error("crearVigia necesita enviarWhatsapp(), prediccion() y estadoGeneral() de ops-server.js");
  }
  if (!F_HIST || !F_AUDIT) throw new Error("crearVigia necesita F_HIST y F_AUDIT de ops-server.js");

  const HORA_REINICIO_UTC = typeof d.HORA_REINICIO_UTC === "number" ? d.HORA_REINICIO_UTC : 9;
  const preguntarAGemini = typeof d.preguntarAGemini === "function" ? d.preguntarAGemini : null;
  const registrarConsultaIA = typeof d.registrarConsultaIA === "function" ? d.registrarConsultaIA : null;
  const leerPersonaCentinela = typeof d.leerPersonaCentinela === "function" ? d.leerPersonaCentinela : null;
  const permisos = d.permisos || null;
  const kapsoYModo = d.kapsoYModo || null;
  const F_MODO = d.F_MODO || null;
  const latidos = d.latidos || null;
  const contenedoresPropios = Array.isArray(d.contenedoresPropios) ? d.contenedoresPropios : CONTENEDORES_PROPIOS_DEFECTO;
  const ahoraFn = typeof d.ahora === "function" ? d.ahora : () => Date.now();

  const RUTA_ESTADO = path.join(DIR_DATOS, "vigia", "estado.json");
  // Decisión de implementación: el diseño (§2.9) llama a este archivo
  // "avisos.jsonl", pero este módulo necesita reescribir líneas EXISTENTES
  // (marcar evaluacion a las 48 h, marcar feedback) y no solo agregar al
  // final — algo que las dependencias inyectadas `anexar`/`leerJsonl`
  // (agregar una línea / leer la cola) no permiten sin depender de `fs`
  // directamente (rompiendo la posibilidad de probar con fakes, igual que el
  // resto de la batería de pruebas del proyecto). Se guarda como un arreglo
  // JSON completo en `avisos.json`, vía `leerJson`/`guardarJson` (mismas
  // dependencias que ya usa el resto del proyecto para archivos que se
  // reescriben enteros, p. ej. `latidos.json`). Mismo contenido y mismo tope
  // de 200 entradas que pedía el diseño — solo cambia el nombre/formato del
  // archivo en disco. Ver INTEGRACION-VIGIA.md.
  const RUTA_AVISOS = path.join(DIR_DATOS, "vigia", "avisos.json");

  // ── estado.json ──────────────────────────────────────────────────────

  function estadoVacio() {
    return { version: 1, ajustes: {}, ultima_corrida: null, ultima_corrida_diaria: null, dias_historial: null };
  }
  function leerEstadoArchivo() {
    const e = leerJson(RUTA_ESTADO, null);
    if (!e || typeof e !== "object") return estadoVacio();
    return { ...estadoVacio(), ...e, ajustes: { ...(e.ajustes || {}) } };
  }
  function mutarEstado(fn) {
    const e = leerEstadoArchivo();
    fn(e);
    guardarJson(RUTA_ESTADO, e);
    return e;
  }

  // ── avisos.json ──────────────────────────────────────────────────────

  function leerAvisos() {
    const a = leerJson(RUTA_AVISOS, null);
    if (!a || !Array.isArray(a.avisos)) return [];
    return a.avisos;
  }
  function guardarAvisos(lista) {
    const recortada = lista.slice(-MAX_AVISOS);
    guardarJson(RUTA_AVISOS, { version: 1, avisos: recortada });
    return recortada;
  }

  // ── Evaluación a 48 h (§2.8) ─────────────────────────────────────────

  function ventanaMuestras(muestrasHist, campo, desdeMs, hastaMs) {
    const vals = [];
    for (const m of muestrasHist || []) {
      if (!m || typeof m.t !== "number" || typeof m[campo] !== "number") continue;
      const tMs = m.t * 1000;
      if (tMs >= desdeMs && tMs <= hastaMs) vals.push(m[campo]);
    }
    return vals;
  }

  function ventanaEventosReinicio(eventosAudit, contenedor, horaReinicioUtc, desdeMs, hastaMs) {
    let n = 0;
    for (const e of eventosAudit || []) {
      if (!e || e.accion !== "evento_docker" || !RESULTADOS_REINICIO.has(e.resultado) || e.detalle !== contenedor) continue;
      if (contenedor === "zeus-bot" && esReinicioBotProgramado(e.ts, horaReinicioUtc)) continue;
      const t = new Date(e.ts).getTime();
      if (Number.isNaN(t) || t < desdeMs || t > hastaMs) continue;
      n++;
    }
    return n;
  }

  function construirCtxEvaluacion(regla, avisoTsMs, estG, muestrasHist, eventosAudit) {
    const desde = avisoTsMs;
    const hasta = avisoTsMs + MS_48H;
    if (regla.id === "proyeccion_disco") {
      const vent = ventanaMuestras(muestrasHist, "disco", desde, hasta);
      return { pctActual: estG && estG.disco ? estG.disco.pct : null, coberturaVentana: vent.length > 0 };
    }
    if (regla.id === "proyeccion_memoria") {
      const vent = ventanaMuestras(muestrasHist, "ram", desde, hasta);
      return {
        pctActual: estG && estG.ram ? estG.ram.pct : null,
        coberturaVentana: vent.length > 0,
        arranqueActual: estG ? estG.arranque : null,
      };
    }
    if (regla.id === "p95_cpu" || regla.id === "p95_carga") {
      const campo = regla.id === "p95_cpu" ? "cpu" : "carga";
      const vent = ventanaMuestras(muestrasHist, campo, desde, hasta);
      return { muestrasVentana: vent, coberturaVentana: vent.length > 0 };
    }
    if (typeof regla.id === "string" && regla.id.indexOf("reinicios_") === 0) {
      const contenedor = regla.datos && regla.datos.contenedor;
      const cubre = (eventosAudit || []).length > 0 && new Date(eventosAudit[0].ts).getTime() <= desde;
      return { eventosVentana: ventanaEventosReinicio(eventosAudit, contenedor, HORA_REINICIO_UTC, desde, hasta), coberturaVentana: cubre };
    }
    return { coberturaVentana: false };
  }

  // ── Redacción (§2.6) ─────────────────────────────────────────────────

  const INSTRUCCION_IA = "Redacta en máximo 6 líneas, en español llano para alguien que no sabe de servidores, qué significa cada tendencia de la lista y por qué conviene mirarla. No inventes datos ni recomiendes acciones que no estén en la lista. No uses jerga.";

  async function redactar(disparadasParaEnviar) {
    const tieneIA = !!(preguntarAGemini && registrarConsultaIA && leerPersonaCentinela);
    if (!tieneIA) return { texto: textoPlantilla(disparadasParaEnviar), iaUsada: false };
    let gasto = null;
    try { gasto = registrarConsultaIA(); } catch (_) { gasto = null; }
    if (!gasto || gasto.permitido === false) return { texto: textoPlantilla(disparadasParaEnviar), iaUsada: false };
    const persona = leerPersonaCentinela();
    const contexto = { avisos: disparadasParaEnviar.map((x) => x.datos) };
    let texto = null;
    try { texto = await preguntarAGemini(persona, contexto, INSTRUCCION_IA, { maxOutputTokens: 500 }); } catch (_) { texto = null; }
    if (!texto || texto.indexOf("No pude consultar") === 0) return { texto: textoPlantilla(disparadasParaEnviar), iaUsada: false };
    return { texto, iaUsada: true };
  }

  // ── Envío (§2.7) ─────────────────────────────────────────────────────

  function frenoEnvio() {
    if (permisos && typeof permisos.permitido === "function" && !permisos.permitido("whatsapp", "escritura")) {
      return "sin_permiso_whatsapp";
    }
    if (kapsoYModo && F_MODO && typeof kapsoYModo.obtenerModo === "function" && typeof kapsoYModo.debeSilenciar === "function") {
      const modo = kapsoYModo.obtenerModo(leerJson, F_MODO);
      if (kapsoYModo.debeSilenciar("warn", modo)) return "silenciado_modo_viaje";
    }
    return null;
  }

  // ── revisar() (§2.4) ─────────────────────────────────────────────────

  async function revisar(quien) {
    const quienFinal = quien || "agente";
    const ahoraMs = ahoraFn();

    let estGActual = null;
    try { estGActual = await estadoGeneral(); } catch (_) { estGActual = null; }

    let muestrasHist = [];
    try { muestrasHist = leerJsonl(F_HIST, MAX_HIST) || []; } catch (_) { muestrasHist = []; }

    let eventosAudit = [];
    try { eventosAudit = leerJsonl(F_AUDIT, MAX_AUDIT) || []; } catch (_) { eventosAudit = []; }

    // (1) Evaluar avisos pendientes de 48 h — antes de generar nuevos.
    const avisos = leerAvisos();
    const evaluadas = [];
    const avisosActualizados = avisos.map((av) => {
      if (!av || av.evaluacion || !av.ts) return av;
      const avisoTsMs = new Date(av.ts).getTime();
      if (Number.isNaN(avisoTsMs) || ahoraMs - avisoTsMs < MS_48H) return av;
      const evalPorRegla = (av.reglas || []).map((r) => {
        const ctx = construirCtxEvaluacion(r, avisoTsMs, estGActual, muestrasHist, eventosAudit);
        const res = evaluarAviso(r, ctx);
        evaluadas.push({ id_aviso: av.id_aviso, id: r.id, resultado: res.resultado, detalle: res.detalle });
        return { id: r.id, resultado: res.resultado, detalle: res.detalle };
      });
      return { ...av, evaluacion: evalPorRegla, evaluado_ts: new Date(ahoraMs).toISOString() };
    });

    // (2) Evaluar reglas.
    let pred = null;
    try { pred = await prediccion(); } catch (_) { pred = null; }

    const estArchivo = leerEstadoArchivo();
    const ajustes = estArchivo.ajustes || {};
    const insumos = { prediccion: pred, estadoGeneral: estGActual, muestrasHist, eventosAudit, horaReinicioUtc: HORA_REINICIO_UTC, contenedoresPropios };
    const { disparadas, sinDatos } = evaluarReglas(insumos, ajustes, ahoraMs);

    // (3) Filtrar: reglas silenciadas (nivel 3) y dedupe de 7 días por clave.
    const activas = disparadas.filter((x) => !esSilenciada(nivelDe(ajustes, x.id)));
    const omitidasDedupe = [];
    const paraEnviar = [];
    for (const x of activas) {
      const yaAvisado = avisosActualizados.some((av) => av && (av.reglas || []).some((r) => r.clave === x.clave)
        && (ahoraMs - new Date(av.ts).getTime()) < MS_7D);
      if (yaAvisado) omitidasDedupe.push(x.clave);
      else paraEnviar.push(x);
    }

    // (4) Redactar y enviar.
    let enviado = false;
    let motivo = null;
    let mensaje = null;
    let listaFinal = avisosActualizados;

    if (paraEnviar.length) {
      const redaccion = await redactar(paraEnviar);
      mensaje = construirMensaje(paraEnviar, redaccion.texto);
      const freno = frenoEnvio();
      if (freno) {
        enviado = false; motivo = freno;
      } else {
        let r = null;
        try { r = await enviarWhatsapp(mensaje); } catch (_) { r = null; }
        enviado = !!(r && r.ok);
        motivo = enviado ? "enviado" : "fallo_envio";
      }
      const nuevoAviso = {
        id_aviso: `vg-${Math.floor(ahoraMs)}`,
        ts: new Date(ahoraMs).toISOString(),
        reglas: paraEnviar,
        texto: mensaje,
        enviado,
        motivo,
        ia_usada: redaccion.iaUsada,
        feedback: null,
        feedback_ts: null,
        evaluacion: null,
      };
      listaFinal = avisosActualizados.concat([nuevoAviso]);
    }

    guardarAvisos(listaFinal);

    // (5) Guardar estado.json y auditar.
    const diasHistorial = new Set(muestrasHist.map((m) => claveDiaUTC((m && typeof m.t === "number" ? m.t : 0) * 1000))).size;
    mutarEstado((s) => {
      s.ajustes = ajustes;
      s.dias_historial = diasHistorial;
      s.ultima_corrida = {
        ts: new Date(ahoraMs).toISOString(), quien: quienFinal,
        disparadas: disparadas.map((x) => x.id), sin_datos: sinDatos, omitidas: omitidasDedupe, enviado, motivo,
      };
    });

    auditar("vigia", quienFinal, disparadas.length ? "aviso" : "sin_novedad", disparadas.map((x) => x.id).join(",") || "sin disparos");

    return { disparadas, omitidas_dedupe: omitidasDedupe, sin_datos: sinDatos, enviado, motivo, mensaje, evaluadas };
  }

  // ── quizaCorridaDiaria() (§2.4, patrón quizaResumenDiario/quizaInformeSemanal) ──

  async function quizaCorridaDiaria() {
    const ahoraMs = ahoraFn();
    const dt = new Date(ahoraMs);
    if (dt.getUTCHours() !== TAREA_LATIDO.hora_utc) return;
    const hoy = dt.toISOString().slice(0, 10);
    const est = leerEstadoArchivo();
    if (est.ultima_corrida_diaria === hoy) return;
    const resultado = await revisar("agente");
    mutarEstado((s) => { s.ultima_corrida_diaria = hoy; });
    if (latidos && typeof latidos.registrar === "function") {
      latidos.registrar(TAREA_LATIDO.id, { ok: true }, "agente");
    }
    return resultado;
  }

  // ── registrarFeedback() (§2.4) ───────────────────────────────────────
  //
  // Decisión de implementación: un aviso puede traer varias reglas
  // ({reglas:[...]}) cuando varias dispararon el mismo día y se mandaron en
  // un solo WhatsApp (§2.7 permite exactamente eso). El diseño describe la
  // salida como {ok, mensaje, regla, nivel} en singular, pensado para el
  // caso típico de una sola regla. Aquí el feedback se aplica a TODAS las
  // reglas del aviso (el dueño responde a todo el mensaje, no a una parte);
  // si hay más de una, `regla`/`nivel` devuelven un arreglo en vez de un
  // valor suelto. Ver INTEGRACION-VIGIA.md.

  function registrarFeedback(valor, quien) {
    if (valor !== "util" && valor !== "ruido") {
      return { ok: false, mensaje: "Valor de feedback inválido." };
    }
    const ahoraMs = ahoraFn();
    const avisos = leerAvisos();
    let idx = -1;
    for (let i = avisos.length - 1; i >= 0; i--) {
      const av = avisos[i];
      if (!av || av.enviado !== true || av.feedback != null || !av.ts) continue;
      if (ahoraMs - new Date(av.ts).getTime() > MS_7D) continue;
      idx = i; break;
    }
    if (idx === -1) return { ok: false, mensaje: "No tengo ningún aviso reciente al que aplicarle eso." };

    const aviso = avisos[idx];
    const estArchivo = leerEstadoArchivo();
    let ajustes = estArchivo.ajustes || {};
    const ids = (aviso.reglas || []).map((r) => r.id);
    for (const id of ids) ajustes = aplicarFeedback(ajustes, id, valor);

    avisos[idx] = { ...aviso, feedback: valor, feedback_ts: new Date(ahoraMs).toISOString() };
    guardarAvisos(avisos);
    mutarEstado((s) => { s.ajustes = ajustes; });
    auditar("vigia_feedback", quien || "panel", valor, ids.join(","));

    return {
      ok: true,
      mensaje: valor === "util" ? "Gracias, tomo nota." : "Gracias, bajo la sensibilidad para que avise menos con esto.",
      regla: ids.length === 1 ? ids[0] : ids,
      nivel: ids.length === 1 ? (ajustes[ids[0]] ? ajustes[ids[0]].nivel : 0) : ids.map((id) => (ajustes[id] ? ajustes[id].nivel : 0)),
    };
  }

  // ── estado() (§2.9, para GET /api/vigia) ─────────────────────────────

  function textoUmbral(id, nivel) {
    const niv = clampNivel(nivel);
    if (niv >= 3) return "Silenciada por el dueño (no avisa).";
    if (id === "proyeccion_disco" || id === "proyeccion_memoria") return `Avisa si faltan ${tiersActivos(niv).join(", ")} días o menos.`;
    if (id === "p95_cpu" || id === "p95_carga") return `Avisa si el promedio de 3 días supera ${Math.round(factorP95(niv) * 100)} % de lo habitual.`;
    if (typeof id === "string" && id.indexOf("reinicios_") === 0) return `Avisa desde ${minimoReinicios(niv)} reinicios en la semana.`;
    return "";
  }

  function estado() {
    const estArchivo = leerEstadoArchivo();
    const avisos = leerAvisos();
    const idsConocidos = new Set(Object.keys(REGLAS));
    for (const id of Object.keys(estArchivo.ajustes || {})) idsConocidos.add(id);
    for (const av of avisos) for (const r of av.reglas || []) idsConocidos.add(r.id);
    const sinDatosActuales = (estArchivo.ultima_corrida && estArchivo.ultima_corrida.sin_datos) || [];

    const reglas = Array.from(idsConocidos).map((id) => {
      const ajuste = (estArchivo.ajustes && estArchivo.ajustes[id]) || { nivel: 0, ruido_seguidos: 0 };
      let aciertos = 0;
      let fallos = 0;
      let sinDatosCount = 0;
      let ultimoAvisoTs = null;
      for (const av of avisos) {
        const r = (av.reglas || []).find((x) => x.id === id);
        if (!r) continue;
        if (!ultimoAvisoTs || new Date(av.ts) > new Date(ultimoAvisoTs)) ultimoAvisoTs = av.ts;
        const ev = (av.evaluacion || []).find((x) => x.id === id);
        if (!ev) continue;
        if (ev.resultado === "acerto") aciertos++;
        else if (ev.resultado === "fallo") fallos++;
        else sinDatosCount++;
      }
      return {
        id,
        nombre: (REGLAS[id] && REGLAS[id].nombre) || (id.indexOf("reinicios_") === 0 ? `Reinicios de ${id.slice(10)}` : id),
        estado: sinDatosActuales.includes(id) ? "sin_datos" : (esSilenciada(ajuste.nivel) ? "silenciada" : "activa"),
        nivel: ajuste.nivel,
        umbral_texto: textoUmbral(id, ajuste.nivel),
        ultimo_aviso_ts: ultimoAvisoTs,
        aciertos, fallos, sin_datos: sinDatosCount,
      };
    });

    const avisosRecientes = avisos.slice(-5).reverse().map((av) => ({
      id_aviso: av.id_aviso, ts: av.ts, texto: av.texto, enviado: av.enviado, feedback: av.feedback, evaluacion: av.evaluacion,
    }));

    return {
      ultima_corrida: estArchivo.ultima_corrida || null,
      reglas,
      avisos_recientes: avisosRecientes,
      dias_historial: estArchivo.dias_historial != null ? estArchivo.dias_historial : null,
    };
  }

  return { revisar, quizaCorridaDiaria, registrarFeedback, estado };
}

module.exports = {
  crearVigia,
  TAREA_LATIDO,
  REGLAS,
  evaluarReglas,
  p95,
  mediaDiaria,
  contarReinicios,
  evaluarAviso,
  aplicarFeedback,
  textoPlantilla,
};
