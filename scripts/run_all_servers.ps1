param(
  [Parameter(Mandatory = $true)]
  [string]$ProjectRoot,

  [Parameter(Mandatory = $true)]
  [string]$ConfigPath,

  [Parameter(Mandatory = $true)]
  [string]$TranslatorDir,

  [Parameter(Mandatory = $true)]
  [string]$TranslatorPython,

  [Parameter(Mandatory = $true)]
  [string]$CdpDir,

  [Parameter(Mandatory = $true)]
  [string]$CdpPython
)

$ErrorActionPreference = "Stop"
$ProjectRoot = (Resolve-Path $ProjectRoot).Path
$ConfigPath = (Resolve-Path $ConfigPath).Path
$logsDir = Join-Path $ProjectRoot "logs"
$processes = @()
$startedYandex = $false
$config = $null

if (-not (Test-Path $logsDir)) {
  New-Item -ItemType Directory -Path $logsDir | Out-Null
}

function Load-ProjectConfig {
  . $ConfigPath
  if (-not $ProjectConfig) {
    throw "config.local.ps1 must define `$ProjectConfig hashtable."
  }
  $defaults = @{
    OllamaModelsPath = ""
    OllamaExe = ""
    YandexBrowserPath = ""
    DefaultOllamaModel = "translategemma:12b"
    TranslatorPort = 8765
    CdpReaderPort = 8766
    YandexDebugPort = 9222
    AutoCloseYandex = $false
  }
  foreach ($key in $defaults.Keys) {
    if (-not $ProjectConfig.ContainsKey($key) -or $null -eq $ProjectConfig[$key] -or $ProjectConfig[$key] -eq "") {
      $ProjectConfig[$key] = $defaults[$key]
    }
  }
  return $ProjectConfig
}

function Stop-PortOwner {
  param([int]$Port)

  $connections = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  foreach ($connection in $connections) {
    if ($connection.OwningProcess -and $connection.OwningProcess -ne $PID) {
      Write-Host "Stopping existing process on port $Port, PID $($connection.OwningProcess) ..."
      Stop-Process -Id $connection.OwningProcess -Force -ErrorAction SilentlyContinue
      Start-Sleep -Milliseconds 300
    }
  }
}

function Find-YandexBrowser {
  if ($config.YandexBrowserPath -and (Test-Path $config.YandexBrowserPath)) {
    return $config.YandexBrowserPath
  }

  $candidates = @(
    "$env:LOCALAPPDATA\Yandex\YandexBrowser\Application\browser.exe",
    "$env:ProgramFiles\Yandex\YandexBrowser\Application\browser.exe",
    "${env:ProgramFiles(x86)}\Yandex\YandexBrowser\Application\browser.exe"
  )

  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path $candidate)) {
      return $candidate
    }
  }

  $command = Get-Command browser.exe -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }

  return $null
}

function Find-Ollama {
  if ($config.OllamaExe -and (Test-Path $config.OllamaExe)) {
    return $config.OllamaExe
  }

  $command = Get-Command ollama -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }

  $candidates = @(
    "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe",
    "$env:ProgramFiles\Ollama\ollama.exe",
    "${env:ProgramFiles(x86)}\Ollama\ollama.exe"
  )

  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path $candidate)) {
      return $candidate
    }
  }

  return $null
}

function Test-PortListening {
  param([int]$Port)
  return [bool](Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}

function Wait-PortListening {
  param(
    [int]$Port,
    [int]$TimeoutSec = 8
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    if (Test-PortListening -Port $Port) {
      return $true
    }
    Start-Sleep -Milliseconds 300
  }
  return $false
}

function Test-HttpJson {
  param(
    [string]$Url,
    [int]$TimeoutSec = 3
  )

  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec $TimeoutSec
    return @{ Ok = $true; Body = $response.Content }
  } catch {
    return @{ Ok = $false; Body = $_.Exception.Message }
  }
}

function Test-PythonModule {
  param(
    [string]$Python,
    [string]$Module
  )

  $oldErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    & $Python -c "import $Module" *> $null
  } finally {
    $ErrorActionPreference = $oldErrorActionPreference
  }
  return ($LASTEXITCODE -eq 0)
}

function Ensure-PythonRequirements {
  param(
    [string]$Python,
    [string]$Dir,
    [string]$Requirements,
    [string[]]$Modules,
    [string]$Name
  )

  foreach ($module in $Modules) {
    if (-not (Test-PythonModule -Python $Python -Module $module)) {
      Write-Host "$Name dependency '$module' is missing. Installing requirements..."
      & $Python -m pip install -r (Join-Path $Dir $Requirements)
      if ($LASTEXITCODE -ne 0) {
        throw "Failed to install requirements for $Name. Run setup_windows.bat and check pip output."
      }
      break
    }
  }

  foreach ($module in $Modules) {
    if (-not (Test-PythonModule -Python $Python -Module $module)) {
      throw "$Name dependency '$module' is still missing after install. Run setup_windows.bat and check pip output."
    }
  }
}

function Show-LogTail {
  param(
    [string]$Path,
    [int]$Lines = 80
  )

  if (-not $Path -or -not (Test-Path $Path)) {
    return
  }
  Write-Host ""
  Write-Host "--- log tail: $Path ---"
  Get-Content -Path $Path -Tail $Lines -ErrorAction SilentlyContinue
  Write-Host "--- end log ---"
}

function Get-YandexProcesses {
  return Get-Process -ErrorAction SilentlyContinue | Where-Object {
    $_.ProcessName -eq "browser" -and $_.Path -like "*\Yandex\YandexBrowser\*"
  }
}

function Start-YandexWithCdp {
  $browserPath = Find-YandexBrowser
  if (-not $browserPath) {
    Write-Host "ERROR: Yandex Browser not found."
    Write-Host "Fix: install Yandex Browser or set YandexBrowserPath in config.local.ps1."
    return
  }

  $debugPort = [int]$config.YandexDebugPort

  if (Test-PortListening -Port $debugPort) {
    Write-Host "Yandex CDP port $debugPort is already open."
    return
  }

  $runningYandex = Get-YandexProcesses
  if ($runningYandex) {
    Write-Host ""
    Write-Host "Yandex Browser is already running without CDP port $debugPort."
    Write-Host "CDP subtitles cannot work until Yandex is restarted with the debug port."
    Write-Host "Running Yandex processes: $($runningYandex.Count)"
    if (-not $config.AutoCloseYandex) {
      $answer = Read-Host "Close all Yandex Browser windows now and restart with CDP? Type Y to continue"
      if ($answer -notin @("Y", "y", "Yes", "yes")) {
        Write-Host "Yandex was not restarted. CDP reader will return 503 until port $debugPort is open."
        return
      }
    }

    foreach ($proc in $runningYandex) {
      Write-Host "Stopping Yandex PID $($proc.Id) ..."
      Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    }

    $deadline = (Get-Date).AddSeconds(10)
    while ((Get-YandexProcesses) -and (Get-Date) -lt $deadline) {
      Start-Sleep -Milliseconds 300
    }
  }

  Write-Host "Starting Yandex Browser with CDP port $debugPort ..."
  Start-Process -FilePath $browserPath -ArgumentList @("--remote-debugging-address=127.0.0.1", "--remote-debugging-port=$debugPort") | Out-Null
  $script:startedYandex = $true

  if (Wait-PortListening -Port $debugPort -TimeoutSec 10) {
    Write-Host "Yandex CDP is ready: http://127.0.0.1:$debugPort/json"
  } else {
    Write-Host "WARNING: Yandex was started, but CDP port $debugPort did not open."
    Write-Host "Close all Yandex windows and run this launcher again."
  }
}

function Stop-Servers {
  foreach ($proc in $processes) {
    if ($null -ne $proc -and -not $proc.HasExited) {
      Write-Host "Stopping PID $($proc.Id) ..."
      Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    }
  }

  if ($startedYandex) {
    $connections = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort ([int]$config.YandexDebugPort) -State Listen -ErrorAction SilentlyContinue
    foreach ($connection in $connections) {
      if ($connection.OwningProcess) {
        Write-Host "Stopping Yandex CDP process PID $($connection.OwningProcess) ..."
        Stop-Process -Id $connection.OwningProcess -Force -ErrorAction SilentlyContinue
      }
    }
  }
}

try {
  $config = Load-ProjectConfig
  $translatorPort = [int]$config.TranslatorPort
  $cdpPort = [int]$config.CdpReaderPort
  $debugPort = [int]$config.YandexDebugPort

  Write-Host "Project: $ProjectRoot"
  Write-Host "Config: $ConfigPath"
  Write-Host "Translator: http://127.0.0.1:$translatorPort"
  Write-Host "CDP reader: http://127.0.0.1:$cdpPort"
  Write-Host "Yandex CDP: http://127.0.0.1:$debugPort/json"
  Write-Host ""

  Stop-PortOwner -Port $translatorPort
  Stop-PortOwner -Port $cdpPort

  Ensure-PythonRequirements `
    -Python $TranslatorPython `
    -Dir $TranslatorDir `
    -Requirements "requirements.txt" `
    -Modules @("uvicorn", "fastapi", "httpx", "pydantic", "yaml", "cachetools") `
    -Name "translator-server"

  Ensure-PythonRequirements `
    -Python $CdpPython `
    -Dir $CdpDir `
    -Requirements "requirements.txt" `
    -Modules @("uvicorn", "fastapi", "httpx", "websockets") `
    -Name "cdp-reader"

  Start-YandexWithCdp

  $ollamaRunning = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -eq "ollama" }
  if (-not $ollamaRunning) {
    $ollamaPath = Find-Ollama
    if ($ollamaPath) {
      if ($config.OllamaModelsPath) {
        $env:OLLAMA_MODELS = $config.OllamaModelsPath
      } else {
        $modelsPath = [Environment]::GetEnvironmentVariable("OLLAMA_MODELS", "User")
        if ($modelsPath) {
          $env:OLLAMA_MODELS = $modelsPath
        }
      }
      Write-Host "Starting Ollama ..."
      $ollama = Start-Process -FilePath $ollamaPath -ArgumentList @("serve") -NoNewWindow -PassThru
      $processes += $ollama
      Start-Sleep -Seconds 3
    } else {
      Write-Host "WARNING: Ollama command not found."
      Write-Host "Fix: install Ollama or set OllamaExe in config.local.ps1."
    }
  } elseif ($config.OllamaModelsPath) {
    Write-Host "WARNING: Ollama is already running."
    Write-Host "OLLAMA_MODELS changes cannot apply to an already-running Ollama server."
    Write-Host "If models are not found, close Ollama and run this launcher again."
  }

  $translatorArgs = @("-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "$translatorPort")
  $cdpArgs = @("-m", "uvicorn", "server:app", "--host", "127.0.0.1", "--port", "$cdpPort")
  $env:YA_CDP_URL = "http://127.0.0.1:$debugPort"

  $translatorOut = Join-Path $logsDir "translator-server.out.log"
  $translatorErr = Join-Path $logsDir "translator-server.err.log"
  $cdpOut = Join-Path $logsDir "cdp-reader.out.log"
  $cdpErr = Join-Path $logsDir "cdp-reader.err.log"

  foreach ($log in @($translatorOut, $translatorErr, $cdpOut, $cdpErr)) {
    if (Test-Path $log) {
      Remove-Item -LiteralPath $log -Force -ErrorAction SilentlyContinue
    }
  }

  $translator = Start-Process -FilePath $TranslatorPython -ArgumentList $translatorArgs -WorkingDirectory $TranslatorDir -NoNewWindow -PassThru -RedirectStandardOutput $translatorOut -RedirectStandardError $translatorErr
  $processes += $translator

  $cdp = Start-Process -FilePath $CdpPython -ArgumentList $cdpArgs -WorkingDirectory $CdpDir -NoNewWindow -PassThru -RedirectStandardOutput $cdpOut -RedirectStandardError $cdpErr
  $processes += $cdp

  Write-Host "Translator PID: $($translator.Id)"
  Write-Host "CDP reader PID: $($cdp.Id)"
  Write-Host "Translator logs:"
  Write-Host "  $translatorOut"
  Write-Host "  $translatorErr"
  Write-Host "CDP reader logs:"
  Write-Host "  $cdpOut"
  Write-Host "  $cdpErr"

  $translatorReady = $false
  $cdpReady = $false
  $yandexReady = $false

  if (Wait-PortListening -Port $translatorPort -TimeoutSec 10) {
    $health = Test-HttpJson -Url "http://127.0.0.1:$translatorPort/health"
    if ($health.Ok) {
      Write-Host "Translator health: OK"
      $translatorReady = $true
    } else {
      Write-Host "Translator health: FAILED - $($health.Body)"
    }
  } else {
    Write-Host "Translator port: NOT OPEN. Check Python errors above."
    Show-LogTail -Path $translatorErr
    Show-LogTail -Path $translatorOut
  }

  if (Wait-PortListening -Port $cdpPort -TimeoutSec 10) {
    $health = Test-HttpJson -Url "http://127.0.0.1:$cdpPort/health"
    if ($health.Ok) {
      Write-Host "CDP reader health: $($health.Body)"
      $cdpReady = $true
    } else {
      Write-Host "CDP reader health: FAILED - $($health.Body)"
    }
  } else {
    Write-Host "CDP reader port: NOT OPEN. Check Python errors above."
  }

  if (Test-PortListening -Port $debugPort) {
    Write-Host "Yandex CDP port: ready on http://127.0.0.1:$debugPort/json"
    $yandexReady = $true
  } else {
    Write-Host "Yandex CDP port: NOT OPEN. Close Yandex and restart this launcher."
  }

  Write-Host ""
  Write-Host "== READY =="
  $translatorStatus = if ($translatorReady) { "OK" } else { "FAILED" }
  $cdpStatus = if ($cdpReady) { "OK" } else { "FAILED" }
  $yandexStatus = if ($yandexReady) { "OK" } else { "FAILED" }
  Write-Host "Translator API: http://127.0.0.1:$translatorPort  [$translatorStatus]"
  Write-Host "Translator health: http://127.0.0.1:$translatorPort/health"
  Write-Host "CDP reader API: http://127.0.0.1:$cdpPort  [$cdpStatus]"
  Write-Host "CDP reader health: http://127.0.0.1:$cdpPort/health"
  Write-Host "Yandex CDP: http://127.0.0.1:$debugPort/json  [$yandexStatus]"
  Write-Host "Overlay URL: http://127.0.0.1:$translatorPort/overlay?font_size=42&bottom=7&max_width=88&opacity=0.72&hide_after_ms=6000"
  Write-Host "Logs: $logsDir"
  Write-Host "Keep this window open. Close it or press Ctrl+C to stop."
  Write-Host ""

  while ($true) {
    Start-Sleep -Seconds 1
    foreach ($proc in $processes) {
      if ($proc.HasExited) {
        $exitCode = $proc.ExitCode
        if ($null -eq $exitCode) {
          $exitCode = "unknown"
        }
        if ($proc.Id -eq $translator.Id) {
          Show-LogTail -Path $translatorErr
          Show-LogTail -Path $translatorOut
        } elseif ($proc.Id -eq $cdp.Id) {
          Show-LogTail -Path $cdpErr
          Show-LogTail -Path $cdpOut
        }
        throw "Process PID $($proc.Id) exited with code $exitCode."
      }
    }
  }
}
finally {
  Stop-Servers
}
