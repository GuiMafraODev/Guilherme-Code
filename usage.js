import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Consumo estimado por chave (slot) e por dia. Fica em .usage.json (só números, sem chaves de API).
const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '.usage.json');
let U = {};
try { U = JSON.parse(fs.readFileSync(FILE, 'utf-8')) || {}; } catch { U = {}; }
let timer = null;

const today = () => new Date().toISOString().slice(0, 10);

function saveSoon() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    try { fs.writeFileSync(FILE, JSON.stringify(U)); } catch {}
  }, 3000);
  timer.unref?.();
}

/** Registra uma chamada. tokens = estimativa (entrada + saída). */
export function recordUsage(slotId, { tokens = 0, error = false } = {}) {
  const d = today();
  const e = (U[slotId] ||= { days: {} });
  const day = (e.days[d] ||= { req: 0, tok: 0, err: 0 });
  day.req++;
  day.tok += Math.max(0, Math.round(tokens));
  if (error) day.err++;
  const keep = Object.keys(e.days).sort().slice(-14); // guarda só 14 dias
  for (const k of Object.keys(e.days)) if (!keep.includes(k)) delete e.days[k];
  saveSoon();
}

export function getUsage(slotId) {
  const e = U[slotId];
  const d = e?.days?.[today()] || { req: 0, tok: 0, err: 0 };
  const tot = Object.values(e?.days || {}).reduce((a, x) => ({ req: a.req + x.req, tok: a.tok + x.tok, err: a.err + x.err }), { req: 0, tok: 0, err: 0 });
  return { today: d, total: tot };
}

// Garante que nada se perde ao fechar o programa (Ctrl+C / fim do processo)
process.on('exit', () => { try { fs.writeFileSync(FILE, JSON.stringify(U)); } catch {} });
