'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const adb = require('./adb');

const GENERATED_CONFIG = 'platforms/android/app/src/main/res/xml/config.xml';
const MANIFEST = 'platforms/android/app/src/main/AndroidManifest.xml';
const DEBUG_APK = 'platforms/android/app/build/outputs/apk/debug/app-debug.apk';

// Mexe só no config.xml GERADO: o próximo `cordova prepare` o regenera a
// partir do config.xml versionado, então nada vaza para release.
function patchConfigXml(xml, devUrl) {
  const content = `<content src="${devUrl}/index.html" />`;
  if (!/<content\s+src="[^"]*"\s*\/>/.test(xml)) throw new Error('config.xml gerado não tem <content src>.');
  let out = xml.replace(/<content\s+src="[^"]*"\s*\/>/, content);
  const nav = `<allow-navigation href="${devUrl}/*" />`;
  if (!out.includes(nav)) out = out.replace(/<\/widget>\s*$/, `    ${nav}\n</widget>\n`);
  return out;
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
  fs.writeFileSync(cfgFile, patchConfigXml(fs.readFileSync(cfgFile, 'utf8'), config.url));
  log(`[devbridge] content src → ${config.url}/index.html`);

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

// O APK dev sem servidor abre numa página de erro que não tenta de novo:
// só abre o app se o `devbridge start` já estiver no ar.
async function launchIfServerUp(config, { log = console.log, isUp = serverUp, restart = adb.restart } = {}) {
  if (!(await isUp(config.port))) {
    log(`[devbridge] servidor não está rodando em ${config.url}; o app não foi aberto.`);
    log('           Rode "devbridge start" e depois "devbridge launch" (ou abra o app no celular).');
    return false;
  }
  await restart(config.package).catch((err) => log(`[devbridge] não consegui abrir o app: ${err.message}`));
  return true;
}

module.exports = { devBuild, patchConfigXml, launchIfServerUp, serverUp, GENERATED_CONFIG, DEBUG_APK };
