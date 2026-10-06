import assert from "node:assert/strict";
import test from "node:test";
import { webSearchStatus } from "../src/kingbot-web-search.js";

test("Google research status is explicit and safe", () => {
  const status = webSearchStatus();

  assert.equal(status.provider, "google");
  assert.equal(status.connector, "GOOGLE_CUSTOM_SEARCH_JSON_API");
  assert.equal(typeof status.configured, "boolean");
  assert.equal(typeof status.available, "boolean");
  assert.equal(typeof status.configurationRequired, "boolean");
  assert.ok(Array.isArray(status.missing));

  if (status.configured) {
    assert.equal(status.available, true);
    assert.equal(status.configurationRequired, false);
    assert.deepEqual(status.missing, []);
  } else {
    assert.equal(status.available, false);
    assert.equal(status.configurationRequired, true);
    assert.ok(status.missing.includes("GOOGLE_SEARCH_API_KEY") || status.missing.includes("GOOGLE_SEARCH_CX"));
  }
});
