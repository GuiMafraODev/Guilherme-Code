#!/usr/bin/env node
import readline from 'readline/promises';
import { runAgentWithFallback, runPlanned, compatLocal } from './engine.js';
import { listModels } from './models.js';
import { getActiveProviders, getAllProviders, saveProviderConfig, getLocals, saveLocal, removeLocal, getLocalMode, saveLocalMode, LOCAL_MODES, getSupervisor, saveSupervisor, LOCAL_ROLES, COMPAT_VERSION } from './config.js';
import { listSkills, listCommands, installFromGithub, expandSlash } from './skills.js';
import { undoLast, listUndo } from './undo.js';

const baseDir = process.cwd();
const messages = [];
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

console.log('\x1b[36m%s\x1b[0m', '==================================================');
console.log('\x1b[36m%s\x1b[0m', '       GUILHERME CODE (CLI + Fallback Free)       ');
console.log('\x1b[36m%s\x1b[0m', '==================================================');
console.log(`Diretório ativo: ${baseDir}`);
console.log('Comandos: /modelos | /chave <provedor> <chave> | /skills | /instalar <url-github> | /desfazer | /novo | /plano <pedido> | /local | /supervisor | sair');
console.log('Também vale /nome-da-skill ou /nome-do-comando instalado.\n');

async function addKey(providerId, key) {
  const p = getAllProviders().find(x => x.id === providerId);
  if (!p) return console.log(`Provedor desconhecido. Opções: ${getAllProviders().map(x => x.id).join(', ')}`);
  try {
    const models = await listModels(providerId, key);
    const pick = models.find(m => m.id === p.defaultModel) || models[0];
    saveProviderConfig(providerId, p.explicit ? { apiKey: key } : { apiKey: key, models: pick ? [pick.id] : [p.defaultModel] }); // /chave de novo ADICIONA outra chave
    console.log(`✅ Chave válida. ${models.length} modelos encontrados; habilitado: ${pick?.id || p.defaultModel}`);
    console.log(`   Chaves salvas para ${providerId}: ${getAllProviders().find(x => x.id === providerId).keys.length}. Use /chave de novo para adicionar mais.`);
  } catch (err) {
    console.log(`\x1b[31m❌ ${err.message}\x1b[0m`);
  }
}

function showModels() {
  const active = getActiveProviders();
  if (!active.length) return console.log('Nenhuma chave configurada.');
  for (const p of active) console.log(`  ${p.id} (chave ${p.slot}/${p.keyCount}): ${p.models.join(', ')}`);
}

async function main() {
  if (getActiveProviders().length === 0) {
    console.log('\x1b[33m[Aviso] Nenhuma chave de API encontrada.\x1b[0m');
    const id = (await rl.question(`Provedor (${getAllProviders().map(p => p.id).join('/')}): `)).trim();
    const key = (await rl.question('Chave: ')).trim();
    if (id && key) await addKey(id, key);
  }

  while (true) {
    const text = (await rl.question('\x1b[32mGuilherme > \x1b[0m')).trim();
    if (!text) continue;
    if (text.toLowerCase() === 'sair') break;
    if (text === '/modelos') { showModels(); continue; }
    if (text.startsWith('/chave ')) {
      const [, id, key] = text.split(/\s+/);
      if (id && key) await addKey(id, key); else console.log('Uso: /chave <provedor> <chave>');
      continue;
    }

    if (text === '/local' || text.startsWith('/local ')) {
      const [, sub, a, b, c, d] = text.split(/\s+/);
      try {
        if (!sub) {
          const l = getLocals();
          console.log(l.length ? l.map(x => `🏠 ${x.id}: ${x.name} • ${x.url} • ${x.models.join(', ')} • ctx ${x.ctx || '?'}${x.enabled === false ? ' (desativada)' : ''}`).join('\n') : 'Nenhuma IA local cadastrada.');
          console.log(`Modo: ${getLocalMode()}  |  /local add <ollama|lmstudio|outro> <endereço|-> <modelo> [contexto]  |  /local rm <id>  |  /local modo <${LOCAL_MODES.join('|')}>`);
        } else if (sub === 'add' && a && c) {
          const def = { ollama: 'http://localhost:11434', lmstudio: 'http://localhost:1234' }[a] || '';
          saveLocal({ kind: a, url: b === '-' ? def : b, models: c, ctx: Number(d) || 8192, autostart: a !== 'outro' });
          console.log('IA local adicionada.');
        } else if (sub === 'rm' && a) { removeLocal(a); console.log('Removida.'); }
        else if (sub === 'modo' && a) { saveLocalMode(a); console.log(`Modo: ${a}`); }
        else console.log('Uso: /local | /local add <ollama|lmstudio|outro> <endereço|-> <modelo> [contexto] | /local rm <id> | /local modo <backup|economia|primeiro>');
      } catch (e) { console.log('Erro:', e.message); }
      continue;
    }
    if (text === '/supervisor' || text.startsWith('/supervisor ')) {
      const [, sub, a, b] = text.split(/\s+/);
      try {
        const s = getSupervisor();
        if (!sub) {
          console.log(`Supervisor: ${s.enabled ? 'LIGADO' : 'desligado'}  modelo: ${s.model || '(nenhum)'}  limites: ${JSON.stringify(s.limits)}`);
          for (const l of getLocals()) for (const m of l.models) {
            const k = `${l.id}::${m}`, ap = s.approved[k];
            const state = !ap ? 'não testado' : ap.version !== COMPAT_VERSION ? 'teste ANTIGO (nenhum papel aprovado; rode /supervisor testar)' : `aprovado: ${ap.roles.join('/') || 'nenhum papel'} | velocidade ${ap.tpsReal ? ap.tpsReal + ' tok/s (medido)' : ap.tpsEst ? '~' + ap.tpsEst + ' tok/s (estimado)' : '?'} | VRAM ${ap.vram ? ap.vram.pct + '% do modelo' : '?'}${Object.entries(ap.roleTests || {}).filter(([, t]) => !t.ok).map(([r, t]) => `\n      ✘ ${r}: ${t.why}`).join('')}`;
            console.log(`  ${k}  ${state}  papéis escolhidos: ${(s.roles[k] || []).join(',') || '-'}`);
          }
          console.log(`Uso: /supervisor testar <id> [modelo] | modelo <id::modelo> | papel <id::modelo> <${LOCAL_ROLES.join(',')}> | ligar | desligar`);
        } else if (sub === 'testar' && a) {
          console.log('Testando (pode demorar na primeira vez)...');
          const r = await compatLocal(a, b);
          console.log(r.success ? `Aprovado para: ${r.result.roles.join(', ') || 'nenhum papel'}\n${Object.entries(r.result.roleTests).map(([k, t]) => `  ${t.ok ? '✔' : '✘'} ${k}${t.ok ? '' : ': ' + t.why}`).join('\n')}` : `Falhou: ${r.error}`);
        } else if (sub === 'modelo' && a) { saveSupervisor({ model: a }); console.log('Supervisor definido.'); }
        else if (sub === 'papel' && a && b) { saveSupervisor({ roles: { ...s.roles, [a]: b.split(',') } }); console.log('Papéis salvos.'); }
        else if (sub === 'ligar') { saveSupervisor({ enabled: true }); console.log('Supervisor ligado.'); }
        else if (sub === 'desligar') { saveSupervisor({ enabled: false }); console.log('Supervisor desligado.'); }
        else console.log('Comando desconhecido. Digite /supervisor.');
      } catch (e) { console.log('Erro:', e.message); }
      continue;
    }
    if (text === '/novo') { messages.length = 0; console.log('Nova conversa iniciada (a memória do projeto continua).'); continue; }
    if (text === '/desfazer') {
      const list = await listUndo(baseDir);
      if (!list.length) { console.log('Nada para desfazer.'); continue; }
      console.log(`Vai desfazer o último pedido (${list[0].files.length} arquivo(s): ${list[0].files.join(', ')}).`);
      if ((await rl.question('Confirmar? (s/n) ')).trim().toLowerCase() !== 's') continue;
      console.log((await undoLast(baseDir)).message);
      continue;
    }

    if (text === '/skills') {
      const [sk, cm] = [await listSkills(baseDir), await listCommands(baseDir)];
      sk.forEach(x => console.log(`  skill   /${x.id} (${x.scope}${x.source === 'claude-code' ? ', Claude Code' : ''}) - ${x.description.slice(0, 80)}`));
      cm.forEach(x => console.log(`  comando /${x.name} (${x.scope}) - ${x.description.slice(0, 80)}`));
      if (!sk.length && !cm.length) console.log('Nada instalado. Use: /instalar https://github.com/usuario/repo');
      continue;
    }
    if (text.startsWith('/instalar ')) {
      try {
        const r = await installFromGithub(text.split(/\s+/)[1], { scope: 'global' });
        console.log(`✅ Skills: ${r.skills.join(', ') || '-'} | Comandos: ${r.commands.join(', ') || '-'}`);
      } catch (err) { console.log(`\x1b[31m❌ ${err.message}\x1b[0m`); }
      continue;
    }

    // /plano <pedido>: modo etapas (projetos grandes). "/plano continue" retoma o plano salvo.
    let planned = false;
    let input = text;
    if (/^\/plano\s+/i.test(text)) { planned = true; input = text.replace(/^\/plano\s+/i, ''); }
    const expanded = planned ? null : await expandSlash(text, baseDir);
    messages.push({ role: 'user', content: expanded ?? input });
    try {
      // Assinatura correta: (mensagens, pasta, provedoresSelecionados, onLog)
      const result = await (planned ? runPlanned : runAgentWithFallback)(planned ? messages.slice(-1) : messages, baseDir, [], (log) => {
        console.log('\x1b[90m%s\x1b[0m', `  ${log}`);
      }, {
        // aprovação no terminal para ações arriscadas (apagar, instalar pacotes, rede...)
        approve: async (info) => {
          console.log(`\n\x1b[33m${info.critical ? '⚠️ AÇÃO CRÍTICA' : '🛡️ Aprovação necessária'}: ${info.reason}\x1b[0m\n  ${info.summary}${info.detail ? '\n  ' + info.detail : ''}`);
          const a = (await rl.question(info.critical ? 'Permitir? (s = sim / n = não) ' : 'Permitir? (s = sim / t = sim, e não perguntar de novo este tipo / n = não) ')).trim().toLowerCase();
          return a === 't' && !info.critical ? 'always' : a === 's' || a === 'sim' ? 'once' : false;
        }
      });
      messages.push({ role: 'assistant', content: result.reply });
      console.log(`\n\x1b[35m[${result.provider}]\x1b[0m${result.ctxPct >= 80 ? ` \x1b[33m(contexto ${result.ctxPct}%: considere /novo)\x1b[0m` : ''}\n${result.reply}\n`);
    } catch (err) {
      messages.pop();
      console.error('\x1b[31mErro:\x1b[0m', err.message, '\n');
    }
  }
  rl.close();
}

main();
