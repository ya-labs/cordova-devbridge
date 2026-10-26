'use strict';

// Remove comentários e literais para que palavras dentro de strings não
// contem como comandos (ex.: "select 'delete'" continua sendo leitura).
function stripSql(sql) {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .trim();
}

const WRITE_WORDS = /\b(insert|update|delete|replace|upsert|drop|alter|create|attach|detach|vacuum|reindex|analyze|begin|commit|rollback|savepoint|release)\b/i;

const READ_PRAGMAS = new Set([
  'table_info', 'table_xinfo', 'index_list', 'index_info', 'index_xinfo',
  'foreign_key_list', 'integrity_check', 'quick_check',
]);

// Uma instrução por chamada: ";" só é aceito no final.
function isSingleStatement(sql) {
  const body = stripSql(sql).replace(/;\s*$/, '');
  return !body.includes(';');
}

// Leitura = SELECT, EXPLAIN, PRAGMA sem atribuição, ou WITH ... sem DML.
function isReadOnly(sql) {
  const body = stripSql(sql).replace(/;\s*$/, '');
  const first = (body.match(/^\s*([a-z]+)/i) || [])[1];
  if (!first) return false;
  switch (first.toLowerCase()) {
    case 'select':
    case 'with':
    case 'explain':
      return !WRITE_WORDS.test(body);
    case 'pragma': {
      // PRAGMA x = y e PRAGMA x(y) alteram estado, exceto os de introspecção.
      if (body.includes('=')) return false;
      const m = body.match(/^pragma\s+(?:\w+\.)?(\w+)\s*(\()?/i);
      return !!m && (!m[2] || READ_PRAGMAS.has(m[1].toLowerCase()));
    }
    default:
      return false;
  }
}

function checkSql(sql, { write }) {
  if (typeof sql !== 'string' || !sql.trim()) return 'SQL vazio.';
  if (!isSingleStatement(sql)) return 'Envie uma instrução por vez (sem ";" no meio).';
  if (!write && !isReadOnly(sql)) {
    return 'Instrução de escrita recusada. Use --write (CLI) ou db_exec (MCP).';
  }
  return null;
}

const LEADING_COMMENTS = /^(\s*(--[^\n]*(\n|$)|\/\*[\s\S]*?\*\/))*\s*/;

// Divide um script em instruções: ";" dentro de string, identificador entre
// aspas ou comentário não separa; CREATE TRIGGER vai até o END que o fecha.
// Comentários antes de cada instrução saem (histórico e saída ficam limpos).
function splitSql(script) {
  const out = [];
  let start = 0;
  let i = 0;
  const s = String(script);
  const flush = (end) => {
    const stmt = s.slice(start, end).replace(LEADING_COMMENTS, '').trim();
    if (stripSql(stmt)) out.push(stmt);
    start = end + 1;
  };
  while (i < s.length) {
    const c = s[i];
    if (c === "'" || c === '"' || c === '`') {
      const close = s.indexOf(c, i + 1);
      i = close < 0 ? s.length : close + 1;
      // aspas dobradas ('') continuam a mesma string
      while (i < s.length && s[i] === c) {
        const again = s.indexOf(c, i + 1);
        i = again < 0 ? s.length : again + 1;
      }
      continue;
    }
    if (c === '-' && s[i + 1] === '-') {
      const nl = s.indexOf('\n', i);
      i = nl < 0 ? s.length : nl + 1;
      continue;
    }
    if (c === '/' && s[i + 1] === '*') {
      const end = s.indexOf('*/', i + 2);
      i = end < 0 ? s.length : end + 2;
      continue;
    }
    if (c === ';') {
      const current = stripSql(s.slice(start, i));
      const trigger = /^create\s+(temp\s+|temporary\s+)?trigger\b/i.test(current);
      if (!trigger || /\bend\s*$/i.test(current)) flush(i);
    }
    i++;
  }
  flush(s.length);
  return out;
}

module.exports = { stripSql, isReadOnly, isSingleStatement, checkSql, splitSql };
