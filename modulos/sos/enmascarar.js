"use strict";
/**
 * modulos/sos/enmascarar.js
 *
 * Enmascarado de datos sensibles del paquete de evidencia del SOS.
 * Ver DISENO-SOS.md §9.3. Reglas aplicadas EN ESTE ORDEN, siempre ANTES de
 * escribir a disco (nunca después, nunca como paso separado posterior):
 *
 *   1. Secretos conocidos (literales de .env y una lista fija) → <secreto:NOMBRE>
 *   2. Patrones de credenciales (pass=, Bearer, mysql -p, user:pass@host, ?token=)
 *   3. Datos personales (teléfonos/JID, correos)
 *   4. Filtro de líneas técnicas de los registros del bot (nunca conversaciones)
 *   5. Literales SQL entre comillas simples
 *   6. Barrido final de cadenas largas que parecen claves/hashes/JWT
 *   7. Comprobación final: si algún secreto conocido sigue presente, la
 *      sección se reemplaza por "[sección omitida por seguridad]"
 *
 * Funciones puras, sin E/S. Con pruebas en pruebas/enmascarar.test.js.
 */

// ── Regla 4: qué líneas de `docker logs zeus-bot` se conservan ──────────────
const RE_LINEA_TECNICA = /(error|err\s|warn|excep|fatal|unhandled|econn|etimedout|enomem|eacces|epipe|timeout|refused|reconnect|listen|start|exit|shutdown|sigterm|mysql|mariadb|chroma|kapso|webhook|health|memory|heap|rate limit|429|5\d\d)/i;

// ── Regla 2: patrones de credenciales ────────────────────────────────────────
const RE_CRED_CLAVE_VALOR = /\b(pass(word)?|contrase[ñn]a|secret|token|api[_-]?key|apikey|authorization|bearer|pin|cookie|clave)\b\s*[:=]\s*("[^"]*"|'[^']*'|\S+)/gi;
const RE_BEARER = /Bearer\s+\S+/gi;
const RE_MYSQL_DASH_P = /(mysql|mariadb)([^\n]{0,40}?)-p\S+/gi;
const RE_URL_USERPASS = /:\/\/[^/\s:]+:[^/\s@]+@/g;
const RE_URL_PARAM_SECRETO = /(token|key|secret|pass|pwd|auth)=[^&\s]+/gi;

// ── Regla 3: datos personales ────────────────────────────────────────────────
const RE_TELEFONO = /(\+?\d[\d\s-]{8,17}\d)(@s\.whatsapp\.net|@lid)?/g;
// Excluye los dominios de JID de WhatsApp (s.whatsapp.net): esos ya los
// enmascara la regla de teléfonos de abajo, conservando los últimos 4
// dígitos; si esta regex los tocara también, se perdería esa información.
const RE_CORREO = /[\w.+-]+@(?!s\.whatsapp\.net\b)[\w-]+\.[\w.-]+/g;

// ── Regla 5: literales SQL ────────────────────────────────────────────────────
const RE_LINEA_SQL = /\b(select|insert|update|delete|where)\b/i;
const RE_LITERAL_SQL = /'[^']*'/g;

// ── Regla 6: barrido final (claves/hashes/JWT) ───────────────────────────────
// Excepción: hashes de git (7-40 hex) e ids ev-/sos-/sim-.
const RE_HASH_GIT = /^[0-9a-f]{7,40}$/i;
const RE_ID_CENTINELA = /^(ev|sos|sim|inc)-/i;
const RE_CADENA_LARGA = /\b(?=\w*[A-Za-z])(?=\w*\d)[A-Za-z0-9_\-./+]{32,}\b/g;

function esExcepcionBarrido(cadena) {
  return RE_HASH_GIT.test(cadena) || RE_ID_CENTINELA.test(cadena);
}

/** Conserva solo los últimos N dígitos de un número largo (teléfono/JID). */
function ocultarNumero(match, numero) {
  const digitos = numero.replace(/\D/g, "");
  if (digitos.length < 8) return match; // no es un teléfono/JID plausible
  return "•".repeat(Math.max(0, digitos.length - 4)) + digitos.slice(-4);
}

/**
 * Filtra `docker logs zeus-bot` a solo líneas técnicas (regla 4). Las
 * conversaciones de clientes nunca se guardan. Recorta cada línea a 300
 * caracteres. Devuelve { texto, lineas_totales, lineas_conservadas }.
 */
function filtrarLineasTecnicas(texto) {
  const lineas = String(texto || "").split("\n");
  const conservadas = lineas.filter((l) => RE_LINEA_TECNICA.test(l)).map((l) => l.slice(0, 300));
  return {
    texto: conservadas.join("\n"),
    lineas_totales: lineas.filter((l) => l.trim() !== "").length,
    lineas_conservadas: conservadas.length,
  };
}

/** Enmascara literales SQL solo dentro de líneas que parecen sentencias SQL. */
function enmascararSql(texto) {
  let reemplazos = 0;
  const salida = String(texto || "").split("\n").map((linea) => {
    if (!RE_LINEA_SQL.test(linea)) return linea;
    return linea.replace(RE_LITERAL_SQL, () => { reemplazos++; return "'…'"; });
  }).join("\n");
  return { texto: salida, reemplazos };
}

/**
 * Construye el enmascarador con la lista de secretos literales conocidos
 * (valores de /opt/zeus-ops/.env, /opt/zeus-app/.env, MYSQL_PASS, KAPSO_KEY,
 * PROXY_SECRETO_GEMINI, PIN_SIMULACRO, TOKEN_PRUEBA_VIGILANTE, WSP_DESTINO...).
 * Solo se cargan valores de >= 6 caracteres, con su nombre de variable.
 *
 * @param {Array<{nombre:string, valor:string}>} secretos
 */
function crearEnmascarador(secretos) {
  const lista = (secretos || [])
    .filter((s) => s && s.valor && String(s.valor).length >= 6)
    .map((s) => ({ nombre: s.nombre, valor: String(s.valor), valorUrl: encodeURIComponent(String(s.valor)) }));

  function contiene(texto) {
    if (!texto) return false;
    return lista.some((s) => texto.includes(s.valor) || (s.valorUrl !== s.valor && texto.includes(s.valorUrl)));
  }

  /**
   * @param {string} texto
   * @param {object} [opciones]
   * @param {boolean} [opciones.esLogBot]   aplica el filtro de líneas técnicas antes de lo demás
   * @param {object}  [opciones.contador]   objeto acumulador { secretos, credenciales, personales, sql, barrido }
   * @returns {{texto:string, lineas_totales?:number, lineas_conservadas?:number}}
   */
  function enmascarar(texto, opciones = {}) {
    const contador = opciones.contador || { secretos: 0, credenciales: 0, personales: 0, sql: 0, barrido: 0 };
    let t = String(texto == null ? "" : texto);
    let lineasInfo = null;

    // Regla 4 primero (si aplica): recorta el texto antes de enmascarar el resto.
    if (opciones.esLogBot) {
      const f = filtrarLineasTecnicas(t);
      t = f.texto;
      lineasInfo = { lineas_totales: f.lineas_totales, lineas_conservadas: f.lineas_conservadas };
    }

    // Regla 1: secretos conocidos, literales (y su versión URL-encoded).
    for (const s of lista) {
      if (t.includes(s.valor)) {
        t = t.split(s.valor).join(`<secreto:${s.nombre}>`);
        contador.secretos++;
      }
      if (s.valorUrl !== s.valor && t.includes(s.valorUrl)) {
        t = t.split(s.valorUrl).join(`<secreto:${s.nombre}>`);
        contador.secretos++;
      }
    }

    // Regla 2: patrones de credenciales.
    t = t.replace(RE_CRED_CLAVE_VALOR, (m, p1) => { contador.credenciales++; return `${p1}=<oculto>`; });
    t = t.replace(RE_BEARER, () => { contador.credenciales++; return "Bearer <oculto>"; });
    t = t.replace(RE_MYSQL_DASH_P, (m, p1, p2) => { contador.credenciales++; return `${p1}${p2}-p<oculto>`; });
    t = t.replace(RE_URL_USERPASS, () => { contador.credenciales++; return "://<oculto>@"; });
    t = t.replace(RE_URL_PARAM_SECRETO, (m, p1) => { contador.credenciales++; return `${p1}=<oculto>`; });

    // Regla 3: datos personales.
    t = t.replace(RE_TELEFONO, (m, numero, sufijo) => {
      const oculto = ocultarNumero(m, numero);
      if (oculto === m) return m;
      contador.personales++;
      return oculto + (sufijo || "");
    });
    t = t.replace(RE_CORREO, () => { contador.personales++; return "<correo>"; });

    // Regla 5: SQL.
    const sqlR = enmascararSql(t);
    t = sqlR.texto;
    contador.sql += sqlR.reemplazos;

    // Regla 6: barrido final.
    t = t.replace(RE_CADENA_LARGA, (m) => {
      if (esExcepcionBarrido(m)) return m;
      contador.barrido++;
      return "<posible-clave>";
    });

    // Regla 7: comprobación. Si tras todo lo anterior queda un secreto
    // literal conocido, la sección entera se omite (nunca se escribe un
    // paquete con un secreto conocido dentro).
    if (contiene(t)) {
      return { texto: "[sección omitida por seguridad]", omitida: true, ...(lineasInfo || {}) };
    }

    return { texto: t, omitida: false, ...(lineasInfo || {}) };
  }

  return { enmascarar, contiene };
}

module.exports = {
  crearEnmascarador,
  filtrarLineasTecnicas,
  enmascararSql,
  RE_LINEA_TECNICA,
};
