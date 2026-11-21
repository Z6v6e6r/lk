import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import {gunzipSync}from'node:zlib';
import {execFileSync}from'node:child_process';
import {fileURLToPath}from'node:url';
const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
test('all T123 blocks fit 17KB and reconstruct the exact complete application',()=>{
 execFileSync(process.execPath,['scripts/build.mjs'],{cwd:project});
 const dist=path.join(project,'dist');
 const manifest=JSON.parse(fs.readFileSync(path.join(dist,'release.json'),'utf8'));
 const names=Object.keys(manifest.files).filter(name=>name.startsWith('tilda/')).sort();
 assert.equal(names.length,manifest.partCount);
 const blocks=names.map(name=>fs.readFileSync(path.join(dist,name),'utf8'));
 assert.ok(blocks.every(part=>Buffer.byteLength(part)<17000));
 const encoded=blocks.slice(0,-1).map(part=>JSON.parse(part.match(/data-rodina-part="\d+">([^<]+)<\/script>/)[1])).join('');
 const restored=gunzipSync(Buffer.from(encoded,'base64'));
 const app=fs.readFileSync(path.join(dist,manifest.bundleName));
 assert.deepEqual(restored,app);
 assert.equal(crypto.createHash('sha256').update(app).digest('hex').slice(0,16),manifest.bundleName.split('.')[1]);
 assert.doesNotThrow(()=>new vm.Script(app.toString('utf8')));
 assert.ok(!blocks.at(-1).includes('script.src'));
 assert.ok(blocks.at(-1).includes(crypto.createHash('sha256').update(app).digest('hex')));
 assert.equal(fs.existsSync(path.join(dist,'tilda/T123-ALL-IN-ONE.html')),false);
 for(const [name,expected]of Object.entries(manifest.files)){
  const bytes=fs.readFileSync(path.join(dist,name));
  assert.equal(bytes.length,expected.bytes);
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),expected.sha256);
 }
});
