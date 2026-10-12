# SteadyScreen: architecture, stack and features (submission draft; NOT submitted)

Status 2026-10-12: tested with synthetic data, replayed development clips, Chrome's simulated camera, a simulated-participant demo mode, and one real laptop-camera session at home (Safari, October 5). Not validated, and not tried with older adults.

## One-paragraph architecture
Everything runs in one browser tab. The camera feeds `requestVideoFrameCallback` frames to MediaPipe Pose Landmarker, vendored and served from the same origin. Each frame's landmarks go to a **causal measurement core** (`app/src/core/chair_stand.js`: plain JavaScript, no look-ahead), the same code that runs in Node for the tests. The core tracks the participant, measures hip height and knee and hip angles, and classifies each rise against the participant's own **observer-confirmed practice stand** as full, uncertain or partial. It then applies the CDC over-halfway rule at 30 s. Optional **temporary still images** are captured about 6 times per second into an in-memory store (`evidence.js`). After GO+30 s, `coverage.js` computes which review decisions actually have images behind them. A single pure function, `decision.js` `decide()`, then turns the core result, the observer's answers and the coverage into the reported value and the CDC-table eligibility. The review screen, the printable summary and the JSON export all call that same function.

```
camera ──► MediaPipe Pose (in-page, GPU/CPU) ──► core 0.8 (tracking · reference · full/uncertain/partial · 30-s rule)
   │                                                          │ result + events + flags
   └──► temporary stills (opt-in, in-tab only) ──► coverage.js (per-decision image coverage)
                                                              ▼
observer review (identity · each rise · missed-stand scan · flags · arms · setup · own count)
                                                              ▼
                        decide(): value · basis · blockers · CDC category (only if every gate holds)
                                  ├─► review screen   ├─► printable summary   └─► JSON record (no images)
```

## Technical stack (exact)
- Browser: Chrome/Edge with `getUserMedia` and `requestVideoFrameCallback`. Tested: Chrome 153, macOS, headless.
- `@mediapipe/tasks-vision` 1.0.1 (Apache-2.0) and `pose_landmarker_full.task` float16, both hash-pinned in `scripts/vendor.sha256`.
- Plain ES modules, no framework, no build step. A strict Content-Security-Policy (`default-src 'self'`) blocks all third-party requests, including the library's built-in usage logging.
- Tests: Node 24 `node:test`, with 344 tests (342 pass, 2 known limitations marked to-do) including two independent decision oracles. Browser journeys use puppeteer-core 25.12 with the system Chrome and isolated temporary profiles.
- Python tools (optional; evaluation only): mediapipe 0.10.35 and OpenCV, for landmark extraction from development clips.

## Defensible feature list (what exists and is tested today)
1. **Guided setup** for the CDC form's safety items: helper beside the participant, chair with no arm rests, side-on camera, and consent. The CDC patient instructions appear on the camera-check screen.
2. **Practice stand confirmed by the observer** from its image. It becomes that person's full-standing reference. Its values are frozen when shown and its image is kept until review. A posture warning appears if it looks bent.
3. **GO cue and 30-s timing** on the video frame clock. The countdown is cancelled if the tab is hidden.
4. **Causal counting** of full stands against the reference. Doubtful rises are held as "uncertain" and are never guessed. Examples: angles not seen, perched sits, low frame rate, near halfway at 30 s.
5. **The CDC 30-second rule**, applied by position ("over halfway up at 30 s"). Borderline cases go to the observer.
6. **Abstention:** no automatic count when tracking is lost for more than 0.7 s, the frame rate is too low, the tab is hidden or the camera stops.
7. **Evidence-gated review.** Every check is enabled only where images actually cover it:
   - the reference;
   - each rise's top;
   - flagged periods;
   - the 30-s mark;
   - the whole test, scanned for missed stands.
8. **Corrections in both directions,** with undo and an audit trail:
   - reject a counted rise;
   - accept a rise the camera doubted;
   - add a missed stand from its image, with guards against double-adding.
9. **The supervisor's own count** is kept separately. It becomes the result only by an explicit choice with a reason. If the two counts disagree, nothing is reported until the observer chooses, and a choice goes stale when either count changes.
10. **CDC table category** (ages 60–94, men/women columns, observer-entered) only when every gate holds. Otherwise the app lists exactly what is still needed.
11. **Printable summary and JSON record.** Neither contains any image. The review screen, the summary and the JSON record share one decision object.

## Not implemented / not claimed
TUG and the 4-Stage Balance test; any fall-risk probability or diagnosis; accuracy or time benefit over manual counting; validation in any population; open-source licence (the code is UNLICENSED, provided for review).
