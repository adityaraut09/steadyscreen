// Table-driven decision tests.
//  v1 oracle (70 cases, checkpoint 3; independent agent, spec docs/DECISION_RULES.md) runs through a TRANSLATOR to the
//  v2 input shape: wherever v1 said "images kept" (evidence.available), the translator supplies FULL per-decision
//  coverage, an accepted image-backed reference, identity confirmed for every rise and a completed whole-test scan -
//  i.e. the v1 notion of "evidence" made explicit. Cases whose expected outcome INTENTIONALLY changes under the v2
//  contract (docs/CONTRACTS_CP4.md s3: the supervisor count needs an explicit choice; discrepant counts are a conflict)
//  are listed in V2_EXPECTATION_CHANGES with the reason; the v1 expectation is still reported.
//  v2 oracle (tests/fixtures/decision_matrix_v2_expected.json, separate independent agent) runs unchanged when present.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { decide, parseStrictInt } from "../app/src/core/decision.js";

const v1 = JSON.parse(readFileSync(new URL("./fixtures/decision_matrix_expected.json", import.meta.url), "utf8"));
const v2Path = new URL("./fixtures/decision_matrix_v2_expected.json", import.meta.url);
const v2 = existsSync(v2Path) ? JSON.parse(readFileSync(v2Path, "utf8")) : [];

export function translateV1(s) {
  const r = structuredClone(s.result);
  r.window = { tGo: 6000, tEnd: 36000, ...(r.window || {}) };
  r.events = (r.events || []).map((e, i) => ({ tRise: 6000 + i * 2000, tPeak: 6800 + i * 2000, tFull: e.counted ? 6700 + i * 2000 : null, tSeat: 7600 + i * 2000, ...e }));
  const ev = s.evidence || {};
  const out = { ...s, result: r };
  if (ev.available) {
    r.reference = { id: 1, t0: 2000, t1: 2600, accepted: { basis: "image" }, usedAsReference: true, postureWarning: false };
    const coverage = { imageCount: 300, imageTimes: [], reference: { ok: true }, events: Object.fromEntries(r.events.map((e) => [e.n, { ok: true }])),
      flags: Object.fromEntries((r.reviewFlags || []).map((f) => [f, { ok: true }])), endpoint: { ok: true, required: false }, scan: { ok: true, gaps: [] } };
    out.evidence = { ...ev, coverage, identityConfirmedFor: ev.identityConfirmed === true ? r.events.map((e) => e.n) : [], sessionScan: "no_missed" };
  } else out.evidence = { ...ev, coverage: null };
  return out;
}

// Intentional v2 changes (reason from docs/CONTRACTS_CP4.md s3). Expected v2 outcome given explicitly.
const V2_EXPECTATION_CHANGES = {};
const noValue = { value: null, referenceEligible: false, category: null };
const reasonManual = "CONTRACTS_CP4 s3: the supervisor count becomes the result only by an explicit observer choice (basisChoice) - v1 used it automatically";
const reasonConflict = "CONTRACTS_CP4 s3: an eligible automatic count and a DIFFERENT valid supervisor count are a conflict (no value until a basis is chosen) - v1 silently kept the automatic count";
for (const id of ["withheld_manual_valid", "manual_used_when_no_evidence", "manual_used_when_range_straddles", "manual_with_range_determinate", "manual_valid_60", "manual_valid_leading_zero"])
  V2_EXPECTATION_CHANGES[id] = { reason: reasonManual, expect: { completion: "completed_30s", ...noValue, mustIncludeBlockerKeywords: ["choose"] } };
V2_EXPECTATION_CHANGES.manual_ignored_when_automatic_eligible = { reason: reasonConflict, expect: { completion: "completed_30s", ...noValue, conflict: true, mustIncludeBlockerKeywords: ["differ"] } };

function check(c, d, e, label) {
  const ctx = JSON.stringify({ why: c.why, got: { completion: d.completion, value: d.value, eligible: d.reference.eligible, category: d.reference.category, automatic: d.automatic && { min: d.automatic.min, max: d.automatic.max }, conflict: d.conflict, blockers: d.reference.blockers } });
  if ("completion" in e) assert.equal(d.completion, e.completion, label + ctx);
  if ("value" in e) assert.equal(d.value, e.value, label + ctx);
  if ("referenceEligible" in e) assert.equal(d.reference.eligible, e.referenceEligible, label + ctx);
  if ("category" in e) assert.equal(d.reference.category, e.category, label + ctx);
  if (e.automatic) { assert.equal(d.automatic.min, e.automatic.min, ctx); assert.equal(d.automatic.max, e.automatic.max, ctx); assert.equal(d.automatic.determinate, e.automatic.determinate, ctx); }
  if ("automaticMin" in e) assert.equal(d.automatic && d.automatic.min, e.automaticMin, ctx);
  if ("automaticMax" in e) assert.equal(d.automatic && d.automatic.max, e.automaticMax, ctx);
  if ("conflict" in e) assert.equal(d.conflict, e.conflict, ctx);
  for (const kw of e.mustIncludeBlockerKeywords || []) assert.ok(d.reference.blockers.join(" ").toLowerCase().includes(kw), `blocker keyword "${kw}" missing: ${ctx}`);
}

for (const c of v1) {
  test(`decision v1->v2: ${c.id}`, () => {
    const d = decide(translateV1(c.session));
    const ch = V2_EXPECTATION_CHANGES[c.id];
    check(c, d, ch ? ch.expect : c.expect, ch ? `[v2 change: ${ch.reason}] ` : "");
  });
}
for (const c of v2) test(`decision v2 oracle: ${c.id}`, () => check(c, decide(c.session), c.expect, ""));

test("strict integer parsing rejects decimals, exponents, signs, spaces and hex", () => {
  for (const bad of ["12.0", "1e1", "-3", " 7 ", "", "0x10", "7a", "+5", "٣"]) assert.equal(parseStrictInt(bad, 2, 0, 60), null, bad);
  assert.equal(parseStrictInt("07", 2, 0, 60), 7);
  assert.equal(parseStrictInt("61", 2, 0, 60), null);
});
test("invariant: no unfinished or replayed session is ever eligible, whatever corrections say", () => {
  for (const reason of ["stopped", "stream_end", "page_hidden", "camera_error"]) for (const source of ["camera", "replay"]) {
    const d = decide(translateV1({ result: { reason, status: "measured", window: { observedMs: 7000 }, events: [], reviewFlags: [] }, source,
      observer: { arms: "no", setup: "yes" }, evidence: { available: true, identityConfirmed: true }, manual: { text: "20", reason: "manual" },
      participant: { ageText: "70", column: "men" }, basisChoice: { basis: "supervisor", rationale: "x" } }));
    assert.equal(d.reference.eligible, false); assert.equal(d.value, null);
  }
});
