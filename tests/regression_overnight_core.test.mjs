// Overnight core/decision regressions (core 0.8.0). Each case reproduces a defect found by the overnight adversarial
// review on tag `overnight-start` (docs/OVERNIGHT_ISSUES.json). Truth comes from the motion generator (eval/synth.mjs:
// alpha 1 = full extension; referencePositionCount = CDC position rule), never from core output.
// The safety property asserted throughout: the core may ask for review, but it must never SILENTLY report a wrong count
// (status "measured" with count != truth, or a range that excludes the truth).
import test from "node:test";
import assert from "node:assert/strict";
import { createChairStand } from "../app/src/core/chair_stand.js";
import { decide } from "../app/src/core/decision.js";
import { skeleton, motion, PRACTICE, PRACTICE_GO, referencePositionCount } from "../eval/synth.mjs";

function run(script, { fps = 30, poseAt = null } = {}) {
  const M = motion(script);
  const c = createChairStand({ width: 720, height: 1280 });
  let started = false; const answered = new Set(); let lastT = 0;
  for (let i = 0; ; i++) {
    const t = Math.round(i * 1000 / fps); if (t > M.totalMs) break;
    if (c.phase === "calibrating" && t >= PRACTICE_GO && !started) {
      const pr = c.readiness().practice || {};
      if (pr.state === "detected" && !answered.has(pr.refId)) { answered.add(pr.refId); c.acceptReference({ refId: pr.refId, basis: "image" }); }
      if (c.readiness().ready) { c.start(t); started = true; }
    }
    const a = M.alphaAt(t);
    const s = c.push({ t, poses: poseAt ? poseAt(t, a, c.phase) : [skeleton(a)] });
    lastT = t;
    if (s.result) return s.result;
  }
  assert.ok(started, "test never started");
  return c.finish("stream_end", lastT);
}
const cyc = (n, { rise = 800, stand = 400, descend = 800, sit = 400 } = {}) => Array.from({ length: n }, () => [["rise", rise], ["stand", stand], ["descend", descend], ["sit", sit]]).flat();
function notSilentlyWrong(r, truth, label) {
  const ctx = `${label}: status ${r.status} count ${r.count} range ${JSON.stringify(r.countRange)} cls ${r.events.map((e) => e.cls[0]).join("")} truth ${truth}`;
  if (r.status === "withheld") return;
  if (r.status === "measured") assert.equal(r.count, truth, ctx);
  else assert.ok(r.countRange.min <= truth && truth <= r.countRange.max, ctx);
}

// ON-05: shoulders poorly visible during the test -> angles unmeasured -> must not become silent "partial"
for (const vis of [0.45, 0.3]) test(`ON-05 shoulders visibility ${vis} during the test: 5 genuine stands are never silently lost`, () => {
  const poseAt = (t, a, phase) => { const lm = skeleton(a); if (phase === "running") for (const i of [11, 12]) lm[i] = [...lm[i].slice(0, 3), vis, lm[i][4]]; return [lm]; };
  const r = run([...PRACTICE, ...cyc(5), ["sit", 30000]], { poseAt });
  notSilentlyWrong(r, 5, "shoulders hidden");
  assert.ok(r.events.filter((e) => e.cls === "partial").length === 0, "a full-height rise with unmeasured angles was classed partial");
});
test("ON-05 control: angles unmeasured but a clearly low rise (h shortfall) is still partial", () => {
  const poseAt = (t, a, phase) => { const lm = skeleton(phase === "running" ? a * 0.5 : a); if (phase === "running") for (const i of [11, 12]) lm[i] = [...lm[i].slice(0, 3), 0.3, lm[i][4]]; return [lm]; };
  const r = run([...PRACTICE, ...cyc(5), ["sit", 30000]], { poseAt });
  assert.equal(r.count, 0);
  assert.ok(r.events.every((e) => e.cls === "partial"), r.events.map((e) => e.cls).join());
});

// ON-06: the participant sits back down higher than at calibration ("perched") -> stands must not merge silently
for (const sitAlpha of [0.12, 0.15, 0.2]) test(`ON-06 perched sits at alpha ${sitAlpha}: 8 stands never silently merged`, () => {
  const script = [...PRACTICE, ...cyc(8, { sit: 500 }), ["sit", 30000]];
  const r = run(script, { poseAt: (t, a, phase) => [skeleton(phase === "running" ? sitAlpha + (1 - sitAlpha) * a : a)] });
  notSilentlyWrong(r, 8, `perched ${sitAlpha}`);
  assert.equal(r.events.filter((e) => e.counted).length + r.events.filter((e) => e.cls === "uncertain").length >= 8, true);
});
for (const floor of [0.13, 0.15, 0.2]) test(`ON-06 one sit (of 8) only down to alpha ${floor}: truth inside the range, never silently 7`, () => {
  const script = [...PRACTICE, ...cyc(8, { sit: 500 }), ["sit", 30000]];
  const w0 = PRACTICE_GO + 3 * 2500 + 1200, w1 = PRACTICE_GO + 4 * 2500;          // cycle 3's descend + sit (cycles are 2500 ms)
  const r = run(script, { poseAt: (t, a, phase) => [skeleton(phase === "running" && t >= w0 && t < w1 + 800 ? Math.max(a, floor) : a)] });
  notSilentlyWrong(r, 8, `one perched ${floor}`);
});
test("ON-06 control: normal sits are unaffected (8 counted, measured)", () => {
  const r = run([...PRACTICE, ...cyc(8), ["sit", 30000]]);
  assert.equal(r.status, "measured"); assert.equal(r.count, 8);
});

// ON-07: 30-s endpoint decided on a lagging smoothed signal at lower frame rates
test("ON-07 endpoint sweep (fps 30/20/15/12/10/9; 3 rise speeds): no silent endpoint error", () => {
  const bad = [];
  for (const fps of [30, 20, 15, 12, 10, 9]) for (const riseMs of [800, 1000, 1400]) for (let frac = 0.05; frac < 1; frac += 0.05) {
    const tEnd = PRACTICE_GO + 30000, lastRiseStart = Math.round(tEnd - frac * riseMs);
    const script = [...PRACTICE, ...cyc(11), ["sit", lastRiseStart - PRACTICE_GO - 11 * 2400], ["rise", riseMs], ["stand", 1500], ["descend", 800], ["sit", 3000]];
    const ref = referencePositionCount(script, PRACTICE_GO);
    const r = run(script, { fps });
    if (r.status === "measured" && r.count !== ref.count) bad.push(`fps ${fps} rise ${riseMs} frac ${frac.toFixed(2)}: measured ${r.count}, CDC ${ref.count} (${ref.case})`);
    if (r.status === "needs_review" && !(r.countRange.min <= ref.count && ref.count <= r.countRange.max)) bad.push(`fps ${fps} rise ${riseMs} frac ${frac.toFixed(2)}: range ${JSON.stringify(r.countRange)} excludes CDC ${ref.count}`);
  }
  assert.deepEqual(bad, []);
});

// ON-08: brief stands at low accepted frame rates must not become silent partials
test("ON-08 fast stands (no hold) at 8.5-15 fps: never silently lost", () => {
  const bad = [];
  for (const fps of [15, 12, 10, 9, 8.5]) for (const [rise, stand, descend, sit] of [[600, 100, 600, 300], [500, 0, 500, 300], [450, 0, 450, 250]]) {
    const r = run([...PRACTICE, ...cyc(8, { rise, stand, descend, sit }), ["sit", 30000]], { fps });
    if (r.status === "withheld") continue;
    const ok = r.status === "measured" ? r.count === 8 : r.countRange.min <= 8 && 8 <= r.countRange.max;
    if (!ok) bad.push(`fps ${fps} ${rise}/${stand}/${descend}/${sit}: ${r.status} ${r.count} ${JSON.stringify(r.countRange)} ${r.events.map((e) => e.cls[0]).join("")}`);
  }
  assert.deepEqual(bad, []);
});

// ON-09: the accepted reference must be the posture shown on the card (values frozen at detection)
test("ON-09 participant sags while the observer reads the card: the accepted reference is the shown (upright) posture", () => {
  const c = createChairStand({ width: 720, height: 1280 });
  const ease = (u) => 0.5 - 0.5 * Math.cos(Math.PI * Math.max(0, Math.min(1, u)));
  const alpha = (t) => t < 1500 ? 0 : t < 2300 ? ease((t - 1500) / 800) : t < 3300 ? 1 : t < 6300 ? 1 - 0.15 * (t - 3300) / 3000 : t < 6600 ? 0.85 : t < 7400 ? 0.85 * (1 - ease((t - 6600) / 800)) : 0;
  let shown = null;
  for (let t = 0; t < 9000; t += 33) {
    const pr = c.readiness().practice;
    if (pr.state === "detected" && !shown) { shown = { refId: pr.refId, knee: pr.knee, hip: pr.hip, h: pr.h }; c.freezeReference(pr.refId); }   // the app freezes when it shows the card
    if (shown && t >= 6400 && pr.state === "detected") c.acceptReference({ refId: shown.refId, basis: "image" });
    c.push({ t, poses: [skeleton(alpha(t))] });
  }
  const pr = c.readiness().practice;
  assert.ok(shown, "no card");
  if (pr.state === "accepted") { assert.equal(pr.knee, shown.knee); assert.equal(pr.hip, shown.hip); assert.equal(pr.h, shown.h); }
  else assert.notEqual(pr.state, "accepted");
});

// ON-13: reselecting the participant after a differently sized person was locked first
test("ON-13 helper (1.6x size) locked first, participant then selected: camera check can become ready", () => {
  const scale = (lm, sc, cx, cy) => lm.map(([x, y, z, v, p]) => [(x - cx) * sc + cx, (y - cy) * sc + cy, z, v, p]);
  const M = motion([...PRACTICE, ["sit", 20000]]);
  const c = createChairStand({ width: 720, height: 1280 });
  const helper = () => scale(skeleton(1, { x0: 150 }), 1.6, 150 / 720, 1150 / 1280);
  for (let t = 0; t < 2000; t += 33) c.push({ t, poses: [helper()] });
  c.selectParticipant(400 / 720, 900 / 1280);
  for (let t = 2000; t < 2000 + M.totalMs; t += 33) {
    c.push({ t, poses: [skeleton(M.alphaAt(t - 2000)), helper()] });
    const pr = c.readiness().practice; if (pr.state === "detected") c.acceptReference({ refId: pr.refId, basis: "image" });
  }
  assert.equal(c.readiness().ready, true, JSON.stringify(c.readiness().reasons));
});

// ---------- decision ----------
const tGo = 6000, tEnd = 36000;
const imageTimes = []; for (let t = 1000; t <= tEnd + 200; t += 166) imageTimes.push(t);
function covered(events, extra = {}) {
  const coverage = { imageCount: imageTimes.length, imageTimes, reference: { ok: true }, events: Object.fromEntries(events.map((e) => [e.n, { ok: true }])), flags: {}, endpoint: { ok: true, required: false }, scan: { ok: true, gaps: [] } };
  const result = { reason: "expired", status: events.some((e) => e.cls === "uncertain") ? "needs_review" : "measured", window: { tGo, tEnd, observedMs: 30000 }, events, reviewFlags: events.some((e) => e.cls === "uncertain") ? ["uncertain_rises"] : [], flagWindows: {},
    reference: { id: 1, t0: 2000, t1: 2600, accepted: { basis: "image" }, usedAsReference: true, postureWarning: false } };
  return { result, source: "camera", observer: { arms: "no", setup: "yes" }, participant: { ageText: "70", column: "women" },
    evidence: { available: true, coverage, identityConfirmed: true, identityConfirmedFor: events.filter((e) => e.counted || e.cls === "uncertain").map((e) => e.n), sessionScan: "no_missed", added: [], eventResolutions: {}, flagChecks: {} }, ...extra };
}
const ev = (n, cls) => ({ n, cls, counted: cls === "full", tRise: 7000 + n * 2500, tFull: cls === "full" ? 7800 + n * 2500 : null, tPeak: 7900 + n * 2500, tSeat: 8800 + n * 2500, flags: [] });

test("ON-11 open range + supervisor count + explicit camera-count choice: never 'no value and no reason'", () => {
  const events = [ev(1, "full"), ev(2, "full"), ev(3, "full"), ev(4, "full"), ev(5, "full")];   // rise 5 marked "can't tell" -> range 4-5
  for (const age of ["70", "61"]) {
    const s = covered(events, { manual: { text: "5", reason: "counted" }, basisChoice: { basis: "automatic", rationale: "prefer camera" }, participant: { ageText: age, column: "women" } });
    s.evidence.eventResolutions = { 5: "cant_tell" };
    const d = decide(s);
    assert.ok(d.reference.eligible || d.reference.blockers.length > 0, `age ${age}: not eligible and no blocker`);
    if (!d.reference.eligible) assert.ok(/unresolved/.test(d.reference.blockers.join(" ")), d.reference.blockers.join(" | "));
  }
});
test("ON-12 a genuine automatic 0 (all rises partial) can become interpretable after the whole-test scan", () => {
  const s = covered([ev(1, "partial"), ev(2, "partial")]);
  s.evidence.identityConfirmed = null;
  const d = decide(s);
  assert.equal(d.value, 0); assert.equal(d.reference.eligible, true);
  s.evidence.sessionScan = null;
  assert.equal(decide(s).reference.eligible, false, "the whole-test scan must still be required");
});
test("ON-12 control: identity is still required when any rise is counted", () => {
  const s = covered([ev(1, "full"), ev(2, "partial")]); s.evidence.identityConfirmed = null; s.evidence.identityConfirmedFor = [];
  assert.equal(decide(s).reference.eligible, false);
});

// ---------- second fresh adversarial pass on the repaired tree (core 0.8.1) ----------
// ON-19: a participant sitting down at the 30-s mark must not get a made-up "rise in progress" rise
test("ON-19 sitting down across the 30-s mark (slow descents, 30/20/15 fps): no extra event after the 12 credited stands", () => {
  const tEnd = PRACTICE_GO + 30000; const bad = [];
  for (const fps of [30, 20, 15]) for (const desc of [1500, 2500, 3500]) for (let off = 0; off <= desc; off += 100) {
    const descStart = tEnd - off, riseStart = descStart - 500 - 800, sitLen = riseStart - PRACTICE_GO - 11 * 2400;
    if (sitLen < 200) continue;                                   // (a negative sit makes the synthetic motion discontinuous)
    const r = run([...PRACTICE, ...cyc(11), ["sit", sitLen], ["rise", 800], ["stand", 500], ["descend", desc], ["sit", 3000]], { fps });
    if (r.events.length !== 12 || r.count !== 12) bad.push(`fps ${fps} desc ${desc} off ${off}: ${r.events.length} events, count ${r.count}, ${r.events.slice(12).map((e) => e.cls + "[" + e.flags + "]")}`);
  }
  assert.deepEqual(bad, []);
});
// ON-22: a rise after a perched (seat-not-reached) sit must never be counted automatically, also at 30 s
test("ON-22 perched dip then rising at 30 s: never auto-counted (12, or review including 12)", () => {
  const tEnd = PRACTICE_GO + 30000;
  for (const dip of [0.2, 0.25]) for (const off of [150, 250, 350, 450]) {
    const riseBack = tEnd - off, dipStart = riseBack - 300 - 900, stand12 = dipStart - 500 - 800, sitLen = stand12 - PRACTICE_GO - 11 * 2400;
    const script = [...PRACTICE, ...cyc(11), ["sit", sitLen], ["rise", 800], ["stand", 500], ["descend", 900], ["sit", 300], ["rise", 800], ["stand", 2000]];
    const r = run(script, { poseAt: (t, a) => [skeleton(t >= dipStart && t < riseBack + 800 ? dip + (1 - dip) * a : a)] });
    const ctx = `dip ${dip} off ${off}: ${r.status} ${r.count} ${JSON.stringify(r.countRange)} ${r.events.slice(11).map((e) => e.cls + (e.counted ? "*" : "") + "[" + e.flags + "]")}`;
    assert.ok(r.events.filter((e) => e.counted).length <= 12, ctx);
    if (r.status === "measured") assert.equal(r.count, 12, ctx); else assert.ok(r.countRange.min <= 12 && 12 <= r.countRange.max, ctx);
  }
});
// ON-20: angles seen only low in the rise (hidden at the top) are not evidence of a partial stand
for (const thr of [0.9, 0.8, 0.7]) test(`ON-20 joint angles hidden above alpha ${thr}: 5 genuine full stands never silently partial`, () => {
  const poseAt = (t, a, phase) => { const lm = skeleton(a); if (phase === "running" && a > thr) for (const i of [11, 12]) lm[i] = [...lm[i].slice(0, 3), 0.4, lm[i][4]]; return [lm]; };
  const r = run([...PRACTICE, ...cyc(5), ["sit", 30000]], { poseAt });
  notSilentlyWrong(r, 5, `angles hidden > ${thr}`);
});
// ON-21: a participant who straightens slowly at the top of the practice stand: the reference is the most extended window
test("ON-21 slow straightening during the practice stand: reference = full extension, incomplete test rises not counted", () => {
  const ease = (u) => 0.5 - 0.5 * Math.cos(Math.PI * Math.max(0, Math.min(1, u)));
  for (const [extFrom, extMs] of [[0.85, 1500], [0.85, 3500], [0.88, 3500]]) {
    const t1 = 1500, t2 = t1 + 800, t3 = t2 + extMs, t4 = t3 + 1000, t5 = t4 + 800, go = t5 + 1800;
    const alpha = (t) => t < t1 ? 0 : t < t2 ? extFrom * ease((t - t1) / 800) : t < t3 ? extFrom + (1 - extFrom) * (t - t2) / extMs : t < t4 ? 1 : t < t5 ? 1 - ease((t - t4) / 800) : 0;
    const c = createChairStand({ width: 720, height: 1280 }); let shown = null;
    for (let t = 0; t < go; t += 33) {
      c.push({ t, poses: [skeleton(alpha(t))] });
      const pr = c.readiness().practice;
      if (pr.state === "detected" && !shown) { shown = pr; c.freezeReference(pr.refId); }             // the app shows the card
    }
    assert.ok(shown, "card never offered");
    assert.ok(shown.knee >= 178, `extFrom ${extFrom} over ${extMs} ms: reference knee ${shown.knee} (not the full extension)`);
  }
});

// ---------- third fresh adversarial pass + mutation re-run (core 0.8.2) ----------
// ON-26: stale smoothed angles at the top at 15-20 fps (shoulders hidden near upright) must not make genuine stands partial
for (const fps of [30, 20, 15]) for (const thr of [0.7, 0.8, 0.9]) test(`ON-26 ${fps} fps, angles hidden above alpha ${thr}: 6 genuine stands never silently partial`, () => {
  const poseAt = (t, a, phase) => { const lm = skeleton(a); if (phase === "running" && a > thr) for (const i of [11, 12]) lm[i] = [...lm[i].slice(0, 3), 0.4, lm[i][4]]; return [lm]; };
  const r = run([...PRACTICE, ...cyc(6), ["sit", 30000]], { fps, poseAt });
  notSilentlyWrong(r, 6, `fps ${fps} thr ${thr}`);
  assert.equal(r.events.filter((e) => e.cls === "partial").length, 0, r.events.map((e) => e.cls).join());
});
// ON-27: shoulders hidden near upright ALSO during the practice stand: the reference must not take its angles from 1-2 frames
test("ON-27 shoulders hidden near upright in practice and test: incomplete rises are never counted as full", () => {
  const poseAt = (t, a) => { const lm = skeleton(a); if (a > 0.85) for (const i of [11, 12]) lm[i] = [...lm[i].slice(0, 3), 0.4, lm[i][4]]; return [lm]; };
  for (const fps of [30, 15]) {
    const script = [...PRACTICE, ...cyc(6), ...cyc(6).map(([k, d]) => [k, d]), ["sit", 30000]];
    const M = motion(script); let n = 0;
    const r = run(script, { fps, poseAt: (t, a, phase) => { if (phase === "running") { const cycle = Math.floor((t - PRACTICE_GO) / 2400); n = cycle; if (cycle >= 6) return poseAt(t, a * 0.8); } return poseAt(t, a); } });
    const counted = r.events.filter((e) => e.counted).length;
    assert.ok(counted <= 6, `fps ${fps}: ${counted} counted (truth: 6 full + 6 incomplete) ${r.events.map((e) => e.cls[0]).join("")}`);
    void M; void n;
  }
});
// ON-28: a 2-3 frame landmark glitch mid-hold must not end the practice stand (and void an acceptance moments later)
test("ON-28 a brief hip glitch during the practice hold does not end the stand", () => {
  const M = motion([["sit", 1500], ["rise", 800], ["stand", 2500], ["descend", 800], ["sit", 3000]]);
  const c = createChairStand({ width: 720, height: 1280 }); const ids = new Set(); let offeredWhileStanding = false;
  for (let t = 0; t < 8600; t += 33) {
    const lm = skeleton(M.alphaAt(t));
    if (t >= 3900 && t < 4000) for (const i of [23, 24]) lm[i] = [lm[i][0], lm[i][1] + 150 / 1280, lm[i][2], lm[i][3], lm[i][4]];
    c.push({ t, poses: [lm] });
    const pr = c.readiness().practice; if (pr.refId) ids.add(pr.refId);
    if (pr.state === "detected" && M.alphaAt(t) > 0.9) offeredWhileStanding = true;
  }
  assert.equal(offeredWhileStanding, false, "card offered while still standing");
  assert.equal(ids.size, 1, `ids ${[...ids]}`);
});
// ON-29 + mutation gaps: rises after perched sits never counted; half-sits flagged, never silently merged
for (const sitAlpha of [0.12, 0.2, 0.3]) test(`ON-29 perched ${sitAlpha}: no counted event carries seat_return_not_confirmed`, () => {
  const r = run([...PRACTICE, ...cyc(8, { sit: 500 }), ["sit", 30000]], { poseAt: (t, a, phase) => [skeleton(phase === "running" ? sitAlpha + (1 - sitAlpha) * a : a)] });
  assert.equal(r.events.filter((e) => e.counted && e.flags.includes("seat_return_not_confirmed")).length, 0);
  notSilentlyWrong(r, 8, `perched ${sitAlpha}`);
});
for (const sitAlpha of [0.35, 0.45, 0.5]) test(`ON-29 half-sits staying above halfway (alpha ${sitAlpha}) are flagged, never silently 'measured'`, () => {
  const r = run([...PRACTICE, ...cyc(8, { sit: 500 }), ["sit", 30000]], { poseAt: (t, a, phase) => [skeleton(phase === "running" ? sitAlpha + (1 - sitAlpha) * a : a)] });
  assert.notEqual(r.status, "measured", `${r.count} ${r.reviewFlags}`);
  assert.ok(r.reviewFlags.includes("stand_dipped_without_sitting") || r.reviewFlags.includes("uncertain_rises"), r.reviewFlags.join());
});
test("mutation gap: the KNEE posture warning (knee < 158 deg) is raised on its own", async () => {
  const { PARAMS } = await import("../app/src/core/params.js");
  assert.equal(PARAMS.referenceWarnKneeDeg, 158);
  // bend only the knee of the practice stand by moving the ankle forward (hip angle stays ~straight)
  const bentKnee = (a) => { const lm = skeleton(a); if (a > 0.9) for (const i of [27, 28, 29, 30, 31, 32]) lm[i] = [lm[i][0] + 95 / 720, lm[i][1] - 10 / 1280, lm[i][2], lm[i][3], lm[i][4]]; return lm; };
  const M = motion([...PRACTICE, ["sit", 3000]]);
  const c = createChairStand({ width: 720, height: 1280 }); let pr = null;
  for (let t = 0; t < 8000; t += 33) { c.push({ t, poses: [bentKnee(M.alphaAt(t))] }); const p = c.readiness().practice; if (p.state === "detected") pr = p; }
  assert.ok(pr, "no practice stand offered");
  if (pr.knee < 158 && pr.hip >= 165) assert.equal(pr.postureWarning, true, JSON.stringify(pr));
  else assert.fail(`fixture did not isolate the knee: knee ${pr.knee} hip ${pr.hip}`);
});

// ---------- fourth fresh adversarial pass (core 0.8.3) ----------
// ON-31: a stand completed before 30 s but not auto-confirmed, with the participant descending below halfway at 30 s, was
// labelled "partial" and dropped silently (also in core 0.7). Scenarios from the 4th reviewer's realistic generator.
import { session as rsession, runCore as rrun, truthCount as rtruth, NEW as RNEW } from "../eval/synth_realistic.mjs";
import { rng as srng } from "../eval/synth.mjs";
// CDC truth: tops reached in (GO, GO+30 s], plus one if over halfway and still rising at 30 s; near halfway either is accepted
function checkRealistic(r, sess, tStart, label) {
  const t = rtruth(sess, tStart);
  const ok = (v) => (t.kase === "near" ? v === t.n || v === t.n + 1 : v === t.nWithExpiry);
  if (r.status === "withheld") return;
  if (r.status === "measured") assert.ok(ok(r.count), `${label}: measured ${r.count}, CDC truth ${t.nWithExpiry} (${t.kase})`);
  else assert.ok([t.n, t.n + 1].some((v) => ok(v) && r.countRange.min <= v && v <= r.countRange.max), `${label}: range ${JSON.stringify(r.countRange)}, CDC truth ${t.nWithExpiry} (${t.kase})`);
}
test("ON-31 a stand completed just before 30 s and descending at 30 s is never silently dropped (reviewer's two repro cases)", () => {
  const cases = [
    [{ riseMs: [900, 1300], holdMs: [100, 400], descMs: [900, 1300], sitMs: [300, 600], leanJit: 0.06, lead: 1460 }, 30, 6],
    [{ riseMs: [1200, 1800], holdMs: [0, 150], descMs: [1000, 1500], sitMs: [300, 700], pauseP: 0.1, rockP: 0.2, lateP: 0.2, topAlpha: [0.985, 1], leanJit: 0.02, practice: { late: true, sway: 0.01 }, lead: 2240 }, 20, 4],
  ];
  for (const [sty, fps, seed] of cases) {
    const sess = rsession(sty, srng(seed * 1009 + fps));
    const out = rrun(RNEW, sess, { fps, noisePx: 3, shoulderFlick: 0.05, legFlick: 0.02, tJit: fps <= 15 ? 12 : 6, drop: 0.02, seed, leanBase: (seed % 3) * 0.06 });
    const r = out.r;
    checkRealistic(r, sess, out.tStart, `fps ${fps} seed ${seed}`);
    assert.ok(!r.events.some((e) => e.cls === "partial" && e.flags.includes("expiry_under_halfway") && e.tPeak < r.window.tEnd - 300 && e.peak && e.peak.h > 1.0), "a completed top was labelled under-halfway partial");
  }
});
test("burden guard (realistic synthetic, 30 fps, 3 px jitter): no silent errors and <= 5% of genuine stands sent to review", () => {
  let genuine = 0, unc = 0;
  for (const [sty, seed] of [[{ riseMs: [900, 1300], holdMs: [100, 400], descMs: [900, 1300], sitMs: [300, 600], leanJit: 0.04 }, 1], [{ riseMs: [1200, 2200], holdMs: [100, 500], descMs: [1000, 1600], sitMs: [300, 700], pauseP: 0.1, rockP: 0.2, lateP: 0.2, leanJit: 0.03, practice: { late: true, sway: 0.01 } }, 2]])
    for (let k = 0; k < 6; k++) {
      const sess = rsession(sty, srng(seed * 7919 + k));
      const out = rrun(RNEW, sess, { fps: 30, noisePx: 3, shoulderFlick: 0.02, legFlick: 0.01, tJit: 6, drop: 0.01, seed: seed * 31 + k, leanBase: 0.03 });
      if (!out.r) continue;
      checkRealistic(out.r, sess, out.tStart, `style ${seed} k ${k}`);
      genuine += rtruth(sess, out.tStart).n; unc += out.r.events.filter((e) => e.cls === "uncertain").length;
    }
  assert.ok(genuine > 50, `only ${genuine} genuine stands`);
  assert.ok(unc / genuine <= 0.05, `${unc}/${genuine} sent to review`);
});

// ---------- fifth fresh adversarial pass (core 0.8.4) ----------
// ON-35: a completed but unconfirmed top, then descending at/below about halfway at 30 s: the review must ask "full stand?",
// never only the 30-s halfway question (an honest "not over halfway" answer would lose a completed stand)
test("ON-35 descending after an unconfirmed top near/below halfway at 30 s -> 'full stand?' question, truth kept in range", () => {
  const bad = [];
  for (const fps of [30, 20, 15]) for (let off = 400; off <= 1150; off += 50) {
    const tEnd = PRACTICE_GO + 30000, top = tEnd - off - 250, firstRise = top - 1200;
    const n = Math.floor((firstRise - PRACTICE_GO - 100) / 3500), lead = firstRise - PRACTICE_GO - n * 3500;
    const script = [...PRACTICE, ["sit", lead], ...Array.from({ length: n }, () => [["rise", 1200], ["stand", 300], ["descend", 1200], ["sit", 800]]).flat(), ["rise", 1200], ["stand", 250], ["descend", 1200], ["sit", 5000]];
    const r = run(script, { fps, poseAt: (t, a, phase) => { const lm = skeleton(a); if (phase === "running" && t > firstRise - 100 && a > 0.9) for (const k of [11, 12]) lm[k] = [lm[k][0], lm[k][1], 0, 0.3, 0.99]; return [lm]; } });
    const truth = n + 1, last = r.events[r.events.length - 1];
    const asksHalfwayOnly = last && !last.counted && last.cls !== "partial" && last.flags.some((f) => /^expiry_/.test(f)) && (r.expiry.hRaw ?? r.expiry.h) < r.expiry.halfway;
    if (asksHalfwayOnly) bad.push(`fps ${fps} off ${off}: halfway question although below halfway (${last.flags})`);
    if (r.status === "measured" ? r.count !== truth : !(r.countRange && r.countRange.min <= truth && truth <= r.countRange.max) && r.status !== "withheld") bad.push(`fps ${fps} off ${off}: ${r.status} ${JSON.stringify(r.countRange)} truth ${truth}`);
  }
  assert.deepEqual(bad, []);
});

// ---------- sixth fresh adversarial pass (core 0.8.5) ----------
// ON-39 (introduced by ON-35 in 0.8.4): a failed rise that sinks back (not to the seat) and a SECOND push rising just over
// halfway at 30 s must get the 30-s question (review), not "was the earlier top a full stand?"
test("ON-39 second push rising over halfway at 30 s inside one open attempt -> never silently decided", () => {
  const ease = (u) => 0.5 - 0.5 * Math.cos(Math.PI * Math.max(0, Math.min(1, u)));
  const prof = (keys) => (t) => { if (t <= keys[0][0]) return keys[0][1]; for (let i = 1; i < keys.length; i++) { const [t0, a0] = keys[i - 1], [t1, a1] = keys[i]; if (t <= t1) return a0 + (a1 - a0) * ease((t - t0) / Math.max(1, t1 - t0)); } return keys[keys.length - 1][1]; };
  const bad = [];
  for (const fps of [30, 15]) for (const p1 of [0.6, 0.8]) for (const d of [0.14, 0.22]) for (const x of [0.3, 0.34, 0.38]) {
    let tStart = null, keys = null;
    const poseAt = (t, a, phase) => {
      if (phase !== "running" && tStart === null) return [skeleton(a)];
      if (tStart === null) {
        tStart = t; const E = tStart + 30000; keys = [[tStart, 0]];
        let tt = tStart + 1000; for (let i = 0; i < 6; i++) { keys.push([tt, 0], [tt + 1000, 1], [tt + 1400, 1], [tt + 2400, 0]); tt += 3000; }
        const f = (x - d) / (1 - d), u = Math.acos(1 - 2 * f) / Math.PI, t2 = E - u * 1600, tPeak = t2 - 1300, tS = tPeak - 1500;
        keys.push([tS, 0], [tPeak, p1], [t2, d], [t2 + 1600, 1], [t2 + 5000, 1]);
      }
      return [skeleton(prof(keys)(t))];
    };
    const r = run([...PRACTICE, ["sit", 40000]], { fps, poseAt });
    const over = r.expiry.hRaw > r.expiry.halfway, near = Math.abs(r.expiry.hRaw - r.expiry.halfway) <= 0.03;
    const truths = near ? [6, 7] : [6 + (over ? 1 : 0)];
    const ok = r.status === "measured" ? truths.includes(r.count) : truths.some((v) => r.countRange.min <= v && v <= r.countRange.max);
    const asksFullAboutOldTop = r.expiry.decision === "closed_descending_rise" && over && !near;
    if (!ok || asksFullAboutOldTop) bad.push(`fps ${fps} p1 ${p1} d ${d} x ${x}: ${r.status} ${JSON.stringify(r.countRange)} ${r.expiry.decision} raw ${r.expiry.hRaw} half ${r.expiry.halfway}`);
  }
  assert.deepEqual(bad, []);
});
