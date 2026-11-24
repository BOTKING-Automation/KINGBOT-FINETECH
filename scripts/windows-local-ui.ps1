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

$Arguments = '-m http.server ' + $Port + ' --bind 127.0.0.1 --directory "' + $RepoRoot + '"'
$Server = Start-Process -FilePath $PythonPath -ArgumentList $Arguments -WindowStyle Hidden -PassThru
$Ready = $false

try {
    for ($Attempt = 0; $Attempt -lt 24; $Attempt++) {
        if ($Server.HasExited) {
            throw "The local UI server exited unexpectedly. Confirm Python 3 is installed."
        }
        try {
            $Response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
            if ($Response.StatusCode -eq 200) {
                $Ready = $true
                break
            }
        } catch {}
        Start-Sleep -Milliseconds 250
    }

    if (-not $Ready) {
        throw "The local UI server did not become ready on port $Port."
    }

    Write-Host "KINGBOT local UI: $Url" -ForegroundColor Cyan
    Write-Host "Static server is bound to 127.0.0.1:$Port only." -ForegroundColor Green
    Start-Process $Url
    [void](Read-Host "Press Enter to stop the local UI server (Ctrl+C also works)")
} finally {
    if ($Server -and -not $Server.HasExited) {
        Stop-Process -Id $Server.Id -Force -ErrorAction SilentlyContinue
    }
}
