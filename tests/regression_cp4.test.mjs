// Checkpoint-4 regression tests, written BEFORE the repair (run on checkpoint4-start to record failures).
// Sources: independent CP3 audit findings A-E (+ the float completion bug found in this run) and docs/CONTRACTS_CP4.md.
// Movement expectations come from the generator's semantics (alpha 1 = full extension), not from core thresholds.
import test from "node:test";
import assert from "node:assert/strict";
import { createChairStand } from "../app/src/core/chair_stand.js";
import { decide, completionOf } from "../app/src/core/decision.js";
import { skeleton, motion, render, PRACTICE, PRACTICE_GO } from "../eval/synth.mjs";

let computeCoverage = null, createEvidenceStore = null;
try { ({ computeCoverage } = await import("../app/src/core/coverage.js")); } catch { /* not yet implemented */ }
try { ({ createEvidenceStore } = await import("../app/src/ui/evidence.js")); } catch { /* browser-only before cp4 */ }

const cyc = (n) => Array.from({ length: n }, () => [["rise", 800], ["stand", 400], ["descend", 800], ["sit", 400]]).flat();
const SCRIPT = [...PRACTICE, ...cyc(5), ["sit", 30000]];
const M = motion(SCRIPT);

/**
 * Drive the core like the app. observer: 'honest' accepts a reference only if the generator's practice stand was full
 * (depth === 1); 'careless' accepts whatever was detected; 'none' never answers.
 */
function runDepth(calDepth, testDepth, { observer = "honest", view = "side", withoutReference = false, mutate = null, basis = "observer_watched" } = {}) {
  const c = createChairStand({ width: 720, height: 1280 });
  let started = false, answered = null;
  for (let i = 0; i < 1200; i++) {
    const t = Math.round(i * 1000 / 30), depth = t < PRACTICE_GO ? calDepth : testDepth;
    if (mutate) mutate(c, t);
    if (c.phase === "calibrating" && t >= PRACTICE_GO && !started) {
      const r = c.readiness();
      const pr = r.practice || {};
      if (c.acceptReference && pr.refId !== undefined && pr.state === "detected" && observer !== "none" && answered !== pr.refId) {
        answered = pr.refId;
        if (observer === "careless" || (observer === "honest" && calDepth === 1)) c.acceptReference({ refId: pr.refId, basis });
        else if (c.rejectReference) c.rejectReference(pr.refId);
      }
      if (withoutReference && c.start.length >= 1) { try { c.start(t, { withoutReference: true }); started = true; } catch { /* not ready */ } }
      else if (c.readiness().ready) { c.start(t); started = true; }
    }
    const s = c.push({ t, poses: [skeleton(M.alphaAt(t) * depth, { view })] });
    if (s.result) return { r: s.result, started, core: c };
  }
  return { r: started ? c.finish("stream_end", 39967) : null, started, core: c };
}
const baseSession = (r, extra = {}) => ({ result: r, source: "camera", observer: { arms: "no", setup: "yes" }, participant: { ageText: "70", column: "men" },
  evidence: { available: true, identityConfirmed: true, eventResolutions: {}, flagChecks: {} }, ...extra });

// ---------- A. reference acceptance ----------
test("A control: full practice + 5 full stands, reference accepted -> 5 measured", () => {
  const { r } = runDepth(1, 1);
  assert.equal(r.status, "measured"); assert.equal(r.count, 5);
});
for (const d of [0.6, 0.7, 0.85, 0.95]) {
  test(`A: incomplete practice (depth ${d}) with an honest observer -> never 5 automatic full stands`, () => {
    const { r } = runDepth(d, d);
    assert.ok(!r || r.status !== "measured" || r.count === 0, JSON.stringify(r && { status: r.status, count: r.count }));
  });
  test(`A: incomplete practice (depth ${d}), 'count without a reference' -> every rise uncertain, nothing counted`, () => {
    const { r } = runDepth(d, d, { observer: "none", withoutReference: true });
    assert.ok(r, "could not start without a reference");
    assert.equal(r.events.filter((e) => e.counted).length, 0);
    assert.notEqual(r.status, "measured");
  });
}
test("A: a detected but unconfirmed practice stand never becomes 'verified' (start refused)", () => {
  const { started } = runDepth(1, 1, { observer: "none" });
  assert.equal(started, false);
});
test("A: careless acceptance of a strongly bent reference (depth 0.6, side view) is flagged, never silently measured", () => {
  const { r } = runDepth(0.6, 0.6, { observer: "careless" });
  assert.ok(r.reviewFlags.includes("reference_posture_warning"), JSON.stringify(r.reviewFlags));
  assert.notEqual(r.status, "measured");
  assert.equal(decide(baseSession(r)).reference.eligible, false);
});
test("A: valid practice then incomplete test rises still rejected/flagged (existing control)", () => {
  for (const d of [0.6, 0.85]) { const { r } = runDepth(1, d); assert.ok(r.status !== "measured" || r.count === 0); }
});
test("A: frontal view with an accepted reference still cannot verify extension", () => {
  const { r } = runDepth(1, 1, { view: "frontal" });
  assert.notEqual(r.status, "measured");
});
test("A: reselecting the participant after acceptance voids the acceptance", () => {
  // (test fix during cp4: the first draft used the 5-rep script, whose first rep starts at 5.7 s, so the participant
  //  was legitimately not ready at 6.6 s; a practice-only motion is used instead - the assertion is unchanged)
  const M = motion([...PRACTICE, ["sit", 30000]]);
  const c = createChairStand({ width: 720, height: 1280 });
  let refId = null;
  for (let i = 0; i < 200; i++) {
    const t = Math.round(i * 1000 / 30);
    c.push({ t, poses: [skeleton(M.alphaAt(t))] });
    const pr = c.readiness().practice || {};
    if (refId === null && pr.state === "detected") { refId = pr.refId; c.acceptReference({ refId, basis: "observer_watched" }); }
  }
  assert.ok(refId !== null && c.readiness().ready);
  c.selectParticipant(400 / 720, 900 / 1280);
  for (let i = 200; i < 260; i++) c.push({ t: Math.round(i * 1000 / 30), poses: [skeleton(0)] });
  assert.equal(c.readiness().ready, false);
});
test("A: an accepted reference older than 5 minutes is stale at GO", () => {
  const c = createChairStand({ width: 720, height: 1280 });
  let refId = null, t = 0;
  for (; t < 5700; t += 33) { c.push({ t, poses: [skeleton(M.alphaAt(t))] }); const pr = c.readiness().practice || {}; if (refId === null && pr.state === "detected") { refId = pr.refId; c.acceptReference({ refId, basis: "observer_watched" }); } }
  for (; t < 5700 + 5 * 60000 + 2000; t += 33) c.push({ t, poses: [skeleton(0)] });
  assert.equal(c.readiness().ready, false);
  assert.ok(c.readiness().reasons.some((x) => /stale|practice/.test(x)));
});
test("A: camera zoom after acceptance (shin length +30%) voids the reference", () => {
  const c = createChairStand({ width: 720, height: 1280 });
  let refId = null, t = 0;
  for (; t < 5700; t += 33) { c.push({ t, poses: [skeleton(M.alphaAt(t))] }); const pr = c.readiness().practice || {}; if (refId === null && pr.state === "detected") { refId = pr.refId; c.acceptReference({ refId, basis: "observer_watched" }); } }
  const zoom = (lm) => lm.map(([x, y, z, v, p]) => [(x - 0.55) * 1.3 + 0.55, (y - 0.9) * 1.3 + 0.9, z, v, p]);
  for (let k = 0; k < 90; k++, t += 33) c.push({ t, poses: [zoom(skeleton(0))] });
  assert.equal(c.readiness().ready, false);
});

// ---------- completion float bug (found in this run's diagnostic) ----------
test("completion: GO at a fractional video time (11125.639 ms) + expiry = a completed 30-s test", () => {
  const r = { reason: "expired", window: { observedMs: (11125.639 + 30000) - 11125.639 } };
  assert.equal(completionOf(r, { arms: "no" }), "completed_30s");
});

// ---------- B. evidence coverage ----------
function coveredSession(r, frameTimes, extra = {}) {
  const coverage = computeCoverage ? computeCoverage(r, frameTimes) : null;
  const counted = r.events.filter((e) => e.cls !== "partial").map((e) => e.n);
  return baseSession(r, { evidence: { available: frameTimes.length > 0, coverage, identityConfirmed: true, identityConfirmedFor: counted,
    eventResolutions: {}, flagChecks: {}, sessionScan: "no_missed", referenceImage: true }, ...extra });
}
const full = () => runDepth(1, 1, { basis: "image" }).r;           // image-backed acceptance (evidence kept)
const denseTimes = (r, from, to, step = 150) => { const a = []; for (let t = from; t <= to; t += step) a.push(t); return a; };

test("B control: dense images over practice + whole test -> automatic count eligible after review", () => {
  assert.ok(computeCoverage, "coverage module missing");
  const r = full();
  const d = decide(coveredSession(r, denseTimes(r, 0, r.window.tEnd + 500)));
  assert.equal(d.reference.eligible, true, JSON.stringify(d.reference.blockers)); assert.equal(d.value, 5);
});
test("B: no images -> not eligible, whatever the answers", () => {
  const r = full(); const d = decide(coveredSession(r, []));
  assert.equal(d.reference.eligible, false);
});
test("B: ONE old image (1 s, before GO) -> not eligible (audit B)", () => {
  const r = full(); const d = decide(coveredSession(r, [1000]));
  assert.equal(d.reference.eligible, false);
});
test("B: missing the image near one rise's top -> not eligible", () => {
  assert.ok(computeCoverage, "coverage module missing");
  const r = full(); const e3 = r.events[2]; const top = e3.tFull;
  const times = denseTimes(r, 0, r.window.tEnd + 500).filter((t) => Math.abs(t - top) > 400);
  const d = decide(coveredSession(r, times));
  assert.equal(d.reference.eligible, false);
  assert.ok(d.reference.blockers.join(" ").match(/rise 3|Rise 3/), JSON.stringify(d.reference.blockers));
});
test("B: gap > 1 s in the whole-test images -> missed stands cannot be ruled out -> not eligible", () => {
  assert.ok(computeCoverage, "coverage module missing");
  const r = full(); const g0 = r.window.tGo + 20000;
  const times = denseTimes(r, 0, r.window.tEnd + 500).filter((t) => t < g0 || t > g0 + 1500);
  assert.equal(decide(coveredSession(r, times)).reference.eligible, false);
});
test("B: no image of the practice stand -> reference acceptance by image not possible -> not eligible", () => {
  assert.ok(computeCoverage, "coverage module missing");
  const r = full(); const st = r.reference || r.calibration.stand;
  const times = denseTimes(r, 0, r.window.tEnd + 500).filter((t) => t < st.t0 - 400 || t > st.t1 + 400);
  assert.equal(decide(coveredSession(r, times)).reference.eligible, false);
});
test("B: identity confirmed for fewer rises than were counted -> not eligible", () => {
  assert.ok(computeCoverage, "coverage module missing");
  const r = full(); const s = coveredSession(r, denseTimes(r, 0, r.window.tEnd + 500)); s.evidence.identityConfirmedFor = [1, 2, 3];
  assert.equal(decide(s).reference.eligible, false);
});

// ---------- C. correction both ways + explicit basis ----------
test("C: a partial rise resolved 'full' WITH its image is counted", () => {
  assert.ok(computeCoverage, "coverage module missing");
  const r = runDepth(1, 0.6, { basis: "image" }).r;
  const s = coveredSession(r, denseTimes(r, 0, r.window.tEnd + 500));
  s.evidence.eventResolutions = Object.fromEntries(r.events.map((e) => [e.n, "full"]));
  const d = decide(s);
  assert.equal(d.automatic.min, r.events.length);
});
test("C: a partial rise resolved 'full' WITHOUT its image is ignored", () => {
  const r = runDepth(1, 0.6).r;
  const s = baseSession(r, { evidence: { available: false, eventResolutions: Object.fromEntries(r.events.map((e) => [e.n, "full"])) } });
  const d = decide(s); assert.ok(!d.automatic || d.automatic.min === 0);
});
test("C: an observer-added missed stand at an image time is counted", () => {
  assert.ok(computeCoverage, "coverage module missing");
  const r = full(); const times = denseTimes(r, 0, r.window.tEnd + 500);
  const s = coveredSession(r, times); s.evidence.added = [{ id: "added-1", t: times.find((t) => t > r.window.tGo + 25000) }];
  assert.equal(decide(s).value, 6);
});
test("C: an observer-added stand with no image at that time is not counted (overnight s9: and it blocks interpretation)", () => {
  assert.ok(computeCoverage, "coverage module missing");
  const r = full(); const times = denseTimes(r, 0, r.window.tEnd + 500);
  const s = coveredSession(r, times); s.evidence.added = [{ id: "added-1", t: r.window.tGo + 25071 }];
  // cp4 expectation was value 5 (silently ignored). Overnight contract s9 (ON-02): an invalid added stand is still never
  // counted, but it now blocks interpretation instead of disappearing silently, so the observer sees and undoes it.
  const d = decide(s);
  assert.notEqual(d.value, 6); assert.equal(d.reference.eligible, false);
  assert.ok(/not at a kept image/.test(d.reference.blockers.join(" ")), d.reference.blockers.join(" | "));
});
function conflict(extra) {
  const r = full(); const s = coveredSession(r, denseTimes(r, 0, r.window.tEnd + 500), { manual: { text: "4", reason: "counted aloud" }, ...extra });
  return decide(s);
}
test("C: automatic 5 vs supervisor 4 -> conflict, no value until an explicit basis is chosen", () => {
  assert.ok(computeCoverage, "coverage module missing");
  const d = conflict({}); assert.equal(d.value, null); assert.equal(d.reference.eligible, false);
  assert.ok(/conflict|differ/i.test(d.reference.blockers.join(" ")));
});
test("C: conflict resolved to 'automatic' with a rationale -> 5; to 'supervisor' -> 4", () => {
  assert.ok(computeCoverage, "coverage module missing");
  assert.equal(conflict({ basisChoice: { basis: "automatic", rationale: "images show 5 clear stands" } }).value, 5);
  assert.equal(conflict({ basisChoice: { basis: "supervisor", rationale: "I lost count once but rechecked" } }).value, 4);
});
test("C: supervisor-count route needs no identity answer, and is not labelled image-verified", () => {
  const r = full();
  const d = decide(baseSession(r, { evidence: { available: false }, manual: { text: "5", reason: "counted during the test" }, basisChoice: { basis: "supervisor", rationale: "no images kept" } }));
  assert.equal(d.value, 5); assert.equal(d.reference.eligible, true);
  assert.ok(!/image/i.test(d.basis) || /not image/i.test(d.basis), d.basis);
});
test("C: a supervisor count is not used silently when the automatic basis is unavailable (explicit switch)", () => {
  const r = full();
  const d = decide(baseSession(r, { evidence: { available: false }, manual: { text: "5", reason: "counted" } }));
  assert.equal(d.value, null);
});
test("C invariant: corrections never complete an unfinished test", () => {
  const r = { ...full(), reason: "stopped", status: "stopped", window: { tGo: 0, tEnd: 30000, observedMs: 7000 } };
  const d = decide(baseSession(r, { manual: { text: "20", reason: "x" }, basisChoice: { basis: "supervisor", rationale: "x" } }));
  assert.equal(d.value, null); assert.equal(d.reference.eligible, false);
});

// ---------- D. evidence store lifecycle (injectable encoder: no DOM needed) ----------
function fakeVideo() { return { videoWidth: 64, videoHeight: 64 }; }
test("D: capture(); clear(); then the pending callback settles -> store stays empty", async () => {
  assert.ok(createEvidenceStore, "evidence module not importable in Node");
  let pendingCb = null;
  const s = createEvidenceStore({ encode: (video, w, h, cb) => { pendingCb = cb; } });
  s.capture(fakeVideo(), 1000, null); s.clear(); pendingCb({ size: 795 });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(s.stats().frames, 0);
});
test("D: out-of-order callbacks are stored in timestamp order", async () => {
  assert.ok(createEvidenceStore, "evidence module not importable in Node");
  const cbs = [];
  const s = createEvidenceStore({ encode: (video, w, h, cb) => cbs.push(cb) });
  s.capture(fakeVideo(), 1000, null); s.capture(fakeVideo(), 1200, null);
  cbs[1]({ size: 10 }); cbs[0]({ size: 10 });
  assert.deepEqual(s.times(), [1000, 1200]);
});
test("D: finalize() waits for a pending final capture before freezing", async () => {
  assert.ok(createEvidenceStore, "evidence module not importable in Node");
  let cb = null;
  const s = createEvidenceStore({ encode: (video, w, h, c) => { cb = c; } });
  s.capture(fakeVideo(), 29900, null);
  const fin = s.finalize(); setTimeout(() => cb({ size: 10 }), 50);
  await fin;
  assert.deepEqual(s.times(), [29900]);
  s.capture(fakeVideo(), 30500, null);                      // after finalize: ignored
  assert.deepEqual(s.times(), [29900]);
});
test("D: null image-creation callbacks are counted as failures, not frames", async () => {
  assert.ok(createEvidenceStore, "evidence module not importable in Node");
  const s = createEvidenceStore({ encode: (video, w, h, cb) => cb(null) });
  s.capture(fakeVideo(), 1000, null);
  assert.equal(s.stats().frames, 0); assert.equal(s.stats().dropped, 1);
});

test("A: a rejected practice stand is not re-offered while the same stand continues (asked again only after it is broken)", () => {
  const M2 = motion([["sit", 1500], ["rise", 800], ["stand", 3000], ["descend", 800], ["sit", 3000]]);
  const c = createChairStand({ width: 720, height: 1280 }); const asked = [];
  for (let t = 0; t < 9000; t += 33) {
    c.push({ t, poses: [skeleton(M2.alphaAt(t) * 0.6)] });
    const pr = c.readiness().practice || {};
    if (pr.state === "detected" && !asked.includes(pr.refId)) { asked.push(pr.refId); c.rejectReference(pr.refId); }
  }
  assert.equal(asked.length, 1, `asked ${asked.length} times during one continuous 3-s stand`);
});
