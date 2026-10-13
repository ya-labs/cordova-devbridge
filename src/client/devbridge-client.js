/* cordova-devbridge client — injetado só no modo dev pelo servidor do PC. */
(function () {
  'use strict';
  if (window.__devbridge) return;

  var base = '/__devbridge';
  var clientId = Math.random().toString(36).slice(2, 10);
  var serverBoot = null;
  var keepRoute = true;
  var deviceReady = false;
  var openedDbs = {};
  var logQueue = [];
  var logTimer = null;
  var original = {};

  // Avisa o servidor: só o WebView do app dispara deviceready, uma aba do PC não.
  document.addEventListener('deviceready', function () {
    deviceReady = true;
    post('/state', { client: clientId, href: location.href, ready: true });
    startRestore();
  }, false);

  // ---- reload com volta à tela --------------------------------------------
  // Antes do reload, a rota e o que o app quiser guardar (save do hook de
  // __devbridge.restore) vão para o sessionStorage. Depois do deviceready, o
  // hook do app refaz o que precisar (login, banco) e volta para a tela.
  // Enquanto isso, uma camada avisa que o app está recarregando.
  var RELOAD_KEY = 'devbridge.reload';
  var RESTORE_TIMEOUT = 30000;
  var restoreHook = null;
  var restoreTimer = null;
  var pending = readPending();
  var overlay = null;
  var overlayLabel = null;
  var overlayText = null;

  function readPending() {
    try {
      var raw = window.sessionStorage && sessionStorage.getItem(RELOAD_KEY);
      if (!raw) return null;
      // Uma tentativa só: se o boot quebrar, o próximo reload não repete a restauração.
      sessionStorage.removeItem(RELOAD_KEY);
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }

  function savePending() {
    var saved = { hash: location.hash || '', at: Date.now() };
    if (restoreHook && typeof restoreHook.save === 'function') {
      try {
        saved.app = restoreHook.save();
      } catch (e) {
        pushLog('warn', ['[devbridge] save do reloadRestore falhou:', e]);
      }
    }
    try {
      sessionStorage.setItem(RELOAD_KEY, JSON.stringify(saved));
    } catch (e) {
      // sem sessionStorage o reload só não volta para a tela
    }
  }

  function renderOverlay() {
    if (overlayText === null) {
      if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
      overlay = null;
      return;
    }
    if (!document.body) return;
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = '__devbridge_overlay';
      overlay.setAttribute('style', 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483647;' +
        'display:flex;align-items:center;justify-content:center;background:rgba(10,14,20,.55);' +
        'font:600 15px/1.4 system-ui,sans-serif;color:#fff');
      overlay.innerHTML = '<style>@keyframes __devbridge_spin{to{transform:rotate(360deg)}}</style>' +
        '<div style="display:flex;align-items:center;padding:12px 18px;border-radius:999px;background:#1d2430;box-shadow:0 4px 18px rgba(0,0,0,.35)">' +
        '<span style="width:16px;height:16px;margin-right:10px;border:3px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:__devbridge_spin .8s linear infinite"></span>' +
        '<span></span></div>';
      overlayLabel = overlay.getElementsByTagName('span')[1];
      document.body.appendChild(overlay);
    }
    overlayLabel.textContent = overlayText;
  }

  function showOverlay(text) {
    overlayText = text;
    renderOverlay();
  }

  function hideOverlay() {
    overlayText = null;
    renderOverlay();
  }

  document.addEventListener('DOMContentLoaded', renderOverlay, false);

  function finishRestore(err) {
    if (!pending) return;
    pending = null;
    clearTimeout(restoreTimer);
    hideOverlay();
    if (err) pushLog('warn', ['[devbridge] o reload não voltou para a tela: ' + err]);
  }

  function startRestore() {
    if (!pending) return;
    if (!restoreHook || typeof restoreHook.restore !== 'function') return finishRestore();
    restoreTimer = setTimeout(function () {
      finishRestore('tempo esgotado (' + RESTORE_TIMEOUT / 1000 + ' s)');
    }, RESTORE_TIMEOUT);
    try {
      restoreHook.restore(pending, function (err) { finishRestore(err); });
    } catch (e) {
      finishRestore(e.message || String(e));
    }
  }

  // Espera cond() ficar verdadeira; para hooks de restauração que dependem do boot do app.
  function waitFor(cond, cb, timeout) {
    var limit = timeout || 20000;
    var waited = 0;
    (function tick() {
      var ok = false;
      try { ok = cond(); } catch (e) { ok = false; }
      if (ok) return cb(null);
      waited += 100;
      if (waited >= limit) return cb('esperou ' + limit / 1000 + ' s pelo app');
      setTimeout(tick, 100);
    })();
  }

  if (pending) showOverlay('Recarregando' + (pending.hash ? ' · voltando para ' + pending.hash.replace(/^#!?\/?/, '') : '') + '…');

  function post(path, body) {
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', base + path, true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.send(JSON.stringify(body));
    } catch (e) {
      // servidor fora do ar: nada a fazer
    }
  }

  // ---- logs -------------------------------------------------------------
  function serialize(value, seen) {
    if (value instanceof Error) return value.stack || (value.name + ': ' + value.message);
    if (value === undefined) return 'undefined';
    if (typeof value === 'string') return value;
    if (typeof value === 'function') return '[function ' + (value.name || 'anon') + ']';
    if (value === null || typeof value !== 'object') return String(value);
    try {
      seen = seen || [];
      return JSON.stringify(value, function (k, v) {
        if (v && typeof v === 'object') {
          if (seen.indexOf(v) >= 0) return '[circular]';
          seen.push(v);
        }
        return v;
      });
    } catch (e) {
      return Object.prototype.toString.call(value);
    }
  }

  function pushLog(level, args) {
    var parts = [];
    for (var i = 0; i < args.length; i++) parts.push(serialize(args[i]));
    var msg = parts.join(' ');
    if (msg.length > 4000) msg = msg.slice(0, 4000) + '… [+' + (msg.length - 4000) + ' chars]';
    logQueue.push({ level: level, msg: msg, ts: Date.now(), href: location.hash || location.pathname });
    if (logQueue.length > 500) logQueue.splice(0, logQueue.length - 500);
    if (!logTimer) logTimer = setTimeout(flushLogs, 250);
  }

  function flushLogs() {
    logTimer = null;
    if (!logQueue.length) return;
    var batch = logQueue.splice(0, logQueue.length);
    post('/log', { client: clientId, entries: batch });
  }

  ['log', 'info', 'warn', 'error', 'debug'].forEach(function (level) {
    original[level] = console[level] ? console[level].bind(console) : function () {};
    console[level] = function () {
      try { pushLog(level, arguments); } catch (e) { /* nunca quebrar o app */ }
      return original[level].apply(null, arguments);
    };
  });

  window.addEventListener('error', function (ev) {
    // O stack já traz a posição; sem ele, monta arquivo:linha:coluna.
    if (ev.error && ev.error.stack) return pushLog('error', [ev.error]);
    var where = ev.filename ? ' em (' + ev.filename.replace(location.origin, '') + ':' + ev.lineno + ':' + ev.colno + ')' : '';
    pushLog('error', [ev.message + where]);
  });
  window.addEventListener('unhandledrejection', function (ev) {
    pushLog('error', ['Promise rejeitada sem tratamento:', ev.reason]);
  });
  window.addEventListener('hashchange', function () {
    post('/state', { client: clientId, href: location.href });
  });

  // ---- SQLite -----------------------------------------------------------
  function whenReady(cb) {
    if (window.sqlitePlugin) return cb(null);
    var waited = 0;
    var timer = setInterval(function () {
      waited += 200;
      if (window.sqlitePlugin) { clearInterval(timer); cb(null); }
      else if (waited >= 10000) {
        clearInterval(timer);
        cb(deviceReady ? 'window.sqlitePlugin não existe (plugin SQLite não instalado?)' : 'deviceready não disparou em 10 s');
      }
    }, 200);
  }

  function getDb(spec, cb) {
    var handle = spec.global && window[spec.global];
    if (handle && typeof handle.executeSql === 'function') return cb(null, handle, spec.global);
    if (!spec.name || spec.name.indexOf('*') >= 0) {
      return cb({ code: 'GLOBAL_CLOSED', message: 'A conexão "' + spec.global + '" ainda não está aberta no app.' });
    }
    whenReady(function (err) {
      if (err) return cb({ message: err });
      if (!openedDbs[spec.name]) {
        openedDbs[spec.name] = window.sqlitePlugin.openDatabase({ name: spec.name, location: 'default' });
      }
      cb(null, openedDbs[spec.name], spec.name);
    });
  }

  function toResult(rs, maxRows, write) {
    var rows = [];
    var total = rs && rs.rows ? rs.rows.length : 0;
    var limit = Math.min(total, maxRows);
    for (var i = 0; i < limit; i++) rows.push(rs.rows.item(i));
    var columns = rows.length ? Object.keys(rows[0]) : [];
    var out = { columns: columns, rows: rows, rowCount: total, truncated: total > limit };
    if (write) {
      out.rowsAffected = rs.rowsAffected;
      if (rs.insertId !== undefined) out.insertId = rs.insertId;
    }
    return out;
  }

  // Leitura vai em readTransaction: o plugin recusa escrita ali, segunda
  // barreira além do filtro do servidor.
  function runSql(req, reply) {
    getDb(req.db, function (err, db, label) {
      if (err) return reply(false, null, err.message, err.code);
      var result = null;
      var failure = null;
      var started = Date.now();
      var method = req.write ? 'transaction' : (db.readTransaction ? 'readTransaction' : 'transaction');
      db[method](function (tx) {
        tx.executeSql(req.sql, req.params || [], function (tx2, rs) {
          result = rs;
        }, function (tx2, e) {
          failure = e;
          return true; // desfaz a transação
        });
      }, function (e) {
        var f = failure || e || {};
        reply(false, null, f.message || String(f), f.code);
      }, function () {
        if (failure) return reply(false, null, failure.message || String(failure), failure.code);
        var out = toResult(result, req.maxRows || 1000, req.write);
        out.database = label;
        out.ms = Date.now() - started;
        reply(true, out);
      });
    });
  }

  // ---- canal com o servidor --------------------------------------------
  function replyFor(id) {
    return function (ok, result, error, code) {
      post('/reply', { client: clientId, id: id, ok: ok, result: result, error: error, code: code });
    };
  }

  function swapCss(paths) {
    var links = document.querySelectorAll('link[rel="stylesheet"]');
    var swapped = 0;
    for (var i = 0; i < links.length; i++) {
      var a = document.createElement('a');
      a.href = links[i].href;
      var p = decodeURIComponent(a.pathname).replace(/^\/+/, '');
      for (var j = 0; j < paths.length; j++) {
        if (p === paths[j]) {
          links[i].href = '/' + p + '?devbridge=' + Date.now();
          swapped++;
        }
      }
    }
    return swapped;
  }

  // Sem keepRoute o reload volta à rota inicial, como uma abertura nova do app:
  // há apps cujo boot (deviceready, abrir o SQLite) só acontece nela.
  function reloadApp() {
    flushLogs();
    showOverlay('Recarregando…');
    savePending();
    if (!keepRoute && location.hash && window.history && history.replaceState) {
      history.replaceState(null, '', location.pathname + (location.search || ''));
    }
    location.reload();
  }

  function connect() {
    var url = base + '/events?client=' + clientId +
      '&href=' + encodeURIComponent(location.href) +
      '&ua=' + encodeURIComponent(navigator.userAgent);
    var es = new EventSource(url);

    es.addEventListener('hello', function (ev) {
      var data = JSON.parse(ev.data);
      keepRoute = data.reloadKeepRoute !== false;
      // Servidor reiniciou enquanto estávamos desconectados: arquivos podem ter mudado.
      if (serverBoot && serverBoot !== data.boot) return reloadApp();
      serverBoot = data.boot;
    });
    es.addEventListener('reload', reloadApp);
    es.addEventListener('css', function (ev) {
      var paths = JSON.parse(ev.data).paths;
      if (!swapCss(paths)) reloadApp();
    });
    es.addEventListener('sql', function (ev) {
      var req = JSON.parse(ev.data);
      try {
        runSql(req, replyFor(req.id));
      } catch (e) {
        replyFor(req.id)(false, null, e.message || String(e));
      }
    });
    es.addEventListener('status', function (ev) {
      var req = JSON.parse(ev.data);
      var globals = {};
      (req.globals || []).forEach(function (g) {
        globals[g] = !!(window[g] && typeof window[g].executeSql === 'function');
      });
      replyFor(req.id)(true, {
        href: location.href,
        deviceReady: deviceReady,
        sqlitePlugin: !!window.sqlitePlugin,
        globals: globals,
      });
    });
  }

  window.__devbridge = {
    client: clientId,
    flushLogs: flushLogs,
    // O script do reloadRestore registra { save: fn() -> dados, restore: fn(salvo, done) }.
    restore: function (hook) { restoreHook = hook; },
    waitFor: waitFor,
    overlayText: function () { return overlayText; },
  };
  connect();
})();
