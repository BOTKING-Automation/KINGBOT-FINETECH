# KINGBOT FINETECH — Local-first runtime

This branch adds an isolated Windows-friendly Docker Compose environment. It does not change the production Render Blueprint, production environment variables, or the existing Supabase project.

## What runs locally

- PostgreSQL 18 with a persistent Docker volume named `kingbot_pgdata`.
- The Node.js API.
- The Python 3.13 CPU ML signal service (scikit-learn + PyTorch CPU wheels).
- The existing static frontend, served by Nginx with the production API origin rewritten to localhost.
- An optional execution worker, excluded from the default Compose startup and guarded by an explicit profile.

## Requirements

- Windows 10/11 with Docker Desktop and its WSL 2 backend enabled.
- Enough free disk space for the Node and PyTorch images, dependencies, and PostgreSQL data.
- Internet access for first-time image/package downloads and Firebase/CDN resources used by the frontend.

## Start on Windows PowerShell

From the repository root:

```powershell
Copy-Item .env.local.example .env.local
notepad .env.local
```

Replace all `REPLACE_WITH_PRIVATE_RANDOM_SECRET` values with separate, unique local secrets of at least 32 characters. These are for a fresh local database only. Do not paste secrets into chat or commit `.env.local`. Keep:

```text
KINGBOT_WORKER_STANDBY=1
```

Then validate and start the default local stack:

```powershell
docker compose --env-file .env.local -f compose.local.yaml config
docker compose --env-file .env.local -f compose.local.yaml up -d --build
docker compose --env-file .env.local -f compose.local.yaml ps
```

Open:

- Frontend: http://localhost:8080
- API health: http://localhost:10000/api/health
- ML service health: http://localhost:10001/health
- Local PostgreSQL: localhost:5433 (database `kingbot_local`)

The local frontend uses the same Firebase project configuration as the existing frontend. In Firebase Authentication settings, make sure `localhost` is an authorized domain before testing sign-in.

## Important execution safety

The default stack runs the API in worker-standby mode. The dedicated execution worker is in the optional `execution` profile and is not started by the commands above.

Do not enable the execution profile until the database has been restored and reviewed, the bot runtime records have been checked, and a demo-only test has been explicitly approved. A restored production database could contain prior broker mappings or bot configuration. Do not assume that bringing up a worker is harmless.

## Optional Kronos forecasting research service

Kronos is isolated from KINGBOT's production strategy-model store and decision engine. It is off by default and is not included in the default `up` command.

Add these variables to `.env.local` before enabling it. Use a unique local secret; never reuse a production or broker key:

```text
KINGBOT_KRONOS_ENABLED=1
KINGBOT_KRONOS_SECRET=<unique random secret of at least 32 characters>
KINGBOT_KRONOS_TORCH_THREADS=2
```

Start only the research service:

```powershell
docker compose --env-file .env.local -f compose.local.yaml --profile research up -d --build kronos-research
```

Check `http://localhost:10002/health`. The first forecast downloads pinned Kronos-small and tokenizer weights into the persistent `kingbot_kronos_cache` volume. The service is bound to `127.0.0.1:10002`; do not expose it publicly.

`POST http://localhost:10002/forecast` requires `Authorization: Bearer <KINGBOT_KRONOS_SECRET>`. The payload contract and strict timestamp/OHLC requirements are documented in `ml-signal-service/kronos_research/README.md`. The trusted market-data/calendar layer must supply future timestamps, including FX sessions, weekends and holidays.

This service returns forecast research only. It has no database, no broker credentials, no access to the execution worker, no BUY/SELL signal or order API, and no write path into existing champion models. Leave it disabled unless conducting an approved research experiment. Stopping the service preserves cached weights; `docker compose down -v` deletes named volumes and must not be used unless data deletion is intended.

## Database persistence and backups

PostgreSQL data is held in the named Docker volume `kingbot_pgdata`. Normal restarts and `docker compose down` preserve that volume.

Create a local backup from PowerShell:

```powershell
.\scripts\local-backup.ps1
```

The script writes a PostgreSQL custom-format dump into `backups\` and reports its SHA-256 hash. The backup folder is excluded from Git. Store copies somewhere protected and separate from this computer.

**Do not run `docker compose down -v`** unless you intentionally want to delete the local database volume.

## Original Render database — recovery is separate

The suspended Render database is not automatically copied into this local database. Do not change production `DATABASE_URL`, do not use the research database as a substitute, and do not overwrite local PostgreSQL with Supabase data.

First request temporary access or an export from Render Support through the Render Dashboard. If Render requires the original database to be upgraded before export, pause and review the quoted cost before approving. Once an export is available, keep the original export unchanged, verify its file size and SHA-256 hash, restore it into a separate local database, and compare table/row counts before any application uses it. If the restored database contains encrypted broker credentials, the local `BROKER_CREDENTIALS_KEY` must be set to the exact original production key or those secrets will not decrypt. Retrieve that key directly from the Render Dashboard and enter it locally; never send it in chat or commit it. Keep the execution worker disabled during this review.

Supabase contains some KINGBOT records but has not been established as a complete backup of the original Render database.

## Useful commands

```powershell
# Inspect status
docker compose --env-file .env.local -f compose.local.yaml ps

# Follow API logs
docker compose --env-file .env.local -f compose.local.yaml logs -f api

# Follow ML service logs
docker compose --env-file .env.local -f compose.local.yaml logs -f ml-signal

# Stop containers without deleting local database data
docker compose --env-file .env.local -f compose.local.yaml down

# Start again
docker compose --env-file .env.local -f compose.local.yaml up -d
```

This is a local integration environment, not a production certification. Broker OAuth callbacks, payment callbacks, public webhooks, live trading, and production-grade uptime require separate configuration and verification.
