import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { runAgentWithFallback, runPlanned, runBroadcastAll, testModel, testLocal, compatLocal, clearProviderState, probeModels, providerHealth, setIgnored } from './engine.js';
import { saveProviderConfig, getAllProviders, maskKey, saveProviderOrder, getSettings, saveSettings, getPermissionMode, savePermissionMode, PERMISSION_MODES, getLocals, saveLocal, removeLocal, getLocalMode, saveLocalMode, normalizeLocalUrl, LOCAL_MODES, getLocalWaitSec, saveLocalWaitSec, COMPAT_VERSION, getSupervisor, saveSupervisor, activeSupervisor, LOCAL_ROLES, localKey } from './config.js';
import { listLocalModels, isLocalUp } from './local.js';
import { listModels, recommendModels } from './models.js';
import { executeTool } from './tools.js';
import { DOC_EXTS, extOf, readDocument } from './docs.js';
import { listUndo, undoLast } from './undo.js';
import { listSkills, listCommands, installFromGithub, removeInstalled, expandSlash } from './skills.js';
import { buildInventory } from './skillindex.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const HOST = '127.0.0.1';
const APP_VERSION = '5.9';
const PORT = process.env.PORT || 3000;

// Esta API executa comandos e escreve arquivos. Sem esta trava, QUALQUER site aberto no seu
// navegador poderia chamar http://localhost:3000/api/agent. Então: sem CORS aberto, e só
// aceitamos requisições do próprio localhost (também protege contra DNS rebinding).
const LOCAL = new Set(['localhost', '127.0.0.1']);
app.use((req, res, next) => {
  const host = req.headers.host || '';
  if (!LOCAL.has(host.split(':')[0])) return res.status(403).json({ error: 'Host não permitido.' });
  const origin = req.headers.origin;
  if (origin) {
    let ok = false;
    try { ok = new URL(origin).host === host; } catch {}
    if (!ok) return res.status(403).json({ error: 'Origem não permitida.' });
  }
  next();
});
app.use(express.json({ limit: '30mb' })); // imagens vão em base64

// Converte texto + imagens (data URLs) no formato de mensagem multimodal. Máx. 4 imagens, ~10 MB cada.
const IMG_PREFIX = /^data:image\/(png|jpeg|webp|gif);base64,/;
function withImages(text, images) {
  const imgs = (Array.isArray(images) ? images : [])
    .filter(u => typeof u === 'string' && u.length < 10_000_000 && IMG_PREFIX.test(u))
    .slice(0, 4);
  if (!imgs.length) return text;
  return [
    { type: 'text', text: text || 'Analise a(s) imagem(ns) anexada(s).' },
    ...imgs.map(url => ({ type: 'image_url', image_url: { url } }))
  ];
}

// Serve só o index.html (nunca a pasta inteira: ali dentro está o .keys.json).
// Se existir mais de um (./index.html e ./public/index.html), vale o mais recente.
function pickIndex() {
  const files = [path.join(__dirname, 'index.html'), path.join(__dirname, 'public', 'index.html')].filter(f => fs.existsSync(f));
  files.sort((x, y) => fs.statSync(y).mtimeMs - fs.statSync(x).mtimeMs);
  return files;
}
app.get('/', (req, res) => {
  const [file] = pickIndex();
  if (!file) return res.status(404).send('index.html não encontrado.');
  res.setHeader('Cache-Control', 'no-store'); // nunca mostrar uma versão antiga em cache
  res.sendFile(file);
});
app.get('/api/version', (req, res) => res.json({ version: APP_VERSION }));

// Sem projectPath, usa ./workspace (separado do código e das chaves).
async function resolveProject(p) {
  const dir = p && p.trim() ? path.resolve(p.trim()) : path.join(__dirname, 'workspace');
  await fs.promises.mkdir(dir, { recursive: true });
  return dir;
}

app.get('/api/keys', (req, res) => {
  res.json({
    providers: getAllProviders().map(p => ({
      id: p.id,
      name: p.name,
      defaultModel: p.defaultModel,
      models: p.models,
      model: p.models[0], // compatibilidade com telas antigas
      explicit: p.explicit,
      hasKey: p.keys.length > 0,
      keyPreview: maskKey(p.apiKey),
      keyCount: p.keys.length,
      keys: p.keys.map((k, i) => ({ index: i, slot: i + 1, preview: maskKey(k) })),
      supportsTools: !p.isAnthropicNative,
      health: providerHealth(p.id) // pausado? modelos sem acesso?
    }))
  });
});

// Lista os modelos que a chave enxerga (e valida a chave de quebra). Sem "key", usa a salva.
app.post('/api/models', async (req, res) => {
  const { provider, key } = req.body;
  try {
    const models = await listModels(provider, key && key.trim());
    res.json({ success: true, models, recommended: recommendModels(models, 3).map(m => m.id) });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ✨ Auto: lista, ordena e TESTA os modelos da chave; devolve só os que realmente respondem.
app.post('/api/auto-models', async (req, res) => {
  const { provider, key, vision } = req.body;
  try {
    res.json({ success: true, ...(await probeModels(provider, { keyOverride: key && key.trim(), need: 3, vision: !!vision })) });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// Configurações gerais (roteamento por passo)
app.get('/api/settings', (req, res) => res.json({ routing: !!getSettings().routing }));
app.post('/api/settings', (req, res) => {
  if (typeof req.body.routing === 'boolean') saveSettings({ routing: req.body.routing });
  res.json({ success: true, routing: !!getSettings().routing });
});

// ---- IAs locais (opcional): Ollama, LM Studio ou qualquer servidor compatível com a API da OpenAI ----
app.get('/api/local', async (req, res) => {
  const locals = getLocals();
  const withStatus = await Promise.all(locals.map(async (l) => ({ ...l, up: req.query.status ? await isLocalUp(l.url) : undefined })));
  res.json({ locals: withStatus, mode: getLocalMode(), modes: LOCAL_MODES });
});
app.post('/api/local/detect', async (req, res) => {
  try {
    const url = normalizeLocalUrl(req.body.url);
    res.json({ success: true, url, models: await listLocalModels(url) });
  } catch (err) {
    res.status(400).json({ success: false, error: `Não consegui falar com o servidor: ${err.message}. Confira se o Ollama/LM Studio está aberto e o endereço.` });
  }
});
app.post('/api/local/save', (req, res) => {
  try { res.json({ success: true, locals: saveLocal(req.body || {}) }); }
  catch (err) { res.status(400).json({ success: false, error: err.message }); }
});
app.post('/api/local/remove', (req, res) => res.json({ success: true, locals: removeLocal(String(req.body?.id || '')) }));
app.post('/api/local/mode', (req, res) => {
  try { saveLocalMode(req.body?.mode); res.json({ success: true, mode: getLocalMode() }); }
  catch (err) { res.status(400).json({ success: false, error: err.message }); }
});
app.post('/api/local/test', async (req, res) => res.json(await testLocal(String(req.body?.id || ''), req.body?.model)));

app.get('/api/local/wait', (req, res) => res.json({ sec: getLocalWaitSec() }));
app.post('/api/local/wait', (req, res) => { saveLocalWaitSec(req.body?.sec); res.json({ success: true, sec: getLocalWaitSec() }); });

// ---- Supervisor local (opcional, desligado por padrão) ----
app.get('/api/supervisor', (req, res) => {
  const sup = getSupervisor();
  res.json({ ...sup, compatVersion: COMPAT_VERSION, active: !!activeSupervisor(), rolesList: LOCAL_ROLES, models: getLocals().flatMap(l => l.models.map(m => ({ key: localKey(l.id, m), local: l.name, model: m }))) });
});
app.post('/api/supervisor/save', (req, res) => {
  try { res.json({ success: true, supervisor: saveSupervisor(req.body || {}) }); }
  catch (err) { res.status(400).json({ success: false, error: err.message }); }
});
app.post('/api/supervisor/compat', async (req, res) => {
  try { res.json(await compatLocal(String(req.body?.id || ''), req.body?.model ? String(req.body.model) : undefined)); }
  catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// Prioridade entre provedores (▲▼ na tela)
app.post('/api/order', (req, res) => {
  const known = new Set(getAllProviders().map(p => p.id));
  const order = (Array.isArray(req.body.order) ? req.body.order : []).filter(id => known.has(id));
  saveProviderOrder(order);
  res.json({ success: true });
});

// Reativa um provedor pausado (ex.: depois de recarregar o saldo) e esquece modelos marcados como sem acesso
app.post('/api/reset-health', (req, res) => {
  const { provider } = req.body;
  if (!provider || !getAllProviders().some(p => p.id === provider)) return res.status(400).json({ error: 'Provedor inválido' });
  clearProviderState(provider, { keepIgnored: false }); // "Reativar" também libera modelos ignorados automaticamente
  res.json({ success: true });
});

// Ignora / restaura um modelo (vale para todas as chaves do provedor)
app.post('/api/ignore', (req, res) => {
  const { provider, model, ignore } = req.body;
  if (!provider || !getAllProviders().some(p => p.id === provider) || !model) return res.status(400).json({ error: 'Pedido inválido' });
  setIgnored(provider, String(model), !!ignore);
  res.json({ success: true });
});

app.post('/api/test-model', async (req, res) => {
  const { provider, model, key } = req.body;
  res.json(await testModel(provider, model, key && key.trim()));
});

// Compatibilidade com a tela antiga
app.post('/api/test-key', async (req, res) => {
  const { provider, key, model } = req.body;
  if (!key || !key.trim()) return res.json({ success: false, error: 'Chave vazia.' });
  res.json(await testModel(provider, model && model.trim() ? model.trim() : undefined, key.trim()));
});

// Remove UMA chave (por posição) de um provedor
app.post('/api/keys/remove', (req, res) => {
  const { provider, index } = req.body;
  if (!provider || !getAllProviders().some(p => p.id === provider) || !Number.isInteger(index)) {
    return res.status(400).json({ error: 'Pedido inválido' });
  }
  saveProviderConfig(provider, { removeKeyIndex: index });
  clearProviderState(provider); // as posições das chaves mudam: esquece cooldowns antigos
  res.json({ success: true });
});

app.post('/api/keys', (req, res) => {
  const { provider, key, models, model } = req.body;
  if (!provider || !getAllProviders().some(p => p.id === provider)) {
    return res.status(400).json({ error: 'Provedor inválido' });
  }
  const patch = {};
  if (key !== undefined) patch.apiKey = key;
  if (Array.isArray(models)) patch.models = models;
  else if (typeof model === 'string' && model.trim()) patch.models = [model.trim()]; // formato antigo
  saveProviderConfig(provider, patch);
  clearProviderState(provider);
  res.json({ success: true });
});

app.post('/api/clone', async (req, res) => {
  const { repoUrl, targetFolder, projectPath } = req.body;
  try {
    const baseDir = await resolveProject(projectPath);
    const result = await executeTool('git_clone', { repoUrl, targetFolder }, baseDir);
    const failed = result.startsWith('Erro');
    res.status(failed ? 500 : 200).json(failed ? { success: false, error: result } : { success: true, message: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Com { stream: true } responde em NDJSON (progresso ao vivo + cancelamento).
// Sem isso, responde um JSON único { reply, provider, logs } como as telas antigas esperam.
// ---- Aprovação de ações arriscadas (apagar, instalar pacotes, rede...) ----
const pendingApprovals = new Map(); // id -> resolve
app.post('/api/approve', (req, res) => {
  const p = pendingApprovals.get(String(req.body?.id || ''));
  if (!p) return res.status(404).json({ success: false, error: 'Este pedido já expirou ou foi respondido.' });
  const a = req.body.answer;
  p(a === 'always' ? 'always' : a === 'once' ? 'once' : false);
  res.json({ success: true });
});
app.get('/api/permissions', (req, res) => res.json({ mode: getPermissionMode(), modes: PERMISSION_MODES }));
app.post('/api/permissions', (req, res) => {
  try { savePermissionMode(req.body?.mode); res.json({ success: true, mode: getPermissionMode() }); }
  catch (err) { res.status(400).json({ success: false, error: err.message }); }
});

app.post('/api/agent', async (req, res) => {
  const { messages, projectPath, selectedProviders, stream, planned } = req.body;
  const logs = [];
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableFinished) ac.abort(); });

  const send = (o) => { if (!res.writableEnded) res.write(JSON.stringify(o) + '\n'); };
  if (stream) {
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders?.();
  }
  const onLog = (text) => (stream ? send({ type: 'log', text }) : logs.push(text));

  try {
    const dir = await resolveProject(projectPath);
    // "/comando args" e "/skill args" viram prompts completos; imagens viram mensagem multimodal
    const expanded = await Promise.all((messages || []).map(async (m) => {
      if (m.role !== 'user') return { role: m.role, content: m.content };
      const text = await expandSlash(m.content, dir);
      return { role: 'user', content: withImages(text ?? m.content, m.images) };
    }));
    const run = planned ? runPlanned : runAgentWithFallback; // "planned": modo etapas (projetos grandes)
    // Só dá para perguntar se a tela está conectada (modo stream). Sem isso, ações arriscadas são recusadas com segurança.
    const mine = new Set();
    const approve = stream ? (info) => new Promise((resolve) => {
      const id = crypto.randomBytes(8).toString('hex');
      const finish = (a) => { clearTimeout(timer); pendingApprovals.delete(id); mine.delete(id); resolve(a); };
      const timer = setTimeout(() => finish(false), 5 * 60 * 1000); // sem resposta em 5 min = recusa
      pendingApprovals.set(id, finish); mine.add(id);
      ac.signal.addEventListener('abort', () => finish(false), { once: true });
      send({ type: 'approval', id, ...info });
    }) : undefined;
    let result;
    try { result = await run(expanded, dir, selectedProviders, onLog, { signal: ac.signal, approve }); }
    finally { for (const id of mine) pendingApprovals.get(id)?.(false); }
    stream ? send({ type: 'done', ...result }) : res.json({ ...result, logs });
  } catch (err) {
    stream ? send({ type: 'error', error: err.message }) : res.status(500).json({ error: err.message, logs });
  }
  if (stream) res.end();
});

// ---- Anexos de arquivos (PDF, Word, Excel, zip, binários...): salvos em <projeto>/.gcode/anexos ----
app.post('/api/attach', async (req, res) => {
  try {
    const { projectPath, name, data } = req.body || {};
    if (!name || typeof data !== 'string') throw new Error('Arquivo inválido.');
    const buf = Buffer.from(data, 'base64');
    if (!buf.length) throw new Error('Arquivo vazio.');
    if (buf.length > 20 * 1024 * 1024) throw new Error(`Arquivo grande demais (${(buf.length / 1048576).toFixed(1)} MB; limite 20 MB).`);
    const dir = await resolveProject(projectPath);
    const safe = path.basename(String(name)).replace(/[^\p{L}\p{N}.\- ()\[\]_]/gu, '_').replace(/^\.+/, '_').slice(0, 120) || 'arquivo';
    const folder = path.join(dir, '.gcode', 'anexos');
    await fs.promises.mkdir(folder, { recursive: true });
    let final = safe;
    for (let n = 2; ; n++) {
      try { await fs.promises.access(path.join(folder, final)); } catch { break; }
      const ext = path.extname(safe);
      final = `${path.basename(safe, ext)}-${n}${ext}`;
    }
    const abs = path.join(folder, final);
    await fs.promises.writeFile(abs, buf);
    const rel = `.gcode/anexos/${final}`;
    let kind = 'arquivo', preview = '';
    try {
      if (DOC_EXTS.has(extOf(final))) { kind = 'documento'; preview = await readDocument(abs, rel, { maxChars: 1500 }); }
      else if (!buf.slice(0, 8000).includes(0)) { kind = 'texto'; preview = buf.toString('utf-8', 0, 1500); }
      else { kind = 'binário'; preview = `(binário de ${buf.length} bytes: o agente usa binary_info/strings/hexdump)`; }
    } catch (e) { preview = `(não consegui extrair texto agora: ${e.message})`; }
    res.json({ success: true, path: rel, kind, size: buf.length, preview });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ---- Desfazer (restaura o que o último pedido do agente criou/alterou) ----
app.get('/api/undo', async (req, res) => {
  const dir = projDir(req.query.projectPath);
  res.json({ items: await listUndo(dir) });
});
app.post('/api/undo', async (req, res) => {
  try {
    res.json(await undoLast(projDir(req.body.projectPath), req.body.id));
  } catch (err) {
    res.json({ ok: false, message: err.message });
  }
});

// ---- Skills e comandos (formato do Claude Code) ----
const projDir = (p) => (p && p.trim() ? path.resolve(p.trim()) : path.join(__dirname, 'workspace'));

app.get('/api/skills', async (req, res) => {
  const dir = projDir(req.query.projectPath);
  const skills = (await listSkills(dir)).map(({ id, name, description, scope, source, manual }) => ({ id, name, description, scope, source, manual }));
  const commands = (await listCommands(dir)).map(({ name, description, argumentHint, scope, source }) => ({ name, description, argumentHint, scope, source }));
  res.json({ skills, commands });
});

// Relatório das skills: categorias, duplicadas/sobrepostas e economia estimada. NÃO apaga nada.
app.get('/api/skills/inventory', async (req, res) => {
  try {
    const dir = await resolveProject(req.query.projectPath);
    const all = await listSkills(dir, { all: true });
    const inv = await buildInventory(all, (s) => fs.promises.readFile(path.join(s.dir, 'SKILL.md'), 'utf-8'));
    const hidden = Array.isArray(getSettings().skillsHidden) ? getSettings().skillsHidden : [];
    res.json({ success: true, ...inv, hidden });
  } catch (err) { res.status(400).json({ success: false, error: err.message }); }
});
// Ocultar/reativar uma skill para o AGENTE (reversível; os arquivos continuam onde estão)
app.post('/api/skills/hide', (req, res) => {
  const id = String(req.body?.id || '');
  if (!id) return res.status(400).json({ success: false, error: 'id ausente.' });
  const cur = new Set(Array.isArray(getSettings().skillsHidden) ? getSettings().skillsHidden : []);
  if (req.body.hidden) cur.add(id); else cur.delete(id);
  saveSettings({ skillsHidden: [...cur] });
  res.json({ success: true, hidden: [...cur] });
});
app.post('/api/skills/install', async (req, res) => {
  const { repoUrl, scope, projectPath } = req.body;
  try {
    const result = await installFromGithub(repoUrl, { scope: scope === 'project' ? 'project' : 'global', projectDir: projDir(projectPath) });
    res.json({ success: true, ...result });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.post('/api/skills/remove', async (req, res) => {
  const { kind, id, scope, projectPath } = req.body;
  try {
    await removeInstalled({ kind, id, scope, projectDir: projDir(projectPath) });
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.post('/api/broadcast', async (req, res) => {
  const { prompt, selectedProviders, images } = req.body;
  try {
    res.json({ results: await runBroadcastAll(withImages(prompt, images), selectedProviders) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Um erro inesperado não derruba o servidor no meio do seu trabalho (fica registrado no log).
process.on('uncaughtException', (e) => console.error('⚠️ Erro inesperado (o servidor continua):', e?.stack || e));
process.on('unhandledRejection', (e) => console.error('⚠️ Promessa rejeitada (o servidor continua):', e?.stack || e));

app.listen(PORT, HOST, () => {
  console.log(`Guilherme Code v${APP_VERSION} rodando em: http://localhost:${PORT}`);
  const files = pickIndex();
  if (files.length) console.log(`Interface: ${files[0]}`);
  if (files.length > 1) console.log(`Aviso: ${files[1]} também existe e está sendo ignorado (o mais recente vence).`);
});
