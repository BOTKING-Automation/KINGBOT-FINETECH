# KINGBOT FINTECH — Broker Partnership Operations

## Purpose

KINGBOT FINTECH can attribute broker acquisition activity without claiming that a commercial partnership exists before the broker has approved it.

The production flow is:
1. Authenticated user clicks OPEN ACCOUNT on Broker Connect.
2. KINGBOT creates a server-side click_id.
3. The click is written to kingbot_partner_clicks and a CLICK event is written to kingbot_partner_events.
4. When the broker-specific partner URL is configured, {click_id} is substituted into that URL and the user is sent through the tracked route.
5. Later, verified broker partner data can be imported as SIGNUP, KYC, FUNDED, ACTIVE, COMMISSION, PAID, or REVERSED events.
6. The protected Partner Revenue dashboard aggregates attributable activity.

## Render configuration

Set these variables only after KINGBOT has a written broker partnership / affiliate / IB arrangement and the broker provides the required tracking URL syntax.

```text
BROKER_PARTNER_EXNESS_URL=
BROKER_PARTNER_DERIV_URL=
BROKER_PARTNER_OANDA_URL=
BROKER_PARTNER_IG_URL=
BROKER_PARTNER_FXCM_URL=
BROKER_PARTNER_IBKR_URL=
```

Use {click_id} as the substitution token wherever the broker's tracking system accepts a KINGBOT-generated sub-ID. Example pattern:

```text
https://broker.example/register?subid={click_id}
```

Do not guess the broker parameter name. Use the exact tracking syntax supplied by the broker program.

For server-to-server event ingestion, set:

```text
PARTNER_EVENT_INGEST_KEY=
```

Keep this value server-side in Render. Never place it in frontend HTML, Firebase client configuration, or browser storage.

KINGBOT_ADMIN_EMAILS controls access to the Partner Revenue dashboard and the authenticated admin event-import endpoint.

## Event import API

Authenticated KINGBOT admins can POST verified events to:

POST /api/partners/events

A server-to-server integration can POST verified partner events to:

POST /api/partners/webhook

and include:

x-partner-ingest-key: <PARTNER_EVENT_INGEST_KEY>

Example payload:

```json
{
  "events": [
    {
      "brokerSlug": "exness",
      "eventType": "COMMISSION",
      "externalReference": "broker-payout-2026-09-30-001",
      "amount": 125.50,
      "currency": "USD",
      "occurredAt": "2026-09-30T09:30:00Z",
      "clickId": "KINGBOT_CLICK_UUID",
      "userId": "OPTIONAL_KINGBOT_USER_UUID",
      "source": "broker_partner_feed",
      "metadata": {
        "period": "2026-09"
      }
    }
  ]
}
```

externalReference should be the broker's auditable event or payout identifier. The database uses a unique index on broker + event type + external reference to reduce duplicate payout imports.

## Important operating rule

A broker card marked OFFICIAL ROUTE · PARTNERSHIP PENDING is informational only. It falls back to the broker's official website and is not represented as a commission-generating KINGBOT partner route.

A card marked PARTNER ROUTE READY means the corresponding Render environment variable is configured. That is a technical tracking status, not proof that the broker has approved any specific territory, payout rate, or client category.

Broker terms, affiliate/IB eligibility, territory restrictions, payout rules, and brand-use rules must be verified against the current agreement with each broker.