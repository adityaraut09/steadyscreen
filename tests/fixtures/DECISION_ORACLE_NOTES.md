# Decision oracle notes

These notes go with `decision_matrix_expected.json`, which has 70 cases. The oracle was written independently. The only sources read were `docs/DECISION_RULES.md` and `sources/cdc/STEADI-Assessment-30Sec-508.txt`. No implementation, eval, or test code was opened.

## How the fixture is organized

- Each case has `id`, `why`, `session` and `expect`. The `session` object uses the exact input shape from the spec.
- `expect` holds `completion`, `value`, `referenceEligible`, `category`, and `mustIncludeBlockerKeywords` when needed. Keywords are lowercase words and should be matched against all blocker text joined together.
- Some cases also carry an extra `expect.automatic = {min, max, determinate}` field. It is only filled in for cases that are `completed_30s` and not withheld. It tests R3 directly, for example that resolutions are ignored when there are no images. A runner can skip this field if it wants to.
- `value` is the number used for scoring. It is null when there is no eligible basis under R1, R4, R5 or R6 (see A2).
- When R6 reports a category from a range, `value` is null. The range itself shows up only in `valueText` and `automatic`.
- Cases whose `why` starts with `AMBIGUOUS:` use the most conservative reading.

## Ambiguities and spec problems

- **A1. Reason `expired` with a short window has no label.** R1 says `completed_30s` needs `observedMs >= 30000`. But the fallback list only maps the reasons `stopped`, `stream_end`, `page_hidden` and `camera_error`. It does not say what to call `expired` with `observedMs < 30000`.
  - Oracle choice: `incomplete`.
  - Case: `expired_short_window`.
- **A2. What `value` means is undefined when R4 fails.** Take a determinate automatic count of 12 with no images, identity not confirmed, or a flag marked problem. Is `value` 12 (shown but not compared) or null?
  - The spec says the automatic value "may be used for the CDC table only if…". That limits the table comparison, not the value itself.
  - Oracle choice: null, with the count visible only in `automatic`.
  - When R4 holds but an R7 gate fails (replay, setup, arms, age, column), the oracle gives `value = 12` with eligible false. The spec should state both behaviors explicitly.
- **A3. A counted `full` event challenged and resolved `cant_tell`.**
  - Read literally, R3 keeps it in `min` because it was not resolved `not_full`. It does not add it to `max` either, since only `uncertain` events widen the range. So the count stays determinate even though the observer said they can't tell.
  - Oracle choice (conservative): move it out of `min` and into `max` only.
  - Case: `challenged_full_resolved_cant_tell`. That case expects 11–12, which straddles the threshold, so not eligible. The literal reading would give 12 and eligible.
- **A4. An `uncertain` event with `counted: true` would be counted twice.** R3 counts every `counted` event that was not resolved `not_full`, then adds `uncertain` events resolved `full`. It also adds unresolved uncertain events to `max`. If any uncertain event is ever `counted: true`, it is counted twice. The spec should say that uncertain events are always `counted: false`, or define the rule by class. No case tests this.
- **A5. `partial` events and the CDC over-halfway rule (conflict with the CDC form).**
  - The CDC form says: "If the patient is over halfway to a standing position when 30 seconds have elapsed, count it as a stand."
  - The spec never mentions this rule. `partial` events (`counted: false`) are in neither `min` nor `max`.
  - If `partial` means a final rise that is over halfway at 30 s, the CDC count is one higher than the spec's `min`. It should at least widen `max`.
  - The oracle follows the spec literally. Case: `partial_event_not_counted`.
- **A6. Which applies first, R5 or R6?** R4 says "Exception: the range rule in R6". R5 says the manual count is used if the automatic basis "is not eligible under R4". So when the range is determinate under R6 and a valid manual count is present, it is unclear which basis wins.
  - Oracle choice: the manual value, because R4's `min == max` is not met. The category is the same either way in the chosen case.
  - Case: `manual_with_range_determinate`.
- **A7. R6 conflicts with the last R7 gate.** R7 requires that "the count used is an integer ≥ 0". R6 reports a range ("min–max") with no single integer count. The oracle treats R6 cases as eligible because R7's first bullet explicitly allows "R4, R5 or R6".
- **A8. No rule for a manual count that disagrees with the camera.** If the automatic count is eligible, a valid manual count is ignored even when it disagrees (case `manual_ignored_when_automatic_eligible`: 12 vs 10). The CDC method is that the observer counts. A disagreement could reasonably block the result or be reported. At minimum, it should be shown.
- **A9. A whitespace-only reason is not clearly "non-empty".** The oracle treats it as invalid. Case: `manual_whitespace_reason`.
- **A10. The regexes accept leading zeros.** `^\d{1,2}$` accepts manual `"07"`, which is 7. `^\d{1,3}$` accepts age `"070"`, which is 70. This is valid per the spec and the oracle accepts both. If that is not intended, the spec should say so.
- **A11. `status` versus `reason` consistency is undefined.**
  - Unclear combinations include `status: 'incomplete'` or `'stopped'` together with `reason: 'expired'` and 30000 ms.
  - Unclear too: whether `needs_review` with an empty `reviewFlags` list is fine.
  - The oracle treats `needs_review` as not a gate by itself. Only `reviewFlags` and `flagChecks` matter.
- **A12. Event-level `flags` are never used.** R4 checks only session `reviewFlags`. Flags on individual events (`events[].flags`) do not need an observer check. That may be intended, but it should be stated.
- **A13. `practiceStand` is never used.** No rule uses it. The oracle treats `skipped` as non-blocking. Case: `practice_stand_skipped`.
- **A14. Stale evidence fields.** When `evidence.available` is false, the spec says to ignore resolutions. It says nothing about `identityConfirmed: true` or `flagChecks` in that situation. R4 fails anyway because images are unavailable, so the outcome does not change. Still, identity and flag checks cannot be valid without images, and the spec should say so.
- **A15. What `automatic` should be for other outcomes.** For non-completed and `protocol_stop_arms` sessions, R3 does not apply. The output shape does not say whether `automatic` is null there. R5 says "the automatic range is still reported alongside". That conflicts with R3, which does not apply when the measurement is withheld. The oracle does not assert `automatic` for withheld, non-completed or arm-use sessions.
- **A16. The protocol zero rests on the observer answer alone.** `arms == 'yes'` gives 0, and it is eligible with no evidence, whatever the reason, including `camera_error` a few seconds in. This matches the CDC text, but note that one checkbox answer produces a "below average" result.
- **A17. A manual count on a replay has no meaning.** "Supervisor's own count … DURING the timed test" does not apply to a replay. R7 blocks replays anyway, so the result is unaffected.
- **A18. Blocker wording is not specified.** R8 only says "plain language". The oracle keywords (`30`, `replay`, `setup`, `arm`, `age`, `evidence`, `identity`) assume those words appear. For example, the evidence blocker may say "images" instead of "evidence". Adjust the keywords, or fix the wording in the spec.

## Checks against the CDC form

- The CDC thresholds in the fixture come from the CDC text. Its rows show 60-64 <14 <12 … 90-94 <7 <4, and the header "AGE MEN WOMEN" comes after the rows in the extracted text. The oracle assumes the first number is men and the second is women.
- The spec's strict "<" and its 60–94 range with no extrapolation both match the form.
- The form has separate "Number" and "Score" fields ("Record '0' for the number and score"). The spec folds both into `value`, which matches for the arm-use zero.
- The only real conflict between the spec and the CDC form found is A5, the over-halfway final stand.
