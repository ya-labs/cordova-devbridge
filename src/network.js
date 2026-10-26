'use strict';

const MAX_ENTRIES = 500;

// Cabeçalhos e campos que carregam credencial: o valor vira "***", a chave fica.
const SECRET_HEADERS = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key)$/i;
const SECRET_KEY = '(?:senha|password|passwd|pwd|secret|token|api[_-]?key)';
const JSON_FIELD = new RegExp(`("[^"\\\\]*${SECRET_KEY}[^"\\\\]*"\\s*:\\s*)("(?:[^"\\\\]|\\\\.)*"|-?\\d[\\d.eE+-]*|true|false|null)`, 'gi');
const FORM_FIELD = new RegExp(`((?:^|[?&;])[^=&?#;\\s]*${SECRET_KEY}[^=&?#;\\s]*=)([^&#;\\s]*)`, 'gi');
const XML_FIELD = new RegExp(`(<([\\w:-]*${SECRET_KEY}[\\w:-]*)(?:\\s[^>]*)?>)([^<]*)(</\\2>)`, 'gi');

// Por regex, e não por parse: o corpo pode chegar cortado e deixar de ser JSON válido.
function maskText(text) {
  if (typeof text !== 'string' || !text) return text;
  return text
    .replace(JSON_FIELD, '$1"***"')
    .replace(FORM_FIELD, '$1***')
    .replace(XML_FIELD, '$1***$4');
}

function maskHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) out[k] = SECRET_HEADERS.test(k) ? '***' : v;
  return out;
}

function part(p, mask) {
  const out = { headers: p.headers || {}, body: p.body ?? null, size: p.size || 0, truncated: !!p.truncated };
  if (mask) {
    out.headers = maskHeaders(out.headers);
    out.body = maskText(out.body);
  }
  return out;
}

function isFailure(e) {
  return e.state === 'error' || (e.state === 'done' && (e.status >= 400 || e.status <= 0));
}

// Chamadas do app ao backend, recebidas do client em eventos start/end.
// Cada mudança dá um seq novo à entrada: "since" devolve também as que
// terminaram depois da última consulta.
class NetworkLog {
  constructor({ mask = true, max = MAX_ENTRIES } = {}) {
    this.mask = mask;
    this.max = max;
    this.entries = new Map(); // chave client:id
    this.byId = new Map();
    this.seq = 0;
    this.nextId = 0;
  }

  add(clientId, events) {
    for (const ev of events || []) {
      const key = `${clientId}:${ev.id}`;
      if (ev.phase === 'start') {
        const entry = {
          id: ++this.nextId,
          seq: ++this.seq,
          client: clientId,
          via: ev.via,
          method: ev.method,
          url: this.mask ? maskText(ev.url) : ev.url,
          local: !!ev.local,
          href: ev.href,
          ts: ev.ts,
          state: 'pending',
          status: null,
          request: part(ev.request || {}, this.mask),
          response: null,
        };
        this.entries.set(key, entry);
        this.byId.set(entry.id, entry);
      } else if (ev.phase === 'end') {
        const entry = this.entries.get(key);
        if (!entry) continue;
        entry.seq = ++this.seq;
        entry.status = ev.status;
        entry.statusText = ev.statusText || '';
        entry.ms = ev.ts - entry.ts;
        entry.state = ev.error ? 'error' : 'done';
        if (ev.error) entry.error = ev.error;
        entry.response = part(ev.response || {}, this.mask);
      }
    }
    while (this.entries.size > this.max) {
      const [key, oldest] = this.entries.entries().next().value;
      this.entries.delete(key);
      this.byId.delete(oldest.id);
    }
  }

  // local: requisições ao próprio servidor de desenvolvimento (templates, js),
  // escondidas por padrão; as que falham aparecem sempre.
  list({ since = 0, url = null, failed = false, local = false, limit = 100 } = {}) {
    const needle = url ? String(url).toLowerCase() : null;
    const items = [...this.entries.values()]
      .filter((e) => e.seq > since)
      .filter((e) => local || !e.local || isFailure(e))
      .filter((e) => !failed || isFailure(e))
      .filter((e) => !needle || e.url.toLowerCase().includes(needle))
      .sort((a, b) => a.seq - b.seq);
    return { last: this.seq, entries: items.slice(-limit).map(summary) };
  }

  get(id) {
    const entry = this.byId.get(Number(id));
    if (!entry) throw new Error(`Chamada ${id} não encontrada (o histórico guarda as ${this.max} mais recentes).`);
    return entry;
  }
}

function summary(e) {
  const out = {
    id: e.id, seq: e.seq, ts: e.ts, via: e.via, method: e.method, url: e.url, local: e.local,
    state: e.state, status: e.status, ms: e.ms, reqSize: e.request.size, resSize: e.response ? e.response.size : null,
  };
  if (e.error) out.error = e.error;
  return out;
}

module.exports = { NetworkLog, maskText, maskHeaders, isFailure };
