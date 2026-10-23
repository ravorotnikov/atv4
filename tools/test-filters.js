#!/usr/bin/env node
// Проверки без Apple TV: настоящие модули из js/ загружаются в песочницу Node
// с заглушками TVJS-окружения, и сценарии прогоняются так, как их проходит пульт:
// открыть выпадашку -> нажать кнопку -> посмотреть, что ушло бы в API.
//
//   node tools/test-filters.js
//
// Покрытие: фильтр года (пресеты и свой диапазон), мультивыбор жанров,
// сериализация массивов в URL, обработчик таймаута, переключение зеркал API
// при обрыве сети.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const root = path.join(__dirname, '..');
const thisYear = new Date().getFullYear();
const load = (sandbox, ...files) => files.forEach((f) =>
  vm.runInContext(fs.readFileSync(path.join(root, 'js', f + '.js'), 'utf8'), sandbox, { filename: f + '.js' }));

const quiet = { log() {}, warn() {}, error() {} };
const baseGlobals = () => ({
  console: quiet, Date, JSON, Math, String, Number, Object, Array, parseInt, parseFloat, isNaN,
  encodeURI, encodeURIComponent, decodeURIComponent,
  setTimeout: (fn) => fn(), // модалки открываются «сразу», без задержек на анимацию
  Device: { appIdentifier: 'test', appVersion: 99, systemVersion: '17.0', vendorIdentifier: 'x', productType: 'AppleTV' },
  Log: { sendSentry() {}, sendLog() {} },
});

// =====================================================================
// Часть 1. Фильтры библиотеки (utils + templates + kp)
// =====================================================================
(function filtersSuite() {
  const requests = [];      // что ушло бы в API
  const parses = [];        // вызовы parseWithContext (обновление подписей и галочек)
  let lastDropdown = null;  // последний показанный список вариантов
  let lastDoc = null;       // его «документ» с обработчиком select
  let modalsOpen = 0;

  const sandbox = Object.assign(baseGlobals(), {
    MenuItemDoc: null,
    AppSettings: { getAll: () => ({ animeIsHidden: { id: 0 } }), get: () => ({ id: 0 }) },
    AppStorage: { getItem: () => '', getData: () => '', setData() {}, removeData() {} },
    Network: {
      loadItemsFrom(itemToLoad, callback) {
        if ('selected' in itemToLoad) {
          // справочник для выпадашки (жанры/страны)
          callback({ items: [{ id: 1, title: 'Боевик' }, { id: 3, title: 'Драма' }, { id: 7, title: 'Комедия' }] }, itemToLoad);
          return;
        }
        requests.push(JSON.parse(JSON.stringify(itemToLoad)));
      },
    },
    Presenter: {
      activeParser: (doc) => ({
        lsInput: {},
        lsParser: { parseWithContext(input, element, action) { parses.push({ xml: input.stringData, action, element }); } },
        doc: doc || { getElementsByTagName: () => ({ item: (i) => ({ lockupIndex: i }) }) },
      }),
      makeDocument(template) {
        const listeners = {};
        const doc = {
          template,
          getElementById: (id) => (template.includes(`id="${id}"`) ? { id } : null),
          getElementsByTagName: () => ({ item: (i) => ({ lockupIndex: i }) }),
          addEventListener: (name, fn) => { listeners[name] = fn; },
          fire: (name, event) => listeners[name](event),
        };
        lastDoc = doc;
        return doc;
      },
      modalDocument() { modalsOpen++; },
      dismissModal() { modalsOpen--; },
    },
  });
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  load(sandbox, 'utils', 'templates', 'kp');
  const { Utils, Templates, KP } = sandbox;

  const realAlert = Templates.alertWithButtons;
  Templates.alertWithButtons = function (title, values, key) {
    lastDropdown = { title, values: Object.values(values) };
    return realAlert.call(this, title, values, key);
  };

  const button = (id, text) => ({ tagName: 'button', getAttribute: (n) => (n === 'id' ? String(id) : String(text ?? id)) });
  const pick = (filterIndex, id, text) => {
    KP.getDropDown(filterIndex);
    lastDoc.fire('select', { target: button(id, text) });
    return requests[requests.length - 1].filters;
  };
  const lastFilters = () => requests[requests.length - 1].filters;
  const lastLockupTitle = () => {
    const m = parses.filter((p) => p.action === 5).pop().xml.match(/<description class ="text">(.*?) <badge/);
    return m[1];
  };

  // Индексы в optionsLibrary (см. начало js/kp.js)
  const GENRE = 2, YEAR = 4;

  // --- Utils.yearRange ---------------------------------------------------
  assert.strictEqual(Utils.yearRange('', ''), '');
  assert.strictEqual(Utils.yearRange('2010', ''), `2010-${thisYear + 1}`);
  assert.strictEqual(Utils.yearRange('', '1999'), '1912-1999');
  assert.strictEqual(Utils.yearRange('2005', '2000'), '2000-2005', 'перепутанные границы меняются местами');
  assert.strictEqual(Utils.yearRange(2014, 2014), '2014', 'равные границы -> один год');
  console.log('ok  Utils.yearRange');

  // --- подписи ------------------------------------------------------------
  assert.strictEqual(Templates.fragments.filterTitle({ title: 'Год', selected: '' }), 'Год');
  assert.strictEqual(Templates.fragments.filterTitle({ title: 'Жанр', prefix: 'жанр: ', selected: 'Драма' }), 'жанр: Драма');
  assert.strictEqual(Templates.fragments.checklistSummary([]), '');
  assert.strictEqual(Templates.fragments.checklistSummary(['Драма']), 'Драма');
  assert.strictEqual(Templates.fragments.checklistSummary(['Драма', 'Комедия']), 'Драма, Комедия');
  assert.strictEqual(Templates.fragments.checklistSummary(['Драма', 'Комедия', 'Боевик', 'Ужасы']), 'Драма, Комедия +2');
  console.log('ok  подписи фильтров');

  // --- год: пресеты -------------------------------------------------------
  KP.getDropDown(YEAR);
  assert.strictEqual(lastDropdown.title, 'Год');
  const names = lastDropdown.values.map((v) => v.name);
  const decade = Math.floor(thisYear / 10) * 10;
  assert.deepStrictEqual(names.slice(0, 4), ['Свой диапазон…', 'Отменить выбор', `${decade}-е`, `${decade - 10}-е`], 'свой диапазон первой кнопкой');
  assert.strictEqual(names[names.length - 1], 'до 1950');
  assert.strictEqual(lastDropdown.values[2].id, `${decade}-${thisYear + 1}`, 'текущее десятилетие захватывает анонсы следующего года');
  assert.strictEqual(lastDropdown.values.find((v) => v.name === '2010-е').id, '2010-2019');
  assert.strictEqual(lastDropdown.values.find((v) => v.name === 'до 1950').id, '1912-1949');

  modalsOpen = 0; // выпадашку выше открывали только для осмотра
  let f = pick(YEAR, '2010-2019', '2010-е');
  assert.strictEqual(f.year, '2010-2019');
  assert.ok(!('conditions' in f), 'лишних ключей нет');
  assert.strictEqual(f.sort, '-created');
  assert.strictEqual(lastLockupTitle(), '2010-е');
  assert.strictEqual(modalsOpen, 0, 'модалка закрыта после выбора');
  console.log('ok  год: пресеты десятилетий');

  // --- год: свой диапазон --------------------------------------------------
  const before = requests.length;
  KP.getDropDown(YEAR);
  lastDoc.fire('select', { target: button('custom', 'Свой диапазон…') });
  assert.strictEqual(lastDropdown.title, 'С какого года');
  assert.strictEqual(lastDropdown.values[0].id, thisYear);
  assert.strictEqual(lastDropdown.values[lastDropdown.values.length - 1].id, 1912);
  lastDoc.fire('select', { target: button(2010) });
  assert.strictEqual(lastDropdown.title, 'По какой год');
  assert.strictEqual(lastDropdown.values[lastDropdown.values.length - 1].id, 2010, '«по» не раньше «с»');
  assert.strictEqual(requests.length, before, 'до второго шага запрос не уходит');
  lastDoc.fire('select', { target: button(2015) });
  assert.strictEqual(lastFilters().year, '2010-2015');
  assert.strictEqual(lastLockupTitle(), '2010–2015');
  assert.strictEqual(modalsOpen, 0);

  // один и тот же год на обоих шагах
  KP.getDropDown(YEAR);
  lastDoc.fire('select', { target: button('custom') });
  lastDoc.fire('select', { target: button(1999) });
  lastDoc.fire('select', { target: button(1999) });
  assert.strictEqual(lastFilters().year, '1999');
  assert.strictEqual(lastLockupTitle(), '1999');

  // сброс
  f = pick(YEAR, 0, 'Отменить выбор');
  assert.ok(!('year' in f), 'без выбора параметр year не отправляется');
  assert.strictEqual(lastLockupTitle(), 'Год');
  console.log('ok  год: свой диапазон и сброс');

  // --- жанры: мультивыбор --------------------------------------------------
  const modalsBefore = modalsOpen;
  KP.getDropDown(GENRE);
  const checklist = lastDoc;
  assert.ok(checklist.template.includes('id="done"') && checklist.template.includes('id="clear"'));
  assert.ok(checklist.template.includes('id="item-1"') && checklist.template.includes('id="item-7"'));
  assert.ok(!checklist.template.includes('✓'), 'пока ничего не выбрано — галочек нет');
  const beforeGenre = requests.length;
  const marksBefore = parses.filter((p) => p.action === 2).length;
  checklist.fire('select', { target: button('item-1') });
  checklist.fire('select', { target: button('item-3') });
  assert.strictEqual(requests.length, beforeGenre, 'переключение галочек не грузит список');
  const marks = parses.filter((p) => p.action === 2).slice(marksBefore);
  assert.strictEqual(marks.length, 6, 'после каждого клика перерисованы все три пункта');
  assert.ok(marks[marks.length - 3].xml.includes('✓ Боевик') && marks[marks.length - 2].xml.includes('✓ Драма'));
  assert.ok(!marks[marks.length - 1].xml.includes('✓'), 'Комедия без галочки');
  assert.strictEqual(modalsOpen, modalsBefore + 1, 'список остаётся открытым');
  checklist.fire('select', { target: button('done') });
  f = lastFilters();
  assert.strictEqual(f.genre, '1,3');
  assert.strictEqual(lastLockupTitle(), 'Боевик, Драма');
  assert.strictEqual(modalsOpen, modalsBefore, 'после «Готово» список закрыт');

  // повторное открытие помнит выбор; снять один
  KP.getDropDown(GENRE);
  assert.ok(lastDoc.template.includes('✓ Боевик') && lastDoc.template.includes('✓ Драма') && !lastDoc.template.includes('✓ Комедия'));
  lastDoc.fire('select', { target: button('item-1') });
  lastDoc.fire('select', { target: button('done') });
  assert.strictEqual(lastFilters().genre, '3');
  assert.strictEqual(lastLockupTitle(), 'Драма');

  // сбросить
  KP.getDropDown(GENRE);
  lastDoc.fire('select', { target: button('clear') });
  lastDoc.fire('select', { target: button('done') });
  assert.strictEqual(lastFilters().genre, '');
  assert.strictEqual(lastLockupTitle(), 'Жанр');
  console.log('ok  жанры: мультивыбор с галочками');

  // --- страница актёра (options == null) не трогает фильтры ----------------
  KP.getSort('actor');
  lastDoc.fire('select', { target: button(4, 'По году') });
  f = lastFilters();
  assert.strictEqual(f.sort, '-year');
  assert.ok(!('year' in f) && !('conditions' in f));
  console.log('ok  страница актёра без фильтров');
})();

// =====================================================================
// Часть 2. Сеть: сериализация, таймаут, зеркала (consts + utils + cache + ajax + api + hosts + network)
// =====================================================================
(function networkSuite() {
  const xhrs = [];
  class FakeXHR {
    constructor() { this.status = 0; this.responseText = ''; this.readyState = 4; this.headers = {}; xhrs.push(this); }
    open(method, url, async) { this.method = method; this.url = decodeURI(url); this.async = async; }
    setRequestHeader(k, v) { this.headers[k] = v; }
    send(body) { this.body = body; }
    abort() { this.aborted = true; }
    // помощники для теста
    fail() { this.status = 0; this.responseText = ''; this.onerror(); }
    timeOut() { this.status = 0; this.ontimeout(); }
    succeed(json) { this.status = 200; this.responseText = JSON.stringify(json); this.onload(); }
  }
  const stored = {};
  const errorsShown = [];
  const sandbox = Object.assign(baseGlobals(), {
    XMLHttpRequest: FakeXHR,
    AppStorage: {
      getData: (k) => stored[k], setData(k, v) { stored[k] = v; }, removeData(k) { delete stored[k]; },
      getItem: (k) => stored[k],
    },
    Templates: { alert: (title, desc) => { errorsShown.push(desc); return '<document/>'; } },
    Presenter: { makeDocument: () => ({}), pushDocument() {}, replaceDocument() {}, dismissModal() {} },
    getActiveDocument: () => ({}),
    Auth: { check: () => true },
  });
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  load(sandbox, 'consts', 'utils', 'cache', 'ajax', 'api', 'hosts', 'network');
  const { Ajax, API, ApiHosts, Network } = sandbox;
  const KINOPUB = vm.runInContext('KINOPUB', sandbox); // const в consts.js не попадает в свойства глобала
  API.setToken('test-token');

  // --- сериализация массивов ---------------------------------------------
  Ajax.get('https://x.test/items', {}, { type: 'movie', conditions: ['kinopoisk_rating>=7.5', 'imdb_rating>=8'], year: '2000-2005' });
  let xhr = xhrs.pop();
  assert.strictEqual(xhr.url, 'https://x.test/items?type=movie&conditions[]=kinopoisk_rating>=7.5&conditions[]=imdb_rating>=8&year=2000-2005');
  assert.strictEqual(typeof xhr.ontimeout, 'function', 'таймаут обрабатывается, а не теряется');
  assert.strictEqual(xhr.timeout, 10000);
  console.log('ok  URL: массивы как key[]=, обработчик таймаута на месте');

  // --- зеркала: умолчание и список ------------------------------------------
  assert.strictEqual(ApiHosts.current().name, 'proxykp.xyz');
  assert.ok(KINOPUB.apiHosts.length >= 3);
  assert.strictEqual(KINOPUB.apiBase, KINOPUB.apiHosts[0].api + '/v1/', 'первое зеркало совпадает с умолчанием');

  // --- обрыв сети -> переключение и повтор того же запроса -------------------
  const results = [];
  const item = { items: 'items', type: 'movie', id: 'test', filters: { sort: '-created' } };
  Network.loadItemsFrom(item, (result) => results.push(result), true);
  xhr = xhrs.pop();
  assert.ok(xhr.url.startsWith('https://proxykp.xyz/api/v1/items?'), xhr.url);
  xhr.fail();
  assert.strictEqual(ApiHosts.current().name, 'api.service-kp.com');
  assert.strictEqual(stored.apiHost, 'api.service-kp.com', 'выбор зеркала сохранён');
  xhr = xhrs.pop();
  assert.ok(xhr.url.startsWith('https://api.service-kp.com/v1/items?'), 'запрос повторён на новом зеркале: ' + xhr.url);
  assert.ok(xhr.url.includes('access_token=test-token'));
  xhr.succeed({ items: [{ id: 1 }], pagination: { current: 1, total: 1 } });
  assert.strictEqual(results.length, 1);
  assert.deepStrictEqual(results[0].items, [{ id: 1 }]);
  assert.strictEqual(errorsShown.length, 0, 'пользователь ошибки не видел');
  console.log('ok  обрыв сети: переключение на зеркало и повтор запроса');

  // --- таймаут тоже переключает -------------------------------------------
  Network.loadItemsFrom({ items: 'items', type: 'serial', id: 'test2', filters: {} }, (r) => results.push(r), true);
  xhrs.pop().timeOut();
  assert.strictEqual(ApiHosts.current().name, 'api.srvkp.com');
  xhrs.pop().succeed({ items: [] });
  assert.strictEqual(results.length, 2);
  console.log('ok  таймаут: переключение на следующее зеркало');

  // --- все зеркала недоступны -> обычная ошибка с кнопкой «Повторить» ----------
  Network.loadItemsFrom({ items: 'items', type: 'movie', id: 'test3', filters: {} }, (r) => results.push(r), true);
  xhrs.pop().fail();                       // srvkp -> proxykp (ещё не пробовали в этом окне)
  assert.strictEqual(ApiHosts.current().name, 'proxykp.xyz');
  xhrs.pop().fail();                       // proxykp -> service-kp пробовали минуту назад: стоп
  assert.strictEqual(ApiHosts.current().name, 'proxykp.xyz', 'по кругу не ходим');
  assert.strictEqual(errorsShown.length, 1, 'показана обычная ошибка');
  assert.ok(errorsShown[0].includes('status: 0'));
  console.log('ok  все зеркала лежат: показана ошибка, без бесконечного цикла');

  // --- восстановление сохранённого зеркала при запуске ------------------------
  stored.apiHost = 'api.srvkp.com';
  ApiHosts.reset(); // сбрасывает и окно повторов, и сохранённый выбор
  assert.strictEqual(stored.apiHost, undefined);
  stored.apiHost = 'api.srvkp.com';
  assert.strictEqual(ApiHosts.restore(), true);
  assert.strictEqual(KINOPUB.apiBase, 'https://api.srvkp.com/v1/');
  assert.strictEqual(KINOPUB.apiAuth, 'https://api.srvkp.com/oauth2/');
  assert.strictEqual(KINOPUB.cdnUrl, 'https://m.pushbr.com/');
  Network.loadItemsFrom({ items: 'items', type: 'movie', id: 'test4', filters: {} }, () => {}, true);
  assert.ok(xhrs.pop().url.startsWith('https://api.srvkp.com/v1/items?'), 'API.update() подхватил новое зеркало');
  stored.apiHost = 'unknown-host';
  assert.strictEqual(ApiHosts.restore(), false, 'неизвестное имя игнорируется');
  console.log('ok  зеркало восстанавливается при запуске');

  // --- мусор в ответе при status 0 не валит обработчик ------------------------
  Network.loadItemsFrom({ items: 'items', type: 'movie', id: 'test5', filters: {} }, () => {}, true);
  xhr = xhrs.pop();
  xhr.status = 0; xhr.responseText = '<html>blocked</html>';
  assert.doesNotThrow(() => xhr.onerror(), 'HTML вместо JSON раньше бросал исключение из JSON.parse');
  console.log('ok  не-JSON ответ при обрыве не ломает обработчик');
})();

console.log('\nВсе проверки пройдены.');
