import { activeSupervisor, localKey, approvedRoles } from './config.js';
import { parseArgs } from './jsonrepair.js';
import { unloadLocalModels } from './local.js';

// Núcleo do Supervisor opcional: papéis, limites e troca de modelo local. Sem Supervisor ativo, nada aqui age.

export const ROLE_OF_STEP = { explorar: 'explorar', codar: 'codar', revisar: 'revisar' };

/** O modelo local {provider, model} tem esse papel (e foi aprovado no teste)? */
export function hasRole(sup, providerId, model, role) {
  if (!sup) return false;
  const k = localKey(providerId, model);
  return (sup.roles[k] || []).includes(role) && approvedRoles(sup, k).includes(role);
}

/** Orçamento de uma execução do Supervisor: limites duros de delegações, tempo, tentativas e passos do agente. */
export function makeBudget(sup) {
  const l = sup.limits;
  const t0 = Date.now();
  const b = {
    delegations: 0, retries: 0, agentSteps: 0, plannerCalls: 0,
    canDelegate() { return b.delegations < l.maxDelegations; },
    canRetry() { return b.retries < l.maxRetries && b.canDelegate(); },
    timeUp() { return Date.now() - t0 > l.maxMinutes * 60e3; },
    stepsUp() { return b.agentSteps >= l.maxAgentSteps; },
    why() { return b.timeUp() ? `tempo (${l.maxMinutes} min)` : b.stepsUp() ? `passos do agente (${l.maxAgentSteps})` : !b.canDelegate() ? `delegações (${l.maxDelegations})` : ''; },
    summary() { return `${b.delegations}/${l.maxDelegations} delegações, ${b.retries} nova(s) tentativa(s), ${Math.round((Date.now() - t0) / 1000)}s`; }
  };
  return b;
}

export const PLAN_SYS_SUP = 'Você é o Supervisor de um time de IAs de programação. Divida o pedido em 3 a 7 etapas pequenas, em ordem. Cada etapa será feita por um agente que NÃO lembra das outras, com pouco contexto. "tipo" é "explorar" (só ler/entender), "codar" (criar/alterar código, rodar testes) ou "revisar" (conferir o que foi feito). Responda APENAS com JSON: {"steps":[{"title":"curto","tipo":"codar","goal":"instruções objetivas e completas, citando arquivos quando souber"}]}';

export const PLAN_TYPES = ['explorar', 'codar', 'revisar'];

/**
 * Extrai a lista de etapas da resposta do modelo SEM inventar nada:
 *  - aceita {"steps":[...]} (formato do contrato) ou uma lista direta [...] de objetos (normalização sem ambiguidade);
 *  - aceita cercas Markdown e texto em volta (usa o mesmo parser tolerante dos argumentos de ferramentas);
 *  - JSON cortado/incompleto NUNCA vira plano (allowTruncated: false).
 * Devolve { steps, normalized[] } ou { error }.
 */
export function extractPlanSteps(raw) {
  if (Array.isArray(raw)) return { steps: raw, normalized: ['lista direta'] };
  let text = String(raw ?? '').trim();
  if (!text) return { error: 'resposta vazia' };
  const fence = text.match(/```[a-zA-Z]*\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
  const firstObj = text.indexOf('{'), firstArr = text.indexOf('[');
  if (firstArr >= 0 && (firstObj < 0 || firstArr < firstObj)) {
    // lista direta: o parser tolerante olharia só o primeiro objeto, então aqui o JSON tem que ser estritamente válido
    const last = text.lastIndexOf(']');
    if (last < firstArr) return { error: 'lista de etapas incompleta (sem fechar)' };
    try {
      const v = JSON.parse(text.slice(firstArr, last + 1).replace(/,\s*([\]}])/g, '$1'));
      return Array.isArray(v) ? { steps: v, normalized: ['lista direta'] } : { error: 'formato inesperado' };
    } catch { return { error: 'JSON inválido ou cortado' }; }
  }
  if (firstObj < 0) return { error: 'sem JSON na resposta' };
  let v;
  try { v = parseArgs(text, { allowTruncated: false }).value; } catch { return { error: 'JSON inválido ou cortado' }; }
  if (!v || typeof v !== 'object' || Array.isArray(v) || !Array.isArray(v.steps)) return { error: 'o JSON não tem a lista "steps"' };
  return { steps: v.steps, normalized: [] };
}

/**
 * Valida um plano do Supervisor de forma ESTRITA (modelos pequenos erram; é melhor recusar do que aprovar errado).
 * `input`: texto bruto da resposta OU a lista de etapas. Cada etapa é validada individualmente:
 *   título (3-100 caracteres), objetivo (>= 20) e tipo EXATAMENTE um de explorar|codar|revisar.
 *   Tipo ausente/desconhecido NÃO vira "codar": é erro. Único apelido aceito: "type" -> "tipo" (e só se "tipo" não existir).
 * Qualquer etapa inválida, repetida ou incompleta rejeita o plano inteiro (nunca completamos um plano).
 * `requireMix` (teste de compatibilidade): exige pelo menos 2 tipos diferentes. Em uso real planos de um só tipo
 * (por exemplo, só "codar" numa tarefa simples) continuam permitidos; planos só de exploração/revisão não.
 * Devolve { ok, plan?, why, issues[], normalized[] }.
 */
export function validateSupervisorPlan(input, { requireMix = false, minSteps = 2, maxSteps = 8 } = {}) {
  const ex = extractPlanSteps(input);
  if (ex.error) return { ok: false, why: ex.error, issues: [ex.error], normalized: [] };
  const steps = ex.steps;
  const normalized = [...ex.normalized];
  const issues = [];
  const plan = [];
  const seen = new Set();
  if (steps.length < minSteps) issues.push(`só ${steps.length} etapa(s) (mínimo ${minSteps})`);
  if (steps.length > maxSteps) issues.push(`${steps.length} etapas (máximo ${maxSteps})`);
  steps.forEach((x, i) => {
    const n = i + 1;
    if (!x || typeof x !== 'object' || Array.isArray(x)) { issues.push(`etapa ${n}: não é um objeto`); return; }
    const title = typeof x.title === 'string' ? x.title.trim() : '';
    const goal = typeof x.goal === 'string' ? x.goal.trim() : '';
    let rawTipo = x.tipo;
    if (rawTipo === undefined && x.type !== undefined) { rawTipo = x.type; normalized.push(`etapa ${n}: "type" -> "tipo"`); }
    else if (rawTipo !== undefined && x.type !== undefined && String(x.type).trim().toLowerCase() !== String(rawTipo).trim().toLowerCase()) issues.push(`etapa ${n}: "tipo" e "type" diferentes`);
    const tipo = typeof rawTipo === 'string' ? rawTipo.trim().toLowerCase() : '';
    if (title.length < 3 || title.length > 100) issues.push(`etapa ${n}: título ausente ou fora do tamanho`);
    if (goal.length < 20) issues.push(`etapa ${n}: objetivo ausente ou curto demais`);
    if (!tipo) issues.push(`etapa ${n}: sem "tipo"`);
    else if (!PLAN_TYPES.includes(tipo)) issues.push(`etapa ${n}: tipo desconhecido "${String(rawTipo).slice(0, 20)}"`);
    const sig = goal.toLowerCase().replace(/\W+/g, '');
    if (sig && seen.has(sig)) issues.push(`etapa ${n}: repetida`);
    seen.add(sig);
    plan.push({ title: title.slice(0, 100), goal: goal.slice(0, 700), tipo, status: 'pendente', summary: '' });
  });
  if (!issues.length) {
    const kinds = new Set(plan.map(p => p.tipo));
    if (requireMix && kinds.size < 2) issues.push(`todas as etapas vieram como "${[...kinds][0]}": o modelo não distribuiu os tipos pedidos`);
    if (!kinds.has('codar')) issues.push('o plano não tem nenhuma etapa de "codar" (só exploração/revisão)');
  }
  if (issues.length) return { ok: false, why: issues.slice(0, 3).join('; '), issues, normalized };
  return { ok: true, plan, why: '', issues: [], normalized };
}

// Qual modelo local está carregado agora (para só trocar — e descarregar o anterior — quando mudar).
let loaded = null; // { provider, model }

/** Antes de usar um modelo local no modo Supervisor: se for outro, descarrega o anterior (nunca 2 na VRAM). */
export async function prepareLocal(provider, model, onLog) {
  // vale com ou sem Supervisor: nunca dois modelos locais ao mesmo tempo na VRAM
  if (loaded && (loaded.provider.id !== provider.id || loaded.model !== model)) {
    await unloadLocalModels(loaded.provider, null, onLog);
    if (loaded.provider.baseUrl !== provider.baseUrl) await unloadLocalModels(provider, model, onLog);
  } else if (!loaded) {
    await unloadLocalModels(provider, model, onLog); // sobras de outras sessões ocupando VRAM
  }
  loaded = { provider, model };
}

export async function releaseLocal(onLog) {
  const sup = activeSupervisor();
  if (!sup || !sup.unloadAfter || !loaded) return;
  await unloadLocalModels(loaded.provider, null, onLog);
  loaded = null;
}
