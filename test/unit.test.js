import test from 'node:test';
import assert from 'node:assert/strict';
import {incoming,callWebhook,createSenderQueue} from '../src/gateway.js';
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
test('ignore self, groups, statuses, media and malformed senders',()=>{
 const m={from:'628123@c.us',fromMe:false,type:'chat',body:'makan 35rb',timestamp:1,id:{_serialized:'id'}};
 assert.equal(incoming(m).text,'makan 35rb');
 for(const patch of [{fromMe:true},{from:'123@g.us'},{isStatus:true},{type:'image'},{from:'attacker'}]) assert.equal(incoming({...m,...patch}),null);
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
