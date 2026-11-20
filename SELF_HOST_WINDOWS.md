# Run KINGBOT FINETECH on your own Windows PC

This setup runs the API, execution worker, Python ML service and PostgreSQL database on your own computer using Docker Desktop.

## What “unlimited” means here

There is no cloud compute-hour allowance or cloud-host sleep timer for these local containers. They use your PC's CPU, memory and disk, and your electricity, internet plan, hardware uptime and ISP limits still apply. The PC must remain powered on and connected for the API and worker to operate. This is self-hosting, not an uptime-guaranteed production service.

A practical starting point is a 64-bit Windows 10/11 PC with hardware virtualization enabled and at least 8 GB RAM; 16 GB or more is recommended because the AI service includes CPU PyTorch. A UPS and reliable internet connection are recommended for longer unattended operation.

## First-time setup

1. Install Docker Desktop for Windows: https://www.docker.com/products/docker-desktop/
2. Start Docker Desktop and wait until the Docker Engine is running.
3. Download or clone the complete KINGBOT FINETECH repository to a folder on your PC.
4. Open PowerShell in the repository folder.
5. Run:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\windows-start.ps1
```

The first build downloads Node, Python, PostgreSQL and CPU PyTorch dependencies; it may take several minutes and needs a stable internet connection. The script creates a private local `.env` file with random secrets the first time it runs. It never uploads those secrets.

## Local endpoints

- API: http://127.0.0.1:10000
- API health: http://127.0.0.1:10000/api/health
- Worker health: http://127.0.0.1:10001/health

The PostgreSQL container is not published on a host port. It is reachable only by services on the private Docker bridge network. The Compose configuration uses the explicit local-only database TLS exception for the internal `postgres` service; remote database hosts still require certificate verification.

## Start, stop and inspect

```powershell
.\scripts\windows-start.ps1
.\scripts\windows-status.ps1
.\scripts\windows-stop.ps1
docker compose -f docker-compose.local.yml logs -f
```

Stopping containers preserves the database volume. Do not run `docker compose down -v` unless you intentionally want to delete the local database and all its data.

To have Docker restart the containers after Windows starts, enable **Start Docker Desktop when you sign in** in Docker Desktop settings. Containers use the `unless-stopped` restart policy. Windows still needs to be powered on, logged in as configured, online and not asleep.

## Secrets and integrations

- Keep `.env` private. It is ignored by Git.
- Add the Firebase service-account JSON and market-data API keys to `.env` only when you are ready to configure those integrations.
- Do not place broker passwords, access tokens, or production keys in source files, screenshots, GitHub issues, or chat.
- The local database starts empty. This setup does not copy the existing Render database, users, broker accounts, bot settings or historical trades.

## Optional remote access

For a temporary test URL, install Cloudflare Tunnel and run:

```powershell
cloudflared tunnel --url http://localhost:10000
```

This creates a temporary `trycloudflare.com` address that changes when the tunnel is restarted. It is for testing, not a stable production hostname. Anyone who receives the URL may be able to reach the published API, so do not expose it until the application's authentication, CORS and access policies have been reviewed.

For a stable hostname, add a domain to Cloudflare and create a named Tunnel in the Cloudflare dashboard. Do not open Windows firewall/router ports for PostgreSQL or the worker.

## Before connecting live broker accounts

Verify the API, worker and ML health endpoints, configure backup/restore, verify Firebase authentication and admin access, set market-data credentials, and test with a demo account first. This local setup is not a guarantee of trading uptime and does not provide automatic failover if the PC, power or internet connection fails.
