(function () {
  // Nombre de la base de datos que vigila Centinela. Debe coincidir con DB_ESQUEMA del .env del servidor.
  var DB_ESQUEMA = "negocio";
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]; }); };
  var pill = function (nivel, texto) { return '<span class="pill ' + nivel + '"><span class="ic"></span>' + esc(texto) + "</span>"; };
  var gb = function (bytes) { return (bytes / 1073741824).toFixed(1); };
  // Servicios que guardan datos: reiniciarlos corta el servicio de verdad,
  // así que se piden con confirmación escrita aunque el botón esté en una lista.
  var conDatos = function (nombre) { return /mariadb|chromadb|proxy/.test(nombre); };

  // Nombres amables y frases de negocio por servicio. Mientras la API no los
  // entregue (ver CAMBIOS.md, "Nombres amables"), quedan aquí en el frontend.
  var NOMBRES = {
    "zeus-bot":        { amigable: "Bot de WhatsApp",      articulo: "el bot de WhatsApp",      hace: "Atiende a los clientes que escriben",              impacto: "Los clientes que escriben no reciben respuesta. La tienda sigue vendiendo." },
    "zeus-web":    { amigable: "Punto de venta",       articulo: "el punto de venta",        hace: "La tienda y la caja",                               impacto: "La tienda no puede cobrar mientras esté caído." },
    "zeus-mariadb":    { amigable: "Base de datos",        articulo: "la base de datos",         hace: "Guarda ventas, clientes y conversaciones",          impacto: "Ni el bot ni la tienda pueden guardar nada mientras esté caída." },
    "zeus-chromadb":   { amigable: "Memoria del bot",      articulo: "la memoria del bot",       hace: "Lo que el bot sabe del negocio",                    impacto: "El bot responde, pero olvida el contexto del negocio." },
    "zeus-proxy":      { amigable: "Puerta de entrada",    articulo: "la puerta de entrada",     hace: "Recibe las visitas de internet",                    impacto: "La web y el bot no reciben visitas de internet." },
    "zeus-centinela":  { amigable: "Centinela",            articulo: "Centinela",                hace: "Vigila y avisa por WhatsApp",                       impacto: "Deja de vigilar y avisar; se reinicia solo." },
    "zeus-respaldos":  { amigable: "Copias de seguridad",  articulo: "el servicio de copias",    hace: "Guarda una copia diaria a las 3:00 a. m.",          impacto: "Las copias automáticas no se están guardando." },
    // Contenedores de OTRO proyecto (ver DISENO-CONTENEDORES.md §7.3): Centinela no los
    // vigila ni los repara solo. "impacto" se usa como aviso genérico en sus modales.
    "otro-proyecto-b":   { amigable: "Otro proyecto B (ejemplo)", articulo: "otro proyecto B", hace: "Es de otro proyecto: Centinela no lo vigila.",     impacto: "Es de otro proyecto: Centinela no lo vigila." },
    "otro-proyecto-c":          { amigable: "Otro proyecto C",                articulo: "otro proyecto C",                   hace: "Es de otro proyecto: Centinela no lo vigila.",     impacto: "Es de otro proyecto: Centinela no lo vigila." },
    "otro-proyecto-a":       { amigable: "Otro proyecto A (ejemplo)", articulo: "el monitor de pools de Orca", hace: "Es de otro proyecto: Centinela no lo vigila.", impacto: "Es de otro proyecto: Centinela no lo vigila." }
  };
  function amigable(nombre) { return (NOMBRES[nombre] && NOMBRES[nombre].amigable) || nombre; }
  function infoServicio(nombre) { return NOMBRES[nombre] || { amigable: nombre, articulo: nombre, hace: "", impacto: "Puede afectar el bot o la tienda." }; }

  // Siempre en hora de Colombia (UTC-5), sin importar en qué zona horaria esté
  // el navegador de quien mira el panel — antes usaba la zona del navegador,
  // lo que desalineaba estas horas con las que trae cada línea de log del bot.
  function horaCO(ts) { return new Date(ts).toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit", timeZone: "America/Bogota" }); }
  function fechaHoraCO(ts) { return new Date(ts).toLocaleString("es-CO", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "America/Bogota" }); }
  function minutosDesde(ts) { return Math.max(0, Math.round((Date.now() - ts) / 60000)); }

  /* =========================================================================
     Navegación (rail de escritorio + pestañas de celular + "Más")
     ========================================================================= */
  var SUB_MAS = ["contenedores", "copias", "registros", "seguridad", "optimizacion", "limpieza", "tecnico", "simulacros", "ajustes", "permisos"];
  // Secciones con URL amigable propia (panel.ejemplo.com/simulacros, etc.)
  // — así se puede compartir o guardar el enlace directo a una sección.
  var VISTAS_VALIDAS = ["inicio", "sos", "historial", "registros", "copias", "contenedores", "seguridad", "optimizacion", "limpieza", "tecnico", "simulacros", "ajustes", "permisos"];

  function rutaDeVista(nombre) { return nombre === "inicio" ? "/" : "/" + nombre; }
  function vistaDeRuta(ruta) {
    var limpia = String(ruta || "/").replace(/^\/+|\/+$/g, "");
    return VISTAS_VALIDAS.indexOf(limpia) !== -1 ? limpia : "inicio";
  }

  function ir(nombre, sinEmpujarUrl) {
    // Al salir de "contenedores" hay que cerrar cualquier consola en vivo abierta
    // (registros o de una operación): el stream de registros mata "docker logs" en
    // el servidor y libera el cupo; el de una operación solo se desconecta del lado
    // del navegador (la operación sigue corriendo; al volver se reengancha por
    // "en_curso"). Ver DISENO-CONTENEDORES.md §7.3, "Salir de la sección".
    var vistaActual = document.querySelector("[data-view]:not([hidden])");
    if (vistaActual && vistaActual.dataset.view === "contenedores" && nombre !== "contenedores") {
      cerrarStreamsContenedores();
    }
    document.querySelectorAll("[data-view]").forEach(function (v) { v.hidden = v.dataset.view !== nombre; });
    document.querySelectorAll(".rail [data-go], .tabbar [data-go]").forEach(function (b) {
      var actual = b.dataset.go === nombre || (b.dataset.go === "mas" && SUB_MAS.indexOf(nombre) !== -1);
      b.setAttribute("aria-current", String(actual));
    });
    window.scrollTo(0, 0);
    cargarSeccion(nombre);
    if (!sinEmpujarUrl) {
      var ruta = rutaDeVista(nombre);
      if (location.pathname !== ruta) history.pushState({ vista: nombre }, "", ruta);
    }
  }
  window.addEventListener("popstate", function () { ir(vistaDeRuta(location.pathname), true); });

  /* ---------- toast: solo para avisos menores, no para el resultado de una acción ---------- */
  var toastT;
  function aviso(msg) {
    var t = $("toast");
    if (!t) return;
    t.textContent = msg;
    t.setAttribute("data-show", "true");
    clearTimeout(toastT);
    toastT = setTimeout(function () { t.setAttribute("data-show", "false"); }, 4000);
  }

  function api(ruta) {
    return fetch(ruta, { headers: { "Accept": "application/json" } }).then(function (r) { return r.json(); });
  }

  /* =========================================================================
     Botón de acción por hallazgo de auditoría (Seguridad, Optimización,
     Auditoría 360): no todo hallazgo se puede "arreglar solo" con un clic —
     tocar SSH, credenciales o el firewall a ciegas puede dejar al dueño
     afuera o cortar el bot. Tres tipos de botón, según qué tan seguro es:
       - una acción ya existente y gateada (ej. instalar actualizaciones)
       - "ir a la sección" donde sí hay más contexto y una acción real
       - "copiar para tu técnico", cuando la reparación es manual a propósito
     ========================================================================= */
  var VISTA_POR_HALLAZGO = {};
  // ssh, firewall y usuarios se quedan en "copiar para tu técnico" a propósito:
  // tocarlos a ciegas puede dejar al dueño afuera del servidor (ver el susto
  // real de SSH del 14-sep-2026) o cortar tráfico legítimo. dependencias y
  // credenciales tampoco tienen un arreglo de un clic (actualizar un paquete
  // puede romper el bot; una credencial expuesta hay que rotarla a mano).
  // docker (contenedor corriendo como root) tampoco: el arreglo real es
  // agregar "user:" en docker-compose.yml y recrear el contenedor, no algo
  // que exista en la sección Contenedores — el botón "Ir a solucionar" que
  // había antes llevaba a una página sin ninguna forma de arreglar esto
  // (encontrado revisando en vivo el 14-sep-2026).
  var COPIABLES_HALLAZGO = { ssh: 1, firewall: 1, usuarios: 1, dependencias: 1, credenciales: 1, docker: 1 };
  // Para lo que Centinela no puede reparar sola, además de "copiar para tu
  // técnico" (por si de verdad tienes uno), ofrece que Gemini redacte una
  // explicación concreta de ESE hallazgo — reemplaza el "no sé qué hacer con
  // esto" por algo específico que el dueño pueda entender y decidir. Gemini
  // solo redacta texto: nunca ejecuta nada (ver modulos/explicador-hallazgos.js).
  function botonExplicarIA(h) {
    return '<button class="btn sm ghost" data-explicar-ia="1" data-titulo="' + esc(h.titulo || "") +
      '" data-significado="' + esc(h.significado || "") + '" data-detalle="' + esc((h.detalle || "").slice(0, 1000)) +
      '">Explicar con IA</button>';
  }
  function botonHallazgo(h) {
    if (!h || h.severidad === "ok") return "";
    if (h.id === "actualizaciones") {
      return '<button class="btn sm" data-accion="actualizar_seguridad" data-confirmar="ACTUALIZAR">Instalar</button>';
    }
    var vista = VISTA_POR_HALLAZGO[h.id];
    if (vista) return '<button class="btn sm ghost" data-a360-ir="' + esc(vista) + '">Ir a solucionar</button>';
    if (COPIABLES_HALLAZGO[h.id]) {
      var texto = (h.titulo || "") + ": " + (h.significado || "") + (h.detalle ? " — " + h.detalle : "");
      return '<button class="btn sm ghost" data-copiar-hallazgo="' + esc(texto) + '">Copiar para tu técnico</button>' + botonExplicarIA(h);
    }
    return "";
  }
  // Sub-filas con botón real, uno por archivo — el único hallazgo de
  // Seguridad que Centinela sabe reparar sola (chmod 640, sin tocar el
  // contenido del archivo).
  function filasAccionablesSeguridad(h) {
    if (h.id === "archivos" && Array.isArray(h.datos) && h.datos.length) {
      return h.datos.map(function (f) {
        return '<div class="fila" style="justify-content:space-between;padding-left:34px;margin-top:4px">' +
          '<span class="sub">' + esc(f.archivo) + " (permiso " + esc(f.permiso) + ")</span>" +
          '<button class="btn sm" data-reparar-permiso="1" data-archivo="' + esc(f.archivo) + '">Corregir permiso</button></div>';
      }).join("");
    }
    return "";
  }
  document.addEventListener("click", function (e) {
    var copiarBtn = e.target.closest("[data-copiar-hallazgo]");
    if (copiarBtn) {
      var texto = copiarBtn.dataset.copiarHallazgo || "";
      (navigator.clipboard && navigator.clipboard.writeText
        ? navigator.clipboard.writeText(texto)
        : Promise.reject()
      ).then(function () { aviso("Copiado. Pégalo donde quieras enviarlo."); })
        .catch(function () { aviso("No pude copiarlo automáticamente."); });
    }
  });

  /* =========================================================================
     Tarjeta de tarea: reemplaza el toast de 4 s para el resultado de acciones.
     Queda visible hasta que el dueño la cierre.
     ========================================================================= */
  function tareaTrabajando(titulo, detalle) {
    var t = $("tarea");
    t.hidden = false;
    t.className = "tarea trabajando";
    $("tarea-t").textContent = titulo;
    $("tarea-d").textContent = detalle || "Puedes seguir mirando el panel.";
    $("tarea-barra").hidden = false;
    $("tarea-cerrar").hidden = true;
    $("tarea-log").hidden = true;
    $("tarea-revertir").hidden = true;
  }
  // `opts.log` es texto de terminal (el comando + su salida real) que se muestra
  // en un bloque tipo consola. `opts.onRevertir` es una función: si se pasa,
  // aparece un botón "Revertir" que la ejecuta al hacer clic.
  function tareaLista(titulo, detalle, opts) {
    opts = opts || {};
    var t = $("tarea");
    t.hidden = false;
    t.className = "tarea lista";
    $("tarea-t").textContent = titulo;
    $("tarea-d").textContent = detalle || "Quedó anotado en el historial de acciones.";
    $("tarea-barra").hidden = true;
    $("tarea-cerrar").hidden = false;
    var log = $("tarea-log");
    if (opts.log) { log.hidden = false; log.textContent = opts.log; } else { log.hidden = true; }
    var revBtn = $("tarea-revertir");
    if (opts.onRevertir) {
      revBtn.hidden = false;
      revBtn.disabled = false;
      revBtn.textContent = "Revertir";
      revBtn.onclick = function () { revBtn.disabled = true; opts.onRevertir(); };
    } else {
      revBtn.hidden = true;
      revBtn.onclick = null;
    }
  }
  function tareaFallo(titulo, detalle, opts) {
    opts = opts || {};
    var t = $("tarea");
    t.hidden = false;
    t.className = "tarea fallo";
    $("tarea-t").textContent = titulo;
    $("tarea-d").textContent = detalle || "";
    $("tarea-barra").hidden = true;
    $("tarea-cerrar").hidden = false;
    var log = $("tarea-log");
    if (opts.log) { log.hidden = false; log.textContent = opts.log; } else { log.hidden = true; }
    $("tarea-revertir").hidden = true;
  }
  var cerrarTareaBtn = $("tarea-cerrar");
  if (cerrarTareaBtn) cerrarTareaBtn.addEventListener("click", function () { $("tarea").hidden = true; });

  /* =========================================================================
     Modal de confirmación escrita: reemplaza el prompt() nativo del navegador.
     Sigue pidiendo escribir la palabra exacta (igual que hoy), pero en una
     ventana propia del panel.
     ========================================================================= */
  var confirmarPendiente = null;
  var scrimConfirmar = $("scrim-confirmar");
  var confirmarInput = $("confirmar-input");
  var confirmarOk = $("confirmar-ok");

  function abrirConfirmar(palabra, descripcion, alConfirmar) {
    $("confirmar-p").textContent = descripcion;
    $("confirmar-palabra").textContent = palabra;
    confirmarInput.value = "";
    confirmarOk.disabled = true;
    confirmarPendiente = { palabra: palabra, cb: alConfirmar };
    scrimConfirmar.hidden = false;
    confirmarInput.focus();
  }
  function cerrarConfirmar() {
    scrimConfirmar.hidden = true;
    confirmarPendiente = null;
    confirmarInput.value = "";
  }
  confirmarInput.addEventListener("input", function () {
    confirmarOk.disabled = !confirmarPendiente || confirmarInput.value !== confirmarPendiente.palabra;
  });
  confirmarInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !confirmarOk.disabled) confirmarOk.click();
  });
  confirmarOk.addEventListener("click", function () {
    var cb = confirmarPendiente && confirmarPendiente.cb;
    cerrarConfirmar();
    if (cb) cb();
  });
  $("confirmar-no").addEventListener("click", cerrarConfirmar);
  scrimConfirmar.addEventListener("click", function (e) { if (e.target === scrimConfirmar) cerrarConfirmar(); });

  /* ---------- hoja informativa (sin acción destructiva): informe, Drive ---------- */
  var scrimInfo = $("scrim-info");
  var HOJAS = {
    drive: {
      t: "Volver a conectar Google Drive",
      p: "Google pidió volver a autorizar la cuenta. Se hace desde el computador, con la cuenta de Google del negocio.",
      datos: [["Paso 1", "Pide el enlace de autorización por WhatsApp."], ["Paso 2", "Ábrelo y entra con la cuenta de Google del negocio."], ["Paso 3", "Acepta. Centinela sube las copias pendientes esa misma noche."]],
      ok: "Enviarme el enlace por WhatsApp",
      accion: "enviar_wsp"
    },
    informe: {
      t: "Enviar informe al técnico",
      p: "Se manda por WhatsApp el resumen actual del servidor: estado, recursos, servicios y avisos.",
      datos: [["Incluye", "Hora, estado de cada servicio y los recursos del servidor."], ["No incluye", "Contraseñas ni datos de clientes."]],
      ok: "Enviar por WhatsApp",
      accion: "enviar_wsp"
    }
  };
  function abrirHoja(clave) {
    var cfg = HOJAS[clave];
    if (!cfg) return;
    $("hoja-info-t").textContent = cfg.t;
    $("hoja-info-p").textContent = cfg.p;
    $("hoja-info-datos").innerHTML = cfg.datos.map(function (d) { return "<div><span>" + esc(d[0]) + "</span><span>" + esc(d[1]) + "</span></div>"; }).join("");
    $("hoja-info-ok").textContent = cfg.ok;
    scrimInfo.hidden = false;
    $("hoja-info-ok").onclick = function () {
      scrimInfo.hidden = true;
      if (cfg.accion) ejecutarAccion(cfg.accion, "", $("hoja-info-ok"));
    };
  }
  $("hoja-info-no").addEventListener("click", function () { scrimInfo.hidden = true; });
  scrimInfo.addEventListener("click", function (e) { if (e.target === scrimInfo) scrimInfo.hidden = true; });

  /* ---------- Modal de ayuda: explicación breve de cada sección ---------- */
  var AYUDAS = {
    inicio: {
      titulo: "Inicio",
      texto: "Aquí ves de un vistazo si todo el servidor está funcionando bien: el bot, la base de datos, el disco y la memoria. Si algo está mal, aparece en rojo con un botón para arreglarlo."
    },
    sos: {
      titulo: "SOS",
      texto: "Si algo anda mal y no sabes qué hacer, este botón hace todo el diagnóstico y la reparación por ti, en un solo paso, y te muestra exactamente qué hizo."
    },
    historial: {
      titulo: "Historial",
      texto: "Qué pasó en el servidor, cuándo, y qué hizo Centinela o tú para resolverlo. Las caídas quedan explicadas aunque hayan durado un minuto."
    },
    registros: {
      titulo: "Registros",
      texto: "Todo lo que el SOS encontró e hizo, y la evidencia que guardó antes de tocar nada. Puedes copiarla para pedir ayuda: los datos sensibles ya están ocultados."
    },
    copias: {
      titulo: "Copias de seguridad",
      texto: "Cada día a las 3:00 a. m. se guarda una copia completa de la base de datos: ventas, clientes y conversaciones. Aquí ves cuándo fue la última y puedes guardar una ahora."
    },
    contenedores: {
      titulo: "Contenedores",
      texto: "Muestra los programas que hacen funcionar el bot y te deja reiniciar uno solo si hace falta, viendo en vivo lo que va pasando."
    },
    seguridad: {
      titulo: "Seguridad",
      texto: "Centinela revisa el servidor todos los días buscando accesos no autorizados, puertos abiertos y otras cosas que puedan traer problemas. Casi siempre no hay nada que hacer."
    },
    optimizacion: {
      titulo: "Optimización",
      texto: "Sugerencias para que la base de datos responda más rápido. Se basan en cómo realmente se usan las tablas en tu negocio. El botón \"Auditar ahora\" hace una revisión completa de la base (memoria, conexiones, índices, crecimiento, bloqueos) y solo sugiere: no cambia nada por su cuenta."
    },
    limpieza: {
      titulo: "Limpieza",
      texto: "Libera espacio en el servidor borrando archivos sobrantes, versiones viejas de programas y registros antiguos. No toca tus datos ni apaga nada que esté funcionando."
    },
    tecnico: {
      titulo: "Datos técnicos",
      texto: "Lo que un técnico va a pedirte para ayudarte. No necesitas entenderlo: cópialo y envíalo por WhatsApp o correo."
    },
    simulacros: {
      titulo: "Simulacros",
      texto: "Prueba, a propósito y de forma controlada, que el sistema de emergencia funcione (por ejemplo, apagar el bot un momento) sin esperar a que pase de verdad. Todo se revierte solo, incluso si cierras la página."
    },
    ajustes: {
      titulo: "Ajustes",
      texto: "Cambia cómo te avisamos y cómo se ve el panel. También puedes silenciar avisos menores si estás de viaje."
    },
    permisos: {
      titulo: "Permisos",
      texto: "Aquí controlas qué puede hacer Centinela por su cuenta: qué partes vigila, cuáles puede reparar sola, y un freno de emergencia para detener toda acción automática de inmediato sin afectar lo que tú hagas manualmente."
    }
  };

  var scrimAyuda = $("scrim-ayuda");
  function abrirAyuda(clave) {
    var cfg = AYUDAS[clave];
    if (!cfg) return;
    $("ayuda-t").textContent = cfg.titulo;
    $("ayuda-p").textContent = cfg.texto;
    scrimAyuda.hidden = false;
  }
  function cerrarAyuda() {
    scrimAyuda.hidden = true;
  }
  $("ayuda-ok").addEventListener("click", cerrarAyuda);
  scrimAyuda.addEventListener("click", function (e) { if (e.target === scrimAyuda) cerrarAyuda(); });

  /* =========================================================================
     Centi: burbuja de chat con el agente. Reutiliza el mismo endpoint que ya
     usa el menú de WhatsApp (/api/centinela/preguntar) — entiende lenguaje
     natural, el menú, y las 10 opciones tal cual. Se agrega una segunda
     manera de preguntar: seleccionar texto en la pantalla con el mouse y
     pedirle a Centi que lo explique (como el copiloto de Meta Ads Manager).
     ========================================================================= */
  (function () {
    var bubble = $("centi-bubble");
    var panel = $("centi-panel");
    var msgs = $("centi-msgs");
    var form = $("centi-form");
    var input = $("centi-input");
    var selBtn = $("centi-selection-btn");
    if (!bubble || !panel) return;

    var historialCenti = [];
    function pintarCenti() {
      msgs.innerHTML = historialCenti.map(function (m) {
        return '<div class="centi-msg ' + m.tipo + '">' + esc(m.texto) + "</div>";
      }).join("");
      msgs.scrollTop = msgs.scrollHeight;
    }
    function agregarCenti(tipo, texto) {
      historialCenti.push({ tipo: tipo, texto: texto });
      pintarCenti();
    }
    function abrirCenti() {
      panel.hidden = false;
      if (!historialCenti.length) {
        agregarCenti("centi", "Hola, soy Centi. Pregúntame lo que sea sobre el servidor, el bot o cualquier parte del panel — o selecciona un texto en la pantalla y te lo explico.");
      }
      input.focus();
    }
    function cerrarCenti() { panel.hidden = true; }

    bubble.addEventListener("click", function () { panel.hidden ? abrirCenti() : cerrarCenti(); });
    $("centi-cerrar").addEventListener("click", cerrarCenti);

    function preguntarCenti(texto) {
      if (!texto || !texto.trim()) return;
      agregarCenti("yo", texto);
      agregarCenti("pensando", "Centi está pensando…");
      postZeus("/api/centinela/preguntar", { pregunta: texto }).then(function (d) {
        historialCenti.pop(); // quita "pensando"
        if (d && d.ok && d.respuesta) agregarCenti("centi", d.respuesta);
        else agregarCenti("centi", (d && d.mensaje) || "No pude responder eso ahora mismo. Intenta de nuevo en un momento.");
      }).catch(function () {
        historialCenti.pop();
        agregarCenti("centi", "No hay conexión con el servidor ahora mismo.");
      });
    }

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var texto = input.value;
      input.value = "";
      preguntarCenti(texto);
    });
    // Enter no siempre dispara el envío implícito del formulario (visto en
    // pruebas reales) — se fuerza el submit a mano en vez de depender de eso.
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (form.requestSubmit) form.requestSubmit();
        else form.dispatchEvent(new Event("submit", { cancelable: true }));
      }
    });

    /* ---------- Preguntar sobre un texto seleccionado (como Meta Ads Manager) ---------- */
    function ocultarBotonSeleccion() { selBtn.hidden = true; }
    document.addEventListener("mouseup", function (e) {
      if (e.target === selBtn) return; // no interferir con su propio clic
      var sel = window.getSelection();
      var texto = sel ? String(sel.toString() || "").trim() : "";
      if (!texto || texto.length < 3 || texto.length > 400 || !document.getElementById("zeus-app").contains(sel.anchorNode)) {
        ocultarBotonSeleccion();
        return;
      }
      var rango = sel.getRangeAt(0).getBoundingClientRect();
      selBtn.hidden = false;
      var x = Math.min(Math.max(8, rango.left + rango.width / 2 - 80), window.innerWidth - 168);
      var y = Math.max(8, rango.top - 38);
      selBtn.style.left = x + "px";
      selBtn.style.top = y + "px";
      selBtn.dataset.texto = texto;
    });
    document.addEventListener("mousedown", function (e) { if (e.target !== selBtn) ocultarBotonSeleccion(); });
    selBtn.addEventListener("click", function () {
      var texto = selBtn.dataset.texto || "";
      ocultarBotonSeleccion();
      window.getSelection().removeAllRanges();
      var vistaActual = document.querySelector("[data-view]:not([hidden])");
      var nombreSeccion = vistaActual && AYUDAS[vistaActual.dataset.view] ? AYUDAS[vistaActual.dataset.view].titulo : "";
      abrirCenti();
      preguntarCenti(
        'Estoy en la sección "' + (nombreSeccion || "del panel") + '" y seleccioné este texto: "' + texto + '". ' +
        'Explícamelo en palabras sencillas.'
      );
    });
  })();

  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    if (!scrimConfirmar.hidden) cerrarConfirmar();
    if (!scrimInfo.hidden) scrimInfo.hidden = true;
    if (!scrimAyuda.hidden) cerrarAyuda();
  });

  /* =========================================================================
     Acciones: POST /api/accion — mismo contrato que antes.
     Las delicadas (data-confirmar) abren el modal de palabra escrita en vez
     del prompt() nativo. El resultado queda en la tarjeta de tarea, no en un
     toast de 4 segundos.
     ========================================================================= */
  var COPIA_BOTON = {
    reiniciar_contenedor: { curso: "Reiniciando", ok: "Reinició" },
    reiniciar_servidor:   { curso: "Reiniciando el servidor completo…", ok: "El servidor volvió a responder." },
    optimizar:            { curso: "Haciendo limpieza…", ok: "Limpieza terminada." },
    respaldar:            { curso: "Guardando la copia…", ok: "Copia guardada." },
    actualizar_seguridad: { curso: "Instalando actualizaciones…", ok: "Actualizaciones instaladas." },
    enviar_wsp:           { curso: "Enviando por WhatsApp…", ok: "Enviado. Revisa tu WhatsApp." },
    desbanear:            { curso: "Desbloqueando la dirección…", ok: "Dirección desbloqueada." }
  };

  function tituloAccion(accion, objetivo) {
    if (accion === "reiniciar_contenedor") return "Reiniciando " + infoServicio(objetivo).articulo + "…";
    var c = COPIA_BOTON[accion];
    return c ? c.curso : "Trabajando…";
  }

  function ejecutarAccion(accion, objetivo, boton) {
    var textoOriginal = boton ? boton.textContent : "";
    if (boton) { boton.disabled = true; boton.textContent = "Un momento…"; }
    tareaTrabajando(tituloAccion(accion, objetivo), "Puede tardar hasta un par de minutos. Puedes seguir mirando el panel.");

    return fetch("/api/accion", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Panel-Zeus": "1" },
      body: JSON.stringify({ accion: accion, objetivo: objetivo })
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && d.ok) {
          var c = COPIA_BOTON[accion];
          tareaLista(d.mensaje || (c && c.ok) || "Listo.", "Quedó anotado en el historial de acciones.");
          if (accion === "optimizar") mostrarOptimizacion(d);
        } else {
          tareaFallo("No se pudo completar", d && d.mensaje || "Inténtalo de nuevo en un momento.");
        }
        if (accion === "respaldar") cargarSeccion("copias", true);
        if (accion === "actualizar_seguridad" || accion === "desbanear") cargarSeccion("seguridad", true);
        cargarRegistro();
        setTimeout(refrescarResumen, 1500);
      })
      .catch(function () {
        tareaFallo("No hay conexión con el servidor", "Puede estar reiniciándose. Vuelve a intentar en unos minutos.");
      })
      .finally(function () { if (boton) { boton.disabled = false; boton.textContent = textoOriginal; } });
  }

  function ejecutar(boton) {
    var accion = boton.dataset.accion;
    var objetivo = boton.dataset.objetivo || "";
    var confirmar = boton.dataset.confirmar;

    if (confirmar) {
      var info = accion === "reiniciar_contenedor" ? infoServicio(objetivo) : null;
      var descripcion = accion === "reiniciar_servidor"
        ? "Apaga y enciende todo el servidor. Bot, tienda y este panel quedan fuera de línea unos dos minutos."
        : accion === "actualizar_seguridad"
          ? "Instala las actualizaciones de seguridad del sistema pendientes. No reinicia el servidor, pero cambia paquetes instalados y no se puede deshacer con un clic."
          : info
            ? "Reinicia " + info.articulo + ". " + info.impacto
            : "Esta acción interrumpe el servicio.";
      abrirConfirmar(confirmar, descripcion, function () {
        // Se conserva el comportamiento de hoy: al reiniciar el servidor completo,
        // el "objetivo" enviado a la API es la propia palabra de confirmación.
        var objetivoFinal = accion === "reiniciar_servidor" ? confirmar : objetivo;
        ejecutarAccion(accion, objetivoFinal, boton);
      });
      return;
    }
    ejecutarAccion(accion, objetivo, boton);
  }

  function mostrarOptimizacion(d) {
    var p = $("panel-optimizar");
    p.hidden = false;
    $("resultado-optimizar").innerHTML =
      '<div class="revision"><span class="mk ok">✓</span><div><b>Se liberaron ' + d.liberado_mb + ' MB</b>' +
      '<span>El disco pasó de ' + d.antes + " % a " + d.despues + ' % de uso.</span></div><span></span></div>' +
      (d.pasos || []).map(function (x) {
        return '<div class="revision"><span class="mk ok">·</span><div><b>' + esc(x.paso) + "</b><span>" + esc(x.detalle) + "</span></div><span></span></div>";
      }).join("");
  }

  document.addEventListener("click", function (e) {
    var nav = e.target.closest("[data-go]");
    if (nav) { ir(nav.dataset.go); return; }

    var ayuda = e.target.closest("[data-ayuda]");
    if (ayuda) { abrirAyuda(ayuda.dataset.ayuda); return; }

    var act = e.target.closest("[data-act]");
    if (act && act.dataset.act === "tema") {
      var cur = document.documentElement.getAttribute("data-theme");
      var oscuro = cur ? cur === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
      document.documentElement.setAttribute("data-theme", oscuro ? "light" : "dark");
      dibujarTodo();
      return;
    }

    var hoja = e.target.closest("[data-hoja]");
    if (hoja) { abrirHoja(hoja.dataset.hoja); return; }

    var btn = e.target.closest("[data-accion]");
    if (btn && !btn.disabled) { ejecutar(btn); return; }

    var chip = e.target.closest("[data-filtro]");
    if (chip) { filtrarHistorial(chip); return; }

    var simBtn = e.target.closest("[data-simulacro]");
    if (simBtn && !simBtn.disabled) { abrirModalSimulacro(simBtn.dataset.simulacro, "lanzar"); return; }

    var optimBtn = e.target.closest("[data-optim-aplicar]");
    if (optimBtn) {
      var elOptim = $("panel-sugerencias-indices");
      var listaOptim = elOptim ? JSON.parse(elOptim.dataset.sugerencias || "[]") : [];
      var sug = listaOptim[Number(optimBtn.dataset.optimAplicar)];
      if (sug) {
        abrirConfirmar("APLICAR", "Se creará un índice en la tabla " + sug.tabla + ". Es una operación segura y no borra datos, pero puede tardar unos segundos.", function () {
          optimBtn.disabled = true;
          tareaTrabajando("Aplicando el índice…", "Tabla " + sug.tabla + ". Puede tardar unos segundos.");
          postZeus("/api/optimizacion/aplicar", { comando: sug.comando }).then(function (d) {
            var log = "$ " + sug.comando + (d && d.salida ? "\n" + d.salida : "");
            if (d && d.ok) {
              optimMarcarAplicado(sug.comando, sug.comando);
              tareaLista("Índice aplicado.", "La tabla " + sug.tabla + " debería responder más rápido. Tardó " + (d.ms != null ? (d.ms / 1000).toFixed(1) + " s" : "—") + ".", {
                log: log,
                onRevertir: function () { optimRevertir(sug.comando, sug.tabla); },
              });
            } else {
              tareaFallo("No se pudo aplicar", (d && d.mensaje) || "Inténtalo de nuevo en un momento.", { log: log });
            }
            cargarOptimizacion();
          }).catch(function () { tareaFallo("No hay conexión con el servidor", ""); }).finally(function () { optimBtn.disabled = false; });
        });
      }
      return;
    }

    var optimRevBtn = e.target.closest("[data-optim-revertir]");
    if (optimRevBtn) {
      var elOptimR = $("panel-sugerencias-indices");
      var listaOptimR = elOptimR ? JSON.parse(elOptimR.dataset.sugerencias || "[]") : [];
      var sugR = listaOptimR[Number(optimRevBtn.dataset.optimRevertir)];
      if (sugR) optimRevertir(sugR.comando, sugR.tabla);
      return;
    }

    var eliminarIndiceBtn = e.target.closest("[data-eliminar-indice]");
    if (eliminarIndiceBtn) {
      var tablaEI = eliminarIndiceBtn.dataset.tabla, indiceEI = eliminarIndiceBtn.dataset.indice;
      // La base no queda seleccionada por defecto en mysql() — sin el esquema
      // explícito (DB_ESQUEMA, el mismo que usa optimComandoRevertir
      // más abajo), MariaDB no encuentra la tabla.
      var comandoEI = "DROP INDEX `" + indiceEI + "` ON `" + DB_ESQUEMA + "`.`" + tablaEI + "`;";
      abrirConfirmar("ELIMINAR", "Se eliminará el índice " + indiceEI + " de la tabla " + tablaEI + ". Ya está cubierto por otro índice, así que las consultas siguen igual de rápidas; solo se libera espacio y las escrituras van un poco más rápido. Si una llave foránea lo necesita, la base rechaza el cambio sola.", function () {
        eliminarIndiceBtn.disabled = true;
        tareaTrabajando("Eliminando el índice…", tablaEI + "." + indiceEI);
        postZeus("/api/optimizacion/aplicar", { comando: comandoEI }).then(function (d) {
          if (d && d.ok) tareaLista("Índice eliminado.", tablaEI + "." + indiceEI + " ya no existe.", { log: "$ " + comandoEI });
          else tareaFallo("No se pudo eliminar", (d && d.mensaje) || "Puede que una llave foránea lo necesite.", { log: "$ " + comandoEI });
          cargarAuditoriaOptim();
        }).catch(function () { tareaFallo("No hay conexión con el servidor", ""); }).finally(function () { eliminarIndiceBtn.disabled = false; });
      });
      return;
    }

    var repararPermisoBtn = e.target.closest("[data-reparar-permiso]");
    if (repararPermisoBtn) {
      var archivoRP = repararPermisoBtn.dataset.archivo;
      abrirConfirmar("PERMISOS", "Se va a dejar " + archivoRP + " en permiso 640 (solo el dueño lo escribe, el grupo lo lee, nadie más puede abrirlo). No cambia el contenido del archivo.", function () {
        repararPermisoBtn.disabled = true;
        tareaTrabajando("Corrigiendo el permiso…", archivoRP);
        postZeus("/api/seguridad/reparar-permisos", { archivo: archivoRP }).then(function (d) {
          if (d && d.ok) tareaLista("Permiso corregido.", d.mensaje || (archivoRP + " quedó en 640."));
          else tareaFallo("No se pudo corregir el permiso", (d && d.mensaje) || "Inténtalo de nuevo en un momento.");
          cargarAuditoriaCompleta();
        }).catch(function () { tareaFallo("No hay conexión con el servidor", ""); }).finally(function () { repararPermisoBtn.disabled = false; });
      });
      return;
    }

    var repararMotorBtn = e.target.closest("[data-reparar-motor]");
    if (repararMotorBtn) {
      var tablaRM = repararMotorBtn.dataset.tabla;
      abrirConfirmar("INNODB", "Se pasará la tabla " + tablaRM + " de MyISAM a InnoDB (ALTER TABLE ... ENGINE=InnoDB). Es reversible, pero bloquea escrituras en esa tabla mientras corre — en una tabla grande puede tardar varios minutos.", function () {
        repararMotorBtn.disabled = true;
        tareaTrabajando("Cambiando el motor de la tabla…", tablaRM + " — esto puede tardar si la tabla es grande.");
        postZeus("/api/optimizacion/reparar-motor", { tabla: tablaRM }).then(function (d) {
          if (d && d.ok) tareaLista("Motor cambiado.", d.mensaje || (tablaRM + " ya usa InnoDB."));
          else tareaFallo("No se pudo cambiar el motor", (d && d.mensaje) || "Inténtalo de nuevo en un momento.");
          cargarAuditoriaOptim();
        }).catch(function () { tareaFallo("No hay conexión con el servidor", ""); }).finally(function () { repararMotorBtn.disabled = false; });
      });
      return;
    }

    var optimizarTablaBtn = e.target.closest("[data-optimizar-tabla]");
    if (optimizarTablaBtn) {
      var tablaOT = optimizarTablaBtn.dataset.tabla;
      abrirConfirmar("OPTIMIZAR", "Se va a desfragmentar la tabla " + tablaOT + " (OPTIMIZE TABLE). No borra ni cambia datos, pero bloquea escrituras en esa tabla mientras corre — en una tabla grande puede tardar varios minutos.", function () {
        optimizarTablaBtn.disabled = true;
        tareaTrabajando("Desfragmentando la tabla…", tablaOT + " — esto puede tardar si la tabla es grande.");
        postZeus("/api/optimizacion/optimizar-tabla", { tabla: tablaOT }).then(function (d) {
          if (d && d.ok) tareaLista("Tabla desfragmentada.", d.mensaje || (tablaOT + " quedó reconstruida."));
          else tareaFallo("No se pudo desfragmentar", (d && d.mensaje) || "Inténtalo de nuevo en un momento.");
          cargarAuditoriaOptim();
        }).catch(function () { tareaFallo("No hay conexión con el servidor", ""); }).finally(function () { optimizarTablaBtn.disabled = false; });
      });
      return;
    }

    var subirConexionesBtn = e.target.closest("[data-subir-conexiones]");
    if (subirConexionesBtn) {
      var valorSC = subirConexionesBtn.dataset.valor;
      abrirConfirmar("CONEXIONES", "Se va a subir max_connections a " + valorSC + ". Se aplica al instante, sin reiniciar la base ni cortar las conexiones que ya están abiertas.", function () {
        subirConexionesBtn.disabled = true;
        tareaTrabajando("Subiendo el tope de conexiones…", "");
        postZeus("/api/optimizacion/subir-conexiones", { valor: Number(valorSC) }).then(function (d) {
          if (d && d.ok) tareaLista("Tope subido.", d.mensaje || ("max_connections quedó en " + valorSC + "."));
          else tareaFallo("No se pudo subir el tope", (d && d.mensaje) || "Inténtalo de nuevo en un momento.");
          cargarAuditoriaOptim();
        }).catch(function () { tareaFallo("No hay conexión con el servidor", ""); }).finally(function () { subirConexionesBtn.disabled = false; });
      });
      return;
    }

    var reducirKeyBufferBtn = e.target.closest("[data-reducir-key-buffer]");
    if (reducirKeyBufferBtn) {
      abrirConfirmar("MEMORIA", "Se va a bajar key_buffer_size a 8 MB. Se aplica al instante, sin reiniciar la base — esa memoria no la está usando ninguna tabla MyISAM real.", function () {
        reducirKeyBufferBtn.disabled = true;
        tareaTrabajando("Liberando memoria…", "");
        postZeus("/api/optimizacion/reducir-key-buffer", {}).then(function (d) {
          if (d && d.ok) tareaLista("Memoria liberada.", d.mensaje || "key_buffer_size quedó en 8 MB.");
          else tareaFallo("No se pudo liberar la memoria", (d && d.mensaje) || "Inténtalo de nuevo en un momento.");
          cargarAuditoriaOptim();
        }).catch(function () { tareaFallo("No hay conexión con el servidor", ""); }).finally(function () { reducirKeyBufferBtn.disabled = false; });
      });
      return;
    }

    var explicarIaBtn = e.target.closest("[data-explicar-ia]");
    if (explicarIaBtn) {
      var contenedorIA = explicarIaBtn.closest(".revision, .fila");
      var yaExplicado = contenedorIA && contenedorIA.querySelector(".explicacion-ia");
      if (yaExplicado) { yaExplicado.remove(); return; }
      explicarIaBtn.disabled = true;
      var textoOrigIA = explicarIaBtn.textContent;
      explicarIaBtn.textContent = "Pensando…";
      postZeus("/api/hallazgo/explicar", {
        titulo: explicarIaBtn.dataset.titulo || "",
        significado: explicarIaBtn.dataset.significado || "",
        detalle: explicarIaBtn.dataset.detalle || "",
      }).then(function (d) {
        var p = document.createElement("p");
        p.className = "note explicacion-ia";
        p.style.cssText = "padding-left:34px;margin-top:6px;white-space:pre-wrap";
        p.textContent = (d && d.ok) ? d.texto : ((d && d.mensaje) || "No se pudo consultar la IA ahora mismo.");
        if (contenedorIA) contenedorIA.appendChild(p);
      }).catch(function () {
        var p = document.createElement("p");
        p.className = "note explicacion-ia";
        p.textContent = "No hay conexión con el servidor.";
        if (contenedorIA) contenedorIA.appendChild(p);
      }).finally(function () { explicarIaBtn.disabled = false; explicarIaBtn.textContent = textoOrigIA; });
      return;
    }

    var optimExplBtn = e.target.closest("[data-optim-explicar]");
    if (optimExplBtn) {
      var elOptimE = $("panel-sugerencias-indices");
      var listaOptimE = elOptimE ? JSON.parse(elOptimE.dataset.sugerencias || "[]") : [];
      var sugE = listaOptimE[Number(optimExplBtn.dataset.optimExplicar)];
      if (sugE) {
        optimExplBtn.disabled = true;
        tareaTrabajando("Centi está pensando…", "Buscando por qué es lenta y dónde se usa en el código.");
        postZeus("/api/optimizacion/explicar", {
          tabla: sugE.tabla, columnas: sugE.columnas, tipo_consulta: sugE.tipo_consulta, ejemplo_sql: sugE.ejemplo_sql
        }).then(function (d) {
          if (d && d.ok) tareaLista("Explicación de Centi", d.explicacion, d.ubicaciones_codigo ? { log: d.ubicaciones_codigo } : {});
          else tareaFallo("No se pudo explicar", (d && d.mensaje) || "Inténtalo de nuevo en un momento.");
        }).catch(function () { tareaFallo("No hay conexión con el servidor", ""); }).finally(function () { optimExplBtn.disabled = false; });
      }
      return;
    }

    var bdBtn = e.target.closest("[data-bd-matar]");
    if (bdBtn) {
      var elBd = $("panel-bd-procesos");
      var listaBd = elBd ? JSON.parse(elBd.dataset.procesos || "[]") : [];
      var proc = listaBd[Number(bdBtn.dataset.bdMatar)];
      if (proc) {
        var pid = proc.pid != null ? proc.pid : proc.id;
        abrirConfirmar("MATAR", "Se va a detener la consulta " + pid + ". Si era una venta en curso, el cliente tendría que intentarlo de nuevo.", function () {
          bdBtn.disabled = true;
          postZeus("/api/bd/matar", { pid: pid, id: pid }).then(function (d) {
            if (d && d.ok) tareaLista("Consulta detenida.", "");
            else tareaFallo("No se pudo detener", (d && d.mensaje) || "");
            cargarBdProcesos();
          }).catch(function () { tareaFallo("No hay conexión con el servidor", ""); }).finally(function () { bdBtn.disabled = false; });
        });
      }
      return;
    }

    var rbBtn = e.target.closest("[data-runbook]");
    if (rbBtn) {
      var elRb = $("panel-runbooks");
      var listaRb = elRb ? JSON.parse(elRb.dataset.runbooks || "[]") : [];
      var rb = listaRb[Number(rbBtn.dataset.runbook)];
      if (rb) {
        abrirConfirmar("EJECUTAR", "Se van a ejecutar " + ((rb.pasos || []).length) + " paso(s) automáticos: " + (rb.descripcion || rb.titulo) + ".", function () {
          ejecutarRunbook(rb, rbBtn);
        });
      }
      return;
    }

    var despBtn = e.target.closest("#desp-iniciar");
    if (despBtn) {
      despBtn.disabled = true;
      tareaTrabajando("Iniciando observación…", "Se vigilará el servidor unos minutos tras el despliegue.");
      postZeus("/api/despliegue/observar", {}).then(function (d) {
        if (d && d.ok) tareaLista("Observación iniciada.", d.mensaje || "");
        else tareaFallo("No se pudo iniciar", (d && d.mensaje) || "");
        cargarDespliegueObservacion();
      }).catch(function () { tareaFallo("No hay conexión con el servidor", ""); }).finally(function () { despBtn.disabled = false; });
      return;
    }

    var modoBtn = e.target.closest("#modo-viaje-btn");
    if (modoBtn && !modoBtn.disabled) {
      var activarA = modoBtn.dataset.modoViajeEstado !== "1";
      modoBtn.disabled = true;
      postZeus("/api/modo", { activo: activarA }).then(function () { cargarModoViaje(); })
        .catch(function () { aviso("No se pudo cambiar el modo viaje."); })
        .finally(function () { modoBtn.disabled = false; });
      return;
    }

    var escActivoBtn = e.target.closest("#escalamiento-activo-btn");
    if (escActivoBtn && !escActivoBtn.disabled) {
      var nuevoActivo = escActivoBtn.dataset.escalamientoActivo !== "1";
      escActivoBtn.disabled = true;
      postZeus("/api/escalamiento/config", { activo: nuevoActivo }).then(function (d) {
        if (!d || !d.ok) aviso((d && d.mensaje) || "No se pudo guardar.");
        cargarEscalamiento();
      }).catch(function () { aviso("No se pudo cambiar la escalada."); })
        .finally(function () { escActivoBtn.disabled = false; });
      return;
    }

    var escGuardarBtn = e.target.closest("#escalamiento-guardar-btn");
    if (escGuardarBtn && !escGuardarBtn.disabled) {
      var input = $("escalamiento-tecnico-input");
      var valor = input ? input.value.trim() : "";
      escGuardarBtn.disabled = true;
      postZeus("/api/escalamiento/config", { tecnico: valor || null }).then(function (d) {
        if (!d || !d.ok) aviso((d && d.mensaje) || "Número inválido.");
        else aviso("Guardado.");
        cargarEscalamiento();
      }).catch(function () { aviso("No se pudo guardar el número."); })
        .finally(function () { escGuardarBtn.disabled = false; });
      return;
    }

    var escAcusarBtn = e.target.closest("[data-escalamiento-acusar]");
    if (escAcusarBtn && !escAcusarBtn.disabled) {
      escAcusarBtn.disabled = true;
      postZeus("/api/escalamiento/acusar", {}).then(function () { cargarEscalamiento(); })
        .catch(function () { aviso("No se pudo confirmar."); })
        .finally(function () { escAcusarBtn.disabled = false; });
      return;
    }
  });

  var copiarInformeBtn = $("copiar-informe");
  if (copiarInformeBtn) {
    copiarInformeBtn.addEventListener("click", function () {
      var texto = ultimoResumenTexto || "Centinela Zeus: sin datos todavía.";
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(texto).then(function () { aviso("Informe copiado."); }, function () { aviso("No se pudo copiar."); });
      } else {
        aviso("No se pudo copiar en este navegador.");
      }
    });
  }

  /* =========================================================================
     Gráficas (SVG a mano, igual que antes)
     ========================================================================= */
  var W = 720, H = 190, PL = 46, PR = 14, PT = 14, PB = 26;
  var svgNS = "http://www.w3.org/2000/svg";
  var series = {};

  function el(tag, attrs) {
    var n = document.createElementNS(svgNS, tag);
    for (var k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  }

  function dibujar(hostId, tipId, datos, unidad, etiqueta) {
    var host = $(hostId);
    if (!host) return;
    series[hostId] = { datos: datos, unidad: unidad, etiqueta: etiqueta, tip: tipId };
    var viejo = host.querySelector("svg");
    if (viejo) viejo.remove();
    if (!datos || datos.length < 2) {
      var previo = host.querySelector(".note");
      if (!previo) host.insertAdjacentHTML("afterbegin", '<p class="note" style="padding:14px 0">Todavía no hay historial suficiente.</p>');
      return;
    }

    var vals = datos.map(function (d) { return d[1]; });
    var max = Math.max(100, Math.ceil(Math.max.apply(null, vals) / 10) * 10);
    var min = 0, n = datos.length - 1;
    var x = function (i) { return PL + (i / n) * (W - PL - PR); };
    var y = function (v) { return PT + (1 - (v - min) / (max - min)) * (H - PT - PB); };

    var s = el("svg", { viewBox: "0 0 " + W + " " + H, "class": "chart", role: "img", "aria-label": etiqueta });

    for (var g = 0; g <= 4; g++) {
      var vv = min + (max - min) * (g / 4), yy = y(vv);
      s.appendChild(el("line", { x1: PL, x2: W - PR, y1: yy, y2: yy, stroke: "var(--border)", "stroke-width": 1 }));
      var t = el("text", { x: PL - 8, y: yy + 3.5, "text-anchor": "end", fill: "var(--ink-3)", "font-size": 10 });
      t.textContent = Math.round(vv) + unidad;
      s.appendChild(t);
    }

    [0, Math.floor(n / 3), Math.floor((2 * n) / 3), n].forEach(function (i) {
      var d = new Date(datos[i][0] * 1000);
      var tx = el("text", { x: x(i), y: H - 8, "text-anchor": i === 0 ? "start" : i === n ? "end" : "middle", fill: "var(--ink-3)", "font-size": 10 });
      tx.textContent = d.toLocaleString("es-CO", { hour: "2-digit", minute: "2-digit", day: n > 60 ? "2-digit" : undefined, month: n > 60 ? "2-digit" : undefined, timeZone: "America/Bogota" });
      s.appendChild(tx);
    });

    var dArea = "M" + x(0) + " " + y(datos[0][1]);
    datos.forEach(function (p, i) { dArea += " L" + x(i) + " " + y(p[1]); });
    dArea += " L" + x(n) + " " + y(min) + " L" + x(0) + " " + y(min) + " Z";
    s.appendChild(el("path", { d: dArea, fill: "var(--accent)", "fill-opacity": ".12" }));

    var dLine = "";
    datos.forEach(function (p, i) { dLine += (i ? " L" : "M") + x(i) + " " + y(p[1]); });
    s.appendChild(el("path", { d: dLine, fill: "none", stroke: "var(--accent)", "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));
    s.appendChild(el("circle", { cx: x(n), cy: y(datos[n][1]), r: 4.5, fill: "var(--accent)", stroke: "var(--surface)", "stroke-width": 2 }));

    var cruz = el("line", { x1: 0, x2: 0, y1: PT, y2: H - PB, stroke: "var(--ink-3)", "stroke-width": 1, opacity: 0 });
    var punto = el("circle", { r: 4, fill: "var(--accent)", stroke: "var(--surface)", "stroke-width": 2, opacity: 0 });
    s.appendChild(cruz); s.appendChild(punto);
    s.appendChild(el("rect", { x: PL, y: PT, width: W - PL - PR, height: H - PT - PB, fill: "transparent" }));
    host.insertBefore(s, host.firstChild);

    var tip = $(tipId);
    s.addEventListener("mousemove", function (ev) {
      var r = s.getBoundingClientRect();
      var px = ((ev.clientX - r.left) / r.width) * W;
      if (px < PL || px > W - PR) return;
      var i = Math.max(0, Math.min(n, Math.round(((px - PL) / (W - PL - PR)) * n)));
      cruz.setAttribute("x1", x(i)); cruz.setAttribute("x2", x(i)); cruz.setAttribute("opacity", ".5");
      punto.setAttribute("cx", x(i)); punto.setAttribute("cy", y(datos[i][1])); punto.setAttribute("opacity", 1);
      if (tip) {
        tip.style.opacity = 1;
        tip.style.left = (x(i) / W) * 100 + "%";
        tip.style.top = (y(datos[i][1]) / H) * r.height + "px";
        tip.textContent = datos[i][1] + unidad + " · " + new Date(datos[i][0] * 1000).toLocaleString("es-CO", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "America/Bogota" });
      }
    });
    s.addEventListener("mouseleave", function () {
      cruz.setAttribute("opacity", 0); punto.setAttribute("opacity", 0);
      if (tip) tip.style.opacity = 0;
    });
  }

  function dibujarTodo() {
    Object.keys(series).forEach(function (k) {
      var s = series[k];
      dibujar(k, s.tip, s.datos, s.unidad, s.etiqueta);
    });
  }

  function tile(k, v, pct, nivel, pie) {
    return '<div class="tile"><span class="k">' + k + '</span><span class="v">' + v + "</span>" +
      '<div class="bar"><i class="' + nivel + '" style="width:' + Math.min(100, Math.max(2, pct)) + '%"></i></div>' +
      '<span class="foot">' + esc(pie) + "</span></div>";
  }

  // Número compacto sin falsos ceros: 4530 → "4.5K" (antes: dividir siempre
  // por 1M mostraba "0.0M" para cualquier valor bajo un millón).
  function numeroCorto(n) {
    n = Number(n) || 0;
    if (n >= 1000000) return (n / 1000000).toFixed(1) + "<small>M</small>";
    if (n >= 1000) return (n / 1000).toFixed(1) + "<small>K</small>";
    return String(n);
  }

  /* =========================================================================
     Inicio: veredicto + pendientes + servicios + recursos.
     Combina /api/estado con /api/prediccion (frase por recurso) y
     /api/incidentes (para el bloque de crisis).
     ========================================================================= */
  var ultimoOk = null;          // { ts, d, pred, inc } — última lectura correcta
  var ultimoResumenTexto = "";
  var pronosticoPorRecurso = {};

  function pintarServicios(contenedores) {
    $("sub-serv").textContent = contenedores.length + " de " + contenedores.length + " funcionando";
    var arriba = contenedores.filter(function (c) { return c.estado === "running" && c.salud !== "unhealthy"; }).length;
    $("sub-serv").textContent = arriba + " de " + contenedores.length + " funcionando";

    // tabla técnica oculta (compatibilidad con el formato anterior)
    $("tb-contenedores").innerHTML = contenedores.map(function (c) {
      var sano = c.estado === "running" && c.salud !== "unhealthy";
      return "<tr><td><b>" + esc(c.nombre) + "</b></td><td>" + esc(c.descripcion) + "</td><td>" +
        pill(sano ? "ok" : "crit", c.estado === "running" ? (c.salud === "unhealthy" ? "No responde" : "Sano") : "Detenido") +
        '</td><td class="num">' + esc(c.memoria) + '</td><td class="num">' + c.reinicios +
        '</td><td style="text-align:right"><button class="btn sm' + (conDatos(c.nombre) ? " danger" : "") +
        '" data-accion="reiniciar_contenedor" data-objetivo="' + esc(c.nombre) + '"' +
        (conDatos(c.nombre) ? ' data-confirmar="' + esc(c.nombre) + '"' : "") + ">Reiniciar</button></td></tr>";
    }).join("");

    // lista visible, con nombre amable primero
    $("tb-contenedores-lista").innerHTML = contenedores.map(function (c) {
      var sano = c.estado === "running" && c.salud !== "unhealthy";
      var info = infoServicio(c.nombre);
      var estadoTxt = c.estado === "running" ? (c.salud === "unhealthy" ? "No responde" : "Funciona") : "Apagado";
      var reinicioTxt = c.reinicios > 0 ? "se reinició solo " + c.reinicios + (c.reinicios === 1 ? " vez hoy" : " veces hoy") : "sin novedad";
      return '<li class="' + (sano ? "" : "crit") + '">' +
        '<span class="led"></span>' +
        '<div><div class="n">' + esc(info.amigable) + ' <span class="tec">' + esc(c.nombre) + '</span></div><div class="d">' + esc(info.hace || c.descripcion) + '</div></div>' +
        '<span class="st">' + estadoTxt + '<small>' + esc(reinicioTxt) + '</small></span>' +
        '<button class="btn sm' + (conDatos(c.nombre) ? " danger" : "") + '" data-accion="reiniciar_contenedor" data-objetivo="' + esc(c.nombre) + '"' +
        (conDatos(c.nombre) ? ' data-confirmar="' + esc(c.nombre) + '"' : "") +
        (c.nombre === "zeus-centinela" ? " disabled title=\"Se reinicia solo\"" : "") + ">Reiniciar</button></li>";
    }).join("");
  }

  function fraseRecurso(nombre) {
    var p = pronosticoPorRecurso[nombre];
    return p && p.texto ? p.texto : "";
  }

  function pintarRecursos(d) {
    // #tiles fue retirado del HTML (quedaba duplicado con "Panorama en vivo").
    // Se deja esta función sin usar por si algo la sigue llamando: sin el
    // guard de abajo, $("tiles") devuelve null y .innerHTML rompería toda
    // la cadena de refrescarResumen().
    if (!$("tiles")) return;
    var nivelRam = d.ram.pct >= 90 ? "crit" : d.ram.pct >= 80 ? "warn" : "";
    var nivelDisco = d.disco.pct >= 90 ? "crit" : d.disco.pct >= 80 ? "warn" : "";
    var nivelCpu = d.cpu.pct >= 90 ? "crit" : d.cpu.pct >= 80 ? "warn" : "";
    $("tiles").innerHTML = [
      tile("Memoria", d.ram.pct + "<small>%</small>", d.ram.pct, nivelRam, gb(d.ram.usada) + " GB usados de " + gb(d.ram.total) + " GB. " + fraseRecurso("memoria")),
      tile("Disco", d.disco.pct + "<small>%</small>", d.disco.pct, nivelDisco, gb(d.disco.libre) + " GB libres. " + fraseRecurso("disco")),
      tile("Procesador", d.cpu.pct + "<small>%</small>", d.cpu.pct, nivelCpu, "Tranquilo. " + fraseRecurso("procesador"))
    ].join("");
  }

  function textoRevisadoHace() {
    if (!ultimoOk) return "";
    var s = Math.max(0, Math.round((Date.now() - ultimoOk.ts) / 1000));
    return s < 60 ? "hace " + s + " s" : "hace " + Math.round(s / 60) + " min";
  }

  // Refleja el estado global en #zeus-app[data-estado] para que el punto rojo
  // de la pestaña "Inicio" (rail y tabbar) aparezca en crisis o sin conexión.
  function marcarEstadoApp(nombre) {
    var app = $("zeus-app");
    if (app) app.dataset.estado = nombre;
  }

  function renderVeredicto() {
    var bloque = $("estado-bloque");
    var hechoBloque = $("estado-hecho-bloque");
    var accionesBloque = $("estado-acciones-bloque");
    var offBloque = $("estado-off-bloque");

    if (!ultimoOk) {
      // sin ningún dato todavía (primera carga)
      bloque.className = "estado mute";
      marcarEstadoApp("cargando");
      $("estado-titulo").textContent = "Cargando…";
      $("estado-desc").textContent = "Leyendo el estado del servidor.";
      hechoBloque.hidden = true; accionesBloque.hidden = true; offBloque.hidden = true;
      return;
    }

    if (ultimoOk.sinConexion) {
      bloque.className = "estado off";
      marcarEstadoApp("off");
      document.title = "● Sin conexión — Centinela Zeus";
      $("estado-titulo").textContent = "No logramos conectar con el servidor";
      var minutos = minutosDesde(ultimoOk.ts);
      $("estado-desc").innerHTML = "Último dato recibido a las " + horaCO(ultimoOk.ts) + ", <b>hace " + minutos + (minutos === 1 ? " minuto" : " minutos") + "</b>. Puede estar reiniciándose: espera unos minutos. Si sigue igual, avisa al técnico.";
      hechoBloque.hidden = true; accionesBloque.hidden = true; offBloque.hidden = false;
      $("resto-inicio").classList.add("viejo");
      $("etiqueta-viejo").hidden = false;
      $("pill-estado").className = "pill mute";
      $("pill-estado").innerHTML = '<span class="ic"></span>Sin conexión · ' + minutos + " min";
      return;
    }

    $("resto-inicio").classList.remove("viejo");
    $("etiqueta-viejo").hidden = true;

    var d = ultimoOk.d, inc = ultimoOk.inc;
    var contenedores = d.contenedores || [];
    var caido = contenedores.filter(function (c) { return !(c.estado === "running" && c.salud !== "unhealthy"); })[0];
    var criticos = (d.avisos || []).filter(function (a) { return a.nivel === "crit"; }).length;

    if (caido || criticos) {
      var info = caido ? infoServicio(caido.nombre) : null;
      var titulo = caido ? info.amigable + " está caído" : "Algo está fallando";
      bloque.className = "estado crit";
      marcarEstadoApp("crisis");
      document.title = "● " + (caido ? info.amigable + " caído" : "Falla") + " — Centinela Zeus";
      $("estado-titulo").textContent = titulo;
      var impacto = caido ? info.impacto : "Revisa los avisos de abajo.";
      $("estado-desc").innerHTML = (inc && inc.abierto && inc.abierto.inicio ? "Desde las " + fechaHoraCO(inc.abierto.inicio) + " · " : "") + esc(impacto);
      $("pill-estado").className = "pill crit";
      $("pill-estado").innerHTML = '<span class="ic"></span>' + (caido ? info.amigable + " caído" : "Requiere atención");

      hechoBloque.hidden = !(inc && inc.abierto);
      if (inc && inc.abierto) $("estado-hecho-texto").textContent = inc.abierto.causa || inc.abierto.descripcion || "Centinela está intentando resolverlo automáticamente.";

      accionesBloque.hidden = false;
      if (caido) {
        var confirmar = conDatos(caido.nombre) ? ' data-confirmar="' + esc(caido.nombre) + '"' : "";
        $("estado-accion-principal").innerHTML =
          '<button class="btn primary' + (confirmar ? " danger" : "") + '" data-accion="reiniciar_contenedor" data-objetivo="' + esc(caido.nombre) + '"' + confirmar + '>Reiniciar ' + esc(info.articulo) + '</button>' +
          '<span class="coste">Un par de minutos · no debería perderse nada</span>';
      } else {
        $("estado-accion-principal").innerHTML = '<span class="coste">Revisa los pendientes de abajo.</span>';
      }
      $("estado-acciones-secundarias").innerHTML =
        '<button class="link" data-accion="reiniciar_servidor" data-confirmar="REINICIAR">Si no funciona: reiniciar el servidor completo</button>' +
        '<button class="link" data-hoja="informe">Enviar informe al técnico por WhatsApp</button>';
      offBloque.hidden = true;
      return;
    }

    hechoBloque.hidden = true; accionesBloque.hidden = true; offBloque.hidden = true;
    var avisos = d.avisos || [];
    if (avisos.length) {
      bloque.className = "estado warn";
      marcarEstadoApp("warn");
      document.title = "Centinela Zeus";
      $("estado-titulo").textContent = "Funciona, con " + avisos.length + (avisos.length === 1 ? " pendiente" : " pendientes");
      $("pill-estado").className = "pill warn";
      $("pill-estado").innerHTML = '<span class="ic"></span>Funciona, con ' + avisos.length + (avisos.length === 1 ? " pendiente" : " pendientes");
    } else {
      bloque.className = "estado ok";
      marcarEstadoApp("ok");
      document.title = "Centinela Zeus";
      $("estado-titulo").textContent = "Todo funciona";
      $("pill-estado").className = "pill ok";
      $("pill-estado").innerHTML = '<span class="ic"></span>Todo funciona';
    }
    $("estado-desc").textContent = "El bot atiende y la tienda vende. Revisado " + textoRevisadoHace() + ".";
  }

  function pintarPendientes() {
    if (!ultimoOk || ultimoOk.sinConexion) return;
    var avisos = ultimoOk.d.avisos || [];
    $("avisos").innerHTML = avisos.length
      ? avisos.map(function (a) {
          return '<li class="' + a.nivel + '"><div><b>' + esc(a.texto) + '</b><span class="d">' + esc(a.detalle) + '</span></div><span></span></li>';
        }).join("")
      : '<li class="ok"><div><b>Todo en orden</b><span class="d">Ningún servicio requiere atención.</span></div><span></span></li>';
    $("pill-avisos").innerHTML = avisos.length ? pill(avisos.some(function (a) { return a.nivel === "crit"; }) ? "crit" : "warn", avisos.length + (avisos.length === 1 ? " pendiente" : " pendientes")) : "";
  }

  /* =========================================================================
     Panorama en vivo: anillos de estado en un solo pantallazo, con solo lo que
     importa en un servidor de un negocio (no miles de nodos): procesador,
     memoria, disco, cuántos servicios propios están sanos, y qué tan rápido
     responde el bot — este último no lo tiene ningún panel genérico porque
     es específico del negocio, no de la infraestructura.
     ========================================================================= */
  var panoramaSerie = { cpu: null, ram: null };
  function anilloSvg(pct) {
    var r = 46, c = 2 * Math.PI * r;
    var p = Math.max(0, Math.min(100, pct || 0));
    var offset = c * (1 - p / 100);
    return '<svg viewBox="0 0 108 108" aria-hidden="true">' +
      '<circle class="pista" cx="54" cy="54" r="' + r + '"/>' +
      '<circle class="valor" cx="54" cy="54" r="' + r + '" stroke-dasharray="' + c.toFixed(1) + '" stroke-dashoffset="' + offset.toFixed(1) + '"/>' +
      "</svg>";
  }
  function chispaSvg(valores) {
    if (!valores || valores.length < 2) return "";
    var w = 100, h = 22;
    var max = Math.max.apply(null, valores), min = Math.min.apply(null, valores);
    var rango = (max - min) || 1;
    var pts = valores.map(function (v, i) {
      var x = (i / (valores.length - 1)) * w;
      var y = h - ((v - min) / rango) * (h - 3) - 1.5;
      return x.toFixed(1) + "," + y.toFixed(1);
    });
    var area = "M0," + h + " L" + pts.join(" L") + " L" + w + "," + h + " Z";
    return '<svg class="chispa" viewBox="0 0 ' + w + " " + h + '" preserveAspectRatio="none" aria-hidden="true">' +
      '<path class="area" d="' + area + '"></path>' +
      '<polyline points="' + pts.join(" ") + '"></polyline>' +
      "</svg>";
  }
  function colorPorPct(pct, umbralWarn, umbralCrit) {
    if (pct >= umbralCrit) return "var(--crit)";
    if (pct >= umbralWarn) return "var(--warn)";
    return "var(--good)";
  }
  function pgTarjeta(id, o) {
    var el = $(id);
    if (!el) return;
    el.style.setProperty("--pg-color", o.color);
    el.innerHTML =
      '<div class="anillo">' + anilloSvg(o.pct) +
      '<div class="centro"><span class="num">' + esc(o.num) + "</span>" +
      (o.unidad ? '<span class="unidad">' + esc(o.unidad) + "</span>" : "") + "</div></div>" +
      '<div class="etiqueta">' + esc(o.etiqueta) + "</div>" +
      '<div class="detalle">' + esc(o.detalle || "") + "</div>" +
      (o.chispa ? chispaSvg(o.chispa) : "");
  }
  function pintarPanorama(d) {
    if (!d) return;
    var horaEl = $("panorama-hora");
    if (horaEl) horaEl.textContent = "Actualizado " + textoRevisadoHace();

    pgTarjeta("pg-cpu", {
      pct: d.cpu.pct, num: d.cpu.pct, unidad: "%", color: colorPorPct(d.cpu.pct, 85, 96),
      etiqueta: "Procesador", detalle: "carga " + (d.cpu.carga != null ? d.cpu.carga.toFixed(2) : "—") + " · 2 vCPU",
      chispa: panoramaSerie.cpu,
    });
    pgTarjeta("pg-ram", {
      pct: d.ram.pct, num: d.ram.pct, unidad: "%", color: colorPorPct(d.ram.pct, 80, 92),
      etiqueta: "Memoria", detalle: gb(d.ram.usada) + " de " + gb(d.ram.total) + " GB",
      chispa: panoramaSerie.ram,
    });
    pgTarjeta("pg-disco", {
      pct: d.disco.pct, num: d.disco.pct, unidad: "%", color: colorPorPct(d.disco.pct, 80, 92),
      etiqueta: "Disco", detalle: gb(d.disco.usado) + " de " + gb(d.disco.total) + " GB",
    });

    var arriba = (d.servicios && d.servicios.arriba) || 0, total = (d.servicios && d.servicios.total) || 0;
    var pctServ = total ? Math.round((arriba / total) * 100) : 100;
    pgTarjeta("pg-contenedores", {
      pct: pctServ, num: arriba + "/" + total, unidad: "", color: arriba === total ? "var(--good)" : (pctServ < 50 ? "var(--crit)" : "var(--warn)"),
      etiqueta: "Servicios", detalle: arriba === total ? "todos funcionando" : (total - arriba) + " con problema",
    });

    var lat = panoramaLatencia;
    if (lat && lat.ultima_hora && lat.ultima_hora.promedio_ms != null) {
      var ms = lat.ultima_hora.promedio_ms;
      var pctBot = Math.max(0, Math.min(100, 100 - (ms / 5000) * 100)); // 0 ms = anillo lleno, 5 s+ = vacío
      var colorBot = ms >= 3000 ? "var(--crit)" : ms >= 1500 ? "var(--warn)" : "var(--good)";
      pgTarjeta("pg-bot", {
        pct: pctBot, num: ms >= 1000 ? (ms / 1000).toFixed(1) : ms, unidad: ms >= 1000 ? "s" : "ms",
        color: colorBot,
        etiqueta: "Velocidad del bot", detalle: lat.ultima_hora.envios + " mensajes en la última hora" + (lat.ultima_hora.fallos ? " · " + lat.ultima_hora.fallos + " fallidos" : ""),
      });
    } else {
      pgTarjeta("pg-bot", { pct: 100, num: "—", unidad: "", color: "var(--ink-3)", etiqueta: "Velocidad del bot", detalle: "Sin mensajes todavía en la última hora" });
    }

    // ---- Seguridad: puntaje 0-100 mostrado como nota sobre 10. Más alto es
    // mejor, al revés que CPU/RAM/disco, así que el color no usa colorPorPct.
    var seg = panoramaSeguridad;
    if (seg && typeof seg.puntaje === "number") {
      var checklist = seg.checklist || [];
      var colorSeg = seg.puntaje >= 80 ? "var(--good)" : seg.puntaje >= 60 ? "var(--warn)" : "var(--crit)";
      pgTarjeta("pg-seguridad", {
        pct: seg.puntaje, num: Math.round(seg.puntaje / 10), unidad: "/10", color: colorSeg,
        etiqueta: "Seguridad",
        detalle: checklist.length ? checklist.filter(function (c) { return c.ok; }).length + " de " + checklist.length + " en orden" : "",
      });
    } else {
      pgTarjeta("pg-seguridad", { pct: 0, num: "—", unidad: "", color: "var(--ink-3)", etiqueta: "Seguridad", detalle: "Sin datos todavía" });
    }

    // ---- Salud Docker: mismo dato que "Servicios" (arriba), pero como nota
    // 1-10 que además resta puntos por contenedores con reinicios hoy.
    var contenedores = d.contenedores || [];
    var conReinicios = contenedores.filter(function (c) { return (c.reinicios || 0) > 0; });
    var puntajeDocker = total ? Math.max(0, Math.round((arriba / total) * 10) - conReinicios.length) : 10;
    var colorDocker = puntajeDocker >= 8 ? "var(--good)" : puntajeDocker >= 5 ? "var(--warn)" : "var(--crit)";
    pgTarjeta("pg-docker", {
      pct: puntajeDocker * 10, num: puntajeDocker, unidad: "/10", color: colorDocker,
      etiqueta: "Salud Docker",
      detalle: conReinicios.length
        ? conReinicios.map(function (c) { return infoServicio(c.nombre).amigable; }).join(", ")
        : "sin incidentes hoy",
    });

    // ---- Carga del sistema: no hay endpoint de I/O de disco ni de red en el
    // backend, así que en vez de inventar uno usamos el load average (2 vCPU)
    // ya disponible en d.cpu.carga como proxy de qué tan ocupado está el servidor.
    if (d.cpu.carga != null) {
      var pctCarga = Math.min(100, (d.cpu.carga / 2) * 100);
      pgTarjeta("pg-velocidad", {
        pct: pctCarga, num: d.cpu.carga.toFixed(2), unidad: "load", color: colorPorPct(pctCarga, 70, 100),
        etiqueta: "Carga del sistema", detalle: "promedio de 1 minuto, 2 núcleos",
      });
    } else {
      pgTarjeta("pg-velocidad", { pct: 0, num: "—", unidad: "", color: "var(--ink-3)", etiqueta: "Carga del sistema", detalle: "Sin datos todavía" });
    }

    // ---- Base de datos: viva/caída según si /api/datos respondió.
    var datos = panoramaDatos;
    if (datos) {
      pgTarjeta("pg-basedatos", {
        pct: 100, num: "OK", unidad: "", color: "var(--good)",
        etiqueta: "Base de datos", detalle: datos.tamano_mb != null ? datos.tamano_mb + " MB" : "",
      });
    } else {
      pgTarjeta("pg-basedatos", {
        pct: 0, num: "CAÍDA", unidad: "", color: "var(--crit)",
        etiqueta: "Base de datos", detalle: "No respondió /api/datos",
      });
    }

    // ---- Encendido desde: no hay datos reales de ancho de banda de red, así
    // que esta tarjeta muestra el uptime del servidor (ya viene armado como
    // texto en d.arranque) en vez de inventar un endpoint de red. El número
    // grande del anillo tiene que ser corto (la fecha completa no cabe ahí
    // dentro), así que se muestran los días encendido y la fecha completa
    // queda abajo, en el detalle.
    var arranqueMs = d.arranque ? Date.parse(d.arranque.replace(" ", "T")) : NaN;
    var diasEncendido = isNaN(arranqueMs) ? null : Math.max(0, Math.floor((Date.now() - arranqueMs) / 86400000));
    pgTarjeta("pg-red", {
      pct: 100, num: diasEncendido != null ? diasEncendido : "—", unidad: diasEncendido != null ? (diasEncendido === 1 ? "día" : "días") : "",
      color: "var(--accent)",
      etiqueta: "Encendido desde", detalle: (d.arranque || "sin datos") + " · sin caídas registradas hoy",
    });
  }
  var panoramaLatencia = null;
  var panoramaSeguridad = null;
  var panoramaDatos = null;

  function armarResumenTexto(d) {
    if (!d) return "";
    var arriba = d.servicios ? d.servicios.arriba : "-";
    var total = d.servicios ? d.servicios.total : "-";
    return "Centinela Zeus — " + new Date(d.ts).toLocaleString("es-CO", { timeZone: "America/Bogota" }) +
      "\nMemoria " + d.ram.pct + "% · Disco " + d.disco.pct + "% · Procesador " + d.cpu.pct + "%" +
      "\nServicios: " + arriba + " de " + total + " funcionando" +
      ((d.avisos || []).length ? "\nPendientes: " + d.avisos.map(function (a) { return a.texto; }).join("; ") : "\nSin pendientes.");
  }

  function refrescarResumen() {
    return Promise.all([
      api("/api/estado"),
      api("/api/prediccion").catch(function () { return null; }),
      api("/api/incidentes").catch(function () { return null; }),
      api("/api/respaldos").catch(function () { return null; }),
      api("/api/kapso/latencia").catch(function () { return null; }),
      api("/api/seguridad").catch(function () { return null; }),
      api("/api/datos").catch(function () { return null; }),
      api("/api/bot-mudo").catch(function () { return null; })
    ])
      .then(function (r) {
        var d = r[0], pred = r[1], inc = r[2], resp = r[3];
        panoramaLatencia = r[4];
        panoramaSeguridad = r[5];
        panoramaDatos = r[6];
        pintarBotMudo(r[7]);
        // d.ts viene como texto ISO ("2026-09-12T10:10:17.826Z"), no como
        // número: hay que convertirlo o toda resta con Date.now() da NaN.
        var tsLeido = d.ts ? new Date(d.ts).getTime() : NaN;
        ultimoOk = { ts: isNaN(tsLeido) ? Date.now() : tsLeido, d: d, pred: pred, inc: inc, sinConexion: false };
        ultimoResumenTexto = armarResumenTexto(d);

        $("pie-arranque").textContent = "Encendido desde " + d.arranque;
        var fichaArranque = $("ficha-arranque"); if (fichaArranque) fichaArranque.textContent = "Desde " + d.arranque;
        $("sello").textContent = "Revisado " + textoRevisadoHace();

        if (pred && pred.pronosticos) {
          pronosticoPorRecurso = {};
          pred.pronosticos.forEach(function (p) {
            var clave = (p.recurso || "").toLowerCase();
            if (clave.indexOf("mem") !== -1) pronosticoPorRecurso.memoria = p;
            else if (clave.indexOf("disc") !== -1) pronosticoPorRecurso.disco = p;
            else if (clave.indexOf("proces") !== -1 || clave.indexOf("cpu") !== -1) pronosticoPorRecurso.procesador = p;
          });
        }

        pintarRecursos(d);
        pintarServicios(d.contenedores || []);
        renderVeredicto();
        pintarPendientes();
        pintarPanorama(d);

        if (resp && resp.ultimo) {
          pintarUltimaCopia({ texto: resp.hora || ("hace " + resp.ultimo.horas + " h"), mb: resp.ultimo.mb, en_drive: resp.drive && resp.drive.conectado });
        }
      })
      .catch(function () {
        ultimoOk = ultimoOk ? Object.assign({}, ultimoOk, { sinConexion: true }) : { ts: Date.now(), sinConexion: true };
        renderVeredicto();
      });
  }

  function pintarUltimaCopia(u) {
    $("ultima-copia-titulo").textContent = "Última copia de seguridad: " + (u.texto || "—");
    $("ultima-copia-detalle").innerHTML = (u.mb ? u.mb + " MB, guardada en el servidor. " : "") + (u.en_drive ? "" : '<span class="warn-t">No se subió a Drive.</span>');
  }

  var reintentarBtn = $("reintentar");
  if (reintentarBtn) reintentarBtn.addEventListener("click", function () {
    reintentarBtn.disabled = true; reintentarBtn.textContent = "Conectando…";
    refrescarResumen().finally(function () { reintentarBtn.disabled = false; reintentarBtn.textContent = "Reintentar"; });
  });

  /* =========================================================================
     Informe semanal: se carga solo al pulsar el botón (no en cada refresco
     de Inicio) — son cuatro lecturas de archivo más una predicción, no hace
     falta pagarlas cada 120 s si nadie está mirando esta tarjeta.
     ========================================================================= */
  function nivelPill(n) { return n === "info" ? "mute" : (n || "mute"); }
  function plural(n, singular, pluralForm) { return n === 1 ? singular : pluralForm; }

  function textoMensajesPanel(m) {
    if (m.estado !== "completo") return esc(m.nota);
    var signo = m.variacion_pct == null ? "" : (m.variacion_pct > 0 ? " más" : m.variacion_pct < 0 ? " menos" : " igual");
    var pct = m.variacion_pct == null ? "" : " (" + Math.abs(m.variacion_pct) + "%" + signo + " que la semana pasada)";
    return m.semana.enviados + " enviados, " + m.semana.recibidos + " recibidos" + pct + ".";
  }

  function textoProyeccionPanel(nombre, e) {
    if (e.dias == null) return "<b>" + nombre + ":</b> " + esc(e.texto || "estable") + " " + pill(nivelPill(e.nivel), e.nivel === "ok" ? "Tranquilo" : e.nivel === "warn" ? "Vigilar" : e.nivel === "crit" ? "Urgente" : "Sin datos");
    return "<b>" + nombre + ":</b> " + esc(e.texto) + " (hacia el " + esc(e.fecha) + ", " + e.dias + " días) " + pill(nivelPill(e.nivel), e.nivel === "ok" ? "Tranquilo" : e.nivel === "warn" ? "Vigilar" : "Urgente");
  }

  function pintarBotMudo(b) {
    if (!b) return;
    var pillEl = $("bot-mudo-pill");
    if (!pillEl) return;
    pillEl.className = "pill " + b.nivel;
    pillEl.innerHTML = '<span class="ic"></span>' + esc(b.titulo);
    $("bot-mudo-detalle").textContent = b.detalle || "";
    $("bot-mudo-btn").hidden = b.nivel !== "crit";
  }

  function pintarInformeSemanal(d) {
    var envioTxt = d.envio
      ? "Último envío por WhatsApp: " + fechaHoraCO(d.envio.ts) + " · " + esc({
          enviado: "enviado", "falló": "falló", sin_permiso_whatsapp: "sin permiso de WhatsApp",
          silenciado_modo_viaje: "silenciado (modo viaje)", error: "error", enviando: "enviando…",
        }[d.envio.resultado] || d.envio.resultado)
      : "Todavía no se ha enviado ningún informe.";

    var filasCaidas = !d.caidas.total
      ? "<p class=\"note\">Ninguna caída esta semana.</p>"
      : "<ul>" + d.caidas.lista.slice(0, 10).map(function (c) {
          return "<li>" + fechaHoraCO(c.cuando) + " — " + esc(c.nombre) + " (" + c.minutos + " min): " + esc(c.causa || "sin causa registrada") + "</li>";
        }).join("") + "</ul>";

    var filasSos = !d.sos.corridas
      ? "<p class=\"note\">No tuvo que intervenir esta semana.</p>"
      : "<ul>" + d.sos.reparaciones.map(function (r) { return "<li>" + esc(r.que) + " ×" + r.veces + "</li>"; }).join("") + "</ul>"
        + (d.sos.por_resultado.detenido_pide_ayuda > 0 ? "<p class=\"note\">Pidió ayuda de una persona " + d.sos.por_resultado.detenido_pide_ayuda + " " + plural(d.sos.por_resultado.detenido_pide_ayuda, "vez", "veces") + ".</p>" : "");

    $("informe-semanal-cuerpo").innerHTML =
      "<p class=\"sub\">" + esc(d.periodo.etiqueta) + "</p>" +
      "<p class=\"note\">" + envioTxt + "</p>" +
      "<div class=\"fila\" style=\"justify-content:space-between\"><b>Bot sin atender</b><span>" + d.bot_sin_atender.minutos + " min (" + d.bot_sin_atender.caidas + " " + plural(d.bot_sin_atender.caidas, "caída", "caídas") + ")" + (d.bot_sin_atender.en_curso ? " " + pill("crit", "En curso") : "") + "</span></div>" +
      "<div><b>Caídas (" + d.caidas.total + ")</b>" + filasCaidas + "</div>" +
      "<div><b>SOS — actuó " + d.sos.corridas + " " + plural(d.sos.corridas, "vez", "veces") + "</b>" + filasSos + "</div>" +
      "<div><b>Mensajes del bot</b><p class=\"note\">" + textoMensajesPanel(d.mensajes) + "</p></div>" +
      "<div><p class=\"note\">" + textoProyeccionPanel("Disco", d.proyeccion.disco) + "</p><p class=\"note\">" + textoProyeccionPanel("Memoria", d.proyeccion.memoria) + "</p></div>" +
      "<div><b>Seguridad</b><p class=\"note\">" + (d.seguridad.ultima
        ? d.seguridad.corridas + " " + plural(d.seguridad.corridas, "auditoría", "auditorías") + " esta semana · último puntaje " + d.seguridad.ultima.puntaje + " de 100 " + pill(d.seguridad.ultima.urgentes ? "crit" : "ok", d.seguridad.ultima.urgentes ? "Urgente" : "Sin urgencias")
        : "Sin auditorías registradas todavía.") + "</p></div>" +
      "<div class=\"fila\"><button class=\"btn sm\" id=\"informe-semanal-actualizar\">Actualizar</button>" +
      "<button class=\"btn sm\" id=\"informe-semanal-texto\">Ver como texto</button></div>";

    var actualizarBtn = $("informe-semanal-actualizar");
    if (actualizarBtn) actualizarBtn.addEventListener("click", cargarInformeSemanal);
    var textoBtn = $("informe-semanal-texto");
    if (textoBtn) textoBtn.addEventListener("click", function () { window.open("/api/informe-semanal?formato=texto", "_blank"); });
  }

  function cargarInformeSemanal() {
    var btn = $("informe-semanal-actualizar") || $("informe-semanal-ver");
    if (btn) { btn.disabled = true; btn.textContent = "Cargando…"; }
    return api("/api/informe-semanal").then(function (d) {
      pintarInformeSemanal(d);
    }).catch(function () {
      $("informe-semanal-cuerpo").innerHTML = "<p class=\"note\">No pude cargar el informe ahora mismo. Intenta de nuevo en un momento.</p><div class=\"fila\"><button class=\"btn sm\" id=\"informe-semanal-ver\">Ver informe de esta semana</button></div>";
      var verBtn = $("informe-semanal-ver");
      if (verBtn) verBtn.addEventListener("click", cargarInformeSemanal);
    });
  }

  var informeSemanalVerBtn = $("informe-semanal-ver");
  if (informeSemanalVerBtn) informeSemanalVerBtn.addEventListener("click", cargarInformeSemanal);

  /* =========================================================================
     Tareas programadas: se carga solo al pulsar el botón, igual que el
     informe semanal — la vigilancia real ya la hace el aviso de WhatsApp.
     ========================================================================= */
  function pintarLatidos(d) {
    var filas = d.tareas.map(function (t) {
      var marca = t.estado === "falta" ? "✕" : (t.estado === "ok" ? "✓" : "…");
      var nivelPill = t.estado === "falta" ? t.nivel : "ok";
      return "<div class=\"fila\" style=\"justify-content:space-between;align-items:flex-start;gap:8px\">" +
        "<span>" + marca + " " + esc(t.nombre) + "</span>" + pill(nivelPill, esc(t.mensaje)) + "</div>";
    }).join("");

    $("latidos-cuerpo").innerHTML =
      "<p class=\"note\">" + esc(d.mensaje) + "</p>" + filas +
      "<div class=\"fila\"><button class=\"btn sm\" id=\"latidos-actualizar\">Actualizar</button></div>";

    var actualizarBtn = $("latidos-actualizar");
    if (actualizarBtn) actualizarBtn.addEventListener("click", cargarLatidos);
  }

  function cargarLatidos() {
    var btn = $("latidos-actualizar") || $("latidos-ver");
    if (btn) { btn.disabled = true; btn.textContent = "Cargando…"; }
    return api("/api/latidos").then(function (d) {
      pintarLatidos(d);
    }).catch(function () {
      $("latidos-cuerpo").innerHTML = "<p class=\"note\">No pude cargar las tareas programadas ahora mismo. Intenta de nuevo en un momento.</p><div class=\"fila\"><button class=\"btn sm\" id=\"latidos-ver\">Ver tareas programadas</button></div>";
      var verBtn = $("latidos-ver");
      if (verBtn) verBtn.addEventListener("click", cargarLatidos);
    });
  }

  var latidosVerBtn = $("latidos-ver");
  if (latidosVerBtn) latidosVerBtn.addEventListener("click", cargarLatidos);

  /* =========================================================================
     Historial: fallas + reinicios + copias + registro de acciones,
     combinados en una sola línea de tiempo, con detalle técnico debajo.
     ========================================================================= */
  var datosHistorial = { incidentes: null, reinicios: null, respaldos: null, registro: null };

  function pintarIncidentes(d) {
    var p = $("pill-fallas");
    p.className = "pill " + (d.abierto ? "crit" : "ok");
    p.innerHTML = '<span class="ic"></span>' + (d.abierto ? "Fallando ahora" : d.historial.length ? d.historial.length + " registradas" : "Sin caídas");

    $("incidente-actual").innerHTML = d.abierto
      ? '<div class="card" style="border-color:var(--crit)"><div class="card-head"><h3>Falla en curso</h3></div>' +
        '<div class="card-body"><p style="margin:0 0 8px"><b>' + esc(d.abierto.descripcion) + "</b> (" + esc(amigable(d.abierto.servicio)) + ")</p>" +
        '<p style="margin:0;color:var(--ink-2)">' + esc(d.abierto.causa) + "</p></div></div>"
      : "";

    $("tb-incidentes").innerHTML = d.historial.length
      ? d.historial.map(function (i) {
          return "<tr><td class=\"mono\">" + fechaHoraCO(i.inicio) +
            "</td><td>" + esc(i.descripcion || amigable(i.servicio)) + '</td><td class="num">' + Math.max(1, Math.round(i.duracion_s / 60)) +
            " min</td><td>" + esc(i.causa) + "</td><td>" + pill("ok", i.resuelto) + "</td></tr>";
        }).join("")
      : '<tr><td colspan="5" class="note">Sin caídas desde que Centinela vigila. Cuando ocurra una, aquí verás qué pasó, por qué y cómo se resolvió.</td></tr>';
  }

  function pintarReinicios(d) {
    $("sumario-reinicios").textContent = "Reinicios programados — próximo en " + d.faltan_texto;
    $("tiles-reinicios").innerHTML = [
      tile("Próximo", "04:00", 100, "", "En " + d.faltan_texto),
      tile("Cada reinicio", "~2<small>min</small>", 20, "", "El servidor queda fuera de línea mientras arranca todo"),
      tile("Registrados", String(d.historial.length), 100, "", "Últimos reinicios"),
      tile("Inesperados", String(d.historial.filter(function (r) { return r.estado === "warn"; }).length), 20, "", "Fuera del horario")
    ].join("");
    $("tb-reinicios").innerHTML = d.historial.map(function (r) {
      return '<tr><td class="mono">' + esc(r.fecha) + '</td><td class="num">' + esc(r.hora) + "</td><td>" + esc(r.tipo) +
        "</td><td>" + pill(r.estado === "ok" ? "ok" : "warn", r.estado === "ok" ? "Correcto" : "Revisar") + "</td></tr>";
    }).join("");
  }

  function cargarRegistro() {
    return api("/api/registro").then(function (filas) {
      datosHistorial.registro = filas;
      $("tb-registro").innerHTML = filas.length
        ? filas.map(function (r) {
            return '<tr><td class="mono">' + fechaHoraCO(r.ts) +
              "</td><td>" + esc(r.accion.replace(/_/g, " ")) + "</td><td>" + esc(r.quien) + "</td><td>" +
              pill(/ok|resuelto|enviado|abierto/.test(r.resultado) ? "ok" : "warn", r.resultado) +
              '</td><td class="note">' + esc(r.detalle || "") + "</td></tr>";
          }).join("")
        : '<tr><td colspan="5" class="note">Sin acciones registradas todavía.</td></tr>';
      pintarTimeline();
    });
  }

  function pintarTimeline() {
    var host = $("timeline");
    if (!datosHistorial.incidentes || !datosHistorial.reinicios || !datosHistorial.respaldos || !datosHistorial.registro) return;
    var eventos = [];
    datosHistorial.incidentes.historial.forEach(function (i) {
      eventos.push({ ts: i.inicio, tipo: "falla", nivel: "crit", titulo: (i.descripcion || amigable(i.servicio)), detalle: (i.causa || "") + (i.resuelto ? ". " + i.resuelto : "") });
    });
    datosHistorial.reinicios.historial.forEach(function (r) {
      eventos.push({ ts: Date.parse(r.fecha + " " + r.hora) || Date.now(), tipo: "reinicio", nivel: r.estado === "ok" ? "info" : "warn", titulo: "Reinicio " + r.tipo, detalle: r.estado === "ok" ? "Correcto. Todo volvió a funcionar." : "Revisar: fuera del horario esperado." });
    });
    (datosHistorial.respaldos.archivos || []).forEach(function (a) {
      eventos.push({ ts: a.ts, tipo: "copia", nivel: "info", titulo: "Copia de seguridad guardada", detalle: a.mb + " MB en el servidor." + (datosHistorial.respaldos.drive && datosHistorial.respaldos.drive.conectado ? "" : " No se subió a Drive.") });
    });
    datosHistorial.registro.forEach(function (r) {
      eventos.push({ ts: r.ts, tipo: "accion", nivel: /ok|resuelto|enviado|abierto/.test(r.resultado) ? "info" : "warn", titulo: r.accion.replace(/_/g, " "), detalle: (r.quien ? r.quien + " · " : "") + (r.detalle || r.resultado || "") });
    });
    eventos.sort(function (a, b) { return b.ts - a.ts; });

    if (!eventos.length) { host.innerHTML = '<p class="note">Sin eventos todavía.</p>'; return; }

    var html = "", diaActual = "";
    eventos.forEach(function (ev) {
      var dia = new Date(ev.ts).toLocaleDateString("es-CO", { weekday: "long", day: "2-digit", month: "long" });
      if (dia !== diaActual) { html += '<div class="dia" data-dia>' + esc(dia) + "</div>"; diaActual = dia; }
      html += '<div class="evento ' + ev.nivel + '" data-tipo="' + ev.tipo + '"><span class="h">' + horaCO(ev.ts) + '</span><span class="m"></span><div><b>' + esc(ev.titulo) + '</b><span>' + esc(ev.detalle) + '</span></div></div>';
    });
    host.innerHTML = html;
    aplicarFiltroHistorial();
  }

  var filtroActivo = "todo";
  function filtrarHistorial(chip) {
    document.querySelectorAll("[data-filtro]").forEach(function (c) { c.setAttribute("aria-pressed", String(c === chip)); });
    filtroActivo = chip.dataset.filtro;
    aplicarFiltroHistorial();
  }
  function aplicarFiltroHistorial() {
    document.querySelectorAll("#timeline .evento").forEach(function (ev) { ev.hidden = filtroActivo !== "todo" && ev.dataset.tipo !== filtroActivo; });
    document.querySelectorAll("#timeline [data-dia]").forEach(function (d) {
      var sig = d.nextElementSibling, alguno = false;
      while (sig && !sig.hasAttribute("data-dia")) { if (!sig.hidden) alguno = true; sig = sig.nextElementSibling; }
      d.hidden = !alguno;
    });
  }

  /* =========================================================================
     Copias de seguridad
     ========================================================================= */
  function pintarRespaldos(d) {
    datosHistorial.respaldos = d;
    $("aviso-drive").innerHTML = d.drive.conectado ? "" :
      '<div class="estado warn"><div class="estado-head"><span class="estado-dot"></span><div>' +
      '<h1 style="font-size:19px">Google Drive está desconectado</h1>' +
      '<p class="desc">' + esc(d.drive.motivo) + '. Las copias se guardan solo en este servidor: si el servidor falla, se pierden con él.</p>' +
      '</div></div><div class="paso" style="grid-template-columns:1fr auto;align-items:center;display:grid">' +
      '<span class="hecho">Se hace desde el computador, con la cuenta de Google del negocio.</span>' +
      '<button class="btn primary" data-hoja="drive">Volver a conectar Drive</button></div></div>';

    $("tiles-respaldos").innerHTML = [
      tile("Última copia", d.ultimo ? "hace " + d.ultimo.horas + "<small>h</small>" : "—", d.ultimo && d.ultimo.horas < 26 ? 100 : 20, d.ultimo && d.ultimo.horas > 30 ? "crit" : "", d.hora),
      tile("Tamaño", d.ultimo ? d.ultimo.mb + "<small>MB</small>" : "—", 60, "", "Comprimido"),
      tile("En el servidor", String(d.total), 100, "", d.espacio_mb + " MB en total"),
      tile("En Drive", d.drive.conectado ? "Sí" : "Ninguna", d.drive.conectado ? 100 : 3, d.drive.conectado ? "" : "crit", d.drive.conectado ? "Sincronizado" : "Drive desconectado")
    ].join("");

    $("tb-respaldos").innerHTML = d.archivos.map(function (a) {
      return '<tr><td class="mono" data-l="Fecha">' + fechaHoraCO(a.ts) +
        '</td><td class="num" data-l="Tamaño">' + a.mb + " MB</td><td data-l=\"Servidor\">" + pill("ok", "Guardada") + "</td><td data-l=\"Drive\">" +
        pill(d.drive.conectado ? "ok" : "crit", d.drive.conectado ? "Subida" : "No se subió") + "</td></tr>";
    }).join("") || '<tr><td colspan="4" class="note">Sin copias todavía.</td></tr>';

    if (d.ultimo) pintarUltimaCopia({ texto: "hoy, " + (d.hora || ""), mb: d.ultimo.mb, en_drive: d.drive.conectado });
  }

  /* =========================================================================
     Datos técnicos: base de datos + predicción detallada + ficha del servidor
     ========================================================================= */
  function pintarDatos(d) {
    $("tiles-datos").innerHTML = [
      tile("Tamaño de la base", (d.tamano_mb / 1024).toFixed(1) + "<small>GB</small>", 60, "", d.tablas.length + " tablas mayores"),
      tile("Consultas lentas", String(d.slow_total), Math.min(100, d.slow_total / 20), d.slow_total > 1000 ? "warn" : "", "Desde el último arranque"),
      tile("Conexiones abiertas", String(d.conexiones), Math.min(100, d.conexiones), "", "Ahora mismo"),
      tile("Consultas totales", numeroCorto(d.consultas_totales), 70, "", "Desde el último arranque")
    ].join("");

    $("tb-lentas").innerHTML = d.consultas_lentas.length
      ? d.consultas_lentas.map(function (c) {
          return '<tr><td class="num">' + c.segundos + "</td><td>" +
            pill(c.accionable ? "warn" : "mute", c.accionable ? "Aplicación" : "Respaldo nocturno") +
            '</td><td class="mono" style="font-size:12px">' + esc(c.sql.slice(0, 130)) + "</td></tr>";
        }).join("")
      : '<tr><td colspan="3" class="note">Ninguna consulta lenta registrada por ahora.</td></tr>';

    $("tb-tablas").innerHTML = d.tablas.map(function (t) {
      return '<tr><td class="mono" data-l="Tabla">' + esc(t.nombre) + '</td><td class="num" data-l="Filas">' + t.filas.toLocaleString("es-CO") +
        '</td><td class="num" data-l="Tamaño">' + t.mb + ' MB</td><td class="num" data-l="Desaprovechado">' + t.desperdicio + " MB</td></tr>";
    }).join("");
  }

  function pintarPrediccion(d) {
    $("pred-titulo").textContent = d.nivel === "ok" ? "Riesgo bajo" : d.nivel === "warn" ? "Riesgo medio, conviene vigilar" : "Riesgo alto";
    $("pred-resumen").textContent = d.resumen;
    $("pred-muestras").textContent = "Con datos desde el " + (d.desde ? new Date(d.desde).toLocaleDateString("es-CO", { day: "2-digit", month: "long" }) : "—") + " (" + d.muestras + " muestras)";

    var host = $("gauge");
    host.innerHTML = "";
    var R = 58, C = 74, circ = 2 * Math.PI * R;
    var color = d.nivel === "ok" ? "var(--good)" : d.nivel === "warn" ? "var(--warn)" : "var(--crit)";
    var s = el("svg", { viewBox: "0 0 148 148", width: 148, height: 148, role: "img", "aria-label": "Riesgo " + d.riesgo + " de 100" });
    s.appendChild(el("circle", { cx: C, cy: C, r: R, fill: "none", stroke: "var(--surface-2)", "stroke-width": 12 }));
    s.appendChild(el("circle", { cx: C, cy: C, r: R, fill: "none", stroke: color, "stroke-width": 12, "stroke-linecap": "round",
      "stroke-dasharray": circ, "stroke-dashoffset": circ * (1 - d.riesgo / 100), transform: "rotate(-90 " + C + " " + C + ")" }));
    host.appendChild(s);
    var n = document.createElement("div");
    n.style.textAlign = "center";
    n.innerHTML = "<b style='font-size:28px'>" + d.riesgo + "</b><br><span class='note'>de 100</span>";
    host.style.display = "grid"; host.style.justifyItems = "center";
    host.appendChild(n);

    $("pronosticos").innerHTML = d.pronosticos.map(function (p) {
      var nivel = p.nivel === "info" ? "mute" : p.nivel;
      return '<div class="card"><div class="card-head"><h3>' + esc(p.recurso) + "</h3></div>" +
        '<div class="card-body" style="display:grid;gap:8px">' +
        '<div class="mono" style="font-size:20px">' + (p.dias !== null ? p.dias + " días" : "Estable") + "</div>" +
        '<span class="note">' + esc(p.texto) + (p.ritmo ? " Ritmo actual: " + p.ritmo + " puntos por día." : "") + "</span>" +
        pill(nivel, p.nivel === "ok" ? "Tranquilo" : p.nivel === "warn" ? "Vigilar" : p.nivel === "crit" ? "Urgente" : "Sin datos") +
        "</div></div>";
    }).join("");

    $("senales").innerHTML = d.senales.map(function (s2) {
      var mk = s2.nivel === "ok" ? "ok" : s2.nivel === "warn" ? "wa" : "no";
      var simbolo = s2.nivel === "ok" ? "✓" : s2.nivel === "warn" ? "!" : "✕";
      return '<div class="revision"><span class="mk ' + mk + '">' + simbolo + "</span><div><b>" + esc(s2.t) +
        '</b><span>' + esc(s2.d) + "</span></div>" + pill("mute", s2.valor) + "</div>";
    }).join("");
  }

  /* =========================================================================
     Seguridad
     ========================================================================= */
  function pintarSeguridad(d) {
    $("tiles-seguridad").innerHTML = [
      tile("Revisiones en orden", d.puntaje + "<small>%</small>", d.puntaje, d.puntaje < 70 ? "warn" : "", "Comprobaciones superadas"),
      tile("Bloqueadas ahora", String(d.baneos.actuales), Math.min(100, d.baneos.actuales * 5), "", d.baneos.totales + " en total. Normal: son robots probando contraseñas."),
      tile("Intentos fallidos", String(d.intentos_fallidos), Math.min(100, d.intentos_fallidos / 10), "", "Registrados esta semana"),
      tile("Actualizaciones", String(d.actualizaciones), d.actualizaciones ? 60 : 3, d.actualizaciones ? "warn" : "", d.actualizaciones ? "Pendientes de instalar" : "Todo al día")
    ].join("");

    $("sub-seguridad").textContent = d.checklist.filter(function (c) { return c.ok; }).length + " de " + d.checklist.length + " correctas";
    $("checklist").innerHTML = d.checklist.map(function (c) {
      return '<div class="revision"><span class="mk ' + (c.ok ? "ok" : "wa") + '">' + (c.ok ? "✓" : "!") + "</span>" +
        '<div><b>' + esc(c.t) + '</b><span>' + esc(c.d) + "</span></div>" +
        (!c.ok && /Actualizaciones/.test(c.t) ? '<button class="btn sm" data-accion="actualizar_seguridad" data-confirmar="ACTUALIZAR">Instalar</button>' : "<span></span>") + "</div>";
    }).join("");

    $("tb-baneos").innerHTML = d.baneos.lista.length
      ? d.baneos.lista.map(function (ip) {
          return '<tr><td class="mono" data-l="Dirección">' + esc(ip) + '</td><td data-l=""><button class="btn sm" data-accion="desbanear" data-objetivo="' +
            esc(ip) + '">Desbloquear</button></td></tr>';
        }).join("")
      : '<tr><td colspan="2" class="note">Ninguna dirección bloqueada ahora mismo.</td></tr>';

    $("puertos").textContent = d.puertos.join("\n");
  }

  /* =========================================================================
     Carga por sección (misma caché por nombre + refresco cada 120 s)
     ========================================================================= */
  var cargadas = {};
  function cargarSeccion(nombre, forzar) {
    if (nombre === "mas") return;
    if (cargadas[nombre] && !forzar) return;
    cargadas[nombre] = true;

    if (nombre === "historial") {
      api("/api/incidentes").then(function (d) { datosHistorial.incidentes = d; pintarIncidentes(d); pintarTimeline(); });
      api("/api/reinicios").then(function (d) { datosHistorial.reinicios = d; pintarReinicios(d); pintarTimeline(); });
      api("/api/respaldos").then(function (d) { datosHistorial.respaldos = d; pintarTimeline(); });
      api("/api/series?rango=7d").then(function (s) { dibujar("w-ram7", "tip-ram7", s.ram, "%", "Memoria en 7 días"); });
      api("/api/series?rango=24h").then(function (s) { dibujar("w-ram", "tip-ram", s.ram, "%", "Memoria en 24 horas"); });
      cargarRegistro();
    }

    if (nombre === "copias") { api("/api/respaldos").then(pintarRespaldos); cargarPruebaRestauracion(); }

    if (nombre === "seguridad") { api("/api/seguridad").then(pintarSeguridad); cargarAuditoriaProfunda(); cargarAuditoriaCompleta(); }

    if (nombre === "optimizacion") { cargarOptimizacion(); cargarAuditoriaOptim(); }

    if (nombre === "tecnico") {
      api("/api/datos").then(pintarDatos);
      api("/api/prediccion").then(pintarPrediccion);
      api("/api/series?rango=24h").then(function (s) { dibujar("w-cpu", "tip-cpu", s.cpu, "%", "Procesador en 24 horas"); });
      api("/api/agente").then(function (a) {
        $("pie-agente").textContent = "Versión " + (a.version || "1.0") + " · usa " + a.memoria_mb + " MB · guarda " + a.muestras + " muestras";
      });
      cargarLogsPatrones();
      cargarBdProcesos();
      cargarKapsoLatencia();
      cargarKapsoGasto();
      cargarRunbooks();
      cargarDespliegueObservacion();
    }

    if (nombre === "ajustes") { cargarModoViaje(); cargarEscalamiento(); }

    if (nombre === "permisos") cargarPermisos();

    if (nombre === "simulacros") cargarSimulacros();

    if (nombre === "sos") cargarSos();
    if (nombre === "registros") cargarRegistros();
    if (nombre === "contenedores") cargarContenedores();

    if (nombre === "inicio") { cargarAuditoria360(); cargarVigia(); cargarGuiaSugerida(); }
  }

  /* =========================================================================
     FASE CAOS — ver DISENO-FASE-CAOS.md. Widgets nuevos + módulo de Simulacros.
     Ningún contrato de /api/accion, /api/estado, etc. se tocó: todo lo de abajo
     es aditivo y usa las mismas funciones de arriba ($ , esc, api, pill,
     abrirConfirmar, tareaTrabajando/Lista/Fallo, cargarRegistro, ir, aviso).
     ========================================================================= */

  function apiSafe(ruta) {
    return fetch(ruta, { headers: { "Accept": "application/json" } })
      .then(function (r) { if (!r.ok) throw new Error("http " + r.status); return r.json(); });
  }
  function postZeus(ruta, cuerpo) {
    return fetch(ruta, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Panel-Zeus": "1" },
      body: JSON.stringify(cuerpo || {})
    }).then(function (r) { return r.json().catch(function () { return { ok: false, mensaje: "Respuesta inválida del servidor" }; }); });
  }
  function noDisponible(id, texto) {
    var el = $(id);
    if (!el) return;
    el.className = "placeholder";
    el.innerHTML = "<b>Todavía no disponible.</b><span>" + esc(texto || "Esta función se está preparando en el servidor.") + "</span>";
  }
  function vacio(id, titulo, texto) {
    var el = $(id);
    if (!el) return;
    el.className = "placeholder";
    el.innerHTML = "<b>" + esc(titulo) + "</b><span>" + esc(texto || "") + "</span>";
  }

  /* ---------- Optimización: sugerencias de índices (GET /api/optimizacion, ya existe) ----------
     Qué índices ya se aplicaron se guarda en el navegador (localStorage): el backend vuelve a
     calcular las sugerencias a partir del log de consultas lentas, que puede tardar en "olvidar"
     una consulta ya resuelta, así que el color/botón de "ya aplicado" no depende de eso. */
  function optimAplicados() {
    try { return JSON.parse(localStorage.getItem("centinela-optim-aplicados") || "{}"); } catch (e) { return {}; }
  }
  function optimMarcarAplicado(comando, indice) {
    try {
      var m = optimAplicados();
      m[comando] = { indice: indice, ts: Date.now() };
      localStorage.setItem("centinela-optim-aplicados", JSON.stringify(m));
    } catch (e) {}
  }
  function optimMarcarRevertido(comando) {
    try {
      var m = optimAplicados();
      delete m[comando];
      localStorage.setItem("centinela-optim-aplicados", JSON.stringify(m));
    } catch (e) {}
  }
  // A partir del comando ALTER TABLE ... ADD INDEX que ya se aplicó (así es como
  // db-optimizacion.js arma siempre sus sugerencias), construye el DROP INDEX que lo deshace.
  function optimComandoRevertir(comandoAplicado) {
    var m = comandoAplicado.match(/ALTER TABLE\s+`([^`]+)`\.`([^`]+)`\s+ADD INDEX\s+`([^`]+)`/i);
    if (!m) return null;
    var esquema = m[1], tabla = m[2], indice = m[3];
    // Sin ALGORITHM/LOCK: a diferencia de ALTER TABLE ADD INDEX, MariaDB no
    // acepta esas cláusulas en DROP INDEX (probado contra la base real: con
    // ellas da error 1064 de sintaxis). DROP INDEX ya es rápido de por sí.
    return "DROP INDEX `" + indice + "` ON `" + esquema + "`.`" + tabla + "`;";
  }

  function optimRevertir(comandoAplicado, tabla) {
    var comandoDrop = optimComandoRevertir(comandoAplicado);
    if (!comandoDrop) { tareaFallo("No se pudo armar el comando para revertir", "El formato del índice aplicado no es el esperado."); return; }
    abrirConfirmar("REVERTIR", "Se quitará el índice que se creó en la tabla " + tabla + ". No borra datos.", function () {
      tareaTrabajando("Revirtiendo el índice…", "Tabla " + tabla + ".");
      postZeus("/api/optimizacion/aplicar", { comando: comandoDrop }).then(function (d) {
        var log = "$ " + comandoDrop + (d && d.salida ? "\n" + d.salida : "");
        if (d && d.ok) {
          optimMarcarRevertido(comandoAplicado);
          tareaLista("Índice revertido.", "La tabla " + tabla + " volvió a como estaba antes.", { log: log });
        } else {
          tareaFallo("No se pudo revertir", (d && d.mensaje) || "Inténtalo de nuevo en un momento.", { log: log });
        }
        cargarOptimizacion();
      }).catch(function () { tareaFallo("No hay conexión con el servidor", ""); });
    });
  }

  function cargarOptimizacion() {
    apiSafe("/api/optimizacion").then(function (d) {
      var lista = (d && d.sugerencias) || [];
      var el = $("panel-sugerencias-indices");
      if (!el) return;
      if (!lista.length) { vacio("panel-sugerencias-indices", "No hay sugerencias por ahora.", (d && d.resumen) || "Centinela no encontró consultas repetidas que necesiten un índice nuevo."); return; }
      el.className = "";
      el.dataset.sugerencias = JSON.stringify(lista);
      var aplicados = optimAplicados();
      el.innerHTML =
        (d.resumen ? '<p class="note" style="margin-bottom:10px">' + esc(d.resumen) + (d.generado ? " · generado " + fechaHoraCO(d.generado) : "") + "</p>" : "") +
        lista.map(function (s, i) {
          var cols = (s.columnas || []).join(", ");
          var yaAplicado = !!aplicados[s.comando];
          return '<div class="revision' + (yaAplicado ? " ok" : "") + '" style="' + (yaAplicado ? "background:var(--good-soft, var(--surface-2))" : "") + '">' +
            '<span class="mk ' + (yaAplicado ? "ok" : "wa") + '">' + (yaAplicado ? "✓" : (i + 1)) + '</span>' +
            "<div><b>Tabla " + esc(s.tabla || "—") + (cols ? " (" + esc(cols) + ")" : "") + "</b>" +
            "<span>" + esc(s.tipo_consulta || "Consulta repetida") + " · se repitió " + (s.repeticiones || 0) + " veces" +
            (s.segundos_acumulados != null ? " · " + s.segundos_acumulados + " s acumulados" : "") +
            (yaAplicado ? " · <b style=\"color:var(--good-ink,#2e8b57)\">índice ya aplicado</b>" : "") + "</span></div>" +
            (s.es_vista ? "<p class=\"note\" style=\"padding-left:34px;margin-top:2px\">Es una vista (" + esc(s.tabla) + "), no una tabla — el índice hay que crearlo en la tabla real que usa la vista, no aquí.</p>" : "") +
            (s.ya_cubierto ? "<p class=\"note\" style=\"padding-left:34px;margin-top:2px\">Ya existe un índice que empieza por esa columna — crear otro no ayudaría, solo ocuparía espacio y haría más lentas las escrituras.</p>" : "") +
            '<span style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">' +
            '<button class="btn sm ghost" data-optim-explicar="' + i + '">Explicar</button>' +
            (s.es_vista || s.ya_cubierto
              ? ""
              : yaAplicado
                ? '<button class="btn sm ghost" data-optim-revertir="' + i + '">Revertir</button>'
                : '<button class="btn sm" data-optim-aplicar="' + i + '">Aplicar</button>') +
            "</span></div>";
        }).join("");
    }).catch(function () { noDisponible("panel-sugerencias-indices", "Las sugerencias de índices todavía no están disponibles."); });
  }

  /* ---------- Optimización: auditoría COMPLETA de la base de datos con consola en vivo (10 revisiones) ----------
     Mismo patrón que la auditoría completa de Seguridad: POST .../ejecutar devuelve el run_id de
     inmediato, la consola se alimenta por SSE (.../vivo) y el evento `fin` trae el resumen. Solo lee. */
  var optimAudFuente = null;
  function pintarResultadoAuditoriaOptim(resumen) {
    var el = $("optim-aud-resultado");
    if (!el) return;
    if (!resumen || !resumen.hallazgos) { el.innerHTML = ""; return; }
    el.innerHTML =
      '<p class="note" style="margin:10px 0">Puntaje: <b>' + resumen.puntaje + "%</b> · " +
      resumen.urgentes + " urgente(s) · " + resumen.atencion + " para revisar · " +
      (resumen.tamano_mb != null ? "la base ocupa " + resumen.tamano_mb + " MB · " : "") +
      fechaHoraCO(resumen.ts) + "</p>" +
      resumen.hallazgos.map(function (h, i) {
        var mk = h.severidad === "urgente" ? "no" : (h.severidad === "atencion" ? "wa" : "ok");
        var ic = mk === "ok" ? "✓" : (mk === "wa" ? "!" : "✕");
        return '<div class="revision"><span class="mk ' + mk + '">' + ic + "</span>" +
          "<div><b>" + (i + 1) + ". " + esc(h.titulo || h.id) + "</b><span>" + esc(h.significado || "") + (h.detalle ? " — " + esc(h.detalle) : "") + "</span></div><span></span></div>" +
          filasAccionablesOptim(h);
      }).join("");
  }
  // Sub-filas con botón real por elemento, para los hallazgos que Centinela
  // sabe reparar sola (índices redundantes, tablas en MyISAM, tablas
  // fragmentadas). El resto de "motor_claves" (tablas sin clave primaria) no
  // tiene botón: no hay forma genérica y segura de elegir qué columna es la
  // llave.
  function filasAccionablesOptim(h) {
    if (h.id === "indices_redundantes" && Array.isArray(h.datos) && h.datos.length) {
      return h.datos.map(function (x) {
        return '<div class="fila" style="justify-content:space-between;padding-left:34px;margin-top:4px">' +
          '<span class="sub">' + esc(x.tabla) + "." + esc(x.indice) + " (" + esc(x.columnas) + ") — ya lo cubre " + esc(x.cubierto_por) + "</span>" +
          '<button class="btn sm danger" data-eliminar-indice="1" data-tabla="' + esc(x.tabla) + '" data-indice="' + esc(x.indice) + '">Eliminar</button></div>';
      }).join("");
    }
    if (h.id === "motor_claves" && h.datos && Array.isArray(h.datos.myisam) && h.datos.myisam.length) {
      return h.datos.myisam.map(function (t) {
        return '<div class="fila" style="justify-content:space-between;padding-left:34px;margin-top:4px">' +
          '<span class="sub">' + esc(t.tabla) + " (" + t.filas.toLocaleString("es-CO") + " filas, MyISAM)</span>" +
          '<button class="btn sm" data-reparar-motor="1" data-tabla="' + esc(t.tabla) + '">Pasar a InnoDB</button></div>';
      }).join("");
    }
    if (h.id === "fragmentacion" && Array.isArray(h.datos) && h.datos.length) {
      return h.datos.map(function (t) {
        return '<div class="fila" style="justify-content:space-between;padding-left:34px;margin-top:4px">' +
          '<span class="sub">' + esc(t.tabla) + " (" + t.mb_libres + " MB libres, " + t.pct + "%)</span>" +
          '<button class="btn sm" data-optimizar-tabla="1" data-tabla="' + esc(t.tabla) + '">Desfragmentar</button></div>';
      }).join("");
    }
    if (h.id === "escaneos" || h.id === "sugerencias_pendientes") {
      return '<div class="fila" style="justify-content:flex-end;padding-left:34px;margin-top:4px">' +
        '<button class="btn sm ghost" data-a360-ir="optimizacion" data-a360-ancla="panel-sugerencias-indices">Ver sugerencias de índice</button></div>';
    }
    if (h.id === "bloqueos" && h.severidad !== "ok") {
      return '<div class="fila" style="justify-content:flex-end;padding-left:34px;margin-top:4px">' +
        '<button class="btn sm ghost" data-a360-ir="tecnico">Ir a Datos técnicos</button></div>';
    }
    if (h.id === "conexiones" && h.datos && h.datos.valor_sugerido) {
      return '<div class="fila" style="justify-content:space-between;padding-left:34px;margin-top:4px">' +
        '<span class="sub">Subir max_connections de ' + h.datos.valor_actual + " a " + h.datos.valor_sugerido + '</span>' +
        '<button class="btn sm" data-subir-conexiones="1" data-valor="' + h.datos.valor_sugerido + '">Subir el tope</button></div>';
    }
    if (h.id === "memoria" && h.datos && h.datos.key_buffer_desperdiciado) {
      return '<div class="fila" style="justify-content:space-between;padding-left:34px;margin-top:4px">' +
        '<span class="sub">Bajar key_buffer_size a 8 MB</span>' +
        '<button class="btn sm" data-reducir-key-buffer="1">Liberar memoria</button></div>';
    }
    if ((h.id === "memoria" || h.id === "crecimiento" || h.id === "conexiones" || h.id === "buffer_pool") && h.severidad !== "ok") {
      var texto = (h.titulo || "") + ": " + (h.significado || "") + (h.detalle ? " — " + h.detalle : "");
      return '<div class="fila" style="justify-content:flex-end;padding-left:34px;margin-top:4px;gap:6px;flex-wrap:wrap">' +
        '<button class="btn sm ghost" data-copiar-hallazgo="' + esc(texto) + '">Copiar para tu técnico</button>' + botonExplicarIA(h) + "</div>";
    }
    return "";
  }
  function cargarAuditoriaOptim() {
    apiSafe("/api/optimizacion/auditoria/ultima").then(function (u) {
      if (u && u.ts) {
        var s = $("optim-aud-ultima");
        if (s) s.textContent = "Última: " + fechaHoraCO(u.ts);
        pintarResultadoAuditoriaOptim(u);
      }
    }).catch(function () {});
  }
  function optimAudLinea(ev) {
    var consola = $("optim-aud-consola");
    if (!consola) return;
    consola.hidden = false;
    var linea = document.createElement("div");
    linea.textContent = (ev.texto || "");
    if (ev.nivel === "crit") linea.style.color = "var(--crit-ink)";
    else if (ev.nivel === "warn") linea.style.color = "var(--warn-ink)";
    else if (ev.nivel === "ok") linea.style.color = "var(--good-ink)";
    consola.appendChild(linea);
    consola.scrollTop = consola.scrollHeight;
  }
  function lanzarAuditoriaOptim() {
    var btn = $("optim-aud-lanzar");
    btn.disabled = true;
    btn.textContent = "Auditando…";
    var consola = $("optim-aud-consola");
    consola.hidden = false;
    consola.innerHTML = "";
    $("optim-aud-resultado").innerHTML = "";
    function terminar() { btn.disabled = false; btn.textContent = "Auditar ahora"; }
    postZeus("/api/optimizacion/auditoria/ejecutar", {}).then(function (d) {
      if (!d || !d.ok) {
        terminar();
        optimAudLinea({ texto: (d && d.mensaje) || "No se pudo iniciar la auditoría.", nivel: "crit" });
        cargarAuditoriaOptim(); // vuelve a mostrar el último resultado, que se limpió al arrancar
        return;
      }
      if (typeof EventSource === "undefined") { optimAudLinea({ texto: "Este navegador no admite ver la auditoría en vivo; el resultado aparecerá al recargar.", nivel: "warn" }); terminar(); return; }
      if (optimAudFuente) { try { optimAudFuente.close(); } catch (e) {} }
      var es = new EventSource("/api/optimizacion/auditoria/vivo?run=" + encodeURIComponent(d.run_id));
      optimAudFuente = es;
      es.addEventListener("paso", function (e) { try { optimAudLinea(JSON.parse(e.data)); } catch (err) {} });
      es.addEventListener("fin", function (e) {
        // El texto de cierre ya llegó como evento `paso` (el bus lo manda por los dos
        // canales); aquí solo se toma el resumen que viene en `dato`.
        var ev = null;
        try { ev = JSON.parse(e.data); } catch (err) {}
        try { es.close(); } catch (err2) {}
        optimAudFuente = null;
        terminar();
        if (ev && ev.dato && ev.dato.hallazgos) {
          var s = $("optim-aud-ultima");
          if (s) s.textContent = "Última: " + fechaHoraCO(ev.dato.ts);
          pintarResultadoAuditoriaOptim(ev.dato);
        } else {
          cargarAuditoriaOptim();
        }
      });
      es.onerror = function () { try { es.close(); } catch (e) {} optimAudFuente = null; terminar(); cargarAuditoriaOptim(); };
    }).catch(function () {
      terminar();
      optimAudLinea({ texto: "No hay conexión con el servidor.", nivel: "crit" });
    });
  }
  var optimAudLanzarBtn = $("optim-aud-lanzar");
  if (optimAudLanzarBtn) optimAudLanzarBtn.addEventListener("click", lanzarAuditoriaOptim);

  /* ---------- Seguridad: auditoría profunda (GET /api/seguridad/completa, ya existe) ---------- */
  function cargarAuditoriaProfunda() {
    apiSafe("/api/seguridad/completa").then(function (d) {
      var hallazgos = (d && d.hallazgos) || [];
      if (!hallazgos.length) { vacio("panel-auditoria-profunda", "Todo en orden.", "No se encontraron hallazgos adicionales."); return; }
      var el = $("panel-auditoria-profunda");
      el.className = "";
      el.innerHTML = hallazgos.map(function (h) {
        var mk = h.severidad === "urgente" ? "no" : (h.severidad === "atencion" ? "wa" : "ok");
        var ic = mk === "ok" ? "✓" : (mk === "wa" ? "!" : "✕");
        return '<div class="revision"><span class="mk ' + mk + '">' + ic + "</span>" +
          "<div><b>" + esc(h.titulo || "Hallazgo") + "</b><span>" + esc(h.significado || "") + (h.detalle ? " — " + esc(h.detalle) : "") + "</span></div>" +
          '<span class="note">' + (h.automatico ? "automático" : "") + "</span></div>";
      }).join("");
    }).catch(function () { noDisponible("panel-auditoria-profunda", "La auditoría ampliada todavía no está disponible."); });
  }

  /* ---------- Seguridad: auditoría COMPLETA con consola en vivo (8 revisiones) ---------- */
  var audFuente = null;
  function pintarResultadoAuditoria(resumen) {
    var el = $("aud-completa-resultado");
    if (!resumen || !resumen.hallazgos) { el.innerHTML = ""; return; }
    el.innerHTML =
      '<p class="note" style="margin:10px 0">Puntaje: <b>' + resumen.puntaje + "%</b> · " +
      resumen.urgentes + " urgente(s) · " + resumen.atencion + " para revisar · " +
      fechaHoraCO(resumen.ts) + "</p>" +
      resumen.hallazgos.map(function (h) {
        var mk = h.severidad === "urgente" ? "no" : (h.severidad === "atencion" ? "wa" : "ok");
        var ic = mk === "ok" ? "✓" : (mk === "wa" ? "!" : "✕");
        return '<div class="revision"><span class="mk ' + mk + '">' + ic + "</span>" +
          "<div><b>" + esc(h.titulo || h.id) + "</b><span>" + esc(h.significado || "") + (h.detalle ? " — " + esc(h.detalle) : "") + "</span></div><span>" + botonHallazgo(h) + "</span></div>" +
          filasAccionablesSeguridad(h);
      }).join("");
  }
  function cargarAuditoriaCompleta() {
    apiSafe("/api/seguridad/auditoria/ultima").then(function (u) {
      if (u && u.ts) {
        $("aud-completa-ultima").textContent = "Última: " + fechaHoraCO(u.ts);
        pintarResultadoAuditoria(u);
      }
    }).catch(function () {});
  }
  function audLinea(ev) {
    var consola = $("aud-completa-consola");
    consola.hidden = false;
    var linea = document.createElement("div");
    linea.textContent = (ev.texto || "");
    if (ev.nivel === "crit") linea.style.color = "var(--crit-ink)";
    else if (ev.nivel === "warn") linea.style.color = "var(--warn-ink)";
    else if (ev.nivel === "ok") linea.style.color = "var(--good-ink)";
    consola.appendChild(linea);
    consola.scrollTop = consola.scrollHeight;
  }
  function lanzarAuditoriaCompleta() {
    var btn = $("aud-completa-lanzar");
    btn.disabled = true;
    btn.textContent = "Auditando…";
    var consola = $("aud-completa-consola");
    consola.hidden = false;
    consola.innerHTML = "";
    $("aud-completa-resultado").innerHTML = "";
    postZeus("/api/seguridad/auditoria/ejecutar", {}).then(function (d) {
      if (!d || !d.ok) {
        btn.disabled = false; btn.textContent = "Auditar ahora";
        audLinea({ texto: (d && d.mensaje) || "No se pudo iniciar la auditoría.", nivel: "crit" });
        return;
      }
      if (audFuente) { try { audFuente.close(); } catch (e) {} }
      var es = new EventSource("/api/seguridad/auditoria/vivo?run=" + encodeURIComponent(d.run_id));
      audFuente = es;
      es.addEventListener("paso", function (e) { try { audLinea(JSON.parse(e.data)); } catch (err) {} });
      es.addEventListener("fin", function (e) {
        try { audLinea(JSON.parse(e.data)); } catch (err) {}
        try { es.close(); } catch (err2) {}
        audFuente = null;
        btn.disabled = false; btn.textContent = "Auditar ahora";
        cargarAuditoriaCompleta();
      });
      es.onerror = function () { try { es.close(); } catch (e) {} audFuente = null; btn.disabled = false; btn.textContent = "Auditar ahora"; };
    }).catch(function () {
      btn.disabled = false; btn.textContent = "Auditar ahora";
      audLinea({ texto: "No hay conexión con el servidor.", nivel: "crit" });
    });
  }
  var audLanzarBtn = $("aud-completa-lanzar");
  if (audLanzarBtn) audLanzarBtn.addEventListener("click", lanzarAuditoriaCompleta);

  /* =========================================================================
     Inicio: Auditoría 360 — orquesta seguridad + optimización + config drift +
     capacidad + servicios + respaldos + tareas en una sola pasada. El botón
     "Auditar todo" reusa el mismo patrón de consola en vivo (SSE) que la
     auditoría de seguridad completa, arriba en este archivo.
     ========================================================================= */
  var NOMBRES_AREA = {
    seguridad: "Seguridad", configuracion: "Configuración", base_datos: "Base de datos",
    capacidad: "Capacidad", servicios: "Servicios", respaldos: "Copias de seguridad", tareas: "Tareas programadas",
  };
  function nivelDeNota(nota) {
    if (nota == null) return "mute";
    if (nota >= 9) return "ok";
    if (nota >= 6) return "warn";
    return "crit";
  }
  function pintarAuditoria360(d) {
    var ultima = d && d.ultima;
    var pillEl = $("a360-pill");
    if (!ultima) {
      if (pillEl) { pillEl.className = "pill mute"; pillEl.innerHTML = '<span class="ic"></span>Sin datos'; }
      $("a360-ultima").textContent = "";
      $("a360-cuerpo").innerHTML = "";
      return;
    }
    var nivel = nivelDeNota(ultima.nota_global);
    var etiqueta = ultima.nota_global == null ? "Parcial" : "Nota " + ultima.nota_global + " de 10 · " + (ultima.etiqueta || "");
    if (pillEl) { pillEl.className = "pill " + nivel; pillEl.innerHTML = '<span class="ic"></span>' + esc(etiqueta); }
    $("a360-ultima").textContent = "Última: " + fechaHoraCO(ultima.ts || ultima.fin);

    var VISTA_POR_AREA = { seguridad: "seguridad", base_datos: "optimizacion", respaldos: "copias", servicios: "contenedores", tareas: "inicio", capacidad: "tecnico" };
    var ANCLA_POR_AREA = { tareas: "card-latidos" };
    var areas = ultima.areas || {};
    var filasAreas = Object.keys(NOMBRES_AREA).filter(function (k) { return areas[k]; }).map(function (k) {
      var a = areas[k];
      var txt = a.nota == null ? "Sin datos" : (a.nota + "/10");
      var pillHtml = pill(nivelDeNota(a.nota), txt);
      var vista = VISTA_POR_AREA[k];
      var pillClic = vista
        ? '<button data-a360-ir="' + esc(vista) + '"' + (ANCLA_POR_AREA[k] ? ' data-a360-ancla="' + esc(ANCLA_POR_AREA[k]) + '"' : "") + ' style="background:none;border:0;padding:0;cursor:pointer">' + pillHtml + "</button>"
        : pillHtml;
      return '<div class="fila" style="justify-content:space-between">' + NOMBRES_AREA[k] + " " + pillClic + "</div>";
    }).join("");

    var aplicado = ultima.aplicado || [];
    var bloqueSolo = aplicado.length
      ? "<p class=\"note\" style=\"margin-top:10px\"><b>Lo que arreglé sola:</b></p>" +
        aplicado.map(function (a) { return "<p class=\"note\">• " + esc(a.mensaje || a.accion) + "</p>"; }).join("")
      : "";

    var hallazgos = ultima.hallazgos || [];
    var proponer = hallazgos.filter(function (h) { return h.cubeta === "proponer" && h.propuesta; });
    var bloqueProponer = proponer.length
      ? "<p class=\"note\" style=\"margin-top:10px\"><b>Con un clic tuyo:</b></p>" +
        proponer.map(function (h) {
          var p = h.propuesta;
          if (p.tipo === "ir") {
            return '<div class="fila" style="justify-content:space-between">' + esc(h.significado || h.titulo) +
              '<button class="btn sm" data-a360-ir="' + esc(p.vista) + '"' + (p.ancla ? ' data-a360-ancla="' + esc(p.ancla) + '"' : "") + ">" + esc(p.etiqueta) + "</button></div>";
          }
          return '<div class="fila" style="justify-content:space-between">' + esc(h.significado || h.titulo) +
            '<button class="btn sm' + (p.confirmar ? " danger" : "") + '" data-accion="' + esc(p.accion) + '" data-objetivo="' + esc(p.objetivo || "") + '"' +
            (p.confirmar ? ' data-confirmar="' + esc(p.confirmar) + '"' : "") + ">" + esc(p.etiqueta) + "</button></div>";
        }).join("")
      : "";

    var reportar = hallazgos.filter(function (h) { return h.cubeta === "reportar" && h.severidad !== "ok"; });
    var bloqueReportar = reportar.length
      ? "<p class=\"note\" style=\"margin-top:10px\"><b>Solo para que lo sepas:</b></p>" +
        reportar.map(function (h) {
          var mk = h.severidad === "urgente" ? "no" : "wa";
          var ic = h.severidad === "urgente" ? "✕" : "!";
          var especifico = botonHallazgo(h);
          var vista = VISTA_POR_AREA[h.area];
          var boton = especifico || (vista ? '<button class="btn sm ghost" data-a360-ir="' + esc(vista) + '">Ir a la sección</button>' : "");
          return '<div class="revision"><span class="mk ' + mk + '">' + ic + "</span>" +
            "<div><b>" + esc(h.titulo) + "</b><span>" + esc(h.significado || "") + (h.detalle ? " — " + esc(h.detalle) : "") + "</span></div>" +
            "<span>" + boton + "</span></div>";
        }).join("")
      : "";

    var cmp = ultima.comparacion;
    var tituloDeClave = function (clave) {
      var h = hallazgos.filter(function (x) { return x.clave === clave; })[0];
      if (h) return h.titulo;
      var partes = String(clave).split(":");
      return (partes[1] || partes[0]).replace(/_/g, " ");
    };
    var bloqueCmp = "";
    if (cmp) {
      var resumenCmp = "Comparado con la anterior: " +
        (cmp.delta > 0 ? "subió " + cmp.delta : cmp.delta < 0 ? "bajó " + Math.abs(cmp.delta) : "igual");
      bloqueCmp = '<p class="note" style="margin-top:10px">' + resumenCmp + "</p>";
      if (cmp.nuevos && cmp.nuevos.length) {
        bloqueCmp += "<p class=\"note\"><b>Nuevo y urgente:</b></p>" +
          cmp.nuevos.map(function (c) { return '<p class="note">• ' + esc(tituloDeClave(c)) + "</p>"; }).join("");
      }
      if (cmp.resueltos && cmp.resueltos.length) {
        bloqueCmp += "<p class=\"note\"><b>Ya se resolvió:</b></p>" +
          cmp.resueltos.map(function (c) { return '<p class="note">• ' + esc(tituloDeClave(c)) + "</p>"; }).join("");
      }
    }

    $("a360-cuerpo").innerHTML = filasAreas + bloqueSolo + bloqueProponer + bloqueReportar + bloqueCmp;
  }
  function cargarAuditoria360() {
    apiSafe("/api/auditoria360").then(pintarAuditoria360).catch(function () {});
  }
  var a360Fuente = null;
  function a360Linea(ev) {
    var consola = $("a360-consola");
    consola.hidden = false;
    var linea = document.createElement("div");
    linea.textContent = (ev.texto || "");
    if (ev.nivel === "crit") linea.style.color = "var(--crit-ink)";
    else if (ev.nivel === "warn") linea.style.color = "var(--warn-ink)";
    else if (ev.nivel === "ok") linea.style.color = "var(--good-ink)";
    consola.appendChild(linea);
    consola.scrollTop = consola.scrollHeight;
  }
  function lanzarAuditoria360() {
    var btn = $("a360-btn");
    btn.disabled = true;
    btn.textContent = "Auditando…";
    var consola = $("a360-consola");
    consola.hidden = false;
    consola.innerHTML = "";
    postZeus("/api/auditoria360/ejecutar", {}).then(function (d) {
      if (!d || !d.ok) {
        btn.disabled = false; btn.textContent = "Auditar todo";
        aviso((d && d.mensaje) || "No se pudo iniciar la auditoría.");
        return;
      }
      if (a360Fuente) { try { a360Fuente.close(); } catch (e) {} }
      var es = new EventSource("/api/auditoria360/vivo?run=" + encodeURIComponent(d.run_id));
      a360Fuente = es;
      es.addEventListener("paso", function (e) { try { a360Linea(JSON.parse(e.data)); } catch (err) {} });
      es.addEventListener("fin", function (e) {
        try { a360Linea(JSON.parse(e.data)); } catch (err) {}
        try { es.close(); } catch (err2) {}
        a360Fuente = null;
        btn.disabled = false; btn.textContent = "Auditar todo";
        cargarAuditoria360();
        cargarRegistro();
      });
      es.onerror = function () { try { es.close(); } catch (e) {} a360Fuente = null; btn.disabled = false; btn.textContent = "Auditar todo"; };
    }).catch(function () {
      btn.disabled = false; btn.textContent = "Auditar todo";
      aviso("No hay conexión con el servidor.");
    });
  }
  var a360Btn = $("a360-btn");
  if (a360Btn) a360Btn.addEventListener("click", lanzarAuditoria360);

  /* =========================================================================
     Inicio: Vigía de tendencias — avisa por su cuenta si algo cambia de rumbo;
     esta tarjeta solo muestra el estado de la última revisión y deja votar
     "me sirvió" / "fue ruido" sobre el último aviso.
     ========================================================================= */
  function cargarVigia() {
    apiSafe("/api/vigia").then(function (d) {
      var el = $("vigia-cuerpo");
      if (!el) return;
      var uc = d && d.ultima_corrida;
      var avisos = (d && d.avisos_recientes) || [];
      var ultimoAviso = avisos.length ? avisos[avisos.length - 1] : null;
      var nDisparadas = uc && uc.disparadas ? uc.disparadas.length : 0;
      var pillEstado = nDisparadas
        ? pill("warn", nDisparadas + " " + (nDisparadas === 1 ? "cosa" : "cosas") + " esta semana")
        : (d && d.dias_historial != null && d.dias_historial < 10)
          ? pill("mute", "Aún sin historial suficiente")
          : pill("ok", "Sin novedades");
      var texto = ultimoAviso ? "<p class=\"note\" style=\"margin-top:8px\">" + esc(ultimoAviso.texto || "").split("\n")[0] + "</p>" : "";
      var stats = (d && d.reglas) || [];
      var aciertos = stats.reduce(function (s, r) { return s + (r.aciertos || 0); }, 0);
      var fallos = stats.reduce(function (s, r) { return s + (r.fallos || 0); }, 0);
      el.className = "";
      el.innerHTML = "<div class=\"fila\" style=\"justify-content:space-between\">" + pillEstado +
        "<span class=\"sub\">Aciertos: " + aciertos + " · Fallos: " + fallos + "</span></div>" + texto +
        "<div class=\"fila\" style=\"margin-top:10px\">" +
        "<button class=\"btn sm\" id=\"vigia-util\">Me sirvió</button>" +
        "<button class=\"btn sm\" id=\"vigia-ruido\">Fue ruido</button>" +
        "<button class=\"btn sm ghost\" id=\"vigia-revisar\">Revisar ahora</button></div>";
    }).catch(function () { noDisponible("vigia-cuerpo", "La vigía todavía no está disponible."); });
  }

  /* ---------- Inicio: Guía sugerida (memoria de incidentes + runbooks) ---------- */
  function cargarGuiaSugerida() {
    apiSafe("/api/memoria-incidentes").then(function (d) {
      var card = $("card-guia");
      if (!card) return;
      var sug = d && d.sugerencia_actual;
      if (!sug) { card.hidden = true; return; }
      card.hidden = false;
      $("guia-cuerpo").innerHTML =
        "<p class=\"note\">" + esc(sug.motivo || sug.titulo || "") + "</p>" +
        "<p><b>" + esc(sug.titulo || "") + "</b> (" + (sug.pasos || 0) + " paso" + (sug.pasos === 1 ? "" : "s") + ")</p>" +
        "<div class=\"fila\" style=\"margin-top:8px\"><button class=\"btn sm\" id=\"guia-ver\">Ver la guía</button></div>";
    }).catch(function () { var card = $("card-guia"); if (card) card.hidden = true; });
  }

  document.addEventListener("click", function (e) {
    var a360IrBtn = e.target.closest("[data-a360-ir]");
    if (a360IrBtn) {
      var vista = a360IrBtn.dataset.a360Ir, ancla = a360IrBtn.dataset.a360Ancla;
      ir(vista);
      if (ancla) setTimeout(function () { var el = $(ancla); if (el) el.scrollIntoView({ behavior: "smooth" }); }, 300);
      return;
    }
    if (e.target.closest("#vigia-util") || e.target.closest("#vigia-ruido")) {
      var valor = e.target.closest("#vigia-util") ? "util" : "ruido";
      postZeus("/api/vigia/feedback", { valor: valor }).then(function (r) { aviso((r && r.mensaje) || "Gracias."); cargarVigia(); }).catch(function () { aviso("No hay conexión con el servidor."); });
      return;
    }
    if (e.target.closest("#vigia-revisar")) {
      postZeus("/api/vigia/revisar", {}).then(function () { aviso("Revisado."); cargarVigia(); }).catch(function () { aviso("No hay conexión con el servidor."); });
      return;
    }
    if (e.target.closest("#guia-ver")) {
      ir("tecnico");
      setTimeout(function () { var el = $("panel-runbooks"); if (el) el.scrollIntoView({ behavior: "smooth" }); }, 300);
      return;
    }
  });

  /* ---------- Copias: prueba de restauración automática (GET /api/respaldos/prueba-restauracion, ya existe) ---------- */
  function cargarPruebaRestauracion() {
    apiSafe("/api/respaldos/prueba-restauracion").then(function (d) {
      if (!d || !d.existe) { var s = $("pr-sub"); if (s) s.textContent = "sin datos"; vacio("panel-prueba-restauracion", "Todavía no se ha probado restaurar ninguna copia.", (d && d.mensaje) || ""); return; }
      var ok = d.resultado === "ok";
      $("pr-sub").textContent = fechaHoraCO(d.ts);
      var el = $("panel-prueba-restauracion");
      el.className = "";
      var conteos = d.conteos ? Object.keys(d.conteos).map(function (k) { return k + ": " + d.conteos[k]; }).join(" · ") : "";
      var agregacion = d.agregacion ? Object.keys(d.agregacion).map(function (k) { return k + ": " + d.agregacion[k]; }).join(" · ") : "";
      el.innerHTML =
        pill(ok ? "ok" : "crit", ok ? "La última copia sí se pudo restaurar" : "La prueba de restauración falló") +
        (d.detalle ? '<p class="note" style="margin-top:8px">' + esc(d.detalle) + "</p>" : "") +
        '<p class="note">Archivo probado: ' + esc(d.archivo_probado || "—") + (d.duracion_seg != null ? " · tardó " + d.duracion_seg + " s" : "") + "</p>" +
        (conteos ? '<p class="note">Datos verificados: ' + esc(conteos) + "</p>" : "") +
        (agregacion ? '<p class="note">' + esc(agregacion) + "</p>" : "");
    }).catch(function () { var s = $("pr-sub"); if (s) s.textContent = "—"; noDisponible("panel-prueba-restauracion", "La prueba automática de restauración todavía no está disponible."); });
  }

  /* ---------- Datos técnicos: patrones de registro (GET /api/logs/patrones) ----------
     Campos reales: ejemplo, veces_total, veces_ultima_pasada, ultima_vez, es_nuevo.
     Se sigue leyendo de forma defensiva (varios nombres de campo alternativos) por si
     el módulo de log-clustering cambia de forma en el futuro. */
  function cargarLogsPatrones() {
    apiSafe("/api/logs/patrones").then(function (d) {
      var lista = (d && (d.patrones || d.grupos)) || [];
      var sub = $("logs-sub");
      if (!lista.length) { if (sub) sub.textContent = "sin novedades"; vacio("panel-logs-patrones", "Sin patrones nuevos.", "No se encontraron mensajes repetidos fuera de lo normal."); return; }
      if (sub) sub.textContent = lista.length + " patrones detectados";
      var el = $("panel-logs-patrones");
      el.className = "";
      el.innerHTML = '<div class="tw"><table class="tarjetas"><thead><tr><th>Mensaje</th><th class="num">Veces</th><th>Última vez</th><th></th></tr></thead><tbody>' +
        lista.slice(0, 30).map(function (p) {
          var texto = p.ejemplo || p.texto || p.patron || p.mensaje || "—";
          var veces = p.veces_total != null ? p.veces_total : (p.veces != null ? p.veces : (p.conteo != null ? p.conteo : "—"));
          var cuando = p.ultima_vez || p.ultimo || p.ts;
          var esNuevo = !!(p.nuevo || p.es_nuevo);
          return "<tr>" +
            '<td data-l="Mensaje" class="mono">' + esc(String(texto).slice(0, 140)) + "</td>" +
            '<td data-l="Veces" class="num">' + esc(veces) + "</td>" +
            '<td data-l="Última vez">' + (cuando ? esc(fechaHoraCO(cuando)) : "—") + "</td>" +
            '<td data-l="">' + (esNuevo ? pill("warn", "Nuevo") : "") + "</td>" +
            "</tr>";
        }).join("") + "</tbody></table></div>";
    }).catch(function () { var s = $("logs-sub"); if (s) s.textContent = "—"; noDisponible("panel-logs-patrones", "El agrupado de registros todavía no está disponible."); });
  }

  /* ---------- Datos técnicos: consultas trabadas de la base de datos ----------
     GET /api/bd/procesos, POST /api/bd/matar. Por diseño solo avisa: matar es un
     clic con confirmación escrita del dueño (nunca automático). */
  function cargarBdProcesos() {
    apiSafe("/api/bd/procesos").then(function (d) {
      var lista = (d && (d.procesos || d.trabados)) || [];
      var sub = $("bd-procesos-sub");
      if (!lista.length) { if (sub) sub.textContent = "sin bloqueos"; vacio("panel-bd-procesos", "No hay consultas trabadas.", "La base de datos responde con normalidad."); return; }
      if (sub) sub.textContent = lista.length + " consulta(s) trabada(s)";
      var el = $("panel-bd-procesos");
      el.className = "";
      el.dataset.procesos = JSON.stringify(lista);
      el.innerHTML = lista.map(function (p, i) {
        var pid = p.pid != null ? p.pid : p.id;
        var tiempo = p.tiempo_seg != null ? p.tiempo_seg : p.tiempo;
        return '<div class="revision"><span class="mk wa">!</span>' +
          "<div><b>Proceso " + esc(pid) + (p.usuario ? " · " + esc(p.usuario) : "") + "</b>" +
          "<span>" + (tiempo != null ? "Lleva " + esc(tiempo) + " s trabada" : "Bloqueada") + (p.estado ? " · " + esc(p.estado) : "") +
          (p.consulta ? " · " + esc(String(p.consulta).slice(0, 90)) : "") + "</span></div>" +
          '<button class="btn sm danger" data-bd-matar="' + i + '">Detener consulta</button></div>';
      }).join("");
    }).catch(function () { var s = $("bd-procesos-sub"); if (s) s.textContent = "—"; noDisponible("panel-bd-procesos", "La lectura de procesos de la base de datos todavía no está disponible."); });
  }

  /* ---------- Datos técnicos: salud de Kapso (WhatsApp) ---------- */
  function cargarKapsoLatencia() {
    apiSafe("/api/kapso/latencia").then(function (d) {
      var serie = (d && (d.serie || d.muestras)) || [];
      if (!serie.length) { vacio("panel-kapso-latencia", "Sin datos todavía.", "Aún no hay suficientes lecturas de latencia."); return; }
      var ultimo = serie[serie.length - 1];
      var ms = (ultimo && (ultimo.ms || ultimo.latencia_ms)) || 0;
      var el = $("panel-kapso-latencia");
      el.className = "";
      var nivel = ms > 3000 ? "crit" : (ms > 1200 ? "warn" : "ok");
      el.innerHTML = pill(nivel, "Última respuesta: " + Math.round(ms) + " ms") +
        '<p class="note" style="margin-top:8px">Con base en las últimas ' + serie.length + " lecturas.</p>";
    }).catch(function () { noDisponible("panel-kapso-latencia", "La medición de latencia de WhatsApp todavía no está disponible."); });
  }
  function cargarKapsoGasto() {
    apiSafe("/api/kapso/gasto").then(function (d) {
      var porHora = (d && (d.por_hora != null ? d.por_hora : d.envios_hora)) != null ? (d.por_hora != null ? d.por_hora : d.envios_hora) : null;
      var total = (d && (d.total_hoy != null ? d.total_hoy : d.total)) != null ? (d.total_hoy != null ? d.total_hoy : d.total) : null;
      var el = $("panel-kapso-gasto");
      el.className = "";
      var alerta = !!(d && (d.alerta || d.bucle_detectado));
      el.innerHTML = (alerta ? pill("crit", "Posible bucle de mensajes") : pill("ok", "Envíos normales")) +
        '<p class="note" style="margin-top:8px">' +
        (porHora != null ? "Esta hora: " + porHora + " envíos" : "") +
        (total != null ? ((porHora != null ? " · " : "") + "Hoy: " + total + " envíos") : "") +
        "</p>";
    }).catch(function () { noDisponible("panel-kapso-gasto", "El conteo de envíos de WhatsApp todavía no está disponible."); });
  }

  /* ---------- Datos técnicos: runbooks (GET /api/runbooks; se ejecutan con /api/accion) ---------- */
  function cargarRunbooks() {
    apiSafe("/api/runbooks").then(function (d) {
      var lista = (d && (d.runbooks || d.lista)) || [];
      if (!lista.length) { vacio("panel-runbooks", "No hay guías cargadas.", "Todavía no hay runbooks configurados."); return; }
      var el = $("panel-runbooks");
      el.className = "";
      el.dataset.runbooks = JSON.stringify(lista);
      el.innerHTML = lista.map(function (r, i) {
        var pasos = r.pasos || [];
        return '<div class="revision"><span class="mk ok">' + (i + 1) + '</span>' +
          "<div><b>" + esc(r.titulo || r.id) + "</b><span>" + esc(r.descripcion || "") +
          (pasos.length ? " · " + pasos.length + " paso(s)" : "") + "</span></div>" +
          '<button class="btn sm" data-runbook="' + i + '">Ejecutar</button></div>';
      }).join("");
    }).catch(function () { noDisponible("panel-runbooks", "Las guías paso a paso todavía no están disponibles."); });
  }
  function ejecutarRunbook(r, boton) {
    var pasos = (r.pasos || []).slice();
    if (!pasos.length) return;
    boton.disabled = true;
    var i = 0;
    function siguiente() {
      if (i >= pasos.length) {
        tareaLista("Guía completada: " + (r.titulo || r.id), "Se ejecutaron " + pasos.length + " paso(s).");
        boton.disabled = false;
        cargarRegistro();
        return;
      }
      var paso = pasos[i];
      tareaTrabajando("Ejecutando: " + (r.titulo || r.id), "Paso " + (i + 1) + " de " + pasos.length + ": " + (paso.descripcion || paso.accion));
      postZeus("/api/accion", { accion: paso.accion, objetivo: paso.objetivo || "" })
        .then(function (resp) {
          if (!resp || !resp.ok) { tareaFallo("La guía se detuvo", (resp && resp.mensaje) || "Falló el paso " + (i + 1) + "."); boton.disabled = false; return; }
          i++;
          siguiente();
        })
        .catch(function () { tareaFallo("No hay conexión con el servidor", "La guía se detuvo en el paso " + (i + 1) + "."); boton.disabled = false; });
    }
    siguiente();
  }

  /* ---------- Datos técnicos: ventana de observación tras un despliegue ---------- */
  function cargarDespliegueObservacion() {
    apiSafe("/api/despliegue/observacion").then(function (d) {
      var sub = $("desp-sub");
      if (!d || !d.ultima) {
        if (sub) sub.textContent = "sin despliegues observados";
        var el0 = $("panel-despliegue-observacion");
        if (el0) { el0.className = ""; el0.innerHTML = '<p class="note">No hay ninguna ventana de observación registrada todavía.</p><button class="btn sm" id="desp-iniciar">Iniciar observación ahora</button>'; }
        return;
      }
      var u = d.ultima;
      if (sub) sub.textContent = u.ts ? fechaHoraCO(u.ts) : "—";
      var el = $("panel-despliegue-observacion");
      el.className = "";
      var revirtio = !!u.revirtio;
      el.innerHTML = pill(revirtio ? "crit" : "ok", revirtio ? "Se revirtió el despliegue" : "El despliegue quedó estable") +
        '<p class="note" style="margin-top:8px">' + esc(u.veredicto || "") + "</p>" +
        '<button class="btn sm" id="desp-iniciar" style="margin-top:8px">Iniciar nueva observación</button>';
    }).catch(function () { var s = $("desp-sub"); if (s) s.textContent = "—"; noDisponible("panel-despliegue-observacion", "La observación de despliegues todavía no está disponible."); });
  }

  /* ---------- Ajustes: modo viaje (GET/POST /api/modo) ---------- */
  function cargarModoViaje() {
    apiSafe("/api/modo").then(function (d) {
      var activo = !!(d && (d.activo || d.modo_viaje));
      var b = $("modo-viaje-btn");
      if (!b) return;
      b.disabled = false;
      b.textContent = activo ? "Desactivar" : "Activar";
      b.dataset.modoViajeEstado = activo ? "1" : "0";
      b.className = "btn sm" + (activo ? " primary" : "");
      var desc = $("modo-viaje-desc");
      if (desc) desc.textContent = activo
        ? "Activo: solo te avisamos si algo se cae por completo."
        : "Silencia los avisos menores; solo avisa si algo se cae por completo.";
    }).catch(function () {
      var b = $("modo-viaje-btn");
      if (b) { b.textContent = "No disponible"; b.disabled = true; b.classList.remove("cargando"); }
    });
  }

  /* ---------- Ajustes: escalada de avisos críticos con acuse
     (GET/POST /api/escalamiento, /api/escalamiento/config, /api/escalamiento/acusar) ---------- */
  var CIERRE_LLANO = {
    acusada: "Confirmado por ti/desde el panel", recuperada: "Se resolvió solo",
    agotada: "Nadie respondió", absorbida: "Reemplazado por el aviso del SOS",
    desactivada: "Apagaste la función"
  };
  var TIPO_LLANO = { sos: "SOS sin resolver", caida: "Caída del bot", manual: "Prueba" };

  function pintarPendientesEscalamiento(pendientes) {
    var el = $("escalamiento-pendientes");
    if (!el) return;
    if (!pendientes || !pendientes.length) {
      vacio("escalamiento-pendientes", "Ningún aviso pendiente", "");
      return;
    }
    var html = pendientes.map(function (p) {
      return '<div class="ajuste"><div><b>' + esc(TIPO_LLANO[p.tipo] || p.tipo) + '</b>' +
        '<span>Sin confirmar hace ' + p.minutos_abierta + ' min · aviso ' + p.intentos + ' de 3 · siguiente a ' +
        (p.destino_siguiente === "tecnico" ? "el técnico" : "ti") + ' en ' + p.minutos_para_proximo + ' min</span></div></div>';
    }).join("") +
      '<div class="ajuste"><button class="btn sm" data-escalamiento-acusar="1">Ya lo vi</button></div>';
    el.className = "";
    el.innerHTML = html;
  }

  function pintarHistorialEscalamiento(historial) {
    var el = $("escalamiento-historial");
    if (!el) return;
    var filas = (historial || []).slice(0, 10);
    if (!filas.length) { vacio("escalamiento-historial", "Sin escaladas todavía", ""); return; }
    el.className = "";
    el.innerHTML = filas.map(function (h) {
      return '<div class="ajuste"><div><b>' + esc(TIPO_LLANO[h.tipo] || h.tipo) + '</b>' +
        '<span>' + fechaHoraCO(h.cerrada_ts) + ' · ' + esc(CIERRE_LLANO[h.cierre] || h.cierre) + '</span></div></div>';
    }).join("");
  }

  function cargarEscalamiento() {
    apiSafe("/api/escalamiento").then(function (d) {
      if (!d) return;
      pintarPendientesEscalamiento(d.pendientes);
      pintarHistorialEscalamiento(d.historial);
    }).catch(function () { noDisponible("escalamiento-pendientes", "No disponible todavía."); });

    apiSafe("/api/escalamiento/config").then(function (d) {
      var btn = $("escalamiento-activo-btn");
      if (btn) {
        var activo = !!(d && d.activo);
        btn.disabled = false;
        btn.textContent = activo ? "Desactivar" : "Activar";
        btn.dataset.escalamientoActivo = activo ? "1" : "0";
        btn.className = "btn sm" + (activo ? " primary" : "");
      }
      var input = $("escalamiento-tecnico-input");
      if (input && document.activeElement !== input) input.value = (d && d.tecnico) || "";
    }).catch(function () {
      var btn = $("escalamiento-activo-btn");
      if (btn) { btn.textContent = "No disponible"; btn.disabled = true; btn.classList.remove("cargando"); }
    });
  }

  /* =========================================================================
     Permisos: freno de emergencia, horario comercial y permisos por categoría
     (GET/POST /api/reglas, /api/reglas/freno, /api/reglas/horario, /api/permisos).
     ========================================================================= */
  function pintarFreno(freno) {
    var btn = $("permisos-freno-btn");
    if (!btn) return;
    var activo = !!(freno && freno.activo);
    btn.disabled = false;
    btn.classList.remove("cargando");
    btn.textContent = activo ? "Desactivar freno de emergencia" : "Activar freno de emergencia";
    btn.dataset.frenoActivo = activo ? "1" : "0";
    var motivoWrap = $("permisos-freno-motivo-wrap");
    if (motivoWrap) motivoWrap.hidden = activo;
    var info = $("permisos-freno-info");
    if (info) {
      info.textContent = activo
        ? ("Activado por " + (freno.quien || "alguien") + (freno.ts ? (" el " + fechaHoraCO(freno.ts)) : "") + (freno.motivo ? (" — Motivo: " + freno.motivo) : ""))
        : "";
    }
  }
  function cargarPermisosReglas() {
    apiSafe("/api/reglas").then(function (d) {
      pintarFreno(d && d.freno);
      var hc = (d && d.horario_comercial) || {};
      var inicioCO = Number.isFinite(hc.inicio_utc) ? ((hc.inicio_utc - 5 + 24) % 24) : 8;
      var finCO = Number.isFinite(hc.fin_utc) ? ((hc.fin_utc - 5 + 24) % 24) : 20;
      var ii = $("permisos-horario-inicio"), fi = $("permisos-horario-fin"), ai = $("permisos-horario-activo");
      if (ii) ii.value = inicioCO;
      if (fi) fi.value = finCO;
      if (ai) ai.checked = hc.activo !== false;
    }).catch(function () {
      var btn = $("permisos-freno-btn");
      if (btn) { btn.textContent = "No disponible"; btn.disabled = true; btn.classList.remove("cargando"); }
    });
  }
  function cargarPermisosCategorias() {
    var cont = $("permisos-categorias");
    if (!cont) return;
    apiSafe("/api/permisos").then(function (d) {
      var cats = (d && d.categorias) || [];
      if (!cats.length) { vacio("permisos-categorias", "Sin categorías", ""); return; }
      cont.className = "";
      cont.innerHTML = cats.map(function (c) {
        return '<div class="ajuste">' +
          '<div><b>' + esc(c.titulo) + '</b><span>' + esc(c.descripcion) + '</span></div>' +
          '<div style="display:flex;gap:16px;flex-wrap:wrap">' +
            '<label style="display:flex;align-items:center;gap:6px;font-size:14px"><input type="checkbox" data-perm-cat="' + esc(c.id) + '" data-perm-tipo="lectura"' + (c.lectura ? " checked" : "") + '> Puede vigilar</label>' +
            '<label style="display:flex;align-items:center;gap:6px;font-size:14px"><input type="checkbox" data-perm-cat="' + esc(c.id) + '" data-perm-tipo="escritura"' + (c.escritura ? " checked" : "") + '> Puede actuar sola</label>' +
          '</div></div>';
      }).join("");
    }).catch(function () { noDisponible("permisos-categorias", "Los permisos todavía no están disponibles."); });
  }
  function cargarPermisos() {
    cargarPermisosReglas();
    cargarPermisosCategorias();
  }

  var permisosFrenoBtn = $("permisos-freno-btn");
  if (permisosFrenoBtn) {
    permisosFrenoBtn.addEventListener("click", function () {
      var activarA = permisosFrenoBtn.dataset.frenoActivo !== "1";
      var cuerpo = activarA ? { activo: true, motivo: (($("permisos-freno-motivo") || {}).value || "") } : { activo: false };
      permisosFrenoBtn.disabled = true;
      postZeus("/api/reglas/freno", cuerpo).then(function (d) {
        if (d && d.ok) { pintarFreno(d.freno); aviso(activarA ? "Freno de emergencia activado." : "Freno de emergencia desactivado."); }
        else { aviso((d && d.mensaje) || "No se pudo cambiar el freno."); permisosFrenoBtn.disabled = false; }
      }).catch(function () { aviso("No hay conexión con el servidor."); permisosFrenoBtn.disabled = false; });
    });
  }

  var permisosHorarioBtn = $("permisos-horario-guardar");
  if (permisosHorarioBtn) {
    permisosHorarioBtn.addEventListener("click", function () {
      var ii = $("permisos-horario-inicio"), fi = $("permisos-horario-fin"), ai = $("permisos-horario-activo");
      var inicioCO = Math.max(0, Math.min(23, parseInt((ii && ii.value) || "8", 10) || 0));
      var finCO = Math.max(0, Math.min(23, parseInt((fi && fi.value) || "20", 10) || 0));
      var cuerpo = { inicio_utc: (inicioCO + 5) % 24, fin_utc: (finCO + 5) % 24, activo: !!(ai && ai.checked) };
      permisosHorarioBtn.disabled = true;
      postZeus("/api/reglas/horario", cuerpo).then(function (d) {
        if (d && d.ok) tareaLista("Horario comercial guardado.", "");
        else aviso((d && d.mensaje) || "No se pudo guardar el horario.");
      }).catch(function () { aviso("No hay conexión con el servidor."); }).finally(function () { permisosHorarioBtn.disabled = false; });
    });
  }

  var permisosGuardarBtn = $("permisos-guardar");
  if (permisosGuardarBtn) {
    permisosGuardarBtn.addEventListener("click", function () {
      var cuerpo = {};
      document.querySelectorAll("#permisos-categorias input[data-perm-cat]").forEach(function (el) {
        var id = el.dataset.permCat, tipo = el.dataset.permTipo;
        cuerpo[id] = cuerpo[id] || { lectura: true, escritura: true };
        cuerpo[id][tipo] = el.checked;
      });
      permisosGuardarBtn.disabled = true;
      postZeus("/api/permisos", { permisos: cuerpo }).then(function (d) {
        if (d && d.ok) tareaLista("Permisos guardados.", "Los cambios ya están activos.");
        else aviso((d && d.mensaje) || "No se pudieron guardar los permisos.");
      }).catch(function () { aviso("No hay conexión con el servidor."); }).finally(function () { permisosGuardarBtn.disabled = false; });
    });
  }

  /* =========================================================================
     Simulacros (ingeniería del caos) — DISENO-FASE-CAOS.md §2.2, §2.3, §2.7, §2.8.
     Ids exactos según el diseño (otro proceso implementa el backend contra ellos).
     ========================================================================= */
  var HOMBRE_MUERTO_S = { bot: 150, cpu: 140, oom: 120, disco: 120, red: 280, bd: 90 };
  // ^ margen del hombre muerto de systemd-run por simulacro (§2.5/§2.6 del diseño).
  //   La API no expone hoy este número; en cuanto lo haga, leerlo de ahí en vez de
  //   este mapa fijo (mismo patrón que NOMBRES, ver CAMBIOS.md).
  var simCatalogoPorId = {};
  var simEnCurso = null;
  var simPendiente = null;
  var simModoModal = "lanzar";
  var simFuente = null;
  var simUltimoSeq = -1;
  var simAutoScroll = true;
  var simTimer = null;
  var simInicioMs = null;
  var simIdActivo = null;

  var scrimSimulacro = $("scrim-simulacro");
  var simConfInput = $("sim-confirmacion");
  var simOkBtn = $("sim-ok");
  var simConsola = $("sim-consola");
  var simAbortarBtn = $("sim-abortar");

  if (simConsola) {
    simConsola.style.background = "#0b0f14";
    simConsola.style.color = "#d8e2e8";
    simConsola.style.borderRadius = "10px";
    simConsola.style.padding = "12px 14px";
    simConsola.style.lineHeight = "1.55";
    simConsola.style.fontSize = "12.5px";
    simConsola.addEventListener("scroll", function () {
      var cerca = simConsola.scrollHeight - simConsola.scrollTop - simConsola.clientHeight < 24;
      simAutoScroll = cerca;
    });
  }

  function simColor(nivel) {
    return nivel === "crit" ? "#ff8a80" : nivel === "warn" ? "#ffd479" : nivel === "ok" ? "#7ee0a8" : "#9fb3c0";
  }

  function pintarPillSimulacro(nivel, texto) {
    var p = $("sim-pill");
    if (!p) return;
    p.className = "pill " + nivel;
    p.innerHTML = '<span class="ic"></span>' + esc(texto);
  }

  function cargarSimulacros() {
    apiSafe("/api/simulacros").then(function (d) {
      (d.catalogo || []).forEach(function (c) { simCatalogoPorId[c.id] = c; });
      simEnCurso = d.en_curso || null;
      pintarCatalogoSimulacros(d.catalogo || [], d.ultimos || {});
      cargarHistorialSimulacros(d.catalogo || []);
      if (simEnCurso && !simFuente) {
        simIdActivo = simEnCurso.simulacro;
        simInicioMs = simEnCurso.inicio ? new Date(simEnCurso.inicio).getTime() : Date.now();
        abrirConsolaSimulacro(simEnCurso.run_id, 0);
      } else if (!simEnCurso && !simFuente) {
        pintarPillSimulacro("mute", "Inactivo");
        $("sim-estado-sub").textContent = "Ningún simulacro en curso";
      }
    }).catch(function () {
      noDisponible("sim-catalogo", "El módulo de simulacros todavía no está disponible en el servidor.");
      var tb = $("sim-tb-historial");
      if (tb) tb.innerHTML = '<tr><td colspan="4" class="note">El módulo de simulacros todavía no está disponible.</td></tr>';
    });
  }

  function pintarCatalogoSimulacros(catalogo, ultimos) {
    var el = $("sim-catalogo");
    if (!el) return;
    el.innerHTML = catalogo.map(function (c) {
      var u = ultimos[c.id];
      var badge = u ? pill(u.aprobado ? "ok" : "crit", u.aprobado ? "Último: aprobado" : "Último: reprobado") : pill("mute", "Sin corridas");
      var deshabilitar = simEnCurso ? "disabled" : "";
      return '<div class="card"><div class="card-head"><h3>' + esc(c.titulo) + '</h3><span class="sub">Impacto ' + esc(c.impacto) + '</span></div>' +
        '<div class="card-body tight">' +
        '<p class="note" style="font-size:13.5px;color:var(--ink-2)">' + esc(c.descripcion) + '</p>' +
        '<p class="note" style="margin-top:6px">Dura ' + esc(c.duracion_s) + ' s aprox. · aprobado si: ' + esc(c.aprobado_si) + '</p>' +
        '<div style="margin-top:10px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">' + badge +
        '<button class="btn sm danger" data-simulacro="' + esc(c.id) + '" ' + deshabilitar + ' style="margin-left:auto">Lanzar</button>' +
        '</div></div></div>';
    }).join("");
  }

  function cargarHistorialSimulacros(catalogo) {
    var ids = catalogo.map(function (c) { return c.id; });
    var tb = $("sim-tb-historial");
    if (!ids.length) { if (tb) tb.innerHTML = '<tr><td colspan="4" class="note">Sin simulacros todavía.</td></tr>'; return; }
    Promise.all(ids.map(function (id) {
      return apiSafe("/api/simulacros/historial?id=" + encodeURIComponent(id))
        .then(function (d) { return (d.corridas || []).map(function (r) { r._id = id; r._titulo = (simCatalogoPorId[id] && simCatalogoPorId[id].titulo) || id; return r; }); })
        .catch(function () { return []; });
    })).then(function (listas) {
      var todas = [].concat.apply([], listas).sort(function (a, b) { return new Date(b.ts) - new Date(a.ts); }).slice(0, 20);
      if (!tb) return;
      if (!todas.length) { tb.innerHTML = '<tr><td colspan="4" class="note">Sin simulacros todavía.</td></tr>'; return; }
      tb.innerHTML = todas.map(function (r) {
        return "<tr>" +
          '<td data-l="Cuándo">' + esc(fechaHoraCO(r.ts)) + "</td>" +
          '<td data-l="Simulacro">' + esc(r._titulo) + "</td>" +
          '<td data-l="Resultado">' + pill(r.aprobado ? "ok" : "crit", r.resultado || (r.aprobado ? "aprobado" : "reprobado")) + "</td>" +
          '<td data-l="Duración" class="num">' + (r.duracion_s != null ? r.duracion_s + " s" : "—") + "</td>" +
          "</tr>";
      }).join("");
    });
  }

  function abrirModalSimulacro(id, modo) {
    var c = simCatalogoPorId[id];
    if (!c) return;
    simModoModal = modo || "lanzar";
    simPendiente = c;
    if (simModoModal === "abortar") {
      $("sim-modal-t").textContent = "Vas a detener el simulacro";
      $("sim-modal-desc").textContent = 'Se revertirá de inmediato el daño que causó "' + c.titulo + '".';
      $("sim-modal-datos").innerHTML = "";
      $("sim-palabra").textContent = "DETENER";
      simOkBtn.textContent = "Detener y revertir";
    } else {
      $("sim-modal-t").textContent = "Vas a lanzar: " + c.titulo;
      $("sim-modal-desc").textContent = c.descripcion;
      $("sim-modal-datos").innerHTML =
        "<div><span>Impacto</span><span>" + esc(c.impacto) + "</span></div>" +
        "<div><span>Duración</span><span>~" + esc(c.duracion_s) + " s</span></div>" +
        "<div><span>Se aprueba si</span><span>" + esc(c.aprobado_si) + "</span></div>";
      $("sim-palabra").textContent = c.palabra;
      simOkBtn.textContent = "Lanzar simulacro";
    }
    simConfInput.value = "";
    simOkBtn.disabled = true;
    $("sim-modal-error").hidden = true;
    scrimSimulacro.hidden = false;
    simConfInput.focus();
  }
  function cerrarModalSimulacro() {
    scrimSimulacro.hidden = true;
    simPendiente = null;
    simConfInput.value = "";
  }
  function actualizarBotonSimulacro() {
    var palabra = simModoModal === "abortar" ? "DETENER" : (simPendiente && simPendiente.palabra);
    simOkBtn.disabled = !simPendiente || simConfInput.value !== palabra;
  }
  if (simConfInput) {
    simConfInput.addEventListener("input", actualizarBotonSimulacro);
    simConfInput.addEventListener("keydown", function (e) { if (e.key === "Enter" && !simOkBtn.disabled) simOkBtn.click(); });
  }
  if ($("sim-cancelar")) $("sim-cancelar").addEventListener("click", cerrarModalSimulacro);
  if (scrimSimulacro) scrimSimulacro.addEventListener("click", function (e) { if (e.target === scrimSimulacro) cerrarModalSimulacro(); });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && scrimSimulacro && !scrimSimulacro.hidden) cerrarModalSimulacro();
  });

  function mostrarErrorModalSimulacro(msg) {
    var p = $("sim-modal-error");
    p.textContent = msg;
    p.hidden = false;
    simOkBtn.disabled = false;
  }

  if (simOkBtn) simOkBtn.addEventListener("click", function () {
    if (!simPendiente) return;
    var c = simPendiente;
    simOkBtn.disabled = true;
    $("sim-modal-error").hidden = true;
    if (simModoModal === "abortar") {
      postZeus("/api/simulacros/abortar", { run_id: simEnCurso && simEnCurso.run_id }).then(function (d) {
        if (d && d.ok) { cerrarModalSimulacro(); aviso(d.mensaje || "Simulacro revertido."); }
        else mostrarErrorModalSimulacro((d && d.mensaje) || "No se pudo detener el simulacro.");
      }).catch(function () { mostrarErrorModalSimulacro("No hay conexión con el servidor."); });
      return;
    }
    postZeus("/api/simulacros/lanzar", { id: c.id, confirmacion: simConfInput.value }).then(function (d) {
      if (d && d.ok) {
        cerrarModalSimulacro();
        simIdActivo = c.id;
        simInicioMs = Date.now();
        abrirConsolaSimulacro(d.run_id, null);
      } else {
        mostrarErrorModalSimulacro((d && d.mensaje) || "No se pudo lanzar el simulacro.");
      }
    }).catch(function () { mostrarErrorModalSimulacro("No hay conexión con el servidor."); });
  });

  if (simAbortarBtn) simAbortarBtn.addEventListener("click", function () {
    if (!simIdActivo) return;
    abrirModalSimulacro(simIdActivo, "abortar");
  });

  function simLinea(ev) {
    if (!simConsola) return;
    if (ev.seq != null) simUltimoSeq = ev.seq;
    var hora = ev.ts ? horaCO(ev.ts) : "";
    var linea = document.createElement("div");
    linea.style.color = simColor(ev.nivel);
    linea.textContent = "[" + hora + "] " + (ev.texto || "");
    simConsola.appendChild(linea);
    if (simAutoScroll) simConsola.scrollTop = simConsola.scrollHeight;
  }

  function actualizarEstadoSimulacro() {
    if (!simIdActivo || simInicioMs == null) return;
    var llevaS = Math.max(0, Math.round((Date.now() - simInicioMs) / 1000));
    var tope = HOMBRE_MUERTO_S[simIdActivo] || 180;
    var restante = Math.max(0, tope - llevaS);
    var titulo = (simCatalogoPorId[simIdActivo] && simCatalogoPorId[simIdActivo].titulo) || simIdActivo;
    var s = $("sim-estado-sub");
    if (s) s.textContent = titulo + " · lleva " + llevaS + " s · reversión automática en " + restante + " s si no termina antes";
  }

  function abrirConsolaSimulacro(runId, desde) {
    if (simConsola) simConsola.innerHTML = "";
    $("sim-veredicto").hidden = true;
    $("sim-veredicto").innerHTML = "";
    $("sim-abortar").hidden = false;
    pintarPillSimulacro("warn", "En curso");
    if (simTimer) clearInterval(simTimer);
    simTimer = setInterval(actualizarEstadoSimulacro, 1000);
    actualizarEstadoSimulacro();
    conectarSseSimulacro(runId, desde);
  }

  function conectarSseSimulacro(runId, desde) {
    if (simFuente) { try { simFuente.close(); } catch (e) {} simFuente = null; }
    if (typeof EventSource === "undefined") { noDisponible("sim-consola", "Este navegador no admite ver el simulacro en vivo."); return; }
    var url = "/api/simulacros/vivo?run=" + encodeURIComponent(runId) + (desde != null ? "&desde=" + desde : "");
    var es = new EventSource(url);
    simFuente = es;
    es.addEventListener("paso", function (e) {
      try { simLinea(JSON.parse(e.data)); } catch (err) {}
    });
    es.addEventListener("fin", function (e) {
      var ev = null;
      try { ev = JSON.parse(e.data); } catch (err) {}
      if (ev) simLinea(ev);
      try { es.close(); } catch (err2) {}
      simFuente = null;
      if (simTimer) { clearInterval(simTimer); simTimer = null; }
      $("sim-abortar").hidden = true;
      var aprobado = ev && ev.dato && ev.dato.aprobado;
      pintarPillSimulacro(aprobado ? "ok" : "crit", aprobado ? "Aprobado" : "Terminado");
      $("sim-estado-sub").textContent = "Ningún simulacro en curso";
      var criterios = (ev && ev.dato && ev.dato.criterios) || [];
      var vc = $("sim-veredicto");
      vc.hidden = false;
      vc.className = "tarea " + (aprobado ? "lista" : "fallo");
      vc.innerHTML = "<b>" + (aprobado ? "APROBADO" : "FALLÓ") + "</b>" +
        (criterios.length ? criterios.map(function (c) {
          var texto = typeof c === "string" ? c : (c.texto || c.descripcion || JSON.stringify(c));
          var cumplido = typeof c === "object" && c !== null ? !!c.cumplido : true;
          return '<div class="revision"><span class="mk ' + (cumplido ? "ok" : "no") + '">' + (cumplido ? "✓" : "✕") + "</span><div><span>" + esc(texto) + "</span></div><span></span></div>";
        }).join("") : "<span>" + esc((ev && ev.texto) || "Simulacro terminado.") + "</span>");
      simIdActivo = null;
      simInicioMs = null;
      cargarSeccion("simulacros", true);
    });
    es.onerror = function () {
      es.close();
      if (simFuente === es) simFuente = null;
      setTimeout(function () {
        if (simIdActivo) conectarSseSimulacro(runId, simUltimoSeq + 1);
      }, 3000);
    };
  }

  /* =========================================================================
     SOS — protocolo autónomo de emergencia (ver modulos/sos/INTEGRACION-SOS.md §5).
     Misma consola SSE que Simulacros (copia adaptada a los ids "sos-*" y al
     contrato de /api/sos/vivo), mismos helpers ($ , esc, api, apiSafe, postZeus,
     pill, abrirConfirmar, aviso, ir, tareaTrabajando/Lista/Fallo, cargarRegistro,
     refrescarResumen, NOMBRES, infoServicio, fechaHoraCO, horaCO, simColor).
     ========================================================================= */
  var sosFuente = null, sosUltimoSeq = -1, sosAutoScroll = true, sosInicioMs = null, sosTimer = null, sosRunId = null;
  var sosUltimoEvidenciaId = null, sosUltimoMensaje = "";
  var sosConsolaEl = $("sos-consola");
  var sosLanzarBtn = $("sos-lanzar");
  if (sosConsolaEl) {
    sosConsolaEl.style.background = "#0b0f14";
    sosConsolaEl.style.color = "#d8e2e8";
    sosConsolaEl.style.borderRadius = "10px";
    sosConsolaEl.style.padding = "12px 14px";
    sosConsolaEl.style.lineHeight = "1.55";
    sosConsolaEl.style.fontSize = "12.5px";
    sosConsolaEl.addEventListener("scroll", function () {
      var cerca = sosConsolaEl.scrollHeight - sosConsolaEl.scrollTop - sosConsolaEl.clientHeight < 24;
      sosAutoScroll = cerca;
    });
  }

  function copiarTexto(texto) {
    function ok() { aviso("Copiado. Ya puedes pegarlo en un chat o correo."); }
    function respaldo() {
      var t = $("reg-portapapeles");
      if (!t) { aviso("No se pudo copiar en este navegador."); return; }
      t.value = texto;
      t.select();
      try { document.execCommand("copy"); ok(); } catch (e) { aviso("No pude copiar. Selecciona el texto y cópialo a mano."); }
    }
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(texto).then(ok, respaldo);
    else respaldo();
  }

  function kb(bytes) {
    bytes = Number(bytes) || 0;
    return bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + " MB" : Math.round(bytes / 1024) + " KB";
  }

  var NOMBRES_LIMITE_SOS = {
    reiniciar_servidor: "Reiniciar el servidor completo",
    deshacer_despliegue: "Deshacer el último cambio",
    reiniciar_docker: "Reiniciar Docker"
  };
  var TITULOS_SINTOMA_SOS = {
    bot_caido: "El bot de WhatsApp estaba caído", tienda_caida: "El punto de venta estaba caído",
    bd_caida: "La base de datos estaba caída", memoria_llena: "Memoria casi llena",
    disco_lleno: "Disco casi lleno", puerta_caida: "La puerta de entrada estaba caída",
    ninguno: "Nada estaba fallando"
  };
  function tituloSintomaSos(s) { return TITULOS_SINTOMA_SOS[s] || (s ? String(s).replace(/_/g, " ") : "—"); }
  function resultadoSosNivel(r) {
    if (r === "restablecido" || r === "sin_falla") return "ok";
    if (r === "parcial") return "warn";
    return "crit";
  }
  function textoResultadoSos(r) {
    return ({
      restablecido: "Se restableció", sin_falla: "No encontró ninguna falla", parcial: "Se arregló en parte",
      detenido_pide_ayuda: "Se detuvo y pide ayuda", "falló": "No se pudo resolver", fallo: "No se pudo resolver"
    })[r] || (r || "—");
  }

  function marcarBadgeSos(activo) {
    ["sos-badge-rail", "sos-badge-tab"].forEach(function (id) {
      var b = $(id);
      if (b) b.className = activo ? "badge aviso" : "badge";
    });
  }

  function pintarPillSos(nivel, texto) {
    var p = $("sos-pill");
    if (!p) return;
    p.className = "pill " + nivel;
    p.innerHTML = '<span class="ic"></span>' + esc(texto);
  }

  function pintarLimitesSos(limites) {
    var claves = Object.keys(limites || {});
    if (!claves.length) { vacio("sos-limites", "Sin datos de límites por ahora.", ""); $("sos-limites-sub").textContent = "—"; return; }
    var el = $("sos-limites");
    el.className = "";
    var bloqueados = claves.filter(function (k) { return limites[k].bloqueado; }).length;
    $("sos-limites-sub").textContent = bloqueados ? bloqueados + (bloqueados === 1 ? " bloqueado" : " bloqueados") : "Todo disponible";
    el.innerHTML = claves.map(function (k) {
      var l = limites[k] || {};
      var nombre = NOMBRES_LIMITE_SOS[k] || k.replace(/_/g, " ");
      var usoHoy = l.hoy != null ? "Hoy: " + l.hoy + (l.hoy === 1 ? " vez" : " veces") : "";
      var enfriamiento = l.enfriamiento_restante_min > 0 ? "Disponible de nuevo en " + l.enfriamiento_restante_min + " min" : "";
      var detalle = [usoHoy, enfriamiento].filter(Boolean).join(" · ") || "Disponible";
      return '<div class="revision"><span class="mk ' + (l.bloqueado ? "no" : "ok") + '">' + (l.bloqueado ? "✕" : "✓") + '</span>' +
        '<div><b>' + esc(nombre) + '</b><span>' + esc(detalle) + (l.motivo_bloqueo ? " · " + esc(l.motivo_bloqueo) : "") + '</span></div>' +
        (l.bloqueado ? '<button class="btn sm" data-desbloquear="' + esc(k) + '">Volver a permitir</button>' : '<span></span>') +
        '</div>';
    }).join("");
  }

  function pintarUltimasSos(d) {
    var lista = (d && d.corridas) || [];
    var tb = $("sos-tb-ultimas");
    if (!tb) return;
    tb.innerHTML = lista.length ? lista.map(function (c) {
      return "<tr>" +
        '<td data-l="Cuándo">' + esc(fechaHoraCO(c.inicio)) + "</td>" +
        '<td data-l="Qué encontró">' + esc(tituloSintomaSos(c.sintoma_principal)) + "</td>" +
        '<td data-l="Resultado">' + (c.fin ? pill(resultadoSosNivel(c.resultado), textoResultadoSos(c.resultado)) : pill("warn", "En curso")) + "</td>" +
        '<td data-l="Acciones" class="num">' + (c.acciones != null ? c.acciones : "—") + "</td>" +
        "</tr>";
    }).join("") : '<tr><td colspan="4" class="note">Sin corridas todavía.</td></tr>';
  }

  function cargarSos() {
    apiSafe("/api/sos").then(function (d) {
      pintarLimitesSos(d.limites || {});
      var bloqueoSim = $("sos-bloqueo-simulacro");
      if (bloqueoSim) bloqueoSim.hidden = !d.simulacro_en_curso;
      if (sosLanzarBtn) sosLanzarBtn.disabled = !!d.simulacro_en_curso || !!d.en_curso;
      marcarBadgeSos(!!d.en_curso);
      if (d.en_curso && !sosFuente) {
        sosRunId = d.en_curso.run_id;
        sosInicioMs = d.en_curso.inicio ? new Date(d.en_curso.inicio).getTime() : Date.now();
        abrirConsolaSos(sosRunId, 0);
      } else if (!d.en_curso && !sosFuente) {
        pintarPillSos("mute", "Inactivo");
        var sub = $("sos-estado-sub");
        if (sub) sub.textContent = "Ningún SOS en curso";
      }
    }).catch(function () {
      noDisponible("sos-limites", "El protocolo SOS todavía no está disponible en el servidor.");
      $("sos-limites-sub").textContent = "—";
      if (sosLanzarBtn) sosLanzarBtn.disabled = true;
      var tb = $("sos-tb-ultimas");
      if (tb) tb.innerHTML = '<tr><td colspan="4" class="note">El protocolo SOS todavía no está disponible.</td></tr>';
    });
    apiSafe("/api/sos/corridas?limite=10").then(pintarUltimasSos).catch(function () {});
  }

  if (sosLanzarBtn) sosLanzarBtn.addEventListener("click", function () {
    $("hoja-info-t").textContent = "Vas a lanzar el SOS";
    $("hoja-info-p").textContent = "Va a diagnosticar, guardar la evidencia y reparar lo que encuentre, incluido reiniciar servicios si hace falta. No reinicia el servidor completo ni deshace un despliegue más de una vez al día.";
    $("hoja-info-datos").innerHTML = "";
    $("hoja-info-ok").textContent = "Ejecutar";
    scrimInfo.hidden = false;
    $("hoja-info-ok").onclick = function () {
      scrimInfo.hidden = true;
      lanzarSos();
    };
  });

  function lanzarSos() {
    if (sosLanzarBtn) sosLanzarBtn.disabled = true;
    postZeus("/api/sos/lanzar", {}).then(function (d) {
      if (d && d.ok) {
        sosRunId = d.run_id;
        sosInicioMs = Date.now();
        abrirConsolaSos(sosRunId, 0);
      } else {
        aviso((d && d.mensaje) || "No se pudo lanzar el SOS.");
        if (sosLanzarBtn) sosLanzarBtn.disabled = false;
      }
    }).catch(function () { aviso("No hay conexión con el servidor."); if (sosLanzarBtn) sosLanzarBtn.disabled = false; });
  }

  function sosLinea(ev) {
    if (!sosConsolaEl) return;
    if (ev.seq != null) sosUltimoSeq = ev.seq;
    var hora = ev.ts ? horaCO(ev.ts) : "";
    var linea = document.createElement("div");
    linea.style.color = simColor(ev.nivel);
    linea.textContent = (hora ? "[" + hora + "] " : "") + (ev.texto || "");
    sosConsolaEl.appendChild(linea);
    if (sosAutoScroll) sosConsolaEl.scrollTop = sosConsolaEl.scrollHeight;
  }

  function actualizarEstadoSos() {
    if (!sosInicioMs) return;
    var llevaS = Math.max(0, Math.round((Date.now() - sosInicioMs) / 1000));
    var s = $("sos-estado-sub");
    if (s) s.textContent = "En curso · lleva " + llevaS + " s";
  }

  function abrirConsolaSos(runId, desde) {
    if (sosConsolaEl) sosConsolaEl.innerHTML = "";
    $("sos-veredicto").hidden = true;
    $("sos-veredicto").innerHTML = "";
    pintarPillSos("warn", "En curso");
    if (sosLanzarBtn) sosLanzarBtn.disabled = true;
    if (sosTimer) clearInterval(sosTimer);
    sosTimer = setInterval(actualizarEstadoSos, 1000);
    actualizarEstadoSos();
    marcarBadgeSos(true);
    conectarSseSos(runId, desde);
  }

  function pintarVeredictoSos(dato) {
    var v = $("sos-veredicto");
    v.hidden = false;
    $("sos-veredicto-titulo").textContent = textoResultadoSos(dato.resultado);
    var lineas = String(dato.mensaje_final || "").split(/\n+/).filter(Boolean);
    $("sos-veredicto-encontro").textContent = lineas[0] || "";
    var clientesTxt = dato.afecta_clientes === "si" ? "Sí afectó a los clientes mientras duró."
      : dato.afecta_clientes === "parcial" ? "Afectó a algunos clientes."
      : dato.afecta_clientes === "no" ? "No llegó a afectar a los clientes." : "";
    $("sos-veredicto-clientes").textContent = clientesTxt;
    var restoLineas = lineas.slice(1);
    $("sos-veredicto-acciones").innerHTML = restoLineas.length
      ? restoLineas.map(function (l) { return "<li>" + esc(l) + "</li>"; }).join("")
      : "<li>" + esc(dato.acciones != null ? (dato.acciones + (dato.acciones === 1 ? " acción realizada." : " acciones realizadas.")) : "Sin acciones adicionales.") + "</li>";
    var detBloque = $("sos-veredicto-detencion");
    if (dato.resultado === "detenido_pide_ayuda") {
      detBloque.hidden = false;
      detBloque.textContent = "Centinela llegó a un límite de seguridad y se detuvo. Revisa los límites de arriba o avisa al técnico.";
    } else detBloque.hidden = true;
    var hip = $("sos-hipotesis-ia");
    if (hip) {
      if (dato.hipotesis_ia) { hip.hidden = false; $("sos-hipotesis-ia-texto").textContent = dato.hipotesis_ia; }
      else hip.hidden = true;
    }
    sosUltimoEvidenciaId = dato.evidencia_id || null;
    sosUltimoMensaje = dato.mensaje_final || "";
  }

  function conectarSseSos(runId, desde) {
    if (sosFuente) { try { sosFuente.close(); } catch (e) {} sosFuente = null; }
    if (typeof EventSource === "undefined") { noDisponible("sos-consola", "Este navegador no admite ver el SOS en vivo."); return; }
    var url = "/api/sos/vivo?run=" + encodeURIComponent(runId) + (desde != null ? "&desde=" + desde : "");
    var es = new EventSource(url);
    sosFuente = es;
    es.addEventListener("paso", function (e) { try { sosLinea(JSON.parse(e.data)); } catch (err) {} });
    es.addEventListener("fin", function (e) {
      var ev = null;
      try { ev = JSON.parse(e.data); } catch (err) {}
      if (ev) sosLinea(ev);
      try { es.close(); } catch (err2) {}
      sosFuente = null;
      if (sosTimer) { clearInterval(sosTimer); sosTimer = null; }
      marcarBadgeSos(false);
      if (sosLanzarBtn) sosLanzarBtn.disabled = false;
      var dato = (ev && ev.dato) || {};
      pintarPillSos(resultadoSosNivel(dato.resultado), textoResultadoSos(dato.resultado));
      var sub = $("sos-estado-sub");
      if (sub) sub.textContent = "Ningún SOS en curso";
      pintarVeredictoSos(dato);
      sosInicioMs = null;
      cargarSos();
      setTimeout(refrescarResumen, 1500);
    });
    es.onerror = function () {
      es.close();
      if (sosFuente === es) sosFuente = null;
      setTimeout(function () { if (sosInicioMs) conectarSseSos(runId, sosUltimoSeq + 1); }, 3000);
    };
  }

  var sosVerEvidenciaBtn = $("sos-ver-evidencia");
  if (sosVerEvidenciaBtn) sosVerEvidenciaBtn.addEventListener("click", function () {
    var idEv = sosUltimoEvidenciaId;
    ir("registros");
    if (idEv) setTimeout(function () { abrirDetalleEvidencia(idEv); }, 250);
  });
  var sosCopiarMensajeBtn = $("sos-copiar-mensaje");
  if (sosCopiarMensajeBtn) sosCopiarMensajeBtn.addEventListener("click", function () {
    copiarTexto(sosUltimoMensaje || "Centinela Zeus: sin resumen disponible.");
  });

  /* =========================================================================
     Registros — evidencia guardada por el SOS + historial de corridas
     (ver modulos/sos/INTEGRACION-SOS.md §5.8-5.10, §5.5-5.6).
     ========================================================================= */
  var regEvidenciaLista = [], regCorridasLista = [], regDetalleActualId = null, regCorridaActualId = null;

  function textoClientesEvidencia(v) { return v === "si" ? "Sí" : v === "parcial" ? "Parcial" : v === "no" ? "No" : "—"; }

  function pintarTablaEvidencia(lista) {
    var tb = $("reg-tb-evidencia");
    if (!tb) return;
    tb.innerHTML = lista.length ? lista.map(function (p) {
      return "<tr>" +
        '<td data-l="Cuándo">' + esc(fechaHoraCO(p.ts)) + "</td>" +
        '<td data-l="Qué falla">' + esc(p.titulo || tituloSintomaSos(p.sintoma_principal)) + "</td>" +
        '<td data-l="Clientes">' + esc(textoClientesEvidencia(p.afecta_clientes)) + "</td>" +
        '<td data-l="Tamaño" class="num">' + kb(p.bytes) + "</td>" +
        '<td data-l=""><button class="btn sm" data-evidencia-ver="' + esc(p.id) + '">Ver</button></td>' +
        "</tr>";
    }).join("") : '<tr><td colspan="5" class="note">Sin evidencia guardada todavía.</td></tr>';
  }

  function pintarTablaCorridas(lista) {
    var tb = $("reg-tb-corridas");
    if (!tb) return;
    tb.innerHTML = lista.length ? lista.map(function (c) {
      return "<tr>" +
        '<td data-l="Cuándo">' + esc(fechaHoraCO(c.inicio)) + "</td>" +
        '<td data-l="Qué encontró">' + esc(tituloSintomaSos(c.sintoma_principal)) + "</td>" +
        '<td data-l="Resultado">' + (c.fin ? pill(resultadoSosNivel(c.resultado), textoResultadoSos(c.resultado)) : pill("warn", "En curso")) + "</td>" +
        '<td data-l="Acciones" class="num">' + (c.acciones != null ? c.acciones : "—") + "</td>" +
        '<td data-l=""><button class="btn sm" data-corrida-ver="' + esc(c.run_id) + '">Ver</button></td>' +
        "</tr>";
    }).join("") : '<tr><td colspan="5" class="note">Sin corridas todavía.</td></tr>';
  }

  function cargarRegistros() {
    apiSafe("/api/evidencia").then(function (d) {
      regEvidenciaLista = (d && d.paquetes) || [];
      var especiales = (d && d.especiales) || [];
      pintarTablaEvidencia(regEvidenciaLista.concat(especiales));
      var esp = $("reg-espacio");
      if (esp) esp.textContent = d && d.bytes_total != null
        ? kb(d.bytes_total) + " usados" + (d.limites ? " de " + kb(d.limites.bytes) + " permitidos" : "")
        : "—";
    }).catch(function () {
      var tb = $("reg-tb-evidencia");
      if (tb) tb.innerHTML = '<tr><td colspan="5" class="note">La evidencia todavía no está disponible.</td></tr>';
      var esp = $("reg-espacio");
      if (esp) esp.textContent = "—";
    });
    apiSafe("/api/sos/corridas?limite=50").then(function (d) {
      regCorridasLista = (d && d.corridas) || [];
      pintarTablaCorridas(regCorridasLista);
      var sub = $("reg-corridas-sub");
      if (sub) sub.textContent = regCorridasLista.length + (regCorridasLista.length === 1 ? " corrida" : " corridas");
    }).catch(function () {
      var tb = $("reg-tb-corridas");
      if (tb) tb.innerHTML = '<tr><td colspan="5" class="note">El historial del SOS todavía no está disponible.</td></tr>';
      var sub = $("reg-corridas-sub");
      if (sub) sub.textContent = "—";
    });
  }

  function abrirDetalleEvidencia(id) {
    apiSafe("/api/evidencia/" + encodeURIComponent(id) + "?formato=json").then(function (p) {
      regDetalleActualId = id;
      var card = $("reg-detalle");
      card.hidden = false;
      $("reg-detalle-titulo").textContent = p.titulo || tituloSintomaSos(p.sintoma_principal);
      $("reg-detalle-meta").textContent = fechaHoraCO(p.ts) + (p.run_id ? " · corrida " + p.run_id : "");
      $("reg-detalle-aviso-abierto").hidden = !p.incidente_abierto;
      var mask = p.enmascarado || {};
      var reemplazos = mask.reemplazos || {};
      var total = Object.keys(reemplazos).reduce(function (a, k) { return a + (Number(reemplazos[k]) || 0); }, 0);
      $("reg-detalle-enmascarado").textContent = total
        ? "Se ocultaron " + total + " dato(s) sensible(s) antes de guardar esto."
        : "No se encontraron datos sensibles que ocultar.";
      var secciones = p.secciones || [];
      $("reg-detalle-secciones").innerHTML = secciones.length ? secciones.map(function (s) {
        var abierto = (s.clave === "resumen" || s.clave === "acciones") ? " open" : "";
        return "<details" + abierto + "><summary>" + esc(s.titulo || s.clave) + " · " + kb(s.bytes) + (s.recortado ? " (recortado)" : "") + "</summary>" +
          '<pre class="mono" style="white-space:pre-wrap;overflow-x:auto">' + esc(s.texto || "") + "</pre></details>";
      }).join("") : '<p class="note">Sin secciones.</p>';
      card.scrollIntoView({ behavior: "smooth", block: "start" });
    }).catch(function () { aviso("No se pudo abrir esta evidencia."); });
  }

  var regCerrarDetalleBtn = $("reg-cerrar-detalle");
  if (regCerrarDetalleBtn) regCerrarDetalleBtn.addEventListener("click", function () { $("reg-detalle").hidden = true; regDetalleActualId = null; });

  var regCopiarResumenBtn = $("reg-copiar-resumen");
  if (regCopiarResumenBtn) regCopiarResumenBtn.addEventListener("click", function () {
    if (!regDetalleActualId) return;
    fetch("/api/evidencia/" + encodeURIComponent(regDetalleActualId) + "?formato=resumen")
      .then(function (r) { return r.text(); }).then(copiarTexto).catch(function () { aviso("No se pudo copiar."); });
  });
  var regCopiarTodoBtn = $("reg-copiar-todo");
  if (regCopiarTodoBtn) regCopiarTodoBtn.addEventListener("click", function () {
    if (!regDetalleActualId) return;
    fetch("/api/evidencia/" + encodeURIComponent(regDetalleActualId) + "?formato=texto")
      .then(function (r) { return r.text(); })
      .then(function (t) {
        if (t.length > 51200) aviso("Son " + Math.round(t.length / 1024) + " KB; se copió completo igual.");
        copiarTexto(t);
      }).catch(function () { aviso("No se pudo copiar."); });
  });
  var regBorrarUnoBtn = $("reg-borrar-uno");
  if (regBorrarUnoBtn) regBorrarUnoBtn.addEventListener("click", function () {
    if (!regDetalleActualId) return;
    var p = regEvidenciaLista.filter(function (x) { return x.id === regDetalleActualId; })[0];
    var titulo = (p && (p.titulo || tituloSintomaSos(p.sintoma_principal))) || regDetalleActualId;
    var abierto = p && p.incidente_abierto;
    abrirConfirmar("BORRAR", "Vas a borrar el registro " + regDetalleActualId + " (" + titulo + "). No se puede recuperar." +
      (abierto ? " Esta falla sigue abierta: perderías la evidencia de lo que pasa ahora." : ""), function () {
      postZeus("/api/evidencia/borrar", { id: regDetalleActualId, confirmacion: "BORRAR" }).then(function (d) {
        if (d && d.ok) { aviso("Registro borrado."); $("reg-detalle").hidden = true; regDetalleActualId = null; cargarRegistros(); }
        else aviso((d && d.mensaje) || "No se pudo borrar.");
      }).catch(function () { aviso("No hay conexión con el servidor."); });
    });
  });
  var regBorrarTodosBtn = $("reg-borrar-todos");
  if (regBorrarTodosBtn) regBorrarTodosBtn.addEventListener("click", function () {
    var n = regEvidenciaLista.length;
    abrirConfirmar("BORRAR-TODO", "Vas a borrar los " + n + " registros de evidencia guardados. No se puede recuperar. Los límites de seguridad del SOS no se borran.", function () {
      postZeus("/api/evidencia/borrar", { todos: true, confirmacion: "BORRAR-TODO" }).then(function (d) {
        if (d && d.ok) { aviso("Registros borrados."); $("reg-detalle").hidden = true; cargarRegistros(); }
        else aviso((d && d.mensaje) || "No se pudo borrar.");
      }).catch(function () { aviso("No hay conexión con el servidor."); });
    });
  });

  function abrirDetalleCorrida(runId) {
    apiSafe("/api/sos/corridas/" + encodeURIComponent(runId)).then(function (c) {
      regCorridaActualId = runId;
      var card = $("reg-corrida-detalle");
      card.hidden = false;
      $("reg-corrida-titulo").textContent = tituloSintomaSos(c.sintoma_principal);
      $("reg-corrida-meta").textContent = fechaHoraCO(c.inicio) + (c.fin ? " · duró " + Math.max(1, Math.round((c.duracion_s || 0) / 60)) + " min" : " · en curso");
      fetch("/api/sos/corridas/" + encodeURIComponent(runId) + "?formato=texto")
        .then(function (r) { return r.text(); })
        .then(function (t) { $("reg-corrida-texto").textContent = t; })
        .catch(function () { $("reg-corrida-texto").textContent = c.mensaje_final || ""; });
      card.scrollIntoView({ behavior: "smooth", block: "start" });
    }).catch(function () { aviso("No se pudo abrir esta corrida."); });
  }
  var regCorridaCerrarBtn = $("reg-corrida-cerrar");
  if (regCorridaCerrarBtn) regCorridaCerrarBtn.addEventListener("click", function () { $("reg-corrida-detalle").hidden = true; regCorridaActualId = null; });
  var regCorridaCopiarBtn = $("reg-corrida-copiar");
  if (regCorridaCopiarBtn) regCorridaCopiarBtn.addEventListener("click", function () { copiarTexto(($("reg-corrida-texto") && $("reg-corrida-texto").textContent) || ""); });
  var regCorridaVerEvidenciaBtn = $("reg-corrida-ver-evidencia");
  if (regCorridaVerEvidenciaBtn) regCorridaVerEvidenciaBtn.addEventListener("click", function () {
    var c = regCorridasLista.filter(function (x) { return x.run_id === regCorridaActualId; })[0];
    if (c && c.evidencia_id) abrirDetalleEvidencia(c.evidencia_id);
    else aviso("Esta corrida no guardó evidencia.");
  });
  var regCorridaVerConsolaBtn = $("reg-corrida-ver-consola");
  if (regCorridaVerConsolaBtn) regCorridaVerConsolaBtn.addEventListener("click", function () {
    var idCorrida = regCorridaActualId;
    ir("sos");
    if (idCorrida) setTimeout(function () { abrirConsolaSos(idCorrida, 0); }, 250);
  });
  var regCorridaBorrarBtn = $("reg-corrida-borrar");
  if (regCorridaBorrarBtn) regCorridaBorrarBtn.addEventListener("click", function () {
    if (!regCorridaActualId) return;
    abrirConfirmar("BORRAR", "Vas a borrar la corrida " + regCorridaActualId + ". No se puede recuperar.", function () {
      postZeus("/api/sos/corridas/borrar", { run_id: regCorridaActualId, confirmacion: "BORRAR", con_evidencia: false }).then(function (d) {
        if (d && d.ok) { aviso("Corrida borrada."); $("reg-corrida-detalle").hidden = true; regCorridaActualId = null; cargarRegistros(); }
        else aviso((d && d.mensaje) || "No se pudo borrar.");
      }).catch(function () { aviso("No hay conexión con el servidor."); });
    });
  });
  var regCorridasBorrarTodasBtn = $("reg-corridas-borrar-todas");
  if (regCorridasBorrarTodasBtn) regCorridasBorrarTodasBtn.addEventListener("click", function () {
    var n = regCorridasLista.length;
    abrirConfirmar("BORRAR-TODO", "Vas a borrar las " + n + " corridas del SOS registradas. No se puede recuperar.", function () {
      postZeus("/api/sos/corridas/borrar", { todos: true, confirmacion: "BORRAR-TODO", con_evidencia: false }).then(function (d) {
        if (d && d.ok) { aviso("Corridas borradas."); $("reg-corrida-detalle").hidden = true; cargarRegistros(); }
        else aviso((d && d.mensaje) || "No se pudo borrar.");
      }).catch(function () { aviso("No hay conexión con el servidor."); });
    });
  });

  /* =========================================================================
     Contenedores — lista, ficha, registros en vivo, reiniciar/detener/arrancar
     (ver modulos/contenedores/INTEGRACION-CONTENEDORES.md §7, DISENO-CONTENEDORES.md §7.3).
     ========================================================================= */
  var contFuente = null, contUltimoSeq = -1, contAutoScroll = true, contModoRegistros = false;
  var contRunActivo = null, contNombreActivo = null, contVisTimer = null;
  var contListaCache = { propios: [], ajenos: [] };
  var contPendiente = null;
  var scrimContenedor = $("scrim-contenedor");
  var contPinInput = $("cont-pin");
  var contConfInput = $("cont-confirmacion");
  var contOkBtn = $("cont-ok");
  var contConsolaEl = $("cont-consola");
  if (contConsolaEl) {
    contConsolaEl.style.background = "#0b0f14";
    contConsolaEl.style.color = "#d8e2e8";
    contConsolaEl.style.borderRadius = "10px";
    contConsolaEl.style.padding = "12px 14px";
    contConsolaEl.style.lineHeight = "1.55";
    contConsolaEl.style.fontSize = "12.5px";
    contConsolaEl.addEventListener("scroll", function () {
      var cerca = contConsolaEl.scrollHeight - contConsolaEl.scrollTop - contConsolaEl.clientHeight < 24;
      contAutoScroll = cerca;
    });
  }

  function textoEncendidoCont(c) {
    if (c.estado !== "running") return "";
    var h = Math.floor((c.encendido_s || 0) / 3600);
    return h > 0 ? "encendida hace " + h + (h === 1 ? " hora" : " horas") : "encendida hace unos minutos";
  }
  function textoEstadoContenedor(c) {
    if (c.mantenimiento && c.mantenimiento.motivo === "detenido") return "Apagado a propósito";
    return c.estado_texto || (c.estado === "running" ? "Funciona" : "Apagado");
  }

  function pintarListaContenedores(id, lista, ajeno, enCurso) {
    var host = $(id);
    if (!host) return;
    if (!lista.length) {
      host.innerHTML = '<li><span class="led" style="background:var(--mute-line)"></span><div><div class="n">' +
        (ajeno ? "No hay contenedores de otro proyecto." : "Sin contenedores propios detectados.") +
        '</div></div><span class="st"></span><span></span></li>';
      return;
    }
    host.innerHTML = lista.map(function (c) {
      var info = infoServicio(c.nombre);
      var enMant = c.mantenimiento && c.mantenimiento.motivo === "detenido";
      var sano = c.estado === "running" && c.salud !== "unhealthy";
      var clase = enMant ? "warn" : (sano ? "" : "crit");
      var reiniciosTotal = (c.reinicios || 0) + (c.reinicios_por_panel || 0);
      var reinicioTxt = reiniciosTotal > 0 ? "se reinició " + reiniciosTotal + (reiniciosTotal === 1 ? " vez" : " veces") + (c.reinicios_por_panel ? " (desde el panel)" : "") : "sin reinicios";
      var memTxt = c.memoria_bytes != null ? "Memoria " + Math.round(c.memoria_bytes / 1048576) + " MB" + (c.memoria_pct_host != null ? " · " + c.memoria_pct_host + "% de la máquina" : "") : "";
      var cpuTxt = c.cpu_pct != null ? (memTxt ? " · " : "") + "Procesador " + c.cpu_pct + "%" : "";
      var deshabilitar = enCurso ? " disabled" : "";
      var acc = c.acciones || {};
      var botones = "";
      if (acc.reiniciar && acc.reiniciar.permitida) {
        botones += '<button class="btn sm' + (acc.reiniciar.confirmacion !== "hoja" ? " danger" : "") + '" data-cont-accion="reiniciar" data-cont-nombre="' + esc(c.nombre) + '"' + deshabilitar + '>Reiniciar</button>';
      }
      if (acc.detener && acc.detener.permitida) {
        botones += '<button class="btn sm danger" data-cont-accion="detener" data-cont-nombre="' + esc(c.nombre) + '"' + deshabilitar + '>Detener</button>';
      }
      if (acc.arrancar && acc.arrancar.permitida) {
        botones += '<button class="btn sm primary" data-cont-accion="arrancar" data-cont-nombre="' + esc(c.nombre) + '"' + deshabilitar + '>Arrancar</button>';
      }
      if (acc.registros && acc.registros.permitida) {
        botones += '<button class="btn sm" data-cont-accion="registros" data-cont-nombre="' + esc(c.nombre) + '"' + deshabilitar + '>Registros</button>';
      }
      botones += '<button class="btn sm ghost" data-cont-accion="ficha" data-cont-nombre="' + esc(c.nombre) + '">Ficha</button>';
      return '<li class="' + clase + '" data-cont="' + esc(c.nombre) + '">' +
        '<span class="led"></span>' +
        '<div><div class="n">' + esc(info.amigable || c.descripcion || c.nombre) + ' <span class="tec">' + esc(c.nombre) + '</span>' +
        (ajeno ? ' <span class="pill mute">Otro proyecto</span>' : '') + '</div>' +
        '<div class="d">' + esc(info.hace || c.descripcion || "") + (textoEncendidoCont(c) ? " · " + textoEncendidoCont(c) : "") + '</div>' +
        (c.estado === "running" && (memTxt || cpuTxt)
          ? '<div class="bar" title="' + esc(memTxt) + '"><i style="width:' + Math.min(100, Math.max(2, c.memoria_pct_host || 2)) + '%"></i></div><div class="note">' + esc((memTxt + cpuTxt) || "") + '</div>'
          : '') +
        '</div>' +
        '<span class="st">' + esc(textoEstadoContenedor(c)) + '<small>' +
        esc(enMant ? ("hasta las " + (c.mantenimiento.hasta ? horaCO(c.mantenimiento.hasta) : "que lo arranques")) : reinicioTxt) + '</small></span>' +
        '<span class="acciones">' + botones + '</span>' +
        '</li>';
    }).join("");
  }

  function pintarOperacionesContenedores(d) {
    var lista = (d && d.ultimas) || [];
    var tb = $("cont-tb-operaciones");
    if (!tb) return;
    tb.innerHTML = lista.length ? lista.map(function (o) {
      var ok = o.resultado === "ok";
      var nombreOp = (o.operacion || "").charAt(0).toUpperCase() + (o.operacion || "").slice(1);
      return "<tr>" +
        '<td data-l="Cuándo">' + esc(fechaHoraCO(o.inicio || o.ts)) + "</td>" +
        '<td data-l="Qué">' + esc(nombreOp) + "</td>" +
        '<td data-l="Servicio">' + esc(amigable(o.contenedor)) + "</td>" +
        '<td data-l="Resultado">' + pill(ok ? "ok" : (o.resultado === "parcial" ? "warn" : "crit"), o.resultado || "—") + "</td>" +
        '<td data-l="Duración" class="num">' + (o.duracion_s != null ? o.duracion_s + " s" : "—") + "</td>" +
        "</tr>";
    }).join("") : '<tr><td colspan="5" class="note">Sin operaciones todavía.</td></tr>';
  }

  function cargarContenedores() {
    apiSafe("/api/contenedores").then(function (d) {
      contListaCache.propios = d.propios || [];
      contListaCache.ajenos = d.ajenos || [];
      pintarListaContenedores("cont-lista-propios", contListaCache.propios, false, d.en_curso);
      pintarListaContenedores("cont-lista-ajenos", contListaCache.ajenos, true, d.en_curso);
      var arriba = contListaCache.propios.filter(function (c) { return c.estado === "running"; }).length;
      $("cont-propios-sub").textContent = arriba + " de " + contListaCache.propios.length + " funcionando";
      if (d.en_curso && !contFuente) {
        abrirConsolaOperacion(d.en_curso.run_id, 0, d.en_curso.operacion, d.en_curso.contenedor);
      }
    }).catch(function () {
      noDisponible("cont-lista-propios", "El módulo de Contenedores todavía no está disponible en el servidor.");
      var elA = $("cont-lista-ajenos");
      if (elA) elA.innerHTML = "";
      $("cont-propios-sub").textContent = "—";
    });
    apiSafe("/api/contenedores/operaciones").then(pintarOperacionesContenedores).catch(function () {
      var tb = $("cont-tb-operaciones");
      if (tb) tb.innerHTML = '<tr><td colspan="5" class="note">El historial de operaciones todavía no está disponible.</td></tr>';
    });
  }

  function abrirFichaContenedor(nombre) {
    apiSafe("/api/contenedores/ficha?nombre=" + encodeURIComponent(nombre)).then(function (f) {
      var card = $("cont-ficha-card");
      card.hidden = false;
      $("cont-ficha-titulo").textContent = amigable(nombre);
      $("cont-ficha-sub").textContent = nombre;
      var up = f.ultima_parada || {};
      var mk = !up.existe ? "ok" : (up.tipo === "inesperado" ? "no" : "ok");
      $("cont-ultima-parada").innerHTML = !up.existe
        ? '<div class="revision"><span class="mk ok">✓</span><div><b>Nunca se ha apagado desde que se creó.</b></div><span></span></div>'
        : '<div class="revision"><span class="mk ' + mk + '">' + (mk === "ok" ? "✓" : "✕") + '</span><div><b>' + esc(up.titulo || "") + '</b><span>' + esc(up.detalle || "") + '</span></div><span>' + esc(up.cuando ? fechaHoraCO(up.cuando) : "") + '</span></div>';
      var horasEncendido = Math.floor((f.encendido_s || 0) / 3600);
      var politicaTxt = ({ "unless-stopped": "Vuelve solo si se cae", "always": "Vuelve solo si se cae", "no": "No vuelve solo", "on-failure": "Vuelve solo si falla" })[f.politica] || (f.politica || "—");
      $("cont-ficha-tiles").innerHTML = [
        tile("Encendido hace", horasEncendido + "<small>h</small>", 60, "", ""),
        tile("Reinicios", String(f.reinicios != null ? f.reinicios : 0), 20, "", "Desde que se creó"),
        tile("Memoria", f.limites && f.limites.memoria_bytes ? Math.round(f.limites.memoria_bytes / 1048576) + "<small>MB</small>" : "—", 40, "", "Límite asignado"),
        tile("Política", politicaTxt, 60, "", "")
      ].join("");
      $("cont-ficha-tb").innerHTML =
        '<tr><td data-l="Imagen">' + esc(f.imagen || "—") + '</td><td data-l="Creado">' + esc(f.creado ? fechaHoraCO(f.creado) : "—") + '</td></tr>' +
        '<tr><td data-l="Redes">' + esc((f.redes || []).join(", ") || "—") + '</td><td data-l="Puertos">' + esc((f.puertos || []).map(function (p) { return p.texto; }).join(" · ") || "—") + '</td></tr>' +
        '<tr><td data-l="Volúmenes" colspan="2">' + esc((f.volumenes || []).map(function (v) { return v.texto; }).join(" · ") || "—") + '</td></tr>';
      $("cont-ultimas-lineas").textContent = up.lineas_disponibles === false ? "No hay registros de antes del último arranque." : (up.ultimas_lineas || []).join("\n");
      card.scrollIntoView({ behavior: "smooth", block: "start" });
    }).catch(function () { aviso("No se pudo abrir la ficha de este servicio."); });
  }
  var contFichaCerrarBtn = $("cont-ficha-cerrar");
  if (contFichaCerrarBtn) contFichaCerrarBtn.addEventListener("click", function () { $("cont-ficha-card").hidden = true; });

  function contLinea(ev) {
    if (!contConsolaEl) return;
    if (ev.seq != null) contUltimoSeq = ev.seq;
    var hora = ev.ts ? horaCO(ev.ts) : "";
    var linea = document.createElement("div");
    linea.style.color = simColor(ev.nivel);
    linea.textContent = (hora ? "[" + hora + "] " : "") + (ev.texto || "");
    contConsolaEl.appendChild(linea);
    if (contAutoScroll) contConsolaEl.scrollTop = contConsolaEl.scrollHeight;
  }
  function pintarPillCont(nivel, texto) {
    var p = $("cont-pill");
    if (!p) return;
    p.className = "pill " + nivel;
    p.innerHTML = '<span class="ic"></span>' + esc(texto);
  }

  function cerrarStreamsContenedores() {
    if (contFuente) { try { contFuente.close(); } catch (e) {} contFuente = null; }
    contModoRegistros = false;
    contRunActivo = null;
    contNombreActivo = null;
    var cerrarBtn = $("cont-consola-cerrar");
    if (cerrarBtn) cerrarBtn.hidden = true;
  }

  function abrirRegistrosContenedor(nombre) {
    var card = $("cont-consola-card");
    if (card) card.scrollIntoView({ behavior: "smooth", block: "start" });
    if (contConsolaEl) contConsolaEl.innerHTML = "";
    $("cont-veredicto").hidden = true;
    $("cont-consola-aviso").hidden = true;
    contModoRegistros = true;
    contNombreActivo = nombre;
    $("cont-consola-sub").textContent = "Registros de " + amigable(nombre) + " · en vivo";
    pintarPillCont("warn", "Escuchando");
    $("cont-consola-cerrar").hidden = false;
    conectarSseRegistros(nombre, 200);
  }
  function conectarSseRegistros(nombre, lineas) {
    if (contFuente) { try { contFuente.close(); } catch (e) {} contFuente = null; }
    if (typeof EventSource === "undefined") { noDisponible("cont-consola", "Este navegador no admite ver los registros en vivo."); return; }
    var url = "/api/contenedores/registros?nombre=" + encodeURIComponent(nombre) + "&lineas=" + lineas;
    var es = new EventSource(url);
    contFuente = es;
    es.addEventListener("paso", function (e) { try { contLinea(JSON.parse(e.data)); } catch (err) {} });
    es.addEventListener("fin", function (e) {
      var ev = null;
      try { ev = JSON.parse(e.data); } catch (err) {}
      if (ev) contLinea(ev);
      try { es.close(); } catch (err2) {}
      contFuente = null;
      pintarPillCont("mute", "Inactivo");
      $("cont-consola-cerrar").hidden = true;
      contModoRegistros = false;
    });
    es.onerror = function () {
      es.close();
      if (contFuente === es) contFuente = null;
      if (contModoRegistros) {
        contLinea({ nivel: "warn", texto: "Se perdió la conexión. Volviendo a intentar…" });
        setTimeout(function () { if (contModoRegistros) conectarSseRegistros(nombre, 50); }, 3000);
      }
    };
  }
  var contConsolaCerrarBtn = $("cont-consola-cerrar");
  if (contConsolaCerrarBtn) contConsolaCerrarBtn.addEventListener("click", function () {
    cerrarStreamsContenedores();
    pintarPillCont("mute", "Inactivo");
    $("cont-consola-sub").textContent = "Nada en curso";
  });

  function abrirConsolaOperacion(runId, desde, operacion, nombre) {
    var card = $("cont-consola-card");
    if (card) card.scrollIntoView({ behavior: "smooth", block: "start" });
    if (contConsolaEl) contConsolaEl.innerHTML = "";
    $("cont-veredicto").hidden = true;
    $("cont-veredicto").innerHTML = "";
    var aviso1 = $("cont-consola-aviso");
    if (nombre === "zeus-proxy") {
      aviso1.hidden = false;
      aviso1.textContent = "La puerta de entrada es por donde entra este panel. Durante unos 10 segundos el panel no responderá y esta consola se quedará muda; se reconecta sola y sigue mostrando lo que pasó. Si en un minuto no vuelve, recarga la página. Te llega un WhatsApp cuando termine.";
    } else aviso1.hidden = true;
    contModoRegistros = false;
    contRunActivo = runId;
    contNombreActivo = nombre;
    pintarPillCont("warn", "En curso");
    var opTxt = operacion ? operacion.charAt(0).toUpperCase() + operacion.slice(1) : "Operación";
    $("cont-consola-sub").textContent = opTxt + " " + amigable(nombre) + " · en curso";
    $("cont-consola-cerrar").hidden = true;
    conectarSseOperacion(runId, desde, nombre);
  }
  function conectarSseOperacion(runId, desde, nombreOp) {
    if (contFuente) { try { contFuente.close(); } catch (e) {} contFuente = null; }
    if (typeof EventSource === "undefined") { noDisponible("cont-consola", "Este navegador no admite ver la operación en vivo."); return; }
    var url = "/api/contenedores/vivo?run=" + encodeURIComponent(runId) + (desde != null ? "&desde=" + desde : "");
    var es = new EventSource(url);
    contFuente = es;
    es.addEventListener("paso", function (e) { try { contLinea(JSON.parse(e.data)); } catch (err) {} });
    es.addEventListener("fin", function (e) {
      var ev = null;
      try { ev = JSON.parse(e.data); } catch (err) {}
      if (ev) contLinea(ev);
      try { es.close(); } catch (err2) {}
      contFuente = null;
      $("cont-consola-aviso").hidden = true;
      var dato = (ev && ev.dato) || {};
      var ok = dato.resultado === "ok" || dato.ok === true;
      pintarPillCont(ok ? "ok" : (dato.resultado === "parcial" ? "warn" : "crit"), ok ? "Listo" : (dato.resultado === "parcial" ? "Parcial" : "Falló"));
      $("cont-consola-sub").textContent = "Nada en curso";
      var vc = $("cont-veredicto");
      vc.hidden = false;
      vc.className = "tarea " + (ok ? "lista" : "fallo");
      vc.innerHTML = "<b>" + (ok ? "Listo" : (dato.resultado === "parcial" ? "Quedó a medias" : "No se pudo completar")) + "</b>" +
        (dato.pasos || []).map(function (p) {
          var pasoOk = p.resultado === "ok" || p.ok === true;
          return '<div class="revision"><span class="mk ' + (pasoOk ? "ok" : "no") + '">' + (pasoOk ? "✓" : "✕") + '</span><div><span>' + esc(amigable(p.contenedor)) + (p.operacion ? " · " + esc(p.operacion) : "") + '</span></div><span>' + (p.segundos != null ? p.segundos + " s" : "") + '</span></div>';
        }).join("");
      contRunActivo = null;
      contNombreActivo = null;
      cargarContenedores();
      cargarRegistro();
      setTimeout(refrescarResumen, 1500);
    });
    es.onerror = function () {
      es.close();
      if (contFuente === es) contFuente = null;
      if (nombreOp === "zeus-proxy" && contRunActivo) {
        contLinea({ nivel: "warn", texto: "Se perdió la conexión con el panel (esperado mientras la puerta de entrada se reinicia). Reintentando…" });
        var aviso2 = $("cont-consola-aviso");
        aviso2.hidden = false;
        aviso2.textContent = "Reconectando…";
      }
      if (contRunActivo) setTimeout(function () { if (contRunActivo) conectarSseOperacion(contRunActivo, contUltimoSeq + 1, nombreOp); }, 3000);
    };
  }

  function abrirModalContenedor(accion, nombre) {
    var lista = contListaCache.propios.concat(contListaCache.ajenos);
    var c = lista.filter(function (x) { return x.nombre === nombre; })[0];
    if (!c) return;
    var cfg = (c.acciones && c.acciones[accion]) || {};
    if (!cfg.permitida) { aviso(cfg.motivo || "Esta acción no está disponible ahora."); return; }
    var ajeno = !c.propio;
    var confirmacion = cfg.confirmacion || "ninguna";

    if (confirmacion === "ninguna") { ejecutarAccionContenedorDirecta(accion, nombre); return; }

    contPendiente = { accion: accion, nombre: nombre, cfg: cfg, ajeno: ajeno };
    var tituloAcc = ({ reiniciar: "reiniciar", detener: "detener", arrancar: "arrancar" })[accion] || accion;
    $("cont-modal-t").textContent = "Vas a " + tituloAcc + " " + amigable(nombre);
    $("cont-modal-desc").textContent = cfg.aviso || infoServicio(nombre).impacto || "";
    $("cont-modal-ajeno").hidden = !ajeno;
    $("cont-modal-datos").innerHTML =
      "<div><span>Tarda</span><span>uno o dos minutos</span></div>" +
      "<div><span>Se avisa por WhatsApp</span><span>" + (nombre === "zeus-proxy" || (accion !== "detener" && ajeno) ? "sí" : "solo si falla") + "</span></div>";

    var ordenWrap = $("cont-orden-wrap");
    if (accion === "reiniciar" && cfg.en_orden_disponible) { ordenWrap.hidden = false; $("cont-orden").checked = false; }
    else ordenWrap.hidden = true;

    $("cont-pin-wrap").hidden = confirmacion !== "palabra_pin";
    $("cont-palabra-wrap").hidden = confirmacion === "hoja";
    $("cont-palabra").textContent = cfg.palabra || (ajeno ? "OTRO-PROYECTO" : nombre);
    contPinInput.value = "";
    contConfInput.value = "";
    $("cont-modal-error").hidden = true;
    contOkBtn.textContent = tituloAcc.charAt(0).toUpperCase() + tituloAcc.slice(1);
    contOkBtn.disabled = confirmacion !== "hoja";
    scrimContenedor.hidden = false;
  }

  function ejecutarAccionContenedorDirecta(accion, nombre) {
    postZeus("/api/contenedores/accion", { accion: accion, nombre: nombre, en_orden: false, confirmacion: "", pin: "" }).then(function (d) {
      if (d && d.ok) abrirConsolaOperacion(d.run_id, 0, accion, nombre);
      else { aviso((d && d.mensaje) || "No se pudo completar la operación."); cargarContenedores(); }
    }).catch(function () { aviso("No hay conexión con el servidor."); cargarContenedores(); });
  }

  function actualizarBotonContenedor() {
    if (!contPendiente) return;
    var confirmacion = contPendiente.cfg.confirmacion || "ninguna";
    if (confirmacion === "hoja") { contOkBtn.disabled = false; return; }
    var palabraOk = contConfInput.value === $("cont-palabra").textContent;
    var pinOk = confirmacion !== "palabra_pin" || !!contPinInput.value;
    contOkBtn.disabled = !(palabraOk && pinOk);
  }
  if (contPinInput) contPinInput.addEventListener("input", actualizarBotonContenedor);
  if (contConfInput) {
    contConfInput.addEventListener("input", actualizarBotonContenedor);
    contConfInput.addEventListener("keydown", function (e) { if (e.key === "Enter" && !contOkBtn.disabled) contOkBtn.click(); });
  }
  function cerrarModalContenedor() {
    scrimContenedor.hidden = true;
    contPendiente = null;
    contPinInput.value = "";
    contConfInput.value = "";
  }
  if ($("cont-cancelar")) $("cont-cancelar").addEventListener("click", cerrarModalContenedor);
  if (scrimContenedor) scrimContenedor.addEventListener("click", function (e) { if (e.target === scrimContenedor) cerrarModalContenedor(); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && scrimContenedor && !scrimContenedor.hidden) cerrarModalContenedor(); });

  function mostrarErrorModalContenedor(msg) {
    var p = $("cont-modal-error");
    p.textContent = msg;
    p.hidden = false;
    contOkBtn.disabled = false;
  }
  if (contOkBtn) contOkBtn.addEventListener("click", function () {
    if (!contPendiente) return;
    var p = contPendiente;
    var enOrden = !$("cont-orden-wrap").hidden && $("cont-orden").checked;
    var pinVal = contPinInput.value;
    var confVal = contConfInput.value;
    contOkBtn.disabled = true;
    $("cont-modal-error").hidden = true;
    postZeus("/api/contenedores/accion", { accion: p.accion, nombre: p.nombre, en_orden: enOrden, confirmacion: confVal, pin: pinVal }).then(function (d) {
      if (d && d.ok) {
        cerrarModalContenedor();
        abrirConsolaOperacion(d.run_id, 0, p.accion, p.nombre);
      } else {
        mostrarErrorModalContenedor((d && d.mensaje) || "No se pudo completar la operación.");
      }
    }).catch(function () { mostrarErrorModalContenedor("No hay conexión con el servidor."); });
  });

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      if (contModoRegistros) contVisTimer = setTimeout(function () { cerrarStreamsContenedores(); }, 120000);
    } else if (contVisTimer) { clearTimeout(contVisTimer); contVisTimer = null; }
  });

  /* =========================================================================
     Delegación de clics de SOS / Registros / Contenedores (listener aparte
     para no tocar el manejador de clics ya existente y probado en producción).
     ========================================================================= */
  document.addEventListener("click", function (e) {
    var desbloquearBtn = e.target.closest("[data-desbloquear]");
    if (desbloquearBtn) {
      var accionDesbloq = desbloquearBtn.dataset.desbloquear;
      abrirConfirmar("PERMITIR", "Vas a volver a permitir \"" + (NOMBRES_LIMITE_SOS[accionDesbloq] || accionDesbloq) + "\" antes de que termine su tiempo de espera normal.", function () {
        postZeus("/api/sos/desbloquear", { accion: accionDesbloq, confirmacion: "PERMITIR" }).then(function (d) {
          if (d && d.ok) { aviso("Vuelto a permitir."); cargarSos(); }
          else aviso((d && d.mensaje) || "No se pudo desbloquear.");
        }).catch(function () { aviso("No hay conexión con el servidor."); });
      });
      return;
    }

    var evVerBtn = e.target.closest("[data-evidencia-ver]");
    if (evVerBtn) { abrirDetalleEvidencia(evVerBtn.dataset.evidenciaVer); return; }

    var corVerBtn = e.target.closest("[data-corrida-ver]");
    if (corVerBtn) { abrirDetalleCorrida(corVerBtn.dataset.corridaVer); return; }

    var contBtn = e.target.closest("[data-cont-accion]");
    if (contBtn && !contBtn.disabled) {
      var caccion = contBtn.dataset.contAccion;
      var cnombre = contBtn.dataset.contNombre;
      if (caccion === "ficha") { abrirFichaContenedor(cnombre); return; }
      if (caccion === "registros") { abrirRegistrosContenedor(cnombre); return; }
      abrirModalContenedor(caccion, cnombre);
      return;
    }
  });

  /* ---------- arranque ---------- */
  function cargarPanoramaSerie() {
    api("/api/series?rango=24h").then(function (s) {
      panoramaSerie.cpu = (s.cpu || []).map(function (p) { return p[1]; });
      panoramaSerie.ram = (s.ram || []).map(function (p) { return p[1]; });
      if (ultimoOk && !ultimoOk.sinConexion) pintarPanorama(ultimoOk.d);
    }).catch(function () {});
  }
  refrescarResumen();
  cargarPanoramaSerie();
  setInterval(cargarPanoramaSerie, 300000);
  var vistaInicial = vistaDeRuta(location.pathname);
  if (vistaInicial !== "inicio") ir(vistaInicial, true);
  else cargarSeccion("inicio");
  setInterval(refrescarResumen, 30000);
  setInterval(function () { apiSafe("/api/sos").then(function (d) { marcarBadgeSos(!!d.en_curso); }).catch(function () {}); }, 30000);
  setInterval(function () {
    var activa = document.querySelector("[data-view]:not([hidden])");
    if (activa) cargarSeccion(activa.dataset.view, true);
  }, 120000);
  setInterval(function () {
    if (ultimoOk && !document.querySelector("[data-view=\"inicio\"]").hidden) {
      $("sello").textContent = ultimoOk.sinConexion ? $("sello").textContent : "Revisado " + textoRevisadoHace();
    }
  }, 1000);
})();
