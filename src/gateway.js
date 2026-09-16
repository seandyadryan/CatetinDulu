import { z } from 'zod';
export const responseSchema = z.object({success:z.boolean(),reply:z.string().min(1).max(12000)});
export function incoming(message, senderName = '') {
  if (message.fromMe || message.isStatus || message.from.endsWith('@g.us') || !['chat'].includes(message.type)) return null;
  if (!/^\d+@(c\.us|lid)$/.test(message.from) || !message.body?.trim() || message.body.length > 2000) return null;
  return {message_id:message.id._serialized,from:message.from,sender_name:senderName.slice(0,100),text:message.body.trim(),timestamp:message.timestamp,is_group:false};
}
export async function callWebhook(payload, {url,secret,timeout=60000,fetchImpl=fetch}) {
  for (let attempt=0; attempt<3; attempt++) {
    try {
      const res=await fetchImpl(url,{method:'POST',headers:{'content-type':'application/json','x-webhook-secret':secret},body:JSON.stringify(payload),signal:AbortSignal.timeout(timeout)});
      if (!res.ok) throw new Error(`Webhook HTTP ${res.status}`);
      const body=responseSchema.parse(await res.json());
      if (!body.success && attempt<2) throw new Error('Workflow temporarily unavailable');
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
