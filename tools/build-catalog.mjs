// Собирает каталог моделей Codex: модели аккаунта OpenAI из models_cache.json
// плюс записи провайдеров моста из шаблона. Кроссплатформенный, без зависимостей.
//
// Использование:
//   node tools/build-catalog.mjs --codex-home <dir> --template <file> --out <file>
import fs from 'node:fs';
import path from 'node:path';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const codexHome = arg('codex-home', path.join(process.env.HOME || process.env.USERPROFILE || '.', '.codex'));
const templatePath = arg('template', null);
const outPath = arg('out', path.join(codexHome, 'models.mixed.json'));

if (!templatePath || !fs.existsSync(templatePath)) {
  console.error(`шаблон модели не найден: ${templatePath}`);
  process.exit(1);
}

const template = JSON.parse(fs.readFileSync(templatePath, 'utf8'));

function modelEntry({ alias, display, description, levels, priority, isDefault, contextWindow }) {
  const e = JSON.parse(JSON.stringify(template));
  e.model = alias;
  e.slug = alias;
  e.id = alias;
  e.display_name = display;
  e.displayName = display;
  e.description = description;
  e.priority = priority;
  e.isDefault = isDefault;
  const defaultLevel = levels.includes('xhigh') ? 'xhigh' : levels[0];
  e.default_reasoning_level = defaultLevel;
  e.defaultReasoningEffort = defaultLevel;
  e.supported_reasoning_levels = levels.map(l => ({ effort: l, description: `Reasoning effort: ${l}` }));
  e.supportedReasoningEfforts = levels.map(l => ({ reasoningEffort: l, description: `Reasoning effort: ${l}` }));
  e.input_modalities = ['text', 'image'];
  e.inputModalities = ['text', 'image'];
  if (contextWindow) {
    e.context_window = contextWindow;
    e.max_context_window = contextWindow;
  }
  return e;
}

const models = [];

const cachePath = path.join(codexHome, 'models_cache.json');
if (fs.existsSync(cachePath)) {
  try {
    const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    let i = 0;
    for (const m of cache.models || []) {
      i++;
      m.model = m.slug;
      m.isDefault = false;
      if (!m.priority) m.priority = i;
      models.push(m);
    }
  } catch (e) {
    console.error(`models_cache.json не прочитан: ${e.message}`);
  }
}

models.push(modelEntry({
  alias: 'deepseek-v4.1-flash',
  display: 'DeepSeek-V4.1-Flash',
  description: 'DeepSeek via Codex Router (api.deepseek.com).',
  levels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
  priority: 100,
  isDefault: true,
}));

models.push(modelEntry({
  alias: 'minimax-m3.1-flash',
  display: 'MiniMax-M3.1-Flash',
  description: 'MiniMax M3.1 Flash via Codex Router (api.minimax.io). Adaptive thinking.',
  levels: ['low', 'medium', 'high', 'xhigh', 'max'],
  priority: 200,
  isDefault: false,
  contextWindow: 1000000,
}));

models.push(modelEntry({
  alias: 'minimax-m3',
  display: 'MiniMax-M3',
  description: 'MiniMax M3 via Codex Router.',
  levels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
  priority: 201,
  isDefault: false,
  contextWindow: 1000000,
}));

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify({ models }, null, 2) + '\n', 'utf8');
console.log(`каталог: ${outPath} (${models.length} моделей)`);
