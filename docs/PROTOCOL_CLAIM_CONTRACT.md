# Protocol / claim contract — SteadyScreen 30-Second Chair Stand assistant (checkpoint 3, amended at checkpoint 4)

> **Checkpoint-4 amendments** (details in `docs/CONTRACTS_CP4.md`):
> - The practice stand must be **accepted by the observer** before it becomes the reference.
> - Every review decision needs **its own image coverage**.
> - Corrections work in both directions, including adding missed stands.
> - The supervisor count is a separate basis, used only by explicit choice; discrepant counts are a conflict.
> - Privacy wording is narrowed (§4).
> - Core `chairstand-core 0.7.0`, decision `decision-2`.

- **Software:** core `chairstand-core 0.6.0` at checkpoint 3 (now `0.8.1`, see `docs/CONTRACTS_CP4.md` §9); decision model `app/src/core/decision.js`, spec in `docs/DECISION_RULES.md`.
- **Sources:** the CDC STEADI forms, read from the PDFs themselves (`sources/cdc/`: extracted text and rendered pages).

Every output falls into exactly one category:
- **M** — measured from camera pose data by a documented rule;
- **R** — computed under a stated rule;
- **O** — entered or confirmed by the observer (never certified by the app);
- **E** — observer judgement made while looking at stored evidence images;
- **U** — not supported.

Rules are also tagged:
- **[CDC]** protocol rule from the form;
- **[ENG]** our engineering or product-safety choice.

## 1. CDC form items and their handling

| CDC 30-Second Chair Stand (verbatim) | Handling | Category |
|---|---|---|
| "Stand next to the patient for safety." | Set-up checkbox. The helper stays beside the participant within reach, and is **never** asked to move away to help the tracking. The helper is tracked as "another person" (§3). | O |
| "A chair with a straight back without arm rests (seat 17" high)" | Observer-confirmed. Seat height is never measured (no metric distance is inferred from pixels). | O |
| Hands crossed at the wrists, arms against the chest | The camera raises a *note* when the arms look uncrossed or can't be seen. It never decides. | M (note) → O |
| "On the word 'Go,' begin timing." | The app gives 3-2-1 tones and GO, and records the GO time on the frame clock. The test can't start unless the participant is seated and still with recent frames. | R |
| "If the patient must use his/her arms to stand, stop the test. Record '0'…" | Observer answer "yes" → completion `protocol_stop_arms`, value 0, whatever the stop reason. | O → R [CDC] |
| "Count the number of times the patient comes to a full standing position in 30 seconds." | Automatic **full / uncertain / partial** classification against the participant's practice stand (§2). Only full stands are counted automatically. Uncertain rises are resolved by the observer **on stored images**, or stay as a range. | M + E |
| "If the patient is over halfway to a standing position when 30 seconds have elapsed, count it as a stand." | **Position rule, no velocity condition.** Near halfway, or descending from a rise that never stood → observer decides. | R [CDC], E near the boundary |
| Below-average table 60–94, men/women | Shown only under every precondition in `DECISION_RULES.md` R7: completed live 30-s test or arm-rule zero; setup = yes; arms answered; age (strict integer) 60–94; column entered; count checked on evidence or the observer's own count. No extrapolation. Demographics are never inferred. | R from O inputs |

## 2. Full stand vs partial rise (M) — exact rules

**Practice stand** [ENG, with precedent]. The Rikli & Jones protocol sheet says to "practice one or two repetitions". Before GO the app needs:
- sitting still;
- one full stand, held still for ≥ 0.6 s;
- sitting still again for ≥ 1 s.

Its median hip height `h`, 2-D knee angle and 2-D hip angle become this participant's **standing reference**. The practice stand can be skipped; then every rise is uncertain.

**View.** The shoulder-width / torso-length ratio at the practice stand must be ≤ 0.55 (about ≤ 40° from side-on). Otherwise knee and hip flexion can't be seen, and every rise is uncertain.

**Full stand** (counted automatically at the first of 2 consecutive smoothed frames, `tFull`): shortfall versus the practice stand is ≤ 0.12 in `h`, ≤ 7° at the knee and ≤ 4° at the hip, all at once.
- **Source of these numbers [DATA]:** the 95th percentile of genuine full stands' shortfall versus the same person's best stand, on 14 clean **development** clips (73 stands).
- **Expected cost:** about 5% of genuine full stands per criterion go to review.

**At the return to sitting**, a rise that never met the full criteria is:
- **partial** (not counted, no review) only with strong evidence: shortfall more than 2× the band in `h`, or more than 2× in *both* knee and hip;
- **uncertain** otherwise (review).

**What the synthetic depth probes give:**

| Rise depth | Result |
|---|---|
| α 0.6 / 0.7 | partial |
| α 0.85 / 0.95 | uncertain |
| Genuine full stands, including a 17° habitual stoop | full |

**Causality.** Everything uses trailing medians. The live count never looks ahead.

## 3. Measurement quality, abstention, identity (M)

**Withheld (no automatic count — not a zero)** when:
- the participant is unseen for any stretch > 0.7 s;
- gap time beyond a 150 ms per-gap tolerance exceeds 20%;
- there are fewer than 8 usable frames/s;
- frames stop for > 0.7 s;
- the tab is hidden, or the camera stops.

**Needs review** when any of these occur:
- any uncertain rise;
- a movement gap of 0.25–0.7 s;
- an overlapping person;
- ≥ 3 identity/landmark jumps;
- the participant is reacquired after being lost while someone else was in view;
- more than 30% of frames lack a usable observation;
- seated-baseline drift;
- the endpoint is not observed;
- a near-halfway or descending expiry;
- an unverifiable view, or no practice stand.

**Reported separately:**
- frames presented / analysed / not analysed (from `presentedFrames`);
- `missingObservationPct` vs `gapTimeBeyondTolerancePct`.

**Identity:**
- Up to 2 poses per frame.
- The participant is locked at the camera check, and the observer can **click to select** them.
- They are then followed by torso-centre continuity; two plausible candidates make the frame ambiguous (not measured).
- **Pose-only limit (not repaired):** a person replacing the participant at the same place and posture, with no visible transition, produces identical input. The core then counts the wrong person.
- **Product gate:** an automatic count is interpreted only after the observer confirms, on the stored images, that the outlined person is the participant in every counted rise. Without images, it is never interpreted.

## 4. Evidence images (E) and privacy

| Claim | Evidence | Status |
|---|---|---|
| Images are opt-in and consented before capture (cp4 wording: "kept by the app only inside this tab while you review; not uploaded or saved to files by the app; released on new test/back/close; the browser itself may hold image data in its own temporary storage") | Setup checkbox with the full privacy text; capture only happens if it was ticked before the source started | Code + browser test (`replay_full_with_evidence`, `replay_without_evidence`) |
| Images are not included in the app's export or report (the app has no upload path) | In-app Blob references; the JSON export contains `evidence.includedInThisFile: false` and no image data | Code inspection + export code |
| Cleanup | `clear()` releases the app's Blob references and revokes object URLs on New test, Back, model/camera errors and `pagehide`. Since cp4, late encoder callbacks from before a clear are discarded (generation check). It does **not** promise forensic erasure. | Code; `back_during_countdown` test (no session left) |
| No network egress | CSP `default-src 'self'`. A 75-s run: MediaPipe's built-in usage logging **attempted 1** POST to `odml.pa.googleapis.com/v1/log`, **blocked by CSP** inside the browser; 0 non-local requests completed. Other runs: 0 non-local requests. | **Measured** in headless Chrome (replay and fake camera). Not measured on other browsers or a deployed site. |
| Camera off at the end | Tracks stopped at test end, Back and errors | Fake-camera tests: `streamLive=false` after the end, after a model failure and after a hidden tab |

## 5. Not supported / not claimed (U)

- Fall-risk probability, diagnosis, treatment advice.
- A complete STEADI assessment.
- TUG and 4-Stage Balance: **not implemented** (see the checkpoint-2 contract in git for their requirements).
- Accuracy or safety in older adults.
- Any time saving or error reduction compared with manual methods.
- Novelty.
- "Open source": the code is **UNLICENSED**, and its source is provided for review only.

## 6. Rights

- **`@mediapipe/tasks-vision` 1.0.1:** Apache-2.0 per its `package.json`; the tarball has no LICENSE file.
- **Pose model:** Apache-2.0 per the model card.
- **Vendored bytes:** pinned in `scripts/vendor.sha256`.
- **CDC material:** public domain, with attribution and non-endorsement.
- **Stanford sit2stand videos:** licence **unknown**. Used locally for engineering tests only, never redistributed. Derived frames, landmarks and screenshots of them are excluded from the ZIP.
