import fs from 'fs/promises';
import path from 'path';

// Pastas que nunca vale a pena listar/buscar (somam muitos tokens e nada de útil).
export const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.gcode',
  '.venv', 'venv', '.cache', 'coverage', '.idea', '.vscode'
]);

// Arquivos que o agente nunca pode ler/escrever.
export const PROTECTED = new Set(['.keys.json', '.env']);

// Extensões binárias / de assets: listar o NOME ajuda, ler o conteúdo só gasta tempo.
const BIN_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'tga', 'psd', 'dds', 'tif', 'tiff',
  'glb', 'fbx', 'blend', '3ds', 'mp3', 'wav', 'ogg', 'flac', 'mp4', 'mkv', 'avi', 'mov', 'webm',
  'zip', '7z', 'rar', 'tar', 'gz', 'bz2', 'xz', 'jar', 'exe', 'dll', 'so', 'dylib', 'bin', 'o', 'a', 'lib', 'pdb',
  'pdf', 'ttf', 'otf', 'woff', 'woff2', 'eot', 'dat', 'spr', 'otb', 'otbm', 'pic', 'db', 'sqlite', 'class', 'pyc', 'wasm'
]);

export const isBinaryName = (name) => BIN_EXT.has(path.extname(String(name)).slice(1).toLowerCase());

/**
 * Lê o arquivo .gcodeignore da raiz do projeto (opcional). Uma regra por linha:
 *   assets            -> qualquer arquivo/pasta com esse nome
 *   public/models     -> essa pasta (e tudo dentro)
 *   *.map             -> todos os arquivos com essa extensão
 *   # comentário
 * Retorna uma função (caminhoRelativo) => true se deve ser ignorado.
 */
export async function loadIgnore(root) {
  let rules = [];
  try {
    rules = (await fs.readFile(path.join(root, '.gcodeignore'), 'utf-8'))
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'))
      .map(l => l.replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\/+$/, ''))
      .filter(Boolean);
  } catch {}
  return (rel) => {
    const r = String(rel).replace(/\\/g, '/');
    const base = r.split('/').pop();
    for (const p of rules) {
      if (p.startsWith('*.')) { if (base.toLowerCase().endsWith(p.slice(1).toLowerCase())) return true; }
      else if (!p.includes('/')) { if (base === p) return true; }
      else if (r === p || r.startsWith(p + '/')) return true;
    }
    return false;
  };
}

/** Deve pular esta entrada (pasta ou arquivo)? */
export const shouldSkip = (name, rel, ignoreFn) =>
  IGNORED_DIRS.has(name) || PROTECTED.has(String(name).toLowerCase()) || ignoreFn(rel);
