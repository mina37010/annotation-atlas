const array = value => value == null ? [] : Array.isArray(value) ? value : [value];
export const idOf = value => typeof value === 'string' ? value : value?.id || value?.['@id'] || '';
export function labelOf(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(v => labelOf(v?.['@value'] ?? v)).join(' / ');
  if (!value || typeof value !== 'object') return '';
  return labelOf(value['@value'] ?? value.ja ?? value.en ?? value.none ?? Object.values(value)[0]);
}
export function httpURL(value, base) {
  try { if (!value) return ''; const u = new URL(value, base || undefined); return ['https:', 'http:'].includes(u.protocol) ? u.href : ''; } catch { return ''; }
}
function textOf(body) {
  return array(body).flatMap(b => {
    if (!b || typeof b !== 'object') return [];
    if (b.type === 'Choice') return [textOf(b.items)];
    if ((b.type || b['@type'] || '').includes('Image') || b.format?.startsWith('image/')) return [];
    const text = b.value ?? b.chars ?? b['cnt:chars'];
    if (text == null) return [];
    // Strip markup without ever inserting annotation HTML into the document.
    if (b.format === 'text/html' && typeof DOMParser !== 'undefined') {
      return [new DOMParser().parseFromString(String(text), 'text/html').body.textContent || ''];
    }
    return [String(text).replace(/<[^>]*>/g, '')];
  }).filter(Boolean).join('\n');
}
export function regionOf(target, width, height) {
  if (!target) return null;
  if (typeof target === 'object') {
    const selectors = array(target.selector ?? target['oa:hasSelector']);
    for (const selector of selectors) {
      const region = regionOf(selector.value ?? selector['rdf:value'], width, height);
      if (region) return region;
    }
    return regionOf(idOf(target), width, height);
  }
  const match = String(target).match(/(?:^|[#&])xywh=(?:(pixel|percent|pct):)?(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)/);
  if (!match) return null;
  let [x, y, w, h] = match.slice(2).map(Number);
  if (match[1] === 'percent' || match[1] === 'pct') { x *= width / 100; w *= width / 100; y *= height / 100; h *= height / 100; }
  const right = Math.min(width, x + w), bottom = Math.min(height, y + h);
  x = Math.max(0, x); y = Math.max(0, y);
  return right > x && bottom > y ? [x, y, right - x, bottom - y] : null;
}
export function cropURL(service, region, size = 700) {
  const [x, y, w, h] = region.map(Math.round);
  const outputWidth = Math.min(size, w);
  return `${service.replace(/\/$/, '')}/${x},${y},${Math.max(1, w)},${Math.max(1, h)}/${Math.max(1, outputWidth)},/0/default.jpg`;
}
export async function parseManifest(manifest, { baseURL = '', fetchJSON, signal, onProgress = () => {} } = {}) {
  const canvases = manifest.items ?? manifest.sequences?.[0]?.canvases;
  if (!Array.isArray(canvases) || !canvases.length || !((manifest.type ?? manifest['@type'] ?? '').endsWith('Manifest'))) {
    throw new Error('IIIF Presentation v2 / v3 のManifestを選択してください。');
  }
  const cache = new Map(), warnings = [], crops = [];
  const fetcher = fetchJSON || (async url => {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  });
  const resolve = (value, base = baseURL) => httpURL(value, base);
  async function hydrate(value, base, fields) {
    if (fields.some(f => Array.isArray(value?.[f]))) return value;
    const url = resolve(idOf(value), base);
    if (!url) throw new Error('参照先URLを解決できません。URLからManifestを読み込んでください。');
    if (!cache.has(url)) cache.set(url, fetcher(url));
    return cache.get(url);
  }
  async function annotations(value, base, visited = new Set()) {
    const url = resolve(idOf(value), base);
    if (url && visited.has(url)) return [];
    const nextVisited = new Set(visited); if (url) nextVisited.add(url);
    const data = await hydrate(value, base, ['items', 'resources']);
    const list = data.items ?? data.resources ?? [];
    const out = [];
    for (const entry of list) {
      const type = entry?.type ?? entry?.['@type'] ?? '';
      if (type.endsWith('Annotation') || entry?.body || entry?.resource) out.push(entry);
      else out.push(...await annotations(entry, url || base, nextVisited));
    }
    if (data.next) out.push(...await annotations(data.next, url || base, nextVisited));
    return out;
  }
  let completed = 0, cursor = 0;
  const results = new Array(canvases.length);
  async function worker() {
    while (cursor < canvases.length) {
      const index = cursor++, canvas = canvases[index];
      const local = [];
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const canvasId = resolve(idOf(canvas), baseURL) || idOf(canvas);
      try {
        const painting = canvas.images ?? (await Promise.all(array(canvas.items).map(p => annotations(p, baseURL)))).flat();
        const images = painting.flatMap(a => array(a.body ?? a.resource)).flatMap(b => b.type === 'Choice' ? array(b.items ?? b.default) : [b]);
        const image = images.find(b => array(b.service).some(s => /ImageService|image\/[123]|level[012]/i.test(JSON.stringify(s))));
        const service = image && array(image.service).find(s => /ImageService|image\/[123]|level[012]/i.test(JSON.stringify(s)));
        const serviceURL = resolve(idOf(service), baseURL).replace(/\/info\.json$/, '');
        const width = Number(canvas.width), height = Number(canvas.height);
        const refs = [...array(canvas.annotations), ...array(canvas.otherContent)];
        if (refs.length && !serviceURL) warnings.push(`${labelOf(canvas.label) || index + 1} — IIIF Image Serviceがありません。`);
        else if (refs.length && !(width > 0 && height > 0)) warnings.push(`${index + 1} — Canvasの寸法がありません。`);
        else if (refs.length) {
          let iw = Number(image.width), ih = Number(image.height);
          // Service dimensions are authoritative when the painting image is a derivative.
          if (!(iw > 0 && ih > 0) || (image.id ?? image['@id'] ?? '').includes('/full/')) {
            try { const info = await hydrate(serviceURL + '/info.json', baseURL, ['unused']); iw = Number(info.width); ih = Number(info.height); }
            catch (error) { if (signal?.aborted) throw error; if (!(iw > 0 && ih > 0)) throw new Error('Image Serviceの画像寸法を取得できません。'); }
          }
          for (const ref of refs) {
            let annos;
            try { annos = await annotations(ref, baseURL); }
            catch (error) { if (signal?.aborted) throw error; warnings.push(`${index + 1} — Annotationの参照先を取得できません。${error.message}`); continue; }
            for (const anno of annos) {
              if (array(anno.motivation).some(m => /(?:^|:)painting$/.test(m))) continue;
              for (const target of array(anno.target ?? anno.on)) {
                const targetSource = typeof target === 'string' ? target : idOf(target.source ?? target.full) || idOf(target);
                if (targetSource && (resolve(targetSource, baseURL) || targetSource).split('#')[0] !== canvasId.split('#')[0]) continue;
                const region = regionOf(target, width, height);
                if (!region) { warnings.push(`${index + 1} — xywh矩形領域がないAnnotationをスキップしました。`); continue; }
                // Account for a painting annotation mapped into a part of the canvas.
                const paint = painting.find(a => array(a.body ?? a.resource).includes(image)) ?? painting[0];
                const viewport = regionOf(paint?.target ?? paint?.on, width, height) ?? [0, 0, width, height];
                const left = Math.max(region[0], viewport[0]), top = Math.max(region[1], viewport[1]);
                const right = Math.min(region[0] + region[2], viewport[0] + viewport[2]);
                const bottom = Math.min(region[1] + region[3], viewport[1] + viewport[3]);
                if (right <= left || bottom <= top) continue;
                const pixel = [(left - viewport[0]) * iw / viewport[2], (top - viewport[1]) * ih / viewport[3], (right - left) * iw / viewport[2], (bottom - top) * ih / viewport[3]].map(Math.round);
                if (pixel[2] < 1 || pixel[3] < 1) continue;
                const text = textOf(anno.body ?? anno.resource);
                local.push({ id: idOf(anno), key: `${index}-${local.length}`, text, canvas: canvasId, canvasIndex: index, canvasRegion: [left, top, right - left, bottom - top], page: labelOf(canvas.label) || `Canvas ${index + 1}`, region: pixel, url: cropURL(serviceURL, pixel), fullURL: cropURL(serviceURL, pixel, Math.max(pixel[2], 1)), ratio: pixel[2] / pixel[3] });
              }
            }
          }
        }
      } catch (error) {
        if (signal?.aborted) throw error;
        warnings.push(`${labelOf(canvas.label) || index + 1} — ${error.message}`);
      }
      results[index] = local;
      onProgress(++completed, canvases.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(5, canvases.length) }, worker));
  crops.push(...results.flat());
  return { title: labelOf(manifest.label) || 'Untitled manifest', crops, warnings, canvases: canvases.length, attribution: labelOf(manifest.requiredStatement?.value ?? manifest.attribution), manifestURL: resolve(idOf(manifest), baseURL) };
}

// A demonstration manifest with real IIIF image regions and explicitly authored sample annotations.
export function demoManifest() {
  const service = 'https://iiif.io/api/image/3.0/example/reference/918ecd18c2592080851777620de9bcb5-gottingen';
  const canvas = 'https://example.org/atlas-demo/canvas';
  const regions = [[0,0,1450,1100],[1600,100,900,1500],[2600,0,1400,950],[150,1300,1100,750],[1250,650,1400,1200],[2700,900,1150,1500],[0,1800,1350,1200],[1300,1700,1700,950],[2800,2200,1200,800],[600,200,1000,1400],[2100,1500,650,1400],[200,1000,1600,650],[2300,0,1650,800],[2000,800,1050,750],[800,2100,1650,850],[3100,1100,850,850],[200,500,900,1000],[1600,1800,850,1150],[2400,1800,1500,800],[0,0,2000,650],[1100,1000,900,1450],[3000,200,1000,1400],[400,1800,1500,700],[1700,150,1300,850]];
  const labels = ['街角と赤い屋根 / rooftops', '歴史的建築のファサード / architecture', '空と屋根の風景 / skyline', '通りを歩く人々 / people', '広場に面した建物 / square', '街並みのディテール / detail', '石畳と影 / shadows', '広場の風景 / city', '通りの風景 / street', '窓と外壁 / windows', '建築の縦のライン / architecture', '街のパノラマ / panorama'];
  return { type: 'Manifest', label: { ja: ['Göttingen — サンプル'] }, requiredStatement: { value: { ja: ['IIIF Cookbook の写真 · Annotation本文はデモ用'] } }, items: [{ id: canvas, type: 'Canvas', width: 4032, height: 3024, label: { ja: ['Göttingen, 2019'] }, items: [{ type: 'AnnotationPage', items: [{ type: 'Annotation', motivation: 'painting', target: canvas, body: { type: 'Image', width: 4032, height: 3024, service: [{ id: service, type: 'ImageService3', profile: 'level1' }] } }] }], annotations: [{ type: 'AnnotationPage', items: regions.map((r, i) => ({ id: `https://example.org/atlas-demo/annotation/${i}`, type: 'Annotation', target: `${canvas}#xywh=${r.join(',')}`, body: { type: 'TextualBody', value: labels[i % labels.length] } })) }] }] };
}
