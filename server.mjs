// Multi-user SMS verification-code relay.
// Anyone can push codes with any token, then view them with the same token.
//
//   PORT=8787 HOST=127.0.0.1 node server.mjs
//
// Push a code:
//   curl -X POST localhost:8787/sms \
//     -H 'X-Token: my-token' -H 'Content-Type: application/json' \
//     -d '{"text":"【某网站】验证码 123456，5分钟内有效"}'
//
// View: open http://localhost:8787/?token=my-token

import http from 'node:http';
import { URL } from 'node:url';

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const MAX_PER_USER = 50;            // keep the last N messages per user
const TTL_MS = 30 * 60_000;        // and forget anything older than 30 min
const MAX_TOKEN_LEN = 128;         // sanity cap on token length

/** @type {Map<string, {messages: {id:number, text:string, code:string|null, at:number}[], nextId: number}>} */
const users = new Map();
let globalId = 1;

function getUser(token) {
  let u = users.get(token);
  if (!u) {
    u = { messages: [], nextId: 1 };
    users.set(token, u);
  }
  return u;
}

function pruneUser(u) {
  const cutoff = Date.now() - TTL_MS;
  u.messages = u.messages.filter(m => m.at >= cutoff).slice(-MAX_PER_USER);
}

// Also prune the whole user map for stale token entries.
function pruneUsers() {
  const cutoff = Date.now() - TTL_MS;
  for (const [token, u] of users) {
    u.messages = u.messages.filter(m => m.at >= cutoff).slice(-MAX_PER_USER);
    if (u.messages.length === 0) users.delete(token);
  }
}

// Pull the most code-looking 4-8 digit run out of the SMS text.
function extractCode(text) {
  const m = String(text).match(/(?<!\d)(\d{4,8})(?!\d)/g);
  if (!m) return null;
  return m.sort((a, b) => (b.length === 6) - (a.length === 6) || b.length - a.length)[0];
}

// Simple hash for the login flow: accept any non-empty string as token,
// but reject obviously invalid ones (too long, empty).
function isValidToken(s) {
  return typeof s === 'string' && s.length > 0 && s.length <= MAX_TOKEN_LEN;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 64_000) { reject(new Error('too large')); req.destroy(); return; }
      data += c;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const CSS = `
/* ===== Theme Variables ===== */
:root, body.no-theme {
  --bg: #090b10;
  --card-bg: #11141d;
  --card-border: #1e2233;
  --text: #e0e2e8;
  --text-muted: #6b7084;
  --text-dim: #4b5068;
  --text-faint: #3d4055;
  --input-bg: #0d0f17;
  --input-border: #1e2233;
  --badge-bg: #1a1d2b;
  --badge-color: #6b7084;
  --msg-bg: #0d0f17;
  --msg-border: #1a1d2b;
  --msg-body: #a0a6b8;
  --code-color: #a78bfa;
  --code-hover: #c4b5fd;
  --accent: #6366f1;
  --accent2: #8b5cf6;
  --green: #22c55e;
  --green-bg: rgba(99,102,241,0.15);
  --green-glow: rgba(34,197,94,0.4);
  --btn-bg: #0d0f17;
  --btn-color: #8b8fa8;
  --btn-hover-bg: #131620;
  --btn-hover-border: #2d3247;
  --btn-hover-color: #c0c4d4;
  --danger-hover-bg: #1c1216;
  --danger-hover-border: #7f1d1d;
  --danger-hover-color: #fca5a5;
  --tut-bg: #0a0c14;
  --tut-border: #1a1d2b;
  color-scheme: dark;
}
:root.light {
  --bg: #f5f5f7;
  --card-bg: #ffffff;
  --card-border: #e5e5ea;
  --text: #1d1d1f;
  --text-muted: #86868b;
  --text-dim: #aeaeb2;
  --text-faint: #c7c7cc;
  --input-bg: #f2f2f7;
  --input-border: #d1d1d6;
  --badge-bg: #f2f2f7;
  --badge-color: #86868b;
  --msg-bg: #f9f9fb;
  --msg-border: #e5e5ea;
  --msg-body: #3a3a3c;
  --code-color: #7c3aed;
  --code-hover: #8b5cf6;
  --accent: #6366f1;
  --accent2: #7c3aed;
  --green: #22c55e;
  --green-bg: rgba(99,102,241,0.1);
  --green-glow: rgba(34,197,94,0.3);
  --btn-bg: #f2f2f7;
  --btn-color: #636366;
  --btn-hover-bg: #e5e5ea;
  --btn-hover-border: #c7c7cc;
  --btn-hover-color: #1d1d1f;
  --danger-hover-bg: #fde8e8;
  --danger-hover-border: #fca5a5;
  --danger-hover-color: #dc2626;
  --tut-bg: #f9f9fb;
  --tut-border: #e5e5ea;
  color-scheme: light;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  background: var(--bg);
  color: var(--text);
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
}
.theme-bar {
  position: fixed; top: 12px; right: 12px; z-index: 100;
}
.theme-btn {
  border: 1px solid var(--card-border);
  background: var(--card-bg);
  color: var(--text-muted);
  border-radius: 50%; width: 38px; height: 38px;
  font-size: 18px; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  transition: all 0.2s;
  box-shadow: 0 2px 8px rgba(0,0,0,0.08);
}
.theme-btn:hover { color: var(--text); border-color: var(--accent); }
.card {
  width: 100%;
  max-width: 460px;
  background: var(--card-bg);
  border: 1px solid var(--card-border);
  border-radius: 20px;
  box-shadow: 0 20px 60px rgba(0,0,0,0.12);
  overflow: hidden;
}
.card-header {
  padding: 28px 28px 0;
  display: flex;
  align-items: center;
  gap: 14px;
}
.card-header .icon {
  width: 48px; height: 48px;
  border-radius: 14px;
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  display: flex; align-items: center; justify-content: center;
  font-size: 24px;
  flex-shrink: 0;
  box-shadow: 0 4px 14px rgba(99,102,241,0.3);
}
.card-header .title-area h1 {
  font-size: 20px; font-weight: 700; letter-spacing: -0.3px;
}
.card-header .title-area p {
  font-size: 13px; color: var(--text-muted); margin-top: 3px;
}
.card-body { padding: 24px 28px 28px; }
.card-footer {
  padding: 0 28px 20px;
  font-size: 12px; color: var(--text-faint);
  text-align: center;
  line-height: 1.6;
}
.input-group {
  position: relative;
  margin-bottom: 16px;
}
.input-group label {
  display: block;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 8px;
}
.input-group input {
  width: 100%;
  padding: 12px 44px 12px 16px;
  background: var(--input-bg);
  border: 1px solid var(--input-border);
  border-radius: 12px;
  color: var(--text);
  font-size: 15px;
  font-family: "SF Mono", "Fira Code", "Cascadia Code", monospace;
  transition: border-color 0.2s, box-shadow 0.2s;
  outline: none;
}
.input-group input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--green-bg);
}
.input-group input::placeholder { color: var(--text-faint); }
.toggle-btn, .toggle-vis-btn {
  position: absolute;
  right: 4px; bottom: 4px;
  width: 36px; height: 36px;
  border: none; background: transparent;
  color: var(--text-dim); cursor: pointer;
  border-radius: 8px;
  font-size: 18px;
  display: flex; align-items: center; justify-content: center;
  transition: color 0.15s;
}
.toggle-btn:hover, .toggle-vis-btn:hover { color: var(--text-muted); }
.primary-btn {
  width: 100%;
  padding: 13px 20px;
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  border: none;
  border-radius: 12px;
  color: #fff;
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.2s, transform 0.15s, box-shadow 0.2s;
  letter-spacing: 0.2px;
}
.primary-btn:hover { opacity: 0.92; transform: translateY(-1px); box-shadow: 0 6px 20px rgba(99,102,241,0.35); }
.primary-btn:active { transform: translateY(0); opacity: 0.85; }
.hint {
  font-size: 12px; color: var(--text-dim);
  margin-top: 14px; text-align: center;
  line-height: 1.7;
}
.hint code {
  background: var(--badge-bg);
  padding: 2px 7px; border-radius: 5px;
  font-size: 11px; color: var(--btn-color);
}
.url-badge {
  display: inline-flex; align-items: center; gap: 6px;
  background: var(--badge-bg); border-radius: 8px;
  padding: 4px 10px; font-size: 12px;
  color: var(--badge-color); margin-top: 10px;
}
.url-badge .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--green); }

/* Tutorial */
.tut-section { margin-top: 16px; }
.tut-trigger {
  width: 100%; padding: 10px 16px;
  background: var(--tut-bg);
  border: 1px solid var(--tut-border);
  border-radius: 12px;
  color: var(--text-muted);
  font-size: 13px; cursor: pointer;
  display: flex; align-items: center; justify-content: space-between;
  transition: all 0.15s;
}
.tut-trigger:hover { color: var(--text); border-color: var(--accent); }
.tut-arrow { transition: transform 0.2s; font-size: 11px; }
.tut-trigger.open .tut-arrow { transform: rotate(180deg); }
.tut-content {
  max-height: 0; overflow: hidden;
  transition: max-height 0.35s ease;
  background: var(--tut-bg);
  border: 1px solid var(--tut-border);
  border-top: none; border-radius: 0 0 12px 12px;
}
.tut-content.open { max-height: 600px; border-top: 1px solid var(--tut-border); }
.tut-inner { padding: 16px 18px; font-size: 12px; color: var(--text-dim); line-height: 1.8; }
.tut-inner h4 { font-size: 12px; color: var(--text-muted); margin: 12px 0 6px; font-weight: 700; }
.tut-inner h4:first-child { margin-top: 0; }
.tut-inner code {
  display: block;
  background: var(--input-bg);
  padding: 8px 12px; border-radius: 8px;
  font-family: "SF Mono", "Fira Code", monospace;
  font-size: 11px; color: var(--code-color);
  margin: 4px 0 8px;
  word-break: break-all;
  overflow-x: auto;
}
.tut-inner code.inline {
  display: inline;
  padding: 1px 5px;
  background: var(--badge-bg);
  color: var(--btn-color);
}

.status-bar {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 12px;
}
.status-dot {
  display: flex; align-items: center; gap: 7px;
  font-size: 12px; color: var(--text-muted);
}
.status-dot .pulse {
  width: 7px; height: 7px; border-radius: 50%;
  background: var(--green);
  animation: pulse 2s ease-in-out infinite;
}
@keyframes pulse {
  0%, 100% { opacity: 1; box-shadow: 0 0 0 0 var(--green-glow); }
  50% { opacity: 0.7; box-shadow: 0 0 0 6px rgba(34,197,94,0); }
}
.status-dot.offline .pulse { background: var(--text-muted); animation: none; }
.status-actions { display: flex; gap: 8px; }
.icon-btn {
  border: 1px solid var(--card-border);
  background: var(--btn-bg);
  color: var(--btn-color);
  border-radius: 10px;
  padding: 6px 12px;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;
  display: flex; align-items: center; gap: 5px;
}
.icon-btn:hover { border-color: var(--btn-hover-border); color: var(--btn-hover-color); background: var(--btn-hover-bg); }
.icon-btn.danger:hover { border-color: var(--danger-hover-border); color: var(--danger-hover-color); background: var(--danger-hover-bg); }
.msg-list { display: flex; flex-direction: column; gap: 10px; }
.msg-card {
  background: var(--msg-bg);
  border: 1px solid var(--msg-border);
  border-radius: 14px;
  overflow: hidden;
  animation: slideIn 0.3s ease;
}
@keyframes slideIn {
  from { opacity: 0; transform: translateY(-8px); }
  to { opacity: 1; transform: translateY(0); }
}
.code-row {
  display: flex; align-items: center; justify-content: space-between;
  padding: 14px 18px 0;
}
.code-display {
  font-size: 32px; font-weight: 800;
  letter-spacing: 5px;
  font-family: "SF Mono", "Fira Code", "Cascadia Code", monospace;
  color: var(--code-color);
  cursor: pointer; user-select: all;
  transition: color 0.15s;
}
.code-display:hover { color: var(--code-hover); }
.code-display.copied { color: var(--green); }
.copy-hint {
  font-size: 11px; color: var(--text-dim);
  opacity: 0; transition: opacity 0.2s;
  pointer-events: none;
}
.code-row:hover .copy-hint { opacity: 1; }
.msg-body {
  padding: 8px 18px 8px;
  color: var(--msg-body);
  font-size: 13px;
  line-height: 1.6;
  word-break: break-all;
}
.msg-body.no-code { padding: 14px 18px; }
.msg-footer {
  display: flex; align-items: center; justify-content: space-between;
  padding: 6px 18px 12px;
}
.msg-time {
  font-size: 11px; color: var(--text-faint);
  display: flex; align-items: center; gap: 4px;
}
.msg-time .live { color: var(--green); font-size: 6px; }
.empty-state {
  text-align: center; padding: 48px 20px;
}
.empty-state .empty-icon { font-size: 40px; margin-bottom: 16px; opacity: 0.5; }
.empty-state .empty-title { font-size: 15px; color: var(--text-muted); font-weight: 600; margin-bottom: 6px; }
.empty-state .empty-desc { font-size: 12px; color: var(--text-faint); line-height: 1.6; }
.count-badge {
  font-size: 11px; background: var(--badge-bg);
  color: var(--badge-color); padding: 2px 8px; border-radius: 10px;
}
.main-card { max-width: 520px; }
.token-badge {
  display: inline-flex; align-items: center; gap: 4px;
  background: var(--badge-bg); padding: 2px 8px; border-radius: 6px;
  font-size: 11px; color: var(--badge-color);
  font-family: "SF Mono", "Fira Code", monospace;
  max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}`;

const LOGIN_PAGE = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>验证码中转 · SMS Relay</title>
<style>${CSS}</style>
</head>
<body>
<div class="theme-bar">
  <button class="theme-btn" id="themeToggle" title="切换主题">🌙</button>
</div>
<div class="card">
  <div class="card-header">
    <div class="icon">📩</div>
    <div class="title-area">
      <h1>SMS Relay</h1>
      <p>多用户验证码中转站</p>
    </div>
  </div>
  <div class="card-body">
    <div class="input-group">
      <label>你的 Token</label>
      <input id="token" type="password" placeholder="随便写一个，用来识别你的短信…" autofocus autocomplete="off">
      <button class="toggle-btn" id="toggle" title="显示/隐藏">👁</button>
    </div>
    <button class="primary-btn" id="go">进入中转站 →</button>
    <div class="hint">
      想一个属于你自己的 Token<br>
      用它发短信、用它收验证码<br>
      <span style="color:var(--text-dim);">别人用别的 Token 看不到你的</span>
    </div>
    <div class="tut-section">
      <button class="tut-trigger" id="tutTrigger">
        📖 如何使用？
        <span class="tut-arrow">▼</span>
      </button>
      <div class="tut-content" id="tutContent">
        <div class="tut-inner">
          <h4>1. 发送验证码到本中转站</h4>
          <p>把手机收到的短信通过 curl / Tasker / 快捷指令转发到你部署的服务器。Token 就是你自己的身份标识，随便写一个就行。</p>
          <code>curl -X POST https://你的域名/sms \\
  -H 'X-Token: 我的令牌' \\
  -H 'Content-Type: application/json' \\
  -d '{"text":"【某网站】验证码 123456"}'</code>
          <h4>2. 在页面查看验证码</h4>
          <p>打开本页面，输入你刚才用的同一个 Token，就能看到转发过来的验证码。点击验证码数字直接复制。</p>
          <h4>3. 多人共用互不干扰</h4>
          <p>每个人用自己不同的 Token 就可以了。<code class="inline">Alice</code> 用 Token <code class="inline">alice</code>，<code class="inline">Bob</code> 用 <code class="inline">bob</code>，互相看不到对方的短信。</p>
          <h4>4. 自动清理</h4>
          <p>每条短信保留 30 分钟，每人最多显示最近 50 条。</p>
        </div>
      </div>
    </div>
  </div>
  <div class="card-footer">
    <div class="url-badge"><span class="dot"></span> SMS Relay</div>
    <div style="margin-top:8px;">每个会话只需输入一次，浏览器会记住</div>
  </div>
</div>
<script>
(function() {
  if (localStorage.getItem('sms_theme') === 'light') document.documentElement.classList.add('light');
  const themeBtn = document.getElementById('themeToggle');
  themeBtn.textContent = document.documentElement.classList.contains('light') ? '☀️' : '🌙';
  themeBtn.onclick = () => {
    const isLight = document.documentElement.classList.toggle('light');
    localStorage.setItem('sms_theme', isLight ? 'light' : 'dark');
    themeBtn.textContent = isLight ? '☀️' : '🌙';
  };
  const tutTrigger = document.getElementById('tutTrigger');
  const tutContent = document.getElementById('tutContent');
  tutTrigger.onclick = () => {
    const open = tutTrigger.classList.toggle('open');
    tutContent.classList.toggle('open', open);
  };
})();
const input = document.getElementById('token');
const toggle = document.getElementById('toggle');
const go = document.getElementById('go');
toggle.onclick = () => {
  const isPass = input.type === 'password';
  input.type = isPass ? 'text' : 'password';
  toggle.textContent = isPass ? '🙈' : '👁';
};
const doLogin = () => {
  const t = input.value.trim();
  if (!t) { input.focus(); return; }
  sessionStorage.setItem('sms_token', t);
  window.location.href = '/?token=' + encodeURIComponent(t);
};
go.onclick = doLogin;
input.onkeydown = (e) => { if (e.key === 'Enter') doLogin(); };
</script>
</body>
</html>`;

const MAIN_PAGE = (token) => `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>验证码 · SMS Relay</title>
<style>${CSS}</style>
</head>
<body>
<div class="theme-bar">
  <button class="theme-btn" id="themeToggle" title="切换主题">🌙</button>
</div>
<div class="card main-card">
  <div class="card-header">
    <div class="icon">📩</div>
    <div class="title-area">
      <h1>SMS Relay</h1>
      <p>验证码中转站</p>
    </div>
  </div>
  <div class="card-body">
    <div class="status-bar">
      <div class="status-dot" id="status">
        <span class="pulse"></span>
        <span id="status-text">连接中…</span>
      </div>
      <div class="status-actions">
        <span class="count-badge" id="count" style="display:none"></span>
        <button class="icon-btn" onclick="refresh()" title="刷新">🔄 刷新</button>
        <button class="icon-btn danger" onclick="clearAll()" title="清空全部">🗑 清空</button>
        <button class="icon-btn" onclick="logout()" title="退出">🚪</button>
      </div>
    </div>
    <div id="list" class="msg-list"></div>
  </div>
  <div class="card-footer">
    <span class="token-badge">🔑 ${token.replace(/[&<>"']/g,'')}</span> · 仅保留最近 ${MAX_PER_USER} 条 · 30 分钟自动清除
  </div>
</div>
<script>
(function() {
  if (localStorage.getItem('sms_theme') === 'light') document.documentElement.classList.add('light');
  const tb = document.getElementById('themeToggle');
  tb.textContent = document.documentElement.classList.contains('light') ? '☀️' : '🌙';
  tb.onclick = () => {
    const isLight = document.documentElement.classList.toggle('light');
    localStorage.setItem('sms_theme', isLight ? 'light' : 'dark');
    tb.textContent = isLight ? '☀️' : '🌙';
  };
})();
const TOKEN = ${JSON.stringify(token)};
sessionStorage.setItem('sms_token', TOKEN);
const list = document.getElementById('list');
const statusEl = document.getElementById('status');
const statusText = document.getElementById('status-text');
const countEl = document.getElementById('count');
function fmtAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 10) return '<span class="live">●</span> 刚刚';
  if (s < 60) return s + ' 秒前';
  if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
  return Math.floor(s / 3600) + ' 小时前';
}
function render(msgs) {
  countEl.textContent = msgs.length + ' 条';
  countEl.style.display = msgs.length ? '' : 'none';
  list.replaceChildren();
  if (!msgs.length) {
    list.innerHTML = '<div class="empty-state"><div class="empty-icon">📭</div><div class="empty-title">等待验证码…</div><div class="empty-desc">收到短信验证码后会自动出现在这里</div></div>';
    return;
  }
  const reversed = msgs.slice().reverse();
  for (const m of reversed) {
    const card = document.createElement('div');
    card.className = 'msg-card';
    if (m.code) {
      const codeRow = document.createElement('div');
      codeRow.className = 'code-row';
      const codeSpan = document.createElement('span');
      codeSpan.className = 'code-display';
      codeSpan.textContent = m.code;
      codeSpan.onclick = () => { cp(codeSpan, m.code); };
      const codeHint = document.createElement('span');
      codeHint.className = 'copy-hint';
      codeHint.textContent = '点击复制';
      codeRow.appendChild(codeSpan);
      codeRow.appendChild(codeHint);
      card.appendChild(codeRow);
    }
    const body = document.createElement('div');
    body.className = 'msg-body' + (m.code ? '' : ' no-code');
    body.textContent = m.text;
    card.appendChild(body);
    const footer = document.createElement('div');
    footer.className = 'msg-footer';
    const timeSpan = document.createElement('span');
    timeSpan.className = 'msg-time';
    timeSpan.innerHTML = fmtAgo(m.at);
    footer.appendChild(timeSpan);
    card.appendChild(footer);
    list.appendChild(card);
  }
}
function cp(el, code) {
  try { navigator.clipboard && navigator.clipboard.writeText(code); } catch(e) {}
  el.classList.add('copied');
  setTimeout(() => el.classList.remove('copied'), 1200);
}
async function poll() {
  try {
    const r = await fetch('/api/messages', { headers: { 'X-Token': TOKEN } });
    if (!r.ok) { throw new Error('HTTP ' + r.status); }
    const data = await r.json();
    statusEl.classList.remove('offline');
    statusText.textContent = '在线 · ' + new Date().toLocaleTimeString('zh-CN', {hour:'2-digit',minute:'2-digit',second:'2-digit'});
    if (String(data.messages.length) !== list.dataset.len) {
      list.dataset.len = data.messages.length;
      render(data.messages);
    }
  } catch (e) {
    statusEl.classList.add('offline');
    statusText.textContent = '离线';
  }
}
window.refresh = poll;
window.clearAll = async () => {
  if (!confirm('确定清空所有验证码？')) return;
  await fetch('/api/messages', { method: 'DELETE', headers: { 'X-Token': TOKEN } });
  list.dataset.len = '0';
  await poll();
};
window.logout = () => {
  sessionStorage.removeItem('sms_token');
  window.location.href = '/';
};
render([]);
list.dataset.len = '0';
poll();
setInterval(poll, 3000);
</script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');

  // --- Ingest a code ---
  if (req.method === 'POST' && u.pathname === '/sms') {
    const token = req.headers['x-token'];
    if (!isValidToken(token)) { res.writeHead(401).end('bad token'); return; }
    let text = '';
    try {
      const raw = await readBody(req);
      const ct = req.headers['content-type'] || '';
      if (ct.includes('application/json')) {
        const j = JSON.parse(raw || '{}');
        text = j.text || j.content || j.message || j.sms || '';
        if (!text && raw.trim() && raw.trim() !== '{}') text = raw;
      } else if (ct.includes('application/x-www-form-urlencoded')) {
        const form = new URLSearchParams(raw);
        text = form.get('text') || form.get('content') || form.get('message') || raw;
      } else {
        text = raw;
      }
    } catch { res.writeHead(400).end('bad body'); return; }
    text = String(text).trim();
    if (!text) { res.writeHead(400).end('empty'); return; }
    const user = getUser(token);
    pruneUser(user);
    const msg = { id: user.nextId++, text, code: extractCode(text), at: Date.now() };
    user.messages.push(msg);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, code: msg.code }));
    return;
  }

  // --- Read codes (called by the page) ---
  if (req.method === 'GET' && u.pathname === '/api/messages') {
    const token = req.headers['x-token'];
    if (!isValidToken(token)) { res.writeHead(401).end('bad token'); return; }
    const user = getUser(token);
    pruneUser(user);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ messages: user.messages }));
    return;
  }

  // --- Clear codes after reading ---
  if (req.method === 'DELETE' && u.pathname === '/api/messages') {
    const token = req.headers['x-token'];
    if (!isValidToken(token)) { res.writeHead(401).end('bad token'); return; }
    const user = getUser(token);
    user.messages = [];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // --- The page ---
  if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) {
    const provided = u.searchParams.get('token');
    if (provided && isValidToken(provided)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(MAIN_PAGE(provided));
      return;
    }
    // Any token is valid now (or none → login page)
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(LOGIN_PAGE);
    return;
  }

  res.writeHead(404).end('not found');
});

// Periodic cleanup of stale users
setInterval(pruneUsers, 5 * 60_000);

server.listen(PORT, HOST, () => {
  console.log('SMS relay (multi-user) on http://' + HOST + ':' + PORT + '/');
  console.log('POST codes to http://' + HOST + ':' + PORT + '/sms  (header X-Token: your-token)');
});
