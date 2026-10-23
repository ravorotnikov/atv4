#!/usr/bin/env node
// Проверка фильтра "Год с" / "Год до" без Apple TV.
// Загружает настоящие js/utils.js, js/templates.js и js/kp.js в песочницу Node
// с заглушками TVJS-окружения и прогоняет выбор фильтров так, как это делает
// пульт: открыть выпадашку -> нажать кнопку -> посмотреть, что ушло в API.
//
//   node tools/test-year-range.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const root = path.join(__dirname, '..');
const thisYear = new Date().getFullYear();

// --- заглушки окружения -------------------------------------------------
const requests = [];          // что ушло бы в API
let lastDropdown = null;      // последний показанный список вариантов
let lastDropdownDoc = null;   // его "документ" с обработчиком select

const sandbox = {
  console: { log() {}, warn() {}, error() {} },
  Date,
  JSON, Math, String, Number, Object, Array, parseInt, isNaN, setTimeout,
  MenuItemDoc: null,
  Device: { appIdentifier: 'test', appVersion: 99, systemVersion: '17.0', vendorIdentifier: 'x' },
  AppSettings: { getAll: () => ({ animeIsHidden: { id: 0 } }), get: () => ({ id: 0 }) },
  AppStorage: { getItem: () => '', getData: () => '', setData() {}, removeData() {} },
  Network: {
    loadItemsFrom(itemToLoad, callback) {
      if ('selected' in itemToLoad) {
        // Загрузка справочника для выпадашки (жанры, страны...): отдадим один пункт
        callback({ items: [{ id: 1, title: 'Боевик' }] }, itemToLoad);
        return;
      }
      // Запрос списка фильмов: нас интересует только то, что ушло бы в API,
      // рендер результата требует TVML DOM
      requests.push(JSON.parse(JSON.stringify(itemToLoad)));
    },
  },
  Presenter: {
    activeParser: () => ({
      lsInput: {},
      lsParser: { parseWithContext() {} },
      doc: { getElementsByTagName: () => ({ item: () => ({}) }) },
    }),
    makeDocument(template) {
      const listeners = {};
      const doc = {
        template,
        addEventListener: (name, fn) => { listeners[name] = fn; },
        fire: (name, event) => listeners[name](event),
      };
      lastDropdownDoc = doc;
      return doc;
    },
    modalDocument() {},
    dismissModal() {},
  },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

for (const file of ['utils', 'templates', 'kp']) {
  vm.runInContext(fs.readFileSync(path.join(root, 'js', file + '.js'), 'utf8'), sandbox, { filename: file + '.js' });
}
const { Utils, Templates, KP } = sandbox;

// Templates.alertWithButtons строит кнопки из values; перехватим values, чтобы знать,
// какие годы предложены.
const realAlert = Templates.alertWithButtons;
Templates.alertWithButtons = function (title, values, key) {
  lastDropdown = { title, values: Object.values(values) };
  return realAlert.call(this, title, values, key);
};

// --- хелперы ------------------------------------------------------------
function pick(filterIndex, buttonId, buttonText) {
  KP.getDropDown(filterIndex);
  lastDropdownDoc.fire('select', {
    target: {
      tagName: 'button',
      getAttribute: (name) => (name === 'id' ? String(buttonId) : String(buttonText ?? buttonId)),
    },
  });
  return requests[requests.length - 1].filters;
}

function yearsOffered() {
  return lastDropdown.values.filter((v) => v.id != 0).map((v) => v.id);
}

// Индексы фильтров в optionsLibrary (см. начало js/kp.js)
const YEAR_FROM = 4;
const YEAR_TO = 5;

// --- 1. Utils.yearRange: чистая функция склейки параметра ------------------
assert.strictEqual(Utils.yearRange('', ''), '');
assert.strictEqual(Utils.yearRange(undefined, undefined), '');
assert.strictEqual(Utils.yearRange('2010', ''), `2010-${thisYear + 1}`);
assert.strictEqual(Utils.yearRange('', '1999'), '1912-1999');
assert.strictEqual(Utils.yearRange('2000', '2005'), '2000-2005');
assert.strictEqual(Utils.yearRange('2005', '2000'), '2000-2005', 'перепутанные границы меняются местами');
assert.strictEqual(Utils.yearRange('2014', '2014'), '2014', 'равные границы -> один год');
assert.strictEqual(Utils.yearRange(2001, 2003), '2001-2003', 'числа тоже принимаются');
console.log('ok  Utils.yearRange');

// --- 2. Подпись фильтра ----------------------------------------------------
assert.strictEqual(Templates.fragments.filterTitle({ title: 'Год с', prefix: 'с ', selected: '' }), 'Год с');
assert.strictEqual(Templates.fragments.filterTitle({ title: 'Год с', prefix: 'с ', selected: '2010' }), 'с 2010');
assert.strictEqual(Templates.fragments.filterTitle({ title: 'Жанр', selected: 'Драма' }), 'Драма');
assert.ok(Templates.fragments.lockup({ title: 'Год до', prefix: 'до ', selected: '2015' }, 5).includes('до 2015'));
console.log('ok  Templates.fragments.filterTitle / lockup');

// --- 3. Сценарий с пультом: выбор "с", потом "до" ----------------------------
// "Год с" предлагает все годы каталога
KP.getDropDown(YEAR_FROM);
assert.strictEqual(lastDropdown.title, 'Год с');
let offered = yearsOffered();
assert.strictEqual(offered[0], thisYear, 'список начинается с текущего года');
assert.strictEqual(offered[offered.length - 1], 1912, 'и заканчивается первым годом каталога');

// выбираем "с 2010"
let filters = pick(YEAR_FROM, 2010, '2010');
assert.strictEqual(filters.year, `2010-${thisYear + 1}`, 'одна граница -> диапазон до края');
assert.ok(!('yearFrom' in filters) && !('yearTo' in filters), 'служебные ключи в API не уходят');
assert.strictEqual(filters.sort, '-created', 'сортировка по умолчанию сохранилась');

// "Год до" теперь предлагает только годы не раньше 2010
KP.getDropDown(YEAR_TO);
offered = yearsOffered();
assert.strictEqual(offered[offered.length - 1], 2010, '"до" не раньше выбранного "с"');
assert.strictEqual(offered[0], thisYear);

// выбираем "до 2015" -> year=2010-2015
filters = pick(YEAR_TO, 2015, '2015');
assert.strictEqual(filters.year, '2010-2015');

// "Год с" теперь ограничен сверху 2015
KP.getDropDown(YEAR_FROM);
offered = yearsOffered();
assert.strictEqual(offered[0], 2015, '"с" не позже выбранного "до"');
assert.strictEqual(offered[offered.length - 1], 1912);

// сбрасываем "с" (кнопка 'Отменить выбор' имеет id 0) -> остаётся только "до"
filters = pick(YEAR_FROM, 0, 'Отменить выбор');
assert.strictEqual(filters.year, '1912-2015');

// сбрасываем и "до" -> параметра year нет вообще
filters = pick(YEAR_TO, 0, 'Отменить выбор');
assert.ok(!('year' in filters), 'без выбранных границ параметр year не отправляется');

// обычный фильтр по-прежнему работает рядом (жанр = 1)
KP.getDropDown(2);
assert.strictEqual(lastDropdown.title, 'Жанр');
lastDropdownDoc.fire('select', { target: { tagName: 'button', getAttribute: (n) => (n === 'id' ? '1' : 'Боевик') } });
filters = requests[requests.length - 1].filters;
assert.strictEqual(filters.genre, '1');
assert.ok(!('year' in filters));
console.log('ok  сценарий выбора "с"/"до" через выпадашки');

// --- 4. Страница актёра (options == null) не трогает year ---------------------
// loadFiltered(itemForActors, null, ...) вызывается из getSort('actor'); проверяем, что не падает
KP.getSort('actor');
lastDropdownDoc.fire('select', { target: { tagName: 'button', getAttribute: (n) => (n === 'id' ? '4' : 'По году') } });
filters = requests[requests.length - 1].filters;
assert.strictEqual(filters.sort, '-year');
assert.ok(!('year' in filters), 'на странице актёра диапазон лет не подставляется');
console.log('ok  страница актёра без фильтров');

console.log(`\nВсе проверки пройдены. Запросов к API перехвачено: ${requests.length}`);
