import { getAllProviders, authHeaders } from './config.js';

export class ProviderError extends Error {
  constructor(message, { status = 0, retryAfter = 0 } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

/** "1m30.5s", "250ms", "7.66s", "45" (segundos) -> segundos (0 se não entender). */
export function parseDuration(v) {
  if (v === null || v === undefined || v === '') return 0;
  const str = String(v).trim();
  if (/^\d+(\.\d+)?$/.test(str)) return Number(str);
  let total = 0;
  let any = false;
  for (const m of str.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h|d)/g)) {
    any = true;
    total += Number(m[1]) * ({ ms: 0.001, s: 1, m: 60, h: 3600, d: 86400 }[m[2]]);
  }
  return any ? total : 0;
}

export async function readHttpError(res) {
  let txt = '';
  try { txt = (await res.text()).replace(/\s+/g, ' ').slice(0, 300); } catch {}
  // Retry-After, ou (Groq/OpenAI/...) os cabeçalhos de renovação do limite
  let retryAfter = Number(res.headers.get('retry-after')) || 0;
  if (!retryAfter) retryAfter = (Number(res.headers.get('retry-after-ms')) || 0) / 1000;
  if (!retryAfter) {
    retryAfter = Math.max(parseDuration(res.headers.get('x-ratelimit-reset-requests')), parseDuration(res.headers.get('x-ratelimit-reset-tokens')));
  }
  retryAfter = Math.min(Math.ceil(retryAfter), 30 * 60);
  return new ProviderError(`HTTP ${res.status}: ${txt}`, { status: res.status, retryAfter });
}

// Heurística: quais ids de modelo aceitam imagem. (O OpenRouter informa isso de verdade; os demais não.)
const VISION_RE = /gemini|gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-5|chatgpt-4o|claude|vision|[-_/]vl[-_:./]|[-_]vl$|pixtral|llava|llama-?3\.2-(11|90)b|llama-?4|maverick|scout|gemma-?3|mistral-(small|medium)|mistral-large-(2|3|latest)|phi-?3\.5-vision|phi-4-multimodal|molmo|minicpm-v|internvl|grok.*(vision|4)/i;
export const isVisionModel = (id) => VISION_RE.test(String(id));

// Modelos que não servem para chat/agente (embeddings, voz, imagem, moderação...)
const NON_CHAT = /embed|whisper|tts|speech|transcribe|audio|realtime|moderation|guard|rerank|reward|dall-e|image|imagen|veo|video|aqa|safety|classif|ocr|diffusion|stable-|flux|sdxl|retriev|deep-research|computer-use|antigravity|robotics|lyria|nano-banana|native-audio|orpheus|playai|allam|[-_]live\b|\blive[-_]/i;
export const isNonChatModel = (id) => NON_CHAT.test(String(id));
const NON_CHAT_TYPES = new Set(['image', 'embedding', 'embed', 'audio', 'moderation', 'rerank', 'transcribe', 'tts', 'video']);

function normalizeModels(data) {
  const raw = Array.isArray(data) ? data : (data?.data || data?.models || []);
  const seen = new Set();
  const out = [];

  for (const m of raw) {
    const o = typeof m === 'string' ? { id: m } : (m || {});
    const id = String(o.id || o.name || '').replace(/^models\//, '');
    if (!id || seen.has(id) || NON_CHAT.test(id)) continue;
    if (typeof o.type === 'string' && NON_CHAT_TYPES.has(o.type)) continue;           // Together
    if (o.capabilities && o.capabilities.completion_chat === false) continue;         // Mistral
    const mods = o.architecture?.output_modalities;                                    // OpenRouter
    if (Array.isArray(mods) && !mods.includes('text')) continue;

    const free =
      id.endsWith(':free') ||
      (o.pricing && Number(o.pricing.prompt) === 0 && Number(o.pricing.completion) === 0);

    const inputs = o.architecture?.input_modalities;
    const vision = Array.isArray(inputs) ? inputs.includes('image') : isVisionModel(id);

    seen.add(id);
    out.push({ id, free: !!free, vision });
  }

  out.sort((a, b) => (b.free - a.free) || a.id.localeCompare(b.id));
  return out;
}

/**
 * Escolhe os melhores modelos de uso geral da lista (heurística): evita preview/experimental/mini,
 * prefere famílias conhecidas, tamanhos grandes e versões mais novas.
 */
function modelScore(id) {
  const s = id.toLowerCase();
  let sc = 0;
  if (/preview|experimental|[-_]exp\b|exp[-_]|thinking|[-_]lite|tiny|nano|beta|alpha|legacy|deprecated/.test(s)) sc -= 50;
  if (/flash|versatile|instruct|chat|maverick|scout|gpt-oss|kimi|qwen|llama|deepseek|mistral|command|claude|gpt-4|gpt-5|sonnet|haiku/.test(s)) sc += 20;
  if (/70b|120b|405b|235b|large|maverick|\bpro\b|sonnet|opus/.test(s)) sc += 10;
  if (/flash/.test(s)) sc += 5;
  if (/latest/.test(s)) sc += 3;
  if (/gemma|[-_]it$|\b[1-9]b\b|\b[1-9]\.\db\b|[-_][1-9](\.\d)?b\b/.test(s)) sc -= 8;
  if (/coder|[-_]code|math|translate|ocr|guard|reward|embed|safety|content/.test(s)) sc -= 30;
  // versão do modelo, ignorando os números de tamanho (70b, 6.7b...)
  const ver = s.replace(/\d+(?:\.\d+)?b\b/g, '').match(/(\d+(?:\.\d+)?)/);
  if (ver) sc += Math.min(parseFloat(ver[1]), 10);
  return sc;
}

export function recommendModels(models, n = 3) {
  return [...models]
    .sort((a, b) => (modelScore(b.id) - modelScore(a.id)) || a.id.localeCompare(b.id))
    .slice(0, n);
}

function friendly(err) {
  if (err.name === 'TimeoutError') return 'Tempo esgotado ao consultar o provedor.';
  if (err.status === 401 || err.status === 403) return `Chave inválida ou sem permissão (${err.message.slice(0, 120)})`;
  if (err.status === 400 && /api key/i.test(err.message)) return `Chave inválida (${err.message.slice(0, 120)})`;
  return err.message;
}

/**
 * Lista os modelos de chat disponíveis para a chave.
 * Serve também como validação: listar modelos não gasta cota.
 */
export async function listModels(providerId, keyOverride) {
  const p = getAllProviders().find(x => x.id === providerId);
  if (!p) throw new Error('Provedor desconhecido.');
  const key = (keyOverride || p.apiKey || '').trim();
  if (!key) throw new Error('Nenhuma chave informada.');

  const headers = authHeaders(p, key);
  try {
    if (p.validateUrl) {
      const v = await fetch(p.validateUrl, { headers, signal: AbortSignal.timeout(15000) });
      if (!v.ok) throw await readHttpError(v);
    }
    const res = await fetch(p.modelsUrl, { headers, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw await readHttpError(res);
    return normalizeModels(await res.json());
  } catch (err) {
    throw new Error(friendly(err));
  }
}
