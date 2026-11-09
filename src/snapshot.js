'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { globToRegExp } = require('./config');

const COMPANION = /-(journal|wal|shm)$/;
const SAFE_NAME = /^[\w.-]+$/;

function history(config, action, name, outcome) {
  fs.mkdirSync(config.stateDir, { recursive: true });
  fs.appendFileSync(path.join(config.stateDir, 'snapshot-history.log'), [new Date().toISOString(), action, name, outcome].join('\t') + '\n');
}

function snapshotsDir(config) {
  return path.join(config.stateDir, 'snapshots');
}

function snapshotDir(config, name) {
  if (!SAFE_NAME.test(name || '')) throw new Error('Nome de snapshot inválido: use letras, números, ponto, hífen ou sublinhado.');
  return path.join(snapshotsDir(config), name);
}

// Arquivos de banco do snapshot: todos de databases/, ou só os do alias pedido
// (com * resolvido no aparelho), sempre com journal/wal/shm junto.
function aliasRegExp(config, db) {
  const spec = config.databases[db] || (/\.db$/i.test(db) || db.includes('*') ? { name: db } : null);
  if (!spec) throw new Error(`Banco "${db}" não existe na config. Disponíveis: ${Object.keys(config.databases).join(', ') || '(nenhum)'}`);
  if (!spec.name) throw new Error(`Banco "${db}" não tem "name" na config; o snapshot precisa do nome do arquivo.`);
  return globToRegExp(spec.name);
}

function pickFiles(config, all, db) {
  const safe = all.filter((f) => SAFE_NAME.test(f));
  if (!db) return safe;
  const re = aliasRegExp(config, db);
  const mains = safe.filter((f) => re.test(f) && !COMPANION.test(f));
  return safe.filter((f) => mains.some((m) => f === m || f.startsWith(m + '-')));
}

// O app fica parado durante a cópia: nada de transação no meio nem conexão aberta.
async function createSnapshot(config, { name, db } = {}, deps) {
  const dir = snapshotDir(config, name);
  const files = pickFiles(config, await deps.listDatabases(config.package), db);
  if (!files.length) throw new Error(`Nenhum arquivo de banco${db ? ` de "${db}"` : ''} no aparelho.`);
  const replaced = fs.existsSync(dir);
  await deps.forceStop(config.package);
  const tmp = `${dir}.tmp`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  try {
    const list = [];
    for (const f of files) {
      const buf = await deps.readAppFile(config.package, `databases/${f}`);
      fs.writeFileSync(path.join(tmp, f), buf);
      list.push({ name: f, size: buf.length });
    }
    const manifest = { name, package: config.package, db: db || null, createdAt: new Date().toISOString(), files: list };
    fs.writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(tmp, dir);
    history(config, 'snapshot', name, `ok ${list.map((f) => f.name).join(',')}`);
    return { ...manifest, replaced, reopened: await deps.reopen() };
  } catch (err) {
    fs.rmSync(tmp, { recursive: true, force: true });
    history(config, 'snapshot', name, `ERRO ${err.message}`);
    await deps.reopen();
    throw err;
  }
}

function readManifest(config, name) {
  const file = path.join(snapshotDir(config, name), 'manifest.json');
  if (!fs.existsSync(file)) throw new Error(`Snapshot "${name}" não existe. Veja os disponíveis com db-snapshots.`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Arquivos do aparelho que o restore controla: toda a pasta no snapshot completo
// (manifest sem "db", inclusive os antigos); no snapshot de um alias, os que casam
// com o nome dele e os companheiros dos bancos do manifest. Um alias que saiu da
// config fica só com os bancos do manifest.
function restoreScope(config, manifest, current) {
  const safe = current.filter((f) => SAFE_NAME.test(f));
  if (!manifest.db) return safe;
  const mains = manifest.files.map((f) => f.name).filter((f) => !COMPANION.test(f));
  let re = null;
  try { re = aliasRegExp(config, manifest.db); } catch { re = null; }
  return safe.filter((f) => {
    const base = f.replace(COMPANION, '');
    return mains.includes(base) || (re && re.test(base));
  });
}

// Deixa a pasta igual ao snapshot: apaga o que ele não tem (banco criado depois,
// como o de um usuário que logou, e journal/wal/shm de outro estado, que o SQLite
// aplicaria sobre o banco restaurado) e só então grava os arquivos dele.
async function restoreSnapshot(config, { name } = {}, deps) {
  const manifest = readManifest(config, name);
  if (manifest.package !== config.package) {
    throw new Error(`Snapshot "${name}" é do pacote ${manifest.package}, não de ${config.package}.`);
  }
  const dir = snapshotDir(config, name);
  const keep = new Set(manifest.files.map((f) => f.name));
  await deps.forceStop(config.package);
  try {
    const current = await deps.listDatabases(config.package);
    const removed = restoreScope(config, manifest, current).filter((f) => !keep.has(f));
    for (const f of removed) await deps.removeAppFile(config.package, `databases/${f}`);
    for (const f of manifest.files) await deps.writeAppFile(config.package, `databases/${f.name}`, fs.readFileSync(path.join(dir, f.name)));
    history(config, 'restore', name, `ok ${manifest.files.map((f) => f.name).join(',')}${removed.length ? ` removidos=${removed.join(',')}` : ''}`);
    return { name, files: manifest.files, removed, createdAt: manifest.createdAt, reopened: await deps.reopen() };
  } catch (err) {
    history(config, 'restore', name, `ERRO ${err.message}`);
    await deps.reopen();
    throw err;
  }
}

function listSnapshots(config) {
  const base = snapshotsDir(config);
  if (!fs.existsSync(base)) return [];
  return fs.readdirSync(base)
    .filter((n) => SAFE_NAME.test(n) && fs.existsSync(path.join(base, n, 'manifest.json')))
    .map((n) => {
      const m = JSON.parse(fs.readFileSync(path.join(base, n, 'manifest.json'), 'utf8'));
      return { name: n, createdAt: m.createdAt, db: m.db, package: m.package, files: m.files.length, size: m.files.reduce((t, f) => t + f.size, 0) };
    })
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

module.exports = { createSnapshot, restoreSnapshot, listSnapshots, pickFiles };
