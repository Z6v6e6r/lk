import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
export const PAYLOAD_FILES=[
  'scripts/lk1_subscription_visit_dev/fixture.mjs','scripts/lk1_subscription_visit_dev/runtime.mjs',
  'scripts/lk1_subscription_visit_dev/start.mjs','scripts/lk1_subscription_visit_dev/packet.mjs',
  'scripts/lk1_subscription_visit_dev/verify.mjs','scripts/lk1_subscription_visit_dev/package.json',
  'scripts/lk1_subscription_visit_dev/package-lock.json',
  'scripts/lib/subscriptionVisitWorker.mjs','scripts/lib/subscriptionVisitLifecycle.mjs',
  'flows.json','config.json','README.txt',
];
export function verifyPacket(packet,entry) {
  packet=fs.realpathSync(packet);
  if(entry && fs.realpathSync(entry)!==path.join(packet,'scripts/lk1_subscription_visit_dev/start.mjs'))throw Error('DEV_ENTRY_MISMATCH');
  const manifest=JSON.parse(fs.readFileSync(path.join(packet,'manifest.json'),'utf8'));
  if(manifest.formatVersion!==1||manifest.environment!=='DEV'||manifest.purpose!=='SYNTHETIC_PAID_JOIN_REHEARSAL'
    ||manifest.productionCompatible!==false||manifest.installAuthorized!==false||manifest.startAuthorized!==false
    ||!Array.isArray(manifest.files)||manifest.files.map(r=>r.path).sort().join()!==[...PAYLOAD_FILES].sort().join())throw Error('DEV_MANIFEST_INVALID');
  for(const row of manifest.files){
    const file=path.join(packet,row.path);
    if(fs.realpathSync(file)!==file||!fs.lstatSync(file).isFile())throw Error('DEV_MANIFEST_PATH');
    if(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')!==row.sha256)throw Error('DEV_PACKET_DRIFT');
  }
  return manifest;
}
export function newPrivateUserDir(userDir) {
  const parent=fs.realpathSync(path.dirname(userDir)),target=path.join(parent,path.basename(userDir));
  if(!/^\/(?:private\/)?tmp\//.test(target)||fs.existsSync(target))throw Error('DEV_NEW_PRIVATE_USER_DIR_REQUIRED');
  fs.mkdirSync(target,{mode:0o700});return target;
}
