#!/usr/bin/env node
// Собирает однофайловую версию приложения, как на appkp.cc: все js/*.js и
// application.js склеиваются в один файл, который оболочка (MicroIPTV)
// загружает одним запросом. Порядок модулей тот же, что в application.js.
//
//   node tools/build.js            -> dist/application.js, dist/bundle.js, dist/img/
//
// Без сборки приложение тоже работает: application.js из корня репозитория сам
// подгружает js/*.js. Сборка нужна только ради скорости старта.

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');

const bootstrap = fs.readFileSync(path.join(root, 'application.js'), 'utf8');

// Список модулей берём прямо из application.js, чтобы не разъезжаться с ним
const listMatch = bootstrap.match(/const javascriptFiles = \[([\s\S]*?)\]\.map/);
if (!listMatch) {
  console.error('Не нашёл список модулей javascriptFiles в application.js');
  process.exit(1);
}
const modules = [...listMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);

const version = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
const parts = [
  `/* atv4 ${version} (fork) — однофайловая сборка от ${new Date().toISOString()} */`,
  'var __ATV4_BUNDLED__ = true;',
];
for (const name of modules) {
  const file = path.join(root, 'js', name + '.js');
  parts.push(`\n// ===== js/${name}.js =====\n` + fs.readFileSync(file, 'utf8'));
}
parts.push('\n// ===== application.js =====\n' + bootstrap);
const bundle = parts.join('\n');

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });
for (const out of ['application.js', 'bundle.js']) {
  fs.writeFileSync(path.join(dist, out), bundle);
}
fs.cpSync(path.join(root, 'img'), path.join(dist, 'img'), { recursive: true });
// Приложение читает их с baseURL в рантайме (экран «О приложении», проверка версии)
for (const name of ['VERSION', 'CHANGELOG']) {
  fs.copyFileSync(path.join(root, name), path.join(dist, name));
}
fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>atv4</title><h1>atv4</h1>\n');

console.log(`dist/application.js: ${modules.length} модулей, ${(bundle.length / 1024).toFixed(0)} КБ`);
