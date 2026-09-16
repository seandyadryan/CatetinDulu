// Embedded into the n8n Code node and tested directly. Image bytes never enter PostgreSQL.
function normalizeInput(p){
 const invalid=()=>({invalid:true,response:{success:false,retryable:false,reply:'Format pesan tidak valid. Kirim teks atau foto struk melalui WhatsApp.'}});
 if(!p || typeof p.text!=='string' || !p.text.trim() || p.text.length>2000 || typeof p.from!=='string' || !/^\d+@(c\.us|lid)$/.test(p.from) || typeof p.message_id!=='string' || !p.message_id || p.message_id.length>250 || p.is_group!==false || !Number.isSafeInteger(Number(p.timestamp)) || Number(p.timestamp)<=0) return invalid();
 const type=p.message_type||'text';
 if(!['text','image'].includes(type))return invalid();
 const image=type==='image'?p.image:null;
 if(type==='image' && (!image || !['image/jpeg','image/png','image/webp'].includes(image.mime_type) || typeof image.data!=='string' || !image.data || image.data.length>6990508 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data))) return invalid();
 const payload={message_id:p.message_id,from:p.from,sender_name:String(p.sender_name||'').slice(0,100),text:p.text.trim(),timestamp:Number(p.timestamp),is_group:false,message_type:type};
 if(image)payload.media={mime_type:image.mime_type,size_bytes:Number(p.media?.size_bytes)||null,sha256:typeof p.media?.sha256==='string'?p.media.sha256:null};
 return {payload,image};
}
module.exports={normalizeInput};
