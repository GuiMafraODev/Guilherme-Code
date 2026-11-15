/**
 * Conserta os JSONs quebrados que modelos fracos mandam nos argumentos das ferramentas.
 *
 * Consertos que NÃO mudam o conteúdo (sempre permitidos):
 *   - cercas ```json ... ``` e texto solto antes/depois do objeto
 *   - quebras de linha/tabs "crus" dentro de textos (o erro mais comum ao escrever código)
 *   - vírgula sobrando antes de } ou ]
 * Conserto que pode perder o final (só com allowTruncated, ou seja, em ferramentas que só LEEM):
 *   - resposta cortada no meio: fecha aspas/chaves que faltam
 * Nunca completamos um write_file/edit_file cortado: gravaria um arquivo pela metade.
 */

function scan(s) {
  let out = '';
  let inStr = false;
  let esc = false;
  const stack = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) { out += c; esc = false; continue; }
      if (c === '\\') { out += c; esc = true; continue; }
      if (c === '"') { out += c; inStr = false; continue; }
      if (c === '\n') { out += '\\n'; continue; }
      if (c === '\r') { out += '\\r'; continue; }
      if (c === '\t') { out += '\\t'; continue; }
      out += c;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '{') stack.push('}');
    else if (c === '[') stack.push(']');
    else if (c === '}' || c === ']') {
      stack.pop();
      if (!stack.length) { out += c; break; } // fim do primeiro objeto completo: descarta texto solto depois
    }
    else if (c === ',') {
      let j = i + 1;
      while (j < s.length && /\s/.test(s[j])) j++;
      if (s[j] === '}' || s[j] === ']') continue; // vírgula sobrando
    }
    out += c;
  }
  return { out, inStr, esc, stack };
}

/** Retorna { value, repaired } ou lança erro. */
export function parseArgs(raw, { allowTruncated = false } = {}) {
  const original = String(raw ?? '').trim() || '{}';
  try { return { value: JSON.parse(original), repaired: '' }; } catch {}

  let s = original.replace(/^```[a-z]*\s*/i, '').replace(/\s*```\s*$/, '');
  const first = s.indexOf('{');
  if (first > 0) s = s.slice(first);

  const r = scan(s);
  try { return { value: JSON.parse(r.out), repaired: 'formato' }; } catch {}

  if (allowTruncated && r.stack.length) {
    let t = r.out;
    if (r.esc) t = t.slice(0, -1);
    if (r.inStr) t += '"';
    t = t.replace(/,\s*$/, '') + r.stack.reverse().join('');
    try { return { value: JSON.parse(t), repaired: 'cortado' }; } catch {}
  }
  throw new Error('JSON inválido ou cortado');
}
