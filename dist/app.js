import { downloadArchive, safeFilename } from './download.js';
import { LIMITS, InputError, validateJSON, parseJSON, collectOrigins, createNetwork } from './security.js';
import { createImages } from './images.js';
import { parseManifest, demoManifest, httpURL, idOf } from './iiif.js';
import { masonryLayout } from './layout.js';
import { copyImage, copyURL } from './clipboard.js';
import { openMirador } from './mirador.js';
const $ = id => document.getElementById(id);
let collection = null, filtered = [], selected = 0, generation = 0, controller;
let size = 205, query = '', showText = false, renderFrame;
let detailRevision = 0, miradorController, miradorSession, downloadController;
const normalize = text => text.normalize('NFKC').toLocaleLowerCase();
function highlight(element, text) {
  element.replaceChildren();
  // Match whole normalized queries while preserving original glyphs.
  if (!query.trim()) { element.textContent = text; return; }
  const terms = [...new Set(query.trim().split(/\s+/u).map(normalize))];
  const points = Array.from(text), normalized = [], offsets = [];
  points.forEach((char, i) => { const normalizedChar = normalize(char); normalized.push(normalizedChar); for (let j = 0; j < normalizedChar.length; j++) offsets.push(i); });
  const haystack = normalized.join(''), ranges = [];
  const maxMatches = element.id === 'detail-text' ? 100 : 8;
  for (const term of terms) { let start = 0, found; while (ranges.length < maxMatches && (found = haystack.indexOf(term, start)) !== -1) { ranges.push([offsets[found], offsets[found + term.length - 1] + 1]); start = found + Math.max(1, term.length); } }
  ranges.sort((a,b) => a[0]-b[0]);
  const merged = [];
  for (const range of ranges) { const last = merged.at(-1); if (last && range[0] <= last[1]) last[1] = Math.max(last[1],range[1]); else merged.push([...range]); }
  let cursor = 0;
  for (const [from,to] of merged) { element.append(document.createTextNode(points.slice(cursor,from).join(''))); const mark = document.createElement('mark'); mark.textContent = points.slice(from,to).join(''); element.append(mark); cursor = to; }
  element.append(document.createTextNode(points.slice(cursor).join('')));
}
function setStatus(text, { loading = false, error = false } = {}) { $('status').textContent = text; $('status').hidden = !text; $('status').dataset.loading = loading; $('status').dataset.error = error; }
function makeTile(item, index, width, height) {
  const button = document.createElement('button'); button.className = 'tile'; button.style.width = width + 'px'; button.style.height = height + 'px';
  button.setAttribute('aria-label', item.text || `${item.page} のAnnotation領域`);
  button.addEventListener('click', () => showDetail(index));
  const img = document.createElement('img'); collection.images.set(img, item.url, index < 12); img.alt = ''; img.loading = index < 12 ? 'eager' : 'lazy'; img.decoding = 'async';
  img.addEventListener('error', () => { img.hidden = true; const message = document.createElement('span'); message.className = 'image-failure'; const icon = document.createElement('strong'); icon.textContent = '◫'; message.append(icon, document.createTextNode('画像を取得できません')); button.append(message); }, { once: true });
  const caption = document.createElement('span'); caption.className = 'tile-caption'; highlight(caption, item.text);
  button.append(img, caption); return button;
}
function render() {
  if (!collection) return;
  const terms = [...new Set(normalize(query.trim()).split(/\s+/u).filter(Boolean))];
  filtered = collection.crops.filter(item => { const text = normalize(item.text); return terms.every(term => text.includes(term)); });
  $('count').textContent = terms.length ? `${filtered.length.toLocaleString()} / ${collection.crops.length.toLocaleString()} images` : `${filtered.length.toLocaleString()} images`;
  updateDownloadButton();
  const gallery = $('gallery'); gallery.classList.toggle('show-text', showText); gallery.classList.toggle('searching', Boolean(terms.length));
  collection.images.clearObservers();
  gallery.replaceChildren();
  $('empty').hidden = filtered.length > 0;
  $('empty-message').textContent = collection.crops.length ? '一致するAnnotationがありません' : '切り抜き可能なAnnotationがありません';
  $('clear-search').hidden = !collection.crops.length;
  $('empty-import').hidden = Boolean(collection.crops.length);
  const available = gallery.clientWidth;
  if (!available) return;
  const target = window.innerWidth < 700 ? Math.min(size, 150) : size;
  const layout = masonryLayout(filtered, available, target);
  gallery.style.height = `${layout.height}px`;
  const fragment = document.createDocumentFragment();
  for (const tile of layout.tiles) {
    const button = makeTile(filtered[tile.index], tile.index, tile.width, tile.height);
    button.style.left = `${tile.left}px`;
    button.style.top = `${tile.top}px`;
    fragment.append(button);
  }
  gallery.append(fragment);
}
function scheduleRender() { cancelAnimationFrame(renderFrame); renderFrame = requestAnimationFrame(render); }
function showDetail(index) {
  if (!filtered.length) return;
  detailRevision++;
  $('detail-status').hidden = true;
  $('copy-image').disabled = false; $('copy-url').disabled = false;
  selected = Math.max(0,Math.min(filtered.length - 1,index));
  const item = filtered[selected];
  collection.images.set($('detail-img'), item.fullURL, true); $('detail-img').alt = item.text || item.page;
  $('detail-page').textContent = item.page;
  highlight($('detail-text'), item.text || '本文なし');
  $('detail-region').textContent = item.region.join(', ');
  $('detail-position').textContent = `${selected+1} / ${filtered.length}`;
  $('previous').disabled = selected === 0; $('next').disabled = selected === filtered.length-1;
  $('image-link').href = item.fullURL;
  if (!$('detail-dialog').open) $('detail-dialog').showModal();
}
async function load(manifest, baseURL, sample = false, token = ++generation) {
  downloadController?.abort();
  controller?.abort(); controller = new AbortController(); const signal = controller.signal;
  $('import-dialog').close(); $('detail-dialog').close(); $('mirador-dialog').close();
  setStatus('Annotationを読み込み中…', { loading: true });
  try {
    validateJSON(manifest);
    const origins = collectOrigins(manifest, baseURL);
    if (!sample && !await confirmOrigins(origins, signal)) { if (token === generation) setStatus('読み込みをキャンセルしました'); return; }
    if (token !== generation || signal.aborted) return;
    const result = await parseManifest(manifest, { baseURL: httpURL(idOf(manifest), baseURL) || baseURL, allowedOrigins: origins, signal, onProgress: (done,total) => { if (token === generation) setStatus(`Annotationを読み込み中　${done} / ${total} Canvas`, { loading: true }); } });
    if (token !== generation) return;
    collection?.images.dispose();
    collection = { ...result, origins, images: createImages(origins) }; query = ''; $('search').value = '';
    $('collection-name').textContent = result.title;
    $('sample-badge').hidden = !sample;
    $('attribution').textContent = result.attribution || '';
    $('attribution').closest('footer').hidden = !result.attribution;
    const warnings = [...new Set(result.warnings)];
    $('warnings').hidden = !warnings.length;
    $('warnings').querySelector('summary').textContent = `${warnings.length}件の読み込みメモ`;
    $('warnings').querySelector('ul').replaceChildren(...warnings.map(w => { const li = document.createElement('li'); li.textContent = w; return li; }));
    setStatus(result.crops.length ? '' : '矩形領域とIIIF Image Serviceを確認してください。');
    document.title = `${result.title} · Annotation Atlas`;
    render();
  } catch (error) { if (token === generation && error.name !== 'AbortError') setStatus(error.message, { error: true }); }
}
function confirmOrigins(origins, signal) {
  if (!origins.length) return Promise.resolve(true);
  return new Promise(resolve => {
    const dialog = $('network-dialog');
    const finish = accepted => { cleanup(); if (dialog.open) dialog.close(); resolve(accepted); };
    const accept = () => finish(true), cancel = () => finish(false);
    const cleanup = () => { $('approve-network').removeEventListener('click', accept); dialog.removeEventListener('close', cancel); signal.removeEventListener('abort', cancel); };
    $('network-origins').replaceChildren(...origins.map(origin => { const li = document.createElement('li'); li.textContent = origin; return li; }));
    $('approve-network').addEventListener('click', accept);
    dialog.addEventListener('close', cancel, { once: true });
    signal.addEventListener('abort', cancel, { once: true });
    dialog.showModal();
  });
}
function openImport() { $('import-error').hidden = true; $('import-dialog').showModal(); }
$('open-import').addEventListener('click', openImport);
$('empty-import').addEventListener('click', openImport);
document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => $(button.dataset.close).close()));
document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click', event => { const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close(); }));
$('import-form').addEventListener('submit', async event => {
  event.preventDefault();
  const url = httpURL($('manifest-url').value.trim());
  if (!url) { $('import-error').textContent = 'http / https のManifest URLを入力してください。'; $('import-error').hidden = false; return; }
  const token = ++generation;
  controller?.abort(); controller = new AbortController();
  $('import-dialog').close(); setStatus('Manifestを読み込み中…', { loading: true });
  try {
    const manifest = await createNetwork([new URL(url).origin], { signal: controller.signal }).json(url);
    if (token !== generation) return;
    await load(manifest, url, false, token);
  } catch (error) { if (token === generation && error.name !== 'AbortError') setStatus(`Manifestを取得できません。URL・公開設定・CORSを確認してください。${error.message}`, { error: true }); }
});
async function readFile(file) {
  if (!file) return;
  const token = ++generation; controller?.abort();
  try { if (file.size > LIMITS.jsonBytes) throw new InputError('8MB以下のJSONファイルを選択してください。'); const manifest = parseJSON(await file.text()); if (token === generation) await load(manifest, httpURL(idOf(manifest)), false, token); }
  catch (error) { if (token === generation) { $('import-error').textContent = `JSONファイルを読み込めません。${error.message}`; $('import-error').hidden = false; if (!$('import-dialog').open) $('import-dialog').showModal(); } }
  $('manifest-file').value = '';
}
$('manifest-file').addEventListener('change', event => readFile(event.target.files[0]));
const drop = $('file-drop');
['dragover','dragenter'].forEach(name => drop.addEventListener(name, event => { event.preventDefault(); drop.classList.add('dragging'); }));
['dragleave','drop'].forEach(name => drop.addEventListener(name, event => { event.preventDefault(); drop.classList.remove('dragging'); }));
drop.addEventListener('drop', event => readFile(event.dataTransfer.files[0]));
$('demo').addEventListener('click', () => load(demoManifest(), '', true));
$('search').addEventListener('input', event => { query = event.target.value.slice(0, 256); scheduleRender(); });
$('clear-search').addEventListener('click', () => { query = ''; $('search').value = ''; render(); $('search').focus(); });
$('show-text').addEventListener('change', event => { showText = event.target.checked; $('gallery').classList.toggle('show-text', showText); });
$('size').addEventListener('input', event => { size = Number(event.target.value); scheduleRender(); });
$('previous').addEventListener('click', () => showDetail(selected-1));
$('next').addEventListener('click', () => showDetail(selected+1));
async function copySelected(kind) {
  const item = filtered[selected];
  if (!item) return;
  const revision = detailRevision;
  const button = $(kind === 'image' ? 'copy-image' : 'copy-url');
  const status = $('detail-status');
  button.disabled = true; status.hidden = false; status.dataset.error = 'false';
  status.textContent = kind === 'image' ? '画像をコピー中…' : 'URLをコピー中…';
  try {
    await (kind === 'image' ? copyImage(item.fullURL, collection.images) : copyURL(item.fullURL));
    if (revision === detailRevision) status.textContent = kind === 'image' ? '画像をコピーしました' : '画像URLをコピーしました';
  } catch (error) {
    if (revision === detailRevision) {
      status.dataset.error = 'true';
      status.textContent = error.message.startsWith('このブラウザ') ? error.message : kind === 'image' ? '画像をコピーできません。画像の公開設定・CORS・クリップボードの許可を確認してください。' : 'URLをコピーできません。クリップボードの許可を確認してください。';
    }
  } finally { if (revision === detailRevision) button.disabled = false; }
}
function updateDownloadButton() {
  $('download-all').disabled = Boolean(downloadController) || !filtered.length;
  $('download-all').textContent = query.trim() ? '検索結果をダウンロード' : '一括ダウンロード';
}
$('cancel-download').addEventListener('click', () => downloadController?.abort());
$('download-all').addEventListener('click', async () => {
  if (!collection || !filtered.length || downloadController) return;
  const snapshot = [...filtered], source = collection;
  const task = new AbortController(); downloadController = task;
  updateDownloadButton();
  $('download-status').hidden = false; $('cancel-download').hidden = false;
  $('download-message').textContent = `画像を取得中　0 / ${snapshot.length}`;
  try {
    const blob = await downloadArchive(snapshot, source.origins, { signal:task.signal, onProgress:(done,total) => { if (downloadController === task) $('download-message').textContent = `画像を取得中　${done} / ${total}`; } });
    if (task.signal.aborted) return;
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = safeFilename(source.title, 'annotations') + '.zip';
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    $('download-message').textContent = `${snapshot.length}件の画像をZIPにまとめました`;
  } catch(error) {
    $('download-message').textContent = task.signal.aborted ? 'ダウンロードを中止しました' : error.message;
  } finally {
    if (downloadController === task) { downloadController = null; $('cancel-download').hidden = true; updateDownloadButton(); }
  }
});
$('copy-image').addEventListener('click', () => copySelected('image'));
$('copy-url').addEventListener('click', () => copySelected('url'));
$('open-mirador').addEventListener('click', async () => {
  const item = filtered[selected];
  if (!item || !collection) return;
  miradorController?.abort(); miradorSession?.close();
  miradorController = new AbortController(); const signal = miradorController.signal;
  $('mirador-status').textContent = 'Miradorを読み込み中…'; $('mirador-status').hidden = false;
  $('mirador-dialog').showModal();
  try {
    const session = await openMirador({ manifest: collection.viewerManifest, origins: collection.origins, item, container: $('mirador-container'), signal, onViewer: () => { if (!signal.aborted) $('mirador-status').hidden = true; }, onError: message => { if (!signal.aborted) { $('mirador-status').hidden = false; $('mirador-status').textContent = message; } } });
    if (signal.aborted) session?.close(); else miradorSession = session;
  } catch (error) { if (!signal.aborted) { $('mirador-status').hidden = false; $('mirador-status').textContent = `Miradorを開けません。${error.message}`; } }
});
$('mirador-dialog').addEventListener('close', () => { miradorController?.abort(); miradorSession?.close(); miradorSession = null; });
document.addEventListener('keydown', event => {
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName);
  if (event.key === '/' && !typing && !$('import-dialog').open && !$('detail-dialog').open) { event.preventDefault(); $('search').focus(); }
  if ($('detail-dialog').open && !$('mirador-dialog').open) { if (event.key === 'ArrowLeft') { event.preventDefault(); showDetail(selected-1); } if (event.key === 'ArrowRight') { event.preventDefault(); showDetail(selected+1); } }
});
let galleryWidth = 0;
new ResizeObserver(entries => {
  const width = entries[0].contentRect.width;
  if (width !== galleryWidth) { galleryWidth = width; scheduleRender(); }
}).observe($('gallery'));
load(demoManifest(), '', true);
