import { createNetwork, InputError, LIMITS } from './security.js';

const encoder = new TextEncoder();
export const MAX_ZIP_BYTES = 128 * 1024 * 1024;
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
export function safeFilename(value, fallback = 'annotation') {
  let name = String(value ?? '').normalize('NFC').replace(/[\p{Cc}\p{Cf}<>:"/\\|?*]/gu, '_').replace(/\s+/gu, ' ').replace(/^[. ]+|[. ]+$/g, '');
  name = name.replace(/\.(?:jpe?g|png|webp|gif|zip)$/i, '').replace(/[. ]+$/g, '');
  let trimmed = '', size = 0;
  for (const char of name) { const count = encoder.encode(char).length; if (size + count > 180) break; trimmed += char; size += count; }
  name = trimmed.trim().replace(/[. ]+$/g, '') || fallback;
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:[ .]|$)/i.test(name.normalize('NFKC'))) name = '_' + name;
  return name;
}
export function uniqueFilenames(items, extensions) {
  const used = new Set();
  return items.map((item, index) => {
    const base = safeFilename(item.name || item.text, `annotation-${String(index + 1).padStart(4, '0')}`);
    const extension = extensions[index] === 'png' ? 'png' : 'jpg';
    let name = `${base}.${extension}`, suffix = 2;
    while (used.has(name.toLowerCase())) name = `${base}_${suffix++}.${extension}`;
    used.add(name.toLowerCase()); return name;
  });
}
function header(size, signature) {
  const data = new Uint8Array(size); const view = new DataView(data.buffer); view.setUint32(0, signature, true); return { data, view };
}
// Stored ZIP entries: JPEG and PNG are already compressed. UTF-8 filenames use
// the ZIP language flag so Japanese names survive extraction without a library.
export function makeZip(files) {
  if (!files.length || files.length > LIMITS.annotations) throw new InputError('ZIPの画像件数が上限を超えています。');
  const parts = [], central = []; let offset = 0, centralSize = 0, total = 0;
  for (const file of files) {
    const name = encoder.encode(file.name), bytes = file.data;
    total += bytes.byteLength;
    if (total > MAX_ZIP_BYTES) throw new InputError('ZIPの画像合計が128MBを超えています。');
    if (name.length > 255 || /[/\\]/.test(file.name) || file.name.startsWith('.') || !name.length) throw new InputError('ZIPのファイル名が不正です。');
    const crc = crc32(bytes);
    const local = header(30, 0x04034b50);
    local.view.setUint16(4, 20, true); local.view.setUint16(6, 0x800, true); local.view.setUint16(12, 0x21, true);
    local.view.setUint32(14, crc, true); local.view.setUint32(18, bytes.length, true); local.view.setUint32(22, bytes.length, true); local.view.setUint16(26, name.length, true);
    const entry = header(46, 0x02014b50);
    entry.view.setUint16(4, 20, true); entry.view.setUint16(6, 20, true); entry.view.setUint16(8, 0x800, true); entry.view.setUint16(14, 0x21, true);
    entry.view.setUint32(16, crc, true); entry.view.setUint32(20, bytes.length, true); entry.view.setUint32(24, bytes.length, true); entry.view.setUint16(28, name.length, true); entry.view.setUint32(42, offset, true);
    parts.push(local.data, name, bytes); central.push(entry.data, name);
    offset += local.data.length + name.length + bytes.length; centralSize += entry.data.length + name.length;
  }
  const end = header(22, 0x06054b50);
  end.view.setUint16(8, files.length, true); end.view.setUint16(10, files.length, true); end.view.setUint32(12, centralSize, true); end.view.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.data], { type:'application/zip' });
}
export async function downloadArchive(items, origins, { signal, onProgress = () => {}, fetchImpl } = {}) {
  if (!items.length || items.length > LIMITS.annotations) throw new InputError('ダウンロードする画像を1〜5000件にしてください。');
  const controller = new AbortController(), abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once:true });
  if (signal?.aborted) controller.abort();
  const network = createNetwork(origins, { signal:controller.signal, maxRequests:LIMITS.annotations, maxBytes:MAX_ZIP_BYTES, duration:300000, ...(fetchImpl ? {fetchImpl} : {}) });
  const files = new Array(items.length), extensions = new Array(items.length); let cursor = 0, done = 0, firstError;
  async function worker() {
    while (cursor < items.length && !controller.signal.aborted) {
      const index = cursor++, item = items[index];
      try {
        const { data, type } = await network.bytes(item.fullURL, { image:true });
        files[index] = { data }; extensions[index] = type === 'image/png' ? 'png' : 'jpg';
        onProgress(++done, items.length);
      } catch (error) {
        if (!controller.signal.aborted) firstError = new InputError(`「${safeFilename(item.name || item.text, `annotation-${index + 1}`)}」を取得できません。${error.message}`);
        controller.abort(); return;
      }
    }
  }
  try {
    await Promise.all(Array.from({length:Math.min(4,items.length)}, worker));
    if (firstError) throw firstError;
    if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const names = uniqueFilenames(items, extensions);
    files.forEach((file, index) => { file.name = names[index]; });
    // Yield before CRC generation, allowing the cancel button to take effect.
    await new Promise(resolve => setTimeout(resolve, 0));
    if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    return makeZip(files);
  } finally { controller.abort(); signal?.removeEventListener('abort', abort); }
}
