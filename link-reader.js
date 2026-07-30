/**
 * Roche 链接解析插件 v2.1
 *
 * 纯后台监听当前打开的聊天会话，检测到链接后：
 *   1. 调用后端解析链接（小红书/微博/B站/知乎/通用）
 *   2. 下载图片转 dataURL
 *   3. 删除原消息，注入解析文本 + 独立图片消息
 *   4. 刷新聊天界面（Pinia splice > 事件派发 > viewStack pop/push）
 *
 * 关键设计：
 *   - DB 短连接：每次 openDB 后事务完成立即 close()，不缓存连接
 *     （参考 RocheToolkit v3.2：避免长连接干扰 Roche 主程序快照隔离）
 *   - 只监听当前打开的会话（从 viewStack 读取），不做会话列表选择
 *   - 关闭面板后监听继续在后台运行（参考 xhs-reader）
 *   - 不声明 chat.tools 工具调用，纯后台处理
 *
 * 数据来源：GD音乐台同款 CF Worker 代理 + 各平台解析
 */
(function () {
  'use strict';

  // ============================ 常量 ============================
  const PLUGIN_ID = 'roche-link-reader';
  const APP_ID = 'roche-link-reader-home';
  const DEFAULT_BACKEND = 'https://456.chajianreader.cc.cd';
  const DB_NAME = 'Roche_db';
  const POLL_INTERVAL = 2000;       // 轮询间隔 2 秒
  const MAX_DIRECT_IMAGES = 9;      // 直注最多图片数
  const FAIL_COOLDOWN = 5000;       // 失败冷却 5 秒
  const MAX_FAILS = 5;              // 最大重试 5 次

  // 链接检测正则
  const LINK_REGEX = /https?:\/\/[^\s<>"'.,;:!?)）】》]+/gi;
  const XHS_REGEX = /https?:\/\/(xhslink\.com|xhslink\.cn|xiaohongshu\.com|xhscdn\.com)\/[^\s<>"']+/i;
  const WEIBO_REGEX = /https?:\/\/(weibo\.com|weibo\.cn|m\.weibo\.cn|t\.cn)\/[^\s<>"']+/i;
  const BILI_REGEX = /https?:\/\/(bilibili\.com|b23\.tv|bilibili\.tv)\/[^\s<>"']+/i;
  const ZHIHU_REGEX = /https?:\/\/(zhihu\.com|zhuanlan\.zhihu\.com)\/[^\s<>"']+/i;

  // storage 键
  const SK = {
    enabled: 'rlr_enabled',         // 总开关
    backend: 'rlr_backend',         // 后端地址
    parsedLinks: 'rlr_parsed_links' // 已解析链接缓存
  };

  // ============================ 运行时状态 ============================
  let rocheRef = null;                  // roche API 引用
  let pollTimer = null;                 // 轮询定时器
  let isPolling = false;                // 全局锁
  let rootEl = null;                    // 设置面板根元素
  let injectedStyleEl = null;           // style 标签
  const processedMessages = new Map();  // 已处理消息 id -> { done, ts, fails, lastFailTs }

  // ============================ 工具函数 ============================

  function log(msg, type) {
    type = type || 'info';
    const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    console.log(`[link-reader][${t}] ${msg}`);
  }

  function uiToast(msg) {
    try {
      if (rocheRef && rocheRef.ui && typeof rocheRef.ui.toast === 'function') {
        rocheRef.ui.toast(msg);
      }
    } catch (e) {}
  }

  function extractLinks(text) {
    if (!text) return [];
    const matches = String(text).match(LINK_REGEX);
    return matches ? matches.slice() : [];
  }

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
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 15000);
      const resp = await fetch(proxyUrl, { signal: ctrl.signal });
      clearTimeout(t);
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

  // ============================ IndexedDB 短连接 ============================
  // 参考 RocheToolkit v3.2：每次 openDB 后事务完成立即 close()，不缓存连接

  function openDB() {
    return new Promise((resolve, reject) => {
      try {
        const req = indexedDB.open(DB_NAME);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      } catch (e) {
        reject(e);
      }
    });
  }

  // 按会话读取所有消息（短连接：事务完成即 close）
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
          resolve(all.filter(m => m && m.conversationId === conversationId));
        };
        req.onerror = () => reject(req.error);
        tx.oncomplete = () => db.close();
        return;
      }
      req.onsuccess = () => {
        const arr = req.result || [];
        arr.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
        resolve(arr);
      };
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => db.close();
      tx.onerror = () => db.close();
    });
  }

  async function addMessage(msg) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('messages', 'readwrite');
      const req = tx.objectStore('messages').add(msg);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => db.close();
      tx.onerror = () => db.close();
      tx.onabort = () => db.close();
    });
  }

  async function deleteMessage(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('messages', 'readwrite');
      const req = tx.objectStore('messages').delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => db.close();
      tx.onerror = () => db.close();
      tx.onabort = () => db.close();
    });
  }

  // ============================ Roche 内部状态访问 ============================

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

  // 从 viewStack 获取当前打开的会话 id（只监听当前会话）
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

  // 刷新聊天界面（三方案降级，参考 xhs-reader）
  async function refreshRocheChat(conversationId) {
    try {
      if (!conversationId) return;
      const cid = String(conversationId);

      // 方案 A：Pinia splice（最佳）
      const piniaArr = findMessagesArrayInPinia(cid);
      if (piniaArr) {
        try {
          const dbMsgs = await getMessagesByConversation(cid);
          if (dbMsgs.length > 0) {
            piniaArr.splice(0, piniaArr.length);
            for (const m of dbMsgs) piniaArr.push(m);
            log(`refreshRocheChat: Pinia splice ${dbMsgs.length} 条 OK`);
            return;
          }
        } catch (e) {
          log(`refreshRocheChat: Pinia 异常: ${e.message}`);
        }
      }

      // 方案 B：事件派发
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

      // 方案 C：viewStack pop+push
      const navStore = getViewStackStore();
      if (navStore && navStore.viewStack && navStore.viewStack.length > 0) {
        const top = navStore.viewStack[navStore.viewStack.length - 1];
        if (top && top.name === 'chat' && top.params && top.params.id === cid) {
          navStore.viewStack.pop();
          setTimeout(() => {
            navStore.viewStack.push({ name: 'chat', params: { id: cid } });
          }, 50);
          log(`refreshRocheChat: viewStack pop/push ${cid}`);
          return;
        }
      }
    } catch (e) {
      log(`refreshRocheChat 失败: ${e.message}`);
    }
  }

  // ============================ 消息注入 ============================

  function genMsgId() {
    return `msg_${Date.now()}${Math.random().toString().slice(1)}`;
  }

  // 注入文本消息（删除原消息，新增文本消息）
  async function injectTextMessage(originalMsg, text) {
    const newMsg = {
      id: genMsgId(),
      text,
      isMe: originalMsg.isMe === undefined ? true : originalMsg.isMe,
      type: 'text',
      timestamp: (originalMsg.timestamp || Date.now()) + 1,
      conversationId: originalMsg.conversationId
    };
    if (originalMsg.senderId !== undefined) newMsg.senderId = originalMsg.senderId;
    if (originalMsg.senderName !== undefined) newMsg.senderName = originalMsg.senderName;
    // 删除原消息（容错）
    if (originalMsg.id) {
      try {
        await deleteMessage(originalMsg.id);
      } catch (e) {
        log(`injectTextMessage: 删除原消息失败 (非致命): ${e.message}`);
      }
    }
    await addMessage(newMsg);
    return newMsg;
  }

  // 注入图片消息（参考 xhs-reader：type:'image', content:dataUrl）
  async function injectImageMessage(originalMsg, imageDataUrl, offset) {
    const imgMsg = {
      id: genMsgId(),
      text: '[Image Upload]',
      isMe: originalMsg.isMe === undefined ? true : originalMsg.isMe,
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

  // ============================ 解析结果格式化 ============================

  // 根据平台格式化解析结果为文本
  function formatParsedResult(data, platform, link) {
    const lines = [];
    const platformName = {
      xiaohongshu: '小红书',
      weibo: '微博',
      bilibili: 'B站',
      zhihu: '知乎',
      general: '网页'
    }[platform] || '网页';

    lines.push(`【${platformName}链接解析】`);
    lines.push(`原始链接：${link}`);
    lines.push('');

    if (data.title) {
      lines.push(`# ${data.title}`);
      lines.push('');
    }
    if (data.desc || data.content || data.text) {
      lines.push(data.desc || data.content || data.text);
      lines.push('');
    }
    if (data.author) {
      lines.push(`作者：${data.author}`);
    }
    if (data.tags && data.tags.length > 0) {
      lines.push(`标签：${data.tags.join(' ')}`);
    }
    if (data.video) {
      lines.push(`（含视频内容）`);
    }
    return lines.join('\n');
  }

  // ============================ 链接处理主流程 ============================

  async function processLink(msg, link, backend) {
    const platform = detectPlatform(link);
    log(`开始解析 [${platform}] ${link}`);

    // 1. 调用后端解析
    const data = await parseLink(link, backend);

    // 2. 格式化文本
    const text = formatParsedResult(data, platform, link);

    // 3. 注入文本消息（同时删除原消息）
    const newTextMsg = await injectTextMessage(msg, text);
    log(`已注入文本消息，长度 ${text.length}`);

    // 4. 下载并注入图片（最多 MAX_DIRECT_IMAGES 张）
    const images = (data.images || data.imageList || []).slice(0, MAX_DIRECT_IMAGES);
    let imgOk = 0, imgFail = 0;
    for (let i = 0; i < images.length; i++) {
      try {
        const imgUrl = typeof images[i] === 'string' ? images[i] : (images[i].url || images[i].src);
        if (!imgUrl) continue;
        log(`下载图片 ${i + 1}/${images.length}`);
        const dataUrl = await downloadImageAsDataUrl(imgUrl, backend);
        await injectImageMessage(newTextMsg, dataUrl, i);
        imgOk++;
      } catch (e) {
        imgFail++;
        log(`图片 ${i + 1} 失败: ${e.message}`, 'error');
      }
    }

    log(`处理完成：文本已注入，图片 ${imgOk} 成功 / ${imgFail} 失败`);
    return { textMsgId: newTextMsg.id, imgOk, imgFail };
  }

  // ============================ 轮询监听 ============================

  async function pollOnce() {
    if (isPolling) return;
    isPolling = true;
    try {
      // 只监听当前打开的会话
      const convId = getCurrentConversationId();
      if (!convId) return;

      // 读取后端地址
      let backend = DEFAULT_BACKEND;
      try {
        if (rocheRef && rocheRef.storage) {
          const saved = await rocheRef.storage.get(SK.backend);
          if (saved) backend = saved;
        }
      } catch (e) {}

      // 只读最新 3 条消息（避免大量 reactive 更新导致卡顿）
      let msgs = [];
      try {
        const result = await rocheRef.memory.getShortTerm({
          conversationId: convId,
          limit: 3
        });
        msgs = Array.isArray(result) ? result : (result && result.messages) || [];
      } catch (e) {
        return;
      }
      if (msgs.length === 0) return;

      // 只检查最后一条消息（最新发送的）
      const m = msgs[msgs.length - 1];
      // 只处理用户自己发的消息
      const isMe = m.isMe === true || m.senderId === 'me' || m.role === 'user' ||
                   (m.senderName === undefined && m.type !== 'assistant');
      if (!isMe) return;
      if (m.type && m.type !== 'text') return;

      const msgText = m.text || m.content || '';
      const links = extractLinks(msgText);
      if (links.length === 0) return;

      const msgId = m.id || m.messageId || `${convId}_${m.timestamp}`;
      const now = Date.now();
      const rec = processedMessages.get(msgId);

      // 已处理过
      if (rec) {
        if (rec.done) return;
        if (rec.processing) return;
        if (rec.fails > 0 && (now - (rec.lastFailTs || 0)) < FAIL_COOLDOWN) return;
        if (rec.fails >= MAX_FAILS) return;
      }

      // 标记正在处理
      processedMessages.set(msgId, { processing: true, ts: now, fails: rec ? rec.fails : 0 });
      uiToast('检测到链接，开始解析...');

      try {
        // 构造伪消息对象供 injectTextMessage 使用
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

        // 处理第一个链接（一条消息只处理一个链接，避免混乱）
        await processLink(fakeMsg, links[0], backend);

        processedMessages.set(msgId, { done: true, ts: Date.now() });
        uiToast('链接解析完成');

        // 刷新聊天界面
        await refreshRocheChat(convId);

        // 清理 processedMessages（保留最近 100 条）
        if (processedMessages.size > 100) {
          const oldKeys = Array.from(processedMessages.keys()).slice(0, 50);
          for (const k of oldKeys) processedMessages.delete(k);
        }
      } catch (e) {
        log(`处理失败: ${e.message}`, 'error');
        const prevFails = (rec && rec.fails) || 0;
        processedMessages.set(msgId, {
          fails: prevFails + 1,
          lastFailTs: Date.now(),
          ts: Date.now()
        });
        if (prevFails + 1 >= MAX_FAILS) {
          uiToast('链接解析失败次数过多，已放弃');
        }
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

  async function loadSettings(roche) {
    if (!roche || !roche.storage) return { enabled: true, backend: DEFAULT_BACKEND };
    const enabled = await roche.storage.get(SK.enabled);
    const backend = await roche.storage.get(SK.backend);
    return {
      enabled: enabled === null || enabled === undefined ? true : !!enabled,
      backend: backend || DEFAULT_BACKEND
    };
  }

  async function saveSettings(roche, settings) {
    if (!roche || !roche.storage) return;
    await roche.storage.set(SK.enabled, settings.enabled ? '1' : '0');
    await roche.storage.set(SK.backend, settings.backend);
  }

  // ============================ 设置面板 UI ============================

  function getStyles() {
    return `
.rlr-root {
  width: 100%;
  height: 100%;
  padding: 16px;
  box-sizing: border-box;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  font-size: 14px;
  color: #e0e0e0;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
}
.rlr-root::-webkit-scrollbar { width: 6px; }
.rlr-root::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 3px; }
.rlr-card {
  background: rgba(255,255,255,0.04);
  border-radius: 12px;
  padding: 16px;
  margin-bottom: 12px;
  border: 1px solid rgba(255,255,255,0.06);
}
.rlr-card-title {
  font-size: 15px;
  font-weight: 600;
  margin-bottom: 12px;
  color: #fff;
}
.rlr-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}
.rlr-label { color: rgba(255,255,255,0.7); }
.rlr-input {
  flex: 1;
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
  height: 24px;
  background: rgba(255,255,255,0.15);
  border-radius: 12px;
  position: relative;
  cursor: pointer;
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
  margin-top: 8px;
}
`;
  }

  async function initApp(container, roche) {
    rootEl = document.createElement('div');
    rootEl.className = 'rlr-root';
    container.appendChild(rootEl);

    // 注入样式
    if (!injectedStyleEl) {
      injectedStyleEl = document.createElement('style');
      injectedStyleEl.textContent = getStyles();
      document.head.appendChild(injectedStyleEl);
    }

    const settings = await loadSettings(roche);

    rootEl.innerHTML = `
      <div class="rlr-card">
        <div class="rlr-card-title">链接解析插件</div>
        <div class="rlr-row">
          <span class="rlr-label">启用后台监听</span>
          <div class="rlr-toggle ${settings.enabled ? 'on' : ''}" id="rlr-enabled-toggle"></div>
        </div>
        <div class="rlr-row">
          <span class="rlr-label">后端地址</span>
          <input class="rlr-input" id="rlr-backend-input" value="${settings.backend}" />
        </div>
        <button class="rlr-btn" id="rlr-save-btn">保存设置</button>
        <div class="rlr-status ${settings.enabled ? 'active' : ''}" id="rlr-status">
          ${settings.enabled ? '监听中（仅当前打开的会话）' : '已停止'}
        </div>
      </div>
      <div class="rlr-card">
        <div class="rlr-card-title">使用说明</div>
        <div class="rlr-hint">
          1. 启用后，插件会在后台监听当前打开的聊天会话。<br/>
          2. 当用户发送包含小红书/微博/B站/知乎等链接的消息时，插件会自动：<br/>
          &nbsp;&nbsp;- 调用后端解析链接内容<br/>
          &nbsp;&nbsp;- 下载图片转成内嵌图片消息<br/>
          &nbsp;&nbsp;- 删除原消息，注入解析后的文本和图片<br/>
          3. 关闭本面板后监听继续在后台运行。<br/>
          4. 只监听当前打开的会话，切换会话时自动跟随。<br/>
          5. char 看不到原始链接，只能看到解析后的内容。
        </div>
      </div>
      <div class="rlr-card">
        <div class="rlr-card-title">免责声明</div>
        <div class="rlr-hint">
          本插件为个人学习用途免费分享。解析服务由后端代理提供，仅用于个人学习参考，不得用于商业用途。使用者应确保自身使用行为符合所在地区法律法规。
        </div>
      </div>
    `;

    // 绑定事件
    const toggle = rootEl.querySelector('#rlr-enabled-toggle');
    const backendInput = rootEl.querySelector('#rlr-backend-input');
    const saveBtn = rootEl.querySelector('#rlr-save-btn');
    const statusEl = rootEl.querySelector('#rlr-status');

    toggle.addEventListener('click', async () => {
      settings.enabled = !settings.enabled;
      toggle.classList.toggle('on', settings.enabled);
      statusEl.classList.toggle('active', settings.enabled);
      statusEl.textContent = settings.enabled ? '监听中（仅当前打开的会话）' : '已停止';
      await saveSettings(roche, settings);
      if (settings.enabled) {
        startPolling();
        uiToast('已启用监听');
      } else {
        stopPolling();
        uiToast('已停止监听');
      }
    });

    saveBtn.addEventListener('click', async () => {
      settings.backend = backendInput.value.trim() || DEFAULT_BACKEND;
      await saveSettings(roche, settings);
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
    version: '2.1.0',
    apps: [
      {
        id: APP_ID,
        name: '链接解析',
        icon: 'extension',
        iconImage: '',
        async mount(container, roche) {
          rocheRef = roche;
          await initApp(container, roche);
        },
        async unmount(container, roche) {
          // 关闭面板时保留监听，监听继续在后台运行（参考 xhs-reader）
          rootEl = null;
          container.replaceChildren();
        }
      }
    ],
    onLoad: function (roche) {
      rocheRef = roche;
      // 兜底：如果 Roche 调用 onLoad，提前启动监听
      loadSettings(roche).then(settings => {
        if (settings.enabled) startPolling();
      }).catch(() => {});
    },
    onUnload: function () {
      // 插件被禁用时不停止监听（参考 xhs-reader）
      // 用户可通过设置面板的开关控制
    }
  });

})();
