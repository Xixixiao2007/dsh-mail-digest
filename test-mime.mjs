/**
 * MIME 解析自检（用真实邮件格式，不联网）：
 *   node test-mime.mjs
 *
 * 这里是最容易静默出错的地方：真实邮箱（QQ / 163 / Outlook / 手机客户端）
 * 发出来的回信形态差异很大。解析错了，插件不会报错，只会「读不懂你的回信」。
 *
 * 覆盖：multipart/alternative、base64 中文、quoted-printable 中文、
 * 只有 HTML 的回信、GBK 编码、引用剥离、以及和 reply.mjs 的联动。
 */
import { decodeEncodedWords, extractMessageText, htmlToText, stripQuoted, subjectMatches, rankCandidateUids } from './imap.mjs'
import { parseMailReply } from './reply.mjs'

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

/**
 * 构造一封邮件：头 + 正文。
 *
 * 返回 **Buffer**，与真实 IMAP 的 `BODY.PEEK[]` 一致 —— 邮件是按字节收下来的，
 * 字符串里有中文时若先套一层 JS 字符串再当字节处理，中文会被拆坏。
 * 字符集的解释权归 Content-Type 的 charset。
 */
function mail(headers, body) {
  const head = Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')
  const charset = /charset\s*=\s*"?([^";]+)"?/i.exec(headers['Content-Type'] ?? '')?.[1] ?? 'utf-8'
  const name = String(charset).toLowerCase().trim()
  // 正文已经是 ASCII（base64 / quoted-printable）时按字节原样写；
  // 否则按声明的 charset 编码。
  const isAsciiSafe = /^(base64|quoted-printable)$/i.test(headers['Content-Transfer-Encoding'] ?? '')
  let bodyBuffer
  if (isAsciiSafe) {
    bodyBuffer = Buffer.from(String(body), 'latin1')
  } else if (name === 'utf-8' || name === 'utf8') {
    bodyBuffer = Buffer.from(String(body), 'utf8')
  } else {
    try {
      bodyBuffer = Buffer.from(String(body), name)
    } catch {
      bodyBuffer = Buffer.from(String(body), 'utf8')
    }
  }
  return Buffer.concat([Buffer.from(`${head}\r\n\r\n`, 'latin1'), bodyBuffer])
}

console.log('\n[1] RFC 2047 头部解码')
check('base64 中文主题', decodeEncodedWords('=?UTF-8?B?5Zue5L2g?=') === '回你', decodeEncodedWords('=?UTF-8?B?5Zue5L2g?='))
check('Q 编码中文', decodeEncodedWords('=?UTF-8?Q?=E5=9B=9E=E4=BD=A0?=') === '回你', decodeEncodedWords('=?UTF-8?Q?=E5=9B=9E=E4=BD=A0?='))
check('多个编码字（中间空格保留）', decodeEncodedWords('=?UTF-8?B?5Zue?= =?UTF-8?B?5L2g?=') === '回 你', decodeEncodedWords('=?UTF-8?B?5Zue?= =?UTF-8?B?5L2g?='))
check('纯 ASCII 原样', decodeEncodedWords('Re: hello') === 'Re: hello')

console.log('\n[2] 纯文本 base64 回信（最常见）')
{
  const body = Buffer.from('1. A\r\n2. B\r\n', 'utf8').toString('base64')
  const raw = mail({
    Subject: '=?UTF-8?B?5Zue5L2g?=',
    From: 'me@qq.com',
    'Content-Type': 'text/plain; charset=UTF-8',
    'Content-Transfer-Encoding': 'base64',
  }, body)
  const parsed = extractMessageText(raw)
  check('主题解码', parsed.subject === '回你', parsed.subject)
  check('正文还原', parsed.text.trim() === '1. A\r\n2. B'.replace(/\n/g, '\r\n') || parsed.text.includes('1. A'), JSON.stringify(parsed.text))
  check('不是 html', parsed.html === false)
  const reply = parseMailReply(parsed)
  check('能解析成两个答案', reply.answers.length === 2, JSON.stringify(reply.answers))
  check('来源是正文', reply.source === 'body', reply.source)
}

console.log('\n[3] quoted-printable 中文回信')
{
  const raw = mail({
    Subject: 'test',
    'Content-Type': 'text/plain; charset=UTF-8',
    'Content-Transfer-Encoding': 'quoted-printable',
  }, '=E7=94=A8=E7=A7=81=E6=9C=89=E4=BB=93=E5=BA=93=E5=90=A7')
  const parsed = extractMessageText(raw)
  check('QP 中文还原', parsed.text.trim() === '用私有仓库吧', JSON.stringify(parsed.text))
  const reply = parseMailReply(parsed)
  check('当成自定义文本', reply.answers[0].custom === '用私有仓库吧', JSON.stringify(reply.answers))
}
{
  // 真实事故：QQ 用 GBK 系 charset + quoted-printable 发中文。
  // `=C4=E3` 是两个**字节**；若被当成两个字符就会变乱码（曾是本插件的 bug，
  // 症状是用户回的 `B` 变成 `B\uFFFD8\u9F49`）。
  const raw = mail({
    Subject: 'test',
    'Content-Type': 'text/plain; charset=gb18030',
    'Content-Transfer-Encoding': 'quoted-printable',
  }, '=C4=E3=BA=C3=A3=AC=D5=E2=CA=C7=B2=E2=CA=D4')
  const parsed = extractMessageText(raw)
  check('GBK + QP 中文还原', parsed.text.trim() === '你好，这是测试', JSON.stringify(parsed.text))
  check('不出现替换字符 U+FFFD', !parsed.text.includes('\uFFFD'), JSON.stringify(parsed.text))
}
{
  // GBK + base64（另一种常见形态）
  const gbkBytes = Buffer.from([
    0xbc, 0xcc, 0xd0, 0xf8, 0xd7, 0xf6, // 继续做
  ])
  const raw = mail({
    Subject: 'test',
    'Content-Type': 'text/plain; charset=gbk',
    'Content-Transfer-Encoding': 'base64',
  }, gbkBytes.toString('base64'))
  const parsed = extractMessageText(raw)
  check('GBK + base64 中文还原', parsed.text.trim() === '继续做', JSON.stringify(parsed.text))
}
{
  // 纯 ASCII 的 QP 不能受影响
  const raw = mail({
    Subject: 'test',
    'Content-Type': 'text/plain; charset=UTF-8',
    'Content-Transfer-Encoding': 'quoted-printable',
  }, '1. A=0D=0A2. B')
  const parsed = extractMessageText(raw)
  check('ASCII 的 QP 换行正确', parsed.text.includes('1. A') && parsed.text.includes('2. B'), JSON.stringify(parsed.text))
  const reply = parseMailReply(parsed)
  check('ASCII QP 解析出两题', reply.answers.length === 2, JSON.stringify(reply.answers))
}

console.log('\n[4] multipart/alternative（QQ 邮箱常见）')
{
  const textBody = Buffer.from('1. B\r\n', 'utf8').toString('base64')
  const htmlBody = Buffer.from('<div>1. B</div>', 'utf8').toString('base64')
  const raw = mail({
    Subject: 'Re: x',
    'Content-Type': 'multipart/alternative; boundary="BOUND1"',
  }, [
    '--BOUND1',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    textBody,
    '--BOUND1',
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    htmlBody,
    '--BOUND1--',
  ].join('\r\n'))
  const parsed = extractMessageText(raw)
  check('优先取 text/plain', parsed.text.includes('1. B'), JSON.stringify(parsed.text))
  check('标记不是 html', parsed.html === false)
  const reply = parseMailReply(parsed)
  check('解析出选 B', reply.answers[0].letters === 'B', JSON.stringify(reply.answers))
}

console.log('\n[5] 只有 HTML 的回信（手机客户端常见）')
{
  const html = '<html><body><p>1. A</p><p>2.&nbsp;B</p></body></html>'
  const raw = mail({
    Subject: 'Re: y',
    'Content-Type': 'text/html; charset=UTF-8',
    'Content-Transfer-Encoding': 'base64',
  }, Buffer.from(html, 'utf8').toString('base64'))
  const parsed = extractMessageText(raw)
  check('HTML 被转成纯文本', parsed.html === true && parsed.text.includes('1. A'), JSON.stringify(parsed.text))
  const reply = parseMailReply(parsed)
  check('从 HTML 回信也能解析', reply.answers.length === 2, JSON.stringify(reply.answers))
  check('第二个答案是 B', reply.answers[1].letters === 'B', JSON.stringify(reply.answers[1]))
}

console.log('\n[6] HTML 转文本的边角')
check('去 script', !htmlToText('<script>bad()</script>好').includes('bad'))
check('去 style', !htmlToText('<style>.a{}</style>好').includes('.a{}'))
check('br 转换行', htmlToText('甲<br>乙').includes('\n'))
check('实体解码', htmlToText('A &amp; B &lt;C&gt;') === 'A & B <C>', htmlToText('A &amp; B &lt;C&gt;'))
check('nbsp 转空格', htmlToText('甲&nbsp;乙') === '甲 乙', htmlToText('甲&nbsp;乙'))

console.log('\n[7] 引用剥离（错了会把原文当答案）')
{
  const withQuote = [
    '1. A',
    '',
    '在 2026-09-23，DSH 写道：',
    '> 1. 仓库公开还是私有？',
    '> A. 公开',
    '> B. 私有',
  ].join('\n')
  const stripped = stripQuoted(withQuote)
  check('剥掉「写道：」之后的内容', stripped === '1. A', JSON.stringify(stripped))
}
{
  const withArrow = '1. B\n\n> 原文第一行\n> 原文第二行'
  check('剥掉 > 引用', stripQuoted(withArrow) === '1. B', JSON.stringify(stripQuoted(withArrow)))
}
{
  const outlook = '1. A\r\n\r\n-----原始邮件-----\r\n发件人: DSH\r\n主题: 提问'
  check('剥掉「原始邮件」', stripQuoted(outlook) === '1. A', JSON.stringify(stripQuoted(outlook)))
}
{
  const english = '1. A\n\nOn Mon, Sep 23 2026, DSH wrote:\n> options'
  check('剥掉英文 On ... wrote:', stripQuoted(english) === '1. A', JSON.stringify(stripQuoted(english)))
}
{
  // 手机签名尾巴
  const signed = '1. A\n发送自我的 iPhone'
  check('剥掉手机签名', stripQuoted(signed) === '1. A', JSON.stringify(stripQuoted(signed)))
}
{
  // 关键回归：带引用的回信必须解析出干净答案，不能被原文污染
  const raw = mail({
    Subject: 'Re: [DSH-Q:abc]',
    'Content-Type': 'text/plain; charset=UTF-8',
  }, '1. A\r\n\r\n在 2026-09-23，DSH 写道：\r\n> 1. 仓库公开还是私有？\r\n> A. 公开\r\n> B. 私有\r\n')
  const parsed = extractMessageText(raw)
  const reply = parseMailReply(parsed)
  check('带引用的回信只解析出 1 个答案', reply.answers.length === 1, JSON.stringify(reply.answers))
  check('答案是 A（不是引用里的内容）', reply.answers[0].letters === 'A', JSON.stringify(reply.answers[0]))
}

console.log('\n[8] 无 boundary 的畸形 multipart 不能崩')
{
  const raw = mail({
    Subject: 'x',
    'Content-Type': 'multipart/alternative',
  }, '随便一段没有 boundary 的内容')
  let threw = null
  let parsed = null
  try { parsed = extractMessageText(raw) } catch (error) { threw = error }
  check('不抛异常', threw === null, threw && threw.message)
  check('仍能给出文本', typeof parsed?.text === 'string')
}

console.log('\n[9] 本地主题匹配（不依赖服务端 SUBJECT 搜索）')
{
  // 实测：163 对 MIME 编码过的主题做 SUBJECT 搜索会返回空，
  // 所以改为取回邮件后在本地比对。
  check('普通主题能匹配前缀', subjectMatches('[DSH] ✅ 会话 [DSH-T:abc123def456]', 'DSH-') === true)
  check('标记被插空格仍匹配', subjectMatches('回复：[DSH] ❓ [D SH-Q:e2jdvd7izt50]', 'DSH-') === true)
  check('标记被插空格仍匹配完整标记', subjectMatches('[D SH-Q:e2jdvd7izt50]', '[DSH-Q:e2jdvd7izt50]') === true)
  check('多空格/制表符也匹配', subjectMatches('[ D  S H - Q : abcdef123456 ]', 'DSH-') === true)
  check('不相关主题不匹配', subjectMatches('阿里云域名到期提醒', 'DSH-') === false)
  check('空 marker 视为全通过', subjectMatches('随便什么', '') === true)
  check('没标记的主题不匹配', subjectMatches('[DSH] 某个通知', 'DSH-Q:') === false)
}

console.log('\n[10] 候选 UID 排序与截断（回归：2026-09-23「邮件批准一直没反应」）')
{
  // 真实故障：收件箱里 30 封都是用户自己回的旧摘要邮件，他最新那封审批回信
  // 排在候选之外；旧实现「从最旧往最新扫 + 扫满 limit 就 break」，
  // 于是新回复永远轮不到 —— 他回邮件批准后等了很久毫无反应，最后只能去点界面拒绝。
  const allUids = Array.from({ length: 30 }, (_, i) => String(1000 + i))

  const ranked = rankCandidateUids({ allUids, preciseUids: [], scanWindow: 400 })
  check('不截断：候选数与窗口一致', ranked.length === 30, ranked.length)
  check('最新的排最前', ranked[0] === '1029', ranked[0])
  check('最旧的排最后', ranked[ranked.length - 1] === '1000', ranked[ranked.length - 1])

  // 关键断言：limit 再小，新邮件也必须在拉取列表里（截断只发生在返回阶段）。
  const small = rankCandidateUids({ allUids, preciseUids: [], scanWindow: 8 })
  check('窗口小也只丢旧的', small.length === 8 && small[0] === '1029', small.join(','))
  check('旧 UID 不进入候选', !small.includes('1000'), small.join(','))

  // 服务端精确定位到的 UID 必须排最前，哪怕它很旧、哪怕窗口根本不覆盖它。
  const preciseHit = rankCandidateUids({ allUids, preciseUids: ['9999'], scanWindow: 5 })
  check('精确命中排最前（即使超出窗口）', preciseHit[0] === '9999', preciseHit.join(','))
  check('精确命中不重复出现', preciseHit.filter((u) => u === '9999').length === 1)

  // 邮箱里有 200 封时，最新那封依然在候选首位 —— 大邮箱不漏。
  const big = Array.from({ length: 200 }, (_, i) => String(1 + i))
  const bigRanked = rankCandidateUids({ allUids: big, preciseUids: [], scanWindow: 400 })
  check('大邮箱不丢最新', bigRanked[0] === '200', bigRanked[0])
}

console.log(`\n${failures === 0 ? '全部通过' : '有失败项'}：${checks - failures}/${checks}\n`)
process.exit(failures === 0 ? 0 : 1)
