// Runs on a dedicated database. Never point this script at the production database.
import pg from 'pg';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
const conn=process.env.TEST_DATABASE_URL;
if(!conn||!new URL(conn).pathname.endsWith('_test'))throw Error('TEST_DATABASE_URL must end in _test');
const db=new pg.Client({connectionString:conn});await db.connect();
try{
 db.on('notice',n=>{if(n.severity==='WARNING')console.log(n.message);});
 await db.query(fs.readFileSync(new URL('../db/schema.sql',import.meta.url),'utf8').replace('EXCEPTION WHEN OTHERS THEN',"EXCEPTION WHEN OTHERS THEN RAISE WARNING '%', SQLERRM;"));
 // A reused test database may already have the shared-workspace columns and constraints.
 if ((await db.query("SELECT to_regclass('public.workspaces') AS t")).rows[0].t) {
  await db.query(fs.readFileSync(new URL('../db/migrations/002_shared_workspaces.sql',import.meta.url),'utf8'));
 }
 const sender=`${Date.now()}@c.us`,sender2=`${Date.now()+1}@c.us`;
 const base={intent:'expense',transaction_type:'expense',amount:35000,currency:'IDR',category:'food',description:'nasi padang',transaction_date:'2026-09-16',payment_method:null,account:null,from_account:null,to_account:null,transaction_id:null,query_period:null,query_category:null,needs_clarification:false,clarification_question:null,confidence:0.99};
 const claim=async(from=sender,id=crypto.randomUUID(),text='test')=>(await db.query('SELECT prepare_message($1) e',[{from,message_id:id,text,timestamp:1,is_group:false}])).rows[0].e;
 const apply=async(e,p)=>(await db.query('SELECT apply_message($1,$2,$3,$4) r',[e.user_id,e.message_id,e.lease_token,p])).rows[0].r;
 const run=async(p,from=sender)=>{const e=await claim(from);assert.equal(e.proceed,true);const r=await apply(e,{...base,...p});assert.equal(r.success,true,r.reply);return {e,r};};
 const first=await run({intent:'income',transaction_type:'income',amount:8000000,category:'salary',account:'BCA',description:'gaji'});
 assert.equal((await claim(sender,first.e.message_id)).proceed,false);
 assert.match((await claim(sender,first.e.message_id)).response.reply,/sudah tercatat/);
 await run({amount:35000});
 await run({intent:'transfer',transaction_type:'transfer',amount:500000,from_account:'BCA',to_account:'GoPay',description:'transfer'});
 const balances=(await db.query('SELECT a.name,sum(l.amount)::bigint AS balance FROM accounts a JOIN ledger_movements l ON l.account_id=a.id WHERE a.user_id=$1 GROUP BY a.name',[first.e.user_id])).rows;
 assert.equal(Number(balances.find(a=>a.name==='BCA').balance),7500000);
 assert.equal(Number(balances.find(a=>a.name==='GoPay').balance),500000);
 assert.equal(balances.reduce((s,a)=>s+Number(a.balance),0),7965000);
 await run({intent:'edit_transaction',transaction_id:'last',amount:600000,category:null,description:null,transaction_date:null});
 assert.equal(Number((await db.query('SELECT sum(amount) s FROM ledger_movements WHERE user_id=$1',[first.e.user_id])).rows[0].s),7965000);
 const transfer=(await db.query("SELECT id FROM transactions WHERE user_id=$1 AND type='transfer'",[first.e.user_id])).rows[0];
 const other=await run({intent:'delete_transaction',transaction_id:transfer.id},sender2);assert.match(other.r.reply,/tidak ditemukan/);
 await run({intent:'delete_transaction',transaction_id:'last'});
 assert.equal(Number((await db.query('SELECT count(*) n FROM ledger_movements WHERE transaction_id=$1',[transfer.id])).rows[0].n),0);
 const context=await run({amount:null,category:'utilities',description:'listrik',needs_clarification:true,clarification_question:'Berapa nominalnya?'});
 const next=await claim(sender,undefined,'250 ribu');assert.equal(next.pending.description,'listrik');
 await apply(next,{...base,amount:250000,category:'utilities',description:'listrik'});
 const report=await run({intent:'report',query_period:'all_time',transaction_type:null});assert.match(report.r.reply,/Rp285.000/);
 const filtered=await run({intent:'report',query_period:'all_time',transaction_type:'expense',query_category:'food'});assert.match(filtered.r.reply,/Rp35.000/);assert.doesNotMatch(filtered.r.reply,/Pemasukan/);
 const locked=await claim();assert.equal((await claim()).proceed,false);
 assert.equal((await apply(locked,{...base,intent:'transfer',from_account:'BCA',to_account:'BCA'})).success,false);
 const retried=await claim(sender,locked.message_id);assert.equal(retried.proceed,true);await apply(retried,base);
 const before=(await db.query('SELECT count(*) n FROM transactions WHERE user_id=$1',[first.e.user_id])).rows[0].n;
 const injection=await run({description:"coffee'); DROP TABLE users; --"});
 assert.equal((await db.query('SELECT count(*) n FROM transactions WHERE user_id=$1',[first.e.user_id])).rows[0].n, String(Number(before)+1));
 console.log('PASS: income, expense, balanced transfer, edit/delete ledger, user isolation, duplicate, context, report/filter, lease/retry, SQL injection safety');
}finally{await db.end();}
