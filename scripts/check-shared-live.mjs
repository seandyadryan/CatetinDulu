import 'dotenv/config';
import pg from 'pg';
import assert from 'node:assert/strict';
const db=new pg.Client({host:'127.0.0.1',port:Number(process.env.CHECK_DATABASE_PORT||25434),user:process.env.POSTGRES_USER,password:process.env.POSTGRES_PASSWORD,database:process.env.POSTGRES_DB});
await db.connect();
try {
 const migration=await db.query("SELECT version FROM schema_migrations WHERE version='002_shared_workspaces'");
 assert.equal(migration.rowCount,1);
 const broken=await db.query(`WITH expected AS (
  SELECT id AS transaction_id,user_id,workspace_id,account_id,CASE WHEN type='income' THEN amount ELSE -amount END AS amount FROM transactions
  UNION ALL
  SELECT id,user_id,workspace_id,to_account_id,amount FROM transactions WHERE type='transfer'
 ), actual AS (SELECT transaction_id,user_id,workspace_id,account_id,amount FROM ledger_movements)
 SELECT * FROM ((SELECT * FROM expected EXCEPT ALL SELECT * FROM actual)
 UNION ALL (SELECT * FROM actual EXCEPT ALL SELECT * FROM expected)) differences`);
 assert.equal(broken.rowCount,0,'ledger must match every financial transaction');
 const counts=(await db.query('SELECT (SELECT count(*) FROM transactions) AS transactions,(SELECT count(*) FROM workspaces) AS workspaces')).rows[0];
 console.log('Production migration present; ledger reconciled; counts:',counts);
}finally{await db.end();}
const site='https://catetindulu.amarlo.online';
assert.equal((await fetch(site+'/healthz')).status,200);
assert.equal((await fetch(site+'/api/status')).status,401);
const response=await fetch(site+'/api/status',{headers:{authorization:'Bearer '+process.env.ADMIN_TOKEN}});
assert.equal(response.status,200);
const status=await response.json();assert.equal(status.status,'ready');
console.log('WhatsApp ready; authenticated status; QR required:',Boolean(status.qr));
const internal='http://127.0.0.1:25679/webhook/';
// n8n can accept TCP before its published routes are registered after a restart.
for(let attempt=0;attempt<30;attempt++) {
 try {
  const probe=await fetch(internal+'finance-message',{method:'POST',headers:{'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(2000)});
  if(probe.status===403) break;
 } catch {}
 await new Promise(resolve=>setTimeout(resolve,1000));
}
assert.equal((await fetch(internal+'finance-message',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,403);
const invalid=await fetch(internal+'finance-message',{method:'POST',headers:{'content-type':'application/json','x-webhook-secret':process.env.N8N_WEBHOOK_SECRET},body:'{}'});
assert.equal(invalid.status,200);assert.equal((await invalid.json()).success,false);
assert.equal((await fetch(internal+'finance-shared-test',{method:'POST',headers:{'content-type':'application/json','x-webhook-secret':process.env.N8N_WEBHOOK_SECRET},body:'{}'})).status,404);
console.log('Production webhook healthy; isolated test endpoint unpublished');
