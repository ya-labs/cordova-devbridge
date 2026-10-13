'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CONFIG_NAME = 'devbridge.config.json';

const DEFAULTS = {
  port: 8100,
  www: 'www',
  platformWww: 'platforms/android/platform_www',
  cordova: 'cordova',
  allowWrites: false,
  databases: {},
  defaultDb: null,
};

// Sobe a partir de `start` até achar devbridge.config.json (raiz do app Cordova).
function findConfig(start) {
  let dir = path.resolve(start);
  for (;;) {
    const candidate = path.join(dir, CONFIG_NAME);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Cada banco aceita a forma curta "Nome.db" ou { name, global }.
// `global` é a variável do app que guarda a conexão já aberta (ex.: "db").
function normalizeDatabases(databases) {
  const out = {};
  for (const [alias, value] of Object.entries(databases || {})) {
    const spec = typeof value === 'string' ? { name: value } : { ...value };
    if (!spec.name && !spec.global) {
      throw new Error(`Banco "${alias}" precisa de "name" ou "global".`);
    }
    out[alias] = { name: spec.name || null, global: spec.global || null };
  }
  return out;
}

function loadConfig(options = {}) {
  const file = options.configPath
    ? path.resolve(options.configPath)
    : findConfig(options.cwd || process.cwd());
  if (!file) {
    throw new Error(`${CONFIG_NAME} não encontrado a partir de ${options.cwd || process.cwd()}. Rode "devbridge init" na raiz do app.`);
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`Falha ao ler ${file}: ${err.message}`);
  }
  if (!raw.package) throw new Error(`${file}: campo "package" (id do app Android) é obrigatório.`);

  const root = path.dirname(file);
  const config = { ...DEFAULTS, ...raw, root, file };
  config.port = Number(config.port);
  config.databases = normalizeDatabases(raw.databases);
  config.defaultDb = raw.defaultDb || Object.keys(config.databases)[0] || null;
  config.wwwDir = path.resolve(root, config.www);
  config.platformWwwDir = path.resolve(root, config.platformWww);
  config.stateDir = path.join(root, '.devbridge');
  config.url = `http://localhost:${config.port}`;
  return config;
}

// --db aceita um alias da config ou um nome de arquivo literal (*.db).
function resolveDatabase(config, requested) {
  const key = requested || config.defaultDb;
  if (!key) throw new Error('Nenhum banco configurado em "databases" e nenhum --db informado.');
  if (config.databases[key]) return { alias: key, ...config.databases[key] };
  if (/\.db$/i.test(key) || key.includes('*')) return { alias: key, name: key, global: null };
  throw new Error(`Banco "${key}" não existe na config. Disponíveis: ${Object.keys(config.databases).join(', ') || '(nenhum)'}`);
}

module.exports = { CONFIG_NAME, findConfig, loadConfig, resolveDatabase, normalizeDatabases };
