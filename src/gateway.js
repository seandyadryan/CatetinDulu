import { z } from 'zod';
export const responseSchema = z.object({success:z.boolean(),reply:z.string().min(1).max(12000),retryable:z.boolean().optional()});
export function messageId(message) {
  const id=message.id;
  if(typeof id==='string' && id.trim()) return id;
  if(typeof id?._serialized==='string' && id._serialized) return id._serialized;
  if(typeof id?.id==='string' && id.id && typeof message.from==='string') return `${Boolean(message.fromMe)}_${message.from}_${id.id}`;
  return null;
}
export function incoming(message, senderName = '') {
  if (message.fromMe || message.isStatus || typeof message.from!=='string' || message.from.endsWith('@g.us') || !['chat','image'].includes(message.type)) return null;
  const text=typeof message.body==='string'?message.body.trim():'';
  if (!/^\d+@(c\.us|lid)$/.test(message.from) || (message.type==='chat'&&!text) || text.length>2000) return null;
  const id=messageId(message),timestamp=Number(message.timestamp);
  if(!id || id.length>250 || !Number.isSafeInteger(timestamp) || timestamp<=0) return null;
  return {message_id:id,from:message.from,sender_name:String(senderName||'').slice(0,100),text:text||(message.type==='image'?'Baca bukti transaksi dari foto ini; tentukan pemasukan atau pengeluaran dari arah transaksi.':''),timestamp,is_group:false,message_type:message.type==='image'?'image':'text'};
}
export async function callWebhook(payload, {url,secret,timeout=60000,fetchImpl=fetch}) {
  for (let attempt=0; attempt<3; attempt++) {
    try {
      const res=await fetchImpl(url,{method:'POST',headers:{'content-type':'application/json','x-webhook-secret':secret},body:JSON.stringify(payload),signal:AbortSignal.timeout(timeout)});
      if (!res.ok) throw new Error(`Webhook HTTP ${res.status}`);
      const body=responseSchema.parse(await res.json());
      if (!body.success && body.retryable!==false && attempt<2) throw new Error('Workflow temporarily unavailable');
      return body;
    } catch(error) {
      if(attempt===2) throw error;
      await new Promise(resolve=>setTimeout(resolve,1000 * 2**attempt));
    }
  }
}
export function createSenderQueue() {
  const pending=new Map();
  return (sender,task)=>{
    const next=(pending.get(sender) || Promise.resolve()).catch(()=>{}).then(task);
    pending.set(sender,next);
    void next.finally(()=>{if(pending.get(sender)===next) pending.delete(sender);}).catch(()=>{});
    return next;
  };
}
