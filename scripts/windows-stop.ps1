$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $RepoRoot
try {
    docker compose -f docker-compose.local.yml stop
    if ($LASTEXITCODE -ne 0) {
        throw "Could not stop KINGBOT containers. Is Docker Desktop running?"
    }
    Write-Host "KINGBOT containers stopped. The database volume and saved data were preserved." -ForegroundColor Green
} finally {
    Pop-Location
}
