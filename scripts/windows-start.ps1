$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $RepoRoot
try {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        throw "Docker CLI not found. Install Docker Desktop, start it, then rerun this script: https://www.docker.com/products/docker-desktop/"
    }

    docker info *> $null
    if ($LASTEXITCODE -ne 0) {
        throw "Docker Engine is not running. Open Docker Desktop, wait until it says Engine running, then rerun this script."
    }

    docker compose version *> $null
    if ($LASTEXITCODE -ne 0) {
        throw "Docker Compose v2 is required. Update Docker Desktop and try again."
    }

    if (-not (Test-Path ".env")) {
        if (-not (Test-Path ".env.selfhost.example")) {
            throw ".env.selfhost.example is missing. Run this script from a complete KINGBOT repository checkout."
        }

        $Template = Get-Content ".env.selfhost.example" -Raw
        function New-KingbotSecret {
            $Bytes = New-Object byte[] 32
            $Rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
            try { $Rng.GetBytes($Bytes) } finally { $Rng.Dispose() }
            return [BitConverter]::ToString($Bytes).Replace("-", "").ToLowerInvariant()
        }

        $Template = $Template.Replace("__GENERATE_POSTGRES_PASSWORD__", (New-KingbotSecret))
        $Template = $Template.Replace("__GENERATE_SESSION_SECRET__", (New-KingbotSecret))
        $Template = $Template.Replace("__GENERATE_BROKER_KEY__", (New-KingbotSecret))
        $Template = $Template.Replace("__GENERATE_ML_SECRET__", (New-KingbotSecret))
        [System.IO.File]::WriteAllText(
            (Join-Path $RepoRoot ".env"),
            $Template,
            (New-Object System.Text.UTF8Encoding($false))
        )
        Write-Host "Created .env with random local secrets. Keep this file private." -ForegroundColor Green
    } else {
        Write-Host "Using existing .env; it will not be overwritten." -ForegroundColor Yellow
    }

    $EnvText = Get-Content ".env" -Raw
    if ($EnvText -match "__GENERATE_") {
        throw "The .env file contains ungenerated placeholders. Remove those placeholders or delete .env and rerun setup."
    }

    Write-Host "Building and starting KINGBOT API, PostgreSQL, ML service, and worker..." -ForegroundColor Cyan
    docker compose -f docker-compose.local.yml up -d --build
    if ($LASTEXITCODE -ne 0) {
        throw "Docker Compose did not start successfully. Inspect logs with: docker compose -f docker-compose.local.yml logs --tail 100"
    }

    Write-Host ""
    Write-Host "KINGBOT containers requested. Checking API readiness..." -ForegroundColor Cyan
    $Deadline = (Get-Date).AddMinutes(20)
    $Ready = $false
    do {
        try {
            $Health = Invoke-RestMethod -Uri "http://127.0.0.1:10000/api/health" -TimeoutSec 5
            if ($Health.ok -eq $true) {
                $Ready = $true
                break
            }
        } catch {}
        Start-Sleep -Seconds 5
    } while ((Get-Date) -lt $Deadline)

    docker compose -f docker-compose.local.yml ps
    if ($Ready) {
        Write-Host "KINGBOT API health check passed: http://127.0.0.1:10000/api/health" -ForegroundColor Green
        Write-Host "Worker health check: http://127.0.0.1:10001/health"
    } else {
        Write-Warning "Containers were started, but the API did not report healthy before the check ended. Review the container logs before enabling any broker connection."
    }

    Write-Host "Local API: http://127.0.0.1:10000" -ForegroundColor Cyan
    Write-Host "Database is stored in Docker volume kingbot-postgres-data and is not published to the network."
    Write-Host "To inspect logs: docker compose -f docker-compose.local.yml logs -f"
} finally {
    Pop-Location
}
