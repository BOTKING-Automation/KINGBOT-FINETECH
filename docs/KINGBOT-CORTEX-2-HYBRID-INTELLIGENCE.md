# KINGBOT CORTEX 2.0 — Hybrid Intelligence

## Architecture boundary

KINGBOT remains a native, evidence-first intelligence system. The generative language model is an optional presentation and knowledge layer; it does not replace CORTEX, specialist strategies, machine-learning inference, deterministic risk controls, or broker validation.

## Provider

- Browser integration: Puter.js at https://js.puter.com/v2/.
- Initial model: openai/gpt-5.4-nano.
- Billing: Puter user-pays; each user is responsible for their own Puter AI usage.
- Consent: disabled by default. The user must enable the checkbox on ai.html before eligible prompts can reach Puter.
- Failure mode: the UI keeps the native CORTEX answer if the SDK is unavailable, the request fails, or the intent is not eligible.

## Allowed intents

- Ordinary conversation.
- General knowledge.
- Programming help.
- Static KINGBOT knowledge and the technical-analysis learning reference (bounded by native CORTEX context).
- Web-research synthesis only when the native backend supplies source URLs and snippets.

## Excluded intents and data

The browser adapter rejects market-intelligence, market research, account, connection, runtime, risk, bot-strategy, store and execution-related intents. It also rejects prompts containing common trading, broker/account and credential indicators. It filters sensitive historical chat messages before building the request.

The adapter sends no broker/account status endpoint payload, balances, positions, runtime telemetry, saved risk settings, execution journal, or native tool output. Only bounded CORTEX reference fields are included for static KINGBOT/education intents; web research includes up to six HTTP(S) source URLs and short snippets.

## Safety invariants

1. CORTEX classifies the user request before Puter is considered.
2. Puter output is never a signal, trade plan, account fact or execution authorization.
3. Broker, market, account, risk and runtime requests remain on their existing authenticated native backend path.
4. The generative layer cannot call backend tools or execute actions.
5. The user can disable the generative layer at any time; native CORTEX remains the default.
6. Failed or empty Puter responses fall back to the already-produced native CORTEX response.

## Validation

Run the backend test suite with:

    cd backend
    npm test

The adapter tests cover allowed intent routing, trading/account isolation, prompt filtering, source-required research synthesis, provider failure handling and SDK-unavailable fallback.
