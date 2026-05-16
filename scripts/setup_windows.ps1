param(
  [Parameter(Mandatory = $true)]
  [string]$ProjectRoot
)

$ErrorActionPreference = "Stop"
$ProjectRoot = (Resolve-Path $ProjectRoot).Path
$configExamplePath = Join-Path $ProjectRoot "config.local.example.ps1"
$configPath = Join-Path $ProjectRoot "config.local.ps1"
$translatorDir = Join-Path $ProjectRoot "translator-server"
$cdpDir = Join-Path $ProjectRoot "subtitle-cdp-reader"

function Write-Step {
  param([string]$Message)
  Write-Host ""
  Write-Host "== $Message =="
}

function Load-ProjectConfig {
  if (-not (Test-Path $configPath)) {
    Copy-Item $configExamplePath $configPath
    Write-Host "Created config.local.ps1 from example."
  }

  . $configPath
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

function Find-Python {
  $python = Get-Command py -ErrorAction SilentlyContinue
  if ($python) {
    foreach ($version in @("3.13", "3.12", "3.11")) {
      try {
        $versionOutput = & $python.Source @("-$version", "-c", "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')") 2>$null
        if ($versionOutput -eq $version) {
          return @{ Command = $python.Source; Args = @("-$version") }
        }
      } catch {
        Write-Host "Python launcher does not have Python $version runtime."
      }
    }
  }

  $python = Get-Command python -ErrorAction SilentlyContinue
  if ($python) {
    $versionOutput = & $python.Source -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"
    $parts = $versionOutput.Split(".")
    $major = [int]$parts[0]
    $minor = [int]$parts[1]
    if ($major -ne 3 -or $minor -lt 11 -or $minor -gt 13) {
      throw "Python 3.11-3.13 is required. Found Python $versionOutput. Python 3.14 is not supported by current pydantic-core wheels. Install Python 3.13 or 3.11, then run setup_windows.bat again."
    }
    return @{ Command = $python.Source; Args = @() }
  }

  throw "Python 3.11-3.13 not found. Install Python 3.13 or 3.11, then run setup_windows.bat again."
}

function Ensure-Venv {
  param(
    [string]$Dir,
    [string]$Requirements
  )

  $venvDir = Join-Path $Dir ".venv"
  $venvPython = Join-Path $Dir ".venv\Scripts\python.exe"
  $needsCreate = $true

  if (Test-Path $venvPython) {
    try {
      $versionOutput = & $venvPython -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"
      $parts = $versionOutput.Split(".")
      $major = [int]$parts[0]
      $minor = [int]$parts[1]
      if ($major -eq 3 -and $minor -ge 11 -and $minor -le 13) {
        $needsCreate = $false
      } else {
        Write-Host "Existing venv in $Dir uses Python $versionOutput, recreating."
      }
    } catch {
      Write-Host "Existing venv in $Dir is not usable on this PC, recreating."
    }
  }

  if ($needsCreate -and (Test-Path $venvDir)) {
    $resolvedDir = (Resolve-Path $Dir).Path
    $resolvedVenv = (Resolve-Path $venvDir).Path
    if (-not $resolvedVenv.StartsWith($resolvedDir, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "Refusing to remove unexpected venv path: $resolvedVenv"
    }
    Remove-Item -LiteralPath $resolvedVenv -Recurse -Force
  }

  if ($needsCreate) {
    $python = Find-Python
    Write-Host "Creating venv in $Dir"
    Push-Location $Dir
    try {
      & $python.Command @($python.Args + @("-m", "venv", ".venv"))
    } finally {
      Pop-Location
    }
    if (-not (Test-Path $venvPython)) {
      throw "Failed to create venv in $Dir. Install Python 3.13 or 3.11 and run setup_windows.bat again."
    }
  }

  Write-Host "Installing requirements for $Dir"
  & $venvPython -m pip install --upgrade pip
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to upgrade pip in $Dir."
  }
  & $venvPython -m pip install -r (Join-Path $Dir $Requirements)
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to install requirements for $Dir. Check pip error above."
  }
}

function Find-Ollama {
  param([hashtable]$Config)

  if ($Config.OllamaExe -and (Test-Path $Config.OllamaExe)) {
    return $Config.OllamaExe
  }

  $cmd = Get-Command ollama -ErrorAction SilentlyContinue
  if ($cmd) {
    return $cmd.Source
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

function Find-YandexBrowser {
  param([hashtable]$Config)

  if ($Config.YandexBrowserPath -and (Test-Path $Config.YandexBrowserPath)) {
    return $Config.YandexBrowserPath
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

  return $null
}

Write-Step "Loading local config"
$config = Load-ProjectConfig
Write-Host "Project: $ProjectRoot"

Write-Step "Preparing Python environments"
Ensure-Venv -Dir $translatorDir -Requirements "requirements.txt"
Ensure-Venv -Dir $cdpDir -Requirements "requirements.txt"

$translatorConfig = Join-Path $translatorDir "config.yaml"
if (-not (Test-Path $translatorConfig)) {
  Copy-Item (Join-Path $translatorDir "config.example.yaml") $translatorConfig
  Write-Host "Created translator-server\config.yaml"
}

Write-Step "Checking Ollama"
$ollama = Find-Ollama -Config $config
if ($ollama) {
  Write-Host "Ollama found: $ollama"
  if ($config.OllamaModelsPath) {
    [Environment]::SetEnvironmentVariable("OLLAMA_MODELS", $config.OllamaModelsPath, "User")
    $env:OLLAMA_MODELS = $config.OllamaModelsPath
    Write-Host "OLLAMA_MODELS set to: $($config.OllamaModelsPath)"
  }

  $model = $config.DefaultOllamaModel
  Write-Host "Required model: $model"

  $modelInstalled = $false
  try {
    $modelList = & $ollama list 2>$null
    if ($LASTEXITCODE -eq 0 -and $modelList) {
      $modelText = ($modelList -join "`n")
      $modelInstalled = ($modelText -match [regex]::Escape($model))
    }
  } catch {
    $modelInstalled = $false
  }

  if ($modelInstalled) {
    Write-Host "Model $model is already downloaded."
  } else {
    Write-Host "Model $model is NOT downloaded yet. It is about 7 GB."
    $answer = Read-Host "Download it now? Type Y to start, anything else to skip"
    if ($answer -in @("Y","y","Yes","yes")) {
      Write-Host "Pulling $model. This can take 10-30 minutes depending on network."
      & $ollama pull $model
      if ($LASTEXITCODE -eq 0) {
        Write-Host "Model downloaded successfully."
      } else {
        Write-Host "Model download did not complete. You can retry later with:"
        Write-Host "  ollama pull $model"
      }
    } else {
      Write-Host "Skipped. To download later run:"
      Write-Host "  ollama pull $model"
    }
  }
} else {
  Write-Host "Ollama not found."
  Write-Host "Install Ollama, then run setup_windows.bat again:"
  Write-Host "  https://ollama.com/download"
}

Write-Step "Checking Yandex Browser"
$yandex = Find-YandexBrowser -Config $config
if ($yandex) {
  Write-Host "Yandex Browser found: $yandex"
} else {
  Write-Host "Yandex Browser not found in standard paths."
  Write-Host "Install it or set YandexBrowserPath in config.local.ps1."
}

Write-Step "Done"
Write-Host "Next step:"
Write-Host "  run_all_servers.bat"
