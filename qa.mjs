/**
 * 邮件问答编排：把 DSH 的「提问」和「回答」发到邮箱，把你的「回信」变成
 * 答案或新消息。
 *
 * 两条通道（用户 2026-09-23 定）：
 *
 *   A. 提问通道 —— `ask_user_question` 需要人回答时
 *      通过 `user-questions/request` 瀑布发邮件，一边等回信一边把请求交给
 *      下一个监听器（界面对话框）；**谁先到算谁**。绝不抢占界面的原生问答能力。
 *
 *   B. 对话通道 —— 每轮回答结束后
 *      邮件里带线程标记；你回复该邮件（内容写在正文），正文被当作一条新的
 *      用户消息投回原会话，对话继续。
 *
 * ── 每次发信都换一个 ID（用户要求）──────────────────────────────
 * 每封发出去的邮件都有自己的随机 token，形如 `[DSH-T:k3f9a2x8m1qp]`。
 * 这样做的好处：
 *   1. token 本身就是一次性凭据，不可猜测、不复用；
 *   2. 外来邮件即使正文写着 `[DSH-...`，token 对不上就被丢弃；
 *   3. 能精确定位你的回信是哪一轮、对应哪个会话。
 *
 * ── 三道闸（防止把随机邮件误判成回复）────────────────────────────
 *   ① 主题里必须有**写全**的 `[DSH-Q:<token>]` / `[DSH-T:<token>]`，
 *      且 token 必须是**我们真的发出去过**的那一串；
 *   ② 发件人必须是配置的收件人（也就是你自己）；
 *   ③ 回信的 References / In-Reply-To 要能对上我们那封邮件的 Message-ID
 *      （有些客户端会剥掉这两个头，此时靠 ①② 放行并在日志里记明）。
 */
import { fetchReplies, IMAP_PRESETS } from './imap.mjs'
import { matchAnswers, parseMailReply, approvalDecisionFrom } from './reply.mjs'

/** 提问线程的存活上限：超时就把决定权交回界面。 */
const QUESTION_TIMEOUT_MS = 30 * 60_000
/** 审批线程的存活上限：超时按拒绝处理（fail closed）。 */
const APPROVAL_TIMEOUT_MS = 10 * 60_000
/** 轮询收件箱的间隔。 */
const POLL_INTERVAL_MS = 15_000
/** 有待处理线程（尤其是审批）时的轮询间隔：更勤，因为用户正卡在那里等。 */
const APPROVAL_POLL_MS = 5_000
/** 最多记住多少条已发线程（够覆盖最近的历史，避免无限增长）。 */
const MAX_THREADS = 500

/** 从配置里取 IMAP 连接参数（复用发信那套账号；显式配了 imap 就用显式的）。 */
export function imapOptions(config) {
  const preset = IMAP_PRESETS[config.provider] ?? {}
  const imap = config.imap ?? {}
  return {
    host: imap.host || preset.host || '',
    port: imap.port || preset.port || 993,
    secure: imap.secure === undefined ? (preset.secure ?? true) : imap.secure === true,
    user: imap.user || config.smtp.user,
    pass: imap.pass || config.smtp.pass,
    mailbox: imap.mailbox || 'INBOX',
  }
}

/** IMAP 是否配置齐了（缺就退化成单向通知，不报错）。 */
export function imapReady(config) {
  const options = imapOptions(config)
  return Boolean(options.host && options.user && options.pass)
}

/** 从 `名字 <a@b.com>` 里取出纯邮箱地址（小写）。 */
export function senderAddressOf(from) {
  const text = String(from ?? '')
  const angled = /<([^>]+)>/.exec(text)
  const raw = angled ? angled[1] : text
  return raw.trim().toLowerCase().replace(/^["']|["']$/g, '')
}

/**
 * 认「写全」的线程标记：`[DSH-Q:token]`（提问）/ `[DSH-T:token]`（对话）/ `[DSH-A:token]`（审批）。
 * 落在主题任意位置即可（`Re:` / `回复：` 前缀随便），token 必须是 6~32 位字母数字。
 *
 * ── 为什么要容忍标记内部的空格 ──────────────────────────────────
 * 实测 QQ 邮箱（含手机 App）在回复时会把长主题**按显示宽度插入空格**，把
 * `[DSH-Q:e2jdvd7izt50]` 变成 `[D SH-Q:e2jdvd7izt50]`、甚至把 token 中间断开
 * （`[DSH-T:wk1fbajmv3 bj]`）。严格匹配会让这种回信被当成「外来邮件」丢弃。
 *
 * 安全性没有因此下降：token 是我们自己生成的 12 位随机串，**必须在已知线程表里**
 * 才会被采纳（见 pollOnce 的闸①「不是我们发出的」）。容忍空格只是恢复被客户端
 * 破坏的标记，不会让无关邮件匹配上。
 *
 * @param {string} subject - 已解码的原始主题。
 * @returns {{kind: 'Q'|'T'|'A', token: string} | null}
 */
export function threadFromSubject(subject) {
  const text = String(subject ?? '')
  // 1) 严格：标记完整无空格
  const strict = /\[DSH-([QTA]):([a-z0-9]{6,32})\]/i.exec(text)
  if (strict) return { kind: strict[1].toUpperCase(), token: strict[2].toLowerCase() }
  // 2) 容忍：`[` 到 `]` 之间允许空白（含客户端折行插入的）
  const loose = /\[([^\]]{0,80})\]/g
  let found
  while ((found = loose.exec(text)) !== null) {
    const compact = found[1].replace(/\s+/g, '')
    const parsed = /^DSH-([QTA]):([a-z0-9]{6,32})$/i.exec(compact)
    if (parsed) return { kind: parsed[1].toUpperCase(), token: parsed[2].toLowerCase() }
  }
  return null
}

/**
 * 建一个邮件问答编排器。
 * @param {object} deps
 * @param {() => object} deps.getConfig - 读配置。
 * @param {(level: string, message: string) => void} deps.log - 日志。
 * @param {() => string[]} [deps.allowedSenders] - 允许的发件人白名单（收件人列表）。
 * @param {Function} [deps.fetchRepliesImpl] - 收信实现，默认 imap.fetchReplies；测试可注入替身。
 * @returns {object} 编排器。
 */
export function createReplyBridge({ getConfig, log, allowedSenders, fetchRepliesImpl }) {
  const fetchMails = typeof fetchRepliesImpl === 'function' ? fetchRepliesImpl : fetchReplies
  /** token → {token, marker, sessionId, kind, questions, messageId, resolve, settled, timer} */
  const threads = new Map()
  /** 已经用掉的邮件 uid（避免重复采纳同一封回信）。 */
  const consumedUids = new Set()

  /** 每封邮件都换一个标记：先注册，发完把 messageId 回填。 */
  function register(thread) {
    const entry = {
      token: thread.token,
      marker: thread.marker,
      sessionId: thread.sessionId,
      // 三种线程：Q 提问作答 / T 对话续接 / A 审批决定
      kind: ['Q', 'T', 'A'].includes(thread.kind) ? thread.kind : 'T',
      questions: Array.isArray(thread.questions) ? thread.questions : [],
      messageId: '',
      resolve: typeof thread.resolve === 'function' ? thread.resolve : null,
      settled: false,
      timer: null,
      at: Date.now(),
    }
    threads.set(entry.token, entry)
    if (threads.size > MAX_THREADS) {
      // 淘汰最旧的（只丢索引，不影响已经发出的邮件）。
      const oldest = [...threads.values()].sort((a, b) => a.at - b.at)[0]
      if (oldest) threads.delete(oldest.token)
    }
    return entry
  }

  /**
   * 收信时要知道去搜哪些标记。
   *
   * 顺序有意「新 → 旧」：`fetchReplies` 会用这些标记做服务端精确定位（受条数上限约束），
   * 而用户正在等的是**最近发出的那几封**（审批/提问），所以新的必须排前面。
   */
  function knownMarkers() {
    return [...threads.values()]
      .sort((a, b) => b.at - a.at)
      .map((entry) => entry.marker)
      .filter(Boolean)
      .filter((marker, index, all) => all.indexOf(marker) === index)
  }

  /** 发出去之后回填 Message-ID（回信的 References 里会带上它）。 */
  function noteSent(token, messageId) {
    const entry = threads.get(token)
    if (entry && messageId) entry.messageId = String(messageId).toLowerCase()
  }

  /**
   * 撤销一个提问线程（界面先答了、或主动放弃）。
   *
   * 注意回给 `resolve` 的是 `{ cancelled: true }`，不是空答案 —— 调用方必须
   * 靠这个标记把它和「真的答了但一道都没对上」区分开，否则界面先答的场景
   * 可能被当成「邮件答了空」而覆盖掉界面答案。
   */
  function finish(token) {
    const entry = threads.get(token)
    if (!entry) return
    entry.settled = true
    if (entry.timer) clearTimeout(entry.timer)
    if (entry.resolve) entry.resolve({ cancelled: true, items: [], leftover: '' })
    threads.delete(token)
  }

  /** 给提问线程挂超时：到点就交回界面。 */
  function armTimeout(token) {
    const entry = threads.get(token)
    if (!entry || !entry.resolve) return
    entry.timer = setTimeout(() => {
      if (entry.settled) return
      log('info', `提问邮件超时未回复（${entry.marker}），交回界面`)
      entry.settled = true
      threads.delete(token)
      entry.resolve({ items: [], leftover: '', timeout: true })
    }, QUESTION_TIMEOUT_MS)
    entry.timer.unref?.()
  }

  /**
   * 给审批线程挂超时，**走 fail-closed**：超时即拒绝，而不是一律交回界面。
   *
   * 理由：审批涉及的正是「需要放行才能做」的操作。超时后若交给界面继续等，
   * 任务会一直挂着（就是那个「硬控」）；明确拒绝则让任务快速失败、把决定留给下一轮。
   * 界面若抢先作答，走的是 `finish()`/答案路径，不会受这里影响。
   */
  function armApprovalTimeout(token) {
    const entry = threads.get(token)
    if (!entry || !entry.resolve) return
    entry.timer = setTimeout(() => {
      if (entry.settled) return
      log('info', `审批邮件超时未回复（${entry.marker}），按拒绝处理（fail closed）`)
      entry.settled = true
      threads.delete(token)
      entry.resolve({ decision: 'reject', timeout: true })
    }, APPROVAL_TIMEOUT_MS)
    entry.timer.unref?.()
  }

  /**
   * 轮询一次收件箱，把回信变成答案 / 新消息。
   * @param {object} handlers
   * @param {(payload: {token: string, sessionId: string, text: string, mail: object}) => void} [handlers.onConversationReply]
   */
  async function pollOnce({ onConversationReply } = {}) {
    const config = getConfig()
    if (!config.enabled || !config.reply?.enabled) return
    if (!imapReady(config)) return
    // 没有任何「我们发出过且还在等」的线程时，不去碰邮箱（省流量，也不会误判）。
    if (threads.size === 0) return

    const options = imapOptions(config)
    const allowed = (typeof allowedSenders === 'function' ? allowedSenders() : [])
      .map((address) => senderAddressOf(address))
      .filter(Boolean)
    // 我们发出过的所有 Message-ID：回信的 References 里会带上。
    const sentIds = new Set(
      [...threads.values()].map((entry) => entry.messageId).filter(Boolean),
    )

    // ── 服务器端搜索用「固定前缀」，不用逐个标记 ─────────────────────
    //
    // 踩过的坑：原先拿我们自己的完整标记去搜
    //   UID SEARCH SUBJECT "[DSH-Q:q66vinwnjqbc]"
    // 但邮件客户端会按显示宽度在主题里插空格，把标记变成 `[D SH-Q:q66vinwnjqbc]`，
    // 服务端子串匹配**直接匹配不到**——邮件连候选集都进不来，
    // 客户端再怎么容错也没用（等于在下游修、上游已筛空）。
    //
    // 改成一个客户端换行也改不坏的前缀 `[DSH-`：即使标记被插了空格，
    // 这个前缀仍在（`[D SH-Q:` 里就含 `[D SH-`… 为稳妥直接用 `DSH-`，见下）。
    // 精确性由下面的 token 校验保证（token 必须是**我们真的发出过**的）。
    const searchTerm = 'DSH-'
    const seen = new Map()

    /**
     * 收两轮：先只看未读（快、干净），**再全量兜一次**。
     *
     * 为什么要全量兜底（实测踩过）：用户的邮件客户端（手机 QQ 邮箱）会在他
     * 看邮件时把邮件标成 `\Seen`；而配置里的 `unseenOnly=true` 会让插件只搜未读，
     * 于是「用户已经批准的回复」被自己的客户端标已读后就再也搜不到了 ——
     * 现象就是「我明明回了邮件批准，系统却按超时拒绝」。
     *
     * 全量会有噪声，但下面的 token 校验（必须是我们发出过的）足以筛干净，
     * 而且 `consumedUids` 保证同一封不会被重复采纳。
     */
    const wantUnseenOnly = config.reply?.unseenOnly !== false
    const passes = wantUnseenOnly ? [true, false] : [false]
    // 我们已知的完整标记：交给 fetchReplies 做服务端精确定位。
    // 这是「邮箱一大就漏掉新回复」那个 bug 的根本解法 ——
    // 不再依赖"最近 N 封里应该能找到"这种会过期的假设。
    const markers = knownMarkers()
    let found = []
    for (const unseenOnly of passes) {
      try {
        const batch = await fetchMails({
          ...options,
          marker: searchTerm,
          markers,
          unseenOnly,
          // 163 等会把「自己回复自己」的邮件放进「已发送」，必须一起搜。
          autoDiscover: true,
          // limit 只限制**返回条数**（现在是最新的 N 封），
          // 真正的候选范围由 window 决定；前缀搜索必然多捞，靠 token 精确筛。
          limit: 30,
          window: 400,
        })
        found = found.concat(batch)
        // 未读那轮已经捞到东西就不必全量扫了（省一次 IMAP 往返）
        if (unseenOnly && batch.length > 0) break
      } catch (error) {
        if (unseenOnly) {
          log('warn', `收信失败（未读，搜 ${searchTerm}）：${error.message}，尝试全量`)
          continue
        }
        log('warn', `收信失败（全量，搜 ${searchTerm}）：${error.message}`)
        return
      }
    }
    const stats = { fetched: found.length, threads: threads.size, matched: 0, ignored: 0 }
    for (const mail of found) if (!seen.has(mail.uid)) seen.set(mail.uid, mail)
    if (seen.size === 0) return

    for (const mail of seen.values()) {
      if (consumedUids.has(mail.uid)) continue
      consumedUids.add(mail.uid)
      if (consumedUids.size > 1000) {
        const first = consumedUids.values().next().value
        consumedUids.delete(first)
      }

      // ── 闸①：主题里必须是**我们真的发过**的那个 token ──────────────
      const thread = threadFromSubject(mail.subject)
      if (!thread) {
        stats.ignored++
        log('info', `忽略邮件（主题没有合法线程标记）：${String(mail.subject ?? '').slice(0, 60)}`)
        continue
      }
      const entry = threads.get(thread.token)
      if (!entry) {
        stats.ignored++
        log('info', `忽略邮件：标记 ${thread.token} 不是我们发出的（可能是外来邮件或被清理的旧线程）`)
        continue
      }

      // ── 闸②：发件人必须是配置的收件人（你自己） ──────────────────
      if (allowed.length > 0) {
        const from = senderAddressOf(mail.from)
        if (!allowed.includes(from)) {
          log('warn', `忽略邮件：发件人 ${from || '(未知)'} 不在允许列表（${allowed.join(', ')}）`)
          continue
        }
      }

      // ── 闸③：References / In-Reply-To 要能对上我们那封 ─────────────
      const referenceText = `${mail.references ?? ''} ${mail.inReplyTo ?? ''}`.toLowerCase()
      const referenced = entry.messageId
        ? referenceText.includes(entry.messageId)
        : [...sentIds].some((id) => referenceText.includes(id))
      if (referenceText.trim() === '') {
        log('info', `回信没带 References 头，按标记+白名单放行（${thread.token}）`)
      } else if (!referenced) {
        log('warn', `忽略邮件：带了标记但不是在回复我们发出的邮件（${thread.token}）`)
        continue
      }

      const parsed = parseMailReply(mail)
      if (parsed.answers.length === 0) continue

      // ── 审批通道：回信决定「允许这一次 / 拒绝」 ──────────────────
      if (entry.kind === 'A') {
        if (entry.settled || !entry.resolve) {
          log('info', `审批已结束或已被界面处理（${thread.token}），忽略`)
          continue
        }
        // 审批不按「题号. 字母」解析，而是认明确的表态词或 1/2。
        // 原始正文优先（引用已剥），认不出来时再看 cleaned 主题。
        const decision = approvalDecisionFrom(mail.text) ?? approvalDecisionFrom(parsed.cleaned)
        if (!decision) {
          log('warn', `审批回信看不懂（${thread.token}），按拒绝处理（fail closed）`)
        }
        entry.settled = true
        if (entry.timer) clearTimeout(entry.timer)
        threads.delete(thread.token)
        log('info', `收到邮件审批（${thread.token}）：${decision ?? '无法识别→拒绝'}`)
        entry.resolve({ decision: decision ?? 'reject' })
        continue
      }

      if (entry.kind === 'Q') {
        if (entry.settled || !entry.resolve) {
          log('info', `提问已结束或已被界面作答（${thread.token}），忽略`)
          continue
        }
        const { items, leftover } = matchAnswers(parsed.answers, entry.questions)
        if (items.length === 0) {
          log('warn', `回信没解析出可用答案（${thread.token}）`)
          continue
        }
        entry.settled = true
        if (entry.timer) clearTimeout(entry.timer)
        threads.delete(thread.token)
        log('info', `收到邮件答案（${thread.token}）：${items.map((i) => i.selected.join('/') || i.custom || '空').join(' | ')}`)
        entry.resolve({ items, leftover })
        continue
      }

      // 对话通道
      if (typeof onConversationReply !== 'function') continue
      const text = parsed.answers.map((a) => a.custom || a.letters).filter(Boolean).join('\n').trim()
        || parsed.cleaned
      if (!text) continue
      log('info', `收到对话回信（${thread.token}），投回会话`)
      try {
        await onConversationReply({ token: thread.token, sessionId: entry.sessionId, text, mail })
      } catch (error) {
        log('warn', `把回信投回会话失败：${error.message}`)
      }
    }
  }

  return {
    register,
    noteSent,
    finish,
    armTimeout,
    armApprovalTimeout,
    pollOnce,
    knownMarkers,
    get pendingCount() { return [...threads.values()].filter((entry) => !entry.settled).length },
    dispose() {
      for (const token of [...threads.keys()]) finish(token)
    },
  }
}

export { POLL_INTERVAL_MS, APPROVAL_POLL_MS, QUESTION_TIMEOUT_MS, APPROVAL_TIMEOUT_MS }
