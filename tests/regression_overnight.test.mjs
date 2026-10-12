// Overnight (post-checkpoint-4) regression tests. Each test was written against a defect reproduced on tag
// `overnight-start` (see docs/OVERNIGHT_ISSUES.json for id, reproduction and root cause). Expected outcomes come from
// the contract (docs/CONTRACTS_CP4.md + its overnight amendment s9), not from the implementation's output.
import test from "node:test";
import assert from "node:assert/strict";
import { decide } from "../app/src/core/decision.js";
import { createEvidenceStore } from "../app/src/ui/evidence.js";

globalThis.URL.revokeObjectURL = globalThis.URL.revokeObjectURL || (() => {});
const enc = (v, w, h, cb) => cb({ size: 1000 });
const VIDEO = { videoWidth: 640, videoHeight: 480 };

// ---------- ON-01: the accepted practice-stand image must survive until review ----------
for (const waitS of [5, 16, 60, 240]) {
  test(`ON-01 practice-stand image survives a ${waitS}-s wait between the practice stand and GO`, () => {
    const ev = createEvidenceStore({ encode: enc });
    const ref = { t0: 5000, t1: 5600 };
    const goT = ref.t1 + waitS * 1000;
    let t = 0, pinned = false;
    for (; t < goT; t += 33) {
      ev.capture(VIDEO, t, null, null);
      if (!pinned && t >= ref.t1 + 1500) { ev.pin("reference", ref.t0 - 150, ref.t1 + 150); pinned = true; }   // app pins when the card is shown
    }
    for (; t < goT + 30000; t += 33) ev.capture(VIDEO, t, null, goT - 15000);
    assert.ok(ev.nearest((ref.t0 + ref.t1) / 2, 450), "reference image was trimmed");
    // unpinned old images are still trimmed (memory stays bounded)
    if (goT - 15000 > 2100) assert.equal(ev.nearest(2000, 100), null, "an unpinned pre-test image outside the keep window should have been trimmed");
  });
}
test("ON-01 re-pinning replaces the previous pin (a rejected hold's images are released again)", () => {
  const ev = createEvidenceStore({ encode: enc });
  let t = 0;
  for (; t < 8000; t += 33) ev.capture(VIDEO, t, null, null);
  ev.pin("reference", 1000, 1600);
  for (; t < 12000; t += 33) ev.capture(VIDEO, t, null, null);
  ev.pin("reference", 9000, 9600);                     // new hold shown: previous hold no longer protected
  for (; t < 40000; t += 33) ev.capture(VIDEO, t, null, null);
  assert.equal(ev.nearest(1300, 400), null);
  assert.ok(ev.nearest(9300, 400));
});
test("ON-01 clear() removes pins", () => {
  const ev = createEvidenceStore({ encode: enc });
  for (let t = 0; t < 3000; t += 33) ev.capture(VIDEO, t, null, null);
  ev.pin("reference", 1000, 1600); ev.clear();
  for (let t = 3000; t < 40000; t += 33) ev.capture(VIDEO, t, null, null);
  assert.equal(ev.nearest(1300, 400), null);
});

// ---------- shared decision fixture: 5 counted full stands, dense images, everything checked ----------
const tGo = 6000, tEnd = 36000;
const imageTimes = []; for (let t = 1000; t <= tEnd + 200; t += 166) imageTimes.push(t);
const imgNear = (t) => imageTimes.find((x) => x >= t);
function fixture({ events: evs } = {}) {
  const events = evs || [0, 1, 2, 3, 4].map((i) => ({ n: i + 1, cls: "full", counted: true, tRise: 7000 + i * 5000, tFull: 7800 + i * 5000, tPeak: 7900 + i * 5000, tSeat: 8800 + i * 5000, flags: [] }));
  const coverage = { imageCount: imageTimes.length, imageTimes, reference: { ok: true }, events: Object.fromEntries(events.map((e) => [e.n, { ok: true }])),
    flags: {}, endpoint: { ok: true, required: false }, scan: { ok: true, gaps: [] } };
  const result = { reason: "expired", status: "measured", window: { tGo, tEnd, observedMs: 30000 }, events, reviewFlags: [], flagWindows: {},
    reference: { id: 1, t0: 2000, t1: 2600, accepted: { basis: "image" }, usedAsReference: true, postureWarning: false } };
  return { result, coverage, ids: events.map((e) => e.n) };
}
function session(fx, { added = [], resolutions = {}, manual = null, basisChoice = null } = {}) {
  return { result: fx.result, source: "camera", observer: { arms: "no", setup: "yes" }, participant: { ageText: "70", column: "women" },
    evidence: { available: true, coverage: fx.coverage, identityConfirmed: true, identityConfirmedFor: fx.ids, sessionScan: "no_missed", added, eventResolutions: resolutions, flagChecks: {} },
    manual, basisChoice };
}

test("ON-02 control: clean fixture is eligible with value 5", () => {
  const d = decide(session(fixture()));
  assert.equal(d.value, 5); assert.equal(d.reference.eligible, true);
});
test("ON-02 an added stand inside an already-detected rise is not counted and blocks interpretation", () => {
  const d = decide(session(fixture(), { added: [{ id: "added-1", t: imgNear(7900) }] }));
  assert.notEqual(d.value, 6);
  assert.equal(d.reference.eligible, false);
  assert.ok(d.reference.blockers.join(" ").toLowerCase().includes("rise 1"), d.reference.blockers.join(" | "));
});
test("ON-02 the same image added twice (double click) is not counted twice", () => {
  const t = imgNear(31500);   // between rise 5 (ends 28800) and 30 s
  const d = decide(session(fixture(), { added: [{ id: "added-1", t }, { id: "added-2", t }] }));
  assert.ok(d.value === null || d.value <= 6, `value ${d.value}`);
  assert.equal(d.reference.eligible, false, "two added stands at the same moment must block, not count");
});
test("ON-02 two added stands closer than one sit-stand cycle block interpretation", () => {
  const d = decide(session(fixture(), { added: [{ id: "added-1", t: imgNear(31000) }, { id: "added-2", t: imgNear(31400) }] }));
  assert.equal(d.reference.eligible, false);
});
test("ON-02 a single well-separated added stand still counts (correction path remains usable)", () => {
  const d = decide(session(fixture(), { added: [{ id: "added-1", t: imgNear(31500) }] }));
  assert.equal(d.value, 6); assert.equal(d.reference.eligible, true);
});
test("ON-02 added stands before GO or after 30 s are not counted and block interpretation", () => {
  for (const t of [imgNear(1000), imgNear(36100)]) {
    const d = decide(session(fixture(), { added: [{ id: "added-1", t }] }));
    assert.notEqual(d.value, 6, `t=${t}`);
    assert.equal(d.reference.eligible, false, `t=${t}`);
  }
});
test("ON-02 an added stand inside a rise rejected as not full is still refused (correct that rise instead)", () => {
  const d = decide(session(fixture(), { added: [{ id: "added-1", t: imgNear(12900) }], resolutions: { 2: "not_full" } }));
  assert.equal(d.reference.eligible, false);
});

// ---------- ON-03: a basis choice is bound to the counts the observer saw when choosing ----------
test("ON-03 control: choosing the camera count while counts agree reports it", () => {
  const fx = fixture();
  const d = decide(session(fx, { manual: { text: "5", reason: "counted" }, basisChoice: { basis: "automatic", rationale: "agree", at: { automaticMin: 5, automaticMax: 5, supervisor: 5 } } }));
  assert.equal(d.value, 5); assert.equal(d.reference.eligible, true);
});
test("ON-03 a later correction that changes the camera count invalidates an earlier basis choice", () => {
  const fx = fixture();
  const d = decide(session(fx, { resolutions: { 5: "not_full" }, manual: { text: "5", reason: "counted" }, basisChoice: { basis: "automatic", rationale: "they agree", at: { automaticMin: 5, automaticMax: 5, supervisor: 5 } } }));
  assert.equal(d.value, null, "stale choice must not produce a value");
  assert.equal(d.reference.eligible, false);
  assert.equal(d.conflict, true);
  assert.ok(d.reference.blockers.join(" ").toLowerCase().includes("choose"), d.reference.blockers.join(" | "));
});
test("ON-03 a stale supervisor choice is also invalidated", () => {
  const fx = fixture();
  const d = decide(session(fx, { manual: { text: "6", reason: "counted" }, basisChoice: { basis: "supervisor", rationale: "missed one", at: { automaticMin: 5, automaticMax: 5, supervisor: 7 } } }));
  assert.equal(d.value, null);
  assert.equal(d.reference.eligible, false);
});

// ON-38: with a slow encoder (all pending slots busy), a priority capture near the 30-s mark is still taken
test("ON-38 priority capture near the 30-s mark is taken even when normal captures are skipped as busy", () => {
  const cbs = [];
  const ev = createEvidenceStore({ encode: (v, w, h, cb) => cbs.push(cb), maxPending: 2, minIntervalMs: 0 });
  ev.capture(VIDEO, 100, null); ev.capture(VIDEO, 200, null);            // 2 pending: store is busy
  ev.capture(VIDEO, 300, null);                                          // normal: skipped
  assert.equal(ev.stats().skippedBusy, 1);
  ev.capture(VIDEO, 30000, null, null, { priority: true });              // near the endpoint: taken
  assert.equal(ev.stats().pending, 3);
  cbs.forEach((cb) => cb({ size: 1 }));
  assert.ok(ev.nearest(30000, 1));
});
