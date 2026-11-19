import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseManifest, regionOf, cropURL, demoManifest, httpURL } from '../dist/iiif.js';
const service = 'https://images.example.org/iiif/page';
const canvasId = 'https://example.org/canvas/1';
const body = { type: 'Image', width: 2000, height: 3000, service: [{ id: service, type: 'ImageService3' }] };
function manifest(annotations, extra = {}) {
  return { type: 'Manifest', label: { ja: ['資料'] }, items: [{ id: canvasId, type: 'Canvas', width: 1000, height: 1500, items: [{ type: 'AnnotationPage', items: [{ type: 'Annotation', motivation: 'painting', target: canvasId, body }] }], annotations: [{ type: 'AnnotationPage', items: annotations }], ...extra }] };
}
const annotation = (target = canvasId + '#xywh=10,20,100,200') => ({ id: 'https://example.org/a/1', type: 'Annotation', target, body: { type: 'TextualBody', value: '猫の絵 cat' } });
test('v3 scales Canvas regions to original image pixels and preserves annotation text', async () => {
  const result = await parseManifest(manifest([annotation()]));
  assert.equal(result.title, '資料'); assert.equal(result.crops.length, 1);
  assert.deepEqual(result.crops[0].region, [20,40,200,400]);
  assert.equal(result.crops[0].url, service + '/20,40,200,400/200,/0/default.jpg');
  assert.equal(result.crops[0].text, '猫の絵 cat');
});
test('FragmentSelector and percent regions are supported; invalid regions are rejected', () => {
  assert.deepEqual(regionOf({ source: canvasId, selector: { type: 'FragmentSelector', value: 'xywh=percent:10,20,30,40' } },1000,500), [100,100,300,200]);
  assert.deepEqual(regionOf('#xywh=-10,20,40,100',100,80), [0,20,30,60]);
  assert.equal(regionOf('#xywh=200,0,30,30',100,100), null);
  assert.equal(regionOf('#xywh=0,0,0,30',100,100), null);
  assert.equal(regionOf({ selector: { type: 'SvgSelector', value: '<svg/>' } },100,100), null);
});
test('v2 external otherContent, chars, @id and on', async () => {
  const v2 = { '@type':'sc:Manifest', label:'v2', sequences:[{ canvases:[{ '@id':canvasId, width:1000, height:1500, images:[{ resource:{ '@type':'dctypes:Image', width:2000, height:3000, service:{ '@id':service, profile:'http://iiif.io/api/image/2/level2.json' } } }], otherContent:['https://example.org/list'] }] }] };
  const result = await parseManifest(v2, { fetchJSON: async url => { assert.equal(url,'https://example.org/list'); return { resources:[{ '@type':'oa:Annotation', on:canvasId+'#xywh=10,20,100,200', resource:{ '@type':'cnt:ContentAsText', chars:'古文書' } }] }; } });
  assert.equal(result.crops.length,1); assert.equal(result.crops[0].text,'古文書'); assert.deepEqual(result.crops[0].region,[20,40,200,400]);
});
test('follows referenced pages, pagination, relative URLs, and prevents cycles', async () => {
  const calls = [];
  const result = await parseManifest(manifest([], { annotations:[{ id:'./page/1', type:'AnnotationPage' }] }), {
    baseURL:'https://example.org/manifest.json', fetchJSON:async url => { calls.push(url); return { items:[annotation()], next: url.endsWith('/1') ? './2' : './1' }; }
  });
  assert.equal(result.crops.length,2); assert.equal(calls.length,2);
});
test('canvas source matching prevents annotations from being assigned to another page', async () => {
  const result = await parseManifest(manifest([annotation('https://example.org/canvas/2#xywh=0,0,100,100'), annotation({ source:canvasId, selector:{ type:'FragmentSelector', value:'xywh=1,2,3,4' } })]));
  assert.equal(result.crops.length,1); assert.deepEqual(result.crops[0].region,[2,4,6,8]);
});
test('failed external page is reported while available annotations remain', async () => {
  const result = await parseManifest(manifest([], { annotations:[{ type:'AnnotationPage', items:[annotation()] }, { id:'https://example.org/missing' }] }), { fetchJSON:async () => { throw new Error('HTTP 403'); } });
  assert.equal(result.crops.length,1); assert.equal(result.warnings.length,1); assert.match(result.warnings[0],/403/);
});
test('uses authoritative service info when the painting body is a derivative', async () => {
  const derived = { ...body, id:service+'/full/500,/0/default.jpg', width:500, height:750 };
  const result = await parseManifest(manifest([annotation()], { items:[{ type:'AnnotationPage', items:[{ type:'Annotation', target:canvasId, body:derived }] }] }), { fetchJSON:async () => ({ width:2000, height:3000 }) });
  assert.deepEqual(result.crops[0].region,[20,40,200,400]);
});
test('painting onto a Canvas subregion adjusts coordinates and clips to the image', async () => {
  const result = await parseManifest(manifest([annotation(canvasId+'#xywh=100,200,200,300')], { items:[{ type:'AnnotationPage', items:[{ type:'Annotation', target:canvasId+'#xywh=100,200,500,750', body }] }] }));
  assert.deepEqual(result.crops[0].region,[0,0,800,1200]);
});
test('rejects non-Manifests and unsafe URLs; generated crop never upscales', async () => {
  await assert.rejects(() => parseManifest({ type:'Collection',items:[] }), /Manifest/);
  assert.equal(httpURL('javascript:alert(1)'), ''); assert.equal(httpURL('data:text/html,hi'), '');
  assert.equal(cropURL(service,[1,2,40,60]),service+'/1,2,40,60/40,/0/default.jpg');
});
test('demo is a real parseable manifest with 24 authored sample annotations', async () => {
  const result = await parseManifest(demoManifest()); assert.equal(result.crops.length,24); assert.equal(result.warnings.length,0);
});
