# KINGBOT FINETECH — Run locally on a Windows laptop

This is a local development/test setup, not a production deployment. It starts a local PostgreSQL database, the Python ML signal service, the API, and one worker. It does not start Caddy or expose the API to your network.

## Requirements

- Windows 10/11 with virtualization enabled and Docker Desktop using its WSL 2 backend.
- 16 GB RAM is recommended for the API, database, worker, and PyTorch/scikit-learn service together. Docker Desktop's current Windows prerequisites list 8 GB RAM as a minimum.
- Git for Windows.

Install Docker Desktop from https://docs.docker.com/desktop/setup/install/windows-install/ and start it. If prompted, install/update WSL 2 and restart Windows.

## 1. Create a local environment file

In PowerShell, from the repository root:

```powershell
cd deploy\local-laptop
Copy-Item .env.example .env
notepad .env
```

Create three different random 64-character hexadecimal values for the local PostgreSQL password, `BROKER_CREDENTIALS_KEY`, and `KINGBOT_ML_SIGNAL_SECRET`. A PowerShell helper that uses the OS cryptographic random-number generator:

```powershell
function New-HexSecret {
  $bytes = New-Object byte[] 32
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $rng.GetBytes($bytes)
    return -join ($bytes | ForEach-Object { $_.ToString('x2') })
  } finally {
    $rng.Dispose()
  }
}
New-HexSecret
New-HexSecret
New-HexSecret
```

Copy the first value into `POSTGRES_PASSWORD` and into the password segment of `DATABASE_URL`; keep the URL's username, host `db`, port `5432`, and database name unchanged. Put the second value in `BROKER_CREDENTIALS_KEY` and the third in `KINGBOT_ML_SIGNAL_SECRET`.

Keep these safety values exactly:
- `KINGBOT_EXECUTION_HALT=1`
- `KINGBOT_LIVE_EXECUTION_ENABLED=0`
- `WORKER_STANDBY=1` in the environment file (the API is standby; the separate worker owns the loop).
- `DATABASE_SSL=disable` is only for the private Docker network in this local compose setup.

Use this as a clean local database. Do not paste your Render database URL, broker tokens, production API keys, Firebase service-account JSON, or production broker-encryption key into this file.

## 2. Start the local backend

Still inside `deploy\local-laptop`:

```powershell
docker compose -f docker-compose.yml -f docker-compose.local.yml config -q
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --build db ml-signal api worker
```

The first build downloads Node/Python dependencies and the PyTorch CPU package, so it can take a while and uses substantial disk space. Keep Docker Desktop open.

## 3. Check it

Open http://127.0.0.1:10000/api/health in your browser, or run:

```powershell
Invoke-RestMethod http://127.0.0.1:10000/api/health | ConvertTo-Json -Depth 6
docker compose -f docker-compose.yml -f docker-compose.local.yml ps
docker compose -f docker-compose.yml -f docker-compose.local.yml logs --tail=100 api ml-signal worker
```

The local runtime should report the API health endpoint. Initial readiness may be degraded while the database schemas and worker heartbeat initialize. Firebase sign-in, outbound email, market data, and broker connection features need their corresponding credentials/configuration; they are not simulated by this local setup.

The worker starts in halted mode. It can report heartbeat/diagnostic state, but should not scan bots or submit orders while `KINGBOT_EXECUTION_HALT=1`. The live execution flag remains off as well.

## 4. Stop / restart

Stop containers without deleting the database volume:

```powershell
docker compose -f docker-compose.yml -f docker-compose.local.yml down
```

Start again with the `up` command above. Do **not** add `-v` to `down` unless you intentionally want to delete the local PostgreSQL volume.

The API is bound to `127.0.0.1` only. This local service is not publicly available and stops being available when the laptop or Docker Desktop is off.
