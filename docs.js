import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { htmlToText } from './webfetch.js';

const execFileAsync = promisify(execFile);

/**
 * Leitor de documentos: transforma vários tipos de arquivo em TEXTO para o modelo.
 *  PDF • DOCX • XLSX • PPTX • ODT/ODS/ODP • EPUB • IPYNB • RTF • HTML • CSV/JSON/código •
 *  ZIP/JAR/APK/WAR (lista e abre itens) • TAR/TGZ • GZ • Office antigo (.doc/.xls/.ppt, extração bruta)
 * Zip/Office/EPUB são lidos com Node puro (sem dependências). PDF usa o pacote opcional "pdfjs-dist"
 * (ou o programa "pdftotext", se existir).
 */

const MAX_FILE_BYTES = 80 * 1024 * 1024;       // maior arquivo que aceitamos abrir
const MAX_ENTRY_BYTES = 30 * 1024 * 1024;      // maior item descompactado (proteção contra "zip bomb")
const MAX_TEXT_CHARS = 2_000_000;              // texto extraído guardado em cache
const DEFAULT_CHARS = 6000;                    // tamanho de cada "página" devolvida ao modelo

export const DOC_EXTS = new Set([
  'pdf', 'docx', 'xlsx', 'xlsm', 'pptx', 'odt', 'ods', 'odp', 'epub', 'ipynb', 'rtf',
  'zip', 'jar', 'war', 'apk', 'aar', 'xpi', 'tar', 'tgz', 'gz', 'doc', 'xls', 'ppt'
]);
export const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'tga', 'tif', 'tiff', 'svg']);
const VISION_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
export const extOf = (name) => path.extname(String(name)).slice(1).toLowerCase();

// ---------- Zip em Node puro ----------

function readZip(buf) {
  const minPos = Math.max(0, buf.length - 65557);
  let eocd = -1;
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('não parece um arquivo zip válido');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || p === 0xffffffff) throw new Error('zip64 (arquivo gigante) não suportado');
  const entries = [];
  for (let i = 0; i < count && i < 50000; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) break;
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString((flags & 0x800) ? 'utf8' : 'latin1');
    entries.push({ name, method, csize, usize, offset, flags, isDir: name.endsWith('/') });
    p += 46 + nlen + elen + clen;
  }
  return entries;
}

function zipRead(buf, entry) {
  if (entry.flags & 1) throw new Error(`"${entry.name}" está criptografado com senha`);
  if (entry.usize > MAX_ENTRY_BYTES) throw new Error(`"${entry.name}" é grande demais (${Math.round(entry.usize / 1048576)} MB)`);
  const o = entry.offset;
  if (o + 30 > buf.length || buf.readUInt32LE(o) !== 0x04034b50) throw new Error('item do zip corrompido');
  const start = o + 30 + buf.readUInt16LE(o + 26) + buf.readUInt16LE(o + 28);
  const raw = buf.slice(start, start + entry.csize);
  if (entry.method === 0) return raw;
  if (entry.method === 8) return zlib.inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES });
  throw new Error(`método de compressão ${entry.method} não suportado`);
}

const zipText = (buf, entries, name) => {
  const e = entries.find(x => x.name === name);
  return e ? zipRead(buf, e).toString('utf-8') : null;
};

// ---------- XML ----------

const unxml = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&amp;/g, '&');

const tidy = (s) => s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

// ---------- Formatos ----------

function docxText(buf, entries) {
  const xml = zipText(buf, entries, 'word/document.xml');
  if (xml === null) throw new Error('não é um .docx válido (falta word/document.xml)');
  const body = xml
    .replace(/<w:tab\/>/g, '\t').replace(/<w:br[^>]*\/>/g, '\n')
    .replace(/<\/w:tc>/g, '\t').replace(/<\/w:tr>/g, '\n');
  const out = [];
  for (const para of body.split(/<\/w:p>/)) {
    const text = [...para.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|(\t)|(\n)/g)].map(m => m[2] || m[3] || unxml(m[1])).join('');
    if (!text.trim()) { out.push(''); continue; }
    const h = para.match(/<w:pStyle w:val="(?:Heading|Título|Titulo)\s?(\d)"/i);
    out.push((h ? '#'.repeat(Math.min(Number(h[1]), 4)) + ' ' : '') + text.trim());
  }
  let text = tidy(out.join('\n'));
  const notes = zipText(buf, entries, 'word/footnotes.xml');
  if (notes) {
    const n = [...notes.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map(m => unxml(m[1])).join(' ').trim();
    if (n) text += `\n\n--- Notas de rodapé ---\n${n}`;
  }
  return text;
}

const colIndex = (ref) => {
  let n = 0;
  for (const ch of ref.replace(/[^A-Z]/gi, '').toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

function xlsxText(buf, entries, sheetWanted) {
  const wb = zipText(buf, entries, 'xl/workbook.xml');
  if (wb === null) throw new Error('não é um .xlsx válido (falta xl/workbook.xml)');
  const rels = zipText(buf, entries, 'xl/_rels/workbook.xml.rels') || '';
  const relTarget = {};
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = m[0].match(/\bId="([^"]+)"/)?.[1];
    const target = m[0].match(/\bTarget="([^"]+)"/)?.[1];
    if (id && target) relTarget[id] = target.startsWith('/') ? target.slice(1) : 'xl/' + target;
  }
  const sheets = [...wb.matchAll(/<sheet\b[^>]*>/g)].map((m, i) => ({
    name: unxml(m[0].match(/\bname="([^"]*)"/)?.[1] || `Planilha${i + 1}`),
    file: relTarget[m[0].match(/\br:id="([^"]+)"/)?.[1]] || `xl/worksheets/sheet${i + 1}.xml`
  }));
  const ss = zipText(buf, entries, 'xl/sharedStrings.xml');
  const shared = ss ? [...ss.matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => unxml([...m[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(t => t[1]).join(''))) : [];

  const wanted = sheetWanted ? sheets.filter((s, i) => String(i + 1) === String(sheetWanted) || s.name.toLowerCase() === String(sheetWanted).toLowerCase()) : sheets;
  if (!wanted.length) throw new Error(`planilha "${sheetWanted}" não existe. Disponíveis: ${sheets.map((s, i) => `${i + 1}=${s.name}`).join(', ')}`);

  const parts = [];
  if (!sheetWanted && sheets.length > 1) parts.push(`Planilhas: ${sheets.map((s, i) => `${i + 1}=${s.name}`).join(' | ')}`);
  for (const sh of wanted) {
    const xml = zipText(buf, entries, sh.file);
    if (xml === null) { parts.push(`## ${sh.name}\n(planilha não encontrada no arquivo)`); continue; }
    const lines = [];
    let rows = 0;
    for (const rm of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      if (++rows > 3000) { lines.push('…[mais de 3000 linhas: use outro intervalo/planilha]'); break; }
      if (rm[2] === undefined) continue; // linha vazia
      const rowNum = rm[1].match(/\br="(\d+)"/)?.[1];
      const cells = [];
      for (const cm of rm[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = cm[1];
        const ref = attrs.match(/\br="([A-Z]+)\d+"/)?.[1];
        if (!ref || cm[2] === undefined) continue;
        const type = attrs.match(/\bt="([^"]+)"/)?.[1];
        const v = cm[2].match(/<v>([\s\S]*?)<\/v>/)?.[1];
        let val = '';
        if (type === 's' && v !== undefined) val = shared[Number(v)] ?? '';
        else if (type === 'inlineStr') val = unxml([...cm[2].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(t => t[1]).join(''));
        else if (type === 'b') val = v === '1' ? 'VERDADEIRO' : 'FALSO';
        else if (v !== undefined) val = unxml(v);
        else { const f = cm[2].match(/<f[^>]*>([\s\S]*?)<\/f>/)?.[1]; if (f) val = '=' + unxml(f); }
        cells[colIndex(ref)] = String(val).replace(/[\t\r\n]+/g, ' ');
      }
      if (cells.length) lines.push(`${rowNum || rows}\t` + Array.from(cells, c => c ?? '').join('\t'));
    }
    parts.push(`## Planilha: ${sh.name} (linha<TAB>colunas A, B, C...)\n${lines.join('\n') || '(vazia)'}`);
  }
  return parts.join('\n\n');
}

function pptxText(buf, entries) {
  const slides = entries.filter(e => /^ppt\/slides\/slide\d+\.xml$/.test(e.name))
    .sort((a, b) => Number(a.name.match(/(\d+)\.xml/)[1]) - Number(b.name.match(/(\d+)\.xml/)[1]));
  if (!slides.length) throw new Error('não é um .pptx válido (nenhum slide encontrado)');
  const paras = (xml) => xml.split(/<\/a:p>/).map(p => [...p.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map(m => unxml(m[1])).join('')).filter(t => t.trim()).join('\n');
  return slides.map((s) => {
    const n = s.name.match(/(\d+)\.xml/)[1];
    let t = `## Slide ${n}\n${paras(zipRead(buf, s).toString('utf-8'))}`;
    const notes = zipText(buf, entries, `ppt/notesSlides/notesSlide${n}.xml`);
    if (notes) { const nt = paras(notes); if (nt.trim()) t += `\n[Notas do apresentador] ${nt}`; }
    return t;
  }).join('\n\n');
}

function odfText(buf, entries) {
  const xml = zipText(buf, entries, 'content.xml');
  if (xml === null) throw new Error('arquivo OpenDocument inválido (falta content.xml)');
  return tidy(unxml(xml
    .replace(/<text:tab\/>/g, '\t').replace(/<text:line-break\/>/g, '\n')
    .replace(/<\/text:(p|h)>/g, '\n').replace(/<\/table:table-cell>/g, '\t').replace(/<\/table:table-row>/g, '\n')
    .replace(/<[^>]+>/g, '')));
}

function epubText(buf, entries) {
  const container = zipText(buf, entries, 'META-INF/container.xml');
  const opfPath = container?.match(/full-path="([^"]+)"/)?.[1];
  let files = [];
  if (opfPath) {
    const opf = zipText(buf, entries, opfPath) || '';
    const base = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
    const manifest = {};
    for (const m of opf.matchAll(/<item\b[^>]*>/g)) {
      const id = m[0].match(/\bid="([^"]+)"/)?.[1];
      const href = m[0].match(/\bhref="([^"]+)"/)?.[1];
      if (id && href) manifest[id] = base + decodeURIComponent(href);
    }
    files = [...opf.matchAll(/<itemref\b[^>]*\bidref="([^"]+)"/g)].map(m => manifest[m[1]]).filter(Boolean);
  }
  if (!files.length) files = entries.filter(e => /\.(x?html?)$/i.test(e.name)).map(e => e.name).sort();
  const out = [];
  for (const f of files) {
    const e = entries.find(x => x.name === f);
    if (!e) continue;
    const t = htmlToText(zipRead(buf, e).toString('utf-8'));
    if (t.trim()) out.push(t);
  }
  if (!out.length) throw new Error('nenhum capítulo de texto encontrado no epub');
  return out.join('\n\n— — —\n\n');
}

function ipynbText(buf) {
  const nb = JSON.parse(buf.toString('utf-8'));
  const lang = nb.metadata?.kernelspec?.language || nb.metadata?.language_info?.name || 'python';
  const join = (x) => (Array.isArray(x) ? x.join('') : String(x ?? ''));
  const out = [];
  (nb.cells || []).forEach((c, i) => {
    if (c.cell_type === 'markdown') out.push(`[${i + 1}] (markdown)\n${join(c.source)}`);
    else if (c.cell_type === 'code') {
      let t = `[${i + 1}] (código)\n\`\`\`${lang}\n${join(c.source)}\n\`\`\``;
      for (const o of c.outputs || []) {
        const txt = o.text ? join(o.text) : o.data?.['text/plain'] ? join(o.data['text/plain']) : o.output_type === 'error' ? `${o.ename}: ${o.evalue}` : '';
        if (txt) t += `\n→ saída: ${txt.slice(0, 1000)}`;
        if (o.data && (o.data['image/png'] || o.data['image/jpeg'])) t += '\n→ [gráfico/imagem omitido]';
      }
      out.push(t);
    } else out.push(`[${i + 1}] (${c.cell_type})\n${join(c.source)}`);
  });
  return out.join('\n\n');
}

function rtfText(buf) {
  return tidy(buf.toString('latin1')
    .replace(/\\u(-?\d+) ?(?:\\'[0-9a-f]{2}|[^\\{}])?/g, (_, n) => { n = Number(n); return String.fromCharCode(n < 0 ? n + 65536 : n); })
    .replace(/\\'([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\(par|line)\b ?/g, '\n').replace(/\\tab\b ?/g, '\t')
    .replace(/\{\\\*[^{}]*\}/g, '').replace(/\{\\(fonttbl|colortbl|stylesheet|info)[\s\S]*?\}\}/g, '')
    .replace(/\\[a-z]+-?\d* ?/gi, '').replace(/[{}]/g, ''));
}

/** Strings imprimíveis (ASCII e UTF-16) de um binário: usado para .doc/.xls/.ppt antigos. */
export function rawStrings(buf, min = 6) {
  const out = [];
  let cur = '';
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i];
    if ((c >= 32 && c < 127) || c === 9) cur += String.fromCharCode(c);
    else { if (cur.length >= min) out.push(cur); cur = ''; }
  }
  if (cur.length >= min) out.push(cur);
  const wide = [];
  cur = '';
  for (let i = 0; i + 1 < buf.length; i += 2) {
    if (buf[i + 1] === 0 && ((buf[i] >= 32 && buf[i] < 127) || buf[i] === 9)) cur += String.fromCharCode(buf[i]);
    else { if (cur.length >= min) wide.push(cur); cur = ''; }
  }
  if (cur.length >= min) wide.push(cur);
  return [...wide, ...out].join('\n');
}

async function pdfText(buf, name, pages) {
  let pdfjs = null;
  try {
    // o pdfjs imprime avisos inofensivos sobre "canvas" ao carregar no Node: silencia só durante o import
    const w = console.warn, l = console.log; console.warn = console.log = () => {};
    try { pdfjs = await import('pdfjs-dist/legacy/build/pdf.js'); } finally { console.warn = w; console.log = l; }
  } catch {}
  if (pdfjs) {
    const lib = pdfjs.getDocument ? pdfjs : (pdfjs.default || pdfjs);
    const doc = await lib.getDocument({ data: new Uint8Array(buf), useSystemFonts: true, disableFontFace: true, isEvalSupported: false, verbosity: 0 }).promise;
    const total = doc.numPages;
    let from = 1, to = Math.min(total, 40);
    if (pages) {
      const m = String(pages).match(/^(\d+)(?:\s*-\s*(\d+))?$/);
      if (!m) throw new Error('"pages" deve ser como "3" ou "2-6"');
      from = Math.max(1, Number(m[1])); to = Math.min(total, Number(m[2] || m[1]), from + 59);
    }
    const out = [];
    for (let p = from; p <= to; p++) {
      const content = await (await doc.getPage(p)).getTextContent();
      let line = '';
      const lines = [];
      for (const it of content.items) {
        line += it.str;
        if (it.hasEOL) { lines.push(line); line = ''; }
      }
      if (line) lines.push(line);
      out.push(`--- página ${p}/${total} ---\n${lines.join('\n')}`);
    }
    await doc.destroy();
    const text = out.join('\n\n');
    const meta = `${total} páginas${to < total ? ` (lidas ${from}-${to}; use "pages" para as outras)` : ''}`;
    const body = text.replace(/--- página \d+\/\d+ ---/g, '').trim();
    return { text, meta, scanned: body.length < 5 * (to - from + 1) };
  }
  // alternativa: o programa pdftotext (poppler), se estiver instalado
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gcode-pdf-'));
  try {
    const f = path.join(tmp, 'in.pdf');
    await fs.writeFile(f, buf);
    const args = ['-layout'];
    const m = pages && String(pages).match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (m) args.push('-f', m[1], '-l', m[2] || m[1]);
    const { stdout } = await execFileAsync('pdftotext', [...args, f, '-'], { maxBuffer: 50 * 1024 * 1024, timeout: 60000, windowsHide: true });
    return { text: stdout.replace(/\f/g, '\n--- nova página ---\n'), meta: 'extraído com pdftotext', scanned: stdout.trim().length < 50 };
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    throw new Error('Para ler PDF é preciso instalar um componente UMA vez: abra o terminal na pasta do Guilherme Code e rode "npm install" (instala o pdfjs-dist).');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

async function tarList(buf, name) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gcode-tar-'));
  try {
    const f = path.join(tmp, 'a' + (/\.(tgz|gz)$/i.test(name) ? '.tgz' : '.tar'));
    await fs.writeFile(f, buf);
    const { stdout } = await execFileAsync('tar', ['-tvf', f], { maxBuffer: 20 * 1024 * 1024, timeout: 60000, windowsHide: true });
    return { tmp, f, listing: stdout.trim() };
  } catch (err) {
    await fs.rm(tmp, { recursive: true, force: true });
    throw new Error(err.code === 'ENOENT' ? 'o programa "tar" não foi encontrado neste computador' : `falha ao listar o tar: ${String(err.stderr || err.message).slice(0, 200)}`);
  }
}

function imageInfo(buf, ext) {
  try {
    if (buf.slice(1, 4).toString() === 'PNG') return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), fmt: 'PNG', alpha: [4, 6].includes(buf[25]) };
    if (buf.slice(0, 3).toString() === 'GIF') return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8), fmt: 'GIF' };
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i < buf.length - 9) {
        if (buf[i] !== 0xff) { i++; continue; }
        const mk = buf[i + 1];
        if (mk >= 0xc0 && mk <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(mk)) return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5), fmt: 'JPEG' };
        i += 2 + buf.readUInt16BE(i + 2);
      }
    }
    if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') {
      const k = buf.slice(12, 16).toString();
      if (k === 'VP8X') return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3), fmt: 'WebP' };
      if (k === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff, fmt: 'WebP' };
      if (k === 'VP8L') { const b = buf.readUInt32LE(21); return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1, fmt: 'WebP' }; }
    }
    if (buf.slice(0, 2).toString() === 'BM') return { w: buf.readInt32LE(18), h: Math.abs(buf.readInt32LE(22)), fmt: 'BMP' };
  } catch {}
  return null;
}

// ---------- API ----------

/** Extrai texto de um arquivo já carregado. Devolve { kind, text, meta, note }. */
export async function extractBuffer(buf, name, { pages, member, sheet } = {}) {
  const ext = extOf(name);
  const head = buf.slice(0, 8);

  if (buf.length > MAX_FILE_BYTES) throw new Error(`arquivo grande demais (${Math.round(buf.length / 1048576)} MB; limite ${MAX_FILE_BYTES / 1048576} MB)`);

  if (ext === 'pdf' || head.slice(0, 4).toString() === '%PDF') {
    const r = await pdfText(buf, name, pages);
    return { kind: 'PDF', text: r.text, meta: r.meta, note: r.scanned ? 'Quase nenhum texto: o PDF parece ser ESCANEADO (imagens). Converta as páginas em PNG/JPG e use view_image.' : '' };
  }

  if (ext === 'doc' || ext === 'xls' || ext === 'ppt' || head.slice(0, 4).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0]))) {
    return { kind: 'Office antigo (OLE2)', text: rawStrings(buf, 6).slice(0, MAX_TEXT_CHARS), meta: 'extração bruta de textos', note: 'Formato antigo: o texto vem sem formatação e pode ter lixo. Para melhor resultado, salve como .docx/.xlsx/.pptx.' };
  }

  if (ext === 'ipynb') return { kind: 'Jupyter Notebook', text: ipynbText(buf), meta: '' };
  if (ext === 'rtf' || buf.slice(0, 5).toString() === '{\\rtf') return { kind: 'RTF', text: rtfText(buf), meta: '' };
  if (ext === 'gz' && !/\.tar\.gz$/i.test(name)) {
    const inner = zlib.gunzipSync(buf, { maxOutputLength: MAX_ENTRY_BYTES });
    const r = await extractBuffer(inner, name.replace(/\.gz$/i, ''), { pages, member, sheet });
    return { ...r, kind: `GZ → ${r.kind}` };
  }
  if (ext === 'tar' || ext === 'tgz' || /\.tar\.gz$/i.test(name)) {
    const t = await tarList(buf, name);
    try {
      if (member) {
        const { stdout } = await execFileAsync('tar', ['-xOf', t.f, member], { maxBuffer: MAX_ENTRY_BYTES, timeout: 60000, encoding: 'buffer', windowsHide: true });
        const r = await extractBuffer(stdout, member, { pages, sheet });
        return { ...r, kind: `TAR → ${r.kind}`, meta: `item "${member}"` };
      }
      const lines = t.listing.split('\n');
      return { kind: 'TAR', text: lines.slice(0, 400).join('\n') + (lines.length > 400 ? `\n…(+${lines.length - 400} itens)` : ''), meta: `${lines.length} itens`, note: 'Use o parâmetro "member" com o caminho de um item para ler o conteúdo dele.' };
    } finally { await fs.rm(t.tmp, { recursive: true, force: true }); }
  }

  const isZip = head.slice(0, 2).toString() === 'PK';
  if (isZip || ['zip', 'jar', 'war', 'apk', 'aar', 'xpi', 'docx', 'xlsx', 'xlsm', 'pptx', 'odt', 'ods', 'odp', 'epub'].includes(ext)) {
    const entries = readZip(buf);
    const names = new Set(entries.map(e => e.name));
    const kind = names.has('word/document.xml') ? 'docx' : names.has('xl/workbook.xml') ? 'xlsx' : [...names].some(n => /^ppt\/slides\//.test(n)) ? 'pptx'
      : names.has('content.xml') && names.has('mimetype') ? 'odf' : names.has('META-INF/container.xml') ? 'epub' : 'zip';
    if (kind === 'docx') return { kind: 'Word (.docx)', text: docxText(buf, entries), meta: '' };
    if (kind === 'xlsx') return { kind: 'Excel (.xlsx)', text: xlsxText(buf, entries, sheet), meta: '' };
    if (kind === 'pptx') return { kind: 'PowerPoint (.pptx)', text: pptxText(buf, entries), meta: '' };
    if (kind === 'odf') return { kind: 'OpenDocument', text: odfText(buf, entries), meta: '' };
    if (kind === 'epub') return { kind: 'EPUB', text: epubText(buf, entries), meta: '' };

    if (member) {
      const e = entries.find(x => x.name === member) || entries.find(x => x.name.toLowerCase() === String(member).toLowerCase());
      if (!e) throw new Error(`item "${member}" não existe no zip. Veja a lista sem o parâmetro "member".`);
      const data = zipRead(buf, e);
      const r = await extractBuffer(data, e.name, { pages, sheet });
      return { ...r, kind: `ZIP → ${r.kind}`, meta: `item "${e.name}"` };
    }
    const files = entries.filter(e => !e.isDir);
    const shown = files.slice(0, 300).map(e => `${String(e.usize).padStart(9)}  ${e.name}`);
    const type = names.has('AndroidManifest.xml') ? 'APK (Android)' : names.has('META-INF/MANIFEST.MF') ? 'JAR/Java' : 'ZIP';
    return {
      kind: type,
      text: shown.join('\n') + (files.length > 300 ? `\n…(+${files.length - 300} arquivos)` : ''),
      meta: `${files.length} arquivos`,
      note: 'Use o parâmetro "member" com o caminho de um item para ler o conteúdo dele (texto, docx, xlsx...).'
    };
  }

  if (IMAGE_EXTS.has(ext)) {
    const info = imageInfo(buf, ext);
    const size = info ? `${info.fmt} ${info.w}×${info.h}px${info.alpha ? ' com transparência' : ''}, ${Math.round(buf.length / 1024)} KB` : `${Math.round(buf.length / 1024)} KB`;
    if (ext === 'svg') return { kind: 'SVG', text: buf.toString('utf-8'), meta: size };
    return { kind: 'Imagem', text: `Arquivo de imagem: ${size}.`, meta: size, note: VISION_EXTS.has(ext) ? 'Para VER a imagem use a ferramenta view_image.' : 'Este formato não pode ser enviado ao modelo; converta para PNG/JPG.' };
  }

  if (ext === 'html' || ext === 'htm' || ext === 'xhtml') return { kind: 'HTML', text: htmlToText(buf.toString('utf-8')), meta: 'convertido para texto' };

  if (buf.includes(0)) {
    const sample = buf.slice(0, 4096);
    let bad = 0;
    for (const b of sample) if (b === 0 || (b < 9) || (b > 13 && b < 32)) bad++;
    if (bad / sample.length > 0.02) throw new Error('arquivo binário: use binary_info, strings ou hexdump');
  }
  const txt = buf.toString('utf-8').replace(/^﻿/, '');
  return { kind: 'Texto', text: txt, meta: '' };
}

const cache = new Map(); // "caminho|mtime|opções" -> resultado (evita extrair o mesmo PDF a cada página pedida)

/**
 * Lê um documento do disco e devolve um trecho de texto com cabeçalho e dica de paginação.
 *  offset/maxChars: paginação em caracteres • pages: faixa de páginas do PDF • member: item de zip/tar • sheet: planilha
 */
export async function readDocument(absPath, displayName, { offset = 0, maxChars = DEFAULT_CHARS, pages, member, sheet } = {}) {
  const st = await fs.stat(absPath);
  if (!st.isFile()) throw new Error('não é um arquivo');
  if (st.size > MAX_FILE_BYTES) throw new Error(`arquivo grande demais (${Math.round(st.size / 1048576)} MB)`);

  const key = `${absPath}|${st.mtimeMs}|${pages || ''}|${member || ''}|${sheet || ''}`;
  let r = cache.get(key);
  if (!r) {
    r = await extractBuffer(await fs.readFile(absPath), displayName, { pages, member, sheet });
    if (r.text.length > MAX_TEXT_CHARS) r = { ...r, text: r.text.slice(0, MAX_TEXT_CHARS), note: `${r.note || ''} (texto cortado em ${MAX_TEXT_CHARS} caracteres)`.trim() };
    cache.set(key, r);
    if (cache.size > 20) cache.delete(cache.keys().next().value);
  }
  const total = r.text.length;
  const start = Math.min(Math.max(Number(offset) || 0, 0), total);
  const size = Math.min(Math.max(Number(maxChars) || DEFAULT_CHARS, 500), 20000);
  const end = Math.min(start + size, total);
  const header = `--- ${displayName} • ${r.kind}${r.meta ? ' • ' + r.meta : ''} • caracteres ${start}-${end} de ${total} ---`;
  const more = end < total ? `\n...[continua: chame de novo com offset=${end}]` : '';
  return `${header}\n${r.text.slice(start, end)}${more}${r.note ? `\n[${r.note}]` : ''}`;
}

/** Carrega uma imagem para ser enviada ao modelo (data URL). */
export async function loadImage(absPath, displayName) {
  const ext = extOf(absPath);
  if (!VISION_EXTS.has(ext)) {
    throw new Error(ext === 'svg' ? 'SVG é texto: leia com read_document' : `formato .${ext} não suportado pelos modelos. Use PNG, JPG, WEBP ou GIF.`);
  }
  const st = await fs.stat(absPath);
  if (st.size > 3 * 1024 * 1024) throw new Error(`imagem grande demais (${(st.size / 1048576).toFixed(1)} MB; limite 3 MB). Reduza o tamanho (ex.: abrir no Paint e redimensionar) ou recorte a parte importante.`);
  const buf = await fs.readFile(absPath);
  const info = imageInfo(buf, ext);
  const mime = ext === 'jpg' ? 'jpeg' : ext;
  return {
    dataUrl: `data:image/${mime};base64,${buf.toString('base64')}`,
    description: info ? `${info.fmt} ${info.w}×${info.h}px, ${Math.round(buf.length / 1024)} KB` : `${Math.round(buf.length / 1024)} KB`
  };
}
