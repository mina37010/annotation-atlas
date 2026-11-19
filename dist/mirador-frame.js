// Runs only in an opaque-origin sandbox. All data requests go through the
// parent's bounded, allowlisted broker; the frame itself has connect-src 'none'.
(() => {
  'use strict';
  const nonce = document.currentScript.nonce;
  const bundleURL = new URL('./vendor/mirador.min.js', document.currentScript.src).href;
  let token, sequence = 0, initialized = false;
  const pending = new Map();
  function request(url, image = false) {
    if (pending.size >= 128) return Promise.reject(new Error('同時リクエストが上限を超えました。'));
    return new Promise((resolve,reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('通信がタイムアウトしました。')); }, 30000);
      pending.set(id,{resolve,reject,timer});
      parent.postMessage({type:'viewer-request',token,id,url:String(url),image},'*');
    });
  }
  window.fetch = async (input, options = {}) => {
    if ((options.method || input?.method || 'GET').toUpperCase() !== 'GET') throw new Error('GETのみ許可されています。');
    const result = await request(typeof input === 'string' ? input : input.url);
    return new Response(result.data,{status:200,headers:{'Content-Type':result.contentType}});
  };
  class BrokerXHR extends EventTarget {
    constructor() { super(); this.readyState=0; this.status=0; this.responseType=''; this.headers={}; }
    open(method,url) { if (method.toUpperCase() !== 'GET') throw new Error('GETのみ許可されています。'); this.url=url; this.readyState=1; }
    setRequestHeader() {}
    getResponseHeader(name) { return this.headers[name.toLowerCase()] || null; }
    getAllResponseHeaders() { return Object.entries(this.headers).map(([k,v])=>k+': '+v).join('\r\n'); }
    overrideMimeType() {}
    abort() { this.aborted=true; }
    event(name) { const event=new Event(name); this['on'+name]?.(event); this.dispatchEvent(event); }
    async send() {
      try {
        const result=await request(this.url,this.responseType==='arraybuffer'||this.responseType==='blob');
        if(this.aborted)return;
        this.status=200;this.responseURL=this.url;this.readyState=4;this.headers={'content-type':result.contentType};
        if(this.responseType==='arraybuffer')this.response=result.data;
        else if(this.responseType==='blob')this.response=new Blob([result.data],{type:result.contentType});
        else { this.responseText=new TextDecoder().decode(result.data);this.response=this.responseType==='json'?JSON.parse(this.responseText):this.responseText; }
        this.event('readystatechange');this.event('load');this.event('loadend');
      } catch(error) { if(!this.aborted){this.readyState=4;this.status=0;this.event('readystatechange');this.event('error');this.event('loadend');} }
    }
  }
  window.XMLHttpRequest=BrokerXHR;
  const originalSrc=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'src');
  const expected=new WeakMap();
  Object.defineProperty(HTMLImageElement.prototype,'src',{configurable:true,get:originalSrc.get,set(value){
    const url=String(value);expected.set(this,url);
    if(url.startsWith('blob:')||url.startsWith('data:image/')){originalSrc.set.call(this,url);return;}
    request(url,true).then(result=>{if(expected.get(this)===url)originalSrc.set.call(this,URL.createObjectURL(new Blob([result.data],{type:result.contentType})));},()=>this.dispatchEvent(new Event('error')));
  }});
  const originalSet=Element.prototype.setAttribute;
  Element.prototype.setAttribute=function(name,value){if(this instanceof HTMLImageElement&&name.toLowerCase()==='src'){this.src=value;return;}originalSet.call(this,name,value);};
  addEventListener('message',async event=>{
    if(event.source!==parent)return;
    const message=event.data;
    if(message?.type==='viewer-response'&&message.token===token){const entry=pending.get(message.id);if(!entry)return;pending.delete(message.id);clearTimeout(entry.timer);message.error?entry.reject(new Error(message.error)):entry.resolve(message);return;}
    if(message?.type!=='viewer-init'||initialized)return;
    initialized=true;token=message.token;
    try {
      await new Promise((resolve,reject)=>{const script=document.createElement('script');script.src=bundleURL;script.nonce=nonce;script.onload=resolve;script.onerror=()=>reject(new Error('Miradorを読み込めません。'));document.head.append(script);});
      const { manifest:json,item }=message;
      const manifestId=json.id,canvasId=json.items[item.canvasIndex].id;
  const windowId = 'atlas-mirador-window';
  const initialized = new WeakMap();
  const disposers = [];
  let instance;
  const signal = { aborted: false };
  const onViewer = () => parent.postMessage({type:"viewer-ready",token}, "*");
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
    id: "viewer",
    osdConfig: { loadTilesWithAjax: true, ajaxWithCredentials: false, imageLoaderLimit: 4, maxImageCacheCount: 100 },
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

    } catch(error) { parent.postMessage({type:'viewer-error',token,error:String(error.message)},'*'); }
  });
})();
