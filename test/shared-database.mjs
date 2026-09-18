// Integration coverage against a dedicated PostgreSQL database; no WhatsApp messages are sent.
import pg from 'pg';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
const conn=process.env.TEST_DATABASE_URL;
if(!conn || !new URL(conn).pathname.endsWith('_test')) throw Error('TEST_DATABASE_URL must end in _test');
const db=new pg.Client({connectionString:conn});await db.connect();
const snapshot=async()=> (await db.query('SELECT id,user_id,amount,description,account_id,to_account_id FROM transactions ORDER BY id')).rows;
const migration=fs.readFileSync(new URL('../db/migrations/002_shared_workspaces.sql',import.meta.url),'utf8');
const base={intent:'expense',transaction_type:'expense',amount:35000,currency:'IDR',category:'food',description:'nasi padang',transaction_date:'2026-09-16',payment_method:null,account:null,from_account:null,to_account:null,transaction_id:null,query_period:null,query_category:null,needs_clarification:false,clarification_question:null,confidence:0.99};
const prefix=String(Date.now());
const owner={from:prefix+'01@c.us',sender_name:'Ayah'};
const member={from:prefix+'02@lid',sender_name:'Ibu'};
const outsider={from:prefix+'03@c.us',sender_name:'Luar'};
const fourth={from:prefix+'04@c.us',sender_name:'Anggota empat'};
const claim=async(who,text='test',message_id=crypto.randomUUID(),client=db,extra={})=>(await client.query('SELECT prepare_message($1) AS e',[{...who,text,message_id,timestamp:1,is_group:false,...extra}])).rows[0].e;
const apply=async(e,p={},client=db)=>(await client.query('SELECT apply_message($1,$2,$3,$4) AS r',[e.user_id,e.message_id,e.lease_token,{...base,...p}])).rows[0].r;
const command=async(who,text,mid=crypto.randomUUID(),client=db)=>{
 const e=await claim(who,text,mid,client); assert.equal(e.proceed,false,JSON.stringify(e));
 assert.equal(e.response.success,true,e.response.reply); return e.response.reply;
};
const run=async(who,p={},text='test')=>{
 const e=await claim(who,text);assert.equal(e.proceed,true,JSON.stringify(e));
 const r=await apply(e,p);assert.equal(r.success,true,r.reply);return {e,r};
};
const tokenOf=reply=>reply.match(/\/ruang gabung ([A-F0-9]{32})/)[1];
const scalar=async(sql,params=[])=>(await db.query(sql,params)).rows[0].v;
try{
 const before=await snapshot();
 await db.query(migration);
 assert.deepEqual(await snapshot(),before,'migration must preserve existing financial data');
 assert.equal(Number(await scalar('SELECT count(*) AS v FROM transactions WHERE workspace_id IS NULL')),0);
 // Reapply safely; no duplicate workspaces/accounts and no data loss.
 await db.query(migration);assert.deepEqual(await snapshot(),before);
 console.log('PASS migration/backfill and repeat migration');
 const privateTx=await run(owner,{amount:99000,description:'Private only'});
 const privateId=privateTx.e.workspace_id;
 const scheduled=(await db.query("SELECT schedule_create($1,$2,$3,$4,$5::timestamptz,$6) AS result",[owner.from,'Ayah','628123456789','Pengingat keluarga','2099-09-20T01:30:00Z',crypto.randomUUID()])).rows[0].result;
 assert.equal(scheduled.success,true,scheduled.reply);
 const listed=(await db.query('SELECT schedule_list($1,$2) AS result',[owner.from,'Ayah'])).rows[0].result;
 assert.equal(listed.items.length,1);assert.equal(listed.items[0].recipient_number,'628123456789');
 assert.equal((await db.query('SELECT schedule_cancel($1,$2,$3::uuid) AS result',[owner.from,'Ayah',scheduled.id])).rows[0].result.success,true);
 const createMid=crypto.randomUUID();
 const made=await command(owner,'/ruang buat keluarga Keluarga Uji',createMid);
 assert.equal(await command(owner,'/ruang buat keluarga Keluarga Uji',createMid),made,'command retry must not create another workspace');
 const wid=made.match(/ID: ([a-f0-9-]{36})/)[1];
 assert.notEqual(wid,privateId);
 const inviteMid=crypto.randomUUID();
 const invite=await command(owner,'/ruang undang',inviteMid);
 assert.equal(await command(owner,'/ruang undang',inviteMid),invite,'retry returns same invitation');
 const token=tokenOf(invite);
 assert.match(await command(member,'/ruang gabung '+token),/Bergabung/);
 assert.match(await command(outsider,'/ruang gabung '+token),/sudah digunakan/);
 assert.match(await command(member,'/ruang undang'),/Hanya pemilik/);
 assert.match(await command(outsider,'/ruang pakai '+wid),/bukan anggotanya/);
 assert.match(await command(owner,'/ruang anggota'),/Ibu/);
 const a=await run(owner,{amount:45820,description:'nasi padang ShopeeFood'});
 const b=await run(member,{amount:60000,description:'Sayur'});
 assert.equal(a.e.workspace_id,wid);assert.equal(b.e.workspace_id,wid);
 assert.match(b.r.reply,/Keluarga Uji/);assert.match(b.r.reply,/Dicatat oleh: Ibu/);
 const accounts=await db.query("SELECT count(*) AS n FROM accounts WHERE workspace_id=$1 AND name='Cash'",[wid]);
 assert.equal(Number(accounts.rows[0].n),1,'Cash is shared across members');
 const report=await run(member,{intent:'report',transaction_type:'expense',query_period:'all_time'});
 assert.match(report.r.reply,/Rp105.820/);assert.doesNotMatch(report.r.reply,/99.000/);
 const balance=await run(member,{intent:'balance'});
 assert.match(balance.r.reply,/Rp-105.820/);
 const list=await run(owner,{intent:'transaction_list',transaction_type:null,query_period:'all_time'});
 assert.match(list.r.reply,/Dicatat: Ayah/);assert.match(list.r.reply,/Dicatat: Ibu/);
 assert.doesNotMatch(list.r.reply,/Private only/);
 const outsiderReport=await run(outsider,{intent:'report',transaction_type:null,query_period:'all_time'});
 assert.match(outsiderReport.r.reply,/Rp0/);assert.doesNotMatch(outsiderReport.r.reply,/105.820/);
 const txA=await scalar('SELECT id AS v FROM transactions WHERE user_id=$1 AND source_message_id=$2',[a.e.user_id,a.e.message_id]);
 const denied=await run(member,{intent:'edit_transaction',transaction_id:txA,amount:1});
 assert.match(denied.r.reply,/tidak ditemukan/);
 const privateTarget=await scalar('SELECT id AS v FROM transactions WHERE user_id=$1 AND source_message_id=$2',[privateTx.e.user_id,privateTx.e.message_id]);
 assert.match((await run(owner,{intent:'delete_transaction',transaction_id:privateTarget})).r.reply,/tidak ditemukan/);
 // "Last" is always the requesting member's latest record, even for the owner.
 await run(owner,{intent:'edit_transaction',transaction_id:'last',amount:50000,description:null,category:null,transaction_date:null});
 assert.equal(Number(await scalar('SELECT amount AS v FROM transactions WHERE id=$1',[txA])),50000);
 const txB=await scalar('SELECT id AS v FROM transactions WHERE user_id=$1 AND source_message_id=$2',[b.e.user_id,b.e.message_id]);
 assert.equal(Number(await scalar('SELECT amount AS v FROM transactions WHERE id=$1',[txB])),60000);
 await run(owner,{intent:'edit_transaction',transaction_id:txB,amount:65000,description:null,category:null,transaction_date:null});
 assert.equal(await scalar('SELECT user_id AS v FROM transactions WHERE id=$1',[txB]),b.e.user_id,'owner edit preserves recorder');
 const ledgerSum=await scalar('SELECT sum(amount) AS v FROM ledger_movements WHERE workspace_id=$1',[wid]);
 assert.equal(Number(ledgerSum),-115000);
 await run(member,{intent:'income',transaction_type:'income',amount:1000000,category:'salary',description:'Dana keluarga',account:'BCA'});
 await run(owner,{intent:'transfer',transaction_type:'transfer',amount:100000,from_account:'BCA',to_account:'GoPay',description:'Transfer'});
 assert.equal(Number(await scalar('SELECT sum(amount) AS v FROM ledger_movements WHERE workspace_id=$1',[wid])),885000);
 await run(member,{amount:null,description:'listrik',needs_clarification:true,clarification_question:'Berapa nominal?'});
 await command(member,'/ruang pribadi');
 const isolated=await claim(member,'250 ribu');assert.equal(isolated.pending,null);
 assert.deepEqual(isolated.history,[],'shared context must not leak into private workspace');
 await apply(isolated,{intent:'help'});
 await command(member,'/ruang pakai '+wid);
 const cleared=await claim(member);assert.equal(cleared.pending,null);await apply(cleared,{intent:'help'});
 // Receipt uses the same shared workspace and author; media bytes are not needed for DB writes.
 const receipt=await claim(member,'struk',undefined,db,{message_type:'image',media:{mime_type:'image/jpeg',size_bytes:100,sha256:'test'}});
 assert.equal(receipt.workspace_id,wid);
 const receiptReply=await apply(receipt,{amount:25000,description:'Struk pasar'});
 assert.match(receiptReply.reply,/Dicatat oleh: Ibu/);
 // Expired invitation and arbitrary SQL-looking command arguments cannot grant membership.
 const expired=tokenOf(await command(owner,'/ruang undang'));
 await db.query("UPDATE workspace_invites SET expires_at=now()-interval '1 second' WHERE token_hash=encode(digest($1,'sha256'),'hex')",[expired]);
 assert.match(await command(outsider,'/ruang gabung '+expired),/kedaluwarsa/);
 assert.match(await command(outsider,"/ruang pakai x'; DROP TABLE users; --"),/bukan anggotanya/);
 // Concurrent redemption: exactly one of two distinct senders may join.
 const concurrent=tokenOf(await command(owner,'/ruang undang'));
 const c2=new pg.Client({connectionString:conn});await c2.connect();
 try{
  const replies=await Promise.all([command(outsider,'/ruang gabung '+concurrent,undefined,db),command(fourth,'/ruang gabung '+concurrent,undefined,c2)]);
  assert.equal(replies.filter(r=>r.includes('Bergabung')).length,1);
  assert.equal(replies.filter(r=>r.includes('sudah digunakan')).length,1);
 }finally{await c2.end();}
 // A removed member with a live parser lease cannot commit into the shared workspace.
 const stale=await claim(member);
 const uid=stale.user_id;
 const unused=tokenOf(await command(owner,'/ruang undang'));
 assert.match(await command(owner,'/ruang keluarkan '+uid),/dikeluarkan/);
 const staleResult=await apply(stale,{amount:123456});
 assert.equal(staleResult.success,false);assert.equal(staleResult.retryable,false);
 assert.match(staleResult.reply,/Akses ruang/);
 const reset=await claim(member,'beli beras 100rb');
 assert.equal(reset.proceed,false);assert.equal(reset.response.retryable,false);
 assert.match(reset.response.reply,/Pesan belum dicatat/);
 assert.match(await command(member,'/ruang gabung '+unused),/kedaluwarsa/);
 assert.match(await command(member,'/ruang pakai '+wid),/bukan anggotanya/);
 assert.equal(Number(await scalar('SELECT count(*) AS v FROM transactions WHERE workspace_id=$1 AND amount=123456',[wid])),0);
 assert.equal(Number(await scalar('SELECT count(*) AS v FROM transactions WHERE id=$1',[txB])),1,'removal preserves historical records');
 // Rejoin then leave voluntarily; owner cannot leave and orphan a workspace.
 const rejoin=tokenOf(await command(owner,'/ruang undang'));
 await command(member,'/ruang gabung '+rejoin);
 assert.match(await command(member,'/ruang keluar'),/Anda keluar/);
 assert.match(await command(owner,'/ruang keluar'),/Pemilik tidak dapat/);
 // Owner can delete another member's explicit transaction and ledger remains consistent.
 await run(owner,{intent:'delete_transaction',transaction_id:txB});
 assert.equal(Number(await scalar('SELECT count(*) AS v FROM ledger_movements WHERE transaction_id=$1',[txB])),0);
 // Separate team, personal, and family keep balances and histories isolated.
 assert.match(await command(owner,'/ruang buat tim Tim Uji'),/Ruang dibuat/);
 assert.match((await run(owner,{intent:'balance'})).r.reply,/Rp0/);
 const teamInvite=tokenOf(await command(owner,'/ruang undang'));
 await command(member,'/ruang gabung '+teamInvite);
 const teamA=await claim(owner),teamB=await claim(member);
 const writer=new pg.Client({connectionString:conn});await writer.connect();
 try {
  const results=await Promise.all([apply(teamA,{amount:17000}),apply(teamB,{amount:23000},writer)]);
  assert.ok(results.every(r=>r.success),JSON.stringify(results));
 } finally { await writer.end(); }
 assert.equal(Number(await scalar("SELECT count(*) AS v FROM accounts WHERE workspace_id=$1 AND name='Cash'",[teamA.workspace_id])),1);
 assert.match((await run(member,{intent:'balance'})).r.reply,/Rp-40.000/);
 const foreignAccount=await scalar('SELECT account_id AS v FROM transactions WHERE id=$1',[privateTarget]);
 await assert.rejects(db.query('UPDATE transactions SET account_id=$1 WHERE workspace_id=$2',[foreignAccount,teamA.workspace_id]),e=>e.code==='23503');
 await command(owner,'/ruang pribadi');
 assert.match((await run(owner,{intent:'balance'})).r.reply,/Rp-99.000/);
 assert.equal(Number(await scalar('SELECT count(*) AS v FROM transactions WHERE id=$1',[privateTarget])),1);
 console.log('PASS shared expenses/receipts, reports, account/ledger scope, author attribution, owner/member permissions, private/team isolation, context reset, invitations/concurrency/revocation, duplicate commands');
}finally{await db.end();}
