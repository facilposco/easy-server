"use strict";
/**
 * Centinela Zeus — módulo de auditoría de seguridad ampliada.
 *
 * Profundiza lo que ya hace `estadoSeguridad()` en ops-server.js (SSH por
 * contraseña, acceso root, cortafuegos, fail2ban, actualizaciones) sin
 * repetir esas comprobaciones: agrega vencimiento del certificado SSL,
 * puertos escuchando fuera de una lista blanca, y un pico de intentos
 * fallidos en 24 horas comparado contra el promedio semanal.
 *
 * Sigue el mismo patrón que el resto del proyecto: recibe la función sh()
 * de ops-server.js por parámetro, no ejecuta nada por su cuenta, y no se
 * conecta a nada por SSH ni toca archivos de producción. Aislado: otro
 * ingeniero decide cuándo conectarlo (ver modulos/INTEGRACION.md).
 */

// Puertos que sí deben estar escuchando en este servidor. Todo lo demás que
// aparezca abierto hacia afuera es sospechoso y se reporta como hallazgo.
// Configurable: se puede pasar una lista distinta como segundo argumento
// de auditoriaCompleta si el servidor cambia de servicios.
const PUERTOS_ESPERADOS = [22, 80, 443, 4900];

const RUTA_CERT_LE = "/etc/letsencrypt/live"; // subcarpeta por dominio, con cert1.pem
const DOMINIO_DEFECTO = "panel.ejemplo.com";

function severidadPeor(a, b) {
  const orden = { ok: 0, atencion: 1, urgente: 2 };
  return orden[a] >= orden[b] ? a : b;
}

// ── Certificado SSL ──────────────────────────────────────────────────────────

/**
 * Revisa cuándo vence el certificado. Primero intenta leer el archivo de
 * Let's Encrypt directamente (más rápido y no depende de red); si no está
 * disponible, cae a `openssl s_client` contra el dominio público.
 */
async function revisarCertificado(sh, dominio) {
  const d = dominio || DOMINIO_DEFECTO;

  const archivo = await sh(
    `test -f ${RUTA_CERT_LE}/${d}/cert.pem && openssl x509 -enddate -noout -in ${RUTA_CERT_LE}/${d}/cert.pem 2>/dev/null`
  );
  let salida = archivo.salida;
  let origen = "archivo local";

  if (!salida) {
    const remoto = await sh(
      `echo | openssl s_client -servername ${d} -connect ${d}:443 2>/dev/null | openssl x509 -enddate -noout 2>/dev/null`,
      15000
    );
    salida = remoto.salida;
    origen = "conexión directa";
  }

  const m = salida.match(/notAfter=(.+)/);
  if (!m) {
    return {
      id: "certificado_ssl",
      titulo: "Certificado de seguridad del sitio",
      severidad: "atencion",
      significado: "No se pudo comprobar cuándo vence el certificado que hace que el candado del navegador aparezca. Puede ser un problema temporal de lectura, conviene revisar a mano.",
      automatico: false,
      detalle: `Sin datos (${origen})`,
    };
  }

  const vence = new Date(m[1]);
  const diasRestantes = Math.round((vence - Date.now()) / 86400000);
  let severidad = "ok";
  let significado = `El certificado vence en ${diasRestantes} días. Let's Encrypt suele renovarlo solo antes de que esto sea un problema.`;
  if (diasRestantes < 0) {
    severidad = "urgente";
    significado = "El certificado de seguridad ya venció. Los visitantes verán una advertencia de sitio no seguro.";
  } else if (diasRestantes <= 7) {
    severidad = "urgente";
    significado = `El certificado vence en ${diasRestantes} días y la renovación automática no se ha completado. Puede dejar el sitio marcado como no seguro.`;
  } else if (diasRestantes <= 20) {
    severidad = "atencion";
    significado = `El certificado vence en ${diasRestantes} días. Normalmente se renueva solo, pero conviene confirmarlo.`;
  }

  return {
    id: "certificado_ssl",
    titulo: "Certificado de seguridad del sitio",
    severidad,
    significado,
    automatico: severidad !== "urgente", // si ya está por vencer o venció, mejor que el dueño confirme
    detalle: `Vence el ${vence.toISOString().slice(0, 10)} (${diasRestantes} días) — ${origen}`,
  };
}

// ── Puertos fuera de la lista blanca ────────────────────────────────────────

/**
 * Compara los puertos TCP en escucha contra la lista blanca. Reporta los
 * que sobran (abiertos y no esperados); no reporta los que faltan, porque
 * un puerto esperado que no está abierto ya lo cubre `estadoSeguridad()`.
 */
async function revisarPuertosInesperados(sh, listaBlanca) {
  const blanca = new Set((listaBlanca && listaBlanca.length ? listaBlanca : PUERTOS_ESPERADOS).map(Number));
  // Solo cuentan los puertos que escuchan hacia AFUERA. Un puerto atado a
  // 127.0.0.1 (o ::1) únicamente es alcanzable desde el propio servidor: no
  // es una puerta abierta a internet y reportarlo como urgente sería una
  // falsa alarma. En este servidor, por ejemplo, los puertos internos de los
  // contenedores (3131, 3132, 8788) y el DNS local (53) son de ese tipo.
  const r = await sh(
    "ss -tlnH 2>/dev/null | awk '{print $4}' | grep -vE '^(127\\.|\\[::1\\])' | grep -oE '[0-9]+$' | sort -un"
  );
  const abiertos = r.salida.split("\n").filter(Boolean).map(Number).filter((n) => !isNaN(n));
  const inesperados = abiertos.filter((p) => !blanca.has(p));

  if (!inesperados.length) {
    return {
      id: "puertos_inesperados",
      titulo: "Puertos abiertos hacia la red",
      severidad: "ok",
      significado: "Solo están abiertos hacia internet los puertos que este servidor necesita.",
      automatico: true,
      detalle: `Abiertos hacia internet: ${abiertos.join(", ") || "ninguno"} · Los puertos internos (solo alcanzables desde el propio servidor) no se cuentan.`,
    };
  }

  return {
    id: "puertos_inesperados",
    titulo: "Puertos abiertos hacia la red",
    severidad: "urgente",
    significado: `Hay ${inesperados.length} puerto(s) abiertos que no deberían estarlo: ${inesperados.join(", ")}. Cada puerto abierto es una puerta más para intentar entrar al servidor.`,
    automatico: false, // cerrar un puerto puede tumbar algo que sí se usa; requiere revisión humana
    detalle: `Inesperados: ${inesperados.join(", ")} · Esperados: ${[...blanca].join(", ")}`,
  };
}

// ── Pico de intentos fallidos ────────────────────────────────────────────────

/**
 * Cuenta intentos fallidos de acceso por SSH en las últimas 24 horas y los
 * compara contra el promedio diario de la última semana. Un conteo total
 * alto pero estable no es noticia; un pico repentino sí lo es, porque
 * indica un ataque activo en curso, no ruido de fondo habitual de internet.
 */
async function revisarPicoIntentos(sh) {
  const hoy = await sh(`grep 'Failed password' /var/log/auth.log 2>/dev/null | grep -c "$(date -d '24 hours ago' '+%b %e')" || echo 0`);
  // Promedio semanal: cuenta los fallidos en auth.log (y su rotado .1, ya
  // comprimido o no) y divide entre 7. auth.log.1 puede no existir todavía
  // en servidores nuevos, así que se ignoran errores de lectura.
  const semana = await sh(
    "( grep -c 'Failed password' /var/log/auth.log 2>/dev/null; " +
    "zgrep -c 'Failed password' /var/log/auth.log.1.gz 2>/dev/null; " +
    "grep -c 'Failed password' /var/log/auth.log.1 2>/dev/null ) | paste -sd+ | bc 2>/dev/null || echo 0"
  );

  const ultimas24 = parseInt(hoy.salida || "0", 10) || 0;
  const totalSemana = parseInt(semana.salida || "0", 10) || 0;
  const promedioDiario = totalSemana > 0 ? totalSemana / 7 : 0;

  let severidad = "ok";
  let significado = `${ultimas24} intentos de entrar con contraseña equivocada en las últimas 24 horas, en línea con lo normal de esta semana.`;

  if (promedioDiario > 0 && ultimas24 > promedioDiario * 3 && ultimas24 > 20) {
    severidad = "urgente";
    significado = `${ultimas24} intentos fallidos en las últimas 24 horas, muy por encima del promedio de ${Math.round(promedioDiario)} al día. Parece un ataque activo, no el ruido normal de internet.`;
  } else if (promedioDiario > 0 && ultimas24 > promedioDiario * 1.8 && ultimas24 > 10) {
    severidad = "atencion";
    significado = `${ultimas24} intentos fallidos en las últimas 24 horas, por encima del promedio de ${Math.round(promedioDiario)} al día. Vale la pena vigilarlo.`;
  } else if (!promedioDiario && ultimas24 > 20) {
    severidad = "atencion";
    significado = `${ultimas24} intentos fallidos en las últimas 24 horas. No hay suficiente historial todavía para saber si es un pico o es normal.`;
  }

  return {
    id: "pico_intentos_fallidos",
    titulo: "Pico de intentos de acceso fallidos",
    severidad,
    significado,
    automatico: true, // fail2ban ya bloquea automáticamente las direcciones repetidas
    detalle: `Últimas 24h: ${ultimas24} · Promedio diario (7 días): ${promedioDiario ? promedioDiario.toFixed(1) : "sin datos"}`,
  };
}

// ── Auditoría completa ───────────────────────────────────────────────────────

/**
 * Corre las tres comprobaciones nuevas en paralelo y devuelve un reporte
 * estructurado. No repite lo que ya hace estadoSeguridad() (SSH, root,
 * cortafuegos, fail2ban, actualizaciones): esas siguen viviendo ahí, este
 * módulo solo agrega hallazgos adicionales.
 *
 * @param {Function} sh función sh() de ops-server.js
 * @param {Object} [opciones]
 * @param {string} [opciones.dominio] dominio a revisar para el certificado
 * @param {number[]} [opciones.puertosEsperados] lista blanca de puertos
 */
async function auditoriaCompleta(sh, opciones) {
  if (typeof sh !== "function") throw new Error("auditoriaCompleta necesita la función sh() de ops-server.js");
  const opts = opciones || {};

  const [certificado, puertos, intentos] = await Promise.all([
    revisarCertificado(sh, opts.dominio).catch((e) => ({
      id: "certificado_ssl", titulo: "Certificado de seguridad del sitio",
      severidad: "atencion", significado: "No se pudo revisar el certificado por un error interno.",
      automatico: false, detalle: e.message,
    })),
    revisarPuertosInesperados(sh, opts.puertosEsperados).catch((e) => ({
      id: "puertos_inesperados", titulo: "Puertos abiertos hacia la red",
      severidad: "atencion", significado: "No se pudo revisar los puertos abiertos por un error interno.",
      automatico: false, detalle: e.message,
    })),
    revisarPicoIntentos(sh).catch((e) => ({
      id: "pico_intentos_fallidos", titulo: "Pico de intentos de acceso fallidos",
      severidad: "atencion", significado: "No se pudo revisar los intentos de acceso por un error interno.",
      automatico: false, detalle: e.message,
    })),
  ]);

  const hallazgos = [certificado, puertos, intentos];
  const severidadGeneral = hallazgos.reduce((peor, h) => severidadPeor(peor, h.severidad), "ok");

  return {
    hallazgos,
    severidad_general: severidadGeneral,
    ts: new Date().toISOString(),
  };
}

// ── Resumen para la auditoría diaria ────────────────────────────────────────

/**
 * Texto corto en español para el resumen diario. Si todo está bien, una
 * frase de tranquilidad. Si hay algo, solo lo que necesita atención u
 * urgencia — no repite la lista completa de comprobaciones que pasaron.
 */
function resumenParaAuditoria(reporte) {
  const hallazgos = (reporte && reporte.hallazgos) || [];
  const pendientes = hallazgos.filter((h) => h.severidad !== "ok");

  if (!pendientes.length) {
    return "Seguridad ampliada: certificado, puertos e intentos de acceso, todo en orden.";
  }

  const lineas = ["Seguridad ampliada — necesita atención:"];
  pendientes
    .sort((a, b) => (a.severidad === "urgente" ? -1 : 1) - (b.severidad === "urgente" ? -1 : 1))
    .forEach((h) => {
      const marca = h.severidad === "urgente" ? "URGENTE" : "Atención";
      lineas.push(`- [${marca}] ${h.titulo}: ${h.significado}`);
    });
  return lineas.join("\n");
}

module.exports = {
  auditoriaCompleta,
  resumenParaAuditoria,
  PUERTOS_ESPERADOS,
  // Exportadas para pruebas individuales.
  _interno: { revisarCertificado, revisarPuertosInesperados, revisarPicoIntentos },
};
