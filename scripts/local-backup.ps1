$ErrorActionPreference = "Stop"

if (-not (Test-Path ".env.local")) {
    throw "Missing .env.local. Copy .env.local.example to .env.local and configure it first."
}

$dbUser = "kingbot"
$userLine = Select-String -Path ".env.local" -Pattern '^KINGBOT_DB_USER=(.*)$' | Select-Object -First 1
if ($userLine) {
    $dbUser = $userLine.Matches[0].Groups[1].Value.Trim()
}
if (-not $dbUser) {
    throw "KINGBOT_DB_USER is empty in .env.local."
}

New-Item -ItemType Directory -Force -Path ".\backups" | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$fileName = "kingbot-local-$stamp.dump"
$containerPath = "/backups/$fileName"
$hostPath = Join-Path (Get-Location) "backups\$fileName"

docker compose --env-file .env.local -f compose.local.yaml exec -T db pg_dump -U $dbUser -d kingbot_local -Fc -f $containerPath
if ($LASTEXITCODE -ne 0) {
    throw "pg_dump failed. No backup was confirmed."
}
if (-not (Test-Path $hostPath)) {
    throw "Expected backup file was not created: $hostPath"
}

$hash = Get-FileHash -Path $hostPath -Algorithm SHA256
Write-Host "Backup created: $hostPath"
Write-Host "SHA256: $($hash.Hash)"
