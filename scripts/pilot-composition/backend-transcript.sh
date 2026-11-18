#!/bin/bash
# Backend transcript against the isolated composition (no real Viva/CUP call).
# Usage: NEW=https://127.0.0.1:8443 FIXTURE=https://127.0.0.1:9443 MONGO_CONTAINER=lk1-pilot-mongo ./backend-transcript.sh
set -u
NEW=${NEW:-https://127.0.0.1:8443}
FIX=${FIXTURE:-https://127.0.0.1:9443}
MONGO_CONTAINER=${MONGO_CONTAINER:-lk1-pilot-mongo}
PID=4037a3a3-e551-4f9a-a9db-1410e46b8635
TOKEN=$(node -e 'const b=o=>Buffer.from(JSON.stringify(o)).toString("base64url");process.stdout.write(b({alg:"none",typ:"JWT"})+"."+b({sub:"pilot.user.0001",phone:"+79990000000",azp:"widget",tenant_key:"iSkq6G",role:"pilot",exp:Math.floor(Date.now()/1000)+86400})+".")')
ORD=$(node -e 'const b=o=>Buffer.from(JSON.stringify(o)).toString("base64url");process.stdout.write(b({alg:"none",typ:"JWT"})+"."+b({sub:"ordinary.user.0001",phone:"+79990000001",azp:"widget",tenant_key:"iSkq6G",role:"ordinary",exp:Math.floor(Date.now()/1000)+86400})+".")')
reset() {
  curl -sk -X POST $FIX/_control/reset >/dev/null
  docker exec $MONGO_CONTAINER mongosh lk_residency_pilot --quiet --eval 'db.lk_residency_lifecycle_orders.deleteMany({})' >/dev/null
}
create() {
  curl -sk -X POST $NEW/lk/residency/orders -H "Authorization: Bearer $1" -H 'Content-Type: application/json' \
    -H "Idempotency-Key: $2" -H 'X-Residency-Return-Target: lk1pilot' \
    -d '{"mode":"NEW","expectedTotalMinor":79000,"expectedProductId":"'$PID'"}'
}
summary() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log(JSON.stringify(j.code?{code:j.code}:j.id?{transactionId:j.id,toPay:j.toPay,paymentUrl:j.paymentUrl}:{orderId:j.order?.orderId,state:j.order?.state,payment:j.order?.payment?.status,externalCheck:j.externalCheck}))}catch{console.log(s.slice(0,200))}})'; }

echo "== 1. reset =="
reset
echo "== 2. published old client creates its Viva transaction directly =="
OLD=$(curl -sk -X POST $FIX/viva/end-user/api/v1/iSkq6G/transactions -H 'Content-Type: application/json' -d '{"clientPhone":"+79990000000","products":[{"id":"'$PID'","type":"SUBSCRIPTION","count":1}],"baseRedirectUrl":"https://127.0.0.1:8444/lk_new?phCheckoutReturn=residency"}')
echo "$OLD" | summary
OLDID=$(printf '%s' "$OLD" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).id))')
echo "== 3. new create refused before any provider POST =="
create "$TOKEN" transcript-key-0001 | summary
echo "mongo_orders=$(docker exec $MONGO_CONTAINER mongosh lk_residency_pilot --quiet --eval 'db.lk_residency_lifecycle_orders.countDocuments({})')"
echo "== 4. old transaction is a confirmed terminal refusal (CANCELLED) =="
curl -sk -X POST $FIX/_control/settle -H 'Content-Type: application/json' -d '{"transactionId":"'$OLDID'","status":"CANCELLED"}' | summary
echo "== 5. new create proceeds =="
CREATE2=$(create "$TOKEN" transcript-key-0001)
echo "$CREATE2" | summary
ORDERID=$(printf '%s' "$CREATE2" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).order.orderId))')
NEWID=$(curl -sk $FIX/_control/state | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.txs.find(x=>x.source==="new").id)})')
echo "== 6. provider confirms payment, CUP confirms activation =="
curl -sk -X POST $FIX/_control/pay -H 'Content-Type: application/json' -d '{"transactionId":"'$NEWID'"}' >/dev/null
curl -sk -X POST $NEW/lk/residency/orders/$ORDERID/reconcile -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -H 'Idempotency-Key: transcript-reconcile-0001' -d '{"eventId":"evt-transcript-1"}' | summary
echo "== 7. reverse: new order first, old checkout second, old payment =="
reset
CREATE3=$(create "$TOKEN" transcript-key-0002); ORDER3=$(printf '%s' "$CREATE3" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).order.orderId))')
OLD2=$(curl -sk -X POST $FIX/viva/end-user/api/v1/iSkq6G/transactions -H 'Content-Type: application/json' -d '{"clientPhone":"+79990000000","products":[{"id":"'$PID'","type":"SUBSCRIPTION","count":1}],"baseRedirectUrl":"https://127.0.0.1:8444/lk_new?phCheckoutReturn=residency"}')
OLD2ID=$(printf '%s' "$OLD2" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).id))')
curl -sk $NEW/lk/residency/orders?state=unresolved -H "Authorization: Bearer $TOKEN" | summary
curl -sk -X POST $FIX/_control/pay -H 'Content-Type: application/json' -d '{"transactionId":"'$OLD2ID'"}' >/dev/null
curl -sk -X POST $NEW/lk/residency/orders/$ORDER3/reconcile -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -H 'Idempotency-Key: transcript-reconcile-0002' -d '{"eventId":"evt-transcript-2"}' | summary
echo "== 8. ordinary account: new create denied, no order =="
reset
create "$ORD" transcript-key-0003 | summary
echo "mongo_orders=$(docker exec $MONGO_CONTAINER mongosh lk_residency_pilot --quiet --eval 'db.lk_residency_lifecycle_orders.countDocuments({})')"
echo "== 9. two devices at the same time =="
reset
( create "$TOKEN" transcript-key-aaaa > /tmp/t-a.json; echo "A_status_body:"; cat /tmp/t-a.json; echo ) &
( create "$TOKEN" transcript-key-bbbb > /tmp/t-b.json; echo "B_status_body:"; cat /tmp/t-b.json; echo ) &
wait
echo "mongo_orders=$(docker exec $MONGO_CONTAINER mongosh lk_residency_pilot --quiet --eval 'db.lk_residency_lifecycle_orders.countDocuments({})')"
echo "new_txs=$(curl -sk $FIX/_control/state | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.txs.filter(t=>t.source==="new").length)})')"
