import test from 'node:test';
import assert from 'node:assert/strict';
import {incoming,callWebhook,createSenderQueue} from '../src/gateway.js';
import {validateImage,ReceiptError} from '../src/receipt.js';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);const {normalizeInput}=require('../src/normalize-input.cjs');
import parser from '../src/validate-parser.cjs';
const base={intent:'expense',transaction_type:'expense',amount:35000,currency:'IDR',category:'food',description:'nasi padang',transaction_date:'2026-09-16',payment_method:null,account:null,from_account:null,to_account:null,transaction_id:null,query_period:null,query_category:null,needs_clarification:false,clarification_question:null,confidence:0.99};
test('schema rejects injected fields, invalid amounts and invalid calendar dates',()=>{
 for(const patch of [{sql:'DROP TABLE users'},{amount:-10},{amount:'35000'},{amount:1.5},{transaction_date:'2026-02-30'},{category:'arbitrary'}]) assert.throws(()=>parser.validateParsed({...base,...patch}));
});
test('missing amount, transfer account, ambiguous target require clarification',()=>{
 for(const patch of [{amount:null},{intent:'transfer',from_account:'BCA',to_account:null},{intent:'delete_transaction',transaction_id:null},{confidence:.2}]) assert.equal(parser.validateParsed({...base,...patch}).needs_clarification,true);
});
test('valid parsing and edits retain null fields',()=>{
 assert.equal(parser.validateParsed({...base}).amount,35000);
 assert.equal(parser.validateParsed({...base,intent:'edit_transaction',transaction_id:'last',category:null,description:null,transaction_date:null}).transaction_date,null);
});
test('ignore self, groups, statuses and malformed senders; accept image messages',()=>{
 const m={from:'628123@c.us',fromMe:false,type:'chat',body:'makan 35rb',timestamp:1,id:{_serialized:'id'}};
 assert.equal(incoming(m).text,'makan 35rb');
 for(const patch of [{fromMe:true},{from:'123@g.us'},{isStatus:true},{from:'attacker'}]) assert.equal(incoming({...m,...patch}),null);
 const image=incoming({...m,type:'image',body:''});assert.equal(image.message_type,'image');assert.match(image.text,/foto struk/);
 assert.equal(incoming({...m,id:{id:'ABC',remote:'628123@c.us'}}).message_id,'false_628123@c.us_ABC');
 assert.equal(incoming({...m,id:'serialized-id'}).message_id,'serialized-id');
});
test('image validation rejects spoofed/oversized files and normalizer keeps bytes out of payload',()=>{
 const png=Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]).toString('base64');
 const checked=validateImage({mimetype:'image/png',data:png});assert.equal(checked.metadata.size_bytes,12);assert.equal(checked.image.data,png);
 assert.throws(()=>validateImage({mimetype:'image/jpeg',data:png}),ReceiptError);
 assert.throws(()=>validateImage({mimetype:'image/png',data:Buffer.alloc(5*1024*1024+1).toString('base64')}),ReceiptError);
 const normalized=normalizeInput({message_id:'m',from:'628123@c.us',text:'Catat pengeluaran dari foto struk ini.',timestamp:1,is_group:false,message_type:'image',image:{mime_type:'image/png',data:png},media:{size_bytes:12,sha256:'x'}});
 assert.equal(normalized.payload.image,undefined);assert.equal(normalized.image.data,png);
});
test('authenticated webhook contract',async()=>{
 const response=await callWebhook({message_id:'one'},{url:'http://test',secret:'secret',fetchImpl:async(url,opts)=>{assert.equal(opts.headers['x-webhook-secret'],'secret');return {ok:true,json:async()=>({success:true,reply:'OK'})};}});
 assert.equal(response.reply,'OK');
});
test('same sender serialized even after failure; separate senders independent',async()=>{
 const q=createSenderQueue(),order=[];
 await Promise.allSettled([q('a',async()=>{await new Promise(r=>setTimeout(r,20));order.push(1);throw Error('test');}),q('a',async()=>order.push(2)),q('b',async()=>order.push(0))]);
 assert.deepEqual(order,[0,1,2]);
});
