import fs from 'fs/promises';
import path from 'path';
import { loadIgnore, shouldSkip, isBinaryName } from './ignore.js';

const MAX_FILES = 3000;
const MAX_READ_BYTES = 400_000;   // arquivos maiores entram na lista, mas sem símbolos
const MAX_SYMBOLS_PER_FILE = 40;
const CACHE_VERSION = 2;

const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'else', 'do', 'try', 'new', 'await', 'typeof', 'super']);

// Cada extrator recebe o texto e devolve [{ name, line }]
const lineScan = (text, patterns) => {
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length && out.length < MAX_SYMBOLS_PER_FILE * 2; i++) {
    const ln = lines[i];
    if (ln.length > 300) continue; // minificado
    for (const { re, group, kind } of patterns) {
      const m = ln.match(re);
      if (m && m[group] && !KEYWORDS.has(m[group])) { out.push({ name: `${kind ? kind + ' ' : ''}${m[group]}`, line: i + 1 }); break; }
    }
  }
  return out;
};

const JS = [
  { re: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, group: 1, kind: 'class' },
  { re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/, group: 1, kind: 'fn' },
  { re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/, group: 1, kind: 'fn' },
  { re: /^\s*(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/, group: 1, kind: 'type' },
  { re: /^ {1,4}(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/, group: 1, kind: '' }
];
const PY = [
  { re: /^\s*class\s+(\w+)/, group: 1, kind: 'class' },
  { re: /^\s*(?:async\s+)?def\s+(\w+)/, group: 1, kind: 'def' }
];
const GO = [
  { re: /^func\s+(?:\([^)]*\)\s*)?(\w+)/, group: 1, kind: 'func' },
  { re: /^type\s+(\w+)\s+(?:struct|interface)/, group: 1, kind: 'type' }
];
const RS = [
  { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)/, group: 1, kind: 'fn' },
  { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait)\s+(\w+)/, group: 1, kind: 'type' },
  { re: /^\s*impl(?:<[^>]*>)?\s+(?:[\w:<>]+\s+for\s+)?(\w+)/, group: 1, kind: 'impl' }
];
const CLIKE_TYPES = { re: /^\s*(?:[\w@<>\[\],]+\s+)*?(?:class|interface|enum|struct|record|object|namespace)\s+(\w+)/, group: 1, kind: 'type' };
const JVM = [
  CLIKE_TYPES,
  { re: /^\s*(?:public|private|protected|internal|static|override|virtual|abstract|final|async|suspend|open)\s+(?:[\w<>\[\],.?]+\s+)*?(\w+)\s*\(/, group: 1, kind: '' },
  { re: /^\s*(?:fun|func)\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?(\w+)\s*\(/, group: 1, kind: 'fn' }
];
const C = [
  CLIKE_TYPES,
  { re: /^[A-Za-z_][\w\s*:&<>,]*?[\s*&]+([A-Za-z_]\w*)\s*\([^;]*\)\s*(?:const\s*)?\{?\s*$/, group: 1, kind: '' }
];
const LUA = [
  { re: /^\s*(?:local\s+)?function\s+([\w.:]+)/, group: 1, kind: 'fn' },
  { re: /^\s*(?:local\s+)?([\w.]+)\s*=\s*function\s*\(/, group: 1, kind: 'fn' }
];
const MD = [{ re: /^#{1,3}\s+(.+?)\s*$/, group: 1, kind: '#' }];

const BY_EXT = {
  js: JS, mjs: JS, cjs: JS, jsx: JS, ts: JS, tsx: JS,
  py: PY, go: GO, rs: RS,
  java: JVM, cs: JVM, kt: JVM, scala: JVM, swift: JVM, dart: JVM,
  c: C, h: C, cpp: C, hpp: C, cc: C,
  lua: LUA, md: MD
};

export function extractSymbols(text, ext) {
  const pats = BY_EXT[ext];
  if (!pats) return [];
  const seen = new Set();
  const out = [];
  for (const s of lineScan(text, pats)) {
    const key = `${s.name}:${s.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(`${s.name}:${s.line}`);
    if (out.length >= MAX_SYMBOLS_PER_FILE) break;
  }
  return out;
}

async function collect(root, start, ignore) {
  const files = [];
  let skippedBin = 0;
  const stack = [start];
  while (stack.length && files.length < MAX_FILES) {
    const dir = stack.pop();
    let ents;
    try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const abs = path.join(dir, e.name);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (shouldSkip(e.name, rel, ignore)) continue;
      if (e.isDirectory()) stack.push(abs);
      else if (e.isFile()) {
        if (isBinaryName(e.name)) { skippedBin++; continue; }
        files.push({ abs, rel });
      }
    }
  }
  files.sort((a, b) => a.rel.localeCompare(b.rel));
  return { files, skippedBin, capped: files.length >= MAX_FILES };
}

/**
 * Mapa do projeto: cada arquivo com nº de linhas e símbolos (funções, classes...) e a linha onde estão.
 * Guarda cache em <projeto>/.gcode/mapa.json: só reanalisa o que mudou.
 *  - sub:   limita a uma subpasta (caminho absoluto já validado)
 *  - query: mostra só arquivos/símbolos que contenham o texto
 */
export async function buildProjectMap(root, { sub, query, maxChars = 6500 } = {}) {
  const ignore = await loadIgnore(root);
  const start = sub || root;
  const { files, skippedBin, capped } = await collect(root, start, ignore);
  if (!files.length) return 'Nenhum arquivo de texto encontrado.';

  const cacheFile = path.join(root, '.gcode', 'mapa.json');
  let cache = { v: CACHE_VERSION, files: {} };
  try {
    const c = JSON.parse(await fs.readFile(cacheFile, 'utf-8'));
    if (c.v === CACHE_VERSION && c.files) cache = c;
  } catch {}

  let dirty = false;
  const rows = [];
  for (const f of files) {
    let st;
    try { st = await fs.stat(f.abs); } catch { continue; }
    const hit = cache.files[f.rel];
    if (hit && hit.m === st.mtimeMs && hit.s === st.size) { rows.push({ rel: f.rel, ...hit }); continue; }

    let entry = { m: st.mtimeMs, s: st.size, l: 0, sym: [], big: st.size > MAX_READ_BYTES };
    if (!entry.big) {
      try {
        const text = await fs.readFile(f.abs, 'utf-8');
        if (text.includes('\0')) continue; // binário disfarçado
        entry.l = text.split('\n').length;
        entry.sym = extractSymbols(text, path.extname(f.rel).slice(1).toLowerCase());
      } catch { continue; }
    }
    cache.files[f.rel] = entry;
    rows.push({ rel: f.rel, ...entry });
    dirty = true;
  }
  if (dirty) {
    // limpa entradas de arquivos que não existem mais (só quando mapeou o projeto todo)
    if (!sub) {
      const alive = new Set(rows.map(r => r.rel));
      for (const k of Object.keys(cache.files)) if (!alive.has(k)) delete cache.files[k];
    }
    try {
      await fs.mkdir(path.dirname(cacheFile), { recursive: true });
      await fs.writeFile(cacheFile, JSON.stringify(cache), 'utf-8');
    } catch {}
  }

  const q = query ? String(query).toLowerCase() : '';
  const lines = [];
  for (const r of rows) {
    const kb = r.s > 2048 ? ` ${Math.round(r.s / 1024)}KB` : '';
    if (q) {
      const syms = r.sym.filter(s => s.toLowerCase().includes(q));
      const nameHit = r.rel.toLowerCase().includes(q);
      if (!syms.length && !nameHit) continue;
      lines.push(`${r.rel} (${r.l}l)${syms.length ? ': ' + syms.join(', ') : ''}`);
    } else {
      lines.push(`${r.rel} (${r.big ? 'grande' : r.l + 'l'}${kb})${r.sym.length ? ': ' + r.sym.join(', ') : ''}`);
    }
  }
  if (!lines.length) return `Nada encontrado para "${query}" no mapa (${rows.length} arquivos analisados).`;

  let out = '';
  let shown = 0;
  for (const ln of lines) {
    if (out.length + ln.length + 1 > maxChars) break;
    out += ln + '\n';
    shown++;
  }
  const notes = [];
  if (shown < lines.length) notes.push(`mostrando ${shown} de ${lines.length} arquivos: use "path" (subpasta) ou "query" para ver o resto`);
  if (skippedBin) notes.push(`${skippedBin} arquivos binários/assets não listados`);
  if (capped) notes.push(`projeto muito grande: só os primeiros ${MAX_FILES} arquivos foram analisados`);
  return `Formato: arquivo (linhas): símbolo:linha\n${out}${notes.length ? '[' + notes.join(' • ') + ']' : ''}`;
}
