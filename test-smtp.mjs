/**
 * 本地假 SMTP 服务器 + 真实 SMTP 客户端对发。
 *
 *   node test-smtp.mjs
 *
 * 覆盖：EHLO 能力协商、AUTH LOGIN、MAIL FROM / RCPT TO、DATA 点填充与结束、
 * RFC 2047 中文主题、base64 正文能否还原、多个收件人、认证失败的中文报错、
 * 「服务器不支持 STARTTLS 就拒绝明文」这条安全底线。
 */
import net from 'node:net'
import { sendMail, SmtpError } from './smtp.mjs'

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

/** 解码 =?UTF-8?B?...?= 主题，验证中文没坏。 */
function decodeSubject(raw) {
  const match = /=\?UTF-8\?B\?([^?]+)\?=/i.exec(raw)
  return match ? Buffer.from(match[1], 'base64').toString('utf8') : raw
}

/** 从原始邮件里取出 base64 正文并还原。 */
function decodeBody(raw) {
  const parts = raw.split('\r\n\r\n')
  const body = parts.slice(1).join('\r\n\r\n')
  return Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8')
}

/**
 * 起一个假 SMTP 服务器。
 * @param {object} options - { starttls: boolean, failAuth: boolean }
 * @returns {Promise<{port: number, close: () => Promise<void>, received: object[]}>}
 */
function startFakeServer({ starttls = false, failAuth = false } = {}) {
  const received = []
  const server = net.createServer((socket) => {
    let buffer = ''
    let inData = false
    let current = null
    /** 认证状态机：null | 'user' | 'pass' */
    let authStep = null
    const send = (line) => socket.write(`${line}\r\n`)
    const ensure = () => { if (!current) current = {}; if (!current.auth) current.auth = [] }
    const finishAuth = () => {
      authStep = null
      if (failAuth) {
        send('535 5.7.8 Authentication credentials invalid')
        return
      }
      send('235 2.7.0 Authentication successful')
    }
    send('220 fake.local ESMTP ready')
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n')
          if (end < 0) return
          current.raw = buffer.slice(0, end)
          buffer = buffer.slice(end + 5)
          inData = false
          received.push(current)
          current = null
          send('250 2.0.0 Ok: queued')
          continue
        }
        const lineEnd = buffer.indexOf('\r\n')
        if (lineEnd < 0) return
        const line = buffer.slice(0, lineEnd)
        buffer = buffer.slice(lineEnd + 2)
        const upper = line.toUpperCase()

        // 认证续行优先：此时任何内容都是 base64 凭据，不是命令。
        if (authStep === 'user' || authStep === 'pass') {
          ensure()
          current.auth.push(Buffer.from(line, 'base64').toString('utf8'))
          if (failAuth && authStep === 'user') {
            // 立刻拒绝，验证 535 的中文提示（不再要口令）。
            finishAuth()
            continue
          }
          if (authStep === 'user') {
            authStep = 'pass'
            send('334 UGFzc3dvcmQ6')
          } else {
            finishAuth()
          }
          continue
        }

        if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
          send('250-fake.local')
          send('250-AUTH LOGIN PLAIN')
          send('250 SIZE 20971520')
        } else if (upper === 'AUTH LOGIN') {
          authStep = 'user'
          send('334 VXNlcm5hbWU6')
        } else if (upper.startsWith('AUTH PLAIN')) {
          // AUTH PLAIN <base64(\0user\0pass)>
          const token = line.slice('AUTH PLAIN'.length).trim()
          ensure()
          if (token) {
            const decoded = Buffer.from(token, 'base64').toString('utf8').split('\u0000')
            current.auth.push(decoded[1] ?? '', decoded[2] ?? '')
            finishAuth()
          } else {
            authStep = 'plain-token'
            send('334 ')
          }
        } else if (upper.startsWith('MAIL FROM')) {
          ensure()
          current.from = line
          send('250 2.1.0 Ok')
        } else if (upper.startsWith('RCPT TO')) {
          ensure()
          current.rcpt = current.rcpt ?? []
          current.rcpt.push(line)
          send('250 2.1.5 Ok')
        } else if (upper === 'DATA') {
          send('354 End data with <CR><LF>.<CR><LF>')
          inData = true
        } else if (upper === 'QUIT') {
          send('221 2.0.0 Bye')
          socket.end()
        } else if (upper.startsWith('STARTTLS')) {
          send(starttls ? '220 2.0.0 Ready' : '502 5.5.1 STARTTLS not implemented')
        } else {
          send('250 2.0.0 Ok')
        }
      }
    })
    socket.on('error', () => {})
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        received,
        close: () => new Promise((done) => server.close(() => done())),
      })
    })
  })
}

console.log('\n[1] 正常发信（明文 + 跳过 STARTTLS 检查，仅测试用）')
const server = await startFakeServer()
try {
  const subject = '✅ 测试会话 · 中文主题'
  const body = '这是一条摘要。\n换行要保留。\n\n第二段。'
  const result = await sendMail({
    host: '127.0.0.1',
    port: server.port,
    secure: false,
    allowInsecure: true,
    user: 'someone@qq.com',
    pass: 'authcode123',
    from: 'someone@qq.com',
    fromName: 'DeepSeek Harness',
    to: ['someone@qq.com', 'other@163.com'],
    subject,
    text: body,
  })
  check('sendMail 返回 messageId', typeof result.messageId === 'string' && result.messageId.includes('@'), result.messageId)
  check('两个收件人都被接受', JSON.stringify(result.accepted) === '["someone@qq.com","other@163.com"]', JSON.stringify(result.accepted))

  const mail = server.received[0]
  check('服务器收到一封信', Boolean(mail))
  check('MAIL FROM 正确', mail?.from === 'MAIL FROM:<someone@qq.com>', mail?.from)
  check('RCPT TO 两条', mail?.rcpt?.length === 2, JSON.stringify(mail?.rcpt))
  check('AUTH 账号口令正确', JSON.stringify(mail?.auth) === '["someone@qq.com","authcode123"]', JSON.stringify(mail?.auth))
  const header = mail?.raw ?? ''
  check('中文主题按 RFC 2047 编码且可还原', decodeSubject(header) === subject, decodeSubject(header))
  check('正文 base64 可还原', decodeBody(header) === body, JSON.stringify(decodeBody(header)))
  check('含 Message-ID', /Message-ID: <[^>]+>/.test(header))
  check('含 Auto-Submitted 头', header.includes('Auto-Submitted: auto-generated'))
  check('DATA 结束符没有把正文吃掉', decodeBody(header).includes('第二段'))
} finally {
  await server.close()
}

console.log('\n[2] 认证失败要给中文提示')
const badServer = await startFakeServer({ failAuth: true })
try {
  let error = null
  try {
    await sendMail({
      host: '127.0.0.1',
      port: badServer.port,
      secure: false,
      allowInsecure: true,
      user: 'someone@qq.com',
      pass: 'wrong',
      from: 'someone@qq.com',
      to: ['someone@qq.com'],
      subject: 'x',
      text: 'y',
    })
  } catch (caught) {
    error = caught
  }
  check('抛出了错误', error !== null)
  check('是 SmtpError 且 code=535', error instanceof SmtpError && error.code === 535, error?.code)
  check('提示是中文且提到授权码', /授权码/.test(error?.message ?? ''), error?.message?.split('\n')[0])
} finally {
  await badServer.close()
}

console.log('\n[3] 不支持 STARTTLS 时必须拒绝明文（安全底线）')
const plainServer = await startFakeServer()
try {
  let error = null
  try {
    await sendMail({
      host: '127.0.0.1',
      port: plainServer.port,
      secure: false,
      allowInsecure: false,
      user: 'someone@qq.com',
      pass: 'authcode',
      from: 'someone@qq.com',
      to: ['someone@qq.com'],
      subject: 'x',
      text: 'y',
    })
  } catch (caught) {
    error = caught
  }
  check('拒绝在明文连接上发账号', error !== null && /STARTTLS/.test(error.message), error?.message)
  check('没有真的把信发出去', plainServer.received.length === 0, plainServer.received.length)
} finally {
  await plainServer.close()
}

console.log(`\n${failures === 0 ? '全部通过' : '有失败项'}：${checks - failures}/${checks}\n`)
process.exit(failures === 0 ? 0 : 1)
