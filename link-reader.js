/**
 * Roche 链接解析插件 v2.3.0
 *
 * 纯后台监听当前打开的聊天会话（从 viewStack 自动读取），检测到各平台链接后：
 *   1. 小红书：优先走专用 HTML 抓取（__INITIAL_STATE__ 提取标题/正文/评论/图片），
 *      失败后降级走后端 /?url= 通用解析
 *   2. B站/微博/抖音/知乎/通用：走后端 /?url= 通用解析获取 JSON
 *   3. 下载图片转 dataURL（三级代理降级：CF Pages → Vercel → CF Worker）
 *   4. 删除原消息，注入解析文本 + 独立图片消息
 *   5. 刷新聊天界面（Pinia splice > 事件派发 > viewStack pop/push）
 *
 * 关键设计：
 *   - DB 短连接：每次 openDB 后事务完成立即 close()，不缓存 _db 连接
 *     （参考 RocheToolkit v3.2 改动A：避免长连接干扰 Roche 主程序快照隔离）
 *   - 只监听当前打开的会话（从 viewStack 读取 top.params.id），不做会话列表选择
 *   - 关闭面板后监听继续在后台运行（参考 xhs-reader）
 *   - 不声明 chat.tools / chat.promptOnly / chat.contextProvider，纯后台处理
 *   - char 看不到原始链接，只能看到解析后的文本和图片
 *
 * 图片插入（参考 xhs-reader v2.7.0）：
 *   - 图片消息结构：{ id, text:'[Image Upload]', isMe, content:dataUrl, type:'image',
 *                   timestamp, conversationId, isVisionRecognized:false }
 *   - 时间戳递增（原消息+1=文本，原消息+2+i=第i张图片）
 */
(function () {
  'use strict';

  // ============================ 常量 ============================
  var PLUGIN_ID = 'roche-link-reader';
  var APP_ID = 'roche-link-reader-home';
  var DB_NAME = 'Roche_db';
  var POLL_INTERVAL = 2000;
  var MAX_IMAGES = 9;
  var FAIL_COOLDOWN = 5000;
  var MAX_FAILS = 5;

  // 内置三级代理（参考 xhs-reader v2.7.0，国内可直连）
  var BUILTIN_CF_PROXY = 'https://456.chajianreader.cc.cd';
  var BUILTIN_VERCEL_PROXY = 'https://xhs-proxy-iota.vercel.app';
  var BUILTIN_CF_WORKER = 'https://xhs-proxy.luyi90720.workers.dev';
  var DEFAULT_BACKEND = 'https://456.chajianreader.cc.cd';

  // 链接检测 — 先提取所有 URL，再按平台分类
  var URL_REGEX = /https?:\/\/[^\s<>"'.,;:!?)）】》\u4e00-\u9fa5]+/gi;
  var XHS_REGEX = /https?:\/\/(xhslink\.com|xhslink\.cn|xiaohongshu\.com|xhscdn\.com)\//i;
  var WEIBO_REGEX = /https?:\/\/(weibo\.com|weibo\.cn|m\.weibo\.cn|t\.cn)\//i;
  var BILI_REGEX = /https?:\/\/(bilibili\.com|b23\.tv|bilibili\.tv)\//i;
  var DOUYIN_REGEX = /https?:\/\/(douyin\.com|v\.douyin\.com|tiktok\.com)\//i;
  var ZHIHU_REGEX = /https?:\/\/(zhihu\.com|zhuanlan\.zhihu\.com)\//i;

  // storage 键
  var SK = {
    enabled: 'rlr_enabled',
    useBuiltinProxy: 'rlr_use_builtin_proxy',
    cfWorker: 'rlr_cf_worker',
    backend: 'rlr_backend',
    processedLinks: 'rlr_processed_links'
  };

  var PLATFORM_NAMES = {
    xiaohongshu: '小红书',
    weibo: '微博',
    bilibili: 'B站',
    douyin: '抖音',
    zhihu: '知乎',
    general: '网页'
  };

  // ============================ 运行时状态 ============================
  var rocheRef = null;
  var rocheStorage = null;
  var pollTimer = null;
  var isPolling = false;
  var rootEl = null;
  var injectedStyleEl = null;
  var processedLinks = {};
  var processedLinksLoaded = false;

  // ============================ 日志 ============================
  var logs = [];

  function log(msg, type) {
    type = type || 'info';
    var t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    logs.push({ time: t, msg: msg, type: type });
    if (logs.length > 200) logs.shift();
    console.log('[link-reader][' + t + '] ' + msg);
    if (rootEl) {
      var el = rootEl.querySelector('#rlr-logs');
      if (el) renderLogs();
    }
  }

  function uiToast(msg) {
    try {
      if (rocheRef && rocheRef.ui && typeof rocheRef.ui.toast === 'function') {
        rocheRef.ui.toast(msg);
      }
    } catch (e) {}
  }

  function notify(msg, type) {
    log(msg, type);
    uiToast(msg);
  }

  // ============================ 链接提取 & 平台检测 ============================

  function extractLinks(text) {
    if (!text) return [];
    var matches = String(text).match(URL_REGEX);
    return matches || [];
  }

  function cleanLink(link) {
    return link.replace(/[,。！？；，、.:;!?)]+$/, '').trim();
  }

  function detectPlatform(link) {
    if (XHS_REGEX.test(link)) return 'xiaohongshu';
    if (WEIBO_REGEX.test(link)) return 'weibo';
    if (BILI_REGEX.test(link)) return 'bilibili';
    if (DOUYIN_REGEX.test(link)) return 'douyin';
    if (ZHIHU_REGEX.test(link)) return 'zhihu';
    return 'general';
  }

  // ============================ 环境检测 + 智能代理 ============================

  function isApkWebView() {
    try {
      var ua = navigator.userAgent || '';
      if (/Android.*wv/i.test(ua)) return true;
      if (/Android.*Version\/\d/i.test(ua)) return true;
      return false;
    } catch (e) { return false; }
  }

  function isBrowserLocalFile() {
    try { return location.protocol === 'file:'; } catch (e) { return false; }
  }

  async function smartFetch(proxyUrl, options, timeoutMs) {
    timeoutMs = timeoutMs || 15000;
    var controller = new AbortController();
    var timeout = setTimeout(function() { controller.abort(); }, timeoutMs);
    try {
      var opts = Object.assign({
        signal: controller.signal,
        mode: 'cors',
        credentials: 'omit',
        redirect: 'follow',
        referrerPolicy: 'no-referrer'
      }, options || {});
      var resp = await fetch(proxyUrl, opts);
      clearTimeout(timeout);
      return { ok: true, resp: resp, error: null };
    } catch (e) {
      clearTimeout(timeout);
      var errType;
      if (e.name === 'AbortError') {
        errType = '超时(' + (timeoutMs / 1000) + 's)';
      } else if (e instanceof TypeError && /Failed to fetch|NetworkError|Load failed/i.test(e.message)) {
        errType = 'CORS拦截(' + e.message + ')';
      } else {
        errType = e.message || e.name;
      }
      return { ok: false, resp: null, error: errType };
    }
  }

  function getProxies(cfWorker, useBuiltin) {
    var proxies = [];
    if (useBuiltin) {
      proxies.push({ name: '内置主代理', fn: function(u) { return BUILTIN_CF_PROXY.replace(/\/$/, '') + '?url=' + encodeURIComponent(u); } });
      proxies.push({ name: 'Vercel代理', fn: function(u) { return BUILTIN_VERCEL_PROXY.replace(/\/$/, '') + '?url=' + encodeURIComponent(u); } });
      proxies.push({ name: 'CF-Worker', fn: function(u) { return BUILTIN_CF_WORKER.replace(/\/$/, '') + '?url=' + encodeURIComponent(u); } });
    }
    if (cfWorker) {
      proxies.push({ name: 'CF-Worker(自定义)', fn: function(u) { return cfWorker.replace(/\/$/, '') + '?url=' + encodeURIComponent(u); } });
    }
    return proxies;
  }

  // ============================ IndexedDB 短连接 ============================

  function openDB() {
    return new Promise(function(resolve, reject) {
      try {
        var req = indexedDB.open(DB_NAME);
        req.onsuccess = function() { resolve(req.result); };
        req.onerror = function() { reject(req.error); };
      } catch (e) { reject(e); }
    });
  }

  function getMessagesByConversation(conversationId) {
    return openDB().then(function(db) {
      return new Promise(function(resolve, reject) {
        var tx = db.transaction('messages', 'readonly');
        var store = tx.objectStore('messages');
        var req;
        try {
          req = store.index('conversationId').getAll(IDBKeyRange.only(conversationId));
        } catch (e) {
          req = store.getAll();
          req.onsuccess = function() {
            var all = req.result || [];
            resolve(all.filter(function(m) { return m && m.conversationId === conversationId; }));
          };
          req.onerror = function() { reject(req.error); };
          tx.oncomplete = function() { db.close(); };
          return;
        }
        req.onsuccess = function() {
          var arr = req.result || [];
          arr.sort(function(a, b) { return (a.timestamp || 0) - (b.timestamp || 0); });
          resolve(arr);
        };
        req.onerror = function() { reject(req.error); };
        tx.oncomplete = function() { db.close(); };
        tx.onerror = function() { db.close(); };
      });
    });
  }

  function addMessage(msg) {
    return openDB().then(function(db) {
      return new Promise(function(resolve, reject) {
        var tx = db.transaction('messages', 'readwrite');
        var req = tx.objectStore('messages').add(msg);
        req.onsuccess = function() { resolve(req.result); };
        req.onerror = function() { reject(req.error); };
        tx.oncomplete = function() { db.close(); };
        tx.onerror = function() { db.close(); };
        tx.onabort = function() { db.close(); };
      });
    });
  }

  function deleteMessage(id) {
    return openDB().then(function(db) {
      return new Promise(function(resolve, reject) {
        var tx = db.transaction('messages', 'readwrite');
        var req = tx.objectStore('messages').delete(id);
        req.onsuccess = function() { resolve(); };
        req.onerror = function() { reject(req.error); };
        tx.oncomplete = function() { db.close(); };
        tx.onerror = function() { db.close(); };
        tx.onabort = function() { db.close(); };
      });
    });
  }

  // ============================ 图片下载（多级代理降级）============================

  async function downloadImageAsDataUrl(imageUrl, cfWorker, useBuiltin) {
    var proxies = getProxies(cfWorker, useBuiltin);
    if (proxies.length === 0) throw new Error('未配置图片代理');

    var errors = [];
    for (var i = 0; i < proxies.length; i++) {
      var proxyName = proxies[i].name;
      var proxyUrl = proxies[i].fn(imageUrl);
      try {
        var result = await smartFetch(proxyUrl, {}, 20000);
        if (!result.ok) { errors.push(proxyName + ': ' + result.error); continue; }
        var resp = result.resp;
        if (!resp.ok) { errors.push(proxyName + ': HTTP ' + resp.status); continue; }
        var blob = await resp.blob();
        if (blob.size === 0) { errors.push(proxyName + ': blob为0'); continue; }
        var dataUrl = await new Promise(function(resolve, reject) {
          var reader = new FileReader();
          reader.onload = function() { resolve(reader.result); };
          reader.onerror = function() { reject(reader.error); };
          reader.readAsDataURL(blob);
        });
        return dataUrl;
      } catch (e) {
        errors.push(proxyName + ': ' + e.message);
      }
    }
    throw new Error('所有代理失败: ' + errors.join(' | '));
  }

  // ============================ 后端 /?url= 通用解析（适用于所有平台）============================

  /**
   * 调用后端 /?url=<link> 通用解析接口，返回 JSON：
   * { platform, title, desc/content/text, author, tags, images/imageList, subtitles, ... }
   */
  async function parseLink(link, backend) {
    var base = backend || DEFAULT_BACKEND;
    var url = base.replace(/\/$/, '') + '/?url=' + encodeURIComponent(link);
    var ctrl = new AbortController();
    var t = setTimeout(function() { ctrl.abort(); }, 20000);
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

  // 提取解析结果中的图片列表（兼容多种字段名）
  function extractImagesFromData(data) {
    var images = data.images || data.imageList || data.pics || [];
    return images.map(function(img) {
      if (typeof img === 'string') return { url: img, alt: '' };
      return { url: img.url || img.src || img.urlDefault || '', alt: img.alt || '' };
    }).filter(function(img) { return img.url; }).slice(0, MAX_IMAGES);
  }

  // ============================ 各平台文本格式化 ============================

  function formatParsedResult(data, platform, link) {
    var pname = PLATFORM_NAMES[platform] || '网页';
    var lines = [];
    lines.push('【' + pname + '链接解析】');
    if (data.title) { lines.push('# ' + data.title); lines.push(''); }
    var body = data.desc || data.content || data.text || data.body || '';
    if (body) { lines.push(body); lines.push(''); }
    if (data.author) lines.push('作者：' + data.author);
    if (data.tags && data.tags.length > 0) lines.push('标签：' + data.tags.join(' '));
    // B站字幕
    if (data.subtitles || data.subtitle) {
      lines.push('');
      lines.push('【字幕内容】');
      lines.push(data.subtitles || data.subtitle);
    }
    if (data.video) lines.push('（含视频内容）');
    if (data.likeCount !== undefined) lines.push('点赞：' + data.likeCount);
    if (data.commentCount !== undefined) lines.push('评论数：' + data.commentCount);
    lines.push('');
    lines.push('原始链接：' + link);
    return lines.join('\n');
  }

  // ============================ 小红书专用：HTML 抓取 + __INITIAL_STATE__ 解析 ============================

  function extractXhsUrl(text) {
    if (!text) return null;
    var m = text.match(/https?:\/\/(?:xhslink\.(?:com|cn)\/[^\s`'"（()）,。！？；、）)\]》\u4e00-\u9fa5]+|www\.xiaohongshu\.com\/[^\s`'"（()）,。！？；、）)\]》\u4e00-\u9fa5]+)/);
    return m ? m[0].replace(/[,。！？；，、]+$/, '').trim() : null;
  }

  async function fetchXhsHtml(xhsUrl, cfWorker, useBuiltin) {
    var proxies = getProxies(cfWorker, useBuiltin);
    if (proxies.length === 0) throw new Error('未配置代理');

    var errors = [];
    for (var i = 0; i < proxies.length; i++) {
      var pn = proxies[i].name;
      var pu = proxies[i].fn(xhsUrl);
      try {
        var result = await smartFetch(pu, {}, 15000);
        if (!result.ok) { errors.push(pn + ': ' + result.error); continue; }
        if (!result.resp.ok) { errors.push(pn + ': HTTP ' + result.resp.status); continue; }
        var html = await result.resp.text();
        if (html && html.includes('__INITIAL_STATE__') && html.includes('commentData')) {
          return html;
        }
        errors.push(pn + ': 无评论数据');
      } catch (e) {
        errors.push(pn + ': ' + (e.message || e.name));
      }
      if (i < proxies.length - 1) await new Promise(function(r) { setTimeout(r, 500); });
    }
    throw new Error('fetchXhsHtml 失败: ' + errors.join(' | '));
  }

  function parseXhsState(html) {
    var m = html.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]+?\})\s*<\/script>/);
    if (!m) throw new Error('未找到 __INITIAL_STATE__');
    return JSON.parse(m[1].replace(/undefined/g, 'null'));
  }

  function extractXhsNote(state) {
    return (state && state.noteData && state.noteData.data && state.noteData.data.noteData) || null;
  }

  function extractXhsComments(state) {
    return (state && state.noteData && state.noteData.data && state.noteData.data.commentData) || null;
  }

  function normalizeImgUrl(url) {
    if (!url) return '';
    if (url.startsWith('//')) return 'https:' + url;
    if (!url.startsWith('http')) return '';
    return url;
  }

  function extractXhsImages(note) {
    var imgs = [];
    if (note.type === 'video') {
      var cover = (note.video && (note.video.imageUrl || (note.video.coverImage && note.video.coverImage.url))) || '';
      var url = normalizeImgUrl(cover);
      if (url) imgs.push({ url: url, alt: '视频封面' });
    }
    if (note.imageList && note.imageList.length) {
      for (var i = 0; i < note.imageList.length && i < MAX_IMAGES; i++) {
        var u = normalizeImgUrl(note.imageList[i].url || note.imageList[i].urlDefault || '');
        if (u) imgs.push({ url: u, alt: '笔记配图' });
      }
    }
    return imgs;
  }

  function extractXhsTags(note) {
    var tags = [];
    if (note.tagList && note.tagList.length) {
      for (var i = 0; i < note.tagList.length; i++) {
        var t = note.tagList[i];
        var name = typeof t === 'string' ? t : (t.name || t.id || '');
        if (name) tags.push(name);
      }
    }
    return tags;
  }

  function formatXhsComments(comments) {
    if (!comments || !comments.comments || !comments.comments.length) return '';
    var lines = ['热门评论：'];
    for (var i = 0; i < comments.comments.length && i < 10; i++) {
      var c = comments.comments[i];
      var u = (c.user && (c.user.nickName || c.user.nickname)) || '匿名';
      var txt = (c.content || '').trim();
      var line = '- ' + u + '：' + txt;
      if (c.likeCount > 0) line += ' (' + c.likeCount + '赞)';
      lines.push(line);
      if (c.subComments && c.subComments.length) {
        for (var j = 0; j < c.subComments.length && j < 2; j++) {
          var sc = c.subComments[j];
          var su = (sc.user && (sc.user.nickName || sc.user.nickname)) || '匿名';
          lines.push('  \u21B3 ' + su + '：' + (sc.content || ''));
        }
      }
    }
    return lines.join('\n');
  }

  function formatXhsText(note, comments, sharerName) {
    var lines = [];
    lines.push(sharerName + '分享了一个小红书笔记：');
    lines.push('');
    lines.push('# ' + (note.title || '(无标题)'));
    lines.push('');
    lines.push(note.desc || '(无正文)');
    lines.push('');
    var tags = extractXhsTags(note);
    if (tags.length > 0) {
      lines.push('标签：' + tags.join(' '));
      lines.push('');
    }
    var commentText = formatXhsComments(comments);
    if (commentText) {
      lines.push(commentText);
    }
    return lines.join('\n');
  }

  async function processXhsLink(xhsUrl, cfWorker, useBuiltin) {
    var html = await fetchXhsHtml(xhsUrl, cfWorker, useBuiltin);
    var state = parseXhsState(html);
    var note = extractXhsNote(state);
    if (!note) throw new Error('未找到笔记数据');
    var comments = extractXhsComments(state);
    return { note: note, comments: comments, images: extractXhsImages(note), isXhs: true };
  }

  // ============================ 用户人设 ============================

  async function getSharerName() {
    try {
      if (rocheRef && rocheRef.persona && rocheRef.persona.getActiveUserPersona) {
        var p = await rocheRef.persona.getActiveUserPersona();
        return (p && (p.handle || p.name)) || '我';
      }
    } catch (e) {}
    return '我';
  }

  // ============================ Pinia / viewStack ============================

  function getPinia() {
    try {
      var selectors = ['#app', '#roche', '[data-v-app]', '#root'];
      for (var si = 0; si < selectors.length; si++) {
        var el = document.querySelector(selectors[si]);
        if (!el || !el.__vue_app__) continue;
        var app = el.__vue_app__;
        var gp = (app._context && app._context.config && app._context.config.globalProperties)
                || (app.config && app.config.globalProperties);
        if (gp && gp.$pinia && gp.$pinia._s) return gp.$pinia;
      }
      for (var ci = 0; ci < document.body.children.length; ci++) {
        var child = document.body.children[ci];
        if (!child.__vue_app__) continue;
        var a = child.__vue_app__;
        var g = (a._context && a._context.config && a._context.config.globalProperties)
              || (a.config && a.config.globalProperties);
        if (g && g.$pinia && g.$pinia._s) return g.$pinia;
      }
    } catch (e) {}
    return null;
  }

  function findMessagesArrayInPinia(cid) {
    var pinia = getPinia();
    if (!pinia) return null;
    var stores = pinia._s;
    for (var key in stores) {
      if (!stores.hasOwnProperty(key)) continue;
      var store = stores[key];
      var state = store.$state || store;
      if (state[cid] !== undefined && Array.isArray(state[cid])) return state[cid];
      if (store[cid] !== undefined && Array.isArray(store[cid])) return store[cid];
    }
    return null;
  }

  function getViewStackStore() {
    var pinia = getPinia();
    if (!pinia) return null;
    var stores = pinia._s;
    for (var key in stores) {
      if (!stores.hasOwnProperty(key)) continue;
      if (stores[key].viewStack !== undefined) return stores[key];
    }
    return null;
  }

  function getCurrentConversationId() {
    var navStore = getViewStackStore();
    if (navStore && navStore.viewStack && navStore.viewStack.length > 0) {
      var top = navStore.viewStack[navStore.viewStack.length - 1];
      if (top && top.name === 'chat' && top.params && top.params.id) {
        return top.params.id;
      }
    }
    return null;
  }

  async function refreshRocheChat(conversationId) {
    try {
      if (!conversationId) return;
      var cid = String(conversationId);

      var piniaArr = findMessagesArrayInPinia(cid);
      if (piniaArr) {
        try {
          var dbMsgs = await getMessagesByConversation(cid);
          if (dbMsgs.length > 0) {
            piniaArr.splice(0, piniaArr.length);
            for (var i = 0; i < dbMsgs.length; i++) piniaArr.push(dbMsgs[i]);
            log('refreshRocheChat: Pinia splice ' + dbMsgs.length + ' 条 OK', 'success');
            return;
          }
        } catch (e) {}
      }

      try {
        window.dispatchEvent(new CustomEvent('roche-open-chat-request', {
          detail: { conversationId: cid, pushType: '', source: 'roche-link-reader' }
        }));
      } catch (e) {}
      try {
        document.dispatchEvent(new CustomEvent('roche-open-chat-request', {
          detail: { conversationId: cid, pushType: '', source: 'roche-link-reader' }
        }));
      } catch (e) {}
      setTimeout(function() {
        try {
          window.dispatchEvent(new CustomEvent('roche-messages-updated', {
            detail: { conversationId: cid, source: 'roche-link-reader' }
          }));
        } catch (e) {}
      }, 100);

      var navStore = getViewStackStore();
      if (navStore && navStore.viewStack && navStore.viewStack.length > 0) {
        var top = navStore.viewStack[navStore.viewStack.length - 1];
        if (top && top.name === 'chat' && top.params && top.params.id === cid) {
          navStore.viewStack.pop();
          setTimeout(function() {
            navStore.viewStack.push({ name: 'chat', params: { id: cid } });
          }, 50);
          log('refreshRocheChat: viewStack pop/push ' + cid, 'success');
          return;
        }
      }
    } catch (e) {
      log('refreshRocheChat 失败: ' + e.message, 'error');
    }
  }

  // ============================ 消息注入 ============================

  function genMsgId() {
    return 'msg_' + Date.now() + Math.random().toString().slice(1);
  }

  async function injectTextMessage(originalMsg, text) {
    var newMsg = {
      id: genMsgId(),
      text: text,
      isMe: originalMsg.isMe === undefined ? true : originalMsg.isMe,
      type: 'text',
      timestamp: (originalMsg.timestamp || Date.now()) + 1,
      conversationId: originalMsg.conversationId
    };
    if (originalMsg.senderId !== undefined) newMsg.senderId = originalMsg.senderId;
    if (originalMsg.senderName !== undefined) newMsg.senderName = originalMsg.senderName;
    if (originalMsg.id) {
      try { await deleteMessage(originalMsg.id); } catch (e) {}
    }
    await addMessage(newMsg);
    return newMsg;
  }

  async function injectImageMessage(originalMsg, imageDataUrl, offset) {
    var imgMsg = {
      id: genMsgId(),
      text: '[Image Upload]',
      isMe: originalMsg.isMe,
      content: imageDataUrl,
      type: 'image',
      timestamp: (originalMsg.timestamp || Date.now()) + 2 + (offset || 0),
      conversationId: originalMsg.conversationId,
      isVisionRecognized: false
    };
    if (originalMsg.senderId !== undefined) imgMsg.senderId = originalMsg.senderId;
    if (originalMsg.senderName !== undefined) imgMsg.senderName = originalMsg.senderName;
    await addMessage(imgMsg);
    return imgMsg;
  }

  // ============================ 链接处理主流程 ============================

  /**
   * 处理一个链接：
   *   小红书 → 优先走 XHS 专有解析，失败降级走后端通用解析
   *   其他平台 → 走后端 /?url= 通用解析
   *   下载图片 → 删除原消息 → 注入文本 + 图片
   */
  async function processOneLink(msg, link, backend, cfWorker, useBuiltin) {
    var platform = detectPlatform(link);
    log('processOneLink: [' + platform + '] ' + link);

    var data;
    var isXhs = false;

    // 小红书：优先走专有解析
    if (platform === 'xiaohongshu') {
      try {
        var xhsResult = await processXhsLink(link, cfWorker, useBuiltin);
        var sharerName = await getSharerName();
        var xhsText = formatXhsText(xhsResult.note, xhsResult.comments, sharerName);
        // 注入文本
        var newTextMsg = await injectTextMessage(msg, xhsText);
        // 下载图片
        var imgOk = 0, imgFail = 0;
        var imageMsgIds = [];
        for (var i = 0; i < xhsResult.images.length; i++) {
          try {
            var dataUrl = await downloadImageAsDataUrl(xhsResult.images[i].url, cfWorker, useBuiltin);
            var imgMsg = await injectImageMessage(newTextMsg, dataUrl, i);
            imageMsgIds.push(imgMsg.id);
            imgOk++;
          } catch (e) { imgFail++; }
        }
        log('processOneLink: XHS专有解析成功, 图片 ' + imgOk + '/' + (imgOk + imgFail));
        return { textMsgId: newTextMsg.id, imageMsgIds: imageMsgIds, imgOk: imgOk, imgFail: imgFail, platform: platform };
      } catch (e) {
        log('processOneLink: XHS专有解析失败 (' + e.message + '), 降级到后端通用解析', 'warn');
      }
    }

    // 通用解析（非XHS 或 XHS降级）
    data = await parseLink(link, backend);
    var platformName = data.platform || platform;
    var text = formatParsedResult(data, platformName, link);

    // 注入文本
    var textMsg = await injectTextMessage(msg, text);

    // 下载图片
    var images = extractImagesFromData(data);
    var ok = 0, fail = 0;
    var imgIds = [];
    for (var j = 0; j < images.length; j++) {
      try {
        var dUrl = await downloadImageAsDataUrl(images[j].url, cfWorker, useBuiltin);
        var im = await injectImageMessage(textMsg, dUrl, j);
        imgIds.push(im.id);
        ok++;
      } catch (e) { fail++; }
    }
    log('processOneLink: 后端通用解析成功, 图片 ' + ok + '/' + (ok + fail));
    return { textMsgId: textMsg.id, imageMsgIds: imgIds, imgOk: ok, imgFail: fail, platform: platformName };
  }

  // ============================ 轮询监听 ============================

  async function loadProcessedLinks() {
    if (processedLinksLoaded) return;
    processedLinksLoaded = true;
    try {
      if (rocheStorage) {
        var saved = await rocheStorage.get(SK.processedLinks);
        if (saved && typeof saved === 'object') Object.assign(processedLinks, saved);
      }
    } catch (e) {}
  }

  async function saveProcessedLinks() {
    try { if (rocheStorage) await rocheStorage.set(SK.processedLinks, processedLinks); } catch (e) {}
  }

  async function pollOnce() {
    if (isPolling) return;
    isPolling = true;
    try {
      var convId = getCurrentConversationId();
      if (!convId) return;

      // 读取设置
      var useBuiltin = true, cfWorker = null, backend = DEFAULT_BACKEND;
      try {
        if (rocheStorage) {
          var v = await rocheStorage.get(SK.useBuiltinProxy);
          if (v !== null && v !== undefined) useBuiltin = v !== false && v !== '0' && v !== 0;
          cfWorker = await rocheStorage.get(SK.cfWorker) || null;
          var b = await rocheStorage.get(SK.backend);
          if (b) backend = b;
        }
      } catch (e) {}

      // 读最新 3 条消息
      var msgs = [];
      try {
        var result = await rocheRef.memory.getShortTerm({ conversationId: convId, limit: 3 });
        msgs = Array.isArray(result) ? result : (result && result.messages) || [];
      } catch (e) { return; }
      if (msgs.length === 0) return;

      var m = msgs[msgs.length - 1];
      var isMe = m.isMe === true || m.senderId === 'me' || m.role === 'user' ||
                 (m.senderName === undefined && m.type !== 'assistant');
      if (!isMe) return;
      if (m.type && m.type !== 'text') return;

      var msgText = m.text || m.content || '';
      var links = extractLinks(msgText);
      if (links.length === 0) return;

      // 取第一个链接
      var link = cleanLink(links[0]);
      var msgId = m.id || m.messageId || (convId + '_' + m.timestamp);
      var key = convId + '_' + msgId;
      var now = Date.now();

      await loadProcessedLinks();
      var rec = processedLinks[key];
      if (rec) {
        if (rec.done) return;
        if (rec.processing) return;
        if (rec.fails > 0 && (now - (rec.lastFailTs || 0)) < FAIL_COOLDOWN) return;
        if (rec.fails >= MAX_FAILS) {
          if (!rec.gaveUpLogged) { notify('链接已达最大重试次数(' + MAX_FAILS + ')，放弃: ' + link.substring(0, 40) + '...', 'error'); rec.gaveUpLogged = true; }
          return;
        }
      }

      processedLinks[key] = { processing: true, ts: now, fails: rec ? rec.fails : 0 };
      var platform = detectPlatform(link);
      notify('检测到' + (PLATFORM_NAMES[platform] || '网页') + '链接，开始解析...', 'info');

      try {
        var fakeMsg = {
          id: msgId, text: msgText, isMe: true, type: 'text',
          timestamp: m.timestamp || Date.now(), conversationId: convId
        };
        if (m.senderId !== undefined) fakeMsg.senderId = m.senderId;
        if (m.senderName !== undefined) fakeMsg.senderName = m.senderName;

        var procResult = await processOneLink(fakeMsg, link, backend, cfWorker, useBuiltin);

        processedLinks[key] = {
          done: true, ts: Date.now(), injectTs: m.timestamp || Date.now(),
          convId: convId, textMsgId: procResult.textMsgId, imageMsgIds: procResult.imageMsgIds
        };
        await saveProcessedLinks();

        notify('注入成功 (图片 ' + procResult.imgOk + '/' + (procResult.imgOk + procResult.imgFail) + ')', 'success');
        await refreshRocheChat(convId);
      } catch (e) {
        notify('处理失败: ' + e.message, 'error');
        var prevFails = (processedLinks[key] && processedLinks[key].fails) || 0;
        processedLinks[key] = { fails: prevFails + 1, lastFailTs: Date.now(), ts: Date.now() };
        await saveProcessedLinks();
      }
    } finally {
      isPolling = false;
    }
  }

  function startPolling() {
    if (pollTimer) return;
    log('启动后台监听');
    pollTimer = setInterval(pollOnce, POLL_INTERVAL);
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; log('停止后台监听'); }
  }

  // ============================ 设置读写 ============================

  async function loadSettings() {
    if (!rocheStorage) return { enabled: true, useBuiltinProxy: true, cfWorker: '', backend: DEFAULT_BACKEND };
    var enabled = await rocheStorage.get(SK.enabled);
    var useBuiltinProxy = await rocheStorage.get(SK.useBuiltinProxy);
    var cfWorker = await rocheStorage.get(SK.cfWorker);
    var backend = await rocheStorage.get(SK.backend);
    return {
      enabled: enabled === null || enabled === undefined ? true : !!enabled,
      useBuiltinProxy: useBuiltinProxy === null || useBuiltinProxy === undefined ? true : !!useBuiltinProxy,
      cfWorker: cfWorker || '',
      backend: backend || DEFAULT_BACKEND
    };
  }

  async function saveSettings(settings) {
    if (!rocheStorage) return;
    await rocheStorage.set(SK.enabled, settings.enabled);
    await rocheStorage.set(SK.useBuiltinProxy, settings.useBuiltinProxy);
    await rocheStorage.set(SK.cfWorker, settings.cfWorker);
    await rocheStorage.set(SK.backend, settings.backend);
  }

  // ============================ 设置面板 UI ============================

  function getStyles() {
    return [
'.rlr-root {',
'  width:100%; height:100%; margin:0; padding:16px; box-sizing:border-box;',
'  display:flex; flex-direction:column; gap:12px;',
'  background:#121212; font-size:14px; color:#e0e0e0; line-height:1.5;',
'  overflow-y:auto; -webkit-overflow-scrolling:touch;',
'  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;',
'}',
'.rlr-root::-webkit-scrollbar { width:6px; }',
'.rlr-root::-webkit-scrollbar-thumb { background:rgba(255,255,255,0.15); border-radius:3px; }',
'.rlr-topbar {',
'  display:flex; align-items:center; justify-content:space-between;',
'  flex-shrink:0;',
'}',
'.rlr-title { font-size:16px; font-weight:700; color:#fff; }',
'.rlr-close-btn {',
'  width:28px; height:28px; border-radius:50%; border:1px solid rgba(255,255,255,0.15);',
'  background:rgba(255,255,255,0.06); color:rgba(255,255,255,0.6); cursor:pointer;',
'  display:flex; align-items:center; justify-content:center; font-size:16px;',
'  flex-shrink:0; line-height:1;',
'}',
'.rlr-close-btn:hover { background:rgba(255,255,255,0.12); color:#fff; }',
'.rlr-card {',
'  background:rgba(255,255,255,0.05); border-radius:12px; padding:16px;',
'  border:1px solid rgba(255,255,255,0.06); flex-shrink:0;',
'}',
'.rlr-card-title { font-size:15px; font-weight:600; margin:0 0 12px 0; color:#fff; }',
'.rlr-row { display:flex; align-items:center; gap:12px; margin-bottom:12px; min-height:32px; }',
'.rlr-row:last-child { margin-bottom:0; }',
'.rlr-label { color:rgba(255,255,255,0.7); flex-shrink:0; white-space:nowrap; }',
'.rlr-input {',
'  flex:1; min-width:0; padding:8px 12px;',
'  background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.1);',
'  border-radius:8px; color:#fff; font-size:13px; outline:none;',
'}',
'.rlr-input:focus { border-color:#C20C0C; }',
'.rlr-toggle {',
'  width:44px; min-width:44px; height:24px;',
'  background:rgba(255,255,255,0.15); border-radius:12px;',
'  position:relative; cursor:pointer; flex-shrink:0; transition:background 0.2s;',
'}',
'.rlr-toggle.on { background:#C20C0C; }',
'.rlr-toggle::after {',
'  content:""; position:absolute; top:2px; left:2px;',
'  width:20px; height:20px; border-radius:50%; background:#fff; transition:transform 0.2s;',
'}',
'.rlr-toggle.on::after { transform:translateX(20px); }',
'.rlr-btn {',
'  padding:8px 16px; background:#C20C0C; color:#fff; border:none;',
'  border-radius:8px; cursor:pointer; font-size:13px; flex-shrink:0;',
'}',
'.rlr-btn:active { transform:scale(0.97); }',
'.rlr-btn-sm { padding:6px 12px; font-size:12px; }',
'.rlr-btn-outline {',
'  background:transparent; border:1px solid rgba(255,255,255,0.2);',
'  color:rgba(255,255,255,0.7);',
'}',
'.rlr-status { font-size:12px; color:rgba(255,255,255,0.5); margin-top:8px; }',
'.rlr-status.active { color:#4ade80; }',
'.rlr-hint { font-size:12px; color:rgba(255,255,255,0.4); line-height:1.6; margin:8px 0 0 0; }',
'.rlr-test-result {',
'  margin-top:12px; padding:12px; background:rgba(0,0,0,0.3); border-radius:8px;',
'  font-size:12px; max-height:300px; overflow-y:auto; white-space:pre-wrap;',
'  word-break:break-all; color:rgba(255,255,255,0.7);',
'}',
'.rlr-log {',
'  background:rgba(0,0,0,0.3); border-radius:8px; padding:8px;',
'  max-height:200px; overflow-y:auto; font-family:monospace; font-size:11px; line-height:1.5;',
'}',
'.rlr-log-line { margin-bottom:2px; word-break:break-all; }',
'.rlr-log-time { color:rgba(255,255,255,0.3); margin-right:6px; }',
'.rlr-log-info { color:rgba(255,255,255,0.7); }',
'.rlr-log-success { color:#4ade80; }',
'.rlr-log-warn { color:#fbbf24; }',
'.rlr-log-error { color:#f87171; }',
'.rlr-platforms {',
'  display:flex; flex-wrap:wrap; gap:6px; margin-bottom:12px;',
'}',
'.rlr-platform-tag {',
'  padding:3px 10px; border-radius:12px; font-size:12px;',
'  background:rgba(255,255,255,0.06); color:rgba(255,255,255,0.5);',
'}',
    ].join('\n');
  }

  function renderLogs() {
    var el = rootEl ? rootEl.querySelector('#rlr-logs') : null;
    if (!el) return;
    if (logs.length === 0) {
      el.innerHTML = '<div style="color:rgba(255,255,255,0.3);font-size:12px;">暂无日志</div>';
      return;
    }
    el.innerHTML = logs.slice(-100).map(function(l) {
      return '<div class="rlr-log-line"><span class="rlr-log-time">' + l.time + '</span><span class="rlr-log-' + l.type + '">' + l.msg + '</span></div>';
    }).join('');
    el.scrollTop = el.scrollHeight;
  }

  async function initApp(container, roche) {
    rocheRef = roche;
    rocheStorage = roche.storage;

    rootEl = document.createElement('div');
    rootEl.className = 'rlr-root';
    container.appendChild(rootEl);

    if (!injectedStyleEl) {
      injectedStyleEl = document.createElement('style');
      injectedStyleEl.textContent = getStyles();
      document.head.appendChild(injectedStyleEl);
    }

    var settings = await loadSettings();

    var platformTags = Object.keys(PLATFORM_NAMES).map(function(k) {
      return '<span class="rlr-platform-tag">' + PLATFORM_NAMES[k] + '</span>';
    }).join('');

    rootEl.innerHTML = [
      '<div class="rlr-topbar">',
      '  <span class="rlr-title">链接解析</span>',
      '  <button class="rlr-close-btn" id="rlr-close-btn" title="关闭">\u2715</button>',
      '</div>',
      '<div class="rlr-card">',
      '  <div class="rlr-card-title">设置</div>',
      '  <div class="rlr-row">',
      '    <span class="rlr-label">启用后台监听</span>',
      '    <div class="rlr-toggle', settings.enabled ? ' on' : '', '" id="rlr-enabled-toggle"></div>',
      '  </div>',
      '  <div class="rlr-row">',
      '    <span class="rlr-label">使用内置代理</span>',
      '    <div class="rlr-toggle', settings.useBuiltinProxy ? ' on' : '', '" id="rlr-builtin-toggle"></div>',
      '  </div>',
      '  <div class="rlr-row">',
      '    <span class="rlr-label">后端地址</span>',
      '    <input class="rlr-input" id="rlr-backend-input" value="' + settings.backend + '" placeholder="' + DEFAULT_BACKEND + '" />',
      '  </div>',
      '  <div class="rlr-row">',
      '    <span class="rlr-label">自定义 CF Worker</span>',
      '    <input class="rlr-input" id="rlr-cfworker-input" value="' + (settings.cfWorker || '') + '" placeholder="可选" />',
      '  </div>',
      '  <button class="rlr-btn" id="rlr-save-btn">保存设置</button>',
      '  <div class="rlr-status', settings.enabled ? ' active' : '', '" id="rlr-status">',
      '    ', settings.enabled ? '监听中（仅当前会话）' : '已停止',
      '  </div>',
      '</div>',
      '<div class="rlr-card">',
      '  <div class="rlr-card-title">测试链接</div>',
      '  <div class="rlr-row">',
      '    <input class="rlr-input" id="rlr-test-input" placeholder="粘贴链接测试是否能解析..." />',
      '  </div>',
      '  <div style="display:flex;gap:8px;">',
      '    <button class="rlr-btn rlr-btn-sm" id="rlr-test-btn">测试解析</button>',
      '    <button class="rlr-btn rlr-btn-sm rlr-btn-outline" id="rlr-clear-test-btn">清空</button>',
      '  </div>',
      '  <div class="rlr-test-result" id="rlr-test-result" style="display:none;"></div>',
      '</div>',
      '<div class="rlr-card">',
      '  <div class="rlr-card-title">支持平台</div>',
      '  <div class="rlr-platforms">' + platformTags + '</div>',
      '  <div class="rlr-hint">',
      '    小红书（优先专用解析，含评论）| B站（含字幕）| 微博 | 抖音 | 知乎 | 通用网页<br/>',
      '    关闭此面板后监听继续运行。char 看不到原始链接。',
      '  </div>',
      '</div>',
      '<div class="rlr-card">',
      '  <div class="rlr-card-title">免责声明</div>',
      '  <div class="rlr-hint">',
      '    本插件为个人学习用途免费分享。解析服务仅用于个人学习参考，不得用于商业用途。<br/>',
      '    代理抓取公开网页数据，不经过用户隐私数据。使用即视为同意上述条款。',
      '  </div>',
      '</div>',
      '<div class="rlr-card">',
      '  <div class="rlr-card-title">运行日志</div>',
      '  <div class="rlr-log" id="rlr-logs"></div>',
      '</div>'
    ].join('');

    renderLogs();

    // ===== 事件绑定 =====
    var closeBtn = rootEl.querySelector('#rlr-close-btn');
    var enabledToggle = rootEl.querySelector('#rlr-enabled-toggle');
    var builtinToggle = rootEl.querySelector('#rlr-builtin-toggle');
    var backendInput = rootEl.querySelector('#rlr-backend-input');
    var cfworkerInput = rootEl.querySelector('#rlr-cfworker-input');
    var saveBtn = rootEl.querySelector('#rlr-save-btn');
    var statusEl = rootEl.querySelector('#rlr-status');
    var testInput = rootEl.querySelector('#rlr-test-input');
    var testBtn = rootEl.querySelector('#rlr-test-btn');
    var clearTestBtn = rootEl.querySelector('#rlr-clear-test-btn');
    var testResultEl = rootEl.querySelector('#rlr-test-result');

    closeBtn.addEventListener('click', function() {
      try {
        if (rocheRef && rocheRef.ui && typeof rocheRef.ui.closeApp === 'function') {
          rocheRef.ui.closeApp();
        }
      } catch (e) {}
    });

    enabledToggle.addEventListener('click', async function() {
      settings.enabled = !settings.enabled;
      if (settings.enabled) { enabledToggle.classList.add('on'); } else { enabledToggle.classList.remove('on'); }
      if (settings.enabled) { statusEl.classList.add('active'); } else { statusEl.classList.remove('active'); }
      statusEl.textContent = settings.enabled ? '监听中（仅当前会话）' : '已停止';
      await saveSettings(settings);
      if (settings.enabled) { startPolling(); uiToast('已启用监听'); }
      else { stopPolling(); uiToast('已停止监听'); }
    });

    builtinToggle.addEventListener('click', function() {
      settings.useBuiltinProxy = !settings.useBuiltinProxy;
      if (settings.useBuiltinProxy) { builtinToggle.classList.add('on'); } else { builtinToggle.classList.remove('on'); }
    });

    saveBtn.addEventListener('click', async function() {
      settings.backend = (backendInput.value || '').trim() || DEFAULT_BACKEND;
      settings.cfWorker = (cfworkerInput.value || '').trim();
      await saveSettings(settings);
      uiToast('设置已保存');
    });

    // 测试链接功能
    testBtn.addEventListener('click', async function() {
      var testLink = (testInput.value || '').trim();
      if (!testLink) { uiToast('请先输入链接'); return; }
      testResultEl.style.display = 'block';
      testResultEl.textContent = '解析中...';
      testBtn.disabled = true;
      testBtn.textContent = '解析中...';

      try {
        var curBackend = (backendInput.value || '').trim() || DEFAULT_BACKEND;
        var curUseBuiltin = settings.useBuiltinProxy;
        var curCfWorker = (cfworkerInput.value || '').trim() || null;

        var platform = detectPlatform(testLink);
        testResultEl.textContent = '平台识别: ' + (PLATFORM_NAMES[platform] || '未知') + '\n正在请求后端解析...';

        var data = await parseLink(testLink, curBackend);
        var images = extractImagesFromData(data);
        var text = formatParsedResult(data, platform, testLink);

        testResultEl.textContent = '【解析成功】\n平台: ' + (PLATFORM_NAMES[platform] || '未知') + '\n图片数: ' + images.length + '\n\n' + text;
        log('测试链接解析成功: ' + testLink, 'success');
        uiToast('测试解析成功');
      } catch (e) {
        testResultEl.textContent = '【解析失败】\n' + e.message;
        log('测试链接解析失败: ' + e.message, 'error');
        uiToast('测试失败: ' + e.message);
      } finally {
        testBtn.disabled = false;
        testBtn.textContent = '测试解析';
      }
    });

    clearTestBtn.addEventListener('click', function() {
      testInput.value = '';
      testResultEl.style.display = 'none';
      testResultEl.textContent = '';
    });

    if (settings.enabled) startPolling();
  }

  // ============================ 插件注册 ============================

  window.RochePlugin = window.RochePlugin || {};

  window.RochePlugin.register({
    id: PLUGIN_ID,
    name: '链接解析',
    version: '2.3.0',
    apps: [{
      id: APP_ID,
      name: '链接解析',
      icon: 'extension',
      iconImage: '',
      async mount(container, roche) {
        rocheRef = roche;
        rocheStorage = roche.storage;
        await initApp(container, roche);
      },
      async unmount(container, roche) {
        rootEl = null;
        container.replaceChildren();
      }
    }]
  });

})();
