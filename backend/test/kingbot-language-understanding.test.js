import test from "node:test";
import assert from "node:assert/strict";
import { normalizeUserLanguage, languageUnderstanding } from "../src/kingbot-language-understanding.js";
import { conversationSignals, conversationalReply } from "../src/kingbot-dialogue-cortex.js";

test("understands common KINGBOT support typos", () => {
  const r = normalizeUserLanguage("helo bro how i conect my borker to the dashbord");
  assert.equal(r.text, "hello bro how i connect my broker to the dashboard");
  assert.equal(r.changed, true);
  assert.ok(r.corrections.length >= 4);
});

test("does not aggressively rewrite unknown names", () => {
  const r = normalizeUserLanguage("Can you check my GibsonFX workspace");
  assert.equal(r.text, "Can you check my GibsonFX workspace");
});

test("dialogue routing survives misspellings", () => {
  const s = conversationSignals("helo i need suport with my borker conection");
  assert.equal(s.intent, "CONNECTION");
  assert.equal(s.languageUnderstanding.corrected, true);
  assert.match(s.resolvedQuestion, /broker/i);
});

test("friendly conversation survives misspellings", () => {
  const r = conversationalReply("helo bro");
  assert.match(r.answer, /KINGBOT|online|working|ready|Hello|Hey/i);
  assert.equal(r.languageUnderstanding.corrected, true);
});
