// Demo mode (simulated participant, app/src/ui/demo.js). The demo must be deterministic, its practice stand must be a
// genuine full stand (so accepting it is correct), and the UNCHANGED core must find exactly the outcome the demo is built
// to show: 10 full stands, 1 rise that needs the observer's decision, and 1 rise counted by the CDC 30-s rule.
// The demo's results are labelled as simulated everywhere they appear (report, record). Engineering tests of the demo
// script only: the demo is not evidence about real people.
import test from "node:test";
import assert from "node:assert/strict";
import { createChairStand } from "../app/src/core/chair_stand.js";
import { PARAMS } from "../app/src/core/params.js";
import { decide } from "../app/src/core/decision.js";
import { computeCoverage } from "../app/src/core/coverage.js";
import { legGeometry } from "../app/src/core/pose_features.js";
import { buildReport } from "../app/src/ui/report.js";
import { createDemoScript, bodyAt, landmarksOf, STANDS, EXPECTED, GO_LEAD_MS, LAST_RISE_MS, PRACTICE, DEMO_LABEL, DEMO_W, DEMO_H,
  decisionSource, demoRecord } from "../app/src/ui/demo.js";

/** Drive the demo like the app: frames at `fps` on a performance-like clock, the observer accepts (or first rejects) the
 *  practice card, waits `goDelay` ms, then GO. Optional frame-time jitter and dropped frames (seeded). */
function runDemo({ fps = 30, phase = 0, jitterMs = 0, drop = 0, goDelay = 2500, base = 123456.7, reject = 0, seed = undefined } = {}) {
  const script = createDemoScript(seed === undefined ? {} : { seed });
  const core = createChairStand({ width: DEMO_W, height: DEMO_H });
  let r = 7; const rnd = () => { r = (r * 16807) % 2147483647; return r / 2147483647; };
  let acceptedAt = null, tGo = null, last = -Infinity, res = null, rejected = 0, ref = null;
  const times = [];
  script.start(base);
  for (let i = 0; i < 200000 && !res; i++) {
    let t = base + phase + (i * 1000) / fps + (jitterMs ? (rnd() - 0.5) * 2 * jitterMs : 0);
    if (t <= last) t = last + 0.5;
    if (drop && rnd() < drop) continue;
    last = t; times.push(t);
    const s = core.push({ t, poses: [script.landmarksAt(t)] });
    if (s.result) { res = s.result; break; }
    if (core.phase !== "calibrating") continue;
    script.react(t, s.readiness);
    const pr = s.readiness.practice;
    if (pr.state === "detected" && acceptedAt === null) {
      if (rejected < reject) { core.rejectReference(pr.refId); rejected += 1; continue; }
      core.freezeReference(pr.refId); assert.ok(core.acceptReference({ refId: pr.refId, basis: "image" })); acceptedAt = t; ref = pr;
    }
    if (acceptedAt !== null && t > acceptedAt + goDelay && core.readiness().ready) { tGo = t + 3; core.start(tGo); script.go(tGo); }
  }
  return { res, script, tGo, acceptedAt, ref, times, rejected };
}
const classes = (res) => res.events.reduce((m, e) => ({ ...m, [e.cls]: (m[e.cls] || 0) + 1 }), {});
const summary = (res) => ({ status: res.status, reason: res.reason, count: res.count, range: res.countRange, classes: classes(res),
  uncertainN: res.events.filter((e) => e.cls === "uncertain").map((e) => e.n), withheld: res.withheldReasons, expiry: res.expiry.decision });

test("demo legs and trunk follow eval/synth.mjs skeleton(): hip height 1.1*sin(90deg*alpha), knee angle 90+90*alpha, side view", () => {
  for (const a of [0, 0.25, 0.5, 0.75, 0.87, 1]) {
    const g = legGeometry(landmarksOf(bodyAt(a)), DEMO_W, DEMO_H, null);
    assert.ok(Math.abs(g.h - 1.1 * Math.sin((Math.PI / 2) * a)) < 0.01, `h at alpha ${a}: ${g.h}`);
    assert.ok(Math.abs(g.knee - (90 + 90 * a)) < 0.5, `knee at alpha ${a}: ${g.knee}`);
    assert.ok(g.viewRatio < PARAMS.sideViewMaxShoulderRatio, "side view");
  }
});

test("demo script is deterministic: same times give identical landmarks; another seed gives other jitter", () => {
  const a = createDemoScript(), b = createDemoScript(), c = createDemoScript({ seed: 1 });
  for (const s of [a, b, c]) s.start(1000);
  for (const t of [1000, 1033.3, 4200, 5100.5, 9000]) {
    assert.deepEqual(a.landmarksAt(t), b.landmarksAt(t));
    assert.notDeepEqual(a.landmarksAt(t), c.landmarksAt(t));
  }
  // jitter is small: a few pixels
  const clean = landmarksOf(bodyAt(a.alphaAt(4200)));
  const d = a.landmarksAt(4200).map((p, i) => Math.hypot((p[0] - clean[i][0]) * DEMO_W, (p[1] - clean[i][1]) * DEMO_H));
  assert.ok(Math.max(...d) < 10 && d.reduce((x, y) => x + y, 0) / d.length < 4, `jitter px: max ${Math.max(...d)}`);
});

test("demo session run twice gives the identical core result", () => {
  const x = runDemo(), y = runDemo();
  assert.deepEqual(JSON.parse(JSON.stringify(x.res)), JSON.parse(JSON.stringify(y.res)));
});

test("demo practice stand is a genuine full stand: detected, side view, no posture warning, accepted", () => {
  const { res, ref } = runDemo();
  assert.equal(ref.state, "detected");
  assert.equal(ref.sideView, true);
  assert.equal(ref.postureWarning, false);
  assert.ok(ref.knee > 176 && ref.hip > 176, `reference angles ${ref.knee}/${ref.hip}`);
  assert.ok(Math.abs(ref.h - 1.1) < 0.05, `reference h ${ref.h}`);
  assert.equal(res.reference.accepted.basis, "image");
  assert.equal(res.reference.usedAsReference, true);
  assert.equal(res.extensionCheck, "verified_side_view");
});

test("demo script design: one short rise inside the review band, cycles 2.4-2.8 s, the 30-s mark clearly over halfway on a rise", () => {
  const short = STANDS.filter((s) => s[4] < 1);
  assert.equal(short.length, 1);
  assert.equal(STANDS.indexOf(short[0]) + 1, EXPECTED.uncertainRise);
  const top = short[0][4];
  const kneeShort = 90 * (1 - top), hShort = 1.1 - 1.1 * Math.sin((Math.PI / 2) * top);
  assert.ok(kneeShort > PARAMS.fullKneeDeg && kneeShort <= PARAMS.partialFactor * PARAMS.fullKneeDeg, `knee shortfall ${kneeShort}`);
  assert.ok(hShort < PARAMS.fullH, `hip-height shortfall ${hShort}`);
  for (const [r, h, d, s] of STANDS) { const c = r + h + d + s; assert.ok(c >= 2400 && c <= 2800, `cycle ${c} ms`); }
  const tLast = GO_LEAD_MS + STANDS.reduce((x, [r, h, d, s]) => x + r + h + d + s, 0);
  const u = (PARAMS.windowMs - tLast) / LAST_RISE_MS;
  assert.ok(u > 0.5 && u < 0.8, `last rise ${Math.round(u * 100)}% done at 30 s`);
  const sc = createDemoScript(); sc.start(0); sc.go(10000);
  const hAt = (t) => 1.1 * Math.sin((Math.PI / 2) * sc.alphaAt(t));
  assert.ok(hAt(10000 + PARAMS.windowMs) - 0.55 > 3 * PARAMS.expiryNearHalfBand, "over halfway by a wide margin at 30 s");
  assert.ok(hAt(10000 + PARAMS.windowMs - 150) - 0.55 > 2 * PARAMS.expiryNearHalfBand, "...also 150 ms earlier (smoothing lag)");
  assert.ok(sc.alphaAt(10000 + PARAMS.windowMs) > sc.alphaAt(10000 + PARAMS.windowMs - 50), "rising at 30 s");
});

const CONDITIONS = [
  { name: "30 fps", o: {} },
  { name: "60 fps", o: { fps: 60 } },
  { name: "24 fps, frame-time jitter 6 ms", o: { fps: 24, jitterMs: 6 } },
  { name: "15 fps", o: { fps: 15 } },
  { name: "30 fps, 4% dropped frames, odd phase", o: { drop: 0.04, phase: 13.7 } },
  { name: "observer waits 40 s before GO", o: { goDelay: 40000 } },
  { name: "observer rejects the first practice stand (the demo repeats it)", o: { reject: 1 } },
];
for (const { name, o } of CONDITIONS) {
  test(`demo outcome (${name}): 10 full + 1 uncertain (rise 5) + 1 counted at 30 s -> count 11, range 11-12`, () => {
    const { res, rejected } = runDemo(o);
    assert.ok(res, "no result");
    if (o.reject) assert.equal(rejected, 1);
    const s = summary(res);
    assert.equal(s.reason, "expired");
    assert.equal(s.status, "needs_review");
    assert.deepEqual(s.withheld, []);
    assert.deepEqual(s.classes, { full: EXPECTED.full, uncertain: EXPECTED.uncertain, expiry: EXPECTED.expiry });
    assert.deepEqual(s.uncertainN, [EXPECTED.uncertainRise]);
    assert.equal(s.count, EXPECTED.counted);
    assert.deepEqual(s.range, { min: EXPECTED.rangeMin, max: EXPECTED.rangeMax });
    assert.equal(s.expiry, "counted_over_halfway");
    assert.deepEqual(res.reviewFlags, ["uncertain_rises"]);
    assert.deepEqual(res.protocolFlags, [], "arms seen crossed");
    const u = res.events.find((e) => e.cls === "uncertain");
    assert.ok(u.flags.includes("extension_not_confirmed"));
    assert.ok(u.shortfall.hip > PARAMS.fullHipDeg && u.shortfall.knee <= PARAMS.partialFactor * PARAMS.fullKneeDeg && u.shortfall.h < PARAMS.fullH, JSON.stringify(u.shortfall));
  });
}

// What the review screen does with this result, then the report and record (module level).
function reviewed() {
  const run = runDemo();
  const { res, times } = run;
  const imgs = []; for (const t of times) if (!imgs.length || t - imgs[imgs.length - 1] >= 150) imgs.push(t);   // ~6 images/s, as evidence.js
  const coverage = computeCoverage(res, imgs);
  const ids = res.events.filter((e) => e.counted || e.cls === "uncertain").map((e) => e.n);
  const review = { resolutions: { [EXPECTED.uncertainRise]: "not_full" }, flagChecks: {}, identityConfirmed: true, identityConfirmedFor: ids, sessionScan: "no_missed", added: [],
    basisChoice: null, arms: "no", setup: "yes", manual: null };
  const participant = { ageText: "72", column: "women" };
  const session = (source) => ({ result: res, source, observer: { arms: "no", setup: "yes" },
    evidence: { available: true, coverage, identityConfirmed: true, identityConfirmedFor: ids, eventResolutions: review.resolutions, flagChecks: {}, sessionScan: "no_missed", added: [] },
    manual: null, basisChoice: null, participant });
  return { ...run, coverage, review, participant, session, imgs };
}

test("demo review: deciding the short rise 'not a full stand' reports 11 with the CDC table (age 72, women: not below average)", () => {
  const { session, coverage } = reviewed();
  assert.equal(coverage.reference.ok, true); assert.equal(coverage.endpoint.required, true); assert.equal(coverage.endpoint.ok, true); assert.equal(coverage.scan.ok, true);
  const d = decide(session(decisionSource("demo")));
  assert.equal(d.completion, "completed_30s");
  assert.equal(d.value, 11);
  assert.deepEqual(d.reference.blockers, []);
  assert.equal(d.reference.eligible, true);
  assert.equal(d.reference.category, "not_below_average");
  assert.equal(d.reference.threshold, 10);
  // the decision gate itself is unchanged: an unmapped "demo" source would be treated like a replay (not live)
  assert.ok(decide(session("demo")).reference.blockers.some((b) => /not a live test/.test(b)));
});

test("decisionSource maps only the demo; camera and replay unchanged", () => {
  assert.equal(decisionSource("camera"), "camera");
  assert.equal(decisionSource("replay"), "replay");
  assert.equal(decisionSource("demo"), "camera");
});

test("demo report and record carry the simulated-demo label; a camera report does not", () => {
  const { res, coverage, review, participant, session, imgs, script } = reviewed();
  const d = decide(session(decisionSource("demo")));
  const sess = (source) => ({ source, result: res, coverage, review, participant, audit: [{ at: 0, what: "x" }], evidenceOn: true,
    evidenceStats: { frames: imgs.length, dropped: 0 }, loopStats: {}, startedAt: 0, replayName: null });
  const html = buildReport(sess("demo"), d);
  assert.ok(html.split(DEMO_LABEL).length - 1 >= 3, "label at the top, next to the number and in the footer");
  assert.match(html, /Source: <strong>SIMULATED DEMO/);
  assert.match(html, /Demo only \(simulated participant\):<\/strong> Not below average for 70-74, women/);
  assert.equal(((html.match(/class="final">([^<]*)</) || [])[1] || "").trim(), "11");
  assert.match(html, /class="final">11 <span class="demotag">Simulated demo/);
  const cam = buildReport(sess("camera"), d);
  assert.ok(!cam.includes(DEMO_LABEL) && !/SIMULATED|Demo only/.test(cam));
  assert.match(cam, /Source: <strong>live camera<\/strong>/);
  const rec = demoRecord(script);
  assert.equal(rec.simulated, true); assert.equal(rec.realPerson, false); assert.equal(rec.realMeasurement, false);
  assert.equal(rec.label, DEMO_LABEL);
  assert.deepEqual(rec.script.expected, { ...EXPECTED });
  assert.equal(rec.script.practiceStands, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(rec)), rec);
});

test("demo script: a practice stand is repeated only when the app asks, never after GO", () => {
  const sc = createDemoScript(); sc.start(0);
  assert.equal(sc.info().practiceStands, 1);
  const end1 = PRACTICE.firstLeadMs + PRACTICE.riseMs + PRACTICE.holdMs + PRACTICE.descendMs;
  sc.react(3000, { reasons: ["practice_stand_needed"] });                      // still planned/running: ignored
  assert.equal(sc.info().practiceStands, 1);
  sc.react(end1 + 2000, { reasons: ["hold_still_seated"] });                    // not asked
  assert.equal(sc.info().practiceStands, 1);
  sc.react(end1 + 2000, { reasons: ["practice_stand_needed"] });                // rejected: repeat
  assert.equal(sc.info().practiceStands, 2);
  assert.ok(sc.alphaAt(end1 + 2000 + PRACTICE.repeatLeadMs + PRACTICE.riseMs + 500) === 1, "second practice stand reaches full standing");
  sc.go(end1 + 20000);
  sc.react(end1 + 30000, { reasons: ["reference_stale"] });
  assert.equal(sc.info().practiceStands, 2);
  assert.equal(sc.alphaAt(end1 + 20000 + GO_LEAD_MS - 1), 0, "seated until GO + reaction time");
});
