-- Fixed parameterized examples. Bind $1.. using n8n queryReplacement arrays.
-- These statements illustrate the operations; production uses apply_message()
-- to keep idempotency, context and ledger changes in one database transaction.

-- Expense / income. $1=user derived from authenticated gateway, $2=amount,
-- $3=category, $4=description, $5=date, $6=account id, $7=WhatsApp message id.
INSERT INTO transactions(user_id,type,amount,category,description,transaction_date,account_id,source_message_id)
VALUES($1,'expense',$2,$3,$4,$5,$6,$7) ON CONFLICT(user_id,source_message_id) DO NOTHING;
INSERT INTO transactions(user_id,type,amount,category,description,transaction_date,account_id,source_message_id)
VALUES($1,'income',$2,$3,$4,$5,$6,$7) ON CONFLICT(user_id,source_message_id) DO NOTHING;

-- Transfer. Trigger creates the debit and credit atomically.
INSERT INTO transactions(user_id,type,amount,category,description,transaction_date,account_id,to_account_id,source_message_id)
VALUES($1,'transfer',$2,'other','transfer',$3,$4,$5,$6) ON CONFLICT(user_id,source_message_id) DO NOTHING;

-- Monthly report, using Jakarta boundaries and excluding transfers.
SELECT coalesce(sum(amount) FILTER(WHERE type='income'),0) AS income,
       coalesce(sum(amount) FILTER(WHERE type='expense'),0) AS expense
FROM transactions WHERE user_id=$1 AND type<>'transfer'
 AND transaction_date >= date_trunc('month',now() AT TIME ZONE 'Asia/Jakarta')::date
 AND transaction_date < (date_trunc('month',now() AT TIME ZONE 'Asia/Jakarta')+interval '1 month')::date;

-- Balance per account. No separately mutable cached balance can drift.
SELECT a.name,coalesce(sum(l.amount),0) AS balance FROM accounts a
LEFT JOIN ledger_movements l ON l.account_id=a.id AND l.user_id=a.user_id
WHERE a.user_id=$1 GROUP BY a.id ORDER BY a.name;

-- Duplicate check; UNIQUE is also enforced under concurrent requests.
SELECT id FROM transactions WHERE user_id=$1 AND source_message_id=$2;
-- For repeated edit/delete/query messages inspect chat_messages as well.
SELECT status,response FROM chat_messages WHERE user_id=$1 AND message_id=$2;
