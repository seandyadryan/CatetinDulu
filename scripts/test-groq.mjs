import 'dotenv/config';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import parser from '../src/validate-parser.cjs';
const system=fs.readFileSync(new URL('../prompts/groq-system.txt',import.meta.url),'utf8');
const samples=[
 ['makan 35rb','expense',35000],['tadi beli bensin 100 ribu','expense',100000],['gaji masuk 8 juta','income',8000000],
 ['transfer 500rb dari BCA ke Gopay','transfer',500000],['pengeluaran saya hari ini berapa?','report',null],
 ['berapa pengeluaran makanan bulan ini?','report',null],['laporan bulan ini','report',null],
 ['hapus transaksi terakhir','delete_transaction',null],['ubah transaksi terakhir menjadi 50 ribu','edit_transaction',50000],
 ['bayar listrik','expense',null],['makan kemarin 25rb pakai gopay','expense',25000],['bonus 1,5jt','income',1500000]
];
for(const [text,intent,amount] of samples.slice(Number(process.env.SAMPLE_START||0))){
 const res=await fetch('https://api.groq.com/openai/v1/chat/completions',{method:'POST',headers:{authorization:`Bearer ${process.env.GROQ_API_KEY}`,'content-type':'application/json'},body:JSON.stringify({model:process.env.GROQ_MODEL,temperature:0,response_format:{type:'json_object'},messages:[{role:'system',content:system},{role:'user',content:JSON.stringify({text,current_date:'2026-09-16',current_datetime:'2026-09-16T12:00:00+07:00',pending:null,history:[]})}]}),signal:AbortSignal.timeout(30000)});
 if(!res.ok){console.log((await res.json()).error);throw Error(`Groq HTTP ${res.status}`);}
 const p=parser.validateParsed(JSON.parse((await res.json()).choices[0].message.content));
 assert.equal(p.intent,intent,text);assert.equal(p.amount,amount,text);
 if(text==='bayar listrik')assert.equal(p.needs_clarification,true);
 if(intent==='edit_transaction'){assert.equal(p.transaction_id,'last');assert.equal(p.transaction_date,null);assert.equal(p.category,null);}
 if(text.includes('kemarin'))assert.equal(p.transaction_date,'2026-09-15');
 console.log('PASS:',text);
 await new Promise(resolve=>setTimeout(resolve,14000));
}
