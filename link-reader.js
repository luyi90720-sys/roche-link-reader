/**
 * Roche 链接解析插件 v2.2.0
 *
 * 纯后台监听当前打开的聊天会话（从 viewStack 自动读取），检测到小红书链接后：
 *   1. 通过内置三级代理（CF Pages → Vercel → CF Worker）抓取小红书页面 HTML
 *   2. 从 __INITIAL_STATE__ 提取笔记标题/正文/标签/评论/图片列表
 *   3. 逐张下载图片转 dataURL（多级代理降级，绕过 CORS 和防盗链）
 *   4. 删除原消息，注入解析文本 + 独立图片消息（type:'image', content:dataUrl）
 *   5. 刷新聊天界面（Pinia splice > 事件派发 > viewStack pop/push）
 *
 * 关键设计：
 *   - DB 短连接：每次 openDB 后事务完成立即 close()，不缓存 _db 连接
 *     （参考 RocheToolkit v3.2 改动A：避免长连接干扰 Roche 主程序快照隔离，
 *      导致写入后前端 UI 无法即时刷新）
 *   - 只监听当前打开的会话（从 viewStack 读取 top.params.id），不做会话列表选择
 *   - 关闭面板后监听继续在后台运行（参考 xhs-reader）
 *   - 不声明 chat.tools / chat.promptOnly / chat.contextProvider，纯后台处理
 *   - char 看不到原始链接，只能看到解析后的文本和图片
 *
 * 图片插入（参考 xhs-reader v2.7.0）：
 *   - 图片消息结构：{ id, text:'[Image Upload]', isMe, content:dataUrl, type:'image',
 *                   timestamp, conversationId, isVisionRecognized:false }
 *   - 时间戳递增（原消息+1=文本，原消息+2+i=第i张图片），保证顺序正确
 *   - 多级代理降级下载（CF Pages → Vercel → CF Worker），任一成功即返回
 */
(function () {
  'use strict';

  // ============================ 常量 ============================
  const PLUGIN_ID = 'roche-link-reader';
  const APP_ID = 'roche-link-reader-home';
  const DB_NAME = 'Roche_db';
  const POLL_INTERVAL = 2000;       // 轮询间隔 2 秒
  const MAX_IMAGES = 9;             // 最多注入图片数
  const FAIL_COOLDOWN = 5000;       // 失败冷却 5 秒
  const MAX_FAILS = 5;              // 最大重试 5 次

  // 内置三级代理（参考 xhs-reader v2.7.0，国内可直连）
  const BUILTIN_CF_PROXY = 'https://456.chajianreader.cc.cd';        // 主代理：CF Pages + 自定义域名
  const BUILTIN_VERCEL_PROXY = 'https://xhs-proxy-iota.vercel.app';  // 回退 1：Vercel Global Proxy
  const BUILTIN_CF_WORKER = 'https://xhs-proxy.luyi90720.workers.dev'; // 回退 2：原始 CF Worker

  // storage 键
  const SK = {
    enabled: 'rlr_enabled',
    useBuiltinProxy: 'rlr_use_builtin_proxy',
    cfWorker: 'rlr_cf_worker',
    processedLinks: 'rlr_processed_links'
  };

  // ============================ 运行时状态 ============================
  let rocheRef = null;                  // roche API 引用
  let rocheStorage = null;              // roche.storage 引用
  let pollTimer = null;                 // 轮询定时器
  let isPolling = false;                // 全局锁，防止并发
  let rootEl = null;                    // 设置面板根元素
  let injectedStyleEl = null;           // style 标签
  const processedLinks = {};            // {key: {done, ts, fails, lastFailTs, convId, textMsgId, imageMsgIds}}
  let processedLinksLoaded = false;     // 是否已从 storage 加载

  // ============================ 日志 ============================
  const logs = [];

  function log(msg, type) {
    type = type || 'info';
    const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const entry = { time: t, msg, type };
    logs.push(entry);
    if (logs.length > 200) logs.shift();
    console.log(`[link-reader][${t}] ${msg}`);
    if (rootEl) {
      const el = rootEl.querySelector('#rlr-logs');
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

  // 便捷通知：日志 + toast
  function notify(msg, type) {
    log(msg, type);
    uiToast(msg);
  }

  // ============================ 环境检测 + 智能代理（参考 xhs-reader）============================

  function isApkWebView() {
    try {
      const ua = navigator.userAgent || '';
      if (/Android.*wv/i.test(ua)) return true;
      if (/Android.*Version\/\d/i.test(ua)) return true;
      return false;
    } catch (e) { return false; }
  }

  function isBrowserLocalFile() {
    try { return location.protocol === 'file:'; } catch (e) { return false; }
  }

  /**
   * 智能抓取 - 区分真 HTTP 错误 vs CORS 拦截
   */
  async function smartFetch(proxyUrl, options, timeoutMs) {
    timeoutMs = timeoutMs || 15000;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const opts = Object.assign({
        signal: controller.signal,
        mode: 'cors',
        credentials: 'omit',
        redirect: 'follow',
        referrerPolicy: 'no-referrer'
      }, options || {});
      const resp = await fetch(proxyUrl, opts);
      clearTimeout(timeout);
      return { ok: true, resp: resp, error: null };
    } catch (e) {
      clearTimeout(timeout);
      let errType;
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

  /**
   * 返回 HTML 抓取的代理列表（按环境排序）
   */
  function getHtmlProxies(cfWorker, useBuiltin) {
    const proxies = [];
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

  /**
   * 返回图片下载的代理列表（与 HTML 一致，只走 CF）
   */
  function getImageProxies(cfWorker, useBuiltin) {
    return getHtmlProxies(cfWorker, useBuiltin);
  }

  // ============================ IndexedDB 短连接 ============================
  // 参考 RocheToolkit v3.2 改动A：每次 openDB 后事务完成立即 close()，不缓存连接
  // 原因：长期缓存 _db 连接可能干扰 Roche 主程序的快照隔离，
  //       导致写入后前端 UI 无法即时刷新。

  function openDB() {
    return new Promise(function(resolve, reject) {
      try {
        const req = indexedDB.open(DB_NAME);
        req.onsuccess = function() { resolve(req.result); };
        req.onerror = function() { reject(req.error); };
      } catch (e) {
        reject(e);
      }
    });
  }

  // 按会话读取所有消息（短连接：事务完成即 close）
  function getMessagesByConversation(conversationId) {
    return openDB().then(function(db) {
      return new Promise(function(resolve, reject) {
        const tx = db.transaction('messages', 'readonly');
        const store = tx.objectStore('messages');
        let req;
        try {
          const idx = store.index('conversationId');
          req = idx.getAll(IDBKeyRange.only(conversationId));
        } catch (e) {
          req = store.getAll();
          req.onsuccess = function() {
            const all = req.result || [];
            resolve(all.filter(function(m) { return m && m.conversationId === conversationId; }));
          };
          req.onerror = function() { reject(req.error); };
          tx.oncomplete = function() { db.close(); };
          return;
        }
        req.onsuccess = function() {
          const arr = req.result || [];
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
        const tx = db.transaction('messages', 'readwrite');
        const req = tx.objectStore('messages').add(msg);
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
        const tx = db.transaction('messages', 'readwrite');
        const req = tx.objectStore('messages').delete(id);
        req.onsuccess = function() { resolve(); };
        req.onerror = function() { reject(req.error); };
        tx.oncomplete = function() { db.close(); };
        tx.onerror = function() { db.close(); };
        tx.onabort = function() { db.close(); };
      });
    });
  }

  // ============================ 小红书链接提取 + HTML 抓取 + 解析（参考 xhs-reader）============================

  /**
   * 从混合文本中提取小红书链接
   * 支持 xhslink.com / xhslink.cn（新版）/ www.xiaohongshu.com
   */
  function extractXhsUrl(text) {
    if (!text) return null;
    const m = text.match(/https?:\/\/(?:xhslink\.(?:com|cn)\/[^\s`'"（()）,。！？；、）)\]》\u4e00-\u9fa5]+|www\.xiaohongshu\.com\/[^\s`'"（()）,。！？；、）)\]》\u4e00-\u9fa5]+)/);
    if (m) {
      return m[0].replace(/[,。！？；，、]+$/, '').trim();
    }
    return null;
  }

  async function fetchXhsHtml(xhsUrl, cfWorker, useBuiltin) {
    const isApk = isApkWebView();
    const isLocal = isBrowserLocalFile();
    log('fetchXhsHtml: 环境=' + (isApk ? 'APK' : '浏览器') + (isLocal ? '(本地文件)' : '') + ', 内置代理=' + (useBuiltin ? '开' : '关') + ', 自定义CF=' + (cfWorker ? '有' : '无'));

    const proxies = getHtmlProxies(cfWorker, useBuiltin);
    if (proxies.length === 0) {
      throw new Error('未配置任何代理（请开启内置代理或配置自定义 CF Worker）');
    }
    log('fetchXhsHtml: 代理顺序 = ' + proxies.map(function(p) { return p.name; }).join(' → '));

    let lastErr = null;
    const errors = [];
    for (let i = 0; i < proxies.length; i++) {
      const proxyName = proxies[i].name;
      const proxyUrl = proxies[i].fn(xhsUrl);
      try {
        log('fetchXhsHtml: [' + proxyName + '] 尝试...');
        const result = await smartFetch(proxyUrl, {}, 15000);
        if (!result.ok) {
          log('fetchXhsHtml: [' + proxyName + '] ' + result.error, 'error');
          errors.push(proxyName + ': ' + result.error);
          lastErr = new Error(result.error);
          continue;
        }
        const resp = result.resp;
        if (!resp.ok) {
          const err = 'HTTP ' + resp.status;
          log('fetchXhsHtml: [' + proxyName + '] ' + err, 'error');
          errors.push(proxyName + ': ' + err);
          lastErr = new Error(err);
          continue;
        }
        const html = await resp.text();
        log('fetchXhsHtml: [' + proxyName + '] OK, ' + html.length + ' 字节');
        if (html && html.includes('__INITIAL_STATE__')) {
          // 严格验证：必须是移动版 HTML（含 commentData）
          if (html.includes('commentData')) {
            log('fetchXhsHtml: [' + proxyName + '] 移动版 HTML（含评论数据），采用', 'success');
            return html;
          }
          log('fetchXhsHtml: [' + proxyName + '] 桌面版 HTML（无 commentData），跳过', 'warn');
          lastErr = new Error('桌面版 HTML 无评论数据');
          errors.push(proxyName + ': 桌面版无评论');
          continue;
        }
        lastErr = new Error('页面未包含 __INITIAL_STATE__');
        errors.push(proxyName + ': 无 __INITIAL_STATE__');
      } catch (e) {
        const errType = e.name === 'AbortError' ? '超时(15s)' : e.message;
        log('fetchXhsHtml: [' + proxyName + '] 异常: ' + errType, 'error');
        errors.push(proxyName + ': ' + errType);
        lastErr = e;
      }
      // 每次代理失败后等 500ms
      if (i < proxies.length - 1) await new Promise(function(r) { setTimeout(r, 500); });
    }
    throw new Error('fetchXhsHtml 所有代理失败: ' + errors.join(' | '));
  }

  function parseXhsState(html) {
    const m = html.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]+?\})\s*<\/script>/);
    if (!m) throw new Error('未找到 __INITIAL_STATE__');
    const jsonStr = m[1].replace(/undefined/g, 'null');
    return JSON.parse(jsonStr);
  }

  function extractNote(state) {
    return (state && state.noteData && state.noteData.data && state.noteData.data.noteData) || null;
  }

  function extractComments(state) {
    return (state && state.noteData && state.noteData.data && state.noteData.data.commentData) || null;
  }

  function normalizeImgUrl(url) {
    if (!url) return '';
    if (url.startsWith('//')) return 'https:' + url;
    if (!url.startsWith('http')) return '';
    return url;
  }

  function extractNoteImages(note) {
    const imgs = [];
    if (note.type === 'video') {
      const cover = (note.video && (note.video.imageUrl || (note.video.coverImage && note.video.coverImage.url))) || '';
      const url = normalizeImgUrl(cover);
      if (url) imgs.push({ url: url, alt: '视频封面' });
    }
    if (note.imageList && note.imageList.length) {
      for (const item of note.imageList.slice(0, MAX_IMAGES)) {
        const url = normalizeImgUrl(item.url || item.urlDefault || '');
        if (url) imgs.push({ url: url, alt: '笔记配图' });
      }
    }
    return imgs;
  }

  function extractTags(note) {
    const tags = [];
    if (note.tagList && note.tagList.length) {
      for (const t of note.tagList) {
        const name = typeof t === 'string' ? t : (t.name || t.id || '');
        if (name) tags.push(name);
      }
    }
    return tags;
  }

  function extractPreview(note, maxLen) {
    maxLen = maxLen || 100;
    const desc = note.desc || '';
    if (desc.length <= maxLen) return desc;
    return desc.substring(0, maxLen) + '...';
  }

  /**
   * 下载图片转 dataURL（多级代理降级，参考 xhs-reader）
   */
  async function downloadImageAsDataUrl(imageUrl, cfWorker, useBuiltin) {
    const proxies = getImageProxies(cfWorker, useBuiltin);
    if (proxies.length === 0) {
      throw new Error('未配置图片代理');
    }

    const errors = [];
    for (let i = 0; i < proxies.length; i++) {
      const proxyName = proxies[i].name;
      const proxyUrl = proxies[i].fn(imageUrl);
      try {
        log('  [' + proxyName + '] 尝试下载图片');
        const result = await smartFetch(proxyUrl, {}, 20000);
        if (!result.ok) {
          log('  [' + proxyName + '] ' + result.error, 'error');
          errors.push(proxyName + ': ' + result.error);
          continue;
        }
        const resp = result.resp;
        if (!resp.ok) {
          const err = 'HTTP ' + resp.status;
          log('  [' + proxyName + '] ' + err, 'error');
          errors.push(proxyName + ': ' + err);
          continue;
        }
        const blob = await resp.blob();
        if (blob.size === 0) {
          log('  [' + proxyName + '] blob 大小为 0', 'error');
          errors.push(proxyName + ': blob为0');
          continue;
        }
        log('  [' + proxyName + '] OK, ' + blob.size + ' 字节, 类型: ' + (blob.type || 'image/jpeg'), 'success');
        const dataUrl = await new Promise(function(resolve, reject) {
          const reader = new FileReader();
          reader.onload = function() { resolve(reader.result); };
          reader.onerror = function() { reject(reader.error); };
          reader.readAsDataURL(blob);
        });
        return dataUrl;
      } catch (e) {
        log('  [' + proxyName + '] 异常: ' + e.message, 'error');
        errors.push(proxyName + ': ' + e.message);
      }
    }
    throw new Error('所有代理失败: ' + errors.join(' | '));
  }

  /**
   * 完整解析小红书链接：抓取 HTML → 提取 state → 提取 note/comments/images/tags
   */
  async function processXhsLinkFull(xhsUrl, cfWorker, useBuiltin) {
    const html = await fetchXhsHtml(xhsUrl, cfWorker, useBuiltin);
    const state = parseXhsState(html);
    const note = extractNote(state);
    if (!note) throw new Error('未找到笔记数据');
    const comments = extractComments(state);
    if (comments && comments.comments && comments.comments.length) {
      log('抓取到 ' + comments.comments.length + ' 条首屏评论', 'success');
    } else {
      log('未抓取到首屏评论（可能为空或 UA 不匹配）', 'warn');
    }
    const images = extractNoteImages(note);
    const tags = extractTags(note);
    const preview = extractPreview(note);
    return { note: note, comments: comments, images: images, tags: tags, preview: preview };
  }

  // ============================ 用户人设（获取分享者名字）===========================

  async function getSharerName() {
    try {
      if (rocheRef && rocheRef.persona && rocheRef.persona.getActiveUserPersona) {
        const p = await rocheRef.persona.getActiveUserPersona();
        return (p && (p.handle || p.name)) || '我';
      }
    } catch (e) {}
    return '我';
  }

  // ============================ Roche 内部状态访问（Pinia / viewStack）============================

  function getPinia() {
    try {
      const selectors = ['#app', '#roche', '[data-v-app]', '#root'];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (!el || !el.__vue_app__) continue;
        const app = el.__vue_app__;
        const gp = (app._context && app._context.config && app._context.config.globalProperties)
                || (app.config && app.config.globalProperties);
        if (gp && gp.$pinia && gp.$pinia._s) return gp.$pinia;
      }
      for (const child of document.body.children) {
        if (!child.__vue_app__) continue;
        const app = child.__vue_app__;
        const gp = (app._context && app._context.config && app._context.config.globalProperties)
                || (app.config && app.config.globalProperties);
        if (gp && gp.$pinia && gp.$pinia._s) return gp.$pinia;
      }
    } catch (e) {}
    return null;
  }

  function findMessagesArrayInPinia(cid) {
    const pinia = getPinia();
    if (!pinia) return null;
    for (const [, store] of pinia._s) {
      const state = store.$state || store;
      if (state[cid] !== undefined && Array.isArray(state[cid])) return state[cid];
      if (store[cid] !== undefined && Array.isArray(store[cid])) return store[cid];
    }
    return null;
  }

  function getViewStackStore() {
    const pinia = getPinia();
    if (!pinia) return null;
    for (const [, store] of pinia._s) {
      if (store.viewStack !== undefined) return store;
    }
    return null;
  }

  // 从 viewStack 获取当前打开的会话 id（只监听当前会话，不做手动选择）
  function getCurrentConversationId() {
    const navStore = getViewStackStore();
    if (navStore && navStore.viewStack && navStore.viewStack.length > 0) {
      const top = navStore.viewStack[navStore.viewStack.length - 1];
      if (top && top.name === 'chat' && top.params && top.params.id) {
        return top.params.id;
      }
    }
    return null;
  }

  // ============================ 刷新聊天界面（三方案降级，参考 xhs-reader）============================

  async function refreshRocheChat(conversationId) {
    try {
      if (!conversationId) return;
      const cid = String(conversationId);

      // 方案 A：Pinia reactive 数组 splice（最佳，无闪烁）
      const piniaArr = findMessagesArrayInPinia(cid);
      if (piniaArr) {
        try {
          const dbMsgs = await getMessagesByConversation(cid);
          if (dbMsgs.length > 0) {
            piniaArr.splice(0, piniaArr.length);
            for (const m of dbMsgs) piniaArr.push(m);
            log('refreshRocheChat: Pinia splice ' + dbMsgs.length + ' 条 OK', 'success');
            return;
          }
        } catch (e) {
          log('refreshRocheChat: Pinia 异常: ' + e.message, 'warn');
        }
      } else {
        log('refreshRocheChat: Pinia 未找到消息数组', 'warn');
      }

      // 方案 B：事件派发兜底
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

      // 方案 C：viewStack pop+push 强制重新挂载 Chat 组件
      const navStore = getViewStackStore();
      if (navStore && navStore.viewStack && navStore.viewStack.length > 0) {
        const top = navStore.viewStack[navStore.viewStack.length - 1];
        if (top && top.name === 'chat' && top.params && top.params.id === cid) {
          navStore.viewStack.pop();
          setTimeout(function() {
            navStore.viewStack.push({ name: 'chat', params: { id: cid } });
          }, 50);
          log('refreshRocheChat: viewStack pop/push 强制刷新 ' + cid, 'success');
          return;
        }
      }

      log('refreshRocheChat: 事件兜底 ' + cid);
    } catch (e) {
      log('refreshRocheChat 失败: ' + e.message, 'error');
    }
  }

  // ============================ 消息注入（参考 xhs-reader：图片消息结构复杂，需严格对齐）============================

  function genMsgId() {
    return 'msg_' + Date.now() + Math.random().toString().slice(1);
  }

  /**
   * 注入文本消息（删除原消息，新增文本消息）
   * 文本消息字段：id, text, isMe, type:'text', timestamp, conversationId
   * 时间戳 = 原消息 + 1（保证排在原消息之后）
   */
  async function injectTextMessage(originalMsg, text) {
    const newMsg = {
      id: genMsgId(),
      text: text,
      isMe: originalMsg.isMe === undefined ? true : originalMsg.isMe,
      type: 'text',
      timestamp: (originalMsg.timestamp || Date.now()) + 1,
      conversationId: originalMsg.conversationId
    };
    if (originalMsg.senderId !== undefined) newMsg.senderId = originalMsg.senderId;
    if (originalMsg.senderName !== undefined) newMsg.senderName = originalMsg.senderName;
    // 关键：删除原消息，容错处理（原消息 id 可能来自官方 API，格式可能不一致）
    if (originalMsg.id) {
      try {
        await deleteMessage(originalMsg.id);
        log('injectTextMessage: 已删除原消息 ' + originalMsg.id);
      } catch (e) {
        log('injectTextMessage: 删除原消息失败 (非致命): ' + e.message, 'warn');
      }
    }
    await addMessage(newMsg);
    log('injectTextMessage: 已注入新消息 ' + newMsg.id + ', 长度 ' + text.length);
    return newMsg;
  }

  /**
   * 注入图片消息（参考 xhs-reader v2.7.0 的图片消息结构）
   *
   * 图片消息字段（与 xhs-reader 完全一致）：
   *   - id: 唯一 ID
   *   - text: '[Image Upload]'  （固定占位文本）
   *   - isMe: 继承原消息（直接用原值，不做兜底）
   *   - content: dataUrl  （图片的 base64 data URL，存这里）
   *   - type: 'image'  （关键：Roche 通过此字段识别图片消息）
   *   - timestamp: 原消息 + 2 + offset  （递增，保证图片排在文本之后，且图片之间有序）
   *   - conversationId: 继承原消息
   *   - isVisionRecognized: false  （标记未被 vision 模型识别过）
   *   - senderId/senderName: 仅当原消息有时才添加
   */
  async function injectImageMessage(originalMsg, imageDataUrl, offset) {
    const imgMsg = {
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

  // ============================ 文本格式化 ============================

  function formatCommentsText(comments) {
    if (!comments || !comments.comments || !comments.comments.length) return '(无评论)';
    const lines = [];
    for (const c of comments.comments.slice(0, 10)) {
      const u = (c.user && (c.user.nickName || c.user.nickname)) || '匿名';
      const t = (c.content || '').trim();
      let line = '- ' + u + '：' + t;
      if (c.likeCount > 0) line += ' (' + c.likeCount + '赞)';
      lines.push(line);
      if (c.subComments && c.subComments.length) {
        for (const sc of c.subComments.slice(0, 2)) {
          const su = (sc.user && (sc.user.nickName || sc.user.nickname)) || '匿名';
          lines.push('  ↳ ' + su + '：' + (sc.content || ''));
        }
      }
    }
    return lines.join('\n');
  }

  function formatNoteText(note, comments, sharerName) {
    const lines = [];
    lines.push(sharerName + '分享了一个小红书笔记：');
    lines.push('');
    lines.push('# ' + (note.title || '(无标题)'));
    lines.push('');
    lines.push(note.desc || '(无正文)');
    lines.push('');
    const tags = extractTags(note);
    if (tags.length > 0) {
      lines.push('标签：' + tags.join(' '));
      lines.push('');
    }
    if (comments && comments.comments && comments.comments.length) {
      lines.push('热门评论：');
      lines.push(formatCommentsText(comments));
    }
    return lines.join('\n');
  }

  // ============================ 直注模式：文本 + 图片 ============================

  async function processMode1(msg, xhsUrl, result, cfWorker, useBuiltin) {
    const note = result.note;
    const comments = result.comments;
    const images = result.images;
    const sharerName = await getSharerName();
    const text = formatNoteText(note, comments, sharerName);

    // 1. 注入文本消息（同时删除原消息）
    const newTextMsg = await injectTextMessage(msg, text);

    // 2. 逐张下载图片并注入（时间戳递增，保证顺序）
    const imageMsgIds = [];
    let imgOk = 0, imgFail = 0;
    for (let i = 0; i < images.length; i++) {
      try {
        log('下载图片 ' + (i + 1) + '/' + images.length);
        const dataUrl = await downloadImageAsDataUrl(images[i].url, cfWorker, useBuiltin);
        const imgMsg = await injectImageMessage(newTextMsg, dataUrl, i);
        imageMsgIds.push(imgMsg.id);
        imgOk++;
      } catch (e) {
        imgFail++;
        log('图片 ' + (i + 1) + ' 失败: ' + e.message, 'error');
      }
    }

    log('处理完成：文本已注入，图片 ' + imgOk + ' 成功 / ' + imgFail + ' 失败', 'success');
    return { textMsgId: newTextMsg.id, imageMsgIds: imageMsgIds, imgOk: imgOk, imgFail: imgFail };
  }

  // ============================ 轮询监听（只监听当前打开的会话）============================

  async function loadProcessedLinks() {
    if (processedLinksLoaded) return;
    processedLinksLoaded = true;
    try {
      if (rocheStorage) {
        const saved = await rocheStorage.get(SK.processedLinks);
        if (saved && typeof saved === 'object') {
          Object.assign(processedLinks, saved);
        }
      }
    } catch (e) {}
  }

  async function saveProcessedLinks() {
    try {
      if (rocheStorage) {
        await rocheStorage.set(SK.processedLinks, processedLinks);
      }
    } catch (e) {}
  }

  async function pollOnce() {
    if (isPolling) return;
    isPolling = true;
    try {
      // 只监听当前打开的会话（从 viewStack 读取）
      const convId = getCurrentConversationId();
      if (!convId) return;

      // 读取设置
      let useBuiltin = true;
      let cfWorker = null;
      try {
        if (rocheStorage) {
          const v = await rocheStorage.get(SK.useBuiltinProxy);
          if (v !== null && v !== undefined) useBuiltin = v !== false && v !== '0' && v !== 0;
          cfWorker = await rocheStorage.get(SK.cfWorker);
        }
      } catch (e) {}

      // 只读最新 3 条消息（避免大量 reactive 更新导致卡顿，参考 xhs-reader）
      let msgs = [];
      try {
        const result = await rocheRef.memory.getShortTerm({
          conversationId: convId,
          limit: 3
        });
        msgs = Array.isArray(result) ? result : (result && result.messages) || [];
      } catch (apiErr) {
        // 官方 API 失败时不回退到 IndexedDB（会加重卡顿）
        return;
      }
      if (msgs.length === 0) return;

      // 只检查最后一条消息（最新发送的）
      const m = msgs[msgs.length - 1];
      // isMe 判断兼容多种字段格式（参考 xhs-reader）
      const isMe = m.isMe === true || m.senderId === 'me' || m.role === 'user' ||
                   (m.senderName === undefined && m.type !== 'assistant');
      if (!isMe) return;
      if (m.type && m.type !== 'text') return;

      const msgText = m.text || m.content || '';
      const url = extractXhsUrl(msgText);
      if (!url) return;

      const msgId = m.id || m.messageId || (convId + '_' + m.timestamp);
      const key = convId + '_' + msgId;
      const now = Date.now();

      // 确保已加载 processedLinks
      await loadProcessedLinks();

      const rec = processedLinks[key];
      if (rec) {
        if (rec.done) return;
        if (rec.processing) return;
        if (rec.fails > 0 && (now - (rec.lastFailTs || 0)) < FAIL_COOLDOWN) return;
        if (rec.fails >= MAX_FAILS) {
          if (!rec.gaveUpLogged) {
            notify('链接已达最大重试次数(' + MAX_FAILS + ')，放弃: ' + url.substring(0, 40) + '...', 'error');
            rec.gaveUpLogged = true;
          }
          return;
        }
        notify('重试处理(第 ' + (rec.fails + 1) + '/' + MAX_FAILS + ' 次): ' + url.substring(0, 40) + '...', 'warn');
      }

      // 标记正在处理
      processedLinks[key] = { processing: true, ts: now, fails: rec ? rec.fails : 0 };
      notify('检测到小红书链接，开始抓取...', 'info');

      try {
        notify('正在抓取小红书内容并下载图片...', 'info');

        // 完整解析小红书链接
        const result = await processXhsLinkFull(url, cfWorker, useBuiltin);

        // 构造伪消息对象供 processMode1 使用
        const fakeMsg = {
          id: msgId,
          text: msgText,
          isMe: true,
          type: 'text',
          timestamp: m.timestamp || Date.now(),
          conversationId: convId
        };
        if (m.senderId !== undefined) fakeMsg.senderId = m.senderId;
        if (m.senderName !== undefined) fakeMsg.senderName = m.senderName;

        // 直注模式：文本 + 图片
        const procResult = await processMode1(fakeMsg, url, result, cfWorker, useBuiltin);

        processedLinks[key] = {
          done: true,
          ts: Date.now(),
          injectTs: m.timestamp || Date.now(),
          convId: convId,
          textMsgId: procResult.textMsgId,
          imageMsgIds: procResult.imageMsgIds
        };
        await saveProcessedLinks();

        const title = (result.note.title || '').substring(0, 30) || '(无标题)';
        notify('注入成功: ' + title + ' (图片 ' + procResult.imgOk + '/' + (procResult.imgOk + procResult.imgFail) + ')', 'success');

        // 刷新聊天界面
        await refreshRocheChat(convId);
      } catch (e) {
        notify('处理失败: ' + e.message, 'error');
        const prevFails = (processedLinks[key] && processedLinks[key].fails) || 0;
        processedLinks[key] = {
          fails: prevFails + 1,
          lastFailTs: Date.now(),
          ts: Date.now()
        };
        await saveProcessedLinks();
        notify('将在 ' + (FAIL_COOLDOWN / 1000) + ' 秒后重试 (已失败 ' + (prevFails + 1) + '/' + MAX_FAILS + ')', 'warn');
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
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
      log('停止后台监听');
    }
  }

  // ============================ 设置读写 ============================

  async function loadSettings() {
    if (!rocheStorage) return { enabled: true, useBuiltinProxy: true, cfWorker: '' };
    const enabled = await rocheStorage.get(SK.enabled);
    const useBuiltinProxy = await rocheStorage.get(SK.useBuiltinProxy);
    const cfWorker = await rocheStorage.get(SK.cfWorker);
    return {
      enabled: enabled === null || enabled === undefined ? true : !!enabled,
      useBuiltinProxy: useBuiltinProxy === null || useBuiltinProxy === undefined ? true : !!useBuiltinProxy,
      cfWorker: cfWorker || ''
    };
  }

  async function saveSettings(settings) {
    if (!rocheStorage) return;
    await rocheStorage.set(SK.enabled, settings.enabled);
    await rocheStorage.set(SK.useBuiltinProxy, settings.useBuiltinProxy);
    await rocheStorage.set(SK.cfWorker, settings.cfWorker);
  }

  // ============================ 设置面板 UI ============================

  function getStyles() {
    return `
.rlr-root {
  width: 100%;
  height: 100%;
  margin: 0;
  padding: 16px;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 12px;
  background: #121212;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  font-size: 14px;
  color: #e0e0e0;
  line-height: 1.5;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
}
.rlr-root::-webkit-scrollbar { width: 6px; }
.rlr-root::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 3px; }
.rlr-card {
  background: rgba(255,255,255,0.05);
  border-radius: 12px;
  padding: 16px;
  border: 1px solid rgba(255,255,255,0.06);
  flex-shrink: 0;
}
.rlr-card-title {
  font-size: 15px;
  font-weight: 600;
  margin: 0 0 12px 0;
  color: #fff;
}
.rlr-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
  min-height: 32px;
}
.rlr-row:last-child { margin-bottom: 0; }
.rlr-label {
  color: rgba(255,255,255,0.7);
  flex-shrink: 0;
  white-space: nowrap;
}
.rlr-input {
  flex: 1;
  min-width: 0;
  padding: 8px 12px;
  background: rgba(255,255,255,0.06);
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 8px;
  color: #fff;
  font-size: 13px;
  outline: none;
}
.rlr-input:focus { border-color: #C20C0C; }
.rlr-toggle {
  width: 44px;
  min-width: 44px;
  height: 24px;
  background: rgba(255,255,255,0.15);
  border-radius: 12px;
  position: relative;
  cursor: pointer;
  flex-shrink: 0;
  transition: background 0.2s;
}
.rlr-toggle.on { background: #C20C0C; }
.rlr-toggle::after {
  content: "";
  position: absolute;
  top: 2px; left: 2px;
  width: 20px; height: 20px;
  border-radius: 50%;
  background: #fff;
  transition: transform 0.2s;
}
.rlr-toggle.on::after { transform: translateX(20px); }
.rlr-btn {
  padding: 8px 16px;
  background: #C20C0C;
  color: #fff;
  border: none;
  border-radius: 8px;
  cursor: pointer;
  font-size: 13px;
  flex-shrink: 0;
}
.rlr-btn:active { transform: scale(0.97); }
.rlr-status {
  font-size: 12px;
  color: rgba(255,255,255,0.5);
  margin-top: 8px;
}
.rlr-status.active { color: #4ade80; }
.rlr-hint {
  font-size: 12px;
  color: rgba(255,255,255,0.4);
  line-height: 1.6;
  margin: 8px 0 0 0;
}
.rlr-log {
  background: rgba(0,0,0,0.3);
  border-radius: 8px;
  padding: 8px;
  max-height: 200px;
  overflow-y: auto;
  font-family: monospace;
  font-size: 11px;
  line-height: 1.5;
}
.rlr-log-line { margin-bottom: 2px; word-break: break-all; }
.rlr-log-time { color: rgba(255,255,255,0.3); margin-right: 6px; }
.rlr-log-info { color: rgba(255,255,255,0.7); }
.rlr-log-success { color: #4ade80; }
.rlr-log-warn { color: #fbbf24; }
.rlr-log-error { color: #f87171; }
`;
  }

  function renderLogs() {
    const el = rootEl ? rootEl.querySelector('#rlr-logs') : null;
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

    // 注入样式
    if (!injectedStyleEl) {
      injectedStyleEl = document.createElement('style');
      injectedStyleEl.textContent = getStyles();
      document.head.appendChild(injectedStyleEl);
    }

    const settings = await loadSettings();

    rootEl.innerHTML = `
      <div class="rlr-card">
        <div class="rlr-card-title">链接解析插件</div>
        <div class="rlr-row">
          <span class="rlr-label">启用后台监听</span>
          <div class="rlr-toggle ${settings.enabled ? 'on' : ''}" id="rlr-enabled-toggle"></div>
        </div>
        <div class="rlr-row">
          <span class="rlr-label">使用内置代理（推荐）</span>
          <div class="rlr-toggle ${settings.useBuiltinProxy ? 'on' : ''}" id="rlr-builtin-toggle"></div>
        </div>
        <div class="rlr-row">
          <span class="rlr-label">自定义 CF Worker（可选）</span>
          <input class="rlr-input" id="rlr-cfworker-input" value="${settings.cfWorker}" placeholder="https://xxx.workers.dev" />
        </div>
        <button class="rlr-btn" id="rlr-save-btn">保存设置</button>
        <div class="rlr-status ${settings.enabled ? 'active' : ''}" id="rlr-status">
          ${settings.enabled ? '监听中（仅当前打开的会话）' : '已停止'}
        </div>
      </div>
      <div class="rlr-card">
        <div class="rlr-card-title">使用说明</div>
        <div class="rlr-hint">
          1. 启用后，插件在后台监听当前打开的聊天会话（切换会话自动跟随）。<br/>
          2. 用户发送小红书链接（xhslink.com / xhslink.cn / xiaohongshu.com）后，插件自动：<br/>
          &nbsp;&nbsp;- 通过三级代理抓取小红书页面 HTML<br/>
          &nbsp;&nbsp;- 提取笔记标题、正文、标签、热门评论<br/>
          &nbsp;&nbsp;- 逐张下载图片转成内嵌图片消息<br/>
          &nbsp;&nbsp;- 删除原消息，注入解析后的文本 + 独立图片消息<br/>
          3. 关闭本面板后监听继续在后台运行。<br/>
          4. char 看不到原始链接，只能看到解析后的内容。<br/>
          5. 内置代理三级降级：CF Pages（国内直连）→ Vercel → CF Worker。
        </div>
      </div>
      <div class="rlr-card">
        <div class="rlr-card-title">免责声明</div>
        <div class="rlr-hint">
          本插件为个人学习用途免费分享，不与任何商业软件捆绑，不依赖 Roche 主程序功能。<br/>
          解析服务仅用于个人学习参考，不得用于商业用途。<br/>
          插件通过内置代理抓取公开网页数据（小红书笔记链接、笔记 HTML、小红书图片），不经过用户隐私数据（聊天内容、角色人设、API Key 均不经过代理）。<br/>
          使用者应确保自身使用行为符合所在地区法律法规，使用本插件即视为同意上述条款。
        </div>
      </div>
      <div class="rlr-card">
        <div class="rlr-card-title">运行日志</div>
        <div class="rlr-log" id="rlr-logs"></div>
      </div>
    `;

    renderLogs();

    // 绑定事件
    const enabledToggle = rootEl.querySelector('#rlr-enabled-toggle');
    const builtinToggle = rootEl.querySelector('#rlr-builtin-toggle');
    const cfworkerInput = rootEl.querySelector('#rlr-cfworker-input');
    const saveBtn = rootEl.querySelector('#rlr-save-btn');
    const statusEl = rootEl.querySelector('#rlr-status');

    enabledToggle.addEventListener('click', async function() {
      settings.enabled = !settings.enabled;
      enabledToggle.classList.toggle('on', settings.enabled);
      statusEl.classList.toggle('active', settings.enabled);
      statusEl.textContent = settings.enabled ? '监听中（仅当前打开的会话）' : '已停止';
      await saveSettings(settings);
      if (settings.enabled) {
        startPolling();
        uiToast('已启用监听');
      } else {
        stopPolling();
        uiToast('已停止监听');
      }
    });

    builtinToggle.addEventListener('click', function() {
      settings.useBuiltinProxy = !settings.useBuiltinProxy;
      builtinToggle.classList.toggle('on', settings.useBuiltinProxy);
    });

    saveBtn.addEventListener('click', async function() {
      settings.cfWorker = (cfworkerInput.value || '').trim();
      await saveSettings(settings);
      uiToast('设置已保存');
    });

    // 根据设置启动监听
    if (settings.enabled) {
      startPolling();
    }
  }

  // ============================ 插件注册 ============================

  window.RochePlugin = window.RochePlugin || {};

  window.RochePlugin.register({
    id: PLUGIN_ID,
    name: '链接解析',
    version: '2.2.0',
    apps: [
      {
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
          // 关闭面板时保留监听，监听继续在后台运行（参考 xhs-reader）
          rootEl = null;
          container.replaceChildren();
        }
      }
    ]
    // 不声明 chat.tools / chat.promptOnly / chat.contextProvider
    // 纯后台 DB 直注，char 看不到原始链接
    // 不使用 onLoad/onUnload（Roche 可能不调用，参考 xhs-reader）
  });

})();
