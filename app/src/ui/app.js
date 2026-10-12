// SteadyScreen UI controller (checkpoint 3): setup -> camera check + practice stand -> 30-s test -> evidence review -> summary.
//
// Session ownership (audit G): every session has an id. Every asynchronous step (camera permission, model load,
// countdown, timers, frame callbacks, image capture) checks `alive(sess)` before touching the UI or the core,
// so Back / New test / errors cancel pending work instead of letting it reopen an old session.
import { createChairStand } from "../core/chair_stand.js";
import { CORE_VERSION, PARAMS } from "../core/params.js";
import { decide, parseStrictInt, MIN_ADDED_SEPARATION_MS } from "../core/decision.js";
import { computeCoverage, anchorTime, COVERAGE_LIMITS, hasImageAt } from "../core/coverage.js";
import { loadLandmarker, startFrameLoop } from "./engine.js";
import { drawOverlay, drawTimeline } from "./draw.js";
import { buildReport, plainReason, STATUS_TEXT, COMPLETION_TEXT, FLAG_TEXT, RISE_TEXT, flagResolvedByRises } from "./report.js";
import { createEvidenceStore } from "./evidence.js";
import { beep } from "./audio.js";
import { createDemoScript, startDemoScene, decisionSource, demoRecord, DEMO_BADGE, DEMO_LABEL } from "./demo.js";

const $ = (id) => document.getElementById(id);
const QS = new URLSearchParams(location.search);
const HARNESS = QS.has("harness");
const screens = ["setup", "ready", "test", "review", "report"];
function show(name) {
  closeZoom();                                                                 // an enlarged image never stays open across screens
  for (const s of screens) $("scr-" + s).classList.toggle("hidden", s !== name);
  const h = $("scr-" + name).querySelector("h1"); if (h) { h.tabIndex = -1; h.focus({ preventScroll: true }); }
  window.scrollTo(0, 0);
}
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// CSP violations (blocked outgoing requests, e.g. the library's usage logging) are counted, not hidden.
const cspBlocked = [];
document.addEventListener("securitypolicyviolation", (e) => cspBlocked.push({ blockedURI: e.blockedURI, directive: e.effectiveDirective || e.violatedDirective }));

const READY_TEXT = {
  no_frames: "Waiting for video…",
  no_person_detected: "No person detected. Check that the participant is in view.",
  several_people_select_participant: "More than one person could be the participant. Click on the participant in the picture.",
  another_person_overlaps_participant: "Someone overlaps the participant in the picture. Helper: stay beside, within reach.",
  participant_lost: "Lost track of the participant — keep them in view.",
  hips_knees_ankles_not_all_visible: "Hips, knees and ankles must be visible. Move the camera back or lower; keep a side view.",
  practice_stand_needed: "Practice stand: stand up fully with arms crossed, hold still ~1 second, then sit down.",
  practice_stand_in_progress: "Practice stand seen: now sit down again; then confirm it on the card.",
  practice_stand_needs_confirmation: "Confirm whether the practice stand was a full stand (card below).",
  reference_stale: "The practice stand is more than 5 minutes old: please repeat it.",
  reference_person_changed: "The tracked person changed after the practice stand: please repeat it.",
  reference_camera_or_person_changed: "The camera or person moved since the practice stand: please repeat it.",
  hold_still_seated: "Participant: sit still with arms crossed.",
  participant_not_seated: "The participant does not look seated. Start from a seated position.",
  camera_frames_too_sparse: "The camera is delivering too few frames. Close other apps or improve lighting.",
};

// ---------- sessions ----------
let S = null, nextId = 1;
let landmarker = null, engineInfo = "", modelPromise = null;
const alive = (sess) => !!sess && S === sess && !sess.dead;
// live camera and the demo run on the performance clock in real time; a replay runs on video time
const liveClock = (sess) => sess.source === "camera" || sess.source === "demo";

function newSession(source) {
  teardown();
  // overnight fix ON-04: review-form fields from a previous session must not carry over (a stale "my count" could be saved)
  for (const id of ["in-manual", "in-manual-reason"]) $(id).value = "";
  $("manual-msg").textContent = ""; $("basis-body").innerHTML = "";
  S = { id: nextId++, source, dead: false, stream: null, core: null, loop: null, result: null, startedAt: null, goT: null,
    countingDown: false, ended: false, timer: null, evidenceOn: $("c-evidence").checked, evidence: createEvidenceStore(),
    replayName: null, replayUrl: null, participant: { ageText: $("in-age").value.trim(), column: $("in-sex").value },
    countdownToken: 0, coverage: null, refShownRefId: null, quiet: $("c-quiet").checked,
    review: { resolutions: {}, flagChecks: {}, identityConfirmed: null, identityConfirmedFor: [], sessionScan: null, added: [], basisChoice: null,
      arms: null, setup: null, manual: null }, audit: [], loopStats: null, evidenceStats: null, demo: null };
  return S;
}
function stopMedia(sess) {
  const v = $("video");
  if (sess && sess.demo) sess.demo.scene.stop();                              // demo: stop drawing the simulated scene
  if (sess && sess.stream) { sess.stream.getTracks().forEach((tr) => tr.stop()); sess.stream = null; }   // camera light off
  v.pause(); v.removeAttribute("src"); v.srcObject = null; v.load();
  if (sess && sess.replayUrl) { URL.revokeObjectURL(sess.replayUrl); sess.replayUrl = null; }
}
function teardown() {
  if (!S) return;
  const sess = S; sess.dead = true; sess.countdownToken++;
  closeZoom();                                                                 // before its image URL is revoked below
  clearTimeout(sess.timer);
  if (sess.loop) { sess.loopStats = sess.loop.stats(); sess.loop.stop(); sess.loop = null; }
  stopMedia(sess);
  sess.evidence.clear();                               // drop every image and revoke object URLs
  setBadge(null); $("demo-banner").classList.add("hidden"); document.title = PAGE_TITLE;
  S = null;
}
window.addEventListener("pagehide", teardown);
// (review F3) a page restored from the back/forward cache has no session any more: start again at setup
window.addEventListener("pageshow", (e) => { if (e.persisted) { show("setup"); $("report").innerHTML = ""; } });

const PAGE_TITLE = document.title;
function log(sess, what) { sess.audit.push({ at: Date.now(), what }); }
function setBadge(text) { const b = $("modeBadge"); b.textContent = text || ""; b.classList.toggle("hidden", !text); }

// ---------- setup ----------
const safetyIds = ["c-helper", "c-chair", "c-okay", "c-camera"];
function supportProblems() {
  const p = [];
  if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) p.push("camera access (getUserMedia)");
  if (!("requestVideoFrameCallback" in HTMLVideoElement.prototype)) p.push("video frame callbacks (requestVideoFrameCallback)");
  return p;
}
const unsupported = supportProblems();
if (unsupported.length) { $("support-msg").textContent = `This browser lacks ${unsupported.join(" and ")}. Use a recent Chrome or Edge.`; $("in-file").disabled = true; $("lbl-file").classList.add("disabled"); }
// the demo needs no camera, only frame callbacks and a canvas video stream
const demoUnsupported = !("requestVideoFrameCallback" in HTMLVideoElement.prototype) || !("captureStream" in HTMLCanvasElement.prototype);
if (demoUnsupported) $("demo-hint").textContent = "This browser cannot run the demo (needs a recent Chrome or Edge).";
function refreshSetup() {
  const safe = safetyIds.every((id) => $(id).checked);
  $("btn-camera").disabled = !(safe && $("c-consent").checked) || unsupported.length > 0;
  $("camera-hint").classList.toggle("hidden", !$("btn-camera").disabled || unsupported.length > 0);
  $("btn-demo").disabled = !safe || demoUnsupported;
  $("demo-hint").textContent = demoUnsupported ? "This browser cannot run the demo (needs a recent Chrome or Edge)." : "Tick the 4 safety boxes above to enable the demo.";
  $("demo-hint").classList.toggle("hidden", !$("btn-demo").disabled);
  const a = $("in-age").value.trim();
  $("age-msg").textContent = a && parseStrictInt(a, 3, 0, 120) === null ? "Age must be a whole number (digits only)." : "";
}
[...safetyIds, "c-consent", "in-age"].forEach((id) => $(id).addEventListener("input", refreshSetup));
[...safetyIds, "c-consent"].forEach((id) => $(id).addEventListener("change", refreshSetup));

function ensureModel() {
  if (landmarker) return Promise.resolve();
  if (!modelPromise) {
    const modelUrl = HARNESS && QS.get("model") === "missing" ? new URL("../../vendor/models/does-not-exist.task", import.meta.url).href : undefined;
    modelPromise = loadLandmarker({ numPoses: 2, preferGPU: QS.get("delegate") !== "CPU", ...(modelUrl ? { modelUrl } : {}) })
      .then((r) => { landmarker = r.landmarker; engineInfo = `${r.delegate}, loaded in ${r.startupMs} ms`; })
      .catch((e) => { modelPromise = null; throw e; });
  }
  return modelPromise;
}

$("btn-camera").addEventListener("click", () => startCamera());
async function startCamera() {
  const sess = newSession("camera");
  $("setup-msg").textContent = "";
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
  } catch (e) {
    if (!alive(sess)) return;
    teardown(); show("setup");
    $("setup-msg").textContent = e && e.name === "NotAllowedError" ? "Camera permission was denied. Allow the camera for this page and try again." : `Camera not available: ${e && e.message || e}`;
    return;
  }
  if (!alive(sess)) { stream.getTracks().forEach((t) => t.stop()); return; }
  sess.stream = stream;
  const v = $("video"); v.srcObject = stream; v.muted = true;
  stream.getVideoTracks()[0].addEventListener("ended", () => onTrackEnded(sess));
  try { await v.play(); } catch (e) { /* autoplay of a muted camera stream is normally allowed */ }
  if (!alive(sess)) return;
  log(sess, `Camera started${sess.evidenceOn ? " (temporary evidence images ON)" : " (no evidence images)"}${sess.quiet ? "; quiet counting (no per-stand tones)" : ""}`);
  await enterReadiness(sess);
}
function onTrackEnded(sess) {
  if (!alive(sess)) return;
  if (sess.core && sess.core.phase === "running" && !sess.ended) endTest(sess, "camera_error");
  else if (!sess.ended) { teardown(); show("setup"); $("setup-msg").textContent = "The camera stopped. Check the camera and try again."; }
}

$("in-file").addEventListener("change", async (ev) => {
  const f = ev.target.files[0]; ev.target.value = ""; if (!f) return;
  await startReplay(URL.createObjectURL(f), f.name);
});
async function startReplay(url, name) {
  const sess = newSession("replay"); sess.replayName = name; sess.replayUrl = url.startsWith("blob:") ? url : null;
  const v = $("video"); v.srcObject = null; v.src = url; v.loop = false; v.muted = true;
  try {
    await new Promise((r, j) => { v.onloadeddata = r; v.onerror = () => j(new Error("cannot open this video file")); });
  } catch (e) { if (alive(sess)) { teardown(); show("setup"); $("setup-msg").textContent = e.message; } return; }
  if (!alive(sess)) return;
  setBadge("REPLAY — not a live test");
  log(sess, `Replay of ${name}${sess.evidenceOn ? " (temporary evidence images ON)" : ""}`);
  await enterReadiness(sess);
  if (!alive(sess)) return;
  v.addEventListener("ended", () => onReplayEnded(sess), { once: true });
  try { await v.play(); } catch (e) { if (alive(sess)) $("ready-status").textContent = "Press play is blocked by the browser: " + e.message; }
}
// Demo: a computer-drawn participant instead of a camera (app/src/ui/demo.js). Same screens, same core, same review.
$("btn-demo").addEventListener("click", () => startDemo());
// quick start for visitors: the safety boxes describe the simulated scene, and still images are kept so the checks can be tried
$("btn-demo-quick").addEventListener("click", () => {
  for (const id of [...safetyIds, "c-evidence"]) $(id).checked = true;
  refreshSetup();
  if (!$("btn-demo").disabled) startDemo();
  else $("setup-msg").textContent = "This browser cannot run the demo (needs a recent Chrome or Edge).";
});
if (demoUnsupported) $("btn-demo-quick").disabled = true;
async function startDemo() {
  const sess = newSession("demo");
  $("setup-msg").textContent = "";
  const script = createDemoScript();
  let scene;
  try { scene = startDemoScene(script); }
  catch (e) { teardown(); show("setup"); $("setup-msg").textContent = `The demo could not start in this browser (${String(e && e.message || e).slice(0, 80)}).`; return; }
  sess.demo = { script, scene }; sess.stream = scene.stream;
  const v = $("video"); v.srcObject = scene.stream; v.muted = true;
  setBadge(DEMO_BADGE); $("demo-banner").classList.remove("hidden"); document.title = `SIMULATED DEMO · ${PAGE_TITLE}`;   // (review F4) also names a saved PDF
  try { await v.play(); } catch (e) { /* a muted canvas stream may autoplay */ }
  if (!alive(sess)) return;
  log(sess, `DEMO started: simulated participant (no camera, no pose model)${sess.evidenceOn ? " (temporary evidence images ON)" : " (no evidence images)"}${sess.quiet ? "; quiet counting (no per-stand tones)" : ""}`);
  await enterReadiness(sess);
}

function onReplayEnded(sess) {
  if (!alive(sess) || sess.ended) return;
  if (sess.core && sess.core.phase === "running") endTest(sess, "stream_end");
  else { sess.countingDown = false; $("ready-status").textContent = "The video ended before the test could start."; $("ready-status").className = "status bad"; $("btn-start").disabled = true; }
}


// ---------- camera check / practice stand ----------
async function enterReadiness(sess) {
  $("slot-ready").appendChild($("videowrap"));
  show("ready");
  $("btn-start").disabled = true; $("ref-card").classList.add("hidden");
  const v = $("video");
  // (review F2) nothing from an earlier demo session may show on a camera/replay session while the model loads
  $("engine-info").textContent = ""; { const o = $("overlay"); o.getContext("2d").clearRect(0, 0, o.width, o.height); }
  if (sess.source === "demo") {                       // no pose model: the demo generates the body points it draws
    $("ready-status").textContent = "Starting the simulated participant…"; $("ready-status").className = "status";
    $("engine-info").textContent = `Simulated demo: no camera and no pose model; body points come from the demo script. Core: ${CORE_VERSION}.`;
    sess.loop = startFrameLoop(v, null, { source: "demo", simulate: (t) => [sess.demo.script.landmarksAt(t)],
      onFrame: (f) => onFrame(sess, f), onError: (e) => { if (alive(sess)) console.error("demo frame error", e); } });
    return;
  }
  $("ready-status").textContent = "Loading the pose model (on this computer)…"; $("ready-status").className = "status";
  try { await ensureModel(); }
  catch (e) {
    if (!alive(sess)) return;
    teardown(); show("setup");
    $("setup-msg").textContent = `The pose model (which runs on this computer) could not be loaded, so the camera has been turned off. Reload the page to try again. (Detail: ${String(e && e.message || e).slice(0, 80)})`;
    return;
  }
  if (!alive(sess)) return;
  $("engine-info").textContent = `Pose model: ${engineInfo}. Core: ${CORE_VERSION}.`;
  sess.loop = startFrameLoop(v, landmarker, {
    source: sess.source,
    onFrame: (f) => onFrame(sess, f),
    onError: (e) => { if (alive(sess)) console.error("pose error", e); },
  });
}

function onFrame(sess, f) {
  if (!alive(sess) || sess.ended) return;
  const v = $("video");
  if (!sess.core) sess.core = createChairStand({ width: v.videoWidth, height: v.videoHeight });
  let snap;
  try { snap = sess.core.push(f); } catch (e) { return; }
  sess.lastFrameT = f.t;
  drawOverlay($("overlay"), v, f.poses, snap.participantPose);
  if (sess.evidenceOn) sess.evidence.capture(v, f.t, snap.participantPose, sess.goT !== null ? sess.goT - 15000 : null,
    { priority: sess.goT !== null && Math.abs(f.t - (sess.goT + PARAMS.windowMs)) <= 400 });
  if (snap.phase === "calibrating" && sess.demo) sess.demo.script.react(f.t, snap.readiness);   // demo: repeat the practice stand when asked
  if (snap.phase === "calibrating") { if (!sess.countingDown) updateReadiness(sess, snap.readiness); }
  else if (snap.phase === "running") updateRunning(sess, snap);
  if (snap.result && !sess.ended) endTest(sess, null);
}

function updateReadiness(sess, r) {
  const st = $("ready-status");
  if (r.ready) { st.textContent = "Ready. Helper beside the participant."; st.className = "status ok"; }
  else { st.textContent = "Not ready yet"; st.className = "status warn"; }
  $("ready-reasons").innerHTML = r.reasons.map((x) => `<li>${esc(READY_TEXT[x] || x)}</li>`).join("");
  const pr = r.practice || {};
  $("step-practice").classList.toggle("done", pr.state === "accepted" || pr.mode === "skipped");
  $("step-seen").classList.toggle("done", !r.reasons.some((x) => ["no_person_detected", "several_people_select_participant", "participant_lost", "hips_knees_ankles_not_all_visible", "another_person_overlaps_participant"].includes(x)));
  if (pr.state === "accepted" && !pr.sideView) st.textContent += " (camera not side-on: each rise will need your check)";
  showReferenceCard(sess, pr);
  $("btn-start").disabled = !r.ready || sess.countingDown;
}

// Practice-stand acceptance (docs/CONTRACTS_CP4.md s1): shown once per detected hold; the answer is bound to its refId.
function showReferenceCard(sess, pr) {
  const card = $("ref-card");
  if (pr.state !== "detected") { card.classList.add("hidden"); sess.refShownRefId = null; return; }
  if (sess.refShownRefId === pr.refId && !card.classList.contains("hidden")) return;       // already showing this hold
  // wait until the image store has an image inside the hold (if images are kept) before asking
  const img = sess.evidenceOn ? sess.evidence.nearest((pr.t0 + pr.t1) / 2, (pr.t1 - pr.t0) / 2 + COVERAGE_LIMITS.referenceSlackMs) : null;
  // (frame-clock based: give a pending image up to ~1 s of video after the hold before asking without one)
  if (sess.evidenceOn && !img && (sess.lastFrameT ?? 0) - pr.t1 < 1000) return;
  sess.refShownRefId = pr.refId; sess.refShownBasis = img ? "image" : "observer_watched";
  sess.core.freezeReference(pr.refId);                  // what the observer accepts is exactly what the card showed (ON-09)
  // keep this hold's images however long the observer takes before GO (overnight fix ON-01; re-pinning replaces the pin)
  if (sess.evidenceOn) sess.evidence.pin("reference", pr.t0 - COVERAGE_LIMITS.referenceSlackMs, pr.t1 + COVERAGE_LIMITS.referenceSlackMs);
  const box = $("ref-img"); box.innerHTML = "";
  if (img) box.appendChild(thumb(sess, img, true, "practice stand"));
  else box.innerHTML = `<p class="small">${sess.evidenceOn ? "No image of the practice stand was captured." : "No images are being kept."} Answer from what you saw.</p>`;
  $("ref-warn").textContent = pr.postureWarning ? "The camera sees bent knees or hips in this position. Confirm only if this is how this person normally stands fully upright." : "";
  card.classList.remove("hidden");
  card.scrollIntoView({ block: "nearest" });              // the answer buttons must be visible (overnight UX)
}
$("btn-ref-yes").addEventListener("click", () => {
  const sess = S; if (!alive(sess) || !sess.core) return;
  const ok = sess.core.acceptReference({ refId: sess.refShownRefId, basis: sess.refShownBasis });
  log(sess, ok ? `Practice stand #${sess.refShownRefId} accepted as a full stand (${sess.refShownBasis === "image" ? "with its image" : "from direct observation, no image"})` : "Practice-stand acceptance failed (it changed): please repeat");
  $("ref-card").classList.add("hidden");
  updateReadiness(sess, sess.core.readiness());                             // refresh Start immediately (no wait for a frame)
});
$("btn-ref-no").addEventListener("click", () => {
  const sess = S; if (!alive(sess) || !sess.core) return;
  sess.core.rejectReference(sess.refShownRefId); log(sess, `Practice stand #${sess.refShownRefId} rejected (not a full stand): repeat requested`);
  $("ref-card").classList.add("hidden"); sess.refShownRefId = null;
  updateReadiness(sess, sess.core.readiness());
});
$("btn-noref").addEventListener("click", () => {
  const sess = S; if (!alive(sess) || !sess.core || sess.core.phase !== "calibrating") return;
  sess.core.countWithoutReference(true); log(sess, "Observer chose to count WITHOUT a practice-stand reference (every rise will need checking)");
  updateReadiness(sess, sess.core.readiness());
});

// click-to-select the participant (object-fit: contain letterboxing handled)
$("overlay").addEventListener("click", (ev) => {
  const sess = S; if (!alive(sess) || !sess.core || sess.core.phase !== "calibrating") return;
  const v = $("video"), rect = ev.currentTarget.getBoundingClientRect();
  const sc = Math.min(rect.width / v.videoWidth, rect.height / v.videoHeight);
  const ox = (rect.width - v.videoWidth * sc) / 2, oy = (rect.height - v.videoHeight * sc) / 2;
  const x = (ev.clientX - rect.left - ox) / (v.videoWidth * sc), y = (ev.clientY - rect.top - oy) / (v.videoHeight * sc);
  if (x < 0 || x > 1 || y < 0 || y > 1) return;
  sess.core.selectParticipant(x, y); log(sess, "Observer selected the participant in the picture (practice stand must be repeated)");
});

$("btn-start").addEventListener("click", () => startCountdown(S));
$("btn-back").addEventListener("click", () => { teardown(); show("setup"); });

// Countdown ownership (audit E): a token that ANY hidden event, Back, New test or error invalidates immediately.
function cancelCountdown(sess, why) {
  if (!sess || !sess.countingDown) return;
  sess.countdownToken++; sess.countingDown = false;
  $("ready-status").textContent = `Countdown cancelled (${why}). Press Start again when ready.`; $("ready-status").className = "status bad";
  log(sess, `Countdown cancelled: ${why}`);
}
async function startCountdown(sess) {
  if (!alive(sess) || sess.countingDown || !sess.core || sess.core.phase !== "calibrating" || document.visibilityState === "hidden") return;
  const token = ++sess.countdownToken;
  sess.countingDown = true; $("btn-start").disabled = true; closeZoom();
  const st = $("ready-status");
  const valid = () => alive(sess) && !sess.ended && sess.countdownToken === token && document.visibilityState !== "hidden";
  for (const n of [3, 2, 1]) {
    st.textContent = String(n); st.className = "status countdown"; beep(660, 150);
    await sleep(1000);
    if (!valid()) { if (alive(sess) && sess.countdownToken === token) cancelCountdown(sess, "tab hidden"); return; }
  }
  const r = sess.core.readiness();
  if (!r.ready) { sess.countingDown = false; st.textContent = "Not ready at GO — test not started: " + r.reasons.map((x) => READY_TEXT[x] || x).join(" "); st.className = "status bad"; return; }
  const v = $("video");
  const goT = liveClock(sess) ? performance.now() : v.currentTime * 1000;
  try { sess.core.start(goT); }
  catch (e) { sess.countingDown = false; st.textContent = "Test not started: " + e.message; st.className = "status bad"; return; }
  sess.goT = goT; sess.startedAt = Date.now();
  if (sess.demo) sess.demo.script.go(goT);                                      // the simulated participant starts standing
  log(sess, `GO (${liveClock(sess) ? "performance clock" : "video time"} ${Math.round(goT)} ms)`);
  beep(880, 450);
  $("slot-test").appendChild($("videowrap"));
  show("test");
  $("count").textContent = "0"; $("count-uncertain").textContent = ""; $("timer").textContent = "30"; $("timer-label").textContent = "seconds left (GO!)";
  $("test-status").textContent = "Measuring"; $("test-status").className = "status ok";
  if (liveClock(sess)) sess.timer = setTimeout(() => { if (alive(sess) && !sess.ended) endTest(sess, "expired"); }, PARAMS.windowMs + 600);
  sess.countingDown = false;
}

let lastCount = 0;
function updateRunning(sess, snap) {
  const left = Math.max(0, Math.ceil((PARAMS.windowMs - snap.elapsedMs) / 1000));
  $("timer").textContent = String(left);
  if (snap.count !== lastCount) { $("count").textContent = String(snap.count); if (snap.count > lastCount && !sess.quiet) beep(520, 60); lastCount = snap.count; }
  $("count-uncertain").textContent = snap.uncertain ? `(+${snap.uncertain} to check)` : "";
  const ok = snap.lastStatus === "ok";
  $("test-status").textContent = ok ? "Measuring" : "Cannot see the participant clearly";
  $("test-status").className = "status " + (ok ? "ok" : "bad");
}

$("btn-stop").addEventListener("click", () => { if (alive(S)) endTest(S, "stopped"); });
document.addEventListener("visibilitychange", () => {
  const sess = S; if (!alive(sess) || document.visibilityState !== "hidden") return;
  if (sess.countingDown) cancelCountdown(sess, "tab hidden");                  // immediately, not at the next tick
  if (sess.core && sess.core.phase === "running" && !sess.ended) endTest(sess, "page_hidden");
});
document.addEventListener("keydown", (e) => {
  if ($("zoom").open) return;                                                  // the enlarged image's dialog handles its own keys (Esc closes only it)
  const scr = screens.find((s) => !$("scr-" + s).classList.contains("hidden"));
  if (scr === "test" && e.key === "Escape") { e.preventDefault(); if (alive(S)) endTest(S, "stopped"); }   // (overnight: a 2nd Space no longer stops the test)
  else if (scr === "test" && e.key === " ") e.preventDefault();
  else if (scr === "ready" && e.key === " " && !$("btn-start").disabled) { e.preventDefault(); startCountdown(S); }
});

async function endTest(sess, reason) {
  if (!alive(sess) || sess.ended) return;
  sess.ended = true;
  clearTimeout(sess.timer);
  let res = sess.core && sess.core.snapshot().result;
  if (!res && sess.core && sess.core.phase === "running") {
    const tNow = liveClock(sess) ? performance.now() : $("video").currentTime * 1000;
    res = sess.core.finish(reason || "stream_end", tNow);
  }
  if (sess.loop) { sess.loopStats = sess.loop.stats(); sess.loop.stop(); sess.loop = null; }
  stopMedia(sess);                                                             // camera off
  beep(440, 200); setTimeout(() => beep(440, 200), 260);
  lastCount = 0;
  if (!res) { teardown(); show("setup"); return; }
  // wait for image captures still being encoded (bounded), THEN freeze coverage (audit D: pending final frame)
  sess.evidenceStats = await sess.evidence.finalize(1500);
  if (!alive(sess)) return;
  sess.result = res;
  sess.coverage = sess.evidenceOn ? computeCoverage(res, sess.evidence.times()) : null;
  log(sess, `Test ended: ${res.reason}; camera measurement: ${res.status}; images kept: ${sess.evidenceStats.frames}`);
  renderReview(sess);
}

// ---------- review ----------
function evidenceAvailable(sess) { return !!(sess.evidenceOn && sess.coverage && sess.coverage.imageCount > 0); }
const covOk = (sess, n) => !!(sess.coverage && sess.coverage.events[n] && sess.coverage.events[n].ok);
function decision(sess) {
  const rv = sess.review;
  return decide({ result: sess.result, source: decisionSource(sess.source), observer: { arms: rv.arms, setup: rv.setup },
    evidence: { available: evidenceAvailable(sess), coverage: sess.coverage, identityConfirmed: rv.identityConfirmed, identityConfirmedFor: rv.identityConfirmedFor,
      eventResolutions: rv.resolutions, flagChecks: rv.flagChecks, sessionScan: rv.sessionScan, added: rv.added },
    manual: rv.manual, basisChoice: rv.basisChoice, participant: sess.participant });
}

function boxEl(frame) {
  const b = document.createElement("div"); b.className = "box";
  b.style.left = `${frame.box[0] * 100}%`; b.style.top = `${frame.box[1] * 100}%`;
  b.style.width = `${(frame.box[2] - frame.box[0]) * 100}%`; b.style.height = `${(frame.box[3] - frame.box[1]) * 100}%`;
  return b;
}
function thumb(sess, frame, highlight = false, label = "") {
  const fig = document.createElement("figure"); fig.className = "thumb" + (highlight ? " hl" : "");
  const img = document.createElement("img"); img.src = sess.evidence.url(frame); img.alt = label || "evidence image"; fig.appendChild(img);
  if (frame.box) fig.appendChild(boxEl(frame));
  const cap = document.createElement("figcaption"); cap.textContent = label; fig.appendChild(cap);
  // click-to-enlarge (judge review): the Enlarge button (mouse or Enter/Space), or a click on the image itself unless the
  // image's own click adds a missed stand (section 4). It must never trigger that action or the page's Space/Esc keys.
  const z = document.createElement("button"); z.type = "button"; z.className = "zoombtn"; z.textContent = "Enlarge"; z.title = "Enlarge this image";
  z.setAttribute("aria-label", `Enlarge image${label ? ": " + label : ""}`);
  const open = (ev) => { ev.preventDefault(); ev.stopPropagation(); openZoom(sess, frame, label, z); };
  z.addEventListener("click", open);
  z.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") ev.stopPropagation(); });
  img.addEventListener("click", (ev) => { if (!fig.classList.contains("pick")) open(ev); });
  fig.appendChild(z);
  return fig;
}
// Enlarged image in a modal <dialog>: the same in-tab object URL (no download, no new URL). Not available during the
// countdown or the 30-s test; closed by Close, Esc (handled by the dialog only) or a click outside the image.
let zoomOpener = null;
function openZoom(sess, frame, label, opener) {
  const dlg = $("zoom");
  const scr = screens.find((s) => !$("scr-" + s).classList.contains("hidden"));
  if (dlg.open || !alive(sess) || scr === "test" || sess.countingDown || (sess.core && sess.core.phase === "running" && !sess.ended)) return;
  const img = $("zoom-img"), fig = $("zoom-fig");
  img.src = sess.evidence.url(frame); img.alt = label || "evidence image";
  const sc = Math.max(0.5, Math.min((window.innerWidth * 0.92 - 40) / frame.w, (window.innerHeight * 0.96 - 170) / frame.h, 2.5));
  img.style.width = `${Math.round(frame.w * sc)}px`;
  fig.querySelectorAll(".box").forEach((b) => b.remove());
  if (frame.box) fig.appendChild(boxEl(frame));
  $("zoom-cap").textContent = label || "Evidence image";
  const s = sess.result ? (frame.t - sess.result.window.tGo) / 1000 : null;
  $("zoom-when").textContent = (s === null ? "" : `Image taken ${Math.abs(s).toFixed(1)} s ${s >= 0 ? "after" : "before"} GO. `) +
    (frame.box ? (sess.source === "demo" ? "The green outline marks the simulated participant. " : "The green outline marks the person the camera tracked. ") : "") + "This image stays in this browser tab.";
  zoomOpener = opener || null;
  dlg.showModal();
  $("zoom-close").focus();
}
function closeZoom() { const d = $("zoom"); zoomOpener = null; if (d && d.open) d.close(); }   // programmatic close: no focus return
$("zoom-close").addEventListener("click", () => $("zoom").close());
$("zoom").addEventListener("click", (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });   // click on the backdrop
$("zoom").addEventListener("close", () => {
  $("zoom-img").removeAttribute("src");
  const o = zoomOpener; zoomOpener = null;
  if (o && o.isConnected) o.focus({ preventScroll: true });
});
function missingTile(text) { const d = document.createElement("div"); d.className = "thumb missing"; d.textContent = text; return d; }
const rel = (sess, t) => ((t - sess.result.window.tGo) / 1000).toFixed(1);
const btn = (txt, on, { disabled = false, chosen = false, key = null } = {}) => { const b = document.createElement("button"); b.textContent = txt; b.disabled = disabled; b.dataset.k = key || txt; if (chosen) b.className = "chosen"; b.addEventListener("click", on); return b; };
// keyboard focus survives re-rendering (overnight UX): remember the focused control's key and its card
function rememberFocus() { const a = document.activeElement; if (!a || !a.dataset || !a.dataset.k) return null; const c = a.closest(".card, fieldset"); return { k: a.dataset.k, card: c && c.id }; }
function restoreFocus(f) {
  if (!f) return;
  const el = [...document.querySelectorAll("#scr-review [data-k]")].find((x) => x.dataset.k === f.k && !x.disabled);
  if (el) { el.focus({ preventScroll: true }); return; }
  const c = f.card && $(f.card); if (c) { const h = c.querySelector("h2, legend") || c; h.tabIndex = -1; h.focus({ preventScroll: true }); }
}
// what moment a rise's heading time is (coverage.anchorTime order); image captions show when each image was taken instead
const anchorLabel = (e, t) => e.tFull != null ? `top at ${t} s` : e.tExpiry != null ? `30-s mark (${t} s)` : e.tPeak != null ? `highest point at ${t} s` : `starts at ${t} s`;
const isExpiryRise = (e) => e.cls === "expiry" || (e.flags || []).some((x) => /^expiry_/.test(x));

function renderReview(sess) {
  const focus = rememberFocus();
  const r = sess.result, ev = evidenceAvailable(sess), cov = sess.coverage;
  const d0 = decision(sess);

  // 1. reference
  const rb = $("reference-body"); rb.innerHTML = "";
  const ref = r.reference;
  if (!ref) rb.innerHTML = `<p class="warn">No practice stand was used. ${r.extensionCheck === "no_accepted_reference" ? "You chose to count without one: every rise needs your decision." : ""}</p>`;
  else {
    rb.innerHTML = `<p>Practice stand #${ref.id} — ${ref.accepted ? `accepted as a full stand (${ref.accepted.basis === "image" ? "while looking at its image" : "from direct observation, no image"})` : "<strong>not accepted</strong>"}${ref.postureWarning ? " — <span class=\"warn\">the camera saw bent knees or hips</span>" : ""}.</p>`;
    if (ev && cov.reference.ok) { const f = sess.evidence.nearest(cov.reference.imageT, 1); if (f) { const st = document.createElement("div"); st.className = "strip"; st.appendChild(thumb(sess, f, true, "practice stand")); rb.appendChild(st); } }
    else if (sess.evidenceOn) rb.appendChild(missingTile("no image of the practice stand"));
  }

  // 2. identity (only rises that have their own image near the top)
  const idb = $("identity-body"); idb.innerHTML = "";
  const needId = r.events.filter((e) => e.counted || e.cls === "uncertain" || sess.review.resolutions[e.n] === "full");
  if (!ev) idb.innerHTML = `<p class="warn">No images were kept, so nobody can check afterwards who was measured.</p>`;
  else if (!needId.length) idb.innerHTML = "<p>No rises to check.</p>";
  else {
    const shown = needId.filter((e) => covOk(sess, e.n)), missing = needId.filter((e) => !covOk(sess, e.n));
    const strip = document.createElement("div"); strip.className = "strip";
    for (const e of needId) {
      const c = cov.events[e.n];
      if (c && c.ok) strip.appendChild(thumb(sess, sess.evidence.nearest(c.imageT, 1), false, `rise ${e.n} · ${rel(sess, c.imageT)} s`));
      else strip.appendChild(missingTile(`rise ${e.n}: no image within ${COVERAGE_LIMITS.anchorMaxMs} ms of its top`));
    }
    idb.appendChild(strip);
    if (missing.length) idb.insertAdjacentHTML("beforeend", `<p class="warn">Rises ${missing.map((e) => e.n).join(", ")} have no image near their top, so identity cannot be confirmed for them.</p>`);
    const q = document.createElement("div"); q.className = "radios";
    q.innerHTML = `<p>Is the <span class="swatch green"></span> outlined person the participant in <strong>every</strong> image shown?</p>`;
    const idsShown = shown.map((e) => e.n);
    const same = sess.review.identityConfirmedFor.length === idsShown.length && idsShown.every((n) => sess.review.identityConfirmedFor.includes(n));
    for (const [val, txt] of [[true, "Yes"], [false, "No"]]) q.appendChild(btn(txt, () => { sess.review.identityConfirmed = val; sess.review.identityConfirmedFor = val ? idsShown : []; log(sess, `Identity in images of rises ${idsShown.join(", ")}: ${txt}`); renderReview(sess); }, { disabled: !shown.length, chosen: sess.review.identityConfirmed === val && same }));
    idb.appendChild(q);
  }

  // 3. rises: required anchors (start / top / end) always shown; missing ones marked
  $("rises-help").textContent = ev ? `Images around each rise. The highlighted image is the one nearest the camera's top of the rise; image captions give the time each image was taken, which can differ from the rise's top time by up to ${COVERAGE_LIMITS.anchorMaxMs / 1000} s. Click an image or its Enlarge button to see it larger. Decisions are possible only for rises that have an image near their top.` : "No images were kept: rises cannot be checked here. Uncertain rises stay unresolved; you can enter your own count instead.";
  const rises = $("rises"); rises.innerHTML = "";
  for (const e of r.events) {
    const card = document.createElement("div"); card.className = `rise ${e.cls}`;
    const res = sess.review.resolutions[e.n];
    const tA = anchorTime(e);
    const c = cov && cov.events[e.n];
    const exp = isExpiryRise(e);
    const resTxt = exp ? { full: "over halfway at 30 s (counts)", not_full: "not over halfway at 30 s", cant_tell: "can't tell" } : { full: "full stand", not_full: "not a full stand", cant_tell: "can't tell" };
    card.innerHTML = `<h3>Rise ${e.n} · ${tA !== null ? anchorLabel(e, rel(sess, tA)) : ""} · ${esc(RISE_TEXT[e.cls])}${res ? ` · <em>your decision: ${esc(resTxt[res])}</em>` : ""}</h3>` +
      (e.flags.length ? `<p class="small">${e.flags.map((f) => esc(f.replace(/_/g, " "))).join("; ")}</p>` : "");
    if (ev && e.tRise !== null) {
      const top = c && c.ok ? sess.evidence.nearest(c.imageT, 1) : null;
      const start = sess.evidence.nearest(e.tRise, 300), end = e.tSeat ? sess.evidence.nearest(e.tSeat, 300) : null;
      const frames = sess.evidence.between(e.tRise - 400, (e.tSeat || e.tExpiry || (e.tRise + 2500)) + 300, 7, [start, top, end]);
      const strip = document.createElement("div"); strip.className = "strip";
      for (const f of frames) strip.appendChild(thumb(sess, f, f === top, `${rel(sess, f.t)} s`));
      if (!top) strip.appendChild(missingTile(`no image within ${COVERAGE_LIMITS.anchorMaxMs} ms of the top (${tA !== null ? rel(sess, tA) : "?"} s)`));
      const det = document.createElement("details"); det.open = e.cls === "uncertain" || !!res || !top;
      const sm = document.createElement("summary"); sm.textContent = `Images of this rise (${frames.length})`; det.appendChild(sm); det.appendChild(strip);
      card.appendChild(det);
    }
    const row = document.createElement("div"); row.className = "choices";
    // at the 30-s mark the CDC question is "over halfway up?", not "full stand?" (overnight protocol audit)
    const opts = exp ? (e.cls === "uncertain" ? [["full", "Over halfway up at 30 s (counts)"], ["not_full", "Not over halfway at 30 s"], ["cant_tell", "Can't tell"]]
        : e.cls === "partial" ? [["full", "Actually over halfway at 30 s (counts)"], ["cant_tell", "Can't tell"]] : [["not_full", "Not over halfway at 30 s"], ["cant_tell", "Can't tell"]])
      : e.cls === "uncertain" ? [["full", "Full stand"], ["not_full", "Not a full stand"], ["cant_tell", "Can't tell"]]
      : e.cls === "partial" ? [["full", "Actually a full stand"], ["cant_tell", "Can't tell"]] : [["not_full", "Not a full stand"], ["cant_tell", "Can't tell"]];
    const can = ev && covOk(sess, e.n);
    for (const [val, txt] of opts) row.appendChild(btn(txt, () => { sess.review.resolutions[e.n] = val; log(sess, `Rise ${e.n} (${e.cls}): observer decided "${txt}" looking at its images`); renderReview(sess); }, { disabled: !can, chosen: res === val, key: `rise${e.n}:${val}` }));
    if (res) row.appendChild(btn("Undo", () => { delete sess.review.resolutions[e.n]; log(sess, `Rise ${e.n}: decision undone`); renderReview(sess); }, { key: `rise${e.n}:undo` }));
    if (!can) { const p = document.createElement("span"); p.className = "small"; p.textContent = ev ? " (no image near the top of this rise — cannot be decided)" : " (no images — cannot be checked)"; row.appendChild(p); }
    card.appendChild(row);
    rises.appendChild(card);
  }
  if (!r.events.length) rises.innerHTML = "<p>No rises were detected.</p>";

  // 4. whole-test images: look for missed stands, add them from an image (audit C)
  const sb = $("scan-body"); sb.innerHTML = "";
  if (!ev) sb.innerHTML = `<p class="warn">No images were kept: a stand the camera missed cannot be found or added afterwards.</p>`;
  else {
    const sc = cov.scan;
    sb.insertAdjacentHTML("beforeend", sc.ok ? `<p>Images cover the whole test (largest gap ${(sc.maxGapMs / 1000).toFixed(1)} s). If the participant made a full stand the camera missed, click the image that shows <strong>the participant</strong> standing fully (images inside detected rises are decided in section 3 instead).</p>`
      : `<p class="warn">Images are missing between ${sc.gaps.map(([a, z]) => `${rel(sess, a)}–${rel(sess, z)} s`).join(", ")}, so missed stands cannot be ruled out there.</p>`);
    const det = document.createElement("details"); const sm = document.createElement("summary"); sm.textContent = "Whole-test images (about 2 per second)"; det.appendChild(sm);
    const strip = document.createElement("div"); strip.className = "strip";
    let lastShown = -Infinity;
    for (const t of sess.evidence.times()) {
      if (t < r.window.tGo || t > r.window.tEnd || t - lastShown < 450) continue;
      lastShown = t; const f = sess.evidence.at(t); if (!f) continue;
      // overnight fix ON-02: images inside a detected rise are decided on that rise's card; one stand cannot be added twice
      const inRise = r.events.find((e) => Number.isFinite(e.tRise) && t >= e.tRise && t <= (e.tSeat ?? e.tExpiry ?? r.window.tEnd));
      const nearAdded = sess.review.added.find((a) => Math.abs(a.t - t) < MIN_ADDED_SEPARATION_MS);
      const fig = thumb(sess, f, false, `${rel(sess, t)} s${inRise ? ` · rise ${inRise.n}` : nearAdded ? " · added" : ""}`);
      if (nearAdded) fig.classList.add("added");
      if (inRise || nearAdded) { fig.classList.add("nopick"); fig.title = inRise ? `Part of detected rise ${inRise.n}: decide on that rise in section 3` : "A stand was already added here"; }
      else {
        fig.classList.add("pick"); fig.title = "Add a full stand BY THE PARTICIPANT that the camera missed at this moment"; fig.tabIndex = 0; fig.setAttribute("role", "button");
        fig.setAttribute("aria-label", `Add a missed full stand by the participant at ${rel(sess, t)} s`); fig.dataset.k = `pick:${Math.round(t)}`;
        const add = () => { if (sess.review.added.some((a) => Math.abs(a.t - f.t) < MIN_ADDED_SEPARATION_MS)) return; const id = `added-${Date.now()}-${sess.review.added.length + 1}`; sess.review.added.push({ id, t: f.t }); log(sess, `Observer added a missed full stand at ${rel(sess, f.t)} s (image ${Math.round(f.t)})`); renderReview(sess); };
        fig.addEventListener("click", add); fig.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); ev.stopPropagation(); add(); } });
      }
      strip.appendChild(fig);
    }
    det.appendChild(strip); sb.appendChild(det);
    if (sess.review.added.length) {
      const ul = document.createElement("ul");
      for (const a of sess.review.added) { const li = document.createElement("li"); li.textContent = `Added full stand at ${rel(sess, a.t)} s `; li.appendChild(btn("Undo", () => { sess.review.added = sess.review.added.filter((x) => x !== a); log(sess, `Added stand at ${rel(sess, a.t)} s removed`); renderReview(sess); }, { key: `added-undo:${a.id}` })); ul.appendChild(li); }
      sb.appendChild(ul);
    }
    const row = document.createElement("div"); row.className = "choices";
    row.appendChild(btn("I looked through all images: no stand is missing", () => { sess.review.sessionScan = "no_missed"; log(sess, "Whole-test images checked: no missed stands"); renderReview(sess); }, { disabled: !sc.ok, chosen: sess.review.sessionScan === "no_missed" }));
    row.appendChild(btn("A stand is missing that I cannot add", () => { sess.review.sessionScan = "missed"; log(sess, "Whole-test images: a missed stand could not be added"); renderReview(sess); }, { chosen: sess.review.sessionScan === "missed" }));
    sb.appendChild(row);
  }

  // 5. flags that need their own images
  const fl = $("flags"); fl.innerHTML = "";
  const own = r.reviewFlags.filter((f) => !flagResolvedByRises(f));
  if (!own.length) fl.innerHTML = "<p>Nothing else to check.</p>";
  for (const f of own) {
    const div = document.createElement("div"); div.className = "flag";
    const fc = cov && cov.flags[f];
    div.innerHTML = `<p><strong>${esc(FLAG_TEXT[f] || f)}</strong>${sess.review.flagChecks[f] ? ` · <em>you checked: ${esc(sess.review.flagChecks[f] === "ok" ? "counts here look right" : "problem")}</em>` : ""}</p>`;
    const wins = (r.flagWindows && r.flagWindows[f]) || [];
    if (ev && wins.length) {
      const strip = document.createElement("div"); strip.className = "strip";
      for (const [a, z] of wins.slice(0, 3)) for (const fr of sess.evidence.between(a - 300, z + 300, 4)) strip.appendChild(thumb(sess, fr, false, `${rel(sess, fr.t)} s`));
      if (fc && !fc.ok) strip.appendChild(missingTile("images missing in this period"));
      div.appendChild(strip);
    }
    const can = ev && fc && fc.ok;
    const row = document.createElement("div"); row.className = "choices";
    const labels = f === "reference_posture_warning" ? [["ok", "Checked: this IS how this person stands fully upright"], ["problem", "No: the practice stand was not a full stand"]]
      : [["ok", "Checked: the camera's counts here look right"], ["problem", "Problem"]];
    for (const [val, txt] of labels) row.appendChild(btn(txt, () => { sess.review.flagChecks[f] = val; log(sess, `Checked "${f}": ${val}`); renderReview(sess); }, { disabled: !can, chosen: sess.review.flagChecks[f] === val, key: `flag:${f}:${val}` }));
    if (!can) { const p = document.createElement("span"); p.className = "small"; p.textContent = !ev ? " (no images — cannot be checked)" : " (images do not cover this period — cannot be checked)"; row.appendChild(p); }
    div.appendChild(row); fl.appendChild(div);
  }

  // 6. protocol questions
  const pf = r.protocolFlags;
  $("arms-hint").textContent = pf.includes("arms_possibly_uncrossed") ? "Camera note: the arms looked uncrossed during part of the test. Please answer from what you saw." :
    pf.includes("arms_not_observable") ? "Camera note: the arms could not be seen well; please answer from what you saw." : "";
  document.querySelectorAll("input[name=arms]").forEach((x) => { x.checked = sess.review.arms === x.value; x.onchange = () => { sess.review.arms = x.value; log(sess, `Arms used to stand: ${x.value}`); renderDecision(sess); }; });
  document.querySelectorAll("input[name=setup]").forEach((x) => { x.checked = sess.review.setup === x.value; x.onchange = () => { sess.review.setup = x.value; log(sess, `Set-up as described: ${x.value}`); renderDecision(sess); }; });
  // 7. supervisor count only for a completed timed test
  const completed = d0.completion === "completed_30s";
  $("manual-card").classList.toggle("disabled", !completed);
  $("btn-manual").disabled = !completed; $("in-manual").disabled = !completed; $("in-manual-reason").disabled = !completed;
  $("manual-msg").textContent = completed ? "" : "Not available: this was not a completed 30-second test.";
  // CDC-table inputs can be entered or corrected here (overnight UX: previously setup-only, forcing a repeat test)
  $("rv-age").value = sess.participant.ageText || ""; $("rv-sex").value = sess.participant.column || "";
  drawTimeline($("timeline"), r.trace, r, sess.core.params);
  $("quality").textContent = JSON.stringify({ quality: r.quality, frames: sess.loopStats, evidence: sess.evidenceStats, coverage: cov && { reference: cov.reference, endpoint: cov.endpoint, scan: { ok: cov.scan.ok, maxGapMs: cov.scan.maxGapMs, gaps: cov.scan.gaps } },
    extensionCheck: r.extensionCheck, reference: r.reference, cspBlockedRequests: cspBlocked.length }, null, 1);
  renderDecision(sess);
  if ($("scr-review").classList.contains("hidden")) show("review");
  else restoreFocus(focus);
}
// Result banner (rendered with every decision update, so its colour and wording follow the decision layer).
// Green ("measured") only once the decision reports the camera's count; until then a measured run is shown neutral
// ("pending"), because the detected number is not a result until checked (judge review).
function renderBanner(sess, d) {
  const r = sess.result, b = $("result-banner");
  // (review F1) a camera count reported as a range (d.reference.fromRange) is reported too, although d.value is null
  const cameraReported = d.completion === "completed_30s" && !d.manualUsed && (d.value !== null || !!d.reference.fromRange);
  const rangeOpen = d.automatic ? !d.automatic.determinate : r.countRange && r.countRange.min !== r.countRange.max;
  b.className = "banner " + (d.completion !== "completed_30s" ? "withheld" : cameraReported ? "measured" : r.status === "measured" ? "pending" : r.status);
  const range = r.countRange ? (r.countRange.min === r.countRange.max ? `${r.countRange.min}` : `${r.countRange.min}–${r.countRange.max}`) : null;
  const notReportedWhy = d.manualUsed ? " Your own count is reported instead (see “What will be reported” below)."
    : !sess.evidenceOn ? " It will not be reported: no images were kept to check it."
    : cameraReported ? " Checked: see “What will be reported” below."
    : " Not a result until checked (see “Still needed” below).";
  const who = sess.source === "demo" ? "the app (simulated participant)" : "the camera";
  b.innerHTML = (sess.source === "demo" ? `<p class="demolabel">${esc(DEMO_LABEL)}.</p>` : "") + `<strong>${esc(COMPLETION_TEXT[d.completion] || d.completion)}.</strong> ${esc(STATUS_TEXT[r.status])}${range !== null ? ` — ${who} detected <strong>${esc(range)}</strong> full stand(s)${rangeOpen ? " (some rises need your decision)" : ""}.${esc(notReportedWhy)}` : "."}` +
    ([...r.withheldReasons.map(plainReason), ...r.reviewNotes].length ? `<ul>${[...r.withheldReasons.map(plainReason), ...r.reviewNotes].map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : "") +
    (sess.evidenceOn ? `<p class="small">Images kept: ${sess.evidenceStats.frames}; failed captures: ${sess.evidenceStats.dropped}; discarded late: ${sess.evidenceStats.lateOrStale}.</p>` : "");
}
function onParticipantEdit() {
  const sess = S; if (!sess || !sess.result) return;
  const ageText = $("rv-age").value.trim(), column = $("rv-sex").value;
  if (ageText === sess.participant.ageText && column === sess.participant.column) return;
  sess.participant = { ageText, column };
  log(sess, `Observer entered age "${ageText || "-"}" and table column "${column || "-"}" on the review screen`);
  renderDecision(sess);
}
$("rv-age").addEventListener("change", onParticipantEdit); $("rv-sex").addEventListener("change", onParticipantEdit);

$("btn-manual").addEventListener("click", () => {
  const sess = S; if (!sess || !sess.result) return;
  const text = $("in-manual").value, reason = $("in-manual-reason").value;
  if (parseStrictInt(text, 2, 0, 60) === null) { $("manual-msg").textContent = "Enter a whole number from 0 to 60 (digits only)."; return; }
  if (!reason.trim()) { $("manual-msg").textContent = "Say how you counted (required)."; return; }
  sess.review.manual = { text, reason: reason.trim() }; $("manual-msg").textContent = "";
  if (sess.review.basisChoice) { log(sess, "Count basis choice reset because your own count changed"); sess.review.basisChoice = null; }
  log(sess, `Observer's own count entered: ${text} (${reason.trim()})`);
  renderDecision(sess);
});

// Count basis (docs/CONTRACTS_CP4.md s3): explicit, with a rationale; no default preference.
function renderBasis(sess, d) {
  const bb = $("basis-body"); bb.innerHTML = "";
  if (!sess.review.manual || d.completion !== "completed_30s") return;
  const auto = d.automatic;
  const p = document.createElement("p");
  p.innerHTML = d.conflict ? `<strong class="warn">The counts differ:</strong> camera (after your checks) ${auto.determinate ? auto.min : auto.min + "–" + auto.max}, your count ${d.supervisor.value}. Choose which one to report and say why.`
    : `Your count: ${d.supervisor.valid ? d.supervisor.value : "not valid"}.${auto && auto.eligible && d.supervisor.value === auto.min ? " It agrees with the checked camera count." : " You can report it instead of the camera count."}`;
  bb.appendChild(p);
  const why = document.createElement("input"); why.type = "text"; why.id = "in-basis-why"; why.placeholder = "Reason for this choice (required)"; why.maxLength = 200; why.value = sess.review.basisChoice ? sess.review.basisChoice.rationale : "";
  bb.appendChild(why);
  const row = document.createElement("div"); row.className = "choices";
  const pick = (basis) => () => { const rationale = $("in-basis-why").value.trim(); if (!rationale) { $("manual-msg").textContent = "A reason is required for choosing which count to report."; return; }
    sess.review.basisChoice = { basis, rationale, at: { automaticMin: auto ? auto.min : null, automaticMax: auto ? auto.max : null, supervisor: d.supervisor.value } }; log(sess, `Count basis chosen: ${basis === "supervisor" ? "my own count" : "camera count"} (${rationale})`); renderDecision(sess); };
  if (auto && auto.eligibleExceptRange) row.appendChild(btn("Report the camera count", pick("automatic"), { chosen: sess.review.basisChoice && sess.review.basisChoice.basis === "automatic" }));
  row.appendChild(btn("Report my own count", pick("supervisor"), { disabled: !d.supervisor.valid || !liveClock(sess), chosen: sess.review.basisChoice && sess.review.basisChoice.basis === "supervisor" }));
  if (sess.review.basisChoice) row.appendChild(btn("Undo choice", () => { sess.review.basisChoice = null; log(sess, "Count basis choice undone"); renderDecision(sess); }));
  bb.appendChild(row);
}

function renderDecision(sess) {
  let d = decision(sess);
  if (d.staleChoice) {                                   // overnight fix ON-03: counts changed after the choice -> choose again
    sess.review.basisChoice = null; log(sess, "Count basis choice cleared: a count changed after it was made. Choose again.");
    d = decision(sess); $("manual-msg").textContent = "A count changed after you chose which one to report: choose again.";
  }
  sess.lastDecision = d;
  renderBanner(sess, d);
  $("decision").innerHTML = `<p><strong>${esc(d.title)}</strong></p>
    <p>Reported number: <strong>${esc(d.value === null ? (d.reference.fromRange ? d.valueText : "not reported") : d.value)}</strong> — ${esc(d.basis)}</p>
    <p class="small">Camera (as detected): ${d.counts.machine ?? "—"} · camera after your checks: ${d.counts.reviewed ?? "—"}${d.automatic && !d.automatic.determinate ? ` (range ${d.automatic.min}–${d.automatic.max})` : ""} · your own count: ${d.counts.supervisor ?? "—"}</p>
    ${d.reference.eligible ? `<p class="cdcline">${sess.source === "demo" ? "<span class=\"demotag\">DEMO ONLY</span> " : ""}CDC table (${esc(d.reference.band)}): <strong>${d.reference.category === "below_average" ? "below average" : "not below average"}</strong> (below average = fewer than ${d.reference.threshold}). The CDC form states: “A below average score indicates a risk for falls.”</p>` : `<p>CDC table not applied because:</p><ul>${d.reference.blockers.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`}`;
  // "Still needed" summary at the top of the review (overnight UX: the list used to be only at the bottom)
  const todo = $("todo");
  todo.innerHTML = d.reference.eligible
    ? `<p><strong>Nothing more is needed.</strong> Reported number: <strong>${esc(d.value === null ? d.valueText : d.value)}</strong>. Open “Show summary”.</p>`
    : (() => {
      // blockers that no answer on this screen can remove (they need a new test, images, or a live camera)
      const fixedHere = (x) => !/^(Replay of a video file|This was not a completed 30-second test|No evidence images were kept|The practice-stand reference was accepted without looking|There is no image of the practice stand|No image near the top of rise|Images are missing between|No practice stand was accepted|No image at the 30-second mark)|no continuous images/.test(x);
      // (ON-40) without images, undecided rises cannot be resolved on this screen either
      const fixable = (x) => fixedHere(x) && !(!evidenceAvailable(sess) && /rise\(s\) are unresolved|decide every rise/.test(x));
      const can = d.reference.blockers.filter(fixable), cannot = d.reference.blockers.filter((x) => !fixable(x));
      return `<p><strong>${d.value === null ? "Not reported yet." : `Reported number: ${esc(d.value)}.`}</strong></p>` +
        (can.length ? `<p><strong>Still needed</strong> (on this screen):</p><ul>${can.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : "") +
        (cannot.length ? `<p><strong>Cannot be fixed on this screen</strong> (the CDC table will not be shown):</p><ul>${cannot.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : "");
    })();
  $("audit").innerHTML = sess.audit.map((a) => `<li>${esc(new Date(a.at).toLocaleTimeString())}: ${esc(a.what)}</li>`).join("");
  renderBasis(sess, d);
}

$("btn-report").addEventListener("click", () => { const sess = S; if (!sess || !sess.result) return; $("report").innerHTML = buildReport(sess, decision(sess)); show("report"); });
$("btn-again").addEventListener("click", () => { teardown(); show("setup"); });
$("btn-review").addEventListener("click", () => show("review"));
$("btn-new").addEventListener("click", () => { teardown(); show("setup"); });
$("btn-print").addEventListener("click", () => window.print());
function exportRecord(sess) {
  const d = decision(sess);
  const demo = sess.source === "demo";
  return { exportedAt: new Date().toISOString(), ...(demo ? { notice: DEMO_LABEL } : {}), core: CORE_VERSION, decisionVersion: d.version, source: sess.source, replayName: sess.replayName,
    ...(demo ? { demo: demoRecord(sess.demo && sess.demo.script) } : {}),
    participant: sess.participant, decision: d, result: sess.result, review: sess.review, audit: sess.audit, coverage: sess.coverage,
    frames: sess.loopStats, evidence: { kept: sess.evidenceOn, images: sess.evidenceStats ? sess.evidenceStats.frames : 0, failedCaptures: sess.evidenceStats ? sess.evidenceStats.dropped : 0, includedInThisFile: false },
    cspBlockedRequests: cspBlocked, engine: demo ? "none (simulated demo: body points generated by the demo script)" : engineInfo };
}
$("btn-json").addEventListener("click", () => {
  const sess = S; if (!sess || !sess.result) return;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(exportRecord(sess), null, 1)], { type: "application/json" }));
  a.download = `chair-stand-record-${sess.source === "demo" ? "SIMULATED-DEMO-" : ""}${new Date().toISOString().slice(0, 19).replace(/:/g, "")}.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
});

// ---------- test harness hooks (only with ?harness=1; used by eval/browser/*.mjs) ----------
if (HARNESS) {
  window.__steady = {
    async realtime(url, name, { evidence = false } = {}) { $("c-evidence").checked = evidence; await startReplay(url, name); return true; },
    startNow() { return startCountdown(S); },
    back() { $("btn-back").click(); },
    acceptShownReference() { $("btn-ref-yes").click(); return S && S.core ? S.core.readiness().practice : null; },
    rejectShownReference() { $("btn-ref-no").click(); },
    exportRecord() { return S && S.result ? exportRecord(S) : null; },
    reportText() { return S && S.result ? buildReport(S, decision(S)) : null; },
    evidenceTimes() { return S ? S.evidence.times() : []; },
    state() {
      const sess = S;
      return { hasSession: !!sess, source: sess && sess.source, phase: sess && sess.core && sess.core.phase, ended: sess && sess.ended, countingDown: sess && sess.countingDown,
        goT: sess && sess.goT, visible: screens.filter((s) => !$("scr-" + s).classList.contains("hidden")),
        readyStatus: $("ready-status").textContent, setupMsg: $("setup-msg").textContent, refCardVisible: !$("ref-card").classList.contains("hidden"),
        streamLive: !!(sess && sess.stream && sess.stream.getTracks().some((t) => t.readyState === "live")),
        videoSrcObject: !!$("video").srcObject, demo: sess && sess.demo ? { tGo: sess.demo.script.tGo, info: sess.demo.script.info() } : null,
        readiness: sess && sess.core && sess.core.phase === "calibrating" ? sess.core.readiness() : null,
        result: sess && sess.result && { status: sess.result.status, reason: sess.result.reason, count: sess.result.count, countRange: sess.result.countRange, events: sess.result.events.map((e) => ({ n: e.n, cls: e.cls, counted: e.counted, tFull: e.tFull, tPeak: e.tPeak, tExpiry: e.tExpiry })), withheld: sess.result.withheldReasons, flags: sess.result.reviewFlags, quality: sess.result.quality, extensionCheck: sess.result.extensionCheck, reference: sess.result.reference, window: sess.result.window },
        loopStats: sess && (sess.loop ? sess.loop.stats() : sess.loopStats), evidence: sess && sess.evidence.stats(), coverage: sess && sess.coverage && { imageCount: sess.coverage.imageCount, reference: sess.coverage.reference, events: sess.coverage.events, endpoint: sess.coverage.endpoint, scan: { ok: sess.coverage.scan.ok, gaps: sess.coverage.scan.gaps } },
        decision: sess && sess.result ? decision(sess) : null, review: sess && sess.review, cspBlocked: cspBlocked.length, audit: sess ? sess.audit.map((a) => a.what) : [] };
    },
  };
}
