/**
 * 零依赖 IMAP 客户端 + MIME 正文抽取。
 *
 * 只实现「读收件箱里匹配某主题标记的未读回复」所需的最小子集：
 *   greeting → LOGIN → SELECT INBOX → UID SEARCH → UID FETCH → LOGOUT
 *
 * 为什么不用 imapflow/nodemailer：DSH 运行时的 node_modules 里没有它们，
 * 本插件要以软链方式装进 profile，不能依赖要联网安装的包。
 *
 * 关键实现点：
 *   - 用 IMAP 字面量（`{n}`）逐段读：FETCH 的 BODY[] 是字面量，不能按行读；
 *   - 用 `BODY.PEEK[]` 而不是 `BODY[]`，避免把用户的邮件标记成已读；
 *   - 只取 text/plain 部（没有才退回 text/html 转纯文本），并剥掉引用历史，
 *     否则用户回复里带的原文会把答案解析带偏。
 */
import net from 'node:net'
import tls from 'node:tls'
import { once } from 'node:events'
// 引用剥离只有一份实现，放在 reply.mjs（那是回复解析的地方）。
// 这里重新导出，保持既有导入路径可用——**不要再复制一份**，
// 两份同名实现会让「改了 A 却生效的是 B」这种事故悄悄发生。
import { stripQuoted } from './reply.mjs'

export { stripQuoted }

const CRLF = '\r\n'

/** IMAP 服务器预置。QQ/163 都用授权码登录。 */
export const IMAP_PRESETS = {
  qq: { host: 'imap.qq.com', port: 993, secure: true },
  '163': { host: 'imap.163.com', port: 993, secure: true },
  '126': { host: 'imap.126.com', port: 993, secure: true },
}

/** IMAP 层错误，带服务器应答便于排查。 */
export class ImapError extends Error {
  constructor(message, response) {
    super(message)
    this.name = 'ImapError'
    this.response = response
  }
}

/**
 * IMAP 连接：带字面量感知的读取器。
 *
 * IMAP 的应答有两种形态：普通行（`* OK ...`），和带字面量的行
 * （`* 1 FETCH (BODY[] {12345}` 后面**紧跟 12345 字节原始数据**）。
 * 所以不能简单按行 split，必须先看行尾有没有 `{n}` 再决定读多少。
 */
class ImapConnection {
  constructor(socket, { timeoutMs }) {
    this.socket = socket
    this.timeoutMs = timeoutMs
    this.buffer = Buffer.alloc(0)
    this.waiters = []
    this.failure = null
    this.closed = false
    this.tagSeq = 0
    this.onData = (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk])
      this.pump()
    }
    this.onError = (error) => this.fail(error)
    this.onClose = () => this.fail(new Error('IMAP 连接被服务器关闭'))
    socket.setTimeout(timeoutMs, () => this.fail(new Error(`IMAP 操作超时（${timeoutMs}ms）`)))
    socket.on('data', this.onData)
    socket.on('error', this.onError)
    socket.on('close', this.onClose)
  }

  fail(error) {
    if (this.failure || this.closed) return
    this.failure = error
    const waiters = this.waiters
    this.waiters = []
    for (const waiter of waiters) waiter.reject(error)
  }

  /** 有新数据时唤醒等待者，让它自己再试着匹配一次。 */
  pump() {
    for (const waiter of [...this.waiters]) {
      try {
        waiter.try()
      } catch (error) {
        this.fail(error)
      }
    }
  }

  /** 注册一个「条件满足就 resolve」的等待。 */
  wait(tryFn) {
    if (this.failure) return Promise.reject(this.failure)
    return new Promise((resolve, reject) => {
      const waiter = {
        try: () => {
          const value = tryFn()
          if (value === undefined) return
          this.waiters = this.waiters.filter((w) => w !== waiter)
          resolve(value)
        },
        reject,
      }
      this.waiters.push(waiter)
      waiter.try()
    })
  }

  /** 读一行（含 CRLF），行内以 latin1 解释（IMAP 应答都是 ASCII）。 */
  readLine() {
    return this.wait(() => {
      const idx = this.buffer.indexOf(CRLF)
      if (idx < 0) return undefined
      const line = this.buffer.subarray(0, idx).toString('latin1')
      this.buffer = this.buffer.subarray(idx + 2)
      return line
    })
  }

  /** 精确读 n 字节（字面量体）。 */
  readExact(n) {
    return this.wait(() => {
      if (this.buffer.length < n) return undefined
      const data = this.buffer.subarray(0, n)
      this.buffer = this.buffer.subarray(n)
      return data
    })
  }

  write(text) {
    return new Promise((resolve, reject) => {
      if (this.failure) return reject(this.failure)
      this.socket.write(text, (error) => (error ? reject(error) : resolve()))
    })
  }

  /** 下一个命令标签。 */
  nextTag() {
    this.tagSeq += 1
    return `a${String(this.tagSeq).padStart(4, '0')}`
  }

  /**
   * 发一条命令并读到 tagged 应答，途中收集所有 untagged 行与字面量。
   * @param {string} command - 命令体（不含标签）。
   * @param {object} [options] - { literalReader?: () => Promise<void> }
   * @returns {Promise<{ok: boolean, lines: string[], text: string}>}
   */
  async run(command, options = {}) {
    const tag = this.nextTag()
    await this.write(`${tag} ${command}${CRLF}`)
    const lines = []
    for (;;) {
      const line = await this.readLine()
      if (line.startsWith(`${tag} `)) {
        const ok = /^OK\b/i.test(line.slice(tag.length + 1).trim())
        return { ok, lines, text: line }
      }
      // 行尾的字面量：读掉 n 字节再继续（内容交给 literalReader 决定怎么用）。
      const literal = /\{(\d+)\}$/.exec(line)
      if (literal) {
        const size = Number(literal[1])
        lines.push(line)
        const data = await this.readExact(size)
        if (options.onLiteral) options.onLiteral(line, data, lines)
        else lines.push(`<literal ${size} bytes>`)
        continue
      }
      lines.push(line)
    }
  }

  /** 发完命令就走，不等完整应答（logout 用）。 */
  async bye() {
    try {
      await this.write(`${this.nextTag()} LOGOUT${CRLF}`)
    } catch { /* 忽略 */ }
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.socket.off('data', this.onData)
    this.socket.off('error', this.onError)
    this.socket.off('close', this.onClose)
    try { this.socket.setTimeout(0) } catch { /* 已销毁 */ }
    try { this.socket.destroy() } catch { /* 已关闭 */ }
  }
}

/** 建立 IMAP 连接（现在是隐式 TLS；明文变体留给本机中继）。 */
async function connect({ host, port, secure = true, rejectUnauthorized = true, timeoutMs }) {
  const socket = secure
    ? tls.connect({ host, port, servername: host, rejectUnauthorized })
    : net.connect({ host, port })
  socket.setNoDelay(true)
  const event = secure ? 'secureConnect' : 'connect'
  const timer = setTimeout(() => socket.destroy(new Error(`连接 ${host}:${port} 超时`)), timeoutMs)
  try {
    await once(socket, event)
  } catch (error) {
    clearTimeout(timer)
    socket.destroy()
    throw new Error(`无法连接 ${host}:${port}：${error.message}`)
  }
  clearTimeout(timer)
  return socket
}

/** 解析 IMAP 里带引号或字面量的字符串（够用即可）。 */
function unquote(value) {
  const text = String(value ?? '').trim()
  if (text.startsWith('"') && text.endsWith('"')) return text.slice(1, -1).replace(/\\(.)/g, '$1')
  return text
}

/** 把 IMAP 内部的 modified UTF-7 转成正常字符串（中文邮箱文件夹名用得上）。 */
function fromModifiedUtf7(text) {
  return String(text ?? '').replace(/&([A-Za-z0-9+,]*)-/g, (whole, body) => {
    if (!body) return '&'
    try {
      const b64 = body.replace(/,/g, '/')
      const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
      const buf = Buffer.from(padded, 'base64')
      let out = ''
      for (let i = 0; i + 1 < buf.length; i += 2) out += String.fromCharCode(buf.readUInt16BE(i))
      return out
    } catch {
      return whole
    }
  })
}

// ── MIME 解析 ──────────────────────────────────────────────────────

/** 宽松解析头部：`Name: value`，支持折行续行。 */
function parseHeaders(block) {
  const headers = {}
  const lines = String(block ?? '').split(/\r?\n/)
  let current = null
  for (const line of lines) {
    if (/^[ \t]/.test(line) && current) {
      headers[current] += ` ${line.trim()}`
      continue
    }
    const match = /^([!-9;-~]+):\s*(.*)$/.exec(line)
    if (!match) continue
    current = match[1].toLowerCase()
    headers[current] = match[2]
  }
  return headers
}

/** 按 RFC 2047 解码头部里的编码字。 */
export function decodeEncodedWords(text) {
  return String(text ?? '').replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (whole, charset, enc, payload) => {
    try {
      const buf = enc.toUpperCase() === 'B'
        ? Buffer.from(payload, 'base64')
        : Buffer.from(payload.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (m, hex) => String.fromCharCode(parseInt(hex, 16))), 'binary')
      const name = String(charset).toLowerCase()
      if (name === 'utf-8' || name === 'utf8') return buf.toString('utf8')
      if (name === 'gb2312' || name === 'gbk' || name === 'gb18030') {
        // Node 没有内置 GBK 解码；用 TextDecoder 的 gbk 支持（Node 内置 ICU 提供）。
        try { return new TextDecoder('gbk').decode(buf) } catch { return buf.toString('latin1') }
      }
      if (name === 'iso-8859-1' || name === 'latin1') return buf.toString('latin1')
      try { return new TextDecoder(name).decode(buf) } catch { return buf.toString('utf8') }
    } catch {
      return whole
    }
  })
}

/**
 * 按 Content-Transfer-Encoding 把正文解成**字节**（返回 Buffer）。
 *
 * 关键：这里不能顺手 `toString('utf8')`。正文的真实字符集写在 charset 参数里
 * （QQ 回信常见 gb18030/gbk），必须把原始字节保留到按 charset 解码的那一步，
 * 否则中文会变成 `B\uFFFD8\u9F49` 这种乱码——字节被当成了字符。
 *
 * @param {string} body - 正文原文。
 * @param {string} encoding - content-transfer-encoding 的值。
 * @returns {Buffer} 原始字节。
 */
function decodeBody(body, encoding) {
  const enc = String(encoding ?? '7bit').toLowerCase().trim()
  const source = String(body ?? '')
  if (enc === 'base64') {
    try { return Buffer.from(source.replace(/\s+/g, ''), 'base64') } catch { return Buffer.from(source, 'latin1') }
  }
  if (enc === 'quoted-printable') {
    // `=XX` 是**一个字节**，所以回填成字节而不是字符（latin1 保住 0x80-0xFF）。
    const text = source
      .replace(/=(?:\r\n|\n)/g, '')
      .replace(/=([0-9A-Fa-f]{2})/g, (m, hex) => String.fromCharCode(parseInt(hex, 16)))
    return Buffer.from(text, 'latin1')
  }
  // 7bit / 8bit / binary：字节直接就是内容
  return Buffer.from(source, 'latin1')
}

/**
 * 按 charset 把**字节**解成字符串。
 * @param {Buffer} bytes - 原始字节。
 * @param {string} charset - charset 参数（可能带引号）。
 * @returns {string} 解码后的文本。
 */
function toText(bytes, charset) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes ?? ''), 'latin1')
  const name = String(charset ?? 'utf-8').toLowerCase().replace(/["']/g, '').trim()
  if (!name || name === 'utf-8' || name === 'utf8' || name === 'us-ascii' || name === 'ascii') {
    return buf.toString('utf8')
  }
  // 部分客户端写 gb2312，实际发的是 gbk/gb18030 范围
  const normalized = name === 'gb2312' || name === 'gb-2312' ? 'gbk' : name
  try {
    return new TextDecoder(normalized).decode(buf)
  } catch {
    try { return buf.toString('utf8') } catch { return buf.toString('latin1') }
  }
}

/** 极简 HTML → 纯文本（只在没有 text/plain 部时兜底）。 */
export function htmlToText(html) {
  return String(html ?? '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * 从一整封原始邮件里抽出最适合当「用户回复正文」的文本。
 * 优先 text/plain，没有就用 text/html 转纯文本。
 *
 * 入参可以是 Buffer（推荐：保留原始字节，charset 才能正确解码）或字符串。
 *
 * @param {Buffer|string} raw - 原始邮件（含头部）。
 * @returns {{subject: string, from: string, text: string, html: boolean, messageId: string, references: string, inReplyTo: string}}
 */
export function extractMessageText(raw) {
  // 统一成「latin1 字符串」来处理：latin1 是字节与字符一一对应的，
  // 这样头部解析与正文切分都不会破坏字节；真正按 charset 解码放在 toText。
  const source = Buffer.isBuffer(raw) ? raw.toString('latin1') : String(raw ?? '')
  const split = source.search(/\r?\n\r?\n/)
  const headText = split < 0 ? source : source.slice(0, split)
  let bodyText = split < 0 ? '' : source.slice(split).replace(/^(\r?\n)+/, '')
  const headers = parseHeaders(headText)
  const subject = decodeEncodedWords(unquote(headers.subject))
  const from = decodeEncodedWords(unquote(headers.from))
  // 线程凭据：回信会带着我们发出邮件的 Message-ID。
  const messageId = unquote(headers['message-id'])
  const references = String(headers.references ?? '')
  const inReplyTo = String(headers['in-reply-to'] ?? '')

  const contentType = String(headers['content-type'] ?? '')
  const boundaryMatch = /boundary\s*=\s*("([^"]+)"|([^;\s]+))/i.exec(contentType)
  const boundary = boundaryMatch ? (boundaryMatch[2] ?? boundaryMatch[3]) : null

  if (!boundary) {
    const decoded = decodeBody(bodyText, headers['content-transfer-encoding'])
    const text = toText(decoded, /charset\s*=\s*"?([^";]+)"?/i.exec(contentType)?.[1])
    if (/text\/html/i.test(contentType)) {
      return { subject, from, text: htmlToText(text), html: true, messageId, references, inReplyTo }
    }
    return { subject, from, text, html: false, messageId, references, inReplyTo }
  }

  // multipart：按 boundary 切成若干部，挑第一个 text/plain，否则第一个 text/html。
  const parts = bodyText.split(new RegExp(`--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?`))
  let plain = ''
  let html = ''
  for (const part of parts) {
    const trimmed = part.replace(/^\r?\n/, '')
    const sep = trimmed.search(/\r?\n\r?\n/)
    const partHead = sep < 0 ? trimmed : trimmed.slice(0, sep)
    const partBody = sep < 0 ? '' : trimmed.slice(sep).replace(/^(\r?\n)+/, '')
    const partHeaders = parseHeaders(partHead)
    const partType = String(partHeaders['content-type'] ?? '')
    const decoded = decodeBody(partBody, partHeaders['content-transfer-encoding'])
    const text = toText(decoded, /charset\s*=\s*"?([^";]+)"?/i.exec(partType)?.[1])
    if (/text\/plain/i.test(partType) && !plain) plain = text
    else if (/text\/html/i.test(partType) && !html) html = htmlToText(text)
  }
  if (plain) return { subject, from, text: plain, html: false, messageId, references, inReplyTo }
  return { subject, from, text: html, html: true, messageId, references, inReplyTo }
}

/**
 * 决定「这一轮到底按什么顺序去拉哪些 UID」—— 纯函数，便于回归测试。
 *
 * 规则（对应 2026-09-23 那个「邮件批准一直没反应」的 bug）：
 *   1. 服务端精确定位到的 UID（`preciseUids`）排最前：它们是最可能包含
 *      我们那封回信的邮件，而且不受邮箱大小影响；
 *   2. 其余候选按 **新 → 旧**（`allUids` 是升序 UID，取尾部再反转）；
 *   3. 这里**不做任何条数截断** —— 截断只能发生在"返回结果"那一步
 *      （见 fetchReplies 末尾的 slice）。在候选阶段截断正是原 bug：
 *      旧邮件占满名额，新回复被无声丢弃。
 *
 * @param {object} options
 * @param {string[]} options.allUids - 该文件夹全部 UID（升序）。
 * @param {Iterable<string>} [options.preciseUids] - 精确命中的 UID。
 * @param {number} options.scanWindow - 宽松兜底看最近多少封（成本控制靠它）。
 * @returns {string[]} 要依次拉取的 UID 列表（完整、有序、不截断）。
 */
export function rankCandidateUids({ allUids, preciseUids, scanWindow }) {
  const precise = []
  const preciseSeen = new Set()
  for (const uid of preciseUids ?? []) {
    const value = String(uid ?? '')
    if (!value || preciseSeen.has(value)) continue
    preciseSeen.add(value)
    precise.push(value)
  }

  const queue = []
  const queued = new Set()
  const add = (uid) => {
    const value = String(uid ?? '')
    if (!value || queued.has(value) || preciseSeen.has(value)) return
    queued.add(value)
    queue.push(value)
  }
  const list = Array.isArray(allUids) ? allUids : []
  const window = Math.max(0, Math.floor(Number(scanWindow) || 0))
  // 新 → 旧：尾部是最新的。
  for (const uid of (window > 0 ? list.slice(-window) : list).slice().reverse()) add(uid)

  // 精确命中优先，其余保持"新→旧"。
  return [...precise, ...queue]
}

/**
 * 列出收件箱里主题包含某标记的邮件（默认只要未读）。
 * @param {object} options
 * @param {string} options.host - IMAP 主机。
 * @param {number} [options.port] - 端口，默认 993。
 * @param {boolean} [options.secure] - 是否隐式 TLS，默认 true。
 * @param {string} options.user - 登录账号。
 * @param {string} options.pass - 授权码。
 * @param {string} options.marker - 主题里要匹配的纯 ASCII 标记。
 * @param {string[]} [options.markers] - 已知的**完整线程标记**列表，用于服务端精确定位。
 * @param {boolean} [options.unseenOnly] - 是否只找未读，默认 true。
 * @param {number} [options.limit] - 最多**返回**几封，默认 10。
 * @param {number} [options.window] - 候选窗口（看最近的多少封），默认 max(limit*4, 40)。
 * @param {string} [options.mailbox] - 邮箱文件夹，默认 INBOX。
 * @param {number} [options.timeoutMs] - 超时，默认 20000。
 * @returns {Promise<Array<{uid: string, raw: string, subject: string, from: string, text: string}>>}
 */
export async function fetchReplies(options) {
  const {
    host,
    port = 993,
    secure = true,
    rejectUnauthorized = true,
    user,
    pass,
    marker,
    markers,
    unseenOnly = true,
    limit = 10,
    window: windowSize,
    mailbox = 'INBOX',
    mailboxes,
    autoDiscover = false,
    timeoutMs = 20_000,
  } = options ?? {}

  if (!host) throw new Error('缺少 IMAP 主机')
  if (!user || !pass) throw new Error('缺少 IMAP 账号或授权码')
  if (!marker) throw new Error('缺少要匹配的主题标记')

  // 要搜哪些文件夹：
  //   - 显式给了 mailboxes 就用给的；
  //   - 否则若 autoDiscover 为真，在**同一条连接**里枚举文件夹，
  //     优先 INBOX 与「已发送」（163 对每 IP 的 IMAP 连接数有限，不能为每个文件夹新开连接）；
  //   - 再否则就只搜 INBOX。
  let targets = (Array.isArray(mailboxes) && mailboxes.length ? mailboxes : [])
    .filter((name) => typeof name === 'string' && name.trim())

  const connection = new ImapConnection(
    await connect({ host, port, secure, rejectUnauthorized, timeoutMs }),
    { timeoutMs },
  )

  try {
    const greeting = await connection.readLine()
    if (!/^\*\s+(OK|PREAUTH)/i.test(greeting)) {
      throw new ImapError(`IMAP 服务器未就绪：${greeting}`, greeting)
    }

    const login = await connection.run(`LOGIN ${quoteString(user)} ${quoteString(pass)}`)
    if (!login.ok) {
      throw new ImapError(
        /AUTHENTICATIONFAILED|invalid credentials|LOGIN failed/i.test(login.text)
          ? 'IMAP 登录失败：账号或授权码不对。QQ/163 要用网页版邮箱生成的授权码，并且要在设置里开启 IMAP 服务。'
          : `IMAP 登录失败：${login.text}`,
        login.text,
      )
    }

    // 163 / Coremail 要求先报身份，否则 SELECT 会被拒（Unsafe Login）。
    await sendClientId(connection)

    if (targets.length === 0) {
      if (autoDiscover) {
        const listed = await connection.run('LIST "" "*"')
        const all = []
        for (const line of listed.lines) {
          if (/\\Noselect/i.test(line)) continue
          const name = parseListLine(line)
          if (name && !all.includes(name)) all.push(name)
        }
        targets = pickMailboxes(all.length ? all : [mailbox])
      } else {
        targets = [mailbox]
      }
    }
    targets = targets.slice(0, 12)

    const results = []
    const seen = new Set()

    // ── 两套定位策略 ────────────────────────────────────────────────
    //
    // 踩过的坑（2026-09-23 实测，导致「邮件批准一直没反应」）：
    // 原实现用 `allUids.slice(-max(limit*4, 40))` 取候选，且**从最旧往最新扫**、
    // 扫满 `limit` 封就 break。用户每一封摘要邮件都会回一次，于是 20 个名额被
    // 旧回信占满 —— 他最新那封审批回信排在候选之外，**永远轮不到**，
    // 现象就是「我回了邮件批准，等了很久毫无反应」。
    //
    // 现在三重修正：
    //   ① **从最新往回扫**（新回复优先，回复是实时的，旧的沉底无所谓）；
    //   ② `limit` 只限制**返回条数**，扫到就继续找、不再因为满了而漏掉新邮件；
    //   ③ 额外支持 `markers`（我们已知的完整线程标记）做**服务端精确定位**，
    //      邮箱再大也能直接命中 —— 不依赖"最近 N 封"这种会过期的假设。
    //
    // 注意 ③ 是**增强**不是必需：163 对 MIME 编码主题的服务端搜索不可靠
    // （见下方注释），所以它失败时自动退回 ①② 的宽松扫描。
    const precisePattern = []
    for (const value of Array.isArray(markers) ? markers : []) {
      const cleaned = String(value ?? '').replace(/\s+/g, '')
      if (cleaned && !precisePattern.includes(cleaned)) precisePattern.push(cleaned)
      if (precisePattern.length >= 10) break
    }

    const scanWindow = Math.max(
      Number.isFinite(windowSize) && windowSize > 0 ? Math.floor(windowSize) : 0,
      limit * 4,
      40,
    )

    for (const target of targets) {
      const selected = await connection.run(`SELECT ${quoteString(target)}`)
      if (!selected.ok) {
        if (/Unsafe Login/i.test(selected.text)) throw new ImapError(explainSelectFailure(target, selected.text), selected.text)
        continue   // 其他原因打不开的文件夹跳过，不影响别的
      }

      // ── 取候选邮件，**在本地匹配主题** ────────────────────────────
      //
      // 为什么不用服务端 `UID SEARCH SUBJECT "..."`：163 对 MIME 编码过的主题
      // （`=?gb18030?B?...?=`）匹配不到——实测 `UID SEARCH ALL` 能列出 7 封，
      // 而 `UID SEARCH SUBJECT "DSH-"` 返回空。所以宽松扫描要靠 `UID SEARCH ALL`
      // 拿回来自己比对；而下面针对**完整标记**的精确搜索是对它的补充尝试。
      const search = await connection.run('UID SEARCH ALL')
      if (!search.ok) continue
      const uidLine = search.lines.find((line) => /^\*\s+SEARCH/i.test(line)) ?? ''
      const allUids = uidLine.replace(/^\*\s+SEARCH\s*/i, '').trim().split(/\s+/).filter(Boolean)

      const preciseUids = new Set()
      // ③ 精确：直接问服务器「哪些邮件的主题里有这一串」。
      for (const label of precisePattern) {
        const hit = await connection.run(`UID SEARCH SUBJECT ${quoteString(label)}`)
        if (!hit.ok) continue
        const line = hit.lines.find((l) => /^\*\s+SEARCH/i.test(l)) ?? ''
        for (const uid of line.replace(/^\*\s+SEARCH\s*/i, '').trim().split(/\s+/).filter(Boolean)) {
          preciseUids.add(uid)
        }
      }

      // 精确命中在前，其余按"新→旧"兜底；不在这里截断。
      const scanList = rankCandidateUids({ allUids, preciseUids, scanWindow })

      for (const uid of scanList) {
        const key = `${target}:${uid}`
        if (seen.has(key)) continue
        seen.add(key)

        let rawBytes = null
        let flags = ''
        const fetchedMail = await connection.run(`UID FETCH ${uid} (FLAGS BODY.PEEK[])`, {
          onLiteral: (line, data) => {
            // **保留原始字节**：正文可能是 GBK 等非 UTF-8 编码，
            // 这里若先 toString('utf8') 就把字节毁了，后面按 charset 解码也救不回来。
            if (/BODY\[/i.test(line)) rawBytes = data
          },
        })
        if (!fetchedMail.ok || !rawBytes) continue
        const flagLine = fetchedMail.lines.find((line) => /FLAGS/i.test(line)) ?? ''
        flags = flagLine

        // 本地判断未读（\Seen 是服务端权威标记）
        if (unseenOnly && /\\Seen/i.test(flags)) continue

        const parsed = extractMessageText(rawBytes)
        // 本地匹配主题标记
        if (marker && !subjectMatches(parsed.subject, marker)) continue

        results.push({
          uid: key,
          mailbox: target,
          // 给人看的文本（UTF-8 近似）与用于解码的字节都留着
          raw: rawBytes.toString('utf8'),
          rawBytes,
          ...parsed,
          text: stripQuoted(parsed.text),
        })
      }
    }
    await connection.bye()
    // 只限制**返回条数**：调用方拿到的永远是"最新的 limit 封"，
    // 不会因为旧邮件多就让新回复消失（那正是之前的 bug）。
    return results.slice(-Math.max(limit, 1))
  } finally {
    connection.close()
  }
}

/**
 * 取某文件夹里最近的若干封邮件（不筛主题），用于诊断「这个账号到底发过什么」。
 * @param {object} options - 连接参数，另有 { mailbox, limit }。
 * @returns {Promise<Array<object>>} 与 fetchReplies 相同形状的邮件数组。
 */
export async function fetchRecent(options) {
  const {
    host,
    port = 993,
    secure = true,
    rejectUnauthorized = true,
    user,
    pass,
    mailbox = 'INBOX',
    limit = 10,
    timeoutMs = 20_000,
  } = options ?? {}
  if (!host || !user || !pass) return []
  const connection = new ImapConnection(
    await connect({ host, port, secure, rejectUnauthorized, timeoutMs }),
    { timeoutMs },
  )
  try {
    const greeting = await connection.readLine()
    if (!/^\*\s+(OK|PREAUTH)/i.test(greeting)) return []
    const login = await connection.run(`LOGIN ${quoteString(user)} ${quoteString(pass)}`)
    if (!login.ok) return []
    await sendClientId(connection)
    const selected = await connection.run(`SELECT ${quoteString(mailbox)}`)
    if (!selected.ok) return []
    const search = await connection.run('UID SEARCH ALL')
    const uidLine = search.lines.find((line) => /^\*\s+SEARCH/i.test(line)) ?? ''
    const uids = uidLine.replace(/^\*\s+SEARCH\s*/i, '').trim().split(/\s+/).filter(Boolean)
    const results = []
    for (const uid of uids.slice(-limit)) {
      let rawBytes = null
      const fetched = await connection.run(`UID FETCH ${uid} (BODY.PEEK[])`, {
        onLiteral: (line, data) => {
          if (/BODY\[/i.test(line)) rawBytes = data
        },
      })
      if (!fetched.ok || !rawBytes) continue
      const parsed = extractMessageText(rawBytes)
      results.push({ uid: `${mailbox}:${uid}`, mailbox, raw: rawBytes.toString('utf8'), rawBytes, ...parsed })
    }
    await connection.bye()
    return results
  } catch {
    return []
  } finally {
    connection.close()
  }
}

/**
 * 解析一条 IMAP LIST 应答，取出文件夹名。
 * 形如：`* LIST (\HasNoChildren) "/" "INBOX"`，名字可能是带引号的字符串或字面量。
 * @param {string} line - LIST 应答行。
 * @returns {string|null} 文件夹名（已按 modified UTF-7 解码）。
 */
export function parseListLine(line) {
  const text = String(line ?? '')
  if (!/^\*\s+LIST\b/i.test(text)) return null
  // 依次剥掉 (\Flags) 和分隔符，剩下的是名字
  const afterFlags = text.replace(/^\*\s+LIST\s+/i, '').replace(/^\([^)]*\)\s*/, '')
  const afterDelim = afterFlags.replace(/^(?:"[^"]*"|NIL)\s+/, '')
  if (!afterDelim) return null
  const raw = afterDelim.replace(/\{\d+\}$/, '').trim()
  const name = unquote(raw)
  if (!name) return null
  return fromModifiedUtf7(name)
}

/**
 * 列出邮箱里的文件夹。
 * @param {object} options - 与 fetchReplies 相同的连接参数。
 * @returns {Promise<string[]>} 文件夹名列表（跳过 \Noselect 的）。
 */
export async function listMailboxes(options) {
  const {
    host,
    port = 993,
    secure = true,
    rejectUnauthorized = true,
    user,
    pass,
    timeoutMs = 20_000,
  } = options ?? {}
  if (!host || !user || !pass) return []
  const connection = new ImapConnection(
    await connect({ host, port, secure, rejectUnauthorized, timeoutMs }),
    { timeoutMs },
  )
  try {
    const greeting = await connection.readLine()
    if (!/^\*\s+(OK|PREAUTH)/i.test(greeting)) return []
    const login = await connection.run(`LOGIN ${quoteString(user)} ${quoteString(pass)}`)
    if (!login.ok) return []
    // 163 / Coremail 要求先报身份，否则后续操作会被拒。
    await sendClientId(connection)
    const listed = await connection.run('LIST "" "*"')
    const names = []
    for (const line of listed.lines) {
      if (/\\Noselect/i.test(line)) continue
      const name = parseListLine(line)
      if (name && !names.includes(name)) names.push(name)
    }
    await connection.bye()
    return names
  } catch {
    return []
  } finally {
    connection.close()
  }
}

/**
 * 从文件夹全集里挑出该搜的：INBOX 优先，再加「已发送 / Sent」这类。
 *
 * 为什么要搜已发送：你自己回复自己的邮件，客户端常常把它归到「已发送」，
 * 只搜 INBOX 就会漏掉（163 的「已发送」就是这个情况）。
 *
 * @param {string[]} all - 全部文件夹名。
 * @returns {string[]} 挑选后的文件夹名。
 */
export function pickMailboxes(all) {
  const list = Array.isArray(all) ? all.filter(Boolean) : []
  if (list.length === 0) return ['INBOX']
  const wanted = []
  const inbox = list.find((name) => /^INBOX$/i.test(name))
  wanted.push(inbox ?? list[0])
  for (const name of list) {
    if (wanted.includes(name)) continue
    // 中英文 + 常见别名
    if (/已发送|已寄出|寄件|发件箱|sent|outbox/i.test(name)) wanted.push(name)
  }
  return wanted
}

/**
 * 自动挑出该搜哪些文件夹：INBOX 优先，再加上名字里像「已发送 / Sent」的。
 * 目的是兜住「自己回复自己的邮件被客户端归到已发送」这种情况。
 * @param {object} options - 连接参数。
 * @returns {Promise<string[]>} 文件夹名列表；枚举失败时退回 ['INBOX']。
 */
export async function autoDiscoverMailboxes(options) {
  const all = await listMailboxes(options)
  return pickMailboxes(all.length ? all : ['INBOX'])
}

/** IMAP 字符串字面量转义：加引号并转义反斜杠与引号。 */
function quoteString(value) {
  return `"${String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * 主题是否含某个标记 —— 在**本地**做，不依赖服务端 SUBJECT 搜索。
 *
 * 比对方式是「两边都去掉所有空白后做子串匹配」，于是邮件客户端按显示宽度
 * 插入的空格/换行（`[DSH-Q:x]` → `[D SH-Q:x]`）不影响判断。
 *
 * @param {string} subject - 已解码的主题。
 * @param {string} marker - 要找的标记（如 `DSH-` 或完整标记）。
 * @returns {boolean}
 */
export function subjectMatches(subject, marker) {
  const squeeze = (text) => String(text ?? '').replace(/\s+/g, '')
  const hay = squeeze(subject)
  const needle = squeeze(marker)
  if (!needle) return true
  return hay.includes(needle)
}

/** 客户端身份（ID 命令用）。163 / Coremail 系要求登录后先报身份，否则拒绝访问。 */const CLIENT_ID = {
  name: 'dsh-mail-digest',
  version: '0.1.0',
  vendor: 'dsh-mail-digest',
  'support-email': 'noreply@example.com',
}

/** 拼出 ID 命令的参数列表：("name" "x" "version" "y" …) */
function idParams() {
  const parts = []
  for (const [key, value] of Object.entries(CLIENT_ID)) parts.push(quoteString(key), quoteString(value))
  return `(${parts.join(' ')})`
}

/**
 * 登录后按服务器能力补发客户端 ID。
 *
 * 163 / Coremail 系会对不报身份的连接在 `SELECT` 时返回
 * `NO SELECT Unsafe Login`；QQ / Gmail 不要求。所以这里是「声明了 ID 就报」，
 * 报失败也不影响后续。
 *
 * @param {ImapConnection} connection - 已登录的连接。
 * @returns {Promise<boolean>} 是否成功发了 ID。
 */
async function sendClientId(connection) {
  try {
    const caps = await connection.run('CAPABILITY')
    if (!/\bID\b/i.test(caps.lines.join(' '))) return false
    await connection.run(`ID ${idParams()}`)
    return true
  } catch {
    return false
  }
}

/** 识别 163 的「未报身份」拒绝，给出可操作的中文提示。 */
function explainSelectFailure(mailbox, text) {
  if (/Unsafe Login/i.test(text)) {
    return `打不开 ${mailbox}：服务器以「Unsafe Login」拒绝了本次会话。`
      + '这通常发生在 163 / Coremail 邮箱——需要客户端先声明身份（本插件会自动发 ID，'
      + '若仍失败，请到网页版 163 邮箱 → 设置 → POP3/SMTP/IMAP 里确认 IMAP/SMTP 服务已开启，'
      + '并重新生成一次授权码）。'
  }
  return `打不开邮箱文件夹 ${mailbox}：${text}`
}

/** 测一次 IMAP 登录是否可用（设置页「测试收信」用）。 */
export async function testImap(options) {
  const { host, port = 993, secure = true, user, pass, timeoutMs = 20_000 } = options ?? {}
  if (!host || !user || !pass) return { ok: false, reason: '缺少 IMAP 主机 / 账号 / 授权码' }
  const connection = new ImapConnection(
    await connect({ host, port, secure, rejectUnauthorized: true, timeoutMs }),
    { timeoutMs },
  )
  try {
    const greeting = await connection.readLine()
    if (!/^\*\s+(OK|PREAUTH)/i.test(greeting)) return { ok: false, reason: `服务器未就绪：${greeting}` }
    const login = await connection.run(`LOGIN ${quoteString(user)} ${quoteString(pass)}`)
    if (!login.ok) {
      return {
        ok: false,
        reason: /AUTHENTICATIONFAILED|invalid credentials/i.test(login.text)
          ? '登录失败：账号或授权码不对（QQ/163 需要授权码，且要开启 IMAP 服务）'
          : `登录失败：${login.text}`,
      }
    }
    const sentId = await sendClientId(connection)
    const selected = await connection.run('SELECT INBOX')
    if (!selected.ok) return { ok: false, reason: explainSelectFailure('INBOX', selected.text), sentId }
    await connection.bye()
    return { ok: true, sentId }
  } finally {
    connection.close()
  }
}
