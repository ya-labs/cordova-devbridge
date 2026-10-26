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

module.exports = { stripSql, isReadOnly, isSingleStatement, checkSql };
