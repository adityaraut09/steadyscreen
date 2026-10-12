// All tunable thresholds for the chair-stand core, in one place.
// History: 0.5.0 frozen for holdout-2 (tag core-freeze-v0.5.0); 0.5.1/0.5.2 post-hoc review guards;
// 0.6.0 (checkpoint 3) = audit repairs: practice-stand calibration, full-vs-partial classification, CDC position
// rule at expiry, readiness continuity, honest quality accounting, status computed after all event flags.
// Provenance tags: [CDC] official form; [DATA] measured on the 14 clean DEVELOPMENT clips (not a holdout);
// [ENG] engineering assumption, to be revisited with real 30-s recordings.
export const CORE_VERSION = "chairstand-core 0.8.5";

export const PARAMS = Object.freeze({
  // --- protocol ---
  windowMs: 30000,               // [CDC] "Repeat this for 30 seconds"; timing starts on "Go"

  // --- landmark validity ---
  minVisibility: 0.5,            // [ENG] hip, knee, ankle (and shoulder for the hip angle) visibility needed
  shinJumpTolerance: 0.35,       // [ENG] side rejected if shin length deviates >35% from the running reference
  hPlausibleMin: -0.4,           // [ENG] h = (knee_y - hip_y) / shin_length; outside this range = landmark swap
  hPlausibleMax: 1.9,
  smoothFrames: 5,               // [ENG] causal trailing median over the last N usable frames (no look-ahead)

  // --- readiness: seated calibration (continuous, recent observations) ---
  calibrationMs: 1000,           // [ENG] seated and still for 1 s before "Go"
  calibrationMaxSpread: 0.15,    // [ENG] max (p90 - p10) of h while "still"
  seatedMaxH: 0.85,              // [ENG] calibration h must be below this to count as seated
  readinessMaxGapMs: 250,        // [ENG] no gap between usable frames above this inside a readiness window (audit G)
  readinessMinUsableFrac: 0.85,  // [ENG] >= 85% of frames in the window must be usable (one dropped frame is tolerated)
  maxStartStaleMs: 300,          // [ENG] start() refused if the last frame is older than this at "Go" (audit G)

  // --- practice stand = per-person standing reference (audit A) ---
  // [precedent] Rikli & Jones protocol sheet: "practice one or two repetitions to ensure proper form".
  standHoldMs: 600,              // [ENG] a practice stand must be held still at least this long
  standHoldMinRise: 0.40,        // [ENG] ... with h at least this far above the seated level
  standHoldMaxSpreadH: 0.10,     // [ENG] stillness during the hold
  standHoldMaxSpreadDeg: 8,      // [ENG]
  sideViewMaxShoulderRatio: 0.55, // [ENG] shoulder width / torso length at the practice stand; above this the camera is
                                 //       too frontal (> ~40 deg off side) for knee/hip angles to show flexion -> unverifiable
  // --- reference acceptance (checkpoint 4; docs/CONTRACTS_CP4.md s1) ---
  // [DATA] posture warning when the accepted reference lies OUTSIDE the range of genuine standing postures observed in the
  // 14 clean development clips (per-clip standing-plateau medians: knee min 160.3 deg, hip min 168.4 deg). A warning is
  // not a rejection: it adds a review item that must be checked on the reference image. (cp4: 150 deg for both was an
  // unanchored first guess and missed a 30-deg hip flexion reference in the audit adapter.)
  referenceWarnKneeDeg: 158,
  referenceWarnHipDeg: 165,
  referenceMaxAgeMs: 300000,     // [ENG] an accepted reference older than 5 min at GO is stale
  referenceMaxShinChange: 0.20,  // [ENG] seated shin length vs reference shin length > 20% -> camera/person changed

  // --- full stand vs partial rise, relative to the participant's own practice stand ---
  // [DATA] 95th percentile of genuine full stands' shortfall vs the same person's best stand, 14 clean dev clips
  // (73 labelled full stands): knee 7.0 deg, hip 3.8 deg, h 0.12. By construction ~5% of genuine full stands per
  // criterion fall into "uncertain" (review), which is the price of not certifying incomplete rises.
  fullKneeDeg: 7,
  fullHipDeg: 4,
  fullH: 0.12,
  // A rise is silently "partial" (not counted, no review) only with strong evidence: shortfall beyond TWICE the band
  // in hip height, or beyond twice the band in BOTH knee and hip. Everything between is "uncertain" -> review.
  partialFactor: 2,
  standConfirmFrames: 2,         // [ENG] consecutive (smoothed) frames meeting the full-stand criteria
  // Fallback when extension cannot be verified (no practice stand / frontal view): old hip-height candidate rule;
  // such events are never counted automatically - they are "uncertain" and need review.
  standAbsMin: 0.85,
  standRiseMin: 0.30,
  seatReturnRise: 0.20,          // [ENG] back to seated when h <= hSit + this (hysteresis)
  partialRiseMin: 0.25,          // [ENG] a movement that exceeds hSit + this is a rise attempt
  perchRiseMin: 0.15,            // [ENG] 0.8 (ON-06): after a "perched" sit (descent below halfway that never reached the seat level), a rise of this much starts a new attempt (never auto-counted)
  minAngleFrames: 3,             // [ENG] 0.8.2 (ON-26): a smoothed joint angle needs this many of the smoothFrames buffered frames (and the current frame)
  refMinAngleFrac: 0.5,          // [ENG] 0.8.2/0.8.3 (ON-27/33): a practice-stand window supplies joint angles only if this fraction of its frames (and >= minAngleFrames) has them
  refTopBandDeg: 3,              // [ENG] 0.8.3 (ON-32): reference = median window among those within this (knee+hip, deg) of the most extended
  standEndMs: 150,               // [ENG] 0.8.2 (ON-28): the practice stand has ended after this long below its end level
  dipFlagH: 0.25,                // [ENG] 0.8.2 (ON-29): while standing, a dip deeper than this below the stand's peak that comes back up is flagged
  peakBandH: 0.03,               // [ENG] 0.8.1/0.8.2 (ON-20/26): raw frames within this of a rise's (90th-percentile) highest raw h count as "at the top" for angle evidence
  maxPartialSmoothSpanMs: 300,   // [ENG] 0.8 (ON-08): a rise may be classed "partial" (not counted, no review) only if the smoothing window spans <= this (fps >= ~13)
  defaultStandRef: 1.10,         // [ENG] standing h used for the halfway point only if no practice stand (-> review)

  // --- 30-s expiry: CDC position rule ---
  // [CDC] "If the patient is over halfway to a standing position when 30 seconds have elapsed, count it as a stand."
  // Halfway = midpoint in hip height between the seated calibration and the practice stand [ENG interpretation].
  // No velocity condition (removed in 0.6.0, audit D). Near the midpoint, or on the way down without ever having
  // stood, the decision is left to the observer (review).
  expiryNearHalfBand: 0.08,      // [ENG] |h - halfway| within this -> review

  // --- identity / multiple people ---
  trackMaxJump: 0.6,             // [ENG] participant torso centre may move <= 0.6 torso lengths between usable frames
  trackJumpPerSec: 1.5,          // [ENG] ... plus 1.5 torso lengths per second since the last lock
  trackJumpCap: 1.5,             // [ENG] capped; two candidates inside the radius -> ambiguous frame (not measured)
  minRelativeSize: 0.5,          // [ENG] poses < 50% of the participant's torso size are ignored
  overlapIoU: 0.25,              // [ENG] another person's box overlapping the participant's box -> overlap frame
  jumpBase: 0.3,                 // [ENG] raw h may change by at most jumpBase + jumpPerSec * dt between usable frames
  jumpPerSec: 4.0,               //       (a real rise takes >= ~0.35 s); larger jumps = identity/landmark discontinuity
  otherPersonRecentMs: 2000,     // [ENG] a lost-then-found participant with someone else in view within this -> review

  // --- measurement quality ---
  maxGapMs: 700,                 // [ENG] any stretch without a usable participant frame longer than this -> withheld
  maxUnusableFraction: 0.2,      // [ENG] > 20% of the window in gaps beyond the per-gap tolerance -> withheld
  gapToleranceMs: 150,           // [ENG] per-gap allowance used for the line above (reported separately, audit H)
  intermittentMissingPct: 30,    // [ENG] > 30% of frames without a usable participant observation -> review
  minEffectiveFps: 8,            // [ENG] usable frames per second over the window
  reviewGapMs: 250,              // [ENG] shorter gaps are tolerated; longer ones during movement -> review
  movementGapRise: 0.20,

  // --- arms (observer-confirmed; the app only raises a note) ---
  armsFarFactor: 0.9,
  armsFlagFraction: 0.3,
});
