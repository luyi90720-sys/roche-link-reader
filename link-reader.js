/**
 * Roche 链接解析插件 v3.0.1
 *
 * v3.0.1：工具 storage 读取加 1s 超时兜底，避免 storage 未就绪时挂起导致工具调用 504
 *
 * v3.0.0 完全重写：
 *   - 纯文字模式：不再下载/注入图片，不替换原消息，不操作主数据库
 *   - 只声明一个 chat.tools 工具 parse_link：帮助 char 将 user 的链接解析成文字返回
 *   - 按需调用：不自动注入全部内容，char 在需要时调用工具
 *   - 平台支持：微博 | 小红书 | 知乎 | 抖音 | B站 | 贴吧 | 豆瓣 | 通用网页
 *   - 统一走后端 /?url= 解析（默认国内可达 456.chajianreader.cc.cd）
 *
 * 工具流程：
 *   user 发链接 → char 判断需要了解内容 → 调用 parse_link → 返回解析文字
 *   不注入系统提示词，不轮询，不抢消息
 */
(function () {
  'use strict';

  // ============================ 常量 ============================
  var PLUGIN_ID = 'roche-link-reader';
  var APP_ID = 'roche-link-reader-home';
  var VERSION = '3.0.1';

  // 默认后端（国内可直连 CF Worker 自定义域名）
  var DEFAULT_BACKEND = 'https://456.chajianreader.cc.cd';

  // storage 键
  var SK = {
    backend: 'rlr_backend'
  };

  // 链接检测 — 先提取所有 URL，再按平台分类
  var URL_REGEX = /https?:\/\/[^\s<>"'.,;:!?)）】》\u4e00-\u9fa5]+/gi;

  // 平台正则
  var XHS_REGEX    = /https?:\/\/(xhslink\.com|xhslink\.cn|xiaohongshu\.com|xhscdn\.com)\//i;
  var WEIBO_REGEX  = /https?:\/\/(weibo\.com|weibo\.cn|m\.weibo\.cn|t\.cn)\//i;
  var BILI_REGEX   = /https?:\/\/(bilibili\.com|b23\.tv|bilibili\.tv)\//i;
  var DOUYIN_REGEX = /https?:\/\/(douyin\.com|v\.douyin\.com|tiktok\.com|iesdouyin\.com)\//i;
  var ZHIHU_REGEX  = /https?:\/\/(zhihu\.com|zhuanlan\.zhihu\.com)\//i;
  var TIEBA_REGEX  = /https?:\/\/(tieba\.baidu\.com|t\.baidu\.com)\//i;
  var DOUBAN_REGEX = /https?:\/\/(douban\.com|m\.douban\.com|book\.douban\.com|movie\.douban\.com|music\.douban\.com|www\.douban\.com)\//i;

  var PLATFORM_NAMES = {
    xiaohongshu: '小红书',
    weibo: '微博',
    bilibili: 'B站',
    douyin: '抖音',
    zhihu: '知乎',
    tieba: '贴吧',
    douban: '豆瓣',
    general: '网页'
  };

  // ============================ 工具函数 ============================

  function extractLinks(text) {
    if (!text) return [];
    return (String(text).match(URL_REGEX) || []);
  }

  function cleanLink(link) {
    var l = String(link).trim();
    while (l.length && (l[l.length - 1] === ')' || l[l.length - 1] === '）' || l[l.length - 1] === '.')) {
      l = l.substring(0, l.length - 1);
    }
    return l;
  }

  function detectPlatform(link) {
    if (XHS_REGEX.test(link)) return 'xiaohongshu';
    if (WEIBO_REGEX.test(link)) return 'weibo';
    if (BILI_REGEX.test(link)) return 'bilibili';
    if (DOUYIN_REGEX.test(link)) return 'douyin';
    if (ZHIHU_REGEX.test(link)) return 'zhihu';
    if (TIEBA_REGEX.test(link)) return 'tieba';
    if (DOUBAN_REGEX.test(link)) return 'douban';
    return 'general';
  }

  // ============================ 后端解析 ============================

  /**
   * 调用后端 /?url= 通用解析接口，返回 JSON
   */
  async function parseLink(link, backend) {
    var base = backend || DEFAULT_BACKEND;
    var url = base.replace(/\/$/, '') + '/?url=' + encodeURIComponent(link);
    var ctrl = new AbortController();
    var t = setTimeout(function() { ctrl.abort(); }, 12000);
    var resp;
    try {
      resp = await fetch(url, { signal: ctrl.signal });
    } finally {
      clearTimeout(t);
    }
    if (!resp.ok) throw new Error('解析接口返回状态 ' + resp.status);
    var data = await resp.json();
    return data;
  }

  // ============================ 各平台文字格式化 ============================

  /**
   * 将解析结果格式化为纯文字（不带图片）
   */
  function formatParsedResult(data, platform, link) {
    var pname = PLATFORM_NAMES[platform] || '网页';
    var lines = [];
    lines.push('【' + pname + '链接解析】');

    // 标题
    var title = data.title || data.name || '';
    if (title) { lines.push('标题：' + title); }

    // 正文/描述
    var body = data.desc || data.content || data.text || data.body || data.description || '';
    if (body) { lines.push(''); lines.push(body); }

    // 作者（可能是对象 {name,nickname} 或字符串）
    var authorName = '';
    if (typeof data.author === 'object' && data.author) {
      authorName = data.author.name || data.author.nickname || '';
    } else if (typeof data.author === 'string') {
      authorName = data.author;
    }
    // 微博特有：user
    if (!authorName && data.user) {
      authorName = (typeof data.user === 'object') ? (data.user.name || data.user.nickname || '') : data.user;
    }
    if (authorName) lines.push('作者：' + authorName);

    // 标签
    if (data.tags && data.tags.length > 0) lines.push('标签：' + data.tags.join(' '));

    // 数据统计
    var stats = [];
    if (data.likedCount !== undefined) stats.push('点赞 ' + data.likedCount);
    else if (data.likeCount !== undefined) stats.push('点赞 ' + data.likeCount);
    if (data.commentCount !== undefined) stats.push('评论 ' + data.commentCount);
    else if (data.replyCount !== undefined) stats.push('评论 ' + data.replyCount);
    if (data.shareCount !== undefined) stats.push('分享 ' + data.shareCount);
    if (data.favoriteCount !== undefined) stats.push('收藏 ' + data.favoriteCount);
    if (data.forwardCount !== undefined) stats.push('转发 ' + data.forwardCount);
    if (stats.length > 0) lines.push('数据：' + stats.join(' | '));

    // 时间
    if (data.publishTime || data.createTime || data.time) {
      lines.push('时间：' + (data.publishTime || data.createTime || data.time));
    }

    // 评论（小红书等平台，后端用 iPhone UA 抓取含评论的 HTML）
    if (data.comments && data.comments.length > 0) {
      lines.push('');
      lines.push('【热门评论】');
      var ciMax = Math.min(data.comments.length, 10);
      for (var ci = 0; ci < ciMax; ci++) {
        var c = data.comments[ci];
        var uname = c.nickname || c.author || '匿名';
        var cline = '- ' + uname + '：' + (c.content || '');
        if (c.likedCount > 0) cline += ' (' + c.likedCount + '赞)';
        lines.push(cline);
      }
    }

    // B站字幕（data.subtitle/subtitles 是对象 {available, text, srt} 或字符串）
    var subSrc = data.subtitle || data.subtitles;
    if (subSrc) {
      var subText = '';
      if (typeof subSrc === 'object' && subSrc) {
        subText = subSrc.text || subSrc.srt || '';
      } else if (typeof subSrc === 'string') {
        subText = subSrc;
      }
      if (subText) {
        lines.push('');
        lines.push('【字幕内容】');
        lines.push(subText);
      }
    }

    // 视频标记
    if (data.video) lines.push('（含视频内容）');

    // 图片数量提示（只报数量，不下载图片）
    var imgCount = 0;
    if (data.images && data.images.length) imgCount = data.images.length;
    else if (data.imageList && data.imageList.length) imgCount = data.imageList.length;
    else if (data.pics && data.pics.length) imgCount = data.pics.length;
    if (imgCount > 0) lines.push('（该内容包含 ' + imgCount + ' 张图片，已按文字模式省略图片）');

    lines.push('');
    lines.push('原始链接：' + link);
    return lines.join('\n');
  }

  // ============================ 工具实现 ============================

  /**
   * 从工具调用中解析出要解析的链接
   * 优先使用 args.link，否则从 ctx.latestUserMessage 提取
   */
  function resolveLink(args, ctx) {
    if (args && args.link && typeof args.link === 'string') {
      var l = cleanLink(args.link);
      if (l) return l;
    }
    if (ctx && ctx.latestUserMessage) {
      var links = extractLinks(ctx.latestUserMessage);
      if (links.length > 0) return cleanLink(links[0]);
    }
    return null;
  }

  /**
   * parse_link 工具执行：解析链接为纯文字
   */
  async function executeParseLink(args, ctx) {
    var link = resolveLink(args, ctx);
    if (!link) {
      return { success: false, message: '未找到可解析的链接。请传入 link 参数，或确保消息中包含链接。' };
    }
    var platform = detectPlatform(link);

    // 读取用户配置的后端地址（加超时兜底，避免 storage 未就绪时挂起导致工具超时）
    var backend = DEFAULT_BACKEND;
    try {
      if (typeof window !== 'undefined' && window.Roche && window.Roche.storage) {
        var saved = await Promise.race([
          window.Roche.storage.get(SK.backend),
          new Promise(function(res) { setTimeout(function() { res(undefined); }, 1000); })
        ]);
        if (saved) backend = saved;
      }
    } catch (e) {}

    try {
      var data = await parseLink(link, backend);
      var text = formatParsedResult(data, platform, link);
      return {
        success: true,
        platform: PLATFORM_NAMES[platform] || '网页',
        link: link,
        text: text
      };
    } catch (e) {
      return {
        success: false,
        platform: PLATFORM_NAMES[platform] || '网页',
        link: link,
        message: '解析失败：' + e.message
      };
    }
  }

  // ============================ UI ============================

  var rootEl = null;
  var injectedStyleEl = null;

  function uiToast(roche, msg) {
    try { if (roche && roche.ui && roche.ui.toast) roche.ui.toast(msg); } catch (e) {}
  }

  function injectStyles() {
    if (injectedStyleEl) return;
    var style = document.createElement('style');
    style.textContent = [
      '.rlr-root { background:#121212; color:#f5f5f5; min-height:100%; padding:16px; box-sizing:border-box; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; display:flex; flex-direction:column; gap:12px; }',
      '.rlr-topbar { display:flex; align-items:center; justify-content:space-between; flex-shrink:0; }',
      '.rlr-title { font-size:17px; font-weight:700; color:#fff; }',
      '.rlr-close-btn { background:rgba(255,255,255,0.08); border:none; color:#fff; width:30px; height:30px; border-radius:8px; font-size:14px; cursor:pointer; }',
      '.rlr-card { background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.08); border-radius:12px; padding:14px 16px; }',
      '.rlr-card-title { font-size:14px; font-weight:600; color:#fff; margin-bottom:10px; }',
      '.rlr-label { display:block; font-size:12px; color:rgba(255,255,255,0.6); margin-bottom:6px; }',
      '.rlr-input { width:100%; box-sizing:border-box; background:rgba(255,255,255,0.08); border:1px solid rgba(255,255,255,0.12); border-radius:8px; color:#fff; padding:9px 12px; font-size:13px; outline:none; margin-bottom:10px; }',
      '.rlr-input:focus { border-color:rgba(255,255,255,0.35); }',
      '.rlr-btn { background:#e6b91e; border:none; color:#1a1a1a; border-radius:8px; padding:9px 16px; font-size:13px; font-weight:600; cursor:pointer; }',
      '.rlr-btn-sm { padding:6px 12px; font-size:12px; }',
      '.rlr-btn-outline { background:transparent; border:1px solid rgba(255,255,255,0.25); color:#fff; }',
      '.rlr-test-result { margin-top:10px; background:rgba(0,0,0,0.3); border-radius:8px; padding:10px 12px; font-size:12px; color:rgba(255,255,255,0.85); white-space:pre-wrap; word-break:break-word; max-height:260px; overflow-y:auto; line-height:1.6; }',
      '.rlr-hint { font-size:12px; color:rgba(255,255,255,0.45); line-height:1.6; margin-top:6px; }',
      '.rlr-plat { display:inline-block; background:rgba(255,255,255,0.08); border-radius:6px; padding:2px 8px; font-size:11px; margin:0 4px 4px 0; color:rgba(255,255,255,0.7); }',
      '.rlr-tool-box { background:rgba(230,185,30,0.08); border:1px solid rgba(230,185,30,0.3); border-radius:8px; padding:10px 12px; font-size:12px; color:rgba(255,255,255,0.85); line-height:1.7; margin-top:8px; }'
    ].join('\n');
    document.head.appendChild(style);
    injectedStyleEl = style;
  }

  async function initApp(container, roche) {
    injectStyles();
    rootEl = container;
    container.innerHTML = [
      '<div class="rlr-root">',
      '  <div class="rlr-topbar">',
      '    <span class="rlr-title">链接解析</span>',
      '    <button class="rlr-close-btn" id="rlr-close-btn" title="关闭">\u2715</button>',
      '  </div>',
      '  <div class="rlr-card">',
      '    <div class="rlr-card-title">\u2728 工作原理（v3.0 纯文字模式）</div>',
      '    <div class="rlr-hint">你发送链接后，char 会按需调用内置工具 <b>parse_link</b>，把链接解析成文字再回复你。',
      '    不再自动注入、不再下载图片、不替换原消息。支持平台：</div>',
      '    <div style="margin-top:8px;">',
      '      <span class="rlr-plat">微博</span><span class="rlr-plat">小红书</span><span class="rlr-plat">知乎</span>',
      '      <span class="rlr-plat">抖音</span><span class="rlr-plat">B站(含字幕)</span><span class="rlr-plat">贴吧</span>',
      '      <span class="rlr-plat">豆瓣</span><span class="rlr-plat">通用网页</span>',
      '    </div>',
      '  </div>',
      '  <div class="rlr-card">',
      '    <div class="rlr-card-title">\u2699\ufe0f 后端解析地址</div>',
      '    <label class="rlr-label">默认：https://456.chajianreader.cc.cd（国内可直连）</label>',
      '    <input type="text" class="rlr-input" id="rlr-backend" placeholder="https://xxx/?url= 形式的解析接口" />',
      '    <div style="display:flex;gap:8px;">',
      '      <button class="rlr-btn rlr-btn-sm" id="rlr-save-backend">保存</button>',
      '      <button class="rlr-btn rlr-btn-sm rlr-btn-outline" id="rlr-reset-backend">恢复默认</button>',
      '    </div>',
      '  </div>',
      '  <div class="rlr-card">',
      '    <div class="rlr-card-title">\U0001f50d 测试链接解析</div>',
      '    <input type="text" class="rlr-input" id="rlr-test-link" placeholder="粘贴任意平台的链接测试解析效果" />',
      '    <div style="display:flex;gap:8px;">',
      '      <button class="rlr-btn rlr-btn-sm" id="rlr-test-btn">测试解析</button>',
      '      <button class="rlr-btn rlr-btn-sm rlr-btn-outline" id="rlr-clear-test-btn">清空</button>',
      '    </div>',
      '    <div class="rlr-test-result" id="rlr-test-result" style="display:none;"></div>',
      '  </div>',
      '  <div class="rlr-card">',
      '    <div class="rlr-card-title">\U0001f4a1 给 char 的工具说明</div>',
      '    <div class="rlr-tool-box">',
      '      <b>工具名</b>：parse_link<br>',
      '      <b>用途</b>：解析用户消息中的链接，返回纯文字内容（含标题/正文/作者/评论/字幕等）<br>',
      '      <b>参数</b>：link（可选，不传则自动从当前消息提取）',
      '    </div>',
      '  </div>',
      '</div>'
    ].join('');

    // 读取已保存后端
    try {
      var savedBackend = await roche.storage.get(SK.backend);
      var backendInput = container.querySelector('#rlr-backend');
      if (savedBackend && backendInput) backendInput.value = savedBackend;
    } catch (e) {}

    // 关闭
    container.querySelector('#rlr-close-btn').addEventListener('click', function() {
      try { if (roche && roche.ui && roche.ui.closeApp) roche.ui.closeApp(); } catch (e) {}
    });

    // 保存后端
    container.querySelector('#rlr-save-backend').addEventListener('click', async function() {
      var v = container.querySelector('#rlr-backend').value.trim();
      if (!v) { uiToast(roche, '请输入后端地址'); return; }
      try { await roche.storage.set(SK.backend, v); uiToast(roche, '已保存'); } catch (e) { uiToast(roche, '保存失败: ' + e.message); }
    });

    // 恢复默认
    container.querySelector('#rlr-reset-backend').addEventListener('click', async function() {
      container.querySelector('#rlr-backend').value = DEFAULT_BACKEND;
      try { await roche.storage.set(SK.backend, DEFAULT_BACKEND); uiToast(roche, '已恢复默认'); } catch (e) {}
    });

    // 测试解析
    container.querySelector('#rlr-test-btn').addEventListener('click', async function() {
      var testLink = (container.querySelector('#rlr-test-link').value || '').trim();
      var resultEl = container.querySelector('#rlr-test-result');
      if (!testLink) { uiToast(roche, '请先粘贴链接'); return; }
      resultEl.style.display = 'block';
      resultEl.textContent = '解析中...';
      try {
        var backendVal = container.querySelector('#rlr-backend').value.trim() || DEFAULT_BACKEND;
        var data = await parseLink(testLink, backendVal);
        var platform = detectPlatform(testLink);
        var text = formatParsedResult(data, platform, testLink);
        resultEl.textContent = '【解析成功】\n平台：' + (PLATFORM_NAMES[platform] || '网页') + '\n\n' + text;
      } catch (e) {
        resultEl.textContent = '【解析失败】\n' + e.message;
      }
    });

    // 清空
    container.querySelector('#rlr-clear-test-btn').addEventListener('click', function() {
      container.querySelector('#rlr-test-link').value = '';
      var resultEl = container.querySelector('#rlr-test-result');
      resultEl.style.display = 'none';
      resultEl.textContent = '';
    });
  }

  // ============================ 插件注册 ============================

  window.RochePlugin = window.RochePlugin || {};

  window.RochePlugin.register({
    id: PLUGIN_ID,
    name: '链接解析',
    version: VERSION,
    apps: [{
      id: APP_ID,
      name: '链接解析',
      icon: 'extension',
      iconImage: '',
      async mount(container, roche) {
        await initApp(container, roche);
      },
      async unmount(container, roche) {
        rootEl = null;
        container.replaceChildren();
      }
    }],
    chat: {
      // 只声明一个工具：parse_link
      // 不注入 promptOnly / contextProvider，char 需要时才调用
      tools: [{
        id: 'parse_link',
        description: '解析用户消息中的链接，返回该链接内容的纯文字摘要（支持微博、小红书、知乎、抖音、B站含字幕、贴吧、豆瓣、通用网页）。当用户发送了链接，或你需要了解链接内容时调用。',
        parameters: {
          link: 'string'
        },
        async execute(args, ctx) {
          return await executeParseLink(args, ctx);
        }
      }]
    }
  });

})();
