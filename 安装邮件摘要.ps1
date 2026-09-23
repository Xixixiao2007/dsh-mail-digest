# 安装 dsh-mail-digest 到 DSH 的 profile
#
#   powershell -ExecutionPolicy Bypass -File 安装邮件摘要.ps1
#   powershell -ExecutionPolicy Bypass -File 安装邮件摘要.ps1 -Uninstall
#
# 必须在**普通 PowerShell 窗口**里跑（不要走 DSH 沙箱：沙箱写不了 ~\.dsh）。
# 跑之前先退出 DSH 桌面应用，装完再打开。
#
# 这个脚本刻意**不写死任何本机路径**：dsh 入口、官方包目录、pnpm 都按事实探测，
# 并且每一步都打印实际取值 —— 别人装不上时能一眼看出卡在哪。
#
# 可用参数：
#   -PluginDir <路径>     插件目录（默认本脚本所在目录）
#   -ProfileName <名字>   profile 名（默认 web）
#   -DshPath <路径>       直接指定 dsh 入口，跳过自动探测
#   -DryRun               只探测并打印，不实际安装

param(
  [switch]$Uninstall,
  [string]$PluginDir = $PSScriptRoot,
  [string]$ProfileName = 'web',
  [string]$DshPath = '',
  [switch]$DryRun
)

$ErrorActionPreference = 'Continue'
$PackageName = 'dsh-mail-digest'

function Say($text) { Write-Host $text }
function Step($text) { Write-Host ''; Write-Host "── $text" }
function Info($text) { Write-Host "   $text" }
function Warn($text) { Write-Host "   ! $text" -ForegroundColor Yellow }

# ── agent 工作规则：写进用户全局指令 ──────────────────────────────
#
# 为什么需要：插件除了收发邮件，还暗含一套**给 agent 的规则**（摘要怎么写、
# 回信怎么读、默认不申请提权）。光靠工具描述不够 —— 那些规则要在**任何**会话里
# 都生效。DSH 会自动加载 `$DSH_HOME\AGENTS.md` 作为「用户全局指令」
# （由 dsh-agent-instructions 提供，dsh-base 默认启用），所以把规则写进那里。
#
# 用成对标记圈出托管区块：可反复安装（替换而不是追加），卸载时只删自己那段，
# 不碰用户自己写的其它内容。
$AgentRulesBegin = '<!-- BEGIN dsh-mail-digest (managed by 安装邮件摘要.ps1, do not edit inside) -->'
$AgentRulesEnd = '<!-- END dsh-mail-digest -->'
$AgentRulesFile = 'AGENTS.dsh-mail-digest.md'

function Install-AgentRules {
  param([string]$DshHome, [string]$PluginDir)

  $templatePath = Join-Path $PluginDir $AgentRulesFile
  if (-not (Test-Path $templatePath)) {
    Warn "没找到规则模板 $AgentRulesFile，跳过用户全局指令写入"
    return
  }
  $target = Join-Path $DshHome 'AGENTS.md'
  # 一律显式转 [string]：Get-Content 在某些情况下会返回数组，
  # 那时 .Trim() / -match 行为完全不同（实测导致幂等替换失效、卸载删不掉）。
  $block = [string]((Get-Content $templatePath -Raw -Encoding UTF8) -replace "`r`n", "`n")

  # 读现有内容（可能不存在）。**不带 BOM** 写回：带 BOM 的 AGENTS.md 在部分
  # 工具链里会被当成异常字符。用 .NET 显式指定 UTF8(no BOM) 最稳。
  $existing = ''
  if (Test-Path $target) { $existing = [string]((Get-Content $target -Raw -Encoding UTF8) -replace "`r`n", "`n") }

  $pattern = [regex]::Escape($AgentRulesBegin) + '(?s).*?' + [regex]::Escape($AgentRulesEnd)
  $merged = $null
  if ($existing -match $pattern) {
    $merged = [regex]::Replace($existing, $pattern, { param($m) $block })
    Info '用户全局指令：已更新托管区块'
  } elseif ($existing.Trim().Length -gt 0) {
    $merged = $existing.TrimEnd() + "`n`n" + $block
    Info '用户全局指令：已追加托管区块（保留原有内容）'
  } else {
    $merged = $block
    Info '用户全局指令：已创建'
  }

  $utf8 = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($target, $merged, $utf8)
  Info "写入：$target"
  Info 'DSH 会在每个会话自动加载它（dsh-agent-instructions）'
}

function Uninstall-AgentRules {
  param([string]$DshHome)

  $target = Join-Path $DshHome 'AGENTS.md'
  if (-not (Test-Path $target)) {
    Info '用户全局指令：文件不存在，无需清理'
    return
  }
  $existing = [string]((Get-Content $target -Raw -Encoding UTF8) -replace "`r`n", "`n")
  # (?s) 让 . 能跨行匹配 —— 托管区块一定是多行的。
  $pattern = [regex]::Escape($AgentRulesBegin) + '(?s).*?' + [regex]::Escape($AgentRulesEnd)
  if ($existing -notmatch $pattern) {
    Info '用户全局指令：没有我们的托管区块，保持原样'
    return
  }
  # 删掉区块，并把留下的多余空行收敛一下。
  $merged = ([regex]::Replace($existing, $pattern, '')).Trim()
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  if ($merged.Length -gt 0) {
    [System.IO.File]::WriteAllText($target, $merged + "`n", $utf8)
    Info '用户全局指令：已移除托管区块（其余内容保留）'
  } else {
    Remove-Item $target -Force
    Info '用户全局指令：移除后为空，已删除该文件'
  }
}

Say ''
Say '=== dsh-mail-digest 安装器 ==='

# ── 0. 基本检查 ────────────────────────────────────────────────────
Step '0. 检查插件目录'
Say "   插件目录：$PluginDir"
if (-not (Test-Path (Join-Path $PluginDir 'package.json'))) {
  throw "插件目录里没有 package.json：$PluginDir"
}
Info 'package.json 存在 ✓'

# ── 1. 找 dsh 入口 ─────────────────────────────────────────────────
# 不写死 npx 缓存目录（其中的哈希是本机专有的）。按可靠性依次尝试：
#   a) 用户显式 -DshPath
#   b) PATH 里的 dsh
#   c) npm 全局 bin（从 npm 自己的 prefix 算）
#   d) npx 缓存（从 npm 自己的 cache 算）
Step '1. 定位 dsh 入口'

function Resolve-DshEntry {
  param([string]$Explicit)

  if ($Explicit) {
    if (Test-Path $Explicit) { Info "使用 -DshPath 指定：$Explicit"; return $Explicit }
    Warn "-DshPath 指向的文件不存在：$Explicit"
  }

  # b) PATH
  $cmd = Get-Command dsh -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source) {
    Info "PATH 里找到 dsh：$($cmd.Source)"
    return $cmd.Source
  }
  Info 'PATH 里没有 dsh'

  # c) npm 全局 bin
  $npm = Get-Command npm -ErrorAction SilentlyContinue
  if ($npm) {
    $prefix = (& npm config get prefix 2>$null | Select-Object -First 1)
    if ($prefix -and $prefix -notmatch '^(undefined|null)$') {
      foreach ($name in @('dsh.cmd', 'dsh.ps1', 'dsh')) {
        $p = Join-Path $prefix.Trim() $name
        if (Test-Path $p) { Info "npm 全局 bin 里找到：$p"; return $p }
      }
      Info "npm 全局 bin（$($prefix.Trim())）里没有 dsh"
    }
  } else {
    Info 'npm 不在 PATH，跳过全局 bin 探测'
  }

  # d) npx 缓存：缓存根目录问 npm 自己，别写死
  $caches = @()
  if ($npm) {
    $cache = (& npm config get cache 2>$null | Select-Object -First 1)
    if ($cache -and $cache -notmatch '^(undefined|null)$') { $caches += $cache.Trim() }
  }
  if ($env:LOCALAPPDATA) { $caches += (Join-Path $env:LOCALAPPDATA 'npm-cache') }
  foreach ($cacheRoot in ($caches | Select-Object -Unique)) {
    $npxRoot = Join-Path $cacheRoot '_npx'
    if (-not (Test-Path $npxRoot)) { continue }
    $hit = Get-ChildItem $npxRoot -Directory -ErrorAction SilentlyContinue |
      ForEach-Object { Join-Path $_.FullName 'node_modules\.bin\dsh.ps1' } |
      Where-Object { Test-Path $_ } |
      Select-Object -First 1
    if ($hit) { Info "npx 缓存里找到：$hit"; return $hit }
  }
  Info 'npx 缓存里没有 dsh'

  return $null
}

$Dsh = Resolve-DshEntry -Explicit $DshPath
if (-not $Dsh) {
  throw @'
找不到 dsh 入口。请任选一种：
  1) 把 dsh 放进 PATH；
  2) 用 npm i -g @deepseek-ai/dsh 全局安装；
  3) 直接指定：-DshPath "C:\path\to\dsh.cmd"
'@
}
Say "   → dsh 入口：$Dsh"

# ── 2. 找 DSH_HOME 与 profile ──────────────────────────────────────
Step '2. 定位 DSH_HOME 与 profile'
$DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
Info "DSH_HOME：$DshHome$(if ($env:DSH_HOME) { '（来自环境变量）' } else { '（默认）' })"
$ProfileDir = Join-Path $DshHome "profiles\$ProfileName"
if (-not (Test-Path $ProfileDir)) {
  $available = Get-ChildItem (Join-Path $DshHome 'profiles') -Directory -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty Name
  throw "找不到 profile：$ProfileDir`n已有的 profile：$($available -join ', ')"
}
Info "profile：$ProfileDir ✓"

# ── 3. 让 pnpm 可用 ────────────────────────────────────────────────
# dsh plugin 只是 pnpm 的转发器，PATH 里必须有 pnpm。
Step '3. 准备 pnpm'
$pnpmCmd = Get-Command pnpm -ErrorAction SilentlyContinue
if ($pnpmCmd) {
  Info "PATH 里已有 pnpm：$($pnpmCmd.Source)"
} else {
  Info 'PATH 里没有 pnpm，尝试从 corepack 生成桥接脚本'
  $corepackRoots = @()
  if ($env:LOCALAPPDATA) { $corepackRoots += (Join-Path $env:LOCALAPPDATA 'node\corepack') }
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if ($nodeCmd) {
    $nodeDir = Split-Path $nodeCmd.Source -Parent
    $corepackRoots += (Join-Path $nodeDir 'node_modules\corepack')
    $corepackRoots += (Join-Path (Split-Path $nodeDir -Parent) 'node\corepack')
  }
  $corepackPnpm = $null
  foreach ($root in ($corepackRoots | Select-Object -Unique)) {
    if (-not (Test-Path $root)) { continue }
    Info "在 $root 里找 pnpm.cjs"
    $corepackPnpm = Get-ChildItem $root -Recurse -Filter 'pnpm.cjs' -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($corepackPnpm) { break }
  }
  if ($corepackPnpm) {
    $bridgeDir = Join-Path $env:TEMP 'dsh-pnpm-bridge'
    New-Item -ItemType Directory -Force -Path $bridgeDir | Out-Null
    $bridge = Join-Path $bridgeDir 'pnpm.cmd'
    Set-Content -Path $bridge -Value ("@echo off`r`nnode `"$($corepackPnpm.FullName)`" %*") -Encoding ASCII
    $env:PATH = "$bridgeDir;$env:PATH"
    Info "已生成桥接脚本：$bridge"
    Info "  → 指向：$($corepackPnpm.FullName)"
  } else {
    Warn '没找到 pnpm。请先装一个：npm i -g pnpm'
    Warn '（dsh plugin 需要它来改 profile 依赖，缺了会失败）'
    if (-not $Uninstall) { throw '缺少 pnpm，无法继续' }
  }
}

# ── 4. 卸载分支 ────────────────────────────────────────────────────
if ($Uninstall) {
  Step "4. 卸载 $PackageName"

  # 先移除我们写进用户全局指令的托管区块（只删自己那一段，别动用户其它内容）。
  Uninstall-AgentRules -DshHome $DshHome

  & $Dsh plugin --profile $ProfileName remove $PackageName
  $code = $LASTEXITCODE
  Say ''
  Say "卸载退出码：$code"
  Say "配置文件保留在 $(Join-Path $DshHome $PackageName)\，要清掉就手动删这个目录。"
  exit $code
}

# ── 5. 备好官方包解析链 ────────────────────────────────────────────
# 插件要从自己的 node_modules 解析 @deepseek-ai/*（DSH 运行时提供的官方包）。
# 用 junction 指到 dsh 那一份，不联网、不复制文件。
#
# 关键：**不要靠入口路径反推 node_modules**。`npm i -g` 装的 dsh 入口在全局 bin，
# 没有 `.bin` 这一层，往上两层根本不是 node_modules。
# 改成：收集若干起点，各自**向上逐级**找「含 @deepseek-ai\dsh 的目录」。
Step '5. 准备官方包解析链'

<#
  找「含 @deepseek-ai\dsh 的目录」。
  思路：收集若干起点，各自向上逐级查，任一级下存在 @deepseek-ai\dsh 就算命中。
  这样对「npx 缓存」「npm 全局」「本地项目」三种安装都能适配，不依赖层级假设。
#>
function Find-OfficialModules {
  param([string]$DshEntry)

  # 起点：入口所在目录（向上查会自然经过它的 node_modules）
  $starts = @()
  if ($DshEntry) { $starts += (Split-Path $DshEntry -Parent) }

  $npm = Get-Command npm -ErrorAction SilentlyContinue
  if ($npm) {
    $rootG = (& npm root -g 2>$null | Select-Object -First 1)
    if ($rootG -and $rootG -notmatch '^(undefined|null)$') { $starts += $rootG.Trim() }
    $cache = (& npm config get cache 2>$null | Select-Object -First 1)
    if ($cache -and $cache -notmatch '^(undefined|null)$') {
      $npxRoot = Join-Path $cache.Trim() '_npx'
      if (Test-Path $npxRoot) {
        $starts += (Get-ChildItem $npxRoot -Directory -ErrorAction SilentlyContinue |
          ForEach-Object { Join-Path $_.FullName 'node_modules\@deepseek-ai' })
      }
    }
  }

  foreach ($start in ($starts | Where-Object { $_ } | Select-Object -Unique)) {
    $probe = $start
    for ($i = 0; $i -lt 8 -and $probe; $i++) {
      # 当前层下的 @deepseek-ai（起点本身可能就是 node_modules 或 @deepseek-ai）
      foreach ($cand in @(
        (Join-Path $probe 'node_modules\@deepseek-ai'),
        (Join-Path $probe '@deepseek-ai'),
        $probe
      )) {
        if ((Split-Path $cand -Leaf) -eq '@deepseek-ai' -and (Test-Path (Join-Path $cand 'dsh'))) {
          return (Resolve-Path $cand).Path
        }
      }
      $parent = Split-Path $probe -Parent
      if (-not $parent -or $parent -eq $probe) { break }
      $probe = $parent
    }
  }
  return $null
}

$officialDir = Find-OfficialModules -DshEntry $Dsh
if (-not $officialDir) {
  throw @'
找不到 DSH 官方包目录（含 @deepseek-ai\dsh 的 node_modules）。
这通常意味着 dsh 的安装方式比较特殊。请把下面两行发我，我按你的环境补探测：
'@ + "`n  dsh 入口：$Dsh`n  npm root -g：$((& npm root -g 2>$null | Select-Object -First 1))"
}
Say "   → 官方包目录：$officialDir"

$count = (Get-ChildItem $officialDir -Directory -ErrorAction SilentlyContinue | Measure-Object).Count
Info "里面有 $count 个官方包"
if ($count -lt 5) {
  Warn '官方包数量偏少，链接后插件可能仍解析不到依赖（把上面这行发我看看）'
}

# ── 5b. DryRun 到此为止（在建立任何链接之前退出，保证零副作用）────
if ($DryRun) {
  Say ''
  Say '（-DryRun：探测完毕，未做任何改动）'
  Say "  下一步会把这些包链接到：$(Join-Path $PluginDir 'node_modules\@deepseek-ai')"
  Say '  若要真装，去掉 -DryRun 重跑。'
  exit 0
}

$linkParent = Join-Path $PluginDir 'node_modules'
$linkPath = Join-Path $linkParent '@deepseek-ai'
New-Item -ItemType Directory -Force -Path $linkParent | Out-Null
if (Test-Path $linkPath) { Remove-Item $linkPath -Force -Recurse -ErrorAction SilentlyContinue }
New-Item -ItemType Directory -Force -Path $linkPath | Out-Null
$linked = 0
Get-ChildItem $officialDir -Directory -ErrorAction SilentlyContinue | ForEach-Object {
  cmd /c mklink /J (Join-Path $linkPath $_.Name) $_.FullName | Out-Null
  $linked++
}
Info "已链接 $linked 个官方包 → $linkPath"

# ── 6. 安装 ────────────────────────────────────────────────────────
Step "6. 安装 $PackageName"
& $Dsh plugin --profile $ProfileName add "link:$PluginDir"
$code = $LASTEXITCODE

Say ''
if ($code -eq 0) {
  # ── 7. 写 agent 工作规则到用户全局指令 ──────────────────────────
  Step '7. 写入 agent 工作规则（用户全局指令）'
  Install-AgentRules -DshHome $DshHome -PluginDir $PluginDir

  Say ''
  Say '✓ 安装成功。'
  Say ''
  Say '接下来：'
  Say '  1. 重启 DSH（退出桌面应用时会连后端一起重启）'
  Say '  2. 打开 http://127.0.0.1:3080/dsh-mail-digest'
  Say '  3. 选邮箱类型，填发件邮箱地址 + 授权码（QQ/163 的授权码不是登录密码）'
  Say '  4. 点「保存」，再点「发送测试邮件」；要用回信功能再点「测试收信」'
  Say ''
  Say "配置存在：$(Join-Path $DshHome $PackageName)\config.json"
  Say ''
  Say '规则已写入用户全局指令，agent 从下一个会话起就会遵守；'
  Say '不想要可以跑 -Uninstall 移除（只会删自己那一块，不动你写的其它内容）。'
} else {
  Say "✗ 安装失败（退出码 $code）。"
  Say '  把上面的报错整段发我；也可以先跑 -DryRun 看探测结果。'
}
Say ''
exit $code
