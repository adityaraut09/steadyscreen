// Session decision model (checkpoint 3): completion, count basis, evidence, CDC-table eligibility.
// Spec: docs/DECISION_RULES.md (written before this file; an independent oracle derived
// tests/fixtures/decision_matrix_expected.json from the spec + CDC form). One pure function used by the
// report, the review screen and the JSON export, so none of them can bypass a gate (audit B, C).
import { CDC_30S_BELOW_AVERAGE } from "./norms.js";
import { hasImageAt, RISE_RESOLVED_FLAGS } from "./coverage.js";
export const DECISION_VERSION = "decision-2 (checkpoint 4)";


const WINDOW_MS = 30000;
// Plain-language names for review items in blocker messages (overnight UX: no internal keys shown to users).
const FLAG_LABEL = {
  gap_during_movement: "a moment the participant could not be measured while moving",
  another_person_overlapped: "another person overlapping the participant",
  participant_reacquired_with_other_person_in_view: "the participant lost and found again while someone else was visible",
  identity_or_landmark_discontinuity: "a sudden jump of body points (possible person mix-up)",
  intermittent_tracking: "the participant measured in only part of the frames",
  seated_baseline_drift: "the participant sitting lower than at the camera check",
  expiry_endpoint_not_observed: "the participant not measured at the very end",
  reference_posture_warning: "the practice-stand (reference) posture warning: bent knees or hips",
  stand_dipped_without_sitting: "a deep dip while standing that came back up without sitting",
};
const flagLabel = (f) => FLAG_LABEL[f] || f.replace(/_/g, " ");
export const MIN_ADDED_SEPARATION_MS = 1000;   // [ENG] two added stands closer than this are treated as one stand added twice

/** Strict integer parsing (audit I): digits only, no sign, decimals, exponents, spaces. */
export function parseStrictInt(text, maxDigits, min, max) {
  if (typeof text === "number") text = String(text);
  if (typeof text !== "string" || !new RegExp(`^\\d{1,${maxDigits}}$`).test(text)) return null;
  const v = Number(text);
  return Number.isInteger(v) && v >= min && v <= max ? v : null;
}

export function cdcCategory(count, ageText, column) {
  const age = parseStrictInt(ageText, 3, 0, 999);
  if (age === null) return { ok: false, reason: "age not entered as a whole number" };
  if (column !== "men" && column !== "women") return { ok: false, reason: "table column (men/women) not entered" };
  const row = CDC_30S_BELOW_AVERAGE.find((r) => age >= r.min && age <= r.max);
  if (!row) return { ok: false, reason: `the CDC table covers ages 60-94 only (entered age ${age})` };
  if (!Number.isInteger(count) || count < 0) return { ok: false, reason: "no valid count" };
  const threshold = row[column];
  return { ok: true, category: count < threshold ? "below_average" : "not_below_average", threshold, band: `${row.min}-${row.max}, ${column}` };
}

export function completionOf(result, observer) {
  if (observer && observer.arms === "yes") return "protocol_stop_arms";                        // R1 (CDC arm-use rule)
  const r = result.reason;
  // 0.5-ms guard: (tGo + 30000) - tGo can be 29999.999999999996 in floating point (checkpoint-4 diagnostic)
  if (r === "expired") return result.window && result.window.observedMs >= WINDOW_MS - 0.5 ? "completed_30s" : "incomplete";
  if (r === "stopped") return "stopped_early";
  if (r === "stream_end") return "incomplete";
  return "interrupted";                                                                         // page_hidden, camera_error, unknown
}

/**
 * v2 (docs/CONTRACTS_CP4.md): every observer decision is honoured only where its own evidence exists (coverage.js);
 * corrections work in both directions (partial -> full, observer-added missed stands); the supervisor count is a
 * separate basis that is used only by explicit choice; a conflict between eligible automatic and supervisor counts
 * yields no value until the observer chooses a basis with a rationale.
 */
export function decide(session) {
  const { result, source, observer = {}, evidence = {}, manual = null, participant = {}, basisChoice = null } = session;
  const completion = completionOf(result, observer);
  const blockers = [];
  // images exist if the coverage lists any (contract s6 shape: imageTimes; imageCount is optional)
  const nImg = (c) => (c ? (Number.isFinite(c.imageCount) ? c.imageCount : (c.imageTimes || []).length) : 0);
  const cov = evidence.available === true && evidence.coverage && nImg(evidence.coverage) > 0 ? evidence.coverage : null;
  const evCovered = (n) => !!(cov && cov.events[n] && cov.events[n].ok);
  const res = evidence.eventResolutions || {};
  const resOf = (n) => (evCovered(n) ? res[n] : undefined);                                   // resolutions need that rise's image
  const events = result.events || [];
  // Observer-added missed stands (overnight fix ON-02, docs/CONTRACTS_CP4.md s9): each must sit exactly at a kept image,
  // inside the 30-s window, outside every detected rise (a detected rise is corrected on its own card, never re-added)
  // and at least MIN_ADDED_SEPARATION_MS from another added stand. Anything else is not counted AND blocks interpretation.
  const addedOk = [], addedProblems = [], addedReview = [];
  if (cov) {
    const tGo = result.window.tGo, tEnd = result.window.tEnd, at = (t) => ((t - tGo) / 1000).toFixed(1);
    const list = [...(evidence.added || [])].sort((a, b) => ((a && a.t) ?? 0) - ((b && b.t) ?? 0));
    const bad = (a, msg) => { addedProblems.push(msg); addedReview.push({ id: a && a.id, t: a && a.t, counted: false, problem: msg }); };
    for (const a of list) {
      if (!a || !Number.isFinite(a.t)) { bad(a, "An added stand has no valid time."); continue; }
      if (!hasImageAt(cov, a.t)) { bad(a, `The added stand at ${at(a.t)} s is not at a kept image.`); continue; }
      if (a.t < tGo || a.t > tEnd) { bad(a, `The added stand at ${at(a.t)} s is outside the 30-second test.`); continue; }
      const inRise = events.find((e) => Number.isFinite(e.tRise) && a.t >= e.tRise && a.t <= (e.tSeat ?? e.tExpiry ?? tEnd));
      if (inRise) { bad(a, `The added stand at ${at(a.t)} s is inside detected rise ${inRise.n}: undo it and decide on rise ${inRise.n} instead.`); continue; }
      const prev = addedOk[addedOk.length - 1];
      if (prev && a.t - prev.t < MIN_ADDED_SEPARATION_MS) { bad(a, `The added stands at ${at(prev.t)} s and ${at(a.t)} s are less than ${MIN_ADDED_SEPARATION_MS / 1000} s apart (the same stand added twice?): undo one.`); continue; }
      addedOk.push(a); addedReview.push({ id: a.id, t: a.t, counted: true, problem: null });
    }
  } else for (const a of evidence.added || []) addedReview.push({ id: a && a.id, t: a && a.t, counted: false, problem: "No evidence images: added stands cannot be used." });
  const added = addedOk;
  const countable = completion === "completed_30s" && result.status !== "withheld";          // (ON-30) nothing is counted otherwise
  if (!countable) for (const a of addedReview) if (a.counted) { a.counted = false; a.problem = "Not counted: this was not a completed, measured 30-second test."; }

  // ---- automatic range (completed, not withheld) ----
  let automatic = null;
  if (completion === "completed_30s" && result.status !== "withheld") {
    let min = 0, max = 0;
    for (const e of events) {
      const r = resOf(e.n);
      if (e.counted) { if (r === "not_full") continue; if (r === "cant_tell") { max++; continue; } min++; max++; }
      else if (e.cls === "uncertain") { if (r === "full") { min++; max++; } else if (r !== "not_full") max++; }
      else if (e.cls === "partial") { if (r === "full") { min++; max++; } else if (r === "cant_tell") max++; }
    }
    min += added.length; max += added.length;
    automatic = { min, max, determinate: min === max, added: added.length, eligible: false, blockers: [] };

    // ---- evidence gate for interpreting the automatic count ----
    const ab = automatic.blockers;
    ab.push(...addedProblems);
    if (!cov) ab.push("No evidence images were kept, so the automatic count cannot be checked afterwards.");
    else {
      const ref = result.reference;
      if (!ref || !ref.accepted || ref.usedAsReference === false) ab.push("No practice stand was accepted as the full-standing reference.");
      else if (ref.accepted.basis !== "image") ab.push("The practice-stand reference was accepted without looking at its image, so it cannot be used to check the automatic count.");
      else if (!cov.reference || !cov.reference.ok) ab.push("There is no image of the practice stand, so the reference cannot be checked.");
      const needId = events.filter((e) => e.counted || e.cls === "uncertain" || resOf(e.n) === "full").map((e) => e.n);
      const missing = needId.filter((n) => !evCovered(n));
      if (missing.length) ab.push(`No image near the top of rise ${missing.join(", ")}: those rises cannot be checked.`);
      const confirmedFor = new Set(evidence.identityConfirmedFor || []);
      // (overnight ON-12: with no rise that needs checking - e.g. a genuine automatic 0 - there is nothing to confirm identity on;
      // the whole-test scan below still has to be done)
      // (overnight ON-23, decided: an observer-added stand is itself the observer's judgement on that image - "a stand by the
      // participant happens here" - so it does not need a separate identity answer; the add control says so explicitly)
      if (needId.length && (evidence.identityConfirmed !== true || needId.some((n) => !confirmedFor.has(n)))) ab.push("The identity of the measured person was not confirmed in the images of every rise.");
      const uncertain = events.filter((e) => e.cls === "uncertain");
      const risesDecided = uncertain.every((e) => resOf(e.n) === "full" || resOf(e.n) === "not_full");
      for (const f of result.reviewFlags || []) {
        if (RISE_RESOLVED_FLAGS.has(f)) { if (!risesDecided) ab.push("Section 3: decide every rise marked \"needs your decision\" (full stand or not; at 30 s: over halfway or not)."); continue; }
        const fc = cov.flags[f];
        if (!fc || !fc.ok) ab.push(`Section 5: ${flagLabel(f)} - no continuous images for that time, so it cannot be checked.`);
        else if ((evidence.flagChecks || {})[f] !== "ok") ab.push(`Section 5: check ${flagLabel(f)} in its images.`);
      }
      // the 30-s endpoint matters if any expiry event/flag exists (derived from the result, not trusted from the input)
      const endpointRelevant = events.some((e) => e.cls === "expiry" || (e.flags || []).some((x) => /^expiry_/.test(x))) ||
        (result.reviewFlags || []).some((f) => /^expiry_/.test(f)) || !!(result.expiry && result.expiry.decision && !["none", "closed_descending_rise"].includes(result.expiry.decision));
      if (endpointRelevant && !(cov.endpoint && cov.endpoint.ok)) ab.push("No image at the 30-second mark, so the final (halfway) decision cannot be checked.");
      if (!cov.scan.ok) ab.push(`Images are missing between ${cov.scan.gaps.map(([a, b]) => `${((a - result.window.tGo) / 1000).toFixed(1)}-${((b - result.window.tGo) / 1000).toFixed(1)} s`).join(", ")}: missed stands cannot be ruled out.`);
      else if (evidence.sessionScan !== "no_missed") ab.push(evidence.sessionScan === "missed" ? "You reported a missed stand that has not been added from the images." : "The whole-test images were not checked for missed stands.");
    }
    automatic.eligibleExceptRange = ab.length === 0;
    if (!automatic.determinate) ab.push(`${automatic.max - automatic.min} rise(s) are unresolved (count ${automatic.min}-${automatic.max}).`);
    automatic.eligible = ab.length === 0;
  }

  // ---- supervisor count (separate basis) ----
  let supervisor = { valid: false, value: null };
  if (manual) {
    const v = parseStrictInt(manual.text, 2, 0, 60);
    const ok = v !== null && typeof manual.reason === "string" && manual.reason.trim().length > 0;
    supervisor = { valid: ok, value: ok ? v : null, reason: manual.reason };
  }
  let choice = basisChoice && (basisChoice.basis === "automatic" || basisChoice.basis === "supervisor") && typeof basisChoice.rationale === "string" && basisChoice.rationale.trim() ? basisChoice.basis : null;
  // overnight fix ON-03: a choice records the counts the observer saw ("at"); if either count changed since, the choice is
  // stale and ignored (the observer must choose again). Callers that omit "at" (pre-overnight tests) are not checked.
  let staleChoice = false;
  if (choice && basisChoice.at) {
    const a = basisChoice.at;
    staleChoice = (a.automaticMin ?? null) !== (automatic ? automatic.min : null) || (a.automaticMax ?? null) !== (automatic ? automatic.max : null) || (a.supervisor ?? null) !== supervisor.value;
    if (staleChoice) choice = null;
  }
  // conflict: the automatic basis is usable (apart from an open range) and a valid supervisor count differs from it, or the
  // automatic value is still a range (oracle v2 case G03: an open range is not silently decided while a supervisor count exists)
  const conflict = completion === "completed_30s" && !!automatic && automatic.eligibleExceptRange && supervisor.valid &&
    (!automatic.determinate || supervisor.value !== automatic.min);

  // ---- value ----
  let value = null, basis = "", valueText = "Not reported", rangeCategory = false;
  if (completion === "protocol_stop_arms") { value = 0; basis = "CDC rule: arms used to stand -> record 0 (observer answer)"; }
  else if (completion !== "completed_30s") { basis = "No score: not a completed 30-second test"; }
  else if (choice === "supervisor" && supervisor.valid && source === "camera") { value = supervisor.value; basis = "Supervisor's own count during a completed 30-s timed test (chosen by the observer; not image-verified)"; }
  else if (conflict && choice !== "automatic") { basis = `Counts disagree: camera (checked) ${automatic.min}, supervisor ${supervisor.value}. Choose which count to report.`; blockers.push("The camera count and your own count differ: choose which one to report, with a reason."); }
  else if (automatic && automatic.eligible) { value = automatic.min; basis = "Automatic count, checked by the observer against the evidence images" + (automatic.added ? `, including ${automatic.added} stand(s) the observer added from images` : "") + (supervisor.valid && supervisor.value === automatic.min ? " (the supervisor's own count agrees)" : conflict ? " (chosen over the differing supervisor count)" : ""); }
  else if (automatic) basis = "Automatic count not usable yet (see blockers)" + (supervisor.valid ? "; your own count is recorded but not chosen as the result" : "");
  else basis = supervisor.valid ? "Camera measurement withheld; your own count is recorded but not chosen as the result" : "Camera measurement withheld and no supervisor count chosen";
  if (staleChoice) blockers.push("The counts changed after you chose which one to report: choose again.");
  if (value !== null) valueText = String(value);
  else if (automatic && completion === "completed_30s") valueText = automatic.determinate ? `${automatic.min} (unchecked)` : `${automatic.min}-${automatic.max} (unresolved)`;

  // ---- CDC table eligibility (R7) ----
  if (completion !== "completed_30s" && completion !== "protocol_stop_arms") blockers.push("This was not a completed 30-second test.");
  if (source !== "camera") blockers.push("Replay of a video file: not a live test.");
  if (observer.setup !== "yes") blockers.push("Chair and helper setup not confirmed by the observer.");
  if (completion === "completed_30s" && observer.arms !== "no") blockers.push("Arm use not answered by the observer.");
  const ageV = parseStrictInt(participant.ageText, 3, 0, 999);
  if (ageV === null) blockers.push(String(participant.ageText ?? "").trim() === "" ? "Age not entered." : "Age not entered as a whole number.");
  else if (ageV < 60 || ageV > 94) blockers.push(`The CDC table covers ages 60-94 only (entered age ${ageV}).`);
  if (participant.column !== "men" && participant.column !== "women") blockers.push("Table column (men/women) not entered.");

  let category = null, threshold = null, band = null;
  // (overnight ON-11: after an explicit "camera count" choice with an open range, the range rule or the range blocker applies -
  // previously this path produced no value AND an empty blocker list)
  if (completion === "completed_30s" && value === null && (!conflict || choice === "automatic")) {
    if (automatic && !automatic.determinate && automatic.eligibleExceptRange && (!supervisor.valid || choice === "automatic")) {
      const a = cdcCategory(automatic.min, participant.ageText, participant.column), b = cdcCategory(automatic.max, participant.ageText, participant.column);
      if (a.ok && b.ok && a.category === b.category) { rangeCategory = true; category = a.category; threshold = a.threshold; band = a.band; valueText = `${automatic.min}-${automatic.max}`;
        basis = "Automatic count still a range (some rises undecided); both ends fall in the same CDC table category"; }
      else blockers.push(...automatic.blockers);
    } else if (automatic) {
      blockers.push(...automatic.blockers);
      if (supervisor.valid && choice !== "automatic") blockers.push("To report your own count instead, choose it explicitly with a reason.");
    } else if (supervisor.valid) blockers.push("To report your own count, choose it explicitly with a reason.");
    else blockers.push("No valid count (camera measurement withheld and no supervisor count).");
  }
  if (value !== null && blockers.length === 0) {
    const c = cdcCategory(value, participant.ageText, participant.column);
    if (c.ok) { category = c.category; threshold = c.threshold; band = c.band; } else blockers.push(c.reason);
  }
  const eligible = blockers.length === 0 && (value !== null || rangeCategory);
  if (!eligible) { category = null; threshold = null; band = null; }
  const title = completion === "completed_30s" || completion === "protocol_stop_arms"
    ? "30-Second Chair Stand — result" : "Chair-stand session — NOT a completed 30-second test";
  const machineCount = events.filter((e) => e.counted).length;
  return { version: DECISION_VERSION, completion, value, valueText, basis, automatic, supervisor, conflict, basisChoice: choice, staleChoice, addedReview,
    counts: { machine: completion === "completed_30s" && result.status !== "withheld" ? machineCount : null, reviewed: automatic ? automatic.min : null, supervisor: supervisor.value },
    manualValid: supervisor.valid, manualValue: supervisor.value, manualUsed: choice === "supervisor" && value === supervisor.value && supervisor.valid,
    reference: { eligible, blockers: [...new Set(blockers)], category, threshold, band, fromRange: rangeCategory }, title };
}
