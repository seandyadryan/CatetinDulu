import fs from 'node:fs';
import crypto from 'node:crypto';
import dotenv from 'dotenv';
if(!fs.existsSync('.env')){
 let template=fs.readFileSync('.env.example','utf8');
 for(const name of ['POSTGRES_PASSWORD','N8N_WEBHOOK_SECRET','N8N_ENCRYPTION_KEY','ADMIN_TOKEN']) template=template.replace(new RegExp(`^${name}=.*$`,'m'),`${name}=${crypto.randomBytes(32).toString('hex')}`);
 template=template.replace(/^GROQ_API_KEY=.*$/m,`GROQ_API_KEY=${process.env.GROQ_API_KEY||''}`);
 fs.writeFileSync('.env',template,{mode:0o600});
}
const e=dotenv.parse(fs.readFileSync('.env'));
if(!e.GROQ_API_KEY)throw Error('Set GROQ_API_KEY in .env before initialization');
fs.mkdirSync('secrets',{recursive:true,mode:0o700});
fs.writeFileSync('secrets/n8n-credentials.json',JSON.stringify([
 {id:'catetindulu-postgres',name:'Catetin Dulu PostgreSQL',type:'postgres',data:{host:e.POSTGRES_HOST,port:Number(e.POSTGRES_PORT),database:e.POSTGRES_DB,user:e.POSTGRES_USER,password:e.POSTGRES_PASSWORD,ssl:'disable'}},
 {id:'catetindulu-webhook',name:'Catetin Dulu Webhook',type:'httpHeaderAuth',data:{name:'x-webhook-secret',value:e.N8N_WEBHOOK_SECRET}},
 {id:'catetindulu-groq',name:'Catetin Dulu Groq',type:'httpHeaderAuth',data:{name:'Authorization',value:`Bearer ${e.GROQ_API_KEY}`}}
],null,2),{mode:0o600});
console.log('Private configuration prepared; no secret values printed.');
