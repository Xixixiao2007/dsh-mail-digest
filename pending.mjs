/**
 * 待申请权限清单（持久化）。
 *
 * 为什么需要它：agent 有时要做**工作区之外**的写操作（改 `~/.dsh` 下的技能、
 * 配置、profile 等），这类操作需要用户批准。如果用户不在电脑前，
 * 当场申请就会把任务卡在等待里（等于被"硬控"）。
 *
 * 所以约定：**不要在用户可能离开时申请权限**，而是把待办攒起来，
 * 放进每封摘要邮件的固定区块里；用户回来一次看完、批准后再做。
 *
 * 存成 JSON 文件而不是内存：插件重启（DSH 重启很频繁）不能把清单弄丢。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { configPath } from './config.mjs'

/** 清单文件放在配置文件旁边（首选位置）。 */
export function pendingPath() {
  return join(dirname(configPath()), 'pending-permissions.json')
}

/**
 * 回退位置：插件目录里（插件装在工作区内，这个位置必然可写）。
 *
 * 为什么需要回退：实测出现过「清单没落盘」，而 savePending 的失败被 catch 吞掉。
 * 不能假设 DSH 进程对 `~\.dsh` 的写权限和别处一致，所以多给一个可靠落点。
 */
export function pendingFallbackPath() {
  try {
    return join(dirname(fileURLToPath(import.meta.url)), 'pending-permissions.json')
  } catch {
    return ''
  }
}

/** 单条待办的字段上限，避免邮件被撑爆。 */
const MAX_ITEMS = 12
const MAX_TEXT = 300

/** 规整一条待办。 */
function normalizeItem(raw, index) {
  if (!raw || typeof raw !== 'object') {
    const text = String(raw ?? '').trim()
    return text ? { what: text.slice(0, MAX_TEXT), why: '', need: '' } : null
  }
  const what = String(raw.what ?? raw.title ?? raw.text ?? '').trim()
  if (!what) return null
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : `p${index + 1}`,
    what: what.slice(0, MAX_TEXT),
    why: String(raw.why ?? raw.reason ?? '').trim().slice(0, MAX_TEXT),
    need: String(raw.need ?? raw.permission ?? raw.scope ?? '').trim().slice(0, MAX_TEXT),
    at: Number.isFinite(Number(raw.at)) ? Number(raw.at) : Date.now(),
  }
}

/** 当前实际存在的清单路径；主路径优先（它是权威记录）。 */
export function activePendingPath() {
  const primary = pendingPath()
  if (existsSync(primary)) return primary
  const fallback = pendingFallbackPath()
  if (fallback && existsSync(fallback)) return fallback
  return primary
}

/**
 * 读待办清单。主路径优先，不存在时读回退路径。
 * @returns {Array<{id: string, what: string, why: string, need: string, at: number}>}
 */
export function loadPending() {
  for (const path of [pendingPath(), pendingFallbackPath()]) {
    if (!path || !existsSync(path)) continue
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'))
      const list = Array.isArray(parsed) ? parsed : (parsed?.items ?? [])
      const items = list.map(normalizeItem).filter(Boolean).slice(0, MAX_ITEMS)
      // 空清单也认（它表示"已清空"，不该再去看回退文件里的旧数据）
      return items
    } catch {
      continue
    }
  }
  return []
}

/**
 * 覆盖写入待办清单（原子写）。
 *
 * 先写首选位置（配置目录）；**失败则回退写插件目录**（工作区内，必然可写），
 * 并把失败原因一并返回 —— 之前这里吞掉错误，导致「清单没落盘」查不出原因。
 *
 * @param {Array} items - 新的清单。
 * @returns {{ok: boolean, count: number, path: string, fallback?: boolean, error?: string}}
 */
export function savePending(items) {
  const list = (Array.isArray(items) ? items : [])
    .map(normalizeItem)
    .filter(Boolean)
    .slice(0, MAX_ITEMS)
  const payload = `${JSON.stringify({ items: list, updatedAt: Date.now() }, null, 2)}\n`

  const primary = pendingPath()
  const primaryError = (() => {
    try {
      mkdirSync(dirname(primary), { recursive: true })
      const tmp = `${primary}.tmp`
      writeFileSync(tmp, payload, 'utf8')
      renameSync(tmp, primary)
      return null
    } catch (error) {
      return error.message
    }
  })()
  if (!primaryError) return { ok: true, count: list.length, path: primary }

  // 首选位置失败 → 回退
  const fallback = pendingFallbackPath()
  if (fallback && fallback !== primary) {
    try {
      mkdirSync(dirname(fallback), { recursive: true })
      const tmp = `${fallback}.tmp`
      writeFileSync(tmp, payload, 'utf8')
      renameSync(tmp, fallback)
      return { ok: true, count: list.length, path: fallback, fallback: true, error: primaryError }
    } catch (fallbackError) {
      return { ok: false, count: list.length, path: primary, error: `${primaryError} / 回退也失败：${fallbackError.message}` }
    }
  }
  return { ok: false, count: list.length, path: primary, error: primaryError }
}

/**
 * 把待办清单渲染成邮件里的固定区块。
 *
 * 放在摘要正文**之后**、元信息之前：它是要用户动手的事，必须显眼，
 * 但不该盖住摘要本身。
 *
 * @param {Array} items - 待办清单。
 * @returns {string} 可直接拼进邮件正文的文本；没有待办时返回空字符串。
 */
export function renderPendingBlock(items) {
  const list = Array.isArray(items) ? items.filter(Boolean) : []
  if (list.length === 0) return ''
  const lines = []
  lines.push('')
  lines.push('────────────')
  lines.push(`⚠ 待你批准的权限（${list.length} 项，我有工作区外的操作需要你放行）`)
  lines.push('')
  list.forEach((item, index) => {
    lines.push(`${index + 1}. ${item.what}`)
    if (item.need) lines.push(`   需要：${item.need}`)
    if (item.why) lines.push(`   原因：${item.why}`)
  })
  lines.push('')
  lines.push('你回来时批准任意一项即可（回复本邮件说明也可以）。')
  return lines.join('\n')
}
