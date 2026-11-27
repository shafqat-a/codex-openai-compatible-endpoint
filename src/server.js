'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { KeyStore } = require('./keys');
const codex = require('./codex');
const tools_ = require('./tools');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const DATA = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const store = new KeyStore(path.join(DATA, 'keys.json'));

// Admin password: env var, else generated once and kept in data/admin-password.
function adminPassword() {
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;
  const f = path.join(DATA, 'admin-password');
  try { return fs.readFileSync(f, 'utf8').trim(); } catch { /* generate */ }
  const pw = crypto.randomBytes(12).toString('base64url');
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(f, pw + '\n', { mode: 0o600 });
  console.log(`Generated admin password (also in ${f}): ${pw}`);
  return pw;
}
const ADMIN_PW = adminPassword();
const SESSION_SECRET = crypto.randomBytes(32);
const sign = (v) => crypto.createHmac('sha256', SESSION_SECRET).update(v).digest('base64url');
const eq = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };

function isAdmin(req) {
  const m = /(?:^|;\s*)admin=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return false;
  const [exp, sig] = m[1].split('.');
  return Number(exp) > Date.now() && sig && eq(sig, sign(exp));
}

const json = (res, code, obj, headers = {}) => {
  res.writeHead(code, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(obj));
};
const oaErr = (res, code, message, type = 'invalid_request_error') => json(res, code, { error: { message, type, code: null } });

function readBody(req, limit = 4e6) {
  return new Promise((resolve, reject) => {
    let b = ''; req.on('data', (d) => { b += d; if (b.length > limit) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => resolve(b)); req.on('error', reject);
  });
}
const readJson = async (req) => { try { return JSON.parse((await readBody(req)) || '{}'); } catch { return null; } };

const loginFails = new Map(); // ip -> {n, until}

// ---- OpenAI-compatible API ----
function chatId() { return 'chatcmpl-' + crypto.randomBytes(12).toString('hex'); }
function usageOf(u) {
  const p = u?.input_tokens || 0, c = u?.output_tokens || 0;
  return { prompt_tokens: p, completion_tokens: c, total_tokens: p + c };
}

// One turn: plain text mode, or tool mode (JSON-shaped reply, retried once if malformed).
async function complete({ messages, tools, toolChoice, model, effort }) {
  tools = toolChoice === 'none' ? [] : tools;
  if (!tools.length) {
    const o = await codex.runCodex({ prompt: tools_.buildPrompt(messages, [], null), model, effort });
    return { text: o.text, toolCalls: [], usage: o.usage };
  }
  const prompt = tools_.buildPrompt(messages, tools, toolChoice);
  let o = await codex.runCodex({ prompt, model, effort, schema: tools_.SCHEMA });
  let r = tools_.parseReply(o.text, tools);
  if (!r) {
    o = await codex.runCodex({ prompt: prompt + '\n\nYour previous reply was not valid. Reply with ONLY the JSON object described above.', model, effort, schema: tools_.SCHEMA });
    r = tools_.parseReply(o.text, tools);
  }
  if (!r) throw new Error('model returned an invalid tool-call reply');
  return { ...r, usage: o.usage };
}

async function chatCompletions(req, res) {
  const body = await readJson(req);
  if (!body || !Array.isArray(body.messages) || !body.messages.length) return oaErr(res, 400, '`messages` is required');
  const model = body.model || 'gpt-6-astra';
  let out;
  try { out = await complete({ messages: body.messages, tools: tools_.normalizeTools(body.tools), toolChoice: body.tool_choice, model, effort: body.reasoning_effort }); }
  catch (e) { return oaErr(res, 502, 'Codex error: ' + e.message, 'api_error'); }
  const id = chatId(), created = Math.floor(Date.now() / 1000);
  const tc = out.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } }));
  const finish = tc.length ? 'tool_calls' : 'stop';
  if (body.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const send = (d) => res.write('data: ' + JSON.stringify(d) + '\n\n');
    const base = { id, object: 'chat.completion.chunk', created, model };
    send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
    if (out.text) send({ ...base, choices: [{ index: 0, delta: { content: out.text }, finish_reason: null }] });
    if (tc.length) send({ ...base, choices: [{ index: 0, delta: { tool_calls: tc.map((c, i) => ({ index: i, ...c })) }, finish_reason: null }] });
    send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }], ...(body.stream_options?.include_usage ? { usage: usageOf(out.usage) } : {}) });
    res.end('data: [DONE]\n\n');
    return;
  }
  json(res, 200, {
    id, object: 'chat.completion', created, model,
    choices: [{ index: 0, message: { role: 'assistant', content: out.text || (tc.length ? null : ''), ...(tc.length ? { tool_calls: tc } : {}) }, finish_reason: finish }],
    usage: usageOf(out.usage),
  });
}

// /v1/responses: text, function tools, and SSE streaming.
async function responses(req, res) {
  const body = await readJson(req);
  if (!body || body.input == null) return oaErr(res, 400, '`input` is required');
  const model = body.model || 'gpt-6-astra';
  let out;
  try { out = await complete({ messages: tools_.inputToMessages(body.input, body.instructions), tools: tools_.normalizeTools(body.tools), toolChoice: body.tool_choice, model, effort: body.reasoning?.effort }); }
  catch (e) { return oaErr(res, 502, 'Codex error: ' + e.message, 'api_error'); }
  const rid = 'resp_' + crypto.randomBytes(12).toString('hex'), created = Math.floor(Date.now() / 1000);
  const hex = (n) => crypto.randomBytes(n).toString('hex');
  const items = [];
  if (out.text || !out.toolCalls.length) items.push({ id: 'msg_' + hex(8), type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: out.text || '', annotations: [] }] });
  for (const c of out.toolCalls) items.push({ id: 'fc_' + hex(8), type: 'function_call', status: 'completed', call_id: c.id, name: c.name, arguments: c.arguments });
  const u = out.usage || {};
  const final = { id: rid, object: 'response', created_at: created, status: 'completed', model, output_text: out.text || '', output: items,
    usage: { input_tokens: u.input_tokens || 0, output_tokens: u.output_tokens || 0, total_tokens: (u.input_tokens || 0) + (u.output_tokens || 0) } };
  if (!body.stream) return json(res, 200, final);
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  let seq = 0;
  const ev = (type, d) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...d })}\n\n`);
  const shell = { ...final, status: 'in_progress', output: [], output_text: '' };
  ev('response.created', { response: shell }); ev('response.in_progress', { response: shell });
  items.forEach((it, i) => {
    if (it.type === 'message') {
      const part = it.content[0];
      ev('response.output_item.added', { output_index: i, item: { ...it, status: 'in_progress', content: [] } });
      ev('response.content_part.added', { item_id: it.id, output_index: i, content_index: 0, part: { ...part, text: '' } });
      if (part.text) ev('response.output_text.delta', { item_id: it.id, output_index: i, content_index: 0, delta: part.text });
      ev('response.output_text.done', { item_id: it.id, output_index: i, content_index: 0, text: part.text });
      ev('response.content_part.done', { item_id: it.id, output_index: i, content_index: 0, part });
    } else {
      ev('response.output_item.added', { output_index: i, item: { ...it, status: 'in_progress', arguments: '' } });
      ev('response.function_call_arguments.delta', { item_id: it.id, output_index: i, delta: it.arguments });
      ev('response.function_call_arguments.done', { item_id: it.id, output_index: i, arguments: it.arguments });
    }
    ev('response.output_item.done', { output_index: i, item: it });
  });
  ev('response.completed', { response: final });
  res.end();
}

async function api(req, res, url) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  if (!store.verify(m && m[1].trim())) return oaErr(res, 401, 'Invalid API key.', 'authentication_error');
  if (url.pathname === '/v1/models' && req.method === 'GET') {
    const data = codex.listModels().map((id) => ({ id, object: 'model', created: 0, owned_by: 'codex' }));
    return json(res, 200, { object: 'list', data });
  }
  if (url.pathname === '/v1/chat/completions' && req.method === 'POST') return chatCompletions(req, res);
  if (url.pathname === '/v1/responses' && req.method === 'POST') return responses(req, res);
  oaErr(res, 404, `Unknown endpoint ${req.method} ${url.pathname}`);
}

// ---- Admin UI + API ----
const PUBLIC = path.join(__dirname, '..', 'public');
async function admin(req, res, url) {
  if (url.pathname === '/admin/login' && req.method === 'POST') {
    const ip = req.socket.remoteAddress, f = loginFails.get(ip);
    if (f && f.n >= 5 && f.until > Date.now()) return json(res, 429, { error: 'Too many attempts. Try later.' });
    const b = await readJson(req);
    if (!b || typeof b.password !== 'string' || !eq(b.password, ADMIN_PW)) {
      const n = (f?.n || 0) + 1; loginFails.set(ip, { n, until: Date.now() + 60000 });
      return json(res, 401, { error: 'Wrong password' });
    }
    loginFails.delete(ip);
    const exp = String(Date.now() + 12 * 3600e3);
    return json(res, 200, { ok: true }, { 'set-cookie': `admin=${exp}.${sign(exp)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200` });
  }
  if (url.pathname === '/admin/logout' && req.method === 'POST')
    return json(res, 200, { ok: true }, { 'set-cookie': 'admin=; HttpOnly; Path=/; Max-Age=0' });
  if (url.pathname === '/admin/api/session') return json(res, 200, { loggedIn: isAdmin(req) });
  if (!isAdmin(req)) return json(res, 401, { error: 'Not logged in' });
  if (url.pathname === '/admin/api/keys' && req.method === 'GET') return json(res, 200, store.list());
  if (url.pathname === '/admin/api/keys' && req.method === 'POST') {
    const b = await readJson(req);
    return json(res, 200, store.create(b?.name));
  }
  const m = /^\/admin\/api\/keys\/([\w-]+)(\/revoke)?$/.exec(url.pathname);
  if (m && m[2] && req.method === 'POST') return json(res, store.revoke(m[1]) ? 200 : 404, { ok: true });
  if (m && !m[2] && req.method === 'DELETE') return json(res, store.remove(m[1]) ? 200 : 404, { ok: true });
  json(res, 404, { error: 'not found' });
}

function serveStatic(res, file, type) {
  try { res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' }); res.end(fs.readFileSync(path.join(PUBLIC, file))); }
  catch { res.writeHead(404); res.end('not found'); }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/v1/')) return await api(req, res, url);
    if (url.pathname.startsWith('/admin/')) return await admin(req, res, url);
    if (url.pathname === '/' || url.pathname === '/admin') return serveStatic(res, 'index.html', 'text/html; charset=utf-8');
    if (url.pathname === '/healthz') return json(res, 200, { ok: true });
    res.writeHead(404); res.end('not found');
  } catch (e) {
    if (!res.headersSent) oaErr(res, 500, e.message, 'api_error'); else res.end();
  }
});

// HOST may be a comma-separated list (e.g. "127.0.0.1,10.89.1.1") to listen on several addresses.
if (require.main === module) {
  const hosts = HOST.split(',').map((h) => h.trim()).filter(Boolean);
  hosts.forEach((h, i) => {
    const s = i === 0 ? server : http.createServer(server.listeners('request')[0]);
    s.listen(PORT, h, () => console.log(`codex endpoint on http://${h}:${PORT}  (UI: /admin)`));
  });
}
module.exports = { server, store };
