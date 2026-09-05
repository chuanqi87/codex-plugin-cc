import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { validateStructuredOutput } from "../plugins/codex/scripts/lib/structured-output.mjs";

const schema = JSON.parse(fs.readFileSync(new URL("../plugins/codex/schemas/review-output.schema.json", import.meta.url), "utf8"));
const review = { verdict: "approve", summary: "No issues found.", findings: [], next_steps: [] };

test("structured review validates the bundled schema including nested findings", () => {
  assert.equal(validateStructuredOutput(JSON.stringify(review), schema), null);
  const finding = { severity: "high", title: "Bug", body: "Evidence", file: "app.js", line_start: 1, line_end: 2, confidence: 0.9, recommendation: "Fix it" };
  assert.equal(validateStructuredOutput(JSON.stringify({ ...review, findings: [finding] }), schema), null);
  for (const [key, value] of [["confidence", 2], ["line_start", 0], ["line_end", 1.5], ["severity", "invalid"], ["file", ""]]) {
    assert.match(validateStructuredOutput(JSON.stringify({ ...review, findings: [{ ...finding, [key]: value }] }), schema), /does not match the requested schema/);
  }
});

test("structured review rejects invalid JSON, missing fields and unknown properties", () => {
  assert.match(validateStructuredOutput("not JSON", schema), /did not return valid JSON/);
  for (const value of [null, [], {}, { ...review, verdict: "maybe" }, { ...review, summary: "" }, { ...review, unknown: true }, { ...review, next_steps: [1] }]) {
    assert.match(validateStructuredOutput(JSON.stringify(value), schema), /does not match the requested schema/);
  }
});
