import { parseManifest, demoManifest, httpURL, idOf } from './iiif.js';
const $ = id => document.getElementById(id);
let collection = null, filtered = [], selected = 0, generation = 0, controller;
let size = 205, query = '', showText = false, renderFrame;
const normalize = text => text.normalize('NFKC').toLocaleLowerCase();
function highlight(element, text) {
  element.replaceChildren();
  // Match whole normalized queries while preserving original glyphs.
  if (!query.trim()) { element.textContent = text; return; }
  const terms = query.trim().split(/\s+/u).map(normalize);
  const points = Array.from(text), normalized = [], offsets = [];
  points.forEach((char, i) => { const normalizedChar = normalize(char); normalized.push(normalizedChar); for (let j = 0; j < normalizedChar.length; j++) offsets.push(i); });
  const haystack = normalized.join(''), ranges = [];
  for (const term of terms) { let start = 0, found; while ((found = haystack.indexOf(term, start)) !== -1) { ranges.push([offsets[found], offsets[found + term.length - 1] + 1]); start = found + Math.max(1, term.length); } }
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
  const img = document.createElement('img'); img.src = item.url; img.alt = ''; img.loading = index < 12 ? 'eager' : 'lazy'; img.decoding = 'async';
  img.addEventListener('error', () => { img.hidden = true; const message = document.createElement('span'); message.className = 'image-failure'; const icon = document.createElement('strong'); icon.textContent = '◫'; message.append(icon, document.createTextNode('画像を取得できません')); button.append(message); }, { once: true });
  const caption = document.createElement('span'); caption.className = 'tile-caption'; highlight(caption, item.text);
  button.append(img, caption); return button;
}
function render() {
  if (!collection) return;
  const terms = normalize(query.trim()).split(/\s+/u).filter(Boolean);
  filtered = collection.crops.filter(item => terms.every(term => normalize(item.text).includes(term)));
  $('count').textContent = terms.length ? `${filtered.length.toLocaleString()} / ${collection.crops.length.toLocaleString()} images` : `${filtered.length.toLocaleString()} images`;
  const gallery = $('gallery'); gallery.classList.toggle('show-text', showText); gallery.classList.toggle('searching', Boolean(terms.length));
  gallery.replaceChildren();
  $('empty').hidden = filtered.length > 0;
  $('empty-message').textContent = collection.crops.length ? '一致するAnnotationがありません' : '切り抜き可能なAnnotationがありません';
  $('clear-search').hidden = !collection.crops.length;
  $('empty-import').hidden = Boolean(collection.crops.length);
  const available = gallery.clientWidth, gap = 4;
  if (!available) return;
  // Justified rows fill the entire width, preserving each region's aspect ratio.
  const target = window.innerWidth < 700 ? Math.min(size, 150) : size;
  let row = [], ratio = 0;
  const fragment = document.createDocumentFragment();
  function flush(last = false) {
    if (!row.length) return;
    const ideal = (available - gap * (row.length - 1)) / ratio;
    const height = last ? Math.min(target, ideal) : ideal;
    const el = document.createElement('div'); el.className = 'gallery-row';
    row.forEach(({ item, index }) => el.append(makeTile(item, index, height * item.ratio, height)));
    fragment.append(el); row = []; ratio = 0;
  }
  filtered.forEach((item,index) => {
    row.push({ item,index }); ratio += item.ratio;
    if (ratio * target + gap * (row.length - 1) >= available) flush();
  });
  flush(true); gallery.append(fragment);
}
function scheduleRender() { cancelAnimationFrame(renderFrame); renderFrame = requestAnimationFrame(render); }
function showDetail(index) {
  if (!filtered.length) return;
  selected = Math.max(0,Math.min(filtered.length - 1,index));
  const item = filtered[selected];
  $('detail-img').src = item.fullURL; $('detail-img').alt = item.text || item.page;
  $('detail-page').textContent = item.page;
  highlight($('detail-text'), item.text || '本文なし');
  $('detail-region').textContent = item.region.join(', ');
  $('detail-position').textContent = `${selected+1} / ${filtered.length}`;
  $('previous').disabled = selected === 0; $('next').disabled = selected === filtered.length-1;
  $('image-link').href = item.fullURL;
  const canvasURL = httpURL(item.canvas); $('canvas-link').hidden = !canvasURL;
  if (canvasURL) $('canvas-link').href = canvasURL;
  if (!$('detail-dialog').open) $('detail-dialog').showModal();
}
async function load(manifest, baseURL, sample = false, token = ++generation) {
  controller?.abort(); controller = new AbortController(); const signal = controller.signal;
  $('import-dialog').close(); $('detail-dialog').close();
  setStatus('Annotationを読み込み中…', { loading: true });
  try {
    const result = await parseManifest(manifest, { baseURL: httpURL(idOf(manifest), baseURL) || baseURL, signal, onProgress: (done,total) => { if (token === generation) setStatus(`Annotationを読み込み中　${done} / ${total} Canvas`, { loading: true }); } });
    if (token !== generation) return;
    collection = result; query = ''; $('search').value = '';
    $('collection-name').textContent = result.title;
    $('sample-badge').hidden = !sample;
    $('attribution').textContent = result.attribution || 'IIIF ANNOTATION EXPLORER';
    const warnings = [...new Set(result.warnings)];
    $('warnings').hidden = !warnings.length;
    $('warnings').querySelector('summary').textContent = `${warnings.length}件の読み込みメモ`;
    $('warnings').querySelector('ul').replaceChildren(...warnings.map(w => { const li = document.createElement('li'); li.textContent = w; return li; }));
    setStatus(result.crops.length ? '' : '矩形領域とIIIF Image Serviceを確認してください。');
    document.title = `${result.title} · Annotation Atlas`;
    render();
  } catch (error) { if (token === generation && error.name !== 'AbortError') setStatus(error.message, { error: true }); }
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
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const manifest = await response.json();
    if (token !== generation) return;
    await load(manifest, response.url || url, false, token);
  } catch (error) { if (token === generation && error.name !== 'AbortError') setStatus(`Manifestを取得できません。URL・公開設定・CORSを確認してください。${error.message}`, { error: true }); }
});
async function readFile(file) {
  if (!file) return;
  const token = ++generation; controller?.abort();
  try { if (file.size > 100 * 1024 * 1024) throw new Error('100MB以下のJSONファイルを選択してください。'); const manifest = JSON.parse(await file.text()); if (token === generation) await load(manifest, httpURL(idOf(manifest)), false, token); }
  catch (error) { if (token === generation) { $('import-error').textContent = `JSONファイルを読み込めません。${error.message}`; $('import-error').hidden = false; if (!$('import-dialog').open) $('import-dialog').showModal(); } }
  $('manifest-file').value = '';
}
$('manifest-file').addEventListener('change', event => readFile(event.target.files[0]));
const drop = $('file-drop');
['dragover','dragenter'].forEach(name => drop.addEventListener(name, event => { event.preventDefault(); drop.classList.add('dragging'); }));
['dragleave','drop'].forEach(name => drop.addEventListener(name, event => { event.preventDefault(); drop.classList.remove('dragging'); }));
drop.addEventListener('drop', event => readFile(event.dataTransfer.files[0]));
$('demo').addEventListener('click', () => load(demoManifest(), '', true));
$('search').addEventListener('input', event => { query = event.target.value; scheduleRender(); });
$('clear-search').addEventListener('click', () => { query = ''; $('search').value = ''; render(); $('search').focus(); });
$('show-text').addEventListener('change', event => { showText = event.target.checked; $('gallery').classList.toggle('show-text', showText); });
$('size').addEventListener('input', event => { size = Number(event.target.value); scheduleRender(); });
$('previous').addEventListener('click', () => showDetail(selected-1));
$('next').addEventListener('click', () => showDetail(selected+1));
document.addEventListener('keydown', event => {
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName);
  if (event.key === '/' && !typing && !$('import-dialog').open && !$('detail-dialog').open) { event.preventDefault(); $('search').focus(); }
  if ($('detail-dialog').open) { if (event.key === 'ArrowLeft') { event.preventDefault(); showDetail(selected-1); } if (event.key === 'ArrowRight') { event.preventDefault(); showDetail(selected+1); } }
});
new ResizeObserver(scheduleRender).observe($('gallery'));
load(demoManifest(), '', true);
