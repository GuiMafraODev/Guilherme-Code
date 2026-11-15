import fs from 'fs/promises';
import path from 'path';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import { useSkill, readSkillFile, listVisibleSkills } from './skills.js';
import { searchSkillsText } from './skillindex.js';
import { PROTECTED, isBinaryName, loadIgnore, shouldSkip } from './ignore.js';
import { buildProjectMap } from './repomap.js';
import { fetchUrl } from './webfetch.js';
import { journalBefore } from './undo.js';
import { DOC_EXTS, IMAGE_EXTS, extOf, readDocument, loadImage } from './docs.js';
import { hexdumpFile, stringsFile, binaryInfo, reTool } from './binary.js';
import { decideCommand, cleanEnv, redactSecrets, writeBlockReason, assertInsideReal, validateArgs, approvalKey } from './guard.js';
import { getPermissionMode } from './config.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

const MAX_OUTPUT = 8000;
const MEMORY_FILE = path.join('.gcode', 'memoria.md');
const MEMORY_MAX = 4000;

// (A lista de bloqueio de comandos agora vive em guard.js: classificação deny/ask/allow + aprovação.)

/** Ferramentas que só LEEM: quando o modelo pede várias de uma vez, rodam em paralelo. */
export const READ_ONLY_TOOLS = new Set([
  'project_tree', 'search_files', 'read_file_chunk', 'read_many', 'project_map',
  'read_skill_file', 'use_skill', 'search_skills', 'git', 'fetch_url', 'parallel_research',
  'read_document', 'view_image', 'hexdump', 'strings', 'binary_info'
]);

// Saída de comandos: erros costumam estar no FIM, então mantém começo e fim.
const truncateMiddle = (s, max = MAX_OUTPUT) => {
  s = String(s);
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.55);
  const tail = max - head;
  return s.slice(0, head) + `\n...[${s.length - max} caracteres omitidos no meio]...\n` + s.slice(-tail);
};
// Leituras: corta no fim (o meio de um arquivo não pode sumir sem aviso).
const truncateEnd = (s, max = MAX_OUTPUT) => {
  s = String(s);
  return s.length > max ? s.slice(0, max) + `\n...[truncado: faltam ${s.length - max} caracteres; peça um trecho menor]` : s;
};

const resolveSafePath = (baseDir, targetPath) => {
  const root = path.resolve(baseDir);
  const resolved = path.resolve(root, targetPath || '.');
  const rel = path.relative(root, resolved);
  // startsWith(baseDir) deixava passar pastas irmãs como "C:\proj-evil"; relative() não.
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Acesso negado: fora do diretório do projeto.');
  }
  if (PROTECTED.has(path.basename(resolved).toLowerCase())) {
    throw new Error('Acesso negado: arquivo protegido.');
  }
  assertInsideReal(root, resolved); // links simbólicos não podem levar para fora do projeto
  return resolved;
};

// ---------- Memória do projeto (.gcode/memoria.md) ----------

export async function loadMemory(baseDir) {
  try { return (await fs.readFile(path.join(path.resolve(baseDir), MEMORY_FILE), 'utf-8')).trim(); } catch { return ''; }
}

// ---------- Sessão: evita reler o mesmo trecho sem mudanças ----------

const sessions = new Map(); // raiz -> { n, reads: Map, changed: Set }
export function resetToolSession(baseDir) {
  sessions.set(path.resolve(baseDir), { n: 0, reads: new Map(), changed: new Set(), written: new Set() });
}
const sessionOf = (root) => {
  if (!sessions.has(root)) sessions.set(root, { n: 0, reads: new Map(), changed: new Set(), written: new Set() });
  return sessions.get(root);
};

/** Arquivos que o agente criou/alterou desde a última chamada (para a validação automática). */
export function takeChanged(baseDir) {
  const sess = sessionOf(path.resolve(baseDir));
  const list = [...sess.changed];
  sess.changed.clear();
  return list;
}
function markChanged(root, rel) { const s = sessionOf(root); s.changed.add(rel); s.written.add(rel); }
/** Todos os arquivos gravados com sucesso neste pedido (confirmado pelo runtime, não pelo que o modelo disse). */
export function getWritten(baseDir) { return [...sessionOf(path.resolve(baseDir)).written]; }
const REREAD_WINDOW = 4; // só avisa "sem alterações" se a leitura anterior é recente (ainda está visível no contexto)

export const toolDefinitions = [
  {
    type: 'function',
    function: {
      name: 'project_tree',
      description: 'Árvore resumida do projeto (ou de uma subpasta).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Subpasta (padrão: raiz)' },
          depth: { type: 'number', description: 'Profundidade máxima (padrão 3)' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'project_map',
      description: 'Mapa do código: arquivos com funções/classes e linhas. Use ANTES de abrir arquivos.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Subpasta (padrão: raiz)' },
          query: { type: 'string', description: 'Filtra por nome de arquivo ou símbolo' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: 'Busca texto/regex nos arquivos (grep). Retorna arquivo:linha: conteúdo.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Texto ou regex' },
          path: { type: 'string', description: 'Subpasta (padrão: raiz)' }
        },
        required: ['pattern']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'git_clone',
      description: 'Clona um repositório público do GitHub.',
      parameters: {
        type: 'object',
        properties: {
          repoUrl: { type: 'string', description: 'URL https do GitHub' },
          targetFolder: { type: 'string', description: 'Pasta de destino' }
        },
        required: ['repoUrl', 'targetFolder']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_file_chunk',
      description: 'Lê um arquivo por faixa de linhas.',
      parameters: {
        type: 'object',
        properties: {
          filepath: { type: 'string', description: 'Caminho relativo' },
          startLine: { type: 'number', description: 'Linha inicial (1)' },
          endLine: { type: 'number', description: 'Linha final' }
        },
        required: ['filepath']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_many',
      description: 'Lê vários arquivos de uma vez (até 8). Mais barato que várias leituras.',
      parameters: {
        type: 'object',
        properties: {
          files: {
            type: 'array',
            description: 'Lista de arquivos',
            items: {
              type: 'object',
              properties: {
                filepath: { type: 'string', description: 'Caminho relativo' },
                startLine: { type: 'number', description: 'Linha inicial' },
                endLine: { type: 'number', description: 'Linha final' }
              },
              required: ['filepath']
            }
          }
        },
        required: ['files']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_document',
      description: 'Lê PDF, Word (docx), Excel (xlsx), PowerPoint (pptx), OpenDocument, EPUB, notebook (ipynb), RTF, zip/jar/apk/tar/gz (lista e abre itens). Texto em páginas: use offset para continuar.',
      parameters: {
        type: 'object',
        properties: {
          filepath: { type: 'string', description: 'Caminho relativo do arquivo' },
          offset: { type: 'number', description: 'Posição (caractere) para continuar a leitura' },
          pages: { type: 'string', description: 'PDF: páginas, ex. "1-5" ou "3"' },
          sheet: { type: 'string', description: 'Excel/ODS: nome ou número da planilha' },
          member: { type: 'string', description: 'zip/jar/apk/tar: caminho de um item interno para ler' }
        },
        required: ['filepath']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'view_image',
      description: 'Enxerga uma imagem (png, jpg, webp, gif) do projeto: print, diagrama, textura, interface. Só funciona se houver modelo com visão.',
      parameters: {
        type: 'object',
        properties: { filepath: { type: 'string', description: 'Caminho relativo da imagem' } },
        required: ['filepath']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'binary_info',
      description: 'Engenharia reversa: identifica um arquivo binário (exe/dll/elf/apk/jar/class/wasm...), hashes, entropia, seções, imports/exports.',
      parameters: { type: 'object', properties: { filepath: { type: 'string', description: 'Caminho relativo' } }, required: ['filepath'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'strings',
      description: 'Extrai textos legíveis (ASCII e UTF-16) de um binário, com offsets. Use pattern para filtrar (ex.: http|key|erro).',
      parameters: {
        type: 'object',
        properties: {
          filepath: { type: 'string', description: 'Caminho relativo' },
          pattern: { type: 'string', description: 'Regex para filtrar' },
          min: { type: 'number', description: 'Tamanho mínimo (padrão 6)' },
          offset: { type: 'number', description: 'Byte inicial para continuar' }
        },
        required: ['filepath']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'hexdump',
      description: 'Mostra bytes de um arquivo em hexadecimal + ASCII (até 1024 por chamada).',
      parameters: {
        type: 'object',
        properties: {
          filepath: { type: 'string', description: 'Caminho relativo' },
          offset: { type: 'number', description: 'Byte inicial' },
          length: { type: 'number', description: 'Quantidade de bytes (16-1024)' }
        },
        required: ['filepath']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 're_tool',
      description: 'Roda programa externo de engenharia reversa, se instalado (objdump, readelf, nm, r2, javap, jadx, ilspycmd, dumpbin). tool="status" lista os disponíveis.',
      parameters: {
        type: 'object',
        properties: {
          tool: { type: 'string', description: 'status | objdump | readelf | nm | r2 | javap | jadx | ilspycmd | dumpbin' },
          action: { type: 'string', description: 'headers, sections, symbols, imports, exports, functions, disasm, decompile...' },
          filepath: { type: 'string', description: 'Caminho relativo do binário' },
          symbol: { type: 'string', description: 'r2 disasm: função ou endereço 0x...' },
          start: { type: 'string', description: 'objdump disasm: endereço inicial 0x...' },
          stop: { type: 'string', description: 'objdump disasm: endereço final 0x...' },
          offset: { type: 'number', description: 'Linha para continuar a saída' }
        },
        required: ['tool']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Cria ou sobrescreve um arquivo.',
      parameters: {
        type: 'object',
        properties: {
          filepath: { type: 'string', description: 'Caminho relativo' },
          content: { type: 'string', description: 'Conteúdo' }
        },
        required: ['filepath', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Troca um trecho exato (old_str, único no arquivo) por new_str.',
      parameters: {
        type: 'object',
        properties: {
          filepath: { type: 'string', description: 'Caminho relativo' },
          old_str: { type: 'string', description: 'Trecho exato' },
          new_str: { type: 'string', description: 'Novo texto' }
        },
        required: ['filepath', 'old_str', 'new_str']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Executa um comando de terminal na pasta do projeto.',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string', description: 'Comando shell' } },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'git',
      description: 'Consulta o git do projeto (somente leitura): status, diff ou log.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['status', 'diff', 'log'], description: 'Operação' },
          path: { type: 'string', description: 'Limita o diff a um arquivo/pasta' }
        },
        required: ['action']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'fetch_url',
      description: 'Baixa uma página pública (documentação, README...) e devolve o texto.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'URL http(s) pública' } },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'parallel_research',
      description: 'Delega de 2 a 4 perguntas de análise (somente leitura) a subagentes que rodam ao mesmo tempo. Devolve um resumo de cada.',
      parameters: {
        type: 'object',
        properties: {
          tasks: { type: 'array', description: 'Perguntas independentes, ex.: "Como funciona o módulo X? Cite arquivos e linhas."', items: { type: 'string' } }
        },
        required: ['tasks']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'save_memory',
      description: 'Salva a memória do projeto (resumo curto: o que é, o que foi feito, o que falta). Substitui a anterior.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: 'Resumo, até ~1500 caracteres' } },
        required: ['text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'use_skill',
      description: 'Carrega as instruções de uma skill pelo id.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Id da skill' } },
        required: ['id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_skills',
      description: 'Busca nas skills instaladas por palavras-chave (ex.: "pdf", "deploy", "teste"). Devolve ids e descrições curtas; depois use use_skill.',
      parameters: { type: 'object', properties: { query: { type: 'string', description: 'Palavras-chave da tarefa' } }, required: ['query'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_skill_file',
      description: 'Lê um arquivo que acompanha uma skill.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Id da skill' },
          path: { type: 'string', description: 'Caminho na pasta da skill' }
        },
        required: ['id', 'path']
      }
    }
  }
];

/** Versão enxuta das ferramentas (sem descrições de parâmetros) para modelos com limite de tokens pequeno. */
export function compactTools(defs = toolDefinitions) {
  const strip = (o) => {
    if (Array.isArray(o)) return o.map(strip);
    if (o && typeof o === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(o)) {
        if (k === 'description' && typeof v === 'string') continue; // só dentro de propriedades
        out[k] = strip(v);
      }
      return out;
    }
    return o;
  };
  return defs.map(t => ({
    type: 'function',
    function: { name: t.function.name, description: String(t.function.description || '').slice(0, 45), parameters: strip(t.function.parameters) }
  }));
}

// Lê um trecho de um arquivo. Devolve o texto (já com cabeçalho) ou um aviso de "sem alterações".
async function readChunk(root, filepath, startLine, endLine, { maxLines = 200, maxChars = MAX_OUTPUT, header = true, skipCache = false } = {}) {
  const target = resolveSafePath(root, filepath);
  const st = await fs.stat(target);
  if (!st.isFile()) throw new Error('Não é um arquivo.');
  const ext = extOf(target);
  if (DOC_EXTS.has(ext)) return await readDocument(target, filepath, { maxChars });
  if (IMAGE_EXTS.has(ext) && ext !== 'svg') {
    return `${filepath}: imagem (${(st.size / 1024).toFixed(0)} KB). Use view_image para enxergá-la (precisa de modelo com visão).`;
  }
  if (isBinaryName(target)) return `${filepath}: arquivo binário (${(st.size / 1024).toFixed(0)} KB). Use binary_info, strings ou hexdump.`;

  const sess = sessionOf(root);
  const start = Math.max((Number(startLine) || 1) - 1, 0);
  const requestedEnd = Number(endLine) || start + maxLines;
  const key = `${path.relative(root, target)}|${start}|${requestedEnd}`;
  const prev = sess.reads.get(key);
  if (!skipCache && prev && prev.mtime === st.mtimeMs && sess.n - prev.n <= REREAD_WINDOW) {
    return `[${filepath} linhas ${start + 1}-${requestedEnd}: sem alterações desde a leitura de poucos passos atrás; o conteúdo já está acima na conversa.]`;
  }

  const text = await fs.readFile(target, 'utf-8');
  if (text.includes('\0')) return `${filepath}: conteúdo binário. Use binary_info, strings ou hexdump.`;
  const lines = text.split('\n');
  if (start >= lines.length) return `${filepath}: o arquivo tem apenas ${lines.length} linhas.`;
  const end = Math.min(requestedEnd, lines.length);
  if (!skipCache) sess.reads.set(key, { n: sess.n, mtime: st.mtimeMs });
  const body = lines.slice(start, end).join('\n');
  const head = `--- ${filepath}: linhas ${start + 1} a ${end} de ${lines.length} ---\n`;
  const cut = body.length > maxChars;
  return (header ? head : '') + (cut ? body.slice(0, maxChars) + `\n...[truncado: continue em startLine=${start + body.slice(0, maxChars).split('\n').length}]` : body);
}

// ---------- permissões: aprovação do usuário para ações arriscadas ----------
const allowedByUser = new Map(); // raiz do projeto -> Set de chaves "permitir sempre nesta sessão"

/**
 * Pede aprovação (se necessário). Devolve '' se pode seguir ou o texto de recusa para o modelo.
 * kind: 'comando' | 'escrita'. critical: nunca vira "permitir sempre".
 */
async function askUser(root, opts, { kind, summary, detail, reason, critical, key }) {
  const set = allowedByUser.get(root) || new Set();
  allowedByUser.set(root, set);
  if (key && !critical && set.has(key)) return '';
  if (typeof opts.approve !== 'function') {
    return `Ação NÃO executada: precisa da aprovação do usuário (${reason}), mas não há como pedir agora. Não tente contornar; use outra abordagem, ou avise o usuário de que ele pode habilitar o modo "automático" em Segurança.`;
  }
  let ans;
  try { ans = await opts.approve({ kind, summary, detail, reason, critical: !!critical }); } catch { ans = false; }
  if (!ans) return `Ação RECUSADA pelo usuário (${reason}). Não repita a mesma ação nem tente contornar: escolha outra abordagem ou pergunte o que ele prefere.`;
  if (ans === 'always' && key && !critical) set.add(key);
  return '';
}

async function runTool(name, args, baseDir, opts = {}) {
  const root = path.resolve(baseDir);

  if (name === 'project_tree') {
    const ignore = await loadIgnore(root);
    const startDir = resolveSafePath(root, args.path);
    const maxDepth = Math.min(Math.max(Number(args.depth) || 3, 1), 6);
    const lines = [];
    const PER_DIR = 40;
    const walk = async (dir, prefix, depth) => {
      if (depth >= maxDepth || lines.length > 400) return;
      const entries = (await fs.readdir(dir, { withFileTypes: true }))
        .filter(e => !shouldSkip(e.name, path.relative(root, path.join(dir, e.name)), ignore))
        .sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
      const shown = entries.slice(0, PER_DIR);
      for (let i = 0; i < shown.length; i++) {
        const e = shown[i];
        const isLast = i === shown.length - 1 && entries.length <= PER_DIR;
        lines.push(`${prefix}${isLast ? '└── ' : '├── '}${e.name}${e.isDirectory() ? '/' : ''}`);
        if (e.isDirectory()) await walk(path.join(dir, e.name), prefix + (isLast ? '    ' : '│   '), depth + 1);
      }
      if (entries.length > PER_DIR) lines.push(`${prefix}└── … (+${entries.length - PER_DIR} itens)`);
    };
    await walk(startDir, '', 0);
    return lines.join('\n') || '(pasta vazia)';
  }

  if (name === 'project_map') {
    const sub = args.path ? resolveSafePath(root, args.path) : undefined;
    return await buildProjectMap(root, { sub, query: args.query });
  }

  if (name === 'search_files') {
    const ignore = await loadIgnore(root);
    let re;
    try { re = new RegExp(args.pattern, 'i'); }
    catch { re = new RegExp(String(args.pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
    const results = [];
    const scan = async (p) => {
      if (results.length >= 60) return;
      const st = await fs.stat(p);
      if (st.isDirectory()) {
        for (const e of await fs.readdir(p)) {
          if (!shouldSkip(e, path.relative(root, path.join(p, e)), ignore) && !isBinaryName(e)) await scan(path.join(p, e));
        }
      } else if (st.size < 1_000_000) {
        let txt;
        try { txt = await fs.readFile(p, 'utf-8'); } catch { return; }
        if (txt.includes('\0')) return;
        txt.split('\n').forEach((line, i) => {
          if (results.length < 60 && re.test(line)) {
            results.push(`${path.relative(root, p)}:${i + 1}: ${line.trim().slice(0, 200)}`);
          }
        });
      }
    };
    await scan(resolveSafePath(root, args.path));
    return results.join('\n') || 'Nenhuma ocorrência.';
  }

  if (name === 'git_clone') {
    // execFile (sem shell) + validação de URL: evita injeção de comandos via repoUrl.
    if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+?(\.git)?\/?$/.test(args.repoUrl || '')) {
      throw new Error('URL inválida. Use https://github.com/usuario/repositorio');
    }
    const dest = resolveSafePath(root, args.targetFolder);
    const { stdout, stderr } = await execFileAsync('git', ['clone', '--depth', '1', args.repoUrl, dest], { timeout: 120000 });
    return `Repositório clonado em: ${dest}\n${stdout}${stderr}`;
  }

  if (name === 'git') {
    const action = String(args.action || '');
    const gitArgs = action === 'status' ? ['status', '--short', '--branch']
      : action === 'diff' ? ['diff', '--no-color', '--unified=2']
      : action === 'log' ? ['log', '--oneline', '-n', '15']
      : null;
    if (!gitArgs) throw new Error('action deve ser status, diff ou log.');
    if (action === 'diff' && args.path) gitArgs.push('--', path.relative(root, resolveSafePath(root, args.path)) || '.');
    try {
      const { stdout } = await execFileAsync('git', gitArgs, { cwd: root, timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
      return stdout.trim() || '(sem saída: nada a mostrar)';
    } catch (err) {
      if (err.code === 'ENOENT') return 'O git não está instalado (ou não está no PATH) neste computador.';
      const msg = String(err.stderr || err.message);
      if (/not a git repository/i.test(msg)) return 'Esta pasta não é um repositório git.';
      return `Erro do git: ${msg.slice(0, 500)}`;
    }
  }

  if (name === 'read_file_chunk') {
    return await readChunk(root, args.filepath, args.startLine, args.endLine, { skipCache: !!opts.skipCache });
  }

  if (name === 'read_many') {
    const files = (Array.isArray(args.files) ? args.files : []).slice(0, 8);
    if (!files.length) throw new Error('Informe a lista "files" com ao menos um arquivo.');
    const per = Math.max(1200, Math.floor((MAX_OUTPUT - 200) / files.length));
    const parts = [];
    for (const f of files) {
      const fp = typeof f === 'string' ? f : f?.filepath;
      try {
        parts.push(await readChunk(root, fp, f?.startLine, f?.endLine, { maxLines: 120, maxChars: per, skipCache: !!opts.skipCache }));
      } catch (err) {
        parts.push(`--- ${fp}: erro: ${err.message} ---`);
      }
    }
    return parts.join('\n\n');
  }

  if (name === 'fetch_url') return await fetchUrl(args.url);

  if (name === 'read_document') {
    const target = resolveSafePath(root, args.filepath);
    return await readDocument(target, args.filepath, { offset: args.offset, pages: args.pages, sheet: args.sheet, member: args.member });
  }

  if (name === 'view_image') {
    return 'view_image só funciona dentro do agente (precisa de um modelo com visão configurado).';
  }

  if (name === 'binary_info') return await binaryInfo(resolveSafePath(root, args.filepath), args.filepath);
  if (name === 'strings') return await stringsFile(resolveSafePath(root, args.filepath), args.filepath, { min: args.min, offset: args.offset, pattern: args.pattern });
  if (name === 'hexdump') return await hexdumpFile(resolveSafePath(root, args.filepath), args.filepath, { offset: args.offset, length: args.length });

  if (name === 're_tool') {
    if (!args.tool || args.tool === 'status') return await reTool(root, '', '', { tool: 'status' });
    if (!args.filepath) throw new Error('Informe filepath (o binário a analisar).');
    return await reTool(root, resolveSafePath(root, args.filepath), args.filepath, args);
  }

  if (name === 'save_memory') {
    const text = String(args.text || '').trim();
    if (!text) throw new Error('O texto da memória está vazio.');
    const target = path.join(root, MEMORY_FILE);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, text.slice(0, MEMORY_MAX), 'utf-8');
    return `Memória do projeto salva (${Math.min(text.length, MEMORY_MAX)} caracteres) em ${MEMORY_FILE}.`;
  }

  if (name === 'write_file') {
    const target = resolveSafePath(root, args.filepath);
    const rel0 = path.relative(root, target);
    const blocked = writeBlockReason(rel0);
    if (blocked) throw new Error(blocked);
    // Sobrescrever um arquivo grande por um bem menor costuma ser resposta cortada do modelo: confirma antes.
    const mode = opts.permissionMode || getPermissionMode();
    let oldSize = 0;
    try { oldSize = (await fs.stat(target)).size; } catch {}
    const newSize = Buffer.byteLength(args.content ?? '', 'utf-8');
    if (mode !== 'automatico' && oldSize >= 2000 && newSize < oldSize * 0.3) {
      const refusal = await askUser(root, opts, {
        kind: 'escrita', summary: `Sobrescrever ${args.filepath}: ${oldSize} → ${newSize} bytes`,
        detail: `O arquivo perderia ${Math.round((1 - newSize / oldSize) * 100)}% do conteúdo. Pode ser resposta cortada do modelo (dá para desfazer em ↩ Desfazer).`,
        reason: 'reduz muito um arquivo existente', critical: true
      });
      if (refusal) return refusal;
    }
    await journalBefore(root, target);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, args.content ?? '', 'utf-8');
    markChanged(root, path.relative(root, target).split(path.sep).join('/'));
    return `Arquivo salvo: ${args.filepath} (${(args.content || '').length} caracteres)`;
  }

  if (name === 'edit_file') {
    const target = resolveSafePath(root, args.filepath);
    const blocked = writeBlockReason(path.relative(root, target));
    if (blocked) throw new Error(blocked);
    const content = await fs.readFile(target, 'utf-8');
    const count = args.old_str ? content.split(args.old_str).length - 1 : 0;
    if (count === 0) return 'Erro: old_str não encontrado. Releia o arquivo e copie o trecho exato.';
    if (count > 1) return `Erro: old_str aparece ${count} vezes. Inclua mais contexto para torná-lo único.`;
    await journalBefore(root, target);
    await fs.writeFile(target, content.replace(args.old_str, () => args.new_str), 'utf-8');
    markChanged(root, path.relative(root, target).split(path.sep).join('/'));
    return `Arquivo editado: ${args.filepath}`;
  }

  if (name === 'use_skill') return await useSkill(root, args.id);

  if (name === 'search_skills') return searchSkillsText(await listVisibleSkills(root), args.query);

  if (name === 'read_skill_file') return await readSkillFile(root, args.id, args.path);

  if (name === 'run_command') {
    const cmd = String(args.command || '');
    const mode = opts.permissionMode || getPermissionMode();
    const d = decideCommand(cmd, mode);
    if (d.action === 'deny') return `Comando BLOQUEADO por segurança (${d.reason}). Isto não é liberado nem com aprovação. Não tente contornar; use as ferramentas próprias (read_file_chunk, edit_file...) ou escolha outra abordagem.`;
    if (d.action === 'ask') {
      const refusal = await askUser(root, opts, { kind: 'comando', summary: cmd.slice(0, 600), detail: `Pasta: ${root}`, reason: d.reason, critical: d.critical, key: approvalKey(cmd) });
      if (refusal) return refusal;
    }
    try {
      const { stdout, stderr } = await execAsync(cmd, { cwd: root, timeout: 120000, maxBuffer: 2 * 1024 * 1024, env: cleanEnv(), windowsHide: true });
      return redactSecrets(`STDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
    } catch (err) {
      // Inclui a saída no erro: é ela que o modelo precisa para corrigir o código.
      return redactSecrets(`Falhou (código ${err.code ?? '?'}${err.killed ? ', timeout' : ''})\nSTDOUT:\n${err.stdout || ''}\nSTDERR:\n${err.stderr || err.message}`);
    }
  }

  return `Ferramenta desconhecida: ${name}`;
}

/** Usado pelo engine para view_image: devolve { dataUrl, description } ou lança erro. */
export async function loadImageForTool(baseDir, filepath) {
  const root = path.resolve(baseDir);
  const target = resolveSafePath(root, filepath);
  return await loadImage(target, filepath);
}

export async function executeTool(name, args, baseDir, opts = {}) {
  const sess = sessionOf(path.resolve(baseDir));
  sess.n++;
  try {
    const def = toolDefinitions.find(t => t.function.name === name);
    let clean = args || {};
    if (def) {
      const v = validateArgs(def.function.parameters, clean);
      if (!v.ok) return `Erro na ferramenta ${name}: argumentos inválidos (${v.error}). Corrija e chame de novo.`;
      clean = v.args;
    }
    const out = await runTool(name, clean, baseDir, opts);
    return (name === 'run_command' || name === 'git') ? truncateMiddle(out) : truncateEnd(out);
  } catch (err) {
    return `Erro na ferramenta ${name}: ${err.message}`;
  }
}
