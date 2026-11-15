// Índice de skills: classifica, detecta sobreposição e escolhe SOB DEMANDA só as relevantes para cada pedido.
// Isolado: não executa nada e não apaga nada (duplicadas só são "ocultadas do agente", e dá para reativar).

import crypto from 'crypto';

const STOP = new Set(('a o as os um uma uns umas de do da dos das em no na nos nas por para com sem sobre entre ate que se ou e ao aos como mais ' +
  'mas seu sua seus suas este esta esse essa isso isto ser ter fazer quando onde qual quais todo toda todos todas ja nao sim voce voces uso usar usado ' +
  'the an and or of to in on for with without about between that this these those is are be been use using used when where which what how from into your you it its ' +
  'skill skills tool tools help helps need needs want wants should must can will also any all each other').split(/\s+/));

const strip = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const stem = (w) => w.replace(/(coes|cao|mente|ing|ers|er|es|s)$/i, (m) => (w.length - m.length >= 4 ? '' : m));

export function tokenize(text) {
  return strip(text).split(/[^a-z0-9]+/).filter(w => w.length >= 3 && !STOP.has(w)).map(stem);
}

const CATEGORIES = {
  codigo: ['code', 'codigo', 'program', 'function', 'refactor', 'debug', 'bug', 'compile', 'typescript', 'javascript', 'python', 'java', 'rust', 'api', 'backend', 'frontend', 'react', 'node', 'script', 'git', 'commit', 'pull', 'review'],
  testes: ['test', 'teste', 'jest', 'pytest', 'lint', 'coverage', 'qa', 'verification', 'validar', 'validate'],
  web: ['web', 'html', 'css', 'browser', 'site', 'landing', 'ui', 'ux', 'page', 'pagina', 'seo'],
  design: ['design', 'visual', 'layout', 'logo', 'brand', 'color', 'font', 'theme', 'canvas', 'poster', 'art'],
  documentos: ['pdf', 'docx', 'word', 'xlsx', 'excel', 'pptx', 'powerpoint', 'slides', 'document', 'documento', 'planilha', 'spreadsheet', 'presentation'],
  dados: ['data', 'dados', 'csv', 'json', 'sql', 'database', 'analytics', 'chart', 'grafico', 'dashboard', 'pandas'],
  devops: ['deploy', 'docker', 'ci', 'pipeline', 'kubernetes', 'server', 'infra', 'cloud', 'aws', 'build', 'release', 'install'],
  seguranca: ['security', 'seguranca', 'vulnerab', 'pentest', 'reverse', 'engenharia', 'exploit', 'malware', 'audit', 'crypto'],
  pesquisa: ['research', 'pesquisa', 'search', 'busca', 'summarize', 'resumo', 'analysis', 'analise', 'report', 'relatorio'],
  escrita: ['write', 'escrever', 'blog', 'article', 'artigo', 'copy', 'email', 'story', 'texto', 'translate', 'traduc'],
  jogos: ['game', 'jogo', 'unity', 'godot', 'three', '3d', 'sprite', 'shader', 'tibia']
};

export function categorize(tokens) {
  const set = new Set(tokens);
  let best = 'geral', score = 0;
  for (const [cat, words] of Object.entries(CATEGORIES)) {
    const s = words.reduce((a, w) => a + (set.has(stem(strip(w))) ? 1 : 0), 0);
    if (s > score) { best = cat; score = s; }
  }
  return best;
}

const cache = new Map(); // id|descrição -> tokens
function skillTokens(s) {
  const key = `${s.id}|${s.description}`;
  let v = cache.get(key);
  if (!v) {
    v = { name: new Set(tokenize(`${s.id} ${s.name}`)), desc: new Set(tokenize(s.description)) };
    cache.set(key, v);
    if (cache.size > 2000) cache.delete(cache.keys().next().value);
  }
  return v;
}

/**
 * Escolhe até k skills relevantes para o pedido (nome vale mais que descrição; palavras raras valem mais).
 * Devolve [{ skill, score }] ordenado. Pedido sem relação com nenhuma skill → lista vazia (e nada é carregado).
 */
export function selectSkills(skills, requestText, k = 4, minScore = 3) {
  const usable = skills.filter(s => !s.manual);
  if (!usable.length) return [];
  const req = new Set(tokenize(requestText));
  const reqLower = strip(requestText);
  if (!req.size) return [];
  const df = new Map();
  for (const s of usable) {
    const t = skillTokens(s);
    for (const w of new Set([...t.name, ...t.desc])) df.set(w, (df.get(w) || 0) + 1);
  }
  const N = usable.length;
  const scored = usable.map((s) => {
    const t = skillTokens(s);
    let score = 0;
    for (const w of req) {
      const idf = Math.log(1 + N / (df.get(w) || N));
      if (t.name.has(w)) score += 3 * idf;
      else if (t.desc.has(w)) score += 1.2 * idf;
    }
    if (reqLower.includes(strip(s.id)) && s.id.length >= 4) score += 10; // citou a skill pelo nome
    return { skill: s, score };
  }).filter(x => x.score >= minScore).sort((a, b) => b.score - a.score);
  // Não gasta o prompt com duas skills praticamente iguais: fica a de maior pontuação
  const out = [];
  for (const x of scored) {
    const d = skillTokens(x.skill).desc;
    if (out.some(o => jaccardSets(skillTokens(o.skill).desc, d) >= 0.85)) continue;
    out.push(x);
    if (out.length >= k) break;
  }
  return out;
}

function jaccardSets(a, b) {
  if (!a.size || !b.size) return 0;
  let i = 0;
  for (const x of a) if (b.has(x)) i++;
  return i / (a.size + b.size - i);
}

/** Texto curto do prompt de sistema: só as relevantes + aviso de que existem outras (busca sob demanda). */
export function skillsPromptOnDemand(selected, total) {
  const more = total - selected.length;
  if (!selected.length) {
    return total ? `\n\nHá ${total} skills instaladas (instruções especializadas). Se a tarefa envolver algo especializado (documentos, design, testes, deploy...), chame search_skills com palavras-chave e depois use_skill.` : '';
  }
  const rows = selected.map(({ skill: s }) => `- ${s.id}: ${s.description.slice(0, 160)}`).join('\n');
  return `\n\nSkills relevantes para este pedido (chame use_skill com o id ANTES de começar e siga as instruções):\n${rows}` +
    (more > 0 ? `\n(Há mais ${more} skills instaladas; use search_skills se precisar de outra.)` : '');
}

/** Resultado da ferramenta search_skills. */
export function searchSkillsText(skills, query, limit = 8) {
  const hits = selectSkills(skills, query, limit, 1.5);
  if (!hits.length) return `Nenhuma skill combina com "${query}". Skills instaladas: ${skills.filter(s => !s.manual).map(s => s.id).slice(0, 40).join(', ') || '(nenhuma)'}`;
  return hits.map(({ skill: s }) => `- ${s.id}: ${s.description.slice(0, 160)}`).join('\n') + '\nUse use_skill com o id para carregar as instruções.';
}

// ---------- inventário (relatório para você decidir; nada é apagado) ----------

const jaccard = (a, b) => {
  if (!a.size || !b.size) return 0;
  let i = 0;
  for (const x of a) if (b.has(x)) i++;
  return i / (a.size + b.size - i);
};

const promptCostTokens = (skills) => Math.ceil(skills.filter(s => !s.manual).slice(0, 40).reduce((a, s) => a + s.id.length + s.description.slice(0, 200).length + 6, 0) / 3);

/**
 * @param skills  todas as skills, inclusive as "sombreadas" (mesmo id em outra pasta), com { id, name, description, scope, source, dir, shadowed? }
 * @param readBody async (skill) => texto do SKILL.md
 */
export async function buildInventory(skills, readBody) {
  const items = [];
  for (const s of skills) {
    let body = '';
    try { body = await readBody(s); } catch {}
    const toks = [...skillTokens(s).name, ...skillTokens(s).desc];
    items.push({
      id: s.id, name: s.name, scope: s.scope, source: s.source, shadowed: !!s.shadowed, manual: !!s.manual,
      description: s.description.slice(0, 200),
      category: categorize(toks), bytes: Buffer.byteLength(body, 'utf-8'),
      hash: crypto.createHash('sha1').update(body.replace(/^\uFEFF?---[\s\S]*?\n---\s*/, '').replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 12), // só o corpo (o frontmatter tem o nome, que difere)
      _desc: skillTokens(s).desc
    });
  }
  const duplicates = [];
  const byId = new Map();
  for (const it of items) { if (!byId.has(it.id)) byId.set(it.id, []); byId.get(it.id).push(it); }
  for (const [id, list] of byId) {
    if (list.length > 1) duplicates.push({
      type: 'mesmo-id', ids: [id], detail: `"${id}" existe em ${list.length} pastas (${list.map(x => `${x.scope}/${x.source}`).join(', ')}). O agente usa só a primeira (projeto vence global).`,
      suggestion: 'Nada a fazer, a segunda já é ignorada. Se for cópia antiga, apague a pasta extra manualmente.'
    });
  }
  const live = items.filter(i => !i.shadowed);
  const byHash = new Map();
  for (const it of live) { if (it.bytes > 0) { if (!byHash.has(it.hash)) byHash.set(it.hash, []); byHash.get(it.hash).push(it); } }
  for (const list of byHash.values()) {
    if (list.length > 1) duplicates.push({
      type: 'conteudo-identico', ids: list.map(x => x.id), detail: `Conteúdo idêntico: ${list.map(x => x.id).join(', ')}.`,
      suggestion: `Pode ocultar ${list.slice(1).map(x => x.id).join(', ')} sem perder nada.`
    });
  }
  // Sobreposição de descrições: agrupa (união transitiva) em vez de listar todos os pares
  const parent = new Map(live.map(x => [x.id, x.id]));
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const alreadyIdentical = new Set(duplicates.filter(d => d.type === 'conteudo-identico').flatMap(d => d.ids));
  let minSim = 1;
  for (let a = 0; a < live.length; a++) {
    for (let b = a + 1; b < live.length; b++) {
      const x = live[a], y = live[b];
      if (x.hash === y.hash || x._desc.size < 4 || y._desc.size < 4 || x.category !== y.category) continue;
      const sim = jaccard(x._desc, y._desc);
      if (sim >= 0.6) { parent.set(find(x.id), find(y.id)); minSim = Math.min(minSim, sim); }
    }
  }
  const clusters = new Map();
  for (const x of live) { const r = find(x.id); if (!clusters.has(r)) clusters.set(r, []); clusters.get(r).push(x); }
  let shown = 0;
  for (const list of clusters.values()) {
    if (list.length < 2 || list.every(x => alreadyIdentical.has(x.id)) || shown >= 30) continue;
    shown++;
    duplicates.push({
      type: 'descricao-parecida', ids: list.map(x => x.id).slice(0, 12),
      detail: `Descrições muito parecidas (${list[0].category}): ${list.map(x => x.id).slice(0, 12).join(', ')}${list.length > 12 ? ` e mais ${list.length - 12}` : ''}.`,
      suggestion: 'Possível sobreposição: leia as skills antes de decidir. Ocultar só tira do agente (reversível); o carregamento sob demanda já evita mostrar todas ao mesmo tempo.'
    });
  }
  const categories = {};
  for (const it of live) categories[it.category] = (categories[it.category] || 0) + 1;
  const liveSkills = skills.filter(s => !s.shadowed);
  return {
    total: items.length, active: live.length, categories,
    promptTokens: { antes: promptCostTokens(liveSkills), depois: 120 + 4 * 45 }, // lista completa vs. só as relevantes (~4)
    items: items.map(({ _desc, ...rest }) => rest), duplicates
  };
}
