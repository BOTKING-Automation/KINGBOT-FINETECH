$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $RepoRoot
try {
    docker compose -f docker-compose.local.yml ps
    Write-Host ""
    try {
        $Health = Invoke-RestMethod -Uri "http://127.0.0.1:10000/api/health" -TimeoutSec 5
        $Health | ConvertTo-Json -Depth 8
    } catch {
        Write-Warning "KINGBOT API health endpoint is not responding: $($_.Exception.Message)"
    }
    $RunningServices = @(docker compose -f docker-compose.local.yml ps --services --filter status=running)
    if ($RunningServices -contains "worker") {
        try {
            $Worker = Invoke-RestMethod -Uri "http://127.0.0.1:10001/health" -TimeoutSec 5
            $Worker | ConvertTo-Json -Depth 5
        } catch {
            Write-Warning "KINGBOT worker health endpoint is not responding: $($_.Exception.Message)"
        }
    } else {
        Write-Host "Execution worker is OFF (safe default). Start it only when deliberately required." -ForegroundColor Yellow
    }
} finally {
    Pop-Location
}
