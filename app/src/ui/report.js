// Printable summary and plain-language texts. All eligibility comes from decide() (app/src/core/decision.js):
// the title, the value, the CDC line and the export use the SAME decision object (audit B, C).
export const STATUS_TEXT = {
  measured: "Measured automatically",
  needs_review: "Counted automatically — needs checking",
  withheld: "No automatic count — the camera could not measure the participant reliably",
  incomplete: "Incomplete — the video or test ended before 30 seconds",
  stopped: "Stopped early",
};
export const COMPLETION_TEXT = {
  completed_30s: "Completed the full 30 seconds",
  protocol_stop_arms: "Observer answered that arms were used to stand (CDC rule: stop the test and record 0)",
  stopped_early: "Stopped early by the observer — not a completed test",
  incomplete: "Ended before 30 seconds — not a completed test",
  interrupted: "Interrupted (browser tab hidden or camera stopped) — not a completed test",
};
export const FLAG_TEXT = {
  uncertain_rises: "Some rises could not be confirmed as full stands from the camera — decide each one in section 3.",
  extension_unverifiable_view: "The camera was not side-on enough to see knee and hip straightening — every rise needs your decision.",
  no_practice_stand: "No practice stand was recorded, so full standing cannot be judged automatically — every rise needs your decision.",
  gap_during_movement: "The participant could not be measured for a moment while moving.",
  another_person_overlapped: "Another person overlapped the participant.",
  participant_reacquired_with_other_person_in_view: "The participant was lost from view while someone else was visible, then found again.",
  identity_or_landmark_discontinuity: "Body points jumped faster than a person can move (possible mix-up with another person, or a tracking error).",
  intermittent_tracking: "The participant was only measured in part of the video frames.",
  seated_baseline_drift: "The participant sat lower during the test than during the camera check.",
  expiry_endpoint_not_observed: "The participant was not measured at the very end of the 30 seconds.",
  expiry_without_practice_stand: "The 30-second halfway rule used a default standing height (no practice stand).",
  no_accepted_reference: "No practice stand was accepted as the full-standing reference — every rise needs your decision.",
  stand_dipped_without_sitting: "While standing, the participant dipped deeply and came back up without sitting down (a half-sit or squat is not a new stand): check whether they actually sat.",
  reference_posture_warning: "The accepted practice stand showed bent knees or hips — check its image before relying on it.",
};
import { RISE_RESOLVED_FLAGS } from "../core/coverage.js";
import { DEMO_LABEL } from "./demo.js";
export const flagResolvedByRises = (f) => RISE_RESOLVED_FLAGS.has(f);

export function plainReason(r) {
  return r
    .replace(/^tracking_lost_before_end \((.+)\)$/, "The participant could not be seen at the end of the test ($1).")
    .replace(/^tracking_lost (.+) s \((.+) s\)$/, "The participant could not be measured from $1 s ($2 s).")
    .replace(/^participant_not_measurable_for_(\d+)pct_of_the_test$/, "The participant could not be measured for about $1% of the test (beyond short tolerated gaps).")
    .replace(/^frame_rate_too_low \((.+)\)$/, "Too few video frames could be analysed ($1).")
    .replace(/^video_frames_stopped_for_(.+)_s$/, "Video frames stopped arriving for $1 s.")
    .replace(/^page_hidden$/, "The browser tab was hidden or minimised during the test, so part of the test was not observed.")
    .replace(/^camera_error$/, "The camera stopped during the test.");
}
export const RISE_TEXT = {
  full: "Full stand (camera classification)",
  expiry: "Counted by the 30-second rule (over halfway up at 30 s)",
  uncertain: "Not clearly a full stand — needs your decision",
  partial: "Partial rise — not counted",
};
const RES_TEXT = { full: "observer: full stand", not_full: "observer: not a full stand", cant_tell: "observer: can't tell" };
const RES_TEXT_EXPIRY = { full: "observer: over halfway at 30 s (counts)", not_full: "observer: not over halfway at 30 s", cant_tell: "observer: can't tell" };
const isExpiry = (e) => e.cls === "expiry" || (e.flags || []).some((x) => /^expiry_/.test(x));
const SCAN_TEXT = { no_missed: "done: no stand missing", missed: "done: a missed stand could not be added" };

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const secs = (t, r) => `${((t - r.window.tGo) / 1000).toFixed(1)} s`;

export function buildReport(sess, d) {
  const r = sess.result, cov = sess.coverage;
  const demo = sess.source === "demo";                     // simulated participant: labelled on every line that carries a result
  const source = sess.source === "camera" ? "live camera" : demo ? "SIMULATED DEMO (computer-drawn participant; no camera, no pose model) — not a real person, not a real measurement"
    : "REPLAY of a video file (" + esc(sess.replayName || "") + ") — not a live test";
  const ref = d.reference;
  const res = sess.review.resolutions || {};
  const covTxt = (n) => (!cov ? "no images" : cov.events[n] && cov.events[n].ok ? `image ${Math.round(cov.events[n].distMs)} ms from the top` : "no image near the top");
  const rises = r.events.map((e) => `<tr><td>${e.n}</td><td>${esc(RISE_TEXT[e.cls])}</td><td>${e.tFull ? secs(e.tFull, r) : e.tExpiry ? "30.0 s" : e.tPeak ? secs(e.tPeak, r) : "—"}</td><td>${esc(res[e.n] ? (isExpiry(e) ? RES_TEXT_EXPIRY : RES_TEXT)[res[e.n]] + (cov && cov.events[e.n] && cov.events[e.n].ok ? "" : " (ignored: no image)") : "—")}</td><td>${esc(covTxt(e.n))}</td></tr>`).join("")
    // added stands: status from decide() (overnight: the report used to re-derive it and could disagree)
    + (d.addedReview || []).map((a) => `<tr><td>added</td><td>Added by the observer (missed by the camera)</td><td>${Number.isFinite(a.t) ? secs(a.t, r) : "—"}</td><td>observer: full stand</td><td>${a.counted ? "picked from its image; counted" : "NOT counted: " + esc(a.problem)}</td></tr>`).join("");
  const refLine = ref.eligible
    ? `${demo ? "<strong>Demo only (simulated participant):</strong> " : ""}${ref.category === "below_average" ? "<strong>Below average</strong>" : "Not below average"} for ${esc(ref.band)} (below average = fewer than ${ref.threshold})${ref.fromRange ? " — decided from the range " + esc(d.valueText) + ", both ends give the same category" : ""}. The CDC form states: “A below average score indicates a risk for falls.”`
    : "Not applied: " + ref.blockers.map(esc).join(" ");
  const q = r.quality, ls = sess.loopStats || {}, rr = r.reference;
  const evid = !sess.evidenceOn ? "No images were kept, so the automatic count cannot be checked afterwards."
    : `Images kept while reviewing: ${sess.evidenceStats ? sess.evidenceStats.frames : 0} (failed captures ${sess.evidenceStats ? sess.evidenceStats.dropped : 0}); not included in this record.${cov ? ` Whole-test coverage: ${cov.scan.ok ? "complete" : "gaps at " + cov.scan.gaps.map(([a, b]) => secs(a, r) + "–" + secs(b, r)).join(", ")}; practice-stand image: ${cov.reference.ok ? "yes" : "no"}; 30-s endpoint image: ${cov.endpoint.ok ? "yes" : "no"}.` : ""} Identity confirmed for rises ${esc((sess.review.identityConfirmedFor || []).join(", ") || "none")}. Missed-stand scan: ${esc(SCAN_TEXT[sess.review.sessionScan] || "not done")}.`;
  return `
<article class="report">
  <h1 id="h-report-title">${esc(d.title)}</h1>
  ${demo ? `<p class="demolabel">${esc(DEMO_LABEL)}. This summary shows how the workflow behaves on a simulated participant; it describes no one.</p>` : ""}
  <p>${esc(new Date(sess.startedAt || Date.now()).toLocaleString())} · Source: <strong>${source}</strong> · ${esc(r.core)} · ${esc(d.version)}</p>
  <table>
    <tr><th>Test</th><td>${esc(COMPLETION_TEXT[d.completion])}</td></tr>
    <tr><th>Number of full stands reported</th><td class="final">${d.value === null ? esc(d.reference.fromRange ? d.valueText : "Not reported") : d.value}${demo ? ` <span class="demotag">${esc(DEMO_LABEL)}</span>` : ""}</td></tr>
    <tr><th>Where this number comes from</th><td>${esc(d.basis)}${sess.review.basisChoice ? `<br>Your choice: ${esc(sess.review.basisChoice.basis === "supervisor" ? "your own count" : "the camera count")} — “${esc(sess.review.basisChoice.rationale)}”` : ""}</td></tr>
    <tr><th>Counts side by side</th><td>Camera as detected: ${d.counts.machine ?? "—"} · camera after your checks: ${d.counts.reviewed ?? "—"}${d.automatic && !d.automatic.determinate ? ` (range ${d.automatic.min}–${d.automatic.max})` : ""} · your own count: ${d.counts.supervisor ?? "—"}${d.conflict ? " · <strong>the counts differ</strong>" : ""}</td></tr>
    <tr><th>Camera measurement</th><td>${esc(STATUS_TEXT[r.status])}${r.withheldReasons.length ? "<br>" + r.withheldReasons.map((x) => esc(plainReason(x))).join("<br>") : ""}</td></tr>
    <tr><th>Full-standing reference</th><td>${rr ? `A practice stand before GO (not part of the CDC form; practice repetitions are suggested in the Rikli &amp; Jones protocol). Practice stand #${rr.id}: ${rr.accepted ? `accepted (${rr.accepted.basis === "image" ? "with its image" : "from direct observation"})` : "not accepted"}${rr.postureWarning ? "; the camera saw bent knees or hips" : ""}; knee/hip check: ${esc({ verified_side_view: "side view", unverifiable_view: "camera too frontal — not checked", no_accepted_reference: "no accepted reference", no_practice_stand: "no practice stand" }[r.extensionCheck] || r.extensionCheck)}` : "None (every rise needed the observer's decision)"}</td></tr>
    <tr><th>Evidence check</th><td>${evid}</td></tr>
    <tr><th>Observer answers</th><td>Arms used to stand: <strong>${esc(sess.review.arms || "not answered")}</strong> · Set-up as described: <strong>${esc(sess.review.setup || "not answered")}</strong></td></tr>
    <tr><th>CDC comparison table</th><td>${refLine}</td></tr>
    <tr><th>Measurement quality</th><td>Participant measured in ${q.usableFrames}/${q.framesInWindow} analysed frames (${(100 - q.missingObservationPct).toFixed(0)}%); longest gap ${q.longestGapMs} ms; ${q.usableFps} usable frames/s.${ls.presentedSpan ? ` Video frames: ${ls.presentedSpan} presented, ${ls.analysed} analysed, ${ls.notAnalysed} not analysed.` : ""}</td></tr>
  </table>
  <h2>Rises</h2>
  ${rises ? `<table><tr><th>#</th><th>What the camera found</th><th>Time</th><th>Your decision</th><th>Image</th></tr>${rises}</table>` : "<p>No rises detected.</p>"}
  <h2>Change record</h2>
  ${sess.audit.length ? `<table><tr><th>When</th><th>What</th></tr>${sess.audit.map((a) => `<tr><td>${esc(new Date(a.at).toLocaleTimeString())}</td><td>${esc(a.what)}</td></tr>`).join("")}</table>` : "<p>No changes.</p>"}
  <p class="disclaimer">
    What this is: a record of one supervised chair-stand session measured with an experimental camera tool. What it is not: a diagnosis, a fall-risk probability, a complete STEADI fall-risk assessment, or a medical device. It has not been validated in any population, including older adults. 
    The CDC table (ages 60–94) is shown only for a completed live 30-second test (or the simulated demo) with the set-up and arm-use questions answered, age and column entered, and either a camera count whose reference, rises, identity and whole test were checked against images, or your own count chosen explicitly.
    Test protocol and table: CDC STEADI “Assessment: 30-Second Chair Stand” (2017), www.cdc.gov/steadi. CDC does not endorse this tool.
    This record contains no images. The app has no upload function.${demo ? ` ${esc(DEMO_LABEL)}: the participant and every number above were simulated by the app's demo script.` : ""}
  </p>
</article>`;
}
