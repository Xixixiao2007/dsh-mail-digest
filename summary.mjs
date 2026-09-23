/**
 * 用模型压缩「这一轮回答」，产出一条详略得当的中文摘要。
 *
 * 长度纪律（这是本插件的核心要求）：
 *   **不用字数限制邮件长度，用详略控制。**
 *   —— 提示词只给出参考区间（结论少就短、结论多就长），
 *      产出不做字数校验、不做截断；只有明显异常的产物（空、复读、超长失控）
 *      才回退到确定性摘要。
 */
import { normalizeDigest } from './digest.mjs'

/** 摘要写手的系统提示。详略优先，字数是参考不是约束。 */
const SYSTEM_PROMPT = [
  '你是 DeepSeek Harness 的邮件摘要写手。',
  '把助手刚给出的这一轮回答，压缩成一段中文摘要，用来发一封通知邮件。',
  '',
  '长度纪律（最重要）：',
  '- 长度由详略决定，不由字数决定：结论少就写短，可能只有一句话；结论多就写详细些，把要点都带上。',
  '- 参考区间约一百字上下（六十字到一百八十字都算合适），但这是参考，不是限制。',
  '- 宁可写全要点，也不要把结论压掉；也绝不要为了凑长度加废话。',
  '',
  '写法：',
  '- 直接陈述做了什么、结论是什么、下一步或需要注意什么。',
  '- 一段连续文本，不要换行、不要 Markdown、不要小标题、不要项目符号。',
  '- 不要开场白（"好的""以下是"），不要"综上所述"这类套话，不要复述用户的问题。',
  '- 不要用引号把整段话包起来。',
  '- 保持原回答的语言（原回答是中文就用中文）。',
].join('\n')

/**
 * 构造要压缩的正文。超长回答只截取头尾——摘要需要的是结论，不是全文。
 * @param {string} answer - 已清洗的回答文本。
 * @returns {string} 供模型阅读的正文。
 */
function promptBody(answer) {
  const text = String(answer ?? '').trim()
  const HEAD = 6000
  const TAIL = 2000
  if (text.length <= HEAD + TAIL) return text
  return `${text.slice(0, HEAD)}\n\n…（中间略）…\n\n${text.slice(-TAIL)}`
}

/**
 * 调一次模型，生成摘要。
 * @param {object} options
 * @param {any} options.llm - `ctx.llm` 服务。
 * @param {string} options.provider - 模型提供方路由。
 * @param {string} options.model - 模型 id。
 * @param {string} options.answer - 这一轮回答的清洗后文本。
 * @param {AbortSignal} [options.signal] - 取消信号。
 * @param {number} [options.timeoutMs] - 本地的兜底超时，默认 45 秒。
 * @returns {Promise<string|null>} 摘要；不可用时返回 null（由调用方回退）。
 */
export async function modelDigest({ llm, provider, model, answer, signal, timeoutMs = 45_000 }) {
  if (!llm || typeof llm.stream !== 'function') return null
  if (!provider || !model) return null
  const body = promptBody(answer)
  if (!body) return null

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('摘要超时')), timeoutMs)
  const onAbort = () => controller.abort(signal?.reason)
  if (signal) {
    if (signal.aborted) { clearTimeout(timer); return null }
    signal.addEventListener('abort', onAbort, { once: true })
  }

  try {
    const options = {
      provider,
      model,
      system: SYSTEM_PROMPT,
      messages: [
        { role: 'user', content: [{ type: 'text', text: body }] },
      ],
      signal: controller.signal,
    }
    let text = ''
    for await (const chunk of llm.stream(options)) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
      else if (chunk?.type === 'finish' && chunk.reason?.kind === 'error') return null
      else if (chunk?.type === 'finish' && chunk.reason?.kind === 'aborted') return null
    }
    const digest = normalizeDigest(text)
    return digest || null
  } catch {
    // 模型路由不可用、被取消、超时：交给调用方回退到确定性摘要。
    return null
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
  }
}
