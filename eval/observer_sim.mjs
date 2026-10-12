// Test-harness stand-in for the observer's practice-stand confirmation (core 0.7+, docs/CONTRACTS_CP4.md s1).
// Used ONLY by harnesses whose synthetic practice stand is a genuine full stand (generator alpha 1), i.e. what an
// honest observer would accept. Tests of incomplete references drive acceptance explicitly instead.
export function acceptDetectedReference(core, basis = "observer_watched") {
  if (!core || core.phase !== "calibrating" || !core.acceptReference) return false;
  const pr = core.readiness().practice || {};
  if (pr.state === "detected") return core.acceptReference({ refId: pr.refId, basis });
  return false;
}
