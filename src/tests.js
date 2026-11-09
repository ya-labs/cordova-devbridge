'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const SAFE = /^[\w.-]+$/;
const STEP_LIMIT = 60000;
const DEFAULT_CASE = 'padrão';
const STEP_LOGS = 200;
const STEP_REQUESTS = 200;
const ANALYZE_MAX = 100;
const ANALYZE_BYTES = 8 * 1024 * 1024;
const RUNS_MAX = 200;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Horário local com o fuso, ex.: 2026-11-09T14:03:05-03:00 (relatórios e histórico).
function localIso(ms) {
  if (typeof ms !== 'number') return ms;
  const d = new Date(ms);
  const pad = (n) => String(Math.abs(n)).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const zone = `${off >= 0 ? '+' : '-'}${pad(Math.trunc(off / 60))}:${pad(off % 60)}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${zone}`;
}

function testsDir(config) {
  return path.join(config.stateDir, 'tests');
}

function runsDir(config) {
  return path.join(config.stateDir, 'test-runs');
}

function listTestIds(config) {
  const dir = testsDir(config);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.test.js'))
    .map((f) => f.slice(0, -'.test.js'.length))
    .filter((id) => SAFE.test(id))
    .sort();
}

// Código comum: .devbridge/tests/*.comum.js, carregado no app antes dos testes, em ordem alfabética.
function readComum(config) {
  const dir = testsDir(config);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.comum.js') && SAFE.test(f))
    .sort()
    .map((f) => {
      const source = fs.readFileSync(path.join(dir, f), 'utf8');
      return { file: f.slice(0, -'.comum.js'.length), source, hash: sha(source) };
    });
}

function sha(text) {
  return crypto.createHash('sha1').update(text).digest('hex').slice(0, 12);
}

function readSource(config, id) {
  if (!SAFE.test(id || '')) throw new Error('Nome de teste inválido: use o nome do arquivo sem .test.js.');
  const file = path.join(testsDir(config), `${id}.test.js`);
  if (!fs.existsSync(file)) {
    const all = listTestIds(config);
    throw new Error(`Teste "${id}" não existe em .devbridge/tests/. Disponíveis: ${all.join(', ') || '(nenhum)'}`);
  }
  return fs.readFileSync(file, 'utf8');
}

// Casos do teste: <teste>.local.json ou, sem ele, casos.local.json (fora do Git).
// Sem arquivo, o teste roda uma vez com um caso vazio.
function casesFile(config, id) {
  for (const name of [`${id}.local.json`, 'casos.local.json']) {
    const file = path.join(testsDir(config), name);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

function readCases(config, id) {
  const file = casesFile(config, id);
  if (!file) return { file: null, cases: [{ nome: DEFAULT_CASE }] };
  const rel = path.relative(config.root, file);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`${rel}: JSON inválido (${err.message}).`);
  }
  // Uma lista, ou um objeto cuja primeira propriedade com lista é usada (ex.: { "casos": [...] }).
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? Object.values(raw).find(Array.isArray) : null;
  if (!list || !list.length) throw new Error(`${rel}: esperado uma lista de casos, ou um objeto com ela (ex.: { "casos": [{ "nome": "..." }] }).`);
  const seen = new Set();
  list.forEach((c, i) => {
    if (!c || typeof c !== 'object' || typeof c.nome !== 'string' || !c.nome) throw new Error(`${rel}: o caso ${i + 1} não tem "nome".`);
    if (seen.has(c.nome)) throw new Error(`${rel}: há dois casos com o nome "${c.nome}".`);
    seen.add(c.nome);
  });
  return { file: rel, cases: list };
}

function blankStep(e) {
  return { nome: e.nome, situacao: 'aguardando', inicio: null, fim: null, duracaoMs: null, detalhe: '', erro: null };
}

function blankTest(id) {
  return { teste: id, nome: id, situacao: 'aguardando', inicio: null, fim: null, duracaoMs: null, erro: null, etapas: [] };
}

// Caso de uma rodada: os testes da lista, em ordem, sem restaurar entre eles.
function blankCase(nome, ids) {
  return {
    nome, situacao: 'aguardando', inicio: null, fim: null, duracaoMs: null, erro: null,
    testeAtual: null, etapaAtual: null, telaAtual: '', testes: ids.map(blankTest), dados: {},
    errosNoLog: [], requisicoesComFalha: [], respostasComErro: [],
  };
}

function shortRequest(e) {
  const out = { id: e.id, metodo: e.method, url: e.url, situacao: e.state, status: e.status, ms: e.ms };
  if (e.error) out.erro = e.error;
  return out;
}

function shortLog(e) {
  return { seq: e.seq, nivel: e.level, msg: e.msg, ts: e.ts };
}

function reportFiles(config) {
  const dir = runsDir(config);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.endsWith('.storage.json')).sort().reverse();
}

// Relatório de um teste só, gravado antes dos testes encadeados (etapas direto no
// caso), convertido para o formato atual: casos[].testes[].etapas.
function normalizeReport(r) {
  if (!r || !Array.isArray(r.casos)) return r;
  if (!Array.isArray(r.testes)) r.testes = [r.teste];
  for (const c of r.casos) {
    if (Array.isArray(c.testes)) continue;
    c.testes = [{
      teste: r.teste, nome: r.nome || r.teste, situacao: c.situacao, inicio: c.inicio, fim: c.fim, duracaoMs: c.duracaoMs,
      erro: c.erro, etapas: c.etapas || [], antes: c.antes, depois: c.depois,
    }];
    delete c.etapas;
    delete c.antes;
    delete c.depois;
    for (const list of [c.errosNoLog, c.requisicoesComFalha, c.respostasComErro]) {
      for (const x of list || []) if (x.etapa !== undefined) x.teste = r.teste;
    }
  }
  return r;
}

// Logs e requisições de uma etapa (ou de antes/depois) de um teste no relatório.
function reportStep(t, step) {
  const src = typeof step === 'number' ? t.etapas[step] : t[step];
  if (!src || !Array.isArray(src.logs)) return { logs: [], requisicoes: [], aviso: 'Este relatório não guardou os logs e as requisições das etapas.' };
  return { logs: src.logs, requisicoes: src.requisicoes || [] };
}

// O que um teste requer (requer: ['outro']) precisa vir antes dele na lista.
function checkRequires(ids, metas) {
  const missing = [];
  metas.forEach((m, i) => {
    for (const req of m.requer || []) {
      const at = ids.indexOf(req);
      if (at < 0 || at > i) missing.push(`${ids[i]} requer ${req} antes dele`);
    }
  });
  if (!missing.length) return;
  const order = [];
  metas.forEach((m, i) => {
    for (const req of m.requer || []) if (!order.includes(req)) order.push(req);
    if (!order.includes(ids[i])) order.push(ids[i]);
  });
  throw new Error(`Ordem dos testes: ${missing.join('; ')}. Rode tests_run com tests ${JSON.stringify(order)} (CLI: devbridge test run ${order.join(' ')}).`);
}

function count(list, fn) {
  return list.reduce((n, x) => n + (fn(x) ? 1 : 0), 0);
}

// Resumo de uma rodada para o histórico.
function runSummary(r, file) {
  const casos = (r.casos || []).map((c) => ({ nome: c.nome, situacao: c.situacao, duracaoMs: c.duracaoMs }));
  const all = r.casos || [];
  return {
    id: r.id, teste: r.teste, testes: r.testes || [r.teste], nome: r.nome, situacao: r.situacao, inicio: r.inicio, fim: r.fim, duracaoMs: r.duracaoMs,
    erro: r.erro, restaurado: r.restauracao ? !!r.restauracao.ok : null, arquivo: `.devbridge/test-runs/${file}`, casos,
    falhas: {
      requisicoes: all.reduce((n, c) => n + (c.requisicoesComFalha || []).length, 0),
      respostas: all.reduce((n, c) => n + count(c.respostasComErro || [], (q) => !q.erro), 0),
      logs: all.reduce((n, c) => n + (c.errosNoLog || []).length, 0),
    },
  };
}

// Rodada de testes: guarda o estado do aparelho (armazenamento e bancos), roda
// os casos um a um no app e devolve o aparelho ao estado de antes, mesmo com
// falha ou cancelamento. Uma rodada por vez.
class TestRunner {
  constructor(server, { pollMs = 1000, readyTimeoutMs = 120000, appLostMs = 30000, caseMarginMs = 120000 } = {}) {
    this.server = server;
    this.config = server.config;
    this.pollMs = pollMs;
    this.readyTimeoutMs = readyTimeoutMs;
    this.appLostMs = appLostMs;
    this.caseMarginMs = caseMarginMs;
    this.current = null;
    this.done = null;
    this.meta = new Map(); // teste -> { hash, meta }
    this.frozen = new Map(); // rodada/caso/teste/etapa -> { logs, requisicoes }
    this.rev = 0;
    this.waiters = new Set();
  }

  busy() {
    return !!(this.current && !this.current.fim);
  }

  touch() {
    this.rev++;
    for (const w of this.waiters) w();
    this.waiters.clear();
  }

  waitChange(after, ms) {
    if (this.rev > after || ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.waiters.add(done);
    });
  }

  async history(run, event, detail) {
    await fsp.mkdir(this.config.stateDir, { recursive: true });
    const line = [localIso(Date.now()), run.id, run.teste, event, String(detail || '').replace(/\s+/g, ' ')].join('\t');
    await fsp.appendFile(path.join(this.config.stateDir, 'test-history.log'), line + '\n');
  }

  // ---- app -----------------------------------------------------------------
  async waitApp(since, timeoutMs = this.readyTimeoutMs) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (this.server.readySince(since)) return;
      await sleep(Math.min(200, this.pollMs));
    }
    throw new Error(`O app não ficou pronto (deviceready) em ${Math.round(timeoutMs / 1000)} s.`);
  }

  // O hash do teste inclui o do código comum: mudou o comum, o teste é avaliado de novo.
  async load(id, source = readSource(this.config, id), comum = readComum(this.config)) {
    const hash = sha(`${comum.map((c) => `${c.file}:${c.hash}`).join(',')}\n${source}`);
    const meta = await this.server.request('test', { action: 'load', file: id, source, hash, comum }, 15000);
    this.meta.set(id, { hash, meta });
    return meta;
  }

  // ---- operações -------------------------------------------------------------
  async list() {
    const ids = listTestIds(this.config);
    const ready = this.server.readySince(0);
    const testes = [];
    for (const id of ids) {
      const item = { id, arquivo: `.devbridge/tests/${id}.test.js` };
      try {
        const c = readCases(this.config, id);
        item.casos = c.cases.map((x) => x.nome);
        item.arquivoCasos = c.file;
      } catch (err) {
        item.erroCasos = err.message;
      }
      const cached = this.meta.get(id);
      try {
        // Durante uma rodada o app está ocupado: usa as etapas já lidas.
        const meta = ready && !this.busy() ? await this.load(id) : cached && cached.meta;
        if (meta) Object.assign(item, { nome: meta.nome, descricao: meta.descricao, etapas: meta.etapas, requer: meta.requer, analisaRespostas: meta.analisaRespostas });
      } catch (err) {
        item.erro = err.message;
      }
      testes.push(item);
    }
    const historico = this.runs({ limit: 5 }).rodadas;
    const comum = readComum(this.config).map((c) => `.devbridge/tests/${c.file}.comum.js`);
    return { pasta: '.devbridge/tests', app: ready, comum, testes, rodada: this.current ? this.summary(this.current) : null, historico };
  }

  // Histórico: relatórios de .devbridge/test-runs/, do mais novo ao mais antigo.
  runs({ teste = null, limit = 100 } = {}) {
    const max = Math.min(Math.max(Number(limit) || 100, 1), RUNS_MAX);
    const rodadas = [];
    const testes = new Set();
    for (const file of reportFiles(this.config).slice(0, RUNS_MAX * 2)) {
      let r;
      try {
        r = JSON.parse(fs.readFileSync(path.join(runsDir(this.config), file), 'utf8'));
      } catch (err) {
        if (!teste && rodadas.length < max) rodadas.push({ id: file.replace(/\.json$/, ''), arquivo: `.devbridge/test-runs/${file}`, situacao: 'ilegível', erro: err.message, casos: [] });
        continue;
      }
      if (!r || typeof r.id !== 'string') continue;
      normalizeReport(r);
      for (const t of r.testes) testes.add(t);
      if (teste && !r.testes.includes(teste)) continue;
      if (rodadas.length < max) rodadas.push(runSummary(r, file));
    }
    return { pasta: '.devbridge/test-runs', testes: [...testes].sort(), rodadas };
  }

  // tests: lista ordenada; em cada caso os testes rodam nessa ordem, sem restaurar
  // o aparelho entre eles. test: atalho para um teste só.
  run({ test, tests, cases } = {}) {
    if (this.busy()) {
      throw new Error(`Já existe uma rodada em andamento (${this.current.id}, ${this.current.teste}). Acompanhe com tests_status ou cancele com tests_cancel.`);
    }
    const ids = tests !== undefined && tests !== null ? [].concat(tests) : test ? [test] : [];
    if (!ids.length || ids.some((x) => typeof x !== 'string' || !x)) {
      throw new Error('Informe o teste (nome do arquivo sem .test.js) ou a lista de testes em ordem.');
    }
    if (new Set(ids).size !== ids.length) throw new Error(`Teste repetido na lista: ${ids.join(', ')}.`);
    const sources = ids.map((id) => readSource(this.config, id));
    const comum = readComum(this.config);
    const all = readCases(this.config, ids[0]).cases;
    let chosen = all;
    const wanted = cases === undefined || cases === null ? [] : Array.isArray(cases) ? cases : [cases];
    if (wanted.length) {
      const unknown = wanted.filter((n) => !all.some((c) => c.nome === n));
      if (unknown.length) throw new Error(`Caso(s) inexistente(s): ${unknown.join(', ')}. Disponíveis: ${all.map((c) => c.nome).join(', ')}`);
      chosen = all.filter((c) => wanted.includes(c.nome));
    }
    if (!this.server.readySince(0)) throw new Error('Nenhum app pronto (deviceready). Abra o app dev no celular com o devbridge start no ar.');
    const now = Date.now();
    let id = localIso(now).slice(0, 19).replace(/:/g, '-');
    if (this.current && this.current.id.startsWith(id)) id += `-${crypto.randomBytes(2).toString('hex')}`;
    const run = {
      id, teste: ids.join('+'), testes: ids, nome: ids.join(' → '), descricao: '', situacao: 'preparando', inicio: now, fim: null, erro: null,
      cancelamento: false, casos: chosen.map((c) => blankCase(c.nome, ids)), restauracao: null, relatorio: null,
    };
    this.current = run;
    this.frozen.clear();
    this.touch();
    this.history(run, 'inicio', `casos=${chosen.map((c) => c.nome).join(',')}`).catch(() => {});
    // Os casos (com credenciais) ficam só nesta closure e no app: nunca no estado da rodada.
    this.done = this.execute(run, sources, comum, chosen);
    return this.summary(run);
  }

  cancel() {
    if (!this.busy()) throw new Error('Nenhuma rodada em andamento.');
    const run = this.current;
    if (!run.cancelamento) {
      run.cancelamento = true;
      this.history(run, 'cancelamento', run.situacao).catch(() => {});
      this.touch();
    }
    return this.summary(run);
  }

  async status({ id, caso, teste, etapa, after, waitMs } = {}) {
    const wantStep = caso !== undefined && caso !== null && caso !== '';
    // Rodada encerrada com relatório gravado: o relatório tem também os logs das etapas.
    const finished = this.current && this.current.id === id && this.current.fim && this.current.relatorio;
    if (id && (!this.current || this.current.id !== id || finished)) {
      const report = this.readReport(id);
      return wantStep ? this.stepDetail(report, caso, teste, etapa) : report;
    }
    if (!this.current) throw new Error('Nenhuma rodada nesta sessão do devbridge start. Inicie com tests_run ou veja as anteriores no tests_list.');
    if (wantStep) return this.stepDetail(this.current, caso, teste, etapa);
    const wait = Math.min(Math.max(Number(waitMs) || 0, 0), 120000);
    if (after !== undefined && after !== null && after !== '') {
      await this.waitChange(Number(after), Math.min(wait || 25000, 25000));
    } else if (wait) {
      const end = Date.now() + wait;
      while (this.busy() && Date.now() < end) await this.waitChange(this.rev, end - Date.now());
    }
    return this.summary(this.current);
  }

  // Tela de testes: long-poll que também avisa de rodada iniciada pelo MCP ou pela CLI.
  async live(after) {
    if (after !== undefined && after !== null && after !== '') await this.waitChange(Number(after), 25000);
    return { rev: this.rev, rodada: this.current ? this.summary(this.current) : null };
  }

  summary(run) {
    const { cancelamento, metas, ...out } = run;
    return { ...out, cancelando: cancelamento && !run.fim, rev: this.rev };
  }

  readReport(id) {
    if (!SAFE.test(id)) throw new Error('Id de rodada inválido.');
    // O nome é <id>-<teste>.json; o id de dentro desempata ids com sufixo (…-ab12).
    for (const f of reportFiles(this.config)) {
      if (!f.startsWith(`${id}-`)) continue;
      let r;
      try {
        r = JSON.parse(fs.readFileSync(path.join(runsDir(this.config), f), 'utf8'));
      } catch (err) {
        continue;
      }
      if (r && r.id === id) return normalizeReport({ ...r, arquivo: `.devbridge/test-runs/${f}`, doRelatorio: true });
    }
    throw new Error(`Rodada "${id}" não encontrada em .devbridge/test-runs/.`);
  }

  // caso e teste: índice (1, 2…) ou nome; etapa: índice (1, 2…), nome, "antes" ou
  // "depois". O teste pode faltar quando a rodada tem um só. run: a rodada atual
  // ou um relatório lido do disco.
  stepDetail(run, caso, teste, etapa) {
    let ci = run.casos.findIndex((c) => c.nome === caso);
    if (ci < 0 && /^\d+$/.test(String(caso))) ci = Number(caso) - 1;
    const c = run.casos[ci];
    if (!c) throw new Error(`Caso "${caso}" não existe nesta rodada. Casos: ${run.casos.map((x, i) => `${i + 1}. ${x.nome}`).join(', ')}`);
    const testList = c.testes.map((t, i) => `${i + 1}. ${t.teste}`).join(', ');
    let ti = 0;
    if (teste !== undefined && teste !== null && teste !== '') {
      ti = c.testes.findIndex((t) => t.teste === teste || t.nome === teste);
      if (ti < 0 && /^\d+$/.test(String(teste))) ti = Number(teste) - 1;
      if (!c.testes[ti]) throw new Error(`Teste "${teste}" não está nesta rodada. Testes: ${testList}`);
    } else if (c.testes.length > 1) {
      throw new Error(`Informe o teste (número ou nome). Testes: ${testList}`);
    }
    const t = c.testes[ti];
    if (etapa === undefined || etapa === null || etapa === '') throw new Error('Informe a etapa (número, nome, "antes" ou "depois").');
    let step;
    if (etapa === 'antes' || etapa === 'depois') step = etapa;
    else {
      step = t.etapas.findIndex((e) => e.nome === etapa);
      if (step < 0 && /^\d+$/.test(String(etapa))) step = Number(etapa) - 1;
      if (!t.etapas[step]) throw new Error(`Etapa "${etapa}" não existe em ${t.teste}. Etapas: ${t.etapas.map((e, i) => `${i + 1}. ${e.nome}`).join(', ')}`);
    }
    const tag = `${run.id}/${ci}/${ti}/${step}`;
    const data = run.doRelatorio ? reportStep(t, step) : this.frozen.get(tag) || this.collectStep(tag);
    const e = typeof step === 'number' ? t.etapas[step] : { nome: step, situacao: t.situacao, erro: null, detalhe: '', duracaoMs: null };
    return {
      rodada: run.id, caso: c.nome, casoIndice: ci + 1, teste: t.teste, testeIndice: ti + 1, testes: c.testes.length,
      etapa: e.nome, etapaIndice: typeof step === 'number' ? step + 1 : step,
      situacao: e.situacao, erro: e.erro, detalhe: e.detalhe, duracaoMs: e.duracaoMs, ...data,
    };
  }

  collectStep(tag) {
    const logs = this.server.getLogs({ test: tag, limit: STEP_LOGS }).entries.map(shortLog);
    const requisicoes = this.server.network.list({ test: tag, limit: STEP_REQUESTS }).entries.map(shortRequest);
    return { logs, requisicoes };
  }

  // ---- execução --------------------------------------------------------------
  set(target, fields) {
    Object.assign(target, fields);
    this.touch();
  }

  async execute(run, sources, comum, cases) {
    const s = this.server;
    let storage = null;
    let snapshot = null;
    try {
      const metas = [];
      for (let ti = 0; ti < run.testes.length; ti++) metas.push(await this.load(run.testes[ti], sources[ti], comum));
      // Ordem errada é recusada antes de mexer no aparelho.
      checkRequires(run.testes, metas);
      run.metas = metas;
      if (metas.length === 1) {
        run.nome = metas[0].nome;
        run.descricao = metas[0].descricao;
      }
      for (const c of run.casos) {
        c.testes.forEach((t, ti) => {
          t.nome = metas[ti].nome;
          t.etapas = metas[ti].etapas.map(blankStep);
        });
      }
      this.set(run, { situacao: 'salvando' });
      storage = await s.request('test', { action: 'saveStorage' }, 30000);
      await this.writeStorage(run, storage);
      if (!run.cancelamento) {
        const since = Date.now();
        const snap = await s.snapshot({ name: `teste-${run.id}` });
        snapshot = snap.name;
        if (!snap.reopened) throw new Error('O app não reabriu depois do snapshot.');
        await this.waitApp(since);
      }
      this.set(run, { situacao: 'rodando' });
      for (let i = 0; i < cases.length; i++) {
        if (run.cancelamento) {
          const c = run.casos[i];
          c.situacao = 'pulado';
          for (const t of c.testes) {
            t.situacao = 'pulado';
            t.etapas.forEach((e) => { e.situacao = 'pulada'; });
          }
          continue;
        }
        await this.runCase(run, i, sources, comum, cases[i]);
      }
    } catch (err) {
      run.erro = err.message;
    } finally {
      await this.restore(run, storage, snapshot);
      delete run.metas;
      run.situacao = run.erro ? 'erro' : run.cancelamento ? 'cancelada' : run.casos.every((c) => c.situacao === 'ok') ? 'ok' : 'falha';
      run.fim = Date.now();
      try {
        run.relatorio = await this.writeReport(run);
      } catch (err) {
        run.erro = run.erro || `Falha ao gravar o relatório: ${err.message}`;
      }
      await this.history(run, 'fim', `${run.situacao}${run.restauracao && !run.restauracao.ok ? ' restauracao=FALHA' : ''}`).catch(() => {});
      this.touch();
    }
  }

  // Os testes da rodada em sequência, com o estado deixado pelo anterior. Depois
  // de um teste que não passou, os seguintes do caso ficam pulados.
  async runCase(run, i, sources, comum, data) {
    const c = run.casos[i];
    this.set(c, { situacao: 'rodando', inicio: Date.now() });
    let stop = false;
    for (let ti = 0; ti < run.testes.length; ti++) {
      const t = c.testes[ti];
      if (stop || run.cancelamento) {
        t.situacao = 'pulado';
        t.etapas.forEach((e) => { if (e.situacao === 'aguardando') e.situacao = 'pulada'; });
        continue;
      }
      await this.runTest(run, i, ti, sources[ti], comum, data);
      if (t.situacao !== 'ok') stop = true;
    }
    const bad = c.testes.find((t) => t.situacao !== 'ok' && t.situacao !== 'pulado');
    c.fim = Date.now();
    c.duracaoMs = c.fim - c.inicio;
    c.situacao = c.testes.every((t) => t.situacao === 'ok') ? 'ok' : bad ? bad.situacao : run.cancelamento ? 'cancelada' : 'pulado';
    c.erro = bad && bad.erro ? (c.testes.length > 1 ? `${bad.teste}: ${bad.erro}` : bad.erro) : null;
    c.testeAtual = null;
    c.etapaAtual = null;
    await this.collectCase(run, i, sources, comum);
    this.touch();
  }

  async runTest(run, i, ti, source, comum, data) {
    const s = this.server;
    const c = run.casos[i];
    const t = c.testes[ti];
    const file = run.testes[ti];
    const limit = run.metas[ti].etapas.reduce((n, e) => n + (e.tempoLimiteMs || STEP_LIMIT), 0) + this.caseMarginMs;
    let cancelSent = false;
    const sendCancel = async () => {
      if (cancelSent) return;
      cancelSent = true;
      await s.request('test', { action: 'cancel' }, 5000).catch(() => {});
    };
    t.inicio = Date.now();
    this.set(t, { situacao: 'rodando' });
    c.testeAtual = ti + 1;
    try {
      await this.load(file, source, comum);
      let st = await s.request('test', { action: 'start', run: run.id, caso: i, teste: ti, file, dados: data }, 10000);
      this.merge(c, ti, st);
      const started = Date.now();
      let lostSince = null;
      while (!st || !st.fim) {
        await sleep(this.pollMs);
        if (run.cancelamento) await sendCancel();
        if (Date.now() - started > limit) {
          await sendCancel();
          throw new Error(`O teste passou de ${Math.round(limit / 1000)} s sem terminar (soma dos tempos limite das etapas e mais ${Math.round(this.caseMarginMs / 1000)} s).`);
        }
        let next;
        try {
          next = await s.request('test', { action: 'state' }, 5000);
          lostSince = null;
        } catch (err) {
          lostSince = lostSince || Date.now();
          if (Date.now() - lostSince > this.appLostMs) throw new Error(`O app parou de responder durante o caso (${err.message})`);
          continue;
        }
        if (!next || next.run !== run.id || next.caso !== i || next.teste !== ti) throw new Error('O app recarregou durante o caso e o estado do teste se perdeu.');
        st = next;
        this.merge(c, ti, st);
      }
    } catch (err) {
      t.situacao = 'erro';
      t.erro = err.message;
      for (const e of t.etapas) {
        if (e.situacao === 'rodando') Object.assign(e, { situacao: 'falha', erro: e.erro || err.message });
        else if (e.situacao === 'aguardando') e.situacao = 'pulada';
      }
    }
    t.fim = Date.now();
    t.duracaoMs = t.fim - t.inicio;
    c.etapaAtual = null;
    this.touch();
  }

  merge(c, ti, st) {
    if (!st) return;
    const t = c.testes[ti];
    const before = JSON.stringify(c);
    t.situacao = st.fim ? st.situacao : 'rodando';
    t.erro = st.erro || null;
    if (Array.isArray(st.etapas)) t.etapas = st.etapas;
    c.testeAtual = ti + 1;
    c.etapaAtual = st.atual === null || st.atual === undefined ? null : st.atual + 1;
    c.telaAtual = st.telaAtual || '';
    c.dados = st.dados || {};
    if (JSON.stringify(c) !== before) this.touch();
  }

  // Fim do caso: copia logs e requisições de cada etapa (o buffer do servidor
  // descarta os antigos) e, se falhou, passa as respostas de cada teste à
  // análise dele no app.
  async collectCase(run, i, sources, comum) {
    const s = this.server;
    const c = run.casos[i];
    const prefix = `${run.id}/${i}/`;
    c.testes.forEach((t, ti) => {
      for (const step of ['antes', ...t.etapas.map((e, k) => k), 'depois']) {
        this.frozen.set(`${prefix}${ti}/${step}`, this.collectStep(`${prefix}${ti}/${step}`));
      }
    });
    const where = (tag) => {
      const [ti, k] = String(tag || '').slice(prefix.length).split('/');
      const t = c.testes[Number(ti)];
      return { ti: Number(ti), teste: t ? t.teste : null, etapa: /^\d+$/.test(k || '') ? Number(k) + 1 : k };
    };
    const mark = (e) => {
      const w = where(e.test);
      return { teste: w.teste, etapa: w.etapa };
    };
    c.errosNoLog = s.getLogs({ test: prefix, level: 'error', limit: 50 }).entries.map((e) => ({ ...shortLog(e), ...mark(e) }));
    c.requisicoesComFalha = s.network.list({ test: prefix, failed: true, local: true, limit: 50 }).entries.map((e) => ({ ...shortRequest(e), ...mark(e) }));
    if (c.situacao === 'ok' || !run.metas.some((m) => m.analisaRespostas)) return;
    let bytes = 0;
    let total = 0;
    const byTest = new Map();
    for (const e of s.network.entriesFor(prefix).reverse()) {
      if (e.state !== 'done' || !e.response || !e.response.body) continue;
      const w = where(e.test);
      if (!run.metas[w.ti] || !run.metas[w.ti].analisaRespostas) continue;
      const size = (e.response.body || '').length + ((e.request && e.request.body) || '').length;
      if (total >= ANALYZE_MAX || bytes + size > ANALYZE_BYTES) break;
      bytes += size;
      total++;
      if (!byTest.has(w.ti)) byTest.set(w.ti, []);
      byTest.get(w.ti).push({
        id: e.id, metodo: e.method, url: e.url, status: e.status, teste: w.teste, etapa: w.etapa,
        requisicao: e.request ? e.request.body : null, resposta: e.response.body, cortada: !!e.response.truncated,
      });
    }
    const found = [];
    for (const [ti, respostas] of byTest) {
      const file = run.testes[ti];
      try {
        await this.load(file, sources[ti], comum);
        const got = await s.request('test', { action: 'analyze', file, respostas }, 60000);
        const byId = new Map(respostas.map((r) => [r.id, r]));
        for (const f of got || []) {
          const r = byId.get(f.id) || {};
          found.push({ id: f.id, metodo: r.metodo, url: r.url, status: r.status, teste: r.teste, etapa: r.etapa, achado: f.achado });
        }
      } catch (err) {
        found.push({ erro: `Falha ao analisar as respostas de ${file} no app: ${err.message}` });
      }
    }
    c.respostasComErro = found;
  }

  // Armazenamento antes dos bancos: com o app no ar ele grava o storage, e o
  // restore dos bancos o reabre já com tudo no lugar.
  async restore(run, storage, snapshot) {
    const s = this.server;
    this.set(run, { situacao: 'restaurando' });
    const r = { ok: true, armazenamento: storage ? null : 'não salvo', bancos: snapshot ? null : 'sem snapshot', bancosRemovidos: [], erros: [] };
    const restoreStorage = async () => {
      await this.waitApp(0, 60000);
      await s.request('test', { action: 'restoreStorage', salvo: storage }, 30000);
      r.armazenamento = 'ok';
    };
    if (storage) {
      try {
        await restoreStorage();
      } catch (err) {
        r.erros.push(`armazenamento: ${err.message}`);
      }
    }
    if (snapshot) {
      try {
        const since = Date.now();
        const res = await s.restore({ name: snapshot });
        r.bancosRemovidos = res.removed || [];
        r.bancos = 'ok';
        if (res.reopened) await this.waitApp(since);
      } catch (err) {
        r.erros.push(`bancos: ${err.message}`);
      }
    }
    // Volta o limite de corpo da rede ao normal se o app não foi reaberto.
    await s.request('test', { action: 'end' }, 3000).catch(() => {});
    // Sem app na primeira tentativa: grava agora e recarrega para o app ler o storage certo.
    if (storage && r.armazenamento !== 'ok' && s.readySince(0)) {
      try {
        await restoreStorage();
        r.erros = r.erros.filter((e) => !e.startsWith('armazenamento:'));
        s.reload();
      } catch (err) {
        r.erros.push(`armazenamento (2ª tentativa): ${err.message}`);
      }
    }
    r.ok = !r.erros.length;
    if (r.ok) {
      // O estado salvo tem a sessão do app: só fica no disco se a restauração falhar.
      fs.rmSync(this.storageFile(run), { force: true });
      if (snapshot) fs.rmSync(path.join(this.config.stateDir, 'snapshots', snapshot), { recursive: true, force: true });
    } else {
      r.manual = `Restaure à mão: devbridge db-restore ${snapshot || '(sem snapshot)'} e o armazenamento salvo em ${path.relative(this.config.root, this.storageFile(run))}.`;
    }
    run.restauracao = r;
    this.touch();
  }

  storageFile(run) {
    return path.join(runsDir(this.config), `${run.id}.storage.json`);
  }

  async writeStorage(run, storage) {
    await fsp.mkdir(runsDir(this.config), { recursive: true });
    await fsp.writeFile(this.storageFile(run), JSON.stringify(storage, null, 2));
  }

  async writeReport(run) {
    const iso = (ms) => localIso(ms);
    const report = {
      id: run.id, teste: run.teste, testes: run.testes, nome: run.nome, descricao: run.descricao, situacao: run.situacao,
      inicio: iso(run.inicio), fim: iso(run.fim), duracaoMs: run.fim - run.inicio, erro: run.erro, restauracao: run.restauracao,
      // Logs e resumo das requisições (sem corpo) de cada etapa, para o histórico.
      casos: run.casos.map((c, ci) => {
        const step = (ti, k) => {
          const d = this.frozen.get(`${run.id}/${ci}/${ti}/${k}`) || { logs: [], requisicoes: [] };
          return { logs: d.logs.map((l) => ({ ...l, ts: iso(l.ts) })), requisicoes: d.requisicoes };
        };
        return {
          ...c,
          inicio: iso(c.inicio),
          fim: iso(c.fim),
          testes: c.testes.map((t, ti) => ({
            ...t,
            inicio: iso(t.inicio),
            fim: iso(t.fim),
            antes: step(ti, 'antes'),
            etapas: t.etapas.map((e, k) => ({ ...e, inicio: iso(e.inicio), fim: iso(e.fim), ...step(ti, k) })),
            depois: step(ti, 'depois'),
          })),
          errosNoLog: c.errosNoLog.map((e) => ({ ...e, ts: iso(e.ts) })),
        };
      }),
    };
    await fsp.mkdir(runsDir(this.config), { recursive: true });
    const file = path.join(runsDir(this.config), `${run.id}-${run.teste}.json`);
    await fsp.writeFile(file, JSON.stringify(report, null, 2) + '\n');
    return path.relative(this.config.root, file);
  }
}

module.exports = { TestRunner, readCases, readComum, listTestIds, localIso, normalizeReport };
