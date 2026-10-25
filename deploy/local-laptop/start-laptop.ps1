$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$compose = @("-f", "docker-compose.yml", "-f", "docker-compose.local.yml")

if (-not (Test-Path ".env")) {
  Copy-Item ".env.example" ".env"
  Write-Host "Created deploy/local-laptop/.env from the template."
  Write-Host "Fill in the three local secrets and matching PostgreSQL password/URL, then run this script again."
  Start-Process notepad.exe -ArgumentList (Join-Path $PSScriptRoot ".env")
  exit 1
}

$envContent = Get-Content ".env" -Raw
if ($envContent -match "REPLACE_WITH|REUSE_EXISTING_RENDER_VALUE") {
  Write-Host "The .env file still contains setup placeholders. Complete them before starting KINGBOT."
  Start-Process notepad.exe -ArgumentList (Join-Path $PSScriptRoot ".env")
  exit 1
}

if ($envContent -notmatch "(?m)^KINGBOT_EXECUTION_HALT=1\s*$" -or
    $envContent -notmatch "(?m)^KINGBOT_LIVE_EXECUTION_ENABLED=0\s*$") {
  throw "Safety check failed. Keep KINGBOT_EXECUTION_HALT=1 and KINGBOT_LIVE_EXECUTION_ENABLED=0 for local testing."
}

docker info *> $null
if ($LASTEXITCODE -ne 0) {
  throw "Docker is not running. Start Docker Desktop and retry."
}

Write-Host "Validating local Docker Compose configuration..."
docker compose @compose config -q
if ($LASTEXITCODE -ne 0) { throw "Docker Compose configuration is invalid. Check .env and compose files." }

Write-Host "Building/starting local PostgreSQL, ML signal service, API, and halted worker..."
docker compose @compose up -d --build db ml-signal api worker
if ($LASTEXITCODE -ne 0) { throw "Docker Compose failed. Check the logs using the command in README.md." }

Write-Host "Waiting for the API health endpoint..."
$healthy = $false
for ($i = 0; $i -lt 60; $i++) {
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:10000/api/health" -TimeoutSec 3
    $healthy = $true
    break
  } catch {
    Start-Sleep -Seconds 2
  }
}

if ($healthy) {
  Write-Host "KINGBOT API responded at http://127.0.0.1:10000/api/health"
  $health | ConvertTo-Json -Depth 6
  Start-Process "http://127.0.0.1:10000/api/health"
} else {
  Write-Host "Containers started but API health did not respond within two minutes."
  Write-Host "Inspect logs: docker compose -f docker-compose.yml -f docker-compose.local.yml logs --tail=100 api ml-signal worker"
}
