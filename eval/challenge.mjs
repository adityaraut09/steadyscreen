// Synthetic challenge set for the chair-stand core. Expected outcomes were written BEFORE the first run
// (2026-09-26) and are the pass criteria; a failing case is reported, not silently re-specified.
// CHECKPOINT 3 ADAPTER: core 0.6 requires a practice stand before "Go". The scenarios below are UNCHANGED; runScenario()
// replaces the old 2.5-s seated prefix by [practice stand + 0.5 s sit] and shifts every absolute time in the options by
// SHIFT ms, so each movement keeps the same position relative to "Go". 'ref' expectations now use the CDC POSITION
// rule oracle (referencePositionCount); the old velocity-based referenceCount is still reported for comparison.
// The unadapted checkpoint-2 file is preserved as eval/challenge_cp2_historical.mjs.
// These are engineering tests on generated skeletons, not evidence about real people or clinical accuracy.
import { createChairStand } from "../app/src/core/chair_stand.js";
import { render, referenceCount, referencePositionCount, PRACTICE, PRACTICE_GO } from "./synth.mjs";
import { writeFileSync, mkdirSync } from "node:fs";
import { acceptDetectedReference } from "./observer_sim.mjs";   // cp4: practice-stand acceptance (all scenarios use a full practice stand)

const T_GO = 2000;                   // app would issue "Go" once readiness holds; scripts sit still for 2.5 s first
const pre = [["sit", 2500]];
const cyc = (n, rise = 700, stand = 400, desc = 700, sit = 500) =>
  Array.from({ length: n }, () => [["rise", rise], ["stand", stand], ["descend", desc], ["sit", sit]]).flat();
const pad = (ms) => [["sit", ms]];
// 10 cycles (end at 28.5 s), then a 2 s rise placed so that rise progress at the 30 s expiry (t=32 s) equals alphaTarget
function expiryScript(alphaTarget, riseMs = 2000) {
  const u = Math.acos(1 - 2 * alphaTarget) / Math.PI;       // inverse of the cosine ease
  const riseStart = T_GO + 30000 - u * riseMs;
  return [...pre, ...cyc(10, 800, 400, 800, 600), ...pad(riseStart - 28500), ["rise", riseMs], ["stand", 3000]];
}

// expect: {status: [...allowed], count: number|null|'ref'}  ('ref' = CDC reference count from the script)
export const SCENARIOS = [
  { id: "zero_rises", script: [...pre, ...pad(32000)], expect: { status: ["measured"], count: 0 } },
  { id: "one_rise", script: [...pre, ...pad(3000), ...cyc(1), ...pad(28000)], expect: { status: ["measured"], count: 1 } },
  { id: "normal_12", script: [...pre, ...cyc(13, 800, 400, 800, 400), ...pad(3000)], expect: { status: ["measured"], count: "ref" } },
  { id: "fast_20", script: [...pre, ...cyc(24, 450, 150, 450, 250), ...pad(3000)], expect: { status: ["measured"], count: "ref" } },
  { id: "slow_with_standing_pauses", script: [...pre, ...cyc(5, 1500, 3000, 1500, 1500), ...pad(3000)], expect: { status: ["measured"], count: "ref" } },
  { id: "partial_rises", script: [...pre, ...cyc(2), ["partial", 1200, 0.35], ["sit", 600], ...cyc(2), ["partial", 1200, 0.4], ["sit", 600], ["partial", 1000, 0.3], ["sit", 600], ...cyc(1), ...pad(20000)], expect: { status: ["measured"], count: 5 } },
  { id: "seated_rest_midtest", script: [...pre, ...cyc(4), ...pad(8000), ...cyc(5), ...pad(10000)], expect: { status: ["measured"], count: "ref" } },
  // last rise reaches full standing at ~29.3 s after Go and the person stays up: counted without a later descent
  { id: "final_rise_no_descent", script: [...pre, ...cyc(10, 800, 400, 800, 600), ...pad(1800), ["rise", 700], ["stand", 5000]], expect: { status: ["measured"], count: "ref" } },
  // expiry midway through a rise. v1 of these three scripts was mis-timed (the rise began after 30 s), found on the
  // first run; scripts re-timed with expiryScript() below, expectations unchanged.
  { id: "expiry_over_halfway", script: expiryScript(0.6), expect: { status: ["measured"], count: "ref" }, note: "alpha 0.6 at 30 s (h~0.89 vs halfway ~0.55)" },
  { id: "expiry_under_halfway", script: expiryScript(0.12), expect: { status: ["measured"], count: "ref" }, note: "alpha 0.12 at 30 s (h~0.21)" },
  { id: "expiry_near_halfway", script: expiryScript(0.34), expect: { status: ["needs_review"], count: "any" }, note: "alpha 0.34 at 30 s (h~0.57, within review band of halfway)" },
  { id: "expiry_while_descending", script: [...pre, ...cyc(11, 800, 400, 800, 600), ...pad(200), ["rise", 700], ["stand", 300], ["descend", 2000], ["sit", 3000]], expect: { status: ["measured"], count: "ref" } },
  { id: "truncated_stream_20s", script: [...pre, ...cyc(8), ...pad(10000)], opts: { durationMs: 22000 }, expect: { status: ["incomplete"], count: null } },
  { id: "camera_drift_and_zoom", script: [...pre, ...cyc(12), ...pad(3000)], opts: { drift: { dx: 150, dy: -60, scale0: 0.8, scale1: 1.1 } }, expect: { status: ["measured"], count: "ref" } },
  { id: "short_gaps_while_seated", script: [...pre, ...cyc(10), ...pad(3000)], opts: { poseGaps: [[5250, 5400], [12250, 12400], [19250, 19400]] }, expect: { status: ["measured"], count: "ref" }, note: "150 ms dropouts" },
  { id: "gap_400ms_during_rise", script: [...pre, ...cyc(10), ...pad(3000)], opts: { poseGaps: [[9500, 9900]] }, expect: { status: ["needs_review"], count: "any" }, note: "v1 gap [8900,9300] fell while seated (script error); moved into the rise 9400-10100" },
  { id: "long_gap_1200ms", script: [...pre, ...cyc(10), ...pad(3000)], opts: { poseGaps: [[10000, 11200]] }, expect: { status: ["withheld"], count: null } },
  { id: "frames_stop_3s_hidden_tab", script: [...pre, ...cyc(10), ...pad(3000)], opts: { gaps: [[14000, 17000]] }, expect: { status: ["withheld"], count: null } },
  { id: "leg_occlusion_2s", script: [...pre, ...cyc(10), ...pad(3000)], opts: { legOcclusion: [[15000, 17000]] }, expect: { status: ["withheld"], count: null } },
  { id: "low_light_noisy", script: [...pre, ...cyc(12), ...pad(3000)], opts: { noisePx: 8, dropFrac: 0.12, visScale: 0.7, seed: 7 }, expect: { status: ["measured", "needs_review", "withheld"], count: "ref_if_reported" } },
  { id: "helper_beside_static", script: [...pre, ...cyc(12), ...pad(3000)], opts: { helper: { x: 700 } }, expect: { status: ["measured"], count: "ref" } },
  { id: "helper_listed_first", script: [...pre, ...cyc(12), ...pad(3000)], opts: { helper: { x: 700, first: true } }, expect: { status: ["measured"], count: "ref" }, note: "helper pose returned before participant by the detector" },
  { id: "helper_crosses_in_front", script: [...pre, ...cyc(12), ...pad(3000)], opts: { helper: { xAt: (t) => (t > 12000 && t < 15000 ? 700 - (t - 12000) * 0.25 : 700) } }, expect: { status: ["needs_review", "withheld"], count: "not_silently_wrong" } },
  { id: "identity_trap_participant_lost_helper_in_place", script: [...pre, ...cyc(12), ...pad(3000)], opts: { poseGaps: [[10000, 14000]], helper: { xAt: (t) => (t >= 10000 && t < 14000 ? 400 : null) } }, expect: { status: ["withheld", "needs_review"], count: "not_silently_wrong" }, note: "participant vanishes; a standing person appears at the same spot" },
  { id: "arms_uncrossed", script: [...pre, ...cyc(12), ...pad(3000)], opts: { arms: "sides" }, expect: { status: ["measured"], count: "ref", protocolFlag: "arms_possibly_uncrossed" } },
  { id: "low_fps_6", script: [...pre, ...cyc(8, 1000, 500, 1000, 800), ...pad(3000)], opts: { fps: 6 }, expect: { status: ["withheld"], count: null } },
  { id: "landmark_swap_spikes", script: [...pre, ...cyc(12), ...pad(3000)], opts: { swapFrac: 0.05, seed: 3 }, expect: { status: ["measured", "needs_review"], count: "ref" } },
  { id: "standing_at_calibration", script: [["stand", 5000], ...cyc(5)], expect: { status: ["never_ready"], count: null } },
  { id: "two_seated_people", script: [...pre, ...cyc(10), ...pad(3000)], opts: { helper: { x: 650, y0: 1150, seated: true } }, expect: { status: ["never_ready", "measured"], count: "ref_if_reported" }, note: "second person rendered standing (generator limitation) -> tracker picks the seated one" },
];

const SHIFT = PRACTICE_GO + 500 - 2500;         // new position of the old content start minus the old one (= 3700 ms)
const shiftSpans = (spans) => (spans || []).map(([a, b]) => [a + SHIFT, b + SHIFT]);
// Expectation changes introduced at checkpoint 3 (original expectation still reported as passOriginal).
export const CP3_EXPECTATION_CHANGES = {
  low_fps_6: { status: ["never_ready", "withheld"], count: null,
    why: "core 0.6 refuses to START when fewer than 8 usable frames/s arrive during the seated readiness window (audit G: sparse observation must not certify stillness). The original expectation 'withheld' presumed the test could start." },
};
export function adaptScenario(sc) {
  const script = sc.script[0][0] === "sit" && sc.script[0][1] === 2500 ? [...PRACTICE, ["sit", 500], ...sc.script.slice(1)] : [...sc.script];
  const o = { ...(sc.opts || {}) };
  for (const k of ["gaps", "poseGaps", "legOcclusion"]) if (o[k]) o[k] = shiftSpans(o[k]);
  if (o.durationMs) o.durationMs += SHIFT;
  if (o.helper && o.helper.xAt) { const f = o.helper.xAt; o.helper = { ...o.helper, xAt: (t) => f(t - SHIFT) }; }
  return { ...sc, script, opts: o };
}

export function runScenario(sc0) {
  const sc = adaptScenario(sc0);
  const T_GO3 = T_GO + SHIFT;
  const data = render(sc.script, { durationMs: T_GO3 + 500 + 32000, ...(sc.opts || {}) });
  const core = createChairStand({ width: data.width, height: data.height });
  let started = false, never = false, res = null;
  for (const f of data.frames) {
    if (!started && f.t >= T_GO3) {
      if (core.readiness().ready) { core.start(f.t); started = true; }
      else if (f.t >= T_GO3 + 3000) { never = true; break; }
    }
    const snap = core.push(f);
    acceptDetectedReference(core);
    if (snap.result) { res = snap.result; break; }
  }
  if (started && !res) res = core.finish("stream_end", data.frames[data.frames.length - 1].t);
  const refOld = started ? referenceCount(data.truth, res.window.tGo) : null;
  const ref = started ? referencePositionCount(sc.script, res.window.tGo) : null;
  const status = never || !started ? "never_ready" : res.status;
  const e = sc.expect;
  let countOK = true;
  if (e.count === "ref") countOK = res && res.count === ref.count;
  else if (typeof e.count === "number") countOK = res && res.count === e.count;
  else if (e.count === null) countOK = !res || res.count === null;
  else if (e.count === "ref_if_reported" || e.count === "not_silently_wrong") countOK = !res || res.count === null || res.count === ref.count || status !== "measured";
  if (e.count === "ref_if_reported") countOK = !res || res.count === null || res.count === ref.count;
  const statusOK = e.status.includes(status);
  const flagOK = !e.protocolFlag || (res && res.protocolFlags.includes(e.protocolFlag));
  const passOriginal = statusOK && countOK && flagOK;
  const ch = CP3_EXPECTATION_CHANGES[sc.id];
  const passCp3 = ch ? ch.status.includes(status) && (ch.count === null ? !res || res.count === null : true) : passOriginal;
  return {
    id: sc.id, pass: passCp3, passOriginal, cp3ExpectationChange: ch ? ch.why : null, status, expectedStatus: e.status.join("|"),
    count: res ? res.count : null, countRange: res ? res.countRange : null, refCount: ref ? ref.count : null, refCountVelocityOracle: refOld ? refOld.count : null,
    expiry: ref ? ref.case : null, expectedCount: e.count,
    reviewFlags: res ? res.reviewFlags.join(";") : "", withheld: res ? res.withheldReasons.join(";") : "",
    protocolFlags: res ? res.protocolFlags.join(";") : "", events: res ? res.events.map((x) => x.cls).join(",") : "",
    usableFps: res ? res.quality.usableFps : null, note: sc.note || "",
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rows = SCENARIOS.map(runScenario);
  mkdirSync("eval/results", { recursive: true });
  writeFileSync("eval/results/cp3/challenge_synthetic_cp3.json", JSON.stringify(rows, null, 1));
  for (const r of rows) console.log(`${r.pass ? "PASS" : "FAIL"}${r.passOriginal === r.pass ? "" : "*"} ${r.id.padEnd(46)} status=${r.status.padEnd(12)} count=${String(r.count).padEnd(4)} ref=${String(r.refCount).padEnd(4)} ${r.withheld || r.reviewFlags} ${r.protocolFlags}`);
  console.log(`\n${rows.filter((r) => r.passOriginal).length}/${rows.length} meet the ORIGINAL pre-written expectation; ${rows.filter((r) => r.pass).length}/${rows.length} meet the checkpoint-3 expectation (* = changed, see CP3_EXPECTATION_CHANGES)`);
}
