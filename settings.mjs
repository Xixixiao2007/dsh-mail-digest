/**
 * 设置界面：宿主端 HTTP 接口 + 一个单页配置页。
 *
 * 路由（都挂在 ctx.webServer 上）：
 *   GET  /dsh-mail-digest/            配置页（HTML）
 *   GET  /dsh-mail-digest/config      读配置（口令只回「是否已设置」）
 *   POST /dsh-mail-digest/config      写配置
 *   POST /dsh-mail-digest/test        按当前（或草稿）配置发一封测试邮件
 *   GET  /dsh-mail-digest/status      诊断
 *
 * 为什么不用 MCP 或命令行配置：用户要的是「放在设置里配置地址一类」，
 * 所以给一个能直接填邮箱、授权码、收件人的网页，填完点保存即生效。
 */
import { collectRecipients, describeReadiness, describeReplyReadiness, providerChoices, publicConfig, saveConfig, senderAddress } from './config.mjs'

const BODY_LIMIT = 256 * 1024

/** 读请求体（带上限，坏 JSON 不抛给框架）。 */
export function readJsonBody(request) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > BODY_LIMIT) {
        request.destroy()
        resolve(null)
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (chunks.length === 0) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        resolve(null)
      }
    })
    request.on('error', () => resolve(null))
  })
}

/** 回一段 JSON。 */
export function sendJson(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(body)
}

/** 回一段 HTML。 */
function sendHtml(response, status, html) {
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(html)
}

/** 转义插进 HTML 的文本。 */
function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * 配置页。刻意做成单文件、无构建、无外部依赖的页面——
 * 它只是往宿主端的 /dsh-mail-digest/config 读写 JSON。
 * @returns {string} HTML 文档。
 */
function settingsPage() {
  const presets = JSON.stringify(providerChoices())
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>邮件摘要 · 设置</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 32px 20px 64px;
    font: 15px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
    background: #f6f7f9; color: #1b1f24;
  }
  .wrap { max-width: 720px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 6px; }
  .sub { color: #5b6472; font-size: 13.5px; margin-bottom: 22px; }
  .card { background: #fff; border: 1px solid #e3e6ea; border-radius: 12px; padding: 20px 22px; margin-bottom: 16px; }
  .card h2 { font-size: 15px; margin: 0 0 16px; letter-spacing: .02em; color: #2c3440; }
  label { display: block; font-size: 13px; color: #444c58; margin-bottom: 6px; }
  .row { margin-bottom: 15px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  input[type=text], input[type=password], input[type=number], select {
    width: 100%; padding: 9px 11px; font-size: 14px; font-family: inherit;
    border: 1px solid #ccd2da; border-radius: 8px;
    /* 不要用 color: inherit：表单控件的文字色由浏览器按 color-scheme 决定，
       继承到的是外层文字色，深浅模式切换时就会变成「深底深字 / 白底白字」。 */
    background: #fff; color: #1b1f24;
    color-scheme: light;
  }
  input::placeholder, select::placeholder { color: #9aa3af; }
  select option { background: #fff; color: #1b1f24; }
  /* 浏览器自动填充会把背景刷成浅黄/浅蓝，用内阴影盖住并保持文字色可控 */
  input:-webkit-autofill, input:-webkit-autofill:hover, input:-webkit-autofill:focus {
    -webkit-text-fill-color: #1b1f24;
    -webkit-box-shadow: 0 0 0 1000px #fff inset;
    transition: background-color 9999s ease-out 0s;
  }
  input:focus, select:focus { outline: 2px solid #3b7ddd33; border-color: #3b7ddd; }
  .hint { font-size: 12px; color: #78828f; margin-top: 5px; }
  .check { display: flex; align-items: flex-start; gap: 9px; margin-bottom: 12px; }
  .check input { margin-top: 3px; accent-color: #2f6fd0; color-scheme: light; }
  .check label { margin: 0; font-size: 13.5px; color: #1b1f24; }
  .actions { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-top: 4px; }
  button {
    font: inherit; font-size: 14px; padding: 9px 18px; border-radius: 8px;
    border: 1px solid #ccd2da; background: #fff; color: #1b1f24; cursor: pointer;
  }
  button.primary { background: #2f6fd0; border-color: #2f6fd0; color: #fff; }
  button:disabled { opacity: .55; cursor: default; }
  .status { margin-top: 14px; font-size: 13px; padding: 10px 12px; border-radius: 8px; display: none; white-space: pre-wrap; }
  .status.ok { display: block; background: #e8f6ec; color: #17643a; border: 1px solid #b7e0c5; }
  .status.err { display: block; background: #fdecec; color: #9c2020; border: 1px solid #f4c2c2; }
  .status.info { display: block; background: #eef3fb; color: #274b80; border: 1px solid #c6d8f2; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 20px; font-size: 12px; background: #eef1f5; color: #4c5563; }
  .badge.on { background: #e8f6ec; color: #17643a; }
  .badge.off { background: #fdecec; color: #9c2020; }
  .foot { font-size: 12px; color: #78828f; margin-top: 10px; }
  code { background: #eef1f5; padding: 1px 5px; border-radius: 5px; font-size: 12.5px; }
  @media (prefers-color-scheme: dark) {
    body { background: #16191d; color: #e6e9ee; }
    .card { background: #1e2228; border-color: #2c323a; }
    .card h2 { color: #cfd6e0; }
    label { color: #a8b1bd; }
    /* 关键：深色模式下背景和文字色必须**成对**覆盖。
       只改 background 会让文字色停留在浅色模式的深灰 → 白底白字/深底深字。 */
    input[type=text], input[type=password], input[type=number], select {
      background: #12151a;
      color: #e6e9ee;
      border-color: #39414c;
      color-scheme: dark;
    }
    input::placeholder, select::placeholder { color: #6b7482; }
    /* 下拉列表展开后的选项在部分浏览器里不继承 select 的颜色，必须显式给 */
    select option { background: #12151a; color: #e6e9ee; }
    input:-webkit-autofill, input:-webkit-autofill:hover, input:-webkit-autofill:focus {
      -webkit-text-fill-color: #e6e9ee;
      -webkit-box-shadow: 0 0 0 1000px #12151a inset;
    }
    .check input { accent-color: #5b8fe0; color-scheme: dark; }
    .sub, .hint, .foot { color: #8b95a3; }
    .check label { color: #e6e9ee; }
    button { background: #232830; border-color: #39414c; color: #e6e9ee; }
    button.primary { background: #2f6fd0; border-color: #2f6fd0; color: #fff; }
    code { background: #232830; color: #d7dee8; }
    .foot code, .hint code { background: #2b313a; }
  }
</style>
</head>
<body>
<div class="wrap">
  <h1>邮件摘要</h1>
  <div class="sub">
    每轮回答结束后，把一条详略得当的中文摘要发到你的邮箱。
    状态：<span id="readyBadge" class="badge">读取中…</span>
  </div>

  <div class="card">
    <h2>邮箱账号</h2>
    <div class="row">
      <label for="provider">邮箱类型</label>
      <select id="provider"></select>
      <div class="hint" id="providerHint"></div>
    </div>
    <div class="grid">
      <div class="row">
        <label for="user">发件邮箱地址</label>
        <input type="text" id="user" placeholder="you@qq.com" autocomplete="off">
      </div>
      <div class="row">
        <label for="pass">授权码 / 密码</label>
        <input type="password" id="pass" placeholder="留空表示不修改" autocomplete="new-password">
        <div class="hint" id="passHint"></div>
      </div>
    </div>
    <div class="row">
      <label for="to">收件地址（可多个，逗号或换行分隔）</label>
      <input type="text" id="to" placeholder="留空 = 发给自己">
    </div>
  </div>

  <div class="card">
    <h2>服务器</h2>
    <div class="grid">
      <div class="row">
        <label for="host">SMTP 服务器</label>
        <input type="text" id="host" placeholder="smtp.qq.com">
      </div>
      <div class="row">
        <label for="port">端口</label>
        <input type="number" id="port" min="1" max="65535" placeholder="465">
      </div>
    </div>
    <div class="check">
      <input type="checkbox" id="secure">
      <label for="secure">使用 SSL/TLS（465 端口勾选；587 不勾，会自动 STARTTLS 升级）</label>
    </div>
    <div class="check">
      <input type="checkbox" id="allowInsecure">
      <label for="allowInsecure">允许未加密发送（仅本机 / 内网中继才勾；勾了等于把授权码明文发出去）</label>
    </div>
    <div class="row" style="margin-top:4px">
      <label for="fromName">发件人显示名</label>
      <input type="text" id="fromName" placeholder="DeepSeek Harness">
    </div>
    <div class="foot">选「自定义 SMTP」时上面三项自己填；选 QQ / 163 会自动填好，不用改。</div>
  </div>

  <div class="card">
    <h2>回信通道（双向）</h2>
    <div class="foot" style="margin:-8px 0 14px">
      开启后：我把提问发到你邮箱，你直接回邮件作答；每轮回答的邮件也能直接回复，内容会当作新消息续接对话。
      收信走 IMAP，账号和授权码默认与上面发信共用（QQ / 163 是同一个授权码）。
    </div>
    <div class="check">
      <input type="checkbox" id="replyEnabled">
      <label for="replyEnabled">启用回信通道（需要邮箱已开启 IMAP 服务）</label>
    </div>
    <div class="foot" style="margin:-4px 0 14px; line-height:1.9">
      <strong>回信怎么写</strong>（内容写在正文，主题保持原样别动）：<br>
      · 多个问题时，每个答案一行，<code>1. A</code> 然后换行 <code>2. B</code>；写在一行也行：<code>1. A 2. B</code><br>
      · 只有一个问题时，正文直接写选项字母，例如 <code>A</code><br>
      · 对某个选项不满意，就直接写你要的内容，例如 <code>1. 用私有仓库</code>
    </div>
    <div class="check">
      <input type="checkbox" id="replyAsk">
      <label for="replyAsk">提问（需要你选的时候）也发邮件</label>
    </div>
    <div class="check">
      <input type="checkbox" id="replyContinue">
      <label for="replyContinue">回答邮件的回信当作新消息，续接对话</label>
    </div>
    <div class="check">
      <input type="checkbox" id="replyUnseen">
      <label for="replyUnseen">只读未读回信（推荐，避免同一封被重复采纳）</label>
    </div>
    <div class="row">
      <label for="imapHost">IMAP 服务器（留空 = 按邮箱类型自动）</label>
      <input type="text" id="imapHost" placeholder="imap.qq.com">
    </div>
    <div class="grid">
      <div class="row">
        <label for="imapPort">IMAP 端口</label>
        <input type="number" id="imapPort" min="0" max="65535" placeholder="993">
      </div>
      <div class="row">
        <label for="imapMailbox">文件夹</label>
        <input type="text" id="imapMailbox" placeholder="INBOX">
      </div>
    </div>
    <div class="actions">
      <button id="testImap">测试收信</button>
    </div>
    <div class="foot">「测试收信」只验证 IMAP 能否登录，不会读你任何邮件内容。</div>
  </div>

  <div class="card">
    <h2>发信行为</h2>
    <div class="check">
      <input type="checkbox" id="enabled">
      <label for="enabled">启用邮件摘要（关掉之后一轮都不发）</label>
    </div>
    <div class="check">
      <input type="checkbox" id="includeSubagents">
      <label for="includeSubagents">子代理 / 委派回合也发（一次任务可能因此收到几十封，默认关）</label>
    </div>
    <div class="grid">
      <div class="row">
        <label for="digestMode">摘要来源</label>
        <select id="digestMode">
          <option value="auto">自动（我写的优先，没写就用模型压缩）</option>
          <option value="model">总是用模型压缩这一轮回答</option>
          <option value="off">不发信，只在日志里记一行</option>
        </select>
      </div>
      <div class="row">
        <label for="subjectPrefix">主题前缀</label>
        <input type="text" id="subjectPrefix" placeholder="[DSH]">
      </div>
    </div>
    <div class="grid">
      <div class="row">
        <label for="maxPerMinute">一分钟最多发几封（0 = 不限）</label>
        <input type="number" id="maxPerMinute" min="0" max="120">
      </div>
      <div class="row">
        <label for="minIntervalSeconds">同一会话最小间隔（秒，0 = 不限）</label>
        <input type="number" id="minIntervalSeconds" min="0" max="3600">
      </div>
    </div>
  </div>

  <div class="actions">
    <button class="primary" id="save">保存</button>
    <button id="test">发送测试邮件</button>
    <button id="reload">重新读取</button>
  </div>
  <div class="status" id="status"></div>
  <div class="foot" id="configPath"></div>
</div>

<script>
const PRESETS = ${presets};
const state = { passSet: false };

const el = (id) => document.getElementById(id);
const statusBox = el('status');

function setStatus(kind, text) {
  statusBox.className = 'status ' + kind;
  statusBox.textContent = text;
}

function findPreset(key) {
  return PRESETS.find((p) => p.key === key) || PRESETS[0];
}

function fillProviders() {
  const select = el('provider');
  select.innerHTML = '';
  for (const preset of PRESETS) {
    const option = document.createElement('option');
    option.value = preset.key;
    option.textContent = preset.label;
    select.appendChild(option);
  }
}

function syncProviderHint() {
  const preset = findPreset(el('provider').value);
  el('providerHint').textContent = preset.hint || '';
}

function applyPreset(key, force) {
  const preset = findPreset(key);
  if (!preset) return;
  if (force || !el('host').value.trim()) el('host').value = preset.host || '';
  if (force || !el('port').value.trim()) el('port').value = preset.port || 465;
  if (force) el('secure').checked = preset.secure === true;
  syncProviderHint();
}

function toList(value) {
  return String(value || '')
    .split(/[,，;\\n\\s]+/)
    .map((item) => item.trim())
    .filter((item) => item.includes('@'));
}

function collect() {
  return {
    enabled: el('enabled').checked,
    provider: el('provider').value,
    smtp: {
      host: el('host').value.trim(),
      port: Number(el('port').value) || 465,
      secure: el('secure').checked,
      allowInsecure: el('allowInsecure').checked,
      rejectUnauthorized: !el('allowInsecure').checked,
      user: el('user').value.trim(),
      pass: el('pass').value,
      fromName: el('fromName').value.trim(),
    },
    to: toList(el('to').value),
    subjectPrefix: el('subjectPrefix').value,
    includeSubagents: el('includeSubagents').checked,
    digestMode: el('digestMode').value,
    maxPerMinute: Number(el('maxPerMinute').value) || 0,
    minIntervalSeconds: Number(el('minIntervalSeconds').value) || 0,
    reply: {
      enabled: el('replyEnabled').checked,
      askViaEmail: el('replyAsk').checked,
      continueViaEmail: el('replyContinue').checked,
      unseenOnly: el('replyUnseen').checked,
    },
    imap: {
      host: el('imapHost').value.trim(),
      port: Number(el('imapPort').value) || 0,
      secure: true,
      user: '',
      // 留空 = 沿用已保存的（默认与 SMTP 共用同一个授权码）
      pass: '',
      mailbox: el('imapMailbox').value.trim() || 'INBOX',
    },
  };
}

function fill(config, meta) {
  state.passSet = Boolean(config.smtp.passSet);
  el('enabled').checked = config.enabled !== false;
  el('provider').value = config.provider || 'qq';
  el('host').value = config.smtp.host || '';
  el('port').value = config.smtp.port || 465;
  el('secure').checked = config.smtp.secure !== false;
  el('allowInsecure').checked = config.smtp.allowInsecure === true;
  el('user').value = config.smtp.user || '';
  el('pass').value = '';
  el('passHint').textContent = state.passSet ? '已保存（留空表示不修改）' : '还没填';
  el('fromName').value = config.smtp.fromName || '';
  el('to').value = (config.to || []).join(', ');
  el('subjectPrefix').value = config.subjectPrefix ?? '';
  el('includeSubagents').checked = config.includeSubagents === true;
  el('digestMode').value = config.digestMode || 'auto';
  el('maxPerMinute').value = config.maxPerMinute ?? 0;
  el('minIntervalSeconds').value = config.minIntervalSeconds ?? 0;
  const reply = config.reply || {};
  el('replyEnabled').checked = reply.enabled === true;
  el('replyAsk').checked = reply.askViaEmail !== false;
  el('replyContinue').checked = reply.continueViaEmail !== false;
  el('replyUnseen').checked = reply.unseenOnly !== false;
  const imap = config.imap || {};
  el('imapHost').value = imap.host || '';
  el('imapPort').value = imap.port || '';
  el('imapMailbox').value = imap.mailbox || 'INBOX';
  if (meta) {
    const badge = el('readyBadge');
    const parts = [];
    parts.push(meta.ready ? '发信就绪' : ('还缺：' + (meta.missing || []).join('、')));
    if (meta.replyReady) parts.push('回信就绪');
    else if (reply.enabled) parts.push('回信还缺：' + ((meta.replyMissing || []).join('、') || '配置'));
    badge.textContent = parts.join(' · ');
    badge.className = 'badge ' + (meta.ready ? 'on' : 'off');
    el('configPath').textContent = meta.configPath ? ('配置文件：' + meta.configPath) : '';
  }
  syncProviderHint();
}

async function load() {
  try {
    const response = await fetch('/dsh-mail-digest/config', { headers: { accept: 'application/json' } });
    const data = await response.json();
    fill(data.config, data);
    setStatus('info', '已读取当前配置。');
  } catch (error) {
    setStatus('err', '读取失败：' + error.message);
  }
}

el('provider').addEventListener('change', () => {
  const key = el('provider').value;
  if (key !== 'custom') applyPreset(key, true);
  else syncProviderHint();
});

el('save').addEventListener('click', async () => {
  el('save').disabled = true;
  setStatus('info', '正在保存…');
  try {
    const response = await fetch('/dsh-mail-digest/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ config: collect() }),
    });
    const data = await response.json();
    if (!data.ok) {
      setStatus('err', '保存失败：' + (data.error || response.status));
    } else {
      fill(data.config, data);
      const warnings = (data.warnings || []).join('；');
      setStatus('ok', '已保存。' + (data.ready ? '配置完整，可以发信。' : ('还缺：' + (data.missing || []).join('、'))) + (warnings ? ('\\n' + warnings) : ''));
    }
  } catch (error) {
    setStatus('err', '保存失败：' + error.message);
  } finally {
    el('save').disabled = false;
  }
});

el('test').addEventListener('click', async () => {
  el('test').disabled = true;
  setStatus('info', '正在发送测试邮件…');
  try {
    const response = await fetch('/dsh-mail-digest/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ config: collect() }),
    });
    const data = await response.json();
    if (data.ok) setStatus('ok', '测试邮件已发出 → ' + (data.to || []).join(', ') + (data.note ? ('\\n' + data.note) : ''));
    else setStatus('err', '发送失败：' + (data.error || response.status));
  } catch (error) {
    setStatus('err', '发送失败：' + error.message);
  } finally {
    el('test').disabled = false;
  }
});

el('reload').addEventListener('click', load);

el('testImap').addEventListener('click', async () => {
  el('testImap').disabled = true;
  setStatus('info', '正在测试收信（IMAP 登录）…');
  try {
    const response = await fetch('/dsh-mail-digest/test-imap', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ config: collect() }),
    });
    const data = await response.json();
    if (data.ok) setStatus('ok', '收信可用：IMAP 登录成功（' + (data.host || '') + ':' + (data.port || '') + '）');
    else setStatus('err', '收信不可用：' + (data.error || response.status));
  } catch (error) {
    setStatus('err', '测试失败：' + error.message);
  } finally {
    el('testImap').disabled = false;
  }
});

fillProviders();
load();
</script>
</body>
</html>
`
}

/**
 * 挂载设置界面的全部 HTTP 路由。
 * @param {object} options
 * @param {any} options.webServer - `ctx.webServer` 服务。
 * @param {() => object} options.getConfig - 读当前配置。
 * @param {() => string} options.getConfigPath - 配置文件路径。
 * @param {(draft: object) => Promise<{ok: boolean, reason?: string}>} options.sendTest - 发测试邮件。
 * @param {(level: string, message: string) => void} options.log - 日志。
 * @returns {() => void} 统一卸载函数。
 */
export function registerSettingsRoutes({ webServer, getConfig, getConfigPath, sendTest, testImapConnect, log }) {
  const disposers = []

  disposers.push(webServer.register({
    kind: 'exact',
    path: '/dsh-mail-digest',
    handler: (request, response) => {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405, { allow: 'GET', 'content-type': 'text/plain; charset=utf-8' })
        return response.end('use GET')
      }
      sendHtml(response, 200, settingsPage())
    },
  }))

  // 带尾斜杠的同一页，避免有人手输地址时 404。
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/dsh-mail-digest/',
    handler: (request, response) => {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405, { allow: 'GET', 'content-type': 'text/plain; charset=utf-8' })
        return response.end('use GET')
      }
      sendHtml(response, 200, settingsPage())
    },
  }))

  disposers.push(webServer.register({
    kind: 'exact',
    path: '/dsh-mail-digest/config',
    handler: async (request, response) => {
      if (request.method === 'GET') {
        const cfg = getConfig()
        const readiness = describeReadiness(cfg)
        const replyReadiness = describeReplyReadiness(cfg)
        return sendJson(response, 200, {
          ok: true,
          config: publicConfig(cfg),
          ready: readiness.ready,
          missing: readiness.missing,
          replyReady: replyReadiness.ready,
          replyMissing: replyReadiness.missing,
          configPath: getConfigPath(),
          presets: providerChoices(),
        })
      }
      if (request.method !== 'POST' && request.method !== 'PUT') {
        response.writeHead(405, { allow: 'GET, POST', 'content-type': 'application/json; charset=utf-8' })
        return response.end(JSON.stringify({ error: 'use GET or POST' }))
      }
      const body = await readJsonBody(request)
      if (!body || typeof body !== 'object') return sendJson(response, 400, { ok: false, error: '请求体不是合法 JSON' })
      const saved = saveConfig(body.config ?? body)
      if (!saved.ok) return sendJson(response, 500, { ok: false, error: saved.error })
      const readiness = describeReadiness(saved.value)
      log('info', `设置已更新（${saved.path}）`)
      sendJson(response, 200, {
        ok: true,
        config: publicConfig(saved.value),
        ready: readiness.ready,
        missing: readiness.missing,
        configPath: saved.path,
        presets: providerChoices(),
      })
    },
  }))

  disposers.push(webServer.register({
    kind: 'exact',
    path: '/dsh-mail-digest/test',
    handler: async (request, response) => {
      if (request.method !== 'POST') return sendJson(response, 405, { error: 'use POST' })
      const body = await readJsonBody(request)
      const draft = body && typeof body === 'object' && body.config ? body.config : null
      try {
        const result = await sendTest(draft)
        if (!result.ok) return sendJson(response, 400, { ok: false, error: result.reason ?? '发送失败' })
        sendJson(response, 200, { ok: true, to: result.to, messageId: result.messageId })
      } catch (error) {
        sendJson(response, 500, { ok: false, error: error.message })
      }
    },
  }))

  disposers.push(webServer.register({
    kind: 'exact',
    path: '/dsh-mail-digest/test-imap',
    handler: async (request, response) => {
      if (request.method !== 'POST') return sendJson(response, 405, { error: 'use POST' })
      const body = await readJsonBody(request)
      const draft = body && typeof body === 'object' && body.config ? body.config : null
      try {
        const result = await testImapConnect(draft)
        if (!result.ok) return sendJson(response, 200, { ok: false, error: result.reason ?? '收信不可用' })
        sendJson(response, 200, { ok: true, host: result.host, port: result.port })
      } catch (error) {
        sendJson(response, 200, { ok: false, error: error.message })
      }
    },
  }))

  disposers.push(webServer.register({
    kind: 'exact',
    path: '/dsh-mail-digest/status',
    handler: (request, response) => {
      const cfg = getConfig()
      const readiness = describeReadiness(cfg)
      const replyReadiness = describeReplyReadiness(cfg)
      sendJson(response, 200, {
        enabled: cfg.enabled,
        digestMode: cfg.digestMode,
        ready: readiness.ready,
        missing: readiness.missing,
        replyEnabled: cfg.reply?.enabled === true,
        replyReady: replyReadiness.ready,
        replyMissing: replyReadiness.missing,
        from: senderAddress(cfg),
        to: collectRecipients(cfg),
        smtp: { host: cfg.smtp.host, port: cfg.smtp.port, secure: cfg.smtp.secure },
        configPath: getConfigPath(),
      })
    },
  }))

  return () => {
    for (const dispose of disposers) {
      try { dispose() } catch { /* 卸载失败不影响其他路由 */ }
    }
  }
}
