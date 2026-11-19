export const LIMITS = Object.freeze({ jsonBytes: 8 * 1024 * 1024, totalJSONBytes: 32 * 1024 * 1024, nodes: 150000, depth: 40, string: 100000, canvases: 500, annotations: 5000, pages: 128, origins: 16, timeout: 15000, loadTime: 60000, imageBytes: 12 * 1024 * 1024, imagePixels: 16777216, imageSide: 8192 });
export class InputError extends Error { constructor(message) { super(message); this.name = 'InputError'; } }
export function publicURL(value, base) {
  try {
    if (typeof value !== 'string' || !value || value.length > 4096) return '';
    const u = new URL(value, base || undefined);
    const host = u.hostname.toLowerCase().replace(/\.$/, '');
    if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || u.port) return '';
    // Reject all IP literals (also alternate numeric spellings normalized by URL),
    // single-label names, and local/reserved suffixes. No client-side DNS assumption.
    if (!host.includes('.') || /[:\[\]]/.test(host) || /^[\d.]+$/.test(host) || /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid|onion|arpa)$/.test(host)) return '';
    u.hostname = host;
    return u.href;
  } catch { return ''; }
}
export function validateJSON(value, limits = LIMITS) {
  const stack = [[value, 0]], seen = new WeakSet(); let nodes = 0;
  while (stack.length) {
    const [entry, depth] = stack.pop();
    if (++nodes > limits.nodes || depth > limits.depth) throw new InputError('JSONの件数または入れ子が上限を超えています。');
    if (typeof entry === 'string' && entry.length > limits.string) throw new InputError('JSON内の文字列が長すぎます。');
    if (typeof entry === 'number' && !Number.isFinite(entry)) throw new InputError('JSONに不正な数値があります。');
    if (entry && typeof entry === 'object') {
      if (seen.has(entry)) throw new InputError('JSONに循環参照があります。'); seen.add(entry);
      for (const key of Object.keys(entry)) {
        if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new InputError('JSONに許可されていないキーがあります。');
        stack.push([entry[key], depth + 1]);
        if (stack.length + nodes > limits.nodes) throw new InputError('JSONの件数が上限を超えています。');
      }
    }
  }
  return value;
}
export function parseJSON(text, limits = LIMITS) {
  if (new TextEncoder().encode(text).byteLength > limits.jsonBytes) throw new InputError('JSONは8MB以下にしてください。');
  return validateJSON(JSON.parse(text), limits);
}
// Work with text only. This is deliberately not an HTML sanitizer or DOM parser:
// stripped markup is never inserted as HTML, so it cannot load resources or run.
export function plainText(value) {
  const input = String(value ?? '').slice(0, LIMITS.string), lower = input.toLowerCase();
  let out = '', cursor = 0;
  while (cursor < input.length) {
    const start = input.indexOf('<', cursor);
    if (start < 0) { out += input.slice(cursor); break; }
    out += input.slice(cursor, start);
    const end = input.indexOf('>', start + 1);
    if (end < 0) break;
    const tag = input.slice(start + 1, end).trim().match(/^([a-z][a-z0-9]*)\b/i)?.[1]?.toLowerCase();
    if (['script','style','iframe','object'].includes(tag)) {
      const close = lower.indexOf('</' + tag, end + 1);
      if (close < 0) break;
      const closeEnd = input.indexOf('>', close); if (closeEnd < 0) break;
      cursor = closeEnd + 1;
    } else cursor = end + 1;
  }
  return out
    .replace(/&(#(?:x[0-9a-f]+|\d+)|amp|lt|gt|quot|apos|nbsp);/gi, (match, code) => {
      if (code[0] === '#') { const n = code[1]?.toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1)); return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : ''; }
      return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' })[code.toLowerCase()] ?? match;
    });
}
export function collectOrigins(json, base) {
  validateJSON(json);
  const origins = new Set();
  if (base) { const url = publicURL(base); if (url) origins.add(new URL(url).origin); }
  const walk = (value, key = '') => {
    if (typeof value === 'string' && ['id', '@id', 'on', 'target', 'source', 'full', 'otherContent', 'annotations'].includes(key)) {
      const url = publicURL(value, base); if (url) origins.add(new URL(url).origin);
    } else if (Array.isArray(value)) value.forEach(entry => walk(entry, key));
    else if (value && typeof value === 'object') Object.entries(value).forEach(([k, v]) => walk(v, k));
  };
  walk(json);
  if (origins.size > LIMITS.origins) throw new InputError('接続先が16件を超えています。');
  return [...origins].sort();
}
export async function readLimited(response, maxBytes, consume = () => {}) {
  if (!response.ok || response.type === 'opaqueredirect' || response.redirected) { await response.body?.cancel(); throw new InputError(`取得できません（HTTP ${response.status}）。リダイレクトは許可されていません。`); }
  if (Number(response.headers.get('content-length')) > maxBytes) { await response.body?.cancel(); throw new InputError('取得データが容量上限を超えています。'); }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength; consume(value.byteLength);
      if (size > maxBytes) throw new InputError('取得データが容量上限を超えています。');
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  const result = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}
export function createNetwork(origins, { signal, maxRequests = 128, maxBytes = LIMITS.totalJSONBytes, duration = LIMITS.loadTime, fetchImpl = fetch } = {}) {
  const allowed = new Set(origins), start = Date.now(); let requests = 0, totalBytes = 0, active = 0;
  const waiting = [];
  function check() { if (signal?.aborted) throw new DOMException('Aborted', 'AbortError'); if (Date.now() - start > duration) throw new InputError('読み込み時間が上限を超えました。'); }
  async function bytes(value, { image = false } = {}) {
    check(); const url = publicURL(value);
    if (!url || !allowed.has(new URL(url).origin)) throw new InputError('確認されていない接続先を拒否しました。');
    if (++requests > maxRequests) throw new InputError('通信回数が上限を超えました。');
    // A semaphore bounds even requests submitted by the isolated viewer.
    if (active >= 4) await new Promise((resolve, reject) => {
      const entry = { resolve, reject }; waiting.push(entry);
      if (signal) { entry.abort = () => { const i = waiting.indexOf(entry); if (i >= 0) waiting.splice(i, 1); reject(new DOMException('Aborted', 'AbortError')); }; signal.addEventListener('abort', entry.abort, { once: true }); }
    });
    else active++;
    const request = new AbortController();
    const abort = () => request.abort(signal?.reason); signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => request.abort(new InputError('通信がタイムアウトしました。')), Math.min(LIMITS.timeout, Math.max(1, duration - (Date.now() - start))));
    try {
      check();
      const response = await fetchImpl(url, { signal: request.signal, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', mode: 'cors' });
      if (!response.ok || response.redirected || response.type === 'opaqueredirect') { await response.body?.cancel(); throw new InputError(`取得できません（HTTP ${response.status}）。リダイレクトは許可されていません。`); }
      const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() || '';
      if (image ? !['image/jpeg', 'image/png'].includes(type) : !(type === 'application/json' || type === 'application/ld+json' || type.endsWith('+json'))) { await response.body?.cancel(); throw new InputError('取得データの形式が許可されていません。'); }
      const data = await readLimited(response, image ? LIMITS.imageBytes : LIMITS.jsonBytes, count => { totalBytes += count; if (totalBytes > maxBytes) throw new InputError('取得データの合計容量が上限を超えました。'); });
      check();
      if (image) imageDimensions(data);
      return { data, type };
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      const next = waiting.shift();
      if (next) { signal?.removeEventListener('abort', next.abort); next.resolve(); } else active--;
    }
  }
  return { origins: [...allowed], bytes, async json(url) { const { data } = await bytes(url); return parseJSON(new TextDecoder('utf-8', { fatal: true }).decode(data)); } };
}
export function imageDimensions(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); let width = 0, height = 0;
  if (bytes.length >= 24 && view.getUint32(0) === 0x89504e47 && view.getUint32(4) === 0x0d0a1a0a && view.getUint32(12) === 0x49484452) { width = view.getUint32(16); height = view.getUint32(20); }
  else if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 8 < bytes.length) {
      if (bytes[i++] !== 0xff) break;
      while (bytes[i] === 0xff) i++;
      const marker = bytes[i++]; if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
      if (i + 2 > bytes.length) break; const length = view.getUint16(i); if (length < 2 || i + length > bytes.length) break;
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) { height = view.getUint16(i + 3); width = view.getUint16(i + 5); break; }
      i += length;
    }
  }
  if (!(width > 0 && height > 0) || width > LIMITS.imageSide || height > LIMITS.imageSide || width * height > LIMITS.imagePixels) throw new InputError('画像の形式または寸法が上限を超えています。');
  return { width, height };
}
