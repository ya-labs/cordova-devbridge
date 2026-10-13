'use strict';

// Espelho da tela do celular por capturas em sequência. Um screencap -p leva
// ~0,6 s no aparelho; várias capturas em paralelo multiplicam os quadros por
// segundo (3 em paralelo ≈ 4 qps num aparelho intermediário). Só roda
// enquanto alguém pede quadros: sem pedidos por idleMs, os workers param.
class Mirror {
  constructor({ capture, workers = 3, idleMs = 4000, waitMs = 10000, retryMs = 1000, staggerMs = 180 } = {}) {
    this.capture = capture;
    this.workers = workers;
    this.idleMs = idleMs;
    this.waitMs = waitMs;
    this.retryMs = retryMs;
    this.staggerMs = staggerMs;
    this.seq = 0;
    this.last = null;        // { seq, png, ts }
    this.started = 0;        // contador de capturas iniciadas
    this.lastStart = 0;      // número da captura que gerou o último quadro
    this.error = null;
    this.running = 0;
    this.lastWant = 0;
    this.waiters = [];
    this.stopped = false;
  }

  // Próximo quadro com seq > after. Resolve com o quadro, com { error } se a
  // captura estiver falhando, ou com null se nada chegou em waitMs.
  next(after = 0) {
    this.lastWant = Date.now();
    this.ensure();
    if (this.last && this.last.seq > after) return Promise.resolve(this.last);
    if (this.error && !this.last) return Promise.resolve({ error: this.error });
    return new Promise((resolve) => {
      const waiter = { after, resolve };
      waiter.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        resolve(this.error ? { error: this.error } : null);
      }, this.waitMs);
      this.waiters.push(waiter);
    });
  }

  ensure() {
    if (this.stopped) return;
    while (this.running < this.workers) {
      this.running++;
      // Escalonados para os quadros chegarem espaçados, não em rajadas.
      const delay = (this.running - 1) * this.staggerMs;
      setTimeout(() => this.loop(), delay);
    }
  }

  async loop() {
    try {
      while (!this.stopped && Date.now() - this.lastWant < this.idleMs) {
        const start = ++this.started;
        let png;
        try {
          png = await this.capture();
        } catch (err) {
          this.error = err.message || String(err);
          this.flush({ error: this.error });
          await sleep(this.retryMs);
          continue;
        }
        this.error = null;
        // Capturas em paralelo terminam fora de ordem: só publica o que começou depois do último quadro.
        if (start < this.lastStart) continue;  // começou antes do último quadro publicado
        this.lastStart = start;
        this.last = { seq: ++this.seq, png, ts: Date.now() };
        this.flush(this.last);
      }
    } finally {
      this.running--;
    }
  }

  flush(result) {
    const ready = result.error ? this.waiters : this.waiters.filter((w) => result.seq > w.after);
    this.waiters = this.waiters.filter((w) => !ready.includes(w));
    for (const w of ready) {
      clearTimeout(w.timer);
      w.resolve(result);
    }
  }

  stop() {
    this.stopped = true;
    this.flush({ error: 'servidor encerrado' });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { Mirror };
