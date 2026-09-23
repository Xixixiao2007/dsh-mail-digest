# AgentRules.ps1 —— 给 DSH 插件投放「agent 工作规则」的可复用模块
#
# 为什么需要它
# ------------
# 插件除了代码，往往还暗含一套**给 agent 的规则**（工具怎么用、什么情况该请求权限、
# 输出写成什么格式）。只写在 README 里等于没有 —— README 是给**人**看的，
# agent 不会主动读。别人装了你的插件，他的 agent 不知道规则。
#
# DSH 没有"插件内置 skill"的机制，但有另一条路：
#   `@deepseek-ai/dsh-agent-instructions`（dsh-base 默认启用）会自动加载
#   `$DSH_HOME/AGENTS.md`（用户全局）与项目内 `AGENTS.md` / `CLAUDE.md`，
#   以 "Additional instructions from: …" 注入 agent 上下文。
#   实测：写入/修改该文件后**立刻**生效，不必重启。
#
# 用法（在你的安装脚本里 dot-source 本文件）
# ----------------------------------------
#   . "$PSScriptRoot\AgentRules.ps1"
#   Install-AgentRules -DshHome $dshHome -TemplatePath "$PSScriptRoot\AGENTS.myplugin.md" -BlockName 'my-plugin'
#   Uninstall-AgentRules -DshHome $dshHome -BlockName 'my-plugin'
#
# 模板文件（$TemplatePath）内容会**原样**写进用户全局指令；请只在里面写规则，
# 并在开头写清这是哪个插件。区块用成对标记圈起来：
#   <!-- BEGIN <BlockName> (managed by <你的安装脚本>, do not edit inside) -->
#   ...
#   <!-- END <BlockName> -->
#
# 安全保证
# --------
# - 可反复安装：有标记就**替换整块**，没有才追加到末尾；绝不会重复堆叠。
# - 绝不覆盖用户已有内容：卸载只删自己那一块，其余原样保留；删完为空才删文件。
# - 写出**不带 BOM**（带 BOM 在部分工具链里会被当成异常字符）。

function Get-AgentRulesMarker {
  param(
    [Parameter(Mandatory)][string]$BlockName,
    # 写进标记里的"管理者"名字（安装脚本名）。改这个值会让旧块认不出来 ——
    # 已发布的插件升级时**不要改**，否则等于换了一套标记。
    [string]$Manager = 'install script'
  )
  @{
    Begin = "<!-- BEGIN $BlockName (managed by $Manager, do not edit inside) -->"
    End = "<!-- END $BlockName -->"
  }
}

function Get-AgentRulesPattern {
  param(
    [Parameter(Mandatory)][string]$BlockName,
    [string]$Manager = 'install script'
  )
  $m = Get-AgentRulesMarker -BlockName $BlockName -Manager $Manager
  # (?s) 必须加：托管区块是多行的，默认 `.` 不匹配换行 → 会匹配不到（卸载就删不掉）。
  return [regex]::Escape($m.Begin) + '(?s).*?' + [regex]::Escape($m.End)
}

<#
.SYNOPSIS
把插件的 agent 规则写进用户全局指令（$DshHome\AGENTS.md）。
.DESCRIPTION
幂等：已存在同名托管区块就整块替换，否则追加。保留用户已有内容。
#>
function Install-AgentRules {
  param(
    [Parameter(Mandatory)][string]$DshHome,
    [Parameter(Mandatory)][string]$TemplatePath,
    [Parameter(Mandatory)][string]$BlockName,
    [string]$Manager = 'install script',
    [scriptblock]$Info = { param($t) Write-Host "   $t" }
  )

  if (-not (Test-Path $TemplatePath)) {
    & $Info "没找到规则模板 $TemplatePath，跳过用户全局指令写入"
    return
  }
  $target = Join-Path $DshHome 'AGENTS.md'
  $block = Get-AgentRulesBlock -TemplatePath $TemplatePath -BlockName $BlockName -Manager $Manager

  # 一律显式 [string]：Get-Content 有时返回数组，
  # 那时 .Trim() / -match 行为完全不同（实测导致幂等替换静默失效）。
  $existing = ''
  if (Test-Path $target) { $existing = [string]((Get-Content $target -Raw -Encoding UTF8) -replace "`r`n", "`n") }

  $pattern = Get-AgentRulesPattern -BlockName $BlockName -Manager $Manager
  $merged = $null
  if ($existing -match $pattern) {
    $merged = [regex]::Replace($existing, $pattern, { param($m) $block })
    & $Info '用户全局指令：已更新托管区块'
  } elseif ($existing.Trim().Length -gt 0) {
    $merged = $existing.TrimEnd() + "`n`n" + $block
    & $Info '用户全局指令：已追加托管区块（保留原有内容）'
  } else {
    $merged = $block
    & $Info '用户全局指令：已创建'
  }

  Write-Utf8NoBom -Path $target -Text $merged
  & $Info "写入：$target"
  & $Info 'DSH 会在每个会话自动加载它（dsh-agent-instructions）'
}

<#
.SYNOPSIS
移除本插件写进用户全局指令的托管区块；其余内容原样保留。
#>
function Uninstall-AgentRules {
  param(
    [Parameter(Mandatory)][string]$DshHome,
    [Parameter(Mandatory)][string]$BlockName,
    [string]$Manager = 'install script',
    [scriptblock]$Info = { param($t) Write-Host "   $t" }
  )

  $target = Join-Path $DshHome 'AGENTS.md'
  if (-not (Test-Path $target)) {
    & $Info '用户全局指令：文件不存在，无需清理'
    return
  }
  $existing = [string]((Get-Content $target -Raw -Encoding UTF8) -replace "`r`n", "`n")
  $pattern = Get-AgentRulesPattern -BlockName $BlockName -Manager $Manager
  if ($existing -notmatch $pattern) {
    & $Info '用户全局指令：没有我们的托管区块，保持原样'
    return
  }
  $merged = ([regex]::Replace($existing, $pattern, '')).Trim()
  if ($merged.Length -gt 0) {
    Write-Utf8NoBom -Path $target -Text ($merged + "`n")
    & $Info '用户全局指令：已移除托管区块（其余内容保留）'
  } else {
    Remove-Item $target -Force
    & $Info '用户全局指令：移除后为空，已删除该文件'
  }
}

<#
.SYNOPSIS
读出模板内容，并在需要时补齐成对标记（模板里已有标记则原样使用）。
#>
function Get-AgentRulesBlock {
  param(
    [Parameter(Mandatory)][string]$TemplatePath,
    [Parameter(Mandatory)][string]$BlockName,
    [string]$Manager = 'install script'
  )
  $block = [string]((Get-Content $TemplatePath -Raw -Encoding UTF8) -replace "`r`n", "`n")
  $m = Get-AgentRulesMarker -BlockName $BlockName -Manager $Manager
  if ($block.Contains($m.End)) { return $block.Trim() }
  return $m.Begin + "`n" + $block.Trim() + "`n" + $m.End
}

<#
.SYNOPSIS
以 UTF-8（不带 BOM）写文件。
.DESCRIPTION
带 BOM 的 AGENTS.md 在部分工具链里会被当成异常字符，所以刻意不带。
#>
function Write-Utf8NoBom {
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][string]$Text
  )
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Text, $utf8)
}
