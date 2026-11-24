param(
    [Parameter(Mandatory = $true)]
    [string]$Path
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$EnvPath = Join-Path $RepoRoot ".env"

if (-not (Test-Path $EnvPath)) {
    throw "Local .env not found. Run scripts/windows-start.ps1 first to generate local environment secrets."
}
if (-not (Test-Path $Path)) {
    throw "Firebase service-account JSON file not found at: $Path"
}

try {
    $ServiceAccount = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
} catch {
    throw "The selected Firebase service-account file is not valid JSON."
}
if (-not $ServiceAccount.project_id -or -not $ServiceAccount.client_email -or -not $ServiceAccount.private_key) {
    throw "The JSON must be a Firebase Admin service-account key containing project_id, client_email and private_key."
}

$CompactJson = $ServiceAccount | ConvertTo-Json -Depth 20 -Compress
$EnvLines = [System.Collections.Generic.List[string]]::new()
foreach ($Line in [System.IO.File]::ReadAllLines($EnvPath)) {
    if (-not $Line.StartsWith("FIREBASE_SERVICE_ACCOUNT_JSON=")) {
        $EnvLines.Add($Line)
    }
}
$EnvLines.Add("FIREBASE_SERVICE_ACCOUNT_JSON=" + $CompactJson)
$Updated = [string]::Join([Environment]::NewLine, $EnvLines) + [Environment]::NewLine

[System.IO.File]::WriteAllText(
    $EnvPath,
    $Updated,
    (New-Object System.Text.UTF8Encoding($false))
)

Write-Host "Firebase Admin credentials imported into the ignored local .env file." -ForegroundColor Green
Write-Host "The private key was not displayed. Recreate the API and worker containers to apply it:" -ForegroundColor Yellow
Write-Host "docker compose -f docker-compose.local.yml up -d --force-recreate api worker"
