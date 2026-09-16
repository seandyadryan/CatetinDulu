-- Catetin Dulu: all monetary writes are atomic, fixed SQL; never execute model SQL.
-- Initial legacy schema. On fresh installs run migrations/002_shared_workspaces.sql next.
-- On existing installations use versioned migrations; do not replay this file by itself.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS n8n;
CREATE TABLE IF NOT EXISTS users (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), whatsapp_number text UNIQUE NOT NULL,
 sender_name text NOT NULL DEFAULT '', pending_context jsonb, pending_until timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS categories (id text PRIMARY KEY, label text NOT NULL);
INSERT INTO categories VALUES
 ('food','🍜 Makanan'),('transport','🚗 Transport'),('shopping','🛒 Belanja'),
 ('utilities','💡 Utilitas'),('bills','🧾 Tagihan'),('health','💊 Kesehatan'),
 ('education','📚 Pendidikan'),('entertainment','🎬 Hiburan'),('salary','💰 Gaji'),
 ('business','🏪 Bisnis'),('investment','📈 Investasi'),('family','👪 Keluarga'),
 ('housing','🏠 Rumah'),('travel','✈️ Perjalanan'),('other','📌 Lainnya') ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS accounts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id),
 name text NOT NULL, UNIQUE(user_id,name), UNIQUE(user_id,id)
);
CREATE TABLE IF NOT EXISTS chat_messages (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id),
 message_id text NOT NULL, text text NOT NULL, payload jsonb NOT NULL,
 status text NOT NULL CHECK(status IN ('processing','done','failed')),
 lease_token uuid NOT NULL DEFAULT gen_random_uuid(), lease_until timestamptz,
 parsed jsonb, response jsonb, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(user_id,message_id)
);
CREATE TABLE IF NOT EXISTS transactions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id),
 type text NOT NULL CHECK(type IN ('expense','income','transfer')),
 amount numeric(16,0) NOT NULL CHECK(amount>0 AND amount<=9000000000000),
 currency text NOT NULL DEFAULT 'IDR' CHECK(currency='IDR'),
 category text REFERENCES categories(id), description text NOT NULL,
 transaction_date date NOT NULL, account_id uuid NOT NULL,
 to_account_id uuid, payment_method text, source_message_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(user_id,source_message_id), UNIQUE(user_id,id),
 FOREIGN KEY(user_id,account_id) REFERENCES accounts(user_id,id),
 FOREIGN KEY(user_id,to_account_id) REFERENCES accounts(user_id,id),
 CHECK((type='transfer' AND to_account_id IS NOT NULL AND to_account_id<>account_id) OR (type<>'transfer' AND to_account_id IS NULL))
);
CREATE TABLE IF NOT EXISTS ledger_movements (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL,
 transaction_id uuid NOT NULL, account_id uuid NOT NULL, amount numeric(16,0) NOT NULL,
 FOREIGN KEY(user_id,transaction_id) REFERENCES transactions(user_id,id) ON DELETE CASCADE,
 FOREIGN KEY(user_id,account_id) REFERENCES accounts(user_id,id)
);
CREATE INDEX IF NOT EXISTS transactions_period ON transactions(user_id,transaction_date);
CREATE INDEX IF NOT EXISTS messages_recent ON chat_messages(user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS ledger_accounts ON ledger_movements(user_id,account_id);
CREATE OR REPLACE FUNCTION refresh_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 DELETE FROM ledger_movements WHERE transaction_id=NEW.id;
 INSERT INTO ledger_movements(user_id,transaction_id,account_id,amount)
 VALUES(NEW.user_id,NEW.id,NEW.account_id,CASE WHEN NEW.type='income' THEN NEW.amount ELSE -NEW.amount END);
 IF NEW.type='transfer' THEN
  INSERT INTO ledger_movements(user_id,transaction_id,account_id,amount) VALUES(NEW.user_id,NEW.id,NEW.to_account_id,NEW.amount);
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS transactions_ledger ON transactions;
CREATE TRIGGER transactions_ledger AFTER INSERT OR UPDATE ON transactions FOR EACH ROW EXECUTE FUNCTION refresh_ledger();
CREATE OR REPLACE FUNCTION rupiah(n numeric) RETURNS text LANGUAGE sql IMMUTABLE AS $$
 SELECT 'Rp' || CASE WHEN n<0 THEN '-' ELSE '' END || replace(to_char(abs(n),'FM999,999,999,999,999,990'),',','.');
$$;
CREATE OR REPLACE FUNCTION resolve_account(uid uuid, account_name text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE aid uuid; canonical text;
BEGIN
 canonical:=CASE lower(btrim(coalesce(account_name,'Cash')))
 WHEN 'cash' THEN 'Cash' WHEN 'tunai' THEN 'Cash' WHEN 'bca' THEN 'BCA' WHEN 'mandiri' THEN 'Mandiri'
 WHEN 'bri' THEN 'BRI' WHEN 'bni' THEN 'BNI' WHEN 'gopay' THEN 'GoPay' WHEN 'ovo' THEN 'OVO'
 WHEN 'dana' THEN 'DANA' WHEN 'shopeepay' THEN 'ShopeePay' WHEN 'credit card' THEN 'Credit Card' ELSE NULL END;
 IF canonical IS NULL THEN RAISE EXCEPTION 'UNKNOWN_ACCOUNT'; END IF;
 INSERT INTO accounts(user_id,name) VALUES(uid,canonical) ON CONFLICT(user_id,name) DO UPDATE SET name=EXCLUDED.name RETURNING id INTO aid;
 RETURN aid;
END $$;
-- Claim and context in one atomic transaction. A per-user lease serializes across workers.
CREATE OR REPLACE FUNCTION prepare_message(p jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE u users%ROWTYPE; m chat_messages%ROWTYPE; tok uuid:=gen_random_uuid(); ctx jsonb;
BEGIN
 IF coalesce(p->>'from','') !~ '^\d+@(c\.us|lid)$' OR coalesce(p->>'message_id','')='' OR length(p->>'message_id')>250
 OR coalesce(p->>'text','')='' OR length(p->>'text')>2000 OR (p->>'is_group')::boolean IS DISTINCT FROM false THEN
  RETURN jsonb_build_object('proceed',false,'response',jsonb_build_object('success',false,'reply','Format pesan tidak valid.'));
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p->>'from',0));
 INSERT INTO users(whatsapp_number,sender_name) VALUES(p->>'from',left(coalesce(p->>'sender_name',''),100))
 ON CONFLICT(whatsapp_number) DO UPDATE SET sender_name=EXCLUDED.sender_name RETURNING * INTO u;
 SELECT * INTO m FROM chat_messages WHERE user_id=u.id AND message_id=p->>'message_id';
 IF m.status='done' THEN RETURN jsonb_build_object('proceed',false,'response',jsonb_build_object('success',true,'reply','Pesan ini sudah tercatat sebelumnya.')); END IF;
 IF EXISTS(SELECT 1 FROM chat_messages WHERE user_id=u.id AND status='processing' AND lease_until>now()) THEN
  RETURN jsonb_build_object('proceed',false,'response',jsonb_build_object('success',false,'reply','Pesan sebelumnya sedang diproses. Tunggu sebentar.'));
 END IF;
 INSERT INTO chat_messages(user_id,message_id,text,payload,status,lease_token,lease_until)
 VALUES(u.id,p->>'message_id',p->>'text',p,'processing',tok,now()+interval '90 seconds')
 ON CONFLICT(user_id,message_id) DO UPDATE SET status='processing',lease_token=tok,lease_until=now()+interval '90 seconds';
 SELECT jsonb_agg(x) INTO ctx FROM (SELECT text,response->>'reply' AS reply,parsed FROM chat_messages WHERE user_id=u.id AND status='done' ORDER BY created_at DESC LIMIT 6) x;
 RETURN jsonb_build_object('proceed',true,'user_id',u.id,'message_id',p->>'message_id','lease_token',tok,
 'text',p->>'text','pending',CASE WHEN u.pending_until>now() THEN u.pending_context ELSE NULL END,
 'history',coalesce(ctx,'[]'::jsonb),'current_date',to_char(now() AT TIME ZONE 'Asia/Jakarta','YYYY-MM-DD'),
 'current_datetime',to_char(now() AT TIME ZONE 'Asia/Jakarta','YYYY-MM-DD"T"HH24:MI:SS')||'+07:00');
END $$;
CREATE OR REPLACE FUNCTION apply_message(uid uuid, mid text, tok uuid, p jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE m chat_messages%ROWTYPE; t transactions%ROWTYPE; intent text:=p->>'intent';
 amt numeric; aid uuid; bid uuid; d date; start_date date; end_date date; cat text;
 reply text; result jsonb; total_in numeric; total_out numeric; lines text; target text; filter_type text;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended((SELECT whatsapp_number FROM users WHERE id=uid),0));
 SELECT * INTO m FROM chat_messages WHERE user_id=uid AND message_id=mid FOR UPDATE;
 IF m.id IS NULL OR m.lease_token<>tok OR m.status<>'processing' OR m.lease_until<now() THEN
  RETURN jsonb_build_object('success',false,'reply','Permintaan kedaluwarsa. Silakan coba lagi.');
 END IF;
 IF p ? 'error' THEN
  UPDATE chat_messages SET status='failed',lease_until=NULL WHERE id=m.id;
  RETURN jsonb_build_object('success',false,'reply','Layanan pemahaman pesan sedang tidak tersedia. Silakan coba lagi.');
 END IF;
 BEGIN
 IF intent NOT IN ('expense','income','transfer','balance','report','transaction_list','edit_transaction','delete_transaction','help','unknown') OR intent IS NULL THEN RAISE EXCEPTION 'INVALID_INTENT'; END IF;
 IF p->>'currency' IS DISTINCT FROM 'IDR' THEN
  reply:='Saat ini hanya mendukung rupiah (IDR). Berapa nominal rupiahnya?';
 ELSIF coalesce((p->>'needs_clarification')::boolean,false) THEN
  reply:=coalesce(nullif(p->>'clarification_question',''),'Boleh lengkapi detail transaksi Anda?');
  UPDATE users SET pending_context=p,pending_until=now()+interval '30 minutes' WHERE id=uid;
 ELSIF intent IN ('expense','income','transfer') THEN
  amt:=(p->>'amount')::numeric;
  IF amt IS NULL OR amt<=0 OR amt<>trunc(amt) OR amt>9000000000000 THEN RAISE EXCEPTION 'INVALID_AMOUNT'; END IF;
  d:=coalesce((p->>'transaction_date')::date,(now() AT TIME ZONE 'Asia/Jakarta')::date);
  cat:=coalesce(p->>'category','other');
  IF intent='transfer' THEN
   IF p->>'from_account' IS NULL OR p->>'to_account' IS NULL THEN RAISE EXCEPTION 'MISSING_ACCOUNT'; END IF;
   aid:=resolve_account(uid,p->>'from_account');bid:=resolve_account(uid,p->>'to_account');
   IF aid=bid THEN RAISE EXCEPTION 'SAME_ACCOUNT'; END IF;
  ELSE aid:=resolve_account(uid,p->>'account');bid:=NULL; END IF;
  INSERT INTO transactions(user_id,type,amount,category,description,transaction_date,account_id,to_account_id,payment_method,source_message_id)
  VALUES(uid,intent,amt,cat,coalesce(nullif(p->>'description',''),(SELECT label FROM categories WHERE id=cat)),d,aid,bid,p->>'payment_method',mid) RETURNING * INTO t;
  reply:='✅ '||CASE intent WHEN 'expense' THEN 'Pengeluaran' WHEN 'income' THEN 'Pemasukan' ELSE 'Transfer' END||' dicatat'||E'\n\n'||
   CASE WHEN intent='transfer' THEN (SELECT name FROM accounts WHERE id=aid)||' → '||(SELECT name FROM accounts WHERE id=bid)
   ELSE (SELECT label FROM categories WHERE id=cat)||E'\n'||t.description||E'\n'||(SELECT name FROM accounts WHERE id=aid) END||
   E'\n'||rupiah(amt)||E'\n'||to_char(d,'DD Mon YYYY')||E'\nID: '||t.id;
  UPDATE users SET pending_context=NULL,pending_until=NULL WHERE id=uid;
 ELSIF intent IN ('edit_transaction','delete_transaction') THEN
  target:=p->>'transaction_id';
  IF target IS NULL THEN reply:='Sebutkan ID transaksi atau katakan "transaksi terakhir".';
  ELSE
   SELECT * INTO t FROM transactions WHERE user_id=uid AND (target='last' OR id::text=target) ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE;
   IF t.id IS NULL THEN reply:='Transaksi tidak ditemukan.';
   ELSIF intent='delete_transaction' THEN
    DELETE FROM transactions WHERE id=t.id AND user_id=uid;
    reply:='✅ Transaksi '||t.id||' ('||rupiah(t.amount)||') dihapus. Saldo sudah diperbarui.';
   ELSE
    amt:=coalesce((p->>'amount')::numeric,t.amount);
    IF amt<=0 OR amt<>trunc(amt) OR amt>9000000000000 THEN RAISE EXCEPTION 'INVALID_AMOUNT'; END IF;
    aid:=CASE WHEN t.type='transfer' AND p->>'from_account' IS NOT NULL THEN resolve_account(uid,p->>'from_account') WHEN t.type<>'transfer' AND p->>'account' IS NOT NULL THEN resolve_account(uid,p->>'account') ELSE t.account_id END;
    bid:=CASE WHEN t.type='transfer' AND p->>'to_account' IS NOT NULL THEN resolve_account(uid,p->>'to_account') ELSE t.to_account_id END;
    UPDATE transactions SET amount=amt,category=coalesce(p->>'category',category),description=coalesce(p->>'description',description),
     transaction_date=coalesce((p->>'transaction_date')::date,transaction_date),account_id=aid,to_account_id=bid,
     payment_method=coalesce(p->>'payment_method',payment_method),updated_at=now() WHERE id=t.id AND user_id=uid;
    reply:='✅ Transaksi '||t.id||' diperbarui menjadi '||rupiah(amt)||'. Saldo sudah diperbarui.';
   END IF;
  END IF;
  UPDATE users SET pending_context=NULL,pending_until=NULL WHERE id=uid;
 ELSIF intent='balance' THEN
  SELECT string_agg(name||'  '||rupiah(balance),E'\n' ORDER BY name),coalesce(sum(balance),0) INTO lines,total_in
   FROM (SELECT a.name,coalesce(sum(l.amount),0) balance FROM accounts a LEFT JOIN ledger_movements l ON l.account_id=a.id AND l.user_id=uid WHERE a.user_id=uid AND (p->>'account' IS NULL OR lower(a.name)=lower(p->>'account')) GROUP BY a.id) q;
  reply:=E'💰 Saldo\n\n'||coalesce(lines,'Belum ada transaksi.')||E'\n\nTotal  '||rupiah(total_in);
 ELSIF intent IN ('report','transaction_list') THEN
  d:=(now() AT TIME ZONE 'Asia/Jakarta')::date;
  CASE coalesce(p->>'query_period','current_month')
   WHEN 'today' THEN start_date:=d;end_date:=d+1;
   WHEN 'yesterday' THEN start_date:=d-1;end_date:=d;
   WHEN 'current_week' THEN start_date:=date_trunc('week',d)::date;end_date:=start_date+7;
   WHEN 'current_month' THEN start_date:=date_trunc('month',d)::date;end_date:=(start_date+interval '1 month')::date;
   WHEN 'last_month' THEN end_date:=date_trunc('month',d)::date;start_date:=(end_date-interval '1 month')::date;
   WHEN 'current_year' THEN start_date:=date_trunc('year',d)::date;end_date:=(start_date+interval '1 year')::date;
   WHEN 'all_time' THEN start_date:='1900-01-01';end_date:='2200-01-01';
   ELSE RAISE EXCEPTION 'INVALID_PERIOD';
  END CASE;
  cat:=p->>'query_category';filter_type:=p->>'transaction_type';
  IF intent='transaction_list' THEN
   SELECT string_agg(to_char(transaction_date,'DD Mon')||' · '||type||' · '||rupiah(amount)||E'\n'||description||E'\nID: '||id,E'\n\n' ORDER BY created_at DESC) INTO lines
   FROM (SELECT * FROM transactions WHERE user_id=uid AND transaction_date>=start_date AND transaction_date<end_date AND (cat IS NULL OR category=cat) AND (filter_type IS NULL OR type=filter_type) ORDER BY created_at DESC LIMIT 20) q;
   reply:=E'📝 Transaksi (maks. 20 terbaru)\n\n'||coalesce(lines,'Belum ada transaksi untuk periode ini.');
  ELSE
   SELECT coalesce(sum(amount) FILTER(WHERE type='income'),0),coalesce(sum(amount) FILTER(WHERE type='expense'),0) INTO total_in,total_out FROM transactions
   WHERE user_id=uid AND type<>'transfer' AND transaction_date>=start_date AND transaction_date<end_date AND (cat IS NULL OR category=cat);
   SELECT string_agg(label||' '||rupiah(total),E'\n' ORDER BY total DESC) INTO lines FROM
   (SELECT c.label,sum(tx.amount) total FROM transactions tx JOIN categories c ON c.id=tx.category WHERE tx.user_id=uid AND tx.type=CASE WHEN filter_type='income' THEN 'income' ELSE 'expense' END AND tx.transaction_date>=start_date AND tx.transaction_date<end_date AND (cat IS NULL OR tx.category=cat) GROUP BY c.label ORDER BY total DESC LIMIT 5) q;
   reply:='📊 '||to_char(start_date,'DD Mon YYYY')||' – '||to_char(end_date-1,'DD Mon YYYY')||
   CASE WHEN cat IS NOT NULL THEN E'\nKategori: '||(SELECT label FROM categories WHERE id=cat) ELSE '' END||
   CASE WHEN filter_type='expense' THEN E'\n\nPengeluaran\n'||rupiah(total_out) WHEN filter_type='income' THEN E'\n\nPemasukan\n'||rupiah(total_in)
   ELSE E'\n\nPemasukan\n'||rupiah(total_in)||E'\n\nPengeluaran\n'||rupiah(total_out)||E'\n\nSelisih\n'||rupiah(total_in-total_out) END||E'\n\nTop kategori:\n'||coalesce(lines,'Belum ada.');
  END IF;
 ELSIF intent='help' THEN
  reply:=E'👋 Catetin Dulu\n\n• makan 35rb\n• gaji masuk 8 juta ke BCA\n• transfer 500rb dari BCA ke GoPay\n• saldo saya\n• laporan bulan ini\n• daftar transaksi\n• ubah transaksi terakhir menjadi 50 ribu\n• hapus transaksi terakhir\n\nTanpa akun → Cash. Saldo awal nol; catat pemasukan saldo awal bila diperlukan. Ketik batal untuk membatalkan pertanyaan sebelumnya.';
  UPDATE users SET pending_context=NULL,pending_until=NULL WHERE id=uid;
 ELSE reply:='Saya belum memahami pesan itu. Contoh: "makan 35rb" atau "laporan bulan ini". Ketik bantuan untuk panduan.';
 END IF;
 result:=jsonb_build_object('success',true,'reply',reply);
 UPDATE chat_messages SET status='done',parsed=p,response=result,lease_until=NULL WHERE id=m.id;
 RETURN result;
 EXCEPTION WHEN OTHERS THEN
  -- Subtransaction rolls back ledger and financial writes before marking this message failed.
  UPDATE chat_messages SET status='failed',lease_until=NULL WHERE id=m.id;
  RETURN jsonb_build_object('success',false,'reply','Data transaksi belum valid atau belum dapat disimpan. Periksa nominal, akun, tanggal, dan ID transaksi.');
 END;
END $$;
