// Unit tests: run with `npm test` (node --test). No browser, camera or video needed.
import test from "node:test";
import assert from "node:assert/strict";
import { SCENARIOS, runScenario } from "../eval/challenge.mjs";
import { cdcReference } from "../app/src/core/norms.js";
import { createChairStand } from "../app/src/core/chair_stand.js";
import { render, PRACTICE, PRACTICE_GO } from "../eval/synth.mjs";
import { decide } from "../app/src/core/decision.js";
import { acceptDetectedReference } from "../eval/observer_sim.mjs";

// Known, disclosed limitation (docs/PROTOCOL_CLAIM_CONTRACT.md): a person replacing the participant at the
// same spot and posture, with no visible transition, cannot be told apart by pose geometry alone.
const KNOWN_LIMITATIONS = new Set(["identity_trap_participant_lost_helper_in_place"]);

for (const sc of SCENARIOS) {
  test(`challenge: ${sc.id}`, { todo: KNOWN_LIMITATIONS.has(sc.id) ? "known limitation, see contract" : false }, () => {
    const r = runScenario(sc);
    assert.ok(r.pass, JSON.stringify(r));
  });
}

test("CDC table: examples straight from the form", () => {
  assert.deepEqual(cdcReference(11, 67, "men"), { applies: true, belowAverage: true, threshold: 12, band: "65-69, men" });
  assert.equal(cdcReference(12, 67, "men").belowAverage, false);
  assert.equal(cdcReference(3, 92, "women").belowAverage, true);
  assert.equal(cdcReference(4, 92, "women").belowAverage, false);
});

test("CDC table: never applied outside 60-94, without sex, or without a valid count", () => {
  assert.equal(cdcReference(15, 16, "men").applies, false);       // teenage demo participant
  assert.equal(cdcReference(10, 95, "women").applies, false);     // no row for 95+
  assert.equal(cdcReference(10, 70, null).applies, false);
  assert.equal(cdcReference(null, 70, "men").applies, false);
});

test("core: timestamps must increase", () => {
  const core = createChairStand({ width: 720, height: 1280 });
  core.push({ t: 10, poses: [] });
  assert.throws(() => core.push({ t: 10, poses: [] }));
});

test("core: cannot start before readiness", () => {
  const core = createChairStand({ width: 720, height: 1280 });
  core.push({ t: 0, poses: [] });
  assert.throws(() => core.start(0), /not ready/);
});

test("core: observer stop -> 'stopped', no score", () => {
  const d = render([...PRACTICE, ["sit", 800], ["rise", 700], ["stand", 400], ["descend", 700], ["sit", 8000]]);
  const core = createChairStand({ width: d.width, height: d.height });
  for (const f of d.frames) {
    if (core.phase === "calibrating") { core.push(f); acceptDetectedReference(core); if (f.t >= PRACTICE_GO && core.readiness().ready) core.start(f.t); continue; }
    core.push(f); if (f.t > PRACTICE_GO + 4000) break;
  }
  const r = core.finish("stopped", PRACTICE_GO + 4000);
  assert.equal(r.status, "stopped"); assert.equal(r.count, null); assert.equal(r.countSoFar, 1);
});

test("core: page hidden -> withheld even if frames looked fine", () => {
  const d = render([...PRACTICE, ["sit", 800], ["rise", 700], ["stand", 400], ["descend", 700], ["sit", 8000]]);
  const core = createChairStand({ width: d.width, height: d.height });
  for (const f of d.frames) {
    if (core.phase === "calibrating") { core.push(f); acceptDetectedReference(core); if (f.t >= PRACTICE_GO && core.readiness().ready) core.start(f.t); continue; }
    core.push(f); if (f.t > PRACTICE_GO + 3000) break;
  }
  const r = core.finish("page_hidden", PRACTICE_GO + 3000);
  assert.equal(r.status, "withheld"); assert.equal(r.count, null);
});

test("identity trap (pose-only limitation): the wrong automatic count cannot become an interpreted result", () => {
  const r = runScenario(SCENARIOS.find((s) => s.id === "identity_trap_participant_lost_helper_in_place"));
  // the core alone cannot tell (known limitation) ... (core 0.8 sends one rise of this scenario to review, but the
  // automatic count is still wrong and the true count is outside the reported range)
  assert.ok(["measured", "needs_review"].includes(r.status), r.status);
  assert.ok(r.countRange.max < r.refCount, JSON.stringify({ range: r.countRange, truth: r.refCount }));
  // ... but the decision layer never interprets an automatic count without images reviewed for identity
  const base = { result: { reason: "expired", status: "measured", window: { observedMs: 30000 }, events: Array.from({ length: r.count }, (_, i) => ({ n: i + 1, cls: "full", counted: true, flags: [] })), reviewFlags: [] },
    source: "camera", observer: { arms: "no", setup: "yes" }, participant: { ageText: "70", column: "men" } };
  assert.equal(decide({ ...base, evidence: { available: false } }).reference.eligible, false);
  assert.equal(decide({ ...base, evidence: { available: true, identityConfirmed: null } }).reference.eligible, false);
  assert.equal(decide({ ...base, evidence: { available: true, identityConfirmed: false } }).reference.eligible, false);
});
