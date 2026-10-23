# KINGBOT FINETECH — Oracle Always Free deployment

This directory prepares a single-VM Docker Compose deployment. It is a migration path, not a promise of uninterrupted hosting: Oracle capacity can be unavailable, and one VM is a single point of failure. Keep independent database backups.

## Migration safety gates

**Do not merge this branch to `main` or cut over the frontend until the Oracle VM is running, `https://api.gibsonfx.online/api/health` succeeds, the database restore is verified, and the demo checks are complete.** This branch also prepares frontend and MT5 API references for the new domain. Merging early would point users at a hostname that may not yet resolve or serve the API.

1. The existing Render PostgreSQL database is currently suspended and its dashboard reported an expiry date of 2026-10-29. Restore access and make a verified export before treating migration as complete.
2. Do not delete the Render database or any existing service while the backup is unverified.
3. The first Oracle worker startup is intentionally halted by default. Keep KINGBOT_EXECUTION_HALT=1 and KINGBOT_LIVE_EXECUTION_ENABLED=0 until the data and demo flow are verified.
4. When migrating existing rows in kingbot_broker_accounts, reuse the exact BROKER_CREDENTIALS_KEY currently stored in Render. A new key cannot decrypt old encrypted broker credentials.
5. Transfer required existing integration variables from Render securely. Do not put secret values into the Git repository, screenshots, or chat.

## 1. Create the Oracle Free Tier account

Open https://www.oracle.com/cloud/free/ and register. Oracle says Always Free services remain available for the life of the account within the published limits; the account signup may require phone and credit-card verification. Do not upgrade the account or create resources that are not labelled Always Free.

Choose the home region carefully: Oracle says the home region cannot be changed later. Compute Always Free resources must be created in that home region. Look for A1 capacity in the console before making further commitments.

Official limits and conditions: https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm

## 2. Create the VM

In the Oracle console, open Compute → Instances → Create instance.

- Name: kingbot-fintech
- Image: a supported Ubuntu 22.04 or 24.04 ARM64 image
- Shape: VM.Standard.A1.Flex; set 2 OCPUs and 12 GB memory only if the console explicitly shows it is Always Free eligible
- Boot volume: start with 50 GB and confirm the console marks the resource within the Always Free allowance
- Networking: create/use a VCN and public subnet, assign a public IPv4 address, and add an SSH public key

If A1 reports out-of-host-capacity, do not select a paid shape. Try another availability domain if offered, or wait and retry. The Always Free quota may not be available immediately.

In the subnet security list or network security group, allow inbound TCP 80 and 443 from the internet. Restrict SSH (TCP 22) to your own current IP address where possible. Do not open PostgreSQL port 5432 or Node port 10000 to the internet.

## 3. Install Docker on Ubuntu

Connect with SSH using the private key corresponding to the public key supplied at VM creation. For an Ubuntu image the default user is usually ubuntu.

Install Docker Engine and its Compose plugin using the official Docker instructions for Ubuntu:
https://docs.docker.com/engine/install/ubuntu/

Verify with:

~~~sh
docker --version
docker compose version
git --version
~~~

## 4. Get the migration branch and prepare secrets

This branch contains the proposed deployment files and safety guards. Until the pull request is reviewed/merged, clone this branch explicitly:

~~~sh
git clone --branch infra/oracle-always-free --single-branch https://github.com/BOTKING-Automation/KINGBOT-FINETECH.git
cd KINGBOT-FINETECH/deploy/oracle
cp .env.example .env
nano .env
~~~

Generate a new PostgreSQL password and a new ML-service secret, for example with:

~~~sh
openssl rand -hex 32
~~~

Use a different generated value for each secret. Put the PostgreSQL password in both POSTGRES_PASSWORD and DATABASE_URL; because it is hexadecimal, it will not need URL encoding. Reuse the existing Render BROKER_CREDENTIALS_KEY when importing the existing database. Also transfer FIREBASE_SERVICE_ACCOUNT_JSON and other required integration variables from the existing Render settings securely.

Keep these initial values:

~~~env
KINGBOT_EXECUTION_HALT=1
KINGBOT_LIVE_EXECUTION_ENABLED=0
WORKER_STANDBY=1
DATABASE_SSL=disable
~~~

DATABASE_SSL=disable is valid only because PostgreSQL is reachable on a private Docker bridge network. Do not use it for an externally hosted database.

## 5. DNS and TLS

Create an A record for the API domain configured in .env (the example uses api.gibsonfx.online), pointing to the VM public IPv4 address. Wait until DNS resolution points to that address before starting the Caddy service. Ensure inbound ports 80 and 443 are allowed. Caddy will request and renew HTTPS certificates automatically.

The frontend and MT5 references in this branch are already prepared to use `https://api.gibsonfx.online`; do not merge or publish those changes until the DNS, TLS certificate, and API health check all succeed. Once the new API passes health checks, review the complete branch diff and merge the frontend cutover deliberately.

For Deriv OAuth, update the redirect URI registered in the Deriv application settings to exactly `https://api.gibsonfx.online/api/broker/deriv/oauth/callback` after DNS and HTTPS are working, and set `DERIV_OAUTH_REDIRECT_URI` to the same value in the private `.env`. Keep `DERIV_FRONTEND_RETURN_URL` pointed at the existing hosted broker-connect page unless that page's URL is also changing. Re-test the OAuth callback before relying on broker connectivity.

For users of the MT5 bridge, allow `https://api.gibsonfx.online` in MT5 under **Tools → Options → Expert Advisors → Allow WebRequest for listed URL**, then compile and deploy the branch's updated bridge EA when cutover is approved.

## 6. Back up and migrate Render PostgreSQL

Do this only after Render access is restored. Use Render's external database connection string privately on the VM. Never commit it to Git.

Create a local backup directory:

~~~sh
mkdir -p backups
chmod 700 backups
~~~

Export a custom-format backup using the PostgreSQL 18 client image. In the SSH shell, set RENDER_EXTERNAL_DATABASE_URL to the external connection string copied from the Render database dashboard, then run:

~~~sh
export RENDER_EXTERNAL_DATABASE_URL='PASTE_THE_RENDER_EXTERNAL_CONNECTION_STRING_IN_THIS_PRIVATE_SHELL_ONLY'
docker run --rm -e RENDER_EXTERNAL_DATABASE_URL postgres:18-alpine sh -lc 'pg_dump "$RENDER_EXTERNAL_DATABASE_URL" --format=custom --no-owner --no-privileges' > backups/render-before-migration.dump
unset RENDER_EXTERNAL_DATABASE_URL
~~~

Verify that the dump is not empty and record its checksum:

~~~sh
test -s backups/render-before-migration.dump
sha256sum backups/render-before-migration.dump
~~~

Do not paste the connection URL into a public terminal recording or chat. Unset the temporary variable after use.

Bring up only PostgreSQL first; do not start the worker before restoring data:

~~~sh
docker compose up -d db
docker compose ps
~~~

Restore into the new empty database:

~~~sh
docker compose exec -T db sh -lc 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-privileges' < backups/render-before-migration.dump
~~~

If restore errors occur, stop here and inspect them. Do not start the API or worker against a partial restore. Keep the dump until a second verified backup exists.

## 7. First safe start and checks

Only after the database restore is verified and required environment variables are present:

~~~sh
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 db ml-signal api worker caddy
~~~

Check:

- API health: https://api.gibsonfx.online/api/health
- ML service health from inside the Docker network: docker compose exec ml-signal python -c "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:10001/health').read().decode())"
- Worker logs should report a heartbeat and, while the safe halt remains on, should explicitly state that execution is halted.
- No public port should expose PostgreSQL or the internal ML service.

The API and worker use the same Node image but run separate processes. The API is configured for standby mode; the worker is the only execution loop.

## 8. Move from halted to demo testing

Do not switch the worker on merely because health checks pass. First inspect the restored runtime state, subscription access, broker account mode, symbol mapping, global kill switch, risk settings, and the execution journal.

After confirming the selected broker account is DEMO and the intended bot is the only eligible bot, set KINGBOT_EXECUTION_HALT=0 in the private .env and restart only the worker:

~~~sh
docker compose up -d --force-recreate worker
docker compose logs --tail=100 -f worker
~~~

KINGBOT_LIVE_EXECUTION_ENABLED remains 0, so LIVE order submissions are rejected at the server-side broker authorization gate even if an old database row contains live authorization. Do not change this gate without a separate explicit review and authorization.

## 9. Backups and ongoing operations

Back up PostgreSQL daily to storage outside the VM as well as keeping a short-lived local copy. A disk attached to the same VM is not an independent backup. Restrict the dump files because they contain user and trading data. Verify backup integrity before retiring Render.
