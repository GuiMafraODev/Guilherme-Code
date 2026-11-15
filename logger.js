import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(__dirname, '.logs');
const KEEP_DAYS = 7;

// Nunca grava chaves de API no log.
const mask = (s) => String(s)
  .replace(/(sk-|gsk_|nvapi-|AIza|AQ\.|xai-|hf_)[\w.-]{8,}/g, '***')
  .replace(/Bearer\s+[\w.-]+/gi, 'Bearer ***')
  .replace(/([?&]key=)[\w-]+/gi, '$1***');

export function logLine(text) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const d = new Date();
    const day = d.toLocaleDateString('sv-SE'); // AAAA-MM-DD no fuso local
    const time = d.toLocaleTimeString('pt-BR');
    fs.appendFile(path.join(DIR, `${day}.log`), `[${time}] ${mask(text)}\n`, () => {});
  } catch {}
}

// Apaga logs com mais de 7 dias (roda uma vez ao iniciar)
try {
  const limit = Date.now() - KEEP_DAYS * 24 * 3600e3;
  for (const f of fs.readdirSync(DIR)) {
    const p = path.join(DIR, f);
    if (f.endsWith('.log') && fs.statSync(p).mtimeMs < limit) fs.unlinkSync(p);
  }
} catch {}
