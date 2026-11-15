import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, '.health.json');

const H12 = 12 * 3600e3;
const H24 = 24 * 3600e3;

const empty = () => ({
  v: 1,
  dead: {},       // "provider::model" -> quando deu 404 (modelo sem acesso/inexistente)
  noTools: {},    // modelo que não aceita tools
  noVision: {},   // modelo que recusou imagem
  hardDown: {},   // erro permanente (400...): até quando ignorar
  cooldowns: {},  // limite temporário (429, timeout...): até quando esperar
  bad: {},        // provedor pausado (sem saldo / chave rejeitada): até quando
  badWhy: {},     // motivo da pausa
  fails: {},      // falhas temporárias seguidas (para aumentar a espera)
  auto: {},       // modelos descobertos e testados automaticamente
  stats: {},      // latência média até a primeira resposta
  limits: {},     // limite de tokens por pedido aprendido de erros 413 (ex.: Groq grátis ~6-8 mil)
  ignored: {},    // "provider::model" -> { why, at, onlyAgent, manual }: modelos que NÃO funcionam. Não expira.
  paramCaps: {},  // "tipo|endereço|modelo" -> { reasoning_effort: {state, at}, response_format: {state, at} } (parâmetros opcionais testados)
  strikes: {}     // recusas (400...) seguidas por modelo: 3 = vai para a lista de ignorados
});

/** Carrega o estado salvo, descartando o que já expirou. Assim o agente NÃO repete erros antigos ao reiniciar. */
export function loadHealth() {
  const h = empty();
  try {
    const d = JSON.parse(fs.readFileSync(FILE, 'utf-8'));
    for (const k of Object.keys(h)) if (d[k] && typeof d[k] === 'object') h[k] = d[k];
  } catch {}

  const t = Date.now();
  const prune = (obj, keep) => { for (const k of Object.keys(obj)) if (!keep(obj[k], k)) delete obj[k]; };
  prune(h.dead, ts => t - ts < H12);
  prune(h.noTools, ts => t - ts < H24);
  prune(h.noVision, ts => t - ts < H24);
  prune(h.hardDown, u => u > t);
  prune(h.cooldowns, u => u > t);
  prune(h.bad, u => u > t);
  prune(h.badWhy, (_, k) => !!h.bad[k]);
  prune(h.fails, f => t - (f.last || 0) < 30 * 60e3);
  prune(h.auto, a => t - (a.at || 0) < H24);
  prune(h.limits, l => t - (l.at || 0) < H24);
  prune(h.strikes, x => t - (x.at || 0) < H24);
  // capacidades de parâmetros opcionais: valem por 30 dias; depois são testadas de novo
  for (const k of Object.keys(h.paramCaps)) {
    const e = h.paramCaps[k] || {};
    for (const n of Object.keys(e)) if (!e[n] || t - (e[n].at || 0) > 30 * 24 * 3600e3) delete e[n];
    if (!Object.keys(e).length) delete h.paramCaps[k];
  }
  // h.ignored propositalmente NÃO é podado: só sai quando você restaura o modelo.
  return h;
}

let timer = null;
let pending = null;

/** Grava em disco no máximo a cada ~1,5 s (não trava o agente). */
export function saveHealthSoon(h) {
  pending = h;
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    try { fs.writeFile(FILE, JSON.stringify(pending), () => {}); } catch {}
  }, 1500);
}
