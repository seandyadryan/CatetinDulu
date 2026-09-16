import 'dotenv/config';
import express from 'express';
import pino from 'pino';
import QRCode from 'qrcode';
import wa from 'whatsapp-web.js';
import { timingSafeEqual } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import path from 'node:path';
import { incoming,callWebhook,createSenderQueue } from './src/gateway.js';
import { attachReceipt, ReceiptError } from './src/receipt.js';
const log=pino({redact:['req.headers.authorization','text','from','qr']});
for(const name of ['N8N_WEBHOOK_SECRET','N8N_WEBHOOK_URL','ADMIN_TOKEN']) if(!process.env[name]) throw new Error(`${name} is required`);
const app=express(); app.disable('x-powered-by');
let status='starting',qrImage=null,stopping=false;
const queue=createSenderQueue(), active=new Set();
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
client.on('message',message=>{
 if(stopping) return;
 const payload=incoming(message,message._data?.notifyName||'');
 if(!payload || (allowed.size && !allowed.has(payload.from.split('@')[0]))) return;
 const job=queue(payload.from,async()=>{
   try {
     message.id={...(typeof message.id==='object'?message.id:{}),_serialized:payload.message_id};
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
async function shutdown(code=0){if(stopping)return;stopping=true;status='stopping';server.close();const timer=setTimeout(()=>process.exit(code||1),20000);timer.unref();await Promise.allSettled([...active]);await client.destroy().catch(()=>{});process.exit(code);}
process.on('SIGTERM',()=>void shutdown());process.on('SIGINT',()=>void shutdown());
