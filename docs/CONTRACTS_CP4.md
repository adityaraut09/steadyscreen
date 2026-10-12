# Checkpoint-4 contracts: reference acceptance, evidence coverage, correction and count basis (v2)

Written **before** the code changes (2026-09-26, 21:45 EDT). These contracts supersede the parts of `docs/DECISION_RULES.md` (v1) that they name; unchanged rules R1, R2 and R7–R8 still apply.

Tags:
- **[CDC]** protocol text;
- **[ENG]** our engineering or safety choice;
- **[LIMIT]** a stated operating limitation.

## 1. Reference acceptance (fixes audit A)

A **stable raised posture is not a full-standing reference.** The core still *detects* the practice stand (a stable hold ≥ 0.6 s after sitting). It now marks it as `detected`, and it becomes `accepted` only when the observer confirms it:

| Item | Rule |
|---|---|
| Question shown | "Was this a full stand — standing straight up the way this person normally stands, knees and hips straightened?" Buttons: **Yes, full stand** / **No — repeat the practice stand**. |
| Evidence shown | The kept image nearest the middle of the hold, only if it lies inside the hold interval (±150 ms), with the tracked person outlined. |
| Basis | Two cases: `image` (the confirmation was made with that image on screen), or `observer_watched` (no image kept; the supervisor saw the practice stand directly). |
| Binding | `{refId, lockGen, t0, t1, shinPx, basis}`. **refId** changes whenever a new hold is detected. **lockGen** changes whenever the tracker re-locks (a reselection, or a lost-then-reacquired participant during the camera check). |
| Invalidation | The acceptance is void if: `refId` changes (new hold); `lockGen` changes; the participant's shin length at the seated check differs by > 20% from the reference (the camera or person moved) [ENG]; or the reference is older than 5 minutes at GO [ENG]. Void → a new practice stand and confirmation are needed. |
| Posture warning [DATA] | In a side view, if the reference's 2-D knee angle is < 158° *or* hip angle < 165° (outside the range of genuine standing postures on 14 clean dev clips: knee ≥ 160.3°, hip ≥ 168.4°; the initial 150° guess missed a 30° hip flexion — changed during checkpoint 4), the confirmation shows a warning: "The camera sees bent knees or hips in this image. Confirm only if this is this person's normal full standing." The result carries the review flag `reference_posture_warning`, which must be checked on images before interpretation. This is **not** a universal straightness rule: the reference is still usable. |
| Without acceptance | The camera check cannot proceed to GO, unless the observer chooses **"Count without a reference"**: every rise becomes `uncertain`, the flag is `no_accepted_reference`, and the report says so. |
| Burden | One decision (one click) per session, plus a repeat practice stand only if rejected. |

**Residual [LIMIT]:** an observer who accepts a genuinely incomplete practice stand will get incomplete rises counted as full. The posture warning catches strongly bent references in side view. It cannot catch everything.

## 2. Evidence coverage (fixes audit B)

"Evidence available" is no longer a session boolean. Every decision the observer can make needs **its own** images, checked by `app/src/core/coverage.js` against the actual timestamps of successfully captured images. All limits are [ENG]; capture runs at about 6.7 images/s, i.e. every 150 ms.

| Decision | Required images | Bound |
|---|---|---|
| Practice-stand acceptance (basis `image`) | ≥ 1 image inside the hold `[t0, t1]` | ±150 ms |
| Each rise (full / uncertain / partial / expiry / observer-added) | An **anchor** image near the rise's top (`tFull` → `tExpiry` → `tPeak`) | ≤ 250 ms from the anchor |
| Identity confirmation | Anchor coverage for **every** counted or uncertain rise. The answer is bound to the list of rises shown. | Same as above |
| Review flag with a time window | Images spanning the window from −200 ms to +200 ms, with no gap > 500 ms | Gap ≤ 500 ms |
| Expiry endpoint (any expiry event or `expiry_*` flag) | An image within 250 ms of the 30-s mark | ±250 ms |
| "No stands were missed" (whole-test scan) | Images across [GO, GO+30 s] with no gap > 1,000 ms | Gap ≤ 1,000 ms |
| Adding a missed stand | The chosen image itself (its timestamp becomes the added stand's time) | Exact |

**Effects:**
- Any decision whose coverage is missing is **disabled** in the UI and **ignored** by `decide()`. It appears as "no image within X ms", never as confirmed.
- Coverage is computed once, after the image store has **finalised** (pending captures settled or timed out). Late callbacks after that are discarded.
- Review, JSON and report all use the same coverage object.
- Filmstrips always include the start, anchor and end images when they exist. They show the real timestamps, and a "missing" tile where required coverage is absent.

## 3. Correction in both directions and count basis (fixes audit C)

| Situation | What the observer can do (all need the relevant coverage) |
|---|---|
| Rise labelled **full** or **expiry** | Not a full stand / Can't tell |
| Rise labelled **uncertain** | Full stand / Not a full stand / Can't tell |
| Rise labelled **partial** | **Actually a full stand** / Can't tell |
| A stand the camera **missed** | In the whole-test images, pick the image showing it: "Add a missed full stand at 14.6 s". This creates `{id: "added-1", cls: "observer_added", t}`. |
| Every change | Logged, with undo. Machine events are never modified; human edits are stored separately. |

**Automatic range (replaces R3):**
- `min` counts:
  - counted machine events not resolved `not_full` or `cant_tell`;
  - uncertain or partial events resolved `full`;
  - observer-added stands.
- `max` = `min` + uncertain or partial events that are `cant_tell` or unresolved (partial events count toward `max` only if resolved `cant_tell`) + counted events resolved `cant_tell`.

**Automatic basis eligible (replaces R4).** All of these must hold:
- the reference is accepted with basis `image` and has coverage;
- identity is confirmed for exactly the covered set, and that set includes every counted or uncertain rise;
- every review flag is checked `ok` with coverage;
- the endpoint has coverage if relevant;
- the **whole-test scan** is answered "no missed stands" with coverage;
- the range is determinate (or R6 applies).

**Count basis (replaces R5, with no automatic preference):**
- The supervisor's own count (strict 0–60 integer plus reason, completed 30-s test only) is always recorded **separately**.
- **The result uses the supervisor count only if the observer explicitly chooses "Report my own count"**, with a rationale. No identity answer is needed for this route, and it is never labelled image-verified.
- If the automatic basis is eligible **and** a valid supervisor count exists **and** they differ → **conflict**. No value is reported until the observer chooses a basis (`automatic` or `supervisor`) with a rationale. Neither side is preferred by default.
- If they agree → the automatic value, with "supervisor count agrees" noted.
- R6 range categories apply only to the automatic basis, and only with no unresolved conflict.

Corrections never change completion, never create coverage and never change the machine's own record. The report shows the machine count, the reviewed count and the supervisor count side by side.

## 4. Lifecycle (fixes audit D, E)

- **Evidence store:** each `clear()` increments a generation number. A `toBlob` callback from an older generation is discarded. Images are inserted in timestamp order. `finalize()` stops capture, waits for pending callbacks (up to 1.5 s), then freezes the store. Trimmed or cleared images have their object URLs revoked.
- **Countdown:** it has a token. **Any** `visibilitychange` to hidden during the countdown invalidates the token immediately. Back, New test and errors also invalidate it. A suspended countdown loop that resumes with a stale token does nothing.

## 5. Privacy wording (replaces absolute claims)

"Images are kept by this app only inside this browser tab while you review. The app does not upload them or save them to files, and it releases them when you start a new test, go back, or close the tab. (The browser itself may hold image data in its own temporary storage; the app cannot control that.)"

## 6. Decision input shape v2 (for `decide()`; supersedes the v1 shape in DECISION_RULES.md)

```
session = {
  result: {
    reason, status, window: { tGo, tEnd, observedMs },
    events: [ { n, cls: 'full'|'expiry'|'uncertain'|'partial', counted, tRise, tFull, tExpiry, tPeak, tSeat, flags } ],
    reviewFlags: [...], flagWindows: { flag: [[t0,t1],...] },
    reference: null | { id, t0, t1, accepted: null | { basis: 'image'|'observer_watched' }, postureWarning: bool },
    expiry: { decision: 'none'|'counted_over_halfway'|'review_near_halfway'|'review_descending_attempt'|'not_counted_under_halfway' },
  },
  source: 'camera'|'replay',
  observer: { arms, setup },
  participant: { ageText, column },
  evidence: {
    available: bool,                        // images were kept (opt-in)
    coverage: computeCoverage(result, imageTimes)   // see coverage.js; null if no images
      // { imageTimes:[...], reference:{ok}, events:{[n]:{ok}}, flags:{[flag]:{ok}}, endpoint:{ok}, scan:{ok, gaps} }
    identityConfirmed: true|false|null, identityConfirmedFor: [n,...],   // rises whose images were shown with the question
    eventResolutions: { [n]: 'full'|'not_full'|'cant_tell' },            // any cls (partial may be resolved 'full')
    flagChecks: { [flag]: 'ok'|'problem' },
    sessionScan: 'no_missed'|'missed'|null,   // observer looked through the whole-test images for missed stands
    added: [ { id, t } ],                     // observer-added missed stands at image times
  },
  manual: null | { text, reason },            // supervisor's own count made during the test
  basisChoice: null | { basis: 'automatic'|'supervisor', rationale },
}
```

**Flags resolved by the rises themselves** (no separate check): `uncertain_rises`, `extension_unverifiable_view`, `no_practice_stand`, `no_accepted_reference`, `expiry_without_practice_stand`. They count as checked when every uncertain rise is resolved `full` or `not_full` with coverage. Every other flag needs `flagChecks[flag] == 'ok'` and `coverage.flags[flag].ok`.

**Output additions:** `value`, `basis`, `automatic {min, max, determinate, eligible, blockers}`, `supervisor {valid, value}`, `conflict: bool`, `reference {eligible, blockers, category, ...}`.

Rules not restated here (R1 completion, R2, R6, R7 gates, R8 titles) are unchanged. One correction: completion treats `observedMs >= 29999.5` as 30 s (a 0.5-ms floating-point guard; tightened from 1 ms after the v1 oracle case `expired_short_window` with observedMs 29999), and the core now reports exactly 30000 for expiry.

## 7. Resolutions after the independent v2 oracle (69 cases; `tests/fixtures/DECISION_ORACLE_V2_NOTES.md`)

All 69 pass. The first run found 5 deviations **in the implementation** from this contract; they were fixed in code, and no oracle case was edited:

1. The coverage shape may omit `imageCount`; images exist if `imageTimes` is non-empty.
2. `reference.usedAsReference` is not part of the shape; an accepted reference counts unless it is explicitly `false`.
3. The automatic basis needs an accepted reference with basis `image` (s3); `observer_watched` is not enough.
4. Whether the 30-s endpoint matters is derived from the result (expiry events or `expiry_*` flags), not trusted from the input.
5. The supervisor-count route is not available for a replay: the value is null for a replay with a supervisor choice. A replay's checked automatic count is still shown, but never compared with the CDC table.

Two interpretations were adopted from the oracle:
- An open automatic range plus a valid supervisor count is a **conflict** (no silent range decision).
- A whitespace-only rationale counts as no choice.

The v1 oracle (70 cases) runs through a translator; **7 cases intentionally changed** (supervisor count needs an explicit choice; discrepant counts are a conflict). They are listed with reasons in `tests/decision_matrix.test.mjs`.

## 8. Quiet counting (for independent labelling)

A setup option removes the tone for each counted stand; only the countdown, GO and END tones remain. It exists so that a separate recording can be labelled without hearing the app's count. It was verified in the real app: 0 per-stand tones, 1 GO tone, 2 END tones.


## 9. Overnight amendments (2026-09-27; core 0.8.1; decision-2 with overnight rules)

> **Core 0.8.1 supersedes the 0.8.0 reference rule below.** A second, fresh adversarial pass found two problems (ON-19..ON-22):
> - freezing the reference when the card first appeared could capture a not-yet-straight posture;
> - two 30-s edge cases around perched sits.
>
> **Rules now in force:**
> - **Reference.** One practice stand = one stand, from its first still hold until the participant descends **below
>   halfway** ("ended"). While it continues, the reference keeps the **most extended** still window of that stand. It is
>   offered for confirmation (state `detected`, card shown) only **after it ended**; before that the readiness reason is
>   `practice_stand_in_progress`. `acceptReference` and `freezeReference` refuse a stand that has not ended.
> - **Angle evidence** for "partial" comes only from frames at the top of the rise (within `peakBandH` = 0.02 of its
>   highest hip height).
> - **At 30 s,** a rise after a perched sit is never auto-counted (uncertain, `seat_return_not_confirmed`), and a sitting-down
>   participant cannot produce a "rise in progress".
> - **Added stands and identity (ON-23, decided).** An added stand is itself the observer's judgement on that image
>   ("a full stand by the participant happens here"); the add control says so explicitly. No separate identity answer
>   is required for it, and the reported basis says how many stands were added.
>
> - **Core 0.8.2/0.8.3 additions** (3rd and 4th adversarial passes):
>   - **Joint-angle evidence.**
>     - A smoothed angle needs the current frame plus at least 3 buffered frames.
>     - Top-of-rise evidence for "partial" comes from **raw** frames within 0.03 of the rise's 90th-percentile raw peak, and
>       needs at least 3 such frames.
>     - A full-height frame whose angles are missing neither confirms nor breaks the full-stand run.
>   - **Reference windows.**
>     - A window supplies angles only if at least 50% of its frames (and at least 3) have them.
>     - The reference is the median window among those within 3 deg (knee+hip) of the most extended.
>     - The stand ends after 150 ms below the end level.
>   - **Half-sits.** A dip deeper than 0.25 while standing that comes back up raises `stand_dipped_without_sitting`.
>   - **At 30 s,** a rise that already peaked and is descending below halfway is classified normally, flagged
>     `rise_peaked_before_30s` (review), never forced to "partial".
>
>   - **0.8.4/0.8.5:** a rise that already peaked (dropped more than the full band) and is at or below about halfway at 30 s
>     (and not rising again: raw h not above both halfway and the smoothed h) is
>     classified as "was it a full stand?" (`rise_peaked_before_30s`) **before** the near-halfway test. Its decision
>     `closed_descending_rise` needs no image at the 30-s mark. The complete list of `expiry.decision` values is:
>     `none`, `counted_over_halfway`, `review_near_halfway`, `review_descending_attempt`, `not_counted_under_halfway`,
>     `review_rise_in_progress`, `review_after_unconfirmed_sit`, `closed_descending_rise`.
>
> Where the text below conflicts with these rules, these rules apply.

Each item is tied to an issue in `docs/OVERNIGHT_ISSUES.json` and a regression test.

**Reference (s1).**
- One practice stand is one stand between sits. More still holds before the participant sits back down (to the seated
  level measured before that stand) belong to the same stand and keep its id (ON-14).
- The values refine only until the app **shows the card** (`freezeReference(refId)`) or the observer accepts. After
  that they are frozen, so the accepted reference is the posture shown on the card (ON-09).
- A new stand after sitting down gets a new id, which voids any earlier acceptance (unchanged).
- The images of the hold shown on the card are **pinned** in the evidence store. They survive however long the
  observer waits before GO, within the 5-minute reference age (ON-01).
- Reselecting the participant, or losing them during the camera check, also resets the camera-scale (shin) history
  (ON-13).

**Counting (core 0.8).** A rise may be classed **partial** (not counted, no review) only with *measured* strong evidence:
- If knee and hip angles were never measured, it is not "strong" evidence. The rise is "uncertain", flagged
  `joint_angles_not_measured` (ON-05).
- If the 5-frame smoothing window spans more than 300 ms (below about 13 fps), the rise is "uncertain", flagged
  `frame_rate_too_low_to_rule_out_full_stand` (ON-08).

A "perched" sit also changes counting (ON-06). This is a descent below halfway that never returns to the calibrated
seat level. It ends the current stand; the next rise starts once the hip climbs 0.15 above the lowest point. That rise
is never counted automatically: it is "uncertain", flagged `seat_return_not_confirmed`.

**30-s endpoint (core 0.8, ON-07).** The CDC position rule also looks at the last **raw** hip height. If raw and
smoothed heights fall on different sides of halfway, or the raw height is within the near-halfway band, the rise goes
to review. A rise that the smoothed signal has not registered yet (raw above the rise threshold at 30 s) is handled by
its raw height:
- at or above halfway minus the band: "uncertain" (`expiry_rise_in_progress`);
- otherwise: partial (`expiry_under_halfway`).

**Observer-added stands (s3, ON-02).** An added stand is counted only if all of these hold:
- it is exactly at a kept image;
- it is inside [GO, GO + 30 s];
- it is outside every detected rise's interval [tRise, tSeat | tExpiry | 30 s] (a detected rise is corrected on its own
  card);
- it is at least 1 s from another added stand.

Any added stand that fails is **not counted and blocks interpretation**, with a message telling the observer what to
undo. Previously a stand without an image was silently ignored and the other cases were counted. The UI marks images
inside detected rises, and images within 1 s of an added stand, as not pickable.

**Count-basis choice (s3).**
- The choice stores the counts the observer saw (`at: {automaticMin, automaticMax, supervisor}`). If either count
  changes later, the choice is stale and ignored, and the UI clears it and asks again (ON-03). `decide()` checks
  staleness only when `at` is supplied (the shipping UI always supplies it; pre-overnight oracle cases do not).
- After an explicit "camera count" choice with an open range, the range rule (R6) applies, or the "unresolved" blocker
  is listed. Never "no value and no reason" (ON-11).

**Identity (s3, ON-12).** Identity confirmation is required only when at least one rise needs checking (counted,
uncertain, or promoted to full). With none (a genuine automatic 0), the whole-test missed-stand scan is still required.

**Lifecycle (s4, ON-04).** A new session clears the review-form fields (own count, reason, basis panel).
