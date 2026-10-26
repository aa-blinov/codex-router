// Патч: DeepSeek в thinking-режиме требует возвращать reasoning_content
// в assistant-сообщениях с tool_calls. Запоминаем reasoning по call_id
// и подмешиваем его при сборке истории.
import fs from 'node:fs';

const p = process.argv[2];
let src = fs.readFileSync(p, 'utf8');

function once(from, to, label) {
  const i = src.indexOf(from);
  if (i < 0) throw new Error('anchor not found: ' + label);
  src = src.slice(0, i) + to + src.slice(i + from.length);
}

// 1. хранилище reasoning по call_id
once(
  "const INLINE_MARKER = '<]minimax[>[';",
  `const INLINE_MARKER = '<]minimax[>[';
const reasoningByCall = new Map();
const REASONING_LIMIT = 500;

function rememberReasoning(callId, text) {
  if (!callId || !text) return;
  reasoningByCall.set(callId, text);
  if (reasoningByCall.size > REASONING_LIMIT) {
    const oldest = reasoningByCall.keys().next().value;
    reasoningByCall.delete(oldest);
  }
}`,
  'reasoning map'
);

// 2. поле в эмиттере
once(
  "    this.textBuffer = '';",
  "    this.textBuffer = '';\n    this.reasoningText = '';",
  'emitter field'
);

// 3. запоминать reasoning при старте инструмента
once(
  "    this.tool = { item, isCustom, buffer: '', outputIndex };",
  "    this.tool = { item, isCustom, buffer: '', outputIndex };\n    rememberReasoning(callId, this.reasoningText);",
  'startTool'
);

// 4. копить reasoning из дельт провайдера
once(
  "        if (d.content) em.textDelta(d.content);",
  "        if (d.reasoning_content) em.reasoningText += d.reasoning_content;\n        if (d.content) em.textDelta(d.content);",
  'delta reasoning'
);

// 5. подмешивать reasoning в assistant-сообщения с tool_calls
once(
  `      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: [{ id: callId, type: 'function', function: { name: item.name, arguments: args } }],
      });`,
  `      const assistantMsg = {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: callId, type: 'function', function: { name: item.name, arguments: args } }],
      };
      const reasoning = reasoningByCall.get(callId);
      if (reasoning) assistantMsg.reasoning_content = reasoning;
      messages.push(assistantMsg);`,
  'history reasoning'
);

fs.writeFileSync(p, src, 'utf8');
console.log('патч reasoning применён');
