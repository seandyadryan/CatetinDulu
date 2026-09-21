-- Scheduled outbound WhatsApp messages. Apply after 002_shared_workspaces.sql.
BEGIN;
CREATE TABLE IF NOT EXISTS scheduled_messages (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL REFERENCES workspaces(id),
 created_by uuid NOT NULL REFERENCES users(id),
 recipient_number text NOT NULL CHECK(recipient_number ~ '^62[0-9]{8,14}$'),
 message_text text NOT NULL CHECK(length(message_text) BETWEEN 1 AND 1000),
 source_message_id text NOT NULL,
 scheduled_at timestamptz NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','failed','cancelled')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
 sent_at timestamptz,
 last_error text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS scheduled_due ON scheduled_messages(status,scheduled_at);
CREATE INDEX IF NOT EXISTS scheduled_workspace ON scheduled_messages(workspace_id,created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS scheduled_source ON scheduled_messages(created_by,source_message_id);

CREATE OR REPLACE FUNCTION schedule_user(p_from text, p_sender_name text, OUT uid uuid, OUT wid uuid, OUT role_name text) LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO users(whatsapp_number,sender_name) VALUES(p_from,left(coalesce(p_sender_name,''),100))
 ON CONFLICT(whatsapp_number) DO UPDATE SET sender_name=CASE WHEN EXCLUDED.sender_name<>'' THEN EXCLUDED.sender_name ELSE users.sender_name END
 RETURNING id INTO uid;
 PERFORM ensure_personal_workspace(uid);
 SELECT active_workspace_id INTO wid FROM users WHERE id=uid;
 IF NOT EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=wid AND user_id=uid) THEN
  wid:=ensure_personal_workspace(uid);
  UPDATE users SET active_workspace_id=wid WHERE id=uid;
 END IF;
 SELECT role INTO role_name FROM workspace_members WHERE workspace_id=wid AND user_id=uid;
END $$;

CREATE OR REPLACE FUNCTION schedule_create(p_from text, p_sender_name text, p_recipient text, p_message text, p_scheduled_at timestamptz, p_source_message_id text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE uid uuid; wid uuid; role_name text; item scheduled_messages%ROWTYPE;
BEGIN
 IF p_recipient !~ '^62[0-9]{8,14}$' THEN RETURN jsonb_build_object('success',false,'reply','Nomor tujuan harus format internasional, contoh 628123456789.'); END IF;
 IF length(btrim(coalesce(p_message,''))) NOT BETWEEN 1 AND 1000 THEN RETURN jsonb_build_object('success',false,'reply','Pesan jadwal harus 1–1000 karakter.'); END IF;
 IF p_scheduled_at<=now() THEN RETURN jsonb_build_object('success',false,'reply','Jadwal harus berada di masa depan.'); END IF;
 SELECT * INTO uid,wid,role_name FROM schedule_user(p_from,p_sender_name);
 INSERT INTO scheduled_messages(workspace_id,created_by,recipient_number,message_text,scheduled_at,source_message_id)
 VALUES(wid,uid,p_recipient,btrim(p_message),p_scheduled_at,p_source_message_id)
 ON CONFLICT(created_by,source_message_id) DO UPDATE SET source_message_id=EXCLUDED.source_message_id
 RETURNING * INTO item;
 RETURN jsonb_build_object('success',true,'id',item.id,'reply','✅ Pesan dijadwalkan\nID: '||item.id||E'\nKe: '||item.recipient_number||E'\nWaktu WIB: '||to_char(item.scheduled_at AT TIME ZONE 'Asia/Jakarta','YYYY-MM-DD HH24:MI')||E'\nPesan: '||item.message_text);
END $$;

CREATE OR REPLACE FUNCTION schedule_list(p_from text, p_sender_name text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE uid uuid; wid uuid; role_name text; items jsonb;
BEGIN
 SELECT * INTO uid,wid,role_name FROM schedule_user(p_from,p_sender_name);
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'recipient_number',recipient_number,'message_text',message_text,'scheduled_at',to_char(scheduled_at AT TIME ZONE 'Asia/Jakarta','YYYY-MM-DD HH24:MI'),'status',status) ORDER BY scheduled_at),'[]'::jsonb) INTO items
 FROM scheduled_messages WHERE workspace_id=wid AND status IN ('pending','sending');
 RETURN jsonb_build_object('success',true,'items',items);
END $$;

CREATE OR REPLACE FUNCTION schedule_cancel(p_from text, p_sender_name text, p_id uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE uid uuid; wid uuid; role_name text; item scheduled_messages%ROWTYPE;
BEGIN
 SELECT * INTO uid,wid,role_name FROM schedule_user(p_from,p_sender_name);
 SELECT * INTO item FROM scheduled_messages WHERE id=p_id AND workspace_id=wid FOR UPDATE;
 IF item.id IS NULL THEN RETURN jsonb_build_object('success',false,'reply','Jadwal tidak ditemukan di ruang aktif.'); END IF;
 IF item.created_by<>uid AND role_name<>'owner' THEN RETURN jsonb_build_object('success',false,'reply','Anda hanya dapat membatalkan jadwal yang Anda buat.'); END IF;
 IF item.status<>'pending' THEN RETURN jsonb_build_object('success',false,'reply','Jadwal sudah diproses dan tidak dapat dibatalkan.'); END IF;
 UPDATE scheduled_messages SET status='cancelled',updated_at=now() WHERE id=item.id;
 RETURN jsonb_build_object('success',true,'reply','✅ Jadwal dibatalkan: '||item.id);
END $$;

INSERT INTO schema_migrations(version) VALUES('003_scheduled_messages') ON CONFLICT DO NOTHING;
COMMIT;
