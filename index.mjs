/**
 * dsh-mail-digest — 宿主端。
 *
 * 每轮回答结束后，把一条**详略得当**的中文摘要通过 SMTP 发到你的邮箱。
 *
 * 触发源取权威事实（不猜 DOM）：
 *   - `session/event` 里的 `turn/start` / `turn/end` / `assistant/message`
 *   - `assistant/message` 事件里这一轮的 text 块，就是「回答原文」
 *
 * 摘要怎么来（详略由内容决定，不用字数限制）：
 *   1. 我自己写：我调用 `mail_digest` 工具提交一条摘要 —— 最准；
 *   2. 没写就用模型压缩这一轮回答（`ctx.llm.stream`）—— 仍然自动；
 *   3. 模型不可用就退回确定性摘要（结论句 + 收尾句）。
 *
 * 配置在网页里改：DSH 起来后打开 http://127.0.0.1:3080/dsh-mail-digest
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  collectRecipients,
  configPath,
  describeReadiness,
  loadConfig,
  senderAddress,
} from './config.mjs'
import { blocksToText, cleanAnswerText, extractiveDigest, isAssistantTextEvent, normalizeDigest } from './digest.mjs'
import { testImap } from './imap.mjs'
import { createReplyBridge, imapOptions, imapReady, APPROVAL_POLL_MS, APPROVAL_TIMEOUT_MS } from './qa.mjs'
import { newThreadToken, threadMarker } from './reply.mjs'
import { loadPending, renderPendingBlock, savePending } from './pending.mjs'
import { registerSettingsRoutes } from './settings.mjs'
import { sendMail } from './smtp.mjs'
import { modelDigest } from './summary.mjs'

/** 插件名。 */
export const name = 'dsh-mail-digest'

/**
 * 严格注入：读哪个服务就必须在这里声明，否则启动即崩。
 * webServer 允许缺席（headless / CLI profile），所以不列进来，
 * 改用 `ctx.inject(['webServer'], ...)` 可选挂载。
 */
export const inject = ['tools', 'agents', 'llm']

/** 一轮压不出来时的兜底上限保护：这是安全线，不是详略控制。 */
const NO_ANSWER_NOTICE = '（这一轮没有产生文本回答）'

/** 可读时间戳：本机时区，秒级。 */
function stamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** 秒数 → 人话。 */
function humanDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '未知'
  const total = Math.round(ms / 1000)
  if (total < 60) return `${total} 秒`
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (minutes < 60) return seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分`
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`
}

/** 工作区显示名：取路径最后一段。 */
function workspaceName(cwd) {
  const text = String(cwd ?? '').replace(/[\\/]+$/, '')
  if (!text) return '未知工作区'
  const parts = text.split(/[\\/]/)
  return parts[parts.length - 1] || text
}

/**
 * 会话名兜底：内存表没赶上时，直接读侧栏投影缓存。
 * 路径由 configPath() 反推——它就是 <DSH_HOME>/dsh-mail-digest/config.json，
 * 上两级回到 DSH_HOME，再进 storages。
 */
function titleFromProjection(sessionId) {
  try {
    const file = join(configPath(), '..', '..', 'storages', 'session_projcache.json')
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const title = parsed?.sessions?.[sessionId]?.rows?.title?.val
    return typeof title === 'string' ? title.trim() : ''
  } catch {
    return ''
  }
}

/** 判断是不是子代理 / 委派回合。 */
function isSubagentSession(session) {
  const header = session?.header ?? {}
  return Boolean(header.parentSession) || Number(header.delegationDepth ?? 0) > 0
}

/**
 * 插件主体。
 * @param {any} ctx - 宿主上下文。
 */
export function apply(ctx) {
  const log = (level, message) => {
    try {
      const logger = ctx.logger
      if (logger && typeof logger[level] === 'function') logger[level](`[dsh-mail-digest] ${message}`)
      else if (level === 'warn' || level === 'error') process.stderr.write(`[dsh-mail-digest] ${message}\n`)
    } catch { /* 日志失败不影响功能 */ }
  }

  /** `${sessionId}:${turn}` → 这一轮的状态。 */
  const turns = new Map()
  /** 会话 id → 侧栏名（由 session/title 事件填充）。 */
  const titles = new Map()
  /** 发信时间戳，用于节流。 */
  const sentAt = []
  /** 最近一次「待批准」即时通知的时间，避免同一轮多次调用把用户邮箱刷爆。 */
  let lastPendingNotifyAt = 0
  /** 两条「待批准」通知的最小间隔。 */
  const PENDING_NOTIFY_GAP_MS = 30_000
  /** 最近一次发信结果（诊断用）。 */
  let lastResult = null

  /** 从会话 id 反查标题（邮件里显示是哪条会话）。 */
  function titleFromAnywhere(sessionId) {
    if (!sessionId) return ''
    const known = titles.get(sessionId)
    if (known) return known
    const projected = titleFromProjection(sessionId)
    if (projected) titles.set(sessionId, projected)
    return projected
  }

  /** 取当前配置（每次现读，改设置立即生效，不用重启）。 */
  function getConfig() {
    const loaded = loadConfig()
    if (loaded.error) log('warn', loaded.error)
    return loaded.value
  }

  /** 这一轮的键。 */
  function keyOf(sessionId, turn) {
    return `${sessionId}:${turn}`
  }

  /** 拿到（或新建）一轮的状态。 */
  function turnState(sessionId, turn) {
    const key = keyOf(sessionId, turn)
    let state = turns.get(key)
    if (!state) {
      state = { turn, text: [], route: null, explicit: null, ended: false }
      turns.set(key, state)
      // 只保留最近 300 轮，防止长会话把内存撑起来。
      if (turns.size > 300) {
        const oldest = turns.keys().next().value
        if (oldest !== undefined) turns.delete(oldest)
      }
    }
    return state
  }

  /** 会话名：内存表 → 会话日志 → 侧栏投影缓存。 */
  function titleOf(session) {
    const known = titles.get(session.id)
    if (typeof known === 'string' && known) return known
    const events = Array.isArray(session.events) ? session.events : []
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event?.type !== 'session/title' && event?.type !== 'session/title/changed') continue
      const title = event.data?.title
      if (typeof title === 'string' && title.trim()) {
        const clean = title.trim()
        titles.set(session.id, clean)
        return clean
      }
    }
    const projected = titleFromProjection(session.id)
    if (projected) titles.set(session.id, projected)
    return projected
  }

  /** 从会话头 / request/context 里学一个模型路由。 */
  function learnRoute(session, route) {
    if (!route?.provider && !route?.model) return
    for (const state of turns.values()) {
      if (!state.route && (route.provider && route.model)) state.route = { ...route }
    }
    routeCache.set(session.id, { ...route })
  }
  /** 会话 id → 最近学到的模型路由。 */
  const routeCache = new Map()

  /** 解析这一轮该用哪个模型来压缩摘要。 */
  function resolveRoute(session, state, config) {
    if (config.summary?.provider && config.summary?.model) {
      return { provider: config.summary.provider, model: config.summary.model }
    }
    if (state?.route?.provider && state?.route?.model) return { ...state.route }
    const cached = routeCache.get(session.id)
    if (cached?.provider && cached?.model) return { ...cached }
    const agent = ctx.agents?.get?.(session.id)
    const options = agent?.options
    if (options?.provider && options?.model) {
      const route = { provider: options.provider, model: options.model }
      routeCache.set(session.id, route)
      return route
    }
    const events = Array.isArray(session.events) ? session.events : []
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event?.type === 'request/context') {
        const route = { provider: event.data?.provider, model: event.data?.model }
        if (route.provider && route.model) {
          routeCache.set(session.id, route)
          return route
        }
      }
      if (event?.type === 'request/header') {
        const config = event.data?.header?.config
        if (config?.provider && config?.model) {
          const route = { provider: config.provider, model: config.model }
          routeCache.set(session.id, route)
          return route
        }
      }
    }
    return null
  }

  /** 节流：一分钟上限 + 同会话最小间隔。 */
  function throttled(config, sessionId) {
    const now = Date.now()
    while (sentAt.length && now - sentAt[0].at > 60_000) sentAt.shift()
    const maxPerMinute = Number(config.maxPerMinute)
    if (Number.isFinite(maxPerMinute) && maxPerMinute > 0 && sentAt.length >= maxPerMinute) {
      return `一分钟内已发 ${sentAt.length} 封，达到上限 ${maxPerMinute}`
    }
    const minGap = Number(config.minIntervalSeconds) * 1000
    if (Number.isFinite(minGap) && minGap > 0) {
      const previous = sentAt.filter((item) => item.sessionId === sessionId).pop()
      if (previous && now - previous.at < minGap) return `同一会话间隔不足 ${config.minIntervalSeconds} 秒`
    }
    return null
  }

  /**
   * 组装邮件正文。摘要是主角，其余是定位用的几行。
   *
   * 结构：摘要 → ⚠待批准权限（若空则不占位）→ 元信息 → 回信提示。
   * 待办块放前面是因为它需要用户动手，但又不该盖住摘要本身。
   */
  function composeMail({ title, cwd, turn, durationMs, outcome, digest, note, replyHint }) {
    const pendingBlock = renderPendingBlock(loadPending())
    const lines = []
    if (digest) lines.push(digest)
    else lines.push(NO_ANSWER_NOTICE)
    if (pendingBlock) {
      lines.push('')
      lines.push(pendingBlock.trim())
    }
    lines.push('')
    lines.push('────────────')
    lines.push(`会话：${title || '（未命名会话）'}`)
    lines.push(`工作区：${workspaceName(cwd)}`)
    lines.push(`回合：第 ${turn} 轮 · 用时 ${humanDuration(durationMs)}`)
    lines.push(`时间：${stamp()}`)
    if (outcome && outcome !== 'completed') lines.push(`状态：${outcome}`)
    if (note) lines.push(`说明：${note}`)
    if (replyHint) {
      lines.push('')
      lines.push('────────────')
      lines.push('直接回复本邮件就能继续对话（主题别改）。')
      lines.push('内容写在正文；只有一问就直接写选项字母，如 A；')
      lines.push('有多问就每行一个「题号. 字母」，例如：')
      lines.push('1. A')
      lines.push('2. B')
      lines.push('不满意某个选项时，直接写你要的内容。')
    }
    return lines.join('\n')
  }

  /** 组装主题：带上线程标记，回信时主题不动就能被搜到。 */
  function composeSubject(config, { mark, title, marker }) {
    const prefix = config.subjectPrefix ? `${config.subjectPrefix} ` : ''
    const name = title || '（未命名会话）'
    const tag = marker ? ` ${marker}` : ''
    // 有待批准权限时在主题上标出来，手机上不用点开就能看见
    const pendingCount = loadPending().length
    const warn = pendingCount > 0 ? ` ⚠${pendingCount}项待批准` : ''
    return `${prefix}${mark} ${name}${warn}${tag}`
  }

  /**
   * 发信。
   * @param {object} config - 当前配置。
   * @param {object} mail - { to, from, subject, text }。
   * @returns {Promise<{ok: boolean, reason?: string, messageId?: string}>}
   */
  async function deliver(config, mail) {
    const readiness = describeReadiness(config)
    if (!readiness.ready) {
      const reason = `配置未完成（缺 ${readiness.missing.join('、')}）`
      log('warn', `${reason}，跳过发信。配置：${configPath()}`)
      lastResult = { at: Date.now(), ok: false, error: reason }
      return { ok: false, reason }
    }
    try {
      const result = await sendMail({
        host: config.smtp.host,
        port: config.smtp.port,
        secure: config.smtp.secure,
        rejectUnauthorized: config.smtp.rejectUnauthorized !== false,
        allowInsecure: config.smtp.allowInsecure === true,
        user: config.smtp.user,
        pass: config.smtp.pass,
        from: mail.from,
        fromName: config.smtp.fromName,
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
      })
      lastResult = { at: Date.now(), ok: true, subject: mail.subject, to: mail.to, messageId: result.messageId }
      log('info', `已发摘要邮件「${mail.subject}」→ ${mail.to.join(', ')}`)
      return { ok: true, messageId: result.messageId, to: mail.to }
    } catch (error) {
      lastResult = { at: Date.now(), ok: false, subject: mail.subject, error: error.message }
      log('warn', `发信失败「${mail.subject}」：${error.message}`)
      return { ok: false, reason: error.message }
    }
  }

  /**
   * 一轮结束：拼摘要、发信。
   * @param {any} session - 会话。
   * @param {any} event - `turn/end` 事件。
   */
  async function onTurnEnd(session, event) {
    const config = getConfig()
    const turn = event.data?.turn
    const key = keyOf(session.id, turn)
    const state = turns.get(key)
    // 不立刻删：我可能在回答收尾、回合关闭之后才调用 mail_digest。
    // 标记成已结束，等一轮发完信再由延迟清理回收。
    if (state) state.ended = true

    if (!config.enabled) {
      log('info', `邮件摘要已关闭，跳过第 ${turn} 轮`)
      turns.delete(key)
      return
    }
    if (config.digestMode === 'off') {
      log('info', `摘要来源设为 off，只记账不发信（第 ${turn} 轮）`)
      turns.delete(key)
      return
    }
    if (isSubagentSession(session) && !config.includeSubagents) {
      log('info', `子代理回合不发信（第 ${turn} 轮）`)
      turns.delete(key)
      return
    }
    // 到这一步这一轮已经定型，回收状态；后面的自写摘要会被忽略。
    turns.delete(key)

    const reason = event.data?.reason ?? { kind: 'completed' }
    const kind = String(reason.kind ?? 'completed')
    const outcome = kind === 'completed' ? '' : kind === 'error' ? '出错' : (kind === 'aborted' || kind === 'stopped') ? '已中止' : kind

    const answer = cleanAnswerText((state?.text ?? []).join('\n\n'))

    // 摘要三级来源：我自己写的 → 模型压缩 → 确定性兜底。
    let digest = normalizeDigest(state?.explicit)
    let source = digest ? 'agent' : ''
    if (!digest && answer) {
      const route = resolveRoute(session, state, config)
      if (route) {
        digest = normalizeDigest(await modelDigest({
          llm: ctx.llm,
          provider: route.provider,
          model: route.model,
          answer,
          signal: undefined,
        })) || ''
        if (digest) source = 'model'
      }
    }
    if (!digest && answer) {
      digest = normalizeDigest(extractiveDigest(answer))
      if (digest) source = 'extractive'
    }

    let note = ''
    if (!answer) note = '这一轮没有文本回答（可能只跑了工具或被中止）'
    else if (source === 'extractive') note = '模型摘要不可用，这条是按回答原文挑出的要点'
    else if (!digest) note = '没能从这一轮回答里生成摘要'

    const skip = throttled(config, session.id)
    if (skip) {
      log('info', `跳过发信（${skip}）：第 ${turn} 轮`)
      return
    }

    const title = titleOf(session)
    const mark = kind === 'completed' ? '✅' : kind === 'error' ? '⚠️' : '⏹️'
    // 回信通道开着就给这封邮件挂一个**全新的**线程标记：你回复它就能继续对话。
    // 每封都换 id —— token 即一次性凭据，外来邮件猜不到也对不上。
    const replyOn = config.reply?.enabled === true && config.reply?.continueViaEmail === true
    const token = replyOn ? newThreadToken() : null
    const marker = token ? threadMarker('T', token) : null
    if (token) {
      replyBridge.register({ token, marker, sessionId: session.id, kind: 'T' })
    }
    const subject = composeSubject(config, { mark, title, marker })
    const text = composeMail({
      title,
      cwd: session.header?.cwd,
      turn,
      durationMs: Number(event.time) - Number(state?.startedAt ?? event.time),
      outcome,
      digest,
      note,
      replyHint: replyOn,
    })

    const result = await deliver(config, {
      from: senderAddress(config),
      to: collectRecipients(config),
      subject,
      text,
    })
    if (result.ok) {
      // 回填我们这封的 Message-ID：回信的 References 里会带上，用于确认。
      if (token && result.messageId) replyBridge.noteSent(token, result.messageId)
      sentAt.push({ at: Date.now(), sessionId: session.id })
      log('info', `摘要来源：${source || 'none'}${token ? `，回信标记 ${marker}` : ''}`)
    }
  }

  // ── 订阅会话事实 ────────────────────────────────────────────────
  ctx.on('session/event', (session, event) => {
    try {
      if (!session || !event) return
      switch (event.type) {
        case 'session/title':
        case 'session/title/changed': {
          const title = event.data?.title
          if (typeof title === 'string' && title.trim()) titles.set(session.id, title.trim())
          break
        }
        case 'turn/start': {
          const state = turnState(session.id, event.data?.turn)
          state.startedAt = event.time
          break
        }
        case 'assistant/message': {
          // 每一轮可能有多个 step，各自产出一条 assistant/message：全部收进来。
          if (!isAssistantTextEvent(event)) break
          const state = turnState(session.id, event.data?.turn)
          const text = blocksToText(event.data?.message?.content)
          if (text) state.text.push(text)
          // 模型路由最可靠的来源：回答自己带着 provider/model。
          // （实测 data.message.source = { kind:'model', provider, model }）
          const source = event.data?.message?.source
          const route = { provider: source?.provider, model: source?.model }
          if (route.provider && route.model) {
            if (!state.route) state.route = route
            routeCache.set(session.id, route)
          }
          break
        }
        case 'request/context': {
          const route = { provider: event.data?.provider, model: event.data?.model }
          if (route.provider && route.model) {
            routeCache.set(session.id, route)
            const state = turns.get(keyOf(session.id, Number(event.data?.turn ?? -1)))
            if (state && !state.route) state.route = route
          }
          break
        }        case 'turn/end':
          void onTurnEnd(session, event)
          break
        default:
          break
      }
    } catch (error) {
      log('warn', `处理会话事件 ${event?.type} 失败：${error.message}`)
    }
  })

  // ── 让我自己提交摘要的工具 ──────────────────────────────────────
  // 注册的是全局工具：我可在回答结尾调用它交一条详略自定的摘要。
  // 它不改变我的回答内容，只是给插件一个更准的摘要来源。
  //
  // 注意契约：defineTool 吃「作者侧 schema DSL」并**编译**成 ToolDefinition；
  // ctx.tools.register 收的是编译产物。两者不能对调。
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'mail_digest',
    description:
      '为「回答结束后发给用户的邮件摘要」提交一条摘要。可选调用：'
      + '如果你希望邮件里的摘要是自己写的（比自动压缩更准），就在回答的最后调用一次这个工具。'
      + '摘要用详略控制长度——结论多就写详细些，结论少就写一句话，不必凑字数；'
      + '写成一段连续中文文本，不要换行、不要 Markdown。'
      + '不调用也没关系：插件会自动压缩这一轮回答。',
    // 参数是「隐式开放对象根 + 每个属性上的 required 标记」的 DSL。
    parameters: {
      summary: {
        type: 'string',
        required: true,
        description: '要发进邮件的中文摘要，一段连续文本，详略由结论多少决定。',
      },
      pendingPermissions: {
        type: 'array',
        description:
          '需要用户批准的权限/操作清单，会以独立区块显示在邮件里（每次发信都带上）。'
          + '【硬性纪律】默认**不要申请提权**：申请本身会让 agent 停在等待审批上，'
          + '而用户不在电脑前就批不了（等同被硬控）。只有用户明确说「去申请」才申请。'
          + '判断用户可能不在场的信号：他用**邮件回复**你，而不是在界面上打字。'
          + '遇到需要放行才能做的事，就记在这份清单里等他回来一次看完。'
          + '用法：把因为需要提权而**暂时没做**的事记在这里；用户批准并做完后，用空数组 [] 清空。'
          + '只写真的需要用户放行的事（通常是要写工作区之外的路径）。',
        items: {
          type: 'object',
          properties: {
            what: { type: 'string', required: true, description: '要做什么（一句话）' },
            why: { type: 'string', description: '为什么需要它' },
            need: { type: 'string', description: '需要什么权限，例如：写 ~/.dsh/skills' },
          },
          additionalProperties: false,
        },
      },
    },
    // output.schema 同样是作者侧 DSL：required 是属性上的标记，不是顶层数组。
    output: {
      schema: {
        type: 'object',
        properties: {
          accepted: { type: 'boolean', required: true },
          turn: { type: 'integer' },
          pendingCount: { type: 'integer' },
          pendingSaved: { type: 'boolean' },
          pendingPath: { type: 'string' },
          pendingError: { type: 'string' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          value?.accepted
            ? `已把这条摘要排进第 ${value.turn} 轮的邮件。`
            : '这一轮已经发过信了，摘要没有采用。',
          typeof value?.pendingCount === 'number' ? `待批准权限清单：${value.pendingCount} 项。` : '',
          value?.pendingSaved === false
            ? `⚠ 清单写入失败：${value.pendingError || '未知原因'}（路径 ${value.pendingPath || '?'}）`
            : '',
          value?.pendingSaved === true && value?.pendingPath ? `清单已写入：${value.pendingPath}` : '',
        ].filter(Boolean).join('\n'),
      }],
    },
    execute: (args, exec) => {
      const session = exec.agent?.session
      // 待批准清单与摘要相互独立：即使这一轮不采用摘要，也要能把清单记下来。
      let pendingCount = loadPending().length
      let pendingSaved
      let pendingPathUsed
      let pendingError
      if (Array.isArray(args.pendingPermissions)) {
        const saved = savePending(args.pendingPermissions)
        pendingCount = saved.count
        pendingSaved = saved.ok === true
        pendingPathUsed = saved.path
        pendingError = saved.error
        if (saved.ok) log('info', `待批准权限清单更新为 ${saved.count} 项（${saved.path}${saved.fallback ? '，回退位置' : ''}）`)
        else log('warn', `待批准权限清单写入失败（${saved.path}）：${saved.error}`)

        // ── 立即补发一封通知 ──────────────────────────────────────────
        // 为什么不等回合结束：插件只在 turn/end 发摘要，而这轮里写入的清单
        // 可能在同一轮内又被清空/改写，等发信时看到的是"最终态"，
        // 用户就看不到"当时待他批的是什么"。实测踩过：同一轮先写 1 项再传 []，
        // 结果那封邮件里没有区块，用户以为功能坏了。
        if (saved.ok && saved.count > 0) {
          const now = Date.now()
          if (now - lastPendingNotifyAt > PENDING_NOTIFY_GAP_MS) {
            lastPendingNotifyAt = now
            const config = getConfig()
            if (config.enabled && config.digestMode !== 'off') {
              const sessionId = exec.agent?.id
              const title = titleFromAnywhere(sessionId)
              const lines = [
                `有 ${saved.count} 项操作需要你放行，我现在不做，等你有空批。`,
                '',
                renderPendingBlock(loadPending()).trim(),
                '',
                '────────────',
                `会话：${title || '（未命名会话）'}`,
                `时间：${stamp()}`,
                '',
                '回复本邮件说明也可以（比如「都批准」或「第 2 项先别做」）。',
              ]
              void deliver(config, {
                from: senderAddress(config),
                to: collectRecipients(config),
                subject: `${config.subjectPrefix ? `${config.subjectPrefix} ` : ''}⚠ ${saved.count} 项待批准`,
                text: lines.join('\n'),
              }).catch(() => {})
              log('info', `已立即补发「${saved.count} 项待批准」通知邮件`)
            }
          } else {
            log('info', `待批准通知刚发过，${Math.round(PENDING_NOTIFY_GAP_MS / 1000)} 秒内不重复发`)
          }
        }
      }
      const base = {
        accepted: false,
        turn: 0,
        pendingCount,
        ...(pendingSaved === undefined ? {} : { pendingSaved }),
        ...(pendingPathUsed ? { pendingPath: pendingPathUsed } : {}),
        ...(pendingError ? { pendingError } : {}),
      }
      if (!session) return base
      // 找这一会话里最后一轮还没发信的状态。先快照：迭代期间别的路径会改动这个 Map。
      let target = null
      for (const [key, state] of [...turns.entries()]) {
        if (!key.startsWith(`${session.id}:`)) continue
        if (state.ended) continue
        if (!target || state.turn > target.turn) target = state
      }
      if (!target) return base
      target.explicit = String(args.summary ?? '')
      log('info', `已收到第 ${target.turn} 轮的自写摘要`)
      return { ...base, accepted: true, turn: target.turn }
    },
  })), 'dsh-mail-digest: mail_digest tool')

  // ── 回信通道：把提问发到邮箱，把你的回信变成答案或新消息 ──────────
  const replyBridge = createReplyBridge({
    getConfig,
    log,
    allowedSenders: () => collectRecipients(getConfig()),
  })

  /** 发一封提问邮件（正文里写清回复格式）。 */
  async function sendQuestionMail({ title, questions, marker }) {
    const config = getConfig()
    const to = collectRecipients(config)
    if (to.length === 0) return { ok: false, reason: '没有收件人' }
    const lines = []
    const list = Array.isArray(questions) ? questions : []
    list.forEach((question, index) => {
      const number = index + 1
      lines.push(`${number}. ${question.header ? `【${question.header}】` : ''}${question.question}`)
      if (question.detail) lines.push(`   ${String(question.detail).split('\n').join('\n   ')}`)
      const options = Array.isArray(question.options) ? question.options : []
      options.forEach((option, optionIndex) => {
        const letter = String.fromCharCode(65 + optionIndex)
        lines.push(`   ${letter}. ${option.label}${option.description ? `（${option.description}）` : ''}`)
      })
      lines.push('')
    })
    lines.push('────────────')
    lines.push('回信方式：直接在正文里写答案，保持主题不变。')
    if (list.length === 1) {
      lines.push('选一个就写选项字母，例如：A')
      lines.push('都不满意就直接写你要的内容。')
    } else {
      lines.push('每个问题一行，题号 + 选项字母，例如：')
      lines.push('   1. A')
      lines.push('   2. B')
      lines.push('某个问题不满意就直接写内容，例如：1. 用私有仓库')
    }
    const result = await deliver(config, {
      from: senderAddress(config),
      to,
      subject: `${config.subjectPrefix ? `${config.subjectPrefix} ` : ''}❓ ${title || '需要你回答'} ${marker}`,
      text: lines.join('\n'),
    })
    if (!result.ok) log('warn', `提问邮件发送失败：${result.reason}`)
    return { ok: result.ok === true, messageId: result.messageId, reason: result.reason }
  }

  // 挂到 user-questions 瀑布：**不改动界面那套问答**，只是旁听 + 并行等回信。
  // 谁先到算谁 —— 你在界面点了就返回界面答案，回了邮件就提交邮件答案。
  ctx.on('user-questions/request', (request, next) => {
    const config = getConfig()
    const shouldMail = config.enabled
      && config.reply?.enabled === true
      && config.reply?.askViaEmail === true
      && imapReady(config)
    if (!shouldMail) return next()

    const questions = Array.isArray(request?.questions) ? request.questions : []
    if (questions.length === 0) return next()

    const sessionId = request?.agent?.id
    // 立刻把界面通道接上（不改动它的行为）。
    const byInterface = Promise.resolve(next())

    return (async () => {
      // 每封提问邮件都有自己的一次性 token。
      const token = newThreadToken()
      const marker = threadMarker('Q', token)
      let resolveAnswer
      const answerPromise = new Promise((resolve) => { resolveAnswer = resolve })
      replyBridge.register({ token, marker, sessionId, kind: 'Q', questions, resolve: resolveAnswer })
      replyBridge.armTimeout(token)

      try {
        const sent = await sendQuestionMail({ title: titleFromAnywhere(sessionId), questions, marker })
        if (!sent.ok) {
          replyBridge.finish(token)
          return byInterface
        }
        replyBridge.noteSent(token, sent.messageId)
        log('info', `已把 ${questions.length} 个问题发到邮箱（${marker}），等回信或界面作答`)
      } catch (error) {
        log('warn', `提问邮件发送失败：${error.message}`)
        replyBridge.finish(token)
        return byInterface
      }

      const byMail = answerPromise.then((answer) => ({ viaMail: true, answer }))
      const first = await Promise.race([
        byMail,
        byInterface.then((answer) => ({ viaMail: false, answer })),
      ])

      if (first.viaMail && !first.answer?.cancelled
        && Array.isArray(first.answer?.items) && first.answer.items.length > 0) {
        log('info', '采用邮件答案（界面那边若还开着，可以关掉）')
        return { answers: first.answer.items }
      }
      // 界面先到 / 邮件超时 / 邮件被撤销：确保邮件通道已关闭，并把界面的答案返回。
      replyBridge.finish(token)
      if (!first.viaMail) return first.answer
      // 走到这里说明邮件分支赢了但没有可用答案（被撤销或超时）——等界面。
      return byInterface
    })()
  })

  // ── 邮件审批：需要你放行的操作也走邮件 ────────────────────────────
  //
  // 挂到 approval/request 瀑布：返回 'allowed-once' 即认领这次审批，
  // 调用 next() 则交给下一个应答者（界面对话框）。与提问通道同样「先到算谁」。
  //
  // ⚠ 安全边界（写清楚，不藏）：
  //   1. 它**绕过不了** `never` 策略 —— 文档明确 never 在瀑布分发之前就强制 rejected。
  //   2. 它把「批准能力」搬到了邮箱：邮箱被盗 = 批准能力被盗。
  //      之所以还能接受：仍过三道闸（一次性随机 token + 发件人白名单 + References 比对原信），
  //      且 **认不出表态就按拒绝处理（fail closed）**，绝不因"像同意"而放行。
  async function sendApprovalMail({ title, toolName, reason, marker }) {
    const config = getConfig()
    const to = collectRecipients(config)
    if (to.length === 0) return { ok: false, reason: '没有收件人' }
    const lines = [
      '⚠ 有一项操作需要你放行，我现在停在这里等你决定。',
      '',
      `工具：${toolName || '（未知）'}`,
      `原因：${reason || '（调用方未说明）'}`,
      `会话：${title || '（未命名会话）'}`,
      `时间：${stamp()}`,
      '',
      '────────────',
      '回复本邮件决定（保持主题不变，正文只写一个选项）：',
      '',
      '1. 允许这一次',
      '2. 拒绝',
      '',
      `只放行这一次操作，不会记住为长期允许。超过 ${Math.round(APPROVAL_TIMEOUT_MS / 60000)} 分钟未回复则默认拒绝。`,
    ]
    const result = await deliver(config, {
      from: senderAddress(config),
      to,
      subject: `${config.subjectPrefix ? `${config.subjectPrefix} ` : ''}🔐 需要你授权 ${toolName || ''} ${marker}`.replace(/\s+/g, ' ').trim(),
      text: lines.join('\n'),
    })
    if (!result.ok) log('warn', `审批邮件发送失败：${result.reason}`)
    return { ok: result.ok === true, messageId: result.messageId, reason: result.reason }
  }

  ctx.on('approval/request', (request, next) => {
    const config = getConfig()
    const shouldMail = config.enabled
      && config.reply?.enabled === true
      && config.reply?.askViaEmail === true
      && imapReady(config)
    if (!shouldMail) return next()

    const sessionId = request?.agent?.id
    // 界面通道照走（保留原生审批能力）。
    // 用 async 包装，确保 next() 的同步异常不会在这里被吞掉。
    const startInterface = async () => {
      try {
        return await next()
      } catch (error) {
        log('warn', `界面审批通道出错：${error.message}`)
        return 'unavailable'
      }
    }
    const byInterface = startInterface()

    return (async () => {
      const token = newThreadToken()
      const marker = threadMarker('A', token)
      let resolveDecision
      const decisionPromise = new Promise((resolve) => { resolveDecision = resolve })
      replyBridge.register({ token, marker, sessionId, kind: 'A', resolve: resolveDecision })
      replyBridge.armApprovalTimeout(token)

      try {
        const sent = await sendApprovalMail({
          title: titleFromAnywhere(sessionId),
          toolName: request?.toolName,
          reason: request?.reason,
          marker,
        })
        if (!sent.ok) {
          replyBridge.finish(token)
          return byInterface
        }
        replyBridge.noteSent(token, sent.messageId)
        log('info', `已把审批请求发到邮箱（${marker}，工具 ${request?.toolName || '?'}），等回信或界面决定`)
      } catch (error) {
        log('warn', `审批邮件发送失败：${error.message}`)
        replyBridge.finish(token)
        return byInterface
      }

      const byMail = decisionPromise.then((answer) => ({ viaMail: true, answer }))
      const first = await Promise.race([
        byMail,
        byInterface.then((outcome) => ({ viaMail: false, outcome })),
      ])

      if (first.viaMail) {
        const decision = first.answer?.decision
        if (decision === 'allow') {
          log('info', `邮件批准了这次操作（${marker}）—— 界面若还开着可以取消`)
          return 'allowed-once'
        }
        if (decision === 'reject') {
          log('info', `邮件拒绝了这次操作（${marker}）${first.answer?.timeout ? '（超时默认拒绝）' : ''}`)
          return 'rejected'
        }
        // 撤销/未决：交回界面
        log('info', `邮件审批未决（${marker}），交回界面`)
        return byInterface
      }

      // 界面先到：撤销邮件通道，别让它之后再来改结论。
      replyBridge.finish(token)
      log('info', `界面先给出了审批结论（${first.outcome}）`)
      return first.outcome
    })()
  })

  // 定时收信：处理回信（提问答案 / 对话续接 / 审批决定）。
  // 有审批线程时收得更勤（5 秒），因为审批对延迟敏感 —— 用户正卡在那里等。
  ctx.effect(() => {
    let ticks = 0
    const timer = setInterval(() => {
      ticks += 1
      // 有待审批或待答线程时每轮都收；空闲时按更慢的节奏（省一次 IMAP 往返）
      const busy = replyBridge.pendingCount > 0
      if (!busy && ticks % 3 !== 0) return
      void replyBridge.pollOnce({
        onConversationReply: ({ sessionId, text }) => {
          const agents = ctx.get('agents')
          const agent = agents?.get?.(sessionId)
          if (!agent) {
            log('warn', `回信要投的会话已不在运行（${sessionId}），忽略`)
            return
          }
          agent.followup({
            id: `mail-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
            role: 'user',
            content: [{ type: 'text', text }],
            source: {
              kind: 'plugin',
              plugin: 'dsh-mail-digest',
              form: 'notice',
              summary: '邮件回复',
            },
          })
          log('info', `已把邮件回信作为新消息投回会话 ${sessionId}`)
        },
      })
    }, APPROVAL_POLL_MS)
    timer.unref?.()
    return () => {
      clearInterval(timer)
      replyBridge.dispose()
    }
  }, 'dsh-mail-digest: reply poller')

  // ── 设置界面（可选挂载：headless profile 没有 webServer） ────────
  ctx.inject(['webServer'], (hostCtx) => {
    hostCtx.effect(() => {
      const dispose = registerSettingsRoutes({
        webServer: hostCtx.webServer,
        getConfig,
        getConfigPath: configPath,
        log,
        testImapConnect: async (draft) => {
          const base = getConfig()
          const merged = draft ? { ...base, ...draft, imap: { ...base.imap, ...(draft.imap ?? {}) } } : base
          if (draft?.imap?.pass === '' || draft?.imap?.pass === undefined) merged.imap.pass = base.imap.pass
          const options = imapOptions(merged)
          if (!options.host || !options.user || !options.pass) {
            return { ok: false, reason: 'IMAP 配置不完整：需要服务器地址、账号与授权码' }
          }
          const result = await testImap(options)
          return result.ok ? { ok: true, host: options.host, port: options.port } : { ok: false, reason: result.reason }
        },
        sendTest: async (draft) => {
          const base = getConfig()
          const merged = draft ? { ...base, ...draft, smtp: { ...base.smtp, ...(draft.smtp ?? {}) } } : base
          if (draft?.smtp?.pass === '' || draft?.smtp?.pass === undefined) merged.smtp.pass = base.smtp.pass
          const readiness = describeReadiness(merged)
          if (!readiness.ready) return { ok: false, reason: `配置不完整：缺 ${readiness.missing.join('、')}` }
          const to = collectRecipients(merged)
          const result = await deliver(merged, {
            from: senderAddress(merged),
            to,
            subject: `${merged.subjectPrefix ? `${merged.subjectPrefix} ` : ''}📮 测试邮件`,
            text: [
              '这是一封测试邮件：能收到就说明 SMTP 配置可用。',
              '',
              '────────────',
              `服务器：${merged.smtp.host}:${merged.smtp.port}（${merged.smtp.secure ? 'SSL/TLS' : 'STARTTLS'}）`,
              `发件人：${senderAddress(merged)}`,
              `收件人：${to.join(', ')}`,
              `时间：${stamp()}`,
            ].join('\n'),
          })
          if (!result.ok) return { ok: false, reason: result.reason }
          return { ok: true, to, messageId: result.messageId }
        },
      })
      return dispose
    }, 'dsh-mail-digest: settings routes')

    log('info', '设置页已挂载：打开 http://127.0.0.1:3080/dsh-mail-digest 填邮箱与授权码')
  })

  // ── 启动自检：配置齐不齐，先说清楚 ──────────────────────────────
  const loaded = loadConfig()
  const readiness = describeReadiness(loaded.value)
  log('info', `已挂载。配置文件：${loaded.path}`)
  if (!readiness.ready) {
    log('warn', `还不能发信，缺：${readiness.missing.join('、')}。去 http://127.0.0.1:3080/dsh-mail-digest 填写。`)
  } else {
    log('info', `已就绪：${senderAddress(loaded.value)} → ${collectRecipients(loaded.value).join(', ')}（${loaded.value.smtp.host}:${loaded.value.smtp.port}）`)
  }
}
