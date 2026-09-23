/**
 * 剥掉回复正文里的引用历史，只留下你新写的内容。
 *
 * 回复解析**必须自己剥**，不能假设上游的 IMAP 读取做过这一步——否则
 * 你回信时带的原文会被当成答案（`1. A` 的解析会被引用的原文污染）。
 *
 * 注意中英文两套写法都要认：
 *   在 2026-09-23，DSH 写道：   /  On Mon, Sep 23 2026, X wrote:
 */
export function stripQuoted(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  const out = []
  /** 引用起始行：出现即停止收集（自身也不算内容）。 */
  const quoteLine = (line) => (
    /^>/.test(line)
    // 引用头：某年某月某日 + 某人 + 写道/写了/wrote
    || /^在\s*[0-9]{4}[-/年].{0,80}?(写道|写了|写於|來信)/.test(line)
    || /^On\s.{0,120}?(wrote|said)/i.test(line)
    // 只要出现这些词，基本就是引用头（宁可多剥，也不要把原文当答案）
    || /写道\s*[:：]\s*$/.test(line)
    || /(原始邮件|原始郵件|Original Message|Forwarded message)/i.test(line)
    || /^-{3,}\s*(原始邮件|原始郵件)/.test(line)
    || /^_{5,}$/.test(line)
  )
  for (const line of lines) {
    const trimmed = line.trim()
    if (quoteLine(trimmed)) break
    if (/^(发件人|寄件者|From)[:：]\s/i.test(trimmed) && out.length > 0) break
    if (/^(发送时间|寄件日期|Sent)[:：]\s/i.test(trimmed) && out.length > 0) break
    out.push(line)
  }
  while (out.length && /^\s*(发送自|发自我的|Sent from my|来自我的)/i.test(out[out.length - 1])) out.pop()
  return out.join('\n').trim()
}

/**
 * 回复解析：把你的邮件回复解析成「选项」或「自定义文本」。
 *
 * 格式（用户 2026-09-23 定）：
 *   - **内容写正文**；主题保持原样别动（里面的 `[DSH-Q:xxx]` 是线程标记，
 *     插件靠它搜索你的回信）；
 *   - 正文换行分题；
 *   - **选择题的标准写法是 `1. A`**（题号 + `.` + 空格 + 选项字母）；
 *   - **不满意要自定义**就直接写文本。
 *
 * 例（两个问题，正文这样回）：
 *   1. A
 *   2. B
 *
 *   1. A 2. B        ← 写一行也行
 *
 *   1. 用私有仓库吧   ← 自定义
 *   直接用你推荐的方案 ← 只有一题、连题号都省了
 */
import { randomBytes } from 'node:crypto'

/** 已知的邮件线程标记：只删这些，不误删你自己写的方括号。 */
const MARKER_PATTERNS = [
  /\[DSH-[A-Z0-9-]+:[^\]]*\]/gi,   // [DSH-Q:xxx] / [DSH-T:xxx]
  /\[DSH[^\]]*\]/gi,               // [DSH] / [DSH 提问]
]

/** 回复前缀：Re: / 答复: / 回复: / Fwd: …（可能叠好几层） */
const REPLY_PREFIX = /^\s*(?:(?:re|fw|fwd|答复|回复|回覆|轉發|转发)\s*(?:\[\d+\])?\s*[:：]\s*)+/i

/**
 * 清理主题，得到「你写的那部分」。
 * @param {string} subject - 原始主题。
 * @returns {string} 去掉标记与回复前缀、展开折行后的文本。
 */
export function cleanSubject(subject) {
  let text = String(subject ?? '')
  // 邮件头的折行：主题里出现换行说明是继续行，展开成空格。
  text = text.replace(/\r?\n[ \t]+/g, ' ')
  // 反复剥前缀与标记（Re: [DSH-Q:x] Re: ...）
  for (let i = 0; i < 6; i += 1) {
    const before = text
    text = text.replace(REPLY_PREFIX, '')
    for (const pattern of MARKER_PATTERNS) text = text.replace(pattern, '')
    if (text === before) break
  }
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * 行首题号。标准写法是 `1. A`（题号 + `.` + 空格 + 选项字母）。
 * 也认：`1.A`、`1 A`、`1) A`、`1、A`、`1A`、`#1 A`、`第1题 A`。
 *
 * 关键防误判：`. ` / `.` 后面**紧跟数字**时不认题号。
 * 否则 `1.1`、`2.0` 这类版本号会被吃成「题 1 + 内容 1」。
 *
 * @param {string} line - 单行。
 * @returns {{index: number, rest: string} | null}
 */
function takeQuestionNumber(line) {
  let text = String(line ?? '')
  const prefixStripped = /^\s*(?:#|第)\s*/.test(text)
  if (prefixStripped) text = text.replace(/^\s*(?:#|第)\s*/, '')

  const digits = /^(\d{1,2})/.exec(text)
  if (!digits) return null
  const index = Number(digits[1])
  let after = text.slice(digits[0].length)

  // `1A` / `1B` 这种无分隔符紧贴字母的写法
  if (/^[A-Za-zＡ-Ｚａ-ｚ]/.test(after)) return { index, rest: after }

  // 标准分隔符
  const separator = /^\s*(?:题)?\s*[.、)\]:：]\s*/.exec(after)
  if (separator) {
    const rest = after.slice(separator[0].length)
    // 挡版本号：`1.1` / `1.0`（点后紧跟数字且无空格）
    if (/^[.]/.test(after.trim()) && /^\d/.test(rest)) return null
    return { index, rest }
  }

  // 纯空格分隔：`1 私有`。
  // 保守处理：后面以冒号或数字开头时不当题号，避免把 `09:15:41`、`2026 09` 这类
  // 时间/编号吃成「题号 9 + 内容」。
  const spaced = /^\s+/.exec(after)
  if (spaced) {
    const rest = after.slice(spaced[0].length)
    if (/^[0-9]/.test(rest) || /^[:：]/.test(rest)) return null
    return { index, rest }
  }

  // 明确写了 `#1` / `第1` 前缀，后面即使空也算题号
  if (prefixStripped) return { index, rest: after.trim() }
  return null
}

/**
 * 取行首的选项字母。
 * 只有「整行基本就是字母」才算选择；后面还跟着实义文字（`QQ`、`私有`）时
 * 交给自定义文本处理，否则 `2 QQ` 会被误判成「选了第 2 个的 B」。
 * @param {string} line - 去掉题号后的内容。
 * @returns {{letters: string, rest: string} | null}
 */
function takeOptionLetters(line) {
  const match = /^\s*[（(\[]?\s*([A-Za-zＡ-Ｚａ-ｚ]{1,6})\s*[)）\].、:：]?\s*([\s\S]*)$/.exec(line)
  if (!match) return null
  const raw = match[1]
  const rest = match[2] ?? ''
  const letters = raw.replace(/[Ａ-Ｚａ-ｚ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)).toUpperCase()
  // 选项字母的合法形状：1~2 个、且互不相同（`A`/`AB` 是选择，`QQ`/`HELLO` 是普通词）。
  const looksLikeChoice = letters.length <= 2 && new Set(letters).size === letters.length
  if (rest.trim() === '') return looksLikeChoice ? { letters, rest } : null
  // 后面还有内容：只有「还只是字母/标点」才继续算选择（支持 `A B` 多选）。
  if (rest.trim().length <= 6 && /^[A-Za-zＡ-Ｚａ-ｚ\s,，、;；.]+$/.test(rest.trim())) {
    const extra = rest.replace(/[Ａ-Ｚａ-ｚ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
      .toUpperCase().replace(/[^A-Z]/g, '')
    const merged = `${letters}${extra}`
    if (merged.length <= 2 && new Set(merged).size === merged.length) return { letters: merged, rest: '' }
  }
  // 后面是实义文字 → 不是选择，整行当自定义。
  return null
}

/** 整行只是装饰线（`────` / `====` / `----` / `****`）时，不该当成答案。 */
function isSeparatorLine(text) {
  const compact = String(text ?? '').replace(/\s+/g, '')
  return compact.length > 0 && /^[─═—–\-=_*·•.]{3,}$/.test(compact)
}

/**
 * 解析一条回复文本（多行）成逐题答案。
 *
 * 规则：
 *   - 每行一题；行首有题号就用题号，没有就按出现顺序递增；
 *   - 行内容去掉题号后，若「剩下的只是选项字母」→ 当作选择；
 *   - 否则整行当作自定义文本（**保留原文，不做裁剪**）；
 *   - 装饰线跳过，既不当答案也不占题号。
 *
 * @param {string} text - 已经清掉标记的回复文本（正文或主题）。
 * @returns {Array<{index: number, letters: string, custom: string, raw: string}>}
 */
export function parseReplyLines(text) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  const answers = []
  let nextIndex = 1
  for (const line of lines) {
    // 整行可能带多个题号（"1A 2B"），先按「题号+内容」切段。
    const segments = splitSegments(line)
    for (const segment of segments) {
      const numbered = takeQuestionNumber(segment)
      let index = nextIndex
      let rest = segment
      if (numbered && numbered.index >= 1 && numbered.index <= 99) {
        index = numbered.index
        rest = numbered.rest
      }
      // 装饰线：跳过，不占题号也不当答案。
      if (isSeparatorLine(rest)) continue
      // 空内容（比如只有题号）：跳过。
      if (!rest.trim()) continue
      nextIndex = index + 1

      const option = takeOptionLetters(rest)
      if (option && option.rest.trim() === '') {
        answers.push({ index, letters: option.letters, custom: '', raw: segment.trim() })
      } else if (option && /^[.、,，;；\s]*$/.test(option.rest)) {
        answers.push({ index, letters: option.letters, custom: '', raw: segment.trim() })
      } else {
        // 剩下还有实义文字 → 自定义回答（保留全文，不做裁剪）。
        const custom = rest.replace(/^\s*[.、:：]\s*/, '').trim()
        answers.push({ index, letters: '', custom: custom || rest.trim(), raw: segment.trim() })
      }
    }
  }
  return answers
}

/**
 * 把一行切成若干「题号 + 内容」段，用于支持 `1. A 2. B` 这种一行写多题。
 *
 * 边界只认**明确形态**：空格 + 1~2 位数字 + 分隔符/字母 + 空格 + **选项字母**。
 * 例如 `1. A`、`2. B`、`3.A`。这样：
 *   - `1. A 2. B` 能切开；
 *   - `时间：2026-09-23 09:15:41`、`第 3 轮 · 用时 19 分` 这类元信息**不会**被切开
 *     （它们的分隔符后面不是单个选项字母）。
 *
 * @param {string} line - 单行。
 * @returns {string[]} 段列表（至少一段）。
 */
function splitSegments(line) {
  const text = String(line ?? '')
  const parts = text.split(/(?<=\S)\s+(?=\d{1,2}\s*[.、)\]:：]?\s*[A-Za-zＡ-Ｚａ-ｚ](?:\s|$))/)
  if (parts.length <= 1) return [text]
  return parts.map((part) => part.trim()).filter(Boolean)
}

/**
 * 把解析出的答案对到原问题上。
 *
 * 匹配策略：先按题号（1 基）取，取不到再按顺序取，都没有就丢弃。
 *
 * @param {Array<{index: number, letters: string, custom: string}>} answers - parseReplyLines 的结果。
 * @param {Array<{id: string, question: string, options?: Array<{label: string}>}>} questions - 原问题。
 * @returns {{items: Array<{id: string, selected: string[], custom?: string}>, leftover: string, matched: number}}
 *   items 是可直接提交给 DSH 的 AskUserQuestionAnswerItem 列表；
 *   leftover 是没能对到问题的自由文本（可以当作一条新的对话消息）。
 */
export function matchAnswers(answers, questions) {
  const list = Array.isArray(questions) ? questions : []
  const items = []
  const leftovers = []
  const used = new Set()

  for (const answer of answers) {
    let target = null
    if (answer.index >= 1 && answer.index <= list.length && !used.has(answer.index - 1)) {
      target = list[answer.index - 1]
      used.add(answer.index - 1)
    } else {
      // 按顺序找第一个没被占用的题
      for (let i = 0; i < list.length; i += 1) {
        if (!used.has(i)) { target = list[i]; used.add(i); break }
      }
    }

    if (!target) {
      // 多出来的文本：当成一条新消息，别丢。
      const text = answer.custom || answer.raw
      if (text) leftovers.push(text)
      continue
    }

    if (answer.letters) {
      const labels = mapLetters(answer.letters, target.options)
      if (labels.length > 0) {
        const item = { id: target.id, selected: labels }
        if (answer.custom) item.custom = answer.custom
        items.push(item)
        continue
      }
      // 字母对不上任何选项：当作自定义文本
      if (answer.custom) {
        items.push({ id: target.id, selected: [], custom: answer.custom })
        continue
      }
      // 纯字母但无匹配选项（题目可能没给选项）→ 也当自定义
      items.push({ id: target.id, selected: [], custom: answer.letters })
      continue
    }

    if (answer.custom) items.push({ id: target.id, selected: [], custom: answer.custom })
  }

  return { items, leftover: leftovers.join('\n').trim(), matched: items.length }
}

/**
 * 把选项字母映射成选项标签。
 * @param {string} letters - 形如 "AB"。
 * @param {Array<{label: string}>} options - 选项列表。
 * @returns {string[]} 选项标签；对不上时返回空数组。
 */
export function mapLetters(letters, options) {
  const list = Array.isArray(options) ? options : []
  const labels = []
  for (const letter of String(letters ?? '').toUpperCase()) {
    const position = letter.charCodeAt(0) - 65 // A → 0
    if (position < 0 || position >= list.length) continue
    const label = list[position]?.label
    if (typeof label === 'string' && label && !labels.includes(label)) labels.push(label)
  }
  return labels
}

/**
 * 从一封回复邮件里取出「你写的内容」并解析。
 *
 * **正文优先**（用户 2026-09-23 明确）：回复内容写在正文里，主题保持原样不动
 * （主题里的 `[DSH-Q:xxx]` 标记是线程标识，要靠它搜索到你的回信，别删）。
 * 只有正文为空时才退回看主题，作为容错。
 *
 * @param {object} mail - { subject, text }，来自 imap.mjs。
 * @returns {{answers: Array, source: 'body'|'subject'|'none', cleaned: string}}
 */
export function parseMailReply(mail) {
  const body = stripBodyNoise(mail?.text)
  if (body) {
    const answers = parseReplyLines(body)
    if (answers.length > 0 && answers.some((a) => a.letters || a.custom)) {
      return { answers, source: 'body', cleaned: body }
    }
  }
  const subject = cleanSubject(mail?.subject)
  if (subject) {
    const answers = parseReplyLines(subject)
    if (answers.length > 0 && answers.some((a) => a.letters || a.custom)) {
      return { answers, source: 'subject', cleaned: subject }
    }
  }
  return { answers: [], source: 'none', cleaned: body || subject || '' }
}

/** 正文里再去掉一层噪音：先剥引用（幂等），再滤掉签名分隔与空行。 */
function stripBodyNoise(text) {
  const lines = stripQuoted(String(text ?? ''))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^--\s*$/.test(line))
  return lines.join('\n').trim()
}

/**
 * 生成线程标记：同时用于「主题里能被搜索到」和「回信对上会话」。
 * 必须是纯 ASCII，才能用 IMAP 的 SUBJECT 搜索。
 * @param {string} prefix - 类别前缀，如 Q（提问）/ T（回答）。
 * @param {string} token - 已经生成的 token。
 * @returns {string} 形如 `[DSH-Q:abc123]`。
 */
export function threadMarker(prefix, token) {
  return `[DSH-${String(prefix).toUpperCase()}:${token}]`
}

/**
 * 为**每一封**发出去的邮件生成一个新的线程 token。
 *
 * 设计要点（用户 2026-09-23 定：每次回复都换 id）：
 *   - 每封邮件的标记都不同 → token 本身就是一次性凭据，外人猜不到、也不复用；
 *   - 你回某一封邮件时，主题里带的就是那一封的 token → 能精确定位到是哪一轮，
 *     并且天然排除了「碰巧带 [DSH- 字样的外来邮件」。
 *
 * 用 crypto 随机数（不是 Math.random），12 位小写字母数字，纯 ASCII 才能被
 * IMAP 的 SUBJECT 搜索匹配。
 * @returns {string} 形如 `k3f9a2x8m1qp`。
 */
export function newThreadToken() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const bytes = randomBytes(12)
  let token = ''
  for (let i = 0; i < 12; i += 1) token += alphabet[bytes[i] % alphabet.length]
  return token
}
