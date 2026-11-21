import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {ensureAssets}from'../scripts/ensure-assets.mjs';
async function fixture(t,name='assets/example.svg',expected){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'rodina-asset-test-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.mkdir(path.join(root,'audit'));await fs.mkdir(path.join(root,'src/assets'),{recursive:true});
 const body=Buffer.from('<svg></svg>');
 await fs.writeFile(path.join(root,'src/assets/example.svg'),body);
 await fs.writeFile(path.join(root,'audit/source-manifest.json'),JSON.stringify({sha256:{[name]:expected||crypto.createHash('sha256').update(body).digest('hex')}}));
 return root;
}
test('existing public assets are accepted only when their pinned hash matches',async t=>{
 const root=await fixture(t);await ensureAssets(root);
 assert.equal(await fs.readFile(path.join(root,'src/assets/example.svg'),'utf8'),'<svg></svg>');
});
test('modified assets fail the build without overwriting the file',async t=>{
 const root=await fixture(t,'assets/example.svg','0'.repeat(64));
 await assert.rejects(ensureAssets(root),/Asset hash mismatch/);
 assert.equal(await fs.readFile(path.join(root,'src/assets/example.svg'),'utf8'),'<svg></svg>');
});
test('asset paths cannot escape the source directory',async t=>{
 const root=await fixture(t,'assets/../../outside.svg');await assert.rejects(ensureAssets(root),/Invalid asset path/);
});
