// Testes automáticos da compatibilidade adaptativa das IAs locais. Rodar:  node tests/compat.test.mjs
// Usa SÓ servidores simulados (mocks) numa cópia temporária do projeto: não toca nas suas configurações, chaves nem APIs reais.
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import assert from 'assert/strict';
import { fileURLToPath, pathToFileURL } from 'url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gcode-compat-'));
const CLOUD_PORT = 47600, LOCAL_PORT = 47601;
for (const f of fs.readdirSync(SRC)) if (/\.(js|json)$/.test(f) && f !== 'package-lock.json') fs.copyFileSync(path.join(SRC, f), path.join(TMP, f));
if (fs.existsSync(path.join(SRC, 'node_modules'))) fs.symlinkSync(path.join(SRC, 'node_modules'), path.join(TMP, 'node_modules'), 'junction');
let cfg = fs.readFileSync(path.join(TMP, 'config.js'), 'utf-8');
cfg = cfg.replace('https://api.groq.com/openai/v1/chat/completions', `http://127.0.0.1:${CLOUD_PORT}/v1/chat/completions`);
fs.writeFileSync(path.join(TMP, 'config.js'), cfg);
fs.writeFileSync(path.join(TMP, '.keys.json'), JSON.stringify({ groq: { apiKey: 'K1', keys: ['K1'], models: ['m1'] } }));
const imp = (f) => import(pathToFileURL(path.join(TMP, f)).href);
const sup = await imp('supervisor.js');
const compat = await imp('compat.js');
const cfgm = await imp('config.js');
const eng = await imp('engine.js');

let pass = 0, fail = 0;
const failures = [];
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ✔ ${name}`); } catch (e) { fail++; failures.push(name); console.log(`  ✘ ${name}\n      ${String(e.message).split('\n').slice(0, 3).join('\n      ')}`); }
}

// ---------- plano de referência ----------
const STEPS = [
  { title: 'Criar estrutura HTML', tipo: 'codar', goal: 'Criar index.html com o formulário de contato e os campos nome e email.' },
  { title: 'Ler requisitos existentes', tipo: 'explorar', goal: 'Ler os arquivos existentes do projeto para entender o que já foi feito.' },
  { title: 'Validar campos', tipo: 'codar', goal: 'Adicionar validação dos campos no navegador com JavaScript simples.' },
  { title: 'Revisar resultado', tipo: 'revisar', goal: 'Conferir se o formulário valida os campos e se o resultado ficou correto.' }
];
const asType = (steps) => steps.map(({ tipo, ...r }) => ({ ...r, type: tipo }));
const J = (x) => JSON.stringify(x);
const V = (input, o) => sup.validateSupervisorPlan(input, o);

console.log('\n== Validação de planos (itens 1-13) ==');
await t('1. JSON direto no formato esperado', () => { const v = V(J({ steps: STEPS }), { requireMix: true }); assert.ok(v.ok, v.why); assert.equal(v.plan.length, 4); });
await t('2. JSON dentro de Markdown', () => assert.ok(V('Aqui está:\n```json\n' + J({ steps: STEPS }) + '\n```\nPronto.', { requireMix: true }).ok));
await t('3. Lista direta é normalizada com segurança', () => { const v = V('```json\n' + J(STEPS) + '\n```', { requireMix: true }); assert.ok(v.ok, v.why); assert.ok(v.normalized.includes('lista direta')); });
await t('3b. Lista direta com a ÚLTIMA etapa cortada é recusada (não vira plano pela metade)', () => assert.equal(V(J(STEPS).slice(0, -30), { requireMix: true }).ok, false));
await t('4. Campo "type" no lugar de "tipo" é normalizado explicitamente', () => { const v = V(J({ steps: asType(STEPS) }), { requireMix: true }); assert.ok(v.ok, v.why); assert.ok(v.normalized.some(n => /type/.test(n))); });
await t('4b. "tipo" e "type" conflitantes são recusados; campo arbitrário não é aceito como tipo', () => {
  assert.equal(V(J({ steps: STEPS.map(s => ({ ...s, type: 'revisar' })) })).ok, false);
  assert.equal(V(J({ steps: STEPS.map(({ tipo, ...r }) => ({ ...r, kind: tipo })) })).ok, false);
});
await t('5. Tipo ausente NÃO vira "codar": é recusado', () => { const v = V(J({ steps: STEPS.map(({ tipo, ...r }) => r) })); assert.equal(v.ok, false); assert.match(v.why, /sem "tipo"/); });
await t('6. Tipo desconhecido é recusado', () => { const v = V(J({ steps: STEPS.map(s => ({ ...s, tipo: 'build' })) })); assert.equal(v.ok, false); assert.match(v.why, /desconhecido/); });
await t('7. Todas as etapas "explorar" são recusadas', () => assert.equal(V(J({ steps: STEPS.map(s => ({ ...s, tipo: 'explorar' })) }), { requireMix: true }).ok, false));
await t('8. Todas "codar": recusadas no teste (requireMix); permitidas em uso real (tarefa simples)', () => {
  const all = J({ steps: STEPS.map(s => ({ ...s, tipo: 'codar' })) });
  assert.equal(V(all, { requireMix: true }).ok, false);
  assert.ok(V(all).ok);
});
await t('9. Etapas incompletas (sem título/objetivo curto) são recusadas', () => {
  assert.equal(V(J({ steps: [STEPS[0], { title: 'x', tipo: 'codar', goal: 'curto' }] })).ok, false);
  assert.equal(V(J({ steps: [STEPS[0], { tipo: 'codar', goal: STEPS[2].goal }] })).ok, false);
  assert.equal(V(J({ steps: [STEPS[0], null] })).ok, false);
  assert.equal(V(J({ steps: [STEPS[0]] })).ok, false); // 1 etapa só
});
await t('10. Etapas duplicadas são recusadas', () => assert.equal(V(J({ steps: [STEPS[0], STEPS[2], { ...STEPS[2], title: 'Outro nome' }] })).ok, false));
await t('11. JSON truncado é recusado', () => { for (const cut of [40, 200, 400]) assert.equal(V(J({ steps: STEPS }).slice(0, cut), { requireMix: true }).ok, false, `cut ${cut}`); });
await t('12. Resposta vazia é recusada', () => { assert.equal(V('').ok, false); assert.equal(V('   ').ok, false); assert.equal(compat.judgeReply({ content: '' }).ok, false); });
await t('13. finish_reason: length é falha (mesmo com conteúdo); sem finish_reason não atrapalha', () => {
  assert.equal(compat.judgeReply({ content: J({ steps: STEPS }), finish_reason: 'length' }).kind, 'truncada');
  assert.ok(compat.judgeReply({ content: 'ok' }).ok);
  assert.ok(compat.judgeReply({ content: 'ok', finish_reason: 'stop' }).ok);
});

// ---------- testPlan com provedores simulados (itens 14-17) ----------
console.log('\n== Parâmetros opcionais adaptativos (itens 14-17, sem rede) ==');
const planCall = (script) => { const calls = []; const fn = async (msgs, o) => { calls.push(o); return script(o, calls.length); }; fn.calls = calls; return fn; };
const bad = { content: '', finish_reason: 'length' };
const good = { content: J({ steps: STEPS }), finish_reason: 'stop' };
await t('14. Provedor que ACEITA reasoning_effort e só funciona com ele: marcado "supported" e usado', async () => {
  const call = planCall((o) => o.extra?.reasoning_effort === 'none' ? good : bad);
  const r = await compat.testPlan({ call, params: {} });
  assert.ok(r.ok); assert.equal(r.params.reasoning_effort, 'supported'); assert.deepEqual(r.extra, { reasoning_effort: 'none' });
});
await t('14b. Se o plano já funciona sem parâmetros, nenhum parâmetro é enviado', async () => {
  const call = planCall(() => good);
  const r = await compat.testPlan({ call, params: {} });
  assert.ok(r.ok); assert.equal(call.calls.length, 1); assert.equal(r.extra, null); assert.deepEqual(r.params, {});
});
await t('15. Provedor que REJEITA reasoning_effort (HTTP 400): marcado "rejected" e o teste segue com o próximo', async () => {
  const call = planCall((o) => { if (o.extra?.reasoning_effort) { const e = new Error('HTTP 400: Unrecognized request argument supplied: reasoning_effort'); e.status = 400; throw e; } return o.extra?.response_format ? good : bad; });
  const r = await compat.testPlan({ call, params: {} });
  assert.equal(r.params.reasoning_effort, 'rejected'); assert.equal(r.params.response_format, 'supported'); assert.ok(r.ok);
});
await t('16. Provedor sem response_format e sem melhora: plano reprovado com justificativa clara', async () => {
  const call = planCall((o) => { if (o.extra?.response_format) { const e = new Error('HTTP 400: response_format is not supported'); e.status = 400; throw e; } return bad; });
  const r = await compat.testPlan({ call, params: {} });
  assert.equal(r.ok, false); assert.equal(r.params.response_format, 'rejected'); assert.match(r.why, /plano inválido/);
});
await t('16b. Parâmetro aceito mas SEM melhorar o resultado fica "accepted" (nunca "supported")', async () => {
  const call = planCall(() => bad);
  const r = await compat.testPlan({ call, params: {} });
  assert.equal(r.ok, false); assert.equal(r.params.reasoning_effort, 'accepted'); assert.equal(r.params.response_format, 'accepted');
});
await t('16c. Parâmetro já conhecido como recusado não é testado de novo', async () => {
  const call = planCall(() => bad);
  await compat.testPlan({ call, params: { reasoning_effort: 'rejected' } });
  assert.ok(!call.calls.some(o => o.extra?.reasoning_effort));
});
await t('16d. Erro 400 sem relação com o parâmetro é "unknown" (inconclusivo), não "rejected"', () => {
  const e = new Error('HTTP 400: context length exceeded'); e.status = 400;
  assert.equal(compat.classifyParamError(e, 'reasoning_effort'), 'unknown');
  const t2 = new Error('timeout'); t2.status = 0; assert.equal(compat.classifyParamError(t2, 'reasoning_effort'), 'unknown');
});
await t('17. Sem finish_reason: plano bom passa; JSON cortado continua sendo recusado', async () => {
  const noFin = (c) => planCall(() => ({ content: c }));
  assert.ok((await compat.testPlan({ call: noFin(J({ steps: STEPS })), params: {} })).ok);
  assert.equal((await compat.testPlan({ call: noFin(J({ steps: STEPS }).slice(0, 300)), params: {} })).ok, false);
});
await t('17b. Resposta cortada: UMA nova tentativa com mais tokens de saída (limitada)', async () => {
  const call = planCall((o) => (o.max || 0) >= 2400 && !o.extra ? good : bad);
  const r = await compat.testPlan({ call, params: {} });
  assert.ok(r.ok); assert.match(r.note, /mais tokens/); assert.equal(call.calls[0].max, 900); assert.equal(call.calls[1].max, 2400);
});
await t('17c. Número de tentativas é limitado (sem ciclo infinito)', async () => {
  const call = planCall(() => bad);
  await compat.testPlan({ call, params: {} });
  assert.ok(call.calls.length <= 4, `chamadas: ${call.calls.length}`);
});

// ---------- servidor simulado compatível com OpenAI / Ollama ----------
const MODELS = ['good', 'fence', 'list', 'alias', 'missing', 'unknown', 'allexp', 'allcode', 'trunc', 'needeffort', 'rejecteffort', 'notools', 'nofinish', 'sse', 'badcode', 'badreview', 'rdonly', 'sup-m', 'code-m'];
const PLAN_BY = {
  good: () => ({ content: J({ steps: STEPS }) }),
  fence: () => ({ content: '```json\n' + J({ steps: STEPS }) + '\n```' }),
  list: () => ({ content: '```json\n' + J(STEPS) + '\n```' }),
  alias: () => ({ content: J({ steps: asType(STEPS) }) }),
  missing: () => ({ content: J({ steps: STEPS.map(({ tipo, ...r }) => r) }) }),
  unknown: () => ({ content: J({ steps: STEPS.map(s => ({ ...s, tipo: 'build' })) }) }),
  allexp: () => ({ content: J({ steps: STEPS.map(s => ({ ...s, tipo: 'explorar' })) }) }),
  allcode: () => ({ content: J({ steps: STEPS.map(s => ({ ...s, tipo: 'codar' })) }) }),
  trunc: () => ({ content: J({ steps: STEPS }).slice(0, 220), finish: 'length' }),
  nofinish: () => ({ content: J({ steps: STEPS }), nofinish: true })
};
const seen = []; // registro do que o mock recebeu
let n = 0;
const mockLocal = http.createServer((req, res) => { let b = ''; req.on('data', d => b += d); req.on('end', () => {
  const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(J(obj)); };
  if (req.url === '/v1/models') return send(200, { data: MODELS.map(id => ({ id })) });
  if (req.url === '/api/ps') return send(200, { models: [{ name: 'good', size: 4e9, size_vram: 4e9 }] });
  if (req.url === '/api/generate') return send(200, {});
  const j = b ? JSON.parse(b) : {};
  const model = j.model, sys = String(j.messages?.[0]?.content || ''), tools = (j.tools || []).map(t => t.function.name);
  seen.push({ model, tools, effort: j.reasoning_effort, rf: j.response_format, max: j.max_tokens, stream: j.stream });
  if (model === 'rejecteffort' && j.reasoning_effort) return send(400, { error: { message: 'Unrecognized request argument supplied: reasoning_effort' } });
  if (model === 'rejecteffort' && j.response_format) return send(400, { error: { message: 'response_format is not supported by this server' } });
  const reply = (r) => {
    const msg = { role: 'assistant', content: r.content ?? '' };
    if (r.tool_calls) msg.tool_calls = r.tool_calls;
    const ch = { message: msg }; if (!r.nofinish && model !== 'nofinish') ch.finish_reason = r.finish || (r.tool_calls ? 'tool_calls' : 'stop');
    if (model === 'sse' && j.stream) { // streaming SSE com finish_reason
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${J({ choices: [{ delta: { content: r.content ?? '' } }] })}\n\n`);
      res.write(`data: ${J({ choices: [{ delta: {}, finish_reason: r.finish || 'stop' }], usage: { completion_tokens: 12 } })}\n\n`);
      return res.end('data: [DONE]\n\n');
    }
    send(200, { choices: [ch], usage: { completion_tokens: 20 } });
  };
  const tool = (name, args) => reply({ tool_calls: [{ id: 'c' + (++n), type: 'function', function: { name, arguments: J(args) } }] });
  const last = j.messages[j.messages.length - 1];
  // --- ferramentas
  if (tools.length === 1 && tools.includes('ping')) return model === 'notools' ? reply({ content: 'chamei ping' }) : tool('ping', {});
  if (tools.length === 1 && tools.includes('read_file')) {
    if (model === 'notools') return reply({ content: 'VERSAO é 7731' });
    if (last.role === 'tool') return reply({ content: 'A VERSAO é 7731.' });
    return tool('read_file', { path: model === 'rdonly' ? 'outro.txt' : 'config.txt' });
  }
  if (tools.length === 1 && tools.includes('write_file')) {
    if (model === 'notools') return reply({ content: 'aqui está o código' });
    const code = model === 'badcode' ? 'module.exports = { pares: (l) => l.filter(n => n % 2 === 1) };' : 'function pares(lista) { return lista.filter(n => n % 2 === 0); }\nmodule.exports = { pares };';
    return tool('write_file', { path: 'pares.js', content: code });
  }
  // --- revisão
  if (/revisor de código/.test(sys)) {
    const code = String(last.content);
    if (model === 'badreview') return reply({ content: '{"ok":true}' }); // aprova até o código com bug
    return reply({ content: /=== 1/.test(code) ? '{"ok":false,"problema":"filtra ímpares em vez de pares"}' : '{"ok":true}' });
  }
  // --- plano
  if (/Supervisor de um time/.test(sys)) {
    if (/site de uma página|Pedido:\n(?!Refatore)/.test(String(last.content)) || true) {
      if (model === 'needeffort' && j.reasoning_effort !== 'none') return reply({ content: '', finish: 'length' });
      if (model === 'needeffort') return reply({ content: J({ steps: STEPS }) });
      if (model === 'rejecteffort') return reply({ content: '', finish: 'length' });
      if (model === 'sup-m' || model === 'code-m') return reply({ content: J({ steps: [{ title: 'Criar base', tipo: 'codar', goal: 'Criar o arquivo base.js com uma função soma exportada em ESM.' }, { title: 'Criar uso', tipo: 'codar', goal: 'Criar o arquivo uso.js que importa soma de base.js e imprime o resultado.' }, { title: 'Conferir', tipo: 'revisar', goal: 'Conferir se base.js e uso.js ficaram coerentes entre si e funcionam.' }] }) });
      return reply((PLAN_BY[model] || PLAN_BY.good)());
    }
  }
  // --- JSON simples e demais
  if (/17\+25/.test(String(last.content))) return reply({ content: '{"soma":42,"ok":true}' });
  if (/Conte de 1 a 40/.test(String(last.content))) return reply({ content: Array.from({ length: 40 }, (_, i) => i + 1).join(', ') });
  if (j.tools) { // agente codando (usado nos testes de integração)
    const results = j.messages.filter(m => m.role === 'tool').length;
    return results === 0 ? tool('write_file', { path: 'local.txt', content: 'x' }) : reply({ content: 'Etapa pronta (local).' });
  }
  reply({ content: 'ok' });
}); });
await new Promise(r => mockLocal.listen(LOCAL_PORT, r));
cfgm.saveSettings({ locals: [], supervisor: undefined, localMode: 'backup', permissionMode: 'automatico' });
cfgm.saveLocal({ kind: 'ollama', name: 'Mock', url: `http://127.0.0.1:${LOCAL_PORT}`, models: MODELS.join(','), ctx: 16384, autostart: false });

const compatOf = async (model) => { const r = await eng.compatLocal('local1', model); assert.ok(r.success, r.error); return r.result; };

console.log('\n== Teste de compatibilidade completo com o servidor simulado ==');
let good1;
await t('Modelo bom: aprovado em todos os papéis, cada um por teste próprio; resultado versionado', async () => {
  good1 = await compatOf('good');
  assert.equal(good1.version, cfgm.COMPAT_VERSION);
  assert.deepEqual(good1.roles.sort(), ['codar', 'explorar', 'planejar', 'revisar']);
  for (const r of ['planejar', 'explorar', 'codar', 'revisar']) assert.ok(good1.roleTests[r].ok, r);
  assert.equal(good1.caps.tools, true); assert.equal(good1.caps.json, true);
});
await t('Velocidade: usa tokens reais quando a API informa (usage) e marca como estimada quando não', async () => {
  assert.ok(good1.tpsReal > 0 && good1.tpsEst > 0);
  const nf = await compatOf('notools'); // o mock sempre envia usage; aqui conferimos que os dois campos têm nomes distintos
  assert.ok('tpsEst' in nf && !('tps' in nf));
});
await t('VRAM: reportada como porcentagem do modelo carregado (não como "uso da GPU")', async () => {
  assert.ok(good1.vram === null || (typeof good1.vram.pct === 'number' && ['total', 'parcial', 'cpu'].includes(good1.vram.state)));
  assert.ok(!('gpu' in good1));
});
await t('Markdown (fence) e lista direta são aceitos', async () => { assert.ok((await compatOf('fence')).roleTests.planejar.ok); assert.ok((await compatOf('list')).roleTests.planejar.ok); });
await t('"type" no lugar de "tipo": aceito com normalização registrada', async () => { const r = await compatOf('alias'); assert.ok(r.roleTests.planejar.ok); assert.ok(r.roleTests.planejar.normalized.some(x => /type/.test(x))); });
await t('Tipo ausente / desconhecido / tudo "explorar" / tudo "codar": NÃO aprova "planejar"', async () => {
  for (const m of ['missing', 'unknown', 'allexp', 'allcode']) { const r = await compatOf(m); assert.equal(r.roleTests.planejar.ok, false, m); assert.ok(r.roleTests.planejar.why, m); assert.ok(!r.roles.includes('planejar'), m); }
});
await t('Resposta truncada em todas as tentativas: reprovado com motivo claro', async () => { const r = await compatOf('trunc'); assert.equal(r.roleTests.planejar.ok, false); });
await t('14. Modelo que só funciona com reasoning_effort: aprovado, parâmetro registrado como "supported" para ESTE modelo', async () => {
  const r = await compatOf('needeffort');
  assert.ok(r.roleTests.planejar.ok); assert.equal(r.params.reasoning_effort, 'supported'); assert.deepEqual(r.extra, { reasoning_effort: 'none' });
  const p = cfgm.getLocalProviders()[0];
  const fp = eng.capFp(p, 'needeffort');
  assert.ok(fp.includes(`127.0.0.1:${LOCAL_PORT}`) && fp.endsWith('|needeffort') && fp.startsWith('ollama|'));
});
await t('15/16. Servidor que recusa reasoning_effort e response_format: recusa registrada, plano reprovado, nada quebra', async () => {
  const r = await compatOf('rejecteffort');
  assert.equal(r.params.reasoning_effort, 'rejected'); assert.equal(r.params.response_format, 'rejected'); assert.equal(r.roleTests.planejar.ok, false);
});
await t('A capacidade aprendida NÃO vaza para outro modelo nem para outro endereço', async () => {
  const p = cfgm.getLocalProviders()[0];
  assert.notEqual(eng.capFp(p, 'needeffort'), eng.capFp(p, 'good'));
  assert.notEqual(eng.capFp(p, 'needeffort'), eng.capFp({ ...p, baseUrl: 'http://127.0.0.1:9999' }, 'needeffort'));
  assert.notEqual(eng.capFp(p, 'needeffort'), eng.capFp({ ...p, kind: 'lmstudio' }, 'needeffort'));
  // modelo "good" nunca recebeu parâmetros opcionais
  const before = seen.length; await compatOf('good');
  assert.ok(!seen.slice(before).filter(s => s.model === 'good').some(s => s.effort || s.rf));
});
await t('18. Sem suporte a ferramentas: explorar/codar NÃO aprovados; planejar/revisar podem ser aprovados por testes próprios', async () => {
  const r = await compatOf('notools');
  assert.equal(r.caps.tools, false);
  assert.equal(r.roleTests.explorar.ok, false); assert.equal(r.roleTests.codar.ok, false);
  assert.ok(r.roleTests.planejar.ok && r.roleTests.revisar.ok);
});
await t('Ferramenta funcionando NÃO prova qualidade: código errado reprova "codar"; leitura errada reprova "explorar"', async () => {
  const bc = await compatOf('badcode'); assert.equal(bc.caps.tools, true); assert.equal(bc.roleTests.codar.ok, false); assert.match(bc.roleTests.codar.why, /errado/);
  const rd = await compatOf('rdonly'); assert.equal(rd.roleTests.explorar.ok, false);
});
await t('JSON válido NÃO prova capacidade de revisar: revisor que aprova tudo reprova "revisar"', async () => {
  const r = await compatOf('badreview'); assert.equal(r.caps.json, true); assert.equal(r.roleTests.revisar.ok, false);
});
await t('17. Servidor sem finish_reason: continua funcionando', async () => { const r = await compatOf('nofinish'); assert.ok(r.roleTests.planejar.ok); });

console.log('\n== fetchChat: finish_reason, parâmetros opcionais, streaming ==');
const prov = () => cfgm.getLocalProviders()[0];
await t('finish_reason e usage preservados (sem streaming)', async () => {
  const m = await eng.fetchChat(prov(), 'good', [{ role: 'system', content: 'Supervisor de um time' }, { role: 'user', content: 'x' }], false, { maxTokens: 50 });
  assert.equal(m.finish_reason, 'stop'); assert.equal(m.usage.completion_tokens, 20);
});
await t('finish_reason: length preservado', async () => {
  const m = await eng.fetchChat(prov(), 'trunc', [{ role: 'system', content: 'Supervisor de um time' }, { role: 'user', content: 'x' }], false, {});
  assert.equal(m.finish_reason, 'length');
});
await t('finish_reason e usage preservados no streaming (SSE)', async () => {
  const m = await eng.fetchChat(prov(), 'sse', [{ role: 'user', content: 'oi' }], false, {});
  assert.equal(m.streamed, true); assert.equal(m.finish_reason, 'stop'); assert.equal(m.usage.completion_tokens, 12);
});
await t('Sem finish_reason no servidor: o campo fica ausente (nunca inventado)', async () => {
  const m = await eng.fetchChat(prov(), 'nofinish', [{ role: 'user', content: 'oi' }], false, {});
  assert.equal(m.finish_reason, undefined);
});
await t('Parâmetros opcionais NUNCA vão por padrão', async () => {
  const before = seen.length;
  await eng.fetchChat(prov(), 'good', [{ role: 'user', content: 'oi' }], false, {});
  const s = seen[before]; assert.equal(s.effort, undefined); assert.equal(s.rf, undefined);
});
await t('Parâmetro recusado: repete UMA vez sem ele e avisa quem chamou', async () => {
  const before = seen.length; let rejected = null;
  const m = await eng.fetchChat(prov(), 'rejecteffort', [{ role: 'user', content: 'oi' }], false, { extra: { reasoning_effort: 'none' }, onParamRejected: (names) => { rejected = names; } });
  assert.equal(m.content, 'ok'); assert.deepEqual(rejected, ['reasoning_effort']);
  assert.equal(seen.slice(before).length, 2); assert.equal(seen[before + 1].effort, undefined);
});
await t('strictExtra desliga a repetição (o teste precisa enxergar a recusa)', async () => {
  await assert.rejects(() => eng.fetchChat(prov(), 'rejecteffort', [{ role: 'user', content: 'oi' }], false, { extra: { reasoning_effort: 'none' }, strictExtra: true }), /reasoning_effort/);
});

console.log('\n== Persistência: versão antiga não aprova nada, cadastro preservado ==');
await t('Resultado de versão antiga (sem version) não aprova papéis, mas o cadastro continua', () => {
  const key = 'local1::good';
  const s0 = cfgm.getSupervisor();
  cfgm.saveSettings({ supervisor: { ...s0, approved: { ...s0.approved, [key]: { at: 1, roles: ['planejar', 'codar'], json: true, tools: true } }, roles: { [key]: ['codar'] } } });
  const s = cfgm.getSupervisor();
  assert.deepEqual(cfgm.approvedRoles(s, key), []);
  assert.throws(() => cfgm.saveSupervisor({ model: key, enabled: true }), /não foi aprovado|Rode o teste/);
  assert.equal(cfgm.getLocals().length, 1); assert.ok(cfgm.getLocals()[0].models.includes('good'));
  assert.equal(sup.hasRole(cfgm.getSupervisor(), 'local1', 'good', 'codar'), false);
});
await t('Modelo detectado, testado e aprovado são estados distintos', async () => {
  const known = cfgm.getLocals()[0].models;
  assert.ok(known.includes('allexp')); // detectado
  const s = cfgm.getSupervisor();
  assert.ok(s.approved['local1::allexp']); // testado
  assert.deepEqual(cfgm.approvedRoles(s, 'local1::allexp').filter(r => r === 'planejar'), []); // mas não aprovado para planejar
});

// ---------- integração (itens 19-21) ----------
console.log('\n== Integração (itens 19-21) ==');
const cloud = http.createServer((req, res) => { let b = ''; req.on('data', d => b += d); req.on('end', () => {
  const j = JSON.parse(b || '{}'); const sys = String(j.messages?.[0]?.content || ''); const results = (j.messages || []).filter(m => m.role === 'tool').length;
  res.writeHead(200, { 'content-type': 'application/json' });
  const text = (c) => res.end(J({ choices: [{ message: { role: 'assistant', content: c }, finish_reason: 'stop' }] }));
  if (/arquiteto/.test(sys)) return text(J({ steps: [{ title: 'Cloud A', goal: 'Criar o arquivo cloud_a.txt com o texto A dentro dele.' }, { title: 'Cloud B', goal: 'Criar o arquivo cloud_b.txt com o texto B dentro dele.' }] }));
  if (j.tools) return results === 0 ? res.end(J({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'k' + Math.random(), type: 'function', function: { name: 'write_file', arguments: J({ filepath: 'nuvem.txt', content: 'x' }) } }] } }] })) : text('Pronto (nuvem).');
  text('ok');
}); });
await new Promise(r => cloud.listen(CLOUD_PORT, r));
const proj = path.join(TMP, 'proj'); const run = async (prompt, logs = []) => { fs.rmSync(proj, { recursive: true, force: true }); fs.mkdirSync(proj, { recursive: true }); return eng.runAgentWithFallback([{ role: 'user', content: prompt }], proj, [], l => logs.push(l)); };
await t('19. Sem IA local e sem Supervisor: funciona só com a nuvem', async () => {
  cfgm.saveSettings({ locals: [], supervisor: undefined, localMode: 'backup', permissionMode: 'automatico' });
  const logs = []; const r = await run('crie um arquivo nuvem.txt', logs);
  assert.match(r.reply, /Pronto \(nuvem\)/); assert.match(r.provider, /Groq/); assert.ok(!logs.some(l => /Supervisor/.test(l)));
});
await t('20. IA local cadastrada com Supervisor DESLIGADO: nuvem continua sendo a base; local não vira Supervisor', async () => {
  cfgm.saveLocal({ kind: 'ollama', name: 'Mock', url: `http://127.0.0.1:${LOCAL_PORT}`, models: 'sup-m,code-m', ctx: 16384, autostart: false });
  const before = seen.length; const logs = [];
  const r = await run('Refatore todo o projeto e migre toda a arquitetura para módulos ESM, criando vários arquivos novos e testes', logs);
  assert.match(r.provider, /Groq/); assert.ok(!logs.some(l => /Supervisor|Plano/.test(l)), logs.filter(l => /Supervisor|Plano/.test(l)).join('|'));
  assert.equal(seen.slice(before).filter(s => /sup-m|code-m/.test(s.model)).length, 0);
});
await t('21. Supervisor LIGADO (modelos testados e aprovados): plano do Supervisor e etapas nos modelos dos papéis', async () => {
  const L = cfgm.getLocals(); const id = L[L.length - 1].id;
  for (const m of ['sup-m', 'code-m']) { const r = await eng.compatLocal(id, m); assert.ok(r.success, r.error); }
  cfgm.saveSupervisor({ model: `${id}::sup-m`, roles: { [`${id}::sup-m`]: ['planejar', 'revisar'], [`${id}::code-m`]: ['codar'] } });
  cfgm.saveSupervisor({ enabled: true });
  const before = seen.length; const logs = [];
  const r = await run('Refatore todo o projeto e migre toda a arquitetura para módulos ESM, criando vários arquivos novos e testes', logs);
  assert.match(r.reply, /Plano concluído/, r.reply.slice(0, 200));
  assert.ok(logs.some(l => /Plano do Supervisor/.test(l)));
  const used = seen.slice(before).map(s => s.model);
  assert.ok(used.includes('sup-m') && used.includes('code-m'), used.join(','));
});
await t('21b. Supervisor ligado, mas o modelo perde a aprovação (teste antigo): volta ao comportamento normal', async () => {
  const s = cfgm.getSupervisor(); const k = s.model;
  cfgm.saveSettings({ supervisor: { ...s, approved: { ...s.approved, [k]: { ...s.approved[k], version: 1 } } } });
  assert.equal(cfgm.activeSupervisor(), null);
  const logs = []; const r = await run('Refatore todo o projeto e migre toda a arquitetura para módulos ESM, criando vários arquivos novos e testes', logs);
  assert.match(r.provider, /Groq/); assert.ok(!logs.some(l => /Supervisor:/.test(l)));
});

mockLocal.close(); cloud.close();
console.log(`\n${pass} passaram, ${fail} falharam.${fail ? '\nFalhas: ' + failures.join(' | ') : ''}`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
