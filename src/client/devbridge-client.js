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
    // cordova.plugin.http só existe depois que o cordova.js carrega os plugins.
    patchAdvancedHttp();
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
      xhr.__dvbOwn = true; // o inspetor de rede não registra o próprio canal
      xhr.open('POST', base + path, true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.send(JSON.stringify(body));
    } catch (e) {
      // servidor fora do ar: nada a fazer
    }
  }

  // ---- logs -------------------------------------------------------------
  // instanceof falha com valores de outro contexto (iframe); o tipo interno não.
  function isError(v) { return v instanceof Error || Object.prototype.toString.call(v) === '[object Error]'; }

  function serialize(value, seen) {
    if (isError(value)) return value.stack || (value.name + ': ' + value.message);
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

  // Cópia JSON dos objetos logados para o console web montar a árvore expansível.
  // Valores que o JSON não representa viram { __dvb: texto }; o limite evita
  // mandar um objeto gigante (ou um nó do DOM) inteiro a cada log.
  var CLONE_LIMIT = 3000;
  var CLONE_DEPTH = 12;

  function cloneArg(value, seen, budget, depth) {
    if (value === null) return null;
    var t = typeof value;
    if (t === 'string' || t === 'boolean') return value;
    if (t === 'number') return isFinite(value) ? value : { __dvb: String(value) };
    if (t === 'undefined') return { __dvb: 'undefined' };
    if (t === 'function') return { __dvb: 'ƒ ' + (value.name || 'anônima') + '()' };
    if (t !== 'object') return { __dvb: String(value) };
    if (isError(value)) return { __dvb: value.stack || (value.name + ': ' + value.message) };
    if (Object.prototype.toString.call(value) === '[object Date]') return { __dvb: isNaN(value) ? 'Invalid Date' : value.toISOString() };
    if (value.nodeType) return { __dvb: '<' + String(value.nodeName || 'node').toLowerCase() + '>' };
    if (seen.indexOf(value) >= 0) return { __dvb: '[circular]' };
    if (++budget.n > CLONE_LIMIT || depth > CLONE_DEPTH) return { __dvb: '…' };
    seen.push(value);
    var out;
    if (Object.prototype.toString.call(value) === '[object Array]') {
      out = [];
      for (var i = 0; i < value.length; i++) out.push(cloneArg(value[i], seen, budget, depth + 1));
    } else {
      out = {};
      var keys = Object.keys(value);
      for (var k = 0; k < keys.length; k++) {
        var v;
        try { v = value[keys[k]]; } catch (e) { v = { __dvb: '[erro ao ler]' }; }
        out[keys[k]] = cloneArg(v, seen, budget, depth + 1);
      }
    }
    seen.pop();
    return out;
  }

  function structuredArgs(args) {
    var any = false;
    var out = [];
    var budget = { n: 0 };
    for (var i = 0; i < args.length; i++) {
      var a = args[i];
      if (a && typeof a === 'object' && !isError(a)) any = true;
      out.push(typeof a === 'string' ? a : cloneArg(a, [], budget, 0));
    }
    return any ? out : null;
  }

  function pushLog(level, args) {
    var parts = [];
    for (var i = 0; i < args.length; i++) parts.push(serialize(args[i]));
    var msg = parts.join(' ');
    if (msg.length > 4000) msg = msg.slice(0, 4000) + '… [+' + (msg.length - 4000) + ' chars]';
    var entry = { level: level, msg: msg, ts: Date.now(), href: location.hash || location.pathname };
    var structured = null;
    try { structured = structuredArgs(args); } catch (e) { structured = null; }
    if (structured) entry.args = structured;
    logQueue.push(entry);
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

  // ---- rede -------------------------------------------------------------
  // Cada chamada do app gera um evento "start" e um "end" (mesmo id), em lote
  // como os logs. O canal do próprio devbridge (/__devbridge/) fica de fora.
  var BODY_LIMIT = 32768;
  var netQueue = [];
  var netTimer = null;
  var netSeq = 0;

  function pushNet(ev) {
    netQueue.push(ev);
    if (netQueue.length > 1000) netQueue.splice(0, netQueue.length - 1000);
    if (!netTimer) netTimer = setTimeout(flushNet, 250);
  }

  function flushNet() {
    netTimer = null;
    if (!netQueue.length) return;
    post('/network', { client: clientId, events: netQueue.splice(0, netQueue.length) });
  }

  function absUrl(u) {
    try { return new URL(String(u), location.href).href; } catch (e) { return String(u); }
  }

  function isOwn(abs) {
    return abs.indexOf(base + '/') === 0 || abs.indexOf(location.origin + base + '/') === 0;
  }

  function typeOf(v) { return Object.prototype.toString.call(v).slice(8, -1); }

  // Corpo como texto, cortado em BODY_LIMIT; binário vira só uma descrição.
  function bodyInfo(b) {
    if (b === undefined || b === null || b === '') return null;
    var text;
    var t = typeOf(b);
    if (typeof b === 'string') text = b;
    else if (t === 'URLSearchParams') text = String(b);
    else if (t === 'FormData') text = '[FormData]';
    else if (t === 'Blob' || t === 'File') return { body: '[' + t + ' ' + b.size + ' bytes]', size: b.size };
    else if (t === 'ArrayBuffer') return { body: '[ArrayBuffer ' + b.byteLength + ' bytes]', size: b.byteLength };
    else if (b.buffer && typeOf(b.buffer) === 'ArrayBuffer') return { body: '[' + t + ' ' + b.byteLength + ' bytes]', size: b.byteLength };
    else if (b.nodeType) text = '[Document]';
    else text = serialize(b);
    var out = { body: text, size: text.length };
    if (text.length > BODY_LIMIT) {
      out.body = text.slice(0, BODY_LIMIT);
      out.truncated = true;
    }
    return out;
  }

  function parseHeaderBlock(raw) {
    var out = {};
    String(raw || '').split(/\r?\n/).forEach(function (line) {
      var i = line.indexOf(':');
      if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    });
    return out;
  }

  function headersObject(h) {
    var out = {};
    if (!h) return out;
    try {
      if (typeof h.forEach === 'function' && typeOf(h) !== 'Array') {
        h.forEach(function (v, k) { out[String(k).toLowerCase()] = String(v); });
      } else if (typeOf(h) === 'Array') {
        for (var i = 0; i < h.length; i++) out[String(h[i][0]).toLowerCase()] = String(h[i][1]);
      } else {
        for (var k in h) if (Object.prototype.hasOwnProperty.call(h, k)) out[k.toLowerCase()] = String(h[k]);
      }
    } catch (e) { /* cabeçalhos ilegíveis ficam vazios */ }
    return out;
  }

  // Devolve o id, ou null se a chamada não deve ser registrada.
  function netStart(via, method, url, headers, body) {
    var abs = absUrl(url);
    if (isOwn(abs)) return null;
    var id = ++netSeq;
    var b = bodyInfo(body);
    pushNet({
      phase: 'start', id: id, via: via, method: String(method || 'GET').toUpperCase(), url: abs,
      local: abs.indexOf(location.origin + '/') === 0, ts: Date.now(), href: location.hash || location.pathname,
      request: { headers: headers || {}, body: b && b.body, size: b ? b.size : 0, truncated: !!(b && b.truncated) },
    });
    return id;
  }

  function netEnd(id, status, statusText, headers, body, error) {
    if (!id) return;
    var b = bodyInfo(body);
    var ev = { phase: 'end', id: id, ts: Date.now(), status: status, statusText: statusText || '' };
    if (error) ev.error = String(error);
    ev.response = { headers: headers || {}, body: b && b.body, size: b ? b.size : 0, truncated: !!(b && b.truncated) };
    pushNet(ev);
  }

  function safe(fn) {
    try { return fn(); } catch (e) { return null; }
  }

  // XHR: patch no prototype preserva instanceof, readyState e os handlers do app.
  (function () {
    var X = window.XMLHttpRequest;
    if (!X || !X.prototype || X.prototype.__dvbNet) return;
    var P = X.prototype;
    var open = P.open;
    var send = P.send;
    var setHeader = P.setRequestHeader;
    P.__dvbNet = true;
    P.open = function (method, url) {
      this.__dvb = { method: method, url: url, headers: {} };
      return open.apply(this, arguments);
    };
    P.setRequestHeader = function (k, v) {
      if (this.__dvb) this.__dvb.headers[String(k).toLowerCase()] = String(v);
      return setHeader.apply(this, arguments);
    };
    P.send = function (body) {
      var xhr = this;
      var info = !xhr.__dvbOwn && xhr.__dvb;
      var id = info && safe(function () { return netStart('xhr', info.method, info.url, info.headers, body); });
      if (id && typeof xhr.addEventListener === 'function') {
        var failure = null;
        var mark = function (why) { return function () { failure = why; }; };
        xhr.addEventListener('error', mark('falha de rede'));
        xhr.addEventListener('abort', mark('abortada'));
        xhr.addEventListener('timeout', mark('tempo esgotado'));
        xhr.addEventListener('loadend', function () {
          safe(function () {
            var rt = xhr.responseType;
            var res = !rt || rt === 'text' ? xhr.responseText : xhr.response;
            netEnd(id, xhr.status, xhr.statusText, parseHeaderBlock(xhr.getAllResponseHeaders()), res, failure);
          });
        });
      }
      return send.apply(this, arguments);
    };
  })();

  // fetch: lê o corpo de um clone, só quando é texto.
  var TEXTUAL = /json|text|xml|javascript|x-www-form-urlencoded/i;
  if (typeof window.fetch === 'function' && !window.fetch.__dvbNet) {
    var origFetch = window.fetch;
    var wrappedFetch = function (input, init) {
      var id = safe(function () {
        var req = typeof input === 'string' ? null : input;
        var url = req && req.url ? req.url : input;
        var method = (init && init.method) || (req && req.method) || 'GET';
        var headers = headersObject((init && init.headers) || (req && req.headers));
        var body = init && init.body !== undefined ? init.body : (req && req.body ? '[corpo do Request]' : null);
        return netStart('fetch', method, url, headers, body);
      });
      var p = origFetch.apply(window, arguments);
      if (!id) return p;
      p.then(function (res) {
        safe(function () {
          var headers = headersObject(res.headers);
          var type = headers['content-type'] || '';
          if (type && !TEXTUAL.test(type)) {
            return netEnd(id, res.status, res.statusText, headers, '[' + type + (headers['content-length'] ? ' ' + headers['content-length'] + ' bytes' : '') + ']');
          }
          res.clone().text().then(function (text) {
            netEnd(id, res.status, res.statusText, headers, text);
          }, function (e) {
            netEnd(id, res.status, res.statusText, headers, null, 'corpo ilegível: ' + (e && e.message));
          });
        });
      }, function (e) {
        netEnd(id, 0, '', {}, null, (e && e.message) || String(e));
      });
      return p;
    };
    wrappedFetch.__dvbNet = true;
    window.fetch = wrappedFetch;
  }

  // cordova-plugin-advanced-http chama o nativo direto, sem XHR. O patch é no
  // próprio objeto (quem guardou a referência também é coberto). post/get/...
  // podem chamar sendRequest por dentro: a profundidade evita registrar duas vezes.
  var HTTP_METHODS = ['sendRequest', 'get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'uploadFile', 'downloadFile'];
  var httpDepth = 0;

  function httpRequestInfo(name, args) {
    var opts = name === 'sendRequest' ? (args[1] || {}) : null;
    if (opts) return { method: opts.method || 'get', headers: opts.headers, body: opts.data !== undefined ? opts.data : opts.params };
    if (name === 'uploadFile') return { method: 'POST', headers: args[2], body: '[upload ' + args[3] + ']' };
    if (name === 'downloadFile') return { method: 'GET', headers: args[2], body: null };
    var withBody = name === 'post' || name === 'put' || name === 'patch';
    return { method: name, headers: args[2], body: withBody ? args[1] : null };
  }

  function patchAdvancedHttp() {
    var http = window.cordova && window.cordova.plugin && window.cordova.plugin.http;
    if (!http || http.__dvbNet) return;
    http.__dvbNet = true;
    HTTP_METHODS.forEach(function (name) {
      var orig = http[name];
      if (typeof orig !== 'function') return;
      http[name] = function () {
        var args = Array.prototype.slice.call(arguments);
        if (httpDepth > 0) return orig.apply(this, args);
        var id = safe(function () {
          var info = httpRequestInfo(name, args);
          return netStart('advanced-http', info.method, args[0], headersObject(info.headers), info.body);
        });
        if (id) {
          // success e failure são as duas primeiras funções da lista de argumentos.
          var cbs = [];
          for (var i = 0; i < args.length; i++) if (typeof args[i] === 'function') cbs.push(i);
          if (cbs.length >= 1) args[cbs[0]] = wrapHttpCallback(id, args[cbs[0]], false);
          if (cbs.length >= 2) args[cbs[1]] = wrapHttpCallback(id, args[cbs[1]], true);
        }
        httpDepth++;
        try {
          return orig.apply(this, args);
        } finally {
          httpDepth--;
        }
      };
    });
  }

  function wrapHttpCallback(id, cb, failed) {
    return function (res) {
      safe(function () {
        var r = res || {};
        var status = typeof r.status === 'number' ? r.status : 0;
        var body = failed ? (r.error !== undefined ? r.error : r.data) : r.data;
        netEnd(id, status, '', headersObject(r.headers), body, failed && status <= 0 ? (r.error || 'falha de rede') : null);
      });
      return cb.apply(this, arguments);
    };
  }

  patchAdvancedHttp();

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
  // Lote (req.statements): todas na mesma transação, uma depois da outra; a
  // primeira que falha desfaz o lote inteiro e o erro diz qual foi.
  function runSql(req, reply) {
    getDb(req.db, function (err, db, label) {
      if (err) return reply(false, null, err.message, err.code);
      var list = req.statements || [{ sql: req.sql, params: req.params }];
      var results = [];
      var failure = null;
      var failedAt = -1;
      var started = Date.now();
      var method = req.write ? 'transaction' : (db.readTransaction ? 'readTransaction' : 'transaction');
      function fail(f) {
        var msg = f.message || String(f);
        if (req.statements && failedAt >= 0) msg = 'Instrução ' + (failedAt + 1) + ' de ' + list.length + ': ' + msg + (req.write ? ' (lote desfeito)' : '');
        reply(false, null, msg, f.code);
      }
      db[method](function (tx) {
        (function next(i) {
          if (i >= list.length) return;
          tx.executeSql(list[i].sql, list[i].params || [], function (tx2, rs) {
            results[i] = rs;
            next(i + 1);
          }, function (tx2, e) {
            failure = e;
            failedAt = i;
            return true; // desfaz a transação
          });
        })(0);
      }, function (e) {
        fail(failure || e || {});
      }, function () {
        if (failure) return fail(failure);
        var maxRows = req.maxRows || 1000;
        var out;
        if (req.statements) {
          out = { results: [] };
          for (var i = 0; i < results.length; i++) out.results.push(toResult(results[i], maxRows, req.write));
        } else {
          out = toResult(results[0], maxRows, req.write);
        }
        out.database = label;
        out.ms = Date.now() - started;
        reply(true, out);
      });
    });
  }

  // ---- storage ----------------------------------------------------------
  // local/session pela API do navegador; native pelo cordova-plugin-nativestorage.
  // Chaves devbridge.* (estado do reloadRestore) aparecem, mas não podem ser alteradas.
  var STORAGE_VALUE_LIMIT = 65536;

  function isInternalKey(k) { return String(k).indexOf('devbridge.') === 0; }

  function storageItem(key, raw) {
    var text = typeof raw === 'string' ? raw : serialize(raw);
    return { key: key, size: text.length, preview: text.length > 120 ? text.slice(0, 120) + '…' : text, internal: isInternalKey(key) };
  }

  function storageValue(area, key, raw) {
    var text = typeof raw === 'string' ? raw : serialize(raw);
    var out = { area: area, key: key, size: text.length, internal: isInternalKey(key), value: text.slice(0, STORAGE_VALUE_LIMIT), truncated: text.length > STORAGE_VALUE_LIMIT };
    var parsed = raw;
    if (typeof raw === 'string') {
      try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
    }
    if (parsed && typeof parsed === 'object') out.json = cloneArg(parsed, [], { n: 0 }, 0);
    return out;
  }

  function byKey(a, b) { return a.key < b.key ? -1 : a.key > b.key ? 1 : 0; }

  function runStorage(req, reply) {
    var action = req.action;
    if ((action === 'set' || action === 'remove') && isInternalKey(req.key)) {
      return reply(false, null, 'A chave "' + req.key + '" é do próprio devbridge (reloadRestore) e não pode ser alterada por aqui.');
    }
    if (req.area === 'native') return runNativeStorage(req, reply);
    var st = null;
    try { st = req.area === 'local' ? window.localStorage : window.sessionStorage; } catch (e) { st = null; }
    if (!st) return reply(false, null, req.area + 'Storage indisponível neste WebView.');
    try {
      if (action === 'list') {
        var items = [];
        for (var i = 0; i < st.length; i++) items.push(storageItem(st.key(i), st.getItem(st.key(i))));
        return reply(true, { area: req.area, items: items.sort(byKey) });
      }
      if (action === 'get') {
        var v = st.getItem(req.key);
        if (v === null) return reply(false, null, 'Chave não encontrada em ' + req.area + ': ' + req.key);
        return reply(true, storageValue(req.area, req.key, v));
      }
      if (action === 'set') {
        st.setItem(req.key, req.value);
        return reply(true, { area: req.area, key: req.key, action: 'set', size: String(req.value).length });
      }
      var existed = st.getItem(req.key) !== null;
      st.removeItem(req.key);
      reply(true, { area: req.area, key: req.key, action: 'remove', removed: existed });
    } catch (e) {
      reply(false, null, e.message || String(e));
    }
  }

  // NativeStorage é assíncrono e guarda o valor já interpretado (objeto, número, texto).
  function runNativeStorage(req, reply) {
    var ns = window.NativeStorage;
    if (!ns) return reply(false, null, 'NativeStorage indisponível: o app não tem o cordova-plugin-nativestorage ou o deviceready ainda não disparou.');
    function fail(e) { reply(false, null, 'NativeStorage: ' + ((e && (e.exception || e.message || e.code)) || String(e))); }
    var NOT_FOUND = 2;
    if (req.action === 'list') {
      return ns.keys(function (keys) {
        var items = [];
        var left = keys.length;
        if (!left) return reply(true, { area: 'native', items: [] });
        function done() {
          if (--left === 0) reply(true, { area: 'native', items: items.sort(byKey) });
        }
        keys.forEach(function (k) {
          ns.getItem(k, function (v) { items.push(storageItem(k, v)); done(); }, function () { items.push({ key: k, size: 0, preview: '(ilegível)', internal: isInternalKey(k) }); done(); });
        });
      }, fail);
    }
    if (req.action === 'get') {
      return ns.getItem(req.key, function (v) { reply(true, storageValue('native', req.key, v)); }, function (e) {
        if (e && e.code === NOT_FOUND) return reply(false, null, 'Chave não encontrada em native: ' + req.key);
        fail(e);
      });
    }
    if (req.action === 'set') {
      var value = req.value;
      try { value = JSON.parse(req.value); } catch (e) { value = req.value; }
      return ns.setItem(req.key, value, function () { reply(true, { area: 'native', key: req.key, action: 'set', size: String(req.value).length }); }, fail);
    }
    ns.remove(req.key, function () { reply(true, { area: 'native', key: req.key, action: 'remove', removed: true }); }, fail);
  }

  // ---- navegação ---------------------------------------------------------
  // A rota segue o prefixo que o app já usa (#! ou #). A resposta espera o hash
  // ficar parado: uma guarda de login ou o otherwise do router pode redirecionar.
  var NAV_SETTLE = 300;
  var NAV_LIMIT = 3000;

  function routeHash(route) {
    var r = String(route || '').trim();
    if (r.charAt(0) === '#') return r;
    var prefix = location.hash.indexOf('#!') === 0 ? '#!' : '#';
    return prefix + (r.charAt(0) === '/' ? r : '/' + r);
  }

  function runNavigate(req, reply) {
    if (!deviceReady) return reply(false, null, 'O app ainda não disparou deviceready; espere o boot terminar.');
    var target = routeHash(req.route);
    var started = Date.now();
    var last = location.hash;
    var changedAt = started;
    if (location.hash !== target) location.hash = target;
    (function check() {
      var now = Date.now();
      if (location.hash !== last) {
        last = location.hash;
        changedAt = now;
      }
      if (now - changedAt < NAV_SETTLE && now - started < NAV_LIMIT) return setTimeout(check, 50);
      reply(true, { requested: target, hash: location.hash, href: location.href, redirected: location.hash !== target, ms: now - started });
    })();
  }

  // ---- eval -------------------------------------------------------------
  // Eval indireto: roda no escopo global, fora do modo estrito do client.
  // Resultado thenable é esperado até timeoutMs; código síncrono não tem como parar.
  function kindOf(v) {
    if (v === null) return 'null';
    if (isError(v)) return 'error';
    if (Object.prototype.toString.call(v) === '[object Array]') return 'array';
    return typeof v;
  }

  // A stack para no runEval: dali para baixo são frames do client (canal SSE),
  // que não dizem nada a quem avaliou. Frames do app chamados pela expressão ficam acima.
  function errorText(e) {
    if (!isError(e)) return 'Rejeitada com: ' + serialize(e);
    var lines = String(e.stack || (e.name + ': ' + e.message)).split('\n');
    for (var i = 1; i < lines.length; i++) {
      if (/^\s*at runEval\b/.test(lines[i])) return lines.slice(0, i).join('\n');
    }
    return lines.join('\n');
  }

  function runEval(req, reply) {
    var started = Date.now();
    var awaited = false;
    var timer = null;
    var done = false;
    function finish(ok, value, err) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (!ok) return reply(false, null, err);
      reply(true, { value: cloneArg(value, [], { n: 0 }, 0), type: kindOf(value), awaited: awaited, ms: Date.now() - started });
    }
    var value;
    try {
      value = (0, eval)(req.expression);
    } catch (e) {
      return finish(false, null, errorText(e));
    }
    if (value && typeof value.then === 'function') {
      awaited = true;
      var limit = req.timeoutMs || 10000;
      timer = setTimeout(function () { finish(false, null, 'A promessa não resolveu em ' + limit / 1000 + ' s.'); }, limit);
      try {
        value.then(function (v) { finish(true, v); }, function (e) { finish(false, null, errorText(e)); });
      } catch (e) {
        finish(false, null, errorText(e));
      }
      return;
    }
    finish(true, value);
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
    flushNet();
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
    es.addEventListener('storage', function (ev) {
      var req = JSON.parse(ev.data);
      try {
        runStorage(req, replyFor(req.id));
      } catch (e) {
        replyFor(req.id)(false, null, e.message || String(e));
      }
    });
    es.addEventListener('navigate', function (ev) {
      var req = JSON.parse(ev.data);
      try {
        runNavigate(req, replyFor(req.id));
      } catch (e) {
        replyFor(req.id)(false, null, e.message || String(e));
      }
    });
    es.addEventListener('eval', function (ev) {
      var req = JSON.parse(ev.data);
      try {
        runEval(req, replyFor(req.id));
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
    flushNet: flushNet,
    // O script do reloadRestore registra { save: fn() -> dados, restore: fn(salvo, done) }.
    restore: function (hook) { restoreHook = hook; },
    waitFor: waitFor,
    overlayText: function () { return overlayText; },
  };
  connect();
})();
