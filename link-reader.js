/**
 * Roche 链接解析插件
 * 解析小红书 / 微博 / B站 / 知乎 / 通用链接
 * 支持三种注入模式：直接注入(contextProvider)、工具调用(tools)、副API判断(preflight)
 * 小红书 / 微博 链接支持数据库直注图片，让 char 真正看到图片
 */
(function () {
  'use strict';

  // ============================ 常量定义 ============================
  const PLUGIN_ID = 'roche-link-reader';
  const APP_ID = 'roche-link-reader-home';
  const DEFAULT_BACKEND = 'https://456.chajianreader.cc.cd';
  const DB_NAME = 'Roche_db';
  const POLL_INTERVAL = 2000; // 后台轮询间隔 2 秒
  const MAX_DIRECT_IMAGES = 9; // 数据库直注最多图片数

  // 链接检测正则
  const LINK_REGEX = /https?:\/\/[^\s<>"'.,;:!?)）】》]+/gi;
  const XHS_REGEX = /https?:\/\/(xhslink\.com|xhslink\.cn|xiaohongshu\.com|xhscdn\.com)\/[^\s<>"']+/i;
  const WEIBO_REGEX = /https?:\/\/(weibo\.com|weibo\.cn|m\.weibo\.cn|t\.cn)\/[^\s<>"']+/i;
  const BILI_REGEX = /https?:\/\/(bilibili\.com|b23\.tv|bilibili\.tv)\/[^\s<>"']+/i;
  const ZHIHU_REGEX = /https?:\/\/(zhihu\.com|zhuanlan\.zhihu\.com)\/[^\s<>"']+/i;

  // storage 键
  const SK = {
    mode: 'rlr_mode',                 // 注入模式 1|2|3
    rounds: 'rlr_rounds',             // 模式1注入轮数
    xhsWeiboDirect: 'rlr_xhs_weibo_direct', // 小红书/微博直注开关
    backend: 'rlr_backend',           // 后端地址
    subApiUrl: 'rlr_sub_api_url',     // 副API地址
    subApiKey: 'rlr_sub_api_key',     // 副API Key
    subApiModel: 'rlr_sub_api_model', // 副API模型
    subApiPresets: 'rlr_sub_api_presets', // 副API预设
    parsedLinks: 'rlr_parsed_links',  // 已解析链接缓存
    injectMeta: 'rlr_inject_meta'     // 模式1注入轮数计数（按链接）
  };

  // ============================ 运行时状态 ============================
  let rocheRef = null;            // roche API 引用
  let pollTimer = null;           // 后台轮询定时器
  let currentConversationId = null; // 当前会话 id
  const processedMessages = new Set(); // 已直注处理过的消息 id
  let _db = null;                       // IndexedDB 连接缓存
  let dbWarned = false;                 // IndexedDB 不可用提示是否已展示
  let injectedStyleEl = null;     // mount 时插入的 style 标签

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

  // blob 转 dataURL
  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  // 调用 roche.ui.toast（若可用）
  function uiToast(msg) {
    try {
      if (rocheRef && rocheRef.ui && typeof rocheRef.ui.toast === 'function') {
        rocheRef.ui.toast(msg);
      }
    } catch (e) {}
  }

  // 下载图片转 dataURL（处理 CORS，走代理；按域名选择 referer）
  async function downloadImageAsDataUrl(imageUrl, backend) {
    const base = backend || DEFAULT_BACKEND;
    // 根据图片域名选择 referer，提升代理成功率
    let referer = 'https://weibo.com';
    const lower = String(imageUrl).toLowerCase();
    if (lower.indexOf('xhscdn.com') >= 0 || lower.indexOf('xiaohongshu.com') >= 0) {
      referer = 'https://www.xiaohongshu.com';
    } else if (lower.indexOf('sinaimg.cn') >= 0 || lower.indexOf('weibo.com') >= 0) {
      referer = 'https://weibo.com';
    }
    // 优先走 /debug 代理（携带 referer，绕过 CORS）
    try {
      const proxyUrl = `${base}/debug?url=${encodeURIComponent(imageUrl)}&referer=${encodeURIComponent(referer)}`;
      const resp = await fetch(proxyUrl);
      if (resp.ok) {
        const blob = await resp.blob();
        if (blob && blob.size > 0) {
          return await blobToDataUrl(blob);
        }
      }
    } catch (e) {
      // 代理失败，尝试直接下载
    }
    // 兜底：直接 fetch 原始 URL
    const resp2 = await fetch(imageUrl, { mode: 'cors' });
    const blob2 = await resp2.blob();
    return await blobToDataUrl(blob2);
  }

  // 调用后端解析链接
  async function parseLink(link, backend) {
    const base = backend || DEFAULT_BACKEND;
    const url = `${base}/?url=${encodeURIComponent(link)}`;
    const ctrl = new AbortController();
    const t = setTimeout(function () { ctrl.abort(); }, 15000);
    let resp;
    try {
      resp = await fetch(url, { signal: ctrl.signal });
    } finally {
      clearTimeout(t);
    }
    if (!resp.ok) throw new Error('解析接口返回状态 ' + resp.status);
    const data = await resp.json();
    return data;
  }

  // 调用副 API（OpenAI 兼容）
  async function callSubApi(messages, apiUrl, apiKey, model) {
    const ctrl = new AbortController();
    const t = setTimeout(function () { ctrl.abort(); }, 15000);
    let resp;
    try {
      resp = await fetch(`${apiUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({ model, messages, temperature: 0.3, max_tokens: 200 }),
        signal: ctrl.signal
      });
    } finally {
      clearTimeout(t);
    }
    if (!resp.ok) throw new Error('副API返回状态 ' + resp.status);
    const data = await resp.json();
    return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
  }

  // ============================ IndexedDB 直注 ============================

  // IndexedDB 不可用时提示一次
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
        req.onupgradeneeded = function () { /* 空实现，避免未初始化 store 报错 */ };
        req.onsuccess = function () { _db = req.result; resolve(_db); };
        req.onerror = function () { warnDbUnavailable(); reject(req.error); };
      } catch (e) {
        warnDbUnavailable();
        reject(e);
      }
    });
  }

  // 按会话读取所有消息
  async function getMessagesByConversation(conversationId) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('messages', 'readonly');
      const store = tx.objectStore('messages');
      // 优先走 conversationId 索引
      let req;
      try {
        const idx = store.index('conversationId');
        req = idx.getAll(IDBKeyRange.only(conversationId));
      } catch (e) {
        // 没有索引则全量读取后过滤
        req = store.getAll();
        req.onsuccess = () => {
          const all = req.result || [];
          resolve(all.filter(m => m && m.conversationId === conversationId));
        };
        req.onerror = () => reject(req.error);
        return;
      }
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async function addMessage(msg) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('messages', 'readwrite');
      const store = tx.objectStore('messages');
      const req = store.add(msg);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function deleteMessage(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('messages', 'readwrite');
      const store = tx.objectStore('messages');
      const req = store.delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  // ============================ 聊天界面刷新 ============================

  // 查找 Roche 的 Vue nav store（window 上带 viewStack 的引用）
  function findRocheNavStore() {
    try {
      for (const key of Object.keys(window)) {
        try {
          const v = window[key];
          if (v && typeof v === 'object' && v.viewStack !== undefined && Array.isArray(v.viewStack)) {
            return v;
          }
        } catch (e) {}
      }
    } catch (e) {}
    return null;
  }

  // 从 nav store 获取当前会话 id
  function getCurrentConversationIdFromNav() {
    const navStore = findRocheNavStore();
    if (navStore && navStore.viewStack && navStore.viewStack.length > 0) {
      const top = navStore.viewStack[navStore.viewStack.length - 1];
      if (top && top.name === 'chat' && top.params && top.params.id) {
        return top.params.id;
      }
    }
    return null;
  }

  // 刷新聊天界面
  function refreshChat(conversationId) {
    const navStore = findRocheNavStore();
    if (navStore && navStore.viewStack && navStore.viewStack.length > 0) {
      const top = navStore.viewStack[navStore.viewStack.length - 1];
      if (top && top.name === 'chat' && top.params && top.params.id === conversationId) {
        navStore.viewStack.pop();
        setTimeout(() => {
          navStore.viewStack.push({ name: 'chat', params: { id: conversationId } });
        }, 50);
        return;
      }
    }
    // 兜底
    try { location.reload(); } catch (e) {}
  }

  // ============================ 设置读写 ============================

  function defaultSettings() {
    return {
      mode: 1,
      rounds: 5,
      xhsWeiboDirect: true,
      backend: DEFAULT_BACKEND,
      subApiUrl: '',
      subApiKey: '',
      subApiModel: '',
      subApiPresets: [],
      parsedLinks: []
    };
  }

  // 读取全部设置（每次实时读取，避免脏数据）
  async function loadSettings(roche) {
    const s = defaultSettings();
    if (!roche || !roche.storage) return s;
    try {
      const mode = await roche.storage.get(SK.mode);
      if (mode !== null && mode !== undefined) s.mode = Number(mode) || 1;
      const rounds = await roche.storage.get(SK.rounds);
      if (rounds !== null && rounds !== undefined) s.rounds = Number(rounds) || 5;
      const xhs = await roche.storage.get(SK.xhsWeiboDirect);
      s.xhsWeiboDirect = (xhs === null || xhs === undefined) ? true : !!xhs;
      const backend = await roche.storage.get(SK.backend);
      if (backend) s.backend = backend;
      const subApiUrl = await roche.storage.get(SK.subApiUrl);
      if (subApiUrl) s.subApiUrl = subApiUrl;
      const subApiKey = await roche.storage.get(SK.subApiKey);
      if (subApiKey) s.subApiKey = subApiKey;
      const subApiModel = await roche.storage.get(SK.subApiModel);
      if (subApiModel) s.subApiModel = subApiModel;
      const subApiPresets = await roche.storage.get(SK.subApiPresets);
      if (Array.isArray(subApiPresets)) s.subApiPresets = subApiPresets;
      const parsedLinks = await roche.storage.get(SK.parsedLinks);
      if (Array.isArray(parsedLinks)) s.parsedLinks = parsedLinks;
    } catch (e) {}
    return s;
  }

  // 缓存已解析链接
  async function cacheParsedLink(roche, link, data) {
    if (!roche || !roche.storage) return;
    try {
      let list = (await roche.storage.get(SK.parsedLinks)) || [];
      list = list.filter(item => item && item.link !== link);
      list.unshift({
        link: link,
        platform: data && data.platform,
        title: data && data.title,
        time: Date.now(),
        data: data
      });
      list = list.slice(0, 50);
      await roche.storage.set(SK.parsedLinks, list);
    } catch (e) {}
  }

  // ============================ 文本格式化 ============================

  // B站/知乎/通用：注入上下文文本
  function formatLinkText(data, link) {
    const lines = [];
    lines.push('【链接解析结果】');
    lines.push('链接：' + link);
    if (data.platform) lines.push('平台：' + data.platform);
    if (data.title) lines.push('标题：' + data.title);
    if (data.desc) lines.push('描述：' + data.desc);
    if (data.content) lines.push('内容：' + data.content);
    if (data.author) {
      const a = data.author;
      const name = a.nickname || a.name || '';
      const uid = a.userId || a.mid || '';
      lines.push('作者：' + name + (uid ? '（' + uid + '）' : ''));
      if (a.description) lines.push('作者简介：' + a.description);
      if (a.verified) lines.push('认证：' + a.verified);
    }
    if (data.images && data.images.length) lines.push('图片数量：' + data.images.length);
    if (data.video) lines.push('视频：' + (typeof data.video === 'string' ? data.video : '有视频'));
    if (data.cover) lines.push('封面：' + data.cover);
    if (data.duration) lines.push('时长：' + data.duration);
    if (data.pubdate) lines.push('发布时间：' + data.pubdate);
    if (data.subtitle && data.subtitle.available) {
      lines.push('字幕可用：' + (data.subtitle.lan || ''));
      if (data.subtitle.text) lines.push('字幕内容：\n' + data.subtitle.text);
    }
    if (data.tags && data.tags.length) lines.push('标签：' + data.tags.join('、'));
    if (data.likedCount !== undefined) lines.push('点赞：' + data.likedCount);
    if (data.commentCount !== undefined) lines.push('评论：' + data.commentCount);
    if (data.collectedCount !== undefined) lines.push('收藏：' + data.collectedCount);
    if (data.shareCount !== undefined) lines.push('分享：' + data.shareCount);
    if (data.time) lines.push('时间：' + data.time);
    if (data.source) lines.push('来源：' + data.source);
    if (data.postUrl) lines.push('原文：' + data.postUrl);
    if (data.retweeted) {
      lines.push('转发的微博：');
      if (data.retweeted.author) lines.push('  原作者：' + data.retweeted.author);
      if (data.retweeted.text) lines.push('  原文：' + data.retweeted.text);
      if (data.retweeted.images && data.retweeted.images.length) {
        lines.push('  原文图片数量：' + data.retweeted.images.length);
      }
    }
    return lines.join('\n');
  }

  // 小红书/微博 直注文本消息（含全文）
  function buildDirectInjectionText(data, link) {
    const lines = [];
    lines.push('【' + (data.platform === 'xiaohongshu' ? '小红书笔记' : '微博') + '】');
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
    if (data.images && data.images.length) lines.push('图片数量：' + data.images.length + '（已作为图片消息发送）');
    // 评论（小红书）
    if (data.comments && data.comments.length) {
      lines.push('热门评论：');
      data.comments.slice(0, 10).forEach((c, i) => {
        const who = c.nickname || '匿名';
        const cnt = c.likedCount !== undefined ? '（赞 ' + c.likedCount + '）' : '';
        const when = c.time ? ' ' + c.time : '';
        lines.push('  ' + (i + 1) + '. ' + who + cnt + when + '：' + (c.content || ''));
      });
    }
    if (data.retweeted) {
      lines.push('转发的微博：');
      if (data.retweeted.author) lines.push('  原作者：' + data.retweeted.author);
      if (data.retweeted.text) lines.push('  原文：' + data.retweeted.text);
      if (data.retweeted.images && data.retweeted.images.length) {
        lines.push('  原文图片数量：' + data.retweeted.images.length);
      }
    }
    return lines.join('\n');
  }

  // ============================ 数据库直注流程（小红书/微博） ============================

  async function handleDirectInjection(originalMsg, link, convId) {
    if (!rocheRef) return;
    try {
      const settings = await loadSettings(rocheRef);
      const data = await parseLink(link, settings.backend);
      await cacheParsedLink(rocheRef, link, data);

      // 下载图片转 base64
      const dataUrls = [];
      const images = (data.images || []).slice(0, MAX_DIRECT_IMAGES);
      let imgFailed = false;
      for (const img of images) {
        const imgUrl = img && (img.url || img);
        if (!imgUrl) continue;
        try {
          const dataUrl = await downloadImageAsDataUrl(imgUrl, settings.backend);
          if (dataUrl) dataUrls.push(dataUrl);
        } catch (e) {
          // 单张失败跳过，不阻塞整体直注
          imgFailed = true;
        }
      }

      // 构建文本消息
      const textContent = buildDirectInjectionText(data, link);
      const senderId = originalMsg.senderId;
      const senderName = originalMsg.senderName;
      const baseTs = Date.now();

      // 先添加文本消息（标记 _rlr_injected 避免轮询重复触发）
      const textMsgId = 'msg_' + baseTs + '_t_' + Math.random().toString(36).slice(2, 8);
      await addMessage({
        id: textMsgId,
        text: textContent,
        isMe: true,
        type: 'text',
        timestamp: baseTs,
        conversationId: convId,
        senderId: senderId,
        senderName: senderName,
        _rlr_injected: true
      });
      processedMessages.add(textMsgId);

      // 逐张添加图片消息
      for (let i = 0; i < dataUrls.length; i++) {
        const imgId = 'msg_' + (baseTs + i + 1) + '_img_' + Math.random().toString(36).slice(2, 6);
        await addMessage({
          id: imgId,
          text: '[Image Upload]',
          isMe: true,
          type: 'image',
          content: dataUrls[i],
          timestamp: baseTs + i + 1,
          conversationId: convId,
          senderId: senderId,
          senderName: senderName,
          isVisionRecognized: false,
          _rlr_injected: true
        });
        processedMessages.add(imgId);
      }

      // 新消息全部写入成功后，最后删除原消息（避免中途失败丢消息）
      try { await deleteMessage(originalMsg.id); } catch (e) {}

      // 部分图片下载失败提示
      if (imgFailed) {
        uiToast('部分图片下载失败');
      }

      // 刷新聊天界面
      refreshChat(convId);
    } catch (e) {
      console.warn('[roche-link-reader] 直注失败', e);
      throw e;
    }
  }

  // ============================ 后台轮询 ============================

  async function pollForLinks() {
    if (!rocheRef) return;
    try {
      const settings = await loadSettings(rocheRef);
      // 只在"小红书/微博特殊处理"开关打开时启用
      if (!settings.xhsWeiboDirect) return;

      // 获取当前会话 id
      let convId = currentConversationId || getCurrentConversationIdFromNav();
      if (!convId) return;
      currentConversationId = convId;

      const messages = await getMessagesByConversation(convId);
      if (!messages || !messages.length) return;

      // processedMessages 定期清理，避免无限增长
      if (processedMessages.size > 200) {
        processedMessages.clear();
      }

      // 找到含小红书/微博链接的 user 文本消息
      for (const msg of messages) {
        if (processedMessages.has(msg.id)) continue;
        // 跳过本插件直注生成的消息，避免无限循环
        if (msg._rlr_injected === true) {
          processedMessages.add(msg.id);
          continue;
        }
        if (!msg.isMe) continue;
        if (msg.type !== 'text') continue;
        const text = msg.text || '';
        if (!text) continue;
        const xhsMatch = text.match(XHS_REGEX);
        const weiboMatch = text.match(WEIBO_REGEX);
        const link = (xhsMatch && xhsMatch[0]) || (weiboMatch && weiboMatch[0]);
        if (link) {
          processedMessages.add(msg.id);
          // 异步处理，不阻塞轮询；失败则回退标记，允许下次重试
          handleDirectInjection(msg, link, convId).catch(function () {
            processedMessages.delete(msg.id);
            uiToast('链接解析失败');
          });
        }
      }
    } catch (e) {
      // 轮询失败静默
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

  // ============================ 模式1：注入轮数计数 ============================

  // 读取注入计数 meta（{ link: { remaining, data } }）
  async function loadInjectMeta(roche) {
    if (!roche || !roche.storage) return {};
    try {
      const m = await roche.storage.get(SK.injectMeta);
      return (m && typeof m === 'object') ? m : {};
    } catch (e) { return {}; }
  }

  async function saveInjectMeta(roche, meta) {
    if (!roche || !roche.storage) return;
    try { await roche.storage.set(SK.injectMeta, meta); } catch (e) {}
  }

  // ============================ chat 能力：contextProvider（模式1） ============================

  async function contextProvider(ctx) {
    try {
      if (!rocheRef) return null;
      const settings = await loadSettings(rocheRef);
      // 仅模式1启用
      if (settings.mode !== 1) return null;

      const convId = ctx && ctx.conversationId;
      if (convId) currentConversationId = convId;

      // 收集 latestUserMessage 与最近消息中的链接
      let allText = ctx && ctx.latestUserMessage ? ctx.latestUserMessage : '';
      try {
        const recent = await rocheRef.memory.getShortTerm({ conversationId: convId, limit: 20 });
        if (Array.isArray(recent)) {
          allText += '\n' + recent.map(m => (m && (m.text || '')) || '').join('\n');
        }
      } catch (e) {}

      const links = extractLinks(allText);
      if (!links.length) return null;

      // 取注入计数
      const meta = await loadInjectMeta(rocheRef);
      const maxRounds = settings.rounds || 5;
      let metaChanged = false;
      const parts = [];

      for (const link of links) {
        const platform = detectPlatform(link);
        // 小红书/微博 不走 contextProvider（走数据库直注），返回 null
        if (platform === 'xiaohongshu' || platform === 'weibo') {
          continue;
        }
        // B站/知乎/通用：注入文本内容
        let entry = meta[link];
        if (!entry) {
          // 首次出现，解析并缓存
          try {
            const data = await parseLink(link, settings.backend);
            await cacheParsedLink(rocheRef, link, data);
            entry = { remaining: maxRounds, data: data };
            meta[link] = entry;
            metaChanged = true;
          } catch (e) {
            // 解析失败跳过
            continue;
          }
        }
        if (entry && entry.remaining > 0 && entry.data) {
          parts.push(formatLinkText(entry.data, link));
          entry.remaining = entry.remaining - 1;
          metaChanged = true;
          if (entry.remaining <= 0) {
            // 超过轮数，清除
            delete meta[link];
            metaChanged = true;
          }
        }
      }

      if (metaChanged) await saveInjectMeta(rocheRef, meta);

      if (!parts.length) return null;
      return parts.join('\n\n');
    } catch (e) {
      return null;
    }
  }

  // ============================ chat 能力：preflight（模式3） ============================

  async function preflight(ctx) {
    try {
      if (!rocheRef) return null;
      const settings = await loadSettings(rocheRef);
      // 仅模式3启用
      if (settings.mode !== 3) return null;
      // 副API 未配置则跳过
      if (!settings.subApiUrl || !settings.subApiKey || !settings.subApiModel) return null;

      const convId = ctx && ctx.conversationId;
      if (convId) currentConversationId = convId;

      // 读取最近 50 条消息
      let messages = [];
      try {
        messages = await rocheRef.memory.getShortTerm({ conversationId: convId, limit: 50 });
      } catch (e) {}
      if (!messages || !messages.length) return null;

      const allText = messages.map(m => (m && (m.text || '')) || '').join('\n');
      const links = extractLinks(allText);
      if (!links.length) return null;

      const latestText = (ctx && ctx.latestUserMessage) || '';
      // 调副 API 判断当前消息是否涉及链接内容
      const judgeMessages = [
        {
          role: 'system',
          content: '判断用户最新消息是否涉及对以下链接内容的讨论或提问。链接列表：' + links.join(' , ') + '。只回答 YES 或 NO。'
        },
        { role: 'user', content: latestText }
      ];
      let verdict = '';
      try {
        verdict = await callSubApi(judgeMessages, settings.subApiUrl, settings.subApiKey, settings.subApiModel);
      } catch (e) {
        return null;
      }

      if (/yes/i.test(String(verdict).trim())) {
        // 涉及 -> 解析链接并注入内容
        const parts = [];
        for (const link of links) {
          try {
            const data = await parseLink(link, settings.backend);
            await cacheParsedLink(rocheRef, link, data);
            // 小红书/微博 在模式3下也注入文本内容（图片直注由后台轮询处理）
            parts.push(formatLinkText(data, link));
          } catch (e) {
            // 单条失败跳过
          }
        }
        return parts.length ? parts.join('\n\n') : null;
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  // ============================ chat 能力：tools（模式2） ============================

  const parseLinkTool = {
    id: 'parse_link',
    description: '解析小红书、微博、B站、知乎等链接，返回标题、描述、图片、字幕、作者、评论等内容。当用户发送了链接并希望了解链接内容时调用。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要解析的链接地址' }
      },
      required: ['url']
    },
    async execute(args, ctx) {
      try {
        if (!rocheRef) return { error: '插件未初始化' };
        const settings = await loadSettings(rocheRef);
        const url = args && args.url;
        if (!url) return { error: '缺少 url 参数' };

        if (ctx && ctx.conversationId) currentConversationId = ctx.conversationId;

        const data = await parseLink(url, settings.backend || DEFAULT_BACKEND);
        await cacheParsedLink(rocheRef, url, data);

        // 小红书/微博：工具返回图片 URL（不直注，由用户在设置中选择是否开启直注）
        if (data.platform === 'xiaohongshu' || data.platform === 'weibo') {
          return {
            platform: data.platform,
            title: data.title,
            desc: data.desc,
            content: data.content,
            author: data.author,
            images: (data.images || []).map(i => (i && i.url) || i),
            video: data.video || null,
            tags: data.tags || [],
            likedCount: data.likedCount,
            collectedCount: data.collectedCount,
            commentCount: data.commentCount,
            shareCount: data.shareCount,
            time: data.time,
            source: data.source,
            comments: data.comments || [],
            retweeted: data.retweeted || null,
            postUrl: data.postUrl || null,
            note: '图片URL已返回。如需让模型直接看到图片，请在插件设置中开启"小红书/微博特殊处理"（数据库直注）。'
          };
        }
        // B站/知乎/通用：返回完整解析结果
        return data;
      } catch (e) {
        return { error: String((e && e.message) || e) };
      }
    }
  };

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

.rlr-mode-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
.rlr-mode-card {
  border: 1.5px solid rgba(139,58,58,.18); border-radius: 12px; padding: 14px;
  background: rgba(255,255,255,0.55); cursor: pointer; transition: all .2s ease;
  text-align: left;
}
.rlr-mode-card:hover { border-color: #8b3a3a; transform: translateY(-1px); }
.rlr-mode-card.active { border-color: #8b3a3a; background: rgba(139,58,58,.08); box-shadow: 0 4px 14px rgba(139,58,58,.14); }
.rlr-mode-card .mm-name { font-weight: 600; color: #8b3a3a; font-size: 14px; margin-bottom: 4px; }
.rlr-mode-card .mm-text { font-size: 12px; color: #6f6666; }

.rlr-field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; }
.rlr-label { font-size: 13px; color: #5a5050; font-weight: 500; }
.rlr-input, .rlr-select {
  width: 100%; padding: 10px 12px; border: 1.5px solid rgba(139,58,58,.18);
  border-radius: 12px; background: rgba(255,255,255,0.75); color: #2b2b2b;
  font-size: 13px; transition: all .2s ease; outline: none;
}
.rlr-input:focus, .rlr-select:focus { border-color: #8b3a3a; background: #fff; }
.rlr-row { display: flex; gap: 8px; align-items: center; }
.rlr-row .rlr-input, .rlr-row .rlr-select { flex: 1; }

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

.rlr-num { width: 90px; }
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

.rlr-presets { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
.rlr-preset-chip { display: inline-flex; align-items: center; gap: 6px; padding: 6px 10px; border-radius: 999px; background: rgba(139,58,58,.08); color: #8b3a3a; font-size: 12px; cursor: pointer; border: 1px solid transparent; transition: all .2s ease; }
.rlr-preset-chip:hover { background: rgba(139,58,58,.16); }
.rlr-preset-chip.active { border-color: #8b3a3a; background: rgba(139,58,58,.12); }
.rlr-preset-chip .px { opacity: .6; }

@media (max-width: 600px) {
  .rlr-root { padding: 12px; }
  .rlr-card { padding: 16px; }
  .rlr-mode-grid { grid-template-columns: 1fr; }
  .rlr-btn { padding: 11px 16px; }
  .rlr-btn.sm { padding: 12px 16px; }
  .rlr-input, .rlr-select { padding: 12px; font-size: 14px; }
  .rlr-preset-chip { padding: 10px 14px; }
  .rlr-link-item { padding: 14px; }
}
`;

  // 简易 toast
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

  // 渲染已解析链接列表
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
        '<div class="li-top"><span class="li-plat">' + plat + '</span>' +
        '<span class="li-time">' + time + '</span></div>' +
        '<div class="li-title">' + escapeHtml(title) + '</div>' +
        '<div class="li-url">' + escapeHtml(item.link || '') + '</div>';
      el.addEventListener('click', () => openDetailModal(root, item));
      box.appendChild(el);
    });
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
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

  // 渲染预设 chips
  function renderPresets(root, settings) {
    const box = root.querySelector('#rlr-presets');
    if (!box) return;
    const presets = settings.subApiPresets || [];
    if (!presets.length) {
      box.innerHTML = '<span class="rlr-empty" style="padding:4px 0">暂无预设</span>';
      return;
    }
    box.innerHTML = '';
    const activeUrl = settings.subApiUrl;
    presets.forEach((p, idx) => {
      const chip = document.createElement('span');
      chip.className = 'rlr-preset-chip' + (p.url === activeUrl ? ' active' : '');
      chip.innerHTML = escapeHtml(p.name || ('预设' + (idx + 1))) +
        ' <span class="px" data-del="' + idx + '">删除</span>';
      chip.addEventListener('click', (e) => {
        if (e.target.getAttribute && e.target.getAttribute('data-del') !== null) {
          e.stopPropagation();
          deletePreset(root, idx);
        } else {
          loadPreset(root, idx);
        }
      });
      box.appendChild(chip);
    });
  }

  async function loadPreset(root, idx) {
    if (!rocheRef) return;
    const settings = await loadSettings(rocheRef);
    const p = settings.subApiPresets[idx];
    if (!p) return;
    await rocheRef.storage.set(SK.subApiUrl, p.url || '');
    await rocheRef.storage.set(SK.subApiKey, p.key || '');
    await rocheRef.storage.set(SK.subApiModel, p.model || '');
    root.querySelector('#rlr-sub-url').value = p.url || '';
    root.querySelector('#rlr-sub-key').value = p.key || '';
    await refreshModelList(root, p.url, p.key, p.model);
    showToast(root, '已加载预设');
    await refreshPanelState(root);
  }

  async function deletePreset(root, idx) {
    if (!rocheRef) return;
    const settings = await loadSettings(rocheRef);
    const presets = (settings.subApiPresets || []).slice();
    presets.splice(idx, 1);
    await rocheRef.storage.set(SK.subApiPresets, presets);
    await refreshPanelState(root);
    showToast(root, '已删除预设');
  }

  // 刷新模型列表
  async function refreshModelList(root, apiUrl, apiKey, currentModel) {
    const sel = root.querySelector('#rlr-sub-model');
    if (!sel) return;
    sel.innerHTML = '<option>加载中...</option>';
    if (!apiUrl) {
      sel.innerHTML = '<option value="">请先填写 API URL</option>';
      return;
    }
    try {
      const resp = await fetch(apiUrl.replace(/\/+$/, '') + '/models', {
        headers: apiKey ? { 'Authorization': 'Bearer ' + apiKey } : {}
      });
      if (!resp.ok) throw new Error('状态 ' + resp.status);
      const data = await resp.json();
      const list = (data && (data.data || data.models)) || [];
      sel.innerHTML = '';
      let found = false;
      list.forEach(m => {
        const id = typeof m === 'string' ? m : (m.id || m.name);
        if (!id) return;
        const opt = document.createElement('option');
        opt.value = id; opt.textContent = id;
        if (currentModel && id === currentModel) { opt.selected = true; found = true; }
        sel.appendChild(opt);
      });
      if (!sel.options.length) sel.innerHTML = '<option value="">未获取到模型</option>';
      if (currentModel && !found && sel.options.length) {
        // 保留当前模型为自定义项
        const opt = document.createElement('option');
        opt.value = currentModel; opt.textContent = currentModel; opt.selected = true;
        sel.appendChild(opt);
      }
    } catch (e) {
      sel.innerHTML = '<option value="">获取失败：' + escapeHtml(String(e.message || e)) + '</option>';
    }
  }

  // 刷新面板状态（重新读取设置并更新视图）
  async function refreshPanelState(root) {
    if (!rocheRef) return;
    const settings = await loadSettings(rocheRef);
    // 模式卡片
    root.querySelectorAll('.rlr-mode-card').forEach(c => {
      c.classList.toggle('active', Number(c.dataset.mode) === settings.mode);
    });
    // 轮数
    const roundsInput = root.querySelector('#rlr-rounds');
    if (roundsInput) roundsInput.value = settings.rounds;
    // 开关
    const tog = root.querySelector('#rlr-xhs-toggle');
    if (tog) tog.checked = !!settings.xhsWeiboDirect;
    // 后端
    const be = root.querySelector('#rlr-backend');
    if (be) be.value = settings.backend;
    // 副API
    root.querySelector('#rlr-sub-url').value = settings.subApiUrl || '';
    root.querySelector('#rlr-sub-key').value = settings.subApiKey || '';
    renderPresets(root, settings);
    renderLinkList(root, settings.parsedLinks);
    // 模式3相关区域显隐
    const m1 = root.querySelector('#rlr-section-rounds');
    const m3 = root.querySelector('#rlr-section-subapi');
    if (m1) m1.style.display = settings.mode === 1 ? '' : 'none';
    if (m3) m3.style.display = settings.mode === 3 ? '' : 'none';
  }

  // 构建设置面板
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
        '<div class="rlr-header-right"><span class="rlr-sub">roche-link-reader v1.0.0</span>' +
          '<button class="rlr-close-btn" id="rlr-close-app" type="button" aria-label="关闭">关闭</button>' +
        '</div>' +
      '</div>' +
      '<div class="rlr-divider"></div>' +

      '<div class="rlr-section">' +
        '<div class="rlr-section-title">注入模式</div>' +
        '<div class="rlr-desc">选择链接内容注入聊天的方式。模式1每轮自动注入；模式2由模型主动调用工具；模式3由副API判断是否注入。</div>' +
        '<div class="rlr-mode-grid">' +
          '<button class="rlr-mode-card" data-mode="1"><div class="mm-name">模式1 直接注入</div><div class="mm-text">每轮检测链接，自动注入解析内容，默认5轮</div></button>' +
          '<button class="rlr-mode-card" data-mode="2"><div class="mm-name">模式2 工具调用</div><div class="mm-text">声明 parse_link 工具，由模型按需调用</div></button>' +
          '<button class="rlr-mode-card" data-mode="3"><div class="mm-name">模式3 副API判断</div><div class="mm-text">副API判断当前消息是否涉及链接</div></button>' +
        '</div>' +
      '</div>' +

      '<div class="rlr-section" id="rlr-section-rounds">' +
        '<div class="rlr-section-title">注入轮数（模式1）</div>' +
        '<div class="rlr-desc">同一链接在上下文中保持注入的轮数，超过后自动清除。</div>' +
        '<div class="rlr-row">' +
          '<input type="number" min="1" max="50" class="rlr-input rlr-num" id="rlr-rounds" />' +
          '<button class="rlr-btn sm" id="rlr-rounds-save">保存</button>' +
        '</div>' +
      '</div>' +

      '<div class="rlr-section">' +
        '<div class="rlr-section-title">小红书 / 微博 特殊处理</div>' +
        '<div class="rlr-toggle">' +
          '<div class="tt-text"><b>启用数据库直注图片</b><span>检测到小红书/微博链接时，下载图片转为 base64 直接写入消息库，让模型真正看到图片。后台每2秒轮询一次。</span></div>' +
          '<label class="rlr-switch"><input type="checkbox" id="rlr-xhs-toggle" /><span class="rlr-slider"></span></label>' +
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

      '<div class="rlr-section" id="rlr-section-subapi">' +
        '<div class="rlr-section-title">副API配置（模式3）</div>' +
        '<div class="rlr-desc">OpenAI 兼容接口，用于判断当前消息是否涉及链接内容。</div>' +
        '<div class="rlr-field"><label class="rlr-label">API URL</label>' +
          '<input type="text" class="rlr-input" id="rlr-sub-url" placeholder="https://api.openai.com/v1" /></div>' +
        '<div class="rlr-field"><label class="rlr-label">API Key</label>' +
          '<input type="password" class="rlr-input" id="rlr-sub-key" placeholder="sk-..." /></div>' +
        '<div class="rlr-field"><label class="rlr-label">模型</label>' +
          '<div class="rlr-row"><select class="rlr-select" id="rlr-sub-model"><option value="">请先填写 URL 并刷新</option></select>' +
          '<button class="rlr-btn sm" id="rlr-model-refresh">刷新</button></div></div>' +
        '<div class="rlr-row">' +
          '<input type="text" class="rlr-input" id="rlr-preset-name" placeholder="预设名称" />' +
          '<button class="rlr-btn sm" id="rlr-preset-save">存为预设</button>' +
        '</div>' +
        '<div class="rlr-presets" id="rlr-presets"></div>' +
        '<div class="rlr-row" style="margin-top:10px"><button class="rlr-btn sm" id="rlr-subapi-save">保存副API配置</button></div>' +
      '</div>' +

      '<div class="rlr-section">' +
        '<div class="rlr-section-title">测试注入</div>' +
        '<div class="rlr-desc">输入任意链接（小红书 / 微博 / B站 / 知乎 / 通用），点击测试解析，查看后端返回内容是否正常。</div>' +
        '<div class="rlr-row">' +
          '<input type="text" class="rlr-input" id="rlr-test-input" placeholder="粘贴链接，如 https://www.xiaohongshu.com/explore/..." />' +
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

    // 事件绑定
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

    // 模式选择
    root.querySelectorAll('.rlr-mode-card').forEach(c => {
      c.addEventListener('click', async () => {
        const mode = Number(c.dataset.mode);
        if (roche && roche.storage) {
          await roche.storage.set(SK.mode, mode);
          // 切换到非模式1时，清空注入计数
          if (mode !== 1) {
            try { await roche.storage.set(SK.injectMeta, {}); } catch (e) {}
          }
        }
        await refreshPanelState(root);
        showToast(root, '已切换到模式' + mode);
      });
    });

    // 轮数保存
    root.querySelector('#rlr-rounds-save').addEventListener('click', async () => {
      const v = parseInt(root.querySelector('#rlr-rounds').value, 10);
      if (!v || v < 1) { showToast(root, '请输入有效轮数'); return; }
      if (roche && roche.storage) await roche.storage.set(SK.rounds, v);
      showToast(root, '已保存');
    });

    // 直注开关
    root.querySelector('#rlr-xhs-toggle').addEventListener('change', async (e) => {
      if (roche && roche.storage) await roche.storage.set(SK.xhsWeiboDirect, e.target.checked);
      showToast(root, e.target.checked ? '已开启直注' : '已关闭直注');
    });

    // 后端保存
    root.querySelector('#rlr-backend-save').addEventListener('click', async () => {
      const v = root.querySelector('#rlr-backend').value.trim();
      if (!v) { showToast(root, '请输入后端地址'); return; }
      if (roche && roche.storage) await roche.storage.set(SK.backend, v);
      showToast(root, '已保存');
    });

    // 模型刷新
    root.querySelector('#rlr-model-refresh').addEventListener('click', async () => {
      const url = root.querySelector('#rlr-sub-url').value.trim();
      const key = root.querySelector('#rlr-sub-key').value.trim();
      if (!url) { showToast(root, '请先填写 API URL'); return; }
      showToast(root, '正在获取模型列表...');
      await refreshModelList(root, url, key, null);
    });

    // 存为预设
    root.querySelector('#rlr-preset-save').addEventListener('click', async () => {
      if (!roche || !roche.storage) return;
      const name = root.querySelector('#rlr-preset-name').value.trim();
      const url = root.querySelector('#rlr-sub-url').value.trim();
      const key = root.querySelector('#rlr-sub-key').value.trim();
      const model = root.querySelector('#rlr-sub-model').value;
      if (!url) { showToast(root, '请先填写 API URL'); return; }
      const settings = await loadSettings(roche);
      const presets = (settings.subApiPresets || []).slice();
      presets.push({ name: name || ('预设' + (presets.length + 1)), url, key, model });
      await roche.storage.set(SK.subApiPresets, presets);
      root.querySelector('#rlr-preset-name').value = '';
      await refreshPanelState(root);
      showToast(root, '已保存预设');
    });

    // 保存副API配置
    root.querySelector('#rlr-subapi-save').addEventListener('click', async () => {
      if (!roche || !roche.storage) return;
      const url = root.querySelector('#rlr-sub-url').value.trim();
      const key = root.querySelector('#rlr-sub-key').value.trim();
      const model = root.querySelector('#rlr-sub-model').value;
      await roche.storage.set(SK.subApiUrl, url);
      await roche.storage.set(SK.subApiKey, key);
      await roche.storage.set(SK.subApiModel, model);
      await refreshPanelState(root);
      showToast(root, '已保存副API配置');
    });

    // 清空已解析链接
    root.querySelector('#rlr-clear-links').addEventListener('click', async () => {
      if (!roche || !roche.storage) return;
      if (roche.ui && roche.ui.confirm) {
        const ok = await roche.ui.confirm({ title: '清空已解析链接', message: '确认清空所有已解析链接记录？' });
        if (!ok) return;
      }
      await roche.storage.set(SK.parsedLinks, []);
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

      // 显示加载中
      btn.disabled = true;
      btn.textContent = '解析中...';
      resultBox.className = 'rlr-test-result show';
      resultBox.innerHTML = '<div class="tr-head"><span class="tr-status">解析中...</span></div><div class="tr-body"><pre>正在请求后端解析，请稍候...</pre></div>';

      try {
        const settings = await loadSettings(rocheRef);
        const backend = settings.backend || DEFAULT_BACKEND;
        const data = await parseLink(link, backend);
        const platform = (data && data.platform) || detectPlatform(link) || 'general';

        // 构建结果展示
        let html = '<div class="tr-head">';
        html += '<span class="tr-status ok">解析成功</span>';
        html += '<span class="tr-platform">' + escapeHtml(platform) + '</span>';
        html += '</div>';
        html += '<div class="tr-body">';

        // 标题
        const title = (data && (data.title || data.desc || '')) || '';
        if (title) {
          html += '<div class="tr-title">' + escapeHtml(title.substring(0, 120)) + '</div>';
        }

        // 图片预览（小红书/微博）
        const images = (data && data.images) || [];
        if (images.length > 0) {
          html += '<div class="tr-images">';
          images.slice(0, 9).forEach(img => {
            const imgSrc = (img && (img.url || img)) || '';
            if (imgSrc) html += '<img src="' + escapeHtml(imgSrc) + '" alt="" onerror="this.style.display=\'none\'" />';
          });
          html += '</div>';
        }

        // 视频标记
        if (data && data.video) {
          html += '<div style="font-size:12px;color:#8b3a3a;margin-top:6px">[含视频]</div>';
        }

        // JSON 详情
        let pretty;
        try { pretty = JSON.stringify(data, null, 2); } catch (e) { pretty = String(data); }
        html += '<pre style="margin-top:8px">' + escapeHtml(pretty) + '</pre>';
        html += '</div>';

        resultBox.innerHTML = html;

        // 缓存到已解析链接
        await cacheParsedLink(rocheRef, link, data);
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
    refreshPanelState(root).then(async () => {
      const settings = await loadSettings(roche);
      // 初始化模型下拉（若已有配置）
      if (settings.subApiUrl) {
        await refreshModelList(root, settings.subApiUrl, settings.subApiKey, settings.subApiModel);
      }
    });

    return root;
  }

  // ============================ 插件定义 ============================

  const plugin = {
    id: PLUGIN_ID,
    name: '链接解析',
    version: '1.0.0',

    // 插件加载时启动后台轮询
    onLoad(roche) {
      rocheRef = roche || rocheRef;
      startPolling();
    },

    // 插件卸载时清理
    onUnload() {
      stopPolling();
      processedMessages.clear();
    },

    apps: [
      {
        id: APP_ID,
        name: '链接解析设置',
        icon: 'link',
        async mount(container, roche) {
          rocheRef = roche || rocheRef;
          // 防重复 mount：先清理容器
          if (container) container.innerHTML = '';
          // 插入样式（仅一次，便于清理）
          if (!injectedStyleEl) {
            injectedStyleEl = document.createElement('style');
            injectedStyleEl.setAttribute('data-roche-plugin', PLUGIN_ID);
            injectedStyleEl.textContent = PANEL_CSS;
            document.head.appendChild(injectedStyleEl);
          }
          buildPanel(container, rocheRef);
        },
        async unmount(container, roche) {
          // 仅清理面板 DOM（事件监听随 DOM 一并回收）
          // 注意：不停止后台轮询、不清空已处理消息集合
          // 保证关闭设置面板后，链接解析功能（小红书/微博直注、contextProvider、tools）继续运行
          if (container) container.innerHTML = '';
          // 删除 style 标签
          if (injectedStyleEl && injectedStyleEl.parentNode) {
            injectedStyleEl.parentNode.removeChild(injectedStyleEl);
            injectedStyleEl = null;
          }
        }
      }
    ],

    chat: {
      scope: { conversationTypes: ['direct', 'group'] },

      // 固定规则文本，始终启用
      promptOnly:
        '你具有链接解析能力。当用户发送小红书、微博、B站、知乎等链接时，你可以：' +
        '1) 依赖已注入的链接解析上下文直接回答；' +
        '2) 调用 parse_link 工具解析链接内容。' +
        '请优先使用提供的真实链接内容回答，不要编造未提供的细节。' +
        '小红书/微博链接的图片可由插件通过数据库直注让模型看到，若用户问及图片但未看到，可提示用户在插件设置中开启"小红书/微博特殊处理"。',

      // 模式1：直接注入
      contextProvider,

      // 模式3：副API判断
      preflight,

      // 模式2：工具调用
      tools: [parseLinkTool]
    }
  };

  // ============================ 注册 ============================
  if (typeof window !== 'undefined' && window.RochePlugin && typeof window.RochePlugin.register === 'function') {
    window.RochePlugin.register(plugin);
  } else {
    // 兜底：等待 RochePlugin 就绪
    window.addEventListener('roche-plugin-ready', () => {
      if (window.RochePlugin && typeof window.RochePlugin.register === 'function') {
        window.RochePlugin.register(plugin);
      }
    });
  }
})();
