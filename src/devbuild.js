'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const adb = require('./adb');

const GENERATED_CONFIG = 'platforms/android/app/src/main/res/xml/config.xml';
const MANIFEST = 'platforms/android/app/src/main/AndroidManifest.xml';
const DEBUG_APK = 'platforms/android/app/build/outputs/apk/debug/app-debug.apk';

const CONTENT_RE = /<content\s+src="([^"]*)"\s*\/>/;

function preferences(xml) {
  const prefs = {};
  for (const [tag] of xml.matchAll(/<preference\b[^>]*>/g)) {
    const name = /\bname="([^"]*)"/.exec(tag);
    const value = /\bvalue="([^"]*)"/.exec(tag);
    if (name && value) prefs[name[1].toLowerCase()] = value[1];
  }
  return prefs;
}

// A URL inicial que o cordova-android usaria sem o patch
// (ConfigXmlParser.setStartUrl/getLaunchUrlPrefix): o www empacotado no APK.
function bundledStartUrl(xml, src) {
  if (/^[a-z-]+:\/\//.test(src)) return src;
  const prefs = preferences(xml);
  const file = src.replace(/^\//, '');
  if (String(prefs.androidinsecurefilemodeenabled).toLowerCase() === 'true') return `file:///android_asset/www/${file}`;
  let scheme = (prefs.scheme || 'https').toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') scheme = 'https';
  return `${scheme}://${(prefs.hostname || 'localhost').toLowerCase()}/${file}`;
}

function appendToWidget(xml, tag) {
  return xml.replace(/<\/widget>\s*$/, `    ${tag}\n</widget>\n`);
}

// Mexe só no config.xml GERADO: o próximo `cordova prepare` o regenera a
// partir do config.xml versionado, então nada vaza para release.
// Sem servidor (cabo solto, `start` parado), o load de localhost falha e o
// CordovaActivity abre o ErrorUrl: o www empacotado no último build.
function patchConfigXml(xml, devUrl) {
  const m = CONTENT_RE.exec(xml);
  if (!m) throw new Error('config.xml gerado não tem <content src>.');
  const devStart = `${devUrl}/index.html`;
  let out = xml.replace(CONTENT_RE, `<content src="${devStart}" />`);
  if (m[1] !== devStart) {
    out = out.replace(/\s*<preference\b[^>]*\bname="errorurl"[^>]*>/gi, '');
    out = appendToWidget(out, `<preference name="ErrorUrl" value="${bundledStartUrl(xml, m[1])}" />`);
  }
  const nav = `<allow-navigation href="${devUrl}/*" />`;
  if (!out.includes(nav)) out = appendToWidget(out, nav);
  return out;
}

function errorUrl(xml) {
  return preferences(xml).errorurl || null;
}

function exec(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: 'inherit' });
    child.on('error', (err) => reject(new Error(`${cmd}: ${err.message}`)));
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} saiu com código ${code}`))));
  });
}

async function devBuild(config, { install = true, prepare = true, log = console.log } = {}) {
  const root = config.root;
  if (prepare) {
    log('[devbridge] cordova prepare android');
    await exec(config.cordova, ['prepare', 'android'], root);
  }

  const cfgFile = path.join(root, GENERATED_CONFIG);
  if (!fs.existsSync(cfgFile)) throw new Error(`${GENERATED_CONFIG} não existe. A plataforma android foi adicionada?`);
  const patched = patchConfigXml(fs.readFileSync(cfgFile, 'utf8'), config.url);
  fs.writeFileSync(cfgFile, patched);
  log(`[devbridge] content src → ${config.url}/index.html`);
  if (errorUrl(patched)) log(`[devbridge] sem servidor → ${errorUrl(patched)} (www empacotado neste build)`);

  const manifest = path.join(root, MANIFEST);
  if (fs.existsSync(manifest) && !/usesCleartextTraffic="true"/.test(fs.readFileSync(manifest, 'utf8'))) {
    log('[devbridge] AVISO: AndroidManifest sem usesCleartextTraffic="true". O app pode não conseguir abrir http://localhost.');
    log('           Instale cordova-plugin-enable-cleartext-traffic no app.');
  }

  log('[devbridge] cordova compile android --debug');
  await exec(config.cordova, ['compile', 'android', '--debug'], root);

  const apk = path.join(root, DEBUG_APK);
  if (!install) return { apk };
  log(`[devbridge] adb install -r ${DEBUG_APK}`);
  await adb.install(apk);
  await adb.reverse(config.port).catch((err) => log(`[devbridge] adb reverse falhou: ${err.message}`));
  const launched = await launchIfServerUp(config, { log });
  return { apk, installed: true, launched };
}

async function serverUp(port, timeoutMs = 1500) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/__devbridge/client.js`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

// O APK dev sem servidor abre o www empacotado, sem live reload: só abre o
// app se o `devbridge start` já estiver no ar.
async function launchIfServerUp(config, { log = console.log, isUp = serverUp, restart = adb.restart } = {}) {
  if (!(await isUp(config.port))) {
    log(`[devbridge] servidor não está rodando em ${config.url}; o app não foi aberto.`);
    log('           Sem servidor, ele abre o www empacotado no APK, sem live reload.');
    log('           Rode "devbridge start" e depois "devbridge launch" (ou abra o app no celular).');
    return false;
  }
  await restart(config.package).catch((err) => log(`[devbridge] não consegui abrir o app: ${err.message}`));
  return true;
}

module.exports = { devBuild, patchConfigXml, launchIfServerUp, serverUp, GENERATED_CONFIG, DEBUG_APK };
