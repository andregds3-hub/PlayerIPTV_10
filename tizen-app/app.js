/* ==========================================================================
   PlayerIPTV — app.js
   Aplicativo IPTV (API Xtream Codes) para Samsung Smart TV (Tizen Web App).

   Compatibilidade: ES2015 "conservador" (sem async/await, optional chaining,
   destructuring ou parâmetros padrão) para rodar no Chromium 47+ das TVs
   Tizen 3.0+ (modelos 2017 em diante).

   Módulos deste arquivo:
     1. Configuração             7. Componentes de UI (Toast, Dialog, Splash,
     2. Utilitários                 Sidebar, Hero, Cards, Prateleiras,
     3. API Xtream Codes            Detalhes, Configurações)
     4. Modelos de dados         8. Player de vídeo (hls.js + player nativo)
     5. Navegação espacial       9. Aplicação (páginas, teclas, inicialização)
     6. Teclas / APIs da TV
   ========================================================================== */
(function () {
  'use strict';

  /* ======================================================================
     1. CONFIGURAÇÃO
     ====================================================================== */
  const CONFIG = {
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
    zapDelay: 700,               // atraso para trocar de canal (zapping rápido)
    baseWidth: 1920,             // resolução de projeto
    baseHeight: 1080
  };

  /* ======================================================================
     2. UTILITÁRIOS
     ====================================================================== */
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.prototype.slice.call((root || document).querySelectorAll(sel));

  const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  // Escapa texto vindo da API antes de inserir em innerHTML
  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, c => HTML_ESCAPES[c]);
  }

  function debounce(fn, wait) {
    let timer = null;
    return function () {
      const args = arguments, ctx = this;
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(ctx, args), wait);
    };
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  // 3725 -> "1:02:05"
  function formatTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    sec = Math.floor(sec);
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return (h ? h + ':' + pad2(m) : m) + ':' + pad2(s);
  }

  // Timestamp Unix (segundos) -> "HH:MM"
  function formatClock(ts) {
    if (!isFinite(ts) || !ts) return '';
    const d = new Date(ts * 1000);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function formatDate(ms) {
    const d = new Date(ms);
    return pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1) + '/' + d.getFullYear();
  }

  // "01:52:00" -> "1h 52min" (outros formatos são mantidos)
  function formatDuration(value) {
    const str = String(value || '').trim();
    const m = str.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (!m) return str;
    const h = parseInt(m[1], 10), min = parseInt(m[2], 10);
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

  // A API às vezes devolve objeto no lugar de array
  function toList(data) {
    if (!data) return [];
    if (Array.isArray(data)) return data;
    if (typeof data === 'object') return Object.keys(data).map(k => data[k]);
    return [];
  }

  function firstOf(value) {
    if (Array.isArray(value)) return value[0] || '';
    return value || '';
  }

  function extractYear(value) {
    const m = String(value || '').match(/\b(19|20)\d{2}\b/);
    return m ? m[0] : '';
  }

  // Normaliza a nota para escala 0–10
  function parseRating(rating, rating5) {
    let n = parseFloat(rating);
    if (!(n > 0)) {
      const n5 = parseFloat(rating5);
      n = n5 > 0 ? n5 * 2 : 0;
    }
    if (n > 10) n = n / 10;
    return n > 0 ? n.toFixed(1) : '';
  }

  function cssUrl(url) {
    return 'url("' + String(url).replace(/["\\\n\r]/g, encodeURIComponent) + '")';
  }

  // Persistência simples (preferências e progresso de reprodução)
  const Storage = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem('iptv.' + key);
        return v === null ? fallback : JSON.parse(v);
      } catch (e) { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem('iptv.' + key, JSON.stringify(value)); } catch (e) { /* cota cheia */ }
    }
  };

  /* ======================================================================
     3. API XTREAM CODES
     ====================================================================== */
  const API = {
    cache: {},
    queue: [],
    active: 0,

    // Monta a URL: {server}/player_api.php?username=...&password=...&action=...
    url(params) {
      const q = [
        'username=' + encodeURIComponent(State.account.username),
        'password=' + encodeURIComponent(State.account.password)
      ];
      Object.keys(params || {}).forEach(k => {
        q.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
      });
      return State.account.server + '/player_api.php?' + q.join('&');
    },

    // Fila com limite de concorrência para não sobrecarregar a TV
    schedule(task) {
      return new Promise((resolve, reject) => {
        this.queue.push({ task: task, resolve: resolve, reject: reject });
        this.next();
      });
    },

    next() {
      if (this.active >= CONFIG.maxConcurrentRequests || !this.queue.length) return;
      const job = this.queue.shift();
      this.active++;
      job.task()
        .then(job.resolve, job.reject)
        .then(() => { this.active--; this.next(); });
    },

    // GET com timeout e parse de JSON
    fetchJson(url) {
      return new Promise((resolve, reject) => {
        let done = false;
        const finish = (err, data) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          if (err) reject(err); else resolve(data);
        };
        const timer = setTimeout(() => finish(new Error('O servidor demorou demais para responder.')), CONFIG.requestTimeout);

        fetch(url, { method: 'GET', credentials: 'omit' })
          .then(res => {
            if (res.status === 404) {
              throw new Error('O endereço ' + State.account.server + ' não respondeu como um servidor Xtream (HTTP 404). ' +
                'Confira a URL e a porta informadas pelo provedor (ex.: http://dominio:8080).');
            }
            if (!res.ok) throw new Error('O servidor respondeu com erro HTTP ' + res.status + '.');
            return res.text();
          })
          .then(text => {
            try { return JSON.parse(text); } catch (e) { throw new Error('Resposta inválida do servidor.'); }
          })
          .then(data => finish(null, data), err => {
            // "Failed to fetch" = rede indisponível ou bloqueio de CORS/acesso
            if (err instanceof TypeError) {
              err = new Error('Falha de rede ao acessar ' + State.account.server +
                '. Verifique a URL/porta, a conexão com a internet e se o servidor está no ar.');
            }
            finish(err);
          });
      });
    },

    // Requisição com cache em memória (e deduplicação de chamadas iguais)
    get(params) {
      const key = JSON.stringify(params);
      if (this.cache[key]) return this.cache[key];
      const p = this.schedule(() => this.fetchJson(this.url(params)));
      this.cache[key] = p;
      p.catch(() => { delete this.cache[key]; });
      return p;
    },

    clearCache() { this.cache = {}; },

    // Valida o acesso: retorna { user_info, server_info }
    login() { return this.fetchJson(this.url({})); },

    getVodCategories() { return this.get({ action: 'get_vod_categories' }).then(toList); },
    getVodStreams(categoryId) { return this.get({ action: 'get_vod_streams', category_id: categoryId }).then(toList); },
    getVodInfo(vodId) { return this.get({ action: 'get_vod_info', vod_id: vodId }); },

    getSeriesCategories() { return this.get({ action: 'get_series_categories' }).then(toList); },
    getSeries(categoryId) { return this.get({ action: 'get_series', category_id: categoryId }).then(toList); },
    getSeriesInfo(seriesId) { return this.get({ action: 'get_series_info', series_id: seriesId }); },

    getLiveCategories() { return this.get({ action: 'get_live_categories' }).then(toList); },
    getLiveStreams(categoryId) { return this.get({ action: 'get_live_streams', category_id: categoryId }).then(toList); },

    // EPG muda com o tempo: sem cache
    getShortEpg(streamId) {
      return this.schedule(() => this.fetchJson(this.url({ action: 'get_short_epg', stream_id: streamId, limit: 3 })));
    },

    // URLs de reprodução no padrão Xtream Codes
    credentialsPath() {
      return encodeURIComponent(State.account.username) + '/' + encodeURIComponent(State.account.password);
    },
    liveUrl(streamId) {
      return State.account.server + '/live/' + this.credentialsPath() + '/' + streamId + '.' + State.liveFormat;
    },
    movieUrl(streamId, ext) {
      return State.account.server + '/movie/' + this.credentialsPath() + '/' + streamId + '.' + (ext || 'mp4');
    },
    episodeUrl(episodeId, ext) {
      return State.account.server + '/series/' + this.credentialsPath() + '/' + episodeId + '.' + (ext || 'mp4');
    }
  };

  /* ======================================================================
     4. MODELOS DE DADOS (normalizam as respostas da API)
     ====================================================================== */
  const KIND_LABEL = { vod: 'Filme', series: 'Série', live: 'Ao vivo' };
  const STATUS_LABEL = { Active: 'Ativa', Expired: 'Expirada', Banned: 'Bloqueada', Disabled: 'Desativada' };

  function infoOf(data) {
    const info = data && data.info;
    return info && typeof info === 'object' && !Array.isArray(info) ? info : {};
  }

  const Model = {
    vod(raw) {
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

    series(raw) {
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

    live(raw) {
      return {
        kind: 'live',
        id: raw.stream_id,
        name: raw.name || 'Canal',
        poster: raw.stream_icon || '',
        epg: null
      };
    },

    // Completa um filme com get_vod_info (sinopse, elenco, backdrop...)
    enrichVod(item, data) {
      const info = infoOf(data);
      item.plot = info.plot || info.description || item.plot;
      item.genre = info.genre || item.genre;
      item.cast = info.cast || info.actors || item.cast || '';
      item.director = info.director || item.director || '';
      item.duration = info.duration || item.duration || '';
      item.year = extractYear(info.releasedate || info.release_date || info.year) || item.year;
      item.rating = parseRating(info.rating) || item.rating;
      const backdrop = firstOf(info.backdrop_path);
      if (backdrop) item.backdrop = backdrop;
      if (!item.poster) item.poster = info.movie_image || info.cover_big || '';
      const movie = data && data.movie_data;
      if (movie && movie.container_extension) item.ext = movie.container_extension;
      item.enriched = true;
    },

    enrichSeries(item, data) {
      const info = infoOf(data);
      item.plot = info.plot || item.plot;
      item.genre = info.genre || item.genre;
      item.cast = info.cast || item.cast;
      item.director = info.director || item.director;
      item.rating = parseRating(info.rating, info.rating_5based) || item.rating;
      item.year = extractYear(info.releaseDate || info.release_date) || item.year;
      const backdrop = firstOf(info.backdrop_path);
      if (backdrop) item.backdrop = backdrop;
      if (!item.poster) item.poster = info.cover || '';
    },

    episode(raw, season) {
      const info = infoOf(raw);
      const num = parseInt(raw.episode_num, 10) || 0;
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
    seasons(data) {
      const eps = data && data.episodes;
      if (!eps) return [];
      const groups = {};
      const add = (key, list) => {
        const n = parseInt(key, 10) || 0;
        groups[n] = (groups[n] || []).concat(list);
      };
      if (Array.isArray(eps)) {
        // Alguns servidores devolvem array de arrays
        eps.forEach((list, i) => {
          toList(Array.isArray(list) ? list : [list]).forEach(ep => add(ep && ep.season ? ep.season : i + 1, [ep]));
        });
      } else {
        Object.keys(eps).forEach(k => add(k, toList(eps[k])));
      }
      return Object.keys(groups)
        .map(k => parseInt(k, 10))
        .sort((a, b) => a - b)
        .map(n => ({
          number: n,
          episodes: groups[n].filter(Boolean).map(ep => Model.episode(ep, n)).sort((a, b) => a.num - b.num)
        }))
        .filter(s => s.episodes.length > 0);
    },

    // get_short_epg -> [{ title, start, end }] (só programas atuais/futuros)
    epg(data) {
      const now = Date.now() / 1000;
      return toList(data && data.epg_listings)
        .map(e => ({
          title: decodeBase64(e.title),
          start: parseInt(e.start_timestamp, 10) || Date.parse(e.start) / 1000,
          end: parseInt(e.stop_timestamp, 10) || Date.parse(e.end || e.stop) / 1000
        }))
        .filter(e => e.title && (!isFinite(e.end) || e.end > now))
        .slice(0, 2);
    }
  };

  // Linha de metadados (nota, ano, duração, gênero)
  function buildMeta(item) {
    const parts = [];
    if (item.kind === 'live') parts.push('<span class="badge badge--live">● AO VIVO</span>');
    if (item.rating) parts.push('<span class="rating">★ ' + esc(item.rating) + '</span>');
    if (item.year) parts.push('<span>' + esc(item.year) + '</span>');
    if (item.duration) parts.push('<span>' + esc(formatDuration(item.duration)) + '</span>');
    if (item.genre) {
      const genres = String(item.genre).split(/[,/|]/).map(g => g.trim()).filter(Boolean).slice(0, 3);
      if (genres.length) parts.push('<span>' + esc(genres.join(' • ')) + '</span>');
    }
    return parts.join('');
  }

  function epgHtml(epg) {
    if (!epg) return 'Carregando programação…';
    if (!epg.length) return 'Programação indisponível para este canal.';
    const now = epg[0], next = epg[1];
    let html = '<strong>Agora:</strong> ' + esc(now.title) +
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
     O "escopo" define qual área recebe as teclas: content, sidebar,
     details, dialog, player ou splash.
     ====================================================================== */
  const Nav = {
    scope: 'splash',
    current: null,
    lastContent: null,
    stack: [],      // escopos sobrepostos (detalhes, diálogo, player)
    roots: { login: 'login', content: 'main', sidebar: 'sidebar', details: 'details', dialog: 'dialog', player: 'player' },

    root() { return document.getElementById(this.roots[this.scope]) || document.body; },

    isFocusable(el) {
      return !!el && el.classList.contains('focusable') && el.getClientRects().length > 0;
    },

    rows(root) {
      return $$('.nav-row', root || this.root())
        .filter(r => r.getClientRects().length > 0 && !!r.querySelector('.focusable'));
    },

    items(row) {
      return row ? $$('.focusable', row).filter(el => this.isFocusable(el)) : [];
    },

    focus(el) {
      if (!el) return;
      if (this.current && this.current !== el) this.current.classList.remove('focused');
      this.current = el;
      el.classList.add('focused');
      // preventScroll não existe nas TVs antigas: a rolagem nativa é desfeita em Scroller.fix
      try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); }
      Scroller.fix(el);

      const row = el.closest('.nav-row');
      if (row) row.setAttribute('data-last', Array.prototype.indexOf.call(row.querySelectorAll('.focusable'), el));

      Scroller.reveal(el);
      if (this.scope === 'content') this.lastContent = el;
      if (typeof el._onFocus === 'function') el._onFocus(el);
    },

    focusFirst() {
      const rows = this.rows();
      if (rows.length) this.focus(this.items(rows[0])[0]);
    },

    move(dir) {
      if (this.scope === 'sidebar') { Sidebar.move(dir); return; }
      const root = this.root();
      const cur = this.current && root.contains(this.current) ? this.current : null;
      if (!cur) { this.focusFirst(); return; }

      const row = cur.closest('.nav-row');
      if (dir === 'left' || dir === 'right') {
        const items = this.items(row);
        const next = items[items.indexOf(cur) + (dir === 'left' ? -1 : 1)];
        if (next) this.focus(next); else this.edge(dir);
        return;
      }

      const rows = this.rows(root);
      const target = rows[rows.indexOf(row) + (dir === 'up' ? -1 : 1)];
      if (target) this.focus(this.pickInRow(target, cur)); else this.edge(dir);
    },

    // Escolhe o item de destino ao trocar de linha
    pickInRow(row, from) {
      const items = this.items(row);
      if (!items.length) return null;
      if (row.hasAttribute('data-remember')) {
        const last = parseInt(row.getAttribute('data-last'), 10) || 0;
        return items[Math.min(last, items.length - 1)];
      }
      const fr = from.getBoundingClientRect();
      const cx = fr.left + fr.width / 2;
      let best = items[0], bestDist = Infinity;
      items.forEach(el => {
        const r = el.getBoundingClientRect();
        const d = Math.abs(r.left + r.width / 2 - cx);
        if (d < bestDist) { bestDist = d; best = el; }
      });
      return best;
    },

    // Chegou na borda: ◀ no primeiro item do conteúdo abre o menu lateral
    edge(dir) {
      if (this.scope === 'content' && dir === 'left') Sidebar.open();
    },

    select() {
      const el = this.current;
      if (el && typeof el._onSelect === 'function') el._onSelect(el);
    },

    openOverlay(scope, el) {
      this.stack.push({ scope: this.scope, focus: this.current });
      this.scope = scope;
      if (el) this.focus(el);
    },

    closeOverlay() {
      const prev = this.stack.pop();
      if (!prev) return;
      this.scope = prev.scope;
      if (prev.focus && document.body.contains(prev.focus)) this.focus(prev.focus);
      else if (this.scope === 'content') this.focusFirst();
    },

    reset(scope) {
      this.stack = [];
      this.scope = scope;
    }
  };

  /* Rolagem controlada por transform (mais fluida que scroll nativo na TV) */
  const Scroller = {
    // Desfaz a rolagem que o navegador aplica sozinho ao focar elementos
    fix(el) {
      let node = el.parentNode;
      while (node && node.nodeType === 1) {
        if (node.scrollLeft) node.scrollLeft = 0;
        if (node.scrollTop && !node.classList.contains('scroll-y')) node.scrollTop = 0;
        node = node.parentNode;
      }
      if (window.pageXOffset || window.pageYOffset) window.scrollTo(0, 0);
    },

    reveal(el) {
      const track = el.closest('.row-track');
      if (track) this.horizontal(track, el);
      const box = el.closest('.scroll-y');
      if (box) this.ensureVisibleY(box, el);
      if (Nav.scope === 'content' && $('#main').contains(el)) this.vertical(el);
    },

    // Mantém o card focado na primeira posição visível da prateleira
    horizontal(track, el) {
      const cards = track.children;
      if (!cards.length) return;
      const viewportW = track.parentNode.clientWidth;
      const first = cards[0], last = cards[cards.length - 1];
      const maxOffset = Math.max(0, last.offsetLeft + last.offsetWidth - viewportW + 60);
      const offset = Math.min(Math.max(0, el.offsetLeft - first.offsetLeft), maxOffset);
      track.style.transform = 'translate3d(' + (-offset) + 'px,0,0)';

      // Pré-carrega as capas dos próximos cards
      const idx = Array.prototype.indexOf.call(cards, el);
      for (let i = idx; i >= 0 && i < Math.min(cards.length, idx + CONFIG.eagerImages); i++) {
        LazyImages.loadIn(cards[i]);
      }
    },

    // A prateleira focada sobe para o topo da área de prateleiras
    vertical(el) {
      const rowsEl = $('#rows');
      const shelf = el.closest('.shelf');
      const y = shelf && rowsEl.contains(shelf) ? shelf.offsetTop : 0;
      rowsEl.style.transform = 'translate3d(0,' + (-y) + 'px,0)';
      Shelves.ensureLoadedAround(shelf);
    },

    // Lista vertical (episódios): rola o mínimo para mostrar o item
    ensureVisibleY(box, el) {
      const margin = 16;
      const br = box.getBoundingClientRect(), er = el.getBoundingClientRect();
      if (er.top < br.top + margin) box.scrollTop -= (br.top + margin - er.top) / App.scale;
      else if (er.bottom > br.bottom - margin) box.scrollTop += (er.bottom - br.bottom + margin) / App.scale;
    }
  };

  /* Carregamento sob demanda das capas (data-src -> src) */
  const LazyImages = {
    load(img) {
      const src = img.getAttribute('data-src');
      if (!src) return;
      img.removeAttribute('data-src');
      img.src = src;
    },
    loadIn(node) {
      const img = node.querySelector('img[data-src]');
      if (img) this.load(img);
    },
    eager(container, count) {
      $$('img[data-src]', container).slice(0, count).forEach(img => this.load(img));
    }
  };

  /* ======================================================================
     6. TECLAS DO CONTROLE REMOTO / APIs DA TV
     ====================================================================== */
  // keyCode -> ação. Inclui teclas de teclado para testar no navegador.
  const KEYMAP = {
    37: 'left', 38: 'up', 39: 'right', 40: 'down',
    13: 'enter',
    10009: 'back',              // RETURN do controle Samsung
    8: 'back', 27: 'back',      // Backspace / Esc (navegador)
    415: 'play', 19: 'pause', 10252: 'playpause', 413: 'stop',
    417: 'ff', 412: 'rw',
    427: 'chup', 428: 'chdown',
    32: 'playpause',            // Espaço (navegador)
    33: 'chup', 34: 'chdown'    // PageUp / PageDown (navegador)
  };
  const ARROWS = { left: true, right: true, up: true, down: true };

  // Teclas de mídia precisam ser registradas no Tizen para chegarem ao app
  const TIZEN_KEYS = {
    MediaPlayPause: 'playpause', MediaPlay: 'play', MediaPause: 'pause', MediaStop: 'stop',
    MediaFastForward: 'ff', MediaRewind: 'rw', ChannelUp: 'chup', ChannelDown: 'chdown'
  };

  const TV = {
    isTizen: !!(window.tizen && window.tizen.tvinputdevice),

    registerKeys() {
      if (!this.isTizen) return;
      Object.keys(TIZEN_KEYS).forEach(name => {
        try {
          window.tizen.tvinputdevice.registerKey(name);
          const key = window.tizen.tvinputdevice.getKey(name);
          if (key && key.code) KEYMAP[key.code] = TIZEN_KEYS[name];
        } catch (e) {
          console.warn('[TV] Tecla não registrada: ' + name, e);
        }
      });
    },

    // Evita o protetor de tela durante a reprodução
    screenSaver(enabled) {
      try {
        const ac = window.webapis && window.webapis.appcommon;
        if (!ac) return;
        ac.setScreenSaver(enabled
          ? ac.AppCommonScreenSaverState.SCREEN_SAVER_ON
          : ac.AppCommonScreenSaverState.SCREEN_SAVER_OFF);
      } catch (e) { /* indisponível fora da TV */ }
    },

    exit() {
      try { window.tizen.application.getCurrentApplication().exit(); } catch (e) { window.close(); }
    }
  };

  /* ======================================================================
     7. COMPONENTES DE UI
     ====================================================================== */
  const ICONS = {
    play: '<svg class="btn-icon" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
    back: '<svg class="btn-icon" viewBox="0 0 24 24"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20z"/></svg>',
    refresh: '<svg class="btn-icon" viewBox="0 0 24 24"><path d="M17.65 6.35A7.95 7.95 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4z"/></svg>',
    swap: '<svg class="btn-icon" viewBox="0 0 24 24"><path d="M6.99 11L3 15l3.99 4v-3H14v-2H6.99zM21 9l-3.99-4v3H10v2h7.01v3z"/></svg>',
    trash: '<svg class="btn-icon" viewBox="0 0 24 24"><path d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6zM19 4h-3.5l-1-1h-5l-1 1H5v2h14z"/></svg>',
    exit: '<svg class="btn-icon" viewBox="0 0 24 24"><path d="M10.09 15.59L11.5 17l5-5-5-5-1.41 1.41L12.67 11H3v2h9.67zM19 3H5a2 2 0 0 0-2 2v4h2V5h14v14H5v-4H3v4a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z"/></svg>',
    user: '<svg class="btn-icon" viewBox="0 0 24 24"><path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>'
  };
  const STATE_ICONS = {
    play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><path d="M6 19h4V5H6zm8-14v14h4V5z"/></svg>'
  };

  function createButton(label, opts) {
    const btn = document.createElement('div');
    btn.className = 'btn focusable' + (opts.primary ? ' btn--primary' : '');
    btn.tabIndex = -1;
    btn.innerHTML = (opts.icon ? ICONS[opts.icon] : '') + '<span>' + esc(label) + '</span>';
    btn._onSelect = opts.action;
    return btn;
  }

  /* ---------- Toast ---------- */
  const Toast = {
    timer: null,
    show(message, ms) {
      const el = $('#toast');
      el.textContent = message;
      el.classList.add('visible');
      clearTimeout(this.timer);
      this.timer = setTimeout(() => el.classList.remove('visible'), ms || 3000);
    }
  };

  /* ---------- Diálogo modal (erros e confirmações) ---------- */
  const Dialog = {
    cancelable: true,

    init() {
      this.el = $('#dialog');
      this.title = $('#dialogTitle');
      this.message = $('#dialogMessage');
      this.actions = $('#dialogActions');
    },

    // opts: { title, message, buttons: [{ label, icon, action }], cancelable }
    show(opts) {
      if (Nav.scope === 'dialog') this.close();
      this.cancelable = opts.cancelable !== false;
      this.title.textContent = opts.title || '';
      this.message.textContent = opts.message || '';
      this.actions.innerHTML = '';
      (opts.buttons || [{ label: 'OK' }]).forEach((b, i) => {
        this.actions.appendChild(createButton(b.label, {
          primary: i === 0,
          icon: b.icon,
          action: () => { this.close(); if (b.action) b.action(); }
        }));
      });
      this.el.classList.remove('hidden');
      Nav.openOverlay('dialog', this.actions.firstChild);
    },

    close() {
      if (this.el.classList.contains('hidden')) return;
      this.el.classList.add('hidden');
      Nav.closeOverlay();
    }
  };

  /* ---------- Splash ---------- */
  const Splash = {
    show(status) {
      $('#splash').classList.remove('is-hidden');
      Nav.reset('splash');
      this.status(status);
    },
    status(text) { $('#splashStatus').textContent = text || ''; },
    hide() { $('#splash').classList.add('is-hidden'); }
  };

  /* ---------- Login (URL/DNS, usuário e senha) ----------
     Cada campo é um wrapper .field navegável. OK abre a edição: o <input>
     recebe o foco e o Tizen exibe o teclado virtual (IME). Concluído/OK
     avança para o próximo campo; Cancelar/VOLTAR ou ▲▼ encerram a edição.
     Enquanto edita, letras, números, apagar e ◀ ▶ vão direto para o campo. */
  const IME_DONE = 65376, IME_CANCEL = 65385;   // teclas do teclado virtual do Tizen

  function safeDecode(value) {
    try { return decodeURIComponent(value); } catch (e) { return value; }
  }

  const Login = {
    editing: null,     // .field em edição

    init() {
      this.el = $('#login');
      this.inputs = { server: $('#loginServer'), username: $('#loginUser'), password: $('#loginPass') };
      this.error = $('#loginError');
      this.submitBtn = $('#loginSubmit');
      this.fields = $$('.field', this.el);
      this.fields.forEach(field => {
        const input = $('input', field);
        field._onSelect = () => this.edit(field);
        // O teclado da TV pode fechar sozinho (o input perde o foco)
        input.addEventListener('blur', () => { if (this.editing === field) this.stopEditing(false); });
      });
      this.submitBtn._onSelect = () => this.submit();
      $('#loginExit')._onSelect = () => App.confirmExit();
    },

    // account: dados para pré-preencher; message: erro da tentativa anterior
    show(account, message) {
      const a = account || {};
      Splash.hide();
      this.el.classList.remove('hidden');
      Nav.reset('login');
      this.inputs.server.value = a.server || '';
      this.inputs.username.value = a.username || '';
      this.inputs.password.value = a.password || '';
      this.setError(message);
      // Foca o primeiro campo vazio; se tudo estiver preenchido, o botão Entrar
      const empty = this.fields.filter(f => !$('input', f).value)[0];
      Nav.focus(empty || this.submitBtn);
    },

    hide() {
      this.stopEditing(false);
      this.el.classList.add('hidden');
    },

    setError(message) {
      this.error.textContent = message || '';
      this.error.classList.toggle('hidden', !message);
    },

    edit(field) {
      const input = $('input', field);
      this.editing = field;
      field.classList.add('editing');
      input.focus();
      try { input.setSelectionRange(input.value.length, input.value.length); } catch (e) { /* ignora */ }
    },

    stopEditing(advance) {
      const field = this.editing;
      if (!field) return;
      this.editing = null;
      field.classList.remove('editing');
      if (field.getAttribute('data-field') === 'server') this.applyServerInput();

      if (!advance) { Nav.focus(field); return; }   // tira o foco do input e fecha o teclado
      const next = this.fields[this.fields.indexOf(field) + 1];
      if (next && !$('input', next).value) { Nav.focus(next); this.edit(next); }
      else Nav.focus(this.submitBtn);
    },

    onEditingKey(e) {
      const code = e.keyCode;
      if (code === 13 || code === IME_DONE) {
        e.preventDefault();
        this.stopEditing(true);
      } else if (code === IME_CANCEL || code === 10009 || code === 27) {
        e.preventDefault();
        this.stopEditing(false);
      } else if (code === 38 || code === 40) {
        e.preventDefault();
        this.stopEditing(false);
        Nav.move(code === 38 ? 'up' : 'down');
      }
    },

    /* Aceita "dominio.com:8080", "http://dominio.com:8080/" ou o link M3U
       completo (get.php?username=...&password=...): nesse caso preenche
       usuário e senha automaticamente. */
    parseServer(raw) {
      let s = String(raw || '').trim();
      if (!s) return { server: '', username: '', password: '' };
      const user = s.match(/[?&]username=([^&#]+)/i);
      const pass = s.match(/[?&]password=([^&#]+)/i);
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

    applyServerInput() {
      const parsed = this.parseServer(this.inputs.server.value);
      this.inputs.server.value = parsed.server;
      if (parsed.username) this.inputs.username.value = parsed.username;
      if (parsed.password) this.inputs.password.value = parsed.password;
    },

    submit() {
      this.applyServerInput();
      const account = {
        server: this.inputs.server.value.trim(),
        username: this.inputs.username.value.trim(),
        password: this.inputs.password.value
      };
      if (!/^https?:\/\/[^\/\s]+/i.test(account.server)) {
        this.setError('Informe a URL do servidor (ex.: http://servidor.com:8080).');
        Nav.focus(this.fields[0]);
        return;
      }
      if (!account.username || !account.password) {
        this.setError('Informe o usuário e a senha.');
        Nav.focus(this.fields[account.username ? 2 : 1]);
        return;
      }
      this.hide();
      App.boot(account);
    }
  };

  /* ---------- Menu lateral retrátil ---------- */
  const Sidebar = {
    init() {
      this.items = $$('.menu-item', $('#sidebar'));
      this.items.forEach(item => {
        item._onSelect = () => App.goTo(item.getAttribute('data-page'));
      });
    },

    open() {
      Nav.scope = 'sidebar';
      document.body.classList.add('sidebar-open');
      Nav.focus($('.menu-item.active') || this.items[0]);
    },

    close() {
      document.body.classList.remove('sidebar-open');
      Nav.scope = 'content';
      const last = Nav.lastContent;
      if (last && document.body.contains(last) && Nav.isFocusable(last)) Nav.focus(last);
      else Nav.focusFirst();
    },

    move(dir) {
      const i = this.items.indexOf(Nav.current);
      if (dir === 'up' && i > 0) Nav.focus(this.items[i - 1]);
      else if (dir === 'down' && i < this.items.length - 1) Nav.focus(this.items[i + 1]);
      else if (dir === 'right') this.close();
    },

    setActive(page) {
      this.items.forEach(item => item.classList.toggle('active', item.getAttribute('data-page') === page));
    }
  };

  /* ---------- Hero Banner ---------- */
  const Hero = {
    item: null,
    ctx: null,
    token: 0,
    layer: 0,
    bgKey: null,

    init() {
      this.els = {
        kicker: $('#heroKicker'), title: $('#heroTitle'), meta: $('#heroMeta'),
        plot: $('#heroPlot'), logo: $('#heroLogo'), play: $('#heroPlay'), info: $('#heroInfo')
      };
      this.layers = [$('#heroLayerA'), $('#heroLayerB')];
      this.els.logo.onerror = () => this.els.logo.classList.add('hidden');

      this.els.play._onSelect = () => { if (this.item) App.play(this.item, this.ctx); };
      this.els.info._onSelect = () => { if (this.item) App.select(this.item, this.ctx); };

      // Atualiza o banner só quando o usuário "para" num card
      this.debounced = debounce((item, ctx, pageToken) => {
        if (pageToken === State.pageToken && item !== this.item) this.set(item, ctx);
      }, CONFIG.heroDebounce);
    },

    schedule(item, ctx) { this.debounced(item, ctx, State.pageToken); },

    placeholder(title, subtitle) {
      this.item = null;
      this.ctx = null;
      this.token++;
      this.els.kicker.textContent = 'PlayerIPTV';
      this.els.title.textContent = title || '';
      this.els.meta.innerHTML = '';
      this.els.plot.textContent = subtitle || 'Carregando conteúdo…';
      this.els.logo.classList.add('hidden');
      this.setBackdrop('');
    },

    set(item, ctx) {
      this.item = item;
      this.ctx = ctx || null;
      const token = ++this.token;
      this.render();

      // Busca dados extras de forma assíncrona (sinopse/backdrop ou EPG)
      if (item.kind === 'vod' && !item.enriched) {
        API.getVodInfo(item.id).then(data => {
          Model.enrichVod(item, data);
          if (token === this.token) this.render();
        }).catch(() => { item.enriched = true; });
      } else if (item.kind === 'live') {
        API.getShortEpg(item.id).then(data => {
          item.epg = Model.epg(data);
          if (token === this.token) this.render();
        }).catch(() => { item.epg = []; if (token === this.token) this.render(); });
      }
    },

    refresh(item) { if (item === this.item) this.render(); },

    render() {
      const item = this.item, e = this.els, ctx = this.ctx || {};
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
        this.setBackdrop('');
      } else {
        e.plot.textContent = item.plot || '';
        e.logo.classList.add('hidden');
        if (item.backdrop) this.setBackdrop(item.backdrop, false);
        else this.setBackdrop(item.poster, true);
      }
    },

    // Crossfade entre duas camadas, só depois que a imagem carregou
    setBackdrop(url, isPoster) {
      const key = (url || '') + (isPoster ? '#poster' : '');
      if (key === this.bgKey) return;
      this.bgKey = key;

      if (!url) {
        this.layers.forEach(l => l.classList.remove('visible'));
        return;
      }
      const img = new Image();
      img.onload = () => {
        if (this.bgKey !== key) return;
        const next = this.layers[1 - this.layer];
        next.style.backgroundImage = cssUrl(url);
        next.classList.toggle('is-poster', !!isPoster);
        next.classList.add('visible');
        this.layers[this.layer].classList.remove('visible');
        this.layer = 1 - this.layer;
      };
      img.src = url;
    }
  };

  /* ---------- Cards ---------- */
  const Cards = {
    // ctx: { list, index, category } — usado no zapping e no banner
    create(item, ctx) {
      const card = document.createElement('div');
      card.className = 'card focusable ' + (item.kind === 'live' ? 'card--live' : 'card--poster');
      card.tabIndex = -1;
      card.innerHTML =
        '<div class="card-media">' +
          '<div class="card-fallback"><span>' + esc(item.name) + '</span></div>' +
          (item.poster ? '<img class="card-img" alt="" data-src="' + esc(item.poster) + '">' : '') +
        '</div>' +
        '<div class="card-title">' + esc(item.name) + '</div>';

      const img = card.querySelector('img');
      if (img) {
        img.onload = () => img.classList.add('loaded');
        img.onerror = () => { if (img.parentNode) img.parentNode.removeChild(img); };
      }
      card._onFocus = () => Hero.schedule(item, ctx);
      card._onSelect = () => App.select(item, ctx);
      return card;
    },

    skeletons(kind, count) {
      const cls = 'card focusable skeleton ' + (kind === 'live' ? 'card--live' : 'card--poster');
      let html = '';
      for (let i = 0; i < count; i++) {
        html += '<div class="' + cls + '" tabindex="-1"><div class="card-media"></div>' +
          (kind === 'live' ? '<div class="card-title">&nbsp;</div>' : '') + '</div>';
      }
      return html;
    }
  };

  /* ---------- Prateleiras (carrosséis por categoria) ---------- */
  const Shelves = {
    list: [],   // [{ def, el, track, count, state: idle|loading|ready|error|empty }]

    // defs: [{ title, kind, loader: () => Promise<item[]> }]
    render(defs) {
      const rowsEl = $('#rows');
      rowsEl.innerHTML = '';
      rowsEl.style.transform = 'translate3d(0,0,0)';
      const frag = document.createDocumentFragment();
      this.list = defs.map(def => {
        const shelf = this.create(def);
        frag.appendChild(shelf.el);
        return shelf;
      });
      rowsEl.appendChild(frag);
      if (!this.list.length) this.showEmpty();
      this.ensureLoaded(0);
    },

    create(def) {
      const el = document.createElement('section');
      el.className = 'shelf nav-row' + (def.kind === 'live' ? ' shelf--live' : '');
      el.setAttribute('data-remember', '');
      el.innerHTML =
        '<h2 class="shelf-title">' + esc(def.title) + '<span class="shelf-count"></span></h2>' +
        '<div class="shelf-viewport"><div class="row-track"></div></div>';
      const shelf = { def: def, el: el, track: el.querySelector('.row-track'), count: el.querySelector('.shelf-count'), state: 'idle' };
      shelf.track.innerHTML = Cards.skeletons(def.kind, 8);
      return shelf;
    },

    indexOf(el) {
      for (let i = 0; i < this.list.length; i++) if (this.list[i].el === el) return i;
      return -1;
    },

    ensureLoadedAround(shelfEl) {
      this.ensureLoaded(shelfEl ? Math.max(0, this.indexOf(shelfEl)) : 0);
    },

    // Carrega a prateleira atual, a anterior e as próximas N
    ensureLoaded(index) {
      let ahead = 0;
      for (let i = Math.max(0, index - 1); i < this.list.length && ahead <= CONFIG.rowsPreload; i++) {
        const shelf = this.list[i];
        if (shelf.state === 'empty') continue;
        this.load(shelf);
        if (i >= index) ahead++;
      }
    },

    load(shelf) {
      if (shelf.state !== 'idle') return;
      shelf.state = 'loading';
      const token = State.pageToken;
      shelf.def.loader()
        .then(items => {
          if (token !== State.pageToken) return;
          if (!items.length) this.remove(shelf); else this.fill(shelf, items);
        })
        .catch(err => {
          if (token !== State.pageToken) return;
          console.error('[Prateleira] ' + shelf.def.title, err);
          this.fail(shelf);
        });
    },

    focusIndexIn(shelf) {
      const cur = Nav.current;
      if (!cur || !shelf.el.contains(cur)) return -1;
      return Array.prototype.indexOf.call(shelf.track.children, cur);
    },

    fill(shelf, items) {
      const focusedIndex = this.focusIndexIn(shelf);
      const visible = items.slice(0, CONFIG.maxItemsPerRow);
      const frag = document.createDocumentFragment();
      visible.forEach((item, i) => {
        // A lista completa vai no contexto (zapping usa todos os canais)
        frag.appendChild(Cards.create(item, { list: items, index: i, category: shelf.def.title }));
      });
      shelf.track.innerHTML = '';
      shelf.track.appendChild(frag);
      shelf.state = 'ready';
      shelf.count.textContent = items.length > visible.length
        ? visible.length + ' de ' + items.length
        : String(items.length);
      LazyImages.eager(shelf.track, CONFIG.eagerImages);

      // Primeiro conteúdo carregado vira o destaque do banner
      if (!Hero.item) Hero.set(items[0], { list: items, index: 0, category: shelf.def.title });

      // Se o usuário estava no skeleton, mantém o foco na mesma posição
      if (focusedIndex >= 0) {
        const cards = shelf.track.children;
        Nav.focus(cards[Math.min(focusedIndex, cards.length - 1)]);
      }
    },

    fail(shelf) {
      const hadFocus = this.focusIndexIn(shelf) >= 0;
      shelf.state = 'error';
      shelf.track.style.transform = '';
      shelf.track.innerHTML = '';
      const card = document.createElement('div');
      card.className = 'card card--error focusable';
      card.tabIndex = -1;
      card.innerHTML = '<div class="card-media"><div class="card-fallback"><span>Falha ao carregar<br>' +
        '<small>Pressione OK para tentar novamente</small></span></div></div>';
      card._onSelect = () => {
        shelf.state = 'idle';
        shelf.track.innerHTML = Cards.skeletons(shelf.def.kind, 8);
        Nav.focus(shelf.track.children[0]);
        this.load(shelf);
      };
      shelf.track.appendChild(card);
      if (hadFocus) Nav.focus(card);
    },

    // Categoria vazia: some da tela
    remove(shelf) {
      const hadFocus = this.focusIndexIn(shelf) >= 0;
      let target = null;
      if (hadFocus) {
        const rows = Nav.rows($('#main'));
        const i = rows.indexOf(shelf.el);
        target = rows[i + 1] || rows[i - 1] || null;
      }
      shelf.state = 'empty';
      if (shelf.el.parentNode) shelf.el.parentNode.removeChild(shelf.el);

      if (this.list.every(s => s.state === 'empty')) {
        this.showEmpty();
        if (hadFocus) Nav.focusFirst();
        return;
      }
      if (target) Nav.focus(Nav.items(target)[0]);
      else if (Nav.lastContent && document.body.contains(Nav.lastContent)) Scroller.vertical(Nav.lastContent);
      else this.ensureLoaded(0);
    },

    showEmpty() {
      $('#rows').innerHTML = '<div class="empty-state">Nenhum conteúdo disponível nesta seção.</div>';
    }
  };

  /* ---------- Detalhes (filme / série) ---------- */
  const Details = {
    item: null,
    token: 0,
    seasons: [],
    activeSeason: 0,

    init() {
      this.el = $('#details');
      this.els = {
        backdrop: $('#detailsBackdrop'), poster: $('#detailsPoster'), kicker: $('#detailsKicker'),
        title: $('#detailsTitle'), meta: $('#detailsMeta'), plot: $('#detailsPlot'),
        credits: $('#detailsCredits'), actions: $('#detailsActions'),
        seasonsWrap: $('#detailsSeasonsWrap'), seasons: $('#detailsSeasons'), episodes: $('#detailsEpisodes')
      };
      this.els.poster.onerror = () => this.els.poster.classList.add('hidden');
    },

    open(item) {
      const token = ++this.token;
      const e = this.els;
      this.item = item;
      this.seasons = [];
      this.el.classList.toggle('is-series', item.kind === 'series');
      e.seasonsWrap.classList.add('hidden');
      e.seasons.innerHTML = '';
      e.episodes.innerHTML = '';
      e.episodes.classList.toggle('hidden', item.kind !== 'series');
      this.render();
      this.renderActions();
      this.el.classList.remove('hidden');
      Nav.openOverlay('details', e.actions.firstChild);

      if (item.kind === 'vod') {
        API.getVodInfo(item.id).then(data => {
          Model.enrichVod(item, data);
          if (token !== this.token) return;
          this.render();
          Hero.refresh(item);
        }).catch(() => {});
      } else if (item.kind === 'series') {
        e.episodes.innerHTML = '<div class="episodes-loading">Carregando episódios…</div>';
        API.getSeriesInfo(item.id).then(data => {
          if (token !== this.token) return;
          Model.enrichSeries(item, data);
          this.seasons = Model.seasons(data);
          this.render();
          this.renderSeasons();
        }).catch(() => {
          if (token !== this.token) return;
          e.episodes.innerHTML = '<div class="episodes-loading">Não foi possível carregar os episódios.</div>';
        });
      }
    },

    close() {
      this.token++;
      this.el.classList.add('hidden');
      this.els.episodes.innerHTML = '';
      Nav.closeOverlay();
    },

    render() {
      const item = this.item, e = this.els;
      e.kicker.textContent = KIND_LABEL[item.kind];
      e.title.textContent = item.name;
      e.meta.innerHTML = buildMeta(item);
      e.plot.textContent = item.plot || 'Sinopse indisponível.';

      const credits = [];
      if (item.director) credits.push('<strong>Direção:</strong> ' + esc(item.director));
      if (item.cast) credits.push('<strong>Elenco:</strong> ' + esc(item.cast));
      e.credits.innerHTML = credits.join('<br>');

      if (item.poster) {
        if (e.poster.getAttribute('src') !== item.poster) e.poster.src = item.poster;
        e.poster.classList.remove('hidden');
      } else {
        e.poster.classList.add('hidden');
      }
      const bg = item.backdrop || item.poster;
      e.backdrop.style.backgroundImage = bg ? cssUrl(bg) : 'none';
      e.backdrop.classList.toggle('is-poster', !item.backdrop);
    },

    renderActions() {
      const item = this.item, e = this.els;
      e.actions.innerHTML = '';
      let label = 'Assistir';
      if (item.kind === 'vod' && Resume.get('vod:' + item.id) > 30) label = 'Continuar assistindo';
      this.playBtn = createButton(label, { icon: 'play', primary: true, action: () => this.playSelected() });
      e.actions.appendChild(this.playBtn);
      e.actions.appendChild(createButton('Voltar', { icon: 'back', action: () => this.close() }));
    },

    playSelected() {
      const item = this.item;
      if (item.kind === 'vod') { App.play(item); return; }
      const season = this.seasons[this.activeSeason];
      if (!season) { Toast.show('Aguarde, carregando episódios…'); return; }
      this.playEpisode(season.episodes[0]);
    },

    playEpisode(episode) {
      // Playlist com todas as temporadas: o próximo episódio toca automaticamente
      const all = [].concat.apply([], this.seasons.map(s => s.episodes));
      App.playEpisodes(this.item, all, Math.max(0, all.indexOf(episode)));
    },

    renderSeasons() {
      const e = this.els;
      if (!this.seasons.length) {
        e.episodes.innerHTML = '<div class="episodes-loading">Nenhum episódio disponível.</div>';
        return;
      }
      e.seasonsWrap.classList.remove('hidden');
      e.seasons.innerHTML = '';
      e.seasons.style.transform = '';
      // Ao subir/descer até as temporadas, o foco vai para a temporada ativa
      e.seasons.setAttribute('data-remember', '');
      this.seasons.forEach((season, i) => {
        const chip = document.createElement('div');
        chip.className = 'chip focusable';
        chip.tabIndex = -1;
        chip.textContent = 'Temporada ' + season.number;
        chip._onSelect = () => this.selectSeason(i);
        e.seasons.appendChild(chip);
      });
      this.selectSeason(0);
    },

    selectSeason(index) {
      const season = this.seasons[index];
      this.activeSeason = index;
      this.els.seasons.setAttribute('data-last', index);
      $$('.chip', this.els.seasons).forEach((c, j) => c.classList.toggle('active', j === index));
      this.renderEpisodes(season);
      const first = season.episodes[0];
      this.playBtn.querySelector('span').textContent = 'Assistir T' + season.number + ':E' + (first ? first.num : 1);
    },

    renderEpisodes(season) {
      const box = this.els.episodes;
      box.innerHTML = '';
      box.scrollTop = 0;
      const frag = document.createDocumentFragment();
      season.episodes.forEach(ep => {
        const row = document.createElement('div');
        row.className = 'nav-row episode-row';
        const el = document.createElement('div');
        el.className = 'episode focusable';
        el.tabIndex = -1;
        el.innerHTML =
          '<div class="episode-thumb">' +
            (ep.image ? '<img src="' + esc(ep.image) + '" alt="">' : '') +
            '<div class="episode-play">' + STATE_ICONS.play + '</div>' +
          '</div>' +
          '<div class="episode-body">' +
            '<div class="episode-title">' + ep.num + '. ' + esc(ep.title) + '</div>' +
            '<div class="episode-meta">' + esc(formatDuration(ep.duration)) + '</div>' +
            '<div class="episode-plot">' + esc(ep.plot) + '</div>' +
          '</div>';
        const img = el.querySelector('img');
        if (img) img.onerror = () => { if (img.parentNode) img.parentNode.removeChild(img); };
        el._onSelect = () => this.playEpisode(ep);
        row.appendChild(el);
        frag.appendChild(row);
      });
      box.appendChild(frag);
    }
  };

  /* ---------- Configurações ---------- */
  const Settings = {
    render() {
      Shelves.list = [];
      const u = State.user || {}, srv = State.server || {}, c = State.categories;
      const rowsEl = $('#rows');
      rowsEl.style.transform = 'translate3d(0,0,0)';

      const expires = parseInt(u.exp_date, 10) ? formatDate(parseInt(u.exp_date, 10) * 1000) : 'Ilimitado';
      const info = [
        ['Usuário', u.username || State.account.username],
        ['Status da conta', STATUS_LABEL[u.status] || u.status || '—'],
        ['Validade', expires],
        ['Conexões', (u.active_cons || 0) + ' de ' + (u.max_connections || '—')],
        ['Servidor', State.account.server.replace(/^https?:\/\//, '')],
        ['Formato ao vivo', State.liveFormat.toUpperCase()],
        ['Fuso horário', srv.timezone || '—'],
        ['Categorias', c.vod.length + ' filmes • ' + c.series.length + ' séries • ' + c.live.length + ' TV']
      ];

      rowsEl.innerHTML =
        '<div class="settings">' +
          '<h1 class="page-title">Configurações</h1>' +
          '<div class="settings-grid">' +
            info.map(p => '<div class="settings-item"><span class="settings-label">' + esc(p[0]) +
              '</span><span class="settings-value">' + esc(p[1]) + '</span></div>').join('') +
          '</div>' +
          '<div class="nav-row settings-actions" id="settingsRow1"></div>' +
          '<div class="nav-row settings-actions" id="settingsRow2"></div>' +
          '<p class="settings-footer">PlayerIPTV v1.0.0 • Navegue com as setas do controle e confirme com OK</p>' +
        '</div>';

      const row1 = $('#settingsRow1'), row2 = $('#settingsRow2');
      row1.appendChild(createButton('Recarregar conteúdo', {
        icon: 'refresh', primary: true,
        action: () => { API.clearCache(); App.boot(); }
      }));
      const playerBtn = createButton(this.playerLabel(), {
        icon: 'swap',
        action: () => {
          State.preferNative = !State.preferNative;
          Storage.set('preferNative', State.preferNative);
          playerBtn.querySelector('span').textContent = this.playerLabel();
          Toast.show(State.preferNative
            ? 'HLS será reproduzido pelo player nativo da TV'
            : 'HLS será reproduzido pelo hls.js');
        }
      });
      row1.appendChild(playerBtn);
      row2.appendChild(createButton('Trocar conta', {
        icon: 'user',
        action: () => {
          Storage.set('account', null);   // próxima abertura volta a pedir o login
          Login.show(State.account);
        }
      }));
      row2.appendChild(createButton('Limpar histórico', {
        icon: 'trash',
        action: () => { Resume.clearAll(); Toast.show('Histórico de reprodução apagado'); }
      }));
      row2.appendChild(createButton('Sair do aplicativo', { icon: 'exit', action: () => App.confirmExit() }));
    },

    playerLabel() { return 'Player HLS: ' + (State.preferNative ? 'Nativo (Tizen)' : 'hls.js'); }
  };

  /* ======================================================================
     8. PLAYER DE VÍDEO
     ----------------------------------------------------------------------
     • .m3u8 -> hls.js (se suportado) com recuperação de erros; em falha
       fatal cai para o player nativo do Tizen (que também toca HLS).
     • .mp4/.mkv/.ts -> <video> nativo.
     • Ao vivo: ▲▼ / CH± trocam de canal. VOD: ◀▶ avançam/voltam.
     ====================================================================== */
  const Resume = {
    all() { return Storage.get('resume', {}); },
    get(key) { return this.all()[key] || 0; },
    set(key, seconds) {
      const all = this.all();
      delete all[key];
      all[key] = Math.floor(seconds);
      const keys = Object.keys(all);
      if (keys.length > 150) delete all[keys[0]];   // descarta o mais antigo
      Storage.set('resume', all);
    },
    clear(key) { const all = this.all(); delete all[key]; Storage.set('resume', all); },
    clearAll() { Storage.set('resume', {}); }
  };

  const MEDIA_ERRORS = {
    1: 'A reprodução foi interrompida.',
    2: 'Erro de rede ao carregar o vídeo.',
    3: 'Não foi possível decodificar o vídeo.',
    4: 'Formato não suportado ou stream offline.'
  };

  const Player = {
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

    init() {
      this.el = $('#player');
      this.video = $('#video');
      this.els = {
        kicker: $('#osdKicker'), title: $('#osdTitle'), subtitle: $('#osdSubtitle'), epg: $('#osdEpg'),
        fill: $('#progressFill'), knob: $('#progressKnob'), current: $('#timeCurrent'), total: $('#timeTotal'),
        hints: $('#osdHints'), state: $('#playerState'), error: $('#playerError'), errorMsg: $('#playerErrorMsg')
      };
      const v = this.video;
      v.addEventListener('waiting', () => this.buffering(true));
      v.addEventListener('playing', () => { this.buffering(false); this.hideError(); });
      v.addEventListener('canplay', () => this.buffering(false));
      v.addEventListener('pause', () => { if (this.session) this.showOsd(); });
      v.addEventListener('timeupdate', () => this.onTime());
      v.addEventListener('loadedmetadata', () => this.onMetadata());
      v.addEventListener('ended', () => this.onEnded());
      v.addEventListener('error', () => this.onNativeError());
    },

    // session: { type, playlist, index, series? }
    open(session) {
      this.session = session;
      this.el.classList.remove('hidden');
      this.el.classList.toggle('is-live', session.type === 'live');
      this.els.kicker.textContent = session.type === 'live' ? 'TV ao vivo' : (session.type === 'vod' ? 'Filme' : 'Série');
      this.els.hints.textContent = session.type === 'live'
        ? '▲ ▼  ou  CH ±  Trocar canal   •   OK  Pausar   •   VOLTAR  Sair'
        : '◀ ▶  Voltar/Avançar   •   OK  Play/Pause' +
          (session.type === 'episode' ? '   •   CH ±  Episódio' : '') + '   •   VOLTAR  Sair';
      Nav.openOverlay('player', this.el);
      TV.screenSaver(false);
      this.playIndex(session.index);
    },

    close() {
      const s = this.session;
      if (!s) return;
      this.saveProgress(true);
      this.session = null;
      clearTimeout(this.osdTimer);
      clearTimeout(this.zapTimer);
      clearTimeout(this.seekTimer);
      this.pendingIndex = null;
      this.seekTarget = null;
      this.destroyEngine();
      this.el.classList.add('hidden');
      this.el.classList.remove('osd-visible', 'buffering');
      this.hideError();
      TV.screenSaver(true);
      Nav.closeOverlay();
      // Atualiza o botão "Continuar assistindo" se voltou para os detalhes
      if (Nav.scope === 'details' && Details.item && Details.item.kind === 'vod') {
        Details.renderActions();
        Nav.focus(Details.els.actions.firstChild);
      }
    },

    sourceFor(entry) {
      const s = this.session;
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

    playIndex(index) {
      const s = this.session;
      if (!s || index < 0 || index >= s.playlist.length) return;
      this.saveProgress(true);
      s.index = index;
      const entry = s.playlist[index];
      s.current = this.sourceFor(entry);
      s.current.triedTs = false;
      s.current.resumed = false;
      this.renderInfo(s.current);
      this.hideError();
      this.updateProgress(0);
      this.load(s.current.url);
      this.showOsd();
      if (s.type === 'live') this.loadEpg(entry);
    },

    renderInfo(src) {
      this.els.title.textContent = src.title;
      this.els.subtitle.textContent = src.subtitle || '';
      this.els.epg.innerHTML = '';
    },

    loadEpg(entry) {
      API.getShortEpg(entry.id).then(data => {
        const s = this.session;
        if (!s || s.playlist[s.index] !== entry) return;
        entry.epg = Model.epg(data);
        this.els.epg.innerHTML = entry.epg.length ? epgHtml(entry.epg) : '';
      }).catch(() => {});
    },

    /* ----- Motores de reprodução ----- */
    load(url) {
      this.destroyEngine();
      this.buffering(true);
      const isHls = /\.m3u8(\?|$)/i.test(url);
      if (isHls && !State.preferNative && window.Hls && window.Hls.isSupported()) this.loadHls(url);
      else this.loadNative(url);
    },

    loadHls(url) {
      const Hls = window.Hls;
      const hls = new Hls({
        maxBufferLength: 30,          // buffer moderado: TVs têm pouca memória
        maxMaxBufferLength: 60,
        backBufferLength: 30,
        manifestLoadingMaxRetry: 3,
        levelLoadingMaxRetry: 3,
        fragLoadingMaxRetry: 4
      });
      let networkRetries = 0, mediaRetries = 0;
      this.hls = hls;

      hls.on(Hls.Events.MANIFEST_PARSED, () => this.playSafe());
      hls.on(Hls.Events.ERROR, (event, data) => {
        if (!data.fatal) return;
        console.warn('[hls.js] erro fatal', data.type, data.details);
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR && networkRetries < 2) {
          networkRetries++;
          hls.startLoad();
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRetries < 2) {
          mediaRetries++;
          hls.recoverMediaError();
        } else {
          // Último recurso: player nativo do Tizen (suporta HLS)
          this.destroyEngine();
          this.loadNative(url);
        }
      });
      hls.loadSource(url);
      hls.attachMedia(this.video);
    },

    loadNative(url) {
      this.video.src = url;
      this.video.load();
      this.playSafe();
    },

    destroyEngine() {
      if (this.hls) {
        try { this.hls.destroy(); } catch (e) { /* ignora */ }
        this.hls = null;
      }
      this.video.pause();
      this.video.removeAttribute('src');
      try { this.video.load(); } catch (e) { /* ignora */ }
    },

    playSafe() {
      const p = this.video.play();
      if (p && typeof p.catch === 'function') p.catch(() => { /* autoplay bloqueado/abortado */ });
    },

    /* ----- Eventos do <video> ----- */
    onNativeError() {
      const s = this.session;
      if (!s || this.hls || !this.video.getAttribute('src')) return;   // hls.js trata os próprios erros
      const err = this.video.error;
      // Ao vivo: se o HLS falhar no nativo, tenta MPEG-TS
      if (s.type === 'live' && !s.current.triedTs && /\.m3u8$/i.test(s.current.url)) {
        s.current.triedTs = true;
        s.current.url = s.current.url.replace(/\.m3u8$/i, '.ts');
        this.loadNative(s.current.url);
        return;
      }
      this.showError(MEDIA_ERRORS[err && err.code] || 'Erro desconhecido na reprodução.');
    },

    onMetadata() {
      const s = this.session;
      if (!s || !s.current || !s.current.resumeKey || s.current.resumed) return;
      s.current.resumed = true;
      const t = Resume.get(s.current.resumeKey), d = this.video.duration;
      if (t > 30 && (!isFinite(d) || t < d - 60)) {
        this.video.currentTime = t;
        Toast.show('Continuando de ' + formatTime(t));
      }
    },

    onTime() {
      if (!this.session) return;
      if (this.seekTarget === null) this.updateProgress(this.video.currentTime);
      this.saveProgress(false);
    },

    onEnded() {
      const s = this.session;
      if (!s) return;
      if (s.current.resumeKey) Resume.clear(s.current.resumeKey);
      s.current.resumeKey = null;
      if (s.type === 'live') { this.playIndex(s.index); return; }          // queda do stream: reconecta
      if (s.type === 'episode' && s.index < s.playlist.length - 1) {
        Toast.show('Próximo episódio…');
        this.playIndex(s.index + 1);
        return;
      }
      this.close();
    },

    saveProgress(force) {
      const s = this.session;
      if (!s || !s.current || !s.current.resumeKey) return;
      const t = this.video.currentTime;
      if (!(t > 0)) return;
      if (!force && Date.now() - this.lastSave < 10000) return;
      this.lastSave = Date.now();
      Resume.set(s.current.resumeKey, t);
    },

    /* ----- Controles ----- */
    handleKey(key) {
      const s = this.session;
      if (!s) return;
      const live = s.type === 'live';

      if (key === 'back' || key === 'stop') { this.close(); return; }

      // Com erro na tela: OK tenta de novo; no ao vivo ainda dá para trocar de canal
      if (!this.els.error.classList.contains('hidden')) {
        if (key === 'enter') this.playIndex(s.index);
        else if (live && (key === 'up' || key === 'chdown')) this.zap(-1);
        else if (live && (key === 'down' || key === 'chup')) this.zap(1);
        return;
      }

      switch (key) {
        case 'enter':
        case 'playpause': this.togglePlay(); break;
        case 'play': this.playSafe(); this.flashState('play'); break;
        case 'pause': this.video.pause(); this.flashState('pause'); break;
        case 'left': if (!live) this.seek(-1, 1); break;
        case 'right': if (!live) this.seek(1, 1); break;
        case 'rw': if (!live) this.seek(-1, 3); break;
        case 'ff': if (!live) this.seek(1, 3); break;
        case 'up': if (live) this.zap(-1); break;
        case 'down': if (live) this.zap(1); break;
        case 'chup': this.zap(1); break;
        case 'chdown': this.zap(-1); break;
      }
      this.showOsd();
    },

    togglePlay() {
      if (this.video.paused) { this.playSafe(); this.flashState('play'); }
      else { this.video.pause(); this.flashState('pause'); }
    },

    // Acumula toques seguidos e aplica o seek uma vez (com aceleração)
    seek(direction, multiplier) {
      const v = this.video;
      if (!isFinite(v.duration) || !v.duration) return;
      this.seekCount++;
      const accel = this.seekCount > 12 ? 6 : (this.seekCount > 5 ? 3 : 1);
      const base = this.seekTarget !== null ? this.seekTarget : v.currentTime;
      this.seekTarget = Math.max(0, Math.min(v.duration - 2, base + direction * CONFIG.seekStep * multiplier * accel));
      this.updateProgress(this.seekTarget);
      clearTimeout(this.seekTimer);
      this.seekTimer = setTimeout(() => {
        if (this.seekTarget !== null) v.currentTime = this.seekTarget;
        this.seekTarget = null;
        this.seekCount = 0;
      }, 600);
    },

    // Troca de canal/episódio com atraso: permite "pular" vários rapidamente
    zap(delta) {
      const s = this.session;
      if (!s || s.playlist.length < 2) return;
      let i = (this.pendingIndex !== null ? this.pendingIndex : s.index) + delta;
      if (s.type === 'live') {
        i = (i + s.playlist.length) % s.playlist.length;        // lista circular
      } else if (i < 0 || i >= s.playlist.length) {
        return;
      }
      this.pendingIndex = i;
      this.renderInfo(this.sourceFor(s.playlist[i]));
      clearTimeout(this.zapTimer);
      this.zapTimer = setTimeout(() => {
        const target = this.pendingIndex;
        this.pendingIndex = null;
        this.playIndex(target);
      }, CONFIG.zapDelay);
    },

    /* ----- Interface ----- */
    showOsd() {
      this.el.classList.add('osd-visible');
      clearTimeout(this.osdTimer);
      this.osdTimer = setTimeout(() => {
        if (!this.video.paused) this.el.classList.remove('osd-visible');
      }, CONFIG.osdTimeout);
    },

    flashState(name) {
      const el = this.els.state;
      el.innerHTML = STATE_ICONS[name];
      el.classList.add('show');
      clearTimeout(this.stateTimer);
      this.stateTimer = setTimeout(() => el.classList.remove('show'), 700);
    },

    buffering(on) { this.el.classList.toggle('buffering', !!on); },

    updateProgress(t) {
      const d = this.video.duration;
      if (!isFinite(d) || d <= 0) {
        this.els.fill.style.width = '0%';
        this.els.knob.style.left = '0%';
        this.els.current.textContent = formatTime(t);
        this.els.total.textContent = '--:--';
        return;
      }
      const pct = Math.max(0, Math.min(100, (t / d) * 100));
      this.els.fill.style.width = pct + '%';
      this.els.knob.style.left = pct + '%';
      this.els.current.textContent = formatTime(t);
      this.els.total.textContent = formatTime(d);
    },

    showError(message) {
      this.buffering(false);
      this.els.errorMsg.textContent = message;
      this.els.error.classList.remove('hidden');
      this.showOsd();
    },

    hideError() { this.els.error.classList.add('hidden'); },

    // App foi para segundo plano (multitarefa do Tizen): pausa
    onHidden() {
      if (this.session) { this.saveProgress(true); this.video.pause(); }
    }
  };

  /* ======================================================================
     9. APLICAÇÃO
     ====================================================================== */
  const State = {
    account: null,      // { server, username, password } informados no login
    user: null,
    server: null,
    liveFormat: 'm3u8',
    categories: { vod: [], series: [], live: [] },
    page: 'home',
    pageToken: 0,
    preferNative: Storage.get('preferNative', false)
  };

  const PAGES = {
    home: { title: 'Início', subtitle: 'Filmes, séries e canais ao vivo em um só lugar.' },
    movies: { title: 'Filmes', subtitle: 'Carregando catálogo de filmes…' },
    series: { title: 'Séries', subtitle: 'Carregando catálogo de séries…' },
    live: { title: 'TV ao Vivo', subtitle: 'Carregando canais…' }
  };

  const App = {
    scale: 1,

    start() {
      this.applyScale();
      window.addEventListener('resize', () => this.applyScale());

      TV.registerKeys();
      Sidebar.init();
      Hero.init();
      Details.init();
      Dialog.init();
      Login.init();
      Player.init();
      this.bindKeys();

      document.addEventListener('visibilitychange', () => { if (document.hidden) Player.onHidden(); });
      window.addEventListener('offline', () => Toast.show('Sem conexão com a internet', 5000));
      window.addEventListener('online', () => Toast.show('Conexão restabelecida'));
      // Sem suporte a mouse: cliques não roubam o foco do controle remoto
      document.addEventListener('mousedown', e => e.preventDefault(), true);
      // Ao voltar de um popup do sistema, devolve o foco ao elemento atual
      window.addEventListener('focus', () => { if (Nav.current && document.body.contains(Nav.current)) Nav.focus(Nav.current); });

      // Usa o último acesso salvo; sem ele, abre a tela de login
      this.boot(Storage.get('account', null));
    },

    // Mantém o layout de 1920x1080 em qualquer resolução (ex.: TVs 1280x720)
    applyScale() {
      this.scale = Math.min(window.innerWidth / CONFIG.baseWidth, window.innerHeight / CONFIG.baseHeight) || 1;
      $('#app').style.transform = this.scale !== 1 ? 'scale(' + this.scale + ')' : '';
    },

    bindKeys() {
      let lastMove = 0;
      document.addEventListener('keydown', e => {
        // Digitando num campo do login: as teclas vão para o texto
        if (Login.editing) { Login.onEditingKey(e); return; }
        const action = KEYMAP[e.keyCode];
        if (!action) return;
        e.preventDefault();
        // Limita a repetição ao segurar a seta (evita travamentos na TV)
        if (ARROWS[action]) {
          const now = Date.now();
          if (now - lastMove < 70) return;
          lastMove = now;
        }
        this.handleKey(action);
      });
    },

    handleKey(key) {
      if (Nav.scope === 'player') { Player.handleKey(key); return; }
      if (Nav.scope === 'splash') return;
      if (key === 'back') { this.back(); return; }
      if (key === 'enter') { Nav.select(); return; }
      if (ARROWS[key]) Nav.move(key);
    },

    back() {
      switch (Nav.scope) {
        case 'login':
          this.confirmExit();
          break;
        case 'dialog':
          if (Dialog.cancelable) Dialog.close();
          break;
        case 'details':
          Details.close();
          break;
        case 'sidebar':
          if (State.page !== 'home') this.goTo('home'); else this.confirmExit();
          break;
        case 'content': {
          // Volta ao topo; se já estiver no topo, abre o menu
          const rows = Nav.rows($('#main'));
          const row = Nav.current && Nav.current.closest('.nav-row');
          if (rows.indexOf(row) > 0) Nav.focus(Nav.items(rows[0])[0]);
          else Sidebar.open();
          break;
        }
      }
    },

    confirmExit() {
      Dialog.show({
        title: 'Sair do PlayerIPTV?',
        message: 'Deseja realmente fechar o aplicativo?',
        buttons: [{ label: 'Sair', icon: 'exit', action: () => TV.exit() }, { label: 'Cancelar' }]
      });
    },

    /* ----- Inicialização: login + categorias ----- */
    // account: { server, username, password }; sem argumento, reusa a conta atual
    boot(account) {
      account = account || State.account;
      if (!account || !account.server) { Login.show(null); return; }
      State.account = account;
      API.clearCache();
      Splash.show('Validando acesso…');
      API.login()
        .then(data => {
          const u = data && data.user_info;
          if (!u || String(u.auth) !== '1') throw new Error('Usuário ou senha inválidos.');
          if (u.status && u.status !== 'Active') {
            throw new Error('A conta está ' + (STATUS_LABEL[u.status] || u.status).toLowerCase() + '.');
          }
          State.user = u;
          State.server = data.server_info || {};
          // Prefere HLS; se o servidor não liberar, usa o primeiro formato permitido (ex.: ts)
          const formats = toList(u.allowed_output_formats);
          State.liveFormat = formats.length && formats.indexOf('m3u8') < 0 ? formats[0] : 'm3u8';

          Splash.status('Carregando categorias…');
          return Promise.all([
            API.getVodCategories().catch(() => []),
            API.getSeriesCategories().catch(() => []),
            API.getLiveCategories().catch(() => [])
          ]);
        })
        .then(res => {
          State.categories = { vod: res[0], series: res[1], live: res[2] };
          if (!res[0].length && !res[1].length && !res[2].length) {
            throw new Error('Nenhum conteúdo disponível para esta conta.');
          }
          Storage.set('account', account);   // lembra o acesso para as próximas aberturas
          Splash.hide();
          this.goTo('home');
        })
        .catch(err => {
          console.error('[Boot]', err);
          // Volta ao login com os dados preenchidos e o motivo da falha
          Login.show(account, err && err.message ? err.message : String(err));
        });
    },

    /* ----- Páginas ----- */
    goTo(page) {
      document.body.classList.remove('sidebar-open');
      Nav.reset('content');
      Nav.lastContent = null;
      State.page = page;
      State.pageToken++;
      Sidebar.setActive(page);

      if (page === 'settings') {
        document.body.classList.add('no-hero');
        Hero.placeholder('');
        Settings.render();
      } else {
        document.body.classList.remove('no-hero');
        Hero.placeholder(PAGES[page].title, PAGES[page].subtitle);
        Shelves.render(this.rowsFor(page));
      }
      Nav.focusFirst();
    },

    // Define as prateleiras de cada página
    rowsFor(page) {
      const c = State.categories;
      const vodRow = (cat, prefix) => ({
        title: (prefix || '') + cat.category_name, kind: 'vod',
        loader: () => API.getVodStreams(cat.category_id).then(list => list.map(Model.vod))
      });
      const seriesRow = (cat, prefix) => ({
        title: (prefix || '') + cat.category_name, kind: 'series',
        loader: () => API.getSeries(cat.category_id).then(list => list.map(Model.series))
      });
      const liveRow = (cat, prefix) => ({
        title: (prefix || '') + cat.category_name, kind: 'live',
        loader: () => API.getLiveStreams(cat.category_id).then(list => list.map(Model.live))
      });

      if (page === 'movies') return c.vod.map(cat => vodRow(cat));
      if (page === 'series') return c.series.map(cat => seriesRow(cat));
      if (page === 'live') return c.live.map(cat => liveRow(cat));

      // Início: categorias de lançamentos primeiro, intercalando filmes, séries e TV
      const featured = /lan[cç]amento|novidade|recente|estreia|cinema|new|\b20[2-3]\d\b/i;
      const prioritize = list => list.filter(x => featured.test(x.category_name))
        .concat(list.filter(x => !featured.test(x.category_name)));

      const queues = {
        vod: prioritize(c.vod).slice(0, CONFIG.homeRows.vod).map(cat => vodRow(cat)),
        series: prioritize(c.series).slice(0, CONFIG.homeRows.series).map(cat => seriesRow(cat, 'Séries • ')),
        live: c.live.slice(0, CONFIG.homeRows.live).map(cat => liveRow(cat, 'Ao vivo • '))
      };
      const order = ['vod', 'series', 'vod', 'live'];
      const rows = [];
      let i = 0;
      while (queues.vod.length || queues.series.length || queues.live.length) {
        const q = queues[order[i++ % order.length]];
        if (q.length) rows.push(q.shift());
      }
      return rows;
    },

    /* ----- Ações de conteúdo ----- */
    // OK num card: canal toca direto; filme/série abre os detalhes
    select(item, ctx) {
      if (item.kind === 'live') this.play(item, ctx);
      else Details.open(item);
    },

    play(item, ctx) {
      if (!item) return;
      if (item.kind === 'live') {
        const list = ctx && ctx.list ? ctx.list : [item];
        const index = ctx && ctx.list ? Math.max(0, list.indexOf(item)) : 0;
        Player.open({ type: 'live', playlist: list, index: index });
      } else if (item.kind === 'vod') {
        Player.open({ type: 'vod', playlist: [item], index: 0 });
      } else if (item.kind === 'series') {
        Toast.show('Carregando episódios…');
        API.getSeriesInfo(item.id).then(data => {
          const all = [].concat.apply([], Model.seasons(data).map(s => s.episodes));
          if (!all.length) { Toast.show('Nenhum episódio disponível'); return; }
          this.playEpisodes(item, all, 0);
        }).catch(() => Toast.show('Não foi possível carregar os episódios'));
      }
    },

    playEpisodes(series, episodes, index) {
      Player.open({ type: 'episode', series: series, playlist: episodes, index: index });
    }
  };

  // Inicia quando o DOM estiver pronto
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => App.start());
  } else {
    App.start();
  }
})();
