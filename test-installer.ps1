# 测试 安装邮件摘要.ps1 里「用户全局指令托管区块」的读写逻辑。
#
#   powershell -ExecutionPolicy Bypass -File test-installer.ps1
#
# 用**临时目录**当 DSH_HOME，不碰真实的 ~/.dsh/AGENTS.md。
# 为什么必须有这个测试：托管区块的"幂等替换 / 干净卸载"很容易写成"重复追加"或
# "删错内容"，而这两种错误只在**反复安装**时才暴露
# （实测踩过一次：读取拿到数组，导致替换静默失效、BEGIN 标记出现两次）。
$ErrorActionPreference = 'Stop'

$pluginDir = $PSScriptRoot
$installer = Join-Path $pluginDir '安装邮件摘要.ps1'

# 从安装器里抠出三个定义（标记 + 两个函数），单独驱动测试。
$src = Get-Content $installer -Raw -Encoding UTF8
$start = $src.IndexOf('$AgentRulesBegin')
$end = $src.IndexOf("Say ''`r`nSay '=== dsh-mail-digest")
if ($end -lt 0) { $end = $src.IndexOf("Say ''`nSay '=== dsh-mail-digest") }
if ($start -lt 0 -or $end -lt 0) { throw "没能从安装器里定位到规则区块（start=$start end=$end）" }
$snippet = $src.Substring($start, $end - $start)
# 安装器里 Info/Warn 定义在别处，测试里给个桩（顺便把安装器的提示打出来）。
function Info($t) { Write-Host "   [Info] $t" }
function Warn($t) { Write-Host "   [Warn] $t" }
Invoke-Expression $snippet | Out-Null
Write-Host '已从安装器提取：$AgentRulesBegin / Install-AgentRules / Uninstall-AgentRules'

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("dsh-agentrules-test-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force $tmp | Out-Null
Write-Host "临时 DSH_HOME: $tmp`n"

function Read-Target { param($dir) $p = Join-Path $dir 'AGENTS.md'; if (Test-Path $p) { Get-Content $p -Raw -Encoding UTF8 } else { $null } }

Write-Host '── [1] 全新安装（文件不存在）'
Install-AgentRules -DshHome $tmp -PluginDir $pluginDir
$c1 = Read-Target $tmp
Write-Host "   文件存在: $($null -ne $c1)  长度: $($c1.Length)"
Write-Host "   含 BEGIN 标记: $($c1 -match 'BEGIN dsh-mail-digest')"
Write-Host "   含 END 标记:   $($c1 -match 'END dsh-mail-digest')"
Write-Host "   含关键规则:    $($c1 -match '默认不申请提权')"

Write-Host "`n── [2] 重复安装（幂等：应替换而不是追加）"
Install-AgentRules -DshHome $tmp -PluginDir $pluginDir
$c2 = Read-Target $tmp
Write-Host "   长度与首次一致: $($c2.Length -eq $c1.Length)  ($($c1.Length) → $($c2.Length))"
$beginCount = ([regex]::Matches($c2, 'BEGIN dsh-mail-digest')).Count
Write-Host "   BEGIN 标记出现次数（应为 1）: $beginCount"

Write-Host "`n── [3] 保留用户已有内容"
$userText = "# 我的全局指令`n`n- 回答用中文`n- 别删我这段`n"
[System.IO.File]::WriteAllText((Join-Path $tmp 'AGENTS.md'), $userText, (New-Object System.Text.UTF8Encoding($false)))
Install-AgentRules -DshHome $tmp -PluginDir $pluginDir
$c3 = Read-Target $tmp
Write-Host "   用户内容仍在: $($c3 -match '别删我这段')"
Write-Host "   规则也写入了: $($c3 -match '默认不申请提权')"
Write-Host "   用户内容在规则之前: $($c3.IndexOf('别删我这段') -lt $c3.IndexOf('BEGIN dsh-mail-digest'))"

Write-Host "`n── [4] 卸载（只删自己那块）"
Uninstall-AgentRules -DshHome $tmp
$c4 = Read-Target $tmp
Write-Host "   规则块已移除: $(-not ($c4 -match 'BEGIN dsh-mail-digest'))"
Write-Host "   用户内容保留: $($c4 -match '别删我这段')"

Write-Host "`n── [5] 卸载后再卸载（幂等、不报错）"
Uninstall-AgentRules -DshHome $tmp
Write-Host "   第二次卸载未抛错 ✓"

Write-Host "`n── [6] 只有我们的内容时，卸载后应删除文件"
[System.IO.File]::WriteAllText((Join-Path $tmp 'AGENTS.md'), '', (New-Object System.Text.UTF8Encoding($false)))
Install-AgentRules -DshHome $tmp -PluginDir $pluginDir
Uninstall-AgentRules -DshHome $tmp
Write-Host "   文件已删除: $(-not (Test-Path (Join-Path $tmp 'AGENTS.md')))"

Write-Host "`n── [7] 写出的文件不带 BOM（避免被当成异常字符）"
Install-AgentRules -DshHome $tmp -PluginDir $pluginDir
$b = [System.IO.File]::ReadAllBytes((Join-Path $tmp 'AGENTS.md'))
Write-Host "   前3字节: $($b[0..2] -join ',')  → 无 BOM: $(-not ($b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF))"

Remove-Item $tmp -Recurse -Force
Write-Host "`n清理临时目录完成"
