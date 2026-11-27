'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CODEX_BIN = process.env.CODEX_BIN || 'codex';
const TIMEOUT_MS = Number(process.env.CODEX_TIMEOUT_MS || 300000);

// Flatten OpenAI chat messages into one prompt for `codex exec`.
function messagesToPrompt(messages) {
  const text = (c) => typeof c === 'string' ? c
    : Array.isArray(c) ? c.map((p) => p.text || p.input_text || p.output_text || '').join('') : '';
  const lines = [
    'You are acting as a plain chat completion API. Do not run commands or edit files; answer directly.',
    'Below is the conversation. Reply only with the next assistant message.', '',
  ];
  for (const m of messages) lines.push(`[${m.role}]\n${text(m.content)}\n`);
  return lines.join('\n');
}

function listModels() {
  const out = new Set();
  try {
    const d = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.codex', 'models_cache.json'), 'utf8'));
    for (const m of d.models || []) if (m.slug) out.add(m.slug);
  } catch { /* no cache yet */ }
  try {
    const m = /^model\s*=\s*"([^"]+)"/m.exec(fs.readFileSync(path.join(os.homedir(), '.codex', 'config.toml'), 'utf8'));
    if (m) out.add(m[1]);
  } catch { /* none */ }
  return [...out];
}

// Runs one turn. Resolves { text, usage }.
function runCodex({ prompt, model, effort }) {
  return new Promise((resolve, reject) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-ep-'));
    const args = ['exec', '--json', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only', '-C', cwd];
    if (model) args.push('-m', model);
    if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);
    args.push('-');
    const p = spawn(CODEX_BIN, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '', text = '', usage = null, err = '';
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('codex timed out')); }, TIMEOUT_MS);
    p.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        try {
          const ev = JSON.parse(line);
          if (ev.type === 'item.completed' && ev.item?.type === 'agent_message') text = ev.item.text; // keep last
          if (ev.type === 'turn.completed') usage = ev.usage;
          if (ev.type === 'error' || ev.type === 'turn.failed') err = ev.message || ev.error?.message || line;
        } catch { /* non-JSON line */ }
      }
    });
    p.stderr.on('data', (d) => { if (err.length < 2000) err += ''; });
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => {
      clearTimeout(timer);
      fs.rm(cwd, { recursive: true, force: true }, () => {});
      if (text) resolve({ text, usage });
      else reject(new Error(err || `codex exited with code ${code}`));
    });
    p.stdin.end(prompt);
  });
}

// Simple concurrency limiter so a burst doesn't spawn dozens of codex processes.
const MAX = Number(process.env.MAX_CONCURRENCY || 4);
let active = 0; const waiting = [];
async function limited(fn) {
  if (active >= MAX) await new Promise((r) => waiting.push(r));
  active++;
  try { return await fn(); } finally { active--; waiting.shift()?.(); }
}

module.exports = { messagesToPrompt, listModels, runCodex: (o) => limited(() => runCodex(o)) };
