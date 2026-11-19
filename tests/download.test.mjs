import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32, safeFilename, uniqueFilenames, makeZip, downloadArchive } from '../dist/download.js';
import { parseManifest, demoManifest } from '../dist/iiif.js';

const utf8 = new TextEncoder();
function entries(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), out = []; let offset = 0;
  while (view.getUint32(offset, true) === 0x04034b50) {
    const size = view.getUint32(offset + 18, true), length = view.getUint16(offset + 26, true), extra = view.getUint16(offset + 28, true);
    assert.equal(view.getUint16(offset + 6, true) & 0x800, 0x800);
    const name = new TextDecoder().decode(bytes.subarray(offset + 30, offset + 30 + length)), start = offset + 30 + length + extra;
    const data = bytes.subarray(start, start + size);
    assert.equal(crc32(data), view.getUint32(offset + 14, true));
    out.push({name, data}); offset = start + size;
  }
  assert.equal(view.getUint32(offset, true), 0x02014b50);
  assert.equal(view.getUint32(bytes.length - 22, true), 0x06054b50);
  assert.equal(view.getUint16(bytes.length - 12, true), out.length);
  assert.equal(view.getUint32(bytes.length - 6, true), offset);
  return out;
}
test('CRC32 matches the standard test vector; ZIP contains intact Japanese filenames and bytes', async () => {
  assert.equal(crc32(utf8.encode('123456789')),0xcbf43926);
  const zip=makeZip([{name:'猫の絵.jpg',data:utf8.encode('one')},{name:'猫の絵_2.png',data:utf8.encode('two')}]);
  const found=entries(new Uint8Array(await zip.arrayBuffer()));
  assert.deepEqual(found.map(e=>e.name),['猫の絵.jpg','猫の絵_2.png']);
  assert.deepEqual(found.map(e=>new TextDecoder().decode(e.data)),['one','two']);
});
test('names cannot create paths, hidden files, control characters or reserved device names', () => {
  assert.equal(safeFilename('../../猫/絵\n.png'),'_.._猫_絵_');
  assert.equal(safeFilename('CON'),'_CON');
  assert.equal(safeFilename('...'),'annotation');
  assert.ok(utf8.encode(safeFilename('猫'.repeat(1000))).length <= 180);
  assert.equal(safeFilename('a\u202eb'),'a_b');
  assert.deepEqual(uniqueFilenames([{name:'猫'},{name:'猫'},{name:'猫_2'},{name:'CAT'},{name:'cat'}],['jpg','jpg','jpg','png','png']),['猫.jpg','猫_2.jpg','猫_2_2.jpg','CAT.png','cat_2.png']);
  assert.throws(()=>makeZip([{name:'../evil.jpg',data:new Uint8Array()}]),/不正/);
});
test('uses Annotation label before text for image names', async () => {
  const m=demoManifest();m.items[0].annotations[0].items[0].label={ja:['カット001']};
  const result=await parseManifest(m);
  assert.equal(result.crops[0].name,'カット001');assert.equal(result.crops[1].name,result.crops[1].text);
});
function png() {
  const data=new Uint8Array(24),v=new DataView(data.buffer);v.setUint32(0,0x89504e47);v.setUint32(4,0x0d0a1a0a);v.setUint32(12,0x49484452);v.setUint32(16,1);v.setUint32(20,1);return data;
}
test('batch preserves order and MIME extensions while reporting progress', async () => {
  const items=[{name:'二',fullURL:'https://images.example/2'},{name:'一',fullURL:'https://images.example/1'}],progress=[];
  const zip=await downloadArchive(items,['https://images.example'],{fetchImpl:async()=>new Response(png(),{headers:{'content-type':'image/png'}}),onProgress:done=>progress.push(done)});
  assert.deepEqual(entries(new Uint8Array(await zip.arrayBuffer())).map(e=>e.name),['二.png','一.png']);assert.deepEqual(progress,[1,2]);
});
test('cancellation and a failed image never produce a partial download', async () => {
  const items=[{name:'絵',fullURL:'https://images.example/image'}];
  const controller=new AbortController();controller.abort();
  await assert.rejects(()=>downloadArchive(items,['https://images.example'],{signal:controller.signal}),{name:'AbortError'});
  await assert.rejects(()=>downloadArchive(items,['https://images.example'],{fetchImpl:async()=>new Response('missing',{status:404})}),/絵.*取得できません/);
  await assert.rejects(()=>downloadArchive(items,['https://other.example'],{fetchImpl:async()=>{throw new Error('must not fetch');}}),/確認されていない/);
  const during=new AbortController();let started=0;
  const task=downloadArchive(items,['https://images.example'],{signal:during.signal,fetchImpl:(_url,{signal})=>new Promise((_resolve,reject)=>{started++;signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true});})});
  during.abort();await assert.rejects(()=>task,{name:'AbortError'});assert.equal(started,1);
});
