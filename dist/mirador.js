import { createNetwork, publicURL, validateJSON, InputError } from './security.js';

export function safeInfo(json, url) {
  validateJSON(json);
  const width = Number(json.width), height = Number(json.height);
  if (![width, height].every(n => Number.isInteger(n) && n > 0 && n <= 100000)) throw new InputError('Image Serviceの寸法が不正です。');
  const id = url.replace(/\/info\.json(?:\?.*)?$/, '');
  const v3 = json.type === 'ImageService3' || String(json['@context']).includes('/image/3/');
  const info = v3 ? { '@context':'http://iiif.io/api/image/3/context.json', id, type:'ImageService3', protocol:'http://iiif.io/api/image', profile:'level1', width, height } : { '@context':'http://iiif.io/api/image/2/context.json', '@id':id, protocol:'http://iiif.io/api/image', profile:['http://iiif.io/api/image/2/level1.json'], width, height };
  if (Array.isArray(json.tiles)) info.tiles = json.tiles.slice(0,4).flatMap(tile => {
    if (!(Number.isInteger(tile.width) && tile.width > 0 && tile.width <= 2048)) return [];
    const scaleFactors = Array.isArray(tile.scaleFactors) ? tile.scaleFactors.filter(n => Number.isInteger(n) && n > 0 && n <= 65536).slice(0,32) : [];
    return scaleFactors.length ? [{ width:tile.width, height:Number.isInteger(tile.height) && tile.height > 0 && tile.height <= 2048 ? tile.height : tile.width, scaleFactors }] : [];
  });
  if (Array.isArray(json.sizes)) info.sizes = json.sizes.slice(0,16).filter(size => Number.isInteger(size.width) && Number.isInteger(size.height) && size.width > 0 && size.height > 0 && size.width <= width && size.height <= height).map(({width,height})=>({width,height}));
  return info;
}

export function openMirador({ manifest, origins, item, container, onViewer, onError, signal }) {
  validateJSON(manifest);
  const frame = document.createElement('iframe');
  frame.title = 'Mirador'; frame.setAttribute('sandbox', 'allow-scripts'); frame.referrerPolicy = 'no-referrer';
  frame.setAttribute('allow', "clipboard-read 'none'; clipboard-write 'none'; camera 'none'; microphone 'none'; geolocation 'none'");
  const token = crypto.randomUUID(), nonce = crypto.randomUUID().replaceAll('-', '');
  const scriptURL = new URL('./mirador-frame.js', location.href).href;
  const networkController = new AbortController();
  const network = createNetwork(origins, { signal: networkController.signal, maxRequests: 512, maxBytes: 128 * 1024 * 1024, duration: 300000 });
  const services = manifest.items.flatMap(canvas => canvas.items.flatMap(page => page.items.flatMap(anno => anno.body.service.map(service => service.id))));
  const prefixes = services.map(service => service.replace(/\/$/, '') + '/');
  const csp = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src blob: data:; connect-src 'none'; font-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'`;
  frame.srcdoc = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>html,body,#viewer{height:100%;margin:0}body{font-family:system-ui,sans-serif}.mirador-selected-region{border:3px solid white;outline:2px solid #222;background:#ffffff15;pointer-events:none;box-sizing:border-box}</style></head><body><div id="viewer"></div><script nonce="${nonce}" src="${scriptURL.replaceAll('&','&amp;').replaceAll('"','&quot;')}"></script></body></html>`;
  const pending = new Set(); let closed = false, ready = false, messages = 0;
  const timer = setTimeout(() => { if (!closed && !ready) { onError?.('Miradorの読み込みがタイムアウトしました。'); close(); } }, 20000);
  const message = async event => {
    if (closed || event.source !== frame.contentWindow || event.origin !== 'null' || event.data?.token !== token) return;
    if (++messages > 2048) { onError?.('Miradorの通信回数が上限を超えました。'); close(); return; }
    const data = event.data;
    if (data.type === 'viewer-ready') { if (!ready) { ready = true; clearTimeout(timer); onViewer?.(); } return; }
    if (data.type === 'viewer-error') { onError?.('Miradorを開けません。'); close(); return; }
    if (data.type !== 'viewer-request' || !Number.isSafeInteger(data.id) || data.id < 1 || pending.has(data.id) || pending.size >= 128) return;
    pending.add(data.id);
    try {
      const url = publicURL(data.url);
      if (!url || !prefixes.some(prefix => url.startsWith(prefix))) throw new InputError('未確認のImage Serviceを拒否しました。');
      const image = data.image === true;
      if (!image && !new URL(url).pathname.endsWith('/info.json')) throw new InputError('未確認のデータ形式を拒否しました。');
      let result;
      if (image) result = await network.bytes(url, { image: true });
      else result = { data: new TextEncoder().encode(JSON.stringify(safeInfo(await network.json(url), url))), type:'application/json' };
      if (!closed) frame.contentWindow.postMessage({type:'viewer-response',token,id:data.id,data:result.data.buffer,contentType:result.type}, '*', [result.data.buffer]);
    } catch (error) { if (!closed) frame.contentWindow.postMessage({type:'viewer-response',token,id:data.id,error:'データを取得できません。'}, '*'); }
    finally { pending.delete(data.id); }
  };
  const close = () => { if (closed) return; closed = true; clearTimeout(timer); networkController.abort(); removeEventListener('message', message); signal?.removeEventListener('abort', close); frame.remove(); };
  addEventListener('message', message); signal?.addEventListener('abort', close, { once:true });
  frame.addEventListener('load', () => { if (!closed) frame.contentWindow.postMessage({type:'viewer-init',token,manifest,item:{canvasIndex:item.canvasIndex,canvasRegion:item.canvasRegion}}, '*'); }, { once:true });
  if (signal?.aborted) close(); else container.replaceChildren(frame);
  return Promise.resolve({ close });
}
