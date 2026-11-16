<#
.SYNOPSIS
  VDACC 环境准备：检查 / 安装 Bun 与 ffmpeg，装好 ts 依赖，最后跑一次 doctor。

.DESCRIPTION
  复原快照、换新机器或重装系统后，仓库里只有源码——Bun、ffmpeg、ts/node_modules
  本来就不入库，这时 `bun ts/src/cli.ts` 会直接报「无法识别 bun」。
  这个脚本把所有步骤收敛成一条命令，缺什么装什么，装完给出可读的结论。

  安装方式刻意不依赖 winget：Windows 上 winget（App Installer）本身经常缺失，
  脚本改为直接从官方发布地址下载 zip 解到用户目录，不写系统目录、不需要管理员。

.PARAMETER BunVersion
  要安装的 Bun 版本，默认 1.4.4（与 CI 固定在同一个版本）。

.PARAMETER SkipInstall
  只做检查与报告，不下载、不安装、不改 PATH。

.PARAMETER SkipDeps
  跳过 `cd ts && bun install`。

.PARAMETER SkipDoctor
  跳过最后的 doctor 自检。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup.ps1

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup.ps1 -SkipInstall
#>
[CmdletBinding()]
param(
  [string]$BunVersion = '1.4.4',
  [switch]$SkipInstall,
  [switch]$SkipDeps,
  [switch]$SkipDoctor
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest 的进度条会拖慢几倍
# 本文件必须存成「UTF-8 with BOM」：Windows PowerShell 5.1 按 ANSI 读无 BOM 的脚本，
# 中文注释会让它整段报 UnexpectedToken。下面这行再兜一次控制台输出编码。
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$Root = Split-Path -Parent $PSScriptRoot
$BunDir = Join-Path $env:USERPROFILE '.bun\bin'
$BunExe = Join-Path $BunDir 'bun.exe'
$FfDir = Join-Path $env:LOCALAPPDATA 'Programs\ffmpeg\bin'
$FfExe = Join-Path $FfDir 'ffmpeg.exe'

$touched = New-Object System.Collections.Generic.List[string]
$failed = New-Object System.Collections.Generic.List[string]

function Write-Step([string]$text) { Write-Host "==> $text" -ForegroundColor Cyan }
function Write-Ok([string]$text) { Write-Host "    OK  $text" -ForegroundColor Green }
function Write-Warn2([string]$text) { Write-Host "    !   $text" -ForegroundColor Yellow }
function Write-Bad([string]$text) { Write-Host "    X   $text" -ForegroundColor Red }

function Get-ToolPath {
  param([string]$Name, [string[]]$Candidates)
  $cmd = Get-Command $Name -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  foreach ($c in $Candidates) { if (Test-Path $c) { return $c } }
  return $null
}

function Add-UserPath {
  param([string]$Dir)
  $cur = [Environment]::GetEnvironmentVariable('Path', 'User')
  $parts = @()
  if ($cur) { $parts = $cur -split ';' | Where-Object { $_ } }
  if ($parts -notcontains $Dir) {
    [Environment]::SetEnvironmentVariable('Path', (($parts + $Dir) -join ';'), 'User')
  }
  # 当前进程也要能看到，否则后面的 doctor 仍然判定缺失
  if (($env:PATH -split ';') -notcontains $Dir) { $env:PATH = "$Dir;$env:PATH" }
}

function Save-File {
  param([string]$Url, [string]$OutFile)
  Write-Host "    下载 $Url"
  Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing -TimeoutSec 900
}

# 工具可能是「装在用户目录但当前窗口 PATH 里没有」（刚装完、或旧终端没刷新）。
# 只认路径不够：后面 doctor 是子进程，继承的是 $env:PATH，必须把它补进去。
function Confirm-ProcessPath {
  param([string]$Exe)
  if (-not $Exe) { return }
  $dir = Split-Path -Parent $Exe
  if ($dir -and (($env:PATH -split ';') -notcontains $dir)) { $env:PATH = "$dir;$env:PATH" }
}

Write-Step "检查 Bun（项目主线运行时，版本 >= 1.4.4）"
$bun = Get-ToolPath -Name 'bun' -Candidates @($BunExe)
if ($bun) {
  Confirm-ProcessPath -Exe $bun
  $bunVersion = (& $bun --version) 2>&1 | Select-Object -First 1
  Write-Ok "Bun $bunVersion（$bun）"
} elseif ($SkipInstall) {
  Write-Bad '未找到 Bun（-SkipInstall 模式下不安装）'
  $failed.Add('Bun')
} else {
  Write-Warn2 "未找到 Bun，安装 $BunVersion 到 $BunDir"
  $zip = Join-Path $env:TEMP "bun-v$BunVersion-windows-x64.zip"
  $tmp = Join-Path $env:TEMP "vdacc-bun-$PID"
  Save-File -Url "https://github.com/oven-sh/bun/releases/download/bun-v$BunVersion/bun-windows-x64.zip" -OutFile $zip
  if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  New-Item -ItemType Directory -Force $BunDir | Out-Null
  $inner = Get-ChildItem $tmp -Recurse -Filter 'bun.exe' | Select-Object -First 1
  if (-not $inner) { throw "下载的 zip 里没有 bun.exe：$zip" }
  Copy-Item $inner.FullName $BunExe -Force
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  Add-UserPath -Dir $BunDir
  $bun = $BunExe
  Write-Ok "已安装 Bun $((& $bun --version) 2>&1 | Select-Object -First 1)（新终端才会继承 PATH，本窗口已临时生效）"
  $touched.Add('Bun')
}

Write-Step '检查 ffmpeg（B站 / YouTube 的 DASH 合并与「分析」都依赖它）'
$ff = Get-ToolPath -Name 'ffmpeg' -Candidates @($FfExe)
if ($ff) {
  Confirm-ProcessPath -Exe $ff
  $ffVer = (& $ff -version 2>&1 | Select-Object -First 1)
  Write-Ok $ffVer
} elseif ($SkipInstall) {
  Write-Bad '未找到 ffmpeg（-SkipInstall 模式下不安装）'
  $failed.Add('ffmpeg')
} else {
  Write-Warn2 "未找到 ffmpeg，安装到 $FfDir"
  $zip = Join-Path $env:TEMP 'ffmpeg-release-essentials.zip'
  $tmp = Join-Path $env:TEMP "vdacc-ffmpeg-$PID"
  Save-File -Url 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip' -OutFile $zip
  if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  $bin = Get-ChildItem $tmp -Recurse -Directory -Filter 'bin' | Select-Object -First 1
  if (-not $bin) { throw "下载的 zip 里没有 bin 目录：$zip" }
  New-Item -ItemType Directory -Force $FfDir | Out-Null
  Copy-Item (Join-Path $bin.FullName '*.exe') $FfDir -Force
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  Add-UserPath -Dir $FfDir
  $ff = $FfExe
  Write-Ok ((& $ff -version 2>&1 | Select-Object -First 1))
  $touched.Add('ffmpeg')
}

if ($bun) {
  try {
    $bunVer = [version](((& $bun --version) 2>&1 | Select-Object -First 1).Trim())
    if ($bunVer -lt [version]'1.4.4') {
      Write-Warn2 "Bun $bunVer 低于 1.4.4，CI 与基线都按 1.4.4 固定；删掉 $BunExe 后重跑本脚本可换到 $BunVersion"
    }
  } catch { Write-Warn2 'Bun 版本号读不出来，跳过版本比较' }
}

if ($bun -and -not $SkipDeps) {
  Write-Step '安装 ts 依赖（playwright-core / qrcode，不下载浏览器）'
  Push-Location (Join-Path $Root 'ts')
  try {
    & $bun install
    if ($LASTEXITCODE -ne 0) { throw "bun install 失败（退出码 $LASTEXITCODE）" }
    Write-Ok 'ts/node_modules 就绪'
  } finally {
    Pop-Location
  }
}

if ($bun -and -not $SkipDoctor) {
  Write-Step 'doctor 自检'
  Push-Location $Root
  try {
    & $bun 'ts/src/cli.ts' doctor
    $code = $LASTEXITCODE
  } finally {
    Pop-Location
  }
}

Write-Host ''
Write-Step '汇总'
if ($touched.Count -gt 0) {
  Write-Host "    本次安装：$($touched -join ', ')"
  Write-Host '    这些目录已写入用户 PATH，但**已经开着的终端不会刷新**——请新开一个窗口再跑 bun。' -ForegroundColor Yellow
}
if ($failed.Count -gt 0) {
  Write-Bad "仍然缺少：$($failed -join ', ')"
  Write-Host '    去掉 -SkipInstall 重跑一次即可自动安装。'
  exit 1
}
if (-not $SkipDoctor -and $code) {
  Write-Bad "doctor 报告阻塞项（退出码 $code），按上面每条后面的 → 处理"
  exit $code
}
Write-Host '    环境可用。首次使用前还需要登录凭据（游客档也能下，但会员档位要登录）：'
Write-Host '      bun ts/src/cli.ts auth bilibili    # B站：4K / Hi-Res / 字幕 / 弹幕'
Write-Host '      bun ts/src/cli.ts auth netease     # 网易云：黑胶无损'
Write-Host '      bun ts/src/cli.ts auth qq          # QQ 音乐：会员档位'
exit 0
