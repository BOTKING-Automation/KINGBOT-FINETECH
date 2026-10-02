# KINGBOT FINTECH Hosted MT5 Nodes

The hosted MT5 layer is additive to the existing broker/API stack.

## Production topology

```
Phone / Browser
      |
      v
KINGBOT FINTECH
      |
      +--> Render API + PostgreSQL
      |
      +--> Google Cloud control / orchestration (optional)
      |
      +--> Windows MT5 Host Node
               |
               +--> MetaTrader 5 terminal
               +--> KINGBOT EA / MT5 Bridge
               +--> Verified broker account
```

## Important connection rule

Hosted native MT5 currently accepts only accounts connected through the `mt5-bridge` provider. The broker connection page remains the source of truth for account authorization.

KINGBOT never needs a broker password in the browser for the MT5 bridge flow. A native MT5 terminal still needs valid broker trading authorization; the host node must therefore be provisioned with an authorized MT5 session or another broker-supported credential flow. Do not place credentials in GitHub.

## Windows host node

Requirements:

- Windows VM or physical Windows host
- MetaTrader 5 installed
- Node.js 20+
- KINGBOT EA artifacts available under the configured `KINGBOT_MT5_SOURCE_ROOT`
- outbound HTTPS access to the KINGBOT API
- no inbound public port is required by the node agent

Environment:

```text
KINGBOT_API_ORIGIN=https://kingbot-fintech-api-etfv.onrender.com
KINGBOT_HOSTING_BOOTSTRAP_TOKEN=<backend secret>
KINGBOT_HOST_NODE_ID=<unique node id>
KINGBOT_HOST_NODE_NAME=<human readable node name>
KINGBOT_HOST_NODE_REGION=<region>
KINGBOT_HOST_NODE_ENDPOINT=
```

Optional runtime paths:

```text
KINGBOT_MT5_TERMINAL_EXE=C:\Program Files\MetaTrader 5\terminal64.exe
KINGBOT_MT5_METAEDITOR_EXE=C:\Program Files\MetaTrader 5\metaeditor64.exe
KINGBOT_MT5_RUNTIME_ROOT=C:\ProgramData\KINGBOT\mt5
KINGBOT_MT5_SOURCE_ROOT=mt5
KINGBOT_HOST_HEARTBEAT_MS=10000
KINGBOT_HOST_SUPERVISOR_POLL_MS=10000
KINGBOT_HOST_BRIDGE_WAIT_MS=60000
```

Start the node:

```powershell
node hosting/mt5-node-agent.mjs
```

The node registers with the API, receives a node token in memory, polls for provisioning work, prepares an isolated MT5 runtime, launches the terminal, and waits for KINGBOT to observe the EA bridge heartbeat for the exact authorized account.

## Google Cloud

Google Cloud's current Free Tier provides one non-preemptible `e2-micro` Compute Engine VM per month in eligible US regions. That VM is appropriate for lightweight control/orchestration, not for a multi-customer native MT5 fleet. A Windows MT5 node should use suitable Windows-capable compute and must stay within the applicable trial or billing limits.

For the current Google Free Tier details, see:
https://docs.cloud.google.com/free/docs/free-cloud-features

## Security

- Never commit `KINGBOT_HOSTING_BOOTSTRAP_TOKEN` or a node token.
- Never commit broker passwords, API secrets, or access tokens.
- Keep broker credential storage inside the existing encrypted broker manager.
- Keep live execution behind explicit authorization and deterministic risk gates.
- The AI agent remains supervisory; it does not replace the local execution/risk path.


## User-owned Windows VPS deployment

KINGBOT also supports a customer-managed Windows VPS path. The customer enters the VPS host/port, Windows account, MT5 server/login/trading password, terminal path, symbol, timeframe, selected strategy, and DEMO/LIVE mode in Broker Connect.

The backend stores the sensitive VPS and MT5 credentials encrypted with `BROKER_CREDENTIALS_KEY`. The browser does not persist those secrets in localStorage. A short-lived enrollment token is generated for the customer's VPS agent; after enrollment the VPS uses a scoped node token.

Flow:

1. In **Broker Connect → DERIV MT5 + CLOUD**, fill **USER-OWNED WINDOWS VPS · FULL MT5 SETUP**.
2. Click **SAVE VPS CONFIG**.
3. Click **GENERATE AGENT TOKEN** and copy the generated PowerShell command.
4. On the Windows VPS, clone/copy the KINGBOT repository, open PowerShell in the repository root, and run the generated command.
5. The agent registers the VPS to the customer's profile and polls for deployment work.
6. Click **DEPLOY TO MY VPS** in Broker Connect.
7. The host agent claims the deployment, obtains the scoped MT5 runtime configuration over HTTPS, prepares the selected EA and MT5 bridge, starts MT5 with a custom startup configuration, and waits for the bridge heartbeat.
8. The deployment is marked `RUNNING` only after the exact MT5 account reports a live bridge heartbeat.

The hosting layer is deliberately account-bound. A user VPS cannot claim another user's deployment, and deployment-state updates are scoped to the registered node/profile.

### Credential handling

The VPS operating-system password is collected only to complete the saved VPS profile; the running agent does not need it for normal operation because the agent is already running inside the VPS session. MT5 login/password are used only by the Windows-side MT5 startup configuration. The bridge token is stored encrypted server-side and delivered only to the scoped VPS agent for that deployment.

For live trading, the platform requires explicit `ENABLE_LIVE_TRADING` confirmation and the selected account must be a REAL account.