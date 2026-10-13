'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Mirror } = require('../src/mirror');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Captura falsa: cada chamada demora `ms` e devolve um buffer numerado.
function fakeCapture(ms, { fail = () => false } = {}) {
  const calls = { n: 0, active: 0, maxActive: 0 };
  const capture = async () => {
    const n = ++calls.n;
    calls.active++;
    calls.maxActive = Math.max(calls.maxActive, calls.active);
    await wait(typeof ms === 'function' ? ms(n) : ms);
    calls.active--;
    if (fail(n)) throw new Error('device offline');
    return Buffer.from('png' + n);
  };
  return { capture, calls };
}

test('mirror: captura em paralelo, entrega quadros novos e para sem espectadores', async () => {
  const { capture, calls } = fakeCapture(30);
  const m = new Mirror({ capture, workers: 3, idleMs: 150, waitMs: 500, staggerMs: 0 });
  try {
    const f1 = await m.next(0);
    assert.equal(f1.seq, 1);
    const f2 = await m.next(f1.seq);
    assert.ok(f2.seq > f1.seq);
    assert.equal(calls.maxActive, 3);
    // Sem novos pedidos por idleMs, os workers param.
    await wait(300);
    const before = calls.n;
    await wait(150);
    assert.equal(m.running, 0);
    assert.equal(calls.n, before);
  } finally {
    m.stop();
  }
});

test('mirror: quadro que começou antes do último publicado é descartado', async () => {
  // A 1ª captura demora mais que a 2ª: termina depois, mas é mais velha.
  const { capture } = fakeCapture((n) => (n === 1 ? 120 : 20));
  const m = new Mirror({ capture, workers: 2, idleMs: 200, waitMs: 500, staggerMs: 0 });
  try {
    const seen = [];
    let after = 0;
    while (seen.length < 3) {
      const f = await m.next(after);
      seen.push(f.png.toString());
      after = f.seq;
    }
    assert.ok(!seen.includes('png1'), `png1 é mais velho que png2 e não pode aparecer: ${seen}`);
  } finally {
    m.stop();
  }
});

test('mirror: erro de captura chega a quem espera e some quando o aparelho volta', async () => {
  const { capture } = fakeCapture(10, { fail: (n) => n <= 2 });
  const m = new Mirror({ capture, workers: 1, idleMs: 400, waitMs: 500, retryMs: 20 });
  try {
    const r = await m.next(0);
    assert.equal(r.error, 'device offline');
    // Como a janela: tenta de novo até vir um quadro.
    let f = r;
    for (let i = 0; i < 20 && !f.png; i++) {
      await wait(20);
      f = await m.next(0);
    }
    // As duas primeiras falharam: o quadro só pode vir da 3ª captura em diante.
    assert.ok(Number(f.png.toString().slice(3)) >= 3, f.png.toString());
    assert.equal(m.error, null);
  } finally {
    m.stop();
  }
});

test('mirror: sem quadro em waitMs, next resolve com null', async () => {
  const m = new Mirror({ capture: () => new Promise(() => {}), workers: 1, idleMs: 100, waitMs: 40 });
  try {
    assert.equal(await m.next(0), null);
  } finally {
    m.stop();
  }
});
