'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os'), fs = require('fs'), path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cep-test-'));
process.env.ADMIN_PASSWORD = 'pw';
// Fake codex binary so tests need no subscription.
const fake = path.join(process.env.DATA_DIR, 'fakecodex');
fs.writeFileSync(fake, `#!/bin/sh
IN=$(cat)
case "$*" in
  *--output-schema*)
    if echo "$IN" | grep -q "tool result for call"; then
      T='{"text":"The weather is sunny.","tool_calls":[]}'
    else
      T='{"text":null,"tool_calls":[{"name":"get_weather","arguments":"{\\"city\\":\\"Dhaka\\"}"}]}'
    fi ;;
  *) T=pong ;;
esac
printf '%s\\n' "{\\"type\\":\\"item.completed\\",\\"item\\":{\\"type\\":\\"agent_message\\",\\"text\\":$(printf '%s' "$T" | python3 -c 'import sys,json;print(json.dumps(sys.stdin.read()))')}}"
echo '{"type":"turn.completed","usage":{"input_tokens":3,"output_tokens":1}}'
`, { mode: 0o755 });
process.env.CODEX_BIN = fake;
const { server } = require('../src/server');

let base, cookie, key;
test.before(() => new Promise((r) => server.listen(0, '127.0.0.1', () => { base = 'http://127.0.0.1:' + server.address().port; r(); })));
test.after(() => server.close());
const call = (p, o = {}) => fetch(base + p, o);

test('rejects missing key', async () => assert.equal((await call('/v1/models')).status, 401));
test('admin requires login', async () => assert.equal((await call('/admin/api/keys')).status, 401));
test('bad password rejected', async () => assert.equal((await call('/admin/login', { method: 'POST', body: '{"password":"x"}' })).status, 401));
test('login + create key', async () => {
  const r = await call('/admin/login', { method: 'POST', body: '{"password":"pw"}' });
  assert.equal(r.status, 200);
  cookie = r.headers.get('set-cookie').split(';')[0];
  const k = await (await call('/admin/api/keys', { method: 'POST', headers: { cookie }, body: '{"name":"t"}' })).json();
  assert.match(k.key, /^sk-codex-/); key = k.key;
  const list = await (await call('/admin/api/keys', { headers: { cookie } })).json();
  assert.equal(list[0].hash, undefined);
});
test('chat completion', async () => {
  const r = await call('/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer ' + key }, body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'ping' }] }) });
  const j = await r.json();
  assert.equal(j.choices[0].message.content, 'pong'); assert.equal(j.usage.total_tokens, 4);
});
test('streaming', async () => {
  const r = await call('/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer ' + key }, body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'ping' }] }) });
  const t = await r.text(); assert.match(t, /pong/); assert.match(t, /\[DONE\]/);
});
test('responses api', async () => {
  const r = await call('/v1/responses', { method: 'POST', headers: { authorization: 'Bearer ' + key }, body: '{"input":"ping"}' });
  assert.equal((await r.json()).output_text, 'pong');
});
test('revoked key fails', async () => {
  const list = await (await call('/admin/api/keys', { headers: { cookie } })).json();
  await call(`/admin/api/keys/${list[0].id}/revoke`, { method: 'POST', headers: { cookie } });
  assert.equal((await call('/v1/models', { headers: { authorization: 'Bearer ' + key } })).status, 401);
});

test('tools: chat completions round trip', async () => {
  const k = await (await call('/admin/api/keys', { method: 'POST', headers: { cookie }, body: '{"name":"t2"}' })).json();
  const H = { authorization: 'Bearer ' + k.key };
  const tools = [{ type: 'function', function: { name: 'get_weather', description: 'w', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }];
  const r1 = await (await call('/v1/chat/completions', { method: 'POST', headers: H, body: JSON.stringify({ tools, messages: [{ role: 'user', content: 'weather in Dhaka?' }] }) })).json();
  const c = r1.choices[0];
  assert.equal(c.finish_reason, 'tool_calls');
  assert.equal(c.message.tool_calls[0].function.name, 'get_weather');
  assert.deepEqual(JSON.parse(c.message.tool_calls[0].function.arguments), { city: 'Dhaka' });
  const r2 = await (await call('/v1/chat/completions', { method: 'POST', headers: H, body: JSON.stringify({ tools, messages: [
    { role: 'user', content: 'weather in Dhaka?' }, c.message, { role: 'tool', tool_call_id: c.message.tool_calls[0].id, content: 'sunny' }] }) })).json();
  assert.equal(r2.choices[0].finish_reason, 'stop');
  assert.equal(r2.choices[0].message.content, 'The weather is sunny.');
  // streaming variant carries the tool call too
  const st = await (await call('/v1/chat/completions', { method: 'POST', headers: H, body: JSON.stringify({ stream: true, tools, messages: [{ role: 'user', content: 'x' }] }) })).text();
  assert.match(st, /"tool_calls"/); assert.match(st, /"finish_reason":"tool_calls"/);
});
test('tools: responses api, plain and streamed', async () => {
  const k = await (await call('/admin/api/keys', { method: 'POST', headers: { cookie }, body: '{"name":"t3"}' })).json();
  const H = { authorization: 'Bearer ' + k.key };
  const tools = [{ type: 'function', name: 'get_weather', description: 'w', parameters: { type: 'object', properties: {} } }];
  const r = await (await call('/v1/responses', { method: 'POST', headers: H, body: JSON.stringify({ tools, input: 'weather?' }) })).json();
  const fc = r.output.find((o) => o.type === 'function_call');
  assert.equal(fc.name, 'get_weather');
  const r2 = await (await call('/v1/responses', { method: 'POST', headers: H, body: JSON.stringify({ tools, input: [
    { role: 'user', content: 'weather?' }, fc, { type: 'function_call_output', call_id: fc.call_id, output: 'sunny' }] }) })).json();
  assert.equal(r2.output_text, 'The weather is sunny.');
  const sse = await (await call('/v1/responses', { method: 'POST', headers: H, body: JSON.stringify({ stream: true, input: 'hi' }) })).text();
  assert.match(sse, /event: response.output_text.delta/); assert.match(sse, /event: response.completed/);
});
