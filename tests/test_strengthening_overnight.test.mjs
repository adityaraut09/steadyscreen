// Overnight test strengthening (independent test-quality audit, docs/OVERNIGHT_AUDIT_REPORT.md s2). Each block pins a
// contract rule that a plausible mutant could previously break without any test failing. Expected values come from
// docs/CONTRACTS_CP4.md (numeric bounds) and the independent v2 oracle fixture, not from implementation output.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { computeCoverage, COVERAGE_LIMITS } from "../app/src/core/coverage.js";
import { decide } from "../app/src/core/decision.js";
import { createChairStand } from "../app/src/core/chair_stand.js";
import { createEvidenceStore } from "../app/src/ui/evidence.js";
import { skeleton, motion, PRACTICE, PRACTICE_GO } from "../eval/synth.mjs";

const V2 = JSON.parse(readFileSync(new URL("./fixtures/decision_matrix_v2_expected.json", import.meta.url), "utf8"));

// ---------- the v2 oracle must actually be present (it was silently optional) ----------
test("the independent v2 decision oracle is present with all 69 cases", () => assert.equal(V2.length, 69));

// ---------- coverage.js is the code the app runs: cross-check it against the oracle's own coverage bits ----------
test("coverage.js agrees with the independent oracle's coverage on every oracle case that carries image times", () => {
  let n = 0; const diffs = [];
  for (const c of V2) {
    const o = c.session.evidence && c.session.evidence.coverage; if (!o || !o.imageTimes) continue; n++;
    const a = computeCoverage(c.session.result, o.imageTimes);
    if (!!a.reference.ok !== !!o.reference.ok) diffs.push(`${c.id} reference`);
    for (const k of Object.keys(o.events || {})) if (!!(a.events[k] || {}).ok !== !!o.events[k].ok) diffs.push(`${c.id} event ${k}`);
    for (const k of Object.keys(o.flags || {})) if (o.flags[k].ok !== null && !!(a.flags[k] || {}).ok !== !!o.flags[k].ok) diffs.push(`${c.id} flag ${k}`);
    if (!!a.endpoint.ok !== !!o.endpoint.ok) diffs.push(`${c.id} endpoint`);
    if (!!a.scan.ok !== !!o.scan.ok) diffs.push(`${c.id} scan`);
  }
  assert.ok(n >= 50, `only ${n} cases had image times`);
  assert.deepEqual(diffs, []);
});

// ---------- coverage bounds at their exact boundaries (CONTRACTS_CP4 s2) ----------
const R = (extra = {}) => ({ window: { tGo: 10000, tEnd: 40000 }, events: [], reviewFlags: [], flagWindows: {}, reference: { t0: 5000, t1: 5600 }, ...extra });
const dense = (a, b, step = 100) => { const t = []; for (let x = a; x <= b; x += step) t.push(x); return t; };
test("coverage: rise anchor image at exactly 250 ms is ok, 251 ms is not", () => {
  const r = R({ events: [{ n: 1, cls: "full", tFull: 20000, tRise: 19500, tSeat: 21000, flags: [] }] });
  assert.equal(COVERAGE_LIMITS.anchorMaxMs, 250);
  assert.equal(computeCoverage(r, [20250]).events[1].ok, true);
  assert.equal(computeCoverage(r, [20251]).events[1].ok, false);
});
test("coverage: practice-stand image inside the hold +-150 ms is ok, 151 ms outside is not", () => {
  assert.equal(computeCoverage(R(), [5750]).reference.ok, true);
  assert.equal(computeCoverage(R(), [5751]).reference.ok, false);
  assert.equal(computeCoverage(R(), [4849]).reference.ok, false);
});
test("coverage: whole-test gap of exactly 1000 ms is ok, 1001 ms is not, including at the start and end of the test", () => {
  assert.equal(computeCoverage(R(), dense(10000, 40000, 1000)).scan.ok, true);
  const t = dense(10000, 40000, 1000); t.splice(t.indexOf(25000), 1, 24999); t.splice(t.indexOf(26000), 1, 26000);   // 24999 -> 26000 = 1001
  assert.equal(computeCoverage(R(), t).scan.ok, false);
  assert.equal(computeCoverage(R(), dense(11100, 40000, 500)).scan.ok, false, "no image in the first 1.1 s");
  assert.equal(computeCoverage(R(), dense(10000, 38900, 500)).scan.ok, false, "no image in the last 1.1 s");
});
test("coverage: flag window needs images with gaps <= 500 ms across [t0-200, t1+200]", () => {
  const r = R({ reviewFlags: ["gap_during_movement"], flagWindows: { gap_during_movement: [[20000, 21000]] } });
  assert.equal(computeCoverage(r, [19800, 20300, 20800, 21200]).flags.gap_during_movement.ok, true);
  assert.equal(computeCoverage(r, [19800, 20301, 20802, 21200]).flags.gap_during_movement.ok, false);
  assert.equal(computeCoverage(r, dense(19800, 21200, 900)).flags.gap_during_movement.ok, false);
});
test("coverage: a session-wide flag (no window) needs the whole-test images", () => {
  const r = R({ reviewFlags: ["intermittent_tracking"] });
  assert.equal(computeCoverage(r, dense(10000, 40000, 500)).flags.intermittent_tracking.ok, true);
  assert.equal(computeCoverage(r, dense(10000, 40000, 500).filter((t) => t < 20000 || t > 22000)).flags.intermittent_tracking.ok, false);
});
test("coverage: endpoint image must be within 250 ms of 30 s (an image elsewhere does not count)", () => {
  const r = R({ events: [{ n: 1, cls: "expiry", tExpiry: 40000, tRise: 39500, flags: ["expiry_over_halfway"] }] });
  assert.equal(computeCoverage(r, [39750]).endpoint.ok, true);
  assert.equal(computeCoverage(r, [39749]).endpoint.ok, false);
  assert.equal(computeCoverage(r, [15000]).endpoint.ok, false);
  assert.equal(computeCoverage(r, [39750]).endpoint.required, true);
});

// ---------- identity is required for promoted (partial -> full) and uncertain rises, not only counted ones ----------
test("identity must be confirmed for a partial rise promoted to full (oracle case C07 variant)", () => {
  const base = V2.find((c) => /^C07/.test(c.id)); assert.ok(base, "C07 missing");
  const s = structuredClone(base.session);
  const promoted = s.result.events.filter((e) => e.cls !== "full" && s.evidence.eventResolutions[e.n] === "full").map((e) => e.n);
  assert.ok(promoted.length > 0);
  assert.equal(decide(s).reference.eligible, base.expect.referenceEligible, "unmodified oracle case");
  s.evidence.identityConfirmedFor = s.evidence.identityConfirmedFor.filter((n) => !promoted.includes(n));
  const d = decide(s);
  assert.equal(d.reference.eligible, false);
  assert.ok(/identity/i.test(d.reference.blockers.join(" ")), d.reference.blockers.join(" | "));
});

// ---------- reference acceptance void rules (CONTRACTS_CP4 s1) ----------
function practiceCore() {
  const M = motion([...PRACTICE, ["sit", 30000]]);
  const c = createChairStand({ width: 1280, height: 1280 }); let refId = null, t = 0;
  for (; t < PRACTICE_GO; t += 33) { c.push({ t, poses: [skeleton(M.alphaAt(t), { W: 1280, H: 1280 })] }); const pr = c.readiness().practice || {}; if (refId === null && pr.state === "detected") refId = pr.refId; }
  return { c, refId, t };
}
test("a new tracker lock (different person) voids an accepted reference", () => {
  const { c, refId, t: t0 } = practiceCore(); let t = t0;
  assert.ok(c.acceptReference({ refId, basis: "image" }));
  for (let k = 0; k < 30; k++, t += 33) c.push({ t, poses: [skeleton(0, { W: 1280, H: 1280 })] });
  assert.equal(c.readiness().ready, true);
  for (let k = 0; k < 120; k++, t += 33) c.push({ t, poses: [skeleton(0, { x0: 1000, W: 1280, H: 1280 })] });   // someone else, elsewhere
  const r = c.readiness();
  assert.equal(r.ready, false, JSON.stringify(r.reasons));
});
test("acceptReference refuses an unknown/old refId and an invalid basis", () => {
  const { c, refId } = practiceCore();
  assert.equal(c.acceptReference({ refId: refId + 1, basis: "image" }), false);
  assert.equal(c.acceptReference({ refId, basis: "trust_me" }), false);
  assert.equal(c.acceptReference({ refId, basis: "image" }), true);
});
test("the reference is the MOST extended still window of the practice stand, offered only after the stand ended (0.8.1)", () => {
  // sit, rise to 0.9 and hold, straighten to 1.0 and hold, sag back to 0.9 and hold, sit
  const c = createChairStand({ width: 1280, height: 1280 });
  const ease = (u) => 0.5 - 0.5 * Math.cos(Math.PI * Math.max(0, Math.min(1, u)));
  const a = (t) => t < 1500 ? 0 : t < 2300 ? 0.9 * ease((t - 1500) / 800) : t < 3500 ? 0.9 : t < 3800 ? 0.9 + 0.1 * ease((t - 3500) / 300) : t < 5000 ? 1
    : t < 5300 ? 1 - 0.1 * ease((t - 5000) / 300) : t < 6500 ? 0.9 : t < 7300 ? 0.9 * (1 - ease((t - 6500) / 800)) : 0;
  const upright = skeleton(1, { W: 1280, H: 1280 });
  let seenInProgress = false, detectedAt = null, acc = null;
  for (let t = 0; t < 9500; t += 33) {
    c.push({ t, poses: [skeleton(a(t), { W: 1280, H: 1280 })] });
    const pr = c.readiness().practice || {};
    if (pr.state === "in_progress") { seenInProgress = true; assert.equal(c.acceptReference({ refId: pr.refId, basis: "image" }), false, "must not accept mid-stand"); }
    if (pr.state === "detected" && detectedAt === null) { detectedAt = t; assert.ok(c.acceptReference({ refId: pr.refId, basis: "image" })); acc = c.readiness().practice; }
  }
  assert.ok(seenInProgress, "never in progress"); assert.ok(acc, "never offered");
  assert.ok(detectedAt >= 6500, `offered at ${detectedAt} ms, before the stand ended`);
  assert.ok(acc.knee >= 179, `reference knee ${acc.knee}: not the most extended window`);
  const after = c.readiness().practice;
  assert.equal(after.refId, acc.refId); assert.equal(after.state, "accepted"); assert.equal(after.knee, acc.knee); assert.equal(after.h, acc.h);
  void upright;
});

// ---------- posture warning at intermediate depths (data-derived 158/165 thresholds) ----------
function carelessRun(depth, view = "side") {
  const cyc = Array.from({ length: 5 }, () => [["rise", 800], ["stand", 400], ["descend", 800], ["sit", 400]]).flat();
  const M = motion([...PRACTICE, ...cyc, ["sit", 30000]]);
  const c = createChairStand({ width: 720, height: 1280 }); let started = false;
  for (let i = 0; i < 1300; i++) {
    const t = Math.round(i * 1000 / 30);
    if (c.phase === "calibrating" && t >= PRACTICE_GO && !started) {
      const pr = c.readiness().practice || {};
      if (pr.state === "detected") c.acceptReference({ refId: pr.refId, basis: "image" });
      if (c.readiness().ready) { c.start(t); started = true; }
    }
    const s = c.push({ t, poses: [skeleton(M.alphaAt(t) * depth, { view })] });
    if (s.result) return s.result;
  }
  return null;
}
for (const d of [0.7, 0.85]) test(`careless acceptance of a depth-${d} practice stand raises the posture warning`, () => {
  const r = carelessRun(d); assert.ok(r, "never started");
  assert.ok(r.reviewFlags.includes("reference_posture_warning"), r.reviewFlags.join());
  assert.notEqual(r.status, "measured");
});
test("careless acceptance of a near-full (0.95) reference is NOT caught (disclosed residual)", { todo: "below pose resolution; disclosed limitation" }, () => {
  const r = carelessRun(0.95); assert.ok(r.reviewFlags.includes("reference_posture_warning"));
});
test("a genuine full practice stand gives no posture warning", () => {
  const r = carelessRun(1); assert.ok(r); assert.ok(!r.reviewFlags.includes("reference_posture_warning")); assert.equal(r.status, "measured"); assert.equal(r.count, 5);
});

// ---------- evidence store lifecycle ----------
globalThis.URL.createObjectURL = globalThis.URL.createObjectURL || (() => "blob:x");
test("evidence: a callback arriving after finalize() timed out is discarded and counted as late", async () => {
  let pendingCb = null;
  const s = createEvidenceStore({ encode: (v, w, h, cb) => { pendingCb = cb; } });
  s.capture({ videoWidth: 10, videoHeight: 10 }, 1000, null);
  const st = await s.finalize(30);
  assert.equal(st.sealed, true); assert.equal(st.frames, 0);
  pendingCb({ size: 5 });
  assert.equal(s.stats().frames, 0); assert.equal(s.stats().lateOrStale, 1);
});
test("evidence: clear() revokes every object URL it created", () => {
  const revoked = []; const orig = URL.revokeObjectURL; URL.revokeObjectURL = (u) => revoked.push(u);
  let k = 0; const origC = URL.createObjectURL; URL.createObjectURL = () => `blob:${++k}`;
  try {
    const s = createEvidenceStore({ encode: (v, w, h, cb) => cb({ size: 1 }) });
    for (let t = 0; t < 1000; t += 200) s.capture({ videoWidth: 10, videoHeight: 10 }, t, null);
    const fs = s.times().map((t) => s.at(t)); fs.forEach((f) => s.url(f));
    assert.equal(s.stats().objectUrls, fs.length);
    s.clear();
    assert.equal(s.stats().objectUrls, 0);
    for (let i = 1; i <= fs.length; i++) assert.ok(revoked.includes(`blob:${i}`), `blob:${i} not revoked`);
  } finally { URL.revokeObjectURL = orig; URL.createObjectURL = origC; }
});
test("evidence: between() keeps the required anchor images when downsampling", () => {
  const s = createEvidenceStore({ encode: (v, w, h, cb) => cb({ size: 1 }), minIntervalMs: 0 });
  for (let t = 0; t <= 3000; t += 50) s.capture({ videoWidth: 10, videoHeight: 10 }, t, null);
  const anchors = [s.at(0), s.at(1350), s.at(3000)];
  const got = s.between(0, 3000, 5, anchors);
  assert.ok(got.length <= 5);
  for (const a of anchors) assert.ok(got.includes(a), `anchor ${a.t} dropped`);
});

// ---------- mutation re-run gaps (overnight, second mutation pass) ----------
function runPoses(poseFn, { fps = 30, extraMs = 30000 } = {}) {
  const cyc = Array.from({ length: 6 }, () => [["rise", 800], ["stand", 400], ["descend", 800], ["sit", 400]]).flat();
  const M = motion([...PRACTICE, ...cyc, ["sit", extraMs]]);
  const c = createChairStand({ width: 720, height: 1280 }); let started = false;
  for (let i = 0; ; i++) {
    const t = Math.round(i * 1000 / fps); if (t > M.totalMs) break;
    if (c.phase === "calibrating" && t >= PRACTICE_GO && !started) {
      const pr = c.readiness().practice || {};
      if (pr.state === "detected") c.acceptReference({ refId: pr.refId, basis: "image" });
      if (c.readiness().ready) { c.start(t); started = true; }
    }
    const s = c.push({ t, poses: poseFn(t, M.alphaAt(t), c.phase) });
    if (s.result) return s.result;
  }
  return null;
}
// (a synthetic trigger for identity_or_landmark_discontinuity was not found: large synthetic hip jumps are rejected by the
//  tracker first; this flag remains without an isolated test - recorded in docs/OVERNIGHT_ISSUES.json ON-15)
test("quality: another person overlapping the participant -> another_person_overlapped, never 'measured'", () => {
  const r = runPoses((t, a, ph) => (ph === "running" && t > 12000 && t < 13500 ? [skeleton(a), skeleton(1, { x0: 430 })] : [skeleton(a)]));
  assert.ok(r); assert.ok(r.reviewFlags.includes("another_person_overlapped") || r.status === "withheld", `${r.status} ${r.reviewFlags}`); assert.notEqual(r.status, "measured");
});
test("quality: missing observations beyond tolerance for > 20% of the test -> withheld (no automatic count)", () => {
  const r = runPoses((t, a, ph) => (ph === "running" && (t % 2000) < 550 ? [] : [skeleton(a)]));
  assert.ok(r); assert.equal(r.status, "withheld", `${r.status} ${r.withheldReasons}`); assert.equal(r.count, null);
});
test("decision wording: an unfinished session's title says NOT completed; an unchecked completed count says (unchecked)", () => {
  const base = { source: "camera", observer: { arms: "no", setup: "yes" }, participant: { ageText: "70", column: "men" }, evidence: { available: false } };
  const ev = [{ n: 1, cls: "full", counted: true, flags: [] }];
  const stopped = decide({ ...base, result: { reason: "stopped", status: "stopped", window: { tGo: 0, tEnd: 30000, observedMs: 9000 }, events: ev, reviewFlags: [] } });
  assert.match(stopped.title, /NOT a completed/);
  const done = decide({ ...base, result: { reason: "expired", status: "measured", window: { tGo: 0, tEnd: 30000, observedMs: 30000 }, events: ev, reviewFlags: [] } });
  assert.equal(done.value, null); assert.match(done.valueText, /unchecked/);
});
