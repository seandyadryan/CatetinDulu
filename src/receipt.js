import { createHash } from 'node:crypto';
export const MAX_IMAGE_BYTES=5*1024*1024;
export class ReceiptError extends Error {}
export function validateImage(media) {
  if(!media || !['image/jpeg','image/png','image/webp'].includes(media.mimetype)) throw new ReceiptError('Kirim struk sebagai foto JPG, PNG, atau WebP.');
  if(typeof media.data!=='string' || !media.data || media.data.length>Math.ceil(MAX_IMAGE_BYTES/3)*4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(media.data)) throw new ReceiptError('Foto tidak valid atau terlalu besar. Kirim foto struk maksimal 5 MB.');
  const bytes=Buffer.from(media.data,'base64');
  if(!bytes.length || bytes.length>MAX_IMAGE_BYTES || bytes.toString('base64')!==media.data) throw new ReceiptError('Foto tidak valid atau terlalu besar. Kirim foto struk maksimal 5 MB.');
  const png=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const jpeg=bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
  const webp=bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP';
  if(!({ 'image/png':png,'image/jpeg':jpeg,'image/webp':webp }[media.mimetype])) throw new ReceiptError('Berkas bukan foto yang valid. Kirim ulang foto struk.');
  return {image:{mime_type:media.mimetype,data:media.data},metadata:{mime_type:media.mimetype,size_bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}};
}
export async function attachReceipt(message,payload) {
  if(payload.message_type!=='image')return payload;
  if(Number(message._data?.size)>MAX_IMAGE_BYTES)throw new ReceiptError('Foto terlalu besar. Kirim foto struk maksimal 5 MB.');
  // wwebjs media/reply methods still expect id._serialized even when WA serializes id as a string.
  message.id={...(typeof message.id==='object'?message.id:{}),_serialized:payload.message_id};
  let timer;
  try {
   const media=await Promise.race([message.downloadMedia(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new ReceiptError('Unduhan foto terlalu lama. Silakan kirim ulang struknya.')),20000);})]);
   if(!media)throw new ReceiptError('Foto belum bisa diunduh. Silakan kirim ulang foto struknya.');
   const {image,metadata}=validateImage(media);
   return {...payload,image,media:metadata};
  }finally{clearTimeout(timer);}
}
