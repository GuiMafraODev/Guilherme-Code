import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/** Roda um verificador e devolve a mensagem de erro (ou '' se passou, ou null se o programa não existe). */
async function run(cmd, args) {
  try {
    await execFileAsync(cmd, args, { timeout: 15000, maxBuffer: 256 * 1024, windowsHide: true });
    return '';
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    return String(err.stderr || err.message).replace(/\r/g, '').trim();
  }
}

/**
 * Checagem de SINTAXE (rápida, sem executar o código do projeto) dos arquivos que o agente alterou.
 * .json -> JSON.parse • .js/.mjs/.cjs -> node --check • .py -> compile() do Python (se houver Python)
 * Devolve uma lista de problemas (vazia = tudo certo).
 */
export async function validateFiles(baseDir, rels) {
  const root = path.resolve(baseDir);
  const problems = [];
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gcode-chk-'));
  try {
    for (const rel of rels.slice(0, 15)) {
      const abs = path.resolve(root, rel);
      const ext = path.extname(rel).toLowerCase();
      let text;
      try { text = await fs.readFile(abs, 'utf-8'); } catch { continue; } // apagado ou ilegível
      if (text.length > 1_500_000) continue;

      if (ext === '.json') {
        try { JSON.parse(text); } catch (e) { problems.push(`${rel}: JSON inválido (${e.message})`); }
      } else if (['.js', '.mjs', '.cjs'].includes(ext)) {
        // .js: decide pelo conteúdo se é módulo (import/export) ou CommonJS. Verifica uma cópia temporária.
        const asModule = ext === '.mjs' || (ext === '.js' && /^\s*(import\s|export\s)/m.test(text));
        const copy = path.join(tmp, asModule ? 'check.mjs' : 'check.cjs');
        await fs.writeFile(copy, text.replace(/^#!.*/, ''), 'utf-8');
        const out = await run(process.execPath, ['--check', copy]);
        if (out) {
          const first = out.split('\n').filter(l => l.trim() && !l.includes('Node.js v')).slice(0, 4).join(' | ');
          problems.push(`${rel}: ${first.split(copy).join(rel).slice(0, 300)}`);
        }
      } else if (ext === '.py') {
        const code = 'import sys\ncompile(open(sys.argv[1], encoding="utf-8").read(), sys.argv[1], "exec")';
        let out = await run('python', ['-c', code, abs]);
        if (out === null) out = await run('python3', ['-c', code, abs]);
        if (out) problems.push(`${rel}: ${out.split('\n').slice(-3).join(' | ').slice(0, 300)}`);
      }
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
  return problems;
}
