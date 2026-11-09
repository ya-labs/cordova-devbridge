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

function inputResult(r) {
  if (r.action === 'tap') return `Toque em (${r.x}, ${r.y}). Confira com app_screenshot.`;
  if (r.action === 'swipe') return `Arrasto de (${r.x1}, ${r.y1}) até (${r.x2}, ${r.y2}).`;
  if (r.action === 'key') return `Tecla ${r.key} enviada.`;
  if (r.via === 'dom') return `Texto inserido no campo ${r.field} pelo app (${r.length} caractere(s))${r.value !== undefined ? `; valor agora: ${JSON.stringify(r.value)}` : ''}.`;
  return `Texto digitado por adb (${r.length} caractere(s)).`;
}

function kb(n) {
  return `${(n / 1024).toFixed(0)} KB`;
}

function snapshotResult(r) {
  const files = r.files.map((f) => `  ${f.name} (${kb(f.size)})`).join('\n');
  const reopen = r.reopened ? 'app reaberto' : 'app parado: abra-o no celular ou rode devbridge launch';
  if (r.removed) {
    const extra = r.removed.length ? `\nApagados (não estavam no snapshot): ${r.removed.join(', ')}` : '';
    return `Restaurado "${r.name}" (de ${r.createdAt}):\n${files}${extra}\n(${reopen})`;
  }
  return `Snapshot "${r.name}"${r.replaced ? ' (substituído)' : ''}:\n${files}\n(${reopen})`;
}

function snapshotList(list) {
  if (!list.length) return '(nenhum snapshot; crie com db_snapshot / devbridge db-snapshot <nome>)';
  return list.map((s) => `${s.name}  ${s.createdAt}  ${s.files} arquivo(s), ${kb(s.size)}${s.db ? `  (banco ${s.db})` : ''}`).join('\n');
}

function storageResult(r) {
  if (r.items) {
    if (!r.items.length) return `(${r.area}: vazio)`;
    const lines = r.items.map((i) => `${i.key}${i.internal ? ' [devbridge]' : ''} (${i.size}) ${i.preview.replace(/\s+/g, ' ')}`);
    return `${lines.join('\n')}\n\n(${r.area}: ${r.items.length} chave(s))`;
  }
  if (r.action === 'set') return `Gravado em ${r.area}: ${r.key} (${r.size} caracteres)`;
  if (r.action === 'remove') return r.removed ? `Removido de ${r.area}: ${r.key}` : `${r.key} não existia em ${r.area}`;
  const body = r.json !== undefined ? JSON.stringify(plain(r.json), null, 2) : r.value;
  const notes = [`${r.area}`, `${r.size} caracteres`];
  if (r.truncated) notes.push(`mostrando ${r.value.length}`);
  if (r.internal) notes.push('chave do devbridge');
  return `${body}\n\n(${r.key} · ${notes.join(' · ')})`;
}

function navigateResult(r) {
  const out = [`Rota atual: ${r.hash || '(sem hash)'}`];
  if (r.redirected) out.push(`O app redirecionou: o pedido foi ${r.requested}.`);
  out.push(`(${r.href} · ${r.ms} ms)`);
  return out.join('\n');
}

// ---- testes do app ----------------------------------------------------------
function duration(ms) {
  if (ms === null || ms === undefined) return '-';
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

// Horário local; o relatório lido do disco já traz ISO com fuso.
function clock(v) {
  if (v === null || v === undefined) return '-';
  if (typeof v === 'string') return v.slice(11, 19);
  return new Date(v).toTimeString().slice(0, 8);
}

function oneLine(v, max = 300) {
  const s = (typeof v === 'string' ? v : JSON.stringify(plain(v))).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function testsList(r) {
  if (!r.testes.length) return `Nenhum teste em ${r.pasta}/ (arquivos <nome>.test.js; veja o manual).`;
  const blocks = r.testes.map((t) => {
    const lines = [`${t.id}${t.descricao ? ` — ${t.descricao}` : ''}`];
    if (t.erro) lines.push(`  erro ao carregar no app: ${t.erro}`);
    if (t.etapas) lines.push(`  etapas: ${t.etapas.map((e, i) => `${i + 1}. ${e.nome} (${duration(e.tempoLimiteMs)})`).join(' · ')}`);
    else if (!t.erro) lines.push('  etapas: abra o app para listar');
    if (t.erroCasos) lines.push(`  casos: ${t.erroCasos}`);
    else lines.push(`  casos${t.arquivoCasos ? ` (${t.arquivoCasos})` : ' (sem arquivo: um caso vazio)'}: ${t.casos.join(', ')}`);
    if (t.analisaRespostas) lines.push('  analisa respostas do servidor nos casos com falha');
    return lines.join('\n');
  });
  if (!r.app) blocks.push('(app não conectado: etapas lidas da última vez que o app carregou o teste)');
  if (r.rodada) blocks.push(`Rodada ${r.rodada.id}: ${r.rodada.teste} · ${r.rodada.situacao}`);
  if (r.historico && r.historico.length) blocks.push(`Últimas rodadas (tests_status com id; CLI: test runs):\n${r.historico.map(runLine).join('\n')}`);
  return blocks.join('\n\n');
}

// "2026-11-09T14:03:05-03:00" -> "09/11 14:03"
function dayClock(v) {
  return typeof v === 'string' && v.length >= 16 ? `${v.slice(8, 10)}/${v.slice(5, 7)} ${v.slice(11, 16)}` : '-';
}

function runLine(r) {
  const ok = r.casos.filter((c) => c.situacao === 'ok').length;
  const f = r.falhas || {};
  const notes = [
    f.requisicoes ? `${f.requisicoes} req. com falha` : '',
    f.respostas ? `${f.respostas} resp. com erro` : '',
    f.logs ? `${f.logs} log(s) de erro` : '',
    r.restaurado === false ? 'RESTAURAÇÃO FALHOU' : '',
  ].filter(Boolean).join(' · ');
  return `${r.id}  ${dayClock(r.inicio)}  ${String(r.teste || '-').padEnd(20)} ${String(r.situacao).toUpperCase().padEnd(9)} ${`${ok}/${r.casos.length} ok`.padEnd(8)} ${duration(r.duracaoMs).padEnd(10)} ${notes}`.trimEnd();
}

function testRuns(r) {
  if (!r.rodadas.length) return `Nenhuma rodada em ${r.pasta}/.`;
  return `${r.rodadas.map(runLine).join('\n')}\n\nDetalhe: test status <ID> (MCP: tests_status com id).`;
}

function stepLine(e, i, current) {
  const mark = current === i + 1 ? '▶' : ' ';
  const info = e.erro ? `Erro: ${oneLine(e.erro)}` : e.detalhe ? oneLine(e.detalhe) : '';
  return `   ${mark}${String(i + 1).padStart(2)}. ${e.nome.padEnd(24)} ${e.situacao.padEnd(10)} ${duration(e.duracaoMs).padEnd(12)} ${info}`.trimEnd();
}

function testsStatus(run) {
  const head = [`Rodada ${run.id} · ${run.teste} · ${run.situacao.toUpperCase()}${run.cancelando ? ' (cancelando…)' : ''}`];
  head.push(`início ${clock(run.inicio)}${run.fim ? ` · fim ${clock(run.fim)} · ${duration(run.duracaoMs !== undefined ? run.duracaoMs : run.fim - run.inicio)}` : ''}`);
  if (run.erro) head.push(`Erro da rodada: ${run.erro}`);
  const out = [head.join('\n')];
  run.casos.forEach((c, ci) => {
    const lines = [`${ci + 1}. ${c.nome} — ${c.situacao.toUpperCase()}${c.duracaoMs !== null && c.duracaoMs !== undefined ? ` (${duration(c.duracaoMs)})` : ''}${c.telaAtual && c.situacao === 'rodando' ? ` · tela ${c.telaAtual}` : ''}`];
    c.etapas.forEach((e, i) => lines.push(stepLine(e, i, c.etapaAtual)));
    if (c.erro) lines.push(`   erro: ${oneLine(c.erro, 500)}`);
    for (const l of c.errosNoLog || []) lines.push(`   log de erro [etapa ${l.etapa}]: ${oneLine(l.msg)}`);
    for (const q of c.requisicoesComFalha || []) lines.push(`   requisição com falha: #${q.id} ${q.metodo} ${q.status || q.erro || q.situacao} ${q.url} [etapa ${q.etapa}]`);
    for (const q of c.respostasComErro || []) {
      lines.push(q.erro ? `   ${q.erro}` : `   resposta com erro: #${q.id} ${q.metodo} ${q.status} ${q.url} [etapa ${q.etapa}]: ${oneLine(q.achado, 500)}`);
    }
    if (c.dados && Object.keys(c.dados).length) lines.push(`   dados: ${oneLine(c.dados, 500)}`);
    out.push(lines.join('\n'));
  });
  const r = run.restauracao;
  if (r) {
    const removed = r.bancosRemovidos && r.bancosRemovidos.length ? ` · bancos criados na rodada removidos: ${r.bancosRemovidos.join(', ')}` : '';
    out.push(r.ok ? `Aparelho restaurado (armazenamento: ${r.armazenamento}; bancos: ${r.bancos})${removed}` : `FALHA NA RESTAURAÇÃO: ${r.erros.join('; ')}\n${r.manual}`);
  } else if (run.situacao === 'restaurando') {
    out.push('Restaurando o aparelho…');
  }
  if (run.relatorio) out.push(`Relatório: ${run.relatorio}`);
  if (run.doRelatorio) out.push(`Logs e requisições de uma etapa: tests_status com id ${run.id}, case e step (CLI: test status ${run.id} --case 1 --step 2).`);
  else out.push('Logs e requisições de uma etapa: tests_status com case e step (CLI: test status --case 1 --step 2); corpo da requisição com app_network_entry (CLI: network <id>).');
  return out.join('\n\n');
}

function testStep(d) {
  const head = [`Caso ${d.casoIndice} (${d.caso}) · etapa ${d.etapaIndice} (${d.etapa}): ${d.situacao}${d.duracaoMs !== null && d.duracaoMs !== undefined ? ` · ${duration(d.duracaoMs)}` : ''}`];
  if (d.erro) head.push(`Erro: ${d.erro}`);
  if (d.detalhe) head.push(`Detalhe: ${d.detalhe}`);
  if (d.aviso) head.push(d.aviso);
  const logs = d.logs.length ? d.logs.map((l) => `${clock(l.ts)} ${l.nivel.toUpperCase().padEnd(5)} ${l.msg}`).join('\n') : '(nenhum)';
  const reqs = d.requisicoes.length
    ? d.requisicoes.map((q) => `#${q.id} ${q.metodo} ${q.situacao === 'pending' ? 'pendente' : q.status}${q.ms !== undefined && q.ms !== null ? ` ${q.ms} ms` : ''} ${q.url}${q.erro ? ` (${q.erro})` : ''}`).join('\n')
    : '(nenhuma)';
  return `${head.join('\n')}\n\nLogs (${d.logs.length}):\n${logs}\n\nRequisições (${d.requisicoes.length}; corpo com app_network_entry):\n${reqs}`;
}

module.exports = { table, sqlResult, sqlBatchResult, logLine, networkLine, networkDetail, evalResult, navigateResult, storageResult, snapshotResult, snapshotList, inputResult, testsList, testsStatus, testStep, testRuns, duration };
