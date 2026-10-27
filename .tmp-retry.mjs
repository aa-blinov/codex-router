import fs from 'node:fs';

const p = 'src/codex-router.mjs';
let src = fs.readFileSync(p, 'utf8');

const start = src.indexOf('function chatStream(body, res, providerId) {');
const end = src.indexOf('// ---------- проброс в OpenAI ----------');
if (start < 0 || end < 0) throw new Error('anchors not found');

const replacement = `function estimateTokens(obj) {
  return Math.ceil(JSON.stringify(obj).length / 3.2);
}

function trimForLimit(req, limitTokens) {
  const systems = req.messages.filter(m => m.role === 'system');
  const rest = req.messages.filter(m => m.role !== 'system');
  const target = Math.floor(limitTokens * 0.85);
  let guard = 0;
  while (rest.length > 2 && guard++ < 500) {
    const candidate = Object.assign({}, req, { messages: systems.concat(rest) });
    if (estimateTokens(candidate) <= target) break;
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
      error: { message: \`codex-router: no API key for \${providerId}; run: codex-router.ps1 key -Provider \${providerId}\` },
    });
  }

  const { req, customNames, upstreamModel } = toChatRequest(body, prov);
  const em = new Emitter(res, model);
  em.customNames = customNames;

  const base = new URL(prov.baseUrl);
  const lib = base.protocol === 'https:' ? https : http;
  let attempt = 0;

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
        authorization: \`Bearer \${key}\`,
        'content-length': payload.length,
        accept: 'text/event-stream',
      },
    }, r => {
      if (r.statusCode !== 200) {
        const chunks = [];
        r.on('data', c => chunks.push(c));
        r.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8').slice(0, 2000);
          const ctx = /maximum context length is (\\d+) tokens/i.exec(text) || /context length is (\\d+)/i.exec(text);
          if (r.statusCode === 400 && ctx && attempt < 2) {
            attempt++;
            const limit = Number(ctx[1]) || 1000000;
            const trimmed = trimForLimit(reqBody, limit);
            log({
              t: new Date().toISOString(), model, upstream: upstreamModel, target: providerId,
              status: 400, contextTrim: true, attempt,
              messagesBefore: reqBody.messages.length, messagesAfter: trimmed.messages.length,
              estimatedTokens: estimateTokens(trimmed), ms: Date.now() - started,
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
        const parts = buffer.split('\\n');
        buffer = parts.pop() || '';
        for (const line of parts) {
          const s = line.trim();
          if (!s.startsWith('data:')) continue;
          const data = s.slice(5).trim();
          if (data === '[DONE]') continue;
          let obj;
          try { obj = JSON.parse(data); } catch { continue; }
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

  attemptSend(req);
}

`;

src = src.slice(0, start) + replacement + src.slice(end);
fs.writeFileSync(p, src, 'utf8');
console.log('chatStream заменён');
