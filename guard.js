// Guard: regras de segurança ISOLADAS do resto do programa (sem imports do engine/tools).
// Tudo aqui é função pura ou quase: classificar comandos, validar argumentos, proteger caminhos.
// NÃO é um sandbox: o objetivo é impedir acidentes e abusos comuns, e dar a você o controle das ações destrutivas.

import path from 'path';
import fs from 'fs';

export const PERMISSION_MODES = ['pedir', 'automatico', 'estrito'];
/*
 * pedir       (padrão): ações destrutivas/arriscadas pedem sua aprovação; o resto roda direto.
 * automatico: aprova sozinho o que é arriscado mas reversível; só as "críticas" (apagar pastas, reset --hard...) pedem.
 * estrito:    só comandos conhecidos e seguros (testes, build, leitura) rodam sozinhos; todo o resto pede aprovação.
 * Em qualquer modo, o que é "proibido" (ler chaves, formatar disco, curl|sh...) nunca roda, nem com aprovação.
 */

// ---------- classificação de comandos ----------

const DENY = [
  [/\.keys\.json|\.settings\.json|\.health\.json|\.usage\.json/i, 'acessa arquivos de configuração e chaves do Guilherme Code'],
  [/(^|[\s\\/'"=])\.env(\.[\w-]+)?\b/i, 'acessa arquivo .env (segredos)'],
  [/\b(id_rsa|id_ed25519|\.ssh[\\/]|\.aws[\\/]|\.npmrc|\.netrc|credentials\.json|\.git-credentials)\b/i, 'acessa credenciais do sistema'],
  [/\b(curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^\n]*\|\s*(sh|bash|zsh|iex|powershell|pwsh|cmd|python|node)\b/i, 'baixa e executa código da internet'],
  [/\biex\b\s*\(?\s*(\(|\$|new-object|iwr|irm|invoke-)/i, 'executa código baixado (iex)'],
  [/\bpowershell(\.exe)?\b[^\n]*\s-(e|enc|encodedcommand)\b/i, 'PowerShell com comando codificado'],
  [/\b(shutdown|reboot|halt|poweroff|mkfs[\w.]*|fdisk|diskpart|bcdedit)\b/i, 'comando de sistema (desligar/disco)'],
  [/\bformat\s+[a-z]:/i, 'formatar disco'],
  [/\bdd\s+if=/i, 'escrita direta em disco (dd)'],
  [/\brm\s+(-[a-z]*\s+)*-[a-z]*r[a-z]*[a-z\s-]*\s+(\/|~|\$HOME|\.\.|[a-z]:[\\/]?)(\s|$)/i, 'apagar pasta raiz/pessoal'],
  [/\b(rd|rmdir|del|erase)\b[^\n]*\s[a-z]:[\\/]?(\s|$)/i, 'apagar unidade inteira'],
  [/\bRemove-Item\b[^\n]*-Recurse[^\n]*\s([a-z]:[\\/]?|~|\\|\/)(\s|$)/i, 'apagar pasta raiz/pessoal'],
  [/\bgit\s+push\b[^\n]*(--force|-f\b|--mirror|--delete)/i, 'git push forçado'],
  [/\b(reg|regedit)\b[^\n]*\b(add|delete|import)\b/i, 'alterar o registro do Windows'],
  [/(^|[;&|]\s*)(net\s+user|useradd|userdel|passwd|visudo|schtasks\s+\/create|crontab\s+-)\b/i, 'alterar usuários/tarefas do sistema'],
  [/\bchmod\s+(-R\s+)?[0-7]*777\b[^\n]*\s\//i, 'permissões abertas na raiz'],
  [/:\(\)\s*\{\s*:\|:&\s*\};:/, 'fork bomb']
];

// Pedem sua aprovação (nível "ask"). critical = destrutivo e difícil de desfazer: pede mesmo no modo automático.
const ASK = [
  [/\b(rm|unlink|shred)\b/i, 'apaga arquivos', /\brm\b[^\n]*\s-[a-z]*r|\brm\s+-[a-z]*f/i],
  [/\b(del|erase|rmdir|rd)\b/i, 'apaga arquivos/pastas', /\/s\b|\brmdir\b|\brd\b/i],
  [/\bRemove-Item\b/i, 'apaga arquivos/pastas', /-Recurse/i],
  [/\bgit\s+(reset\s+--hard|clean|checkout\s+--\s|restore\b|stash\s+(drop|clear)|branch\s+-D|rebase|filter-branch|reflog\s+expire)/i, 'git: descarta alterações/histórico', true],
  [/\bgit\s+(push|commit|merge|tag|pull|fetch|remote|config)\b/i, 'git: altera o repositório/rede', false],
  [/\b(npm|pnpm|yarn|bun)\s+(i|install|add|ci|remove|rm|uninstall|update|up|link|publish)\b/i, 'instala/remove pacotes', false],
  [/\bnpx\b/i, 'baixa e roda pacote (npx)', false],
  [/\b(pip3?|pipx|poetry|conda|uv)\s+(install|uninstall|add|remove)\b/i, 'instala/remove pacotes Python', false],
  [/\b(cargo|go|gem|composer|dotnet|nuget|apt(-get)?|brew|choco|winget|scoop)\s+(install|add|remove|uninstall|get)\b/i, 'instala/remove programas', false],
  [/\b(curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod|scp|ssh|ftp|sftp|nc|ncat|telnet)\b/i, 'acessa a rede', false],
  [/\b(sudo|runas|su)\b/i, 'executa como administrador', true],
  [/\b(chmod|chown|chgrp|icacls|takeown|attrib)\b/i, 'muda permissões', false],
  [/\b(taskkill|kill|killall|pkill|Stop-Process)\b/i, 'encerra processos', false],
  [/\b(mv|move|ren|rename|Move-Item|Rename-Item)\b/i, 'move/renomeia arquivos', false],
  [/\bdocker\s+(rm|rmi|system\s+prune|volume\s+rm|kill|stop)\b/i, 'docker: remove contêineres/imagens', true],
  [/\b(truncate|Clear-Content|Set-Content)\b/i, 'sobrescreve arquivos', false],
  [/(^|[^>])>\s*[^\s>&|]/, 'redireciona saída para arquivo (sobrescreve)', false],
  [/\b(python3?|node|bash|sh|pwsh|powershell)\b[^\n]*\s(-c|-e|-Command)\s/i, 'roda código inline (não dá para inspecionar)', false]
];

// Comandos conhecidos e inofensivos (testes, build, leitura): rodam sozinhos até no modo estrito.
const SAFE = /^\s*(?:cd\s+[^;&|]+|ls|dir|pwd|cat|type|head|tail|wc|echo|findstr|grep|rg|find|tree|where|which|node\s+--check|node\s+[\w./\\-]+\.m?c?js|npm\s+(?:test|run\s+(?:test|lint|build|check|typecheck|format:check)[\w:-]*|t\b)|npx\s+--no-install\s+(?:tsc|eslint|prettier\s+--check|jest|vitest)|pytest|python3?\s+-m\s+(?:pytest|unittest|compileall|py_compile|mypy|flake8|ruff)|python3?\s+[\w./\\-]+\.py|ruff|flake8|mypy|tsc|eslint|jest|vitest|cargo\s+(?:test|check|build|clippy|fmt\s+--check)|go\s+(?:test|build|vet)|dotnet\s+(?:test|build)|mvn\s+(?:-q\s+)?(?:test|compile|verify)|gradlew?(?:\.bat)?\s+(?:test|build|check)|make(?:\s+(?:test|check|build))?|git\s+(?:status|diff|log|show|branch|rev-parse|ls-files))\b/i;

/**
 * Classifica um comando de shell.
 * @returns {{ level: 'deny'|'ask'|'allow', reason: string, critical: boolean }}
 */
export function classifyCommand(command) {
  const cmd = String(command || '').trim();
  if (!cmd) return { level: 'deny', reason: 'comando vazio', critical: false };
  if (cmd.length > 4000) return { level: 'deny', reason: 'comando longo demais (use um script)', critical: false };
  for (const [re, why] of DENY) if (re.test(cmd)) return { level: 'deny', reason: why, critical: true };
  const reasons = [];
  let critical = false;
  for (const [re, why, crit] of ASK) {
    if (re.test(cmd)) {
      reasons.push(why);
      if (crit === true || (crit instanceof RegExp && crit.test(cmd))) critical = true;
    }
  }
  // caminhos fora do projeto (absolutos, ~, ..\..) → pergunta
  if (/(^|[\s'"=])(~[\\/]|\$HOME|%USERPROFILE%|[a-z]:[\\/]|\/(etc|usr|var|bin|sbin|root|home|opt|windows)\b)/i.test(cmd) || /(\.\.[\\/]){2,}/.test(cmd)) {
    reasons.push('mexe fora da pasta do projeto');
  }
  if (reasons.length) return { level: 'ask', reason: [...new Set(reasons)].join('; '), critical };
  // comandos encadeados: todos os pedaços precisam ser conhecidos para serem "allow" no modo estrito
  const parts = cmd.split(/\s*(?:&&|\|\||;|\|)\s*/).filter(Boolean);
  const known = parts.every(p => SAFE.test(p));
  return { level: 'allow', reason: known ? '' : 'comando não catalogado', critical: false, known };
}

/**
 * Decide o que fazer com um comando segundo o modo.
 * @returns {{ action: 'run'|'ask'|'deny', reason: string, critical: boolean }}
 */
export function decideCommand(command, mode = 'pedir') {
  const c = classifyCommand(command);
  if (c.level === 'deny') return { action: 'deny', reason: c.reason, critical: true };
  if (c.level === 'ask') {
    if (mode === 'automatico' && !c.critical) return { action: 'run', reason: c.reason, critical: false, auto: true };
    return { action: 'ask', reason: c.reason, critical: c.critical };
  }
  if (mode === 'estrito' && !c.known) return { action: 'ask', reason: 'modo estrito: comando fora da lista segura', critical: false };
  return { action: 'run', reason: '', critical: false };
}

// ---------- ambiente limpo para comandos ----------

const SECRET_ENV = /(key|token|secret|passw(or)?d|credential|auth|cookie|session)/i;
/** Cópia do ambiente SEM variáveis que parecem segredos (comandos do agente não herdam suas chaves). */
export function cleanEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (!SECRET_ENV.test(k)) out[k] = v;
  return out;
}

const SECRET_VALUE = [
  /\bsk-[A-Za-z0-9_-]{20,}/g, /\bgsk_[A-Za-z0-9]{20,}/g, /\bAIza[0-9A-Za-z_-]{30,}/g, /\bnvapi-[A-Za-z0-9_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g, /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, /\bAKIA[0-9A-Z]{16}\b/g, /\bsk-ant-[A-Za-z0-9_-]{20,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g
];
/** Troca chaves de API que apareçam em saídas de comando antes de elas irem para o modelo/log. */
export function redactSecrets(text) {
  let s = String(text ?? '');
  for (const re of SECRET_VALUE) s = s.replace(re, '[CHAVE-OCULTA]');
  return s;
}

// ---------- caminhos ----------

// Escrever aqui mudaria o comportamento do próprio agente (skills/comandos são INSTRUÇÕES: vetor de injeção persistente).
const WRITE_DENY_DIRS = ['.git', '.gcode', '.claude', '.github/workflows'];
const WRITE_DENY_FILES = new Set(['.gcodeignore']);

/** O modelo pode escrever neste caminho (relativo ao projeto)? Devolve '' se sim ou o motivo se não. */
export function writeBlockReason(rel) {
  const norm = String(rel).split(path.sep).join('/').replace(/^\.\//, '');
  const lower = norm.toLowerCase();
  for (const d of WRITE_DENY_DIRS) {
    if (lower === d || lower.startsWith(d + '/')) {
      return `não é permitido escrever em "${d}/" (guarda estado, skills e histórico do agente; peça para você mesmo alterar, se necessário)`;
    }
  }
  if (WRITE_DENY_FILES.has(path.basename(lower))) return 'este arquivo controla as regras do agente; altere você mesmo';
  return '';
}

/**
 * Resolve links simbólicos: o caminho REAL (ou o do pai existente mais próximo) precisa continuar dentro do projeto.
 * Impede que um link dentro do projeto aponte para fora (C:\Users\..., /etc).
 */
export function assertInsideReal(root, target) {
  let realRoot;
  try { realRoot = fs.realpathSync(root); } catch { realRoot = path.resolve(root); }
  let probe = path.resolve(target);
  const tail = [];
  for (let i = 0; i < 64; i++) {
    try {
      const real = fs.realpathSync(probe);
      const full = path.join(real, ...tail.reverse());
      const rel = path.relative(realRoot, full);
      if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Acesso negado: o caminho aponta (via link simbólico) para fora do projeto.');
      return true;
    } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e;
      const parent = path.dirname(probe);
      if (parent === probe) return true;
      tail.push(path.basename(probe));
      probe = parent;
    }
  }
  return true;
}

// ---------- validação de argumentos ----------

/**
 * Valida e normaliza os argumentos de uma ferramenta contra o schema (JSON Schema simplificado).
 * Modelos locais mandam "5" em vez de 5, "true" em vez de true: converte quando seguro; senão devolve erro claro.
 * @returns {{ ok: true, args: object } | { ok: false, error: string }}
 */
export function validateArgs(schema, rawArgs) {
  const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? { ...rawArgs } : null;
  if (!args) return { ok: false, error: 'os argumentos devem ser um objeto JSON.' };
  const props = schema?.properties || {};
  const problems = [];
  for (const req of schema?.required || []) {
    if (args[req] === undefined || args[req] === null) problems.push(`falta "${req}"`);
  }
  for (const [key, def] of Object.entries(props)) {
    let v = args[key];
    if (v === undefined || v === null) { delete args[key]; continue; }
    const t = def.type;
    if (t === 'number' || t === 'integer') {
      if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) v = Number(v);
      if (typeof v !== 'number' || !Number.isFinite(v)) { problems.push(`"${key}" deve ser número`); continue; }
      if (t === 'integer') v = Math.trunc(v);
    } else if (t === 'boolean') {
      if (v === 'true') v = true; else if (v === 'false') v = false;
      if (typeof v !== 'boolean') { problems.push(`"${key}" deve ser true/false`); continue; }
    } else if (t === 'string') {
      if (typeof v === 'number' || typeof v === 'boolean') v = String(v);
      if (typeof v !== 'string') { problems.push(`"${key}" deve ser texto`); continue; }
      if (v.includes('\0')) { problems.push(`"${key}" contém caractere inválido`); continue; }
      if (v.length > 2_000_000) { problems.push(`"${key}" é grande demais`); continue; }
    } else if (t === 'array') {
      if (typeof v === 'string') { try { v = JSON.parse(v); } catch {} }
      if (!Array.isArray(v)) { problems.push(`"${key}" deve ser uma lista`); continue; }
      if (v.length > 500) { problems.push(`"${key}" tem itens demais`); continue; }
    } else if (t === 'object') {
      if (typeof v === 'string') { try { v = JSON.parse(v); } catch {} }
      if (typeof v !== 'object' || Array.isArray(v)) { problems.push(`"${key}" deve ser um objeto`); continue; }
    }
    if (def.enum && !def.enum.includes(v)) { problems.push(`"${key}" deve ser um de: ${def.enum.join(', ')}`); continue; }
    args[key] = v;
  }
  if (problems.length) return { ok: false, error: problems.join('; ') };
  return { ok: true, args };
}

// ---------- memória de aprovações da sessão ----------

/** Chave estável de um comando para "permitir sempre nesta sessão" (primeiras palavras, sem argumentos soltos). */
export function approvalKey(command) {
  return String(command || '').trim().split(/\s+/).slice(0, 2).join(' ').toLowerCase();
}
