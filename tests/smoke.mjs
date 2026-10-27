// Дымовой тест Codex Router без сети и без ключей.
// Поднимает фальшивый Chat-Completions сервер, копирует мост во временную папку
// и проверяет трансляцию, маршрутизацию и уровни reasoning.
//
// Использует node:http (а не global fetch), чтобы одинаково работать в Windows,
// WSL и CI: в WSL fetch изредка зависает на keep-alive соединениях.
//
// Запуск: node tests/smoke.mjs
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SRC = path.join(ROOT, 'src', 'codex-router.mjs');
const DEBUG = Boolean(process.env.SMOKE_DEBUG);

let failures = 0;

function stage(name) {
  if (DEBUG) console.error(`stage: ${name}`);
}

function check(name, cond, extra = '') {
  if (cond) {
    console.log(`ok   ${name}`);
  } else {
    failures++;
    console.log(`FAIL ${name}${extra ? ' — ' + extra : ''}`);
  }
}

function request(url, { method = 'GET', body = null, headers = {}, timeout = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method,
      headers: body ? Object.assign({ 'content-type': 'application/json' }, headers) : headers,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.setTimeout(timeout, () => req.destroy(new Error(`timeout ${url}`)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function sse(res, chunks) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

function chunk(delta, finish = null) {
  return { id: 'x', object: 'chat.completion.chunk', created: 1, model: 'fake', choices: [{ index: 0, delta, finish_reason: finish }] };
}

// ---------- фальшивый провайдер ----------

const upstream = { mode: 'text', bodies: [], toolName: 'exec', calls: 0 };

const fake = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = null;
    try { body = JSON.parse(raw); } catch {}
    upstream.bodies.push({ path: req.url, body });

    if (!req.url.includes('/chat/completions')) {
      res.writeHead(429, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'usage limit reached' } }));
    }

    if (upstream.mode === 'context') {
      upstream.calls++;
      if (upstream.calls === 1) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'This model\'s maximum context length is 1000 tokens. However, you requested 5000 tokens.' } }));
      }
      return sse(res, [chunk({ role: 'assistant', content: '' }), chunk({ content: 'trimmed' }), chunk({}, 'stop')]);
    }

    if (upstream.mode === 'inline') {
      const text = '<]minimax[>[<invoke name="exec_command">]<]minimax[>[<cmd>git status]<]minimax[>[<workdir>/tmp/work]<]minimax[>[<yield_time_ms>120000]';
      return sse(res, [
        chunk({ role: 'assistant', content: '' }),
        chunk({ content: text }),
        chunk({}, 'stop'),
      ]);
    }

    if (upstream.mode === 'tool') {
      return sse(res, [
        chunk({ role: 'assistant', content: '' }),
        chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: upstream.toolName, arguments: '{"cmd":"echo hi"}' } }] }),
        chunk({}, 'tool_calls'),
      ]);
    }

    sse(res, [
      chunk({ role: 'assistant', content: '' }),
      chunk({ content: 'hello' }),
      chunk({}, 'stop'),
      { id: 'x', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
    ]);
  });
});

// ---------- запуск ----------

async function main() {
  stage('start');
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  const upstreamPort = fake.address().port;
  stage(`fake-up ${upstreamPort}`);
  const routerPort = await freePort();

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-router-test-'));
  fs.copyFileSync(SRC, path.join(dir, 'codex-router.mjs'));
  fs.writeFileSync(path.join(dir, 'codex-router.config.json'), JSON.stringify({
    port: routerPort,
    openai: { baseUrl: `http://127.0.0.1:${upstreamPort}`, prefix: '' },
    providers: {
      deepseek: { baseUrl: `http://127.0.0.1:${upstreamPort}` },
      minimax: { baseUrl: `http://127.0.0.1:${upstreamPort}` },
    },
  }));

  const child = spawn(process.execPath, [path.join(dir, 'codex-router.mjs')], {
    cwd: dir,
    env: Object.assign({}, process.env, {
      DEEPSEEK_API_KEY: 'test-deepseek-key-000000',
      MINIMAX_API_KEY: 'test-minimax-key-000000',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  stage(`spawned ${child.pid}`);
  let stderr = '';
  child.stderr.on('data', d => { stderr += d.toString(); });
  if (DEBUG) child.stdout.on('data', d => process.stderr.write(String(d)));

  const base = `http://127.0.0.1:${routerPort}`;
  stage(`polling ${base}`);
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    try {
      const r = await request(`${base}/health`, { timeout: 1000 });
      if (r.status === 200) ready = true;
    } catch { /* ещё не поднялся */ }
    if (!ready) await new Promise(r => setTimeout(r, 100));
  }
  if (!ready) throw new Error('мост не поднялся за 6 секунд');

  const post = body => request(`${base}/v1/responses`, { method: 'POST', body: JSON.stringify(body) });
  const msg = text => [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }];

  stage('healthy');
  try {
    const health = JSON.parse((await request(`${base}/health`)).text);
    check('health отвечает', health.ok === true);
    check('ключи из окружения', health.providers.deepseek.keySource === 'env' && health.providers.minimax.keySource === 'env');

    // 1. обычный ответ DeepSeek
    upstream.mode = 'text';
    upstream.bodies = [];
    let r = await post({ model: 'deepseek-v4.1-flash', stream: true, input: msg('hi'), reasoning: { effort: 'xhigh' } });
    check('deepseek: response.completed', r.text.includes('event: response.completed'));
    check('deepseek: текст ответа', r.text.includes('"delta":"hello"'));
    check('deepseek: thinking enabled при xhigh', upstream.bodies[0].body.thinking?.type === 'enabled', JSON.stringify(upstream.bodies[0].body.thinking));

    // 2. effort none → thinking disabled
    upstream.bodies = [];
    await post({ model: 'deepseek-v4.1-flash', stream: true, input: msg('hi'), reasoning: { effort: 'none' } });
    check('deepseek: thinking disabled при none', upstream.bodies[0].body.thinking?.type === 'disabled');

    // 3. вызов function-инструмента
    upstream.mode = 'tool';
    r = await post({
      model: 'deepseek-v4.1-flash', stream: true, input: msg('run'),
      tools: [{ type: 'function', name: 'exec', description: 'shell', parameters: { type: 'object', properties: {} } }],
      tool_choice: 'auto',
    });
    check('инструмент: function_call_item', r.text.includes('"type":"function_call"'));
    check('инструмент: аргументы', r.text.includes('response.function_call_arguments.done'));

    // 4. custom-инструмент
    upstream.toolName = 'apply_patch';
    r = await post({
      model: 'deepseek-v4.1-flash', stream: true, input: msg('patch'),
      tools: [{ type: 'custom', name: 'apply_patch', description: 'freeform' }],
    });
    check('custom-инструмент', r.text.includes('response.custom_tool_call_input.done'));
    upstream.toolName = 'exec';

    // 5. MiniMax: none → low, max → max
    upstream.mode = 'text';
    upstream.bodies = [];
    await post({ model: 'minimax-m3.1-flash', stream: true, input: msg('hi'), reasoning: { effort: 'none' } });
    check('minimax 3.1: none → low', upstream.bodies[0].body.reasoning_effort === 'low', String(upstream.bodies[0].body.reasoning_effort));
    upstream.bodies = [];
    await post({ model: 'minimax-m3.1-flash', stream: true, input: msg('hi'), reasoning: { effort: 'max' } });
    check('minimax 3.1: max → max', upstream.bodies[0].body.reasoning_effort === 'max');

    // 6. MiniMax-M3: none → thinking disabled, high → effort + split
    upstream.bodies = [];
    await post({ model: 'minimax-m3', stream: true, input: msg('hi'), reasoning: { effort: 'none' } });
    check('minimax m3: none → thinking disabled', upstream.bodies[0].body.thinking?.type === 'disabled');
    upstream.bodies = [];
    await post({ model: 'minimax-m3', stream: true, input: msg('hi'), reasoning: { effort: 'high' } });
    const m3 = upstream.bodies[0].body;
    check('minimax m3: high → reasoning_effort', m3.reasoning_effort === 'high');
    check('minimax m3: high → reasoning_split', m3.reasoning_split === true);

    // 6b. inline-вызовы MiniMax превращаются в function_call
    upstream.mode = 'inline';
    const inline = await post({
      model: 'minimax-m3.1-flash', stream: true, input: msg('run'),
      tools: [{ type: 'function', name: 'exec_command', description: 'shell', parameters: { type: 'object', properties: {} } }],
      tool_choice: 'auto',
    });
    check('inline: вызов разобран', inline.text.includes('"name":"exec_command"'), inline.text.slice(0, 200));
    check('inline: аргументы собраны', inline.text.includes('git status'));
    check('inline: маркер не утёк в текст', !inline.text.includes('minimax['));

    // 6c. переполнение контекста: мост обрезает историю и повторяет запрос
    upstream.mode = 'context';
    upstream.calls = 0;
    const filler = 'x'.repeat(400);
    const longInput = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: filler }] }];
    for (let i = 0; i < 8; i++) longInput.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: filler }] });
    longInput.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] });
    const trimmed = await post({ model: 'deepseek-v4.1-flash', stream: true, input: longInput });
    check('контекст: повтор после обрезки', trimmed.text.includes('"delta":"trimmed"'), trimmed.text.slice(0, 160));
    check('контекст: два обращения к провайдеру', upstream.calls === 2, String(upstream.calls));
    const trimLog = (await request(`${base}/router/log?limit=10`)).text;
    check('контекст: запись contextTrim', trimLog.includes('"contextTrim":true'));

    // 7. 429 от OpenAI → переход в DeepSeek
    upstream.mode = 'text';
    const limited = await post({ model: 'gpt-test', stream: true, input: msg('hi') });
    check('429 от OpenAI → ответ пришёл', limited.text.includes('"delta":"hello"'), `status ${limited.status}: ${limited.text.slice(0, 200)}`);
    const log = (await request(`${base}/router/log?limit=10`)).text;
    check('429 → лог с fallback', log.includes('"fallback":"deepseek"'));
  } finally {
    child.kill();
    fake.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    if (stderr.trim()) console.log('\nstderr моста:\n' + stderr.trim());
  }

  console.log('');
  if (failures) {
    console.log(`Провалов: ${failures}`);
    process.exit(1);
  }
  console.log('Все проверки прошли.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
