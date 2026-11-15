import fs from 'fs/promises';
import path from 'path';

// Estado do projeto GRAVADO PELO CÓDIGO (não depende de o modelo lembrar de chamar save_memory).
// Só entram aqui fatos confirmados pelo runtime: arquivos realmente gravados, comandos/verificações com resultado real.
// Arquivo: <projeto>/.gcode/estado.json

export const STATE_FILE = path.join('.gcode', 'estado.json');
const MAX_TASKS = 12;

const empty = () => ({ version: 1, updated: 0, tasks: [] });

export async function loadState(root) {
  try {
    const s = JSON.parse(await fs.readFile(path.join(root, STATE_FILE), 'utf-8'));
    return Array.isArray(s.tasks) ? s : empty();
  } catch { return empty(); }
}

async function saveState(root, state) {
  const file = path.join(root, STATE_FILE);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(state, null, 1), 'utf-8');
  await fs.rename(tmp, file); // troca atômica: uma queda no meio não corrompe o estado
}

/**
 * Registra uma tarefa. outcome: 'ok' | 'parcial' | 'falhou' | 'interrompido'.
 * entry: { request, outcome, files[], checks[{cmd, ok}], summary, role, steps }
 */
export async function recordTask(root, entry) {
  try {
    const state = await loadState(root);
    state.tasks.push({
      at: Date.now(),
      request: String(entry.request || '').replace(/\s+/g, ' ').slice(0, 200),
      outcome: entry.outcome || 'ok',
      files: [...new Set(entry.files || [])].slice(0, 40),
      checks: (entry.checks || []).slice(0, 6).map(c => ({ cmd: String(c.cmd).slice(0, 80), ok: !!c.ok })),
      summary: String(entry.summary || '').replace(/\s+/g, ' ').slice(0, 300),
      unverified: entry.unverified ? String(entry.unverified).slice(0, 160) : undefined
    });
    state.tasks = state.tasks.slice(-MAX_TASKS);
    state.updated = Date.now();
    await saveState(root, state);
  } catch { /* gravar o estado nunca pode derrubar a tarefa */ }
}

const ICON = { ok: '✔', parcial: '◐', falhou: '✘', interrompido: '⏸' };

/** Texto compacto para o prompt (poucos tokens): últimas tarefas + o que ficou pendente. */
export function renderState(state, maxChars = 1600) {
  if (!state?.tasks?.length) return '';
  const lines = [];
  for (const t of state.tasks.slice(-6).reverse()) {
    const checks = t.checks?.length ? ` • verificações: ${t.checks.map(c => `${c.cmd} ${c.ok ? '✔' : '✘'}`).join(', ')}` : '';
    const files = t.files?.length ? ` • arquivos: ${t.files.slice(0, 8).join(', ')}${t.files.length > 8 ? ` (+${t.files.length - 8})` : ''}` : '';
    lines.push(`${ICON[t.outcome] || '•'} ${new Date(t.at).toISOString().slice(0, 16).replace('T', ' ')} ${t.request}${files}${checks}${t.unverified ? ` • NÃO VERIFICADO: ${t.unverified}` : ''}${t.summary && t.outcome !== 'ok' ? ` • ${t.summary}` : ''}`);
  }
  const pend = state.tasks.filter(t => t.outcome === 'interrompido' || t.outcome === 'falhou' || t.outcome === 'parcial').slice(-1)[0];
  const head = 'Histórico do projeto (registrado pelo programa; ✔ concluído, ◐ parcial, ✘ falhou, ⏸ interrompido):\n';
  const tail = pend && pend === state.tasks[state.tasks.length - 1]
    ? '\nA última tarefa NÃO foi concluída. Se o usuário pedir para continuar, retome dela: os arquivos listados já foram gravados — leia-os em vez de refazer.' : '';
  let out = head + lines.join('\n') + tail;
  if (out.length > maxChars) out = out.slice(0, maxChars) + '…';
  return out;
}
