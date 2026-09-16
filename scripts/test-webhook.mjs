import 'dotenv/config';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
const url='http://127.0.0.1:25678/webhook/finance-message-test',from=`${Date.now()}@c.us`;
const send=async(text,id=crypto.randomUUID())=>{
 const p={message_id:id,from,sender_name:'Isolated integration test',text,timestamp:Math.floor(Date.now()/1000),is_group:false};
 const res=await fetch(url,{method:'POST',headers:{'content-type':'application/json','x-webhook-secret':process.env.N8N_WEBHOOK_SECRET},body:JSON.stringify(p),signal:AbortSignal.timeout(65000)});
 const raw=await res.text();assert.equal(res.status,200,raw);let body;try{body=JSON.parse(raw);}catch{throw Error(`Invalid JSON response: ${raw}`);}
 console.log(text,body);assert.equal(body.success,true);return {body,id};
};
const delay=()=>new Promise(r=>setTimeout(r,15000));
const unauth=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});assert.equal(unauth.status,403);console.log('PASS: missing authentication rejected');
const first=await send('gaji masuk 8 juta ke BCA');assert.match(first.body.reply,/Rp8.000.000/);
const dup=await send('gaji masuk 8 juta ke BCA',first.id);assert.match(dup.body.reply,/sudah tercatat/);await delay();
let r=await send('transfer 500rb dari BCA ke Gopay');assert.match(r.body.reply,/Transfer dicatat/);await delay();
r=await send('bayar listrik');assert.match(r.body.reply,/nominal|berapa/i);await delay();
r=await send('250 ribu');assert.match(r.body.reply,/Rp250.000/);assert.match(r.body.reply,/listrik/i);await delay();
r=await send('ubah transaksi terakhir menjadi 300 ribu');assert.match(r.body.reply,/Rp300.000/);await delay();
r=await send('pengeluaran saya bulan ini berapa?');assert.match(r.body.reply,/Rp300.000/);await delay();
r=await send('saldo saya');assert.match(r.body.reply,/Rp7.700.000/);await delay();
r=await send('hapus transaksi terakhir');assert.match(r.body.reply,/dihapus/);await delay();
r=await send('laporan bulan ini');assert.match(r.body.reply,/Rp8.000.000/);assert.match(r.body.reply,/Pengeluaran\nRp0/);
console.log('PASS: full authenticated n8n→Groq→PostgreSQL→response flow in isolated test database');
