/**
 * Roche 链接解析插件 v2.0
 *
 * 纯直注模式：只监听当前打开的会话，检测到链接 → 解析 → 注入文本+图片 → 删除原消息 → 刷新界面
 * 支持小红书 / 微博 / B站 / 知乎 / 通用链接
 * 关闭设置面板后继续后台监听（参考 xhs-reader 设计）
 *
 * 核心流程：
 *   1. pollForLinks() 每 2 秒读当前会话最新 3 条消息
 *   2. 检测到最后一条消息含链接 → 解析后端
 *   3. 下载图片转 base64（小红书/微博）
 *   4. 注入文本消息 + 图片消息到数据库
 *   5. 删除原始链接消息（char 看不到原链接，只看到注入内容）
 *   6. refreshRocheChat() 刷新聊天界面（Pinia splice 优先，无闪烁）
 */
(function () {
  'use strict';

  // ============================ 常量 ============================
  const PLUGIN_ID = 'roche-link-reader';
  const APP_ID = 'roche-link-reader-home';
  const DEFAULT_BACKEND = 'https://456.chajianreader.cc.cd';
  const DB_NAME = 'Roche_db';
  const POLL_INTERVAL = 2000;          // 后台轮询间隔
  const MAX_DIRECT_IMAGES = 9;         // 直注最多图片数
  const FAIL_COOLDOWN = 5000;          // 失败冷却 5 秒
  const MAX_FAILS = 5;                 // 最大重试次数

  // 链接检测正则
  const LINK_REGEX = /https?:\/\/[^\s<>"'.,;:!?)）】》]+/gi;
  const XHS_REGEX = /https?:\/\/(xhslink\.com|xhslink\.cn|xiaohongshu\.com|xhscdn\.com)\/[^\s<>"']+/i;
  const WEIBO_REGEX = /https?:\/\/(weibo\.com|weibo\.cn|m\.weibo\.cn|t\.cn)\/[^\s<>"']+/i;
  const BILI_REGEX = /https?:\/\/(bilibili\.com|b23\.tv|bilibili\.tv)\/[^\s<>"']+/i;
  const ZHIHU_REGEX = /https?:\/\/(zhihu\.com|zhuanlan\.zhihu\.com)\/[^\s<>"']+/i;

  // storage 键
  const SK = {
    enabled: 'rlr_enabled',            // 总开关
    backend: 'rlr_backend',            // 后端地址
    parsedLinks: 'rlr_parsed_links'    // 已解析链接缓存
  };

  // ============================ 运行时状态 ============================
  let rocheRef = null;                 // roche API 引用（持久化，不随面板关闭失效）
  let pollTimer = null;                // 后台轮询定时器
  let isPolling = false;               // 全局锁，防止并发
  const processedLinks = {};           // { key: { processing, done, fails, lastFailTs, ts } }
  let _db = null;                      // IndexedDB 连接缓存
  let dbWarned = false;
  let injectedStyleEl = null;

  // ============================ 工具函数 ============================

  // 提取文本中所有链接
  function extractLinks(text) {
    if (!text) return [];
    const matches = String(text).match(LINK_REGEX);
    return matches ? matches.slice() : [];
  }

  // 判断链接平台
  function detectPlatform(link) {
    if (XHS_REGEX.test(link)) return 'xiaohongshu';
    if (WEIBO_REGEX.test(link)) return 'weibo';
    if (BILI_REGEX.test(link)) return 'bilibili';
    if (ZHIHU_REGEX.test(link)) return 'zhihu';
    return 'general';
  }

  // 提取文本中第一个支持的链接（小红书/微博/B站/知乎/通用）
  function extractFirstSupportedLink(text) {
    const links = extractLinks(text);
    for (const link of links) {
      // 过滤掉明显不是内容链接的（如图片url）
      if (XHS_REGEX.test(link) || WEIBO_REGEX.test(link) || BILI_REGEX.test(link) || ZHIHU_REGEX.test(link)) {
        return link;
      }
    }
    // 没有匹配特定平台，取第一个通用链接
    return links.length > 0 ? links[0] : null;
  }

  // blob 转 dataURL
  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  // 调用 roche.ui.toast
  function uiToast(msg) {
    try {
      if (rocheRef && rocheRef.ui && typeof rocheRef.ui.toast === 'function') {
        rocheRef.ui.toast(msg);
      }
    } catch (e) {}
  }

  // 下载图片转 dataURL（走代理绕过 CORS）
  async function downloadImageAsDataUrl(imageUrl, backend) {
    const base = backend || DEFAULT_BACKEND;
    let referer = 'https://weibo.com';
    const lower = String(imageUrl).toLowerCase();
    if (lower.indexOf('xhscdn.com') >= 0 || lower.indexOf('xiaohongshu.com') >= 0) {
      referer = 'https://www.xiaohongshu.com';
    } else if (lower.indexOf('sinaimg.cn') >= 0 || lower.indexOf('weibo.com') >= 0) {
      referer = 'https://weibo.com';
    }
    // 优先走 /debug 代理
    try {
      const proxyUrl = `${base}/debug?url=${encodeURIComponent(imageUrl)}&referer=${encodeURIComponent(referer)}`;
      const resp = await fetch(proxyUrl);
      if (resp.ok) {
        const blob = await resp.blob();
        if (blob && blob.size > 0) return await blobToDataUrl(blob);
      }
    } catch (e) {}
    // 兜底：直接 fetch
    const resp2 = await fetch(imageUrl, { mode: 'cors' });
    const blob2 = await resp2.blob();
    return await blobToDataUrl(blob2);
  }

  // 调用后端解析链接
  async function parseLink(link, backend) {
    const base = backend || DEFAULT_BACKEND;
    const url = `${base}/?url=${encodeURIComponent(link)}`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    let resp;
    try {
      resp = await fetch(url, { signal: ctrl.signal });
    } finally {
      clearTimeout(t);
    }
    if (!resp.ok) throw new Error('解析接口返回状态 ' + resp.status);
    return await resp.json();
  }

  // HTML 转义
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  // 生成消息 id
  function genMsgId() {
    return `msg_${Date.now()}${Math.random().toString().slice(1)}`;
  }

  // ============================ IndexedDB ============================

  function warnDbUnavailable() {
    if (dbWarned) return;
    dbWarned = true;
    uiToast('当前环境不支持 IndexedDB，直注功能不可用');
  }

  function openDB() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      try {
        const req = indexedDB.open(DB_NAME);
        req.onupgradeneeded = function () {};
        req.onsuccess = function () { _db = req.result; resolve(_db); };
        req.onerror = function () { warnDbUnavailable(); reject(req.error); };
      } catch (e) {
        warnDbUnavailable();
        reject(e);
      }
    });
  }

  async function getMessagesByConversation(conversationId) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('messages', 'readonly');
      const store = tx.objectStore('messages');
      let req;
      try {
        const idx = store.index('conversationId');
        req = idx.getAll(IDBKeyRange.only(conversationId));
      } catch (e) {
        req = store.getAll();
        req.onsuccess = () => {
          const all = req.result || [];
          resolve(all.filter(m => m && m.conversationId === conversationId).sort((a, b) => a.timestamp - b.timestamp));
        };
        req.onerror = () => reject(req.error);
        return;
      }
      req.onsuccess = () => {
        const all = req.result || [];
        all.sort((a, b) => a.timestamp - b.timestamp);
        resolve(all);
      };
      req.onerror = () => reject(req.error);
    });
  }

  async function addMessage(msg) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const req = db.transaction('messages', 'readwrite').objectStore('messages').add(msg);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function deleteMessage(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const req = db.transaction('messages', 'readwrite').objectStore('messages').delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  // ============================ Pinia 访问（参考 xhs-reader）============================

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

  // 从 viewStack 获取当前打开的会话 id
  function getCurrentConversationIdFromNav() {
    const navStore = getViewStackStore();
    if (navStore && navStore.viewStack && navStore.viewStack.length > 0) {
      const top = navStore.viewStack[navStore.viewStack.length - 1];
      if (top && top.name === 'chat' && top.params && top.params.id) {
        return top.params.id;
      }
    }
    return null;
  }

  // ============================ 刷新聊天界面（三方案降级）============================

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
            return;
          }
        } catch (e) {}
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
      setTimeout(() => {
        try {
          window.dispatchEvent(new CustomEvent('roche-messages-updated', {
            detail: { conversationId: cid, source: 'roche-link-reader' }
          }));
        } catch (e) {}
      }, 100);

      // 方案 C：viewStack pop+push 强制重新挂载
      const navStore = getViewStackStore();
      if (navStore && navStore.viewStack && navStore.viewStack.length > 0) {
        const top = navStore.viewStack[navStore.viewStack.length - 1];
        if (top && top.name === 'chat' && top.params && top.params.id === cid) {
          navStore.viewStack.pop();
          setTimeout(() => {
            navStore.viewStack.push({ name: 'chat', params: { id: cid } });
          }, 50);
          return;
        }
      }
    } catch (e) {}
  }

  // ============================ 消息注入 ============================

  // 注入文本消息（删除原消息）
  async function injectTextMessage(originalMsg, text) {
    const newMsg = {
      id: genMsgId(),
      text,
      isMe: originalMsg.isMe === undefined ? true : originalMsg.isMe,
      type: 'text',
      timestamp: (originalMsg.timestamp || Date.now()) + 1,
      conversationId: originalMsg.conversationId,
      _rlr_injected: true
    };
    if (originalMsg.senderId !== undefined) newMsg.senderId = originalMsg.senderId;
    if (originalMsg.senderName !== undefined) newMsg.senderName = originalMsg.senderName;
    // 先删原消息（容错）
    if (originalMsg.id) {
      try { await deleteMessage(originalMsg.id); } catch (e) {}
    }
    await addMessage(newMsg);
    return newMsg;
  }

  // 注入图片消息
  async function injectImageMessage(originalMsg, imageDataUrl, offset) {
    const imgMsg = {
      id: genMsgId(),
      text: '[Image Upload]',
      isMe: originalMsg.isMe === undefined ? true : originalMsg.isMe,
      content: imageDataUrl,
      type: 'image',
      timestamp: (originalMsg.timestamp || Date.now()) + 2 + (offset || 0),
      conversationId: originalMsg.conversationId,
      isVisionRecognized: false,
      _rlr_injected: true
    };
    if (originalMsg.senderId !== undefined) imgMsg.senderId = originalMsg.senderId;
    if (originalMsg.senderName !== undefined) imgMsg.senderName = originalMsg.senderName;
    await addMessage(imgMsg);
    return imgMsg;
  }

  // ============================ 文本格式化 ============================

  // 构建直注文本（所有平台通用）
  function buildDirectInjectionText(data, link) {
    const lines = [];
    const platform = data.platform || detectPlatform(link);
    const platformName = {
      xiaohongshu: '小红书笔记',
      weibo: '微博',
      bilibili: 'B站',
      zhihu: '知乎',
      general: '网页'
    }[platform] || '网页';

    lines.push(`【${platformName}】`);
    lines.push('链接：' + link);
    if (data.title) lines.push('标题：' + data.title);
    if (data.desc) lines.push('正文：' + data.desc);
    if (data.content) lines.push('内容：' + data.content);
    if (data.author) {
      const a = data.author;
      const name = a.nickname || a.name || '';
      const uid = a.userId || a.mid || '';
      lines.push('作者：' + name + (uid ? '（' + uid + '）' : ''));
      if (a.description) lines.push('作者简介：' + a.description);
      if (a.verified) lines.push('认证：' + a.verified);
    }
    if (data.tags && data.tags.length) lines.push('标签：' + data.tags.join('、'));
    if (data.likedCount !== undefined) lines.push('点赞：' + data.likedCount);
    if (data.collectedCount !== undefined) lines.push('收藏：' + data.collectedCount);
    if (data.commentCount !== undefined) lines.push('评论数：' + data.commentCount);
    if (data.shareCount !== undefined) lines.push('分享：' + data.shareCount);
    if (data.time) lines.push('发布时间：' + data.time);
    if (data.source) lines.push('来源：' + data.source);
    if (data.video) lines.push('视频：' + (typeof data.video === 'string' ? data.video : '有视频'));
    if (data.cover) lines.push('封面：' + data.cover);
    if (data.duration) lines.push('时长：' + data.duration);
    if (data.pubdate) lines.push('发布时间：' + data.pubdate);
    if (data.images && data.images.length) {
      lines.push('图片数量：' + data.images.length + '（已作为图片消息发送）');
    }
    if (data.subtitle && data.subtitle.available) {
      lines.push('字幕可用：' + (data.subtitle.lan || ''));
      if (data.subtitle.text) lines.push('字幕内容：\n' + data.subtitle.text);
    }
    // 评论
    if (data.comments && data.comments.length) {
      lines.push('热门评论：');
      data.comments.slice(0, 10).forEach((c, i) => {
        const who = c.nickname || c.user?.nickName || c.user?.nickname || '匿名';
        const cnt = c.likedCount !== undefined || c.likeCount !== undefined ? '（赞 ' + (c.likedCount || c.likeCount) + '）' : '';
        const when = c.time ? ' ' + c.time : '';
        lines.push('  ' + (i + 1) + '. ' + who + cnt + when + '：' + (c.content || ''));
      });
    }
    // 转发微博
    if (data.retweeted) {
      lines.push('转发的微博：');
      if (data.retweeted.author) lines.push('  原作者：' + data.retweeted.author);
      if (data.retweeted.text) lines.push('  原文：' + data.retweeted.text);
      if (data.retweeted.images && data.retweeted.images.length) {
        lines.push('  原文图片数量：' + data.retweeted.images.length);
      }
    }
    if (data.postUrl) lines.push('原文：' + data.postUrl);
    return lines.join('\n');
  }

  // ============================ 直注处理 ============================

  async function handleDirectInjection(originalMsg, link, convId, backend) {
    try {
      const data = await parseLink(link, backend);
      await cacheParsedLink(link, data);

      // 构建文本
      const textContent = buildDirectInjectionText(data, link);

      // 下载图片（小红书/微博/B站封面等）
      const dataUrls = [];
      const images = (data.images || []).slice(0, MAX_DIRECT_IMAGES);
      let imgFailed = false;
      for (const img of images) {
        const imgUrl = img && (img.url || img);
        if (!imgUrl) continue;
        try {
          const dataUrl = await downloadImageAsDataUrl(imgUrl, backend);
          if (dataUrl) dataUrls.push(dataUrl);
        } catch (e) {
          imgFailed = true;
        }
      }

      // 注入文本消息（同时删除原消息）
      const textMsg = await injectTextMessage(originalMsg, textContent);

      // 逐张注入图片消息
      for (let i = 0; i < dataUrls.length; i++) {
        try {
          await injectImageMessage(textMsg, dataUrls[i], i);
        } catch (e) {}
      }

      if (imgFailed) uiToast('部分图片下载失败');

      // 刷新聊天界面
      await refreshRocheChat(convId);
    } catch (e) {
      console.warn('[roche-link-reader] 直注失败', e);
      throw e;
    }
  }

  // ============================ 后台轮询 ============================

  async function pollForLinks() {
    if (!rocheRef) return;
    // 全局锁
    if (isPolling) return;
    isPolling = true;
    try {
      const settings = await loadSettings();
      // 总开关关闭则跳过
      if (settings.enabled === false) return;

      // 只监听当前打开的会话
      const convId = getCurrentConversationIdFromNav();
      if (!convId) return;

      // 读取最新 3 条消息（只看最后一条，避免大量 reactive 更新）
      let msgs = [];
      try {
        const result = await rocheRef.memory.getShortTerm({
          conversationId: convId,
          limit: 3
        });
        msgs = Array.isArray(result) ? result : (result && result.messages) || [];
      } catch (apiErr) {
        return;
      }
      if (!msgs || msgs.length === 0) return;

      const m = msgs[msgs.length - 1];

      // 只处理 user 自己发的消息
      const isMe = m.isMe === true || m.senderId === 'me' || m.role === 'user'
                || (m.senderName === undefined && m.type !== 'assistant');
      if (!isMe) return;
      if (m.type && m.type !== 'text') return;
      // 跳过本插件注入的消息
      if (m._rlr_injected === true) return;

      const text = m.text || m.content || '';
      if (!text) return;

      // 提取第一个支持的链接
      const link = extractFirstSupportedLink(text);
      if (!link) return;

      const msgId = m.id || m.messageId || (convId + '_' + (m.timestamp || Date.now()));
      const key = convId + '_' + msgId;
      const now = Date.now();

      // 失败冷却/重试控制
      const rec = processedLinks[key];
      if (rec) {
        if (rec.done) return;
        if (rec.processing) return;
        if (rec.fails > 0 && (now - (rec.lastFailTs || 0)) < FAIL_COOLDOWN) return;
        if (rec.fails >= MAX_FAILS) return;
      }

      // 标记正在处理
      processedLinks[key] = { processing: true, ts: now, fails: rec ? rec.fails : 0 };

      // 构造伪消息对象
      const fakeMsg = {
        id: msgId,
        text: text,
        isMe: true,
        type: 'text',
        timestamp: m.timestamp || Date.now(),
        conversationId: convId
      };
      if (m.senderId !== undefined) fakeMsg.senderId = m.senderId;
      if (m.senderName !== undefined) fakeMsg.senderName = m.senderName;

      // 异步处理
      try {
        await handleDirectInjection(fakeMsg, link, convId, settings.backend);
        processedLinks[key] = { done: true, ts: Date.now() };
        // 定期清理 processedLinks（保留 200 条）
        const keys = Object.keys(processedLinks);
        if (keys.length > 200) {
          keys.slice(0, keys.length - 200).forEach(k => delete processedLinks[k]);
        }
      } catch (e) {
        const prevFails = processedLinks[key] ? processedLinks[key].fails : 0;
        processedLinks[key] = {
          fails: prevFails + 1,
          lastFailTs: Date.now(),
          ts: Date.now()
        };
        uiToast('链接解析失败（第 ' + (prevFails + 1) + ' 次）：' + (e.message || ''));
      }
    } catch (e) {
      // 轮询失败静默
    } finally {
      isPolling = false;
    }
  }

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(pollForLinks, POLL_INTERVAL);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  // ============================ 设置读写 ============================

  function defaultSettings() {
    return {
      enabled: true,
      backend: DEFAULT_BACKEND,
      parsedLinks: []
    };
  }

  async function loadSettings() {
    const s = defaultSettings();
    if (!rocheRef || !rocheRef.storage) return s;
    try {
      const enabled = await rocheRef.storage.get(SK.enabled);
      s.enabled = (enabled === null || enabled === undefined) ? true : !!enabled;
      const backend = await rocheRef.storage.get(SK.backend);
      if (backend) s.backend = backend;
      const parsedLinks = await rocheRef.storage.get(SK.parsedLinks);
      if (Array.isArray(parsedLinks)) s.parsedLinks = parsedLinks;
    } catch (e) {}
    return s;
  }

  async function cacheParsedLink(link, data) {
    if (!rocheRef || !rocheRef.storage) return;
    try {
      const settings = await loadSettings();
      let list = (settings.parsedLinks || []).filter(item => item && item.link !== link);
      list.unshift({
        link: link,
        platform: data && data.platform,
        title: data && data.title,
        time: Date.now(),
        data: data
      });
      list = list.slice(0, 50);
      await rocheRef.storage.set(SK.parsedLinks, list);
    } catch (e) {}
  }

  // ============================ 设置面板 UI ============================

  const PANEL_CSS = `
.rlr-root { all: initial; }
.rlr-root * { box-sizing: border-box; }
.rlr-root {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", Roboto, Helvetica, Arial, sans-serif;
  position: fixed; top: 0; right: 0; bottom: 0; left: 0; z-index: 9999;
  color: #2b2b2b; font-size: 14px; line-height: 1.6;
  overflow-y: auto; padding: 24px;
}
.rlr-bg {
  position: fixed; top: 0; right: 0; bottom: 0; left: 0; z-index: -1;
  background: linear-gradient(135deg, #f6eaea 0%, #f3f0ec 45%, #eef1f4 100%);
}
.rlr-card {
  max-width: 720px; margin: 0 auto;
  background: rgba(255,255,255,0.62);
  backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
  border: 1px solid rgba(255,255,255,0.7);
  border-radius: 16px; padding: 24px 26px;
  box-shadow: 0 10px 40px rgba(139,58,58,0.10);
}
.rlr-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
.rlr-header-right { display: flex; align-items: center; gap: 12px; }
.rlr-close-btn { min-width: 44px; min-height: 44px; padding: 0 14px; border: 1.5px solid rgba(139,58,58,.18); border-radius: 12px; background: rgba(255,255,255,.6); color: #8b3a3a; font-size: 13px; font-weight: 600; cursor: pointer; transition: all .2s ease; }
.rlr-close-btn:hover { background: rgba(139,58,58,.12); }
.rlr-title { font-size: 20px; font-weight: 700; color: #8b3a3a; letter-spacing: .5px; }
.rlr-sub { font-size: 12px; color: #9a8a8a; }
.rlr-divider { height: 1px; background: linear-gradient(90deg, rgba(139,58,58,.18), transparent); margin: 14px 0 18px; }
.rlr-section { margin-bottom: 22px; }
.rlr-section-title { font-size: 15px; font-weight: 600; color: #6a2f2f; margin-bottom: 10px; }
.rlr-desc { font-size: 12px; color: #8a7d7d; margin-bottom: 10px; }

.rlr-field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; }
.rlr-label { font-size: 13px; color: #5a5050; font-weight: 500; }
.rlr-input {
  width: 100%; padding: 10px 12px; border: 1.5px solid rgba(139,58,58,.18);
  border-radius: 12px; background: rgba(255,255,255,0.75); color: #2b2b2b;
  font-size: 13px; transition: all .2s ease; outline: none;
}
.rlr-input:focus { border-color: #8b3a3a; background: #fff; }
.rlr-row { display: flex; gap: 8px; align-items: center; }
.rlr-row .rlr-input { flex: 1; }

.rlr-btn {
  padding: 9px 16px; border: none; border-radius: 12px; cursor: pointer;
  background: #8b3a3a; color: #fff; font-size: 13px; font-weight: 600;
  transition: all .2s ease; white-space: nowrap;
}
.rlr-btn:hover { background: #7a3030; transform: translateY(-1px); }
.rlr-btn:active { transform: translateY(0); }
.rlr-btn.ghost { background: rgba(139,58,58,.08); color: #8b3a3a; }
.rlr-btn.ghost:hover { background: rgba(139,58,58,.16); }
.rlr-btn.sm { padding: 7px 12px; font-size: 12px; }
.rlr-btn:disabled { opacity: .5; cursor: not-allowed; transform: none; }

.rlr-toggle { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 14px; border-radius: 12px; background: rgba(255,255,255,.55); border: 1.5px solid rgba(139,58,58,.14); }
.rlr-toggle .tt-text { font-size: 13px; }
.rlr-toggle .tt-text b { color: #6a2f2f; }
.rlr-toggle .tt-text span { display:block; font-size: 11px; color: #8a7d7d; }
.rlr-switch { position: relative; width: 56px; height: 32px; flex: none; }
.rlr-switch input { display: none; }
.rlr-slider { position: absolute; top: 0; right: 0; bottom: 0; left: 0; background: #cdb6b6; border-radius: 999px; transition: .2s ease; cursor: pointer; }
.rlr-slider::before { content: ""; position: absolute; width: 26px; height: 26px; left: 3px; top: 3px; background: #fff; border-radius: 50%; transition: .2s ease; }
.rlr-switch input:checked + .rlr-slider { background: #8b3a3a; }
.rlr-switch input:checked + .rlr-slider::before { transform: translateX(24px); }

.rlr-link-list { display: flex; flex-direction: column; gap: 8px; max-height: 280px; overflow-y: auto; }
.rlr-link-item { padding: 10px 12px; border-radius: 12px; background: rgba(255,255,255,.55); border: 1px solid rgba(139,58,58,.12); cursor: pointer; transition: all .2s ease; }
.rlr-link-item:hover { border-color: #8b3a3a; background: rgba(139,58,58,.05); }
.rlr-link-item .li-top { display: flex; justify-content: space-between; gap: 8px; }
.rlr-link-item .li-plat { font-size: 11px; color: #8b3a3a; font-weight: 600; }
.rlr-link-item .li-time { font-size: 11px; color: #9a8a8a; }
.rlr-link-item .li-title { font-size: 13px; color: #3a3434; margin-top: 3px; word-break: break-all; }
.rlr-link-item .li-url { font-size: 11px; color: #a99; margin-top: 3px; word-break: break-all; }
.rlr-empty { font-size: 12px; color: #9a8a8a; padding: 14px; text-align: center; }

.rlr-test-result {
  margin-top: 10px; border-radius: 12px; background: rgba(255,255,255,.55);
  border: 1.5px solid rgba(139,58,58,.12); overflow: hidden; display: none;
}
.rlr-test-result.show { display: block; }
.rlr-test-result .tr-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 14px; border-bottom: 1px solid rgba(139,58,58,.10); }
.rlr-test-result .tr-status { font-size: 12px; font-weight: 600; }
.rlr-test-result .tr-status.ok { color: #2d8b5a; }
.rlr-test-result .tr-status.err { color: #c0392b; }
.rlr-test-result .tr-platform { font-size: 11px; color: #8b3a3a; font-weight: 600; }
.rlr-test-result .tr-body { padding: 10px 14px; max-height: 300px; overflow-y: auto; }
.rlr-test-result .tr-body pre { white-space: pre-wrap; word-break: break-all; font-size: 12px; line-height: 1.55; color: #3a3434; margin: 0; }
.rlr-test-result .tr-title { font-size: 13px; font-weight: 600; color: #6a2f2f; margin-bottom: 4px; }
.rlr-test-result .tr-images { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.rlr-test-result .tr-images img { width: 72px; height: 72px; object-fit: cover; border-radius: 8px; border: 1px solid rgba(139,58,58,.12); }
.rlr-modal-mask { position: fixed; top: 0; right: 0; bottom: 0; left: 0; background: rgba(40,20,20,.35); backdrop-filter: blur(4px); display: flex; align-items: center; justify-content: center; z-index: 10000; }
.rlr-modal { width: min(560px, 92vw); max-height: 80vh; overflow: auto; background: rgba(255,255,255,.9); backdrop-filter: blur(20px); border-radius: 16px; padding: 20px; box-shadow: 0 16px 50px rgba(0,0,0,.2); }
.rlr-modal pre { white-space: pre-wrap; word-break: break-all; font-size: 12px; line-height: 1.5; color: #3a3434; }

.rlr-toast { position: fixed; left: 50%; bottom: 40px; transform: translateX(-50%); background: rgba(60,30,30,.92); color: #fff; padding: 10px 18px; border-radius: 999px; font-size: 13px; z-index: 10001; opacity: 0; transition: opacity .2s ease, bottom .2s ease; }
.rlr-toast.show { opacity: 1; bottom: 52px; }

.rlr-status-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; vertical-align: middle; }
.rlr-status-dot.on { background: #2d8b5a; box-shadow: 0 0 6px rgba(45,139,90,.5); }
.rlr-status-dot.off { background: #bbb; }

@media (max-width: 600px) {
  .rlr-root { padding: 12px; }
  .rlr-card { padding: 16px; }
  .rlr-btn { padding: 11px 16px; }
  .rlr-btn.sm { padding: 12px 16px; }
  .rlr-input { padding: 12px; font-size: 14px; }
  .rlr-link-item { padding: 14px; }
}
`;

  function showToast(root, msg) {
    let t = root.querySelector('.rlr-toast');
    if (!t) {
      t = document.createElement('div');
      t.className = 'rlr-toast';
      root.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.remove('show'), 1800);
  }

  function renderLinkList(root, parsedLinks) {
    const box = root.querySelector('#rlr-link-list');
    if (!box) return;
    if (!parsedLinks || !parsedLinks.length) {
      box.innerHTML = '<div class="rlr-empty">暂无已解析链接</div>';
      return;
    }
    box.innerHTML = '';
    parsedLinks.forEach(item => {
      const el = document.createElement('div');
      el.className = 'rlr-link-item';
      const plat = item.platform || 'general';
      const title = item.title || '(无标题)';
      const time = item.time ? new Date(item.time).toLocaleString('zh-CN') : '';
      el.innerHTML =
        '<div class="li-top"><span class="li-plat">' + escapeHtml(plat) + '</span>' +
        '<span class="li-time">' + escapeHtml(time) + '</span></div>' +
        '<div class="li-title">' + escapeHtml(title) + '</div>' +
        '<div class="li-url">' + escapeHtml(item.link || '') + '</div>';
      el.addEventListener('click', () => openDetailModal(root, item));
      box.appendChild(el);
    });
  }

  function openDetailModal(root, item) {
    closeDetailModal(root);
    const mask = document.createElement('div');
    mask.className = 'rlr-modal-mask';
    const modal = document.createElement('div');
    modal.className = 'rlr-modal';
    const pretty = (() => {
      try { return JSON.stringify(item.data || item, null, 2); } catch (e) { return String(item.data || item); }
    })();
    modal.innerHTML =
      '<div class="rlr-row" style="justify-content:space-between;margin-bottom:10px">' +
      '<b style="color:#8b3a3a">' + escapeHtml(item.title || '(无标题)') + '</b>' +
      '<button class="rlr-btn sm ghost" id="rlr-modal-close">关闭</button></div>' +
      '<div style="font-size:12px;color:#9a8a8a;word-break:break-all;margin-bottom:8px">' + escapeHtml(item.link || '') + '</div>' +
      '<pre>' + escapeHtml(pretty) + '</pre>';
    mask.appendChild(modal);
    mask.addEventListener('click', e => { if (e.target === mask) closeDetailModal(root); });
    root.appendChild(mask);
    modal.querySelector('#rlr-modal-close').addEventListener('click', () => closeDetailModal(root));
  }

  function closeDetailModal(root) {
    const mask = root.querySelector('.rlr-modal-mask');
    if (mask) mask.remove();
  }

  async function refreshPanelState(root) {
    if (!rocheRef) return;
    const settings = await loadSettings();
    const tog = root.querySelector('#rlr-enabled-toggle');
    if (tog) tog.checked = !!settings.enabled;
    const be = root.querySelector('#rlr-backend');
    if (be) be.value = settings.backend;
    // 状态指示
    const statusEl = root.querySelector('#rlr-status-text');
    if (statusEl) {
      statusEl.innerHTML = settings.enabled
        ? '<span class="rlr-status-dot on"></span>监听中（当前会话）'
        : '<span class="rlr-status-dot off"></span>已关闭';
    }
    renderLinkList(root, settings.parsedLinks);
  }

  function buildPanel(container, roche) {
    const root = document.createElement('div');
    root.className = 'rlr-root rlr-scope';

    const bg = document.createElement('div');
    bg.className = 'rlr-bg';
    root.appendChild(bg);

    const card = document.createElement('div');
    card.className = 'rlr-card';
    card.innerHTML =
      '<div class="rlr-header">' +
        '<div class="rlr-title">链接解析</div>' +
        '<div class="rlr-header-right"><span class="rlr-sub">v2.0</span>' +
          '<button class="rlr-close-btn" id="rlr-close-app" type="button">关闭</button>' +
        '</div>' +
      '</div>' +
      '<div class="rlr-divider"></div>' +

      '<div class="rlr-section">' +
        '<div class="rlr-section-title">运行状态</div>' +
        '<div class="rlr-desc">插件只监听当前打开的会话，检测到链接后自动解析并替换为内容（文本+图片）。关闭此面板后监听继续在后台运行。</div>' +
        '<div class="rlr-toggle">' +
          '<div class="tt-text"><b id="rlr-status-text"><span class="rlr-status-dot on"></span>监听中（当前会话）</b><span>开启后自动解析当前会话中的小红书/微博/B站/知乎/通用链接</span></div>' +
          '<label class="rlr-switch"><input type="checkbox" id="rlr-enabled-toggle" checked /><span class="rlr-slider"></span></label>' +
        '</div>' +
      '</div>' +

      '<div class="rlr-section">' +
        '<div class="rlr-section-title">后端解析地址</div>' +
        '<div class="rlr-desc">链接解析后端地址，默认 https://456.chajianreader.cc.cd</div>' +
        '<div class="rlr-row">' +
          '<input type="text" class="rlr-input" id="rlr-backend" placeholder="https://456.chajianreader.cc.cd" />' +
          '<button class="rlr-btn sm" id="rlr-backend-save">保存</button>' +
        '</div>' +
      '</div>' +

      '<div class="rlr-section">' +
        '<div class="rlr-section-title">测试解析</div>' +
        '<div class="rlr-desc">输入任意链接（小红书 / 微博 / B站 / 知乎 / 通用），点击测试解析，查看后端返回内容是否正常。</div>' +
        '<div class="rlr-row">' +
          '<input type="text" class="rlr-input" id="rlr-test-input" placeholder="粘贴链接，如 http://xhslink.cn/o/..." />' +
          '<button class="rlr-btn sm" id="rlr-test-btn">测试解析</button>' +
        '</div>' +
        '<div class="rlr-test-result" id="rlr-test-result"></div>' +
      '</div>' +

      '<div class="rlr-section">' +
        '<div class="rlr-section-title">已解析链接</div>' +
        '<div class="rlr-desc">最近解析的链接，点击查看详情。</div>' +
        '<div class="rlr-link-list" id="rlr-link-list"></div>' +
        '<div class="rlr-row" style="margin-top:10px"><button class="rlr-btn sm ghost" id="rlr-clear-links">清空列表</button></div>' +
      '</div>';
    root.appendChild(card);
    container.appendChild(root);

    // 关闭面板
    const closeBtn = root.querySelector('#rlr-close-app');
    if (closeBtn) {
      closeBtn.addEventListener('click', function () {
        try {
          if (rocheRef && rocheRef.ui && typeof rocheRef.ui.closeApp === 'function') {
            rocheRef.ui.closeApp();
          }
        } catch (e) {}
      });
    }

    // 总开关
    root.querySelector('#rlr-enabled-toggle').addEventListener('change', async (e) => {
      if (rocheRef && rocheRef.storage) {
        await rocheRef.storage.set(SK.enabled, e.target.checked);
      }
      await refreshPanelState(root);
      showToast(root, e.target.checked ? '已开启监听' : '已关闭监听');
    });

    // 后端保存
    root.querySelector('#rlr-backend-save').addEventListener('click', async () => {
      const v = root.querySelector('#rlr-backend').value.trim();
      if (!v) { showToast(root, '请输入后端地址'); return; }
      if (rocheRef && rocheRef.storage) await rocheRef.storage.set(SK.backend, v);
      showToast(root, '已保存');
    });

    // 清空已解析链接
    root.querySelector('#rlr-clear-links').addEventListener('click', async () => {
      if (!rocheRef || !rocheRef.storage) return;
      if (rocheRef.ui && rocheRef.ui.confirm) {
        const ok = await rocheRef.ui.confirm({ title: '清空已解析链接', message: '确认清空所有已解析链接记录？' });
        if (!ok) return;
      }
      await rocheRef.storage.set(SK.parsedLinks, []);
      await refreshPanelState(root);
      showToast(root, '已清空');
    });

    // 测试解析
    root.querySelector('#rlr-test-btn').addEventListener('click', async () => {
      const input = root.querySelector('#rlr-test-input');
      const resultBox = root.querySelector('#rlr-test-result');
      const btn = root.querySelector('#rlr-test-btn');
      const link = (input.value || '').trim();
      if (!link) { showToast(root, '请输入链接'); return; }

      btn.disabled = true;
      btn.textContent = '解析中...';
      resultBox.className = 'rlr-test-result show';
      resultBox.innerHTML = '<div class="tr-head"><span class="tr-status">解析中...</span></div><div class="tr-body"><pre>正在请求后端解析，请稍候...</pre></div>';

      try {
        const settings = await loadSettings();
        const data = await parseLink(link, settings.backend);
        const platform = (data && data.platform) || detectPlatform(link) || 'general';

        let html = '<div class="tr-head">';
        html += '<span class="tr-status ok">解析成功</span>';
        html += '<span class="tr-platform">' + escapeHtml(platform) + '</span>';
        html += '</div>';
        html += '<div class="tr-body">';

        const title = (data && (data.title || data.desc || '')) || '';
        if (title) html += '<div class="tr-title">' + escapeHtml(title.substring(0, 120)) + '</div>';

        const images = (data && data.images) || [];
        if (images.length > 0) {
          html += '<div class="tr-images">';
          images.slice(0, 9).forEach(img => {
            const imgSrc = (img && (img.url || img)) || '';
            if (imgSrc) html += '<img src="' + escapeHtml(imgSrc) + '" alt="" onerror="this.style.display=\'none\'" />';
          });
          html += '</div>';
        }

        if (data && data.video) html += '<div style="font-size:12px;color:#8b3a3a;margin-top:6px">[含视频]</div>';

        let pretty;
        try { pretty = JSON.stringify(data, null, 2); } catch (e) { pretty = String(data); }
        html += '<pre style="margin-top:8px">' + escapeHtml(pretty) + '</pre>';
        html += '</div>';

        resultBox.innerHTML = html;
        await cacheParsedLink(link, data);
        await refreshPanelState(root);
      } catch (e) {
        const errMsg = String((e && e.message) || e);
        resultBox.innerHTML = '<div class="tr-head"><span class="tr-status err">解析失败</span></div>' +
          '<div class="tr-body"><pre>' + escapeHtml(errMsg) + '</pre></div>';
      } finally {
        btn.disabled = false;
        btn.textContent = '测试解析';
      }
    });

    // 回车触发测试
    root.querySelector('#rlr-test-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        root.querySelector('#rlr-test-btn').click();
      }
    });

    // 初始化视图
    refreshPanelState(root);

    return root;
  }

  // ============================ 插件定义 ============================

  const plugin = {
    id: PLUGIN_ID,
    name: '链接解析',
    version: '2.0.0',

    apps: [
      {
        id: APP_ID,
        name: '链接解析设置',
        icon: 'link',
        async mount(container, roche) {
          rocheRef = roche || rocheRef;
          if (container) container.innerHTML = '';
          // 插入样式（仅一次）
          if (!injectedStyleEl) {
            injectedStyleEl = document.createElement('style');
            injectedStyleEl.setAttribute('data-roche-plugin', PLUGIN_ID);
            injectedStyleEl.textContent = PANEL_CSS;
            document.head.appendChild(injectedStyleEl);
          }
          buildPanel(container, rocheRef);
          // 首次 mount 启动后台轮询（unmount 不停止，保证关闭面板后继续监听）
          startPolling();
        },
        async unmount(container, roche) {
          // 仅清理面板 DOM，不停止轮询
          if (container) container.innerHTML = '';
          if (injectedStyleEl && injectedStyleEl.parentNode) {
            injectedStyleEl.parentNode.removeChild(injectedStyleEl);
            injectedStyleEl = null;
          }
        }
      }
    ]
  };

  // ============================ 注册 ============================
  if (typeof window !== 'undefined' && window.RochePlugin && typeof window.RochePlugin.register === 'function') {
    window.RochePlugin.register(plugin);
  } else {
    window.addEventListener('roche-plugin-ready', () => {
      if (window.RochePlugin && typeof window.RochePlugin.register === 'function') {
        window.RochePlugin.register(plugin);
      }
    });
  }
})();
