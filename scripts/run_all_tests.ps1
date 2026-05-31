# Runs the whole test suite (JS unit tests + Python glossary/cleanup tests).
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\run_all_tests.ps1
# Exits non-zero if any test fails.

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$failed = @()

function Run-Test($name, $cmd) {
    Write-Host "`n=== $name ===" -ForegroundColor Cyan
    & ([scriptblock]::Create($cmd))
    if ($LASTEXITCODE -ne 0) {
        $script:failed += $name
        Write-Host "FAILED: $name" -ForegroundColor Red
    }
}

# JS unit tests (by pipeline stage)
Run-Test "ingestion: youtube-reader" "node scripts/test_youtube_reader.js"
Run-Test "ingestion: segment-utils"  "node scripts/test_segment_utils.js"
Run-Test "segmentation: segmenter"   "node scripts/test_segmenter.js"
Run-Test "overlay: dedup"            "node scripts/test_overlay.js"

# JS syntax checks (catch broken edits to the content scripts)
Run-Test "check content.js"      "node --check extension/src/content.js"
Run-Test "check segment-utils.js" "node --check extension/src/segment-utils.js"
Run-Test "check segmenter.js"    "node --check extension/src/segmenter.js"
Run-Test "check overlay.js"      "node --check extension/src/overlay.js"

# Python tests (use the translator-server venv if present)
$py = Join-Path $root "translator-server\.venv\Scripts\python.exe"
if (-not (Test-Path $py)) { $py = "python" }
Run-Test "translate: glossary corrections" "& '$py' scripts/test_translation_cleanup.py"
Run-Test "translate: post-processing"      "& '$py' scripts/test_translation_postprocess.py"

Write-Host ""
if ($failed.Count -gt 0) {
    Write-Host "SUITE FAILED: $($failed -join ', ')" -ForegroundColor Red
    exit 1
}
Write-Host "ALL TESTS PASSED" -ForegroundColor Green
