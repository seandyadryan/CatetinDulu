import 'dotenv/config';
import express from 'express';
import pino from 'pino';
import QRCode from 'qrcode';
import wa from 'whatsapp-web.js';
import pg from 'pg';
import { timingSafeEqual } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import path from 'node:path';
import { incoming,callWebhook,createSenderQueue } from './src/gateway.js';
import { attachReceipt, ReceiptError } from './src/receipt.js';
import { parseScheduleCommand, scheduleHelp } from './src/scheduler.js';
const log=pino({redact:['req.headers.authorization','text','from','qr']});
for(const name of ['N8N_WEBHOOK_SECRET','N8N_WEBHOOK_URL','ADMIN_TOKEN']) if(!process.env[name]) throw new Error(`${name} is required`);
const app=express(); app.disable('x-powered-by');
let status='starting',qrImage=null,stopping=false;
const queue=createSenderQueue(), active=new Set();
const db=process.env.POSTGRES_PASSWORD?new pg.Pool({host:process.env.POSTGRES_HOST||'postgres',port:Number(process.env.POSTGRES_PORT||5432),database:process.env.POSTGRES_DB||'catetindulu',user:process.env.POSTGRES_USER||'catetindulu',password:process.env.POSTGRES_PASSWORD,max:4}):null;
let schedulerTimer=null;
const allowed=new Set((process.env.WA_ALLOWED_NUMBERS||'').split(',').map(s=>s.trim()).filter(Boolean));
// This deployment has exactly one gateway replica per LocalAuth volume.
// Chromium singleton symlinks survive a killed/recreated container; session data is preserved.
for(const name of ['SingletonLock','SingletonSocket','SingletonCookie']) await unlink(path.join(process.env.WA_AUTH_PATH||'.wwebjs_auth','session',name)).catch(error=>{if(error.code!=='ENOENT')throw error;});
const client=new wa.Client({authStrategy:new wa.LocalAuth({dataPath:process.env.WA_AUTH_PATH||'.wwebjs_auth'}),puppeteer:{headless:true,executablePath:process.env.PUPPETEER_EXECUTABLE_PATH||undefined,args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage']}});
function auth(req,res,next){
 const a=Buffer.from(req.headers.authorization||''),b=Buffer.from(`Bearer ${process.env.ADMIN_TOKEN}`);
 if(a.length!==b.length || !timingSafeEqual(a,b)) return res.status(401).json({success:false,reply:'Autentikasi diperlukan.'});
 res.set('Cache-Control','no-store'); next();
}
app.get('/healthz',(_,res)=>res.json({success:true,service:'catetin-dulu'}));
app.get('/api/status',auth,(_,res)=>res.json({success:true,status,qr:qrImage}));
app.use(express.static('public',{index:'index.html'}));
client.on('qr',async qr=>{status='qr_required';qrImage=await QRCode.toDataURL(qr);log.info('WhatsApp QR available in authenticated setup page');});
client.on('ready',()=>{status='ready';qrImage=null;log.info('WhatsApp ready');});
client.on('authenticated',()=>{status='authenticated';qrImage=null;});
client.on('auth_failure',()=>{status='auth_failure';qrImage=null;log.error('WhatsApp authentication failed');});
client.on('disconnected',()=>{status='disconnected';qrImage=null;log.warn('WhatsApp disconnected; exiting for restart');void shutdown(1);});
async function scheduleCommand(payload, command) {
 if(!db) return {success:false,reply:'Penjadwalan belum tersedia di konfigurasi bot.'};
 if(command.kind==='help') return {success:true,reply:scheduleHelp()};
 if(command.kind==='create') return (await db.query('SELECT schedule_create($1,$2,$3,$4,$5::timestamptz,$6) AS result',[payload.from,payload.sender_name,command.recipientNumber,command.message,command.scheduledAt,payload.message_id])).rows[0].result;
 if(command.kind==='cancel') return (await db.query('SELECT schedule_cancel($1,$2,$3::uuid) AS result',[payload.from,payload.sender_name,command.id])).rows[0].result;
 const result=(await db.query('SELECT schedule_list($1,$2) AS result',[payload.from,payload.sender_name])).rows[0].result;
 const items=Array.isArray(result.items)?result.items:[];
 return {success:true,reply:items.length?`🗓️ Jadwal aktif\n\n${items.map(item=>`ID: ${item.id}\nKe: ${item.recipient_number}\nWaktu WIB: ${item.scheduled_at}\n${item.message_text}`).join('\n\n')}`:'Tidak ada jadwal aktif.'};
}
async function deliverDue() {
 if(!db || status!=='ready' || stopping) return;
 try {
  await db.query("UPDATE scheduled_messages SET status='pending',updated_at=now() WHERE status='sending' AND updated_at<now()-interval '5 minutes'");
  const rows=(await db.query(`UPDATE scheduled_messages SET status='sending',attempts=attempts+1,updated_at=now()
    WHERE id IN (SELECT id FROM scheduled_messages WHERE status='pending' AND scheduled_at<=now() ORDER BY scheduled_at FOR UPDATE SKIP LOCKED LIMIT 10)
    RETURNING *`)).rows;
  for(const item of rows) {
   try {
    const numberId=await client.getNumberId(item.recipient_number);
    if(!numberId) throw new Error('Nomor tujuan tidak terdaftar di WhatsApp.');
    await client.sendMessage(numberId._serialized||`${item.recipient_number}@c.us`,item.message_text);
    await db.query("UPDATE scheduled_messages SET status='sent',sent_at=now(),updated_at=now(),last_error=NULL WHERE id=$1",[item.id]);
   } catch(error) {
    const retry=item.attempts<3;
    await db.query(`UPDATE scheduled_messages SET status=$2,scheduled_at=CASE WHEN $2='pending' THEN now()+interval '5 minutes' ELSE scheduled_at END,last_error=$3,updated_at=now() WHERE id=$1`,[item.id,retry?'pending':'failed',String(error.message||error).slice(0,500)]);
    log.error({schedule_id:item.id,error:error.message, retry},'Scheduled WhatsApp message failed');
   }
  }
 } catch(error) { log.error({error:error.message},'Scheduler poll failed'); }
}
function startScheduler() {
 if(!db || schedulerTimer) return;
 schedulerTimer=setInterval(()=>void deliverDue(),Math.max(5000,Number(process.env.SCHEDULER_POLL_MS||10000)));
 schedulerTimer.unref();
 void deliverDue();
}
client.on('ready',startScheduler);
client.on('message',message=>{
 if(stopping) return;
 const payload=incoming(message,message._data?.notifyName||'');
 if(!payload || (allowed.size && !allowed.has(payload.from.split('@')[0]))) return;
 const job=queue(payload.from,async()=>{
   try {
     message.id={...(typeof message.id==='object'?message.id:{}),_serialized:payload.message_id};
     let command=null;
     try { command=parseScheduleCommand(payload.text); } catch(error) { await client.sendMessage(message.from,error.message); return; }
     if(command) { const body=await scheduleCommand(payload,command); await client.sendMessage(message.from,body.reply); return; }
     const prepared=await attachReceipt(message,payload);
     const body=await callWebhook(prepared,{url:process.env.N8N_WEBHOOK_URL,secret:process.env.N8N_WEBHOOK_SECRET,timeout:Number(process.env.WEBHOOK_TIMEOUT_MS||60000)});
     await client.sendMessage(message.from,body.reply);
     log.info({message_id:payload.message_id,message_type:payload.message_type,success:body.success},'Message processed');
   }
   catch(error){log.error({message_id:payload.message_id,error:error.message},'Message failed');await client.sendMessage(message.from,error instanceof ReceiptError?error.message:'Maaf, layanan sedang mengalami gangguan. Coba lagi sebentar; periksa daftar transaksi sebelum mencatat ulang.').catch(()=>{});}
 });
 active.add(job);void job.finally(()=>active.delete(job)).catch(()=>{});
});
const server=app.listen(Number(process.env.PORT||3000),'0.0.0.0',()=>log.info('Gateway listening'));
client.initialize().catch(error=>{log.error({error:error.message},'WhatsApp initialization failed');void shutdown(1);});
async function shutdown(code=0){if(stopping)return;stopping=true;status='stopping';if(schedulerTimer)clearInterval(schedulerTimer);server.close();const timer=setTimeout(()=>process.exit(code||1),20000);timer.unref();await Promise.allSettled([...active]);await client.destroy().catch(()=>{});await db?.end().catch(()=>{});process.exit(code);}
process.on('SIGTERM',()=>void shutdown());process.on('SIGINT',()=>void shutdown());
