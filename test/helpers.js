'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');

// App Cordova mínimo em disco: www + platform_www + config.
function makeApp(extraConfig = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devbridge-app-'));
  const www = path.join(root, 'www');
  const pw = path.join(root, 'platforms/android/platform_www');
  fs.mkdirSync(path.join(www, 'css'), { recursive: true });
  fs.mkdirSync(path.join(www, 'templates'), { recursive: true });
  fs.mkdirSync(pw, { recursive: true });
  fs.writeFileSync(path.join(www, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body ng-app="app"></body></html>');
  fs.writeFileSync(path.join(www, 'templates/home.html'), '<div>home</div>');
  fs.writeFileSync(path.join(www, 'css/app.css'), 'body{}');
  fs.writeFileSync(path.join(pw, 'cordova.js'), '// cordova');
  const config = {
    package: 'com.teste.app',
    port: 0,
    databases: { par: { global: 'dbconfig', name: 'Param.db' }, user: { global: 'db', name: 'User_*.db' } },
    ...extraConfig,
  };
  fs.writeFileSync(path.join(root, 'devbridge.config.json'), JSON.stringify(config));
  return root;
}

// SQLite falso, suficiente para o protocolo: SELECT por tabela, UPDATE por rowid,
// sqlite_master e a recusa de escrita em readTransaction (como o plugin real).
function fakeSqlitePlugin(data) {
  const opened = [];
  function exec(name, sql, params, readOnly) {
    const tables = data[name] || (data[name] = {});
    const s = sql.trim();
    if (readOnly && !/^(select|pragma|with|explain)\b/i.test(s)) throw new Error('invalid sql for a read-only transaction');
    if (/sqlite_master/i.test(s)) return { rows: Object.keys(tables).map((t) => ({ name: t, type: 'table' })) };
    let m = s.match(/^pragma\s+(table_info|index_list)\((\w+)\)/i);
    if (m) {
      if (m[1].toLowerCase() === 'index_list') return { rows: [] };
      const first = (tables[m[2]] || [])[0] || {};
      return { rows: Object.keys(first).map((k, i) => ({ cid: i, name: k, type: '', notnull: 0, dflt_value: null, pk: 0 })) };
    }
    m = s.match(/^select\s+(rowid as __rowid, )?\*\s+from\s+"?(\w+)"?/i);
    if (m) {
      if (!tables[m[2]]) throw new Error(`no such table: ${m[2]}`);
      return { rows: tables[m[2]].map((r, i) => (m[1] ? { __rowid: i + 1, ...r } : { ...r })) };
    }
    m = s.match(/^update\s+"?(\w+)"?\s+set\s+"?(\w+)"?\s*=\s*\?\s+where\s+rowid\s*=\s*\?/i);
    if (m) {
      const row = tables[m[1]][params[1] - 1];
      row[m[2]] = params[0];
      return { rows: [], rowsAffected: 1 };
    }
    m = s.match(/^insert\s+into\s+"?(\w+)"?\s+(?:default\s+values|\(([^)]*)\)\s+values\s*\((.*)\))/i);
    if (m) {
      const cols = m[2] ? m[2].split(',').map((c) => c.trim().replace(/"/g, '')) : [];
      // values com "?" usa params; com literais (script de --file), lê números e strings.
      const literals = (m[3] || '').match(/'(?:[^']|'')*'|[^,\s]+/g) || [];
      const values = literals.map((v, i) => (v === '?' ? params[i] : v[0] === "'" ? v.slice(1, -1).replace(/''/g, "'") : Number(v)));
      const row = {};
      cols.forEach((c, i) => (row[c] = values[i]));
      tables[m[1]].push(row);
      return { rows: [], rowsAffected: 1 };
    }
    m = s.match(/^delete\s+from\s+"?(\w+)"?\s+where\s+rowid\s*=\s*\?/i);
    if (m) {
      tables[m[1]].splice(params[0] - 1, 1);
      return { rows: [], rowsAffected: 1 };
    }
    m = s.match(/^delete\s+from\s+(\w+)/i);
    if (m) {
      const n = tables[m[1]].length;
      tables[m[1]] = [];
      return { rows: [], rowsAffected: n };
    }
    if (/^select\s+1/i.test(s)) return { rows: [{ 1: 1 }] };
    throw new Error(`fake não entende: ${s}`);
  }
  function toRs(r) {
    const rows = r.rows || [];
    return { rows: { length: rows.length, item: (i) => rows[i] }, rowsAffected: r.rowsAffected || 0 };
  }
  function makeDb(name) {
    function tx(readOnly) {
      return (fn, error, success) => {
        setTimeout(() => {
          // Falha desfaz a transação inteira, como no plugin real.
          const before = structuredClone(data[name] || {});
          let failed = null;
          fn({
            executeSql(sql, params, ok, err) {
              try {
                ok({}, toRs(exec(name, sql, params, readOnly)));
              } catch (e) {
                failed = e;
                if (err) err({}, { message: e.message });
              }
            },
          });
          if (failed) {
            data[name] = before;
            error({ message: failed.message });
          } else success();
        }, 1);
      };
    }
    return { name, executeSql() {}, transaction: tx(false), readTransaction: tx(true) };
  }
  return {
    opened,
    makeDb,
    openDatabase(opts) {
      opened.push(opts.name);
      return makeDb(opts.name);
    },
  };
}

// Roda o client real num vm com EventSource/XHR mínimos apontando para o servidor.
function runClient(baseUrl, { sqlitePlugin, globals = {}, storage = {} } = {}) {
  const calls = { reload: 0, logs: [], hrefsOnReload: [] };
  const listeners = {};
  const docListeners = {};
  const sources = [];

  class EventSource {
    constructor(url) {
      this.handlers = {};
      sources.push(this);
      this.req = http.get(baseUrl + url, (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          buf += chunk;
          let idx;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            let event = 'message';
            let data = '';
            for (const line of block.split('\n')) {
              if (line.startsWith('event: ')) event = line.slice(7);
              else if (line.startsWith('data: ')) data += line.slice(6);
            }
            if (data) (this.handlers[event] || []).forEach((h) => h({ data }));
          }
        });
      });
      this.req.on('error', () => {});
    }
    addEventListener(type, fn) {
      (this.handlers[type] = this.handlers[type] || []).push(fn);
    }
    close() {
      this.req.destroy();
    }
  }

  // XHR com o necessário do real: status, cabeçalhos, eventos e on<evento>.
  class XMLHttpRequest {
    constructor() {
      this.listeners = {};
      this.readyState = 0;
      this.status = 0;
      this.statusText = '';
      this.responseType = '';
      this.responseText = '';
      this.rawHeaders = '';
    }
    open(method, url) {
      this.method = method;
      this.url = url;
      this.headers = {};
      this.readyState = 1;
    }
    setRequestHeader(k, v) {
      this.headers[k] = v;
    }
    addEventListener(type, fn) {
      (this.listeners[type] = this.listeners[type] || []).push(fn);
    }
    getAllResponseHeaders() {
      return this.rawHeaders;
    }
    emit(type) {
      (this.listeners[type] || []).forEach((fn) => fn.call(this, { type }));
      if (typeof this['on' + type] === 'function') this['on' + type]({ type });
    }
    send(body) {
      const url = /^https?:/.test(this.url) ? this.url : baseUrl + this.url;
      fetch(url, { method: this.method, headers: this.headers, body: body === undefined ? undefined : body }).then(async (res) => {
        this.status = res.status;
        this.statusText = res.statusText;
        this.rawHeaders = [...res.headers].map(([k, v]) => `${k}: ${v}`).join('\r\n');
        this.responseText = await res.text();
        this.response = this.responseText;
        this.readyState = 4;
        ['readystatechange', 'load', 'loadend'].forEach((t) => this.emit(t));
      }, () => {
        this.readyState = 4;
        ['readystatechange', 'error', 'loadend'].forEach((t) => this.emit(t));
      });
    }
  }

  const links = [{ href: baseUrl + '/css/app.css' }];
  const ctx = {
    console: {
      log: (...a) => calls.logs.push(['log', a]),
      info: () => {},
      warn: () => {},
      error: (...a) => calls.logs.push(['error', a]),
      debug: () => {},
    },
    location: {
      href: baseUrl + '/index.html#/home', hash: '#/home', pathname: '/index.html', search: '', origin: baseUrl,
      reload() {
        calls.reload++;
        calls.hrefsOnReload.push(this.href);
      },
    },
    history: {
      replaceState(state, title, url) {
        ctx.location.href = new URL(url, baseUrl).href;
        ctx.location.hash = new URL(url, baseUrl).hash;
      },
    },
    navigator: { userAgent: 'vm-test' },
    document: {
      addEventListener: (t, fn) => (docListeners[t] = fn),
      querySelectorAll: () => links,
      createElement: (tag) => {
        if (tag !== 'a') return { setAttribute() {}, getElementsByTagName: () => [{}, {}] };
        const a = {};
        Object.defineProperty(a, 'href', { set(v) { a.pathname = new URL(v).pathname; } });
        return a;
      },
      body: {
        appendChild(n) { n.parentNode = this; },
        removeChild(n) { n.parentNode = null; },
      },
    },
    // Compartilhado entre clients do mesmo teste para simular o sessionStorage que sobrevive ao reload.
    sessionStorage: {
      getItem: (k) => (k in storage ? storage[k] : null),
      setItem: (k, v) => { storage[k] = String(v); },
      removeItem: (k) => { delete storage[k]; },
    },
    addEventListener: (t, fn) => (listeners[t] = fn),
    EventSource,
    XMLHttpRequest,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    encodeURIComponent,
    decodeURIComponent,
    URL,
    sqlitePlugin: sqlitePlugin || undefined,
    ...globals,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/client/devbridge-client.js'), 'utf8'), ctx);
  return {
    ctx,
    calls,
    links,
    fireDeviceReady: () => docListeners.deviceready && docListeners.deviceready(),
    fireError: (ev) => listeners.error(ev),
    close: () => sources.forEach((s) => s.close()),
  };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, timeout = 3000) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error('timeout esperando condição');
    await wait(20);
  }
}

module.exports = { makeApp, fakeSqlitePlugin, runClient, wait, until };
