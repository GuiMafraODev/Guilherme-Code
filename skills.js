import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';

import { getSettings } from './config.js';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const GLOBAL_SKILLS_DIR = path.join(__dirname, 'skills');
export const GLOBAL_COMMANDS_DIR = path.join(__dirname, 'commands');
const CLAUDE_HOME = path.join(os.homedir(), '.claude');

const MAX_SKILLS_IN_PROMPT = 40;
const MAX_SKILL_BYTES = 25 * 1024 * 1024;
const SKIP_DIRS = new Set(['.git', 'node_modules']);

const sanitizeId = (s) => String(s).replace(/[^\w.-]/g, '-').replace(/^\.+/, '') || 'item';

// Onde procurar. Projeto vence global (primeiro encontrado ganha).
// ~/.claude/... e .claude/... são lidos para reaproveitar o que você já tem no Claude Code.
function skillRoots(projectDir) {
  const roots = [];
  if (projectDir) {
    roots.push({ dir: path.join(projectDir, '.gcode', 'skills'), scope: 'project', source: 'gcode' });
    roots.push({ dir: path.join(projectDir, '.claude', 'skills'), scope: 'project', source: 'claude-code' });
  }
  roots.push({ dir: GLOBAL_SKILLS_DIR, scope: 'global', source: 'gcode' });
  roots.push({ dir: path.join(CLAUDE_HOME, 'skills'), scope: 'global', source: 'claude-code' });
  return roots;
}

function commandRoots(projectDir) {
  const roots = [];
  if (projectDir) {
    roots.push({ dir: path.join(projectDir, '.gcode', 'commands'), scope: 'project', source: 'gcode' });
    roots.push({ dir: path.join(projectDir, '.claude', 'commands'), scope: 'project', source: 'claude-code' });
  }
  roots.push({ dir: GLOBAL_COMMANDS_DIR, scope: 'global', source: 'gcode' });
  roots.push({ dir: path.join(CLAUDE_HOME, 'commands'), scope: 'global', source: 'claude-code' });
  return roots;
}

/** YAML mínimo: chaves simples, aspas, e blocos "|" / ">" (suficiente para SKILL.md). */
export function parseFrontmatter(text) {
  const m = String(text).replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: String(text) };
  const lines = m[1].split(/\r?\n/);
  const meta = {};
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([\w-]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    let v = kv[2].trim();
    if (/^[|>][+-]?$/.test(v)) {
      const folded = v[0] === '>';
      const buf = [];
      while (i + 1 < lines.length && (/^\s/.test(lines[i + 1]) || lines[i + 1] === '')) buf.push(lines[++i].trim());
      v = buf.join(folded ? ' ' : '\n').trim();
    } else {
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) v += ' ' + lines[++i].trim();
      v = v.trim().replace(/^(["'])([\s\S]*)\1$/, '$2');
    }
    meta[key] = v;
  }
  return { meta, body: m[2] };
}

const isTrue = (v) => String(v).toLowerCase() === 'true';

export async function listSkills(projectDir, { all = false } = {}) {
  const found = new Map();
  const shadowed = [];
  for (const root of skillRoots(projectDir)) {
    let entries;
    try { entries = await fs.readdir(root.dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!(e.isDirectory() || e.isSymbolicLink()) || e.name.startsWith('.')) continue;
      const dir = path.join(root.dir, e.name);
      let txt;
      try { txt = await fs.readFile(path.join(dir, 'SKILL.md'), 'utf-8'); } catch { continue; }
      const dup = found.has(e.name);
      if (dup && !all) continue;
      const { meta, body } = parseFrontmatter(txt);
      const description = (meta.description || body.trim().split(/\n\s*\n/)[0] || '').replace(/\s+/g, ' ').trim();
      const entry = {
        id: e.name,
        name: meta.name || e.name,
        description,
        dir,
        scope: root.scope,
        source: root.source,
        manual: isTrue(meta['disable-model-invocation']) // só o usuário pode invocar
      };
      if (dup) shadowed.push({ ...entry, shadowed: true }); else found.set(e.name, entry);
    }
  }
  return [...found.values(), ...shadowed];
}

/** Skills que o agente enxerga: as que você marcou como "ocultas" (duplicadas, por ex.) ficam de fora. Reversível. */
export async function listVisibleSkills(projectDir) {
  const hidden = new Set(Array.isArray(getSettings().skillsHidden) ? getSettings().skillsHidden : []);
  return (await listSkills(projectDir)).filter(s => !hidden.has(s.id));
}

export async function listCommands(projectDir) {
  const found = new Map();
  for (const root of commandRoots(projectDir)) {
    let entries;
    try { entries = await fs.readdir(root.dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isFile() || !e.name.toLowerCase().endsWith('.md')) continue;
      const name = e.name.slice(0, -3);
      if (found.has(name)) continue;
      const file = path.join(root.dir, e.name);
      let txt;
      try { txt = await fs.readFile(file, 'utf-8'); } catch { continue; }
      const { meta, body } = parseFrontmatter(txt);
      found.set(name, {
        name,
        description: (meta.description || body.trim().split('\n')[0] || '').slice(0, 200),
        argumentHint: meta['argument-hint'] || '',
        file,
        scope: root.scope,
        source: root.source
      });
    }
  }
  return [...found.values()];
}

/** Trecho do system prompt: só nome + descrição (o corpo é carregado sob demanda). */
export function skillsPromptSection(skills) {
  const usable = skills.filter(s => !s.manual).slice(0, MAX_SKILLS_IN_PROMPT);
  if (!usable.length) return '';
  const rows = usable.map(s => `- ${s.id}: ${s.description.slice(0, 200)}`).join('\n');
  return `\n\nSkills disponíveis (instruções especializadas). Se a tarefa combinar com a descrição de uma skill, chame use_skill com o id ANTES de começar e siga as instruções dela:\n${rows}`;
}

export async function useSkill(projectDir, id) {
  const skills = await listSkills(projectDir);
  const skill = skills.find(s => s.id === id);
  if (!skill) return `Skill "${id}" não encontrada. Disponíveis: ${skills.map(s => s.id).join(', ') || '(nenhuma)'}`;

  const txt = await fs.readFile(path.join(skill.dir, 'SKILL.md'), 'utf-8');
  const { body } = parseFrontmatter(txt);

  const files = [];
  const walk = async (dir, depth) => {
    if (depth > 3 || files.length >= 50) return;
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      if (e.name === 'SKILL.md' && depth === 0) continue;
      if (e.isDirectory() && !SKIP_DIRS.has(e.name)) await walk(path.join(dir, e.name), depth + 1);
      else if (e.isFile()) files.push(path.relative(skill.dir, path.join(dir, e.name)));
    }
  };
  await walk(skill.dir, 0);

  return `# Skill: ${skill.id}\nPasta da skill: ${skill.dir}\n` +
    `(Caminhos relativos citados abaixo são relativos a essa pasta. Use read_skill_file para ler arquivos dela; ` +
    `para rodar scripts use run_command com o caminho absoluto.)\n\n${body.trim()}\n\n` +
    (files.length ? `Arquivos da skill:\n${files.join('\n')}` : '');
}

export async function readSkillFile(projectDir, id, relPath) {
  const skills = await listSkills(projectDir);
  const skill = skills.find(s => s.id === id);
  if (!skill) throw new Error(`Skill "${id}" não encontrada.`);
  const target = path.resolve(skill.dir, relPath || 'SKILL.md');
  const rel = path.relative(skill.dir, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Acesso negado: fora da pasta da skill.');
  return await fs.readFile(target, 'utf-8');
}

/** "/nome argumentos" -> prompt expandido (comando ou skill). Retorna null se não for nenhum. */
export async function expandSlash(text, projectDir) {
  const m = String(text).match(/^\/([\w.:-]+)(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  const args = (m[2] || '').trim();

  const cmd = (await listCommands(projectDir)).find(c => c.name === m[1]);
  if (cmd) {
    const { body } = parseFrontmatter(await fs.readFile(cmd.file, 'utf-8'));
    const positional = args.split(/\s+/).filter(Boolean);
    let out = body.replace(/\$ARGUMENTS/g, args).replace(/\$(\d)\b/g, (_, n) => positional[n - 1] ?? '');
    if (args && !/\$ARGUMENTS|\$\d/.test(body)) out += `\n\nArgumentos: ${args}`;
    return out.trim();
  }

  const skill = (await listSkills(projectDir)).find(s => s.id === m[1]);
  if (skill) {
    return `Use a skill "${skill.id}" (chame use_skill) para: ${args || 'a tarefa atual do projeto'}.`;
  }
  return null;
}

// ---------- Instalação a partir do GitHub ----------

function parseGithubUrl(url) {
  const m = String(url).trim().match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/tree\/([\w./-]+?))?\/?$/);
  if (!m || (m[3] && m[3].split('/').includes('..'))) {
    throw new Error('URL inválida. Use https://github.com/usuario/repositorio (ou .../tree/main/pasta).');
  }
  return { owner: m[1], repo: m[2], tree: m[3] || '' };
}

async function findSkillDirs(base, depth = 0, out = []) {
  if (depth > 5) return out;
  if (fsSync.existsSync(path.join(base, 'SKILL.md'))) { out.push(base); return out; }
  let entries;
  try { entries = await fs.readdir(base, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.isDirectory() && !SKIP_DIRS.has(e.name)) await findSkillDirs(path.join(base, e.name), depth + 1, out);
  }
  return out;
}

async function findCommandFiles(base, depth = 0, out = []) {
  if (depth > 5 || out.length >= 100) return out;
  let entries;
  try { entries = await fs.readdir(base, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory() || SKIP_DIRS.has(e.name)) continue;
    const p = path.join(base, e.name);
    if (e.name === 'commands') {
      for (const f of await fs.readdir(p, { withFileTypes: true })) {
        if (f.isFile() && /\.md$/i.test(f.name) && !/^(readme|changelog|license)/i.test(f.name)) out.push(path.join(p, f.name));
      }
    } else {
      await findCommandFiles(p, depth + 1, out);
    }
  }
  return out;
}

async function dirSize(dir) {
  let total = 0;
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && e.name !== '.git') total += await dirSize(p);
    else if (e.isFile()) total += (await fs.stat(p)).size;
  }
  return total;
}

// Não copia symlinks (um symlink malicioso poderia apontar para arquivos fora da skill).
const copyFilter = async (src) => {
  if (path.basename(src) === '.git') return false;
  return !(await fs.lstat(src)).isSymbolicLink();
};

/**
 * Baixa um repositório do GitHub e instala TODAS as skills (pastas com SKILL.md) e
 * comandos (.md em pastas "commands") encontrados nele.
 */
export async function installFromGithub(url, { scope = 'global', projectDir } = {}) {
  const { owner, repo, tree } = parseGithubUrl(url);
  if (scope === 'project' && !projectDir) throw new Error('Defina a pasta do projeto para instalar no escopo do projeto.');

  const skillsDest = scope === 'project' ? path.join(projectDir, '.gcode', 'skills') : GLOBAL_SKILLS_DIR;
  const commandsDest = scope === 'project' ? path.join(projectDir, '.gcode', 'commands') : GLOBAL_COMMANDS_DIR;

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gcode-'));
  const repoDir = path.join(tmp, 'repo');
  const cloneUrl = `https://github.com/${owner}/${repo}.git`;
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };

  try {
    const [branch, ...rest] = tree ? tree.split('/') : [];
    let subpath = rest.join('/');
    try {
      await execFileAsync('git', ['clone', '--depth', '1', ...(branch ? ['--branch', branch] : []), cloneUrl, repoDir], { timeout: 120000, env });
    } catch (err) {
      if (!branch) throw err;
      // branch com "/" no nome: clona o padrão e trata tudo depois de /tree/ como subpasta
      await fs.rm(repoDir, { recursive: true, force: true });
      await execFileAsync('git', ['clone', '--depth', '1', cloneUrl, repoDir], { timeout: 120000, env });
      subpath = tree;
    }

    const base = path.resolve(repoDir, subpath);
    const relBase = path.relative(repoDir, base);
    if (relBase.startsWith('..') || path.isAbsolute(relBase)) throw new Error('Subpasta inválida.');
    if (!fsSync.existsSync(base)) throw new Error('A subpasta informada não existe no repositório.');

    const skillDirs = await findSkillDirs(base);
    const commandFiles = await findCommandFiles(base);
    if (!skillDirs.length && !commandFiles.length) {
      throw new Error('Nada instalável encontrado (nenhuma pasta com SKILL.md e nenhuma pasta "commands" com .md).');
    }

    const result = { skills: [], commands: [], skipped: [] };

    for (const dir of skillDirs) {
      const fallback = dir === repoDir ? repo : path.basename(dir);
      const id = sanitizeId(dir === base && subpath ? path.basename(subpath) : fallback);
      if ((await dirSize(dir)) > MAX_SKILL_BYTES) { result.skipped.push(`${id} (maior que 25 MB)`); continue; }
      const dest = path.join(skillsDest, id);
      await fs.mkdir(skillsDest, { recursive: true });
      await fs.rm(dest, { recursive: true, force: true });
      await fs.cp(dir, dest, { recursive: true, filter: copyFilter });
      result.skills.push(id);
    }

    for (const file of commandFiles) {
      const name = sanitizeId(path.basename(file, path.extname(file)));
      await fs.mkdir(commandsDest, { recursive: true });
      await fs.copyFile(file, path.join(commandsDest, `${name}.md`));
      result.commands.push(name);
    }

    return result;
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

/** Remove apenas o que o Guilherme Code instalou (nunca mexe em ~/.claude ou .claude). */
export async function removeInstalled({ kind, id, scope, projectDir }) {
  if (!/^[\w.-]+$/.test(id || '') || id.startsWith('.')) throw new Error('Nome inválido.');
  const base = kind === 'skill'
    ? (scope === 'project' ? path.join(projectDir || '', '.gcode', 'skills') : GLOBAL_SKILLS_DIR)
    : (scope === 'project' ? path.join(projectDir || '', '.gcode', 'commands') : GLOBAL_COMMANDS_DIR);
  const target = kind === 'skill' ? path.join(base, id) : path.join(base, `${id}.md`);
  if (!fsSync.existsSync(target)) throw new Error('Item não encontrado (itens do Claude Code não podem ser removidos por aqui).');
  await fs.rm(target, { recursive: true, force: true });
}
