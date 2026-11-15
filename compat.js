import vm from 'vm';
import { parseArgs } from './jsonrepair.js';
import { validateSupervisorPlan, PLAN_SYS_SUP } from './supervisor.js';

// Teste de compatibilidade das IAs locais (lógica pura: quem faz a chamada de rede é o engine, via `call`).
// Princípio: separar CAPACIDADES de protocolo (responde, ferramentas, JSON, parâmetros opcionais, streaming) dos PAPÉIS.
// Um papel só é aprovado por um teste ESPECÍFICO daquele papel. Sem prova, fica NÃO aprovado (nunca presumido).
//
// call(messages, { tools, max, extra }) -> msg { content, tool_calls, finish_reason, usage, streamed } | lança erro (err.status)

export const PLAN_PROBE = 'Pedido: criar um site de uma página com formulário de contato, validar os campos no navegador e conferir se o resultado ficou correto.';

/** Julga uma resposta: vazia e cortada (finish_reason: length) são FALHA, nunca sucesso. Sem finish_reason = não dá para saber (ok). */
export function judgeReply(msg, { needContent = true } = {}) {
  if (!msg) return { ok: false, kind: 'vazia', why: 'sem resposta' };
  const hasTools = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
  const text = String(msg.content ?? '').trim();
  if (msg.finish_reason === 'length') return { ok: false, kind: 'truncada', why: 'resposta cortada (finish_reason: length)' };
  if (needContent && !text && !hasTools) return { ok: false, kind: 'vazia', why: 'resposta vazia' };
  return { ok: true, text, hasTools };
}

/** O erro indica que o servidor recusou o parâmetro opcional? 'rejected' | 'unknown' (inconclusivo). */
export function classifyParamError(err, name) {
  const st = Number(err?.status);
  const msg = String(err?.message || '');
  if (![400, 404, 422].includes(st)) return 'unknown';
  if (new RegExp(name, 'i').test(msg) || /unknown|unrecogni[sz]ed|unsupported|not supported|extra inputs|additional propert|not permitted|invalid (?:parameter|param|argument)|não suportad/i.test(msg)) return 'rejected';
  return 'unknown';
}

const CANDIDATES = [
  { name: 'reasoning_effort', extra: { reasoning_effort: 'none' } },
  { name: 'response_format', extra: { response_format: { type: 'json_object' } } }
];

/**
 * Plano: baseline sem parâmetros; se vier vazio/cortado/inválido, 1 nova tentativa com mais tokens; só então testa
 * parâmetros opcionais, um por vez, e só os que COMPROVADAMENTE melhoram o resultado viram "supported".
 * `params` = estados já conhecidos { nome: 'supported'|'accepted'|'rejected'|'unknown' } (alterado no lugar).
 */
export async function testPlan({ call, params = {} }) {
  const msgs = [{ role: 'system', content: PLAN_SYS_SUP }, { role: 'user', content: PLAN_PROBE }];
  let attempts = 0;
  const attempt = async (extra, max) => {
    attempts++;
    let msg;
    try { msg = await call(msgs, { max, extra }); }
    catch (e) { return { ok: false, kind: 'erro', err: e, why: `erro: ${String(e.message || e).slice(0, 120)}` }; }
    const j = judgeReply(msg);
    if (!j.ok) return j;
    const v = validateSupervisorPlan(j.text, { requireMix: true });
    return v.ok ? { ok: true, plan: v.plan, normalized: v.normalized } : { ok: false, kind: 'invalida', why: v.why };
  };

  let r = await attempt(null, 900);
  if (r.ok) return { ok: true, extra: null, params, attempts, normalized: r.normalized };
  let why = r.why;
  if (r.kind === 'truncada' || r.kind === 'vazia') {
    const r2 = await attempt(null, 2400);
    if (r2.ok) return { ok: true, extra: null, params, attempts, normalized: r2.normalized, note: 'precisou de mais tokens de saída' };
    why = r2.why;
  }
  for (const c of CANDIDATES) {
    if (params[c.name] === 'rejected') continue; // já sabemos que este servidor/modelo recusa
    const a = await attempt(c.extra, 2400);
    if (a.kind === 'erro') {
      params[c.name] = classifyParamError(a.err, c.name);
      why = `${c.name}: ${a.why}`;
      continue;
    }
    if (a.ok) { params[c.name] = 'supported'; return { ok: true, extra: c.extra, params, attempts, normalized: a.normalized, note: `só funcionou com ${c.name}` }; }
    params[c.name] = 'accepted'; // aceito pelo servidor, mas sem melhorar o resultado
    why = `com ${c.name} também falhou: ${a.why}`;
  }
  return { ok: false, why: `plano inválido: ${why}`, extra: null, params, attempts };
}

/** JSON estruturado simples: o valor tem que estar certo, não só ser JSON. */
export async function testJson({ call, extra }) {
  const msgs = [{ role: 'user', content: 'Responda APENAS com um objeto JSON com as chaves "soma" (resultado de 17+25) e "ok" (true).' }];
  for (const ex of extra ? [null, extra] : [null]) {
    try {
      const j = judgeReply(await call(msgs, { max: 300, extra: ex }));
      if (!j.ok) continue;
      const v = parseArgs(j.text, { allowTruncated: false }).value;
      if (v && Number(v.soma) === 42 && v.ok === true) return { ok: true, needsExtra: !!ex };
    } catch {}
  }
  return { ok: false };
}

export const PROBE_PING = [{ type: 'function', function: { name: 'ping', description: 'Teste de conexão.', parameters: { type: 'object', properties: {}, required: [] } } }];

/** Ferramentas: precisa vir uma tool_call de verdade chamando `ping` (texto dizendo que chamou não vale). */
export async function testTools({ call }) {
  try {
    const msg = await call([{ role: 'user', content: 'Chame a ferramenta ping agora.' }], { tools: PROBE_PING, max: 200 });
    if (msg.finish_reason === 'length') return { ok: false, why: 'resposta cortada' };
    return Array.isArray(msg.tool_calls) && msg.tool_calls.some(c => c.function?.name === 'ping') ? { ok: true } : { ok: false, why: 'não devolveu chamada de ferramenta no formato esperado' };
  } catch (e) { return { ok: false, why: `erro: ${String(e.message || e).slice(0, 100)}` }; }
}

const READ_TOOL = [{ type: 'function', function: { name: 'read_file', description: 'Lê um arquivo do projeto e devolve o conteúdo.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'caminho do arquivo' } }, required: ['path'] } } }];
const WRITE_TOOL = [{ type: 'function', function: { name: 'write_file', description: 'Cria ou sobrescreve um arquivo com o conteúdo dado.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } }];

/** EXPLORAR: usa a ferramenta de leitura com o argumento certo e responde com base no que LEU (não no que imagina). */
export async function testExplore({ call, extra }) {
  const msgs = [
    { role: 'system', content: 'Você explora um projeto. Para saber o conteúdo de um arquivo, use a ferramenta read_file. Responda curto.' },
    { role: 'user', content: 'Qual é o valor de VERSAO no arquivo config.txt? Use a ferramenta para ler.' }
  ];
  try {
    const m1 = await call(msgs, { tools: READ_TOOL, max: 400, extra });
    const j1 = judgeReply(m1);
    if (!j1.ok) return { ok: false, why: j1.why };
    const tc = (m1.tool_calls || []).find(c => c.function?.name === 'read_file');
    if (!tc) return { ok: false, why: 'não chamou read_file para ler o arquivo' };
    let args; try { args = parseArgs(tc.function.arguments, { allowTruncated: false }).value; } catch { return { ok: false, why: 'argumentos da ferramenta inválidos' }; }
    if (!/config\.txt/i.test(String(args.path || ''))) return { ok: false, why: 'chamou read_file com o caminho errado' };
    const m2 = await call([...msgs, { role: 'assistant', content: m1.content || '', tool_calls: m1.tool_calls }, { role: 'tool', tool_call_id: tc.id, content: 'VERSAO=7731\nMODO=producao' }], { tools: READ_TOOL, max: 400, extra });
    const j2 = judgeReply(m2);
    if (!j2.ok) return { ok: false, why: j2.why };
    return /7731/.test(j2.text) ? { ok: true } : { ok: false, why: 'não usou o conteúdo lido na resposta' };
  } catch (e) { return { ok: false, why: `erro: ${String(e.message || e).slice(0, 100)}` }; }
}

/** Executa com segurança razoável o código de teste: recusa recursos perigosos e limita o tempo (vm, 1 s). */
export function runSnippet(code, fnName) {
  if (/\b(require|process|child_process|import|eval|Function|fs|globalThis|constructor)\b/.test(code.replace(/module\.exports/g, ''))) return { error: 'usa recursos fora do esperado (require/process/eval...)' };
  const sandbox = { module: { exports: {} }, console: { log() {} } };
  try {
    vm.runInNewContext(code, sandbox, { timeout: 1000 });
  } catch (e) { return { error: `o código não executa: ${String(e.message).slice(0, 80)}` }; }
  const ex = sandbox.module.exports;
  const fn = typeof ex === 'function' ? ex : ex?.[fnName];
  if (typeof fn !== 'function') return { error: `não exporta a função ${fnName}` };
  return { fn };
}

/** CODAR: grava um arquivo pela ferramenta E o código funciona (testes com casos escondidos). */
export async function testCode({ call, extra }) {
  const msgs = [
    { role: 'system', content: 'Você é um programador. Para criar arquivos use SEMPRE a ferramenta write_file.' },
    { role: 'user', content: 'Crie o arquivo pares.js em CommonJS que exporta (module.exports = { pares }) a função pares(lista), que devolve um NOVO array só com os números pares da lista, sem alterar a lista original. Use write_file.' }
  ];
  try {
    const m = await call(msgs, { tools: WRITE_TOOL, max: 700, extra });
    const j = judgeReply(m);
    if (!j.ok) return { ok: false, why: j.why };
    const tc = (m.tool_calls || []).find(c => c.function?.name === 'write_file');
    if (!tc) return { ok: false, why: 'não chamou write_file' };
    let args; try { args = parseArgs(tc.function.arguments, { allowTruncated: false }).value; } catch { return { ok: false, why: 'argumentos de write_file inválidos ou cortados' }; }
    if (!/pares\.js$/i.test(String(args.path || '')) || typeof args.content !== 'string') return { ok: false, why: 'write_file com caminho/conteúdo errado' };
    const r = runSnippet(args.content, 'pares');
    if (r.error) return { ok: false, why: r.error };
    const orig = [1, 2, 3, 4, 6, 7];
    const same = (a, b) => Array.isArray(a) && JSON.stringify(Array.from(a)) === JSON.stringify(b);
    if (!same(r.fn(orig), [2, 4, 6]) || !same(r.fn([]), []) || !same(r.fn([5]), []) || JSON.stringify(orig) !== JSON.stringify([1, 2, 3, 4, 6, 7])) return { ok: false, why: 'o código gravado dá resultado errado nos casos de teste' };
    return { ok: true };
  } catch (e) { return { ok: false, why: `erro: ${String(e.message || e).slice(0, 100)}` }; }
}

const REVIEW_SYS = 'Você é um revisor de código rigoroso e objetivo. Compare o OBJETIVO com o código. Responda APENAS com JSON: {"ok":true|false,"problema":"o que está errado, em uma frase"}. Marque ok=false só se houver falha concreta em relação ao objetivo.';
const REVIEW_GOAL = 'OBJETIVO: função pares(lista) que devolve só os números PARES da lista.';

/** REVISAR: reprova o código com bug E aprova o correto (os dois, em JSON válido). */
export async function testReview({ call, extra }) {
  const ask = async (code) => {
    const j = judgeReply(await call([{ role: 'system', content: REVIEW_SYS }, { role: 'user', content: `${REVIEW_GOAL}\n\nCÓDIGO:\n${code}` }], { max: 500, extra }));
    if (!j.ok) return { error: j.why };
    try { const v = parseArgs(j.text, { allowTruncated: false }).value; return typeof v?.ok === 'boolean' ? { v } : { error: 'JSON sem o campo "ok" booleano' }; } catch { return { error: 'JSON inválido' }; }
  };
  try {
    const bad = await ask('function pares(lista) { return lista.filter(n => n % 2 === 1); }');
    if (bad.error) return { ok: false, why: bad.error };
    if (bad.v.ok !== false || !String(bad.v.problema || '').trim()) return { ok: false, why: 'não percebeu o bug (aprovou código que devolve ímpares)' };
    const good = await ask('function pares(lista) { return lista.filter(n => n % 2 === 0); }');
    if (good.error) return { ok: false, why: good.error };
    return good.v.ok === true ? { ok: true } : { ok: false, why: 'reprovou código correto' };
  } catch (e) { return { ok: false, why: `erro: ${String(e.message || e).slice(0, 100)}` }; }
}

/**
 * Orquestra o teste. Devolve o resultado versionado (ver COMPAT_VERSION em config.js).
 * Papéis aprovados = SÓ os que passaram no teste específico:
 *   planejar -> plano estrito  | explorar -> laço de leitura | codar -> código que funciona | revisar -> reprova o ruim e aprova o bom
 */
export async function runCompat({ call, params = {}, version, onProgress = () => {} }) {
  const r = { version, at: Date.now(), caps: { responds: false, streaming: null, tools: false, json: false, jsonNeedsParams: false }, params: {}, roleTests: {}, roles: [], notes: [] };
  // 1) responde (+ streaming) — o primeiro pedido inclui o tempo de carregar o modelo
  onProgress('Respondendo...');
  const t0 = Date.now();
  const first = await call([{ role: 'user', content: 'Responda apenas: ok' }], { max: 32 });
  r.loadMs = Date.now() - t0;
  r.caps.responds = judgeReply(first).ok;
  r.caps.streaming = first.streamed === true ? true : first.streamed === false ? false : null;
  if (!r.caps.responds) { r.notes.push('respondeu vazio'); return r; }
  // 2) velocidade
  onProgress('Medindo velocidade...');
  try {
    const t1 = Date.now();
    const m = await call([{ role: 'user', content: 'Conte de 1 a 40 separados por vírgula.' }], { max: 160 });
    const sec = Math.max(0.2, (Date.now() - t1) / 1000);
    r.tpsEst = Math.round((String(m.content || '').length / 3.5) / sec * 10) / 10;
    const ct = Number(m.usage?.completion_tokens);
    if (ct > 0) r.tpsReal = Math.round(ct / sec * 10) / 10; // tokens reportados pela API ÷ tempo total da resposta
  } catch (e) { r.notes.push(`velocidade: ${String(e.message || e).slice(0, 80)}`); }
  // 3) ferramentas
  onProgress('Testando ferramentas...');
  const tools = await testTools({ call });
  r.caps.tools = tools.ok;
  if (!tools.ok) r.notes.push(`ferramentas: ${tools.why}`);
  // 4) PLANEJAR (descobre também quais parâmetros opcionais ajudam)
  onProgress('Testando plano em JSON...');
  const plan = await testPlan({ call, params });
  r.params = plan.params;
  r.roleTests.planejar = plan.ok ? { ok: true, note: plan.note, normalized: plan.normalized } : { ok: false, why: plan.why };
  const extra = plan.extra || null;
  // 5) JSON estruturado simples
  onProgress('Testando JSON...');
  const js = await testJson({ call, extra });
  r.caps.json = js.ok; r.caps.jsonNeedsParams = !!js.needsExtra;
  // 6) papéis com ferramentas (só se o protocolo de ferramentas funciona)
  if (tools.ok) {
    onProgress('Testando leitura (explorar)...');
    r.roleTests.explorar = await testExplore({ call, extra });
    onProgress('Testando código (codar)...');
    r.roleTests.codar = await testCode({ call, extra });
  } else {
    r.roleTests.explorar = { ok: false, why: 'sem suporte a ferramentas' };
    r.roleTests.codar = { ok: false, why: 'sem suporte a ferramentas' };
  }
  onProgress('Testando revisão...');
  r.roleTests.revisar = await testReview({ call, extra });
  r.roles = Object.entries(r.roleTests).filter(([, t]) => t.ok).map(([k]) => k);
  r.extra = extra; // parâmetros comprovadamente úteis para chamadas de JSON/plano deste modelo
  return r;
}
