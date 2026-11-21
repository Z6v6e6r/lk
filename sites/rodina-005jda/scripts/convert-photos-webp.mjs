// Optional delivery variants. Existing live URLs remain valid until these files are uploaded.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync}from'node:child_process';
import {fileURLToPath}from'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const source=path.join(root,'src/assets/venues');
const out=path.join(root,'dist/webp-for-upload/assets/venues');
fs.mkdirSync(out,{recursive:true});
const files=[];
for(const name of fs.readdirSync(source).sort()){
 if(!/\.(png|jpe?g)$/i.test(name))continue;
 const original=path.join(source,name),converted=name.replace(/\.(png|jpe?g)$/i,'.webp');
 const target=path.join(out,converted);
 execFileSync('cwebp',['-quiet','-q','84','-m','6',original,'-o',target]);
 const bytes=fs.readFileSync(target);
 if(bytes.toString('ascii',0,4)!=='RIFF'||bytes.toString('ascii',8,12)!=='WEBP')throw Error('Invalid WebP output');
 files.push({originalURL:'https://cg178013.tw1.ru/assets/venues/'+name,webpPath:'assets/venues/'+converted,originalBytes:fs.statSync(original).size,webpBytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')});
}
const originalBytes=files.reduce((n,f)=>n+f.originalBytes,0),webpBytes=files.reduce((n,f)=>n+f.webpBytes,0);
const report={files,originalBytes,webpBytes,savedPercent:Number(((originalBytes-webpBytes)*100/originalBytes).toFixed(1)),activeInT123:false};
fs.writeFileSync(path.join(root,'dist/webp-for-upload/WEBP-MAP.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({photos:files.length,originalBytes,webpBytes,savedPercent:report.savedPercent}));
