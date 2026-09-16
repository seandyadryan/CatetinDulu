-- Shared books migration. Existing data is moved into each user's private workspace.
-- Apply with psql -v ON_ERROR_STOP=1. DDL, backfill, and functions commit atomically.
BEGIN;
CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS workspaces (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
 kind text NOT NULL CHECK(kind IN ('personal','family','team')),
 owner_id uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS workspaces_personal_owner ON workspaces(owner_id) WHERE kind='personal';
CREATE TABLE IF NOT EXISTS workspace_members (
 workspace_id uuid NOT NULL REFERENCES workspaces(id),
 user_id uuid NOT NULL REFERENCES users(id),
 role text NOT NULL CHECK(role IN ('owner','member')),
 joined_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,user_id)
);
CREATE TABLE IF NOT EXISTS workspace_invites (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL REFERENCES workspaces(id),
 token_hash text UNIQUE NOT NULL,
 created_by uuid NOT NULL REFERENCES users(id),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours',
 used_by uuid REFERENCES users(id), used_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS active_workspace_id uuid REFERENCES workspaces(id);
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS workspace_id uuid REFERENCES workspaces(id);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS workspace_id uuid REFERENCES workspaces(id);
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS workspace_id uuid REFERENCES workspaces(id);
ALTER TABLE ledger_movements ADD COLUMN IF NOT EXISTS workspace_id uuid REFERENCES workspaces(id);

CREATE OR REPLACE FUNCTION ensure_personal_workspace(uid uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE wid uuid;
BEGIN
 INSERT INTO workspaces(name,kind,owner_id) VALUES('Pribadi','personal',uid)
 ON CONFLICT(owner_id) WHERE kind='personal' DO UPDATE SET owner_id=EXCLUDED.owner_id RETURNING id INTO wid;
 INSERT INTO workspace_members(workspace_id,user_id,role) VALUES(wid,uid,'owner') ON CONFLICT DO NOTHING;
 UPDATE users SET active_workspace_id=wid WHERE id=uid AND active_workspace_id IS NULL;
 RETURN wid;
END $$;
DO $$ DECLARE u record; BEGIN
 FOR u IN SELECT id FROM users LOOP PERFORM ensure_personal_workspace(u.id); END LOOP;
END $$;
UPDATE accounts a SET workspace_id=w.id FROM workspaces w WHERE a.workspace_id IS NULL AND w.owner_id=a.user_id AND w.kind='personal';
UPDATE transactions t SET workspace_id=w.id FROM workspaces w WHERE t.workspace_id IS NULL AND w.owner_id=t.user_id AND w.kind='personal';
UPDATE chat_messages m SET workspace_id=w.id FROM workspaces w WHERE m.workspace_id IS NULL AND w.owner_id=m.user_id AND w.kind='personal';
UPDATE ledger_movements l SET workspace_id=t.workspace_id FROM transactions t WHERE l.workspace_id IS NULL AND t.id=l.transaction_id;

ALTER TABLE accounts ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE transactions ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE chat_messages ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE ledger_movements ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_user_id_account_id_fkey;
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_user_id_to_account_id_fkey;
ALTER TABLE ledger_movements DROP CONSTRAINT IF EXISTS ledger_movements_user_id_account_id_fkey;
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_user_id_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS accounts_workspace_name ON accounts(workspace_id,name);
CREATE UNIQUE INDEX IF NOT EXISTS accounts_workspace_id ON accounts(workspace_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS transactions_workspace_id ON transactions(workspace_id,id);
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_workspace_account_fk;
ALTER TABLE transactions ADD CONSTRAINT transactions_workspace_account_fk FOREIGN KEY(workspace_id,account_id) REFERENCES accounts(workspace_id,id);
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_workspace_destination_fk;
ALTER TABLE transactions ADD CONSTRAINT transactions_workspace_destination_fk FOREIGN KEY(workspace_id,to_account_id) REFERENCES accounts(workspace_id,id);
ALTER TABLE ledger_movements DROP CONSTRAINT IF EXISTS ledger_workspace_account_fk;
ALTER TABLE ledger_movements ADD CONSTRAINT ledger_workspace_account_fk FOREIGN KEY(workspace_id,account_id) REFERENCES accounts(workspace_id,id);
ALTER TABLE ledger_movements DROP CONSTRAINT IF EXISTS ledger_workspace_transaction_fk;
ALTER TABLE ledger_movements ADD CONSTRAINT ledger_workspace_transaction_fk FOREIGN KEY(workspace_id,transaction_id) REFERENCES transactions(workspace_id,id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS transactions_workspace_period ON transactions(workspace_id,transaction_date);
CREATE INDEX IF NOT EXISTS messages_workspace_recent ON chat_messages(user_id,workspace_id,created_at DESC);
CREATE INDEX IF NOT EXISTS members_user ON workspace_members(user_id);
CREATE INDEX IF NOT EXISTS ledger_workspace_accounts ON ledger_movements(workspace_id,account_id);

CREATE OR REPLACE FUNCTION refresh_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 DELETE FROM ledger_movements WHERE transaction_id=NEW.id;
 INSERT INTO ledger_movements(user_id,workspace_id,transaction_id,account_id,amount)
 VALUES(NEW.user_id,NEW.workspace_id,NEW.id,NEW.account_id,CASE WHEN NEW.type='income' THEN NEW.amount ELSE -NEW.amount END);
 IF NEW.type='transfer' THEN
  INSERT INTO ledger_movements(user_id,workspace_id,transaction_id,account_id,amount)
  VALUES(NEW.user_id,NEW.workspace_id,NEW.id,NEW.to_account_id,NEW.amount);
 END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION resolve_workspace_account(wid uuid, uid uuid, account_name text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE aid uuid; canonical text;
BEGIN
 canonical:=CASE lower(btrim(coalesce(account_name,'Cash')))
 WHEN 'cash' THEN 'Cash' WHEN 'tunai' THEN 'Cash' WHEN 'bca' THEN 'BCA' WHEN 'mandiri' THEN 'Mandiri'
 WHEN 'bri' THEN 'BRI' WHEN 'bni' THEN 'BNI' WHEN 'gopay' THEN 'GoPay' WHEN 'ovo' THEN 'OVO'
 WHEN 'dana' THEN 'DANA' WHEN 'shopeepay' THEN 'ShopeePay' WHEN 'credit card' THEN 'Credit Card' ELSE NULL END;
 IF canonical IS NULL THEN RAISE EXCEPTION 'UNKNOWN_ACCOUNT'; END IF;
 IF NOT EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=wid AND user_id=uid) THEN RAISE EXCEPTION 'NOT_MEMBER'; END IF;
 INSERT INTO accounts(user_id,workspace_id,name) VALUES(uid,wid,canonical)
 ON CONFLICT(workspace_id,name) DO UPDATE SET name=EXCLUDED.name RETURNING id INTO aid;
 RETURN aid;
END $$;
-- Keep the legacy helper safe for callers; account scope always comes from DB membership.
CREATE OR REPLACE FUNCTION resolve_account(uid uuid, account_name text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE wid uuid;
BEGIN
 SELECT active_workspace_id INTO wid FROM users WHERE id=uid;
 RETURN resolve_workspace_account(wid,uid,account_name);
END $$;

CREATE OR REPLACE FUNCTION actor_label(uid uuid) RETURNS text LANGUAGE sql STABLE AS $$
 SELECT coalesce(nullif(left(regexp_replace(sender_name,E'[\\n\\r\\t]',' ','g'),60),''),'Anggota '||left(id::text,8)) FROM users WHERE id=uid;
$$;

-- Membership and workspace switching are deterministic commands, never interpreted by the LLM.
CREATE OR REPLACE FUNCTION workspace_command(uid uuid, body text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE parts text[]; cmd text; arg text; w workspaces%ROWTYPE; inv workspace_invites%ROWTYPE;
 wid uuid; target uuid; token text; reply text; listing text; role_name text;
BEGIN
 IF body !~* '^/ruang($|[[:space:]])' THEN RETURN NULL; END IF;
 parts:=regexp_match(btrim(body),'^/ruang(?:[[:space:]]+([^[:space:]]+))?(?:[[:space:]]+(.*))?$','i');
 cmd:=lower(coalesce(parts[1],''));arg:=btrim(coalesce(parts[2],''));
 SELECT active_workspace_id INTO wid FROM users WHERE id=uid;
 -- Every membership mutation locks the same workspace as financial writes.
 IF cmd='pakai' THEN
  BEGIN target:=arg::uuid; EXCEPTION WHEN invalid_text_representation THEN target:=NULL; END;
  IF target IS NOT NULL THEN PERFORM pg_advisory_xact_lock(hashtextextended('workspace:'||target::text,0)); END IF;
 ELSIF cmd='gabung' THEN
  SELECT workspace_id INTO target FROM workspace_invites WHERE token_hash=encode(digest(upper(arg),'sha256'),'hex');
  IF target IS NOT NULL THEN PERFORM pg_advisory_xact_lock(hashtextextended('workspace:'||target::text,0)); END IF;
 ELSE
  PERFORM pg_advisory_xact_lock(hashtextextended('workspace:'||wid::text,0));
 END IF;
 SELECT * INTO w FROM workspaces WHERE id=wid;
 SELECT role INTO role_name FROM workspace_members WHERE workspace_id=wid AND user_id=uid;
 IF cmd='buat' THEN
  parts:=regexp_match(arg,'^(keluarga|tim)[[:space:]]+(.+)$','i');
  IF parts IS NULL OR length(btrim(parts[2])) NOT BETWEEN 1 AND 80 THEN
   reply:='Contoh: /ruang buat keluarga Keluarga Nugraha atau /ruang buat tim Tim Kantor. Nama maksimal 80 karakter.';
  ELSE
   INSERT INTO workspaces(name,kind,owner_id) VALUES(btrim(parts[2]),CASE lower(parts[1]) WHEN 'keluarga' THEN 'family' ELSE 'team' END,uid) RETURNING * INTO w;
   INSERT INTO workspace_members(workspace_id,user_id,role) VALUES(w.id,uid,'owner');
   UPDATE users SET active_workspace_id=w.id,pending_context=NULL,pending_until=NULL WHERE id=uid;
   reply:='✅ Ruang dibuat dan aktif: '||w.name||E'\nID: '||w.id||E'\nKetik /ruang undang untuk mengajak satu anggota. Setiap anggota chat langsung ke bot ini.';
  END IF;
 ELSIF cmd='undang' THEN
  IF w.kind='personal' OR role_name IS DISTINCT FROM 'owner' THEN
   reply:='Hanya pemilik ruang keluarga/tim yang dapat membuat undangan. Ketik /ruang daftar untuk melihat ruang Anda.';
  ELSE
   token:=upper(encode(gen_random_bytes(16),'hex'));
   INSERT INTO workspace_invites(workspace_id,token_hash,created_by) VALUES(w.id,encode(digest(token,'sha256'),'hex'),uid);
   reply:='Undangan untuk '||w.name||E'\nBerlaku 24 jam, untuk satu anggota. Bagikan perintah ini secara pribadi kepada orang yang diundang:'||E'\n\n/ruang gabung '||token;
  END IF;
 ELSIF cmd='gabung' THEN
  SELECT * INTO inv FROM workspace_invites WHERE token_hash=encode(digest(upper(arg),'sha256'),'hex') FOR UPDATE;
  IF inv.id IS NULL OR inv.used_at IS NOT NULL OR inv.expires_at<=now() THEN
   reply:='Kode undangan tidak valid, sudah digunakan, atau kedaluwarsa. Minta undangan baru kepada pemilik.';
  ELSIF EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=inv.workspace_id AND user_id=uid) THEN
   reply:='Anda sudah menjadi anggota ruang ini. Aktifkan dengan /ruang pakai '||inv.workspace_id;
  ELSE
   INSERT INTO workspace_members(workspace_id,user_id,role) VALUES(inv.workspace_id,uid,'member');
   UPDATE workspace_invites SET used_by=uid,used_at=now() WHERE id=inv.id;
   UPDATE users SET active_workspace_id=inv.workspace_id,pending_context=NULL,pending_until=NULL WHERE id=uid;
   SELECT * INTO w FROM workspaces WHERE id=inv.workspace_id;
   reply:='✅ Bergabung. Ruang aktif: '||w.name||E'\nTransaksi berikutnya masuk ke ruang ini. Semua anggota dapat melihat saldo dan laporan bersama. Ketik /ruang pribadi untuk mencatat pribadi.';
  END IF;
 ELSIF cmd='pribadi' THEN
  wid:=ensure_personal_workspace(uid);
  UPDATE users SET active_workspace_id=wid,pending_context=NULL,pending_until=NULL WHERE id=uid;
  reply:='✅ Ruang aktif: Pribadi. Ketik /ruang daftar untuk kembali ke keluarga/tim.';
 ELSIF cmd='pakai' THEN
  IF target IS NULL OR NOT EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=target AND user_id=uid) THEN
   reply:='Ruang tidak ditemukan atau Anda bukan anggotanya. Gunakan ID dari /ruang daftar.';
  ELSE
   UPDATE users SET active_workspace_id=target,pending_context=NULL,pending_until=NULL WHERE id=uid;
   reply:='✅ Ruang aktif: '||(SELECT name FROM workspaces WHERE id=target);
  END IF;
 ELSIF cmd='daftar' THEN
  SELECT string_agg(CASE WHEN x.id=wid THEN '✅ ' ELSE '• ' END||x.name||' ('||x.kind||', '||m.role||E')\n/ruang pakai '||x.id,E'\n\n' ORDER BY x.created_at) INTO listing
  FROM workspaces x JOIN workspace_members m ON m.workspace_id=x.id WHERE m.user_id=uid;
  reply:=E'Ruang Anda (✅ aktif):\n\n'||coalesce(listing,'Belum ada.');
 ELSIF cmd='anggota' THEN
  IF role_name IS NULL THEN reply:='Anda bukan anggota ruang ini.';
  ELSE
   SELECT string_agg(actor_label(m.user_id)||' ('||m.role||E')\nID: '||m.user_id,E'\n\n' ORDER BY m.joined_at,m.user_id) INTO listing
   FROM workspace_members m WHERE m.workspace_id=wid;
   reply:='Anggota '||w.name||E'\n\n'||listing;
  END IF;
 ELSIF cmd='keluarkan' THEN
  BEGIN target:=arg::uuid; EXCEPTION WHEN invalid_text_representation THEN target:=NULL; END;
  IF w.kind='personal' OR role_name IS DISTINCT FROM 'owner' THEN reply:='Hanya pemilik ruang keluarga/tim yang dapat mengeluarkan anggota.';
  ELSIF target IS NULL OR target=uid OR NOT EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=wid AND user_id=target AND role='member') THEN
   reply:='Pilih ID anggota dari /ruang anggota. Pemilik tidak dapat dikeluarkan.';
  ELSE
   DELETE FROM workspace_members WHERE workspace_id=wid AND user_id=target;
   -- Do not take another user's row lock: their next request resets an inactive membership.
   UPDATE workspace_invites SET expires_at=now() WHERE workspace_id=wid AND used_at IS NULL;
   reply:='✅ Anggota dikeluarkan. Catatan sebelumnya tetap tersimpan. Semua undangan yang belum digunakan dibatalkan.';
  END IF;
 ELSIF cmd='keluar' THEN
  IF w.kind='personal' OR role_name='owner' THEN reply:='Pemilik tidak dapat keluar dari ruang. Gunakan /ruang pribadi untuk berpindah.';
  ELSE
   DELETE FROM workspace_members WHERE workspace_id=wid AND user_id=uid;
   wid:=ensure_personal_workspace(uid);
   UPDATE users SET active_workspace_id=wid,pending_context=NULL,pending_until=NULL WHERE id=uid;
   reply:='✅ Anda keluar dari ruang. Catatan sebelumnya tetap tersimpan. Ruang aktif: Pribadi.';
  END IF;
 ELSE
  reply:='Ruang aktif: '||w.name||E'\nID: '||w.id||E'\n\n/ruang buat keluarga Nama Keluarga\n/ruang buat tim Nama Tim\n/ruang undang\n/ruang gabung KODE\n/ruang daftar\n/ruang pakai ID_RUANG\n/ruang pribadi\n/ruang anggota\n/ruang keluarkan ID_ANGGOTA\n/ruang keluar\n\nKirim transaksi atau foto struk ke chat pribadi bot. Semua catatan masuk ke ruang aktif. Anggota melihat laporan bersama; edit/hapus hanya catatan sendiri, pemilik boleh semua. "Transaksi terakhir" selalu catatan Anda sendiri di ruang aktif.';
 END IF;
 RETURN jsonb_build_object('success',true,'reply',reply,'retryable',false);
END $$;

CREATE OR REPLACE FUNCTION prepare_message(p jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE u users%ROWTYPE; m chat_messages%ROWTYPE; tok uuid:=gen_random_uuid(); ctx jsonb;
 cmd_response jsonb; personal uuid;
BEGIN
 IF coalesce(p->>'from','') !~ '^\d+@(c\.us|lid)$' OR coalesce(p->>'message_id','')='' OR length(p->>'message_id')>250
 OR coalesce(p->>'text','')='' OR length(p->>'text')>2000 OR (p->>'is_group')::boolean IS DISTINCT FROM false THEN
  RETURN jsonb_build_object('proceed',false,'response',jsonb_build_object('success',false,'reply','Format pesan tidak valid.'));
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p->>'from',0));
 INSERT INTO users(whatsapp_number,sender_name) VALUES(p->>'from',left(coalesce(p->>'sender_name',''),100))
 ON CONFLICT(whatsapp_number) DO UPDATE SET sender_name=CASE WHEN EXCLUDED.sender_name<>'' THEN EXCLUDED.sender_name ELSE users.sender_name END RETURNING * INTO u;
 personal:=ensure_personal_workspace(u.id);
 SELECT * INTO u FROM users WHERE id=u.id;
 IF NOT EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=u.active_workspace_id AND user_id=u.id) THEN
  UPDATE users SET active_workspace_id=personal,pending_context=NULL,pending_until=NULL WHERE id=u.id RETURNING * INTO u;
  -- Require an explicit retry after a revoked membership, so an intended shared expense is not recorded privately.
  RETURN jsonb_build_object('proceed',false,'response',jsonb_build_object('success',false,'retryable',false,'reply','Akses ruang sebelumnya sudah berakhir. Ruang aktif sekarang Pribadi. Pesan belum dicatat. Ketik /ruang daftar, lalu kirim ulang di ruang yang diinginkan.'));
 END IF;
 SELECT * INTO m FROM chat_messages WHERE user_id=u.id AND message_id=p->>'message_id';
 IF m.status='done' THEN
  RETURN jsonb_build_object('proceed',false,'response',CASE WHEN m.parsed->>'intent'='workspace_command' THEN m.response ELSE jsonb_build_object('success',true,'reply','Pesan ini sudah tercatat sebelumnya.') END);
 END IF;
 IF m.id IS NOT NULL AND m.workspace_id<>u.active_workspace_id THEN
  RETURN jsonb_build_object('proceed',false,'response',jsonb_build_object('success',false,'retryable',false,'reply','Pesan ini berasal dari ruang lain. Kirim pesan baru di ruang yang diinginkan.'));
 END IF;
 IF EXISTS(SELECT 1 FROM chat_messages WHERE user_id=u.id AND status='processing' AND lease_until>now()) THEN
  RETURN jsonb_build_object('proceed',false,'response',jsonb_build_object('success',false,'reply','Pesan sebelumnya sedang diproses. Tunggu sebentar.'));
 END IF;
 INSERT INTO chat_messages(user_id,workspace_id,message_id,text,payload,status,lease_token,lease_until)
 VALUES(u.id,u.active_workspace_id,p->>'message_id',p->>'text',p,'processing',tok,now()+interval '90 seconds')
 ON CONFLICT(user_id,message_id) DO UPDATE SET status='processing',lease_token=tok,lease_until=now()+interval '90 seconds';
 IF coalesce(p->>'message_type','text')='text' THEN
  cmd_response:=workspace_command(u.id,btrim(p->>'text'));
 END IF;
 IF cmd_response IS NOT NULL THEN
  UPDATE chat_messages SET status='done',parsed='{"intent":"workspace_command"}',response=cmd_response,lease_until=NULL WHERE user_id=u.id AND message_id=p->>'message_id';
  RETURN jsonb_build_object('proceed',false,'response',cmd_response);
 END IF;
 SELECT jsonb_agg(x) INTO ctx FROM (
  SELECT text,response->>'reply' AS reply,parsed FROM chat_messages
  WHERE user_id=u.id AND workspace_id=u.active_workspace_id AND status='done' AND parsed->>'intent'<>'workspace_command'
  ORDER BY created_at DESC LIMIT 6
 ) x;
 RETURN jsonb_build_object('proceed',true,'user_id',u.id,'workspace_id',u.active_workspace_id,
 'message_id',p->>'message_id','lease_token',tok,'text',p->>'text',
 'pending',CASE WHEN u.pending_until>now() THEN u.pending_context ELSE NULL END,
 'history',coalesce(ctx,'[]'::jsonb),'current_date',to_char(now() AT TIME ZONE 'Asia/Jakarta','YYYY-MM-DD'),
 'current_datetime',to_char(now() AT TIME ZONE 'Asia/Jakarta','YYYY-MM-DD"T"HH24:MI:SS')||'+07:00');
END $$;


CREATE OR REPLACE FUNCTION apply_message(uid uuid, mid text, tok uuid, p jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE m chat_messages%ROWTYPE; t transactions%ROWTYPE; intent text:=p->>'intent';
 amt numeric; aid uuid; bid uuid; d date; start_date date; end_date date; cat text;
 wid uuid; workspace_name text; member_role text;
 reply text; result jsonb; total_in numeric; total_out numeric; lines text; target text; filter_type text;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended((SELECT whatsapp_number FROM users WHERE id=uid),0));
 SELECT * INTO m FROM chat_messages WHERE user_id=uid AND message_id=mid FOR UPDATE;
 IF m.id IS NULL OR m.lease_token<>tok OR m.status<>'processing' OR m.lease_until<now() THEN
  RETURN jsonb_build_object('success',false,'reply','Permintaan kedaluwarsa. Silakan coba lagi.');
 END IF;
 wid:=m.workspace_id;
 PERFORM pg_advisory_xact_lock(hashtextextended('workspace:'||wid::text,0));
 SELECT role INTO member_role FROM workspace_members WHERE workspace_id=wid AND user_id=uid;
 IF member_role IS NULL THEN
  UPDATE chat_messages SET status='failed',lease_until=NULL WHERE id=m.id;
  RETURN jsonb_build_object('success',false,'retryable',false,'reply','Akses ruang sudah berakhir. Transaksi belum dicatat. Ketik /ruang pribadi atau /ruang daftar.');
 END IF;
 SELECT name INTO workspace_name FROM workspaces WHERE id=wid;
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
   aid:=resolve_workspace_account(wid,uid,p->>'from_account');bid:=resolve_workspace_account(wid,uid,p->>'to_account');
   IF aid=bid THEN RAISE EXCEPTION 'SAME_ACCOUNT'; END IF;
  ELSE aid:=resolve_workspace_account(wid,uid,p->>'account');bid:=NULL; END IF;
  INSERT INTO transactions(user_id,workspace_id,type,amount,category,description,transaction_date,account_id,to_account_id,payment_method,source_message_id)
  VALUES(uid,wid,intent,amt,cat,coalesce(nullif(p->>'description',''),(SELECT label FROM categories WHERE id=cat)),d,aid,bid,p->>'payment_method',mid) RETURNING * INTO t;
  reply:='✅ '||CASE intent WHEN 'expense' THEN 'Pengeluaran' WHEN 'income' THEN 'Pemasukan' ELSE 'Transfer' END||' dicatat'||E'\n\n'||
   CASE WHEN intent='transfer' THEN (SELECT name FROM accounts WHERE id=aid)||' → '||(SELECT name FROM accounts WHERE id=bid)
   ELSE (SELECT label FROM categories WHERE id=cat)||E'\n'||t.description||E'\n'||(SELECT name FROM accounts WHERE id=aid) END||
   E'\n'||rupiah(amt)||E'\n'||to_char(d,'DD Mon YYYY')||E'\nID: '||t.id;
  UPDATE users SET pending_context=NULL,pending_until=NULL WHERE id=uid;
 ELSIF intent IN ('edit_transaction','delete_transaction') THEN
  target:=p->>'transaction_id';
  IF target IS NULL THEN reply:='Sebutkan ID transaksi atau katakan "transaksi terakhir".';
  ELSE
   SELECT * INTO t FROM transactions WHERE workspace_id=wid AND ((target='last' AND user_id=uid) OR id::text=target) AND (user_id=uid OR member_role='owner') ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE;
   IF t.id IS NULL THEN reply:='Transaksi tidak ditemukan.';
   ELSIF intent='delete_transaction' THEN
    DELETE FROM transactions WHERE id=t.id AND workspace_id=wid;
    reply:='✅ Transaksi '||t.id||' ('||rupiah(t.amount)||') dihapus. Saldo sudah diperbarui.';
   ELSE
    amt:=coalesce((p->>'amount')::numeric,t.amount);
    IF amt<=0 OR amt<>trunc(amt) OR amt>9000000000000 THEN RAISE EXCEPTION 'INVALID_AMOUNT'; END IF;
    aid:=CASE WHEN t.type='transfer' AND p->>'from_account' IS NOT NULL THEN resolve_workspace_account(wid,uid,p->>'from_account') WHEN t.type<>'transfer' AND p->>'account' IS NOT NULL THEN resolve_workspace_account(wid,uid,p->>'account') ELSE t.account_id END;
    bid:=CASE WHEN t.type='transfer' AND p->>'to_account' IS NOT NULL THEN resolve_workspace_account(wid,uid,p->>'to_account') ELSE t.to_account_id END;
    UPDATE transactions SET amount=amt,category=coalesce(p->>'category',category),description=coalesce(p->>'description',description),
     transaction_date=coalesce((p->>'transaction_date')::date,transaction_date),account_id=aid,to_account_id=bid,
     payment_method=coalesce(p->>'payment_method',payment_method),updated_at=now() WHERE id=t.id AND workspace_id=wid;
    reply:='✅ Transaksi '||t.id||' diperbarui menjadi '||rupiah(amt)||'. Saldo sudah diperbarui.';
   END IF;
  END IF;
  UPDATE users SET pending_context=NULL,pending_until=NULL WHERE id=uid;
 ELSIF intent='balance' THEN
  SELECT string_agg(name||'  '||rupiah(balance),E'\n' ORDER BY name),coalesce(sum(balance),0) INTO lines,total_in
   FROM (SELECT a.name,coalesce(sum(l.amount),0) balance FROM accounts a LEFT JOIN ledger_movements l ON l.account_id=a.id AND l.workspace_id=wid WHERE a.workspace_id=wid AND (p->>'account' IS NULL OR lower(a.name)=lower(p->>'account')) GROUP BY a.id) q;
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
   SELECT string_agg(to_char(transaction_date,'DD Mon')||' · '||type||' · '||rupiah(amount)||E'\n'||description||E'\nDicatat: '||actor_label(user_id)||E'\nID: '||id,E'\n\n' ORDER BY created_at DESC) INTO lines
   FROM (SELECT * FROM transactions WHERE workspace_id=wid AND transaction_date>=start_date AND transaction_date<end_date AND (cat IS NULL OR category=cat) AND (filter_type IS NULL OR type=filter_type) ORDER BY created_at DESC LIMIT 20) q;
   reply:=E'📝 Transaksi (maks. 20 terbaru)\n\n'||coalesce(lines,'Belum ada transaksi untuk periode ini.');
  ELSE
   SELECT coalesce(sum(amount) FILTER(WHERE type='income'),0),coalesce(sum(amount) FILTER(WHERE type='expense'),0) INTO total_in,total_out FROM transactions
   WHERE workspace_id=wid AND type<>'transfer' AND transaction_date>=start_date AND transaction_date<end_date AND (cat IS NULL OR category=cat);
   SELECT string_agg(label||' '||rupiah(total),E'\n' ORDER BY total DESC) INTO lines FROM
   (SELECT c.label,sum(tx.amount) total FROM transactions tx JOIN categories c ON c.id=tx.category WHERE tx.workspace_id=wid AND tx.type=CASE WHEN filter_type='income' THEN 'income' ELSE 'expense' END AND tx.transaction_date>=start_date AND tx.transaction_date<end_date AND (cat IS NULL OR tx.category=cat) GROUP BY c.label ORDER BY total DESC LIMIT 5) q;
   reply:='📊 '||to_char(start_date,'DD Mon YYYY')||' – '||to_char(end_date-1,'DD Mon YYYY')||
   CASE WHEN cat IS NOT NULL THEN E'\nKategori: '||(SELECT label FROM categories WHERE id=cat) ELSE '' END||
   CASE WHEN filter_type='expense' THEN E'\n\nPengeluaran\n'||rupiah(total_out) WHEN filter_type='income' THEN E'\n\nPemasukan\n'||rupiah(total_in)
   ELSE E'\n\nPemasukan\n'||rupiah(total_in)||E'\n\nPengeluaran\n'||rupiah(total_out)||E'\n\nSelisih\n'||rupiah(total_in-total_out) END||E'\n\nTop kategori:\n'||coalesce(lines,'Belum ada.');
  END IF;
 ELSIF intent='help' THEN
  reply:=E'👋 Catetin Dulu\n\n• makan 35rb\n• gaji masuk 8 juta ke BCA\n• transfer 500rb dari BCA ke GoPay\n• saldo saya\n• laporan bulan ini\n• daftar transaksi\n• ubah transaksi terakhir menjadi 50 ribu\n• hapus transaksi terakhir\n\nTanpa akun → Cash. Saldo awal nol; catat pemasukan saldo awal bila diperlukan. Ketik batal untuk membatalkan pertanyaan sebelumnya. Ketik /ruang untuk panduan keuangan keluarga/tim.';
  UPDATE users SET pending_context=NULL,pending_until=NULL WHERE id=uid;
 ELSE reply:='Saya belum memahami pesan itu. Contoh: "makan 35rb" atau "laporan bulan ini". Ketik bantuan untuk panduan.';
 END IF;
 reply:='📒 '||workspace_name||E'\n'||reply;
 IF intent IN ('expense','income','transfer') AND NOT coalesce((p->>'needs_clarification')::boolean,false) THEN reply:=reply||E'\nDicatat oleh: '||actor_label(uid); END IF;
 result:=jsonb_build_object('success',true,'reply',reply);
 UPDATE chat_messages SET status='done',parsed=p,response=result,lease_until=NULL WHERE id=m.id;
 RETURN result;
 EXCEPTION WHEN OTHERS THEN
  -- Subtransaction rolls back ledger and financial writes before marking this message failed.
  UPDATE chat_messages SET status='failed',lease_until=NULL WHERE id=m.id;
  RETURN jsonb_build_object('success',false,'reply','Data transaksi belum valid atau belum dapat disimpan. Periksa nominal, akun, tanggal, dan ID transaksi.');
 END;
END $$;

INSERT INTO schema_migrations(version) VALUES('002_shared_workspaces') ON CONFLICT DO NOTHING;
COMMIT;
