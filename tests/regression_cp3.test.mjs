// Checkpoint-3 regression tests (written BEFORE the core repair; run against checkpoint3-start to record failures).
// Expectations come from what the synthetic movement IS (generator semantics), not from the core's thresholds:
//   - a 'rise' segment reaches full extension (alpha = 1); a 'partial' segment never does.
//   - Partial depth alpha is a thigh-angle parameter: alpha 0.6 = knees ~144 deg, alpha 0.95 = knees ~175 deg + trunk lean.
// Acceptable outcomes for movements near the limit of measurement are stated explicitly (count OR explicit review).
// Invariant (audit A/B): nothing that is not a supported full stand may silently raise a 'measured' count.
import test from "node:test";
import assert from "node:assert/strict";
import { createChairStand } from "../app/src/core/chair_stand.js";
import { render, skeleton, motion, PRACTICE, PRACTICE_GO, referencePositionCount } from "../eval/synth.mjs";
import { acceptDetectedReference } from "../eval/observer_sim.mjs";   // cp4: explicit practice-stand acceptance (full practice only)

const cyc = (n, rise = 800, stand = 400, desc = 800, sit = 400) =>
  Array.from({ length: n }, () => [["rise", rise], ["stand", stand], ["descend", desc], ["sit", sit]]).flat();
const partials = (n, alpha, dur = 1600) => Array.from({ length: n }, () => [["partial", dur, alpha], ["sit", 700]]).flat();

/** Run a script through the core the way the app does: practice prefix, Go at PRACTICE_GO when ready. */
export function run(script, opts = {}, { goAt = PRACTICE_GO, select = null, coreOpts = {} } = {}) {
  const data = render(script, { durationMs: goAt + 32000, noisePx: 1.0, ...opts });
  const core = createChairStand({ width: data.width, height: data.height, ...coreOpts });
  let started = false, res = null, readyAtGo = null;
  for (const f of data.frames) {
    if (select && core.selectParticipant && f.t === select.t) core.selectParticipant(select.x, select.y);
    if (!started && f.t >= goAt && core.phase === "calibrating") {
      readyAtGo = readyAtGo ?? core.readiness();
      if (core.readiness().ready) { core.start(f.t); started = true; }
    }
    const s = core.push(f);
    acceptDetectedReference(core);
    if (s.result) { res = s.result; break; }
  }
  if (started && !res) res = core.finish("stream_end", data.frames.at(-1).t);
  return { res, started, readyAtGo, core, data, tGo: started ? res.window.tGo : null };
}
const counted = (r) => r.events.filter((e) => e.counted !== false).length;            // old core: all events counted
const uncertain = (r) => r.events.filter((e) => e.cls === "uncertain").length;

// ---------- A. full stands vs partial rises ----------
test("control: 12 ordinary full stands (side view) are measured and counted", () => {
  const { res, tGo } = run([...PRACTICE, ...cyc(12), ["sit", 30000]]);
  const ref = referencePositionCount([...PRACTICE, ...cyc(12), ["sit", 30000]], tGo);
  assert.equal(res.status, "measured", JSON.stringify(res.reviewFlags));
  assert.equal(res.count, ref.count);
});

test("control: full stands with noise 3 px are not inflated and the true count is inside the reported range", () => {
  const script = [...PRACTICE, ...cyc(12), ["sit", 30000]];
  const { res, tGo } = run(script, { noisePx: 3, seed: 5 });
  const ref = referencePositionCount(script, tGo).count;
  assert.ok(counted(res) <= ref, `counted ${counted(res)} > ref ${ref}`);
  assert.ok(counted(res) + uncertain(res) >= ref, "true count outside reported range");
  if (counted(res) !== ref) assert.equal(res.status, "needs_review");
});

for (const alpha of [0.4, 0.6, 0.7]) {
  test(`partial depth alpha=${alpha}: five clearly incomplete rises are never counted as full stands`, () => {
    const { res } = run([...PRACTICE, ...partials(5, alpha), ["sit", 30000]]);
    assert.equal(counted(res), 0, JSON.stringify(res.events.map((e) => e.cls)));
  });
}
for (const alpha of [0.85, 0.95]) {
  test(`near-full depth alpha=${alpha}: not silently certified - either not counted, or counted only with review`, () => {
    const { res } = run([...PRACTICE, ...partials(5, alpha), ["sit", 30000]]);
    assert.ok(!(res.status === "measured" && counted(res) > 0), `silently measured ${counted(res)} stands`);
  });
}

test("mixed: 5 full + 1 incomplete (alpha 0.6) + 3 full -> 8 counted, the incomplete one not counted", () => {
  const script = [...PRACTICE, ...cyc(5), ["partial", 1600, 0.6], ["sit", 700], ...cyc(3), ["sit", 30000]];
  const { res } = run(script);
  assert.equal(counted(res), 8);
});

test("audit B: 5 full + one near-full (alpha 0.95) -> never a silent measured 6", () => {
  const { res } = run([...PRACTICE, ...cyc(5), ["partial", 1600, 0.95], ["sit", 30000]]);
  assert.ok(!(res.status === "measured" && counted(res) === 6));
  if (uncertain(res) > 0 || res.events.some((e) => (e.flags || []).length)) assert.notEqual(res.status, "measured", "event flag present but status measured");
});

test("pauses: standing pauses of 3 s and a 6 s seated rest keep the count", () => {
  const script = [...PRACTICE, ...cyc(3, 800, 3000, 800, 400), ["sit", 6000], ...cyc(4), ["sit", 30000]];
  const { res, tGo } = run(script);
  assert.equal(res.count, referencePositionCount(script, tGo).count);
  assert.equal(res.status, "measured");
});

test("habitual forward lean (17 deg stoop, also in the practice stand): full stands still counted", () => {
  const script = [...PRACTICE, ...cyc(10), ["sit", 30000]];
  const { res, tGo } = run(script, { leanExtra: 0.3 });
  assert.equal(res.count, referencePositionCount(script, tGo).count);
});

test("frontal view: extension cannot be verified -> never 'measured'; range contains the true count", () => {
  const script = [...PRACTICE, ...cyc(10), ["sit", 30000]];
  const { res, tGo } = run(script, { view: "frontal", W: 720, H: 1280 });
  const ref = referencePositionCount(script, tGo).count;
  assert.notEqual(res.status, "measured");
  assert.ok(counted(res) <= ref && counted(res) + uncertain(res) >= ref);
});

test("event time: a full stand's timestamp is within 200 ms of the generator's full-extension moment", () => {
  const script = [...PRACTICE, ...cyc(6), ["sit", 30000]];
  const { res } = run(script);
  const m = motion(script); const full = m.stands.filter((t) => t > PRACTICE_GO);
  const times = res.events.filter((e) => e.counted !== false).map((e) => e.tFull ?? e.tStand);
  assert.equal(times.length, full.length);
  times.forEach((t, i) => assert.ok(Math.abs(t - full[i]) <= 200, `event ${i + 1}: ${t} vs ${full[i]}`));
});

// ---------- D. expiry: CDC position rule ----------
function expiryScript(fracTarget, { riseMs = 2000, paused = false } = {}) {
  // 10 cycles, then a rise whose hip-height fraction at expiry equals fracTarget (paused: rise stops there)
  const base = [...PRACTICE, ...cyc(10, 800, 400, 800, 400)];
  const baseEnd = base.reduce((a, s) => a + s[1], 0);
  const tEnd = PRACTICE_GO + 30000;
  const alpha = Math.asin(fracTarget) / (Math.PI / 2);
  if (paused) {
    const riseStart = tEnd - 1500;
    return [...base, ["sit", riseStart - baseEnd], ["partial_hold", 1000, alpha], ["hold", 3000, alpha]];
  }
  const u = Math.acos(1 - 2 * alpha) / Math.PI;
  return [...base, ["sit", tEnd - u * riseMs - baseEnd], ["rise", riseMs], ["stand", 3000]];
}
// A paused attempt is rendered by a custom frame source (the motion() helper has no 'hold' segment).
function runPaused(fracTarget) {
  const tEnd = PRACTICE_GO + 30000; const alpha = Math.asin(fracTarget) / (Math.PI / 2);
  const base = [...PRACTICE, ...cyc(10, 800, 400, 800, 400)];
  const m = motion(base); const baseEnd = m.totalMs; const riseStart = tEnd - 1500;
  const frames = [];
  for (let i = 0; ; i++) {
    const t = Math.round(i * 1000 / 30); if (t > tEnd + 2000) break;
    let a = t < baseEnd ? m.alphaAt(t) : 0;
    if (t >= riseStart && t < riseStart + 1000) a = alpha * (t - riseStart) / 1000; else if (t >= riseStart + 1000) a = alpha;
    frames.push({ t, poses: [skeleton(a)] });
  }
  const core = createChairStand({ width: 720, height: 1280 }); let res = null;
  for (const f of frames) { if (core.phase === "calibrating" && f.t >= PRACTICE_GO && core.readiness().ready) core.start(f.t); const s = core.push(f); acceptDetectedReference(core); if (s.result) { res = s.result; break; } }
  return { res, fullBefore: m.stands.filter((t) => t > PRACTICE_GO && t <= tEnd).length };
}

test("expiry: paused above halfway (frac 0.64) at 30 s -> counted by the position rule or explicit review (audit D)", () => {
  const { res, fullBefore } = runPaused(0.64);
  assert.ok(res.count === fullBefore + 1 || res.status === "needs_review", `count ${res.count}, fullBefore ${fullBefore}, ${res.status}`);
});
test("expiry: paused below halfway (frac 0.30) -> not counted", () => {
  const { res, fullBefore } = runPaused(0.30);
  assert.equal(res.count, fullBefore);
});
for (const [name, frac, expectAdd] of [["over halfway, rising (0.75)", 0.75, 1], ["under halfway, rising (0.25)", 0.25, 0]]) {
  test(`expiry: ${name}`, () => {
    const script = expiryScript(frac);
    const { res, tGo } = run(script);
    const ref = referencePositionCount(script, tGo);
    assert.equal(ref.case, expectAdd ? "over" : "under");
    assert.equal(res.count, ref.count);
  });
}
test("expiry: exactly halfway (0.50) -> explicit review, not a silent decision", () => {
  const script = expiryScript(0.5);
  const { res, tGo } = run(script);
  assert.equal(referencePositionCount(script, tGo).case, "near");
  assert.equal(res.status, "needs_review");
});
test("expiry: descending after an already counted stand -> no double count", () => {
  const base = [...PRACTICE, ...cyc(10, 800, 400, 800, 400)];
  const baseEnd = base.reduce((a, s) => a + s[1], 0); const tEnd = PRACTICE_GO + 30000;
  const script = [...base, ["sit", tEnd - 1500 - baseEnd], ["rise", 700], ["stand", 300], ["descend", 2000], ["sit", 3000]];
  const { res, tGo } = run(script);
  assert.equal(res.count, referencePositionCount(script, tGo).count);
});
test("expiry: endpoint not visible (participant unseen for the last 0.5 s) -> not a silent measured result", () => {
  const script = [...PRACTICE, ...cyc(12), ["sit", 30000]];
  const { res } = run(script, { poseGaps: [[PRACTICE_GO + 29500, PRACTICE_GO + 31000]] });
  assert.notEqual(res.status, "measured");
});

// ---------- G/H. readiness continuity and quality accounting ----------
test("readiness: two seated frames 1 s apart are not 'still and seated'", () => {
  const c = createChairStand({ width: 720, height: 1280 });
  c.push({ t: 0, poses: [skeleton(0)] }); c.push({ t: 1000, poses: [skeleton(0)] });
  assert.equal(c.readiness().ready, false);
});
test("readiness: start() long after the last frame is refused", () => {
  const d = render([...PRACTICE], { durationMs: PRACTICE_GO });
  const c = createChairStand({ width: d.width, height: d.height });
  for (const f of d.frames) { c.push(f); acceptDetectedReference(c); }
  assert.throws(() => c.start(PRACTICE_GO + 59000));
});
test("quality: half the frames without a pose is reported as ~50% missing, and not silently 'measured'", () => {
  const script = [...PRACTICE, ["sit", 33000]];
  const data = render(script, { durationMs: PRACTICE_GO + 32000, noisePx: 0 });
  for (const f of data.frames) if (f.t > PRACTICE_GO && Math.floor((f.t - PRACTICE_GO) / 100) % 2 === 0) f.poses = [];
  const c = createChairStand({ width: 720, height: 1280 }); let res = null;
  for (const f of data.frames) { if (c.phase === "calibrating" && f.t >= PRACTICE_GO && c.readiness().ready) c.start(f.t); const s = c.push(f); acceptDetectedReference(c); if (s.result) { res = s.result; break; } }
  assert.ok(res.quality.missingObservationPct >= 40, JSON.stringify(res.quality));
  assert.notEqual(res.status, "measured");
});

// ---------- F. people in view ----------
test("helper standing beside (static) does not disturb an ordinary measurement", () => {
  const script = [...PRACTICE, ...cyc(12), ["sit", 30000]];
  const { res, tGo } = run(script, { W: 1280, H: 1280, helper: { x: 1000 } });
  assert.equal(res.count, referencePositionCount(script, tGo).count);
});
test("helper walks in from the side during the test and stays beside: count unaffected", () => {
  const script = [...PRACTICE, ...cyc(12), ["sit", 30000]];
  const walkIn = (t) => (t < PRACTICE_GO + 8000 ? null : Math.max(1000, 1300 - (t - PRACTICE_GO - 8000) * 0.3));
  const { res, tGo } = run(script, { W: 1280, H: 1280, helper: { xAt: walkIn } });
  assert.equal(res.count, referencePositionCount(script, tGo).count);
});
test("helper crosses in front of the participant: never a silent measured result", () => {
  const script = [...PRACTICE, ...cyc(12), ["sit", 30000]];
  const cross = (t) => (t > PRACTICE_GO + 10000 && t < PRACTICE_GO + 13000 ? 1100 - (t - PRACTICE_GO - 10000) * 0.3 : 1100);
  const { res } = run(script, { W: 1280, H: 1280, helper: { xAt: cross } });
  assert.notEqual(res.status, "measured");
});
test("short participant dropout (0.4 s) while a helper is in view -> review (identity may have switched)", () => {
  const script = [...PRACTICE, ...cyc(12), ["sit", 30000]];
  const { res } = run(script, { W: 1280, H: 1280, helper: { x: 1000 }, poseGaps: [[PRACTICE_GO + 12000, PRACTICE_GO + 12400]] });
  assert.equal(res.status, "needs_review");
});
test("two SEATED people (fixed fixture): not ready until the participant is selected; then counts correctly", () => {
  const script = [...PRACTICE, ...cyc(12), ["sit", 30000]];
  const noSel = run(script, { W: 1280, H: 1280, helper: { x: 1000, seated: true } });
  assert.equal(noSel.started, false, "started without knowing who the participant is");
  const withSel = run(script, { W: 1280, H: 1280, helper: { x: 1000, seated: true } }, { select: { t: 500, x: 250 / 1280, y: 950 / 1280 } });
  assert.equal(withSel.started, true);
  assert.equal(withSel.res.count, referencePositionCount(script, withSel.tGo).count);
});
test("no practice stand (skipped): extension unverifiable -> never 'measured'", () => {
  const script = [["sit", 3000], ...cyc(12), ["sit", 30000]];
  const { res } = run(script, {}, { goAt: 2500, coreOpts: { practiceStand: "skip" } });
  assert.ok(res && res.status !== "measured");
});
