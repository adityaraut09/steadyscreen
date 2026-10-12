# Decision rules (checkpoint 3): session → completion, value, CDC-table eligibility

> **Superseded in part (read first).** R4, R5 and resolutions 6 and 8 below describe the checkpoint-3 model, in which the
> supervisor's own count could become the result automatically. Since checkpoint 4 (`docs/CONTRACTS_CP4.md` §3, decision-2)
> the supervisor count is used **only by an explicit choice with a reason**, and a disagreement with a usable camera count
> **blocks** the result until the observer chooses. Overnight amendments (added-stand validity, choice staleness, open-range
> choice, zero-count identity) are in `docs/CONTRACTS_CP4.md` §9. This file is kept unchanged below as the spec the
> checkpoint-3 oracle was derived from.

This spec is written **before** `app/src/core/decision.js`. Tests derive expected outcomes from this file plus the CDC form (`sources/cdc/STEADI-Assessment-30Sec-508.txt`), not from the implementation.

Tags on each rule:
- **CDC**: the rule comes from the CDC form.
- **ENG**: an engineering or product-safety choice made for this prototype.

## Inputs (plain object)

```
session = {
  result: {                       // from the measurement core's finish()
    reason: 'expired' | 'stopped' | 'stream_end' | 'page_hidden' | 'camera_error',
    status: 'measured' | 'needs_review' | 'withheld' | 'incomplete' | 'stopped',
    window: { observedMs },       // ms observed after Go (30000 when the window ran to expiry)
    events: [ { n, cls: 'full'|'uncertain'|'partial', counted: bool, flags: [...] } ],
    reviewFlags: [ ... ],         // session-level measurement flags needing review
    practiceStand: 'calibrated' | 'skipped',
  },
  source: 'camera' | 'replay',
  observer: { arms: 'no'|'yes'|'unsure'|null, setup: 'yes'|'no'|null },
  evidence: {
    available: bool,              // temporary still images were kept (opt-in)
    identityConfirmed: true|false|null,        // observer: highlighted person = participant in the counted-stand images
    eventResolutions: { [n]: 'full'|'not_full'|'cant_tell' },  // for uncertain events and for challenged full events
    flagChecks: { [flag]: 'ok'|'problem' },    // observer looked at the frames for each session review flag
  },
  manual: null | { text: '12', reason: '...' },    // supervisor's own count made DURING the timed test
  participant: { ageText: '70', column: 'men'|'women'|'' },
}
```

## Rules

**R1 — Completion** (CDC: "Repeat this for 30 seconds").
- `completed_30s` requires `reason == 'expired'` and `observedMs >= 30000`.
- Otherwise the session is `stopped_early` (reason `stopped`), `incomplete` (reason `stream_end`) or `interrupted` (reason `page_hidden` / `camera_error`).
- **Arm-use override (CDC).** "If the patient must use his/her arms to stand, stop the test. Record '0'." When the observer answers `arms == 'yes'`, completion is `protocol_stop_arms` whatever the reason (stopped, expired or other). The value is 0, basis "CDC arm-use rule (observer answer)".

**R2 — No score for an unfinished test** (ENG, following CDC R1).
- For `stopped_early`, `incomplete` or `interrupted`, the value is `null`.
- A manual number and event resolutions are ignored for scoring.
- The report must say "not a completed 30-second test".

**R3 — Automatic count range** (ENG). Applies only to `completed_30s` when the measurement is not withheld.
- `min` = the number of events with `counted == true` that were not resolved `not_full`, plus the number of `uncertain` events resolved `full`.
- `max` = `min` plus the number of `uncertain` events that are unresolved or `cant_tell`.
- The automatic value is determinate only if `min == max`.

**R4 — Evidence needed to interpret an automatic count** (ENG). The automatic value may be used for the CDC table only if **all** of these hold:
- `evidence.available == true`;
- `identityConfirmed == true`;
- every session review flag has `flagChecks[flag] == 'ok'`;
- `min == max`.

Exception: the range rule in R6. A resolution of `full` or `not_full` counts only when `evidence.available` is true. Without images, resolutions are ignored and uncertain events stay unresolved.

**R5 — Manual count** (CDC method: the observer counts; ENG provenance).
- Allowed only for `completed_30s`. It must be a strict integer string `^\d{1,2}$` in 0–60, with a non-empty reason. Anything else is invalid and yields no value.
- It is used as the value only if the automatic measurement was `withheld`, or if the automatic basis is not eligible under R4 **and** the observer supplied the manual count.
- The basis is "Supervisor's own count during a completed 30-s timed test (camera count not used)".
- The automatic range is still reported alongside.

**R6 — Range-determinate category** (ENG). If the automatic range is not determinate but *both* `min` and `max` fall in the same CDC category for the entered age and column, and every other R4 condition holds, the category may be reported. The value is shown as "min–max".

**R7 — CDC table eligibility** (CDC table plus ENG gates). Every one of these is required:
- completion is `completed_30s` (with an eligible value per R4, R5 or R6), or `protocol_stop_arms`;
- `source == 'camera'` (replays are never compared);
- `observer.setup == 'yes'`;
- `observer.arms` is `'no'` (for `completed_30s`) or `'yes'` (for the protocol zero). `unsure` or null blocks it;
- age is a strict integer string `^\d{1,3}$` from 60 to 94 inclusive (CDC table rows 60–64 … 90–94). No extrapolation;
- column is `men` or `women`;
- the count used is an integer ≥ 0.

Category: `below_average` if count < threshold(age, column); else `not_below_average`. The CDC wording to quote: "A below average score indicates a risk for falls."

**R8 — Wording** (ENG).
- Every blocker is listed in plain language.
- The report title states completion: "30-Second Chair Stand — result" only for `completed_30s` and `protocol_stop_arms`. Otherwise it reads "Chair-stand session — NOT a completed 30-second test".

## Output

```
{ completion, value: number|null, valueText, basis, automatic: {min, max, determinate} | null,
  manualValid: bool, reference: { eligible, blockers:[...], category?, threshold?, band? } }
```

## Resolutions after the independent oracle review (2026-09-26)

The oracle agent (`tests/fixtures/DECISION_ORACLE_NOTES.md`) found 18 ambiguities. `decision.js` resolves them as follows. All 70 oracle cases pass without changing the oracle.

1. `expired` with `observedMs < 30000` → completion `incomplete`.
2. When R4 fails, `value` is null. The automatic range is still reported, as `valueText` "min–max (unresolved)" or "n (unchecked)".
3. A counted full event resolved `cant_tell` becomes uncertain: it leaves `min` but stays in `max`.
4. `uncertain` events are never `counted` (the core guarantees this).
5. **CDC expiry stand:** the core emits an event with `cls: 'expiry', counted: true` when the attempt is over halfway at 30 s. It enters `min`, like a full stand. Near-halfway or descending cases are `uncertain`.
6. If R4 fails and a valid manual count exists, the manual count is used (even if R6 could decide a category).
7. R6 needs both ends of the range to give the same category. The value stays null and the text is "min–max".
8. A manual count that disagrees with an eligible automatic count is ignored, and both are shown in the report. *(Kept as specified. Future improvement: block when they disagree.)*
9. A whitespace-only reason is invalid.
10. Leading zeros are accepted: "07" = 7, "070" = 70.
11. `status == 'withheld'` plus `reason == 'expired'` means completed but not measured, so only the manual route is available.
12. Per-event flags reach the observer through session `reviewFlags`, which the core raises for every event flag that needs review.
13. `practiceStand == 'skipped'` is not a separate gate. The core raises `no_practice_stand` as a review flag, so R4 requires it to be checked.
14. Identity and flag checks without images are ignored, because R4 requires images first.
15. `automatic` is null for withheld, unfinished and arm-use sessions.
16. The arm-use zero relies on the observer's answer, exactly as the CDC form does.
17. A manual count on a replay can never be eligible (replay gate).
18. Blocker wording contains the keywords the oracle checks.
