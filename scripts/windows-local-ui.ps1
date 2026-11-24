$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$Port = 5500
$Url = "http://localhost:$Port/ai.html?kb-api=local"

$listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($listener) {
    throw "Port $Port is already in use. Stop the existing server or choose another port before starting KINGBOT local UI."
}

$PythonPath = $null
$PyLauncher = Get-Command py -ErrorAction SilentlyContinue
if ($PyLauncher) {
    $PythonPath = (& $PyLauncher.Source -3 -c "import sys; print(sys.executable)" 2>$null | Select-Object -First 1)
}
if (-not $PythonPath) {
    $Python = Get-Command python -ErrorAction SilentlyContinue
    if ($Python) {
        $PythonPath = (& $Python.Source -c "import sys; print(sys.executable)" 2>$null | Select-Object -First 1)
    }
}
$PythonPath = ([string]$PythonPath).Trim()
if (-not $PythonPath -or -not (Test-Path $PythonPath)) {
    throw "Python 3 was not found. Install Python 3 or add the Python launcher (py.exe) to PATH."
}

Write-Host "KINGBOT local UI: $Url" -ForegroundColor Cyan
Write-Host "Static server binds to 127.0.0.1:$Port only. Press Ctrl+C to stop." -ForegroundColor Yellow
Start-Process $Url

Push-Location $RepoRoot
try {
    & $PythonPath -m http.server $Port --bind 127.0.0.1 --directory $RepoRoot
    if ($LASTEXITCODE -ne 0) {
        throw "The local frontend server exited with code $LASTEXITCODE."
    }
} finally {
    Pop-Location
}
