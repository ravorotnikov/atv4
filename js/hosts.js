// Запасные зеркала API kino.pub с автоматическим переключением.
//
// Список зеркал лежит в KINOPUB.apiHosts (js/consts.js). Когда запрос к текущему
// зеркалу не доходит до сервера (status 0: обрыв, таймаут, блокировка), Network
// вызывает ApiHosts.switchToNext() и повторяет запрос. Выбранное зеркало
// запоминается и восстанавливается при следующем запуске (ApiHosts.restore()).
var ApiHosts = (function () {
    var switchedAt = {}; // name -> когда последний раз переключались на это зеркало
    var RETRY_WINDOW = 60000; // одно и то же зеркало пробуем не чаще раза в минуту

    function all() {
        return KINOPUB.apiHosts || [];
    }

    function currentIndex() {
        var hosts = all();
        for (var i = 0; i < hosts.length; i++) {
            if (KINOPUB.apiBase.indexOf(hosts[i].api + '/') === 0) { return i; }
        }
        return -1;
    }

    function apply(host) {
        KINOPUB.apiBase = host.api + '/v1/';
        KINOPUB.apiAuth = host.api + '/oauth2/';
        if (host.ext2) { KINOPUB.apiBaseExt2 = host.ext2 + '/v1.1/'; }
        if (host.cdn) {
            KINOPUB.cdnUrl = host.cdn + '/';
            KINOPUB.actorImgUrl = host.cdn + '/actors/';
        }
        KINOPUB.proxyUrl = host.api.replace(/\/api$/, '');
        API.update();
        console.log('ApiHosts: using ' + host.name);
    }

    return {
        // Зеркало, выбранное в прошлый раз (если его ещё нет в списке — остаётся умолчание)
        restore() {
            var name = AppStorage.getData(KEYS.apiHost);
            if (!name) { return false; }
            var host = all().filter(function (h) { return h.name == name; })[0];
            if (!host) { return false; }
            apply(host);
            return true;
        },

        current() {
            var i = currentIndex();
            return (i >= 0) ? all()[i] : { name: KINOPUB.apiBase, api: KINOPUB.apiBase };
        },

        // Переключиться на следующее зеркало по кругу. false — если зеркал нет или
        // следующее уже пробовали только что (чтобы не крутиться бесконечно).
        switchToNext() {
            var hosts = all();
            if (hosts.length < 2) { return false; }
            var next = hosts[(currentIndex() + 1) % hosts.length];
            var now = Date.now();
            if (switchedAt[next.name] && now - switchedAt[next.name] < RETRY_WINDOW) { return false; }
            switchedAt[next.name] = now;
            apply(next);
            AppStorage.setData(KEYS.apiHost, next.name);
            return true;
        },

        // Забыть выбранное зеркало (вернуться к умолчанию при следующем запуске)
        reset() {
            AppStorage.removeData(KEYS.apiHost);
            switchedAt = {};
        }
    };
}());
