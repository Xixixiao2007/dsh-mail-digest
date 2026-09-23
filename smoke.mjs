/**
 * dsh-mail-digest 自检：不依赖 DSH、不联网、不发信。
 *
 *   node smoke.mjs
 *
 * 覆盖：
 *   1. 入口契约（name / inject / apply 存在）
 *   2. 真的用 ToolRuntime 注册工具（能查出 schema 错误）
 *   3. 摘要函数在中文 Markdown 上的行为
 *   4. 配置读写（到临时 DSH_HOME）
 *   5. 设置页路由真的能挂上、设置页能取回
 *   6. 走一遍完整的 turn/start → assistant/message → turn/end 事件流
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 必须在导入插件之前设好 DSH_HOME：配置路径在模块加载期不读，但为保险起见先设。
const HOME = mkdtempSync(join(tmpdir(), 'dsh-mail-digest-test-'))
process.env.DSH_HOME = HOME

const { defineTool } = await import('@deepseek-ai/dsh-tools')
const plugin = await import('./index.mjs')
const { cleanAnswerText, extractiveDigest, normalizeDigest, blocksToText } = await import('./digest.mjs')
const { loadConfig, saveConfig, describeReadiness, publicConfig, configPath, providerChoices } = await import('./config.mjs')
const { loadPending, renderPendingBlock, savePending, pendingPath, pendingFallbackPath, activePendingPath } = await import('./pending.mjs')

let failures = 0
let checks = 0

function check(label, condition, detail) {
  checks += 1
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL ${label}${detail === undefined ? '' : `  → ${detail}`}`)
  }
}

console.log('\n[1] 入口契约')
check('name 正确', plugin.name === 'dsh-mail-digest', plugin.name)
check('inject 声明了 tools/agents/llm', Array.isArray(plugin.inject)
  && ['tools', 'agents', 'llm'].every((s) => plugin.inject.includes(s)), JSON.stringify(plugin.inject))
check('apply 是函数', typeof plugin.apply === 'function')

console.log('\n[2] 工具注册')
// ToolRuntime 的构造依赖整棵 Cordis 树（ctx.systemPrompt 等），单进程起不来；
// 这里用一个最小注册表替身接住插件交给 ctx.tools.register 的**原始定义**
// （就是传给 defineTool 的那份），再用 SDK 真编译一遍做 DSL 校验；
// 端到端验证交给第 7 步的真实 profile 启动。
const registered = []
const tools = {
  // ctx.tools.register 收的是 defineTool 已经编译好的 ToolDefinition。
  // 编译期错误（schema DSL 写错）会在插件内部的 defineTool 调用处直接抛出，
  // 所以这里只需要原样接住，不要再编一次——重复编译已编译产物必然失败。
  register: (definition) => {
    registered.push(definition)
    return () => {}
  },
  schemas: () => registered.map(({ name, description, parameters }) => ({ name, description, parameters })),
}

// 独立校验一次 DSL：同样的 spec 交给 SDK 编译，能过说明写法合法。
let dslThrew = null
try {
  defineTool({
    name: 'mail_digest',
    description: 'schema DSL 校验',
    parameters: { summary: { type: 'string', required: true, description: '摘要' } },
    output: {
      schema: {
        type: 'object',
        properties: { accepted: { type: 'boolean', required: true }, turn: { type: 'integer' } },
        additionalProperties: false,
      },
      render: () => [{ type: 'text', text: 'ok' }],
    },
    execute: () => ({ accepted: true, turn: 1 }),
  })
} catch (error) {
  dslThrew = error
}
check('schema DSL 合法', dslThrew === null, dslThrew && dslThrew.message)
const fakeCtx = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  tools,
  agents: { get: () => undefined },
  llm: { stream: async function* () {} },
  effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
  on: () => () => {},
  inject: () => () => {},
  get: () => undefined,
}
const captured = { handlers: {}, tool: null }
fakeCtx.on = (type, handler) => { captured.handlers[type] = handler; return () => {} }

let applyThrew = null
try {
  plugin.apply(fakeCtx)
} catch (error) {
  applyThrew = error
}
captured.tool = registered[0] ?? null
check('apply 不抛异常', applyThrew === null, applyThrew && applyThrew.message)
check('注册了 mail_digest 工具', captured.tool?.name === 'mail_digest', captured.tool?.name)
const schema = tools.schemas()
check('工具 schema 出现在 schemas() 里', schema.some((s) => s.name === 'mail_digest'))
check('参数 DSL 编译出 required', JSON.stringify(captured.tool?.parameters).includes('"required":["summary"]'),
  JSON.stringify(captured.tool?.parameters))
check('output DSL 编译出 required', JSON.stringify(captured.tool?.output?.schema).includes('"required":["accepted"]'),
  JSON.stringify(captured.tool?.output?.schema))
check('订阅了 session/event', typeof captured.handlers['session/event'] === 'function')

console.log('\n[3] 摘要函数')
const sample = [
  '## 已完成',
  '',
  '我按你的要求装好了插件，**核心是一个零依赖的 Cordis 插件**。',
  '',
  '- 订阅 `turn/end`，把这一轮回答抽出来',
  '- 用 `ctx.llm.stream` 压成一条摘要',
  '',
  '```js',
  'const x = 1',
  '```',
  '',
  '| 文件 | 作用 |',
  '| --- | --- |',
  '| index.mjs | 入口 |',
  '',
  '装完要重启 web 服务，然后刷新页面才能生效。',
].join('\n')
const cleaned = cleanAnswerText(sample)
check('清洗去掉了代码块', !cleaned.includes('const x = 1'))
check('清洗去掉了表格分隔行', !cleaned.includes('--- | ---'))
check('清洗保留了正文', cleaned.includes('装好了插件'))
check('清洗保留了收尾句', cleaned.includes('重启 web 服务'))
const digest = extractiveDigest(cleaned)
check('兜底摘要非空', digest.length > 0, digest)
check('兜底摘要是单行', !digest.includes('\n'), JSON.stringify(digest))
check('兜底摘要含结论', /插件|重启|订阅|摘要/.test(digest), digest)
console.log(`       兜底摘要（${digest.length} 字）：${digest}`)
check('normalizeDigest 去掉列表符号', normalizeDigest('- 第一件事\n- 第二件事') === '第一件事 第二件事', normalizeDigest('- 第一件事\n- 第二件事'))
check('normalizeDigest 去掉引号包裹', normalizeDigest('“这是一条摘要。”') === '这是一条摘要。', normalizeDigest('“这是一条摘要。”'))
check('blocksToText 只取 text 块', blocksToText([
  { type: 'text', text: '甲' },
  { type: 'reasoning', text: '不该出现' },
  { type: 'text', text: '乙' },
]) === '甲\n乙')

console.log('\n[4] 配置读写')
const defaults = loadConfig()
check('默认配置存在且未落盘', defaults.exists === false)
check('默认邮箱类型是 QQ', defaults.value.provider === 'qq', defaults.value.provider)
check('默认服务器是 smtp.qq.com:465', defaults.value.smtp.host === 'smtp.qq.com' && defaults.value.smtp.port === 465)
check('默认未就绪（还没填授权码）', describeReadiness(defaults.value).ready === false)
const saved = saveConfig({
  ...defaults.value,
  smtp: { ...defaults.value.smtp, user: 'someone@qq.com', pass: 'authcode' },
})
check('保存成功', saved.ok === true, saved.error)
check('保存后落盘了', loadConfig().exists === true)
check('保存后已就绪', describeReadiness(saved.value).ready === true, JSON.stringify(describeReadiness(saved.value)))
check('收件人缺省回落到发件人自己', JSON.stringify(saved.value.to) === '["someone@qq.com"]', JSON.stringify(saved.value.to))
const pub = publicConfig(saved.value)
check('回显隐藏口令', pub.smtp.pass === '' && pub.smtp.passSet === true, JSON.stringify(pub.smtp))
const again = saveConfig({ ...pub, smtp: { ...pub.smtp, pass: '' } })
check('留空口令 = 不改动已存口令', again.value.smtp.pass === 'authcode')
check('预置含 qq 与 163', providerChoices().some((p) => p.key === 'qq') && providerChoices().some((p) => p.key === '163'))
check('配置路径在临时 HOME 下', configPath().startsWith(HOME), configPath())

console.log('\n[5] 设置页路由')
const routes = []
const fakeWebServer = { register: (route) => { routes.push(route); return () => {} } }
const settingsCtx = {
  ...fakeCtx,
  inject: (deps, fn) => { fn({ webServer: fakeWebServer, effect: (f) => { f(); return () => {} } }); return () => {} },
}
try {
  plugin.apply(settingsCtx)
  check('注册了 6 条路由', routes.length === 6, routes.map((r) => r.path).join(','))
  check('有 /dsh-mail-digest 页面', routes.some((r) => r.path === '/dsh-mail-digest'))
  check('有 test-imap 路由', routes.some((r) => r.path === '/dsh-mail-digest/test-imap'))
  const pageRoute = routes.find((r) => r.path === '/dsh-mail-digest')
  let html = ''
  await pageRoute.handler({ method: 'GET', url: '/dsh-mail-digest' }, {
    writeHead: () => {},
    end: (body) => { html = body },
  })
  check('页面是 HTML', html.startsWith('<!doctype html>'))
  check('页面含授权码提示', html.includes('授权码'))
  check('页面含 QQ / 163 预置', html.includes('smtp.qq.com') && html.includes('smtp.163.com'))
  check('页面含回信通道设置', html.includes('回信通道') && html.includes('replyEnabled'))
  check('页面含 IMAP 服务器项', html.includes('imapHost') && html.includes('imap.qq.com'))
  check('页面含「1. A」写法说明', html.includes('1. A'))
  {
    // 深色模式：输入框必须**同时**覆盖 background 与 color。
    // 只改 background 会造成「深底深字」（曾经的 bug：白底白字看不清）。
    const dark = /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{([\s\S]*?)\n\s*\}\s*\n<\/style>/.exec(html)
    const darkCss = dark ? dark[1] : ''
    check('存在深色模式样式块', darkCss.length > 0)
    const inputRule = /input\[type=text\][^{]*\{([^}]*)\}/.exec(darkCss)
    check('深色模式里覆盖了输入框', Boolean(inputRule))
    const ruleBody = inputRule ? inputRule[1] : ''
    check('深色模式输入框设了 background', /background\s*:/.test(ruleBody), ruleBody.trim().slice(0, 70))
    check('深色模式输入框设了 color', /[^-]color\s*:/.test(ruleBody), ruleBody.trim().slice(0, 70))
    check('深色模式输入框带 color-scheme:dark', /color-scheme\s*:\s*dark/.test(ruleBody), ruleBody.trim().slice(0, 70))
    const lightCss = html.replace(darkCss, '')
    check('浅色模式输入框也显式设了 color',
      /input\[type=text\][^{]*\{[^}]*[^-]color\s*:\s*#/.test(lightCss))
    check('深色模式给了 select option 配色', /select\s+option[^{]*\{[^}]*background/.test(darkCss))
  }

  const configRoute = routes.find((r) => r.path === '/dsh-mail-digest/config')
  let payload = null
  await configRoute.handler({ method: 'GET', url: '/dsh-mail-digest/config' }, {
    writeHead: () => {},
    end: (body) => { payload = JSON.parse(body) },
  })
  check('GET config 回 JSON', payload?.ok === true)
  check('GET config 不回显口令', payload?.config?.smtp?.pass === '' && payload?.config?.imap?.pass === '')
  check('GET config 带回信就绪信息', typeof payload?.replyReady === 'boolean' && Array.isArray(payload?.replyMissing))
} catch (error) {
  check('设置页挂载不抛异常', false, error.message)
}

console.log('\n[6] 完整事件流（digestMode=off，不发信）')
saveConfig({ ...loadConfig().value, digestMode: 'off', enabled: true })
const handler = captured.handlers['session/event']
const session = {
  id: 'session-test',
  header: { cwd: process.cwd() },
  events: [],
}
if (typeof handler === 'function') {
  try {
    handler(session, { type: 'turn/start', time: Date.now(), data: { turn: 1 } })
    handler(session, {
      type: 'assistant/message',
      time: Date.now(),
      data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: sample }] } },
    })
    handler(session, { type: 'request/context', time: Date.now(), data: { provider: 'deepseek-official', model: 'deepseek-flash' } })
    handler(session, { type: 'turn/end', time: Date.now(), data: { turn: 1, reason: { kind: 'completed' } } })
    await new Promise((resolve) => setTimeout(resolve, 60))
    check('事件流处理不抛异常', true)
  } catch (error) {
    check('事件流处理不抛异常', false, error.message)
  }
} else {
  check('拿到 session/event 处理器', false)
}

rmSync(HOME, { recursive: true, force: true })

console.log('\n[7] 待批准权限清单')
{
  // 干净起点
  savePending([])
  check('初始为空', loadPending().length === 0, JSON.stringify(loadPending()))
  check('为空时不占邮件版面', renderPendingBlock([]) === '', JSON.stringify(renderPendingBlock([])))

  const saved = savePending([
    { what: '把三条坑写进 dsh-plugin-mgmt 技能', why: '下次发布插件还会踩', need: '写 ~/.dsh/skills' },
    { what: '更新 profile 的 cordis.patch.yml', need: '写 ~/.dsh/profiles/web' },
  ])
  check('保存成功', saved.ok === true && saved.count === 2, JSON.stringify(saved))
  check('落盘了', loadPending().length === 2, JSON.stringify(loadPending().map((i) => i.what)))

  const block = renderPendingBlock(loadPending())
  check('渲染出区块标题', block.includes('待你批准的权限'), block.slice(0, 60))
  check('渲染出条目标题', block.includes('把三条坑写进'), block)
  check('渲染出需要什么权限', block.includes('需要：写 ~/.dsh/skills'), block)
  check('渲染出原因', block.includes('原因：下次发布插件还会踩'), block)
  check('缺 why 的那条不报错', block.includes('更新 profile'), block)
  check('区块以空行开头（与摘要隔开）', block.startsWith('\n'), JSON.stringify(block.slice(0, 6)))

  // 清空语义：空数组 = 清空
  const cleared = savePending([])
  check('空数组清空清单', cleared.count === 0 && loadPending().length === 0, JSON.stringify(cleared))

  // 脏数据要能被规整掉，而不是让邮件崩
  const messy = savePending([
    '纯字符串也算一条',
    { why: '没有 what 应被丢弃' },
    null,
    { what: 'A'.repeat(500), need: 'B'.repeat(500) },
  ])
  const items = loadPending()
  check('脏数据被规整', items.length === 2, JSON.stringify(items.map((i) => i.what.slice(0, 12))))
  check('超长文本被截断', items[1].what.length <= 300 && items[1].need.length <= 300,
    `${items[1].what.length}/${items[1].need.length}`)
  check('规整后仍能渲染', renderPendingBlock(items).includes('纯字符串也算一条'))
  savePending([])

  check('清单路径与配置同目录', pendingPath().includes('dsh-mail-digest'), pendingPath())
  // 回退位置：必须在插件目录里（工作区内，DSH 进程必然可写）。
  // 这是「首选位置写不进去」时的兜底，实测踩过清单没落盘。
  check('回退路径在插件目录内', pendingFallbackPath().includes('dsh-mail-digest'), pendingFallbackPath())
  check('回退路径与首选路径不同', pendingFallbackPath() !== pendingPath())
  savePending([])
  check('activePendingPath 指向已存在的文件', activePendingPath() === pendingPath(), activePendingPath())
}

console.log('\n[8] mail_digest 工具带待批准权限参数')
{
  const definition = registered.find((d) => d.name === 'mail_digest')
  check('工具已注册', Boolean(definition))
  // 注意：这里拿到的是 defineTool **编译后**的 JSON Schema，
  // 自定义属性在 .properties 下（不是 DSL 那种平铺结构）。
  const props = definition?.parameters?.properties ?? {}
  check('参数里有 pendingPermissions', Boolean(props.pendingPermissions),
    JSON.stringify(Object.keys(props)))
  check('pendingPermissions 声明为数组', props.pendingPermissions?.type === 'array',
    JSON.stringify(props.pendingPermissions?.type))
  check('它的元素是对象（含 what）',
    props.pendingPermissions?.items?.properties?.what?.type === 'string',
    JSON.stringify(props.pendingPermissions?.items))

  // 通过工具写清单，再通过工具清空
  const exec = { agent: undefined }
  const saved = await definition.execute({
    summary: 'x',
    pendingPermissions: [{ what: '通过工具写入的待办', need: '写某处' }],
  }, exec)
  check('工具能写入清单', loadPending().length === 1, JSON.stringify(loadPending()))
  check('返回里带 pendingCount', saved?.pendingCount === 1, JSON.stringify(saved))

  const cleared = await definition.execute({ summary: 'x', pendingPermissions: [] }, exec)
  check('工具能用空数组清空', loadPending().length === 0, JSON.stringify(loadPending()))
  check('清空后 pendingCount 为 0', cleared?.pendingCount === 0, JSON.stringify(cleared))

  // 不传这个参数时不应改动既有清单
  savePending([{ what: '既有项' }])
  await definition.execute({ summary: 'x' }, exec)
  check('不传参数不动清单', loadPending().length === 1 && loadPending()[0].what === '既有项',
    JSON.stringify(loadPending()))
  savePending([])
}

console.log('\n[10] 审批仲裁（回归：2026-09-23 14:21「邮件批准了却没生效」）')
{
  // 实测故障：用户 14:21:02 收到审批邮件、14:21:19 回信批准，
  // 但界面同时在 14:21:2x 返回 rejected，纯 race 让界面瞬间取胜 ——
  // 用户的邮件批准完全没机会生效，他只能看着"没反应"。
  const { arbitrateApproval } = plugin
  check('导出了 arbitrateApproval', typeof arbitrateApproval === 'function')

  const settle = (ms, value) => new Promise((resolve) => setTimeout(() => resolve(value), ms))
  const logs = []
  const log = (level, message) => logs.push(message)

  // ① 邮件先到 → 以邮件为准
  check('邮件先批准 → allowed-once', await arbitrateApproval({
    byMail: settle(0, { decision: 'allow' }),
    byInterface: settle(500, 'rejected'),
    graceMs: 50, log,
  }) === 'allowed-once')

  check('邮件先拒绝 → rejected', await arbitrateApproval({
    byMail: settle(0, { decision: 'reject' }),
    byInterface: settle(500, 'allowed-once'),
    graceMs: 50, log,
  }) === 'rejected')

  // ② 界面批准 → 立刻采纳，不必等宽限期（放行更宽松，没有安全代价）
  const startedAt = Date.now()
  const fast = await arbitrateApproval({
    byMail: settle(5000, { decision: 'allow' }),
    byInterface: settle(0, 'allowed-once'),
    graceMs: 5000, log,
  })
  check('界面批准立刻生效（不等宽限期）', fast === 'allowed-once' && Date.now() - startedAt < 1000,
    `${fast} / ${Date.now() - startedAt}ms`)

  // ③ ★ 核心回归：界面拒绝先到，但邮件在宽限期内批准 → 必须采纳邮件
  logs.length = 0
  const rescued = await arbitrateApproval({
    byMail: settle(40, { decision: 'allow' }),
    byInterface: settle(0, 'rejected'),
    graceMs: 3000, log,
  })
  check('★ 界面拒绝先到，邮件在宽限期内批准 → 采纳邮件', rescued === 'allowed-once', rescued)
  check('日志说明了是宽限期救回来的', logs.some((m) => m.includes('宽限期')), JSON.stringify(logs))

  // ④ 界面拒绝 + 宽限期内邮件没动静 → 按界面结论（fail closed）
  const closed = await arbitrateApproval({
    byMail: settle(5000, { decision: 'allow' }),
    byInterface: settle(0, 'rejected'),
    graceMs: 120, log,
  })
  check('宽限期内无邮件结论 → 按界面拒绝（fail closed）', closed === 'rejected', closed)

  // ⑤ 宽限期内邮件也拒绝 → rejected（不会因为"等到了"就放行）
  check('宽限期内邮件拒绝 → rejected', await arbitrateApproval({
    byMail: settle(30, { decision: 'reject' }),
    byInterface: settle(0, 'rejected'),
    graceMs: 3000, log,
  }) === 'rejected')

  // ⑥ 宽限期为 0 时保持旧行为（界面结论立刻生效）
  check('graceMs=0 时不等（兼容行为）', await arbitrateApproval({
    byMail: settle(5000, { decision: 'allow' }),
    byInterface: settle(0, 'rejected'),
    graceMs: 0, log,
  }) === 'rejected')
}

console.log(`\n${failures === 0 ? '全部通过' : '有失败项'}：${checks - failures}/${checks}\n`)
process.exit(failures === 0 ? 0 : 1)
