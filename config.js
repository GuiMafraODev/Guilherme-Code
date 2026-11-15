import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Sempre ao lado do código (e não no cwd), assim o CLI funciona de qualquer pasta.
const CONFIG_FILE = path.join(__dirname, '.keys.json');
const SETTINGS_FILE = path.join(__dirname, '.settings.json');

// Prioridade entre provedores (você pode reordenar na tela). Vale também para o fallback.
// Configurações gerais (.settings.json): { order: [...], routing: true|false }
export function getSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8')) || {}; } catch { return {}; }
}
export function saveSettings(patch) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ ...getSettings(), ...patch }, null, 2), 'utf-8');
}
export function getProviderOrder() {
  const o = getSettings().order;
  return Array.isArray(o) ? o : [];
}
export function saveProviderOrder(order) {
  saveSettings({ order });
}


// ---------- IAs locais (OPCIONAL): Ollama, LM Studio ou qualquer servidor compatível com a API da OpenAI ----------
// Ficam em .settings.json -> locals: [{ id, name, url, models[], ctx, kind, autostart, enabled }]
// Sem nenhuma IA local cadastrada, o programa se comporta exatamente como antes.

export const PERMISSION_MODES = ['pedir', 'automatico', 'estrito'];
export function getPermissionMode() {
  const m = getSettings().permissionMode;
  return PERMISSION_MODES.includes(m) ? m : 'pedir';
}
export function savePermissionMode(mode) {
  if (!PERMISSION_MODES.includes(mode)) throw new Error('Modo de segurança inválido.');
  saveSettings({ permissionMode: mode });
}

export const LOCAL_MODES = ['backup', 'economia', 'primeiro'];

/** "localhost:11434", "http://127.0.0.1:1234/" -> "http://localhost:11434/v1" (sem barra no fim). */
export function normalizeLocalUrl(raw) {
  let u = String(raw || '').trim();
  if (!u) throw new Error('Informe o endereço do servidor (ex.: http://localhost:11434).');
  if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
  let parsed;
  try { parsed = new URL(u); } catch { throw new Error('Endereço inválido.'); }
  let p = parsed.pathname.replace(/\/+$/, '');
  p = p.replace(/\/chat\/completions$/, '');
  if (!/\/v1$/.test(p)) p += '/v1';
  return `${parsed.protocol}//${parsed.host}${p}`;
}

export function getLocals() {
  const l = getSettings().locals;
  return Array.isArray(l) ? l.filter(x => x && x.id && x.url) : [];
}

/** Adiciona ou atualiza (se vier id). Devolve a lista salva. */
export function saveLocal(entry) {
  const list = getLocals();
  const url = normalizeLocalUrl(entry.url);
  const models = [...new Set((Array.isArray(entry.models) ? entry.models : String(entry.models || '').split(','))
    .map(m => String(m).trim()).filter(Boolean))];
  if (!models.length) throw new Error('Informe pelo menos um modelo (ex.: qwen2.5-coder:7b).');
  const kind = ['ollama', 'lmstudio', 'outro'].includes(entry.kind) ? entry.kind : 'outro';
  let id = entry.id && list.some(x => x.id === entry.id) ? entry.id : '';
  if (!id) { let n = 1; while (list.some(x => x.id === `local${n}`)) n++; id = `local${n}`; }
  const ctx = Math.max(0, Math.min(Number(entry.ctx) || 0, 1000000));
  const clean = {
    id,
    name: String(entry.name || '').trim().slice(0, 40) || (kind === 'ollama' ? 'Ollama' : kind === 'lmstudio' ? 'LM Studio' : 'IA local'),
    url, models, ctx, kind,
    autostart: !!entry.autostart,
    enabled: entry.enabled !== false
  };
  const next = list.some(x => x.id === id) ? list.map(x => (x.id === id ? clean : x)) : [...list, clean];
  saveSettings({ locals: next });
  return next;
}

export function removeLocal(id) {
  const next = getLocals().filter(x => x.id !== id);
  saveSettings({ locals: next });
  return next;
}

export function getLocalMode() {
  const m = getSettings().localMode;
  return LOCAL_MODES.includes(m) ? m : 'economia';
}
export function saveLocalMode(mode) {
  if (!LOCAL_MODES.includes(mode)) throw new Error('Modo inválido.');
  saveSettings({ localMode: mode });
}


/** Quantos segundos vale esperar a nuvem voltar antes de passar o trabalho para a IA local (0 = nunca espera). */
export function getLocalWaitSec() {
  const v = getSettings().localWaitSec;
  const n = Number(process.env.GCODE_LOCAL_WAIT_SEC ?? v);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 1800) : 120;
}
export function saveLocalWaitSec(sec) { saveSettings({ localWaitSec: Math.max(0, Math.min(Number(sec) || 0, 1800)) }); }

// ---------- Supervisor local (OPCIONAL, desligado por padrão) ----------
// Um modelo local escolhido por VOCÊ planeja tarefas complexas, divide em etapas e distribui para outros modelos conforme o
// "papel" que você deu a cada um. Ser só "IA local de reserva" NUNCA a transforma em Supervisor.
// .settings.json -> supervisor: { enabled, model: "localId::modelo", roles: { "localId::modelo": [papéis] },
//                                 approved: { "localId::modelo": resultado do teste de compatibilidade }, limits, unloadAfter }
export const LOCAL_ROLES = ['planejar', 'explorar', 'codar', 'revisar', 'reserva'];
export const DEFAULT_SUP_LIMITS = { maxDelegations: 8, maxMinutes: 40, maxRetries: 1, maxAgentSteps: 250 };

export const localKey = (id, model) => `${id}::${model}`;

/** Versão do formato/critérios do teste de compatibilidade. Resultados de versões antigas NÃO aprovam papel nenhum
 *  (o cadastro continua; basta rodar o teste de novo). */
export const COMPAT_VERSION = 2;
export const approvedRoles = (sup, key) => { const a = sup.approved?.[key]; return a && a.version === COMPAT_VERSION && Array.isArray(a.roles) ? a.roles : []; };

export function getSupervisor() {
  const s = getSettings().supervisor || {};
  return {
    enabled: s.enabled === true,
    model: typeof s.model === 'string' ? s.model : '',
    roles: s.roles && typeof s.roles === 'object' ? s.roles : {},
    approved: s.approved && typeof s.approved === 'object' ? s.approved : {},
    limits: { ...DEFAULT_SUP_LIMITS, ...(s.limits || {}) },
    unloadAfter: s.unloadAfter !== false
  };
}

const knownLocalKeys = () => new Set(getLocals().flatMap(l => l.models.map(m => localKey(l.id, m))));

/** Aplica mudanças com validação. Ligar o Supervisor exige: modelo escolhido, existente e APROVADO no teste de compatibilidade. */
export function saveSupervisor(patch = {}) {
  const cur = getSupervisor();
  const next = { ...cur };
  const known = knownLocalKeys();
  if (patch.model !== undefined) {
    if (patch.model && !known.has(patch.model)) throw new Error('Esse modelo local não está cadastrado.');
    next.model = patch.model || '';
  }
  if (patch.roles !== undefined) {
    const r = {};
    for (const [k, v] of Object.entries(patch.roles || {})) {
      if (!known.has(k)) continue;
      const list = [...new Set((Array.isArray(v) ? v : []).filter(x => LOCAL_ROLES.includes(x)))];
      const bad = list.filter(x => x !== 'reserva' && !approvedRoles(cur, k).includes(x));
      if (bad.length) throw new Error(`"${k.split('::')[1]}" ainda não foi aprovado para: ${bad.join(', ')}. Rode o "Teste de compatibilidade" primeiro.`);
      r[k] = list;
    }
    next.roles = r;
  }
  if (patch.limits) {
    const l = { ...next.limits };
    for (const k of Object.keys(DEFAULT_SUP_LIMITS)) if (patch.limits[k] !== undefined) l[k] = Math.max(1, Math.min(Number(patch.limits[k]) || DEFAULT_SUP_LIMITS[k], 1000));
    next.limits = l;
  }
  if (patch.unloadAfter !== undefined) next.unloadAfter = !!patch.unloadAfter;
  if (patch.enabled !== undefined) {
    if (patch.enabled) {
      if (!next.model) throw new Error('Escolha qual modelo local será o Supervisor antes de ligar.');
      if (!approvedRoles(next, next.model).includes('planejar')) throw new Error('O modelo escolhido ainda não foi aprovado para "planejar" no Teste de compatibilidade atual (resultados antigos não valem). Rode o teste.');
    }
    next.enabled = !!patch.enabled;
  }
  saveSettings({ supervisor: next });
  return getSupervisor();
}

/** Guarda o resultado do teste de compatibilidade (só o programa chama isto). */
export function saveCompat(key, result) {
  const cur = getSupervisor();
  saveSettings({ supervisor: { ...cur, approved: { ...cur.approved, [key]: result } } });
}

/** Supervisor realmente ativo agora? (ligado + modelo existente + aprovado). Senão null: o programa segue como sempre. */
export function activeSupervisor() {
  const s = getSupervisor();
  if (!s.enabled || !s.model) return null;
  const [id] = s.model.split('::');
  const loc = getLocals().find(l => l.id === id && l.enabled !== false);
  if (!loc || !knownLocalKeys().has(s.model)) return null;
  if (!approvedRoles(s, s.model).includes('planejar')) return null;
  return s;
}

/** IAs locais no mesmo formato dos provedores (para entrar na esteira de fallback). */
export function getLocalProviders() {
  return getLocals().filter(l => l.enabled !== false).map(l => ({
    id: l.id, baseId: l.id, slot: 1, keyCount: 1, name: `🏠 ${l.name}`,
    url: `${l.url}/chat/completions`, modelsUrl: `${l.url}/models`, baseUrl: l.url,
    apiKey: 'local', keys: ['local'], models: l.models, model: l.models[0], explicit: true,
    local: true, ctx: l.ctx || 0, kind: l.kind, autostart: !!l.autostart, supportsTools: true
  }));
}

const PROVIDERS = [
  {
    id: 'gemini',
    name: 'Google Gemini (AI Studio)',
    url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    modelsUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/models',
    defaultModel: 'gemini-2.0-flash'
  },
  {
    id: 'openrouter',
    name: 'OpenRouter (Várias IAs)',
    url: 'https://openrouter.ai/api/v1/chat/completions',
    modelsUrl: 'https://openrouter.ai/api/v1/models', // público: não valida a chave
    validateUrl: 'https://openrouter.ai/api/v1/key',  // este valida
    defaultModel: 'openrouter/free'
  },
  {
    id: 'mistral',
    name: 'Mistral AI',
    url: 'https://api.mistral.ai/v1/chat/completions',
    modelsUrl: 'https://api.mistral.ai/v1/models',
    defaultModel: 'mistral-small-latest'
  },
  {
    id: 'together',
    name: 'Together AI',
    url: 'https://api.together.xyz/v1/chat/completions',
    modelsUrl: 'https://api.together.xyz/v1/models',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo'
  },
  {
    id: 'cohere',
    name: 'Cohere',
    // O endpoint antigo (/v1/chat/completions) não existe; o compatível com OpenAI é este:
    url: 'https://api.cohere.ai/compatibility/v1/chat/completions',
    modelsUrl: 'https://api.cohere.com/v1/models?endpoint=chat',
    defaultModel: 'command-r-plus'
  },
  {
    id: 'nvidia',
    name: 'NVIDIA NIM (build.nvidia.com)',
    url: 'https://integrate.api.nvidia.com/v1/chat/completions',
    modelsUrl: 'https://integrate.api.nvidia.com/v1/models',
    defaultModel: 'meta/llama-3.3-70b-instruct'
  },
  {
    id: 'deepseek',
    name: 'DeepSeek API',
    url: 'https://api.deepseek.com/v1/chat/completions',
    modelsUrl: 'https://api.deepseek.com/models',
    defaultModel: 'deepseek-chat'
  },
  {
    id: 'openai',
    name: 'OpenAI',
    url: 'https://api.openai.com/v1/chat/completions',
    modelsUrl: 'https://api.openai.com/v1/models',
    defaultModel: 'gpt-4o-mini'
  },
  {
    id: 'groq',
    name: 'Groq Cloud',
    url: 'https://api.groq.com/openai/v1/chat/completions',
    modelsUrl: 'https://api.groq.com/openai/v1/models',
    defaultModel: 'llama-3.3-70b-versatile'
  },
  {
    id: 'anthropic',
    name: 'Anthropic Claude',
    url: 'https://api.anthropic.com/v1/messages',
    modelsUrl: 'https://api.anthropic.com/v1/models?limit=1000',
    defaultModel: 'claude-3-5-sonnet-20241022',
    isAnthropicNative: true // ainda sem tool-use: só entra no Modo Arena
  }
];

export function authHeaders(provider, key) {
  return provider.isAnthropicNative
    ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
    : { Authorization: `Bearer ${key}` };
}

export function maskKey(key) {
  if (!key) return '';
  return key.length > 10 ? `${key.slice(0, 4)}…${key.slice(-4)}` : '••••••';
}

const cleanKeys = (arr) => [...new Set(arr.map(k => String(k || '').trim()).filter(Boolean))];

export function getStoredConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
      const normalized = {};
      for (const [k, v] of Object.entries(data)) {
        if (typeof v === 'string') {
          normalized[k] = { apiKey: v, keys: cleanKeys([v]), model: '', models: [] };
        } else {
          // Formato antigo: só "apiKey". Formato novo: "keys" (lista). Os dois são aceitos.
          const keys = cleanKeys([v?.apiKey, ...(Array.isArray(v?.keys) ? v.keys : [])]);
          normalized[k] = {
            apiKey: keys[0] || '',
            keys,
            model: v?.model || '',
            models: Array.isArray(v?.models) ? v.models : []
          };
        }
      }
      return normalized;
    }
  } catch (e) {
    console.error('Aviso: não consegui ler .keys.json:', e.message);
  }
  return {};
}

/**
 * patch.apiKey         -> ADICIONA uma chave (sem duplicar). Vazio ('') remove TODAS as chaves do provedor.
 * patch.removeKeyIndex -> remove a chave de posição N (0 = primeira)
 * patch.models         -> lista ORDENADA de modelos habilitados (a ordem é a prioridade no fallback)
 */
export function saveProviderConfig(providerId, patch = {}) {
  const current = getStoredConfig();
  const next = { ...(current[providerId] || { apiKey: '', keys: [], model: '', models: [] }) };
  let keys = [...(next.keys || [])];

  if (patch.apiKey !== undefined) {
    const k = String(patch.apiKey).trim();
    if (!k) keys = [];
    else if (!keys.includes(k)) keys.push(k);
  }
  if (Number.isInteger(patch.removeKeyIndex)) keys = keys.filter((_, i) => i !== patch.removeKeyIndex);
  next.keys = keys;
  next.apiKey = keys[0] || ''; // compatibilidade com o formato antigo

  if (Array.isArray(patch.models)) {
    next.models = [...new Set(patch.models.map(m => String(m).trim()).filter(Boolean))];
    next.model = next.models[0] || '';
  }

  current[providerId] = next;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(current, null, 2), { encoding: 'utf-8', mode: 0o600 });
}

export function getAllProviders() {
  const stored = getStoredConfig();
  const saved_order = getProviderOrder();
  const rank = (id) => { const i = saved_order.indexOf(id); return i < 0 ? 1000 + PROVIDERS.findIndex(p => p.id === id) : i; };
  return [...PROVIDERS].sort((a, b) => rank(a.id) - rank(b.id)).map(p => {
    const saved = stored[p.id] || {};
    const explicit = !!(saved.models?.length || saved.model?.trim());
    let models = saved.models?.length ? saved.models : [];
    if (!models.length && saved.model?.trim()) models = [saved.model.trim()];
    if (!models.length) models = [p.defaultModel];
    return {
      ...p,
      apiKey: saved.apiKey || '',
      keys: saved.keys || [],
      models,
      explicit, // false = ainda é o modelo padrão embutido (pode estar desatualizado)
      model: models[0] // compatibilidade
    };
  });
}

/**
 * Uma entrada por CHAVE. A 1ª chave mantém o id do provedor (ex.: "gemini"), as outras viram
 * "gemini#2", "gemini#3"... Assim cooldown, limite e saldo são controlados separadamente por chave.
 * `baseId` é sempre o id do provedor.
 */
export function getActiveProviders(selectedProviderIds = []) {
  const out = [];
  // IA local (opcional): entra se a seleção estiver vazia ou citar o id dela. O engine acrescenta os ids locais à seleção.
  const locals = getLocalProviders().filter(p => !selectedProviderIds?.length || selectedProviderIds.includes(p.id));
  for (const p of getAllProviders()) {
    if (selectedProviderIds && selectedProviderIds.length > 0 && !selectedProviderIds.includes(p.id)) continue;
    const keys = p.keys || [];
    keys.forEach((key, i) => {
      out.push({
        ...p,
        baseId: p.id,
        id: i === 0 ? p.id : `${p.id}#${i + 1}`,
        slot: i + 1,
        keyCount: keys.length,
        name: keys.length > 1 ? `${p.name} #${i + 1}` : p.name,
        apiKey: key
      });
    });
  }
  out.push(...locals);
  return out;
}
