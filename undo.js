import fs from 'fs/promises';
import path from 'path';

/**
 * Desfazer: antes de o agente criar/alterar um arquivo (write_file / edit_file), guardamos o original em
 * <projeto>/.gcode/undo/<pedido>/. "Desfazer" restaura tudo que UM pedido mexeu.
 * Não depende de git. Não cobre o que um comando (run_command) altera.
 */

const DIR = path.join('.gcode', 'undo');
const KEEP = 10;
const MAX_BACKUP_BYTES = 5 * 1024 * 1024;

const journals = new Map(); // raiz -> { id, seen, entries, n }
const toRel = (root, abs) => path.relative(root, abs).split(path.sep).join('/');

export async function beginJournal(baseDir) {
  const root = path.resolve(baseDir);
  const id = new Date().toISOString().replace(/[:.]/g, '-');
  journals.set(root, { id, seen: new Set(), entries: [], n: 0 });
  // mantém só os últimos KEEP pedidos
  try {
    const dirs = (await fs.readdir(path.join(root, DIR))).sort();
    for (const d of dirs.slice(0, Math.max(0, dirs.length - KEEP))) {
      await fs.rm(path.join(root, DIR, d), { recursive: true, force: true });
    }
  } catch {}
}

/** Chame ANTES de gravar `target` (caminho absoluto já validado). */
export async function journalBefore(baseDir, target) {
  const root = path.resolve(baseDir);
  const j = journals.get(root);
  if (!j) return;
  const rel = toRel(root, target);
  if (j.seen.has(rel)) return; // só o estado ORIGINAL (antes do pedido) interessa
  j.seen.add(rel);

  const dir = path.join(root, DIR, j.id);
  const entry = { rel, existed: false, backup: null, skipped: false };
  try {
    await fs.mkdir(path.join(dir, 'files'), { recursive: true });
    try {
      const st = await fs.stat(target);
      entry.existed = true;
      if (st.size > MAX_BACKUP_BYTES) entry.skipped = true;
      else {
        entry.backup = `files/${j.n++}`;
        await fs.copyFile(target, path.join(dir, entry.backup));
      }
    } catch { /* não existia: desfazer = apagar */ }
    j.entries.push(entry);
    await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ id: j.id, at: Date.now(), entries: j.entries }), 'utf-8');
  } catch { /* se o backup falhar, o agente continua; só não dá para desfazer este arquivo */ }
}

export async function listUndo(baseDir) {
  const root = path.resolve(baseDir);
  const out = [];
  let dirs = [];
  try { dirs = (await fs.readdir(path.join(root, DIR))).sort().reverse(); } catch { return out; }
  for (const d of dirs) {
    try {
      const m = JSON.parse(await fs.readFile(path.join(root, DIR, d, 'manifest.json'), 'utf-8'));
      out.push({ id: m.id, at: m.at, files: m.entries.map(e => e.rel) });
    } catch {}
  }
  return out;
}

/** Desfaz o pedido mais recente (ou o `id` informado). */
export async function undoLast(baseDir, id) {
  const root = path.resolve(baseDir);
  const list = await listUndo(root);
  const item = id ? list.find(x => x.id === id) : list[0];
  if (!item) return { ok: false, message: 'Nada para desfazer neste projeto.' };

  const dir = path.join(root, DIR, item.id);
  const m = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf-8'));
  const restored = [];
  const removed = [];
  const failed = [];

  for (const e of [...m.entries].reverse()) {
    const target = path.resolve(root, e.rel);
    const rel = path.relative(root, target);
    if (rel.startsWith('..') || path.isAbsolute(rel)) { failed.push(`${e.rel} (caminho inválido)`); continue; }
    try {
      if (!e.existed) {
        await fs.rm(target, { force: true });
        removed.push(e.rel);
      } else if (e.backup) {
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.copyFile(path.join(dir, e.backup), target);
        restored.push(e.rel);
      } else {
        failed.push(`${e.rel} (era grande demais para guardar cópia)`);
      }
    } catch (err) { failed.push(`${e.rel} (${err.message})`); }
  }

  if (!failed.length) await fs.rm(dir, { recursive: true, force: true });
  const parts = [];
  if (restored.length) parts.push(`restaurados: ${restored.join(', ')}`);
  if (removed.length) parts.push(`removidos (eram novos): ${removed.join(', ')}`);
  if (failed.length) parts.push(`NÃO foi possível: ${failed.join(', ')}`);
  return { ok: failed.length === 0, restored, removed, failed, message: parts.join(' | ') || 'Nada a fazer.' };
}
