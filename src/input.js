'use strict';

// Entrada no aparelho por `adb shell input`. Coordenadas em pixels da captura
// (as mesmas do screencap/app_screenshot), que seguem a rotação atual da tela.
const KEYS = {
  back: 4, home: 3, enter: 66, tab: 61, del: 67, backspace: 67, delete: 112, escape: 111, esc: 111,
  menu: 82, space: 62, up: 19, down: 20, left: 21, right: 22, recents: 187, search: 84,
};

function coord(v, name) {
  const n = Math.round(Number(v));
  if (v === undefined || v === null || v === '' || !Number.isFinite(n) || n < 0) throw new Error(`${name} inválido: ${v}`);
  return String(n);
}

function tapArgs(x, y) {
  return ['shell', 'input', 'tap', coord(x, 'x'), coord(y, 'y')];
}

function swipeArgs(x1, y1, x2, y2, durationMs = 300) {
  const ms = Math.min(Math.max(Math.round(Number(durationMs) || 300), 50), 5000);
  return ['shell', 'input', 'swipe', coord(x1, 'x1'), coord(y1, 'y1'), coord(x2, 'x2'), coord(y2, 'y2'), String(ms)];
}

// `input text` só aceita ASCII imprimível; o resto vai pelo DOM do app.
function isPlainText(text) {
  return /^[\x20-\x7e]+$/.test(text);
}

// O texto passa pelo shell do aparelho: metacaracteres levam barra e espaço vira %s.
function textArgs(text) {
  if (typeof text !== 'string' || !text) throw new Error('Informe o texto.');
  if (!isPlainText(text)) throw new Error('O "input text" do Android só aceita ASCII sem quebra de linha; use via "dom" (campo focado no app) ou app_key enter.');
  return ['shell', 'input', 'text', text.replace(/[\\'"`$&|;<>()*?[\]{}~#!]/g, '\\$&').replace(/ /g, '%s')];
}

function keyArgs(key) {
  const k = String(key || '').trim();
  let code = KEYS[k.toLowerCase()];
  if (code === undefined && /^\d+$/.test(k)) code = Number(k);
  if (code === undefined && /^KEYCODE_\w+$/i.test(k)) code = k.toUpperCase();
  if (code === undefined) throw new Error(`Tecla desconhecida: "${k}". Use ${Object.keys(KEYS).join(', ')}, um número ou KEYCODE_*.`);
  return ['shell', 'input', 'keyevent', String(code)];
}

module.exports = { KEYS, tapArgs, swipeArgs, textArgs, keyArgs, isPlainText };
