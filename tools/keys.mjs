// Управление файлом ключей на Linux/macOS (на Windows ключи лежат в DPAPI-хранилище).
// Кроссплатформенный, без зависимостей.
//
//   node tools/keys.mjs list --file ~/.codex/codex-router/keys.json
//   node tools/keys.mjs set  --file <path> --provider minimax --key sk-...
//   node tools/keys.mjs get  --file <path> --provider deepseek
import fs from 'node:fs';
import path from 'node:path';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const cmd = process.argv[2];
const file = arg('file', path.join(process.env.HOME || '.', '.codex', 'codex-router', 'keys.json'));
const provider = arg('provider');
const key = arg('key');

function read() {
  if (!fs.existsSync(file)) return {};
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { return {}; }
}

function write(map) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(map, null, 2) + '\n', { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
}

function mask(k) {
  return k.length < 12 ? '***' : k.slice(0, 5) + '********' + k.slice(-4);
}

switch (cmd) {
  case 'list': {
    const map = read();
    const names = Object.keys(map);
    if (!names.length) { console.log('хранилище пустое'); break; }
    for (const n of names) console.log(`${n}: ${mask(map[n])}`);
    break;
  }
  case 'set': {
    if (!provider || !key) { console.error('нужны --provider и --key'); process.exit(1); }
    if (key.length < 16) { console.error('ключ подозрительно короткий'); process.exit(1); }
    const map = read();
    map[provider] = key.trim();
    write(map);
    console.log(`ключ ${provider} сохранён в ${file}`);
    break;
  }
  case 'get': {
    if (!provider) { console.error('нужен --provider'); process.exit(1); }
    const v = read()[provider];
    if (!v) { console.error(`нет ключа для ${provider}`); process.exit(1); }
    process.stdout.write(v);
    break;
  }
  default:
    console.error('использование: keys.mjs <list|set|get> --file <path> [--provider X] [--key Y]');
    process.exit(1);
}
