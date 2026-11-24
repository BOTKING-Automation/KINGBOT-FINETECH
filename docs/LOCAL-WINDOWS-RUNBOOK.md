# KINGBOT FINETECH — Local Windows Runbook

This setup runs the KINGBOT API, PostgreSQL database and Python ML signal service on your own Windows computer. The database is stored in a local Docker volume. The API is bound to loopback; the execution worker is deliberately disabled by default and can be enabled separately.

## What runs locally

- API: http://127.0.0.1:10000
- PostgreSQL: private Docker network only; not exposed to your LAN
- ML signal service: private Docker network only
- Optional execution worker health (only after explicit enable): http://127.0.0.1:10001/health
- Browser UI: http://localhost:5500
- Local AI page: http://localhost:5500/ai.html?kb-api=local

The local browser API switch is accepted only when the page is opened on localhost/127.0.0.1. Hosted pages cannot use a crafted URL parameter to redirect Firebase tokens to a local or third-party API.

## Requirements

1. Windows 10/11 (64-bit).
2. Docker Desktop with Docker Compose v2; Docker Engine must be running.
3. Git.
4. Python 3 (for the static frontend server). Node and Python ML dependencies are installed inside Docker images.
5. Internet access for public market feeds and container image/package downloads.

The Python ML container currently installs CPU PyTorch by default. This is not a GPU-accelerated deployment.

## 1. Get the current CORTEX research branch

Open PowerShell in your local KINGBOT repository folder:

```powershell
git fetch origin
git checkout cortex-21-intelligence-speed-20261124
git pull --ff-only origin cortex-21-intelligence-speed-20261124
```

If the branch does not exist in your local clone yet, use:

```powershell
git fetch origin cortex-21-intelligence-speed-20261124
git switch --track origin/cortex-21-intelligence-speed-20261124
```

## 2. Create the local environment and start services

Open Docker Desktop and wait until it reports that the engine is running. Then, from the repository root, run:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\windows-start.ps1
```

On first launch, the script creates a private `.env` file with random local PostgreSQL, session, broker-encryption and ML-service secrets. It does not overwrite an existing `.env`.

Docker Compose builds and starts the local database, API and ML signal service. The execution worker is disabled by default so starting the intelligence stack cannot accidentally run previously enabled bots. The first build can be large because the Python service installs CPU PyTorch and scikit-learn.

## 3. Configure Firebase Admin for authenticated backend requests

The browser signs in with Firebase Authentication. The local backend also needs a Firebase Admin service-account JSON file to verify browser ID tokens.

1. In Firebase Console, open Project Settings → Service accounts and generate a private key for the KINGBOT Firebase project.
2. Save the downloaded JSON outside the repository, for example:
   `$env:USERPROFILE\kingbot-firebase-admin.json`.
3. From the repository root, run:

```powershell
.\scripts\windows-set-firebase-service-account.ps1 -Path "$env:USERPROFILE\kingbot-firebase-admin.json"
```

The helper writes the compact service-account JSON into the ignored local `.env` file and does not print the private key. Never upload this file or paste its contents into chat or GitHub.

Recreate only the API container so it reads the new environment. The worker remains disabled:

```powershell
docker compose -f docker-compose.local.yml up -d --force-recreate api
```

## 4. Start the local browser frontend

Open a second VS Code terminal at the repository root and run:

```powershell
.\scripts\windows-local-ui.ps1
```

The static server binds to 127.0.0.1 only. Open the local KINGBOT Intelligence page:

`http://localhost:5500/ai.html?kb-api=local`

Use `localhost` in the browser address so Firebase Authentication recognizes the standard local development domain. The session manager routes local pages to the local API only when `?kb-api=local` is present.

You can browse other repository pages under the same local server. Keep the frontend terminal open while using the local UI. Press Ctrl+C in that terminal to stop the static server.

## 5. Check service health

From another PowerShell terminal:

```powershell
.\scripts\windows-status.ps1
Invoke-RestMethod http://127.0.0.1:10000/api/health
```

Useful diagnostics:

```powershell
docker compose -f docker-compose.local.yml ps
docker compose -f docker-compose.local.yml logs --tail 150 api
docker compose -f docker-compose.local.yml logs --tail 150 ml-signal
docker compose -f docker-compose.local.yml logs --tail 150 worker
```

## Optional: enable the execution worker deliberately

Market-data collection, CORTEX orchestration and ML inference do not require the execution worker. Keep it disabled while validating the local intelligence stack.

Only enable it after reviewing the local database, confirming the intended DEMO account and risk settings, and deliberately deciding to run the execution loop:

```powershell
.\scripts\windows-start.ps1 -EnableExecutionWorker
Invoke-RestMethod http://127.0.0.1:10001/health
```

This starts a real execution worker, not a paper-trading simulator. Do not enable it with LIVE credentials during initial local validation.

## Market-data configuration

The local stack can use available public feeds, including the public Gold API, Deriv public market feed and Binance public crypto quotes. Add a Twelve Data key privately to `.env` if you have one and want its supported streaming/technical coverage. Do not place provider keys in browser JavaScript.

Without a valid Twelve Data key, the instrument universe and candle availability will be narrower. A local server does not create a broker feed or guarantee quotes for every symbol.

## Safety and data separation

- The new local database volume starts independently. It does not copy the Render PostgreSQL database or customer records.
- Keep the execution worker disabled while validating feeds, model readiness and the five specialists. If you later enable it, use DEMO mode only.
- Do not connect a LIVE broker or enable trading until the complete market feed, risk state, worker health and account mapping have been verified.
- The worker is a real execution service, not a simulator. It can act on any enabled and correctly authorized bot/account records in the local database.
- The API, worker and ML ports are bound to loopback/private Docker networking. Do not change those bindings to 0.0.0.0 or expose PostgreSQL publicly.
- Local .env secrets and Firebase Admin credentials must never be committed.

## Stop the local containers

```powershell
docker compose -f docker-compose.local.yml stop
```

This stops services but preserves the local PostgreSQL volume. To permanently remove the local database volume, use `docker compose -f docker-compose.local.yml down -v`; this deletes local database data and should only be used deliberately.
