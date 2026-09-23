/**
 * 配置读写。
 *
 * 配置文件位置：<DSH_HOME>/dsh-mail-digest/config.json
 * （DSH_HOME 默认 %USERPROFILE%\.dsh，可用环境变量覆盖）
 *
 * 口令只留在本机这个文件里；读回界面时永远只回「是否已设置」。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 插件设置目录名。 */
const DIR_NAME = 'dsh-mail-digest'

/**
 * SMTP 服务器预置。用户只需要选一个「邮箱类型」，服务器和端口自动填好。
 * QQ / 163 的「授权码」不是登录密码，要去网页版邮箱里生成。
 */
export const SERVER_PRESETS = {
  qq: {
    label: 'QQ 邮箱',
    host: 'smtp.qq.com',
    port: 465,
    secure: true,
    hint: '网页版 QQ 邮箱 → 设置 → 账户 → 开启「IMAP/SMTP 服务」，拿 16 位授权码',
  },
  '163': {
    label: '163 邮箱',
    host: 'smtp.163.com',
    port: 465,
    secure: true,
    hint: '网页版 163 邮箱 → 设置 → POP3/SMTP/IMAP → 开启「SMTP 服务」，拿授权码',
  },
  '126': {
    label: '126 邮箱',
    host: 'smtp.126.com',
    port: 465,
    secure: true,
    hint: '网页版 126 邮箱 → 设置 → POP3/SMTP/IMAP → 开启「SMTP 服务」，拿授权码',
  },
}

/** 预置之外的自定义服务器用的默认值。 */
export const CUSTOM_PRESET = { label: '自定义 SMTP', host: '', port: 465, secure: true, hint: '填你自己的 SMTP 服务器地址与端口' }

/** 全部可选的邮箱类型（含自定义）。 */
export function providerChoices() {
  return [
    ...Object.entries(SERVER_PRESETS).map(([key, value]) => ({ key, ...value })),
    { key: 'custom', ...CUSTOM_PRESET },
  ]
}

/** 配置文件的绝对路径。 */
export function configPath() {
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  return join(home, DIR_NAME, 'config.json')
}

/** 默认配置。 */
export function defaultConfig() {
  return {
    enabled: true,
    /** 邮箱类型：qq / 163 / 126 / custom */
    provider: 'qq',
    smtp: {
      host: SERVER_PRESETS.qq.host,
      port: SERVER_PRESETS.qq.port,
      secure: true,
      rejectUnauthorized: true,
      allowInsecure: false,
      user: '',
      pass: '',
      fromName: 'DeepSeek Harness',
    },
    /** 收件人；留空表示发给 smtp.user 自己。 */
    to: [],
    /** 主题前缀。 */
    subjectPrefix: '[DSH]',
    /** 子代理 / 委派回合是否也发信。默认关，避免一次任务收到几十封。 */
    includeSubagents: false,
    /**
     * 摘要生成方式：
     *   auto  = 先让我自己写（mail_digest 工具），没写就用模型压缩这一段回答
     *   model = 总是用模型压缩
     *   off   = 不发信，只在日志里记一行（调试用）
     */
    digestMode: 'auto',
    /** 一分钟内最多发几封，防止死循环刷屏。 */
    maxPerMinute: 6,
    /** 同一会话同类通知的最小间隔（秒）。 */
    minIntervalSeconds: 0,
    /** 压缩这一次回答的模型路由；留空表示用当前会话正在用的模型。 */
    summary: { provider: '', model: '' },
    /**
     * 回信通道（双向）：
     *   - enabled：总开关。关掉就只剩「回答摘要」单向通知。
     *   - askViaEmail：提问（ask_user_question）也发邮件，允许回信作答。
     *   - continueViaEmail：回答邮件的回信当作新消息投回会话，对话继续。
     *   - unseenOnly：只读未读回信（推荐，避免重复采纳同一封）。
     */
    reply: {
      enabled: false,
      askViaEmail: true,
      continueViaEmail: true,
      unseenOnly: true,
    },
    /** IMAP 收信；各字段留空表示复用发信那套账号与授权码。 */
    imap: {
      host: '',
      port: 0,
      secure: true,
      user: '',
      pass: '',
      mailbox: 'INBOX',
    },
  }
}

/** 深合并：只认识已知键，避免配置文件里塞进来的垃圾字段污染运行时。 */
function normalize(raw) {
  const base = defaultConfig()
  if (!raw || typeof raw !== 'object') return base
  const smtp = raw.smtp && typeof raw.smtp === 'object' ? raw.smtp : {}
  const summary = raw.summary && typeof raw.summary === 'object' ? raw.summary : {}
  const reply = raw.reply && typeof raw.reply === 'object' ? raw.reply : {}
  const imap = raw.imap && typeof raw.imap === 'object' ? raw.imap : {}
  const provider = Object.hasOwn(SERVER_PRESETS, raw.provider) || raw.provider === 'custom'
    ? raw.provider
    : base.provider
  return {
    enabled: raw.enabled === undefined ? base.enabled : raw.enabled === true,
    provider,
    smtp: {
      host: typeof smtp.host === 'string' && smtp.host.trim() ? smtp.host.trim() : base.smtp.host,
      port: Number.isInteger(smtp.port) && smtp.port > 0 && smtp.port < 65536 ? smtp.port : base.smtp.port,
      secure: smtp.secure === undefined ? base.smtp.secure : smtp.secure === true,
      rejectUnauthorized: smtp.rejectUnauthorized === undefined ? true : smtp.rejectUnauthorized === true,
      allowInsecure: smtp.allowInsecure === true,
      user: typeof smtp.user === 'string' ? smtp.user.trim() : '',
      pass: typeof smtp.pass === 'string' ? smtp.pass : '',
      fromName: typeof smtp.fromName === 'string' && smtp.fromName.trim() ? smtp.fromName.trim() : base.smtp.fromName,
    },
    to: Array.isArray(raw.to)
      ? raw.to.map((v) => String(v ?? '').trim()).filter((v) => v.includes('@'))
      : base.to,
    subjectPrefix: typeof raw.subjectPrefix === 'string' ? raw.subjectPrefix : base.subjectPrefix,
    includeSubagents: raw.includeSubagents === true,
    digestMode: ['auto', 'model', 'off'].includes(raw.digestMode) ? raw.digestMode : base.digestMode,
    maxPerMinute: Number.isFinite(Number(raw.maxPerMinute)) && Number(raw.maxPerMinute) >= 0
      ? Math.floor(Number(raw.maxPerMinute))
      : base.maxPerMinute,
    minIntervalSeconds: Number.isFinite(Number(raw.minIntervalSeconds)) && Number(raw.minIntervalSeconds) >= 0
      ? Math.floor(Number(raw.minIntervalSeconds))
      : base.minIntervalSeconds,
    summary: {
      provider: typeof summary.provider === 'string' ? summary.provider.trim() : '',
      model: typeof summary.model === 'string' ? summary.model.trim() : '',
    },
    reply: {
      enabled: reply.enabled === true,
      askViaEmail: reply.askViaEmail === undefined ? base.reply.askViaEmail : reply.askViaEmail === true,
      continueViaEmail: reply.continueViaEmail === undefined ? base.reply.continueViaEmail : reply.continueViaEmail === true,
      unseenOnly: reply.unseenOnly === undefined ? base.reply.unseenOnly : reply.unseenOnly === true,
    },
    imap: {
      host: typeof imap.host === 'string' ? imap.host.trim() : '',
      port: Number.isInteger(imap.port) && imap.port > 0 && imap.port < 65536 ? imap.port : 0,
      secure: imap.secure === undefined ? true : imap.secure === true,
      user: typeof imap.user === 'string' ? imap.user.trim() : '',
      pass: typeof imap.pass === 'string' ? imap.pass : '',
      mailbox: typeof imap.mailbox === 'string' && imap.mailbox.trim() ? imap.mailbox.trim() : 'INBOX',
    },
  }
}

/**
 * 读配置。文件不存在时返回默认值（不写盘，写盘交给 saveConfig）。
 * @returns {{value: object, path: string, exists: boolean, error?: string}}
 */
export function loadConfig() {
  const path = configPath()
  if (!existsSync(path)) return { value: defaultConfig(), path, exists: false }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return { value: normalize(parsed), path, exists: true }
  } catch (error) {
    return { value: defaultConfig(), path, exists: true, error: `配置文件解析失败（${error.message}），本次使用默认值` }
  }
}

/**
 * 保存配置（原子写：先写 .tmp 再 rename）。
 * 口令留空 = 不改动已保存的口令。
 * @param {object} raw - 界面发回来的完整配置。
 * @returns {{ok: true, value: object, path: string} | {ok: false, error: string}}
 */
export function saveConfig(raw) {
  const path = configPath()
  const current = loadConfig().value
  const next = normalize(raw)
  // 口令留空表示"不改"：界面永远不会把真实口令回显出来。
  const incomingPass = raw && typeof raw === 'object' && raw.smtp && typeof raw.smtp === 'object'
    ? raw.smtp.pass
    : undefined
  if (incomingPass === undefined || incomingPass === '' || incomingPass === null) next.smtp.pass = current.smtp.pass
  // IMAP 授权码同理：留空 = 沿用已保存的（默认还与 SMTP 共用同一个）。
  const incomingImapPass = raw && typeof raw === 'object' && raw.imap && typeof raw.imap === 'object'
    ? raw.imap.pass
    : undefined
  if (incomingImapPass === undefined || incomingImapPass === '' || incomingImapPass === null) {
    next.imap.pass = current.imap.pass
  }
  if (!next.to.length && next.smtp.user) next.to = [next.smtp.user]
  try {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.tmp`
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    renameSync(tmp, path)
    return { ok: true, value: next, path }
  } catch (error) {
    return { ok: false, error: `写入配置失败：${error.message}` }
  }
}

/** 收件人：显式配了就用配置的，否则发给登录邮箱自己。 */
export function collectRecipients(config) {
  if (Array.isArray(config.to) && config.to.length) return [...config.to]
  return config.smtp.user ? [config.smtp.user] : []
}

/** 发件地址：QQ / 163 都要求 MAIL FROM 等于登录账号本身。 */
export function senderAddress(config) {
  return config.smtp.user ? config.smtp.user : ''
}

/**
 * 判断配置是否已经可以发信。
 * @returns {{ready: boolean, missing: string[]}}
 */
export function describeReadiness(config) {
  const missing = []
  if (!config.smtp.user) missing.push('发件邮箱账号')
  if (!config.smtp.pass) missing.push('授权码 / 密码')
  if (!config.smtp.host) missing.push('SMTP 服务器地址')
  if (!senderAddress(config)) missing.push('发件地址')
  if (collectRecipients(config).length === 0) missing.push('收件地址')
  return { ready: missing.length === 0, missing }
}

/**
 * 判断回信通道（IMAP）能不能用。
 * 账号/授权码缺省复用发信那套；服务器缺省按邮箱类型推。
 * @param {object} config - 解析后的配置。
 * @returns {{ready: boolean, missing: string[]}}
 */
export function describeReplyReadiness(config) {
  if (!config.reply?.enabled) return { ready: false, missing: ['回信通道未启用'] }
  const missing = []
  const preset = SERVER_PRESETS[config.provider]
  const host = config.imap?.host || (preset ? IMAP_HOSTS[config.provider] : '')
  const user = config.imap?.user || config.smtp.user
  const pass = config.imap?.pass || config.smtp.pass
  if (!host) missing.push('IMAP 服务器地址')
  if (!user) missing.push('收件邮箱账号')
  if (!pass) missing.push('授权码')
  return { ready: missing.length === 0, missing }
}

/** 各邮箱类型的 IMAP 主机（收信服务器）。 */
export const IMAP_HOSTS = {
  qq: 'imap.qq.com',
  '163': 'imap.163.com',
  '126': 'imap.126.com',
}

/**
 * 给界面看的配置：口令只回「是否已设置」。
 * @param {object} config - 解析后的配置。
 * @returns {object} 可安全回显的配置副本。
 */
export function publicConfig(config) {
  return {
    ...config,
    smtp: { ...config.smtp, pass: '', passSet: Boolean(config.smtp.pass) },
    imap: { ...config.imap, pass: '', passSet: Boolean(config.imap.pass) },
    to: [...config.to],
  }
}
