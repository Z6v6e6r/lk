import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildFlow as buildStandaloneFlow } from './build_flow.mjs';
import { createCampaignEngine } from './engine.mjs';
import { compatibleDatabase } from './mongo_compat.mjs';

export function buildCloudFlow(manifest,config,{mongoModule='mongodb',sendWindow,schedule}={}) {
  if (!/^[a-z][a-z0-9-]*$/.test(mongoModule)) throw new Error('invalid_mongo_module');
  // Reject secret-bearing extras and strip provenance not needed by the sender.
  const audience = { schemaVersion: manifest.schemaVersion, batchId: manifest.batchId,
    audienceSnapshotDate: manifest.audienceSnapshotDate,
    campaigns: manifest.campaigns.map(c=>({campaignId:c.campaignId,
      recipients:c.recipients.map(r=>({chatId:r.chatId}))})) };
  const messages = { schemaVersion: config.schemaVersion, botId: config.botId,
    campaigns: config.campaigns.map(c=>({campaignId:c.campaignId,type:c.type,fileId:c.fileId,
      text:c.text,link:c.link,utmConfirmed:c.utmConfirmed,
      utm:{source:c.utm?.source,medium:c.utm?.medium,campaign:c.utm?.campaign}})) };
  createCampaignEngine({crypto}).validate(audience,messages,true);
  if (/\b\d{5,15}:[A-Za-z0-9_-]{20,}\b/.test(JSON.stringify(messages)) ||
    JSON.stringify(messages).includes('https://api.telegram.org/file/bot')) throw new Error('credential_in_message_config');
  if (schedule && schedule.batchId !== audience.batchId) throw new Error('schedule_batch_mismatch');
  const nodes=buildStandaloneFlow({sendWindow,schedule});
  const controller=nodes.find(n=>n.type==='function');
  const start=controller.func.indexOf("  const readPrivate = name => {");
  const end=controller.func.indexOf('  let db;',start);
  if (start<0 || end<0) throw new Error('standalone_template_changed');
  controller.func=controller.func.slice(0,start)+
    `  const manifest = ${JSON.stringify(audience)};\n  const config = ${JSON.stringify(messages)};\n`+
    controller.func.slice(end);
  controller.func=`const compatibleDatabase = ${compatibleDatabase.toString()};\n`+controller.func;
  controller.func=controller.func.replace("writeConcern: { w: 'majority' }",
    "writeConcern: { w: 'majority', j: true }, readConcern: { level: 'majority' }, readPreference: 'primary'");
  controller.func=controller.func.replace('db = client.db(database);','db = compatibleDatabase(client.db(database));');
  controller.libs=controller.libs.filter(lib=>lib.var!=='fs');
  controller.libs.find(lib=>lib.var==='mongo').module=mongoModule;
  controller.name='Cloud campaigns — durable ledger';
  nodes[0].label='TG — FULL 4 campaigns — cloud';
  nodes[0].info='Private import contains fixed chatIds and 4 posts. No filesystem files or token/URI embedded. Uses Mongo driver already installed by the Mongo nodes (3.7.4 or modern drivers) through real acknowledgements, majority+journal and majority primary reads. Set 4 secret/service environment variables. Import disabled; manual PREVIEW → PREPARE → RUN/START. Never reset the batchId after beginning this campaign.';
  const rename=id=>id.replace(/_v1$/,'_cloud_v2');
  for (const n of nodes) {
    n.id=rename(n.id);
    if(n.z) n.z=rename(n.z);
    if(n.wires) n.wires=n.wires.map(w=>w.map(rename));
  }
  return nodes;
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const [audienceFile,configFile,output,mongoModule='mongodb']=process.argv.slice(2);
  if(![audienceFile,configFile,output].every(p=>p && path.isAbsolute(p))) throw new Error('absolute_paths_required');
  const nodes=buildCloudFlow(JSON.parse(await fs.readFile(audienceFile,'utf8')),
    JSON.parse(await fs.readFile(configFile,'utf8')),{mongoModule});
  await fs.writeFile(output,JSON.stringify(nodes,null,2)+'\n',{mode:0o600,flag:'wx'});
  console.log('Created disabled private cloud import; no credentials, filesystem or automatic sends.');
}
