param(
  [Parameter(Mandatory = $true)]
  [string]$ProjectRoot
)

$ErrorActionPreference = "Continue"
$ProjectRoot = (Resolve-Path $ProjectRoot).Path

$global:problems = @()
$global:warnings = @()

function Mark-Ok {
  param([string]$Message)
  Write-Host "[OK]   $Message" -ForegroundColor Green
}

function Mark-Warn {
  param([string]$Message, [string]$Hint = "")
  Write-Host "[WARN] $Message" -ForegroundColor Yellow
  if ($Hint) {
    Write-Host "       $Hint" -ForegroundColor Yellow
  }
  $global:warnings += $Message
}

function Mark-Fail {
  param([string]$Message, [string]$Hint = "")
  Write-Host "[FAIL] $Message" -ForegroundColor Red
  if ($Hint) {
    Write-Host "       $Hint" -ForegroundColor Red
  }
  $global:problems += $Message
}

function Check-Section {
  param([string]$Title)
  Write-Host ""
  Write-Host "== $Title ==" -ForegroundColor Cyan
}

function Get-VenvPython {
  param([string]$Dir)
  return Join-Path $Dir ".venv\Scripts\python.exe"
}

function Test-VenvUsable {
  param([string]$Python)
  if (-not (Test-Path $Python)) { return $false }
  try {
    $versionOutput = & $Python -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')" 2>$null
    $parts = $versionOutput.Split(".")
    if ($parts.Length -lt 2) { return $false }
    $major = [int]$parts[0]
    $minor = [int]$parts[1]
    return ($major -eq 3 -and $minor -ge 11 -and $minor -le 13)
  } catch {
    return $false
  }
}

function Test-PythonModule {
  param([string]$Python, [string]$Module)
  if (-not (Test-Path $Python)) { return $false }
  $oldErr = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    & $Python -c "import $Module" *> $null
  } finally {
    $ErrorActionPreference = $oldErr
  }
  return ($LASTEXITCODE -eq 0)
}

Write-Host "Yandex Live Subtitles Translator - doctor"
Write-Host "Project: $ProjectRoot"

# Python on PATH
Check-Section "Python"
$pythonOnPath = Get-Command python -ErrorAction SilentlyContinue
$pyLauncher = Get-Command py -ErrorAction SilentlyContinue
if ($pythonOnPath) {
  $version = & $pythonOnPath.Source -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')" 2>$null
  if ($version -match '^3\.(11|12|13)$') {
    Mark-Ok "Python $version on PATH: $($pythonOnPath.Source)"
  } else {
    Mark-Warn "Python on PATH is $version (need 3.11-3.13)" "Project needs Python 3.11, 3.12 or 3.13. Python 3.14 not yet supported."
  }
} elseif ($pyLauncher) {
  Mark-Ok "py launcher available: $($pyLauncher.Source)"
} else {
  Mark-Fail "Python not found" "Install Python 3.13 from https://www.python.org/downloads/ and check 'Add to PATH'."
}

# Translator venv
Check-Section "Translator server venv"
$translatorDir = Join-Path $ProjectRoot "translator-server"
$translatorPy = Get-VenvPython $translatorDir
if (Test-Path $translatorPy) {
  if (Test-VenvUsable $translatorPy) {
    Mark-Ok "Translator venv exists and is usable"
    $modules = @("fastapi","uvicorn","httpx","pydantic","yaml","cachetools")
    $missing = @()
    foreach ($m in $modules) {
      if (-not (Test-PythonModule $translatorPy $m)) { $missing += $m }
    }
    if ($missing.Count -eq 0) {
      Mark-Ok ("Required modules present: " + ($modules -join ", "))
    } else {
      Mark-Fail ("Missing modules in translator venv: " + ($missing -join ", ")) "Run setup_windows.bat to reinstall requirements."
    }
  } else {
    Mark-Fail "Translator venv unusable (wrong Python version)" "Delete translator-server\.venv and run setup_windows.bat."
  }
} else {
  Mark-Fail "Translator venv missing" "Run setup_windows.bat to create it."
}

# CDP reader venv
Check-Section "CDP reader venv"
$cdpDir = Join-Path $ProjectRoot "subtitle-cdp-reader"
$cdpPy = Get-VenvPython $cdpDir
if (Test-Path $cdpPy) {
  if (Test-VenvUsable $cdpPy) {
    Mark-Ok "CDP venv exists and is usable"
    $modules = @("fastapi","uvicorn","httpx","websockets")
    $missing = @()
    foreach ($m in $modules) {
      if (-not (Test-PythonModule $cdpPy $m)) { $missing += $m }
    }
    if ($missing.Count -eq 0) {
      Mark-Ok ("Required modules present: " + ($modules -join ", "))
    } else {
      Mark-Fail ("Missing modules in CDP venv: " + ($missing -join ", ")) "Run setup_windows.bat to reinstall requirements."
    }
  } else {
    Mark-Fail "CDP venv unusable (wrong Python version)" "Delete subtitle-cdp-reader\.venv and run setup_windows.bat."
  }
} else {
  Mark-Fail "CDP venv missing" "Run setup_windows.bat to create it."
}

# Config files
Check-Section "Config files"
$localConfig = Join-Path $ProjectRoot "config.local.ps1"
if (Test-Path $localConfig) {
  Mark-Ok "config.local.ps1 exists"
} else {
  Mark-Warn "config.local.ps1 missing" "Will be auto-created from example on next run."
}

$translatorConfig = Join-Path $translatorDir "config.yaml"
if (Test-Path $translatorConfig) {
  Mark-Ok "translator-server\config.yaml exists"
} else {
  Mark-Warn "translator-server\config.yaml missing" "Will be auto-created from example on next run."
}

# Ollama
Check-Section "Ollama"
$ollamaExe = $null
$cmd = Get-Command ollama -ErrorAction SilentlyContinue
if ($cmd) { $ollamaExe = $cmd.Source }
if (-not $ollamaExe) {
  $candidates = @(
    "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe",
    "$env:ProgramFiles\Ollama\ollama.exe",
    "${env:ProgramFiles(x86)}\Ollama\ollama.exe"
  )
  foreach ($c in $candidates) {
    if ($c -and (Test-Path $c)) { $ollamaExe = $c; break }
  }
}
if ($ollamaExe) {
  Mark-Ok "Ollama found: $ollamaExe"
  $models = & $ollamaExe list 2>$null
  if ($LASTEXITCODE -eq 0 -and $models) {
    $modelText = ($models -join "`n")
    if ($modelText -match "translategemma:12b") {
      Mark-Ok "Model translategemma:12b is downloaded"
    } else {
      Mark-Warn "Model translategemma:12b is NOT downloaded" "Run: ollama pull translategemma:12b   (about 7 GB)"
    }
  } else {
    Mark-Warn "Ollama not running or cannot list models" "It will start automatically when you run run_all_servers.bat."
  }
} else {
  Mark-Fail "Ollama not found" "Install from https://ollama.com/download then run setup_windows.bat again."
}

# Yandex Browser
Check-Section "Yandex Browser"
$yandexExe = $null
$candidates = @(
  "$env:LOCALAPPDATA\Yandex\YandexBrowser\Application\browser.exe",
  "$env:ProgramFiles\Yandex\YandexBrowser\Application\browser.exe",
  "${env:ProgramFiles(x86)}\Yandex\YandexBrowser\Application\browser.exe"
)
foreach ($c in $candidates) {
  if ($c -and (Test-Path $c)) { $yandexExe = $c; break }
}
if ($yandexExe) {
  Mark-Ok "Yandex Browser found: $yandexExe"
} else {
  Mark-Fail "Yandex Browser not found" "Install from https://browser.yandex.ru or set YandexBrowserPath in config.local.ps1."
}

# Ports
Check-Section "Ports"
foreach ($pair in @(@(8765,"translator-server"), @(8766,"cdp-reader"), @(9222,"yandex cdp"))) {
  $port = $pair[0]
  $name = $pair[1]
  $listening = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  if ($listening) {
    $pidValue = $listening[0].OwningProcess
    $procName = (Get-Process -Id $pidValue -ErrorAction SilentlyContinue).ProcessName
    Mark-Ok "Port $port ($name): busy by PID $pidValue ($procName)"
  } else {
    Mark-Ok "Port $port ($name): free"
  }
}

# Extension files
Check-Section "Browser extension"
$extDir = Join-Path $ProjectRoot "extension"
$manifest = Join-Path $extDir "manifest.json"
if (Test-Path $manifest) {
  Mark-Ok "extension\manifest.json present"
  $expected = @("src\content.js","src\segmenter.js","src\translator-client.js","src\overlay.js","src\settings.js","options\options.html","options\options.js")
  $missing = @()
  foreach ($f in $expected) {
    if (-not (Test-Path (Join-Path $extDir $f))) { $missing += $f }
  }
  if ($missing.Count -eq 0) {
    Mark-Ok "All extension source files present"
  } else {
    Mark-Fail ("Missing extension files: " + ($missing -join ", ")) "Re-copy the extension folder from a working install."
  }
} else {
  Mark-Fail "extension\manifest.json missing" "Re-copy the extension folder from a working install."
}

# Logs dir
Check-Section "Logs"
$logsDir = Join-Path $ProjectRoot "logs"
if (Test-Path $logsDir) {
  $logFiles = Get-ChildItem $logsDir -Filter "*.jsonl" -ErrorAction SilentlyContinue
  Mark-Ok ("logs\ exists, translation log files: " + $logFiles.Count)
  $totalMb = [math]::Round((Get-ChildItem $logsDir -Recurse -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum / 1MB, 1)
  if ($totalMb -gt 200) {
    Mark-Warn "logs\ folder is $totalMb MB" "Run cleanup.bat to delete old logs."
  }
} else {
  Mark-Ok "logs\ will be created on first run"
}

# Summary
Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
if ($problems.Count -eq 0 -and $warnings.Count -eq 0) {
  Write-Host "All good. You can run: run_all_servers.bat" -ForegroundColor Green
} elseif ($problems.Count -eq 0) {
  Write-Host ("Ready to run, but " + $warnings.Count + " warning(s) above. Translation will work.") -ForegroundColor Yellow
} else {
  Write-Host ("PROBLEMS: " + $problems.Count + ". Fix them, then run doctor.bat again.") -ForegroundColor Red
  foreach ($p in $problems) { Write-Host "  - $p" -ForegroundColor Red }
}
Write-Host "============================================" -ForegroundColor Cyan
