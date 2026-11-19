import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicURL, validateJSON, parseJSON, plainText, createNetwork, readLimited, imageDimensions, LIMITS } from '../dist/security.js';
import { parseManifest, demoManifest } from '../dist/iiif.js';
import { safeInfo } from '../dist/mirador.js';

test('blocks non-web schemes, credentials, local addresses and numeric encodings', () => {
  for (const url of ['javascript:alert(1)','data:text/html,x','file:///etc/passwd','http://localhost/x','http://foo.local/x','http://127.0.0.1/x','http://2130706433/x','http://0x7f000001/x','http://0177.0.0.1/x','http://10.0.0.1/x','http://169.254.169.254/x','http://[::1]/x','http://[::ffff:127.0.0.1]/x','http://user:pass@public.example/x','https://public.example:8443/x']) assert.equal(publicURL(url),'',url);
  assert.equal(publicURL('/page','https://library.example/manifest.json'),'https://library.example/page');
});
test('rejects size, depth, node-count, prototype keys and nonfinite numbers', () => {
  assert.throws(()=>parseJSON('"'+'a'.repeat(LIMITS.jsonBytes)+'"'),/8MB/);
  let deep={}; for(let i=0;i<45;i++)deep={nested:deep};
  assert.throws(()=>validateJSON(deep),/入れ子/);
  assert.throws(()=>validateJSON([1,2,3,4],{...LIMITS,nodes:3}),/件数/);
  for(const key of ['__proto__','constructor','prototype']) assert.throws(()=>parseJSON('{"'+key+'":{}}'),/キー/);
  assert.throws(()=>parseJSON('{"width":1e999}'),/数値/);
  assert.equal({}.polluted,undefined);
});
test('converts hostile HTML to text without a DOM parser', () => {
  const before=globalThis.DOMParser;
  globalThis.DOMParser=class { constructor(){throw new Error('Must not instantiate HTML parser');} };
  try { assert.equal(plainText('<img src="https://tracker.example/a" onerror="alert(1)"><b>猫</b><script>evil()</script>&amp;'),'猫&'); assert.equal(plainText('<script>'.repeat(10000)),''); }
  finally { globalThis.DOMParser=before; }
});
test('fetches only approved origins, without credentials or redirects', async () => {
  const calls=[];
  const net=createNetwork(['https://safe.example'],{fetchImpl:async(url,init)=>{calls.push({url,init});return new Response('{"ok":true}',{headers:{'content-type':'application/json'}});}});
  await assert.rejects(()=>net.json('https://other.example/x'),/接続先/);
  await assert.rejects(()=>net.json('http://127.0.0.1/x'),/接続先/);
  assert.deepEqual(await net.json('https://safe.example/x'),{ok:true});
  assert.equal(calls.length,1);assert.equal(calls[0].init.credentials,'omit');assert.equal(calls[0].init.redirect,'error');assert.equal(calls[0].init.referrerPolicy,'no-referrer');
});
test('bounds streamed responses even without Content-Length, MIME and request count', async () => {
  let cancelled=false;
  const response=new Response(new ReadableStream({pull(c){c.enqueue(new Uint8Array(8));},cancel(){cancelled=true;}}));
  await assert.rejects(()=>readLimited(response,10),/上限/);assert.equal(cancelled,true);
  const net=createNetwork(['https://safe.example'],{maxRequests:1,fetchImpl:async()=>new Response('{}',{headers:{'content-type':'text/html'}})});
  await assert.rejects(()=>net.json('https://safe.example/x'),/形式/);
  await assert.rejects(()=>net.json('https://safe.example/x'),/通信回数/);
});
test('stops stalled requests, redirects and aggregate download overruns', async () => {
  const stalled=createNetwork(['https://safe.example'],{duration:15,fetchImpl:(_url,{signal})=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))});
  await assert.rejects(()=>stalled.json('https://safe.example/x'),/タイムアウト/);
  const redirect=createNetwork(['https://safe.example'],{fetchImpl:async()=>new Response(null,{status:302,headers:{location:'http://127.0.0.1/'}})});
  await assert.rejects(()=>redirect.json('https://safe.example/x'),/HTTP 302/);
  const aggregate=createNetwork(['https://safe.example'],{maxBytes:3,fetchImpl:async()=>new Response('{"x":1}',{headers:{'content-type':'application/json'}})});
  await assert.rejects(()=>aggregate.json('https://safe.example/x'),/合計容量/);
});
test('limits pagination and aborts rather than silently swallowing a security error', async () => {
  const m=demoManifest();m.items[0].annotations=[{id:'https://example.org/page/0',type:'AnnotationPage'}];
  let count=0;
  await assert.rejects(()=>parseManifest(m,{fetchJSON:async()=>({items:[],next:'https://example.org/page/'+(++count)})}),/128/);
  assert.ok(count<=128);
});
test('external pages cannot introduce unapproved hosts or dangerous structure', async () => {
  const m=demoManifest();m.items[0].annotations=[{id:'https://example.org/page/0'}];
  let calls=0;
  await assert.rejects(()=>parseManifest(m,{fetchJSON:async()=>{calls++;return{items:[],next:'https://evil.example/page'};}}),/接続先/);
  assert.equal(calls,1);
  await assert.rejects(()=>parseManifest(m,{fetchJSON:async()=>JSON.parse('{"items":[],"__proto__":{"polluted":true}}')}),/キー/);
});
test('Mirador gets only projected image data and sanitized service info', async () => {
  const m=demoManifest();m.metadata=[{label:'attack',value:'<img src=x onerror=evil()>'}];m.seeAlso=[{id:'javascript:evil()'}];m.items[0].label={en:['&lt;img src=x onerror=evil()&gt;']};
  const result=await parseManifest(m);
  assert.equal(result.viewerManifest.metadata,undefined);assert.equal(result.viewerManifest.seeAlso,undefined);assert.equal(result.viewerManifest.items[0].annotations,undefined);
  assert.equal(JSON.stringify(result.viewerManifest).includes('<img'),false);
  const info=safeInfo({width:2000,height:1000,'@id':'http://127.0.0.1',service:[{id:'javascript:evil()'}],tiles:[{width:512,scaleFactors:[1,2,4]}]},'https://safe.example/iiif/page/info.json');
  assert.equal(info['@id'],'https://safe.example/iiif/page');assert.equal(info.service,undefined);assert.deepEqual(info.tiles[0].scaleFactors,[1,2,4]);
});
test('rejects image bombs before decoding', () => {
  const data=new Uint8Array(24),v=new DataView(data.buffer);v.setUint32(0,0x89504e47);v.setUint32(4,0x0d0a1a0a);v.setUint32(12,0x49484452);v.setUint32(16,100000);v.setUint32(20,100000);
  assert.throws(()=>imageDimensions(data),/寸法/);v.setUint32(16,512);v.setUint32(20,256);assert.deepEqual(imageDimensions(data),{width:512,height:256});
  assert.throws(()=>imageDimensions(new TextEncoder().encode('<svg onload="evil()"/>')),/形式/);
});
