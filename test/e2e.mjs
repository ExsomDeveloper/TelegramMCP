// E2E: fake Telegram Bot API + real daemon + real MCP client + real hook script. Run: npm test
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const PROJECT = fileURLToPath(new URL('..', import.meta.url));

const CHAT = 111, STRANGER = 999, TG_PORT = 8899, PORT = 8788;
const updates = [], sent = [], edits = [], reactions = [];
let msgId = 100, updId = 1;

createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    const method = req.url.split('/').pop();
    const p = body ? JSON.parse(body) : {};
    const ok = (result) => res.end(JSON.stringify({ ok: true, result }));
    switch (method) {
      case 'getMe': return ok({ id: 1, is_bot: true, first_name: 'T', username: 'test_bot' });
      case 'deleteWebhook': return ok(true);
      case 'getUpdates': {
        const until = Date.now() + 1000;
        while (!updates.length && Date.now() < until) await new Promise((r) => setTimeout(r, 30));
        return ok(updates.splice(0));
      }
      case 'sendMessage': { const m = { message_id: ++msgId, chat: { id: p.chat_id }, text: p.text, reply_markup: p.reply_markup }; sent.push(m); return ok({ ...m, date: 0 }); }
      case 'editMessageText': edits.push(p); return ok(true);
      case 'answerCallbackQuery': return ok(true);
      case 'setMessageReaction': reactions.push(p); return ok(true);
      default: console.log('unhandled', method); return ok(true);
    }
  });
}).listen(TG_PORT);

const chat = (id) => ({ id, type: 'private' });
const from = (id) => ({ id, is_bot: false, first_name: 'U' });
const pushText = (text, { replyTo, chatId = CHAT } = {}) =>
  updates.push({ update_id: updId++, message: { message_id: ++msgId, date: 0, chat: chat(chatId), from: from(chatId), text, ...(replyTo ? { reply_to_message: { message_id: replyTo, date: 0, chat: chat(chatId) } } : {}) } });
const pressButton = (msg, index) =>
  updates.push({ update_id: updId++, callback_query: { id: String(updId), from: from(CHAT), chat_instance: 'x', data: msg.reply_markup.inline_keyboard.flat()[index].callback_data, message: { message_id: msg.message_id, date: 0, chat: chat(CHAT), text: msg.text } } });
const waitFor = async (fn, ms = 5000) => { const t = Date.now() + ms; let v; while (!(v = fn()) && Date.now() < t) await new Promise((r) => setTimeout(r, 30)); assert.ok(v, 'waitFor timed out'); return v; };
const nextSent = async (n) => waitFor(() => sent[n]);

const daemon = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
  cwd: PROJECT,
  env: { ...process.env, BOT_TOKEN: '1:TEST', ALLOWED_CHAT_ID: String(CHAT), PORT: String(PORT), TELEGRAM_API_ROOT: `http://127.0.0.1:${TG_PORT}`, APPROVE_TIMEOUT_SEC: '4' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
daemon.stdout.on('data', (d) => (log += d)); daemon.stderr.on('data', (d) => (log += d));
await waitFor(() => log.includes('polling as @test_bot'), 15000);

const client = new Client({ name: 'e2e', version: '1' });
await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`)));
const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
const results = [];
const step = async (name, fn) => { try { await fn(); results.push(`PASS ${name}`); } catch (e) { results.push(`FAIL ${name}: ${e.message}`); } };

await step('tools listed', async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ['ask', 'cancel_ask', 'check_reply', 'get_messages', 'notify']);
});

await step('notify', async () => {
  assert.equal((await call('notify', { text: 'План готов', label: 'proj' })).status, 'sent');
  assert.equal(sent.at(-1).text, '🤖 [proj]\nПлан готов');
});

await step('ask answered by button', async () => {
  const n = sent.length;
  const p = call('ask', { question: 'Удалить X?', label: 'proj' });
  const msg = await nextSent(n);
  assert.equal(msg.reply_markup.inline_keyboard.flat().length, 2);
  pressButton(msg, 1);
  const r = await p;
  assert.deepEqual([r.status, r.answer, r.by], ['answered', '❌ Нет', 'button']);
  await waitFor(() => edits.find((e) => e.message_id === msg.message_id && e.text.endsWith('➡️ ❌ Нет')));
});

await step('ask timeout → text reply → check_reply', async () => {
  const n = sent.length;
  const r = await call('ask', { question: 'Какое имя?', options: [], timeout_sec: 5 });
  assert.equal(r.status, 'timeout');
  const msg = sent[n];
  assert.equal(msg.reply_markup, undefined);
  assert.equal((await call('check_reply', { request_id: r.request_id })).status, 'pending');
  pushText('Боб', { replyTo: msg.message_id });
  const c = await call('check_reply', { request_id: r.request_id, wait_sec: 5 });
  assert.deepEqual([c.status, c.answer, c.by], ['answered', 'Боб', 'text']);
});

await step('plain text goes to latest open ask', async () => {
  const n = sent.length;
  const p = call('ask', { question: 'Q?' });
  await nextSent(n);
  pushText('давай');
  const r = await p;
  assert.equal(r.answer, 'давай');
});

await step('two concurrent asks resolve independently', async () => {
  const n = sent.length;
  const a = call('ask', { question: 'A?', options: ['a1', 'a2'], label: 'agentA' });
  const b = call('ask', { question: 'B?', options: ['b1', 'b2'], label: 'agentB' });
  await nextSent(n + 1);
  const msgA = sent.slice(n).find((m) => m.text.includes('agentA'));
  const msgB = sent.slice(n).find((m) => m.text.includes('agentB'));
  pressButton(msgB, 0); pressButton(msgA, 1);
  assert.equal((await a).answer, 'a2');
  assert.equal((await b).answer, 'b1');
});

await step('free message → inbox, stranger ignored', async () => {
  pushText('сделай потом тесты');
  pushText('я чужой', { chatId: STRANGER });
  await waitFor(() => reactions.length >= 1 && updates.length === 0);
  await new Promise((r) => setTimeout(r, 300));
  const { messages } = await call('get_messages', {});
  assert.deepEqual(messages.map((m) => m.text), ['сделай потом тесты']);
  assert.equal((await call('get_messages', {})).messages.length, 0, 'unread consumed');
});

await step('cancel_ask', async () => {
  const r = await call('ask', { question: 'later?', timeout_sec: 5 });
  assert.equal((await call('cancel_ask', { request_id: r.request_id, reason: 'не нужно' })).status, 'cancelled');
  assert.ok(edits.at(-1).text.endsWith('🚫 Отменено: не нужно'));
});

const runHook = (endpoint, input) => {
  const child = spawn(process.execPath, ['hooks/send.mjs', endpoint], { cwd: PROJECT, env: { ...process.env, TELEGRAM_MCP_PORT: String(PORT) }, stdio: ['pipe', 'pipe', 'inherit'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stdin.end(JSON.stringify(input));
  return { child, done: new Promise((r) => child.on('exit', (code) => r({ code, out }))) };
};
const permInput = { hook_event_name: 'PermissionRequest', cwd: 'D:/x/myproj', tool_name: 'Bash', tool_input: { command: 'rm -rf build', description: 'Clean' } };

for (const [idx, behavior] of [[0, 'allow'], [1, 'deny']]) {
  await step(`approve hook → ${behavior}`, async () => {
    const n = sent.length;
    const h = runHook('approve', permInput);
    const msg = await nextSent(n);
    assert.ok(msg.text.startsWith('🤖 [myproj]\n🔐 Запрос разрешения: Bash'));
    pressButton(msg, idx);
    const { code, out } = await h.done;
    assert.equal(code, 0);
    const d = JSON.parse(out).hookSpecificOutput;
    assert.equal(d.hookEventName, 'PermissionRequest');
    assert.equal(d.decision.behavior, behavior);
  });
}

await step('approve: text reply does not approve', async () => {
  const n = sent.length;
  const h = runHook('approve', permInput);
  const msg = await nextSent(n);
  pushText('да', { replyTo: msg.message_id });
  const { out } = await h.done; // times out after 4s
  assert.equal(out, '');
  await waitFor(() => edits.find((e) => e.message_id === msg.message_id && e.text.includes('Время вышло')));
});

await step('approve: hook killed → "решено в терминале"', async () => {
  const n = sent.length;
  const h = runHook('approve', permInput);
  const msg = await nextSent(n);
  h.child.kill();
  await waitFor(() => edits.find((e) => e.message_id === msg.message_id && e.text.includes('Решено в терминале')));
});

await step('Stop hook → notify', async () => {
  const { out } = await runHook('notify', { hook_event_name: 'Stop', cwd: '/a/myproj', last_assistant_message: 'Готово.' }).done;
  assert.equal(out, '');
  assert.equal(sent.at(-1).text, '🤖 [myproj]\n✅ Агент завершил ответ\n\nГотово.');
});

await step('hook with daemon down → silent exit 0', async () => {
  const child = spawn(process.execPath, ['hooks/send.mjs', 'approve'], { cwd: PROJECT, env: { ...process.env, TELEGRAM_MCP_PORT: '8790' } });
  child.stdin.end('{}');
  const code = await new Promise((r) => child.on('exit', r));
  assert.equal(code, 0);
});

console.log(results.join('\n'));
await client.close();
daemon.kill();
if (results.some((r) => r.startsWith('FAIL'))) { console.log('--- daemon log ---\n' + log); process.exit(1); }
process.exit(0);
