'use strict';

// Cliente da API local do servidor `devbridge start` (CLI e MCP usam este).
class Api {
  constructor(port) {
    this.base = `http://127.0.0.1:${port}/__devbridge/api`;
  }

  async call(method, route, { query, body, raw = false } = {}) {
    const url = new URL(this.base + route);
    for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null) url.searchParams.set(k, v);
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: { 'X-Devbridge': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new Error(`Servidor devbridge não está rodando em ${url.host}. Rode "devbridge start" na raiz do app.`);
    }
    if (raw && res.ok) return Buffer.from(await res.arrayBuffer());
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  status() { return this.call('GET', '/status'); }
  reload() { return this.call('POST', '/reload'); }
  logs(opts) { return this.call('GET', '/logs', { query: opts }); }
  network(opts) { return this.call('GET', '/network', { query: opts }); }
  networkEntry(id) { return this.call('GET', '/network/entry', { query: { id } }); }
  sql(body) { return this.call('POST', '/sql', { body }); }
  input(body) { return this.call('POST', '/input', { body }); }
  snapshots() { return this.call('GET', '/snapshots'); }
  snapshot(body) { return this.call('POST', '/snapshot', { body }); }
  restore(name) { return this.call('POST', '/restore', { body: { name } }); }
  storage(body) { return this.call('POST', '/storage', { body }); }
  navigate(route) { return this.call('POST', '/navigate', { body: { route } }); }
  evaluate(body) { return this.call('POST', '/eval', { body }); }
  tables(db) { return this.call('GET', '/tables', { query: { db } }); }
  schema(db, table) { return this.call('GET', '/schema', { query: { db, table } }); }
  screenshot() { return this.call('GET', '/screenshot', { raw: true }); }
}

module.exports = { Api };
