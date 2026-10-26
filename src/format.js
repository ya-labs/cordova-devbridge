'use strict';

function cell(value, max) {
  let s = value === null || value === undefined ? 'NULL' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  s = s.replace(/\s+/g, ' ');
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// Tabela alinhada para o terminal; células longas são cortadas.
function table(columns, rows, { max = 60 } = {}) {
  if (!columns.length) return '(sem linhas)';
  const body = rows.map((r) => columns.map((c) => cell(r[c], max)));
  const widths = columns.map((c, i) => Math.max(c.length, ...body.map((r) => r[i].length)));
  const line = (vals) => vals.map((v, i) => v.padEnd(widths[i])).join(' │ ');
  return [line(columns), widths.map((w) => '─'.repeat(w)).join('─┼─'), ...body.map(line)].join('\n');
}

function sqlResult(result) {
  const out = [];
  if (result.columns && result.columns.length) out.push(table(result.columns, result.rows));
  const info = [`${result.rowCount ?? 0} linha(s)`];
  if (result.truncated) info.push(`mostrando ${result.rows.length}`);
  if (result.rowsAffected !== undefined) info.push(`afetadas: ${result.rowsAffected}`);
  if (result.insertId !== undefined) info.push(`insertId: ${result.insertId}`);
  if (result.database) info.push(`banco: ${result.database}`);
  if (result.ms !== undefined) info.push(`${result.ms} ms`);
  out.push(`(${info.join(' · ')})`);
  return out.join('\n');
}

// Lote: um bloco por instrução, na ordem enviada.
function sqlBatchResult(result, statements) {
  const blocks = result.results.map((r, i) => {
    const sql = statements && statements[i] ? (typeof statements[i] === 'string' ? statements[i] : statements[i].sql) : '';
    const head = `-- [${i + 1}] ${sql.replace(/\s+/g, ' ').trim().slice(0, 100)}`;
    return `${head}\n${sqlResult(r)}`;
  });
  blocks.push(`(${result.results.length} instrução(ões) numa transação · banco: ${result.database} · ${result.ms} ms)`);
  return blocks.join('\n\n');
}

function logLine(e) {
  const t = new Date(e.ts).toTimeString().slice(0, 8);
  return `${t} ${e.level.toUpperCase().padEnd(5)} ${e.msg}`;
}

function size(n) {
  if (n === null || n === undefined) return '-';
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}

function netStatus(e) {
  if (e.state === 'pending') return 'pendente';
  if (e.state === 'error') return `ERRO ${e.status || ''}`.trim();
  return String(e.status);
}

// Uma linha por chamada: o id leva ao detalhe (network <id> / app_network_entry).
function networkLine(e) {
  const t = new Date(e.ts).toTimeString().slice(0, 8);
  const ms = e.ms === undefined || e.ms === null ? '' : ` ${e.ms} ms`;
  const err = e.error ? ` (${e.error})` : '';
  return `#${e.id} ${t} ${e.method} ${netStatus(e)}${ms} ${e.url} [${e.via}, req ${size(e.reqSize)}, res ${size(e.resSize)}]${err}`;
}

function bodyText(p, maxBody) {
  if (p.body === null || p.body === undefined || p.body === '') return '(sem corpo)';
  let body = p.body;
  if (!p.truncated) {
    try {
      body = JSON.stringify(JSON.parse(body), null, 2);
    } catch {
      // não é JSON: fica como veio
    }
  }
  const notes = [];
  if (p.truncated) notes.push(`app enviou só os primeiros ${p.body.length} de ${p.size} caracteres`);
  if (body.length > maxBody) {
    notes.push(`mostrando ${maxBody} de ${body.length}; use maxBody para ver mais`);
    body = body.slice(0, maxBody);
  }
  return notes.length ? `${body}\n[${notes.join('; ')}]` : body;
}

function headerLines(h) {
  const keys = Object.keys(h || {});
  return keys.length ? keys.map((k) => `  ${k}: ${h[k]}`).join('\n') : '  (nenhum)';
}

function networkDetail(e, { maxBody = 8000 } = {}) {
  const head = [`#${e.id} ${e.method} ${e.url}`];
  const info = [`via ${e.via}`, `rota ${e.href || '-'}`, new Date(e.ts).toTimeString().slice(0, 8), netStatus(e) + (e.statusText ? ` ${e.statusText}` : '')];
  if (e.ms !== undefined && e.ms !== null) info.push(`${e.ms} ms`);
  head.push(info.join(' · '));
  if (e.error) head.push(`erro: ${e.error}`);
  const out = [head.join('\n'), `Pedido (${size(e.request.size)})\n${headerLines(e.request.headers)}\n\n${bodyText(e.request, maxBody)}`];
  out.push(e.response
    ? `Resposta (${size(e.response.size)})\n${headerLines(e.response.headers)}\n\n${bodyText(e.response, maxBody)}`
    : 'Resposta: ainda não chegou');
  return out.join('\n\n');
}

// Valores que o JSON não representa chegam como { __dvb: texto } (mesma cópia dos logs).
function plain(v) {
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === 'object') {
    const keys = Object.keys(v);
    if (keys.length === 1 && typeof v.__dvb === 'string') return v.__dvb;
    const out = {};
    for (const k of keys) out[k] = plain(v[k]);
    return out;
  }
  return v;
}

function evalResult(r, { max = 20000 } = {}) {
  const special = r.value && typeof r.value === 'object' && !Array.isArray(r.value) && Object.keys(r.value).length === 1 && typeof r.value.__dvb === 'string';
  let body = special ? r.value.__dvb : JSON.stringify(plain(r.value), null, 2);
  if (body.length > max) body = `${body.slice(0, max)}\n[mostrando ${max} de ${body.length} caracteres]`;
  const info = [`tipo: ${r.type}`, `${r.ms} ms`];
  if (r.awaited) info.push('promessa resolvida');
  return `${body}\n\n(${info.join(' · ')})`;
}

function navigateResult(r) {
  const out = [`Rota atual: ${r.hash || '(sem hash)'}`];
  if (r.redirected) out.push(`O app redirecionou: o pedido foi ${r.requested}.`);
  out.push(`(${r.href} · ${r.ms} ms)`);
  return out.join('\n');
}

module.exports = { table, sqlResult, sqlBatchResult, logLine, networkLine, networkDetail, evalResult, navigateResult };
