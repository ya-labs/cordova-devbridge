'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.tpl': 'text/html; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};

function mimeOf(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

function isInside(root, file) {
  const rel = path.relative(root, file);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// Resolve por ARQUIVO: platform_www (cordova.js, plugins Cordova) primeiro,
// depois www. Pastas de mesmo nome nas duas árvores convivem.
function resolveFile(roots, urlPath) {
  let rel;
  try {
    rel = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  } catch {
    return null;
  }
  if (rel.includes('\0')) return null;
  if (rel.endsWith('/')) rel += 'index.html';
  rel = rel.replace(/^\/+/, '');
  for (const root of roots) {
    const file = path.resolve(root, rel);
    if (!isInside(root, file)) continue;
    try {
      if (fs.statSync(file).isFile()) return file;
    } catch {
      // segue para a próxima raiz
    }
  }
  return null;
}

const CLIENT_TAG = '<script src="/__devbridge/client.js"></script>';
const RESTORE_TAG = '<script src="/__devbridge/restore.js"></script>';

// O client entra como primeiro script do <head> para capturar logs do boot
// e continuar recebendo "reload" mesmo se algum script do app quebrar.
// O script de restauração do app (reloadRestore) vem logo depois dele.
function injectClient(html, { restore = false } = {}) {
  if (html.includes(CLIENT_TAG)) return html;
  const tags = CLIENT_TAG + (restore ? '\n    ' + RESTORE_TAG : '');
  const head = html.match(/<head[^>]*>/i);
  if (head) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + '\n    ' + tags + html.slice(at);
  }
  return tags + '\n' + html;
}

// O client embrulha console.*, então o DevTools apontaria todo log para a
// linha do wrapper. Um source map de identidade com o arquivo na ignore list
// faz o DevTools pular esses frames e mostrar a linha do app que chamou o log.
const CLIENT_MAP_URL = '/__devbridge/client.js.map';

function withSourceMap(source) {
  return source.replace(/\n?$/, '\n') + '//# sourceMappingURL=' + CLIENT_MAP_URL + '\n';
}

function ignoreListMap(source, name) {
  const lines = source.split('\n').length;
  return {
    version: 3,
    file: 'client.js',
    sources: [name],
    sourcesContent: [source],
    names: [],
    mappings: Array.from({ length: lines }, (_, i) => (i === 0 ? 'AAAA' : 'AACA')).join(';'),
    ignoreList: [0],
    x_google_ignoreList: [0],
  };
}

module.exports = { resolveFile, injectClient, mimeOf, withSourceMap, ignoreListMap, CLIENT_TAG, RESTORE_TAG, CLIENT_MAP_URL };
