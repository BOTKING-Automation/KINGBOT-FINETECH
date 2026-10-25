$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
docker compose -f docker-compose.yml -f docker-compose.local.yml down
if ($LASTEXITCODE -ne 0) { throw "Docker Compose stop failed." }
Write-Host "KINGBOT local containers stopped. The PostgreSQL volume was kept."
