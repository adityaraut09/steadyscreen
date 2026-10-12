// Causal 30-Second Chair Stand measurement core, v0.7 (shared by the browser app and Node evaluation).
// v0.7 (checkpoint 4): the practice stand is only DETECTED by the core; it becomes the standing reference only when
// the observer ACCEPTS it (docs/CONTRACTS_CP4.md s1). Acceptance is bound to the hold id, the tracker lock generation,
// the camera scale (shin length) and its age. Expiry reports observedMs exactly (float bug found in checkpoint 4).
//
// Causality: every decision uses only frames already received (trailing medians, no look-ahead, no whole-clip
// normalisation). A full stand is counted at the first frame where full extension is confirmed.
//
// What changed in 0.6 (checkpoint-3 audit repairs, see docs/AUDIT_RESPONSE_CP3.md):
//  A. Each rise attempt is classified against the participant's OWN practice stand (hip height + knee + hip angle):
//       full      -> counted automatically (event time = first frame of confirmed full extension)
//       uncertain -> not counted automatically; needs observer review (count is reported as a range)
//       partial   -> not counted; only with strong evidence (shortfall beyond twice the data-derived band)
//     Without a practice stand, or when the camera is too frontal to see joint angles, extension cannot be
//     verified and every rise is "uncertain".
//  B. Status is decided LAST, after every event and session flag exists.
//  D. 30-s expiry uses the CDC position condition (no velocity requirement); near-halfway goes to review, and so
//     does a never-stood attempt that has dropped more than the full-stand band below its peak (0.8.1: plus raw/smoothed
//     disagreement, a rise not yet registered, or a rise after a perched sit).
//  G. Readiness needs recent, continuous observations; start() refuses a stale "Go".
//  H. Quality reports missing observations separately from tolerated gaps.
import { PARAMS, CORE_VERSION } from "./params.js";
import { legGeometry, armsCrossed, torsoGeometry } from "./pose_features.js";
import { ParticipantTracker } from "./tracker.js";

const median = (a) => { const s = a.filter((x) => Number.isFinite(x)).sort((x, y) => x - y); const n = s.length; return n ? (n % 2 ? s[n >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2) : NaN; };
const spread = (a) => { const s = a.filter((x) => Number.isFinite(x)).sort((x, y) => x - y); if (!s.length) return Infinity; const q = (p) => s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))]; return q(0.9) - q(0.1); };
const r3 = (x) => (Number.isFinite(x) ? +x.toFixed(3) : null);
const mergeWins = (w) => { if (!w) return []; const s = [...w].sort((a, b) => a[0] - b[0]); const out = [];
  for (const [a, b] of s) { if (out.length && a <= out[out.length - 1][1] + 300) out[out.length - 1][1] = Math.max(out[out.length - 1][1], b); else out.push([a, b]); } return out; };
const r1 = (x) => (Number.isFinite(x) ? +x.toFixed(1) : null);

export function createChairStand({ width, height, params = PARAMS, calibrationMs, practiceStand = "require" } = {}) {
  const P = { ...params, ...(calibrationMs ? { calibrationMs } : {}) };
  const tracker = new ParticipantTracker(width, height, P);
  let phase = "calibrating";                // calibrating -> running -> done
  let shinHist = [];
  let calib = [];                           // {t, usable, h, knee, hip, view, status}
  let standRef = null;                      // detected practice stand {id, h, knee, hip, viewRatio, shinPx, t0, t1, lockGen, accepted}
  let suppressEndLevel = null, nextRefId = 1, lastHoldT = -Infinity, rejectedIds = new Set(), noReference = false, refRecord = null, suppressUntilBreak = false;
  let lastFrameT = null, pendingSelect = null, participantPose = null, lastOthersT = -Infinity;

  // running state
  let tGo = null, tEnd = null, hSit = null, angleOK = false, verified = false;
  let buf = { h: [], knee: [], hip: [] }, lastUsable = null, lastRaw = null, suspect = false;
  let state = "seated", consec = 0, consecT = null, attempt = null, upEvent = null, perched = null;
  let lostSince = null, lastTrackOkT = null;
  const events = [], gaps = [], trace = [];
  const flags = new Set(); const reviewNotes = []; const flagWindows = {};
  const winAt = (f, t0, t1) => { (flagWindows[f] = flagWindows[f] || []).push([t0, t1]); };   // records a time window only
  const flagAt = (f, t0, t1) => { flags.add(f); winAt(f, t0, t1); };                             // raises a review flag + window
  const q = { framesInWindow: 0, usableFrames: 0, noPoseFrames: 0, notParticipantFrames: 0, legsNotVisibleFrames: 0,
    ambiguousFrames: 0, overlapFrames: 0, otherPersonFrames: 0, discontinuityFrames: 0, maxFrameIntervalMs: 0 };
  let usableTimes = [], armsSeen = 0, armsUncrossed = 0, seatMin = Infinity; const seatTroughs = [];
  let reacquiredT = [];
  let result = null;

  const shinRef = () => (shinHist.length >= 5 ? median(shinHist) : null);
  const rel = (t) => ((t - tGo) / 1000).toFixed(1);

  // ---------- participant choice ----------
  function chooseInitial(poses, geoms) {
    if (pendingSelect) {                      // observer clicked the participant in the camera check
      let best = -1, bd = Infinity;
      geoms.forEach((g, i) => { const d = Math.hypot(g.centre[0] - pendingSelect.x, g.centre[1] - pendingSelect.y); if (d < bd) { bd = d; best = i; } });
      pendingSelect = null;
      return best;
    }
    if (poses.length === 1) return 0;
    const seated = poses.map((lm, i) => ({ i, g: legGeometry(lm, width, height, null) })).filter((c) => c.g && c.g.h < P.seatedMaxH);
    return seated.length === 1 ? seated[0].i : -1;   // several people and not exactly one seated -> not ready
  }

  function measure(frame) {
    const tr = tracker.update(frame.poses, phase === "calibrating" ? chooseInitial : null, frame.t);
    participantPose = tr.status === "ok" ? tr.pose : null;
    if (tr.status === "ok" && tr.others > 0) {
      const sizes = frame.poses.filter((p) => p !== tr.pose).map((p) => torsoGeometry(p, width, height).size);
      if (sizes.some((s) => s >= P.minRelativeSize * tr.geom.size)) lastOthersT = frame.t;
    } else if (frame.poses.length > 1) lastOthersT = frame.t;
    if (tr.status !== "ok") return { usable: false, status: tr.status, overlap: tr.overlap, others: tr.others };
    const g = legGeometry(tr.pose, width, height, shinRef());
    if (!g) return { usable: false, status: "legs_not_visible", overlap: tr.overlap, pose: tr.pose, geom: tr.geom, others: tr.others };
    shinHist.push(g.shin); if (shinHist.length > 30) shinHist.shift();
    return { usable: true, status: "ok", g, overlap: tr.overlap, pose: tr.pose, geom: tr.geom, others: tr.others };
  }

  // ---------- readiness ----------
  // Readiness windows: >= readinessMinUsableFrac of frames usable, and no gap between USABLE frames above
  // readinessMaxGapMs (a single dropped camera frame is tolerated; sparse or stale observation is not).
  function windowStats(tFrom, tTo) {
    const all = calib.filter((c) => c.t >= tFrom && c.t <= tTo);
    const win = all.filter((c) => c.usable);
    let maxGap = win.length ? win[0].t - tFrom : Infinity;
    for (let i = 1; i < win.length; i++) maxGap = Math.max(maxGap, win[i].t - win[i - 1].t);
    const usableFrac = all.length ? win.length / all.length : 0;
    return { win, maxGap, allUsable: win.length > 0 && usableFrac >= P.readinessMinUsableFrac };
  }

  function seatedWindow() {
    const last = calib[calib.length - 1]; if (!last) return null;
    const { win, maxGap, allUsable } = windowStats(last.t - P.calibrationMs, last.t);
    const minFrames = Math.ceil(P.minEffectiveFps * P.calibrationMs / 1000);
    const hs = win.map((c) => c.h);
    return { ok: allUsable && maxGap <= P.readinessMaxGapMs && win.length >= minFrames && median(hs) < P.seatedMaxH && spread(hs) <= P.calibrationMaxSpread,
      hSit: median(hs), t0: last.t - P.calibrationMs, moving: allUsable && spread(hs) > P.calibrationMaxSpread, notSeated: allUsable && median(hs) >= P.seatedMaxH, sparse: maxGap > P.readinessMaxGapMs || win.length < minFrames };
  }

  // Practice stand DETECTION: a still standing hold (>= standHoldMs), preceded by seated frames.
  // Detection alone never makes the reference trusted (checkpoint 4, audit A).
  // 0.8.1 (overnight ON-09/ON-14/ON-21): one practice stand = one stand, from its first still hold until the participant
  // descends below halfway ("ended"). While it continues, the reference keeps the MOST EXTENDED still window of that stand
  // (never a later sag, never an early not-yet-straight window). It is offered for confirmation only AFTER it ended, so
  // the card shows the final values and their image; showing (freezeReference) or accepting freezes them. A new stand
  // after an ended one gets a new id, which voids any earlier acceptance.
  // 0.8.2 (ON-27): compare like with like - by joint angles when both windows have them, otherwise by hip height
  const hasAngles = (v) => Number.isFinite(v.knee) && Number.isFinite(v.hip);
  function representative(cands) {
    const withA = cands.filter(hasAngles);
    const pool = withA.length ? withA : cands;
    const score = (v) => (withA.length ? v.knee + v.hip : 100 * v.h);
    const best = Math.max(...pool.map(score));
    const near = pool.filter((v) => score(v) >= best - (withA.length ? P.refTopBandDeg : 100 * 0.02)).sort((a, b) => score(a) - score(b));
    return near[(near.length - 1) >> 1];
  }
  const moreExtended = (a, b) => (hasAngles(a) && hasAngles(b) ? a.knee + a.hip > b.knee + b.hip : hasAngles(a) !== hasAngles(b) ? hasAngles(a) : a.h > b.h);
  function updateStandRef(t) {
    const last = calib[calib.length - 1]; if (!last || !last.usable) return;
    const { win, maxGap, allUsable } = windowStats(last.t - P.standHoldMs, last.t);
    if (!allUsable || maxGap > P.readinessMaxGapMs || win.length < Math.ceil(P.minEffectiveFps * P.standHoldMs / 1000)) return;
    const seatedEarlier = calib.filter((c) => c.usable && c.t < last.t - P.standHoldMs && c.h < P.seatedMaxH).map((c) => c.h);
    if (!seatedEarlier.length) return;
    const hs = win.map((c) => c.h);
    if (median(hs) < Math.max(P.standAbsMin, median(seatedEarlier) + P.standHoldMinRise)) return;
    // 0.8.2 (ON-27): the window supplies joint angles only if >= refMinAngleFrac of its frames have both; otherwise its
    // angles are "not measured" (-> view unverifiable, every rise needs review) instead of coming from one or two frames
    const angFrac = win.filter((c) => Number.isFinite(c.knee) && Number.isFinite(c.hip)).length / win.length;
    const angOK = angFrac >= P.refMinAngleFrac && angFrac * win.length >= P.minAngleFrames;
    if (spread(hs) > P.standHoldMaxSpreadH || (angOK && (spread(win.map((c) => c.knee)) > P.standHoldMaxSpreadDeg || spread(win.map((c) => c.hip)) > P.standHoldMaxSpreadDeg))) return;
    if (suppressUntilBreak) return;                                    // the rejected stand has not ended yet: don't re-ask
    const continuing = standRef && !standRef.ended && standRef.lockGen === tracker.lockGen;
    if (continuing && (standRef.accepted || standRef.frozen)) return;  // frozen once shown or accepted
    const vals = { h: median(hs), knee: angOK ? median(win.map((c) => c.knee)) : NaN, hip: angOK ? median(win.map((c) => c.hip)) : NaN, viewRatio: angOK ? median(win.map((c) => c.view)) : NaN,
      shinPx: median(win.map((c) => c.shin)), t0: win[0].t, t1: last.t, lockGen: tracker.lockGen };
    lastHoldT = t;
    // 0.8.3 (ON-32): "most extended" by the maximum of noisy windows biased the reference upward (more review); use the
    // MEDIAN window among those within refTopBand of the most extended one
    if (continuing) { standRef.cands.push(vals); Object.assign(standRef, representative(standRef.cands)); }
    else { standRef = { id: nextRefId++, accepted: null, frozen: false, ended: false, endLevel: (median(seatedEarlier) + vals.h) / 2, cands: [vals], ...vals }; }
    standRef.sideView = standRef.viewRatio <= P.sideViewMaxShoulderRatio;
    standRef.postureWarning = standRef.sideView && (standRef.knee < P.referenceWarnKneeDeg || standRef.hip < P.referenceWarnHipDeg);
  }
  // The practice stand has ended once the participant descends below halfway after its last still frame.
  // 0.8.2 (ON-28): it must stay below for standEndMs (a brief landmark glitch must not end a stand mid-hold)
  let belowSince = null;
  function markStandEnded(c) {
    if (!c.usable) return;
    const level = standRef && !standRef.ended ? standRef.endLevel : suppressUntilBreak ? suppressEndLevel : null;
    if (level === null || c.t <= lastHoldT || c.h > level) { belowSince = null; return; }
    if (belowSince === null) belowSince = c.t;
    if (c.t - belowSince < P.standEndMs) return;
    belowSince = null;
    if (standRef && !standRef.ended) standRef.ended = true;
    else if (suppressUntilBreak) { suppressUntilBreak = false; suppressEndLevel = null; }
  }

  // Why an accepted reference is no longer valid (or null if it is).
  function referenceProblem(tNow) {
    if (!standRef || !standRef.accepted) return null;
    if (standRef.lockGen !== tracker.lockGen) return "reference_person_changed";
    if (tNow - standRef.t1 > P.referenceMaxAgeMs) return "reference_stale";
    const shins = calib.filter((c) => c.usable && c.t >= tNow - P.calibrationMs).map((c) => c.shin);
    if (shins.length && Math.abs(median(shins) - standRef.shinPx) / standRef.shinPx > P.referenceMaxShinChange) return "reference_camera_or_person_changed";
    return null;
  }

  function readiness() {
    const reasons = [];
    const last = calib[calib.length - 1];
    if (!last) return { ready: false, reasons: ["no_frames"], practice: practiceInfo() };
    const st = last.status;
    if (st === "none") reasons.push("no_person_detected");
    if (st === "unlocked") reasons.push("several_people_select_participant");
    if (st === "ambiguous") reasons.push("another_person_overlaps_participant");
    if (st === "lost") reasons.push("participant_lost");
    if (st === "legs_not_visible") reasons.push("hips_knees_ankles_not_all_visible");
    const sw = seatedWindow();
    if (!reasons.length && practiceStand !== "skip" && !noReference) {
      const prob = referenceProblem(last.t);
      if (!standRef || rejectedIds.has(standRef.id)) reasons.push("practice_stand_needed");
      else if (!standRef.accepted && !standRef.ended) reasons.push("practice_stand_in_progress");
      else if (!standRef.accepted) reasons.push("practice_stand_needs_confirmation");
      else if (prob) reasons.push(prob);
    }
    if (!reasons.length && sw) {
      if (sw.sparse) reasons.push("camera_frames_too_sparse");
      else if (sw.notSeated) reasons.push("participant_not_seated");
      else if (!sw.ok) reasons.push("hold_still_seated");
      else if (standRef && standRef.t1 >= sw.t0) reasons.push("hold_still_seated");
    }
    return { ready: reasons.length === 0, reasons, hSit: sw ? sw.hSit : null, practice: practiceInfo() };
  }
  const practiceInfo = () => (practiceStand === "skip" || noReference ? { mode: "skipped", state: "none" } : standRef && !rejectedIds.has(standRef.id)
    ? { mode: "calibrated", state: standRef.accepted ? "accepted" : standRef.ended ? "detected" : "in_progress", refId: standRef.id, h: r3(standRef.h), knee: r1(standRef.knee), hip: r1(standRef.hip),
        viewRatio: r3(standRef.viewRatio), sideView: standRef.sideView, postureWarning: standRef.postureWarning, t0: standRef.t0, t1: standRef.t1, accepted: standRef.accepted }
    : { mode: "needed", state: "none" });

  // ---------- running ----------
  function recordGap(t0, t1, hBefore, hAfter) {
    const dur = t1 - t0;
    if (dur < P.reviewGapMs) return;
    const moving = (hBefore !== null && hBefore > hSit + P.movementGapRise) || (hAfter !== null && hAfter > hSit + P.movementGapRise) || attempt !== null || state === "up";
    gaps.push({ t0, t1, dur, moving });
    if (dur > P.maxGapMs) return;
    if (moving) { flagAt("gap_during_movement", t0, t1); reviewNotes.push(`The participant could not be measured for ${(dur / 1000).toFixed(2)} s while moving (${rel(t0)}-${rel(t1)} s).`); }
  }

  let recentIntervals = [];
  const smoothSpanMs = () => { const m = median(recentIntervals); return Number.isFinite(m) ? m * (P.smoothFrames - 1) : 0; };
  const deficits = (s) => ({
    h: standRef ? standRef.h - s.h : NaN,
    knee: angleOK ? standRef.knee - s.knee : NaN,
    hip: angleOK ? standRef.hip - s.hip : NaN,
  });
  const fullOK = (d) => verified && d.h <= P.fullH && d.knee <= P.fullKneeDeg && d.hip <= P.fullHipDeg;
  const candidateUp = (s) => s.h >= P.standAbsMin && s.h >= hSit + P.standRiseMin && (!standRef || standRef.h - s.h <= P.fullH);

  function newEvent(cls, fields) {
    const ev = { n: events.length + 1, cls, counted: cls === "full" || cls === "expiry", tRise: null, tFull: null, tPeak: null, tSeat: null,
      peak: null, shortfall: null, flags: [], ...fields };
    if (reacquiredT.some((t) => ev.tRise !== null && ev.tRise - t < 3000 && ev.tRise >= t - 3000)) ev.flags.push("after_participant_reacquired");
    events.push(ev); return ev;
  }

  function topEvidence(a) {
    const smp = a.samples || []; if (!smp.length) return;
    const hs = smp.map((x) => x.h).sort((x, y) => x - y);
    const peak = hs[Math.max(0, Math.ceil(0.9 * hs.length) - 1)];                  // 90th percentile: one noisy frame cannot set it
    const top = smp.filter((x) => x.h >= peak - P.peakBandH && Number.isFinite(x.k) && Number.isFinite(x.p));
    a.topAngleN = top.length;
    a.best.knee = top.length ? Math.min(...top.map((x) => x.k)) : Infinity;
    a.best.hip = top.length ? Math.min(...top.map((x) => x.p)) : Infinity;
  }
  function closeAttempt(t, reasonFlag = null) {
    const a = attempt; attempt = null;
    topEvidence(a);
    const best = a.best;
    let cls;
    const k = P.partialFactor;
    // 0.8: "strong evidence" needs MEASURED values (ON-05: a non-finite angle shortfall means the angles were never seen,
    // not that they were bad) and a smoothing window short enough to resolve the peak (ON-08: low frame rates flatten it).
    const coarse = smoothSpanMs() > P.maxPartialSmoothSpanMs;
    const anglesSeen = Number.isFinite(best.knee) && Number.isFinite(best.hip) && (a.topAngleN || 0) >= P.minAngleFrames;   // >= 3 frames at the top (ON-26)
    if (verified) {
      const strong = !coarse && (best.h > k * P.fullH || (anglesSeen && best.knee > k * P.fullKneeDeg && best.hip > k * P.fullHipDeg));
      cls = strong ? "partial" : "uncertain";
      if (!strong && coarse) reasonFlag = reasonFlag || "frame_rate_too_low_to_rule_out_full_stand";
      else if (!strong && !anglesSeen) reasonFlag = reasonFlag || "joint_angles_not_measured";
    } else if (standRef) {
      cls = !coarse && best.h > k * P.fullH ? "partial" : "uncertain";
    } else {
      cls = a.peakH < P.standAbsMin ? "partial" : "uncertain";
    }
    const ev = newEvent(cls, { tRise: a.tRise, tPeak: a.tPeak, tSeat: t, peak: { h: r3(a.peakH), knee: r1(a.peakKnee), hip: r1(a.peakHip) },
      shortfall: { h: r3(best.h), knee: r1(best.knee), hip: r1(best.hip) } });
    if (reasonFlag) ev.flags.push(reasonFlag);
    if (a.seatNotReached) ev.flags.push("seat_return_not_confirmed");
    if (cls === "uncertain") ev.flags.push(verified ? "extension_not_confirmed" : standRef ? "extension_unverifiable_view" : practiceStand === "skip" ? "no_practice_stand" : "no_accepted_reference");
    return ev;
  }

  const halfwayH = () => hSit + ((standRef ? standRef.h : P.defaultStandRef) - hSit) / 2;
  function stepState(t, s, raw = null) {
    const d = deficits(s);
    // 0.8.2 (ON-26): top-of-rise angle evidence uses this frame's RAW angles (a smoothed median still contains frames from
    // lower in the rise, which at low frame rates made a genuine full stand look like a partial)
    const rd = raw ? deficits(raw) : { knee: NaN, hip: NaN };
    if (state === "seated" && !attempt) seatMin = Math.min(seatMin, s.h);
    if (state === "seated") {
      // 0.8 (ON-06): after a descent below halfway that never reached the calibrated seat level ("perched"), a new rise
      // starts only once h climbs perchRiseMin above the lowest point; such a rise can never be counted automatically.
      if (perched) {
        if (s.h <= hSit + P.seatReturnRise) perched = null;
        else {
          perched.min = Math.min(perched.min, s.h);
          if (!attempt && s.h > perched.min + P.perchRiseMin) attempt = { tRise: t, seatNotReached: true, best: { h: Infinity, knee: Infinity, hip: Infinity }, peakH: -Infinity, tPeak: t, peakKnee: NaN, peakHip: NaN };
        }
      }
      if (!attempt && !perched && s.h > hSit + P.partialRiseMin) {
        attempt = { tRise: t, best: { h: Infinity, knee: Infinity, hip: Infinity }, peakH: -Infinity, tPeak: t, peakKnee: NaN, peakHip: NaN };
        if (Number.isFinite(seatMin)) { seatTroughs.push(seatMin); seatMin = Infinity; }
      }
      if (attempt) {
        if (s.h > attempt.peakH) { attempt.peakH = s.h; attempt.tPeak = t; attempt.peakKnee = s.knee; attempt.peakHip = s.hip; }
        // 0.8.1 (ON-20): angle shortfalls count as evidence only from frames AT the top of this rise (h within
        // peakBandH of its highest point so far); hip height saturates near standing, so angles seen lower in the rise
        // say nothing about whether the participant straightened fully.
        if (Number.isFinite(d.h)) attempt.best.h = Math.min(attempt.best.h, d.h);
        // raw samples of this rise; "at the top" is decided when the rise closes (from past frames only), against a
        // spike-robust peak of the RAW hip height (the smoothed h lags and would admit frames from lower in the rise)
        (attempt.samples = attempt.samples || []).push({ h: raw ? raw.h : s.h, k: rd.knee, p: rd.hip });
        const up = verified ? fullOK(d) : candidateUp(s);
        // 0.8.3 (ON-33): a frame at full height whose joint angles are missing neither confirms nor breaks the run
        const unknown = verified && !up && Number.isFinite(d.h) && d.h <= P.fullH && (!Number.isFinite(d.knee) || !Number.isFinite(d.hip));
        if (unknown) { /* hold */ }
        else if (up) {
          if (consec === 0) consecT = t;
          consec += 1;
          if (consec >= P.standConfirmFrames) {
            const a = attempt; attempt = null; consec = 0;
            const auto = verified && !a.seatNotReached;
            upEvent = newEvent(auto ? "full" : "uncertain", { tRise: a.tRise, tFull: auto ? consecT : null, tPeak: t, peak: { h: r3(s.h), knee: r1(s.knee), hip: r1(s.hip) }, shortfall: null });
            if (a.seatNotReached) upEvent.flags.push("seat_return_not_confirmed");
            if (!verified) upEvent.flags.push(standRef ? "extension_unverifiable_view" : practiceStand === "skip" ? "no_practice_stand" : "no_accepted_reference");
            upEvent._best = { h: Infinity, knee: Infinity, hip: Infinity };
            state = "up";
          }
        } else consec = 0;
        if (attempt && s.h <= hSit + P.seatReturnRise) closeAttempt(t);
      }
    } else {                                  // state up (counted or unverified stand), until back seated
      const ev = upEvent;
      if (s.h > ev.peak.h) { ev.peak = { h: r3(s.h), knee: r1(s.knee), hip: r1(s.hip) }; ev.tPeak = t; }
      for (const kk of ["h", "knee", "hip"]) if (Number.isFinite(d[kk])) ev._best[kk] = Math.min(ev._best[kk], d[kk]);
      // 0.8.2 (ON-29): a deep dip that stays above halfway and comes back up (a half-sit, or a squat) is not a new stand
      // by rule, but it must not pass silently: flag it for review on its images
      if (!ev._dip || s.h < ev._dip.h) ev._dip = { h: s.h, t };
      if (ev.peak.h - ev._dip.h > P.dipFlagH && standRef && s.h >= standRef.h - P.fullH) { flagAt("stand_dipped_without_sitting", ev._dip.t - 500, t); ev._dip = { h: s.h, t }; }
      if (s.h <= hSit + P.seatReturnRise) { ev.tSeat = t; state = "seated"; upEvent = null; seatMin = Infinity; }
      else if (s.h < halfwayH()) { ev.tSeat = t; state = "seated"; upEvent = null; seatMin = Infinity; perched = { t, min: s.h }; }   // ON-06
    }
  }

  function applyExpiry() {
    // [CDC] "If the patient is over halfway to a standing position when 30 seconds have elapsed, count it as a stand."
    const standH = standRef ? standRef.h : P.defaultStandRef;
    const halfway = hSit + (standH - hSit) / 2;
    const out = { evaluated: true, state, halfway: r3(halfway), h: lastUsable ? r3(lastUsable.h) : null, decision: "none" };
    if (state === "up" || !lastUsable) return out;                    // already counted, or not observed
    // 0.8 (ON-07): the smoothed h lags a moving hip, so the decision also looks at the last RAW observation. A rise that
    // the smoothed signal has not registered yet, or raw and smoothed on different sides of halfway, goes to review.
    const raw = lastRaw && lastRaw.t >= lastUsable.t - 1 ? lastRaw.h : lastUsable.h;
    out.hRaw = r3(raw);
    if (!attempt) {
      // seated (or perched after a sit that did not reach the seat level: ON-19, no phantom rise while sitting down)
      if (raw <= (perched ? perched.min + P.perchRiseMin : hSit + P.partialRiseMin)) return out;
      const tr = lastRaw ? lastRaw.t : lastUsable.t;
      attempt = { tRise: tr, seatNotReached: !!perched, best: { h: Infinity, knee: Infinity, hip: Infinity }, peakH: raw, tPeak: tr, peakKnee: NaN, peakHip: NaN };
      if (raw >= halfway - P.expiryNearHalfBand) {
        const ev = closeAttempt(tEnd, "expiry_rise_in_progress"); ev.cls = "uncertain"; ev.counted = false;
        out.decision = "review_rise_in_progress";
        reviewNotes.push("At 30 s the participant was part-way up and the camera could not tell whether they were rising: decide from the 30-second image whether they were over halfway up on a rise.");
      } else {
        const ev = closeAttempt(tEnd, "expiry_under_halfway"); ev.cls = "partial"; ev.counted = false; ev.flags = ["expiry_under_halfway"];
        out.decision = "not_counted_under_halfway";
      }
      return out;
    }
    const h = lastUsable.h;
    const descending = attempt.peakH - h > P.fullH;
    const split = (h > halfway) !== (raw > halfway) || Math.abs(raw - halfway) <= P.expiryNearHalfBand;
    // (ON-39: "descending" compares the attempt's highest point with the lagging smoothed h; a NEW push inside the same
    //  attempt that is rising over halfway - raw above both halfway and the smoothed h - is not a descent)
    if (descending && (raw <= halfway || raw <= h) && raw <= halfway + P.expiryNearHalfBand) {
      // 0.8.3/0.8.4 (ON-31, ON-35): the rise already peaked and the participant is coming down, at or below about halfway,
      // at 30 s. The question is whether that rise WAS a full stand before 30 s, not the 30-s halfway question: classify it
      // normally (review unless strong partial evidence). Checked BEFORE the near-halfway test (the smoothed height lags
      // a descent). The flag is neutral and does not start with "expiry_".
      closeAttempt(tEnd, "rise_peaked_before_30s");
      out.decision = "closed_descending_rise";
      return out;
    }
    if (Math.abs(h - halfway) <= P.expiryNearHalfBand || split) {
      const ev = closeAttempt(tEnd, "expiry_near_halfway"); ev.cls = "uncertain"; ev.counted = false;
      out.decision = "review_near_halfway";
      reviewNotes.push(`At 30 s the participant was about halfway up (h=${h.toFixed(2)}, halfway=${halfway.toFixed(2)}): decide whether the last rise counts.`);
    } else if (h > halfway && !descending && attempt.seatNotReached) {        // ON-18b: a rise after a perched sit is never auto-counted
      const ev = closeAttempt(tEnd, "expiry_over_halfway"); ev.cls = "uncertain"; ev.counted = false;
      out.decision = "review_after_unconfirmed_sit";
      reviewNotes.push("At 30 s the participant was over halfway up, but had not clearly sat down before this rise: decide whether it counts.");
    } else if (h > halfway && !descending) {
      const ev = newEvent("expiry", { tRise: attempt.tRise, tFull: null, tPeak: attempt.tPeak, tSeat: null, peak: { h: r3(attempt.peakH), knee: r1(attempt.peakKnee), hip: r1(attempt.peakHip) } });
      ev.flags.push("expiry_over_halfway"); ev.tExpiry = tEnd; attempt = null;
      if (!standRef) { ev.flags.push("expiry_default_standing_reference"); }
      out.decision = "counted_over_halfway";
    } else if (h > halfway && descending) {
      const ev = closeAttempt(tEnd, "expiry_attempt_descending"); ev.cls = "uncertain"; ev.counted = false;
      out.decision = "review_descending_attempt";
      reviewNotes.push("At 30 s the participant was above halfway but moving down from a rise that never reached full standing: decide whether it counts.");
    } else {
      const ev = closeAttempt(tEnd, "expiry_under_halfway"); ev.cls = "partial"; ev.counted = false;
      ev.flags = ev.flags.filter((f) => f === "expiry_under_halfway");
      out.decision = "not_counted_under_halfway";
    }
    return out;
  }

  return {
    get phase() { return phase; },
    get params() { return P; },

    /** Feed one frame {t: ms (monotonic), poses: [...]}. Returns a live snapshot for the UI. */
    push(frame) {
      if (phase === "done") return this.snapshot();
      if (lastFrameT !== null && frame.t <= lastFrameT) throw new Error("timestamps must increase");
      const interval = lastFrameT === null ? 0 : frame.t - lastFrameT;
      lastFrameT = frame.t;

      if (phase === "calibrating") {
        const m = measure(frame);
        if (m.status === "lost") { tracker.reset(); shinHist = []; }   // 0.8 (ON-13): a new lock starts a new shin history
        calib.push({ t: frame.t, usable: m.usable, h: m.usable ? m.g.h : null, knee: m.usable ? m.g.knee : NaN, hip: m.usable ? m.g.hip : NaN, view: m.usable ? m.g.viewRatio : NaN, shin: m.usable ? m.g.shin : NaN, status: m.status });
        while (calib.length && calib[0].t < frame.t - 20000) calib.shift();
        if (practiceStand !== "skip") { updateStandRef(frame.t); markStandEnded(calib[calib.length - 1]); }
        trace.push({ t: frame.t, h: m.usable ? r3(m.g.h) : null, s: m.status, ph: "cal" });
        if (trace.length > 3000) trace.shift();
        return this.snapshot();
      }

      if (frame.t > tEnd) { this.finish("expired"); return this.snapshot(); }
      q.framesInWindow += 1; q.maxFrameIntervalMs = Math.max(q.maxFrameIntervalMs, interval);
      const m = measure(frame);
      if (!frame.poses.length) q.noPoseFrames += 1;
      else if (["lost", "ambiguous", "unlocked", "none"].includes(m.status)) q.notParticipantFrames += 1;
      if (m.status === "legs_not_visible") q.legsNotVisibleFrames += 1;
      if (m.status === "ambiguous") q.ambiguousFrames += 1;
      if (m.overlap) { q.overlapFrames += 1; winAt("another_person_overlapped_candidate", frame.t - 300, frame.t + 300); }
      if (frame.poses.length > 1) q.otherPersonFrames += 1;
      // identity continuity: participant lost/ambiguous for >= reviewGapMs, then found again while someone else is around
      if (m.status === "ok") {
        if (lostSince !== null && frame.t - lostSince >= P.reviewGapMs && frame.t - lastOthersT <= P.otherPersonRecentMs) {
          flagAt("participant_reacquired_with_other_person_in_view", lostSince, frame.t); reacquiredT.push(frame.t);
          reviewNotes.push(`The participant was out of sight for ${((frame.t - lostSince) / 1000).toFixed(1)} s while another person was in view (${rel(lostSince)}-${rel(frame.t)} s): check that the same person was measured afterwards.`);
        }
        lostSince = null; lastTrackOkT = frame.t;
      } else if (lostSince === null) lostSince = lastTrackOkT ?? frame.t;
      if (m.usable && lastRaw) {
        const dt = Math.min((frame.t - lastRaw.t) / 1000, suspect ? 0.1 : Infinity);
        if (Math.abs(m.g.h - lastRaw.h) > P.jumpBase + P.jumpPerSec * dt) {
          m.usable = false; m.status = "discontinuity"; q.discontinuityFrames += 1; suspect = true;
          winAt("identity_or_landmark_discontinuity_candidate", frame.t - 200, frame.t + 200);
          if (q.discontinuityFrames >= 3) flags.add("identity_or_landmark_discontinuity");
        }
      }
      if (m.usable) { lastRaw = { t: frame.t, h: m.g.h }; suspect = false; }
      let sm = null;
      if (m.usable) {
        const prevT = lastUsable ? lastUsable.t : tGo;
        if (lastUsable) { recentIntervals.push(frame.t - lastUsable.t); if (recentIntervals.length > 15) recentIntervals.shift(); }
        if (frame.t - prevT >= P.reviewGapMs) buf = { h: [], knee: [], hip: [] };
        recordGap(prevT, frame.t, lastUsable ? lastUsable.h : hSit, m.g.h);
        for (const kk of ["h", "knee", "hip"]) { buf[kk].push(m.g[kk]); if (buf[kk].length > P.smoothFrames) buf[kk].shift(); }
        // 0.8.2 (ON-26): a smoothed angle exists only if THIS frame has it and >= 3 of the buffered frames do; otherwise the
        // median of a few older frames (lower in the rise) would pose as the angle at the top.
        const angleOf = (kk) => (Number.isFinite(m.g[kk]) && buf[kk].filter(Number.isFinite).length >= P.minAngleFrames ? median(buf[kk]) : NaN);
        sm = { h: median(buf.h), knee: angleOf("knee"), hip: angleOf("hip") };
        stepState(frame.t, sm, m.g);
        lastUsable = { t: frame.t, h: sm.h };
        usableTimes.push(frame.t); q.usableFrames += 1;
        const crossed = armsCrossed(m.pose, width, height, m.geom.size);
        if (crossed !== null) { armsSeen += 1; if (!crossed) armsUncrossed += 1; }
      }
      trace.push({ t: frame.t, h: sm ? r3(sm.h) : null, k: sm ? r1(sm.knee) : null, hp: sm ? r1(sm.hip) : null, s: m.status, o: m.overlap ? 1 : 0 });
      return this.snapshot();
    },

    readiness,

    /** Observer clicked the participant (normalised image coordinates) during the camera check. */
    selectParticipant(xn, yn) {
      if (phase !== "calibrating") return false;
      tracker.reset(); shinHist = []; pendingSelect = { x: xn * width, y: yn * height }; calib = []; standRef = null; noReference = false;
      return true;
    },

    /** The app shows the practice-stand card for `refId`: freeze its values so what is accepted is what was shown. */
    freezeReference(refId) {
      if (phase !== "calibrating" || !standRef || standRef.id !== refId || !standRef.ended) return false;
      standRef.frozen = true; return true;
    },
    /** Observer accepts the DETECTED practice stand `refId` as a full stand. basis: 'image' | 'observer_watched'. */
    acceptReference({ refId, basis }) {
      if (phase !== "calibrating" || !standRef || standRef.id !== refId || rejectedIds.has(refId) || !standRef.ended) return false;
      if (basis !== "image" && basis !== "observer_watched") return false;
      standRef.accepted = { basis, atT: lastFrameT }; standRef.frozen = true; noReference = false;
      return true;
    },
    /** Observer says the detected practice stand was NOT a full stand: it is discarded; a new one is needed. */
    rejectReference(refId) {
      if (phase !== "calibrating" || !standRef || standRef.id !== refId) return false;
      rejectedIds.add(refId); if (!standRef.ended) { suppressUntilBreak = true; suppressEndLevel = standRef.endLevel; } standRef = null;   // a new hold needs the stand to be broken first
      return true;
    },
    /** Observer chooses to count without a reference (every rise will be 'uncertain'). */
    countWithoutReference(on = true) { if (phase === "calibrating") noReference = !!on; return noReference; },

    /** Start the 30-s window at the "Go" cue. Requires readiness based on recent, continuous frames and an ACCEPTED,
     *  still-valid reference (or an explicit choice to count without one). */
    start(tGoMs, { withoutReference = false } = {}) {
      if (withoutReference) noReference = true;
      const r = readiness();
      if (!r.ready) throw new Error("not ready: " + r.reasons.join(","));
      if (tGoMs - lastFrameT > P.maxStartStaleMs) throw new Error(`stale: last camera frame ${Math.round(tGoMs - lastFrameT)} ms before Go`);
      hSit = r.hSit; tGo = tGoMs; tEnd = tGoMs + P.windowMs; phase = "running";
      if (noReference || !standRef || !standRef.accepted) { refRecord = standRef ? { ...standRef, usedAsReference: false } : null; standRef = null; }
      else refRecord = { ...standRef, usedAsReference: true };
      angleOK = !!(standRef && standRef.sideView && Number.isFinite(standRef.knee) && Number.isFinite(standRef.hip));
      verified = angleOK;
      lastUsable = null; lastRaw = null; buf = { h: [], knee: [], hip: [] };
      return { hSit, tGo, tEnd, practice: practiceInfo(), extensionCheck: verified ? "verified_side_view" : standRef ? "unverifiable_view" : noReference ? "no_accepted_reference" : "no_practice_stand" };
    },

    /** Close the test. reason: 'expired' | 'stream_end' | 'stopped' | 'page_hidden' | 'camera_error' */
    finish(reason, tNow = lastFrameT) {
      if (result) return result;
      if (phase !== "running") throw new Error("finish() called while " + phase);
      phase = "done";
      const withheld = [];
      let expiry = { evaluated: false };
      if (reason === "expired") {
        const endGap = tEnd - (lastUsable ? lastUsable.t : tGo);
        if (endGap > P.maxGapMs) withheld.push(`tracking_lost_before_end (${(endGap / 1000).toFixed(1)} s without the participant)`);
        else if (endGap >= P.reviewGapMs) {
          flagAt("expiry_endpoint_not_observed", tEnd - endGap - 500, tEnd);
          reviewNotes.push(`The participant was not measured during the last ${(endGap / 1000).toFixed(2)} s before 30 s: check the final position.`);
        }
        expiry = applyExpiry();
      } else if (attempt) {
        closeAttempt(Math.min(tNow ?? tGo, tEnd), "test_ended_during_rise");
      }
      // ---- quality (audit H): missing observations vs tolerated gaps are reported separately ----
      const tStop = reason === "expired" ? tEnd : Math.min(tNow ?? tGo, tEnd);
      const obsMs = reason === "expired" ? P.windowMs : Math.max(1, tStop - tGo);   // exact on expiry (float bug, cp4)
      const pts = [tGo, ...usableTimes.filter((t) => t <= tStop), tStop];
      let beyondTolMs = 0, longestGap = 0;
      for (let i = 1; i < pts.length; i++) { const g = pts[i] - pts[i - 1]; longestGap = Math.max(longestGap, g); beyondTolMs += Math.max(0, g - P.gapToleranceMs); }
      for (const g of gaps) if (g.dur > P.maxGapMs) withheld.push(`tracking_lost ${rel(g.t0)}-${rel(g.t1)} s (${(g.dur / 1000).toFixed(1)} s)`);
      if (beyondTolMs / obsMs > P.maxUnusableFraction) withheld.push(`participant_not_measurable_for_${Math.round(100 * beyondTolMs / obsMs)}pct_of_the_test`);
      const effFps = q.usableFrames / (obsMs / 1000);
      if (effFps < P.minEffectiveFps) withheld.push(`frame_rate_too_low (${effFps.toFixed(1)} usable fps)`);
      if (q.maxFrameIntervalMs > P.maxGapMs) withheld.push(`video_frames_stopped_for_${(q.maxFrameIntervalMs / 1000).toFixed(1)}_s`);
      const missingPct = q.framesInWindow ? (100 * (q.framesInWindow - q.usableFrames)) / q.framesInWindow : 100;
      if (missingPct > P.intermittentMissingPct) {
        flags.add("intermittent_tracking");
        reviewNotes.push(`The participant was measured in only ${(100 - missingPct).toFixed(0)}% of the video frames (short gaps were bridged).`);
      }
      if (Number.isFinite(seatMin)) seatTroughs.push(seatMin);
      const typicalSeat = seatTroughs.length >= 2 ? median(seatTroughs) : null;
      if (typicalSeat !== null && hSit - typicalSeat > 0.2) {
        flags.add("seated_baseline_drift");
        reviewNotes.push(`The seated position during the test (h~${typicalSeat.toFixed(2)}) was lower than at calibration (h=${hSit.toFixed(2)}).`);
      }
      if (flags.has("identity_or_landmark_discontinuity")) flagWindows.identity_or_landmark_discontinuity = mergeWins(flagWindows.identity_or_landmark_discontinuity_candidate);
      if (q.discontinuityFrames > 0) reviewNotes.push(`${q.discontinuityFrames} frame(s) were rejected because hip height jumped faster than a person can move (possible identity switch or landmark error).`);
      if (q.overlapFrames > 0) { flags.add("another_person_overlapped"); flagWindows.another_person_overlapped = mergeWins(flagWindows.another_person_overlapped_candidate); reviewNotes.push(`Another person overlapped the participant in ${q.overlapFrames} frame(s).`); }
      delete flagWindows.identity_or_landmark_discontinuity_candidate; delete flagWindows.another_person_overlapped_candidate;
      // ---- event-derived review flags (audit B): decided BEFORE the status ----
      for (const ev of events) {
        if (ev.cls === "full" && ev._best) {
          const b = ev._best;                  // shortfall at the best frame while up (for the review display)
          ev.shortfall = { h: r3(b.h), knee: r1(b.knee), hip: r1(b.hip) };
        }
        delete ev._best; delete ev._dip;
        if (ev.cls === "uncertain") flags.add("uncertain_rises");
        if (ev.flags.includes("after_participant_reacquired") && ev.counted) flags.add("participant_reacquired_with_other_person_in_view");
        if (ev.flags.includes("expiry_default_standing_reference")) flags.add("expiry_without_practice_stand");
      }
      if (!standRef && practiceStand === "skip") flags.add("no_practice_stand");
      else if (!standRef) flags.add("no_accepted_reference");
      else if (!verified) flags.add("extension_unverifiable_view");
      if (standRef && refRecord && refRecord.postureWarning) flagAt("reference_posture_warning", refRecord.t0, refRecord.t1);

      // ---- status LAST ----
      let status;
      if (reason === "page_hidden" || reason === "camera_error") { status = "withheld"; withheld.unshift(reason); }
      else if (reason === "stopped") status = "stopped";
      else if (reason === "stream_end" && (tNow ?? 0) < tEnd) status = "incomplete";
      else if (withheld.length) status = "withheld";
      else if (flags.size) status = "needs_review";
      else status = "measured";
      const countedN = events.filter((e) => e.counted).length;
      const uncertainN = events.filter((e) => e.cls === "uncertain").length;
      const protocolFlags = [];
      if (armsSeen >= 10 && armsUncrossed / armsSeen > P.armsFlagFraction) protocolFlags.push("arms_possibly_uncrossed");
      if (armsSeen < 10) protocolFlags.push("arms_not_observable");

      result = {
        core: CORE_VERSION, reason, status,
        qualityVerdict: withheld.length ? "withheld" : flags.size ? "needs_review" : "ok",
        count: status === "measured" || status === "needs_review" ? countedN : null,
        countRange: status === "measured" || status === "needs_review" ? { min: countedN, max: countedN + uncertainN } : null,
        countSoFar: countedN,
        events, gaps, expiry,
        partials: events.filter((e) => e.cls === "partial"),
        withheldReasons: withheld, reviewFlags: [...flags], reviewNotes, protocolFlags, flagWindows,
        practiceStand: standRef ? "calibrated" : "skipped",
        extensionCheck: verified ? "verified_side_view" : standRef ? "unverifiable_view" : practiceStand === "skip" ? "no_practice_stand" : "no_accepted_reference",
        reference: refRecord ? { id: refRecord.id, t0: refRecord.t0, t1: refRecord.t1, h: r3(refRecord.h), knee: r1(refRecord.knee), hip: r1(refRecord.hip),
          viewRatio: r3(refRecord.viewRatio), shinPx: r1(refRecord.shinPx), sideView: refRecord.sideView, postureWarning: !!refRecord.postureWarning,
          lockGen: refRecord.lockGen, accepted: refRecord.accepted, usedAsReference: refRecord.usedAsReference } : null,
        calibration: { hSit: r3(hSit), stand: standRef ? { h: r3(standRef.h), knee: r1(standRef.knee), hip: r1(standRef.hip), viewRatio: r3(standRef.viewRatio), t0: standRef.t0, t1: standRef.t1 } : null,
          typicalSeatDuringTest: r3(typicalSeat), halfway: expiry.halfway ?? r3(hSit + ((standRef ? standRef.h : P.defaultStandRef) - hSit) / 2) },
        window: { tGo, tEnd, observedMs: obsMs },
        quality: {
          ...q, usableFps: +effFps.toFixed(1),
          missingObservationPct: +missingPct.toFixed(1),
          gapTimeBeyondTolerancePct: +((100 * beyondTolMs) / obsMs).toFixed(1), gapToleranceMs: P.gapToleranceMs,
          longestGapMs: Math.round(longestGap), armsFramesSeen: armsSeen, armsFramesUncrossed: armsUncrossed,
        },
        trace: trace.filter((r) => r.t >= tGo - 3000),
      };
      return result;
    },

    snapshot() {
      const last = trace[trace.length - 1];
      return {
        phase, count: events.filter((e) => e.counted).length, uncertain: events.filter((e) => e.cls === "uncertain").length, state,
        elapsedMs: tGo !== null && last ? Math.max(0, Math.min(last.t, tEnd) - tGo) : 0,
        lastStatus: last ? last.s : null, lastH: last ? last.h : null, lastFrameT,
        readiness: phase === "calibrating" ? readiness() : null,
        participantPose, result,
      };
    },

    get trace() { return trace; },
    get hSit() { return hSit; },
  };
}
