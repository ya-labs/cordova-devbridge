'use strict';

const { execFile, spawn } = require('node:child_process');

const ADB = process.env.ADB || 'adb';

function run(args, { encoding = 'utf8', timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(ADB, args, { encoding, timeout, maxBuffer: 512 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr && stderr.toString().trim()) || err.message;
        reject(new Error(`adb ${args.join(' ')}: ${msg}`));
      } else {
        resolve(stdout);
      }
    });
  });
}

async function devices() {
  const out = await run(['devices']);
  return out
    .split('\n')
    .slice(1)
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => p[0] && p[1] === 'device')
    .map((p) => p[0]);
}

async function reverse(port) {
  await run(['reverse', `tcp:${port}`, `tcp:${port}`]);
}

async function hasReverse(port) {
  try {
    const out = await run(['reverse', '--list']);
    return out.includes(`tcp:${port}`);
  } catch {
    return false;
  }
}

// run-as só funciona em build debuggable — exatamente o build dev.
async function listDatabases(pkg) {
  const out = await run(['shell', 'run-as', pkg, 'ls', 'databases']);
  if (/not debuggable|unknown package/i.test(out)) throw new Error(out.trim());
  return out.split(/\s+/).filter(Boolean);
}

function readAppFile(pkg, relPath) {
  return run(['exec-out', 'run-as', pkg, 'cat', relPath], { encoding: 'buffer', timeout: 120000 });
}

function screencap() {
  return run(['exec-out', 'screencap', '-p'], { encoding: 'buffer' });
}

function install(apk) {
  return new Promise((resolve, reject) => {
    const child = spawn(ADB, ['install', '-r', apk], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`adb install saiu com código ${code}`))));
  });
}

function launch(pkg) {
  return run(['shell', 'monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1']);
}

// Fecha e reabre: tira o app da página de erro de conexão do WebView.
async function restart(pkg) {
  await run(['shell', 'am', 'force-stop', pkg]);
  return launch(pkg);
}

module.exports = { run, devices, reverse, hasReverse, listDatabases, readAppFile, screencap, install, launch, restart };
