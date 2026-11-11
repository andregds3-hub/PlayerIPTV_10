/* ==========================================================================
   PlayerIPTV — app.js
   Aplicativo IPTV (API Xtream Codes) para Samsung Smart TV (Tizen Web App).

   Compatibilidade: ES5 puro (sem =>, const/let, classes, template strings
   ou fetch) para rodar no motor WebKit das TVs Tizen 2.4 (modelos 2016) e
   em todas as mais novas. Promise e Element.closest têm polyfill abaixo.

   Módulos deste arquivo:
     0. Polyfills                7. Componentes de UI (Toast, Dialog, Splash,
     1. Configuração                Login, Sidebar, Hero, Cards, Prateleiras,
     2. Utilitários                 Detalhes, Configurações)
     3. API Xtream Codes         8. Player de vídeo (hls.js + player nativo)
     4. Modelos de dados         9. Aplicação (páginas, teclas, inicialização)
     5. Navegação espacial
     6. Teclas / APIs da TV
   ========================================================================== */
(function () {
  'use strict';

  /* ======================================================================
     0. POLYFILLS (só entram se a TV não tiver o recurso)
     ====================================================================== */
  if (!Element.prototype.matches) {
    Element.prototype.matches = Element.prototype.webkitMatchesSelector || Element.prototype.msMatchesSelector;
  }
  if (!Element.prototype.closest) {
    Element.prototype.closest = function (selector) {
      var el = this;
      while (el && el.nodeType === 1) {
        if (el.matches(selector)) return el;
        el = el.parentNode;
      }
      return null;
    };
  }

  // Promise mínima (then/catch/resolve/reject/all), suficiente para este app
  if (typeof window.Promise !== 'function') {
    window.Promise = (function () {
      function P(executor) {
        var self = this;
        self._state = 0;          // 0 pendente, 1 resolvida, 2 rejeitada
        self._value = undefined;
        self._handlers = [];
        var done = false;

        function settle(state, value) {
          if (done) return;
          if (state === 1 && value && (typeof value === 'object' || typeof value === 'function')) {
            var then;
            try { then = value.then; } catch (e) { done = true; finish(2, e); return; }
            if (typeof then === 'function') {
              done = true;
              var called = false;
              try {
                then.call(value,
                  function (v) { if (!called) { called = true; done = false; settle(1, v); } },
                  function (r) { if (!called) { called = true; finish(2, r); } });
              } catch (e) { if (!called) { called = true; finish(2, e); } }
              return;
            }
          }
          done = true;
          finish(state, value);
        }

        function finish(state, value) {
          self._state = state;
          self._value = value;
          setTimeout(function () {
            var list = self._handlers;
            self._handlers = [];
            for (var i = 0; i < list.length; i++) list[i]();
          }, 0);
        }

        try {
          executor(function (v) { settle(1, v); }, function (r) { settle(2, r); });
        } catch (e) { settle(2, e); }
      }

      P.prototype.then = function (onFulfilled, onRejected) {
        var self = this;
        return new P(function (resolve, reject) {
          function run() {
            var cb = self._state === 1 ? onFulfilled : onRejected;
            if (typeof cb !== 'function') {
              if (self._state === 1) resolve(self._value); else reject(self._value);
              return;
            }
            try { resolve(cb(self._value)); } catch (e) { reject(e); }
          }
          if (self._state) setTimeout(run, 0); else self._handlers.push(run);
        });
      };
      P.prototype['catch'] = function (onRejected) { return this.then(null, onRejected); };
      P.resolve = function (v) { return new P(function (resolve) { resolve(v); }); };
      P.reject = function (r) { return new P(function (resolve, reject) { reject(r); }); };
      P.all = function (list) {
        return new P(function (resolve, reject) {
          var out = [], left = list.length;
          if (!left) { resolve(out); return; }
          list.forEach(function (p, i) {
            P.resolve(p).then(function (v) {
              out[i] = v;
              left--;
              if (left === 0) resolve(out);
            }, reject);
          });
        });
      };
      return P;
    })();
  }

  /* ======================================================================
     1. CONFIGURAÇÃO
     ====================================================================== */
  var CONFIG = {
    // Servidor, usuário e senha são informados na tela de login (State.account)
    requestTimeout: 25000,       // ms — listas grandes podem demorar
    maxConcurrentRequests: 3,    // requisições simultâneas (TVs têm CPU/rede limitadas)
    maxItemsPerRow: 60,          // cards renderizados por prateleira (protege a memória)
    rowsPreload: 2,              // prateleiras abaixo da atual a pré-carregar
    eagerImages: 8,              // capas carregadas de imediato em cada prateleira
    homeRows: { vod: 5, series: 3, live: 2 },
    heroDebounce: 350,           // atraso para atualizar o banner ao navegar
    osdTimeout: 4500,            // tempo até esconder os controles do player
    seekStep: 10,                // segundos por toque em ◀ ▶
    zapDelay: 500,               // atraso para trocar de canal (zapping rápido)
    apiCacheSize: 60,            // respostas da API mantidas em memória
    baseWidth: 1920,             // resolução de projeto
    baseHeight: 1080
  };

  /* ======================================================================
     2. UTILITÁRIOS
     ====================================================================== */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  var HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  // Escapa texto vindo da API antes de inserir em innerHTML
  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) { return HTML_ESCAPES[c]; });
  }

  function debounce(fn, wait) {
    var timer = null;
    return function () {
      var args = arguments, ctx = this;
      clearTimeout(timer);
      timer = setTimeout(function () { fn.apply(ctx, args); }, wait);
    };
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  // 3725 -> "1:02:05"
  function formatTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    sec = Math.floor(sec);
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return (h ? h + ':' + pad2(m) : m) + ':' + pad2(s);
  }

  // Timestamp Unix (segundos) -> "HH:MM"
  function formatClock(ts) {
    if (!isFinite(ts) || !ts) return '';
    var d = new Date(ts * 1000);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function formatDate(ms) {
    var d = new Date(ms);
    return pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1) + '/' + d.getFullYear();
  }

  // "01:52:00" -> "1h 52min" (outros formatos são mantidos)
  function formatDuration(value) {
    var str = String(value || '').trim();
    var m = str.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (!m) return str;
    var h = parseInt(m[1], 10), min = parseInt(m[2], 10);
    if (!h && !min) return '';
    return (h ? h + 'h ' : '') + min + 'min';
  }

  // A EPG do Xtream vem em Base64 (UTF-8)
  function decodeBase64(str) {
    if (!str) return '';
    try { return decodeURIComponent(escape(atob(str))); } catch (e) {
      try { return atob(str); } catch (e2) { return str; }
    }
  }

  function safeDecode(value) {
    try { return decodeURIComponent(value); } catch (e) { return value; }
  }

  // A API às vezes devolve objeto no lugar de array
  function toList(data) {
    if (!data) return [];
    if (Array.isArray(data)) return data;
    if (typeof data === 'object') return Object.keys(data).map(function (k) { return data[k]; });
    return [];
  }

  function firstOf(value) {
    if (Array.isArray(value)) return value[0] || '';
    return value || '';
  }

  function extractYear(value) {
    var m = String(value || '').match(/\b(19|20)\d{2}\b/);
    return m ? m[0] : '';
  }

  // Normaliza a nota para escala 0–10
  function parseRating(rating, rating5) {
    var n = parseFloat(rating);
    if (!(n > 0)) {
      var n5 = parseFloat(rating5);
      n = n5 > 0 ? n5 * 2 : 0;
    }
    if (n > 10) n = n / 10;
    return n > 0 ? n.toFixed(1) : '';
  }

  function cssUrl(url) {
    return 'url("' + String(url).replace(/["\\\n\r]/g, encodeURIComponent) + '")';
  }

  // classList.toggle(nome, força) não é confiável no WebKit antigo
  function toggleClass(el, name, on) {
    if (on) el.classList.add(name); else el.classList.remove(name);
  }

  // Aplica transform com e sem prefixo (WebKit antigo usa -webkit-)
  function setTransform(el, value) {
    el.style.webkitTransform = value;
    el.style.transform = value;
  }

  // Persistência simples (preferências, conta e progresso de reprodução)
  function same(x) { return x; }

  // Normaliza texto para a busca: minúsculas e sem acentos
  var ACCENT_FROM = 'àáâãäåçèéêëìíîïñòóôõöùúûü';
  var ACCENT_TO = 'aaaaaaceeeeiiiinooooouuuu';
  function normalizeText(value) {
    var s = String(value || '').toLowerCase(), out = '';
    for (var i = 0; i < s.length; i++) {
      var j = ACCENT_FROM.indexOf(s.charAt(i));
      out += j >= 0 ? ACCENT_TO.charAt(j) : s.charAt(i);
    }
    return out;
  }

  var Storage = {
    get: function (key, fallback) {
      try {
        var v = localStorage.getItem('iptv.' + key);
        return v === null ? fallback : JSON.parse(v);
      } catch (e) { return fallback; }
    },
    set: function (key, value) {
      try { localStorage.setItem('iptv.' + key, JSON.stringify(value)); } catch (e) { /* cota cheia */ }
    }
  };

  // Modo leve automático: TVs Tizen 2.x/3.0 (2016–2017) ou motor sem ES6
  function detectLite() {
    var m = (navigator.userAgent || '').match(/Tizen\s*(\d+)\.(\d+)/i);
    if (m) return parseFloat(m[1] + '.' + m[2]) < 4;
    return typeof window.Symbol === 'undefined';
  }

  // Pede ao TMDB a imagem no tamanho de exibição (evita baixar e reduzir o original na TV)
  function tmdbSize(url, size) {
    if (!url || url.indexOf('image.tmdb.org/t/p/') < 0) return url;
    return url.replace(/\/t\/p\/[^\/]+\//, '/t/p/' + size + '/');
  }

  /* ======================================================================
     3. API XTREAM CODES
     ====================================================================== */
  var API = {
    cache: {},
    cacheKeys: [],   // ordem de inserção, para descartar as respostas mais antigas
    queue: [],
    active: 0,

    // Monta a URL: {servidor}/player_api.php?username=...&password=...&action=...
    url: function (params) {
      var acc = State.account;
      var q = [
        'username=' + encodeURIComponent(acc.username),
        'password=' + encodeURIComponent(acc.password)
      ];
      Object.keys(params || {}).forEach(function (k) {
        q.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
      });
      return acc.server + '/player_api.php?' + q.join('&');
    },

    // Fila com limite de concorrência para não sobrecarregar a TV
    schedule: function (task) {
      return new Promise(function (resolve, reject) {
        API.queue.push({ task: task, resolve: resolve, reject: reject });
        API.next();
      });
    },

    next: function () {
      if (API.active >= CONFIG.maxConcurrentRequests || !API.queue.length) return;
      var job = API.queue.shift();
      API.active++;
      job.task()
        .then(job.resolve, job.reject)
        .then(function () { API.active--; API.next(); });
    },

    // GET com timeout e parse de JSON (XMLHttpRequest: fetch não existe nas TVs 2016)
    fetchJson: function (url, timeout) {
      return new Promise(function (resolve, reject) {
        var server = State.account ? State.account.server : '';
        var xhr = new XMLHttpRequest();
        xhr.open('GET', url, true);
        xhr.timeout = timeout || CONFIG.requestTimeout;
        xhr.onload = function () {
          if (xhr.status === 404) {
            reject(new Error('O endereço ' + server + ' não respondeu como um servidor Xtream (HTTP 404). ' +
              'Confira a URL e a porta informadas pelo provedor (ex.: http://dominio:8080).'));
            return;
          }
          if (xhr.status < 200 || xhr.status >= 300) {
            reject(new Error('O servidor respondeu com erro HTTP ' + xhr.status + '.'));
            return;
          }
          var data;
          try { data = JSON.parse(xhr.responseText); } catch (e) {
            reject(new Error('Resposta inválida do servidor.'));
            return;
          }
          resolve(data);
        };
        // Rede indisponível, servidor fora do ar ou bloqueio de acesso
        xhr.onerror = function () {
          reject(new Error('Falha de rede ao acessar ' + server +
            '. Verifique a URL/porta, a conexão com a internet e se o servidor está no ar.'));
        };
        xhr.ontimeout = function () {
          reject(new Error('O servidor demorou demais para responder.'));
        };
        xhr.send();
      });
    },

    // Requisição com cache em memória (e deduplicação de chamadas iguais)
    get: function (params) {
      var key = JSON.stringify(params);
      if (API.cache[key]) return API.cache[key];
      var p = API.schedule(function () { return API.fetchJson(API.url(params)); });
      API.cache[key] = p;
      API.cacheKeys.push(key);
      // Limita a memória: listas grandes antigas saem do cache
      while (API.cacheKeys.length > CONFIG.apiCacheSize) delete API.cache[API.cacheKeys.shift()];
      p['catch'](function () { delete API.cache[key]; });
      return p;
    },

    clearCache: function () { API.cache = {}; API.cacheKeys = []; },

    // Valida o acesso: retorna { user_info, server_info }
    login: function () { return API.fetchJson(API.url({})); },

    getVodCategories: function () { return API.get({ action: 'get_vod_categories' }).then(toList); },
    getVodStreams: function (categoryId) { return API.get({ action: 'get_vod_streams', category_id: categoryId }).then(toList); },
    getVodInfo: function (vodId) { return API.get({ action: 'get_vod_info', vod_id: vodId }); },

    getSeriesCategories: function () { return API.get({ action: 'get_series_categories' }).then(toList); },
    getSeries: function (categoryId) { return API.get({ action: 'get_series', category_id: categoryId }).then(toList); },
    getSeriesInfo: function (seriesId) { return API.get({ action: 'get_series_info', series_id: seriesId }); },

    getLiveCategories: function () { return API.get({ action: 'get_live_categories' }).then(toList); },
    getLiveStreams: function (categoryId) { return API.get({ action: 'get_live_streams', category_id: categoryId }).then(toList); },

    // EPG muda com o tempo: sem cache
    getShortEpg: function (streamId) {
      return API.schedule(function () {
        return API.fetchJson(API.url({ action: 'get_short_epg', stream_id: streamId, limit: 3 }));
      });
    },

    // URLs de reprodução no padrão Xtream Codes
    credentialsPath: function () {
      return encodeURIComponent(State.account.username) + '/' + encodeURIComponent(State.account.password);
    },
    liveUrl: function (streamId) {
      return State.account.server + '/live/' + API.credentialsPath() + '/' + streamId + '.' + State.liveFormat;
    },
    movieUrl: function (streamId, ext) {
      return State.account.server + '/movie/' + API.credentialsPath() + '/' + streamId + '.' + (ext || 'mp4');
    },
    episodeUrl: function (episodeId, ext) {
      return State.account.server + '/series/' + API.credentialsPath() + '/' + episodeId + '.' + (ext || 'mp4');
    }
  };

  /* ======================================================================
     4. MODELOS DE DADOS (normalizam as respostas da API)
     ====================================================================== */
  var KIND_LABEL = { vod: 'Filme', series: 'Série', live: 'Ao vivo' };
  var STATUS_LABEL = { Active: 'Ativa', Expired: 'Expirada', Banned: 'Bloqueada', Disabled: 'Desativada' };

  function infoOf(data) {
    var info = data && data.info;
    return info && typeof info === 'object' && !Array.isArray(info) ? info : {};
  }

  var Model = {
    vod: function (raw) {
      return {
        kind: 'vod',
        id: raw.stream_id,
        name: raw.name || 'Sem título',
        poster: raw.stream_icon || '',
        backdrop: '',
        rating: parseRating(raw.rating, raw.rating_5based),
        year: extractYear(raw.year || raw.releaseDate || raw.name),
        plot: raw.plot || '',
        genre: raw.genre || '',
        ext: raw.container_extension || 'mp4',
        enriched: false
      };
    },

    series: function (raw) {
      return {
        kind: 'series',
        id: raw.series_id,
        name: raw.name || 'Sem título',
        poster: raw.cover || '',
        backdrop: firstOf(raw.backdrop_path),
        rating: parseRating(raw.rating, raw.rating_5based),
        year: extractYear(raw.releaseDate || raw.release_date || raw.year || raw.name),
        plot: raw.plot || '',
        genre: raw.genre || '',
        cast: raw.cast || '',
        director: raw.director || ''
      };
    },

    live: function (raw) {
      return {
        kind: 'live',
        id: raw.stream_id,
        name: raw.name || 'Canal',
        poster: raw.stream_icon || '',
        epg: null
      };
    },

    // Completa um filme com get_vod_info (sinopse, elenco, backdrop...)
    enrichVod: function (item, data) {
      var info = infoOf(data);
      item.plot = info.plot || info.description || item.plot;
      item.genre = info.genre || item.genre;
      item.cast = info.cast || info.actors || item.cast || '';
      item.director = info.director || item.director || '';
      item.duration = info.duration || item.duration || '';
      item.year = extractYear(info.releasedate || info.release_date || info.year) || item.year;
      item.rating = parseRating(info.rating) || item.rating;
      var backdrop = firstOf(info.backdrop_path);
      if (backdrop) item.backdrop = backdrop;
      if (!item.poster) item.poster = info.movie_image || info.cover_big || '';
      var movie = data && data.movie_data;
      if (movie && movie.container_extension) item.ext = movie.container_extension;
      item.enriched = true;
    },

    enrichSeries: function (item, data) {
      var info = infoOf(data);
      item.plot = info.plot || item.plot;
      item.genre = info.genre || item.genre;
      item.cast = info.cast || item.cast;
      item.director = info.director || item.director;
      item.rating = parseRating(info.rating, info.rating_5based) || item.rating;
      item.year = extractYear(info.releaseDate || info.release_date) || item.year;
      var backdrop = firstOf(info.backdrop_path);
      if (backdrop) item.backdrop = backdrop;
      if (!item.poster) item.poster = info.cover || '';
    },

    episode: function (raw, season) {
      var info = infoOf(raw);
      var num = parseInt(raw.episode_num, 10) || 0;
      return {
        id: raw.id,
        season: parseInt(raw.season, 10) || season,
        num: num,
        title: raw.title || ('Episódio ' + num),
        ext: raw.container_extension || 'mp4',
        plot: info.plot || '',
        duration: info.duration || '',
        image: info.movie_image || info.cover_big || ''
      };
    },

    // get_series_info -> [{ number, episodes: [...] }] ordenado
    seasons: function (data) {
      var eps = data && data.episodes;
      if (!eps) return [];
      var groups = {};
      function add(key, list) {
        var n = parseInt(key, 10) || 0;
        groups[n] = (groups[n] || []).concat(list);
      }
      if (Array.isArray(eps)) {
        // Alguns servidores devolvem array de arrays
        eps.forEach(function (list, i) {
          toList(Array.isArray(list) ? list : [list]).forEach(function (ep) {
            add(ep && ep.season ? ep.season : i + 1, [ep]);
          });
        });
      } else {
        Object.keys(eps).forEach(function (k) { add(k, toList(eps[k])); });
      }
      return Object.keys(groups)
        .map(function (k) { return parseInt(k, 10); })
        .sort(function (a, b) { return a - b; })
        .map(function (n) {
          return {
            number: n,
            episodes: groups[n].filter(Boolean)
              .map(function (ep) { return Model.episode(ep, n); })
              .sort(function (a, b) { return a.num - b.num; })
          };
        })
        .filter(function (s) { return s.episodes.length > 0; });
    },

    // get_short_epg -> [{ title, start, end }] (só programas atuais/futuros)
    epg: function (data) {
      var now = Date.now() / 1000;
      return toList(data && data.epg_listings)
        .map(function (e) {
          return {
            title: decodeBase64(e.title),
            start: parseInt(e.start_timestamp, 10) || Date.parse(e.start) / 1000,
            end: parseInt(e.stop_timestamp, 10) || Date.parse(e.end || e.stop) / 1000
          };
        })
        .filter(function (e) { return e.title && (!isFinite(e.end) || e.end > now); })
        .slice(0, 2);
    }
  };

  // Linha de metadados (nota, ano, duração, gênero)
  function buildMeta(item) {
    var parts = [];
    if (item.kind === 'live') parts.push('<span class="badge badge--live">● AO VIVO</span>');
    if (item.rating) parts.push('<span class="rating">★ ' + esc(item.rating) + '</span>');
    if (item.year) parts.push('<span>' + esc(item.year) + '</span>');
    if (item.duration) parts.push('<span>' + esc(formatDuration(item.duration)) + '</span>');
    if (item.genre) {
      var genres = String(item.genre).split(/[,\/|]/)
        .map(function (g) { return g.trim(); })
        .filter(Boolean)
        .slice(0, 3);
      if (genres.length) parts.push('<span>' + esc(genres.join(' • ')) + '</span>');
    }
    return parts.join('');
  }

  function epgHtml(epg) {
    if (!epg) return 'Carregando programação…';
    if (!epg.length) return 'Programação indisponível para este canal.';
    var now = epg[0], next = epg[1];
    var html = '<strong>Agora:</strong> ' + esc(now.title) +
      '<span class="epg-time">' + formatClock(now.start) + (now.end ? ' – ' + formatClock(now.end) : '') + '</span>';
    if (next) {
      html += '<br><strong>A seguir:</strong> ' + esc(next.title) +
        '<span class="epg-time">' + formatClock(next.start) + '</span>';
    }
    return html;
  }

  /* ======================================================================
     5. NAVEGAÇÃO ESPACIAL (controle remoto)
     ----------------------------------------------------------------------
     Modelo em "linhas": cada .nav-row é uma linha horizontal de itens
     .focusable. ◀ ▶ andam dentro da linha; ▲ ▼ trocam de linha.
     Prateleiras ([data-remember]) lembram o último card focado (como na
     Netflix); as demais linhas escolhem o item mais próximo na horizontal.
     O "escopo" define qual área recebe as teclas: login, content, sidebar,
     details, dialog, player ou splash.
     ====================================================================== */
  var Nav = {
    scope: 'splash',
    current: null,
    lastContent: null,
    stack: [],      // escopos sobrepostos (detalhes, diálogo, player)
    roots: { login: 'login', content: 'main', sidebar: 'sidebar', grid: 'grid', details: 'details', dialog: 'dialog', player: 'player' },

    root: function () { return document.getElementById(Nav.roots[Nav.scope]) || document.body; },

    isFocusable: function (el) {
      return !!el && el.classList.contains('focusable') && el.getClientRects().length > 0;
    },

    rows: function (root) {
      return $$('.nav-row', root || Nav.root()).filter(function (r) {
        return r.getClientRects().length > 0 && !!r.querySelector('.focusable');
      });
    },

    items: function (row) {
      return row ? $$('.focusable', row).filter(Nav.isFocusable) : [];
    },

    focus: function (el) {
      if (!el) return;
      if (Nav.current && Nav.current !== el) Nav.current.classList.remove('focused');
      Nav.current = el;
      el.classList.add('focused');
      // preventScroll não existe nas TVs antigas: a rolagem nativa é desfeita em Scroller.fix
      try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); }
      Scroller.fix(el);

      var row = el.closest('.nav-row');
      if (row) row._last = Array.prototype.indexOf.call(row.querySelectorAll('.focusable'), el);

      Scroller.reveal(el);
      if (Nav.scope === 'content') Nav.lastContent = el;
      if (typeof el._onFocus === 'function') el._onFocus(el);
    },

    focusFirst: function () {
      var rows = Nav.rows();
      if (rows.length) Nav.focus(Nav.items(rows[0])[0]);
    },

    move: function (dir) {
      if (Nav.scope === 'sidebar') { Sidebar.move(dir); return; }
      var root = Nav.root();
      var cur = Nav.current && root.contains(Nav.current) ? Nav.current : null;
      if (!cur) { Nav.focusFirst(); return; }

      var row = cur.closest('.nav-row');
      if (dir === 'left' || dir === 'right') {
        var items = Nav.items(row);
        var next = items[items.indexOf(cur) + (dir === 'left' ? -1 : 1)];
        if (next) Nav.focus(next); else Nav.edge(dir);
        return;
      }

      var rows = Nav.rows(root);
      var target = rows[rows.indexOf(row) + (dir === 'up' ? -1 : 1)];
      if (target) Nav.focus(Nav.pickInRow(target, cur)); else Nav.edge(dir);
    },

    // Escolhe o item de destino ao trocar de linha
    pickInRow: function (row, from) {
      var items = Nav.items(row);
      if (!items.length) return null;
      if (row.hasAttribute('data-remember')) {
        var last = row._last || 0;
        return items[Math.min(last, items.length - 1)];
      }
      var fr = from.getBoundingClientRect();
      var cx = fr.left + fr.width / 2;
      var best = items[0], bestDist = Infinity;
      items.forEach(function (el) {
        var r = el.getBoundingClientRect();
        var d = Math.abs(r.left + r.width / 2 - cx);
        if (d < bestDist) { bestDist = d; best = el; }
      });
      return best;
    },

    // Chegou na borda: ◀ no primeiro item do conteúdo abre o menu lateral
    edge: function (dir) {
      if (Nav.scope === 'content' && dir === 'left') Sidebar.open();
    },

    select: function () {
      var el = Nav.current;
      if (el && typeof el._onSelect === 'function') el._onSelect(el);
    },

    openOverlay: function (scope, el) {
      Nav.stack.push({ scope: Nav.scope, focus: Nav.current });
      Nav.scope = scope;
      if (el) Nav.focus(el);
    },

    closeOverlay: function () {
      var prev = Nav.stack.pop();
      if (!prev) return;
      Nav.scope = prev.scope;
      if (prev.focus && document.body.contains(prev.focus)) Nav.focus(prev.focus);
      else if (Nav.scope === 'content') Nav.focusFirst();
    },

    reset: function (scope) {
      Nav.stack = [];
      Nav.scope = scope;
    }
  };

  /* Rolagem controlada por transform (mais fluida que scroll nativo na TV) */
  var Scroller = {
    // Desfaz a rolagem que o navegador aplica sozinho ao focar elementos
    fix: function (el) {
      var node = el.parentNode;
      while (node && node.nodeType === 1) {
        // No modo leve a rolagem das prateleiras é por scroll (.scroll-managed): não desfaz
        var managed = State.lite && node.classList.contains('scroll-managed');
        if (node.scrollLeft && !managed) node.scrollLeft = 0;
        if (node.scrollTop && !managed && !node.classList.contains('scroll-y')) node.scrollTop = 0;
        node = node.parentNode;
      }
      if (window.pageXOffset || window.pageYOffset) window.scrollTo(0, 0);
    },

    reveal: function (el) {
      var track = el.closest('.row-track');
      if (track) Scroller.horizontal(track, el);
      var box = el.closest('.scroll-y');
      if (box) Scroller.ensureVisibleY(box, el);
      if (Nav.scope === 'content' && $('#main').contains(el)) Scroller.vertical(el);
    },

    // Mantém o card focado na primeira posição visível da prateleira
    horizontal: function (track, el) {
      var cards = track.children;
      if (!cards.length) return;
      var viewportW = track.parentNode.clientWidth;
      var first = cards[0], last = cards[cards.length - 1];
      var maxOffset = Math.max(0, last.offsetLeft + last.offsetWidth - viewportW + 60);
      var offset = Math.min(Math.max(0, el.offsetLeft - first.offsetLeft), maxOffset);
      // Modo leve: scrollLeft (sem camada de GPU); normal: transform (animação suave)
      if (State.lite) track.parentNode.scrollLeft = offset;
      else setTransform(track, 'translate3d(' + (-offset) + 'px,0,0)');

      // Pré-carrega as capas dos próximos cards
      // No modo leve só baixa quando o usuário para de navegar (decodificar trava a TV)
      var idx = Array.prototype.indexOf.call(cards, el);
      clearTimeout(Scroller.imgTimer);
      Scroller.imgTimer = setTimeout(function () {
        for (var i = idx; i >= 0 && i < Math.min(cards.length, idx + CONFIG.eagerImages); i++) {
          LazyImages.loadIn(cards[i]);
        }
      }, State.lite ? 300 : 0);
    },

    // A prateleira focada sobe para o topo da área de prateleiras
    vertical: function (el) {
      var rowsEl = $('#rows');
      var shelf = el.closest('.shelf');
      var y = shelf && rowsEl.contains(shelf) ? shelf.offsetTop : 0;
      if (State.lite) $('#rows-viewport').scrollTop = y;
      else setTransform(rowsEl, 'translate3d(0,' + (-y) + 'px,0)');
      Shelves.ensureLoadedAround(shelf);
    },

    // Lista vertical (episódios): rola o mínimo para mostrar o item
    resetY: function () {
      setTransform($('#rows'), '');
      $('#rows-viewport').scrollTop = 0;
    },
    resetX: function (track) {
      setTransform(track, '');
      if (track.parentNode) track.parentNode.scrollLeft = 0;
    },

    ensureVisibleY: function (box, el) {
      var margin = 16;
      var br = box.getBoundingClientRect(), er = el.getBoundingClientRect();
      if (er.top < br.top + margin) box.scrollTop -= (br.top + margin - er.top) / App.scale;
      else if (er.bottom > br.bottom - margin) box.scrollTop += (er.bottom - br.bottom + margin) / App.scale;
    }
  };

  /* Carregamento sob demanda das capas (data-src -> src) */
  var LazyImages = {
    load: function (img) {
      var src = img.getAttribute('data-src');
      if (!src) return;
      img.removeAttribute('data-src');
      img.src = src;
    },
    loadIn: function (node) {
      var img = node.querySelector('img[data-src]');
      if (img) LazyImages.load(img);
    },
    eager: function (container, count) {
      $$('img[data-src]', container).slice(0, count).forEach(LazyImages.load);
    }
  };

  /* ======================================================================
     6. TECLAS DO CONTROLE REMOTO / APIs DA TV
     ====================================================================== */
  // keyCode -> ação. Inclui teclas de teclado para testar no navegador.
  var KEYMAP = {
    37: 'left', 38: 'up', 39: 'right', 40: 'down',
    13: 'enter',
    10009: 'back',              // RETURN do controle Samsung
    8: 'back', 27: 'back',      // Backspace / Esc (navegador)
    415: 'play', 19: 'pause', 10252: 'playpause', 413: 'stop',
    417: 'ff', 412: 'rw',
    427: 'chup', 428: 'chdown',
    403: 'red',                 // botão VERMELHO (A): favoritar
    32: 'playpause',            // Espaço (navegador)
    33: 'chup', 34: 'chdown'    // PageUp / PageDown (navegador)
  };
  var ARROWS = { left: true, right: true, up: true, down: true };

  // Teclas de mídia precisam ser registradas no Tizen para chegarem ao app
  var TIZEN_KEYS = {
    MediaPlayPause: 'playpause', MediaPlay: 'play', MediaPause: 'pause', MediaStop: 'stop',
    MediaFastForward: 'ff', MediaRewind: 'rw', ChannelUp: 'chup', ChannelDown: 'chdown',
    ColorF0Red: 'red'
  };

  var TV = {
    isTizen: !!(window.tizen && window.tizen.tvinputdevice),

    registerKeys: function () {
      if (!TV.isTizen) return;
      Object.keys(TIZEN_KEYS).forEach(function (name) {
        try {
          window.tizen.tvinputdevice.registerKey(name);
          var key = window.tizen.tvinputdevice.getKey(name);
          if (key && key.code) KEYMAP[key.code] = TIZEN_KEYS[name];
        } catch (e) {
          if (window.console) console.warn('[TV] Tecla não registrada: ' + name, e);
        }
      });
    },

    // Evita o protetor de tela durante a reprodução
    screenSaver: function (enabled) {
      try {
        var ac = window.webapis && window.webapis.appcommon;
        if (!ac) return;
        ac.setScreenSaver(enabled
          ? ac.AppCommonScreenSaverState.SCREEN_SAVER_ON
          : ac.AppCommonScreenSaverState.SCREEN_SAVER_OFF);
      } catch (e) { /* indisponível fora da TV */ }
    },

    exit: function () {
      try { window.tizen.application.getCurrentApplication().exit(); } catch (e) { window.close(); }
    }
  };

  /* ======================================================================
     7. COMPONENTES DE UI
     ====================================================================== */
  var ICONS = {
    play: '<svg class="btn-icon" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
    back: '<svg class="btn-icon" viewBox="0 0 24 24"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20z"/></svg>',
    refresh: '<svg class="btn-icon" viewBox="0 0 24 24"><path d="M17.65 6.35A7.95 7.95 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4z"/></svg>',
    swap: '<svg class="btn-icon" viewBox="0 0 24 24"><path d="M6.99 11L3 15l3.99 4v-3H14v-2H6.99zM21 9l-3.99-4v3H10v2h7.01v3z"/></svg>',
    trash: '<svg class="btn-icon" viewBox="0 0 24 24"><path d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6zM19 4h-3.5l-1-1h-5l-1 1H5v2h14z"/></svg>',
    exit: '<svg class="btn-icon" viewBox="0 0 24 24"><path d="M10.09 15.59L11.5 17l5-5-5-5-1.41 1.41L12.67 11H3v2h9.67zM19 3H5a2 2 0 0 0-2 2v4h2V5h14v14H5v-4H3v4a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z"/></svg>',
    user: '<svg class="btn-icon" viewBox="0 0 24 24"><path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>',
    plus: '<svg class="btn-icon" viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>',
    check: '<svg class="btn-icon" viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>',
    info: '<svg class="btn-icon" viewBox="0 0 24 24"><path fill-rule="evenodd" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm-1 5h2v2h-2zm0 4h2v6h-2z"/></svg>',
    search: '<svg class="btn-icon" viewBox="0 0 24 24"><path d="M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>'
  };
  var STATE_ICONS = {
    play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><path d="M6 19h4V5H6zm8-14v14h4V5z"/></svg>'
  };

  function createButton(label, opts) {
    var btn = document.createElement('div');
    btn.className = 'btn focusable' + (opts.primary ? ' btn--primary' : '');
    btn.tabIndex = -1;
    btn.innerHTML = (opts.icon ? ICONS[opts.icon] : '') + '<span>' + esc(label) + '</span>';
    btn._onSelect = opts.action;
    return btn;
  }

  /* ---------- Toast ---------- */
  var Toast = {
    timer: null,
    show: function (message, ms) {
      var el = $('#toast');
      el.textContent = message;
      el.classList.add('visible');
      clearTimeout(Toast.timer);
      Toast.timer = setTimeout(function () { el.classList.remove('visible'); }, ms || 3000);
    }
  };

  /* ---------- Diálogo modal (erros e confirmações) ---------- */
  var Dialog = {
    cancelable: true,

    init: function () {
      Dialog.el = $('#dialog');
      Dialog.title = $('#dialogTitle');
      Dialog.message = $('#dialogMessage');
      Dialog.actions = $('#dialogActions');
    },

    // opts: { title, message, buttons: [{ label, icon, action }], cancelable }
    show: function (opts) {
      if (Nav.scope === 'dialog') Dialog.close();
      Dialog.cancelable = opts.cancelable !== false;
      Dialog.title.textContent = opts.title || '';
      Dialog.message.textContent = opts.message || '';
      Dialog.actions.innerHTML = '';
      (opts.buttons || [{ label: 'OK' }]).forEach(function (b, i) {
        Dialog.actions.appendChild(createButton(b.label, {
          primary: i === 0,
          icon: b.icon,
          action: function () { Dialog.close(); if (b.action) b.action(); }
        }));
      });
      Dialog.el.classList.remove('hidden');
      Nav.openOverlay('dialog', Dialog.actions.firstChild);
    },

    close: function () {
      if (Dialog.el.classList.contains('hidden')) return;
      Dialog.el.classList.add('hidden');
      Nav.closeOverlay();
    }
  };

  /* ---------- Splash ---------- */
  var Splash = {
    show: function (status) {
      $('#splash').classList.remove('is-hidden');
      Nav.reset('splash');
      Splash.status(status);
    },
    status: function (text) { $('#splashStatus').textContent = text || ''; },
    hide: function () { $('#splash').classList.add('is-hidden'); }
  };

  /* ---------- Login (URL/DNS, usuário e senha) ----------
     Cada campo é um wrapper .field navegável. OK abre a edição: o <input>
     recebe o foco e o Tizen exibe o teclado virtual (IME). Concluído/OK
     avança para o próximo campo; Cancelar/VOLTAR ou ▲▼ encerram a edição.
     Enquanto edita, letras, números, apagar e ◀ ▶ vão direto para o campo. */
  var IME_DONE = 65376, IME_CANCEL = 65385;   // teclas do teclado virtual do Tizen

  var Login = {
    editing: null,     // .field em edição

    init: function () {
      Login.el = $('#login');
      Login.inputs = { server: $('#loginServer'), username: $('#loginUser'), password: $('#loginPass') };
      Login.error = $('#loginError');
      Login.submitBtn = $('#loginSubmit');
      Login.fields = $$('.field', Login.el);
      Login.fields.forEach(function (field) {
        var input = $('input', field);
        field._onSelect = function () { Login.edit(field); };
        // O teclado da TV pode fechar sozinho (o input perde o foco)
        input.addEventListener('blur', function () {
          if (Login.editing === field) Login.stopEditing(false);
        });
      });
      Login.submitBtn._onSelect = function () { Login.submit(); };
      $('#loginExit')._onSelect = function () { App.confirmExit(); };
    },

    // account: dados para pré-preencher; message: erro da tentativa anterior
    show: function (account, message) {
      var a = account || {};
      Splash.hide();
      Login.el.classList.remove('hidden');
      Nav.reset('login');
      Login.inputs.server.value = a.server || '';
      Login.inputs.username.value = a.username || '';
      Login.inputs.password.value = a.password || '';
      Login.setError(message);
      // Foca o primeiro campo vazio; se tudo estiver preenchido, o botão Entrar
      var empty = Login.fields.filter(function (f) { return !$('input', f).value; })[0];
      Nav.focus(empty || Login.submitBtn);
    },

    hide: function () {
      Login.stopEditing(false);
      Login.el.classList.add('hidden');
    },

    setError: function (message) {
      Login.error.textContent = message || '';
      toggleClass(Login.error, 'hidden', !message);
    },

    edit: function (field) {
      var input = $('input', field);
      Login.editing = field;
      field.classList.add('editing');
      input.focus();
      try { input.setSelectionRange(input.value.length, input.value.length); } catch (e) { /* ignora */ }
    },

    stopEditing: function (advance) {
      var field = Login.editing;
      if (!field) return;
      Login.editing = null;
      field.classList.remove('editing');
      if (field.getAttribute('data-field') === 'server') Login.applyServerInput();

      if (!advance) { Nav.focus(field); return; }   // tira o foco do input e fecha o teclado
      var next = Login.fields[Login.fields.indexOf(field) + 1];
      if (next && !$('input', next).value) { Nav.focus(next); Login.edit(next); }
      else Nav.focus(Login.submitBtn);
    },

    onEditingKey: function (e) {
      var code = e.keyCode;
      if (code === 13 || code === IME_DONE) {
        e.preventDefault();
        Login.stopEditing(true);
      } else if (code === IME_CANCEL || code === 10009 || code === 27) {
        e.preventDefault();
        Login.stopEditing(false);
      } else if (code === 38 || code === 40) {
        e.preventDefault();
        Login.stopEditing(false);
        Nav.move(code === 38 ? 'up' : 'down');
      }
    },

    /* Aceita "dominio.com:8080", "http://dominio.com:8080/" ou o link M3U
       completo (get.php?username=...&password=...): nesse caso preenche
       usuário e senha automaticamente. */
    parseServer: function (raw) {
      var s = String(raw || '').trim();
      if (!s) return { server: '', username: '', password: '' };
      var user = s.match(/[?&]username=([^&#]+)/i);
      var pass = s.match(/[?&]password=([^&#]+)/i);
      if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
      s = s.split(/[?#]/)[0]
        .replace(/\/(player_api|get|xmltv|panel_api)\.php$/i, '')
        .replace(/\/+$/, '');
      return {
        server: s,
        username: user ? safeDecode(user[1]) : '',
        password: pass ? safeDecode(pass[1]) : ''
      };
    },

    applyServerInput: function () {
      var parsed = Login.parseServer(Login.inputs.server.value);
      Login.inputs.server.value = parsed.server;
      if (parsed.username) Login.inputs.username.value = parsed.username;
      if (parsed.password) Login.inputs.password.value = parsed.password;
    },

    submit: function () {
      Login.applyServerInput();
      var account = {
        server: Login.inputs.server.value.trim(),
        username: Login.inputs.username.value.trim(),
        password: Login.inputs.password.value
      };
      if (!/^https?:\/\/[^\/\s]+/i.test(account.server)) {
        Login.setError('Informe a URL do servidor (ex.: http://servidor.com:8080).');
        Nav.focus(Login.fields[0]);
        return;
      }
      if (!account.username || !account.password) {
        Login.setError('Informe o usuário e a senha.');
        Nav.focus(Login.fields[account.username ? 2 : 1]);
        return;
      }
      Login.hide();
      App.boot(account);
    }
  };

  /* ---------- Menu lateral retrátil ---------- */
  /* ---------- Minha lista (favoritos) ----------
     Salva um resumo de cada título/canal na TV, separado por conta
     (servidor + usuário). O mais recente fica primeiro. */
  var Favorites = {
    MAX: 300,

    storageKey: function () {
      var a = State.account || {};
      return 'fav.' + (a.server || '') + '|' + (a.username || '');
    },
    list: function () { return Storage.get(Favorites.storageKey(), []) || []; },
    key: function (item) { return item.kind + ':' + item.id; },

    has: function (item) {
      if (!item) return false;
      var k = Favorites.key(item);
      return Favorites.list().some(function (f) { return Favorites.key(f) === k; });
    },

    byKind: function (kind) {
      return Favorites.list().filter(function (f) { return f.kind === kind; });
    },

    // Resumo leve do item (sem EPG, sinopse limitada) para caber no armazenamento
    snapshot: function (item) {
      return {
        kind: item.kind, id: item.id, name: item.name, poster: item.poster || '',
        backdrop: item.backdrop || '', rating: item.rating || '', year: item.year || '',
        genre: item.genre || '', plot: String(item.plot || '').slice(0, 400),
        ext: item.ext || '', epg: null, enriched: false
      };
    },

    // Retorna true se foi adicionado, false se foi removido
    toggle: function (item) {
      if (!item) return false;
      var list = Favorites.list(), k = Favorites.key(item), index = -1;
      list.forEach(function (f, i) { if (Favorites.key(f) === k) index = i; });
      if (index >= 0) {
        list.splice(index, 1);
        Toast.show('“' + item.name + '” removido da sua lista');
      } else {
        list.unshift(Favorites.snapshot(item));
        if (list.length > Favorites.MAX) list.length = Favorites.MAX;
        Toast.show('“' + item.name + '” adicionado à sua lista');
      }
      Storage.set(Favorites.storageKey(), list);
      return index < 0;
    }
  };

  /* ---------- Pesquisa (lupa), estilo Netflix ----------
     A API Xtream não tem busca: o app monta um índice local com os nomes de
     filmes, séries e canais (uma vez por sessão) e filtra enquanto se digita
     no teclado da tela. No modo leve o índice é montado categoria por
     categoria, para não baixar listas gigantes de uma só vez. */
  var SEARCH_HINT = 'Use o teclado acima para digitar o nome de um filme, série ou canal.';

  var Search = {
    query: '',
    index: null,     // [{ item, key }]
    loading: null,
    gen: 0,          // invalida um índice em construção ao trocar de conta
    timer: null,
    LIMIT: 200,      // resultados por tipo

    reset: function () { Search.gen++; Search.index = null; Search.loading = null; },

    setStatus: function (text) {
      var el = $('#searchStatus');
      if (el) el.textContent = text || '';
    },

    render: function () {
      Shelves.list = [];
      Scroller.resetY();
      $('#rows').innerHTML =
        '<div class="search">' +
          '<div class="search-box">' + ICONS.search + '<span class="search-query" id="searchQuery"></span></div>' +
          '<div id="searchKeyboard"></div>' +
          '<div class="search-status" id="searchStatus"></div>' +
        '</div>' +
        '<div id="searchResults"></div>';
      Search.renderKeyboard();
      Search.updateQuery();
      Search.setStatus(SEARCH_HINT);
      if (Search.query) Search.run();
      Search.ensureIndex();   // já começa a montar o índice ao abrir a página
    },

    key: function (label, action, cls) {
      var k = document.createElement('div');
      k.className = 'key focusable' + (cls ? ' ' + cls : '');
      k.tabIndex = -1;
      k.textContent = label;
      k._onSelect = action;
      return k;
    },

    renderKeyboard: function () {
      var box = $('#searchKeyboard');
      var rows = ['abcdefghijklm'.split(''), 'nopqrstuvwxyz'.split(''), '1234567890'.split('')];
      rows.forEach(function (keys, r) {
        var row = document.createElement('div');
        row.className = 'nav-row keyboard-row';
        keys.forEach(function (ch) {
          row.appendChild(Search.key(ch, function () { Search.type(ch); }));
        });
        if (r === 2) {
          row.appendChild(Search.key('Espaço', function () { Search.type(' '); }, 'key--wide'));
          row.appendChild(Search.key('Apagar', function () { Search.backspace(); }, 'key--wide'));
          row.appendChild(Search.key('Limpar', function () { Search.clear(); }, 'key--wide'));
        }
        box.appendChild(row);
      });
    },

    type: function (ch) {
      if (Search.query.length >= 40) return;
      Search.query += ch;
      Search.changed();
    },
    backspace: function () { Search.query = Search.query.slice(0, -1); Search.changed(); },
    clear: function () { Search.query = ''; Search.changed(); },

    changed: function () {
      Search.updateQuery();
      clearTimeout(Search.timer);
      Search.timer = setTimeout(Search.run, State.lite ? 600 : 350);
    },

    updateQuery: function () {
      var el = $('#searchQuery');
      if (!el) return;
      if (Search.query) {
        el.className = 'search-query';
        el.innerHTML = esc(Search.query) + '<span class="search-caret"></span>';
      } else {
        el.className = 'search-query is-empty';
        el.innerHTML = 'Títulos, séries ou canais<span class="search-caret"></span>';
      }
    },

    normalizedQuery: function () { return normalizeText(Search.query).replace(/\s+/g, ' ').trim(); },

    run: function () {
      var results = $('#searchResults');
      if (!results || State.page !== 'search') return;
      var q = Search.normalizedQuery();
      if (q.length < 2) {
        results.innerHTML = '';
        Search.setStatus(q.length ? 'Digite pelo menos 2 letras.' : SEARCH_HINT);
        return;
      }
      var token = State.pageToken;
      Search.ensureIndex().then(function (index) {
        if (token !== State.pageToken || State.page !== 'search') return;
        if (Search.normalizedQuery() !== q) return;   // a busca mudou enquanto o índice carregava
        Search.show(Search.match(index, q));
      });
    },

    // Todas as palavras precisam aparecer no nome; quem começa com a busca vem primeiro
    match: function (index, q) {
      var words = q.split(' ');
      var groups = { vod: [], series: [], live: [] };
      for (var i = 0; i < index.length; i++) {
        var e = index[i], g = groups[e.item.kind];
        if (!g || g.length >= Search.LIMIT) continue;
        var ok = true;
        for (var w = 0; w < words.length; w++) {
          if (e.key.indexOf(words[w]) < 0) { ok = false; break; }
        }
        if (ok) g.push(e);
      }
      Object.keys(groups).forEach(function (k) {
        groups[k] = groups[k]
          .sort(function (a, b) { return (b.key.indexOf(q) === 0 ? 1 : 0) - (a.key.indexOf(q) === 0 ? 1 : 0); })
          .map(function (e) { return e.item; });
      });
      return groups;
    },

    show: function (groups) {
      var results = $('#searchResults');
      results.innerHTML = '';
      var total = 0;
      [['vod', 'Filmes'], ['series', 'Séries'], ['live', 'Canais']].forEach(function (p) {
        var items = groups[p[0]];
        if (!items.length) return;
        total += items.length;
        var shelf = Shelves.create({ title: p[1], kind: p[0], model: same });
        results.appendChild(shelf.el);
        Shelves.fill(shelf, items);
      });
      Search.setStatus(total ? '' : 'Nenhum resultado para “' + Search.query.trim() + '”.');
    },

    ensureIndex: function () {
      if (Search.index) return Promise.resolve(Search.index);
      if (Search.loading) return Search.loading;
      var gen = Search.gen, index = [], seen = {};
      var steps = [
        { kind: 'vod', label: 'filmes', action: 'get_vod_streams', model: Model.vod },
        { kind: 'series', label: 'séries', action: 'get_series', model: Model.series },
        { kind: 'live', label: 'canais', action: 'get_live_streams', model: Model.live }
      ];
      var chain = Promise.resolve();
      steps.forEach(function (step) {
        chain = chain.then(function () {
          if (gen !== Search.gen) return null;
          return Search.fetchKind(step, function (raw) {
            var item = step.model(raw);
            var k = item.kind + ':' + item.id;
            if (seen[k]) return;
            seen[k] = true;
            index.push({ item: item, key: normalizeText(item.name) });
          });
        });
      });
      Search.loading = chain.then(function () {
        if (gen !== Search.gen) return [];
        Search.index = index;
        Search.loading = null;
        if (State.page === 'search' && Search.normalizedQuery().length < 2) Search.setStatus(SEARCH_HINT);
        return index;
      });
      return Search.loading;
    },

    // Normal: uma lista completa por tipo. Modo leve: categoria por categoria
    fetchKind: function (step, add) {
      if (!State.lite) {
        Search.setStatus('Preparando a busca: carregando ' + step.label + '…');
        return API.schedule(function () { return API.fetchJson(API.url({ action: step.action }), 120000); })
          .then(function (data) { toList(data).forEach(add); })['catch'](function () { /* tipo indisponível */ });
      }
      var cats = State.categories[step.kind] || [];
      var chain = Promise.resolve();
      cats.forEach(function (cat, i) {
        chain = chain.then(function () {
          Search.setStatus('Preparando a busca: ' + step.label + ' (' + (i + 1) + ' de ' + cats.length + ')…');
          return API.schedule(function () {
            return API.fetchJson(API.url({ action: step.action, category_id: cat.category_id }));
          }).then(function (data) { toList(data).forEach(add); })['catch'](function () { /* categoria indisponível */ });
        });
      });
      return chain;
    }
  };

  var Sidebar = {
    init: function () {
      Sidebar.items = $$('.menu-item', $('#sidebar'));
      Sidebar.items.forEach(function (item) {
        item._onSelect = function () { App.goTo(item.getAttribute('data-page')); };
      });
    },

    open: function () {
      Nav.scope = 'sidebar';
      document.body.classList.add('sidebar-open');
      Nav.focus($('.menu-item.active') || Sidebar.items[0]);
    },

    close: function () {
      document.body.classList.remove('sidebar-open');
      Nav.scope = 'content';
      var last = Nav.lastContent;
      if (last && document.body.contains(last) && Nav.isFocusable(last)) Nav.focus(last);
      else Nav.focusFirst();
    },

    move: function (dir) {
      var i = Sidebar.items.indexOf(Nav.current);
      if (dir === 'up' && i > 0) Nav.focus(Sidebar.items[i - 1]);
      else if (dir === 'down' && i < Sidebar.items.length - 1) Nav.focus(Sidebar.items[i + 1]);
      else if (dir === 'right') Sidebar.close();
    },

    setActive: function (page) {
      Sidebar.items.forEach(function (item) {
        toggleClass(item, 'active', item.getAttribute('data-page') === page);
      });
    }
  };

  /* ---------- Hero Banner ---------- */
  var Hero = {
    item: null,
    ctx: null,
    token: 0,
    layer: 0,
    bgKey: null,

    init: function () {
      Hero.els = {
        kicker: $('#heroKicker'), title: $('#heroTitle'), meta: $('#heroMeta'),
        plot: $('#heroPlot'), logo: $('#heroLogo'), play: $('#heroPlay'), info: $('#heroInfo')
      };
      Hero.layers = [$('#heroLayerA'), $('#heroLayerB')];
      Hero.els.logo.onerror = function () { Hero.els.logo.classList.add('hidden'); };

      Hero.els.play._onSelect = function () { if (Hero.item) App.play(Hero.item, Hero.ctx); };
      // Segundo botão: "Detalhes" (filme/série) ou "Minha lista" (canal ao vivo)
      Hero.els.info._onSelect = function () {
        if (!Hero.item) return;
        if (Hero.item.kind === 'live') { Favorites.toggle(Hero.item); Hero.updateInfoBtn(); }
        else App.select(Hero.item, Hero.ctx);
      };

      // Atualiza o banner só quando o usuário "para" num card
      Hero.debounced = debounce(function (item, ctx, pageToken) {
        if (pageToken === State.pageToken && item !== Hero.item) Hero.set(item, ctx);
      }, CONFIG.heroDebounce);
    },

    schedule: function (item, ctx) {
      if (document.body.classList.contains('no-hero')) return;   // página sem banner
      Hero.debounced(item, ctx, State.pageToken);
    },

    placeholder: function (title, subtitle) {
      Hero.item = null;
      Hero.ctx = null;
      Hero.token++;
      Hero.els.kicker.textContent = 'PlayerIPTV';
      Hero.els.title.textContent = title || '';
      Hero.els.meta.innerHTML = '';
      Hero.els.plot.textContent = subtitle || 'Carregando conteúdo…';
      Hero.els.logo.classList.add('hidden');
      Hero.setBackdrop('');
      Hero.updateInfoBtn();
    },

    updateInfoBtn: function () {
      var item = Hero.item, btn = Hero.els.info;
      if (item && item.kind === 'live') {
        var fav = Favorites.has(item);
        btn.innerHTML = ICONS[fav ? 'check' : 'plus'] + '<span>' + (fav ? 'Na minha lista' : 'Minha lista') + '</span>';
      } else {
        btn.innerHTML = ICONS.info + '<span>Detalhes</span>';
      }
    },

    set: function (item, ctx) {
      Hero.item = item;
      Hero.ctx = ctx || null;
      var token = ++Hero.token;
      Hero.render();

      // Busca dados extras de forma assíncrona (sinopse/backdrop ou EPG)
      // No modo leve a sinopse do filme só é buscada ao abrir os detalhes
      if (item.kind === 'vod' && !item.enriched && !State.lite) {
        API.getVodInfo(item.id).then(function (data) {
          Model.enrichVod(item, data);
          if (token === Hero.token) Hero.render();
        })['catch'](function () { item.enriched = true; });
      } else if (item.kind === 'live') {
        API.getShortEpg(item.id).then(function (data) {
          item.epg = Model.epg(data);
          if (token === Hero.token) Hero.render();
        })['catch'](function () {
          item.epg = [];
          if (token === Hero.token) Hero.render();
        });
      }
    },

    refresh: function (item) { if (item === Hero.item) Hero.render(); },

    render: function () {
      var item = Hero.item, e = Hero.els, ctx = Hero.ctx || {};
      if (!item) return;
      e.kicker.textContent = KIND_LABEL[item.kind] + (ctx.category ? '  •  ' + ctx.category : '');
      e.title.textContent = item.name;
      e.meta.innerHTML = buildMeta(item);

      if (item.kind === 'live') {
        e.plot.innerHTML = epgHtml(item.epg);
        if (item.poster) {
          if (e.logo.getAttribute('src') !== item.poster) e.logo.src = item.poster;
          e.logo.classList.remove('hidden');
        } else {
          e.logo.classList.add('hidden');
        }
        Hero.setBackdrop('');
      } else {
        e.plot.textContent = item.plot || '';
        e.logo.classList.add('hidden');
        if (item.backdrop) Hero.setBackdrop(tmdbSize(item.backdrop, State.lite ? 'w780' : 'w1280'), false);
        else Hero.setBackdrop(tmdbSize(item.poster, State.lite ? 'w342' : 'w500'), true);
      }
      Hero.updateInfoBtn();
    },

    // Crossfade entre duas camadas, só depois que a imagem carregou
    setBackdrop: function (url, isPoster) {
      if (State.lite) url = '';   // modo leve: banner sem imagem de fundo (repinta muito menos)
      var key = (url || '') + (isPoster ? '#poster' : '');
      if (key === Hero.bgKey) return;
      Hero.bgKey = key;

      if (!url) {
        Hero.layers.forEach(function (l) { l.classList.remove('visible'); });
        return;
      }
      var img = new Image();
      img.onload = function () {
        if (Hero.bgKey !== key) return;
        var next = Hero.layers[1 - Hero.layer];
        next.style.backgroundImage = cssUrl(url);
        toggleClass(next, 'is-poster', !!isPoster);
        next.classList.add('visible');
        Hero.layers[Hero.layer].classList.remove('visible');
        Hero.layer = 1 - Hero.layer;
      };
      img.src = url;
    }
  };

  /* ---------- Cards ---------- */
  var Cards = {
    // ctx: { list, index, category } — usado no zapping e no banner
    create: function (item, ctx) {
      var card = document.createElement('div');
      card.className = 'card focusable ' + (item.kind === 'live' ? 'card--live' : 'card--poster');
      card.tabIndex = -1;
      card.innerHTML =
        '<div class="card-media">' +
          '<div class="card-fallback"><span>' + esc(item.name) + '</span></div>' +
          (item.poster ? '<img class="card-img" alt="" data-src="' + esc(tmdbSize(item.poster, State.lite ? 'w185' : 'w342')) + '">' : '') +
        '</div>' +
        '<div class="card-title">' + esc(item.name) + '</div>';

      var img = card.querySelector('img');
      if (img) {
        img.onload = function () { img.classList.add('loaded'); };
        img.onerror = function () { if (img.parentNode) img.parentNode.removeChild(img); };
      }
      card._onFocus = function () {
        if (Nav.scope === 'grid') Grid.onFocus(card);
        else if (Nav.scope === 'content') Hero.schedule(item, ctx);
      };
      card._item = item;   // usado pelo botão VERMELHO (favoritar)
      card._onSelect = function () { App.select(item, ctx); };
      return card;
    },

    // Último card da prateleira: abre a categoria completa na grade
    more: function (def, raw) {
      var live = def.kind === 'live';
      var card = document.createElement('div');
      card.className = 'card card--more focusable ' + (live ? 'card--live' : 'card--poster');
      card.tabIndex = -1;
      card.innerHTML =
        '<div class="card-media"><div class="card-more">' +
          '<span class="card-more-icon">+</span><span>Ver todos</span>' +
          '<small>' + raw.length + (live ? ' canais' : ' títulos') + '</small>' +
        '</div></div>' +
        (live ? '<div class="card-title">Ver todos</div>' : '');
      card._onSelect = function () { Grid.open(def, raw); };
      return card;
    },

    skeletons: function (kind, count) {
      if (State.lite) count = Math.min(count, 5);
      var cls = 'card focusable skeleton ' + (kind === 'live' ? 'card--live' : 'card--poster');
      var html = '';
      for (var i = 0; i < count; i++) {
        html += '<div class="' + cls + '" tabindex="-1"><div class="card-media"></div>' +
          (kind === 'live' ? '<div class="card-title">&nbsp;</div>' : '') + '</div>';
      }
      return html;
    }
  };

  /* ---------- Prateleiras (carrosséis por categoria) ---------- */
  var Shelves = {
    list: [],   // [{ def, el, track, count, state: idle|loading|ready|error|empty }]

    // defs: [{ title, kind, loader: function () -> Promise<item[]> }]
    render: function (defs, emptyMessage) {
      var rowsEl = $('#rows');
      rowsEl.innerHTML = '';
      Scroller.resetY();
      var frag = document.createDocumentFragment();
      Shelves.list = defs.map(function (def) {
        var shelf = Shelves.create(def);
        frag.appendChild(shelf.el);
        return shelf;
      });
      rowsEl.appendChild(frag);
      if (!Shelves.list.length) Shelves.showEmpty(emptyMessage);
      Shelves.ensureLoaded(0);
    },

    create: function (def) {
      var el = document.createElement('section');
      el.className = 'shelf nav-row' + (def.kind === 'live' ? ' shelf--live' : '');
      el.setAttribute('data-remember', '');
      el.innerHTML =
        '<h2 class="shelf-title">' + esc(def.title) + '<span class="shelf-count"></span></h2>' +
        '<div class="shelf-viewport scroll-managed"><div class="row-track"></div></div>';
      var shelf = {
        def: def, el: el, state: 'idle',
        track: el.querySelector('.row-track'),
        count: el.querySelector('.shelf-count')
      };
      shelf.track.innerHTML = Cards.skeletons(def.kind, 8);
      return shelf;
    },

    indexOf: function (el) {
      for (var i = 0; i < Shelves.list.length; i++) if (Shelves.list[i].el === el) return i;
      return -1;
    },

    ensureLoadedAround: function (shelfEl) {
      Shelves.ensureLoaded(shelfEl ? Math.max(0, Shelves.indexOf(shelfEl)) : 0);
    },

    // Carrega a prateleira atual, a anterior e as próximas N
    ensureLoaded: function (index) {
      var ahead = 0;
      for (var i = Math.max(0, index - 1); i < Shelves.list.length && ahead <= CONFIG.rowsPreload; i++) {
        var shelf = Shelves.list[i];
        if (shelf.state === 'empty') continue;
        Shelves.load(shelf);
        if (i >= index) ahead++;
      }
    },

    load: function (shelf) {
      if (shelf.state !== 'idle') return;
      shelf.state = 'loading';
      var token = State.pageToken;
      shelf.def.loader()
        .then(function (items) {
          if (token !== State.pageToken) return;
          if (!items.length) Shelves.remove(shelf); else Shelves.fill(shelf, items);
        })['catch'](function (err) {
          if (token !== State.pageToken) return;
          if (window.console) console.error('[Prateleira] ' + shelf.def.title, err);
          Shelves.fail(shelf);
        });
    },

    focusIndexIn: function (shelf) {
      var cur = Nav.current;
      if (!cur || !shelf.el.contains(cur)) return -1;
      return Array.prototype.indexOf.call(shelf.track.children, cur);
    },

    // raw: lista bruta da API. Só os primeiros itens viram cards; o restante
    // fica acessível pelo card "Ver todos" (grade paginada)
    fill: function (shelf, raw) {
      var focusedIndex = Shelves.focusIndexIn(shelf);
      var model = shelf.def.model;
      var isLive = shelf.def.kind === 'live';
      // Canais: lista completa normalizada (o zapping percorre a categoria toda)
      var all = isLive ? raw.map(model) : null;
      var visible = isLive ? all.slice(0, CONFIG.maxItemsPerRow) : raw.slice(0, CONFIG.maxItemsPerRow).map(model);
      var list = isLive ? all : visible;
      var frag = document.createDocumentFragment();
      visible.forEach(function (item, i) {
        frag.appendChild(Cards.create(item, { list: list, index: i, category: shelf.def.title }));
      });
      if (raw.length > visible.length) frag.appendChild(Cards.more(shelf.def, raw));
      shelf.track.innerHTML = '';
      shelf.track.appendChild(frag);
      shelf.state = 'ready';
      shelf.count.textContent = raw.length + (isLive ? ' canais' : ' títulos');
      LazyImages.eager(shelf.track, CONFIG.eagerImages);

      // Primeiro conteúdo carregado vira o destaque do banner
      if (!Hero.item && !document.body.classList.contains('no-hero')) {
        Hero.set(visible[0], { list: list, index: 0, category: shelf.def.title });
      }

      // Se o usuário estava no skeleton, mantém o foco na mesma posição
      if (focusedIndex >= 0) {
        var cards = shelf.track.children;
        Nav.focus(cards[Math.min(focusedIndex, cards.length - 1)]);
      }
    },

    fail: function (shelf) {
      var hadFocus = Shelves.focusIndexIn(shelf) >= 0;
      shelf.state = 'error';
      Scroller.resetX(shelf.track);
      shelf.track.innerHTML = '';
      var card = document.createElement('div');
      card.className = 'card card--error focusable';
      card.tabIndex = -1;
      card.innerHTML = '<div class="card-media"><div class="card-fallback"><span>Falha ao carregar<br>' +
        '<small>Pressione OK para tentar novamente</small></span></div></div>';
      card._onSelect = function () {
        shelf.state = 'idle';
        shelf.track.innerHTML = Cards.skeletons(shelf.def.kind, 8);
        Nav.focus(shelf.track.children[0]);
        Shelves.load(shelf);
      };
      shelf.track.appendChild(card);
      if (hadFocus) Nav.focus(card);
    },

    // Categoria vazia: some da tela
    remove: function (shelf) {
      var hadFocus = Shelves.focusIndexIn(shelf) >= 0;
      var target = null;
      if (hadFocus) {
        var rows = Nav.rows($('#main'));
        var i = rows.indexOf(shelf.el);
        target = rows[i + 1] || rows[i - 1] || null;
      }
      shelf.state = 'empty';
      if (shelf.el.parentNode) shelf.el.parentNode.removeChild(shelf.el);

      var allEmpty = Shelves.list.every(function (s) { return s.state === 'empty'; });
      if (allEmpty) {
        Shelves.showEmpty();
        if (hadFocus) Nav.focusFirst();
        return;
      }
      if (target) Nav.focus(Nav.items(target)[0]);
      else if (Nav.lastContent && document.body.contains(Nav.lastContent)) Scroller.vertical(Nav.lastContent);
      else Shelves.ensureLoaded(0);
    },

    showEmpty: function (message) {
      $('#rows').innerHTML = '<div class="empty-state">' + esc(message || 'Nenhum conteúdo disponível nesta seção.') + '</div>';
    }
  };

  /* ---------- Grade "Ver todos" (categoria completa, paginada) ----------
     Mostra todos os títulos de uma categoria em páginas, para manter poucos
     elementos na tela (TVs antigas). Os botões ou CH+/CH− trocam de página. */
  var Grid = {
    def: null,
    raw: [],
    all: null,    // canais já normalizados (zapping)
    page: 0,

    init: function () {
      Grid.el = $('#grid');
      Grid.els = { kicker: $('#gridKicker'), title: $('#gridTitle'), info: $('#gridInfo'), body: $('#gridBody') };
    },

    cols: function () { return Grid.def.kind === 'live' ? 5 : 7; },
    pageSize: function () { return Grid.cols() * (State.lite ? 3 : 5); },
    pages: function () { return Math.max(1, Math.ceil(Grid.raw.length / Grid.pageSize())); },

    open: function (def, raw) {
      Grid.def = def;
      Grid.raw = raw;
      Grid.all = def.kind === 'live' ? raw.map(def.model) : null;
      Grid.els.kicker.textContent = def.kind === 'live' ? 'TV ao vivo' : (def.kind === 'vod' ? 'Filmes' : 'Séries');
      Grid.els.title.textContent = def.title;
      Grid.el.classList.remove('hidden');
      Nav.openOverlay('grid', null);
      Grid.render(0);
    },

    close: function () {
      Grid.el.classList.add('hidden');
      Grid.els.body.innerHTML = '';
      Grid.raw = [];
      Grid.all = null;
      Nav.closeOverlay();
    },

    render: function (page) {
      var size = Grid.pageSize(), cols = Grid.cols();
      var isLive = Grid.def.kind === 'live';
      Grid.page = Math.max(0, Math.min(page, Grid.pages() - 1));
      var start = Grid.page * size;
      var items = isLive ? Grid.all.slice(start, start + size) : Grid.raw.slice(start, start + size).map(Grid.def.model);
      var list = isLive ? Grid.all : items;

      var body = Grid.els.body;
      body.innerHTML = '';
      body.scrollTop = 0;
      var frag = document.createDocumentFragment();
      var row = null;
      items.forEach(function (item, i) {
        if (i % cols === 0) {
          row = document.createElement('div');
          row.className = 'nav-row grid-row';
          frag.appendChild(row);
        }
        row.appendChild(Cards.create(item, { list: list, index: isLive ? start + i : i, category: Grid.def.title }));
      });

      // Paginação
      if (Grid.pages() > 1) {
        var pager = document.createElement('div');
        pager.className = 'nav-row grid-pager';
        if (Grid.page > 0) {
          pager.appendChild(createButton('Página anterior', { icon: 'back', action: function () { Grid.render(Grid.page - 1); } }));
        }
        if (Grid.page < Grid.pages() - 1) {
          pager.appendChild(createButton('Próxima página', { icon: 'play', primary: true, action: function () { Grid.render(Grid.page + 1); } }));
        }
        frag.appendChild(pager);
      }
      body.appendChild(frag);
      LazyImages.eager(body, cols * 2);

      Grid.els.info.textContent = Grid.raw.length + (isLive ? ' canais' : ' títulos') +
        (Grid.pages() > 1 ? '   •   Página ' + (Grid.page + 1) + ' de ' + Grid.pages() + '   •   CH ± troca de página' : '');
      Nav.focus(body.querySelector('.card'));
    },

    // Carrega as capas da linha focada e das duas seguintes
    onFocus: function (card) {
      var row = card.parentNode;
      for (var n = 0; row && n < 3; n++) {
        $$('img[data-src]', row).forEach(LazyImages.load);
        row = row.nextElementSibling;
      }
    }
  };

  /* ---------- Detalhes (filme / série) ---------- */
  var Details = {
    item: null,
    token: 0,
    seasons: [],
    activeSeason: 0,

    init: function () {
      Details.el = $('#details');
      Details.els = {
        backdrop: $('#detailsBackdrop'), poster: $('#detailsPoster'), kicker: $('#detailsKicker'),
        title: $('#detailsTitle'), meta: $('#detailsMeta'), plot: $('#detailsPlot'),
        credits: $('#detailsCredits'), actions: $('#detailsActions'),
        seasonsWrap: $('#detailsSeasonsWrap'), seasons: $('#detailsSeasons'), episodes: $('#detailsEpisodes')
      };
      Details.els.poster.onerror = function () { Details.els.poster.classList.add('hidden'); };
    },

    open: function (item) {
      var token = ++Details.token;
      var e = Details.els;
      Details.item = item;
      Details.seasons = [];
      toggleClass(Details.el, 'is-series', item.kind === 'series');
      e.seasonsWrap.classList.add('hidden');
      e.seasons.innerHTML = '';
      e.episodes.innerHTML = '';
      toggleClass(e.episodes, 'hidden', item.kind !== 'series');
      Details.render();
      Details.renderActions();
      Details.el.classList.remove('hidden');
      Nav.openOverlay('details', e.actions.firstChild);

      if (item.kind === 'vod') {
        API.getVodInfo(item.id).then(function (data) {
          Model.enrichVod(item, data);
          if (token !== Details.token) return;
          Details.render();
          Hero.refresh(item);
        })['catch'](function () {});
      } else if (item.kind === 'series') {
        e.episodes.innerHTML = '<div class="episodes-loading">Carregando episódios…</div>';
        API.getSeriesInfo(item.id).then(function (data) {
          if (token !== Details.token) return;
          Model.enrichSeries(item, data);
          Details.seasons = Model.seasons(data);
          Details.render();
          Details.renderSeasons();
        })['catch'](function () {
          if (token !== Details.token) return;
          e.episodes.innerHTML = '<div class="episodes-loading">Não foi possível carregar os episódios.</div>';
        });
      }
    },

    close: function () {
      Details.token++;
      Details.el.classList.add('hidden');
      Details.els.episodes.innerHTML = '';
      Nav.closeOverlay();
    },

    render: function () {
      var item = Details.item, e = Details.els;
      e.kicker.textContent = KIND_LABEL[item.kind];
      e.title.textContent = item.name;
      e.meta.innerHTML = buildMeta(item);
      e.plot.textContent = item.plot || 'Sinopse indisponível.';

      var credits = [];
      if (item.director) credits.push('<strong>Direção:</strong> ' + esc(item.director));
      if (item.cast) credits.push('<strong>Elenco:</strong> ' + esc(item.cast));
      e.credits.innerHTML = credits.join('<br>');

      if (item.poster) {
        var posterUrl = tmdbSize(item.poster, 'w342');
        if (e.poster.getAttribute('src') !== posterUrl) e.poster.src = posterUrl;
        e.poster.classList.remove('hidden');
      } else {
        e.poster.classList.add('hidden');
      }
      var bg = tmdbSize(item.backdrop || item.poster, State.lite ? 'w780' : 'w1280');
      e.backdrop.style.backgroundImage = bg && !State.lite ? cssUrl(bg) : 'none';
      toggleClass(e.backdrop, 'is-poster', !item.backdrop);
    },

    renderActions: function () {
      var item = Details.item, e = Details.els;
      e.actions.innerHTML = '';
      var label = 'Assistir';
      if (item.kind === 'vod' && Resume.get('vod:' + item.id) > 30) label = 'Continuar assistindo';
      Details.playBtn = createButton(label, { icon: 'play', primary: true, action: function () { Details.playSelected(); } });
      e.actions.appendChild(Details.playBtn);
      Details.favBtn = createButton('Minha lista', {
        icon: 'plus',
        action: function () { Favorites.toggle(Details.item); Details.updateFav(); Hero.updateInfoBtn(); }
      });
      e.actions.appendChild(Details.favBtn);
      Details.updateFav();
      e.actions.appendChild(createButton('Voltar', { icon: 'back', action: function () { Details.close(); } }));
    },

    updateFav: function () {
      if (!Details.favBtn || !Details.item) return;
      var fav = Favorites.has(Details.item);
      Details.favBtn.innerHTML = ICONS[fav ? 'check' : 'plus'] + '<span>' + (fav ? 'Na minha lista' : 'Minha lista') + '</span>';
    },

    playSelected: function () {
      var item = Details.item;
      if (item.kind === 'vod') { App.play(item); return; }
      var season = Details.seasons[Details.activeSeason];
      if (!season) { Toast.show('Aguarde, carregando episódios…'); return; }
      Details.playEpisode(season.episodes[0]);
    },

    playEpisode: function (episode) {
      // Playlist com todas as temporadas: o próximo episódio toca automaticamente
      var all = [].concat.apply([], Details.seasons.map(function (s) { return s.episodes; }));
      App.playEpisodes(Details.item, all, Math.max(0, all.indexOf(episode)));
    },

    renderSeasons: function () {
      var e = Details.els;
      if (!Details.seasons.length) {
        e.episodes.innerHTML = '<div class="episodes-loading">Nenhum episódio disponível.</div>';
        return;
      }
      e.seasonsWrap.classList.remove('hidden');
      e.seasons.innerHTML = '';
      Scroller.resetX(e.seasons);
      // Ao subir/descer até as temporadas, o foco vai para a temporada ativa
      e.seasons.setAttribute('data-remember', '');
      Details.seasons.forEach(function (season, i) {
        var chip = document.createElement('div');
        chip.className = 'chip focusable';
        chip.tabIndex = -1;
        chip.textContent = 'Temporada ' + season.number;
        chip._onSelect = function () { Details.selectSeason(i); };
        e.seasons.appendChild(chip);
      });
      Details.selectSeason(0);
    },

    selectSeason: function (index) {
      var season = Details.seasons[index];
      Details.activeSeason = index;
      Details.els.seasons._last = index;
      $$('.chip', Details.els.seasons).forEach(function (c, j) { toggleClass(c, 'active', j === index); });
      Details.renderEpisodes(season);
      var first = season.episodes[0];
      Details.playBtn.querySelector('span').textContent = 'Assistir T' + season.number + ':E' + (first ? first.num : 1);
    },

    renderEpisodes: function (season) {
      var box = Details.els.episodes;
      box.innerHTML = '';
      box.scrollTop = 0;
      var frag = document.createDocumentFragment();
      season.episodes.forEach(function (ep) {
        var row = document.createElement('div');
        row.className = 'nav-row episode-row';
        var el = document.createElement('div');
        el.className = 'episode focusable';
        el.tabIndex = -1;
        el.innerHTML =
          '<div class="episode-thumb">' +
            (ep.image ? '<img src="' + esc(tmdbSize(ep.image, 'w300')) + '" alt="">' : '') +
            '<div class="episode-play">' + STATE_ICONS.play + '</div>' +
          '</div>' +
          '<div class="episode-body">' +
            '<div class="episode-title">' + ep.num + '. ' + esc(ep.title) + '</div>' +
            '<div class="episode-meta">' + esc(formatDuration(ep.duration)) + '</div>' +
            '<div class="episode-plot">' + esc(ep.plot) + '</div>' +
          '</div>';
        var img = el.querySelector('img');
        if (img) img.onerror = function () { if (img.parentNode) img.parentNode.removeChild(img); };
        el._onSelect = function () { Details.playEpisode(ep); };
        row.appendChild(el);
        frag.appendChild(row);
      });
      box.appendChild(frag);
    }
  };

  /* ---------- Configurações ---------- */
  var Settings = {
    render: function () {
      Shelves.list = [];
      var u = State.user || {}, srv = State.server || {}, c = State.categories;
      var rowsEl = $('#rows');
      Scroller.resetY();

      var expTs = parseInt(u.exp_date, 10);
      var expires = expTs ? formatDate(expTs * 1000) : 'Ilimitado';
      var info = [
        ['Usuário', u.username || State.account.username],
        ['Status da conta', STATUS_LABEL[u.status] || u.status || '—'],
        ['Validade', expires],
        ['Conexões', (u.active_cons || 0) + ' de ' + (u.max_connections || '—')],
        ['Servidor', State.account.server.replace(/^https?:\/\//, '')],
        ['Formato ao vivo', State.liveFormat.toUpperCase()],
        ['Fuso horário', srv.timezone || '—'],
        ['Categorias (filmes / séries / TV)', c.vod.length + ' / ' + c.series.length + ' / ' + c.live.length]
      ];

      rowsEl.innerHTML =
        '<div class="settings">' +
          '<h1 class="page-title">Configurações</h1>' +
          '<div class="settings-grid">' +
            info.map(function (p) {
              return '<div class="settings-item"><span class="settings-label">' + esc(p[0]) +
                '</span><span class="settings-value">' + esc(p[1]) + '</span></div>';
            }).join('') +
          '</div>' +
          '<div class="nav-row settings-actions" id="settingsRow1"></div>' +
          '<div class="nav-row settings-actions" id="settingsRow2"></div>' +
          '<div class="nav-row settings-actions" id="settingsRow3"></div>' +
          '<p class="settings-footer">PlayerIPTV v1.0.0 • Navegue com as setas do controle e confirme com OK</p>' +
        '</div>';

      var row1 = $('#settingsRow1'), row2 = $('#settingsRow2');
      row1.appendChild(createButton('Recarregar conteúdo', {
        icon: 'refresh', primary: true,
        action: function () { API.clearCache(); App.boot(); }
      }));
      var playerBtn = createButton(Settings.playerLabel(), {
        icon: 'swap',
        action: function () {
          State.preferNative = !State.preferNative;
          Storage.set('preferNative', State.preferNative);
          playerBtn.querySelector('span').textContent = Settings.playerLabel();
          Toast.show(State.preferNative
            ? 'HLS será reproduzido pelo player nativo da TV'
            : 'HLS será reproduzido pelo hls.js');
        }
      });
      row1.appendChild(playerBtn);
      row1.appendChild(createButton('Modo leve: ' + (State.lite ? 'Ligado' : 'Desligado'), {
        icon: 'swap',
        action: function () {
          Storage.set('lite', !State.lite);
          Toast.show('Reiniciando para aplicar o modo leve…');
          setTimeout(function () { window.location.reload(); }, 800);
        }
      }));
      var row3 = $('#settingsRow3');
      var engineBtn = createButton(Settings.engineLabel(), {
        icon: 'swap',
        action: function () {
          State.engine = State.engine === 'avplay' ? 'html5' : 'avplay';
          Storage.set('engine', State.engine);
          engineBtn.querySelector('span').textContent = Settings.engineLabel();
          Toast.show(State.engine === 'avplay'
            ? 'Vídeo pelo player da Samsung (AVPlay)'
            : 'Vídeo pelo player HTML5 do navegador');
        }
      });
      row3.appendChild(engineBtn);

      row2.appendChild(createButton('Trocar conta', {
        icon: 'user',
        action: function () {
          Storage.set('account', null);   // próxima abertura volta a pedir o login
          Login.show(State.account);
        }
      }));
      row2.appendChild(createButton('Limpar histórico', {
        icon: 'trash',
        action: function () { Resume.clearAll(); Toast.show('Histórico de reprodução apagado'); }
      }));
      row2.appendChild(createButton('Sair do aplicativo', { icon: 'exit', action: function () { App.confirmExit(); } }));
    },

    playerLabel: function () { return 'Player HLS: ' + (State.preferNative ? 'Nativo (Tizen)' : 'hls.js'); },

    engineLabel: function () {
      if (State.engine !== 'avplay') return 'Motor de vídeo: HTML5';
      return 'Motor de vídeo: AVPlay' + (AVP.available() ? ' (Samsung)' : ' (indisponível aqui)');
    }
  };

  /* ======================================================================
     8. PLAYER DE VÍDEO
     ----------------------------------------------------------------------
     • .m3u8 -> hls.js (se suportado) com recuperação de erros; em falha
       fatal cai para o player nativo do Tizen (que também toca HLS).
     • .mp4/.mkv/.ts -> <video> nativo.
     • Ao vivo: ▲▼ / CH± trocam de canal. VOD: ◀▶ avançam/voltam.
     ====================================================================== */
  var Resume = {
    all: function () { return Storage.get('resume', {}) || {}; },
    get: function (key) { return Resume.all()[key] || 0; },
    set: function (key, seconds) {
      var all = Resume.all();
      delete all[key];
      all[key] = Math.floor(seconds);
      var keys = Object.keys(all);
      if (keys.length > 150) delete all[keys[0]];   // descarta o mais antigo
      Storage.set('resume', all);
    },
    clear: function (key) { var all = Resume.all(); delete all[key]; Storage.set('resume', all); },
    clearAll: function () { Storage.set('resume', {}); }
  };

  /* AVPlay: player nativo da Samsung (webapis.avplay). Inicia os streams bem mais
     rápido que o <video> nas TVs Tizen e toca HLS, TS e MKV. O vídeo é desenhado
     num plano atrás da página, na área do <object id="avplayer">. */
  var AVP = {
    token: 0,   // invalida callbacks de streams anteriores (zapping rápido)

    api: function () { return window.webapis && window.webapis.avplay ? window.webapis.avplay : null; },
    available: function () { return !!AVP.api(); },
    state: function () { try { return AVP.api().getState(); } catch (e) { return 'NONE'; } },

    // cb: { onReady, onBuffering(on), onTime, onEnded, onError(msg) }
    start: function (url, startMs, cb) {
      var av = AVP.api();
      AVP.stop();
      var token = ++AVP.token;
      function live() { return token === AVP.token; }
      try {
        av.open(url);
        av.setDisplayRect(0, 0, window.innerWidth || 1920, window.innerHeight || 1080);
        av.setListener({
          onbufferingstart: function () { if (live()) cb.onBuffering(true); },
          onbufferingprogress: function () {},
          onbufferingcomplete: function () { if (live()) cb.onBuffering(false); },
          oncurrentplaytime: function () { if (live()) cb.onTime(); },
          onstreamcompleted: function () { if (live()) cb.onEnded(); },
          onevent: function () {},
          onerror: function (type) { if (live()) cb.onError(String(type)); },
          onsubtitlechange: function () {},
          ondrmevent: function () {}
        });
        av.prepareAsync(function () {
          if (!live()) return;
          try {
            if (startMs) av.seekTo(startMs);
            av.play();
            cb.onReady();
          } catch (e) { cb.onError(e.message || String(e)); }
        }, function (err) {
          if (live()) cb.onError((err && (err.name || err.message)) || 'prepare');
        });
      } catch (e) {
        cb.onError(e.message || String(e));
      }
    },

    stop: function () {
      var av = AVP.api();
      if (!av) return;
      AVP.token++;
      try {
        var st = av.getState();
        if (st === 'PLAYING' || st === 'PAUSED' || st === 'READY') av.stop();
      } catch (e) { /* ignora */ }
      try { av.close(); } catch (e) { /* ignora */ }
    },

    play: function () { try { AVP.api().play(); } catch (e) { /* ignora */ } },
    pause: function () { try { AVP.api().pause(); } catch (e) { /* ignora */ } },
    time: function () { try { return AVP.api().getCurrentTime() / 1000; } catch (e) { return 0; } },
    duration: function () {
      try { var d = AVP.api().getDuration(); return d > 0 ? d / 1000 : NaN; } catch (e) { return NaN; }
    },
    seek: function (sec) { try { AVP.api().seekTo(Math.floor(sec * 1000)); } catch (e) { /* ignora */ } }
  };

  var MEDIA_ERRORS = {
    1: 'A reprodução foi interrompida.',
    2: 'Erro de rede ao carregar o vídeo.',
    3: 'Não foi possível decodificar o vídeo.',
    4: 'Formato não suportado ou stream offline.'
  };

  var Player = {
    session: null,      // { type: live|vod|episode, playlist, index, series, current }
    hls: null,
    osdTimer: null,
    stateTimer: null,
    zapTimer: null,
    seekTimer: null,
    seekTarget: null,
    seekCount: 0,
    pendingIndex: null,
    lastSave: 0,
    engine: 'native',   // avplay | hls | native

    init: function () {
      Player.el = $('#player');
      Player.video = $('#video');
      Player.els = {
        kicker: $('#osdKicker'), title: $('#osdTitle'), subtitle: $('#osdSubtitle'), epg: $('#osdEpg'),
        fill: $('#progressFill'), knob: $('#progressKnob'), current: $('#timeCurrent'), total: $('#timeTotal'),
        hints: $('#osdHints'), state: $('#playerState'), error: $('#playerError'), errorMsg: $('#playerErrorMsg')
      };
      var v = Player.video;
      v.addEventListener('waiting', function () { Player.buffering(true); });
      v.addEventListener('playing', function () { Player.buffering(false); Player.hideError(); });
      v.addEventListener('canplay', function () { Player.buffering(false); });
      v.addEventListener('pause', function () { if (Player.session) Player.showOsd(); });
      v.addEventListener('timeupdate', function () { Player.onTime(); });
      v.addEventListener('loadedmetadata', function () { Player.onMetadata(); });
      v.addEventListener('ended', function () { Player.onEnded(); });
      v.addEventListener('error', function () { Player.onNativeError(); });
    },

    // session: { type, playlist, index, series? }
    open: function (session) {
      Player.session = session;
      Player.el.classList.remove('hidden');
      toggleClass(Player.el, 'is-live', session.type === 'live');
      Player.els.kicker.textContent = session.type === 'live' ? 'TV ao vivo' : (session.type === 'vod' ? 'Filme' : 'Série');
      Player.els.hints.textContent = session.type === 'live'
        ? '▲ ▼  ou  CH ±  Trocar canal   •   OK  Pausar   •   VERMELHO  Favoritar   •   VOLTAR  Sair'
        : '◀ ▶  Voltar/Avançar   •   OK  Play/Pause' +
          (session.type === 'episode' ? '   •   CH ±  Episódio' : '') + '   •   VOLTAR  Sair';
      Nav.openOverlay('player', Player.el);
      TV.screenSaver(false);
      Player.playIndex(session.index);
    },

    close: function () {
      var s = Player.session;
      if (!s) return;
      Player.saveProgress(true);
      Player.session = null;
      clearTimeout(Player.osdTimer);
      clearTimeout(Player.zapTimer);
      clearTimeout(Player.seekTimer);
      Player.pendingIndex = null;
      Player.seekTarget = null;
      Player.destroyEngine();
      Player.el.classList.add('hidden');
      Player.el.classList.remove('osd-visible');
      Player.el.classList.remove('buffering');
      Player.hideError();
      TV.screenSaver(true);
      Nav.closeOverlay();
      // Atualiza o botão "Continuar assistindo" se voltou para os detalhes
      if (Nav.scope === 'details' && Details.item && Details.item.kind === 'vod') {
        Details.renderActions();
        Nav.focus(Details.els.actions.firstChild);
      }
    },

    sourceFor: function (entry) {
      var s = Player.session;
      if (s.type === 'live') {
        return {
          url: API.liveUrl(entry.id), title: entry.name, resumeKey: null,
          subtitle: 'Canal ' + (s.playlist.indexOf(entry) + 1) + ' de ' + s.playlist.length
        };
      }
      if (s.type === 'vod') {
        return {
          url: API.movieUrl(entry.id, entry.ext), title: entry.name, resumeKey: 'vod:' + entry.id,
          subtitle: [entry.year, formatDuration(entry.duration)].filter(Boolean).join('  •  ')
        };
      }
      return {
        url: API.episodeUrl(entry.id, entry.ext), title: s.series.name, resumeKey: 'ep:' + entry.id,
        subtitle: 'T' + entry.season + ':E' + entry.num + '  —  ' + entry.title
      };
    },

    playIndex: function (index) {
      var s = Player.session;
      if (!s || index < 0 || index >= s.playlist.length) return;
      Player.saveProgress(true);
      s.index = index;
      var entry = s.playlist[index];
      s.current = Player.sourceFor(entry);
      s.current.triedTs = false;
      s.current.resumed = false;
      Player.renderInfo(s.current);
      Player.hideError();
      Player.updateProgress(0);
      Player.load(s.current.url);
      Player.showOsd();
      if (s.type === 'live') Player.loadEpg(entry);
    },

    renderInfo: function (src) {
      Player.els.title.textContent = src.title;
      Player.els.subtitle.textContent = src.subtitle || '';
      Player.els.epg.innerHTML = '';
    },

    loadEpg: function (entry) {
      API.getShortEpg(entry.id).then(function (data) {
        var s = Player.session;
        if (!s || s.playlist[s.index] !== entry) return;
        entry.epg = Model.epg(data);
        Player.els.epg.innerHTML = entry.epg.length ? epgHtml(entry.epg) : '';
      })['catch'](function () {});
    },

    /* ----- Motores de reprodução ----- */
    load: function (url) {
      Player.destroyEngine();
      Player.buffering(true);
      // 1º AVPlay (Samsung); 2º hls.js para .m3u8; 3º <video> nativo
      if (State.engine === 'avplay' && AVP.available()) { Player.loadAvplay(url); return; }
      var isHls = /\.m3u8(\?|$)/i.test(url);
      if (isHls && !State.preferNative && window.Hls && window.Hls.isSupported()) Player.loadHls(url);
      else Player.loadNative(url);
    },

    loadHls: function (url) {
      var Hls = window.Hls;
      var hls = new Hls({
        maxBufferLength: 30,          // buffer moderado: TVs têm pouca memória
        maxMaxBufferLength: 60,
        backBufferLength: 30,
        manifestLoadingMaxRetry: 3,
        levelLoadingMaxRetry: 3,
        fragLoadingMaxRetry: 4
      });
      var networkRetries = 0, mediaRetries = 0;
      Player.engine = 'hls';
      Player.hls = hls;

      hls.on(Hls.Events.MANIFEST_PARSED, function () { Player.playSafe(); });
      hls.on(Hls.Events.ERROR, function (event, data) {
        if (!data.fatal) return;
        if (window.console) console.warn('[hls.js] erro fatal', data.type, data.details);
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR && networkRetries < 2) {
          networkRetries++;
          hls.startLoad();
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRetries < 2) {
          mediaRetries++;
          hls.recoverMediaError();
        } else {
          // Último recurso: player nativo do Tizen (suporta HLS)
          Player.destroyEngine();
          Player.loadNative(url);
        }
      });
      hls.loadSource(url);
      hls.attachMedia(Player.video);
    },

    loadAvplay: function (url) {
      var s = Player.session;
      var startMs = 0;
      Player.engine = 'avplay';
      // Retomada: o AVPlay recebe a posição já no início da reprodução
      if (s && s.current && s.current.resumeKey && !s.current.resumed) {
        s.current.resumed = true;
        var t = Resume.get(s.current.resumeKey);
        if (t > 30) { startMs = t * 1000; Toast.show('Continuando de ' + formatTime(t)); }
      }
      document.documentElement.classList.add('avplay-active');
      AVP.start(url, startMs, {
        onReady: function () { Player.buffering(false); Player.hideError(); },
        onBuffering: function (on) { Player.buffering(on); },
        onTime: function () { Player.onTime(); },
        onEnded: function () { Player.onEnded(); },
        onError: function (msg) { Player.onAvplayError(url, msg); }
      });
    },

    // AVPlay falhou neste conteúdo: tenta o player HTML5 com a mesma URL
    onAvplayError: function (url, msg) {
      if (window.console) console.warn('[AVPlay]', msg);
      var s = Player.session;
      if (!s) return;
      if (!s.current.triedHtml5) {
        s.current.triedHtml5 = true;
        AVP.stop();
        document.documentElement.classList.remove('avplay-active');
        Player.loadNative(url);
        return;
      }
      Player.showError('Não foi possível reproduzir este conteúdo.');
    },

    loadNative: function (url) {
      Player.engine = 'native';
      Player.video.src = url;
      Player.video.load();
      Player.playSafe();
    },

    destroyEngine: function () {
      AVP.stop();
      document.documentElement.classList.remove('avplay-active');
      if (Player.hls) {
        try { Player.hls.destroy(); } catch (e) { /* ignora */ }
        Player.hls = null;
      }
      Player.video.pause();
      Player.video.removeAttribute('src');
      try { Player.video.load(); } catch (e) { /* ignora */ }
    },

    /* ----- Operações independentes do motor (AVPlay ou <video>) ----- */
    isPaused: function () { return Player.engine === 'avplay' ? AVP.state() === 'PAUSED' : Player.video.paused; },
    getTime: function () { return Player.engine === 'avplay' ? AVP.time() : Player.video.currentTime; },
    getDuration: function () { return Player.engine === 'avplay' ? AVP.duration() : Player.video.duration; },
    setTime: function (t) { if (Player.engine === 'avplay') AVP.seek(t); else Player.video.currentTime = t; },
    pauseMedia: function () { if (Player.engine === 'avplay') AVP.pause(); else Player.video.pause(); },

    playSafe: function () {
      if (Player.engine === 'avplay') { AVP.play(); return; }
      var p = Player.video.play();
      if (p && typeof p['catch'] === 'function') p['catch'](function () { /* autoplay bloqueado/abortado */ });
    },

    /* ----- Eventos do <video> ----- */
    onNativeError: function () {
      var s = Player.session;
      if (!s || Player.engine !== 'native' || !Player.video.getAttribute('src')) return;   // hls.js trata os próprios erros
      var err = Player.video.error;
      // Ao vivo: se o HLS falhar no nativo, tenta MPEG-TS
      if (s.type === 'live' && !s.current.triedTs && /\.m3u8$/i.test(s.current.url)) {
        s.current.triedTs = true;
        s.current.url = s.current.url.replace(/\.m3u8$/i, '.ts');
        Player.loadNative(s.current.url);
        return;
      }
      Player.showError(MEDIA_ERRORS[err && err.code] || 'Erro desconhecido na reprodução.');
    },

    onMetadata: function () {
      var s = Player.session;
      if (!s || !s.current || !s.current.resumeKey || s.current.resumed) return;
      s.current.resumed = true;
      var t = Resume.get(s.current.resumeKey), d = Player.video.duration;
      if (t > 30 && (!isFinite(d) || t < d - 60)) {
        Player.video.currentTime = t;
        Toast.show('Continuando de ' + formatTime(t));
      }
    },

    onTime: function () {
      if (!Player.session) return;
      if (Player.seekTarget === null) Player.updateProgress(Player.getTime());
      Player.saveProgress(false);
    },

    onEnded: function () {
      var s = Player.session;
      if (!s) return;
      if (s.current.resumeKey) Resume.clear(s.current.resumeKey);
      s.current.resumeKey = null;
      if (s.type === 'live') { Player.playIndex(s.index); return; }      // queda do stream: reconecta
      if (s.type === 'episode' && s.index < s.playlist.length - 1) {
        Toast.show('Próximo episódio…');
        Player.playIndex(s.index + 1);
        return;
      }
      Player.close();
    },

    saveProgress: function (force) {
      var s = Player.session;
      if (!s || !s.current || !s.current.resumeKey) return;
      var t = Player.getTime();
      if (!(t > 0)) return;
      if (!force && Date.now() - Player.lastSave < 10000) return;
      Player.lastSave = Date.now();
      Resume.set(s.current.resumeKey, t);
    },

    /* ----- Controles ----- */
    handleKey: function (key) {
      var s = Player.session;
      if (!s) return;
      var live = s.type === 'live';

      if (key === 'back' || key === 'stop') { Player.close(); return; }

      // Com erro na tela: OK tenta de novo; no ao vivo ainda dá para trocar de canal
      if (!Player.els.error.classList.contains('hidden')) {
        if (key === 'enter') Player.playIndex(s.index);
        else if (live && (key === 'up' || key === 'chdown')) Player.zap(-1);
        else if (live && (key === 'down' || key === 'chup')) Player.zap(1);
        return;
      }

      switch (key) {
        case 'enter':
        case 'playpause': Player.togglePlay(); break;
        case 'play': Player.playSafe(); Player.flashState('play'); break;
        case 'pause': Player.pauseMedia(); Player.flashState('pause'); break;
        case 'left': if (!live) Player.seek(-1, 1); break;
        case 'right': if (!live) Player.seek(1, 1); break;
        case 'rw': if (!live) Player.seek(-1, 3); break;
        case 'ff': if (!live) Player.seek(1, 3); break;
        case 'up': if (live) Player.zap(-1); break;
        case 'down': if (live) Player.zap(1); break;
        case 'chup': Player.zap(1); break;
        case 'chdown': Player.zap(-1); break;
        case 'red': Player.toggleFavorite(); break;
      }
      Player.showOsd();
    },

    // VERMELHO no player: favorita o canal/filme atual (ou a série do episódio)
    toggleFavorite: function () {
      var s = Player.session;
      if (!s) return;
      Favorites.toggle(s.type === 'episode' ? s.series : s.playlist[s.index]);
    },

    togglePlay: function () {
      if (Player.isPaused()) { Player.playSafe(); Player.flashState('play'); }
      else { Player.pauseMedia(); Player.flashState('pause'); }
    },

    // Acumula toques seguidos e aplica o seek uma vez (com aceleração)
    seek: function (direction, multiplier) {
      var duration = Player.getDuration();
      if (!isFinite(duration) || !duration) return;
      Player.seekCount++;
      var accel = Player.seekCount > 12 ? 6 : (Player.seekCount > 5 ? 3 : 1);
      var base = Player.seekTarget !== null ? Player.seekTarget : Player.getTime();
      Player.seekTarget = Math.max(0, Math.min(duration - 2, base + direction * CONFIG.seekStep * multiplier * accel));
      Player.updateProgress(Player.seekTarget);
      clearTimeout(Player.seekTimer);
      Player.seekTimer = setTimeout(function () {
        if (Player.seekTarget !== null) Player.setTime(Player.seekTarget);
        Player.seekTarget = null;
        Player.seekCount = 0;
      }, 600);
    },

    // Troca de canal/episódio com atraso: permite "pular" vários rapidamente
    zap: function (delta) {
      var s = Player.session;
      if (!s || s.playlist.length < 2) return;
      var i = (Player.pendingIndex !== null ? Player.pendingIndex : s.index) + delta;
      if (s.type === 'live') {
        i = (i + s.playlist.length) % s.playlist.length;        // lista circular
      } else if (i < 0 || i >= s.playlist.length) {
        return;
      }
      Player.pendingIndex = i;
      Player.renderInfo(Player.sourceFor(s.playlist[i]));
      clearTimeout(Player.zapTimer);
      Player.zapTimer = setTimeout(function () {
        var target = Player.pendingIndex;
        Player.pendingIndex = null;
        Player.playIndex(target);
      }, CONFIG.zapDelay);
    },

    /* ----- Interface ----- */
    showOsd: function () {
      Player.el.classList.add('osd-visible');
      clearTimeout(Player.osdTimer);
      Player.osdTimer = setTimeout(function () {
        if (!Player.isPaused()) Player.el.classList.remove('osd-visible');
      }, CONFIG.osdTimeout);
    },

    flashState: function (name) {
      var el = Player.els.state;
      el.innerHTML = STATE_ICONS[name];
      el.classList.add('show');
      clearTimeout(Player.stateTimer);
      Player.stateTimer = setTimeout(function () { el.classList.remove('show'); }, 700);
    },

    buffering: function (on) { toggleClass(Player.el, 'buffering', !!on); },

    updateProgress: function (t) {
      var d = Player.getDuration();
      if (!isFinite(d) || d <= 0) {
        Player.els.fill.style.width = '0%';
        Player.els.knob.style.left = '0%';
        Player.els.current.textContent = formatTime(t);
        Player.els.total.textContent = '--:--';
        return;
      }
      var pct = Math.max(0, Math.min(100, (t / d) * 100));
      Player.els.fill.style.width = pct + '%';
      Player.els.knob.style.left = pct + '%';
      Player.els.current.textContent = formatTime(t);
      Player.els.total.textContent = formatTime(d);
    },

    showError: function (message) {
      Player.buffering(false);
      Player.els.errorMsg.textContent = message;
      Player.els.error.classList.remove('hidden');
      Player.showOsd();
    },

    hideError: function () { Player.els.error.classList.add('hidden'); },

    // App foi para segundo plano (multitarefa do Tizen): pausa
    onHidden: function () {
      if (Player.session) { Player.saveProgress(true); Player.pauseMedia(); }
    }
  };

  /* ======================================================================
     9. APLICAÇÃO
     ====================================================================== */
  var State = {
    account: null,      // { server, username, password } informados no login
    user: null,
    server: null,
    liveFormat: 'm3u8',
    categories: { vod: [], series: [], live: [] },
    page: 'home',
    pageToken: 0,
    preferNative: Storage.get('preferNative', false),
    lite: Storage.get('lite', null),   // null = automático (detectLite)
    engine: Storage.get('engine', 'avplay')   // avplay (Samsung) | html5
  };

  var PAGES = {
    home: { title: 'Início', subtitle: 'Filmes, séries e canais ao vivo em um só lugar.' },
    movies: { title: 'Filmes', subtitle: 'Carregando catálogo de filmes…' },
    series: { title: 'Séries', subtitle: 'Carregando catálogo de séries…' },
    live: { title: 'TV ao Vivo', subtitle: 'Carregando canais…' },
    favorites: { title: 'Minha lista', subtitle: 'Seus filmes, séries e canais favoritos.' },
    search: { title: 'Pesquisar', subtitle: '' }
  };

  var App = {
    scale: 1,

    start: function () {
      if (State.lite === null) State.lite = detectLite();
      if (State.lite) App.applyLite();
      App.applyScale();
      window.addEventListener('resize', App.applyScale);

      TV.registerKeys();
      Sidebar.init();
      Hero.init();
      Details.init();
      Grid.init();
      Dialog.init();
      Login.init();
      Player.init();
      App.bindKeys();

      document.addEventListener('visibilitychange', function () { if (document.hidden) Player.onHidden(); });
      window.addEventListener('offline', function () { Toast.show('Sem conexão com a internet', 5000); });
      window.addEventListener('online', function () { Toast.show('Conexão restabelecida'); });
      // Sem suporte a mouse: cliques não roubam o foco do controle remoto
      document.addEventListener('mousedown', function (e) { e.preventDefault(); }, true);
      // Ao voltar de um popup do sistema, devolve o foco ao elemento atual
      window.addEventListener('focus', function () {
        if (Nav.current && document.body.contains(Nav.current)) Nav.focus(Nav.current);
      });

      // Usa o último acesso salvo; sem ele, abre a tela de login
      App.boot(Storage.get('account', null));
    },

    // Mantém o layout de 1920x1080 em qualquer resolução (ex.: TVs 1280x720)
    applyLite: function () {
      document.body.classList.add('lite');
      CONFIG.maxItemsPerRow = 30;
      CONFIG.rowsPreload = 1;
      CONFIG.eagerImages = 6;
      CONFIG.maxConcurrentRequests = 2;
      CONFIG.heroDebounce = 600;
      CONFIG.apiCacheSize = 20;
      CONFIG.homeRows = { vod: 4, series: 2, live: 2 };
    },

    applyScale: function () {
      App.scale = Math.min(window.innerWidth / CONFIG.baseWidth, window.innerHeight / CONFIG.baseHeight) || 1;
      setTransform($('#app'), App.scale !== 1 ? 'scale(' + App.scale + ')' : '');
    },

    bindKeys: function () {
      var lastMove = 0;
      document.addEventListener('keydown', function (e) {
        // Digitando num campo do login: as teclas vão para o texto
        if (Login.editing) { Login.onEditingKey(e); return; }
        // Página de pesquisa: letras e números digitam direto (teclado do PC ou números do controle)
        if (State.page === 'search' && Nav.scope === 'content') {
          var code = e.keyCode;
          if ((code >= 65 && code <= 90) || (code >= 48 && code <= 57)) {
            e.preventDefault();
            Search.type(String.fromCharCode(code).toLowerCase());
            return;
          }
          if (code === 8 && Search.query) { e.preventDefault(); Search.backspace(); return; }
        }
        var action = KEYMAP[e.keyCode];
        if (!action) return;
        e.preventDefault();
        // Limita a repetição ao segurar a seta (evita travamentos na TV)
        if (ARROWS[action]) {
          // Usa o horário do evento: setas acumuladas enquanto a TV processava são descartadas
          var now = e.timeStamp || Date.now();
          if (now >= lastMove && now - lastMove < (State.lite ? 150 : 70)) return;
          lastMove = now;
        }
        App.handleKey(action);
      });
    },

    handleKey: function (key) {
      if (Nav.scope === 'player') { Player.handleKey(key); return; }
      if (Nav.scope === 'splash') return;
      if (key === 'red') { App.toggleFavoriteFocused(); return; }
      if (Nav.scope === 'grid' && (key === 'chup' || key === 'chdown')) {
        Grid.render(Grid.page + (key === 'chup' ? 1 : -1));
        return;
      }
      if (key === 'back') { App.back(); return; }
      if (key === 'enter') { Nav.select(); return; }
      if (ARROWS[key]) Nav.move(key);
    },

    back: function () {
      var rows, row;
      switch (Nav.scope) {
        case 'login':
          App.confirmExit();
          break;
        case 'dialog':
          if (Dialog.cancelable) Dialog.close();
          break;
        case 'details':
          Details.close();
          break;
        case 'grid':
          Grid.close();
          break;
        case 'sidebar':
          if (State.page !== 'home') App.goTo('home'); else App.confirmExit();
          break;
        case 'content':
          // Volta ao topo; se já estiver no topo, abre o menu
          rows = Nav.rows($('#main'));
          row = Nav.current && Nav.current.closest('.nav-row');
          if (rows.indexOf(row) > 0) Nav.focus(Nav.items(rows[0])[0]);
          else Sidebar.open();
          break;
      }
    },

    // VERMELHO fora do player: favorita o card focado, o destaque do banner ou o título dos detalhes
    toggleFavoriteFocused: function () {
      var el = Nav.current;
      var item = null;
      if (el && el._item) item = el._item;
      else if (Nav.scope === 'details') item = Details.item;
      else if (el && el.closest('#hero')) item = Hero.item;
      if (!item) return;
      Favorites.toggle(item);
      Details.updateFav();
      Hero.updateInfoBtn();
    },

    confirmExit: function () {
      Dialog.show({
        title: 'Sair do PlayerIPTV?',
        message: 'Deseja realmente fechar o aplicativo?',
        buttons: [{ label: 'Sair', icon: 'exit', action: function () { TV.exit(); } }, { label: 'Cancelar' }]
      });
    },

    /* ----- Inicialização: login + categorias ----- */
    // account: { server, username, password }; sem argumento, reusa a conta atual
    boot: function (account) {
      account = account || State.account;
      if (!account || !account.server) { Login.show(null); return; }
      State.account = account;
      API.clearCache();
      Search.reset();
      Splash.show('Validando acesso…');
      API.login()
        .then(function (data) {
          var u = data && data.user_info;
          if (!u || String(u.auth) !== '1') throw new Error('Usuário ou senha inválidos.');
          if (u.status && u.status !== 'Active') {
            throw new Error('A conta está ' + (STATUS_LABEL[u.status] || u.status).toLowerCase() + '.');
          }
          State.user = u;
          State.server = data.server_info || {};
          // Prefere HLS; se o servidor não liberar, usa o primeiro formato permitido (ex.: ts)
          var formats = toList(u.allowed_output_formats);
          State.liveFormat = formats.length && formats.indexOf('m3u8') < 0 ? formats[0] : 'm3u8';

          Splash.status('Carregando categorias…');
          return Promise.all([
            API.getVodCategories()['catch'](function () { return []; }),
            API.getSeriesCategories()['catch'](function () { return []; }),
            API.getLiveCategories()['catch'](function () { return []; })
          ]);
        })
        .then(function (res) {
          State.categories = { vod: res[0], series: res[1], live: res[2] };
          if (!res[0].length && !res[1].length && !res[2].length) {
            throw new Error('Nenhum conteúdo disponível para esta conta.');
          }
          Storage.set('account', account);   // lembra o acesso para as próximas aberturas
          Splash.hide();
          App.goTo('home');
        })['catch'](function (err) {
          if (window.console) console.error('[Boot]', err);
          // Volta ao login com os dados preenchidos e o motivo da falha
          Login.show(account, err && err.message ? err.message : String(err));
        });
    },

    /* ----- Páginas ----- */
    goTo: function (page) {
      document.body.classList.remove('sidebar-open');
      Nav.reset('content');
      Nav.lastContent = null;
      State.page = page;
      State.pageToken++;
      Sidebar.setActive(page);

      if (page === 'settings' || page === 'search') {
        document.body.classList.add('no-hero');
        Hero.placeholder('');
        if (page === 'settings') Settings.render(); else Search.render();
      } else {
        document.body.classList.remove('no-hero');
        Hero.placeholder(PAGES[page].title, PAGES[page].subtitle);
        Shelves.render(App.rowsFor(page), page === 'favorites'
          ? 'Sua lista está vazia. Abra um filme ou série e escolha “Minha lista”, ou aperte o botão VERMELHO do controle sobre um card ou canal.'
          : null);
      }
      Nav.focusFirst();
    },

    // Define as prateleiras de cada página
    rowsFor: function (page) {
      var c = State.categories;
      function vodRow(cat, prefix) {
        return {
          title: (prefix || '') + cat.category_name, kind: 'vod',
          model: Model.vod,
          loader: function () { return API.getVodStreams(cat.category_id); }
        };
      }
      function seriesRow(cat, prefix) {
        return {
          title: (prefix || '') + cat.category_name, kind: 'series',
          model: Model.series,
          loader: function () { return API.getSeries(cat.category_id); }
        };
      }
      function liveRow(cat, prefix) {
        return {
          title: (prefix || '') + cat.category_name, kind: 'live',
          model: Model.live,
          loader: function () { return API.getLiveStreams(cat.category_id); }
        };
      }

      // Minha lista: uma prateleira por tipo, com os itens salvos
      function favRows(prefix) {
        var rows = [];
        [['vod', 'Filmes'], ['series', 'Séries'], ['live', 'Canais']].forEach(function (p) {
          var list = Favorites.byKind(p[0]);
          if (!list.length) return;
          rows.push({
            title: prefix + p[1], kind: p[0], model: same,
            loader: function () { return Promise.resolve(list); }
          });
        });
        return rows;
      }

      if (page === 'favorites') return favRows('');
      if (page === 'movies') return c.vod.map(function (cat) { return vodRow(cat); });
      if (page === 'series') return c.series.map(function (cat) { return seriesRow(cat); });
      if (page === 'live') return c.live.map(function (cat) { return liveRow(cat); });

      // Início: categorias de lançamentos primeiro, intercalando filmes, séries e TV
      var featured = /lan[cç]amento|novidade|recente|estreia|cinema|new|\b20[2-3]\d\b/i;
      function prioritize(list) {
        return list.filter(function (x) { return featured.test(x.category_name); })
          .concat(list.filter(function (x) { return !featured.test(x.category_name); }));
      }

      var queues = {
        vod: prioritize(c.vod).slice(0, CONFIG.homeRows.vod).map(function (cat) { return vodRow(cat); }),
        series: prioritize(c.series).slice(0, CONFIG.homeRows.series).map(function (cat) { return seriesRow(cat, 'Séries • '); }),
        live: c.live.slice(0, CONFIG.homeRows.live).map(function (cat) { return liveRow(cat, 'Ao vivo • '); })
      };
      var order = ['vod', 'series', 'vod', 'live'];
      var rows = [];
      var i = 0;
      while (queues.vod.length || queues.series.length || queues.live.length) {
        var q = queues[order[i % order.length]];
        i++;
        if (q.length) rows.push(q.shift());
      }
      return favRows('Minha lista • ').concat(rows);
    },

    /* ----- Ações de conteúdo ----- */
    // OK num card: canal toca direto; filme/série abre os detalhes
    select: function (item, ctx) {
      if (item.kind === 'live') App.play(item, ctx);
      else Details.open(item);
    },

    play: function (item, ctx) {
      if (!item) return;
      if (item.kind === 'live') {
        var list = ctx && ctx.list ? ctx.list : [item];
        var index = ctx && ctx.list ? Math.max(0, list.indexOf(item)) : 0;
        Player.open({ type: 'live', playlist: list, index: index });
      } else if (item.kind === 'vod') {
        Player.open({ type: 'vod', playlist: [item], index: 0 });
      } else if (item.kind === 'series') {
        Toast.show('Carregando episódios…');
        API.getSeriesInfo(item.id).then(function (data) {
          var all = [].concat.apply([], Model.seasons(data).map(function (s) { return s.episodes; }));
          if (!all.length) { Toast.show('Nenhum episódio disponível'); return; }
          App.playEpisodes(item, all, 0);
        })['catch'](function () { Toast.show('Não foi possível carregar os episódios'); });
      }
    },

    playEpisodes: function (series, episodes, index) {
      Player.open({ type: 'episode', series: series, playlist: episodes, index: index });
    }
  };

  // Inicia quando o DOM estiver pronto (ou imediatamente, se carregado pelo loader da VPS)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { App.start(); });
  } else {
    App.start();
  }
})();
