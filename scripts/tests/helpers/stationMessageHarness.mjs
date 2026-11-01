import { memoryDb,community,matches,uid } from './stationMembershipOwnerHarness.mjs';
export {uid};
export function messageDb(){
  const db=memoryDb([{...community(),members:[{id:'player-a',name:'Synthetic',status:'ACTIVE',role:'MEMBER'}]}]),base=db.collection;
  db.collection=name=>{const store=base(name);return {...store,async updateOne(query,update,options){
    if(update.$pull){let count=0;for(const row of db.tables.get(name)||[])if(matches(row,query)){for(const[k,v]of Object.entries(update.$pull))row[k]=(row[k]||[]).filter(item=>!matches(item,v));count++;}return {acknowledged:true,matchedCount:count,modifiedCount:count};}
    return store.updateOne(query,update,options);
  }};};return db;
}
