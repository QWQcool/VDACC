<#
.SYNOPSIS
  VDACC 环境准备：检查 / 安装 Bun、ffmpeg、Python，装好 ts 依赖，最后跑一次 doctor。

.DESCRIPTION
  复原快照、换新机器或重装系统后，仓库里只有源码——Bun、ffmpeg、Python、ts/node_modules
  本来就不入库，这时 `bun ts/src/cli.ts` 会直接报「无法识别 bun」。
  这个脚本把所有步骤收敛成一条命令，缺什么装什么，装完给出可读的结论。

  安装方式刻意不依赖 winget：Windows 上 winget（App Installer）本身经常缺失，
  脚本改为直接从官方发布地址下载、装到用户目录，不写系统目录、不需要管理员。

.PARAMETER BunVersion
  要安装的 Bun 版本，默认 1.4.4（与 CI 固定在同一个版本）。

.PARAMETER PythonVersion
  要安装的 Python 版本，默认 3.12.10。主线（Bun）不需要它，
  但 `tools/build_skill_ts.py`、`tools/release_baseline.cjs` 与 legacy 归档版要。

.PARAMETER WithLegacy
  额外建 `venv/` 并装 legacy 依赖（playwright + yt-dlp，约 46MB），最后跑一次 legacy 的 doctor。
  只跑主线（Bun）时不需要它。

.PARAMETER SkipInstall
  只做检查与报告，不下载、不安装、不改 PATH。

.PARAMETER SkipDeps
  跳过 `cd ts && bun install`（以及 `-WithLegacy` 时的 pip install）。

.PARAMETER SkipDoctor
  跳过最后的 doctor 自检（主线与 legacy 都不跑）。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup.ps1

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup.ps1 -WithLegacy

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup.ps1 -SkipInstall
#>
[CmdletBinding()]
param(
  [string]$BunVersion = '1.4.4',
  [string]$PythonVersion = '3.12.10',
  [switch]$WithLegacy,
  [switch]$SkipInstall,
  [switch]$SkipDeps,
  [switch]$SkipDoctor
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest 的进度条会拖慢几倍
# 本文件必须存成「UTF-8 with BOM」：Windows PowerShell 5.1 按 ANSI 读无 BOM 的脚本，
# 中文注释会让它整段报 UnexpectedToken。下面这行再兜一次控制台输出编码。
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
# 子进程 Python 也要说 UTF-8：否则 legacy 的 doctor / pip 在中文 Windows 上按 GBK 输出，
# 到这里就变成一片「锟斤拷」。PYTHONUTF8 是 Python 3.7+ 的 UTF-8 模式开关。
$env:PYTHONIOENCODING = 'utf-8'
$env:PYTHONUTF8 = '1'

$Root = Split-Path -Parent $PSScriptRoot
$BunDir = Join-Path $env:USERPROFILE '.bun\bin'
$BunExe = Join-Path $BunDir 'bun.exe'
$FfDir = Join-Path $env:LOCALAPPDATA 'Programs\ffmpeg\bin'
$FfExe = Join-Path $FfDir 'ffmpeg.exe'
# 3.12.10 → Python312（Python 安装器就是这么命名目录的）
$PyTag = 'Python' + ((($PythonVersion -split '\.')[0..1]) -join '')
$PyRoot = Join-Path $env:LOCALAPPDATA "Programs\Python\$PyTag"
$PyExe = Join-Path $PyRoot 'python.exe'

$touched = New-Object System.Collections.Generic.List[string]
$failed = New-Object System.Collections.Generic.List[string]
$code = 0
$legacyCode = 0

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

# Windows 上的 `python.exe` 可能是 Microsoft Store 的占位别名：能解析到路径，
# 但一执行就提示「去商店安装」。所以认到路径之后必须**真的跑一次 --version**。
function Test-Python {
  param([string]$Exe)
  if (-not $Exe -or -not (Test-Path $Exe)) { return $false }
  try {
    $out = (& $Exe --version 2>&1) -join ' '
    return ($out -match 'Python 3\.')
  } catch { return $false }
}

Write-Step '检查 Python（构建 Skill / 刷新发布基线 / legacy 需要；主线 Bun 本身不需要）'
$py = $null
if (Test-Python -Exe $PyExe) {
  $py = $PyExe
} else {
  $cmd = Get-Command python -ErrorAction SilentlyContinue
  if ($cmd -and (Test-Python -Exe $cmd.Source)) { $py = $cmd.Source }
}
if ($py) {
  Confirm-ProcessPath -Exe $py
  Write-Ok ((& $py --version 2>&1) -join ' ')
} elseif ($SkipInstall) {
  Write-Bad '未找到可用的 Python（-SkipInstall 模式下不安装）'
  $failed.Add('Python')
} else {
  Write-Warn2 "未找到可用的 Python，安装 $PythonVersion 到 $PyRoot"
  $exe = Join-Path $env:TEMP "python-$PythonVersion-amd64.exe"
  Save-File -Url "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-amd64.exe" -OutFile $exe
  # 不给 PrependPath：不擅自改动用户已有 PATH 的顺序；下面自己把两个目录补到末尾
  $proc = Start-Process -FilePath $exe -ArgumentList '/quiet', 'InstallAllUsers=0', 'Include_launcher=1', 'Include_test=0', 'Include_pip=1' -Wait -PassThru
  if ($proc.ExitCode -ne 0) { throw "Python 安装失败（退出码 $($proc.ExitCode)）" }
  if (-not (Test-Path $PyExe)) { throw "安装完成但找不到 $PyExe（版本目录名可能与预期不同）" }
  Add-UserPath -Dir $PyRoot
  Add-UserPath -Dir (Join-Path $PyRoot 'Scripts')
  $py = $PyExe
  Write-Ok ((& $py --version 2>&1) -join ' ')
  $touched.Add('Python')
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

# legacy（Python 归档版）是可选的：主线、Skill、发布基线都不需要它。
# 但它是唯一能用 yt-dlp 跑「其它站点」的实现，验证历史行为时要跑，所以留一个开关。
if ($WithLegacy) {
  Write-Step '准备 legacy 归档版（venv + playwright / yt-dlp）'
  $venvDir = Join-Path $Root 'venv'
  $venvPy = Join-Path $venvDir 'Scripts\python.exe'
  if (-not $py) {
    Write-Bad '没有可用的 Python，无法创建 venv'
    $failed.Add('venv')
  } elseif (-not (Test-Path $venvPy)) {
    & $py -m venv $venvDir
    if ($LASTEXITCODE -ne 0) { throw "创建 venv 失败（退出码 $LASTEXITCODE）" }
    Write-Ok "已创建 venv（$venvPy）"
    $touched.Add('venv')
  } else {
    Write-Ok "venv 已存在（$((& $venvPy --version) -join ' ')）"
  }

  if ((Test-Path $venvPy) -and -not $SkipDeps) {
    & $venvPy -m pip install -q --disable-pip-version-check -r (Join-Path $Root 'requirements.txt')
    if ($LASTEXITCODE -ne 0) { throw "pip install 失败（退出码 $LASTEXITCODE）" }
    Write-Ok 'legacy 依赖就绪（yt-dlp / playwright）'
  }

  if ((Test-Path $venvPy) -and -not $SkipDoctor) {
    Write-Step 'legacy doctor 自检'
    Push-Location (Join-Path $Root 'legacy\python')
    try {
      & $venvPy -m vdl doctor
      $legacyCode = $LASTEXITCODE
    } finally {
      Pop-Location
    }
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
if (-not $SkipDoctor -and $legacyCode) {
  Write-Bad "legacy doctor 报告阻塞项（退出码 $legacyCode）"
  exit $legacyCode
}
Write-Host '    环境可用。首次使用前还需要登录凭据（游客档也能下，但会员档位要登录）：'
Write-Host '      bun ts/src/cli.ts auth bilibili    # B站：4K / Hi-Res / 字幕 / 弹幕'
Write-Host '      bun ts/src/cli.ts auth netease     # 网易云：黑胶无损'
Write-Host '      bun ts/src/cli.ts auth qq          # QQ 音乐：会员档位'
if (-not $WithLegacy) {
  Write-Host '    legacy（Python 归档版）没有准备；需要时加 -WithLegacy 重跑一次。' -ForegroundColor DarkGray
}
exit 0
