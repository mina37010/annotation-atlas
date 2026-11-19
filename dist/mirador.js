import { httpURL, idOf } from './iiif.js';

let library;
function loadLibrary() {
  if (window.Mirador) return Promise.resolve(window.Mirador);
  if (!library) library = new Promise((resolve, reject) => {
    const script = document.createElement('script'); script.src = './vendor/mirador.min.js';
    script.onload = () => resolve(window.Mirador);
    script.onerror = () => { script.remove(); library = null; reject(new Error('Miradorを読み込めません。')); };
    document.head.append(script);
  });
  return library;
}

function absolutize(value, base, key = '') {
  if (typeof value === 'string') return ['id', '@id', 'on', 'target', 'source', 'full', 'otherContent', 'annotations', 'thumbnail'].includes(key) ? httpURL(value, base) || value : value;
  if (Array.isArray(value)) return value.map(entry => absolutize(entry, base, key));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, absolutize(entry, base, name)]));
  return value;
}

export async function openMirador({ manifest, baseURL, item, container, onViewer, signal }) {
  const Mirador = await loadLibrary();
  if (signal?.aborted) return null;
  const json = absolutize(manifest, baseURL);
  const manifestId = idOf(json) || 'urn:annotation-atlas:local-manifest';
  const v3 = json.type === 'Manifest';
  json[v3 ? 'id' : '@id'] = manifestId;
  json['@context'] ||= v3 ? 'http://iiif.io/api/presentation/3/context.json' : 'http://iiif.io/api/presentation/2/context.json';
  if (v3) {
    for (const [ci, c] of (json.items || []).entries()) {
      for (const [pi, page] of (c.items || []).entries()) {
        page.id ||= `${manifestId}/page/${ci}/${pi}`;
        for (const [ai, anno] of (page.items || []).entries()) {
          anno.id ||= `${page.id}/annotation/${ai}`;
          const bodies = Array.isArray(anno.body) ? anno.body : [anno.body];
          for (const body of bodies) {
            const service = Array.isArray(body?.service) ? body.service[0] : body?.service;
            if (body && !idOf(body) && idOf(service)) body.id = `${idOf(service)}/full/${service.type === 'ImageService3' ? 'max' : 'full'}/0/default.jpg`;
          }
        }
      }
    }
  }
  const canvas = (json.items ?? json.sequences?.[0]?.canvases)?.[item.canvasIndex];
  if (!canvas) throw new Error('該当ページが見つかりません。');
  const canvasId = idOf(canvas) || item.canvas;
  const windowId = 'atlas-mirador-window';
  const initialized = new WeakMap();
  const disposers = [];
  let instance;
  const plugin = {
    target: 'OpenSeadragonViewer', mode: 'add',
    component: function SelectedRegion({ viewer, canvasWorld }) {
      if (!viewer || signal?.aborted) return null;
      const current = canvasWorld?.canvasIds?.includes(canvasId);
      let state = initialized.get(viewer);
      if (!state) {
        state = { overlay: null, focused: false, scheduled: false };
        initialized.set(viewer, state);
        const refresh = () => {
          if (signal?.aborted || !viewer.world.getItemCount() || !state.active) return;
          const [x, y, width, height] = item.canvasRegion;
          const rect = (left, top, w, h) => Object.assign(viewer.viewport.getBounds().clone(), { x: left, y: top, width: w, height: h });
          if (!state.overlay) {
            state.overlay = document.createElement('div');
            state.overlay.className = 'mirador-selected-region';
            state.overlay.setAttribute('aria-label', '選択したAnnotationの領域');
            viewer.addOverlay({ element: state.overlay, location: rect(x, y, width, height), checkResize: false });
          }
          if (!state.focused) {
            state.focused = true;
            // Mirador fits the full canvas after its tile-source promise resolves.
            // Focus the selected region on the next frame, after that fit.
            requestAnimationFrame(() => {
              if (!signal?.aborted && state.active) viewer.viewport.fitBounds(rect(x - width * .3, y - height * .3, width * 1.6, height * 1.6), true);
            });
          }
        };
        state.refresh = refresh;
        viewer.world.addHandler('add-item', refresh);
        disposers.push(() => viewer.world.removeHandler('add-item', refresh));
      }
      state.active = Boolean(current);
      if (!current && state.overlay) { viewer.removeOverlay(state.overlay); state.overlay = null; state.focused = false; }
      if (!state.scheduled) { state.scheduled = true; requestAnimationFrame(() => { state.scheduled = false; state.refresh(); }); }
      onViewer?.(viewer);
      return null;
    },
  };
  instance = Mirador.viewer({
    id: container.id,
    language: 'ja',
    theme: { palette: { primary: { main: '#333333' }, secondary: { main: '#555555' } } },
    workspaceControlPanel: { enabled: false },
    workspace: { allowNewWindows: false, showZoomControls: true },
    window: { allowClose: false, allowMaximize: false, sideBarOpen: false },
    windows: [],
  }, [plugin]);
  // Supply the already loaded Manifest, including local JSON, instead of refetching its ID.
  instance.store.dispatch(Mirador.actions.receiveManifest(manifestId, json));
  instance.store.dispatch(Mirador.actions.addWindow({ id: windowId, manifestId, canvasId, canvasIndex: item.canvasIndex, thumbnailNavigationPosition: 'far-bottom' }));
  return { instance, close() { disposers.forEach(dispose => dispose()); instance.unmount(); container.replaceChildren(); } };
}
