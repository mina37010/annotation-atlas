import { createNetwork } from './security.js';

export function createImages(origins) {
  const controller = new AbortController();
  const network = createNetwork(origins, { signal: controller.signal, maxRequests: 10000, maxBytes: 256 * 1024 * 1024, duration: 3600000 });
  const cache = new Map(), pending = new Map(), expected = new WeakMap(); let size = 0;
  async function get(url) {
    if (cache.has(url)) { const entry = cache.get(url); cache.delete(url); cache.set(url, entry); return entry; }
    if (pending.has(url)) return pending.get(url);
    const task = (async () => {
      const { data, type } = await network.bytes(url, { image: true });
      if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const blob = new Blob([data], { type }), entry = { blob, url: URL.createObjectURL(blob) };
      cache.set(url, entry); size += blob.size;
      while (size > 32 * 1024 * 1024 && cache.size > 1) { const first = cache.keys().next().value, removed = cache.get(first); size -= removed.blob.size; URL.revokeObjectURL(removed.url); cache.delete(first); }
      return entry;
    })();
    pending.set(url, task);
    try { return await task; } finally { pending.delete(url); }
  }
  async function display(img, url) {
    try { const entry = await get(url); if (!controller.signal.aborted && expected.get(img) === url) { img.src = entry.url; img.hidden = false; } }
    catch (error) { if (!controller.signal.aborted && expected.get(img) === url) img.dispatchEvent(new Event('error')); }
  }
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) { observer.unobserve(entry.target); display(entry.target, expected.get(entry.target)); }
  }, { rootMargin: '400px' });
  return {
    blob: async url => (await get(url)).blob,
    set(img, url, eager = false) { expected.set(img, url); img.removeAttribute('src'); if (eager) display(img, url); else observer.observe(img); },
    clearObservers() { observer.disconnect(); },
    dispose() { controller.abort(); observer.disconnect(); for (const entry of cache.values()) URL.revokeObjectURL(entry.url); cache.clear(); pending.clear(); },
  };
}
