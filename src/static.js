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

// O client entra como primeiro script do <head> para capturar logs do boot
// e continuar recebendo "reload" mesmo se algum script do app quebrar.
function injectClient(html) {
  if (html.includes(CLIENT_TAG)) return html;
  const head = html.match(/<head[^>]*>/i);
  if (head) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + '\n    ' + CLIENT_TAG + html.slice(at);
  }
  return CLIENT_TAG + '\n' + html;
}

module.exports = { resolveFile, injectClient, mimeOf, CLIENT_TAG };
