#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { loadConfig, resolveDatabase, CONFIG_NAME } = require('../src/config');
const { DevServer, globToRegExp } = require('../src/server');
const { devBuild, launchIfServerUp } = require('../src/devbuild');
const { Api } = require('../src/api');
const { sqlResult, logLine, table, networkLine, networkDetail, evalResult, navigateResult } = require('../src/format');
const { startMcp } = require('../src/mcp');
const adb = require('../src/adb');

const HELP = `cordova-devbridge — live reload e SQLite do app Cordova no celular (USB/adb)

Uso: devbridge <comando> [opções]   (rodar na raiz do app, onde está ${CONFIG_NAME})

  init                       cria ${CONFIG_NAME} detectando o id do app
  start [--no-adb]           servidor de live reload + API + console web (rode antes do build)
  build [--no-install] [--skip-prepare]
                             gera e instala o APK dev (content src → servidor do PC);
                             só abre o app se o start estiver no ar
  launch                     fecha e reabre o app no celular (sai da tela de erro de conexão)
  status                     app conectado, tela atual, conexões abertas
  reload                     recarrega o app
  logs [-f] [--level error,warn] [--since N]
                             console do app
  network [-f] [--failed] [--local] [--url trecho] [--since N]
                             requisições HTTP do app (XHR, fetch, advanced-http)
  network <ID> [--json]      cabeçalhos e corpos de uma requisição
  sql "<SQL>" [--db X] [--params '[..]'] [--write] [--json] [--max N]
                             executa SQL no app rodando (leitura por padrão)
  go <ROTA>                  leva o app à rota (ex.: /pedidos/12) e mostra onde ele parou
  eval "<JS>" [--timeout ms] [--json]
                             avalia JavaScript no app
  tables [--db X]            lista tabelas
  schema <TABELA> [--db X]   colunas e índices
  pull-db [--db X] [--out DIR]
                             copia o .db do aparelho (adb run-as) para abrir no PC
  screenshot [--out arq.png] captura a tela do celular
  mcp                        servidor MCP (stdio) para agentes de IA

Opções globais: --config <arquivo>`;

const VALUE_FLAGS = new Set(['--db', '--level', '--since', '--params', '--max', '--out', '--config', '--url', '--timeout']);

function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (VALUE_FLAGS.has(a)) args.flags[a.slice(2)] = argv[++i];
    else if (a === '-f') args.flags.follow = true;
    else if (a.startsWith('--')) args.flags[a.slice(2)] = true;
    else args._.push(a);
  }
  return args;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cmdInit() {
  const target = path.resolve(CONFIG_NAME);
  if (fs.existsSync(target)) throw new Error(`${CONFIG_NAME} já existe.`);
  const xml = fs.existsSync('config.xml') ? fs.readFileSync('config.xml', 'utf8') : '';
  const id = (xml.match(/<widget[^>]*\sid="([^"]+)"/) || [])[1];
  if (!id) throw new Error('config.xml com <widget id> não encontrado. Rode na raiz do app Cordova.');
  const config = { package: id, port: 8100, databases: { main: { global: 'db', name: 'App.db' } } };
  fs.writeFileSync(target, JSON.stringify(config, null, 2) + '\n');
  console.log(`Criado ${CONFIG_NAME} para ${id}. Ajuste "databases" (name = arquivo do sqlitePlugin.openDatabase, global = variável que guarda a conexão).`);
  console.log('Adicione ".devbridge/" ao .gitignore (histórico de SQL e cópias de banco).');
}

async function keepReverse(port) {
  let warned = false;
  for (;;) {
    try {
      const devs = await adb.devices();
      if (!devs.length) {
        if (!warned) console.log('[devbridge] nenhum aparelho no adb; aguardando cabo…');
        warned = true;
      } else if (!(await adb.hasReverse(port))) {
        await adb.reverse(port);
        console.log(`[devbridge] adb reverse tcp:${port} ativo (${devs.join(', ')})`);
        warned = false;
      }
    } catch (err) {
      if (!warned) console.log(`[devbridge] adb: ${err.message}`);
      warned = true;
    }
    await sleep(3000);
  }
}

async function cmdStart(config, flags) {
  if (!fs.existsSync(path.join(config.platformWwwDir, 'cordova.js'))) {
    console.log(`[devbridge] AVISO: ${path.relative(config.root, config.platformWwwDir)}/cordova.js não existe. Rode "devbridge build" (ou cordova prepare android).`);
  }
  const server = new DevServer(config);
  try {
    await server.listen();
  } catch (err) {
    if (err.code === 'EADDRINUSE') throw new Error(`Porta ${config.port} já está em uso (outro "devbridge start" rodando?).`);
    throw err;
  }
  console.log(`[devbridge] servindo ${path.relative(process.cwd(), config.wwwDir) || '.'} em ${config.url}`);
  console.log(`[devbridge] console SQL/logs: ${config.url}/__devbridge/`);
  const stop = () => server.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  if (!flags['no-adb']) keepReverse(config.port);
}

async function cmdLogs(api, flags) {
  let since = Number(flags.since || 0);
  const first = await api.logs({ since, level: flags.level, limit: flags.follow ? 50 : 500 });
  first.entries.forEach((e) => console.log(logLine(e)));
  since = first.last;
  while (flags.follow) {
    await sleep(500);
    const r = await api.logs({ since, level: flags.level });
    r.entries.forEach((e) => console.log(logLine(e)));
    since = r.last;
  }
}

async function cmdNetwork(api, args) {
  const { flags } = args;
  if (args._[1]) {
    const e = await api.networkEntry(args._[1]);
    return console.log(flags.json ? JSON.stringify(e, null, 2) : networkDetail(e, { maxBody: Infinity }));
  }
  const query = { url: flags.url, failed: flags.failed, local: flags.local };
  let since = Number(flags.since || 0);
  const first = await api.network({ ...query, since, limit: flags.follow ? 50 : 500 });
  first.entries.forEach((e) => console.log(networkLine(e)));
  since = first.last;
  while (flags.follow) {
    await sleep(500);
    const r = await api.network({ ...query, since });
    r.entries.forEach((e) => console.log(networkLine(e)));
    since = r.last;
  }
}

async function cmdSql(api, args) {
  const sql = args._.slice(1).join(' ');
  if (!sql) throw new Error('Informe o SQL: devbridge sql "select ..."');
  let params = [];
  if (args.flags.params) {
    try {
      params = JSON.parse(args.flags.params);
    } catch {
      throw new Error('--params precisa ser um array JSON, ex.: --params \'[1,"abc"]\'');
    }
  }
  const r = await api.sql({ sql, params, db: args.flags.db, write: !!args.flags.write, maxRows: Number(args.flags.max || 1000) });
  console.log(args.flags.json ? JSON.stringify(r, null, 2) : sqlResult(r));
}

async function cmdPullDb(config, flags) {
  const spec = resolveDatabase(config, flags.db);
  if (!spec.name) throw new Error(`Banco "${spec.alias}" não tem "name" na config; informe --db <arquivo.db>.`);
  const all = await adb.listDatabases(config.package);
  const re = globToRegExp(spec.name);
  const mains = all.filter((f) => re.test(f) && !/-(journal|wal|shm)$/.test(f));
  if (!mains.length) throw new Error(`Nenhum banco casa com ${spec.name}. No aparelho: ${all.join(', ') || '(vazio)'}`);
  const outDir = path.resolve(flags.out || path.join(config.stateDir, 'db'));
  fs.mkdirSync(outDir, { recursive: true });
  for (const name of mains) {
    for (const f of all.filter((x) => x === name || x.startsWith(name + '-'))) {
      const buf = await adb.readAppFile(config.package, `databases/${f}`);
      fs.writeFileSync(path.join(outDir, f), buf);
      console.log(`${path.join(outDir, f)} (${(buf.length / 1024).toFixed(0)} KB)`);
    }
  }
  console.log('Cópia com o app aberto pode não ter as últimas escritas em andamento; para um retrato fiel, feche o app antes.');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (!cmd || cmd === 'help' || args.flags.help) return console.log(HELP);
  if (cmd === 'init') return cmdInit();

  const config = loadConfig({ configPath: args.flags.config });
  const api = new Api(config.port);
  switch (cmd) {
    case 'build': {
      const r = await devBuild(config, { install: !args.flags['no-install'], prepare: !args.flags['skip-prepare'] });
      if (r.launched) console.log('[devbridge] pronto: app aberto no celular carregando do servidor.');
      else if (!r.installed) console.log(`[devbridge] APK dev gerado em ${path.relative(process.cwd(), r.apk)} (não instalado).`);
      return;
    }
    case 'launch': {
      const launched = await launchIfServerUp(config);
      if (launched) console.log('[devbridge] app reaberto.');
      return;
    }
    case 'start':
      return cmdStart(config, args.flags);
    case 'status':
      return console.log(JSON.stringify(await api.status(), null, 2));
    case 'reload': {
      const r = await api.reload();
      return console.log(r.apps ? `reload enviado para ${r.apps} app(s)` : 'nenhum app conectado');
    }
    case 'logs':
      return cmdLogs(api, args.flags);
    case 'network':
      return cmdNetwork(api, args);
    case 'sql':
      return cmdSql(api, args);
    case 'go': {
      if (!args._[1]) throw new Error('Informe a rota: devbridge go /pedidos');
      return console.log(navigateResult(await api.navigate(args._[1])));
    }
    case 'eval': {
      const expression = args._.slice(1).join(' ');
      if (!expression) throw new Error('Informe a expressão: devbridge eval "location.hash"');
      const r = await api.evaluate({ expression, timeoutMs: args.flags.timeout ? Number(args.flags.timeout) : undefined });
      return console.log(args.flags.json ? JSON.stringify(r, null, 2) : evalResult(r));
    }
    case 'tables': {
      const r = await api.tables(args.flags.db);
      return console.log(table(['name', 'type'], r.rows) + `\n(banco: ${r.database})`);
    }
    case 'schema': {
      const r = await api.schema(args.flags.db, args._[1]);
      console.log(table(['cid', 'name', 'type', 'notnull', 'dflt_value', 'pk'], r.columns));
      if (r.indexes.length) console.log('\nÍndices:\n' + table(Object.keys(r.indexes[0]), r.indexes));
      return;
    }
    case 'pull-db':
      return cmdPullDb(config, args.flags);
    case 'screenshot': {
      const png = await adb.screencap();
      const out = path.resolve(args.flags.out || path.join(config.stateDir, `screenshot-${Date.now()}.png`));
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, png);
      return console.log(out);
    }
    case 'mcp':
      startMcp(config);
      return;
    default:
      throw new Error(`Comando desconhecido: ${cmd}\n\n${HELP}`);
  }
}

main().catch((err) => {
  console.error(`devbridge: ${err.message}`);
  process.exit(1);
});
