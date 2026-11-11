import assert from "node:assert/strict";
import test from "node:test";

import {
  getDerivHistoryChunkWithRetry,
  isDerivHistoryRateLimitError
} from "./deriv-history-retry.mjs";

const quietLogger = { warn() {} };

test("identifies Deriv historical candle rate-limit responses", () => {
  assert.equal(
    isDerivHistoryRateLimitError(
      new Error("You have reached the rate limit for ticks_history_expensive.")
    ),
    true
  );
  assert.equal(isDerivHistoryRateLimitError(new Error("socket closed")), false);
});

test("retries rate limits with exponential backoff and returns the successful page", async () => {
  let attempts = 0;
  const delays = [];
  const expected = [{ time: "2026-11-11T00:00:00.000Z", close: 1.25 }];

  const result = await getDerivHistoryChunkWithRetry(
    {
      async getHistoricalCandles() {
        attempts += 1;
        if (attempts < 3) {
          throw new Error("You have reached the rate limit for ticks_history_expensive.");
        }
        return expected;
      }
    },
    "GBPUSD",
    { timeframe: "4h", limit: 500, end: "latest" },
    {
      minIntervalMs: 0,
      maxAttempts: 4,
      backoffBaseMs: 10,
      sleepFn: async (milliseconds) => delays.push(milliseconds),
      logger: quietLogger
    }
  );

  assert.equal(attempts, 3);
  assert.deepEqual(delays, [10, 20]);
  assert.deepEqual(result, expected);
});

test("does not retry non-rate-limit errors", async () => {
  let attempts = 0;
  await assert.rejects(
    getDerivHistoryChunkWithRetry(
      {
        async getHistoricalCandles() {
          attempts += 1;
          throw new Error("DERIV_PUBLIC_WEBSOCKET_CLOSED");
        }
      },
      "USDJPY",
      { timeframe: "4h" },
      {
        minIntervalMs: 0,
        maxAttempts: 5,
        sleepFn: async () => {},
        logger: quietLogger
      }
    ),
    /DERIV_PUBLIC_WEBSOCKET_CLOSED/
  );
  assert.equal(attempts, 1);
});

test("stops after the configured retry budget", async () => {
  let attempts = 0;
  const delays = [];
  await assert.rejects(
    getDerivHistoryChunkWithRetry(
      {
        async getHistoricalCandles() {
          attempts += 1;
          throw new Error("You have reached the rate limit for ticks_history_expensive.");
        }
      },
      "XAUUSD",
      { timeframe: "1h" },
      {
        minIntervalMs: 0,
        maxAttempts: 3,
        backoffBaseMs: 5,
        sleepFn: async (milliseconds) => delays.push(milliseconds),
        logger: quietLogger
      }
    ),
    /rate limit/
  );
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [5, 10]);
});
