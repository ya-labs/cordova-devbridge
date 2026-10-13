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

function logLine(e) {
  const t = new Date(e.ts).toTimeString().slice(0, 8);
  return `${t} ${e.level.toUpperCase().padEnd(5)} ${e.msg}`;
}

module.exports = { table, sqlResult, logLine };
