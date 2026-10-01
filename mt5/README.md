# KINGBOT MT5 EA Bridge

Native MetaTrader 5 execution bridge for KINGBOT FINTECH.

The EA runs inside the user's MT5 terminal. KINGBOT sends controlled commands to the EA and receives broker-native account and position telemetry. No MT5 master password is collected by the website.

## Install

1. Log into the exact Deriv MT5 DEMO or REAL account that KINGBOT should control.
2. In MT5 open Tools -> Options -> Expert Advisors.
3. Add this allowed WebRequest URL:
   https://kingbot-fintech-api-etfv.onrender.com
4. Copy KINGBOT_MT5_BRIDGE.mq5 into MQL5/Experts/KINGBOT/.
5. Open the file in MetaEditor and compile it.
6. Open KINGBOT Broker Connect and choose KINGBOT MT5 BRIDGE.
7. Select DEMO or LIVE. DEMO means the broker-side Deriv MT5 demo account; it is not a KINGBOT paper/sandbox account.
8. Generate the bridge token and paste it into the EA BridgeToken input.
9. Attach the EA to an MT5 chart and enable Algo Trading.
10. Keep the MT5 terminal connected while the bridge is required.

## Native data

The EA reports:
- balance, equity, margin, free margin and leverage
- MT5 position tickets and pending order tickets
- BUY/SELL direction
- native lot volume
- entry and current price
- S/L and T/P
- swap and floating profit
- broker-native quotes
- volume limits, steps, tick size/value and stop levels
- recent deals and order history
- MT5 candle data requested by KINGBOT

## Commands

The backend can request:
- OPEN_POSITION
- MODIFY_POSITION
- CLOSE_POSITION
- GET_CANDLES

Market orders are executed locally by MQL5 CTrade.

## Security

The website creates a per-user bridge token and stores only its SHA-256 hash. The raw token is shown to the user so it can be entered into the EA. Tokens expire and can be revoked.

The user's MT5 broker login/password stays inside MT5.

## Runtime requirement

The browser is not the broker terminal. The user's MT5 terminal must remain logged in and connected for the bridge to remain online.

The repository contains source code only; compile the MQ5 file in MetaEditor to create the EX5 binary.
