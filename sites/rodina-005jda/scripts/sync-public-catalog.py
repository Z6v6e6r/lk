"""Read-only catalog audit. No authentication, bookings, payments or admin writes."""
from pathlib import Path
import json,re,subprocess,concurrent.futures,datetime
root=Path(__file__).resolve().parent.parent
out=root/'audit/public';out.mkdir(exist_ok=True)
widgets=json.loads((root/'audit/widgets.json').read_text())
def get(url,path):
 subprocess.run(['curl','--proxy','socks5h://127.0.0.1:17892','--connect-timeout','10','--max-time','30','-fsS',url,'-o',str(path)],check=True)
 return path.read_text()
def audit(pair):
 arena,wid=pair
 s=get('https://supadb.vivacrm.ru/storage/v1/object/public/widgets/'+wid+'.js',out/(arena+'-widget.js'))
 c=json.loads(re.search(r'var initConfig = (\{[\s\S]+?\n\})',s).group(1))
 assert c['tenantKey']=='005JDA',arena
 mid=c['masterServiceId'];base='https://api.vivacrm.ru/end-user/api/v1/005JDA/products/master-services/'+mid
 replies={k:json.loads(get(base+'/'+k,out/(arena+'-'+k+'.json')))for k in ['meta','subServices','studios']}
 subs=[v for g in replies['subServices']for v in g['subServices']]
 candidates=[]
 for sub in subs:
  for available in sub.get('availableStudioRooms',[]):
   studio=available['studio']
   rooms=available.get('rooms',studio.get('rooms',[]))
   for room in rooms:
    rid=room['id']if isinstance(room,dict)else room
    if any(st['id']==studio['id'] and any(r['id']==rid for r in st.get('rooms',[]))for st in replies['studios']):
     candidates.append((sub,studio,rid))
 assert len(candidates)==1,(arena,'ambiguous subservice/studio/room',[(s['id'],st['id'],r)for s,st,r in candidates])
 sub,studio,rid=candidates[0];m=replies['meta']
 assert m['id']==mid and not m['paused'] and m['roomRentEnabled'],arena
 binding={'tenantKey':'005JDA','masterServiceId':mid,'subServiceId':sub['id'],'studioId':studio['id'],'roomId':rid,'minMinutes':m['minMinutesForBooking'],'stepMinutes':m['timeStepMinutes'],'timeZone':m['timeZone'],'serviceDuration':sub['exerciseDirection']['duration'],'continuous':True,'maxBookingDaysAhead':m['maxBookingDaysAhead']}
 report={'arenaId':arena,'widgetId':wid,'serviceName':m['name'],'subServiceName':sub['name'],'studioName':studio['name'],'binding':binding,'onlinePaymentEnabled':m.get('onlinePaymentEnabled'),'verifiedAt':datetime.datetime.now(datetime.timezone.utc).isoformat()}
 print(arena,m['name'],studio['name'],mid,flush=True)
 return arena,report
with concurrent.futures.ThreadPoolExecutor(max_workers=4)as pool: reports=dict(pool.map(audit,widgets.items()))
data=json.loads((root/'src/arenas.json').read_text())
for a in data['arenas']:
 if a['id']in reports:a['viva']=reports[a['id']]['binding']
(root/'src/arenas.json').write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n')
(root/'audit/catalog.json').write_text(json.dumps(reports,ensure_ascii=False,indent=2)+'\n')
