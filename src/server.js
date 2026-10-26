'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');

const { resolveFile, injectClient, mimeOf, withSourceMap, ignoreListMap, CLIENT_MAP_URL } = require('./static');
const { checkSql } = require('./sqlguard');
const { resolveDatabase } = require('./config');
const adb = require('./adb');
const { Mirror } = require('./mirror');
const { NetworkLog } = require('./network');

const CLIENT_JS = path.join(__dirname, 'client', 'devbridge-client.js');
const UI_DIR = path.join(__dirname, 'ui');
const MAX_LOGS = 5000;
const IGNORED = /(^|[\\/])(\.[^\\/]*|node_modules)([\\/]|$)|(~|\.swp|\.swx|\.tmp)$/;

function globToRegExp(glob) {
  return new RegExp('^' + glob.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
}

// Navegador de PC: Mozilla sem Android. O WebView do app traz "Android" e o fetch do Node não traz "Mozilla".
function isDesktopBrowser(ua) {
  return /Mozilla/.test(ua || '') && !/Android/i.test(ua || '');
}

class DevServer {
  constructor(config, { logger = console, watch = true, listDatabases = adb.listDatabases, screencap = adb.screencap, mirror = {} } = {}) {
    this.config = config;
    this.screencap = screencap;
    this.mirror = new Mirror({ capture: () => this.screencap(), ...mirror });
    this.logger = logger;
    this.watchEnabled = watch;
    this.listDatabases = listDatabases;
    this.boot = crypto.randomBytes(4).toString('hex');
    this.clients = new Map();
    this.readyClients = new Set();
    this.pending = new Map();
    this.logs = [];
    this.logSeq = 0;
    this.network = new NetworkLog({ mask: config.networkMask !== false });
    this.reqSeq = 0;
    this.watcher = null;
    this.server = http.createServer((req, res) => this.handle(req, res).catch((err) => this.fail(res, 500, err.message)));
  }

  // ---- ciclo de vida ----------------------------------------------------
  listen(host = '127.0.0.1') {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.config.port, host, () => {
        this.server.off('error', reject);
        this.port = this.server.address().port;
        if (this.watchEnabled) this.startWatch();
        resolve(this.port);
      });
    });
  }

  close() {
    if (this.watcher) this.watcher.close();
    this.mirror.stop();
    for (const c of this.clients.values()) c.res.end();
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('Servidor encerrado.'));
    }
    this.clients.clear();
    this.pending.clear();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  startWatch() {
    let changed = new Set();
    let timer = null;
    const flush = () => {
      timer = null;
      const files = [...changed];
      changed = new Set();
      const allCss = files.every((f) => f.endsWith('.css'));
      if (allCss) this.broadcast('css', { paths: files });
      else this.broadcast('reload', { files });
      this.logger.log(`[devbridge] ${allCss ? 'css' : 'reload'}: ${files.join(', ')} (${this.clients.size} app(s) conectado(s))`);
    };
    this.watcher = fs.watch(this.config.wwwDir, { recursive: true }, (event, filename) => {
      if (!filename || IGNORED.test(filename)) return;
      changed.add(filename.split(path.sep).join('/'));
      clearTimeout(timer);
      timer = setTimeout(flush, 120);
    });
  }

  // ---- canal com o app --------------------------------------------------
  // Com reloadRestore o app volta sozinho para a tela; o reload parte sempre da rota inicial.
  keepRoute() {
    return this.config.reloadKeepRoute !== false && !this.config.reloadRestoreFile;
  }

  // Prefere o client que já disparou deviceready: uma aba do PC aberta em
  // localhost:8100 também carrega o client, mas não é o app.
  activeClient() {
    let latest = null;
    for (const c of this.clients.values()) {
      const better = !latest
        || (this.readyClients.has(c.id) && !this.readyClients.has(latest.id))
        || (this.readyClients.has(c.id) === this.readyClients.has(latest.id) && c.connectedAt >= latest.connectedAt);
      if (better) latest = c;
    }
    return latest;
  }

  sendEvent(client, event, data) {
    client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  broadcast(event, data) {
    for (const c of this.clients.values()) this.sendEvent(c, event, data);
    return this.clients.size;
  }

  request(event, payload, timeoutMs = 20000) {
    const client = this.activeClient();
    if (!client) {
      return Promise.reject(new Error('Nenhum app conectado. Abra o app dev no celular (devbridge build) e confira o cabo/adb reverse.'));
    }
    const id = ++this.reqSeq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`O app não respondeu em ${timeoutMs / 1000} s.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.sendEvent(client, event, { id, ...payload });
    });
  }

  addLogs(clientId, entries) {
    for (const e of entries || []) {
      const entry = { seq: ++this.logSeq, client: clientId, level: e.level, msg: e.msg, ts: e.ts, href: e.href };
      // args: os objetos logados, para a árvore do console web; CLI e MCP usam só msg.
      if (Array.isArray(e.args)) entry.args = e.args;
      this.logs.push(entry);
    }
    if (this.logs.length > MAX_LOGS) this.logs.splice(0, this.logs.length - MAX_LOGS);
  }

  getLogs({ since = 0, level = null, limit = 500 } = {}) {
    const levels = level ? new Set(String(level).split(',')) : null;
    const items = this.logs.filter((l) => l.seq > since && (!levels || levels.has(l.level)));
    return { last: this.logSeq, entries: items.slice(-limit) };
  }

  // ---- operações (usadas pela API HTTP, CLI e MCP) ----------------------
  async status() {
    const client = this.activeClient();
    const out = {
      server: {
        root: this.config.root,
        port: this.port,
        boot: this.boot,
        reloadKeepRoute: this.keepRoute(),
        reloadRestore: this.config.reloadRestoreFile,
        clients: this.clients.size,
        databases: this.config.databases,
        defaultDb: this.config.defaultDb,
        logs: this.logSeq,
        network: this.network.seq,
        networkMask: this.network.mask,
      },
      app: null,
    };
    if (client) {
      out.app = { client: client.id, href: client.href, userAgent: client.ua, connectedAt: new Date(client.connectedAt).toISOString() };
      const globals = Object.values(this.config.databases).map((d) => d.global).filter(Boolean);
      try {
        Object.assign(out.app, await this.request('status', { globals }, 3000));
      } catch (err) {
        out.app.error = err.message;
      }
    }
    return out;
  }

  reload() {
    return { apps: this.broadcast('reload', { files: [] }) };
  }

  // statements: lote [{ sql, params }] numa transação só; cada instrução passa pelo guard.
  async sql({ sql, params = [], statements, db, write = false, maxRows = 1000 }) {
    let list = null;
    if (statements !== undefined) {
      if (!Array.isArray(statements) || !statements.length) throw new Error('"statements" precisa ser uma lista com ao menos uma instrução.');
      list = statements.map((s) => (typeof s === 'string' ? { sql: s, params: [] } : { sql: s && s.sql, params: (s && s.params) || [] }));
      list.forEach((s, i) => {
        const problem = checkSql(s.sql, { write });
        if (problem) throw new Error(`Instrução ${i + 1} de ${list.length}: ${problem}`);
      });
    } else {
      const problem = checkSql(sql, { write });
      if (problem) throw new Error(problem);
    }
    const spec = resolveDatabase(this.config, db);
    const target = { global: spec.global, name: spec.name };
    const payload = list ? { statements: list, write, maxRows, db: target } : { sql, params, write, maxRows, db: target };
    // O lote entra no histórico como uma linha só.
    const logSql = list ? `[lote ${list.length}] ${list.map((s) => s.sql.replace(/;\s*$/, '')).join('; ')}` : sql;
    const logParams = list ? list.map((s) => s.params) : params;
    let result;
    try {
      result = await this.sendSql(payload, spec);
    } catch (err) {
      if (write) await this.history(spec.alias, logSql, logParams, `ERRO ${err.message}`);
      throw err;
    }
    if (write) {
      const affected = list ? result.results.map((r) => r.rowsAffected).join(',') : result.rowsAffected;
      await this.history(spec.alias, logSql, logParams, `ok rowsAffected=${affected}`);
    }
    return result;
  }

  async sendSql(payload, spec) {
    try {
      return await this.request('sql', payload);
    } catch (err) {
      if (err.code !== 'GLOBAL_CLOSED' || !spec.name || !spec.name.includes('*')) throw err;
      // Conexão global ainda fechada (ex.: antes do login): acha o arquivo pelo padrão.
      const re = globToRegExp(spec.name);
      const files = (await this.listDatabases(this.config.package)).filter((f) => re.test(f));
      if (files.length !== 1) {
        throw new Error(files.length
          ? `"${spec.alias}" casa com vários bancos: ${files.join(', ')}. Use --db <arquivo.db>.`
          : `Nenhum banco casa com ${spec.name} no aparelho (o app já fez login?).`);
      }
      return this.request('sql', { ...payload, db: { global: null, name: files[0] } });
    }
  }

  async history(alias, sql, params, outcome) {
    await fsp.mkdir(this.config.stateDir, { recursive: true });
    const line = [new Date().toISOString(), alias, sql.replace(/\s+/g, ' ').trim(), JSON.stringify(params || []), outcome].join('\t');
    await fsp.appendFile(path.join(this.config.stateDir, 'sql-history.log'), line + '\n');
  }

  navigate({ route } = {}) {
    if (typeof route !== 'string' || !route.trim()) return Promise.reject(new Error('Informe a rota, ex.: #/pedidos ou /pedidos.'));
    return this.request('navigate', { route }, 8000);
  }

  async evaluate({ expression, timeoutMs = 10000 } = {}) {
    if (typeof expression !== 'string' || !expression.trim()) throw new Error('Expressão vazia.');
    const limit = Math.min(Math.max(Number(timeoutMs) || 10000, 100), 120000);
    let result;
    try {
      // Folga sobre o limite do app: o timeout da promessa chega antes do da requisição.
      result = await this.request('eval', { expression, timeoutMs: limit }, limit + 2000);
    } catch (err) {
      await this.evalHistory(expression, `ERRO ${err.message.split('\n')[0]}`);
      throw err;
    }
    await this.evalHistory(expression, `ok ${result.type}`);
    return result;
  }

  async evalHistory(expression, outcome) {
    await fsp.mkdir(this.config.stateDir, { recursive: true });
    const line = [new Date().toISOString(), expression.replace(/\s+/g, ' ').trim(), outcome].join('\t');
    await fsp.appendFile(path.join(this.config.stateDir, 'eval-history.log'), line + '\n');
  }

  async tables(db) {
    return this.sql({ db, sql: "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__WebKit%' ORDER BY name" });
  }

  async schema(db, table) {
    if (!/^[\w$]+$/.test(table || '')) throw new Error('Nome de tabela inválido.');
    const cols = await this.sql({ db, sql: `PRAGMA table_info(${table})` });
    const idx = await this.sql({ db, sql: `PRAGMA index_list(${table})` });
    return { table, columns: cols.rows, indexes: idx.rows, database: cols.database };
  }

  // ---- HTTP -------------------------------------------------------------
  async handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    if (p.startsWith('/__devbridge/api/')) return this.handleApi(req, res, url);
    if (p === '/__devbridge/client.js') return this.sendText(res, mimeOf(CLIENT_JS), withSourceMap(await fsp.readFile(CLIENT_JS, 'utf8')));
    if (p === CLIENT_MAP_URL) return this.json(res, 200, ignoreListMap(await fsp.readFile(CLIENT_JS, 'utf8'), 'devbridge-client.js'));
    if (p === '/__devbridge/restore.js') {
      if (!this.config.reloadRestoreFile) return this.fail(res, 404, 'Sem "reloadRestore" na config.');
      if (!fs.existsSync(this.config.reloadRestoreFile)) return this.fail(res, 404, `reloadRestore não encontrado: ${this.config.reloadRestoreFile}`);
      return this.sendFile(res, this.config.reloadRestoreFile);
    }
    if (p === '/__devbridge/events') return this.openEvents(req, res, url);
    if (p === '/__devbridge' || p === '/__devbridge/') return this.sendFile(res, path.join(UI_DIR, 'index.html'));
    if (p === '/__devbridge/mirror') return this.sendFile(res, path.join(UI_DIR, 'mirror.html'));
    if (req.method === 'POST' && p === '/__devbridge/log') {
      const body = await readJson(req);
      this.addLogs(body.client, body.entries);
      return this.json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/__devbridge/network') {
      const body = await readJson(req);
      this.network.add(body.client, body.events);
      return this.json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/__devbridge/reply') {
      const body = await readJson(req);
      const pending = this.pending.get(body.id);
      if (pending) {
        this.pending.delete(body.id);
        clearTimeout(pending.timer);
        if (body.ok) pending.resolve(body.result);
        else pending.reject(Object.assign(new Error(body.error || 'Erro no app.'), { code: body.code }));
      }
      return this.json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/__devbridge/state') {
      const body = await readJson(req);
      const c = this.clients.get(body.client);
      if (c) c.href = body.href;
      // Guardado por id: o EventSource reconecta com o mesmo id e a marca continua valendo.
      if (body.ready) this.readyClients.add(body.client);
      return this.json(res, 200, { ok: true });
    }
    if (p.startsWith('/__devbridge/')) return this.fail(res, 404, 'Rota devbridge desconhecida.');
    // No Chrome do PC o app trava no prompt() do cordova.js e, por dividir o
    // processo com as outras abas do mesmo site, trava também o console.
    // Quem quiser o app mesmo assim usa ?app.
    if ((p === '/' || p === '/index.html') && isDesktopBrowser(req.headers['user-agent']) && !url.searchParams.has('app')) {
      res.writeHead(302, { Location: '/__devbridge/' });
      return res.end();
    }
    return this.serveStatic(req, res, p);
  }

  async handleApi(req, res, url) {
    // Header próprio força preflight CORS (que não respondemos): outra página
    // aberta no navegador não consegue disparar SQL contra o app.
    if (req.headers['x-devbridge'] !== '1') return this.fail(res, 403, 'Header X-Devbridge ausente.');
    const route = `${req.method} ${url.pathname.slice('/__devbridge/api'.length)}`;
    const q = url.searchParams;
    try {
      switch (route) {
        case 'GET /status':
          return this.json(res, 200, await this.status());
        case 'POST /reload':
          return this.json(res, 200, this.reload());
        case 'GET /logs':
          return this.json(res, 200, this.getLogs({ since: Number(q.get('since') || 0), level: q.get('level'), limit: Number(q.get('limit') || 500) }));
        case 'GET /network':
          return this.json(res, 200, this.network.list({
            since: Number(q.get('since') || 0),
            url: q.get('url'),
            failed: q.get('failed') === '1' || q.get('failed') === 'true',
            local: q.get('local') === '1' || q.get('local') === 'true',
            limit: Number(q.get('limit') || 100),
          }));
        case 'GET /network/entry':
          return this.json(res, 200, this.network.get(q.get('id')));
        case 'POST /sql':
          return this.json(res, 200, await this.sql(await readJson(req)));
        case 'POST /navigate':
          return this.json(res, 200, await this.navigate(await readJson(req)));
        case 'POST /eval':
          return this.json(res, 200, await this.evaluate(await readJson(req)));
        case 'GET /tables':
          return this.json(res, 200, await this.tables(q.get('db')));
        case 'GET /schema':
          return this.json(res, 200, await this.schema(q.get('db'), q.get('table')));
        case 'GET /mirror/frame': {
          // Long-poll: responde quando houver quadro mais novo que "after".
          const frame = await this.mirror.next(Number(q.get('after') || 0));
          if (!frame) {
            res.writeHead(204, { 'Cache-Control': 'no-store' });
            return res.end();
          }
          if (frame.error) return this.fail(res, 503, frame.error);
          res.writeHead(200, {
            'Content-Type': 'image/png',
            'Cache-Control': 'no-store',
            'X-Frame-Seq': String(frame.seq),
            'X-Frame-Ts': String(frame.ts),
          });
          return res.end(frame.png);
        }
        case 'GET /screenshot': {
          const png = await this.screencap();
          res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
          return res.end(png);
        }
        default:
          return this.fail(res, 404, `API desconhecida: ${route}`);
      }
    } catch (err) {
      return this.fail(res, 400, err.message);
    }
  }

  openEvents(req, res, url) {
    const id = url.searchParams.get('client') || crypto.randomBytes(4).toString('hex');
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    res.write('retry: 1000\n\n');
    const client = { id, res, href: url.searchParams.get('href'), ua: url.searchParams.get('ua'), connectedAt: Date.now() };
    this.clients.set(id, client);
    this.sendEvent(client, 'hello', { boot: this.boot, reloadKeepRoute: this.keepRoute() });
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    this.logger.log(`[devbridge] app conectado (${id}) ${client.href || ''}`);
    if (client.ua && !/Android/i.test(client.ua)) {
      this.logger.log('[devbridge] aviso: essa conexão é de um navegador do PC, não do app. O console fica em /__devbridge/.');
    }
    req.on('close', () => {
      clearInterval(ping);
      if (this.clients.get(id) === client) this.clients.delete(id);
    });
  }

  async serveStatic(req, res, urlPath) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return this.fail(res, 405, 'Método não suportado.');
    const roots = [this.config.platformWwwDir, this.config.wwwDir];
    const file = resolveFile(roots, urlPath);
    if (!file) return this.fail(res, 404, `Não encontrado: ${urlPath}`);
    if (file === path.join(this.config.wwwDir, 'index.html')) {
      const html = injectClient(await fsp.readFile(file, 'utf8'), { restore: !!this.config.reloadRestoreFile });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(req.method === 'HEAD' ? undefined : html);
    }
    return this.sendFile(res, file, req.method === 'HEAD');
  }

  sendFile(res, file, headOnly = false) {
    res.writeHead(200, { 'Content-Type': mimeOf(file), 'Cache-Control': 'no-store' });
    if (headOnly) return res.end();
    fs.createReadStream(file).on('error', () => res.end()).pipe(res);
  }

  sendText(res, type, text) {
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(text);
  }

  json(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  fail(res, status, message) {
    if (res.headersSent) return res.end();
    this.json(res, status, { error: message });
  }
}

function readJson(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('Corpo da requisição grande demais.'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('JSON inválido.'));
      }
    });
    req.on('error', reject);
  });
}

module.exports = { DevServer, globToRegExp };
