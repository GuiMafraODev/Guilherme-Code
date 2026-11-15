import fs from 'fs/promises';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { decideCommand, cleanEnv, redactSecrets } from './guard.js';

const execAsync = promisify(exec);

const exists = async (p) => { try { await fs.access(p); return true; } catch { return false; } };
const readJson = async (p) => { try { return JSON.parse(await fs.readFile(p, 'utf-8')); } catch { return null; } };

/**
 * Descobre, pelo tipo do projeto, as verificações que valem a pena rodar depois de uma alteração.
 * Só devolve comandos FIXOS/conhecidos (ou scripts que o próprio package.json declara). Ordem: mais barato primeiro.
 * Devolve [{ id, cmd, kind }]
 */
export async function detectChecks(root) {
  const out = [];
  const pkg = await readJson(path.join(root, 'package.json'));
  if (pkg) {
    const sc = pkg.scripts || {};
    const real = (v) => v && !/no test specified/i.test(v);
    for (const name of ['lint', 'typecheck', 'check', 'test', 'build']) {
      if (real(sc[name])) out.push({ id: `npm:${name}`, cmd: name === 'test' ? 'npm test' : `npm run ${name}`, kind: name });
    }
  }
  const has = async (...f) => { for (const x of f) if (await exists(path.join(root, x))) return true; return false; };
  if (await has('pytest.ini', 'tox.ini', 'conftest.py', 'tests', 'test')) {
    if (await has('pytest.ini', 'conftest.py', 'tests', 'test')) out.push({ id: 'py:pytest', cmd: 'python -m pytest -q -x', kind: 'test' });
  } else if (await has('pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt')) {
    // sem testes conhecidos: ao menos compila tudo
    out.push({ id: 'py:compile', cmd: 'python -m compileall -q .', kind: 'check' });
  }
  if (await has('Cargo.toml')) out.push({ id: 'rust:check', cmd: 'cargo check', kind: 'check' });
  if (await has('go.mod')) out.push({ id: 'go:vet', cmd: 'go vet ./...', kind: 'check' }, { id: 'go:test', cmd: 'go test ./...', kind: 'test' });
  try {
    const files = await fs.readdir(root);
    if (files.some(f => /\.(sln|csproj)$/i.test(f))) out.push({ id: 'dotnet:build', cmd: 'dotnet build --nologo -v q', kind: 'build' });
  } catch {}
  if (await has('pom.xml')) out.push({ id: 'mvn:test', cmd: 'mvn -q -B test', kind: 'test' });
  if (await has('gradlew', 'build.gradle', 'build.gradle.kts')) out.push({ id: 'gradle:build', cmd: (await has('gradlew')) ? (process.platform === 'win32' ? 'gradlew.bat build' : './gradlew build') : 'gradle build', kind: 'build' });
  return out;
}

/** Quais verificações importam para os arquivos alterados (docs/markdown/imagens não disparam testes). */
export function relevantFor(changedFiles) {
  return (changedFiles || []).some(f => !/\.(md|txt|png|jpe?g|gif|svg|ico|pdf|docx?|xlsx?|csv)$/i.test(f));
}

/**
 * Roda as verificações (no máximo `max`, 120 s cada). Passa pela mesma guarda de comandos do run_command:
 * 'deny' nunca roda; 'ask' só roda se houver aprovação do usuário. Devolve [{ cmd, ok, skipped?, tail }].
 */
export async function runChecks(root, checks, { max = 2, mode = 'pedir', approve, onLog = () => {}, timeoutMs = 120000 } = {}) {
  const results = [];
  for (const c of checks.slice(0, max)) {
    const d = decideCommand(c.cmd, mode);
    if (d.action === 'deny') { results.push({ cmd: c.cmd, ok: false, skipped: true, tail: `bloqueado pela segurança (${d.reason})` }); continue; }
    if (d.action === 'ask') {
      let ok = false;
      if (approve) { try { ok = !!(await approve({ kind: 'comando', summary: c.cmd, detail: `Verificação automática em ${root}`, reason: d.reason || 'verificação automática', critical: false, key: 'verify:' + c.id })); } catch {} }
      if (!ok) { results.push({ cmd: c.cmd, ok: false, skipped: true, tail: 'não aprovado pelo usuário' }); continue; }
    }
    onLog(`🧪 Verificando: ${c.cmd}`);
    try {
      const { stdout, stderr } = await execAsync(c.cmd, { cwd: root, timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024, env: cleanEnv(), windowsHide: true });
      results.push({ cmd: c.cmd, ok: true, tail: redactSecrets(String(stdout || stderr || '')).slice(-300) });
    } catch (err) {
      const msg = String(err.stderr || err.message);
      if (err.killed) { results.push({ cmd: c.cmd, ok: false, skipped: true, tail: `passou de ${Math.round(timeoutMs / 1000)}s (não conta como falha)` }); continue; }
      if (err.code === 127 || /command not found|not recognized|não é reconhecido|não foi encontrado|No module named pytest/i.test(msg)) {
        results.push({ cmd: c.cmd, ok: false, skipped: true, tail: 'programa/módulo não instalado neste computador' });
        continue;
      }
      const text = redactSecrets(`${err.stdout || ''}\n${err.stderr || err.message}`).replace(/\r/g, '').trim();
      results.push({ cmd: c.cmd, ok: false, tail: (err.killed ? '(timeout) ' : `(código ${err.code ?? '?'}) `) + text.slice(-1500) });
    }
  }
  return results;
}
