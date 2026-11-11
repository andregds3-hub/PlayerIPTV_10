/* ==========================================================================
   PlayerIPTV (VPS) — loader.js
   Baixa da VPS a versão atual do PlayerIPTV e a executa dentro deste app:
     1. index.html  -> só a marcação do <body> (os <script> são descartados)
     2. style.css   -> estilos
     3. lib/hls.min.js (opcional) e app.js -> scripts, nessa ordem
   Como tudo roda na origem do app instalado, valem as permissões do
   config.xml (teclas de mídia, acesso de rede sem CORS).
   ES5 puro com callbacks e XMLHttpRequest: roda nas TVs Tizen 2.4 (2016)
   em diante, que não têm fetch nem Promise garantidos.
   ========================================================================== */
(function () {
  'use strict';

  // Onde o PlayerIPTV está hospedado (container Docker na VPS)
  var BASE_URL = 'http://109.199.107.136:90';
  var TIMEOUT = 15000;

  var LOADER_HTML =
    '<div id="loader">' +
      '<div class="loader-logo">PLAYER<span>IPTV</span></div>' +
      '<div class="loader-spinner" id="loaderSpinner"></div>' +
      '<p class="loader-msg" id="loaderMsg"></p>' +
      '<p class="loader-hint hidden" id="loaderHint">OK para tentar novamente • VOLTAR para sair</p>' +
    '</div>';

  var state = 'loading';   // loading | error | done

  // Evita cache: sempre a versão mais recente da VPS
  function remote(path) {
    return BASE_URL + path + '?v=' + Date.now();
  }

  // GET de texto: callback(erro, texto)
  function getText(url, callback) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.timeout = TIMEOUT;
    xhr.onload = function () {
      if (xhr.status >= 200 && xhr.status < 300) callback(null, xhr.responseText);
      else callback('O servidor respondeu com erro HTTP ' + xhr.status + '.');
    };
    xhr.onerror = function () {
      callback('Servidor inacessível. Verifique a internet e se a porta 90 da VPS está liberada.');
    };
    xhr.ontimeout = function () { callback('O servidor não respondeu a tempo.'); };
    xhr.send();
  }

  // Insere <link> ou <script> e avisa quando carregar: callback(erro)
  function loadTag(tag, attrs, parent, callback) {
    var el = document.createElement(tag);
    Object.keys(attrs).forEach(function (k) { el.setAttribute(k, attrs[k]); });
    el.onload = function () { callback(null); };
    el.onerror = function () {
      callback('Falha ao baixar ' + (attrs.src || attrs.href).split('?')[0] + '.');
    };
    parent.appendChild(el);
  }

  // Extrai o conteúdo do <body> do index.html remoto, sem os <script>
  function extractBody(html) {
    var match = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
    var body = match ? match[1] : html;
    return body.replace(/<script[\s\S]*?<\/script>/gi, '');
  }

  function render(message, isError) {
    document.body.innerHTML = LOADER_HTML;
    document.getElementById('loaderMsg').textContent = message;
    document.getElementById('loaderSpinner').className = 'loader-spinner' + (isError ? ' hidden' : '');
    document.getElementById('loaderHint').className = 'loader-hint' + (isError ? '' : ' hidden');
  }

  function showError(detail) {
    state = 'error';
    document.addEventListener('keydown', onKey, true);
    render('Não foi possível carregar o PlayerIPTV de ' + BASE_URL + '. ' + detail, true);
  }

  // hls.js usa JavaScript moderno: em TVs antigas (sem ES6) nem é baixado
  function loadHls(callback) {
    if (typeof window.Symbol === 'undefined') { callback(null); return; }
    loadTag('script', { src: remote('/lib/hls.min.js') }, document.body, function () { callback(null); });
  }

  function start() {
    state = 'loading';
    render('Carregando o aplicativo…', false);

    // Remove o CSS de uma tentativa anterior
    var oldCss = document.getElementById('remoteCss');
    if (oldCss) oldCss.parentNode.removeChild(oldCss);

    getText(remote('/index.html'), function (err, html) {
      if (err) { showError(err); return; }
      var markup = extractBody(html);

      loadTag('link', { id: 'remoteCss', rel: 'stylesheet', href: remote('/style.css') }, document.head, function (cssErr) {
        if (cssErr) { showError(cssErr); return; }
        document.body.innerHTML = markup;

        // hls.js é opcional: sem ele (ou se a TV não o suportar) o app usa o player nativo
        loadHls(function () {
          state = 'done';
          document.removeEventListener('keydown', onKey, true);
          // O app.js inicia sozinho ao ser executado (o DOM já está pronto)
          loadTag('script', { src: remote('/app.js') }, document.body, function (jsErr) {
            if (jsErr) showError(jsErr);
          });
        });
      });
    });
  }

  function exit() {
    try { window.tizen.application.getCurrentApplication().exit(); } catch (e) { window.close(); }
  }

  // Teclas só enquanto o loader está na tela; depois o app assume
  function onKey(e) {
    if (state === 'done') return;
    if (e.keyCode === 10009 || e.keyCode === 27) {
      e.preventDefault();
      exit();
    } else if (e.keyCode === 13 && state === 'error') {
      e.preventDefault();
      start();
    }
  }

  document.addEventListener('keydown', onKey, true);
  start();
})();
