# 测试 tools\AgentRules.ps1 的「用户全局指令托管区块」读写逻辑。
#
#   powershell -ExecutionPolicy Bypass -File test-installer.ps1
#
# 用**临时目录**当 DSH_HOME，不碰真实的 ~/.dsh/AGENTS.md。
#
# 为什么必须有这个测试：托管区块的"幂等替换 / 干净卸载"很容易写成"重复追加"或
# "删错内容"，而这两种错误只在**反复安装**时才暴露
# （实测踩过一次：读取拿到数组，导致替换静默失效、BEGIN 标记出现两次）。
$ErrorActionPreference = 'Stop'

$pluginDir = $PSScriptRoot
. (Join-Path $pluginDir 'tools\AgentRules.ps1')

$BlockName = 'dsh-mail-digest'
$Manager = '安装邮件摘要.ps1'
$Template = Join-Path $pluginDir 'AGENTS.dsh-mail-digest.md'
$Quiet = { param($t) Write-Host "   [Info] $t" }

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("dsh-agentrules-test-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force $tmp | Out-Null
Write-Host "已加载模块: tools\AgentRules.ps1"
Write-Host "临时 DSH_HOME: $tmp`n"

function Read-Target { param($dir) $p = Join-Path $dir 'AGENTS.md'; if (Test-Path $p) { Get-Content $p -Raw -Encoding UTF8 } else { $null } }
function Install-It { Install-AgentRules -DshHome $tmp -TemplatePath $Template -BlockName $BlockName -Manager $Manager -Info $Quiet }
function Uninstall-It { Uninstall-AgentRules -DshHome $tmp -BlockName $BlockName -Manager $Manager -Info $Quiet }

Write-Host '── [1] 全新安装（文件不存在）'
Install-It
$c1 = Read-Target $tmp
Write-Host "   文件存在: $($null -ne $c1)  长度: $($c1.Length)"
Write-Host "   含 BEGIN 标记: $($c1 -match 'BEGIN dsh-mail-digest')"
Write-Host "   含 END 标记:   $($c1 -match 'END dsh-mail-digest')"
Write-Host "   含关键规则:    $($c1 -match '默认不申请提权')"
Write-Host "   含自包含规则:  $($c1 -match '自包含')"

Write-Host "`n── [2] 重复安装（幂等：应替换而不是追加）"
Install-It
$c2 = Read-Target $tmp
Write-Host "   BEGIN 标记出现次数（应为 1）: $(([regex]::Matches($c2, 'BEGIN dsh-mail-digest')).Count)"
Write-Host "   END 标记出现次数（应为 1）:   $(([regex]::Matches($c2, 'END dsh-mail-digest')).Count)"
Write-Host "   内容长度基本不变: $([math]::Abs($c2.Length - $c1.Length) -le 1)  ($($c1.Length) → $($c2.Length))"

Write-Host "`n── [3] 保留用户已有内容"
$userText = "# 我的全局指令`n`n- 回答用中文`n- 别删我这段`n"
[System.IO.File]::WriteAllText((Join-Path $tmp 'AGENTS.md'), $userText, (New-Object System.Text.UTF8Encoding($false)))
Install-It
$c3 = Read-Target $tmp
Write-Host "   用户内容仍在: $($c3 -match '别删我这段')"
Write-Host "   规则也写入了: $($c3 -match '默认不申请提权')"
Write-Host "   用户内容在规则之前: $($c3.IndexOf('别删我这段') -lt $c3.IndexOf('BEGIN dsh-mail-digest'))"

Write-Host "`n── [4] 卸载（只删自己那块）"
Uninstall-It
$c4 = Read-Target $tmp
Write-Host "   规则块已移除: $(-not ($c4 -match 'BEGIN dsh-mail-digest'))"
Write-Host "   用户内容保留: $($c4 -match '别删我这段')"

Write-Host "`n── [5] 卸载后再卸载（幂等、不报错）"
Uninstall-It
Write-Host "   第二次卸载未抛错 ✓"

Write-Host "`n── [6] 只有我们的内容时，卸载后应删除文件"
[System.IO.File]::WriteAllText((Join-Path $tmp 'AGENTS.md'), '', (New-Object System.Text.UTF8Encoding($false)))
Install-It
Uninstall-It
Write-Host "   文件已删除: $(-not (Test-Path (Join-Path $tmp 'AGENTS.md')))"

Write-Host "`n── [7] 写出的文件不带 BOM（避免被当成异常字符）"
Install-It
$b = [System.IO.File]::ReadAllBytes((Join-Path $tmp 'AGENTS.md'))
Write-Host "   前3字节: $($b[0..2] -join ',')  → 无 BOM: $(-not ($b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF))"

Write-Host "`n── [8] 无标记的模板也能用（模块自动补标记）"
$bareTemplate = Join-Path $tmp 'bare-template.md'
[System.IO.File]::WriteAllText($bareTemplate, "## 裸模板`n`n没有任何标记。`n", (New-Object System.Text.UTF8Encoding($false)))
Remove-Item (Join-Path $tmp 'AGENTS.md') -Force -ErrorAction SilentlyContinue
Install-AgentRules -DshHome $tmp -TemplatePath $bareTemplate -BlockName 'bare-test' -Manager 'x.ps1' -Info $Quiet
$c8 = Read-Target $tmp
Write-Host "   自动补了 BEGIN: $($c8 -match 'BEGIN bare-test')"
Write-Host "   自动补了 END:   $($c8 -match 'END bare-test')"
Uninstall-AgentRules -DshHome $tmp -BlockName 'bare-test' -Manager 'x.ps1' -Info $Quiet
Write-Host "   卸载后文件已删: $(-not (Test-Path (Join-Path $tmp 'AGENTS.md')))"

Remove-Item $tmp -Recurse -Force
Write-Host "`n清理临时目录完成"
