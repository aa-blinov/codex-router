// Codex Router — один провайдер в Codex, несколько бэкендов за ним.
//
//   deepseek-*   -> api.deepseek.com   (трансляция Responses <-> Chat Completions)
//   minimax-*    -> api.minimax.io     (та же трансляция, свой контракт reasoning)
//   остальные    -> chatgpt.com/backend-api/codex (проброс, токен даёт Codex)
//
// Ключи лежат в keys.dpapi: JSON, зашифрованный DPAPI (CurrentUser) + ACL.
// Переменные окружения DEEPSEEK_API_KEY / MINIMAX_API_KEY имеют приоритет.
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CFG_PATH = path.join(HERE, 'codex-router.config.json');
const LOG_DIR = path.join(HERE, 'logs');
const ROUTE_LOG = path.join(LOG_DIR, 'routes.jsonl');
const IS_WIN = process.platform === 'win32';
const INLINE_MARKER = '<]minimax[>[';
const ROUTER_VERSION = '1.3.0';
const CALIB_PATH = path.join(HERE, 'token-calibration.json');
let tokenCalibration = {};
try { tokenCalibration = JSON.parse(fs.readFileSync(CALIB_PATH, 'utf8')) || {}; } catch { tokenCalibration = {}; }

function charsPerToken(model) {
  const v = tokenCalibration[model];
  if (typeof v === 'number' && v > 0.5 && v < 20) return v;
  const name = String(model || '').toLowerCase();
  if (name.startsWith('minimax')) return 3.0;
  if (name.startsWith('deepseek')) return 2.6;
  return 3.4;
}

const STATS_PATH = path.join(HERE, 'usage-stats.json');
let usageStats = {};
try { usageStats = JSON.parse(fs.readFileSync(STATS_PATH, 'utf8')) || {}; } catch { usageStats = {}; }

function saveUsageStats() {
  try { fs.writeFileSync(STATS_PATH, JSON.stringify(usageStats, null, 2)); } catch {}
}

function recordUsage(model, usage, chars) {
  if (!model || !usage) return;
  const s = usageStats[model] || { requests: 0, inputTokens: 0, outputTokens: 0 };
  s.requests += 1;
  s.inputTokens += usage.input_tokens || 0;
  s.outputTokens += usage.output_tokens || 0;
  if (usage.input_tokens) {
    s.lastPromptTokens = usage.input_tokens;
    s.lastChars = chars;
  }
  usageStats[model] = s;
  saveUsageStats();
}

function saveTokenCalibration() {
  try { fs.writeFileSync(CALIB_PATH, JSON.stringify(tokenCalibration, null, 2)); } catch {}
}

function observeTokens(model, chars, tokens) {
  if (!model || !chars || !tokens || tokens < 50) return;
  const ratio = chars / tokens;
  if (!(ratio > 0.5 && ratio < 20)) return;
  const prev = charsPerToken(model);
  tokenCalibration[model] = Number((prev * 0.5 + ratio * 0.5).toFixed(4));
  saveTokenCalibration();
}
const reasoningByCall = new Map();
const REASONING_LIMIT = 500;

function rememberReasoning(callId, text) {
  if (!callId) return;
  reasoningByCall.set(callId, text);
  if (reasoningByCall.size > REASONING_LIMIT) {
    const oldest = reasoningByCall.keys().next().value;
    reasoningByCall.delete(oldest);
  }
}

function coerceValue(raw) {
  const v = String(raw).replace(/\]\s*$/, '').trim();
  if (/^-?\d+$/.test(v)) return Number(v);
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v.startsWith('[') || v.startsWith('{')) {
    try { return JSON.parse(v); } catch { return v; }
  }
  return v;
}
const VAULT_PATH = path.join(HERE, IS_WIN ? 'keys.dpapi' : 'keys.json');

const DEFAULTS = {
  port: 8788,
  openai: { baseUrl: 'https://chatgpt.com', prefix: '/backend-api/codex' },
  providers: {
    deepseek: {
      contextLimit: 1048576,
      baseUrl: 'https://api.deepseek.com',
      match: ['deepseek'],
      keyEnv: 'DEEPSEEK_API_KEY',
      defaultModel: 'deepseek-flash',
      fallbackModel: 'deepseek-v4.1-flash',
      reasoning: 'thinking',
      modelMap: {
        'deepseek-v4.1-flash': 'deepseek-flash',
        'deepseek-v4-flash': 'deepseek-flash',
        'deepseek-flash': 'deepseek-flash',
        'deepseek-v4-pro': 'deepseek-v4-pro',
        'deepseek-pro': 'deepseek-v4-pro',
      },
    },
    minimax: {
      contextLimit: 1048576,
      baseUrl: 'https://api.minimax.io',
      match: ['minimax'],
      keyEnv: 'MINIMAX_API_KEY',
      defaultModel: 'MiniMax-M3.1-Flash',
      reasoning: 'effort',
      effortMap: { none: 'low', minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
      modelReasoning: {
        'MiniMax-M3': { mode: 'toggle+effort', split: true },
      },
      modelMap: {
        'minimax-m3.1-flash': 'MiniMax-M3.1-Flash',
        'minimax-m3': 'MiniMax-M3',
        'minimax-m2.7': 'MiniMax-M2.7',
        'minimax-m2.7-highspeed': 'MiniMax-M2.7-highspeed',
        'minimax-m2.5': 'MiniMax-M2.5',
        'minimax-m2.1': 'MiniMax-M2.1',
        'minimax-m2': 'MiniMax-M2',
      },
    },
  },
};

const cfg = merge(structuredClone(DEFAULTS),
  fs.existsSync(CFG_PATH) ? JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')) : {});

function merge(a, b) {
  for (const [k, v] of Object.entries(b || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v)) a[k] = merge(a[k] || {}, v);
    else a[k] = v;
  }
  return a;
}

// ---------- хранилище ключей ----------

const keyCache = new Map();

function dpapiDecrypt(file) {
  const blob = fs.readFileSync(file, 'utf8').trim();
  const script =
    "Add-Type -AssemblyName System.Security;" +
    "$b=[Convert]::FromBase64String('" + blob + "');" +
    "$u=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser');" +
    "[Console]::Out.Write([Convert]::ToBase64String($u))";
  const out = execFileSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8' });
  return Buffer.from(out.trim(), 'base64').toString('utf8').trim();
}

function readVault() {
  if (!fs.existsSync(VAULT_PATH)) return {};
  try {
    const raw = IS_WIN ? dpapiDecrypt(VAULT_PATH) : fs.readFileSync(VAULT_PATH, 'utf8');
    return JSON.parse(raw) || {};
  } catch (e) {
    return { __error: e.message };
  }
}

function providerKey(id) {
  if (keyCache.has(id)) return keyCache.get(id);
  const prov = cfg.providers[id];
  let key = null, source = 'none';
  if (prov && prov.keyEnv && process.env[prov.keyEnv]) {
    key = process.env[prov.keyEnv].trim();
    source = 'env';
  }
  if (!key) {
    const vault = readVault();
    if (vault[id]) { key = String(vault[id]); source = IS_WIN ? 'dpapi' : 'file'; }
    else if (vault.__error) source = 'dpapi-error';
  }
  if (!key && id === 'deepseek' && IS_WIN) {
    const legacy = path.join(os.homedir(), '.codex', 'codex-router', 'secret.dpapi');
    if (fs.existsSync(legacy)) {
      try {
        const raw = dpapiDecrypt(legacy);
        const v = raw.trim().startsWith('{') ? JSON.parse(raw) : raw;
        key = typeof v === 'string' ? v : (v.deepseek || null);
        if (key) source = 'legacy';
      } catch { /* ignore */ }
    }
  }
  const result = { key, source };
  keyCache.set(id, result);
  return result;
}

function providerFor(model) {
  if (typeof model !== 'string') return null;
  const m = model.toLowerCase();
  for (const [id, p] of Object.entries(cfg.providers)) {
    if ((p.match || []).some(prefix => m.startsWith(prefix))) return { id, prov: p };
  }
  return null;
}

function log(rec) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(ROUTE_LOG, JSON.stringify(rec) + '\n');
  } catch {}
}

function readLog(limit) {
  try {
    const lines = fs.readFileSync(ROUTE_LOG, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-limit).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

function sendJson(res, code, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
  res.end(s);
}

// ---------- Responses -> Chat Completions ----------

function contentOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const p of content) {
    if (!p) continue;
    const type = p.type || '';
    if (type === 'input_image' || type === 'image_url') {
      const url = typeof p.image_url === 'string' ? p.image_url : (p.image_url && p.image_url.url) || p.url;
      if (url) parts.push({ type: 'image_url', image_url: { url } });
      continue;
    }
    const text = p.text ?? p.input_text ?? '';
    if (text) parts.push({ type: 'text', text });
  }
  if (!parts.length) return '';
  if (parts.every(x => x.type === 'text')) return parts.map(x => x.text).join('');
  return parts;
}

function convertTools(tools) {
  const out = [];
  const customNames = new Set();
  const seen = new Set();
  const push = (fn) => {
    if (!fn || !fn.name || seen.has(fn.name)) return;
    seen.add(fn.name);
    out.push({ type: 'function', function: fn });
  };
  for (const t of tools || []) {
    if (t.type === 'function') {
      push({ name: t.name, description: t.description || '', parameters: t.parameters || { type: 'object', properties: {} } });
    } else if (t.type === 'namespace') {
      for (const inner of t.tools || []) {
        if (inner.type === 'function') {
          push({ name: inner.name, description: inner.description || '', parameters: inner.parameters || { type: 'object', properties: {} } });
        }
      }
    } else if (t.type === 'custom') {
      customNames.add(t.name);
      if (seen.has(t.name)) continue;
      push({
        name: t.name,
        description: (t.description || '') + '\nPut the entire payload into the input field.',
        parameters: {
          type: 'object',
          properties: { input: { type: 'string', description: 'Raw tool input.' } },
          required: ['input'],
        },
      });
    }
  }
  return { tools: out, customNames };
}

function toChatRequest(body, prov) {
  const items = body.input || [];
  const effort = body.reasoning?.effort || null;
  const isDeepSeek = /deepseek/i.test(prov.baseUrl || '');
  const needReasoning = isDeepSeek && effort !== 'none';

  const outputs = new Map();
  for (const it of items) {
    if (it.type === 'function_call_output' || it.type === 'custom_tool_call_output') {
      outputs.set(it.call_id, typeof it.output === 'string' ? it.output : JSON.stringify(it.output ?? ''));
    }
  }

  const messages = [];
  const consumed = new Set();
  let missingReasoning = false;
  if (body.instructions) messages.push({ role: 'system', content: body.instructions });

  for (const item of items) {
    const t = item.type || 'message';
    if (t === 'message') {
      const role = item.role === 'developer' ? 'system' : item.role;
      const msg = { role, content: contentOf(item.content) };
      if (needReasoning && role === 'assistant') msg.reasoning_content = '';
      messages.push(msg);
    } else if (t === 'function_call' || t === 'custom_tool_call') {
      const callId = item.call_id || item.id;
      const args = t === 'custom_tool_call'
        ? JSON.stringify({ input: item.input || '' })
        : (item.arguments || '{}');
      const assistantMsg = {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: callId, type: 'function', function: { name: item.name, arguments: args } }],
      };
      const known = reasoningByCall.get(callId);
      if (isDeepSeek) {
        // DeepSeek требует наличие поля reasoning_content у assistant+tool_calls,
        // даже если размышлений не было: пустая строка принимается.
        if (needReasoning) assistantMsg.reasoning_content = known !== undefined ? known : '';
      } else if (known !== undefined) {
        assistantMsg.reasoning_content = known;
      }
      messages.push(assistantMsg);
      if (outputs.has(callId)) {
        messages.push({ role: 'tool', tool_call_id: callId, content: outputs.get(callId) });
        consumed.add(callId);
      }
    } else if (t === 'function_call_output' || t === 'custom_tool_call_output') {
      if (!consumed.has(item.call_id)) {
        messages.push({
          role: 'tool',
          tool_call_id: item.call_id,
          content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? ''),
        });
        consumed.add(item.call_id);
      }
    }
  }

  const { tools, customNames } = convertTools(body.tools);
  const upstreamModel = prov.modelMap[String(body.model).toLowerCase()] || prov.defaultModel;

  const req = {
    model: upstreamModel,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (tools.length) {
    req.tools = tools;
    req.tool_choice = body.tool_choice === 'none' ? 'none' : 'auto';
  }
  if (body.parallel_tool_calls) req.parallel_tool_calls = true;

  const perModel = (prov.modelReasoning || {})[upstreamModel] || null;
  const mode = perModel?.mode || prov.reasoning;
  const mappedEffort = (prov.effortMap || {})[effort] || 'high';

  if (mode === 'thinking') {
    // У DeepSeek нет градаций: API принимает reasoning_effort и budget_tokens, но игнорирует их.
    // Поэтому все уровни кроме none означают включённое мышление.
    req.thinking = { type: effort === 'none' ? 'disabled' : 'enabled' };
  } else if (mode === 'effort') {
    req.reasoning_effort = mappedEffort;
  } else if (mode === 'toggle+effort') {
    // MiniMax-M3: thinking.type допускает только adaptive|disabled,
    // а thinking по умолчанию уходит в content как <think>, поэтому split обязателен.
    if (effort === 'none') {
      req.thinking = { type: 'disabled' };
    } else {
      req.reasoning_effort = mappedEffort;
      if (perModel?.split !== false) req.reasoning_split = true;
    }
  }

  return { req, customNames, upstreamModel };
}

// ---------- Chat Completions SSE -> Responses SSE ----------

class Emitter {
  constructor(res, model) {
    this.res = res;
    this.model = model;
    this.seq = 0;
    this.responseId = 'resp_' + Math.random().toString(36).slice(2, 18);
    this.createdAt = Math.floor(Date.now() / 1000);
    this.output = [];
    this.text = null;
    this.tool = null;
    this.usage = null;
    this.textBuffer = '';
    this.reasoningText = '';
    this.reasoningItem = null;
    this.inlineToolText = null;
    this.customNames = new Set();
  }

  send(type, payload) {
    const data = Object.assign({ type, sequence_number: this.seq++ }, payload);
    this.res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  skeleton(status) {
    return {
      id: this.responseId, object: 'response', created_at: this.createdAt,
      status, model: this.model, output: [], error: null, incomplete_details: null,
      instructions: null, parallel_tool_calls: true,
    };
  }

  start() {
    if (this.res.headersSent) return;
    this.res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    this.send('response.created', { response: this.skeleton('in_progress') });
    this.send('response.in_progress', { response: this.skeleton('in_progress') });
  }

  ensureText() {
    if (this.text) return this.text;
    const item = {
      type: 'message', id: 'msg_' + Math.random().toString(36).slice(2, 16),
      status: 'in_progress', role: 'assistant', content: [],
    };
    this.text = { item };
    this.output.push(item);
    this.send('response.output_item.added', { output_index: this.output.length - 1, item });
    this.send('response.content_part.added', {
      item_id: item.id, output_index: this.output.length - 1, content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    });
    return this.text;
  }

  emitText(t) {
    if (!t) return;
    const ctx = this.ensureText();
    const idx = this.output.indexOf(ctx.item);
    ctx.item.__text = (ctx.item.__text || '') + t;
    this.send('response.output_text.delta', { item_id: ctx.item.id, output_index: idx, content_index: 0, delta: t });
  }

  textDelta(t) {
    if (!t) return;
    if (this.inlineToolText !== null) { this.inlineToolText += t; return; }
    this.textBuffer += t;
    const at = this.textBuffer.indexOf(INLINE_MARKER);
    if (at >= 0) {
      const before = this.textBuffer.slice(0, at);
      if (before) this.emitText(before);
      this.inlineToolText = this.textBuffer.slice(at);
      this.textBuffer = '';
      return;
    }
    if (this.textBuffer.length > 400) {
      const ready = this.textBuffer.slice(0, -40);
      this.textBuffer = this.textBuffer.slice(-40);
      if (ready) this.emitText(ready);
    }
  }

  reasoningDelta(text) {
    if (!text) return;
    if (!this.reasoningItem) {
      const item = { type: 'reasoning', id: 'rs_' + Math.random().toString(36).slice(2, 16), summary: [], status: 'in_progress' };
      this.reasoningItem = item;
      this.output.push(item);
      const outputIndex = this.output.length - 1;
      this.send('response.output_item.added', { output_index: outputIndex, item });
      this.send('response.reasoning_summary_part.added', {
        item_id: item.id, output_index: outputIndex, summary_index: 0,
        part: { type: 'summary_text', text: '' },
      });
    }
    const idx = this.output.indexOf(this.reasoningItem);
    this.send('response.reasoning_summary_text.delta', {
      item_id: this.reasoningItem.id, output_index: idx, summary_index: 0, delta: text,
    });
  }

  finishReasoning() {
    if (!this.reasoningItem) return;
    const item = this.reasoningItem;
    const idx = this.output.indexOf(item);
    const text = this.reasoningText || '';
    this.send('response.reasoning_summary_text.done', { item_id: item.id, output_index: idx, summary_index: 0, text });
    this.send('response.reasoning_summary_part.done', {
      item_id: item.id, output_index: idx, summary_index: 0,
      part: { type: 'summary_text', text },
    });
    item.summary = [{ type: 'summary_text', text }];
    item.status = 'completed';
    this.send('response.output_item.done', { output_index: idx, item });
    this.reasoningItem = null;
  }

  flushText() {
    if (this.textBuffer) {
      this.emitText(this.textBuffer);
      this.textBuffer = '';
    }
  }

  parseInlineTools() {
    const raw = this.inlineToolText || '';
    this.inlineToolText = null;
    const parts = raw.split(INLINE_MARKER)
      .map(s => s.replace(/^\]/, '').trim())
      .filter(Boolean);
    const calls = [];
    let current = null;
    for (const part of parts) {
      const inv = /^<invoke\s+name="([^"]+)">/i.exec(part);
      if (inv) {
        current = { name: inv[1], params: {} };
        calls.push(current);
        continue;
      }
      const prm = /^<([a-zA-Z_][\w-]*)>([\s\S]*)$/.exec(part);
      if (prm && current) current.params[prm[1]] = coerceValue(prm[2]);
    }
    return calls;
  }

  emitInlineTools(calls) {
    for (const call of calls) {
      const isCustom = this.customNames && this.customNames.has(call.name);
      this.startTool('call_' + Math.random().toString(36).slice(2, 12), call.name, isCustom);
      if (isCustom) {
        const first = Object.values(call.params)[0];
        this.toolDelta(typeof first === 'string' ? first : JSON.stringify(call.params));
      } else {
        this.toolDelta(JSON.stringify(call.params));
      }
      this.finishTool();
    }
  }

  startTool(callId, name, isCustom) {
    this.finishTool();
    const item = isCustom
      ? { type: 'custom_tool_call', id: 'ctc_' + Math.random().toString(36).slice(2, 16), call_id: callId, name, input: '' }
      : { type: 'function_call', id: 'fc_' + Math.random().toString(36).slice(2, 16), call_id: callId, name, arguments: '', status: 'in_progress' };
    const outputIndex = this.output.length;
    this.output.push(item);
    this.tool = { item, isCustom, buffer: '', outputIndex };
    (this.toolCallIds = this.toolCallIds || []).push(callId);
    rememberReasoning(callId, this.reasoningText);
    if (cfg.debugDump) log({ t: new Date().toISOString(), debug: 'tool-start', callId, reasoningLen: this.reasoningText.length });
    this.send('response.output_item.added', { output_index: outputIndex, item });
  }

  toolDelta(text) {
    if (!this.tool || !text) return;
    this.tool.buffer += text;
  }

  finishTool() {
    if (!this.tool) return;
    const { item, isCustom, buffer, outputIndex } = this.tool;
    if (isCustom) {
      item.input = buffer;
      this.send('response.custom_tool_call_input.delta', { item_id: item.id, output_index: outputIndex, delta: buffer });
      this.send('response.custom_tool_call_input.done', { item_id: item.id, output_index: outputIndex, input: buffer });
    } else {
      item.arguments = buffer;
      this.send('response.function_call_arguments.delta', { item_id: item.id, output_index: outputIndex, delta: buffer });
      this.send('response.function_call_arguments.done', { item_id: item.id, output_index: outputIndex, arguments: buffer });
    }
    item.status = 'completed';
    this.send('response.output_item.done', { output_index: outputIndex, item });
    this.tool = null;
  }

  finishText() {
    if (!this.text) return;
    const { item } = this.text;
    const idx = this.output.indexOf(item);
    const text = item.__text || '';
    this.send('response.output_text.done', { item_id: item.id, output_index: idx, content_index: 0, text });
    this.send('response.content_part.done', {
      item_id: item.id, output_index: idx, content_index: 0,
      part: { type: 'output_text', text, annotations: [] },
    });
    item.status = 'completed';
    item.content = [{ type: 'output_text', text, annotations: [] }];
    delete item.__text;
    this.send('response.output_item.done', { output_index: idx, item });
    this.text = null;
  }

  finish(status = 'completed', error = null) {
    if (this.toolCallIds && this.toolCallIds.length) {
      for (const id of this.toolCallIds) rememberReasoning(id, this.reasoningText);
      if (cfg.debugDump) log({ t: new Date().toISOString(), debug: 'stream-end', calls: this.toolCallIds.length, reasoningLen: this.reasoningText.length });
    }
    this.finishTool();
    if (!error && this.inlineToolText !== null) {
      const calls = this.parseInlineTools();
      if (calls.length) this.emitInlineTools(calls);
      else if (this.inlineToolText) this.emitText(this.inlineToolText.replaceAll(INLINE_MARKER, ''));
      this.inlineToolText = null;
    }
    this.flushText();
    this.finishText();
    this.finishReasoning();
    const resp = this.skeleton(status);
    resp.output = this.output.map(i => { const c = Object.assign({}, i); delete c.__text; return c; });
    resp.completed_at = Math.floor(Date.now() / 1000);
    if (this.usage) resp.usage = this.usage;
    if (error) resp.error = error;
    this.send(status === 'completed' ? 'response.completed' : 'response.failed', { response: resp });
    this.res.end();
  }
}

function estimateTokens(obj, model) {
  return Math.ceil(JSON.stringify(obj).length / charsPerToken(model));
}

function trimToEstimate(req, targetTokens, model) {
  const systems = req.messages.filter(m => m.role === 'system');
  const rest = req.messages.filter(m => m.role !== 'system');
  const target = Math.max(1500, Math.floor(targetTokens));
  let guard = 0;
  while (rest.length > 1 && guard++ < 500) {
    const candidate = Object.assign({}, req, { messages: systems.concat(rest) });
    if (estimateTokens(candidate, model) <= target) break;
    rest.shift();
  }
  return Object.assign({}, req, { messages: systems.concat(rest) });
}

function chatStream(body, res, providerId) {
  const prov = cfg.providers[providerId];
  const { key, source } = providerKey(providerId);
  const started = Date.now();
  const model = body.model;

  if (!key) {
    return sendJson(res, 500, {
      error: { message: `codex-router: no API key for ${providerId}; run: codex-router.ps1 key -Provider ${providerId}` },
    });
  }

  const { req, customNames, upstreamModel } = toChatRequest(body, prov);
  const em = new Emitter(res, model);
  em.customNames = customNames;

  const base = new URL(prov.baseUrl);
  const lib = base.protocol === 'https:' ? https : http;
  let attempt = 0;
  let outbound = req;

  // Провайдер сообщает точный размер контекста в usage прошлого ответа.
  // Если история выросла, проецируем размер и режем заранее, не дожидаясь 400.
  const limit = Number(prov.contextLimit || 1048576);
  const stat = usageStats[model];
  if (stat && stat.lastPromptTokens > 0 && stat.lastChars > 0) {
    const chars = JSON.stringify(req).length;
    const projected = Math.round(stat.lastPromptTokens * (chars / stat.lastChars));
    if (projected > limit * 0.9) {
      const targetChars = Math.floor(stat.lastChars * ((limit * 0.75) / stat.lastPromptTokens));
      const systems = req.messages.filter(m => m.role === 'system');
      const rest = req.messages.filter(m => m.role !== 'system');
      let guard = 0;
      while (rest.length > 1 && guard++ < 500) {
        const candidate = Object.assign({}, req, { messages: systems.concat(rest) });
        if (JSON.stringify(candidate).length <= targetChars) break;
        rest.shift();
      }
      const trimmed = Object.assign({}, req, { messages: systems.concat(rest) });
      log({
        t: new Date().toISOString(), model, upstream: upstreamModel, target: providerId,
        status: 0, proactiveTrim: true, limitTokens: limit,
        lastPromptTokens: stat.lastPromptTokens, projectedTokens: projected,
        messagesBefore: req.messages.length, messagesAfter: trimmed.messages.length,
      });
      outbound = trimmed;
    }
  }

  const attemptSend = (reqBody) => {
    const payload = Buffer.from(JSON.stringify(reqBody));
    if (process.env.ROUTER_DUMP || cfg.debugDump) {
      try {
        fs.mkdirSync(LOG_DIR, { recursive: true });
        fs.writeFileSync(path.join(LOG_DIR, 'last-upstream.json'), JSON.stringify(reqBody));
      } catch {}
    }

    const up = lib.request({
      hostname: base.hostname,
      port: base.port || (base.protocol === 'https:' ? 443 : 80),
      path: prov.chatPath || '/v1/chat/completions',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
        'content-length': payload.length,
        accept: 'text/event-stream',
      },
    }, r => {
      if (r.statusCode !== 200) {
        const chunks = [];
        r.on('data', c => chunks.push(c));
        r.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8').slice(0, 2000);
          const ctx = /maximum context length is (\d+) tokens/i.exec(text) || /context length is (\d+)/i.exec(text);
          const asked = /you requested (\d+) tokens/i.exec(text);
          if (r.statusCode === 400 && ctx && attempt < 3) {
            attempt++;
            const limit = Number(ctx[1]) || 1000000;
            const requested = asked ? Number(asked[1]) : null;
            const chars = JSON.stringify(reqBody).length;
            if (requested) observeTokens(model, chars, requested);
            const currentEstimate = estimateTokens(reqBody, model);
            // во сколько раз реальный запрос больше лимита — во столько же режем нашу оценку
            const ratio = requested && requested > 0 ? (limit * 0.8) / requested : (limit * 0.8) / currentEstimate;
            const target = Math.floor(currentEstimate * Math.min(ratio, 0.9));
            const trimmed = trimToEstimate(reqBody, target, model);
            log({
              t: new Date().toISOString(), model, upstream: upstreamModel, target: providerId,
              status: 400, contextTrim: true, attempt,
              requestedTokens: requested, limitTokens: limit,
              messagesBefore: reqBody.messages.length, messagesAfter: trimmed.messages.length,
              estimatedBefore: currentEstimate, estimatedAfter: estimateTokens(trimmed, model), charsPerToken: Number(charsPerToken(model).toFixed(3)), ms: Date.now() - started,
            });
            attemptSend(trimmed);
            return;
          }
          log({ t: new Date().toISOString(), model, upstream: upstreamModel, target: providerId, keySource: source, status: r.statusCode, ms: Date.now() - started, error: text.slice(0, 200) });
          let parsed = null;
          try { parsed = JSON.parse(text); } catch {}
          sendJson(res, r.statusCode, parsed || { error: { message: String(text || ('upstream HTTP ' + r.statusCode)) } });
        });
        return;
      }

      em.start();
      let buffer = '';
      r.setEncoding('utf8');
      r.on('data', chunk => {
        buffer += chunk;
        const parts = buffer.split('\n');
        buffer = parts.pop() || '';
        for (const line of parts) {
          const s = line.trim();
          if (!s.startsWith('data:')) continue;
          const data = s.slice(5).trim();
          if (data === '[DONE]') continue;
          let obj;
          try { obj = JSON.parse(data); } catch { continue; }
          if (obj.usage && obj.usage.prompt_tokens) {
            observeTokens(model, JSON.stringify(reqBody).length, obj.usage.prompt_tokens);
            recordUsage(model, { input_tokens: obj.usage.prompt_tokens, output_tokens: obj.usage.completion_tokens || 0 }, JSON.stringify(reqBody).length);
          }
          if (obj.usage) {
            em.usage = {
              input_tokens: obj.usage.prompt_tokens ?? 0,
              output_tokens: obj.usage.completion_tokens ?? 0,
              total_tokens: obj.usage.total_tokens ?? 0,
            };
          }
          const choice = obj.choices && obj.choices[0];
          if (!choice) continue;
          const d = choice.delta || {};
          if (d.reasoning_content) { em.reasoningText += d.reasoning_content; em.reasoningDelta(d.reasoning_content); }
          if (d.content) em.textDelta(d.content);
          if (Array.isArray(d.tool_calls)) {
            for (const tc of d.tool_calls) {
              if (tc.function?.name) {
                em.startTool(tc.id || 'call_' + Math.random().toString(36).slice(2, 10), tc.function.name, customNames.has(tc.function.name));
              }
              if (tc.function?.arguments) em.toolDelta(tc.function.arguments);
            }
          }
        }
      });
      r.on('end', () => {
        log({ t: new Date().toISOString(), model, upstream: upstreamModel, target: providerId, keySource: source, reasoning: reqBody.thinking || reqBody.reasoning_effort || null, status: 200, ms: Date.now() - started, items: em.output.length, trimmed: attempt > 0 });
        em.finish('completed');
      });
      r.on('error', e => {
        log({ t: new Date().toISOString(), model, upstream: upstreamModel, target: providerId, status: 0, ms: Date.now() - started, error: e.message });
        em.finish('failed', { code: 'stream_error', message: e.message });
      });
    });

    up.on('error', e => {
      log({ t: new Date().toISOString(), model, upstream: upstreamModel, target: providerId, status: 0, ms: Date.now() - started, error: e.message });
      if (res.headersSent) em.finish('failed', { code: 'upstream_error', message: e.message });
      else sendJson(res, 502, { error: { message: e.message } });
    });

    up.end(payload);
  };

  attemptSend(outbound);
}

// ---------- проброс в OpenAI ----------

function proxyOpenAI(res, urlPath, headers, payload, meta) {
  const started = Date.now();
  const rel = urlPath.replace(/^\/v1(?=\/|$)/, '') || '/';
  const finalPath = cfg.openai.prefix + (rel === '/' ? '' : rel);
  const h = Object.assign({}, headers);
  delete h.host; delete h['content-length']; delete h['transfer-encoding'];
  if (payload.length) h['content-length'] = payload.length;

  const base = new URL(cfg.openai.baseUrl);
  const lib = base.protocol === 'https:' ? https : http;
  const up = lib.request({
    hostname: base.hostname,
    port: base.port || (base.protocol === 'https:' ? 443 : 80),
    path: finalPath,
    method: 'POST',
    headers: h,
  }, r => {
    const limited = [429, 402, 403].includes(r.statusCode);
    if (limited && meta.fallbackBody) {
      const chunks = [];
      r.on('data', c => chunks.push(c));
      r.on('end', () => {
        log(Object.assign(meta, { target: 'openai', path: finalPath, status: r.statusCode, ms: Date.now() - started, fallback: 'deepseek' }));
        const fb = Object.assign({}, meta.fallbackBody, { model: cfg.providers.deepseek.fallbackModel });
        chatStream(fb, res, 'deepseek');
      });
      return;
    }
    res.writeHead(r.statusCode, r.headers);
    if (res.flushHeaders) res.flushHeaders();
    r.pipe(res);
    r.on('end', () => log(Object.assign(meta, { target: 'openai', path: finalPath, status: r.statusCode, ms: Date.now() - started })));
  });
  up.on('error', e => {
    log(Object.assign(meta, { target: 'openai', path: finalPath, status: 0, error: e.message, ms: Date.now() - started }));
    if (!res.headersSent) sendJson(res, 502, { error: { message: e.message } });
    else res.end();
  });
  up.end(payload.length ? payload : undefined);
}

// ---------- сервер ----------

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');

  if (url.pathname === '/health') {
    const providers = {};
    for (const [id, p] of Object.entries(cfg.providers)) {
      const { key, source } = providerKey(id);
      providers[id] = {
        base: p.baseUrl,
        key: key ? 'present' : 'missing',
        keySource: source,
        reasoning: p.reasoning,
        fallbackModel: p.fallbackModel,
        models: p.modelMap,
      };
    }
    return sendJson(res, 200, {
      ok: true, name: 'codex-router', version: ROUTER_VERSION, platform: process.platform, tokenizer: tokenCalibration, usage: usageStats, secrets: { file: VAULT_PATH, kind: IS_WIN ? 'dpapi' : 'file-0600' }, port: cfg.port, providers,
      openai: { base: cfg.openai.baseUrl + cfg.openai.prefix, auth: 'chatgpt passthrough' },
    });
  }
  if (url.pathname === '/router/log') {
    return sendJson(res, 200, { routes: readLog(Math.min(Number(url.searchParams.get('limit') || 50), 500)) });
  }
  if (url.pathname === '/v1/models') {
    const data = [];
    for (const [id, p] of Object.entries(cfg.providers)) {
      for (const alias of Object.keys(p.modelMap || {})) data.push({ id: alias, object: 'model', owned_by: id });
    }
    return sendJson(res, 200, { object: 'list', data });
  }

  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('error', () => {});
  req.on('end', () => {
    const payload = Buffer.concat(chunks);
    if (cfg.debugDump) {
      try {
        fs.mkdirSync(LOG_DIR, { recursive: true });
        fs.writeFileSync(path.join(LOG_DIR, 'last-request.json'), payload.toString('utf8'));
        log({ t: new Date().toISOString(), debug: 'request-dumped' });
      } catch (e) { if (cfg.debugDump) log({ t: new Date().toISOString(), debug: 'dump-in-failed', error: e.message }); }
    }
    let body = null;
    if (payload.length && /json/.test(req.headers['content-type'] || '')) {
      try { body = JSON.parse(payload.toString('utf8')); } catch {}
    }
    if (!body) return sendJson(res, 400, { error: { message: 'codex-router: expected JSON body' } });

    const model = body.model;
    const hit = providerFor(model);
    if (hit) return chatStream(body, res, hit.id);

    const meta = { t: new Date().toISOString(), model, auth: req.headers.authorization ? 'bearer' : 'none', fallbackBody: body };
    return proxyOpenAI(res, url.pathname, req.headers, payload, meta);
  });
}).listen(cfg.port, '127.0.0.1', () => {
  console.log(`codex-router :${cfg.port} providers=${Object.keys(cfg.providers).join(',')} openai=${cfg.openai.baseUrl}${cfg.openai.prefix}`);
});
