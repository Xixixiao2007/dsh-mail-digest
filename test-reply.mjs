/**
 * 回复解析自检：
 *   node test-reply.mjs
 *
 * 覆盖用户 2026-09-23 定的格式：主题直接写、换行分题、行首题号、
 * 单字母=选选项、其它文字=自定义。
 */
import {
  cleanSubject,
  matchAnswers,
  newThreadToken,
  parseMailReply,
  parseReplyLines,
  threadMarker,
} from './reply.mjs'
import { senderAddressOf, threadFromSubject } from './qa.mjs'

let failures = 0
let checks = 0
function check(label, condition, detail) {
  checks += 1
  if (condition) console.log(`  ok   ${label}`)
  else {
    failures += 1
    console.log(`  FAIL ${label}${detail === undefined ? '' : `  → ${detail}`}`)
  }
}

const twoQuestions = [
  { id: 'q1', question: '仓库公开还是私有？', options: [{ label: '公开' }, { label: '私有' }] },
  { id: 'q2', question: '用什么邮箱？', options: [{ label: 'QQ' }, { label: '163' }, { label: 'Gmail' }] },
]

console.log('\n[1] 主题清理')
check('去掉标记', cleanSubject('[DSH-Q:a1b2c3] 私有') === '私有', cleanSubject('[DSH-Q:a1b2c3] 私有'))
check('去掉 Re: 与标记', cleanSubject('Re: [DSH-Q:a1b2c3] 私有') === '私有', cleanSubject('Re: [DSH-Q:a1b2c3] 私有'))
check('叠两层 Re:', cleanSubject('Re: Re: [DSH-T:x9] 继续做') === '继续做', cleanSubject('Re: Re: [DSH-T:x9] 继续做'))
check('中文回复前缀', cleanSubject('回复: [DSH-Q:x] 公开') === '公开', cleanSubject('回复: [DSH-Q:x] 公开'))
check('展开折行', cleanSubject('[DSH-Q:x] 第一行\n 第二行') === '第一行 第二行', cleanSubject('[DSH-Q:x] 第一行\n 第二行'))
check('不误删用户方括号', cleanSubject('[DSH-Q:x] [重要] 私有') === '[重要] 私有', cleanSubject('[DSH-Q:x] [重要] 私有'))
check('只留 Re: 时结果为空', cleanSubject('Re: [DSH-Q:x]') === '', JSON.stringify(cleanSubject('Re: [DSH-Q:x]')))

console.log('\n[2] 单题：单字母=选选项')
{
  const a = parseReplyLines('A')
  check('A → 一个答案', a.length === 1, JSON.stringify(a))
  check('A → letters=A 无 custom', a[0].letters === 'A' && a[0].custom === '', JSON.stringify(a[0]))
}
{
  const a = parseReplyLines('b')
  check('小写 b → B', a[0].letters === 'B', JSON.stringify(a[0]))
}
{
  const a = parseReplyLines('(B)')
  check('(B) → B', a[0].letters === 'B', JSON.stringify(a[0]))
}
{
  const a = parseReplyLines('B.')
  check('B. → B', a[0].letters === 'B', JSON.stringify(a[0]))
}
{
  const a = parseReplyLines('Ａ')
  check('全角 Ａ → A', a[0].letters === 'A', JSON.stringify(a[0]))
}

console.log('\n[3] 单题：其它文字=自定义')
{
  const a = parseReplyLines('先别公开，等我确认')
  check('整句走 custom', a[0].custom === '先别公开，等我确认' && a[0].letters === '', JSON.stringify(a[0]))
}
{
  const a = parseReplyLines('用私有仓库吧')
  check('中文短语走 custom', a[0].custom === '用私有仓库吧', JSON.stringify(a[0]))
}
{
  const a = parseReplyLines('1. 先别公开')
  check('带题号的自定义文本', a[0].index === 1 && a[0].custom === '先别公开', JSON.stringify(a[0]))
}
{
  const a = parseReplyLines('AB')
  check('多字母不拆', a[0].letters === 'AB', JSON.stringify(a[0]))
}

console.log('\n[4] 多题')
{
  // 用户指定的标准选择题写法
  const a = parseReplyLines('1. A\n2. B')
  check('标准写法 1. A / 2. B：两题', a.length === 2, JSON.stringify(a))
  check('标准写法：题 1 选 A', a[0].index === 1 && a[0].letters === 'A', JSON.stringify(a[0]))
  check('标准写法：题 2 选 B', a[1].index === 2 && a[1].letters === 'B', JSON.stringify(a[1]))
}
{
  const a = parseReplyLines('1. A 2. B')
  check('标准写法一行两题', a.length === 2 && a[0].index === 1 && a[1].index === 2, JSON.stringify(a))
}
{
  const a = parseReplyLines('1. B')
  check('单题标准写法', a.length === 1 && a[0].index === 1 && a[0].letters === 'B', JSON.stringify(a))
}
{
  const a = parseReplyLines('1) A\n2、C\n3: A')
  check('各种分隔符都认', a.length === 3 && a[2].letters === 'A', JSON.stringify(a))
}
{
  const a = parseReplyLines('1A\n2B')
  check('紧凑写法仍可用（两行两题）', a.length === 2, JSON.stringify(a))
  check('紧凑写法：题 1 选 A', a[0].index === 1 && a[0].letters === 'A', JSON.stringify(a[0]))
  check('紧凑写法：题 2 选 B', a[1].index === 2 && a[1].letters === 'B', JSON.stringify(a[1]))
}
{
  const a = parseReplyLines('1A 2B')
  check('紧凑写法一行两题也能切', a.length === 2, JSON.stringify(a))
  check('紧凑写法：题号正确', a[0].index === 1 && a[1].index === 2, JSON.stringify(a))
}
{
  const a = parseReplyLines('1. 私有\n2. QQ')
  check('题号 + 自定义混合', a.length === 2 && a[0].custom === '私有' && a[1].custom === 'QQ', JSON.stringify(a))
}
{
  const a = parseReplyLines('A\nB')
  check('无题号按顺序', a[0].index === 1 && a[1].index === 2, JSON.stringify(a))
}
{
  const a = parseReplyLines('1. A\n2. 用 163 吧')
  check('一选一写', a[0].letters === 'A' && a[1].custom === '用 163 吧', JSON.stringify(a))
}
{
  const a = parseReplyLines('1.1')
  check('版本号不被当选项', a[0].letters === '' && a[0].custom === '1.1', JSON.stringify(a))
}
{
  // 真实摘要邮件的形状：装饰线与元信息行不该被当成答案
  const real = [
    '这一轮我把收信链路查清楚了，结论是 IMAP 本身没有问题。',
    '',
    '────────────',
    '会话：给 dsh 加邮件插件',
    '工作区：dsh',
    '回合：第 3 轮 · 用时 19 分 25 秒',
    '时间：2026-09-23 09:15:41',
  ].join('\n')
  const a = parseReplyLines(real)
  check('装饰线被跳过', !a.some((x) => x.custom.includes('────')), JSON.stringify(a.map((x) => x.custom)))
  check('正文首行保留为答案', a[0].custom.startsWith('这一轮我把收信链路'), JSON.stringify(a[0]))
  check('元信息行不丢（那是内容）', a.some((x) => x.custom.includes('会话：')), JSON.stringify(a.map((x) => x.custom)))
}
{
  const a = parseReplyLines('====\n1. A\n----')
  check('装饰线不占题号', a.length === 1 && a[0].index === 1 && a[0].letters === 'A', JSON.stringify(a))
}
{
  const a = parseReplyLines('1. A\n────────\n2. B')
  check('夹杂装饰线的两题', a.length === 2 && a[0].letters === 'A' && a[1].letters === 'B', JSON.stringify(a))
}

console.log('\n[5] 答案对到问题')
{
  const r = matchAnswers(parseReplyLines('1B\n2C'), twoQuestions)
  check('两道题都对上', r.matched === 2, JSON.stringify(r.items))
  check('题 1 → 私有', r.items[0].id === 'q1' && r.items[0].selected[0] === '私有', JSON.stringify(r.items[0]))
  check('题 2 → Gmail', r.items[1].id === 'q2' && r.items[1].selected[0] === 'Gmail', JSON.stringify(r.items[1]))
}
{
  const r = matchAnswers(parseReplyLines('A'), twoQuestions)
  check('只答一题时另一题留空', r.matched === 1, JSON.stringify(r.items))
  check('答案落在第一题', r.items[0].id === 'q1' && r.items[0].selected[0] === '公开', JSON.stringify(r.items[0]))
}
{
  const r = matchAnswers(parseReplyLines('2B'), twoQuestions)
  check('按题号能跳过第一题', r.items[0].id === 'q2', JSON.stringify(r.items))
}
{
  const r = matchAnswers(parseReplyLines('1 只要私有'), twoQuestions)
  check('自定义填进 custom', r.items[0].custom === '只要私有' && r.items[0].selected.length === 0, JSON.stringify(r.items[0]))
}
{
  // 字母超出选项范围 → 当自定义，不静默丢弃
  const r = matchAnswers(parseReplyLines('1Z'), twoQuestions)
  check('超范围字母退回 custom', r.items[0].custom === 'Z', JSON.stringify(r.items[0]))
}
{
  // 多出来的题号 → 变 leftover（能当新消息续接对话）
  const r = matchAnswers(parseReplyLines('1A\n2B\n3 顺便把文档也更新一下'), twoQuestions)
  check('多出的题号进 leftover', r.leftover === '顺便把文档也更新一下', JSON.stringify(r.leftover))
}

console.log('\n[6] 整封邮件解析（正文优先）')
{
  const r = parseMailReply({ subject: 'Re: [DSH-Q:abc123]', text: '1B\n2A' })
  check('从正文取到答案', r.source === 'body' && r.answers.length === 2, JSON.stringify(r))
}
{
  const r = parseMailReply({ subject: 'Re: [DSH-Q:abc123] 1B 2A', text: '1A\n2B' })
  check('正文优先于主题', r.source === 'body' && r.answers[0].letters === 'A', JSON.stringify(r))
}
{
  const r = parseMailReply({ subject: 'Re: [DSH-Q:abc123] 1A', text: '' })
  check('正文空时退回主题', r.source === 'subject' && r.answers[0].letters === 'A', JSON.stringify(r))
}
{
  const r = parseMailReply({ subject: '[DSH-Q:abc123]', text: '' })
  check('都没内容时 source=none', r.source === 'none', JSON.stringify(r))
}
{
  const r = parseMailReply({ subject: 'Re: [DSH-T:xyz]', text: '继续，把设置页也加上' })
  check('长文本写在正文里', r.source === 'body' && r.answers[0].custom === '继续，把设置页也加上', JSON.stringify(r))
}
{
  const r = parseMailReply({ subject: 'Re: [DSH-T:xyz]', text: '引用内容不该被采纳\n> 原文\n> 更多' })
  check('正文里的引用行被剥掉', r.cleaned === '引用内容不该被采纳', JSON.stringify(r.cleaned))
}
{
  const r = parseMailReply({ subject: 'Re: [DSH-Q:abc123]', text: '\n\n  \n' })
  check('正文只有空白不算内容', r.source === 'none', JSON.stringify(r))
}

console.log('\n[7] 线程标记')
{
  const marker = threadMarker('q', 'abc123')
  check('标记是纯 ASCII', /^[\x20-\x7E]+$/.test(marker), marker)
  check('标记形状正确', marker === '[DSH-Q:abc123]', marker)
  check('标记能被 cleanSubject 去掉', cleanSubject(`Re: ${marker} 私有`) === '私有', cleanSubject(`Re: ${marker} 私有`))
}
{
  const a = newThreadToken()
  const b = newThreadToken()
  check('token 长度 12', a.length === 12, a)
  check('token 是纯小写字母数字', /^[a-z0-9]{12}$/.test(a), a)
  check('两次生成不重复', a !== b, `${a} / ${b}`)
  const many = new Set(Array.from({ length: 200 }, () => newThreadToken()))
  check('200 次生成无碰撞', many.size === 200, `${many.size}/200`)
}

console.log('\n[8] 防误判：只认我们真的发出去过的 token')
for (const [label, subject, expected] of [
  ['标准标记', 'Re: [DSH-T:k3f9a2x8m1qp] 会话名', { kind: 'T', token: 'k3f9a2x8m1qp' }],
  ['提问标记', '[DSH-Q:abc123def456] 需要你回答', { kind: 'Q', token: 'abc123def456' }],
  ['主题被改过', '随便什么标题 [DSH-T:zz9988776655] 尾巴', { kind: 'T', token: 'zz9988776655' }],
  ['只有词头', '这是 [DSH- 但不是完整标记', null],
  ['伪造的短 token', '[DSH-T:abc] 太短不算', null],
  ['大写 token 归一化', '[DSH-T:ABC123DEF456]', { kind: 'T', token: 'abc123def456' }],
  ['无关邮件', '会议纪要 2026-09-23', null],
  ['带 DSH 字样但不是标记', '[DSH] 某个插件的通知', null],
  ['标记在正文不算', '主题里没有标记', null],
]) {
  const got = threadFromSubject(subject)
  const ok = expected === null
    ? got === null
    : got && got.kind === expected.kind && got.token === expected.token
  check(`主题识别：${label}`, ok, JSON.stringify(got))
}

console.log('\n[9] 发件人白名单匹配')
for (const [label, from, expected] of [
  ['纯地址', 'me@qq.com', 'me@qq.com'],
  ['带显示名', '张三 <me@qq.com>', 'me@qq.com'],
  ['大小写归一', 'ME@QQ.COM', 'me@qq.com'],
  ['带引号显示名', '"Zhang, San" <me@qq.com>', 'me@qq.com'],
  ['陌生地址', 'spam@evil.com', 'spam@evil.com'],
]) {
  check(`解析发件人：${label}`, senderAddressOf(from) === expected, senderAddressOf(from))
}

console.log(`\n${failures === 0 ? '全部通过' : '有失败项'}：${checks - failures}/${checks}\n`)
process.exit(failures === 0 ? 0 : 1)
