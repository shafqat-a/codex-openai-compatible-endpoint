'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os'), fs = require('fs'), path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cep-test-'));
process.env.ADMIN_PASSWORD = 'pw';
// Fake codex binary so tests need no subscription.
const fake = path.join(process.env.DATA_DIR, 'fakecodex');
fs.writeFileSync(fake, '#!/bin/sh\ncat >/dev/null\necho \'{"type":"item.completed","item":{"type":"agent_message","text":"pong"}}\'\necho \'{"type":"turn.completed","usage":{"input_tokens":3,"output_tokens":1}}\'\n', { mode: 0o755 });
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
