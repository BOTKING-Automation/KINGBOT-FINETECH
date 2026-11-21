# Customer access modes

KINGBOT separates market intelligence from broker execution. A personal broker connection is optional for analysis and required only when a customer chooses automated order execution.

## Analysis Only

- No personal broker account, OAuth grant, API token, MT4/MT5 terminal, or VPS bridge is required.
- The customer can use the market scanner, supported chart visualizations, technical context, and Cortex analysis when the relevant market-data providers are available.
- Public/shared market-data providers (including a public Deriv feed) are data sources, not customer broker-account connections.
- Analysis-only access must never create, authorize, or submit an order.

## Demo Automation

- The customer explicitly chooses a supported broker and a broker-side DEMO account.
- The selected broker account must be authenticated and verified by its adapter before execution.
- Orders, positions, and account telemetry must remain scoped to that customer's selected account.
- Demo mode is not a simulated KINGBOT paper account unless a product screen clearly labels it as such.

## Live Automation

- The customer explicitly chooses a supported broker and a REAL account.
- A live account connection alone is not live-trading consent.
- Existing backend safeguards must remain in force: REAL account verification, explicit live_execution_authorized, broker trading-enabled checks, and global kill-switch / trading-pause checks.
- Switching the UI to LIVE is setup intent only. It must not set live authorization or bypass a separate confirmation step.

## Engineering invariants

1. Market-data access and broker execution are independent capabilities.
2. Never require Deriv specifically; customers choose only from broker adapters that are actually implemented and verified for the requested market and account type.
3. Keep one active broker account mapping per customer until multi-account isolation is explicitly engineered and tested.
4. Keep execution APIs fail-closed when there is no valid customer broker mapping.
5. No research preview change automatically alters production services or authorizes live trading.

## Current implementation note

The Broker Connect page now exposes the three access choices. Analysis Only links to the standalone scanner. Demo and Live choices set the corresponding broker environment and guide the customer to the broker list. This is a front-end onboarding entry point; it does not represent completed verification of every listed broker adapter.
