/**
 * 摘要的确定性部分：
 *   - 把一条回答的文本从会话事件里取出来
 *   - 清洗成适合进邮件的纯文本
 *   - 模型不可用时，用「结论句 + 收尾句」拼一条兜底摘要
 *
 * 这里的长度约束刻意**不是硬性字数上限**：正文多长由结论多少决定。
 * 归一化只在超出很宽松的安全线（防止把整篇文档塞进邮件）时才发生，
 * 且从整句边界切断，不做固定的「截断到 N 字」。
 */

/** 从内容块数组里取出纯文本（拼接同一会话事件里的所有 text 块）。 */
export function blocksToText(content) {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/**
 * 判断一条会话事件是不是「助手回答」。
 * `assistant/message` 的 data 形如 { turn, step, message: { role: 'assistant', content: [...] } }。
 * message.role 不存在时按 assistant 处理——某些版本只记录 content。
 */
export function isAssistantTextEvent(event) {
  if (!event || event.type !== 'assistant/message') return false
  const message = event.data?.message
  if (!message) return false
  if (message.role && message.role !== 'assistant') return false
  return blocksToText(message.content).length > 0
}

/**
 * 把一条回答的纯文本清洗成适合放进邮件的段落文本。
 * 去掉代码块、表格分隔、链接语法与强调标记——摘要是给人扫一眼的，
 * 不是原文搬运。
 * @param {string} raw - 原始 Markdown 回答。
 * @returns {string} 清洗后的纯文本（保留段落换行）。
 */
export function cleanAnswerText(raw) {
  let text = String(raw ?? '')
  if (!text.trim()) return ''
  // 代码块整体去掉（摘要里不需要代码）。
  text = text.replace(/```[\s\S]*?```/g, ' ')
  // 行内代码去掉反引号，保留内容。
  text = text.replace(/`([^`\n]+)`/g, '$1')
  // 图片整体去掉；链接只保留文字。
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  // Markdown 表格：丢掉分隔行，其余行只保留前两格内容。
  text = text
    .split('\n')
    .filter((line) => !/^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) || !line.includes('-'))
    .map((line) => line
      .replace(/^\s{0,3}#{1,6}\s*/, '')
      .replace(/^\s{0,3}>\s?/, '')
      .replace(/^\s*[-*+]\s+/, '')
      .replace(/^\s*\d+[.)]\s+/, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/(?<![A-Za-z0-9])\*([^*\n]+)\*(?![A-Za-z0-9])/g, '$1')
      .replace(/^\s*\|/, '')
      .replace(/\|\s*$/, '')
      .replace(/\s*\|\s*/g, ' · ')
      .replace(/[ \t]+/g, ' ')
      .trim())
    .join('\n')
  // 折叠多余空行，去掉纯装饰行。
  return text
    .split('\n')
    .filter((line) => line && !/^[-=_*·\s]{3,}$/.test(line))
    .join('\n')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

/** 一句「像结论」的话：带数量、因果、建议或明确的收尾口吻。 */
const CONCLUSION_HINTS = [
  '结论', '综上', '建议', '已', '完成', '装好', '搞定', '可用', '成功', '失败', '报错',
  '注意', '问题', '原因', '需要', '推荐', '默认', '可以', '不能', '支持', '限制', '结论是',
]

/**
 * 给一句话打信息量分数。位置越靠前、越像结论、越具体，分越高。
 * @param {string} sentence - 单句。
 * @param {number} index - 句序（0 起）。
 * @param {number} total - 总句数。
 * @returns {number} 分数。
 */
function scoreSentence(sentence, index, total) {
  let score = 0
  const length = sentence.length
  if (index === 0) score += 40
  else if (index === 1) score += 24
  else if (index === 2) score += 14
  else score += Math.max(0, 10 - index)
  if (index === total - 1) score += 26
  if (/[0-9０-９]/.test(sentence)) score += 10
  if (/[:：]/.test(sentence)) score += 5
  if (CONCLUSION_HINTS.some((hint) => sentence.includes(hint))) score += 12
  if (length >= 12 && length <= 70) score += 8
  else if (length < 6) score -= 18
  else if (length > 120) score -= 10
  if (/^(我|我们)(来|先|会|将|想|觉得)/.test(sentence)) score -= 12
  if (/[?？]$/.test(sentence)) score -= 6
  return score
}

/** 按中英文句末标点切句，保留标点。 */
function splitSentences(text) {
  const parts = []
  let buffer = ''
  for (const char of text) {
    buffer += char
    if ('。！？；!?;'.includes(char)) {
      const trimmed = buffer.trim()
      if (trimmed) parts.push(trimmed)
      buffer = ''
    }
  }
  const rest = buffer.trim()
  if (rest) parts.push(rest)
  return parts
}

/**
 * 兜底摘要：模型不可用时，从回答里挑出最有信息量的几句拼成一条。
 *
 * 长度由信息量决定：结论多的回答自然拼得多，一句就说完的回答就短。
 * 只有超过很宽松的安全线（避免把整篇文档塞进邮件）才在句子边界停下。
 *
 * @param {string} answer - 已清洗的回答文本。
 * @returns {string} 一条摘要；回答为空时返回空字符串。
 */
export function extractiveDigest(answer) {
  const text = String(answer ?? '').trim()
  if (!text) return ''

  // 先看开头几段：结论通常在这里。段落按整句参与打分。
  const paragraphs = text.split('\n').map((line) => line.trim()).filter(Boolean)
  const head = paragraphs.slice(0, 6).join(' ')
  const sentences = splitSentences(head)
  if (sentences.length === 0) return clampAtSentenceBoundary(paragraphs[0] ?? text)

  const ranked = sentences
    .map((sentence, index) => ({ sentence, index, score: scoreSentence(sentence, index, sentences.length) }))
    .sort((a, b) => b.score - a.score)

  const picked = []
  // 上限取得很宽：只用来挡住"整篇文档"，不用来控制详略。
  const softLimit = 220
  for (const item of ranked) {
    if (picked.length > 0 && picked.join('').length + item.sentence.length > softLimit) continue
    picked.push(item)
    if (picked.length >= 4) break
  }
  picked.sort((a, b) => a.index - b.index)

  let digest = picked.map((item) => item.sentence).join('')
  if (!digest.trim()) digest = sentences.slice(0, 2).join('')
  return clampAtSentenceBoundary(digest)
}

/** 只在超过宽松安全线时，从整句边界收尾——不做固定字数截断。 */
function clampAtSentenceBoundary(text) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim()
  const HARD_SAFETY = 400
  if (clean.length <= HARD_SAFETY) return clean
  const sentences = splitSentences(clean)
  let out = ''
  for (const sentence of sentences) {
    if (out && out.length + sentence.length > 300) break
    out += sentence
  }
  return (out || clean.slice(0, HARD_SAFETY)).trim()
}

/**
 * 把最终要发出去的摘要规整成一行文本：
 * 去掉模型可能加的引号、标签、列表符号和换行。
 * 注意：**不按字数截断**——详略交给内容本身决定。
 * @param {string} raw - 模型或用户给出的摘要。
 * @returns {string} 一行摘要。
 */
export function normalizeDigest(raw) {
  let text = String(raw ?? '').trim()
  if (!text) return ''
  // 去掉整体包裹的引号 / 书名号。
  text = text.replace(/^["'“”‘’「」《》]+/, '').replace(/["'“”‘’「」《》]+$/, '')
  // 去掉可能出现的标签或前缀。
  text = text.replace(/^\s*(摘要|总结|digest)\s*[:：]\s*/i, '')
  // 去掉行首的列表符号与标题标记。
  text = text
    .split('\n')
    .map((line) => line.replace(/^\s{0,3}#{1,6}\s*/, '').replace(/^\s*[-*+·]\s+/, '').replace(/^\s*\d+[.)]\s+/, '').trim())
    .filter(Boolean)
    .join(' ')
  return text.replace(/\s+/g, ' ').trim()
}
