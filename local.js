import { spawn } from 'child_process';

// Apoio às IAs locais (Ollama, LM Studio...): detectar, iniciar o servidor e serializar as chamadas.

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Lista os modelos que o servidor local oferece. Lança erro se não responder. */
export async function listLocalModels(baseUrl, timeoutMs = 4000) {
  const res = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(timeoutMs), headers: { authorization: 'Bearer local' } });
  if (!res.ok) throw new Error(`o servidor respondeu HTTP ${res.status}`);
  const data = await res.json();
  const arr = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
  return arr.map(m => String(m.id || m.name || m.model || '')).filter(Boolean);
}

export async function isLocalUp(baseUrl) {
  try { await listLocalModels(baseUrl, 2500); return true; } catch { return false; }
}

const isThisMachine = (baseUrl) => { try { return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(baseUrl).hostname); } catch { return false; } };

// Comandos FIXOS (nunca vêm da tela): só iniciam o programa de IA local conhecido, no próprio computador.
const START_CMD = {
  ollama: ['ollama', ['serve']],
  lmstudio: ['lms', ['server', 'start']]
};
const lastStart = new Map();

/**
 * Garante que o servidor local está no ar. Se não estiver e "autostart" estiver ligado (Ollama/LM Studio, neste
 * computador), tenta iniciá-lo e espera até ~25 s. Devolve true se está respondendo.
 */
export async function ensureLocalUp(p, onLog = () => {}) {
  if (await isLocalUp(p.baseUrl)) return true;
  const cmd = START_CMD[p.kind];
  if (!p.autostart || !cmd || !isThisMachine(p.baseUrl)) return false;
  if (Date.now() - (lastStart.get(p.id) || 0) < 60e3) return false; // não fica reiniciando em loop
  lastStart.set(p.id, Date.now());
  onLog(`🔄 ${p.name}: servidor local parado. Tentando iniciar (${cmd[0]} ${cmd[1].join(' ')})...`);
  let failed = '';
  try {
    const child = spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore', windowsHide: true, shell: process.platform === 'win32' });
    child.on('error', (e) => { failed = e.message; });
    child.unref();
  } catch (e) { failed = e.message; }
  for (let i = 0; i < 25 && !failed; i++) {
    await sleep(1000);
    if (await isLocalUp(p.baseUrl)) { onLog(`✅ ${p.name}: servidor local iniciado.`); return true; }
  }
  onLog(`⚠️ ${p.name}: não consegui iniciar sozinho${failed ? ` (${failed})` : ''}. Abra o programa manualmente.`);
  return false;
}

// Fila GLOBAL das IAs locais: a GPU/CPU é uma só, então NUNCA roda mais de uma IA local ao mesmo tempo,
// mesmo que sejam servidores diferentes (Ollama + LM Studio) ou subagentes em paralelo. Os demais esperam na fila.
let tail = Promise.resolve();
export function withLock(_id, fn) {
  const run = tail.catch(() => {}).then(fn);
  tail = run.catch(() => {});
  return run;
}

// ---------- Memória de vídeo: descarregar modelo local para não ter vários na VRAM ----------

const originOf = (baseUrl) => { try { return new URL(baseUrl).origin; } catch { return ''; } };

/** Modelos que o Ollama está mantendo carregados agora: [{ name, size, sizeVram }] (vazio se não for Ollama/não responder). */
export async function ollamaLoaded(baseUrl) {
  try {
    const res = await fetch(`${originOf(baseUrl)}/api/ps`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return [];
    const d = await res.json();
    return (d.models || []).map(m => ({ name: String(m.name || m.model || ''), size: Number(m.size) || 0, sizeVram: Number(m.size_vram) || 0 }));
  } catch { return []; }
}

/**
 * Libera a VRAM: descarrega os modelos locais carregados, exceto `keep` (nome do modelo que vai ser usado em seguida).
 * Ollama: pede keep_alive 0 (API nativa). LM Studio: comando fixo `lms unload --all`. Melhor esforço: nunca lança erro.
 * Devolve a lista de modelos descarregados.
 */
export async function unloadLocalModels(p, keep = null, onLog = () => {}) {
  const out = [];
  try {
    if (p.kind === 'ollama') {
      for (const m of await ollamaLoaded(p.baseUrl)) {
        if (keep && (m.name === keep || m.name.replace(/:latest$/, '') === String(keep).replace(/:latest$/, ''))) continue;
        try {
          await fetch(`${originOf(p.baseUrl)}/api/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: m.name, keep_alive: 0 }), signal: AbortSignal.timeout(8000) });
          out.push(m.name);
        } catch {}
      }
    } else if (p.kind === 'lmstudio' && isThisMachine(p.baseUrl)) {
      await new Promise((resolve) => {
        const c = spawn('lms', ['unload', '--all'], { stdio: 'ignore', windowsHide: true, shell: process.platform === 'win32' });
        c.on('error', () => resolve()); c.on('exit', () => { out.push('(LM Studio)'); resolve(); });
        setTimeout(resolve, 10000);
      });
    }
  } catch {}
  if (out.length) onLog(`🧹 VRAM liberada: ${out.join(', ')} descarregado(s).`);
  return out;
}
