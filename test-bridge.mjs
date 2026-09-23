/**
 * 收信判定整合测试（离线，不联网）：
 *   node test-bridge.mjs
 *
 * 把假邮件喂给 replyBridge.pollOnce，验证三道闸与两种通道的行为。
 * 这段逻辑决定「它会不会误读你的邮件」，也决定「你的回信能不能被认出来」，
 * 必须被测试守住，而不是靠拿真邮箱手工试。
 */
import { createReplyBridge, threadFromSubject } from './qa.mjs'
import { parseListLine, pickMailboxes } from './imap.mjs'
import { newThreadToken, threadMarker } from './reply.mjs'

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

const ME = 'me@qq.com'
const STRANGER = 'spam@evil.com'
const OUR_MID = '<our-message-id@qq.com>'

const baseConfig = {
  enabled: true,
  provider: 'qq',
  smtp: { host: 'smtp.qq.com', port: 465, socket: null, user: ME, pass: 'authcode' },
  imap: { host: 'imap.qq.com', port: 993, secure: true, user: '', pass: '', mailbox: 'INBOX' },
  reply: { enabled: true, askViaEmail: true, continueViaEmail: true, unseenOnly: true },
  to: [ME],
}

/** 造一封邮件（形状与 imap.fetchReplies 的返回一致）。 */
function mail({ uid, subject, from = ME, text = '继续吧', references = OUR_MID }) {
  return { uid: String(uid), subject, from, text, references, inReplyTo: '', html: false }
}

/** 建一个 bridge，收信实现由测试喂数据。 */
function makeBridge(mails, { config = baseConfig, logSink = [], onFetch } = {}) {
  const log = (level, message) => { logSink.push(`${level}: ${message}`) }
  const bridge = createReplyBridge({
    getConfig: () => config,
    log,
    allowedSenders: () => config.to,
    fetchRepliesImpl: async () => {
      if (typeof onFetch === 'function') onFetch()
      return mails
    },
  })
  return { bridge, logSink }
}

const T_TOKEN = 't1aaaaaaaaaa'
const Q_TOKEN = 'q1bbbbbbbbbb'
const T_MARKER = `[DSH-T:${T_TOKEN}]`
const Q_MARKER = `[DSH-Q:${Q_TOKEN}]`

console.log('\n[1] 对话通道：能认出我们发过的标记')
{
  const delivered = []
  const { bridge } = makeBridge([mail({ uid: 1, subject: `Re: [DSH] ✅ 会话 ${T_MARKER}` })])
  bridge.register({ token: T_TOKEN, marker: T_MARKER, sessionId: 's1', kind: 'T' })
  bridge.noteSent(T_TOKEN, OUR_MID)
  await bridge.pollOnce({ onConversationReply: (payload) => delivered.push(payload) })
  check('回信被投递到会话', delivered.length === 1, JSON.stringify(delivered))
  check('投递到正确的会话', delivered[0]?.sessionId === 's1', delivered[0]?.sessionId)
  check('正文被当作消息内容', delivered[0]?.text === '继续吧', JSON.stringify(delivered[0]?.text))
  bridge.dispose()
}

console.log('\n[2] 闸①：没有标记 / 标记不是我们的 → 丢弃')
{
  const delivered = []
  const logSink = []
  const { bridge } = makeBridge([
    mail({ uid: 2, subject: 'Re: [DSH] ✅ 会话' }),                      // 没有线程标记
    mail({ uid: 3, subject: 'Re: [DSH-T:zz9999999999] 伪造', from: ME }), // token 不是我们的
    mail({ uid: 4, subject: '随便一封普通邮件' }),
  ], { logSink })
  bridge.register({ token: T_TOKEN, marker: T_MARKER, sessionId: 's1', kind: 'T' })
  bridge.noteSent(T_TOKEN, OUR_MID)
  await bridge.pollOnce({ onConversationReply: (payload) => delivered.push(payload) })
  check('三封都被丢弃', delivered.length === 0, JSON.stringify(delivered))
  check('日志说明了原因', logSink.some((line) => line.includes('不是我们发出的') || line.includes('没有合法线程标记')), JSON.stringify(logSink.slice(0, 3)))
  bridge.dispose()
}

console.log('\n[3] 闸②：发件人不在白名单 → 丢弃')
{
  const delivered = []
  const logSink = []
  const { bridge } = makeBridge([
    mail({ uid: 5, subject: `Re: ${T_MARKER}`, from: STRANGER }),
  ], { logSink })
  bridge.register({ token: T_TOKEN, marker: T_MARKER, sessionId: 's1', kind: 'T' })
  bridge.noteSent(T_TOKEN, OUR_MID)
  await bridge.pollOnce({ onConversationReply: (payload) => delivered.push(payload) })
  check('陌生发件人被丢弃', delivered.length === 0, JSON.stringify(delivered))
  check('日志说明了发件人不允许', logSink.some((line) => line.includes('不在允许列表')), JSON.stringify(logSink))
  bridge.dispose()
}

console.log('\n[4] 闸③：References 对不上 → 丢弃；对不上但没有 References → 放行（宽容）')
{
  const delivered = []
  const logSink = []
  const { bridge } = makeBridge([
    mail({ uid: 6, subject: `Re: ${T_MARKER}`, references: '<someone-else@x.com>' }),
  ], { logSink })
  bridge.register({ token: T_TOKEN, marker: T_MARKER, sessionId: 's1', kind: 'T' })
  bridge.noteSent(T_TOKEN, OUR_MID)
  await bridge.pollOnce({ onConversationReply: (payload) => delivered.push(payload) })
  check('References 对不上的被丢弃', delivered.length === 0, JSON.stringify(delivered))
  check('日志说明不是在回复我们', logSink.some((line) => line.includes('不是在回复我们')), JSON.stringify(logSink))
  bridge.dispose()
}
{
  const delivered = []
  const logSink = []
  const { bridge } = makeBridge([
    mail({ uid: 7, subject: `Re: ${T_MARKER}`, references: '' }),
  ], { logSink })
  bridge.register({ token: T_TOKEN, marker: T_MARKER, sessionId: 's1', kind: 'T' })
  bridge.noteSent(T_TOKEN, OUR_MID)
  await bridge.pollOnce({ onConversationReply: (payload) => delivered.push(payload) })
  check('没有 References 时按标记放行', delivered.length === 1, JSON.stringify(delivered))
  check('日志说明了放行原因', logSink.some((line) => line.includes('没带 References')), JSON.stringify(logSink))
  bridge.dispose()
}

console.log('\n[5] 提问通道：回信变成答案')
{
  const questions = [
    { id: 'q1', question: '仓库公开还是私有？', options: [{ label: '公开' }, { label: '私有' }] },
    { id: 'q2', question: '用什么邮箱？', options: [{ label: 'QQ' }, { label: '163' }] },
  ]
  let answered = null
  const { bridge } = makeBridge([
    mail({ uid: 8, subject: `Re: ${Q_MARKER}`, text: '1. B\n2. A' }),
  ])
  bridge.register({
    token: Q_TOKEN,
    marker: Q_MARKER,
    sessionId: 's2',
    kind: 'Q',
    questions,
    resolve: (payload) => { answered = payload },
  })
  bridge.noteSent(Q_TOKEN, OUR_MID)
  await bridge.pollOnce({})
  check('答案被交回', answered !== null, JSON.stringify(answered))
  check('题 1 选中「私有」', answered?.items?.[0]?.selected?.[0] === '私有', JSON.stringify(answered?.items?.[0]))
  check('题 2 选中「QQ」', answered?.items?.[1]?.selected?.[0] === 'QQ', JSON.stringify(answered?.items?.[1]))
  bridge.dispose()
}
{
  // 已被界面作答的提问：entry 被撤销，回信应被忽略，且撤销必须是 cancelled 而不是空答案
  let outcome = null
  let fetches = 0
  const { bridge } = makeBridge(
    [mail({ uid: 9, subject: `Re: ${Q_MARKER}`, text: '1. A' })],
    { onFetch: () => { fetches += 1 } },
  )
  bridge.register({
    token: Q_TOKEN,
    marker: Q_MARKER,
    sessionId: 's2',
    kind: 'Q',
    questions: [{ id: 'q1', question: 'x', options: [{ label: '公开' }] }],
    resolve: (payload) => { outcome = payload },
  })
  bridge.noteSent(Q_TOKEN, OUR_MID)
  bridge.finish(Q_TOKEN)          // 模拟界面先答了
  check('撤销带 cancelled 标记（不是空答案）', outcome?.cancelled === true, JSON.stringify(outcome))
  check('撤销时不带任何答案项', Array.isArray(outcome?.items) && outcome.items.length === 0, JSON.stringify(outcome))
  check('finish 之后线程被撤销（标记不再已知）', !bridge.knownMarkers().includes(Q_MARKER),
    JSON.stringify(bridge.knownMarkers()))
  outcome = null
  await bridge.pollOnce({})
  check('撤销后回信不再触发 resolve', outcome === null, JSON.stringify(outcome))
  check('没有已知线程时根本不去收信', fetches === 0, `fetch 调用了 ${fetches} 次`)
  bridge.dispose()
}

console.log('\n[6] 同一封邮件不会被重复采纳')
{
  const delivered = []
  const { bridge } = makeBridge([mail({ uid: 10, subject: `Re: ${T_MARKER}` })])
  bridge.register({ token: T_TOKEN, marker: T_MARKER, sessionId: 's1', kind: 'T' })
  bridge.noteSent(T_TOKEN, OUR_MID)
  await bridge.pollOnce({ onConversationReply: (payload) => delivered.push(payload) })
  await bridge.pollOnce({ onConversationReply: (payload) => delivered.push(payload) })
  check('轮询两次只投递一次', delivered.length === 1, delivered.length)
  bridge.dispose()
}

console.log('\n[7] 关闭通道 / 没配好时不动作')
{
  const delivered = []
  const off = { ...baseConfig, reply: { ...baseConfig.reply, enabled: false } }
  const { bridge } = makeBridge([mail({ uid: 11, subject: `Re: ${T_MARKER}` })], { config: off })
  bridge.register({ token: T_TOKEN, marker: T_MARKER, sessionId: 's1', kind: 'T' })
  await bridge.pollOnce({ onConversationReply: (payload) => delivered.push(payload) })
  check('回信通道关闭时不收信', delivered.length === 0)
  bridge.dispose()
}
{
  const delivered = []
  const noImap = {
    ...baseConfig,
    smtp: { ...baseConfig.smtp, user: '', pass: '' },
    imap: { ...baseConfig.imap, user: '', pass: '' },
  }
  const { bridge } = makeBridge([mail({ uid: 12, subject: `Re: ${T_MARKER}` })], { config: noImap })
  bridge.register({ token: T_TOKEN, marker: T_MARKER, sessionId: 's1', kind: 'T' })
  await bridge.pollOnce({ onConversationReply: (payload) => delivered.push(payload) })
  check('没账号时不收信', delivered.length === 0)
  bridge.dispose()
}
{
  const delivered = []
  const { bridge } = makeBridge([mail({ uid: 13, subject: `Re: ${T_MARKER}` })])
  // 没有注册任何线程 → 不该去搜，也不该投递
  await bridge.pollOnce({ onConversationReply: (payload) => delivered.push(payload) })
  check('没有已知线程时不收信', delivered.length === 0)
  bridge.dispose()
}

console.log('\n[8] 每封邮件的标记都不同（可区分是哪一轮）')
{
  const first = 'aaaaaaaaaaaa'
  const second = 'bbbbbbbbbbbb'
  const delivered = []
  const logSink = []
  // 每封邮件带着**它自己那封**的 References —— 模拟真实客户端行为
  const { bridge } = makeBridge([
    mail({ uid: 14, subject: `Re: [DSH-T:${first}] 第一轮`, references: '<m1@qq.com>' }),
    mail({ uid: 15, subject: `Re: [DSH-T:${second}] 第二轮`, references: '<m2@qq.com>' }),
  ], { logSink })
  bridge.register({ token: first, marker: `[DSH-T:${first}]`, sessionId: 's1', kind: 'T' })
  bridge.register({ token: second, marker: `[DSH-T:${second}]`, sessionId: 's2', kind: 'T' })
  bridge.noteSent(first, '<m1@qq.com>')
  bridge.noteSent(second, '<m2@qq.com>')
  await bridge.pollOnce({ onConversationReply: (payload) => delivered.push(payload) })
  check('两封都投递', delivered.length === 2, JSON.stringify(delivered))
  check('分别落回各自的会话', delivered.map((d) => d.sessionId).sort().join(',') === 's1,s2',
    JSON.stringify(delivered.map((d) => d.sessionId)))
  check('各自的内容没串', delivered.find((d) => d.sessionId === 's1')?.text === '继续吧',
    JSON.stringify(delivered.map((d) => [d.sessionId, d.text])))
  bridge.dispose()
}
{
  // 交叉引用：第二轮的回信带着第一轮的 References → 按 entry 的 messageId 应被丢弃
  const first = 'cccccccccccc'
  const second = 'dddddddddddd'
  const delivered = []
  const logSink = []
  const { bridge } = makeBridge([
    mail({ uid: 16, subject: `Re: [DSH-T:${second}]`, references: '<m1@qq.com>' }),
  ], { logSink })
  bridge.register({ token: first, marker: `[DSH-T:${first}]`, sessionId: 's1', kind: 'T' })
  bridge.register({ token: second, marker: `[DSH-T:${second}]`, sessionId: 's2', kind: 'T' })
  bridge.noteSent(first, '<m1@qq.com>')
  bridge.noteSent(second, '<m2@qq.com>')
  await bridge.pollOnce({ onConversationReply: (payload) => delivered.push(payload) })
  check('References 对不上该线程时被丢弃', delivered.length === 0, JSON.stringify(delivered))
  check('日志说明不是在回复我们', logSink.some((line) => line.includes('不是在回复我们')), JSON.stringify(logSink))
  bridge.dispose()
}

console.log('\n[9] 文件夹挑选（163 的「已发送」必须被搜到）')
{
  // 真实 163 的文件夹列表
  const boxes163 = ['INBOX', '草稿箱', '已发送', '已删除', '垃圾邮件', '病毒文件夹', '广告邮件', '订阅邮件']
  const picked = pickMailboxes(boxes163)
  check('163：INBOX 在列表里', picked.includes('INBOX'), JSON.stringify(picked))
  check('163：已发送 被选中', picked.includes('已发送'), JSON.stringify(picked))
  check('163：垃圾邮件不被搜', !picked.includes('垃圾邮件'), JSON.stringify(picked))
  check('163：只挑两个', picked.length === 2, JSON.stringify(picked))
}
{
  const gmail = ['INBOX', 'Sent', 'Drafts', 'Trash', '[Gmail]/All Mail']
  const picked = pickMailboxes(gmail)
  check('英文 Sent 也被选中', picked.includes('Sent'), JSON.stringify(picked))
}
{
  check('空列表退回 INBOX', JSON.stringify(pickMailboxes([])) === '["INBOX"]')
  check('没有 INBOX 时取第一个', pickMailboxes(['Mail', 'Sent'])[0] === 'Mail', JSON.stringify(pickMailboxes(['Mail', 'Sent'])))
}

console.log('\n[10] 解析 IMAP LIST 应答')
{
  check('带引号的普通名', parseListLine('* LIST (\\HasNoChildren) "/" "INBOX"') === 'INBOX',
    parseListLine('* LIST (\\HasNoChildren) "/" "INBOX"'))
  check('带引号的带空格名', parseListLine('* LIST (\\HasNoChildren) "/" "Sent Items"') === 'Sent Items',
    parseListLine('* LIST (\\HasNoChildren) "/" "Sent Items"'))
  check('裸名（无引号）', parseListLine('* LIST (\\HasNoChildren) "/" INBOX') === 'INBOX',
    parseListLine('* LIST (\\HasNoChildren) "/" INBOX'))
  check('带字面量尾标', parseListLine('* LIST () "/" "已发送" {0}') === '已发送',
    parseListLine('* LIST () "/" "已发送" {0}'))
  check('非 LIST 行返回 null', parseListLine('* 4 EXISTS') === null)
  check('NIL 分隔符也能认', parseListLine('* LIST (\\HasNoChildren) NIL "INBOX"') === 'INBOX',
    parseListLine('* LIST (\\HasNoChildren) NIL "INBOX"'))
}

console.log('\n[11] 主题标记的容错（真实事故：QQ 在标记里插空格）')
{
  // 实测：QQ 回复长主题时会插入折行空格，
  // `[DSH-Q:e2jdvd7izt50]` 变成 `[D SH-Q:e2jdvd7izt50]`
  const mangled = threadFromSubject('回复：[DSH] ❓ 需要你回答 [D SH-Q:e2jdvd7izt50]')
  check('带空格的标记能认出来', mangled?.token === 'e2jdvd7izt50', JSON.stringify(mangled))
  check('类型正确', mangled?.kind === 'Q', JSON.stringify(mangled))

  const moreSpace = threadFromSubject('Re: 主题 [ D S H - Q : abcdef123456 ]')
  check('多空格 + 冒号周围空格也能认', moreSpace?.token === 'abcdef123456', JSON.stringify(moreSpace))

  const tabbed = threadFromSubject('Re: [DSH-\tT:aaaabbbbcccc] x')
  check('制表符也能认', tabbed?.token === 'aaaabbbbcccc', JSON.stringify(tabbed))

  // 容忍空格不能变成「什么都认」——token 仍必须是合法形状
  check('短 token 仍被拒', threadFromSubject('[D SH-Q:abc] x') === null,
    JSON.stringify(threadFromSubject('[D SH-Q:abc] x')))
  check('无关方括号仍被拒', threadFromSubject('看这个 [重要] 文档') === null,
    JSON.stringify(threadFromSubject('看这个 [重要] 文档')))
  check('缺冒号仍被拒', threadFromSubject('[DSH-Q abcdef123456] x') === null,
    JSON.stringify(threadFromSubject('[DSH-Q abcdef123456] x')))
}
{
  // 端到端：被改坏标记的回信仍能投回会话
  const token = 'e2jdvd7izt50'
  const delivered = []
  const logSink = []
  const { bridge } = makeBridge([
    mail({ uid: 20, subject: `回复：[DSH] ❓ 需要你回答 [D SH-Q:${token}]`, text: 'B' }),
  ], { logSink })
  bridge.register({ token, marker: `[DSH-Q:${token}]`, sessionId: 's1', kind: 'T' })
  bridge.noteSent(token, OUR_MID)
  await bridge.pollOnce({ onConversationReply: (payload) => delivered.push(payload) })
  check('标记被插空格后回信仍能投递', delivered.length === 1, JSON.stringify(delivered))
  check('正文取到 B', delivered[0]?.text === 'B', JSON.stringify(delivered[0]?.text))
  bridge.dispose()
}

console.log('\n[13] 审批通道：邮件批准 / 拒绝 / 不可识别')
{
  // 允许
  const token = newThreadToken()
  const marker = threadMarker('A', token)
  let outcome = null
  const { bridge } = makeBridge([
    mail({ uid: 30, subject: `Re: [DSH] 🔐 需要你授权 pwsh ${marker}`, text: '1' }),
  ])
  bridge.register({ token, marker, sessionId: 's1', kind: 'A', resolve: (r) => { outcome = r } })
  bridge.armApprovalTimeout(token)
  bridge.noteSent(token, OUR_MID)
  await bridge.pollOnce({})
  check('回信 1 → allow', outcome?.decision === 'allow', JSON.stringify(outcome))
  bridge.dispose()
}
{
  // 拒绝
  const token = newThreadToken()
  const marker = threadMarker('A', token)
  let outcome = null
  const { bridge } = makeBridge([
    mail({ uid: 31, subject: `Re: [DSH] 🔐 ${marker}`, text: '2' }),
  ])
  bridge.register({ token, marker, sessionId: 's1', kind: 'A', resolve: (r) => { outcome = r } })
  bridge.armApprovalTimeout(token)
  bridge.noteSent(token, OUR_MID)
  await bridge.pollOnce({})
  check('回信 2 → reject', outcome?.decision === 'reject', JSON.stringify(outcome))
  bridge.dispose()
}
{
  // 认不出 → fail closed（按拒绝）
  const token = newThreadToken()
  const marker = threadMarker('A', token)
  let outcome = null
  const logSink = []
  const { bridge } = makeBridge([
    mail({ uid: 32, subject: `Re: [DSH] 🔐 ${marker}`, text: '让我想想' }),
  ], { logSink })
  bridge.register({ token, marker, sessionId: 's1', kind: 'A', resolve: (r) => { outcome = r } })
  bridge.armApprovalTimeout(token)
  bridge.noteSent(token, OUR_MID)
  await bridge.pollOnce({})
  check('认不出表态 → 按拒绝（fail closed）', outcome?.decision === 'reject', JSON.stringify(outcome))
  check('日志说明了原因', logSink.some((l) => l.includes('看不懂')), JSON.stringify(logSink.slice(0, 3)))
  bridge.dispose()
}
{
  // 标记被插空格 + 中文表态
  const token = newThreadToken()
  const marker = threadMarker('A', token)
  const mangled = marker.replace(':', ' :').replace(/^\[/, '[ ')
  let outcome = null
  const { bridge } = makeBridge([
    mail({ uid: 33, subject: `回复：[DSH] 🔐 ${mangled}`, text: '允许这一次' }),
  ])
  bridge.register({ token, marker, sessionId: 's1', kind: 'A', resolve: (r) => { outcome = r } })
  bridge.armApprovalTimeout(token)
  bridge.noteSent(token, OUR_MID)
  await bridge.pollOnce({})
  check('标记被改坏 + 中文表态 → allow', outcome?.decision === 'allow', JSON.stringify({ mangled, outcome }))
  bridge.dispose()
}
{
  // 界面先到：撤销邮件通道后，回信不再改结论
  const token = newThreadToken()
  const marker = threadMarker('A', token)
  let outcome = null
  const { bridge } = makeBridge([
    mail({ uid: 34, subject: `Re: [DSH] 🔐 ${marker}`, text: '1' }),
  ])
  bridge.register({ token, marker, sessionId: 's1', kind: 'A', resolve: (r) => { outcome = r } })
  bridge.noteSent(token, OUR_MID)
  bridge.finish(token)          // 模拟界面先处理了
  outcome = null
  await bridge.pollOnce({})
  check('界面先到后，邮件回信不再触发 resolve', outcome === null, JSON.stringify(outcome))
  check('该线程已从已知标记里移除', !bridge.knownMarkers().includes(marker), JSON.stringify(bridge.knownMarkers()))
  bridge.dispose()
}
{
  // 审批与提问/对话三种线程共存，互不串台
  const aTok = newThreadToken()
  const qTok = newThreadToken()
  const aMark = threadMarker('A', aTok)
  const qMark = threadMarker('Q', qTok)
  let aOut = null
  let qOut = null
  const { bridge } = makeBridge([
    mail({ uid: 35, subject: `Re: ${aMark}`, text: '2' }),
    mail({ uid: 36, subject: `Re: ${qMark}`, text: '1. A' }),
  ])
  bridge.register({ token: aTok, marker: aMark, sessionId: 's1', kind: 'A', resolve: (r) => { aOut = r } })
  bridge.register({
    token: qTok, marker: qMark, sessionId: 's1', kind: 'Q',
    questions: [{ id: 'q1', question: 'x', options: [{ label: '公开' }] }],
    resolve: (r) => { qOut = r },
  })
  bridge.noteSent(aTok, OUR_MID)
  bridge.noteSent(qTok, OUR_MID)
  bridge.armApprovalTimeout(aTok)
  bridge.armTimeout(qTok)
  await bridge.pollOnce({})
  check('审批得到 reject', aOut?.decision === 'reject', JSON.stringify(aOut))
  check('提问得到答案（不被审批格式影响）', qOut?.items?.[0]?.selected?.[0] === '公开', JSON.stringify(qOut))
  bridge.dispose()
}

console.log(`\n${failures === 0 ? '全部通过' : '有失败项'}：${checks - failures}/${checks}\n`)
process.exit(failures === 0 ? 0 : 1)