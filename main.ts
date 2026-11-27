// Frost Squeeze: a lossless PNG compressor for 1280x720 screenshots.
//
// Pipeline per instance:
//   1. Decode the stored RGBA PNG.
//   2. Analyse it (opaque? grey? at most 256 colours?) and build candidate forms:
//      palette (three orderings), grey / grey+alpha / RGB / RGBA, with a tRNS key
//      when a single fully-transparent colour can carry the alpha channel.
//   3. Screen every (form, filter choice) at zlib level 6: fixed filter 0, the
//      minimum-sum heuristic, a fewest-distinct-pairs heuristic, and brute force
//      (each row's filter picked by its real deflate cost against the preceding
//      32 KiB as dictionary).
//   4. Final-encode the best two candidates with zlib level 9 and with a lazy
//      LZ77 + dynamic-Huffman deflate of my own, and the best candidate also
//      with an optimal-parse (shortest-path) deflate whose Huffman costs come
//      from the lazy parse. Keep the smallest stream; write one IDAT.
// Deterministic: no clock, no environment, no randomness; the same input bytes
// always produce the same output bytes.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync, deflateSync, constants } from 'node:zlib';

// ---------- PNG chunk writing ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(bytes, start = 0, end = bytes.length) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
const ascii = (s) => Uint8Array.from(s, (ch) => ch.charCodeAt(0));
function pngOf(chunks) {
  let size = 8;
  for (const [, d] of chunks) size += 12 + d.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  let at = 8;
  for (const [type, data] of chunks) {
    view.setUint32(at, data.length);
    out.set(ascii(type), at + 4);
    out.set(data, at + 8);
    view.setUint32(at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length));
    at += 12 + data.length;
  }
  return out;
}
function ihdrOf(w, h, ct) {
  const d = new Uint8Array(13);
  const v = new DataView(d.buffer);
  v.setUint32(0, w);
  v.setUint32(4, h);
  d[8] = 8; d[9] = ct;
  return d;
}

// ---------- PNG decoding (colour types 0, 2, 3, 4, 6) ----------
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}
function decodePng(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8, width = 0, height = 0, ct = 0, palette = null, trns = null;
  const idat = [];
  while (at < bytes.length) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    const data = bytes.subarray(at + 8, at + 8 + len);
    at += 12 + len;
    if (type === 'IHDR') { const dv = new DataView(data.buffer, data.byteOffset, 13); width = dv.getUint32(0); height = dv.getUint32(4); ct = data[9]; }
    else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
  }
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ct];
  const stride = width * ch;
  const raw = inflateSync(Buffer.concat(idat.map((d) => Buffer.from(d))));
  const samples = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1, o = y * stride, p = o - stride;
    if (ft === 0) samples.set(raw.subarray(src, src + stride), o);
    else if (ft === 1) { for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (i >= ch ? samples[o + i - ch] : 0); }
    else if (ft === 2) { for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (y > 0 ? samples[p + i] : 0); }
    else if (ft === 3) { for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (((i >= ch ? samples[o + i - ch] : 0) + (y > 0 ? samples[p + i] : 0)) >> 1); }
    else { for (let i = 0; i < stride; i++) { const a = i >= ch ? samples[o + i - ch] : 0, b = y > 0 ? samples[p + i] : 0, c = y > 0 && i >= ch ? samples[p + i - ch] : 0; samples[o + i] = raw[src + i] + paeth(a, b, c); } }
  }
  const n = width * height, rgba = new Uint8Array(n * 4);
  if (ct === 6) rgba.set(samples);
  else if (ct === 2) { const key = trns ? (trns[1] << 16) | (trns[3] << 8) | trns[5] : -1; for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) { rgba[d] = samples[s]; rgba[d + 1] = samples[s + 1]; rgba[d + 2] = samples[s + 2]; rgba[d + 3] = ((samples[s] << 16) | (samples[s + 1] << 8) | samples[s + 2]) === key ? 0 : 255; } }
  else if (ct === 0) { const key = trns ? trns[1] : -1; for (let i = 0, d = 0; i < n; i++, d += 4) { const g = samples[i]; rgba[d] = rgba[d + 1] = rgba[d + 2] = g; rgba[d + 3] = g === key ? 0 : 255; } }
  else if (ct === 4) { for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) { rgba[d] = rgba[d + 1] = rgba[d + 2] = samples[s]; rgba[d + 3] = samples[s + 1]; } }
  else { const lut = new Uint8Array((palette.length / 3) * 4); for (let e = 0; e < palette.length / 3; e++) { lut[e * 4] = palette[e * 3]; lut[e * 4 + 1] = palette[e * 3 + 1]; lut[e * 4 + 2] = palette[e * 3 + 2]; lut[e * 4 + 3] = trns && e < trns.length ? trns[e] : 255; } for (let i = 0, d = 0; i < n; i++, d += 4) { const e = samples[i]; rgba[d] = lut[e * 4]; rgba[d + 1] = lut[e * 4 + 1]; rgba[d + 2] = lut[e * 4 + 2]; rgba[d + 3] = lut[e * 4 + 3]; } }
  return { width, height, rgba };
}

// ---------- PNG row filters ----------
function filterRow(type, cur, prev, bpp, out) {
  const n = cur.length;
  if (type === 0) { out.set(cur); return; }
  if (type === 1) { for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0); return; }
  if (type === 2) { for (let i = 0; i < n; i++) out[i] = cur[i] - (prev === null ? 0 : prev[i]); return; }
  if (type === 3) { for (let i = 0; i < n; i++) out[i] = cur[i] - (((i >= bpp ? cur[i - bpp] : 0) + (prev === null ? 0 : prev[i])) >> 1); return; }
  for (let i = 0; i < n; i++) {
    const a = i >= bpp ? cur[i - bpp] : 0, b = prev === null ? 0 : prev[i], c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
    out[i] = cur[i] - paeth(a, b, c);
  }
}
function signedSum(row) {
  let s = 0;
  for (let i = 0; i < row.length; i++) { const v = row[i]; s += v < 128 ? v : 256 - v; }
  return s;
}

// ---------- image analysis ----------
function analyse(rgba) {
  const n = rgba.length >>> 2;
  let opaque = true, grey = true;
  const counts = new Map();
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!many) {
      const key = ((rgba[d] << 24) | (rgba[d + 1] << 16) | (rgba[d + 2] << 8) | rgba[d + 3]) >>> 0;
      const k = counts.get(key);
      if (k === undefined) { if (counts.size === 256) many = true; else counts.set(key, 1); }
      else counts.set(key, k + 1);
    }
  }
  let colours = null;
  if (!many) {
    colours = [...counts.entries()].map(([key, count], first) => ({
      r: (key >>> 24) & 255, g: (key >>> 16) & 255, b: (key >>> 8) & 255, a: key & 255,
      word: key, count, first,
    }));
  }
  return { opaque, grey, colours };
}
// The one fully transparent colour the image may key by tRNS instead of an alpha
// channel: every pixel opaque or that exact value at alpha 0, and no opaque pixel
// of the same value. Null when there is none.
function transparentKey(rgba, grey) {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v; else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}
function samplesOf(rgba, ct) {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) out[s] = rgba[d];
    else if (ct === 4) { out[s] = rgba[d]; out[s + 1] = rgba[d + 3]; }
    else { out[s] = rgba[d]; out[s + 1] = rgba[d + 1]; out[s + 2] = rgba[d + 2]; }
  }
  return out;
}
function paletteForm(rgba, colours, order) {
  const lum = (c) => 299 * c.r + 587 * c.g + 114 * c.b;
  const entries = [...colours].sort((x, y) => {
    const ta = x.a === 255 ? 1 : 0, tb = y.a === 255 ? 1 : 0;
    if (ta !== tb) return ta - tb;
    if (ta === 0 && x.a !== y.a) return x.a - y.a;
    if (order === 'luminance') return lum(x) - lum(y) || x.word - y.word;
    if (order === 'first') return x.first - y.first;
    return y.count - x.count || x.word - y.word;
  });
  const index = new Map(entries.map((c, i) => [c.word, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.r; plte[i * 3 + 1] = c.g; plte[i * 3 + 2] = c.b;
    if (c.a !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.a);
  const n = rgba.length >>> 2;
  const indices = new Uint8Array(n);
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    indices[i] = index.get(((rgba[d] << 24) | (rgba[d + 1] << 16) | (rgba[d + 2] << 8) | rgba[d + 3]) >>> 0);
  }
  return { plte, trns, indices };
}

// ---------- per-row filter choice ----------
const BRUTE_CONTEXT = 32768;
const BRUTE_LEVEL = 4;
function filterData(samples, width, height, bpp, choice) {
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  const trial = Array.from({ length: 5 }, () => new Uint8Array(stride + 1));
  for (let t = 0; t < 5; t++) trial[t][0] = t;
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (typeof choice === 'number') {
      raw[at] = choice;
      filterRow(choice, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
      continue;
    }
    if (choice === 'minsum') {
      let type = 0, best = Infinity;
      for (let t = 0; t < 5; t++) {
        filterRow(t, cur, prev, bpp, trial[t].subarray(1));
        const s = signedSum(trial[t].subarray(1));
        if (s < best) { best = s; type = t; }
      }
      raw.set(trial[type], at);
      continue;
    }
    // brute: deflate each trial row after the preceding 32 KiB as dictionary
    if (prev !== null && cur.length === prev.length && cur.every((v, i) => v === prev[i])) {
      raw[at] = 2; // Up on an identical row is all zeros; unbeatable
      continue;
    }
    const before = raw.subarray(Math.max(0, at - BRUTE_CONTEXT), at);
    let type = 0, best = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRow(t, cur, prev, bpp, trial[t].subarray(1));
      const len = deflateSync(trial[t], before.length === 0
        ? { level: BRUTE_LEVEL, memLevel: 9 }
        : { level: BRUTE_LEVEL, memLevel: 9, dictionary: before }).length;
      if (len < best) { best = len; type = t; }
    }
    raw.set(trial[type], at);
  }
  return raw;
}
function pairsOf(row, seen, stamp) {
  let n = 0;
  for (let i = 1; i < row.length; i++) {
    const pair = (row[i - 1] << 8) | row[i];
    if (seen[pair] !== stamp) { seen[pair] = stamp; n++; }
  }
  return n;
}
function filterDataPairs(samples, width, height, bpp) {
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  const trial = Array.from({ length: 5 }, () => new Uint8Array(stride + 1));
  for (let t = 0; t < 5; t++) trial[t][0] = t;
  const seen = new Uint32Array(65536);
  let stamp = 0;
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    let type = 0, best = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRow(t, cur, prev, bpp, trial[t].subarray(1));
      const c = pairsOf(trial[t].subarray(1), seen, ++stamp);
      if (c < best) { best = c; type = t; }
    }
    raw.set(trial[type], at);
  }
  return raw;
}

// ---------- candidate forms ----------
function formsOf(rgba) {
  const { opaque, grey, colours } = analyse(rgba);
  const forms = [];
  if (colours !== null) {
    for (const order of ['count', 'luminance', 'first']) {
      const p = paletteForm(rgba, colours, order);
      forms.push({ colourType: 3, bpp: 1, samples: p.indices, plte: p.plte, trns: p.trns, filters: order === 'count' ? [0, 'minsum', 'brute'] : ['minsum', 'brute'] });
    }
    if (!grey) return forms;
  }
  const key = opaque ? null : transparentKey(rgba, grey);
  let ct, trns = null;
  if (grey) {
    ct = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    ct = opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
  forms.push({ colourType: ct, bpp, samples: samplesOf(rgba, ct), plte: null, trns, filters: [0, 'minsum', 'pairs', 'brute'] });
  return forms;
}
function pngOfForm(width, height, form, idat) {
  const chunks = [['IHDR', ihdrOf(width, height, form.colourType)]];
  if (form.plte !== null) chunks.push(['PLTE', form.plte]);
  if (form.trns !== null) chunks.push(['tRNS', form.trns]);
  chunks.push(['IDAT', idat]);
  chunks.push(['IEND', new Uint8Array(0)]);
  return pngOf(chunks);
}
const CHUNK = (form) => (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);

// ---------- DEFLATE tables ----------
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
function lenCode(len) {
  let lo = 0, hi = 28;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (LEN_BASE[mid] <= len) lo = mid; else hi = mid - 1; }
  return lo;
}
function distCode(d) {
  let lo = 0, hi = 29;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (DIST_BASE[mid] <= d) lo = mid; else hi = mid - 1; }
  return lo;
}
const FIXED_LIT_LEN = new Uint8Array(288);
for (let i = 0; i < 288; i++) FIXED_LIT_LEN[i] = i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8;

class BitWriter {
  constructor(cap) { this.buf = new Uint8Array(cap); this.pos = 0; this.acc = 0; this.nbits = 0; }
  write(code, len) {
    this.acc |= code << this.nbits; this.nbits += len;
    while (this.nbits >= 8) { if (this.pos >= this.buf.length) throw new Error('BitWriter overflow'); this.buf[this.pos++] = this.acc & 255; this.acc >>>= 8; this.nbits -= 8; }
  }
  writeHuff(code, len) {
    let r = 0;
    for (let i = 0; i < len; i++) { r = (r << 1) | ((code >> i) & 1); }
    this.write(r, len);
  }
  flush() { if (this.nbits > 0) { this.buf[this.pos++] = this.acc & 255; this.acc = 0; this.nbits = 0; } }
  bytes() { return this.buf.subarray(0, this.pos); }
}

// Huffman code lengths for given symbol frequencies, limited to maxLen bits.
// Builds a Huffman tree, then lengthens codes (least frequent first) until the
// Kraft sum is exactly 1. Returns null when the repair cannot reach exactly 1;
// the caller then falls back to fixed Huffman.
function huffmanLengths(freq, maxLen) {
  const n = freq.length;
  const syms = [];
  for (let i = 0; i < n; i++) if (freq[i] > 0) syms.push(i);
  const lens = new Uint8Array(n);
  if (syms.length === 0) return lens;
  if (syms.length === 1) { lens[syms[0]] = 1; return lens; }
  const heap = syms.map((s) => ({ f: freq[s], s, left: null, right: null }));
  const cmp = (a, b) => (a.f - b.f) || (a.s - b.s);
  heap.sort(cmp);
  const pop = () => {
    let bi = 0;
    for (let i = 1; i < heap.length; i++) if (cmp(heap[i], heap[bi]) < 0) bi = i;
    return heap.splice(bi, 1)[0];
  };
  while (heap.length > 1) {
    const a = pop(), b = pop();
    heap.push({ f: a.f + b.f, s: Math.min(a.s, b.s), left: a, right: b });
  }
  const depth = (node, d) => {
    if (node.left === null) { lens[node.s] = d; return; }
    depth(node.left, d + 1); depth(node.right, d + 1);
  };
  depth(heap[0], 0);
  let max = 0;
  for (const s of syms) if (lens[s] > max) max = lens[s];
  if (max <= maxLen) return lens;
  for (const s of syms) if (lens[s] > maxLen) lens[s] = maxLen;
  let kraft = 0;
  for (const s of syms) kraft += 1 << (maxLen - lens[s]);
  const target = 1 << maxLen;
  const byFreq = [...syms].sort((a, b) => (freq[a] - freq[b]) || (b - a));
  let guard = 0;
  while (kraft > target) {
    const need = kraft - target;
    let picked = -1;
    for (const s of byFreq) {
      if (lens[s] < maxLen && (1 << (maxLen - 1 - lens[s])) <= need) { picked = s; break; }
    }
    if (picked === -1) return null;
    kraft -= 1 << (maxLen - 1 - lens[picked]);
    lens[picked]++;
    if (++guard > 100000) return null;
  }
  if (kraft !== target) return null;
  return lens;
}
function canonicalCodes(lens) {
  const max = Math.max(0, ...lens);
  const blCount = new Uint16Array(max + 1);
  for (let i = 0; i < lens.length; i++) if (lens[i]) blCount[lens[i]]++;
  const next = new Uint16Array(max + 1);
  let code = 0;
  for (let b = 1; b <= max; b++) { code = (code + blCount[b - 1]) << 1; next[b] = code; }
  const codes = new Uint16Array(lens.length);
  for (let i = 0; i < lens.length; i++) if (lens[i]) codes[i] = next[lens[i]]++;
  return codes;
}
function adler32(bytes) {
  let a = 1, b = 0;
  for (let i = 0; i < bytes.length;) {
    const end = Math.min(bytes.length, i + 5552);
    for (; i < end; i++) { a += bytes[i]; b += a; }
    a %= 65521; b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

// ---------- lazy LZ77 parse + custom DEFLATE emission ----------
// Op stream: sym 0-255 literal, or 257+lenCode for a match; extra holds the length
// extra-bits value; dist holds (distCode<<13)|distance-extra, -1 for a literal.
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
const MAX_CHAIN = 4096;
const BLOCK_SIZES = [131072, 524288, 0]; // block sizes tried; 0 = one block
const HASH_MASK = 32767;

function lazyParse(d) {
  const n = d.length;
  const head = new Int32Array(32768).fill(-1);
  const prev = new Int32Array(n).fill(-1);
  const sym = new Int32Array(n + 1);
  const extra = new Int32Array(n + 1);
  const dist = new Int32Array(n + 1);
  const litFreq = new Uint32Array(288);
  const distFreq = new Uint32Array(30);
  let count = 0;
  const hash3 = (i) => (((d[i] << 16) ^ (d[i + 1] << 8) ^ d[i + 2]) * 2654435761) >>> 17 & HASH_MASK;
  const insert = (i) => {
    if (i + 2 >= n) return;
    const h = hash3(i);
    prev[i] = head[h];
    head[h] = i;
  };
  const longestMatch = (i) => {
    const maxLen = Math.min(258, n - i);
    if (maxLen < 3) return [0, 0];
    const h = hash3(i);
    let cand = head[h];
    const limit = i - 32768;
    let bestLen = 2, bestDist = 0, chain = 0;
    while (cand >= limit && cand >= 0 && chain < MAX_CHAIN) {
      if (bestLen < maxLen && d[cand + bestLen] === d[i + bestLen]) {
        let len = 0;
        while (len < maxLen && d[cand + len] === d[i + len]) len++;
        if (len > bestLen) {
          bestLen = len; bestDist = i - cand;
          if (len >= maxLen) break;
        }
      } else if (bestLen === 2) {
        if (d[cand] === d[i] && d[cand + 1] === d[i + 1] && d[cand + 2] === d[i + 2]) {
          let len = 3;
          while (len < maxLen && d[cand + len] === d[i + len]) len++;
          bestLen = len; bestDist = i - cand;
          if (len >= maxLen) break;
        }
      }
      cand = prev[cand];
      chain++;
    }
    return [bestLen, bestDist];
  };
  let i = 0;
  while (i < n) {
    let len1 = 0, dist1 = 0;
    if (i + 2 < n) [len1, dist1] = longestMatch(i);
    insert(i);
    if (len1 >= 3 && i + 1 < n) {
      let len2 = 0;
      if (i + 3 < n) [len2] = longestMatch(i + 1);
      if (len2 > len1) {
        sym[count] = d[i]; extra[count] = 0; dist[count] = -1; count++;
        litFreq[d[i]]++;
        i++;
        continue;
      }
    }
    if (len1 >= 3) {
      const lc = lenCode(len1);
      sym[count] = 257 + lc;
      extra[count] = len1 - LEN_BASE[lc];
      const dc = distCode(dist1);
      dist[count] = (dc << 13) | (dist1 - DIST_BASE[dc]);
      count++;
      litFreq[257 + lc]++;
      distFreq[dc]++;
      for (let j = i + 1; j < i + len1; j++) insert(j);
      i += len1;
    } else {
      sym[count] = d[i]; extra[count] = 0; dist[count] = -1; count++;
      litFreq[d[i]]++;
      i++;
    }
  }
  sym[count] = 256; extra[count] = 0; dist[count] = -1; count++;
  litFreq[256]++;
  return { sym, extra, dist, count, litFreq, distFreq };
}

// RLE-encode a literal/length + distance code-length sequence for a dynamic block.
function rleLengths(lens, total) {
  const ops = [];
  const clFreq = new Uint32Array(19);
  let i = 0;
  while (i < total) {
    const v = lens[i];
    let run = 1;
    while (i + run < total && lens[i + run] === v) run++;
    if (v === 0) {
      let left = run;
      while (left >= 11) { const r = Math.min(left, 138); ops.push([18, r - 11]); clFreq[18]++; left -= r; }
      if (left >= 3) { ops.push([17, left - 3]); clFreq[17]++; left = 0; }
      while (left > 0) { ops.push([0, 0]); clFreq[0]++; left--; }
    } else {
      ops.push([v, 0]); clFreq[v]++;
      let left = run - 1;
      while (left >= 3) { const r = Math.min(left, 6); ops.push([16, r - 3]); clFreq[16]++; left -= r; }
      while (left > 0) { ops.push([v, 0]); clFreq[v]++; left--; }
    }
    i += run;
  }
  return { ops, clFreq };
}

function emitDynamicBlock(w, parsed, litLens, litCodes, distLens, distCodes, last) {
  let litCount = 288;
  while (litCount > 257 && litLens[litCount - 1] === 0) litCount--;
  let distCount = 30; // distance alphabet is codes 0..29 (zlib rejects ndist > 30)
  while (distCount > 1 && distLens[distCount - 1] === 0) distCount--;
  const total = litCount + distCount;
  const allLens = new Uint8Array(total);
  allLens.set(litLens.subarray(0, litCount), 0);
  allLens.set(distLens.subarray(0, distCount), litCount);
  const { ops, clFreq } = rleLengths(allLens, total);
  const clLens = huffmanLengths(clFreq, 7);
  if (clLens === null) { emitFixedBlock(w, parsed, 0, parsed.count, last); return; }
  const clCodes = canonicalCodes(clLens);
  let hclen = 19;
  while (hclen > 4 && clLens[CL_ORDER[hclen - 1]] === 0) hclen--;
  w.write(last ? 1 : 0, 1); w.write(2, 2);
  w.write(litCount - 257, 5);
  w.write(distCount - 1, 5);
  w.write(hclen - 4, 4);
  for (let k = 0; k < hclen; k++) w.write(clLens[CL_ORDER[k]], 3);
  for (const [s, ex] of ops) {
    w.writeHuff(clCodes[s], clLens[s]);
    if (s === 16) w.write(ex, 2);
    else if (s === 17) w.write(ex, 3);
    else if (s === 18) w.write(ex, 7);
  }
  const { sym, extra, dist, count } = parsed;
  for (let k = 0; k < count; k++) {
    const s = sym[k];
    w.writeHuff(litCodes[s], litLens[s]);
    if (s >= 257 && s <= 285) {
      const lc = s - 257;
      if (LEN_EXT[lc]) w.write(extra[k], LEN_EXT[lc]);
      const dc = dist[k] >> 13;
      w.writeHuff(distCodes[dc], distLens[dc]);
      if (DIST_EXT[dc]) w.write(dist[k] & 8191, DIST_EXT[dc]);
    }
  }
  if (!last) w.writeHuff(litCodes[256], litLens[256]);
}

function emitFixedBlock(w, parsed, lo, hi, last) {
  const litCode = (s) => s < 144 ? [s + 0x30, 8] : s < 256 ? [s - 144 + 0x190, 9] : s < 280 ? [s - 256, 7] : [s - 280 + 0xC0, 8];
  w.write(last ? 1 : 0, 1); w.write(1, 2);
  const { sym, extra, dist } = parsed;
  for (let k = lo; k < hi; k++) {
    const s = sym[k];
    const [c, l] = litCode(s);
    w.writeHuff(c, l);
    if (s >= 257 && s <= 285) {
      const lc = s - 257;
      if (LEN_EXT[lc]) w.write(extra[k], LEN_EXT[lc]);
      const dc = dist[k] >> 13;
      w.writeHuff(dc, 5);
      if (DIST_EXT[dc]) w.write(dist[k] & 8191, DIST_EXT[dc]);
    }
  }
  if (!last) w.writeHuff(0, 7); // end-of-block 256 in fixed Huffman is code 0, 7 bits
}

// Emit one block covering ops [lo, hi); dynamic vs fixed Huffman by estimated size.
function emitBlock(w, parsed, lo, hi, last) {
  const { sym, extra, dist } = parsed;
  const litFreq = new Uint32Array(288);
  const distFreq = new Uint32Array(30);
  for (let k = lo; k < hi; k++) {
    const s = sym[k];
    litFreq[s]++;
    if (s >= 257 && s <= 285) distFreq[dist[k] >> 13]++;
  }
  if (!last) litFreq[256]++; // every non-final block ends with its own end-of-block
  let hasDist = false;
  for (let i = 0; i < 30; i++) if (distFreq[i] > 0) { hasDist = true; break; }
  let fixedBits = 3;
  for (let k = lo; k < hi; k++) {
    const s = sym[k];
    fixedBits += FIXED_LIT_LEN[s];
    if (s >= 257 && s <= 285) { const lc = s - 257; fixedBits += LEN_EXT[lc] + 5 + DIST_EXT[dist[k] >> 13]; }
  }
  let dynBits = Infinity;
  let litLens = null, distLens = null, litCodes = null, distCodes = null;
  if (hasDist) {
    litLens = huffmanLengths(litFreq, 15);
    distLens = huffmanLengths(distFreq, 15);
    if (litLens !== null && distLens !== null) {
      litCodes = canonicalCodes(litLens);
      distCodes = canonicalCodes(distLens);
      dynBits = 3 + 5 + 5 + 4 + 19 * 3;
      for (let k = lo; k < hi; k++) {
        const s = sym[k];
        dynBits += litLens[s];
        if (s >= 257 && s <= 285) { const lc = s - 257; dynBits += LEN_EXT[lc] + distLens[dist[k] >> 13] + DIST_EXT[dist[k] >> 13]; }
      }
    }
  }
  if (dynBits < fixedBits && litLens !== null) {
    const slice = {
      sym: sym.subarray(lo, hi), extra: extra.subarray(lo, hi), dist: dist.subarray(lo, hi),
      count: hi - lo, litFreq, distFreq,
    };
    emitDynamicBlock(w, slice, litLens, litCodes, distLens, distCodes, last);
  } else {
    emitFixedBlock(w, parsed, lo, hi, last);
  }
}

// Emit the parsed op stream as raw deflate with blocks of ~blockBytes input bytes.
function emitStream(parsed, data, blockBytes) {
  const { sym, extra, count } = parsed;
  const w = new BitWriter(data.length + (data.length >> 3) + 4096);
  const ranges = [];
  if (blockBytes > 0) {
    let start = 0, bytes = 0;
    for (let k = 0; k < count; k++) {
      const s = sym[k];
      bytes += s >= 257 ? LEN_BASE[s - 257] + extra[k] : 1;
      if (bytes >= blockBytes && k + 1 < count) { ranges.push([start, k + 1]); start = k + 1; bytes = 0; }
    }
    ranges.push([start, count]);
  } else ranges.push([0, count]);
  for (let b = 0; b < ranges.length; b++) {
    const [lo, hi] = ranges[b];
    emitBlock(w, parsed, lo, hi, b === ranges.length - 1);
  }
  w.flush();
  return w.bytes();
}
function wrapZlib(raw, data) {
  const out = new Uint8Array(raw.length + 6);
  out[0] = 0x78; out[1] = 0xDA;
  out.set(raw, 2);
  const ad = adler32(data);
  out[out.length - 4] = (ad >>> 24) & 255;
  out[out.length - 3] = (ad >>> 16) & 255;
  out[out.length - 2] = (ad >>> 8) & 255;
  out[out.length - 1] = ad & 255;
  return out;
}
function zdeflateFromParsed(parsed, data) {
  let best = null;
  for (const blockBytes of BLOCK_SIZES) {
    const raw = emitStream(parsed, data, blockBytes);
    if (best === null || raw.length < best.length) best = raw;
  }
  return wrapZlib(best, data);
}
function zdeflate(data) {
  return zdeflateFromParsed(lazyParse(data), data);
}

// ---------- optimal-parse (DP) DEFLATE ----------
// Shortest-path LZ77 parse with a hash-chain matcher. Costs come from a Huffman
// code built on the lazy parse, so distances are priced as the emitted stream
// prices them (fixed-Huffman costs would underprice far matches). Block-local DP:
// a match may reference earlier blocks, never extend past its block's end.
const DP_CHAIN = 256;
const DP_BLOCK = 262144;
const BOUNDS = [3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 16, 18, 22, 26, 30, 34, 42, 50, 58, 66, 82, 98, 114, 130, 162, 194, 226, 257, 258];
function trueCosts(litLens, distLens) {
  const lit = new Float64Array(288);
  const dist = new Float64Array(30);
  for (let i = 0; i < 288; i++) lit[i] = litLens[i] || 15;
  for (let i = 0; i < 30; i++) dist[i] = distLens[i] || 15;
  return { lit, dist };
}
function dpBlock(d, lo, hi, head, prev, costs, lenCost) {
  const n = hi - lo;
  const cost = new Float64Array(n + 1).fill(Infinity);
  const choice = new Int32Array(n + 1);
  const choiceDist = new Int32Array(n + 1);
  cost[0] = 0;
  const litCost = costs.lit;
  const distCost = costs.dist;
  const hash3 = (i) => (((d[i] << 16) ^ (d[i + 1] << 8) ^ d[i + 2]) * 2654435761) >>> 17 & 32767;
  const longestMatch = (i) => {
    const maxLen = Math.min(258, d.length - i);
    if (maxLen < 3 || i + 2 >= d.length) return 0;
    const h = hash3(i);
    let cand = head[h];
    const limit = i - 32768;
    let bestLen = 2, bestDist = 0, chain = 0;
    let chainLimit = DP_CHAIN;
    while (cand >= limit && cand >= 0 && chain < chainLimit) {
      if (d[cand + bestLen] === d[i + bestLen] || bestLen === 2) {
        if (d[cand] !== d[i] || d[cand + 1] !== d[i + 1] || d[cand + 2] !== d[i + 2]) { cand = prev[cand]; chain++; continue; }
        let len = 3;
        while (len < maxLen && d[cand + len] === d[i + len]) len++;
        if (len > bestLen) {
          bestLen = len; bestDist = i - cand;
          if (len >= 128) break;
          if (len >= 32) chainLimit = Math.min(chainLimit, 256);
          if (len >= maxLen) break;
        }
      }
      cand = prev[cand];
      chain++;
    }
    return bestLen >= 3 ? (bestDist << 16) | bestLen : 0;
  };
  const insert = (i) => {
    if (i + 2 >= d.length) return;
    const h = hash3(i);
    prev[i] = head[h];
    head[h] = i;
  };
  for (let i = 0; i < n; i++) {
    const gi = lo + i;
    const c = cost[i];
    if (c === Infinity) { insert(gi); continue; }
    const packed = longestMatch(gi);
    insert(gi);
    const lc0 = c + litCost[d[gi]];
    if (lc0 < cost[i + 1]) { cost[i + 1] = lc0; choice[i + 1] = 1; }
    if (packed !== 0) {
      const L = packed & 65535;
      const D = packed >>> 16;
      const dc = distCode(D);
      const distC = distCost[dc] + DIST_EXT[dc];
      const r = n - i;
      const maxL = L < r ? L : r;
      let prevL = -1;
      for (let b = 0; b < BOUNDS.length; b++) {
        const top = BOUNDS[b];
        const l = top < maxL ? top : maxL;
        if (l >= 3 && l !== prevL) {
          prevL = l;
          const nc = c + lenCost[l] + distC;
          if (nc < cost[i + l]) { cost[i + l] = nc; choice[i + l] = l; choiceDist[i + l] = D; }
        }
        if (top >= maxL) break;
      }
    }
  }
  const ops = [];
  let i = n;
  while (i > 0) {
    const ch = choice[i];
    if (ch === 1) { ops.push({ sym: d[lo + i - 1], extra: 0, dist: -1 }); i -= 1; }
    else {
      const D = choiceDist[i];
      const lc = lenCode(ch);
      const dc = distCode(D);
      ops.push({ sym: 257 + lc, extra: ch - LEN_BASE[lc], dist: (dc << 13) | (D - DIST_BASE[dc]) });
      i -= ch;
    }
  }
  ops.reverse();
  return ops;
}
function dpParse(d, costs) {
  const lenCost = new Float64Array(259);
  for (let l = 3; l <= 258; l++) {
    const lc = lenCode(l);
    lenCost[l] = costs.lit[257 + lc] + LEN_EXT[lc];
  }
  const head = new Int32Array(32768).fill(-1);
  const prev = new Int32Array(d.length).fill(-1);
  const sym = [], extra = [], dist = [];
  for (let lo = 0; lo < d.length; lo += DP_BLOCK) {
    const hi = Math.min(d.length, lo + DP_BLOCK);
    const ops = dpBlock(d, lo, hi, head, prev, costs, lenCost);
    for (const o of ops) { sym.push(o.sym); extra.push(o.extra); dist.push(o.dist); }
  }
  sym.push(256); extra.push(0); dist.push(-1);
  return { sym: Int32Array.from(sym), extra: Int32Array.from(extra), dist: Int32Array.from(dist), count: sym.length };
}

// ---------- final encoding of one image ----------
function bestDeflate(data) {
  let best = deflateSync(data, { level: 9, memLevel: 9, strategy: constants.Z_DEFAULT_STRATEGY });
  const zz = zdeflate(data);
  if (zz.length < best.length) best = zz;
  return best;
}
function dpDeflate(data, costs) {
  const parsed = dpParse(data, costs);
  let best = null;
  for (const blk of [131072, 524288, 0]) {
    const z = wrapZlib(emitStream(parsed, data, blk), data);
    if (best === null || z.length < best.length) best = z;
  }
  return best;
}
function encode(rgba, width, height) {
  const cands = [];
  for (const form of formsOf(rgba)) {
    for (const choice of form.filters) {
      const data = choice === 'pairs'
        ? filterDataPairs(form.samples, width, height, form.bpp)
        : filterData(form.samples, width, height, form.bpp, choice);
      const z6 = deflateSync(data, { level: 6, memLevel: 8 });
      cands.push({ form, data, bytes: z6.length + CHUNK(form) });
    }
  }
  cands.sort((a, b) => a.bytes - b.bytes);
  let best = null;
  const consider = (form, z) => {
    const bytes = z.length + CHUNK(form);
    if (best === null || bytes < best.bytes) best = { form, z, bytes };
  };
  for (const c of cands.slice(0, 2)) {
    if (c === cands[0]) consider(c.form, deflateSync(c.data, { level: 9, memLevel: 9 })); // lazy+DP below cover this one
    else consider(c.form, bestDeflate(c.data));
  }
  // Optimal-parse deflate on the top candidate, with true Huffman costs taken
  // from the lazy parse (one DP run; the lazy parse is reused, not redone).
  const top = cands[0];
  const lp = lazyParse(top.data);
  consider(top.form, zdeflateFromParsed(lp, top.data));
  const litFreq = new Uint32Array(288), distFreq = new Uint32Array(30);
  for (let k = 0; k < lp.count; k++) { litFreq[lp.sym[k]]++; if (lp.sym[k] >= 257) distFreq[lp.dist[k] >> 13]++; }
  const litLens = huffmanLengths(litFreq, 15), distLens = huffmanLengths(distFreq, 15);
  if (litLens !== null && distLens !== null) consider(top.form, dpDeflate(top.data, trueCosts(litLens, distLens)));
  return pngOfForm(width, height, best.form, best.z);
}

// ---------- main ----------
const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
for (const id of readdirSync(I).sort()) {
  const image = decodePng(new Uint8Array(readFileSync(join(I, id, 'image.png'))));
  const png = encode(image.rgba, image.width, image.height);
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'image.png'), png);
}
