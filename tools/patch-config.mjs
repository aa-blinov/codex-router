// Прописывает провайдера codex_router в config.toml Codex. Идемпотентно,
// с резервной копией. Кроссплатформенный, без зависимостей.
//
// Использование:
//   node tools/patch-config.mjs --config <config.toml> --catalog <models.json> [--port 8788]
import fs from 'node:fs';
import path from 'node:path';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const configPath = arg('config');
const catalogPath = arg('catalog');
const port = Number(arg('port', '8788'));

if (!configPath || !fs.existsSync(configPath)) {
  console.error(`config.toml не найден: ${configPath}`);
  process.exit(1);
}
if (!catalogPath) {
  console.error('не указан --catalog');
  process.exit(1);
}

let text = fs.readFileSync(configPath, 'utf8');

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
fs.copyFileSync(configPath, `${configPath}.${stamp}.bak`);

if (!text.includes('[model_providers.codex_router]')) {
  text = text.replace(/\s*$/, '') + `

# >>> codex-router: один провайдер, несколько бэкендов
[model_providers.codex_router]
name = "Codex Router (OpenAI + DeepSeek + MiniMax)"
base_url = "http://127.0.0.1:${port}/v1"
wire_api = "responses"
supports_websockets = false
requires_openai_auth = true
# <<< codex-router
`;
}

text = text.replace(/^model_provider\s*=\s*".*"$/m, 'model_provider = "codex_router"');

const tomlValue = catalogPath.replace(/\\/g, '\\\\');
if (/^model_catalog_json\s*=/m.test(text)) {
  text = text.replace(/^model_catalog_json\s*=\s*".*"$/m, `model_catalog_json = "${tomlValue}"`);
} else {
  text = text.replace(/^model_provider\s*=\s*".*"$/m, `model_provider = "codex_router"\nmodel_catalog_json = "${tomlValue}"`);
}

if (!/^model\s*=/m.test(text)) {
  text = `model = "deepseek-v4.1-flash"\n` + text;
}

fs.writeFileSync(configPath, text, 'utf8');
console.log(`config.toml: провайдер codex_router, каталог ${catalogPath}`);
