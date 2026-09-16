// Shared by automated tests and embedded into n8n's Structured Output Parser Code node.
const fields=['intent','transaction_type','amount','currency','category','description','transaction_date','payment_method','account','from_account','to_account','transaction_id','query_period','query_category','needs_clarification','clarification_question','confidence'];
const intents=['expense','income','transfer','balance','report','transaction_list','edit_transaction','delete_transaction','help','unknown'];
const categories=['food','transport','shopping','utilities','bills','health','education','entertainment','salary','business','investment','family','housing','travel','other'];
const accounts=['Cash','BCA','Mandiri','BRI','BNI','GoPay','OVO','DANA','ShopeePay','Credit Card'];
function validateParsed(p){
 if(!p || Array.isArray(p) || typeof p!=='object' || Object.keys(p).length!==fields.length || fields.some(k=>!(k in p))) throw Error('Invalid output shape');
 if(!intents.includes(p.intent) || typeof p.needs_clarification!=='boolean' || typeof p.confidence!=='number' || p.confidence<0 || p.confidence>1) throw Error('Invalid intent/confidence');
 for(const k of fields.filter(k=>!['amount','needs_clarification','confidence'].includes(k))) if(p[k]!==null && (typeof p[k]!=='string' || p[k].length>500)) throw Error('Invalid string');
 if(p.amount!==null && (!Number.isSafeInteger(p.amount)||p.amount<=0||p.amount>9000000000000)) throw Error('Invalid amount');
 if(p.transaction_type!==null && !['expense','income','transfer'].includes(p.transaction_type)) throw Error('Invalid transaction type');
 for(const k of ['category','query_category']) if(p[k]!==null&&!categories.includes(p[k])) throw Error('Invalid category');
 if(p.transaction_date!==null && (!/^\d{4}-\d{2}-\d{2}$/.test(p.transaction_date)||Number.isNaN(Date.parse(p.transaction_date))||new Date(p.transaction_date).toISOString().slice(0,10)!==p.transaction_date)) throw Error('Invalid date');
 if(p.query_period!==null&&!['today','yesterday','current_week','current_month','last_month','current_year','all_time'].includes(p.query_period)) throw Error('Invalid period');
 if(p.transaction_id!==null&&p.transaction_id!=='last'&&!/^[a-f\d]{8}(-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(p.transaction_id)) throw Error('Invalid transaction id');
 const clarify=q=>{p.needs_clarification=true;p.clarification_question=q;};
 if(p.confidence<0.6) clarify('Boleh jelaskan lagi transaksi atau laporan yang Anda maksud?');
 if(p.currency!=='IDR') clarify('Saat ini hanya mendukung rupiah. Berapa nominal dalam IDR?');
 if(['expense','income','transfer'].includes(p.intent)&&p.amount===null) clarify('Berapa nominal transaksinya?');
 for(const k of ['account','from_account','to_account']) if(p[k]!==null&&!accounts.includes(p[k])) clarify('Pilih akun: Cash, BCA, Mandiri, BRI, BNI, GoPay, OVO, DANA, ShopeePay, atau Credit Card.');
 if(p.intent==='transfer'&&(!p.from_account||!p.to_account||p.from_account===p.to_account)) clarify('Transfer dari akun mana ke akun mana? Kedua akun harus berbeda.');
 if(['expense','income'].includes(p.intent)&&!p.description) {
  const labels={food:'Makanan',transport:'Transport',shopping:'Belanja',utilities:'Utilitas',bills:'Tagihan',health:'Kesehatan',education:'Pendidikan',entertainment:'Hiburan',salary:'Gaji',business:'Bisnis',investment:'Investasi',family:'Keluarga',housing:'Rumah',travel:'Perjalanan'};
  if(labels[p.category]) p.description=labels[p.category]; else clarify('Transaksi ini untuk apa?');
 }
 if(['edit_transaction','delete_transaction'].includes(p.intent)&&!p.transaction_id) clarify('Sebutkan ID transaksi atau katakan "transaksi terakhir".');
 if(p.intent==='edit_transaction'&&!['amount','category','description','transaction_date','payment_method','account','from_account','to_account'].some(k=>p[k]!==null)) clarify('Apa yang ingin diubah dari transaksi tersebut?');
 if(p.needs_clarification&&!p.clarification_question) p.clarification_question='Boleh lengkapi detail transaksi Anda?';
 return p;
}
module.exports={validateParsed};
