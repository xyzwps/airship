/*
 * 官网的两件交互：主题档与文档页的当前节高亮。
 * 内容不依赖 JS：脚本没跑起来时页面照样读、照样导航。
 */

(function () {
  var root = document.documentElement;

  /* ---------- 主题：亮 / 暗 / 跟随系统三档循环，结果存在 localStorage ---------- */

  var ORDER = ['system', 'light', 'dark'];
  var LABEL = { system: '跟随系统', light: '亮色', dark: '暗色' };
  var ICON = { system: '◐', light: '☀', dark: '☾' };
  var btn = document.getElementById('theme-toggle');

  function stored() {
    try { return localStorage.getItem('airship-site-theme') || 'system'; } catch (e) { return 'system'; }
  }
  function save(mode) {
    try { localStorage.setItem('airship-site-theme', mode); } catch (e) { /* 隐私模式下存不了，不影响本档生效 */ }
  }
  function apply(mode) {
    if (mode === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', mode);
    if (btn) {
      btn.textContent = ICON[mode];
      btn.title = '主题：' + LABEL[mode] + '（点一下换成' + LABEL[ORDER[(ORDER.indexOf(mode) + 1) % 3]] + '）';
      btn.setAttribute('aria-label', btn.title);
    }
  }
  var current = stored();
  apply(current);
  if (btn) {
    btn.addEventListener('click', function () {
      current = ORDER[(ORDER.indexOf(current) + 1) % 3];
      save(current);
      apply(current);
    });
  }

  /* ---------- 文档页侧栏：滚到哪一节，哪一条亮起来 ---------- */

  var links = Array.prototype.slice.call(document.querySelectorAll('.toc a[href^="#"]'));
  if (!links.length || !('IntersectionObserver' in window)) return;

  var byId = {};
  links.forEach(function (a) { byId[a.getAttribute('href').slice(1)] = a; });

  var visible = [];
  var observer = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      var i = visible.indexOf(e.target);
      if (e.isIntersecting && i < 0) visible.push(e.target);
      if (!e.isIntersecting && i >= 0) visible.splice(i, 1);
    });
    if (!visible.length) return;
    var top = visible.reduce(function (best, el) {
      return el.getBoundingClientRect().top < best.getBoundingClientRect().top ? el : best;
    });
    links.forEach(function (a) { a.classList.remove('active'); });
    var link = byId[top.id];
    if (link) link.classList.add('active');
  }, { rootMargin: '-70px 0px -62% 0px', threshold: 0 });

  Object.keys(byId).forEach(function (id) {
    var el = document.getElementById(id);
    if (el) observer.observe(el);
  });
})();
