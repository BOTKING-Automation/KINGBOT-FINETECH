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
    try {
        $Worker = Invoke-RestMethod -Uri "http://127.0.0.1:10001/health" -TimeoutSec 5
        $Worker | ConvertTo-Json -Depth 5
    } catch {
        Write-Warning "KINGBOT worker health endpoint is not responding: $($_.Exception.Message)"
    }
} finally {
    Pop-Location
}
