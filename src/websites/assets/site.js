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

  /* ---------- 代码块：轻量高亮（无外部依赖）与悬浮复制键 ---------- */

  // 三种口径各自一条组合正则；数字前面借一个"非词字符"捕获位，避开 SHA、时间戳、版本号里的连排数字。
  var RX = {
    ts: /('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`)|\b(import|from|export|const|let|var|function|return|if|else|new|throw|try|catch|finally|for|while|async|await|interface|type|extends|implements|class|void|null|undefined|true|false|this|typeof|as|of|in|delete|switch|case|break|continue)\b|([^\w.\-:])(\d+(?:\.\d+)?)(?![\w.\-:])/g,
    css: /("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')|([a-zA-Z-]+)(?=\s*:)|([^\w.\-])(\d+(?:\.\d+)?(?:px|em|rem|%|s|ms|fr|vh|vw|deg)?)(?![\w.\-])/g,
    sh: /('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*")|(\$^)|([^\w.\-:])(\d+(?:\.\d+)?)(?![\w.\-:])/g
  };
  var CLS = { ts: ['tok-str', 'tok-kw', 'tok-num'], css: ['tok-str', 'tok-prop', 'tok-num'], sh: ['tok-str', null, 'tok-num'] };

  function detectLang(t) {
    if (/\b(?:import|export|function|const|interface|async|await|return)\b/.test(t) || t.indexOf('=>') >= 0) return 'ts';
    if (/[{]/.test(t) && /\b(?:display|margin|padding|color|background|border|font|gap|list-style|cursor|max-width|text-decoration|align|justify|flex)\s*:/.test(t)) return 'css';
    return 'sh';
  }

  function wrapText(text, lang) {
    var frag = document.createDocumentFragment();
    var re = RX[lang]; var cls = CLS[lang];
    var last = 0; var m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      if (m[1]) {
        frag.appendChild(wrap(m[1], cls[0]));
        re.lastIndex = m.index + m[1].length;
      } else if (m[2] && cls[1]) {
        frag.appendChild(wrap(m[2], cls[1]));
      } else if (m[3] && m[4]) {
        frag.appendChild(document.createTextNode(m[3]));
        frag.appendChild(wrap(m[4], cls[2]));
        re.lastIndex = m.index + m[3].length + m[4].length;
      }
      last = re.lastIndex;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    return frag;
  }

  function wrap(t, c) {
    var s = document.createElement('span');
    s.className = c;
    s.textContent = t;
    return s;
  }

  var pres = Array.prototype.slice.call(document.querySelectorAll('pre'));
  pres.forEach(function (pre) {
    // 已有的注释/重点 span（.c/.k）整族跳过，只动裸文本节点
    var walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT, null);
    var texts = [];
    while (walker.nextNode()) {
      var p = walker.currentNode.parentElement;
      if (p && p.closest('.c, .k')) continue;
      texts.push(walker.currentNode);
    }
    var lang = detectLang(pre.textContent);
    texts.forEach(function (n) {
      if (n.nodeValue.indexOf('\u00a0') < 0) {
        n.parentNode.replaceChild(wrapText(n.nodeValue, lang), n);
      }
    });

    // 复制键：悬浮或键盘聚焦时亮在右上角；内容在插键之前取，键自己的字不会混进剪贴板
    var text = pre.textContent;
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'copy-btn';
    b.textContent = '复制';
    b.title = '复制这段内容';
    b.setAttribute('aria-label', '复制这段内容');
    b.addEventListener('click', function () {
      function done() {
        b.textContent = '已复制';
        b.classList.add('done');
        setTimeout(function () { b.textContent = '复制'; b.classList.remove('done'); }, 1600);
      }
      function fallback() {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); } catch (e) { /* 复制不了也不炸页面 */ }
        document.body.removeChild(ta);
        done();
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, fallback);
      } else {
        fallback();
      }
    });
    pre.appendChild(b);
  });

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
