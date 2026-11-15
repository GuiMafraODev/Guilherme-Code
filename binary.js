import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { extractBuffer } from './docs.js';

const execFileAsync = promisify(execFile);
const MAX_BIN = 64 * 1024 * 1024;
const MAX_OUT = 7000;

/** Lê até `max` bytes de um arquivo a partir de `offset` (sem carregar o arquivo inteiro). */
async function readSlice(file, offset, length) {
  const fh = await fs.open(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, offset);
    return buf.slice(0, bytesRead);
  } finally { await fh.close(); }
}

// ---------- hexdump ----------

export async function hexdumpFile(file, name, { offset = 0, length = 256 } = {}) {
  const st = await fs.stat(file);
  const off = Math.min(Math.max(Number(offset) || 0, 0), st.size);
  const len = Math.min(Math.max(Number(length) || 256, 16), 1024);
  const buf = await readSlice(file, off, len);
  const lines = [];
  for (let i = 0; i < buf.length; i += 16) {
    const row = buf.slice(i, i + 16);
    const hex = [...row].map(b => b.toString(16).padStart(2, '0'));
    const left = hex.slice(0, 8).join(' ').padEnd(23);
    const right = hex.slice(8).join(' ').padEnd(23);
    const asc = [...row].map(b => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
    lines.push(`${(off + i).toString(16).padStart(8, '0')}  ${left}  ${right}  |${asc}|`);
  }
  const end = off + buf.length;
  return `--- ${name}: bytes ${off}-${end} de ${st.size} (hex: 0x${off.toString(16)}-0x${end.toString(16)}) ---\n${lines.join('\n')}${end < st.size ? `\n...[continua: offset=${end}]` : ''}`;
}

// ---------- strings ----------

export async function stringsFile(file, name, { min = 6, offset = 0, pattern } = {}) {
  const st = await fs.stat(file);
  const start = Math.min(Math.max(Number(offset) || 0, 0), st.size);
  const minLen = Math.min(Math.max(Number(min) || 6, 3), 40);
  const buf = await readSlice(file, start, Math.min(MAX_BIN, st.size - start));
  let re = null;
  if (pattern) { try { re = new RegExp(pattern, 'i'); } catch { re = new RegExp(String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); } }

  const found = [];
  let cur = '';
  let curStart = 0;
  const push = (s, o, wide) => { if (s.length >= minLen && (!re || re.test(s))) found.push({ o: start + o, s, wide }); };
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i];
    if ((c >= 32 && c < 127) || c === 9) { if (!cur) curStart = i; cur += String.fromCharCode(c); }
    else { push(cur, curStart, false); cur = ''; }
  }
  push(cur, curStart, false);
  cur = '';
  for (let i = 0; i + 1 < buf.length; i += 2) {
    if (buf[i + 1] === 0 && ((buf[i] >= 32 && buf[i] < 127) || buf[i] === 9)) { if (!cur) curStart = i; cur += String.fromCharCode(buf[i]); }
    else { push(cur, curStart, true); cur = ''; }
  }
  push(cur, curStart, true);
  found.sort((a, b) => a.o - b.o);

  const lines = [];
  let chars = 0;
  let shown = 0;
  for (const f of found) {
    const line = `0x${f.o.toString(16).padStart(6, '0')}${f.wide ? ' (utf16)' : ''}: ${f.s.slice(0, 200)}`;
    if (chars + line.length > MAX_OUT || shown >= 300) break;
    lines.push(line); chars += line.length + 1; shown++;
  }
  const last = found[shown - 1];
  const more = shown < found.length ? `\n...[mostrando ${shown} de ${found.length}; use "pattern" para filtrar (ex.: http|senha|key) ou offset=${last ? last.o + last.s.length * (last.wide ? 2 : 1) : start} para continuar]` : '';
  return `--- ${name}: ${found.length} strings (mín. ${minLen} caracteres)${re ? ` com /${pattern}/` : ''} ---\n${lines.join('\n') || '(nenhuma)'}${more}`;
}

// ---------- binary_info ----------

const entropy = (buf) => {
  if (!buf.length) return 0;
  const h = new Array(256).fill(0);
  for (const b of buf) h[b]++;
  let e = 0;
  for (const n of h) if (n) { const p = n / buf.length; e -= p * Math.log2(p); }
  return e;
};

const cstr = (buf, off, max = 256) => {
  if (off < 0 || off >= buf.length) return '';
  let e = off;
  while (e < buf.length && buf[e] !== 0 && e - off < max) e++;
  return buf.slice(off, e).toString('latin1');
};

const MACHINE_PE = { 0x14c: 'x86 (32 bits)', 0x8664: 'x64', 0x1c0: 'ARM', 0x1c4: 'ARM Thumb-2', 0xaa64: 'ARM64', 0x200: 'Itanium' };
const MACHINE_ELF = { 3: 'x86', 0x3e: 'x86-64', 0x28: 'ARM', 0xb7: 'AArch64', 8: 'MIPS', 0xf3: 'RISC-V', 0x14: 'PowerPC', 0x15: 'PowerPC64', 0x5e: 'Xtensa' };
const PACKER_SECTIONS = /^(UPX\d|\.?upx|\.themida|\.vmp\d|\.aspack|\.adata|\.petite|\.nsp\d|\.enigma|\.MPRESS\d|\.boom|\.packed)/i;

function parsePE(buf) {
  if (buf.length < 0x100) return null;
  const pe = buf.readUInt32LE(0x3c);
  if (pe + 24 > buf.length || buf.readUInt32LE(pe) !== 0x4550) return null;
  const machine = buf.readUInt16LE(pe + 4);
  const nsec = buf.readUInt16LE(pe + 6);
  const stamp = buf.readUInt32LE(pe + 8);
  const optSize = buf.readUInt16LE(pe + 20);
  const chars = buf.readUInt16LE(pe + 22);
  const opt = pe + 24;
  const magic = buf.readUInt16LE(opt);
  const is64 = magic === 0x20b;
  const entry = buf.readUInt32LE(opt + 16);
  const imageBase = is64 ? Number(buf.readBigUInt64LE(opt + 24)) : buf.readUInt32LE(opt + 28);
  const subsystem = buf.readUInt16LE(opt + 68);
  const dirsAt = opt + (is64 ? 112 : 96);
  const nDirs = buf.readUInt32LE(opt + (is64 ? 108 : 92));
  const dir = (i) => (i < nDirs && dirsAt + i * 8 + 8 <= buf.length ? { rva: buf.readUInt32LE(dirsAt + i * 8), size: buf.readUInt32LE(dirsAt + i * 8 + 4) } : { rva: 0, size: 0 });

  const secAt = opt + optSize;
  const sections = [];
  for (let i = 0; i < Math.min(nsec, 96); i++) {
    const p = secAt + i * 40;
    if (p + 40 > buf.length) break;
    const raw = { ptr: buf.readUInt32LE(p + 20), size: buf.readUInt32LE(p + 16) };
    const fl = buf.readUInt32LE(p + 36);
    sections.push({
      name: cstr(buf, p, 8), vsize: buf.readUInt32LE(p + 8), vaddr: buf.readUInt32LE(p + 12), rawSize: raw.size, rawPtr: raw.ptr,
      flags: `${fl & 0x40000000 ? 'R' : '-'}${fl & 0x80000000 ? 'W' : '-'}${fl & 0x20000000 ? 'X' : '-'}`,
      entropy: raw.size && raw.ptr < buf.length ? entropy(buf.slice(raw.ptr, Math.min(buf.length, raw.ptr + raw.size))) : 0
    });
  }
  const rvaToOff = (rva) => {
    for (const s of sections) if (rva >= s.vaddr && rva < s.vaddr + Math.max(s.vsize, s.rawSize)) return rva - s.vaddr + s.rawPtr;
    return rva < 0x1000 ? rva : -1;
  };

  const imports = [];
  const imp = dir(1);
  if (imp.rva) {
    let p = rvaToOff(imp.rva);
    for (let n = 0; p >= 0 && p + 20 <= buf.length && n < 200; n++, p += 20) {
      const oft = buf.readUInt32LE(p);
      const nameRva = buf.readUInt32LE(p + 12);
      const ft = buf.readUInt32LE(p + 16);
      if (!nameRva && !ft) break;
      const dll = cstr(buf, rvaToOff(nameRva));
      const fns = [];
      let t = rvaToOff(oft || ft);
      const sz = is64 ? 8 : 4;
      for (let k = 0; t >= 0 && t + sz <= buf.length && k < 500; k++, t += sz) {
        const v = is64 ? buf.readBigUInt64LE(t) : BigInt(buf.readUInt32LE(t));
        if (v === 0n) break;
        const ordFlag = is64 ? (v >> 63n) & 1n : (v >> 31n) & 1n;
        if (ordFlag) fns.push(`#${Number(v & 0xffffn)}`);
        else fns.push(cstr(buf, rvaToOff(Number(v & 0x7fffffffn)) + 2, 120));
      }
      imports.push({ dll, fns });
    }
  }

  const exportsList = [];
  const exp = dir(0);
  if (exp.rva) {
    const p = rvaToOff(exp.rva);
    if (p >= 0 && p + 40 <= buf.length) {
      const nNames = Math.min(buf.readUInt32LE(p + 24), 300);
      const names = rvaToOff(buf.readUInt32LE(p + 32));
      for (let i = 0; names >= 0 && i < nNames && names + i * 4 + 4 <= buf.length; i++) exportsList.push(cstr(buf, rvaToOff(buf.readUInt32LE(names + i * 4)), 120));
    }
  }

  return {
    machine: MACHINE_PE[machine] || `0x${machine.toString(16)}`, is64, dll: !!(chars & 0x2000), stamp, entry, imageBase, subsystem,
    sections, imports, exports: exportsList, dotnet: dir(14).rva !== 0, hasSignature: dir(4).rva !== 0, hasTls: dir(9).rva !== 0
  };
}

function parseELF(buf) {
  if (buf.length < 64) return null;
  const is64 = buf[4] === 2;
  const le = buf[5] !== 2;
  const r16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const r32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const r64 = (o) => Number(le ? buf.readBigUInt64LE(o) : buf.readBigUInt64BE(o));
  const rw = (o) => (is64 ? r64(o) : r32(o));
  const type = r16(16);
  const machine = r16(18);
  const entry = rw(24);
  const shoff = is64 ? r64(40) : r32(32);
  const shentsize = is64 ? r16(58) : r16(46);
  const shnum = is64 ? r16(60) : r16(48);
  const shstrndx = is64 ? r16(62) : r16(50);
  const sh = [];
  for (let i = 0; i < Math.min(shnum, 200); i++) {
    const p = shoff + i * shentsize;
    if (!shoff || p + shentsize > buf.length) break;
    sh.push(is64
      ? { nameOff: r32(p), type: r32(p + 4), addr: r64(p + 16), off: r64(p + 24), size: r64(p + 32), link: r32(p + 40), flags: r64(p + 8) }
      : { nameOff: r32(p), type: r32(p + 4), addr: r32(p + 12), off: r32(p + 16), size: r32(p + 20), link: r32(p + 24), flags: r32(p + 8) });
  }
  const strtab = sh[shstrndx];
  for (const s of sh) s.name = strtab ? cstr(buf, strtab.off + s.nameOff, 64) : '';
  const needed = [];
  const dyn = sh.find(s => s.type === 6);
  if (dyn) {
    const str = sh[dyn.link];
    const esz = is64 ? 16 : 8;
    for (let p = dyn.off; p + esz <= dyn.off + dyn.size && p + esz <= buf.length; p += esz) {
      const tag = rw(p);
      if (tag === 0) break;
      if (tag === 1 && str) needed.push(cstr(buf, str.off + rw(p + esz / 2), 120));
    }
  }
  let interp = '';
  const ip = sh.find(s => s.name === '.interp');
  if (ip) interp = cstr(buf, ip.off, 120);
  return {
    bits: is64 ? 64 : 32, endian: le ? 'little' : 'big', type: { 1: 'objeto (.o)', 2: 'executável', 3: 'compartilhado/PIE (.so)', 4: 'core' }[type] || type,
    machine: MACHINE_ELF[machine] || `0x${machine.toString(16)}`, entry, sections: sh.filter(s => s.name), needed, interp,
    stripped: !sh.some(s => s.name === '.symtab')
  };
}

const FORMATS = [
  [(b) => b.slice(0, 2).toString() === 'MZ', 'Executável Windows (MZ/PE)'],
  [(b) => b.readUInt32BE(0) === 0x7f454c46, 'ELF (Linux/Unix)'],
  [(b) => [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(b.readUInt32BE(0)), 'Mach-O (macOS/iOS)'],
  [(b) => b.slice(0, 4).toString('latin1') === 'dex\n', 'Android DEX'],
  [(b) => b.slice(0, 4).equals(Buffer.from([0, 0x61, 0x73, 0x6d])), 'WebAssembly (.wasm)'],
  [(b) => b.slice(0, 4).toString('latin1') === '%PDF', 'PDF'],
  [(b) => b.slice(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])), 'Imagem PNG'],
  [(b) => b.slice(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])), 'Imagem JPEG'],
  [(b) => b.slice(0, 3).toString() === 'GIF', 'Imagem GIF'],
  [(b) => b.slice(0, 2).toString() === 'PK', 'Zip (jar/apk/docx/xlsx/...)'],
  [(b) => b.slice(0, 4).toString('latin1') === '7z\xbc\xaf', '7-Zip'],
  [(b) => b.slice(0, 4).toString('latin1') === 'Rar!', 'RAR'],
  [(b) => b[0] === 0x1f && b[1] === 0x8b, 'GZIP'],
  [(b) => b.slice(0, 15).toString('latin1') === 'SQLite format 3', 'Banco SQLite'],
  [(b) => b.slice(0, 4).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0])), 'Office antigo (OLE2: .doc/.xls/.ppt/.msi)'],
  [(b) => b.slice(0, 4).toString('latin1') === '\x1bLua', 'Bytecode Lua'],
  [(b) => b.slice(0, 7).toString('latin1') === '!<arch>', 'Biblioteca estática (ar/.a/.lib)'],
  [(b) => b.slice(0, 4).toString('latin1') === 'OggS', 'Áudio/vídeo Ogg'],
  [(b) => b.slice(0, 3).toString('latin1') === 'ID3', 'Áudio MP3']
];

export async function binaryInfo(file, name) {
  const st = await fs.stat(file);
  const buf = await readSlice(file, 0, Math.min(st.size, MAX_BIN));
  const out = [`--- ${name} ---`, `Tamanho: ${st.size} bytes${st.size > MAX_BIN ? ` (analisados só os primeiros ${MAX_BIN / 1048576} MB)` : ''}`];
  if (st.size <= 200 * 1024 * 1024) {
    out.push(`SHA-256: ${crypto.createHash('sha256').update(buf).digest('hex')}`, `MD5: ${crypto.createHash('md5').update(buf).digest('hex')}`);
  }
  const ent = entropy(buf.slice(0, Math.min(buf.length, 4 * 1024 * 1024)));
  out.push(`Entropia: ${ent.toFixed(2)}/8${ent > 7.2 ? ' (ALTA: possivelmente compactado, criptografado ou empacotado)' : ''}`);

  let type = buf.length >= 8 ? (FORMATS.find(([f]) => { try { return f(buf); } catch { return false; } })?.[1] || 'desconhecido (provavelmente dados brutos ou texto)') : 'muito pequeno';
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0xcafebabe) type = buf.readUInt32BE(4) < 30 ? 'Mach-O universal (fat)' : `Classe Java (versão do bytecode: Java ${buf.readUInt16BE(6) - 44})`;
  out.push(`Tipo: ${type}`);

  if (type.startsWith('Executável Windows')) {
    const pe = (() => { try { return parsePE(buf); } catch { return null; } })();
    if (!pe) out.push('(cabeçalho MZ sem estrutura PE válida: DOS/16 bits ou arquivo corrompido)');
    else {
      out.push(`${pe.dll ? 'DLL' : 'Executável'} ${pe.is64 ? 'PE32+' : 'PE32'} • arquitetura ${pe.machine} • subsistema ${pe.subsystem === 2 ? 'GUI' : pe.subsystem === 3 ? 'console' : pe.subsystem}`);
      out.push(`Compilado em: ${pe.stamp ? new Date(pe.stamp * 1000).toISOString().slice(0, 19).replace('T', ' ') + ' UTC (pode ser falsificado)' : '(zerado)'}`);
      out.push(`Entry point (RVA): 0x${pe.entry.toString(16)} • ImageBase: 0x${pe.imageBase.toString(16)}`);
      if (pe.dotnet) out.push('⚙ Assembly .NET: use re_tool com ilspycmd para decompilar para C#.');
      if (pe.hasSignature) out.push('Possui assinatura digital (Authenticode).');
      if (pe.hasTls) out.push('Possui callbacks TLS (atenção em análise de anti-debug).');
      out.push('Seções (nome, endereço virtual, tamanho no disco, permissões, entropia):');
      for (const s of pe.sections) out.push(`  ${s.name.padEnd(8)} va=0x${s.vaddr.toString(16).padEnd(8)} raw=${String(s.rawSize).padEnd(9)} ${s.flags} H=${s.entropy.toFixed(2)}${PACKER_SECTIONS.test(s.name) ? '  ← nome típico de empacotador' : ''}${s.entropy > 7.2 ? '  ← entropia alta' : ''}${s.flags === 'RWX' ? '  ← RWX (suspeito)' : ''}`);
      let total = 0;
      out.push(`Imports (${pe.imports.length} DLLs):`);
      for (const d of pe.imports) {
        const line = `  ${d.dll}: ${d.fns.slice(0, 40).join(', ')}${d.fns.length > 40 ? ` …(+${d.fns.length - 40})` : ''}`;
        total += line.length;
        if (total > 4500) { out.push('  …(lista de imports cortada; use strings/re_tool para ver o resto)'); break; }
        out.push(line);
      }
      if (pe.exports.length) out.push(`Exports (${pe.exports.length}): ${pe.exports.slice(0, 60).join(', ')}${pe.exports.length > 60 ? ' …' : ''}`);
    }
  } else if (type.startsWith('ELF')) {
    const elf = (() => { try { return parseELF(buf); } catch { return null; } })();
    if (elf) {
      out.push(`ELF ${elf.bits} bits • ${elf.endian}-endian • ${elf.type} • ${elf.machine} • ${elf.stripped ? 'sem símbolos (stripped)' : 'com símbolos'}`);
      out.push(`Entry point: 0x${elf.entry.toString(16)}${elf.interp ? ` • interpretador: ${elf.interp}` : ''}`);
      if (elf.needed.length) out.push(`Bibliotecas necessárias: ${elf.needed.join(', ')}`);
      out.push('Seções:');
      for (const s of elf.sections.slice(0, 60)) out.push(`  ${s.name.padEnd(18)} addr=0x${s.addr.toString(16).padEnd(10)} off=0x${s.off.toString(16).padEnd(8)} size=${s.size}`);
    }
  } else if (type.startsWith('Mach-O') && buf.readUInt32BE(0) !== 0xcafebabe) {
    const le = [0xcefaedfe, 0xcffaedfe].includes(buf.readUInt32BE(0));
    const cpu = le ? buf.readUInt32LE(4) : buf.readUInt32BE(4);
    const ft = le ? buf.readUInt32LE(12) : buf.readUInt32BE(12);
    out.push(`CPU: ${{ 7: 'x86', 0x01000007: 'x86-64', 12: 'ARM', 0x0100000c: 'ARM64' }[cpu] || '0x' + cpu.toString(16)} • tipo: ${{ 1: 'objeto', 2: 'executável', 6: 'biblioteca (dylib)', 8: 'bundle' }[ft] || ft}`);
  } else if (type.startsWith('Zip')) {
    try {
      const r = await extractBuffer(buf, name);
      out.push(`Conteúdo: ${r.kind}${r.meta ? ' • ' + r.meta : ''}`);
      if (/APK|JAR|ZIP/.test(r.kind)) out.push(r.text.split('\n').slice(0, 40).join('\n'));
    } catch (e) { out.push(`(não consegui abrir como zip: ${e.message})`); }
  }
  out.push('Próximos passos: strings (com pattern), hexdump (offset), re_tool (disassembly/decompilação, se instalado).');
  return out.join('\n');
}

// ---------- re_tool: programas externos de engenharia reversa (se estiverem instalados) ----------

const WIN = process.platform === 'win32';
const HEX = /^0x[0-9a-f]{1,16}$/i;
const SYM = /^(?:0x[0-9a-f]{1,16}|[\w.$@:<>~-]{1,100})$/i;
const binCache = new Map();

async function which(bin) {
  if (binCache.has(bin)) return binCache.get(bin);
  let ok = false;
  try { await execFileAsync(WIN ? 'where' : 'which', [bin], { windowsHide: true, timeout: 8000 }); ok = true; } catch {}
  binCache.set(bin, ok);
  return ok;
}

const RE_TOOLS = {
  objdump: {
    bins: ['objdump'], install: 'binutils (Linux: apt install binutils • Windows: via MSYS2 ou WSL)',
    actions: {
      headers: (f) => ['-x', f], sections: (f) => ['-h', f], symbols: (f) => ['-t', f],
      disasm: (f, o) => {
        const a = ['-d', '-M', 'intel'];
        if (o.start) a.push(`--start-address=${o.start}`);
        if (o.stop) a.push(`--stop-address=${o.stop}`);
        return [...a, f];
      }
    }
  },
  readelf: { bins: ['readelf'], install: 'binutils', actions: { headers: (f) => ['-h', f], sections: (f) => ['-S', '-W', f], symbols: (f) => ['-s', '-W', f], dynamic: (f) => ['-d', f] } },
  nm: { bins: ['nm'], install: 'binutils', actions: { symbols: (f) => ['-C', f], dynamic: (f) => ['-D', '-C', f] } },
  javap: { bins: ['javap'], install: 'JDK (Java Development Kit) — adoptium.net', actions: { headers: (f) => ['-p', f], disasm: (f) => ['-c', '-p', f] } },
  r2: {
    bins: ['r2', 'radare2', 'rizin'], install: 'radare2 — github.com/radareorg/radare2/releases (zip para Windows; coloque a pasta bin no PATH)',
    actions: {
      info: (f) => ['-q', '-e', 'scr.color=0', '-c', 'iI', f], imports: (f) => ['-q', '-e', 'scr.color=0', '-c', 'ii', f],
      exports: (f) => ['-q', '-e', 'scr.color=0', '-c', 'iE', f], strings: (f) => ['-q', '-e', 'scr.color=0', '-c', 'iz', f],
      sections: (f) => ['-q', '-e', 'scr.color=0', '-c', 'iS', f], functions: (f) => ['-q', '-e', 'scr.color=0', '-c', 'aaa;afl', f],
      disasm: (f, o) => ['-q', '-e', 'scr.color=0', '-c', `aaa;pdf @ ${o.symbol}`, f]
    }
  },
  jadx: { bins: ['jadx'], install: 'jadx — github.com/skylot/jadx/releases (precisa de Java; coloque a pasta bin no PATH)', long: true, outDir: true, actions: { decompile: (f, o) => ['-d', o.out, f] } },
  ilspycmd: { bins: ['ilspycmd'], install: '.NET SDK + comando: dotnet tool install -g ilspycmd', long: true, outDir: true, actions: { decompile: (f, o) => ['-p', '-o', o.out, f] } },
  dumpbin: { bins: ['dumpbin'], install: 'Visual Studio Build Tools (abra o "Developer Command Prompt")', actions: { headers: (f) => ['/headers', f], imports: (f) => ['/imports', f], exports: (f) => ['/exports', f], disasm: (f) => ['/disasm', f] } }
};

const outCache = new Map();

export async function reStatus() {
  const lines = [];
  for (const [name, t] of Object.entries(RE_TOOLS)) {
    let found = '';
    for (const b of t.bins) if (await which(b)) { found = b; break; }
    lines.push(`${found ? '✅' : '⬜'} ${name.padEnd(9)} ações: ${Object.keys(t.actions).join(', ')}${found ? '' : `  — não instalado: ${t.install}`}`);
  }
  return `Ferramentas externas de engenharia reversa:\n${lines.join('\n')}\n\nSem nenhuma delas, binary_info + strings + hexdump já funcionam (são nativas).`;
}

async function listDir(dir, limit = 5000) {
  let n = 0;
  const top = [];
  const stack = [dir];
  while (stack.length && n < limit) {
    const d = stack.pop();
    let ents = [];
    try { ents = await fs.readdir(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (e.isDirectory()) stack.push(path.join(d, e.name)); else n++;
      if (d === dir && top.length < 25) top.push(e.name + (e.isDirectory() ? '/' : ''));
    }
  }
  return { n, top };
}

/** Roda uma ação de um programa externo (sem shell; argumentos montados por nós, nunca livres). */
export async function reTool(root, file, displayPath, { tool, action, symbol, start, stop, offset = 0 } = {}) {
  if (tool === 'status' || !tool) return reStatus();
  const t = RE_TOOLS[tool];
  if (!t) throw new Error(`ferramenta desconhecida "${tool}". Use tool="status" para ver as disponíveis.`);
  const fn = t.actions[action];
  if (!fn) throw new Error(`ação "${action}" inválida para ${tool}. Ações: ${Object.keys(t.actions).join(', ')}`);

  let bin = '';
  for (const b of t.bins) if (await which(b)) { bin = b; break; }
  if (!bin) return `${tool} não está instalado neste computador. Instalação: ${t.install}. (tool="status" lista tudo; binary_info/strings/hexdump funcionam sem instalar nada.)`;

  const opts = {};
  if (action === 'disasm' && tool === 'r2') {
    if (!symbol || !SYM.test(symbol)) throw new Error('para r2/disasm informe "symbol" (nome de função ou endereço 0x...). Veja os nomes com action=functions.');
    opts.symbol = symbol;
  }
  if (start) { if (!HEX.test(start)) throw new Error('"start" deve ser um endereço hexadecimal como 0x401000'); opts.start = start; }
  if (stop) { if (!HEX.test(stop)) throw new Error('"stop" deve ser um endereço hexadecimal como 0x401200'); opts.stop = stop; }

  if (t.outDir) {
    const base = path.basename(displayPath).replace(/[^\w.-]/g, '_');
    opts.out = path.join(root, '.gcode', 're', `${base}-${tool}`);
    await fs.mkdir(opts.out, { recursive: true });
  }

  const key = `${tool}|${action}|${file}|${symbol || ''}|${start || ''}|${stop || ''}`;
  let result = outCache.get(key);
  if (!result) {
    const args = fn(file, opts);
    const cmd = WIN && /^(jadx|r2|radare2)$/.test(bin) ? 'cmd.exe' : bin;
    const finalArgs = cmd === 'cmd.exe' ? ['/d', '/c', bin + (bin === 'jadx' ? '.bat' : ''), ...args] : args;
    try {
      const { stdout, stderr } = await execFileAsync(cmd, finalArgs, { cwd: root, timeout: t.long ? 600000 : 120000, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
      result = { text: (stdout + (stdout.trim() ? '' : stderr)).replace(/\r/g, ''), out: opts.out };
    } catch (err) {
      if (err.killed) throw new Error('tempo esgotado (a análise demorou demais)');
      if (/maxBuffer/i.test(String(err.message))) throw new Error('saída enorme: restrinja com start/stop (disasm) ou use outra ação');
      // jadx/ilspy costumam sair com erro mesmo tendo gerado a maior parte dos arquivos
      if (opts.out && (await listDir(opts.out, 10)).n > 0) result = { text: `(terminou com avisos)\n${String(err.stderr || err.message).slice(0, 600)}`, out: opts.out };
      else throw new Error(`${tool} falhou: ${String(err.stderr || err.message).replace(/\s+/g, ' ').slice(0, 400)}`);
    }
    outCache.set(key, result);
    if (outCache.size > 6) outCache.delete(outCache.keys().next().value);
  }

  if (result.out) {
    const rel = path.relative(root, result.out).split(path.sep).join('/');
    const { n, top } = await listDir(result.out);
    return `${tool} ${action}: ${n} arquivos gerados em ${rel}/\nPrimeiros itens: ${top.join(', ') || '(nenhum)'}\nExplore com project_tree (path="${rel}"), project_map e read_file_chunk.${result.text.trim() ? `\n${result.text.slice(0, 800)}` : ''}`;
  }

  const lines = result.text.split('\n');
  const from = Math.min(Math.max(Number(offset) || 0, 0), lines.length);
  let chars = 0;
  let i = from;
  const outLines = [];
  for (; i < lines.length && chars + lines[i].length < MAX_OUT; i++) { outLines.push(lines[i]); chars += lines[i].length + 1; }
  return `--- ${tool} ${action} ${displayPath}: linhas ${from + 1}-${i} de ${lines.length} ---\n${outLines.join('\n')}${i < lines.length ? `\n...[continua: offset=${i}]` : ''}`;
}
