'use strict';
// Tool-calling emulation: tools go into the prompt, Codex must answer with a fixed JSON shape,
// and we convert that JSON back into OpenAI tool calls.
const crypto = require('crypto');

const SCHEMA = {
  type: 'object',
  properties: {
    text: { type: ['string', 'null'] },
    tool_calls: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, arguments: { type: 'string' } },
        required: ['name', 'arguments'], additionalProperties: false,
      },
    },
  },
  required: ['text', 'tool_calls'], additionalProperties: false,
};

const partsText = (c) => typeof c === 'string' ? c
  : Array.isArray(c) ? c.map((p) => p.text || p.input_text || p.output_text || '').join('') : (c == null ? '' : JSON.stringify(c));

// Accept chat-style and responses-style tools; keep function tools only.
function normalizeTools(tools) {
  return (tools || []).filter((t) => t && t.type === 'function' && (t.function?.name || t.name)).map((t) => {
    const f = t.function || t;
    return { name: f.name, description: f.description || '', parameters: f.parameters || { type: 'object', properties: {} } };
  });
}

// Responses `input` items -> chat-style messages.
function inputToMessages(input, instructions) {
  const msgs = [];
  if (instructions) msgs.push({ role: 'system', content: instructions });
  if (typeof input === 'string') { msgs.push({ role: 'user', content: input }); return msgs; }
  for (const it of input || []) {
    if (it.type === 'function_call') {
      msgs.push({ role: 'assistant', content: '', tool_calls: [{ id: it.call_id || it.id, function: { name: it.name, arguments: it.arguments || '{}' } }] });
    } else if (it.type === 'function_call_output') {
      msgs.push({ role: 'tool', tool_call_id: it.call_id, content: partsText(it.output) });
    } else if (it.role) {
      msgs.push({ role: it.role === 'developer' ? 'system' : it.role, content: it.content });
    }
  }
  return msgs;
}

function buildPrompt(messages, tools, toolChoice) {
  const out = ['You are acting as a plain chat completion API. Do not run shell commands or edit files; answer directly.'];
  const active = toolChoice === 'none' ? [] : tools;
  if (active.length) {
    out.push('', 'You can call these tools. Definitions (JSON Schema for arguments):', JSON.stringify(active, null, 1), '',
      'Reply with a JSON object: {"text": <string or null>, "tool_calls": [{"name": <tool name>, "arguments": <JSON-encoded string of the arguments>}]}.',
      '- To call tool(s), put them in "tool_calls" (several are allowed when independent) and set "text" to null.',
      '- To answer the user without tools, set "tool_calls" to [] and put your full reply in "text".',
      '- Only use tool names listed above. Use the results of earlier tool calls instead of repeating them.');
    if (toolChoice === 'required') out.push('- You MUST call at least one tool.');
    const named = toolChoice && typeof toolChoice === 'object' ? (toolChoice.function?.name || toolChoice.name) : null;
    if (named) out.push(`- You MUST call the tool "${named}".`);
  }
  out.push('', 'Conversation. Reply only with the next assistant turn.', '');
  for (const m of messages) {
    if (m.role === 'tool') out.push(`[tool result for call ${m.tool_call_id}]\n${partsText(m.content)}\n`);
    else {
      const t = partsText(m.content);
      if (t) out.push(`[${m.role}]\n${t}\n`);
      for (const c of m.tool_calls || []) out.push(`[assistant called tool ${c.function.name} (call ${c.id})]\n${c.function.arguments}\n`);
    }
  }
  return out.join('\n');
}

// Returns { text, toolCalls:[{id,name,arguments}] } or null if the reply is unusable.
function parseReply(raw, tools) {
  let j;
  try { j = JSON.parse(raw); } catch {
    const m = /\{[\s\S]*\}/.exec(raw); try { j = m && JSON.parse(m[0]); } catch { j = null; }
  }
  if (!j || typeof j !== 'object') return null;
  const names = new Set(tools.map((t) => t.name));
  const calls = (Array.isArray(j.tool_calls) ? j.tool_calls : []).filter((c) => c && names.has(c.name)).map((c) => {
    let a = c.arguments; if (typeof a !== 'string') a = JSON.stringify(a ?? {});
    try { JSON.parse(a); } catch { a = '{}'; }
    return { id: 'call_' + crypto.randomBytes(9).toString('hex'), name: c.name, arguments: a };
  });
  if (!calls.length && typeof j.text !== 'string') return null;
  return { text: calls.length ? (j.text || '') : j.text, toolCalls: calls };
}

module.exports = { SCHEMA, normalizeTools, inputToMessages, buildPrompt, parseReply, partsText };
