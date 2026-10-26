'use strict';

const readline = require('node:readline');
const { Api } = require('./api');
const { sqlResult, logLine, networkLine, networkDetail, evalResult, navigateResult } = require('./format');

const PROTOCOL_VERSION = '2025-06-18';

// Servidor MCP mínimo (JSON-RPC 2.0 por stdio, uma mensagem por linha).
// Só repassa para a API local do `devbridge start`.
function buildTools(config) {
  const dbs = Object.keys(config.databases);
  const dbProp = {
    type: 'string',
    description: `Banco: ${dbs.length ? dbs.join(', ') : 'nome do arquivo .db'} (padrão: ${config.defaultDb || 'nenhum'}). Também aceita nome de arquivo .db.`,
  };
  const tools = [
    {
      name: 'app_status',
      description: 'Mostra se o app dev está conectado, a tela atual (href) e quais conexões SQLite estão abertas.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'app_reload',
      description: 'Recarrega o app no celular (equivale a salvar um arquivo em www/). Use após editar o código.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'app_logs',
      description: 'Lê console.log/warn/error e erros não tratados do app. Use `since` com o `last` da chamada anterior para pegar só os novos.',
      inputSchema: {
        type: 'object',
        properties: {
          since: { type: 'number', description: 'Retorna logs com seq maior que este.' },
          level: { type: 'string', description: 'Filtro, ex.: "error" ou "warn,error".' },
          limit: { type: 'number', description: 'Máximo de linhas (padrão 200).' },
        },
      },
    },
    {
      name: 'app_network',
      description: 'Lista as requisições HTTP do app ao backend (XHR, fetch e cordova-plugin-advanced-http): id, método, status, duração e URL. Use `since` com o `last` da chamada anterior para ver só o que mudou (inclui chamadas que terminaram depois). Detalhe com app_network_entry.',
      inputSchema: {
        type: 'object',
        properties: {
          since: { type: 'number', description: 'Retorna chamadas com seq maior que este.' },
          url: { type: 'string', description: 'Filtra por trecho da URL.' },
          failed: { type: 'boolean', description: 'Só falhas: status >= 400, sem resposta ou erro de rede.' },
          local: { type: 'boolean', description: 'Inclui requisições ao próprio servidor de desenvolvimento (templates, js). Por padrão só aparecem se falharem.' },
          limit: { type: 'number', description: 'Máximo de linhas (padrão 50).' },
        },
      },
    },
    {
      name: 'app_network_entry',
      description: 'Detalhe de uma requisição do app_network: cabeçalhos e corpos do pedido e da resposta (JSON formatado). Credenciais aparecem como *** quando networkMask está ligado.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'number', description: 'O #id mostrado pelo app_network.' },
          maxBody: { type: 'number', description: 'Máximo de caracteres por corpo (padrão 8000).' },
        },
        required: ['id'],
      },
    },
    {
      name: 'db_query',
      description: 'Executa UMA instrução SQL de leitura (SELECT, WITH, PRAGMA de introspecção) no SQLite do app rodando no celular.',
      inputSchema: {
        type: 'object',
        properties: {
          sql: { type: 'string' },
          params: { type: 'array', description: 'Valores para os "?" do SQL.' },
          db: dbProp,
          maxRows: { type: 'number', description: 'Padrão 200.' },
        },
        required: ['sql'],
      },
    },
    {
      name: 'db_tables',
      description: 'Lista tabelas e views do banco.',
      inputSchema: { type: 'object', properties: { db: dbProp } },
    },
    {
      name: 'db_schema',
      description: 'Colunas (PRAGMA table_info) e índices de uma tabela.',
      inputSchema: { type: 'object', properties: { table: { type: 'string' }, db: dbProp }, required: ['table'] },
    },
    {
      name: 'app_screenshot',
      description: 'Captura a tela do celular (adb screencap).',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'app_navigate',
      description: 'Leva o app a uma rota (hash do AngularJS) e devolve a rota final, avisando se o app redirecionou (guarda de login, otherwise). Use antes de app_screenshot/app_logs para validar uma tela específica. Só depois do deviceready.',
      inputSchema: {
        type: 'object',
        properties: { route: { type: 'string', description: 'Ex.: "/pedidos/12", "#/pedidos/12" ou "#!/pedidos". Sem "#", usa o prefixo que o app já usa.' } },
        required: ['route'],
      },
    },
    {
      name: 'app_eval',
      description: 'Avalia JavaScript no app rodando (escopo global do WebView) e devolve o valor; promessas são esperadas. Útil para ler estado do AngularJS, ex.: angular.element(document.body).injector().get("MeuServico") ou angular.element(document.querySelector("[ng-controller]")).scope(). Pode alterar o estado do app; fica registrado em .devbridge/eval-history.log.',
      inputSchema: {
        type: 'object',
        properties: {
          expression: { type: 'string', description: 'Expressão ou bloco; volta o valor da última instrução.' },
          timeoutMs: { type: 'number', description: 'Espera máxima por uma promessa (padrão 10000, máximo 120000).' },
        },
        required: ['expression'],
      },
    },
    {
      name: 'db_exec',
      description: 'Executa UMA instrução SQL de ESCRITA (INSERT/UPDATE/DELETE/DDL) em transação no SQLite do app. Altera dados reais do aparelho de teste; fica registrada em .devbridge/sql-history.log.',
      inputSchema: {
        type: 'object',
        properties: { sql: { type: 'string' }, params: { type: 'array' }, db: dbProp },
        required: ['sql'],
      },
    },
  ];
  return tools;
}

const text = (t) => ({ content: [{ type: 'text', text: t }] });

async function callTool(api, name, args) {
  switch (name) {
    case 'app_status':
      return text(JSON.stringify(await api.status(), null, 2));
    case 'app_reload': {
      const r = await api.reload();
      return text(r.apps ? `Reload enviado para ${r.apps} app(s).` : 'Nenhum app conectado.');
    }
    case 'app_logs': {
      const r = await api.logs({ since: args.since, level: args.level, limit: args.limit || 200 });
      const lines = r.entries.map(logLine).join('\n') || '(sem logs novos)';
      return text(`${lines}\n\n[last=${r.last}]`);
    }
    case 'app_network': {
      const r = await api.network({ since: args.since, url: args.url, failed: args.failed, local: args.local, limit: args.limit || 50 });
      const lines = r.entries.map(networkLine).join('\n') || '(sem requisições novas)';
      return text(`${lines}\n\n[last=${r.last}]`);
    }
    case 'app_network_entry':
      return text(networkDetail(await api.networkEntry(args.id), { maxBody: args.maxBody || 8000 }));
    case 'db_query': {
      const r = await api.sql({ sql: args.sql, params: args.params, db: args.db, maxRows: args.maxRows || 200 });
      return text(sqlResult(r));
    }
    case 'app_navigate':
      return text(navigateResult(await api.navigate(args.route)));
    case 'app_eval':
      return text(evalResult(await api.evaluate({ expression: args.expression, timeoutMs: args.timeoutMs })));
    case 'db_exec': {
      const r = await api.sql({ sql: args.sql, params: args.params, db: args.db, write: true });
      return text(sqlResult(r));
    }
    case 'db_tables': {
      const r = await api.tables(args.db);
      return text(r.rows.map((t) => `${t.name}${t.type === 'view' ? ' (view)' : ''}`).join('\n') + `\n\n(banco: ${r.database})`);
    }
    case 'db_schema':
      return text(JSON.stringify(await api.schema(args.db, args.table), null, 2));
    case 'app_screenshot': {
      const png = await api.screenshot();
      return { content: [{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }] };
    }
    default:
      throw Object.assign(new Error(`Ferramenta desconhecida: ${name}`), { rpcCode: -32602 });
  }
}

function startMcp(config, { input = process.stdin, output = process.stdout } = {}) {
  const api = new Api(config.port);
  const tools = buildTools(config);
  const send = (msg) => output.write(JSON.stringify(msg) + '\n');

  async function handle(msg) {
    const { id, method, params = {} } = msg;
    if (id === undefined || id === null) return; // notificação
    try {
      let result;
      switch (method) {
        case 'initialize':
          result = {
            protocolVersion: params.protocolVersion || PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: 'cordova-devbridge', version: require('../package.json').version },
            instructions: `App Cordova em ${config.root}. Fluxo: editar www/ → app_reload → app_logs/app_network/db_query/app_screenshot para validar. Requer "devbridge start" rodando.`,
          };
          break;
        case 'ping':
          result = {};
          break;
        case 'tools/list':
          result = { tools };
          break;
        case 'tools/call':
          if (!tools.some((t) => t.name === params.name)) {
            throw Object.assign(new Error(`Ferramenta indisponível: ${params.name}`), { rpcCode: -32602 });
          }
          try {
            result = await callTool(api, params.name, params.arguments || {});
          } catch (err) {
            if (err.rpcCode) throw err;
            result = { ...text(err.message), isError: true };
          }
          break;
        default:
          throw Object.assign(new Error(`Método não suportado: ${method}`), { rpcCode: -32601 });
      }
      send({ jsonrpc: '2.0', id, result });
    } catch (err) {
      send({ jsonrpc: '2.0', id, error: { code: err.rpcCode || -32603, message: err.message } });
    }
  }

  const rl = readline.createInterface({ input });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON inválido.' } });
    }
    handle(msg);
  });
  return rl;
}

module.exports = { startMcp, buildTools };
