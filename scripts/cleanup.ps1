param(
  [Parameter(Mandatory = $true)]
  [string]$ProjectRoot
)

$ErrorActionPreference = "Continue"
$ProjectRoot = (Resolve-Path $ProjectRoot).Path

function Ask-YesNo {
  param([string]$Question, [bool]$DefaultYes = $false)
  $suffix = if ($DefaultYes) { "[Y/n]" } else { "[y/N]" }
  while ($true) {
    $answer = Read-Host "$Question $suffix"
    if (-not $answer) { return $DefaultYes }
    $lower = $answer.ToLower()
    if ($lower -in @("y","yes")) { return $true }
    if ($lower -in @("n","no")) { return $false }
  }
}

function Show-Header {
  param([string]$Title)
  Write-Host ""
  Write-Host "== $Title ==" -ForegroundColor Cyan
}

Write-Host "Yandex Live Subtitles Translator - cleanup"
Write-Host "Project: $ProjectRoot"
Write-Host ""
Write-Host "This script will offer to remove temporary files and stop stuck processes."
Write-Host "Nothing is deleted without your confirmation."

# 1. Logs cleanup
Show-Header "Translation logs"
$logsDir = Join-Path $ProjectRoot "logs"
if (Test-Path $logsDir) {
  $logFiles = Get-ChildItem $logsDir -ErrorAction SilentlyContinue
  $totalBytes = ($logFiles | Measure-Object Length -Sum).Sum
  $totalMb = if ($totalBytes) { [math]::Round($totalBytes / 1MB, 1) } else { 0 }
  Write-Host ("Found " + $logFiles.Count + " files, total " + $totalMb + " MB")
  if ($logFiles.Count -gt 0) {
    if (Ask-YesNo "Delete ALL logs (translation history + server logs)?" $false) {
      foreach ($f in $logFiles) {
        Remove-Item -LiteralPath $f.FullName -Force -ErrorAction SilentlyContinue
      }
      Write-Host "Logs deleted." -ForegroundColor Green
    } else {
      if (Ask-YesNo "Delete only old logs (older than 7 days)?" $true) {
        $cutoff = (Get-Date).AddDays(-7)
        $old = $logFiles | Where-Object { $_.LastWriteTime -lt $cutoff }
        Write-Host ("Old files to remove: " + $old.Count)
        foreach ($f in $old) {
          Remove-Item -LiteralPath $f.FullName -Force -ErrorAction SilentlyContinue
        }
        Write-Host "Old logs deleted." -ForegroundColor Green
      } else {
        Write-Host "Logs kept."
      }
    }
  }
} else {
  Write-Host "logs\ does not exist - nothing to clean."
}

# 2. Stuck processes on our ports
Show-Header "Stuck processes on translator/CDP ports"
$ports = @(8765, 8766)
$foundAny = $false
foreach ($port in $ports) {
  $listening = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  foreach ($conn in $listening) {
    $pidValue = $conn.OwningProcess
    if (-not $pidValue) { continue }
    $proc = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
    if ($proc) {
      Write-Host ("Port " + $port + " is busy: PID " + $pidValue + " (" + $proc.ProcessName + ")")
      $foundAny = $true
    }
  }
}
if ($foundAny) {
  if (Ask-YesNo "Stop these processes?" $true) {
    foreach ($port in $ports) {
      $listening = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $port -State Listen -ErrorAction SilentlyContinue
      foreach ($conn in $listening) {
        if ($conn.OwningProcess) {
          Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
          Write-Host ("Stopped PID " + $conn.OwningProcess)
        }
      }
    }
    Write-Host "Ports freed." -ForegroundColor Green
  } else {
    Write-Host "Processes left running."
  }
} else {
  Write-Host "No stuck processes."
}

# 3. Yandex Browser - full close
Show-Header "Yandex Browser (close all windows)"
$yandexProcs = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
  $_.ProcessName -eq "browser" -and $_.Path -like "*\Yandex\YandexBrowser\*"
})
$debugListening = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 9222 -State Listen -ErrorAction SilentlyContinue

if ($yandexProcs.Count -gt 0) {
  Write-Host ("Yandex Browser is running. Processes: " + $yandexProcs.Count)

  if ($debugListening) {
    Write-Host "Debug port 9222 is open. Reading list of open tabs..."
    try {
      $tabsResp = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:9222/json" -TimeoutSec 2 -ErrorAction Stop
      $tabs = @(($tabsResp.Content | ConvertFrom-Json) | Where-Object { $_.type -eq "page" })
      Write-Host ("Open page tabs: " + $tabs.Count)
      foreach ($t in $tabs) {
        $url = "$($t.url)"
        if ($url.Length -gt 80) { $url = $url.Substring(0, 80) + "..." }
        $title = "$($t.title)"
        if ($title.Length -gt 50) { $title = $title.Substring(0, 50) + "..." }
        Write-Host ("  - " + $title + " | " + $url)
      }
      if ($tabs.Count -gt 1) {
        Write-Host "Multiple tabs means the extension runs in each of them." -ForegroundColor Yellow
        Write-Host "This can produce duplicate translations during a broadcast." -ForegroundColor Yellow
      }
    } catch {
      Write-Host "Could not query tab list from CDP (browser may be busy)."
    }
  } else {
    Write-Host "Debug port 9222 is NOT open. Cannot list tabs."
  }

  Write-Host ""
  if (Ask-YesNo "Close ALL Yandex Browser windows now?" $false) {
    foreach ($p in $yandexProcs) {
      Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
      Write-Host ("Stopped PID " + $p.Id)
    }
    $deadline = (Get-Date).AddSeconds(10)
    while (((Get-Process -ErrorAction SilentlyContinue | Where-Object {
              $_.ProcessName -eq "browser" -and $_.Path -like "*\Yandex\YandexBrowser\*"
            }).Count -gt 0) -and (Get-Date) -lt $deadline) {
      Start-Sleep -Milliseconds 300
    }
    Write-Host "Yandex Browser closed." -ForegroundColor Green
    Write-Host "Use run_all_servers.bat to start it again clean (with debug port)."
  } else {
    Write-Host "Yandex left running."
  }
} else {
  Write-Host "Yandex Browser is not running."
}

# 4. Optional: reset config to defaults
Show-Header "Local config (config.local.ps1)"
$localCfg = Join-Path $ProjectRoot "config.local.ps1"
$exampleCfg = Join-Path $ProjectRoot "config.local.example.ps1"
if (Test-Path $localCfg) {
  Write-Host ("Current config: " + $localCfg)
  if (Ask-YesNo "Reset config.local.ps1 to defaults from example?" $false) {
    $backup = $localCfg + ".bak"
    Copy-Item -LiteralPath $localCfg -Destination $backup -Force
    Copy-Item -LiteralPath $exampleCfg -Destination $localCfg -Force
    Write-Host ("Reset done. Old config saved as " + $backup) -ForegroundColor Green
  }
} else {
  Write-Host "config.local.ps1 not present yet - run setup_windows.bat first."
}

# 5. Translator server config (config.yaml)
Show-Header "Translator server config (config.yaml)"
$tsCfg = Join-Path $ProjectRoot "translator-server\config.yaml"
$tsExample = Join-Path $ProjectRoot "translator-server\config.example.yaml"
if (Test-Path $tsCfg) {
  Write-Host ("Current config: " + $tsCfg)
  if (Ask-YesNo "Reset translator-server\config.yaml to defaults?" $false) {
    $backup = $tsCfg + ".bak"
    Copy-Item -LiteralPath $tsCfg -Destination $backup -Force
    Copy-Item -LiteralPath $tsExample -Destination $tsCfg -Force
    Write-Host ("Reset done. Old config saved as " + $backup) -ForegroundColor Green
  }
}

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "Cleanup done." -ForegroundColor Green
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  1. doctor.bat - check that everything is ready"
Write-Host "  2. run_all_servers.bat - start the system"
Write-Host "============================================" -ForegroundColor Cyan
