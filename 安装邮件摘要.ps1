# 安装 dsh-mail-digest 到 DSH 的 web profile
#
#   powershell -ExecutionPolicy Bypass -File 安装邮件摘要.ps1
#   powershell -ExecutionPolicy Bypass -File 安装邮件摘要.ps1 -Uninstall
#
# 必须在**普通 PowerShell 窗口**里跑（不要走 DSH 沙箱：沙箱写不了 ~\.dsh）。
# 跑之前先退出 DSH 桌面应用，装完再打开。
#
# 插件目录默认取本脚本所在目录，跨机器时也可用 -PluginDir 指定。

param(
  [switch]$Uninstall,
  [string]$PluginDir = $PSScriptRoot,
  [string]$ProfileName = 'web'
)

$ErrorActionPreference = 'Continue'

$PackageName = 'dsh-mail-digest'

function Say($text) { Write-Host $text }

Say ''
Say '=== dsh-mail-digest 安装器 ==='
Say ''
Say "插件目录：$PluginDir"

if (-not (Test-Path (Join-Path $PluginDir 'package.json'))) {
  throw "插件目录里没有 package.json：$PluginDir"
}

# ── 1. 找 dsh 入口 ─────────────────────────────────────────────────
$DshCandidates = @()
$cmd = Get-Command dsh -ErrorAction SilentlyContinue
if ($cmd) { $DshCandidates += $cmd.Source }
$DshCandidates += (Get-ChildItem "$env:LOCALAPPDATA\npm-cache\_npx" -Directory -ErrorAction SilentlyContinue |
  ForEach-Object { Join-Path $_.FullName 'node_modules\.bin\dsh.ps1' })
$Dsh = $DshCandidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $Dsh) { throw '找不到 dsh 入口：请把 dsh 装进 PATH，或用 npm i -g @deepseek-ai/dsh 安装。' }
Say "dsh 入口：$Dsh"

# ── 2. 找 DSH_HOME 与 profile ──────────────────────────────────────
$DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$ProfileDir = Join-Path $DshHome "profiles\$ProfileName"
if (-not (Test-Path $ProfileDir)) { throw "找不到 profile：$ProfileDir" }
Say "profile：$ProfileDir"

# ── 3. 让 pnpm 可用 ────────────────────────────────────────────────
# dsh plugin 需要 PATH 里有 pnpm。没有就用 corepack 里的那份生成一个桥接脚本。
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  $corepackPnpm = Get-ChildItem "$env:LOCALAPPDATA\node\corepack" -Recurse -Filter 'pnpm.cjs' -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($corepackPnpm) {
    $bridgeDir = Join-Path $env:TEMP 'dsh-pnpm-bridge'
    New-Item -ItemType Directory -Force -Path $bridgeDir | Out-Null
    $bridge = Join-Path $bridgeDir 'pnpm.cmd'
    Set-Content -Path $bridge -Value ("@echo off`r`nnode `"$($corepackPnpm.FullName)`" %*") -Encoding ASCII
    $env:PATH = "$bridgeDir;$env:PATH"
    Say "已生成 pnpm 桥接脚本：$bridge"
  } else {
    Say '警告：PATH 里没有 pnpm，也没找到 corepack 的 pnpm —— dsh plugin 可能会失败。'
  }
}

if ($Uninstall) {
  Say "卸载 $PackageName ..."
  & $Dsh plugin --profile $ProfileName remove $PackageName
  $code = $LASTEXITCODE
  Say ''
  Say "卸载退出码：$code"
  Say "配置文件保留在 $(Join-Path $DshHome $PackageName)\，要清掉就手动删这个目录。"
  exit $code
}

# ── 4. 备好官方包解析链 ────────────────────────────────────────────
# 插件要从自己的 node_modules 解析 @deepseek-ai/*（DSH 运行时提供的官方包）。
# 用 junction 指到 dsh 安装目录里那份，不联网、不复制文件。
Say '准备官方包解析链 ...'
$installRoot = Split-Path (Split-Path $Dsh -Parent) -Parent   # ...\node_modules
$npxModules = Join-Path $installRoot '@deepseek-ai'
if (-not (Test-Path $npxModules)) { throw "找不到 DSH 官方包目录：$npxModules" }
$linkParent = Join-Path $PluginDir 'node_modules'
$linkPath = Join-Path $linkParent '@deepseek-ai'
New-Item -ItemType Directory -Force -Path $linkParent | Out-Null
if (Test-Path $linkPath) { Remove-Item $linkPath -Force -Recurse -ErrorAction SilentlyContinue }
New-Item -ItemType Directory -Force -Path $linkPath | Out-Null
$linked = 0
Get-ChildItem $npxModules -Directory | ForEach-Object {
  cmd /c mklink /J (Join-Path $linkPath $_.Name) $_.FullName | Out-Null
  $linked++
}
Say "已链接 $linked 个官方包"

# ── 5. 安装 ────────────────────────────────────────────────────────
Say "安装 $PackageName ..."
& $Dsh plugin --profile $ProfileName add "link:$PluginDir"
$code = $LASTEXITCODE

Say ''
if ($code -eq 0) {
  Say '安装成功。'
  Say ''
  Say '接下来：'
  Say '  1. 重启 DSH（退出桌面应用时会连后端一起重启）'
  Say '  2. 打开 http://127.0.0.1:3080/dsh-mail-digest'
  Say '  3. 选邮箱类型，填发件邮箱地址 + 授权码（QQ/163 的授权码不是登录密码）'
  Say '  4. 点「保存」，再点「发送测试邮件」'
  Say ''
  Say "配置存在：$(Join-Path $DshHome $PackageName)\config.json"
} else {
  Say "安装失败，退出码 $code。把上面的报错整段发我。"
}
Say ''
exit $code
