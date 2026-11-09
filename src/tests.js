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

function stepKey(step) {
  return step === 'antes' || step === 'depois' ? step : Number(step);
}

function blankCase(nome) {
  return {
    nome, situacao: 'aguardando', inicio: null, fim: null, duracaoMs: null, erro: null,
    etapaAtual: null, telaAtual: '', etapas: [], dados: {},
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
    this.frozen = new Map(); // rodada/caso/etapa -> { logs, requisicoes }
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

  async load(id, source = readSource(this.config, id)) {
    const hash = crypto.createHash('sha1').update(source).digest('hex').slice(0, 12);
    const meta = await this.server.request('test', { action: 'load', file: id, source, hash }, 15000);
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
        if (meta) Object.assign(item, { nome: meta.nome, descricao: meta.descricao, etapas: meta.etapas, analisaRespostas: meta.analisaRespostas });
      } catch (err) {
        item.erro = err.message;
      }
      testes.push(item);
    }
    return { pasta: '.devbridge/tests', app: ready, testes, rodada: this.current ? this.summary(this.current) : null };
  }

  run({ test, cases } = {}) {
    if (this.busy()) {
      throw new Error(`Já existe uma rodada em andamento (${this.current.id}, ${this.current.teste}). Acompanhe com tests_status ou cancele com tests_cancel.`);
    }
    if (typeof test !== 'string' || !test) throw new Error('Informe o teste (nome do arquivo sem .test.js).');
    const source = readSource(this.config, test);
    const all = readCases(this.config, test).cases;
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
      id, teste: test, nome: test, descricao: '', situacao: 'preparando', inicio: now, fim: null, erro: null,
      cancelamento: false, casos: chosen.map((c) => blankCase(c.nome)), restauracao: null, relatorio: null,
    };
    this.current = run;
    this.frozen.clear();
    this.touch();
    this.history(run, 'inicio', `casos=${chosen.map((c) => c.nome).join(',')}`).catch(() => {});
    // Os casos (com credenciais) ficam só nesta closure e no app: nunca no estado da rodada.
    this.done = this.execute(run, source, chosen);
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

  async status({ id, caso, etapa, after, waitMs } = {}) {
    if (id && (!this.current || this.current.id !== id)) return this.readReport(id);
    if (!this.current) throw new Error('Nenhuma rodada nesta sessão do devbridge start. Inicie com tests_run.');
    if (caso !== undefined && caso !== null && caso !== '') return this.stepDetail(caso, etapa);
    const wait = Math.min(Math.max(Number(waitMs) || 0, 0), 120000);
    if (after !== undefined && after !== null && after !== '') {
      await this.waitChange(Number(after), Math.min(wait || 25000, 25000));
    } else if (wait) {
      const end = Date.now() + wait;
      while (this.busy() && Date.now() < end) await this.waitChange(this.rev, end - Date.now());
    }
    return this.summary(this.current);
  }

  summary(run) {
    const { cancelamento, meta, ...out } = run;
    return { ...out, cancelando: cancelamento && !run.fim, rev: this.rev };
  }

  readReport(id) {
    if (!SAFE.test(id)) throw new Error('Id de rodada inválido.');
    const dir = runsDir(this.config);
    const file = fs.existsSync(dir) && fs.readdirSync(dir).find((f) => f.startsWith(`${id}-`) && f.endsWith('.json') && !f.endsWith('.storage.json'));
    if (!file) throw new Error(`Rodada "${id}" não encontrada em .devbridge/test-runs/.`);
    return { ...JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')), doRelatorio: true };
  }

  // caso: índice (1, 2…) ou nome; etapa: índice (1, 2…), nome, "antes" ou "depois".
  stepDetail(caso, etapa) {
    const run = this.current;
    let ci = run.casos.findIndex((c) => c.nome === caso);
    if (ci < 0 && /^\d+$/.test(String(caso))) ci = Number(caso) - 1;
    const c = run.casos[ci];
    if (!c) throw new Error(`Caso "${caso}" não existe nesta rodada. Casos: ${run.casos.map((x, i) => `${i + 1}. ${x.nome}`).join(', ')}`);
    if (etapa === undefined || etapa === null || etapa === '') throw new Error('Informe a etapa (número, nome, "antes" ou "depois").');
    let step;
    if (etapa === 'antes' || etapa === 'depois') step = etapa;
    else {
      step = c.etapas.findIndex((e) => e.nome === etapa);
      if (step < 0 && /^\d+$/.test(String(etapa))) step = Number(etapa) - 1;
      if (!c.etapas[step]) throw new Error(`Etapa "${etapa}" não existe. Etapas: ${c.etapas.map((e, i) => `${i + 1}. ${e.nome}`).join(', ')}`);
    }
    const tag = `${run.id}/${ci}/${step}`;
    const data = this.frozen.get(tag) || this.collectStep(tag);
    const e = typeof step === 'number' ? c.etapas[step] : { nome: step, situacao: c.situacao, erro: null, detalhe: '', duracaoMs: null };
    return {
      rodada: run.id, caso: c.nome, casoIndice: ci + 1, etapa: e.nome, etapaIndice: typeof step === 'number' ? step + 1 : step,
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

  async execute(run, source, cases) {
    const s = this.server;
    let storage = null;
    let snapshot = null;
    try {
      const meta = await this.load(run.teste, source);
      run.nome = meta.nome;
      run.descricao = meta.descricao;
      run.meta = meta;
      for (const c of run.casos) {
        c.etapas = meta.etapas.map((e) => ({ nome: e.nome, situacao: 'aguardando', inicio: null, fim: null, duracaoMs: null, detalhe: '', erro: null }));
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
          run.casos[i].situacao = 'pulado';
          run.casos[i].etapas.forEach((e) => { e.situacao = 'pulada'; });
          continue;
        }
        await this.runCase(run, i, source, cases[i]);
      }
    } catch (err) {
      run.erro = err.message;
    } finally {
      await this.restore(run, storage, snapshot);
      delete run.meta;
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

  async runCase(run, i, source, data) {
    const s = this.server;
    const c = run.casos[i];
    this.set(c, { situacao: 'rodando', inicio: Date.now() });
    const limit = run.meta.etapas.reduce((t, e) => t + (e.tempoLimiteMs || STEP_LIMIT), 0) + this.caseMarginMs;
    let cancelSent = false;
    const sendCancel = async () => {
      if (cancelSent) return;
      cancelSent = true;
      await s.request('test', { action: 'cancel' }, 5000).catch(() => {});
    };
    try {
      await this.load(run.teste, source);
      let st = await s.request('test', { action: 'start', run: run.id, caso: i, file: run.teste, dados: data }, 10000);
      this.merge(c, st);
      const started = Date.now();
      let lostSince = null;
      while (!st || !st.fim) {
        await sleep(this.pollMs);
        if (run.cancelamento) await sendCancel();
        if (Date.now() - started > limit) {
          await sendCancel();
          throw new Error(`O caso passou de ${Math.round(limit / 1000)} s sem terminar (soma dos tempos limite das etapas e mais ${Math.round(this.caseMarginMs / 1000)} s).`);
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
        if (!next || next.run !== run.id || next.caso !== i) throw new Error('O app recarregou durante o caso e o estado do teste se perdeu.');
        st = next;
        this.merge(c, st);
      }
    } catch (err) {
      c.situacao = 'erro';
      c.erro = err.message;
      for (const e of c.etapas) {
        if (e.situacao === 'rodando') Object.assign(e, { situacao: 'falha', erro: e.erro || err.message });
        else if (e.situacao === 'aguardando') e.situacao = 'pulada';
      }
    }
    c.fim = Date.now();
    c.duracaoMs = c.fim - c.inicio;
    c.etapaAtual = null;
    await this.collectCase(run, i);
    this.touch();
  }

  merge(c, st) {
    if (!st) return;
    const before = JSON.stringify(c);
    c.situacao = st.fim ? st.situacao : 'rodando';
    c.erro = st.erro || null;
    c.etapaAtual = st.atual === null || st.atual === undefined ? null : st.atual + 1;
    c.telaAtual = st.telaAtual || '';
    c.dados = st.dados || {};
    if (Array.isArray(st.etapas)) c.etapas = st.etapas;
    if (JSON.stringify(c) !== before) this.touch();
  }

  // Fim do caso: copia logs e requisições de cada etapa (o buffer do servidor
  // descarta os antigos) e, se falhou, passa as respostas ao app para análise.
  async collectCase(run, i) {
    const s = this.server;
    const c = run.casos[i];
    const prefix = `${run.id}/${i}/`;
    for (const step of ['antes', ...c.etapas.map((e, k) => k), 'depois']) {
      this.frozen.set(prefix + step, this.collectStep(prefix + step));
    }
    const stepOf = (tag) => {
      const k = String(tag || '').slice(prefix.length);
      return /^\d+$/.test(k) ? Number(k) + 1 : k;
    };
    c.errosNoLog = s.getLogs({ test: prefix, level: 'error', limit: 50 }).entries.map((e) => ({ ...shortLog(e), etapa: stepOf(e.test) }));
    c.requisicoesComFalha = s.network.list({ test: prefix, failed: true, local: true, limit: 50 }).entries.map((e) => ({ ...shortRequest(e), etapa: stepOf(e.test) }));
    if (c.situacao === 'ok' || !run.meta.analisaRespostas) return;
    let bytes = 0;
    const respostas = [];
    for (const e of s.network.entriesFor(prefix).reverse()) {
      if (e.state !== 'done' || !e.response || !e.response.body) continue;
      const size = (e.response.body || '').length + ((e.request && e.request.body) || '').length;
      if (respostas.length >= ANALYZE_MAX || bytes + size > ANALYZE_BYTES) break;
      bytes += size;
      respostas.push({
        id: e.id, metodo: e.method, url: e.url, status: e.status, etapa: stepOf(e.test),
        requisicao: e.request ? e.request.body : null, resposta: e.response.body, cortada: !!e.response.truncated,
      });
    }
    if (!respostas.length) return;
    try {
      await this.load(run.teste);
      const found = await s.request('test', { action: 'analyze', file: run.teste, respostas }, 60000);
      const byId = new Map(respostas.map((r) => [r.id, r]));
      c.respostasComErro = (found || []).map((f) => {
        const r = byId.get(f.id) || {};
        return { id: f.id, metodo: r.metodo, url: r.url, status: r.status, etapa: r.etapa, achado: f.achado };
      });
    } catch (err) {
      c.respostasComErro = [{ erro: `Falha ao analisar as respostas no app: ${err.message}` }];
    }
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
    const t = (ms) => localIso(ms);
    const report = {
      id: run.id, teste: run.teste, nome: run.nome, descricao: run.descricao, situacao: run.situacao,
      inicio: t(run.inicio), fim: t(run.fim), duracaoMs: run.fim - run.inicio, erro: run.erro, restauracao: run.restauracao,
      casos: run.casos.map((c) => ({
        ...c,
        inicio: t(c.inicio),
        fim: t(c.fim),
        etapas: c.etapas.map((e) => ({ ...e, inicio: t(e.inicio), fim: t(e.fim) })),
        errosNoLog: c.errosNoLog.map((e) => ({ ...e, ts: t(e.ts) })),
      })),
    };
    await fsp.mkdir(runsDir(this.config), { recursive: true });
    const file = path.join(runsDir(this.config), `${run.id}-${run.teste}.json`);
    await fsp.writeFile(file, JSON.stringify(report, null, 2) + '\n');
    return path.relative(this.config.root, file);
  }
}

module.exports = { TestRunner, readCases, listTestIds, localIso };
