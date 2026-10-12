# Decision oracle v2: notes, ambiguities, spec problems

Fixture: `tests/fixtures/decision_matrix_v2_expected.json` (69 cases).
Written 2026-09-26 from these files only: `docs/CONTRACTS_CP4.md` (v2), `docs/DECISION_RULES.md` (v1, where CP4 does not supersede it) and `sources/cdc/STEADI-Assessment-30Sec-508.txt`. I read no implementation, test, eval or audit file.

## How the cases were built

- Every session uses the exact CP4 §6 input shape: tGo 6000, tEnd 36000, and 8 to 12 events with explicit `n`, `cls`, `counted`, `tRise`, `tFull`, `tExpiry`, `tPeak` and `tSeat`.
- The anchor for each event is `tFull`, then `tExpiry`, then `tPeak`.
- `coverage` is supplied as input. For consistency, it was computed from `imageTimes` using the CP4 §2 bounds:
  - imageTimes is a 150 ms grid from 1500 to 36300 ms, with specific ranges deleted.
  - reference: an image within 150 ms of [t0, t1].
  - event anchor: an image within 250 ms.
  - flag window: [t0-200, t1+200] with no gap over 500 ms.
  - endpoint: an image within 250 ms of GO+30 s.
  - scan: [GO, GO+30 s] with no gap over 1000 ms.
- Each case asserts its coverage precondition. For example, B04 asserts that the flag coverage is not ok while every event is covered and the scan is ok.
- All expectations were written by hand. They were then cross-checked against a small interpretation model. The generator aborts on any mismatch, and all 69 cases agree. The generator is `/tmp/oracle_v2/gen.mjs`, which is outside the repo.
- `mustIncludeBlockerKeywords` are generic lowercase words. They are meant to be matched against the union of all blocker texts (automatic and reference).
- `conflict` is asserted only where the answer is unambiguous: no conflict, or a conflict that is still unresolved.

## Ambiguities (the oracle's reading)

1. **"Identity confirmed for exactly the covered set" (CP4 §3).** The oracle reads this as three conditions:
   - the set of `identityConfirmedFor` equals the set of rises that need identity;
   - that set is every machine rise with `counted` true or `cls` uncertain, plus every partial resolved `full` with coverage;
   - every rise in that set has anchor coverage.

   The "exact" part is not tested with extra entries. C07 depends on including a promoted partial. C06 tests the same range with the automatic basis blocked for another reason.
2. **Observer-added stands and identity.** An added stand has no `n` and uses an image time by construction. The oracle does not require it in `identityConfirmedFor` (C15). C13 and C14 test the range with the automatic basis blocked for another reason.
3. **`sessionScan` after adding a missed stand.** The oracle reads `no_missed` as "no remaining missed stands" (C15) and treats `missed` as a blocker (B12). The contract does not say whether adding stands and answering `no_missed` go together.
4. **R6 against the auto-resolved `uncertain_rises` flag (spec problem).** CP4 §6 counts the auto flags as checked only when every uncertain rise is resolved `full` or `not_full`. Any indeterminacy caused by an uncertain rise (unresolved or `cant_tell`) therefore fails a flag gate, and R6 ("every other condition holds") can never apply to it. R6 is reachable only through counted rises resolved `cant_tell` (C12, G01, G02) or partials resolved `cant_tell` (C09). The oracle follows the literal rule (C05: range 7–8, both ends below average, no category). If R6 is meant to cover uncertain rises, the §6 auto-flag rule needs an exception.
5. **Partial resolved `cant_tell` adds to `max`** (CP4 §3), even though an unresolved partial adds nothing. This follows the text, but it is asymmetric: saying "can't tell" on a partial makes the range *less* determinate than leaving it alone.
6. **Expiry event against the endpoint.** A `cls: 'expiry'` event's anchor is `tExpiry`, which is 30 s, with the same 250 ms tolerance as the endpoint. So a missing endpoint always also removes that event's anchor coverage (B06: both block). The endpoint gate can only be isolated through an `expiry_*` flag without an expiry event (B07). The flag name `expiry_not_counted_under_halfway` is hypothetical; CP4 names only the `expiry_` prefix. Also unspecified: whether an `uncertain` event carrying `tExpiry` (review near halfway) counts as an "expiry event". The model says yes, and no case depends on it.
7. **The `conflict` output after the observer chooses a basis.** It is unclear whether it stays true (a conflict existed) or becomes false (no *unresolved* conflict). It is not asserted in D03 or D04.
8. **Conflict when the automatic range is not determinate (R6) and a valid supervisor count exists (G03).** The oracle treats this as differing, so there is a conflict and no category. A supervisor count inside [min, max] could arguably be read as agreement; this is not tested.
9. **Missing basis-choice rationale.** An empty, absent (D05) or whitespace-only (D06) rationale is treated as no choice. The whitespace case follows the v1 whitespace-reason rule by analogy.
10. **Replay with a supervisor count and choice (D17).** Following the task brief, the value is null and never eligible. CP4 only says the supervisor count is for a "completed 30-s test only"; it does not say that a replay can never supply a value. The automatic value on a replay is not specified, and no case covers it.
11. **Arm-use rule against the basis choice (E02).** `arms == 'yes'` gives 0 even with a supervisor choice and counted rises. This follows v1 R1 ("whatever the reason"); CP4 does not restate the precedence.
12. **Reference posture warning.** It is unclear whether `decide()` derives the flag from `reference.postureWarning` or reads it from `reviewFlags`. The cases supply both, so both readings agree. A case with `postureWarning: true` but no flag in `reviewFlags` is not tested.
13. **Coverage for flags without a time window** is not defined in CP4 §2. Every non-auto flag in the fixture has a window.
14. **Auto flags when there are no uncertain rises** would count as checked vacuously. This is not tested on its own. `no_accepted_reference` (A04) and `no_practice_stand` (A05) are still blocked by the reference gate.
15. **Partial resolved `not_full`** is not an offered action (CP4 §3 table). The oracle would ignore it; this is not tested.
16. **Values when only R7 gates fail.** With `setup` 'no', `arms` 'unsure', age out of range or no column, the value is still reported and only the table comparison is blocked (E04, H07, H09, H11). With R6, eligibility is true while the value is null (C09, C12, G01), following v1 resolution 7.
17. **Leading-zero age "070"** is read as 70, following v1 resolution 10 (H08).
18. **`status: 'withheld'` with reason `expired`.** The automatic basis is unavailable; the supervisor route works with an explicit choice (D19), following v1 resolution 11.
19. **Resolutions on events without coverage** are ignored in both directions: `not_full` does not remove a rise (C11, B01) and `full` does not add one (C02, C08). This follows CP4 §2 ("ignored by decide()").
20. **Observer-added stand times outside [GO, GO+30 s]** are not specified. Every added `t` in the fixture is inside the window.

## Conflicts or tensions with the CDC form

- **The CDC's method is observer counting.** The form says to "Count the number of times the patient comes to a full standing position in 30 seconds." Under CP4, a supervisor count becomes the result only after an explicit choice, and it blocks an agreeing-or-conflicting automatic value until that choice. This is an engineering choice layered on the CDC method, not a CDC rule. D08 (a valid supervisor count without a choice gives no value) is stricter than the paper form.
- **The float guard** (`observedMs >= 29999` counts as 30 s) accepts a test that is up to 1 ms short. This is negligible, but it is not literally "30 seconds".
- **The arm-use rule.** The CDC says "stop the test. Record '0' for the number and score." The zero is compared against the table: 0 is below every threshold (E01). This relies only on the observer's answer, as the paper form does.
- **The CDC table has no rows below 60 or above 94.** The oracle does not extrapolate (H07). The row thresholds used are:

  | Age | Men | Women |
  |---|---|---|
  | 60–64 | 14 | 12 |
  | 65–69 | 12 | 11 |
  | 70–74 | 12 | 10 |
  | 75–79 | 11 | 10 |
  | 80–84 | 10 | 9 |
  | 85–89 | 8 | 8 |
  | 90–94 | 7 | 4 |

  "Below average" means the count is below the threshold.
- **Over-halfway at 30 s** ("count it as a stand"). This is modelled as `cls: 'expiry'`, `counted: true`, which enters `min` (B09, v1 resolution 5). CP4 adds an image requirement for the endpoint that the paper form does not have. That is a stricter evidence gate, not a scoring change.
- **The CDC "full standing position"** is judged by the observer. CP4's reference acceptance and the posture warning are engineering proxies; they are not CDC criteria.
