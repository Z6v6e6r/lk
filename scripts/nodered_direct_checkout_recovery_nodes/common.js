// Pure UTF-8 SHA-256: Node-RED's function sandbox exposes Buffer, not node:crypto.
function dcrSha(text) {
  const input = Buffer.from(text, 'utf8'), length = input.length;
  const bytes = Buffer.alloc(Math.ceil((length + 9) / 64) * 64);
  input.copy(bytes); bytes[length] = 128;
  bytes.writeUInt32BE(Math.floor(length / 0x20000000), bytes.length - 8);
  bytes.writeUInt32BE((length * 8) >>> 0, bytes.length - 4);
  const constants = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  const state = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19], words = new Uint32Array(64);
  const rotate = (x,n) => (x >>> n) | (x << (32-n));
  for (let offset=0;offset<bytes.length;offset+=64) {
    for(let i=0;i<16;i++) words[i]=bytes.readUInt32BE(offset+i*4);
    for(let i=16;i<64;i++) { const a=words[i-15],b=words[i-2]; words[i]=(words[i-16]+(rotate(a,7)^rotate(a,18)^(a>>>3))+words[i-7]+(rotate(b,17)^rotate(b,19)^(b>>>10)))>>>0; }
    let [a,b,c,d,e,f,g,h]=state;
    for(let i=0;i<64;i++) { const first=(h+(rotate(e,6)^rotate(e,11)^rotate(e,25))+((e&f)^(~e&g))+constants[i]+words[i])>>>0; const second=((rotate(a,2)^rotate(a,13)^rotate(a,22))+((a&b)^(a&c)^(b&c)))>>>0; h=g;g=f;f=e;e=(d+first)>>>0;d=c;c=b;b=a;a=(first+second)>>>0; }
    [a,b,c,d,e,f,g,h].forEach((v,i)=>{state[i]=(state[i]+v)>>>0;});
  }
  return state.map(x=>x.toString(16).padStart(8,'0')).join('');
}
const DCR_PRODUCT = '6b98e7e3-5bd3-4e94-9dc3-7723ea52513e';
const DCR_DOMAIN = 'direct-checkout-closure:v1\0iSkq6G\0' + DCR_PRODUCT + '\0';
const dcrObject = x => !!x && typeof x === 'object' && !Array.isArray(x);
const dcrUUID = x => typeof x === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(x);
const dcrHash = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const dcrDate = x => typeof x === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(x) && Number.isFinite(Date.parse(x));
function dcrExact(values) { const items=values.filter(x=>x!==null&&x!==undefined); return items.length&&items.every(x=>typeof x==='string'&&x.length>0&&x===items[0])?items[0]:null; }
function dcrPhone(value) { if(typeof value!=='string')return null;let x=value.replace(/\D/g,'');if(x.length===10)x='7'+x;if(x.length===11&&x[0]==='8')x='7'+x.slice(1);return /^7\d{10}$/.test(x)?x:null; }
function dcrOwner(t) {
  const id=dcrExact([t.clientId,t.client?.id,t.client?.uuid,t.client?.clientId]);
  const values=[t.clientPhone,t.client?.phone,t.client?.mobile,t.client?.phoneNumber].filter(x=>x!=null);
  const phones=values.map(dcrPhone),phone=phones[0];
  return dcrUUID(id)&&phone&&phones.every(x=>x===phone)?{id,phone}:null;
}
function dcrFacts(t,actor,proof,cutoff,now) {
  if(!dcrObject(t)||!dcrUUID(t.id)||!dcrObject(actor)||!dcrObject(proof)||!dcrDate(cutoff))return false;
  const id=t.id,owner=dcrOwner(t),line=t.products?.[0],card=t.cardPaymentInfo;
  if(dcrExact([t.id,t.uuid,t.transactionId])!==id||dcrExact([t.status,t.state,t.paymentStatus,t.transactionStatus])!=='UNPAID')return false;
  if(!owner||owner.id!==actor.id||owner.phone!==actor.phone||dcrSha(DCR_DOMAIN+id+'\0'+owner.id+'\0'+owner.phone)!==proof.ownerBinding)return false;
  if(!Array.isArray(t.products)||t.products.length!==1||!dcrObject(line)||dcrExact([line.id,line.uuid,line.productId,line.product?.id,t.productId])!==DCR_PRODUCT||line.type!=='SUBSCRIPTION'||line.count!==1)return false;
  if(line.cost!==1980000||!Number.isSafeInteger(line.discount)||line.discount<0||line.discount>=line.cost
    ||t.sum!==line.cost||t.discount!==line.discount||t.toPay!==line.cost-line.discount||t.deposit!==0)return false;
  for(const key of ['paymentDate','paidAt','refundDate','refundedAt','refundSum','refundedAmount','paidAmount','paidAmountMinor','paidAmountKopecks','clientSubscriptionId'])if(t[key])return false;
  if(t.paid===true||line.used===true||line.refunded===true||line.clientSubscriptionId||t.clientSubscription?.id||line.clientSubscription?.id)return false;
  if(!dcrObject(card)||Object.keys(card).some(k=>!['paymentId','paymentUrl','status','declineOutcome','declineReason','declineMessage'].includes(k)))return false;
  if(card.status!=='REJECTED'||card.declineOutcome!=='EXPIRED'||card.declineReason!=='OTHER'||card.declineMessage!==null||typeof card.paymentId!=='string'||!/^[a-zA-Z0-9-]{1,100}$/.test(card.paymentId))return false;
  if(typeof card.paymentUrl!=='string'||!/^https:\/\/pay\.vivacrm\.ru\/[A-Za-z0-9_/?=&.%~-]+$/.test(card.paymentUrl)||card.paymentUrl.length>4096)return false;
  if(dcrSha(DCR_DOMAIN+id+'\0'+card.paymentId+'\0'+card.paymentUrl)!==proof.paymentBinding)return false;
  if(!['SMS','WIDGET','CARD'].includes(t.paymentMethod)||!Array.isArray(t.paymentLegs)||dcrSha(DCR_DOMAIN+id+'\0'+JSON.stringify({paymentMethod:t.paymentMethod,paymentLegs:t.paymentLegs,discountMinor:t.discount,toPayMinor:t.toPay}))!==proof.legsBinding)return false;
  if(t.processingStatus!==null||t.possibleDoublePayment!==false||t.receiptPending!==false||t.acquiringAuthCode||t.acquiringRrnCode)return false;
  for(const key of ['purchasedServices','receipts','executedSurcharges','paidByOtherSaleBookingIds','transactionRefunds'])if(!Array.isArray(t[key])||t[key].length)return false;
  for(const key of ['cardPaymentStatus','payments','cardPayments','paymentAttempts','payment','paymentInfo'])if(t[key]!=null)return false;
  if(!dcrDate(t.createDate)||!dcrDate(t.paymentDueDate)||t.createDate!==proof.createdAt||t.paymentDueDate!==proof.expiresAt||Date.parse(t.createDate)>=Date.parse(cutoff))return false;
  return now>=Math.max(Date.parse(t.paymentDueDate),Date.parse(t.createDate)+25*60000)+60000;
}
function dcrResponse(msg,status,payload,index,count) {
  const output=Array(count).fill(null);
  output[index]={_msgid:msg._msgid,req:msg.req,res:msg.res,statusCode:status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'},payload};
  return output;
}
function dcrRequest(msg,context,stage,url,method,headers,payload) {
  return [{_msgid:msg._msgid,req:msg.req,res:msg.res,_directCheckoutRecovery:{...context,stage,expectedUrl:url},method,url,headers,followRedirects:false,requestTimeout:4000,httpRequestTimeout:4000,payload},null,null,null,null];
}
