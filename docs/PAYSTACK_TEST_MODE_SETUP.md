# KINGBOT Paystack Test Mode Setup

This integration is intentionally restricted to Paystack **Test Mode**. It does not accept a live secret key and cannot collect real customer funds.

## 1. Add environment variables to the Render API service

Open the existing KINGBOT API service in Render (not the static GitHub Pages site). Add these variables in the service's Environment section:

| Variable | Value |
| --- | --- |
| `PAYSTACK_MODE` | `test` |
| `PAYSTACK_SECRET_KEY` | Your Paystack **Test Secret Key**, beginning with `sk_test_` |
| `PAYSTACK_WEBHOOK_SECRET` | Your Test Mode webhook signing secret, beginning with `whsec_` |
| `PAYSTACK_USD_KES_RATE` | The KES-per-USD rate approved by KINGBOT for the checkout quote |
| `PAYSTACK_CALLBACK_URL` | `https://botking-automation.github.io/KINGBOT-FINETECH/subscription.html` |

Do not put either secret in GitHub, the browser, source files, or chat. Do not configure a live key in this test integration. The card checkout remains disabled until the test secret, webhook secret, and rate are all present.

The payment amount is computed by the backend from the selected plan's USD price and the configured KES-per-USD rate. Three-month prepaid billing uses the existing 30% discount (2.1 times the monthly price). The browser cannot submit or override the charged KES amount.

## 2. Configure the Paystack Test Mode webhook

In the Paystack Dashboard's **Test Mode** settings under Developers / API configuration, add this HTTPS webhook URL:

`https://kingbot-fintech-api-etfv.onrender.com/api/subscription/paystack/webhook`

Subscribe to `charge.success` and `charge.failed`. Use the Test Mode webhook signing secret for `PAYSTACK_WEBHOOK_SECRET`. The API validates the timestamped `Paystack-Signature` against the raw request body and also supports Paystack's legacy `x-paystack-signature` header.

## 3. Test the complete flow

1. Sign in to KINGBOT with a verified account email.
2. Select an engine and one-month or three-month term.
3. Choose **PAY BY CARD / WALLET · PAYSTACK TEST**.
4. Complete the checkout using Paystack's test payment details from its official Test Payments documentation.
5. Return to KINGBOT. The server verifies the transaction reference, amount, currency and KINGBOT order metadata against Paystack.
6. Check the KINGBOT admin payment queue. The verified payment appears as pending and must still be approved by an administrator before subscription access is granted.

Only channels enabled for the Paystack merchant account and eligible test customer/device are displayed by Paystack. Apple Pay and Google Pay availability is subject to Paystack's account/channel eligibility; their logos on the KINGBOT page do not imply activation.

## 4. Activation boundary

The integration records a successful sandbox transaction as **verified / awaiting administrator approval**. It does not automatically grant an engine licence. Production live payments require a separate code review, live-key configuration, webhook verification and explicit approval; the present implementation deliberately refuses live keys.
