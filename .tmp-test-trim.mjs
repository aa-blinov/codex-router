import fs from 'node:fs';

const p = 'tests/smoke.mjs';
let t = fs.readFileSync(p, 'utf8');

// счётчик запросов в фальшивый провайдер
t = t.replace(
  "const upstream = { mode: 'text', bodies: [], toolName: 'exec' };",
  "const upstream = { mode: 'text', bodies: [], toolName: 'exec', calls: 0 };"
);

// режим context: первый запрос 400 про контекст, второй — обычный ответ
t = t.replace(
  "    if (upstream.mode === 'inline') {",
  `    if (upstream.mode === 'context') {
      upstream.calls++;
      if (upstream.calls === 1) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'This model\\'s maximum context length is 1000 tokens. However, you requested 5000 tokens.' } }));
      }
      return sse(res, [chunk({ role: 'assistant', content: '' }), chunk({ content: 'trimmed' }), chunk({}, 'stop')]);
    }

    if (upstream.mode === 'inline') {`
);

// сам тест перед проверкой 429
t = t.replace(
  "    // 7. 429 от OpenAI → переход в DeepSeek",
  `    // 6c. переполнение контекста: мост обрезает историю и повторяет запрос
    upstream.mode = 'context';
    upstream.calls = 0;
    const filler = 'x'.repeat(400);
    const longInput = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: filler }] }];
    for (let i = 0; i < 8; i++) longInput.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: filler }] });
    longInput.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] });
    const trimmed = await post({ model: 'deepseek-v4.1-flash', stream: true, input: longInput });
    check('контекст: повтор после обрезки', trimmed.text.includes('"delta":"trimmed"'), trimmed.text.slice(0, 160));
    check('контекст: два обращения к провайдеру', upstream.calls === 2, String(upstream.calls));
    const trimLog = (await request(\`\${base}/router/log?limit=10\`)).text;
    check('контекст: запись contextTrim', trimLog.includes('"contextTrim":true'));

    // 7. 429 от OpenAI → переход в DeepSeek`
);

fs.writeFileSync(p, t, 'utf8');
console.log('тест на обрезку добавлен');
