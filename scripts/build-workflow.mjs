import fs from 'node:fs';

const prompt = fs.readFileSync(new URL('../prompts/groq-system.txt', import.meta.url), 'utf8');
const receiptPrompt = fs.readFileSync(new URL('../prompts/receipt.txt', import.meta.url), 'utf8');
const normalize = fs.readFileSync(new URL('../src/normalize-input.cjs', import.meta.url), 'utf8')
  .replace('module.exports={normalizeInput};', '');
const parser = fs.readFileSync(new URL('../src/validate-parser.cjs', import.meta.url), 'utf8')
  .replace('module.exports={validateParsed};', '');

const pgCred = { postgres: { id: 'catetindulu-postgres', name: 'Catetin Dulu PostgreSQL' } };
const nodes = [];
const connections = {};

const add = (name, type, parameters, x, y = 0, extra = {}) => {
  nodes.push({
    id: name.replaceAll(' ', '-'),
    name,
    type,
    typeVersion: 1,
    position: [x, y],
    parameters,
    ...extra,
  });
};
const link = (a, b, out = 0) => {
  connections[a] ??= { main: [] };
  connections[a].main[out] ??= [];
  connections[a].main[out].push({ node: b, type: 'main', index: 0 });
};

add('Webhook', 'n8n-nodes-base.webhook', {
  httpMethod: 'POST',
  path: 'finance-message',
  authentication: 'headerAuth',
  responseMode: 'responseNode',
  options: {},
}, 0, 0, {
  typeVersion: 2,
  webhookId: 'catetin-dulu-finance',
  credentials: { httpHeaderAuth: { id: 'catetindulu-webhook', name: 'Catetin Dulu Webhook' } },
});

add('Normalize Input', 'n8n-nodes-base.code', {
  jsCode: `${normalize}
return [{json:normalizeInput($json.body)}];`,
}, 240, 0, { typeVersion: 2 });

add('Valid Request', 'n8n-nodes-base.if', {
  conditions: {
    options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
    conditions: [{
      id: 'valid',
      leftValue: '={{ $json.invalid !== true }}',
      rightValue: true,
      operator: { type: 'boolean', operation: 'true', singleValue: true },
    }],
    combinator: 'and',
  },
  options: {},
}, 360, 180, { typeVersion: 2.2 });

add('PostgreSQL Get User and Check Duplicate', 'n8n-nodes-base.postgres', {
  operation: 'executeQuery',
  query: 'SELECT prepare_message($1::jsonb) AS envelope',
  options: { queryReplacement: '={{ [JSON.stringify($json.payload || {})] }}' },
}, 480, 0, { typeVersion: 2.6, credentials: pgCred, onError: 'continueRegularOutput' });

add('New Message', 'n8n-nodes-base.if', {
  conditions: {
    options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
    conditions: [{
      id: 'proceed',
      leftValue: '={{ $json.envelope?.proceed === true }}',
      rightValue: true,
      operator: { type: 'boolean', operation: 'true', singleValue: true },
    }],
    combinator: 'and',
  },
  options: {},
}, 720, 0, { typeVersion: 2.2 });

const groqCode = `const envelope = $json.envelope;
const media = $('Normalize Input').first().json.image;
const context = JSON.stringify({
  text: envelope.text,
  current_date: envelope.current_date,
  current_datetime: envelope.current_datetime,
  pending: media ? null : envelope.pending,
  history: media ? [] : envelope.history,
});
const system = ${JSON.stringify(prompt)} + (media ? ${JSON.stringify('\\n' + receiptPrompt)} : '');
const request = {
  model: media ? ($env.GROQ_VISION_MODEL || 'qwen/qwen3.8-27b') : ($env.GROQ_MODEL || 'openai/gpt-oss-120b'),
  temperature: 0,
  max_completion_tokens: 2400,
  reasoning_effort: media ? 'none' : 'low',
  response_format: { type: 'json_object' },
  messages: [{
    role: 'system',
    content: system,
  }, {
    role: 'user',
    content: media ? [{
      type: 'text',
      text: context,
    }, {
      type: 'image_url',
      image_url: { url: 'data:' + media.mime_type + ';base64,' + media.data },
    }] : context,
  }],
};
return [{ json: { envelope, groqRequest: request } }];`;
add('Build Groq Request', 'n8n-nodes-base.code', { jsCode: groqCode }, 900, -160, { typeVersion: 2 });

add('Groq Chat Model', 'n8n-nodes-base.httpRequest', {
  method: 'POST',
  url: 'https://api.groq.com/openai/v1/chat/completions',
  authentication: 'genericCredentialType',
  genericAuthType: 'httpHeaderAuth',
  sendBody: true,
  specifyBody: 'json',
  jsonBody: '={{ JSON.stringify($json.groqRequest) }}',
  options: { timeout: 25000 },
}, 1140, -160, {
  typeVersion: 4.2,
  retryOnFail: true,
  maxTries: 2,
  waitBetweenTries: 3000,
  credentials: { httpHeaderAuth: { id: 'catetindulu-groq', name: 'Catetin Dulu Groq' } },
  onError: 'continueRegularOutput',
});

add('Structured Output Parser', 'n8n-nodes-base.code', {
  jsCode: `${parser}
const envelope = $('PostgreSQL Get User and Check Duplicate').first().json.envelope;
let parsed;
try {
  parsed = validateParsed(JSON.parse($json.choices[0].message.content), {
    receipt: Boolean($('Normalize Input').first().json.image),
  });
} catch {
  parsed = { error: 'parser_unavailable' };
}
return [{json:{envelope,parsed}}];`,
}, 1380, -160, { typeVersion: 2 });

add('Switch Intent', 'n8n-nodes-base.switch', {
  mode: 'rules',
  rules: {
    values: ['expense', 'income', 'transfer', 'balance', 'report', 'transaction_list', 'edit_transaction', 'delete_transaction', 'help', 'unknown']
      .map((intent) => ({
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
          conditions: [{
            leftValue: '={{ $json.parsed.intent }}',
            rightValue: intent,
            operator: { type: 'string', operation: 'equals' },
          }],
          combinator: 'and',
        },
        renameOutput: true,
        outputKey: intent,
      })),
  },
  options: { fallbackOutput: 'extra' },
}, 1620, -160, { typeVersion: 3.2 });

add('PostgreSQL Business Logic', 'n8n-nodes-base.postgres', {
  operation: 'executeQuery',
  query: 'SELECT apply_message($1::uuid,$2::text,$3::uuid,$4::jsonb) AS response',
  options: {
    queryReplacement: '={{ [$json.envelope.user_id,$json.envelope.message_id,$json.envelope.lease_token,JSON.stringify($json.parsed)] }}',
  },
}, 1900, -160, {
  typeVersion: 2.6,
  credentials: pgCred,
  onError: 'continueRegularOutput',
});

add('Set Response', 'n8n-nodes-base.code', {
  jsCode: `const r=$json.response || $json.envelope?.response;return [{json:r && typeof r.success==='boolean' && typeof r.reply==='string' ? r : {success:false,reply:'Layanan sedang tidak tersedia. Silakan coba sebentar lagi.'}}];`,
}, 2140, 0, { typeVersion: 2 });

add('Respond to Webhook', 'n8n-nodes-base.respondToWebhook', {
  respondWith: 'json',
  responseBody: '={{ $json }}',
  options: { responseCode: 200 },
}, 2380, 0, { typeVersion: 1.4 });

link('Webhook', 'Normalize Input');
link('Normalize Input', 'Valid Request');
link('Valid Request', 'PostgreSQL Get User and Check Duplicate');
link('Valid Request', 'Set Response', 1);
link('PostgreSQL Get User and Check Duplicate', 'New Message');
link('New Message', 'Build Groq Request');
link('New Message', 'Set Response', 1);
link('Build Groq Request', 'Groq Chat Model');
link('Groq Chat Model', 'Structured Output Parser');
link('Structured Output Parser', 'Switch Intent');
for (let i = 0; i < 11; i += 1) link('Switch Intent', 'PostgreSQL Business Logic', i);
link('PostgreSQL Business Logic', 'Set Response');
link('Set Response', 'Respond to Webhook');

fs.mkdirSync(new URL('../n8n/', import.meta.url), { recursive: true });
fs.writeFileSync(
  new URL('../n8n/finance-message.json', import.meta.url),
  JSON.stringify({
    id: 'catetinDuluFinance',
    name: 'Catetin Dulu · Finance Message',
    active: false,
    nodes,
    connections,
    settings: {
      executionOrder: 'v1',
      executionTimeout: 65,
      saveDataErrorExecution: 'none',
      saveDataSuccessExecution: 'none',
      saveManualExecutions: false,
      timezone: 'Asia/Jakarta',
    },
    pinData: {},
  }, null, 2) + '\n',
);

