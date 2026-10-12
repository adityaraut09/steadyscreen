# Code walkthrough prep

UnivaBio says teams must understand their code and be ready to walk judges through it. This page is for practising that. Each teammate should be able to explain at least one file below without notes.

## Life of one rise

1. **Camera frame to body points.** `app/src/ui/engine.js` passes each video frame to MediaPipe Pose Landmarker, a pretrained Google model running in the browser. It returns 33 body points per person. This is the only machine-learning part, and we did not train it.
2. **Which person.** `app/src/core/tracker.js` follows the participant from frame to frame. It ignores people much smaller than the participant and marks frames where someone else overlaps them.
3. **Measurements.** `app/src/core/pose_features.js` turns the points into hip height `h = (knee_y - hip_y) / shin length`, plus the knee angle and hip angle. A frame is unusable if the hip, knee or ankle is unclear (visibility below 0.5).
4. **Counting rules.** `app/src/core/chair_stand.js` does the counting.
   - Before GO: the person sits still for 1 s (seated level), then does a practice stand. The supervisor accepts it from its picture, and it becomes the reference for "full".
   - During the 30 s: a rise starts when `h` goes 0.25 above the seated level. At the top it is compared with the reference:
     - **full:** knee within 7°, hip within 4° and `h` within 0.12 of the reference;
     - **partial (not counted):** clearly short, more than twice those margins;
     - **uncertain:** anything in between. It goes to "needs your decision".
   - At 30 s: the CDC rule counts a rise that is over halfway up. If it is close to halfway, the app asks.
5. **Pictures.** `app/src/ui/evidence.js` keeps still images around each rise, in the browser tab only.
6. **Is there a picture for it?** `app/src/core/coverage.js` checks that each rise has an image near its top, so a decision is never made without one.
7. **Can we report a number?** `app/src/core/decision.js` reports a count only when every check is done:
   - reference accepted;
   - every uncertain rise decided;
   - the person confirmed in the images;
   - the whole test scanned for missed stands;
   - the supervisor's own count matches, or a basis was chosen with a reason.

   The CDC table is shown only for ages 60 to 94.
8. **Summary.** `app/src/ui/report.js` builds the result page and the downloadable record. The record contains no images.

All thresholds are in `app/src/core/params.js`, each tagged `[CDC]` (from the form), `[DATA]` (measured on development clips) or `[ENG]` (our guess, to be checked with real recordings).

## Likely questions, with honest answers

**Where is the AI?** The pose model finds the body points. Everything after that is rules we wrote and can explain. We also used AI coding assistants while building and reviewing the code, which the hackathon allows. Be ready to explain any part of the code yourself.

**How do you know 8 is right?** We don't. On the second try we didn't keep our own count. On the first try our count (8) was higher than anything the camera found (3 to 7), and we didn't finish the review. That is why the app reported nothing.

**Which numbers decide "uncertain"?** `fullKneeDeg` 7, `fullHipDeg` 4 and `fullH` 0.12 in `params.js`. They come from the 95th percentile of genuine full stands in 14 development clips, so about 5% of real full stands per measure go to review by design.

**Why still images, not a video?** A video would also let someone check the count. Still images let the supervisor look at each stand in a few seconds, and they are never saved. We have not measured whether that is faster than watching a video.

**Why only 8 stands in 30 s?** That was the participant's pace on the day. The app needs at least about 0.35 s per rise. We haven't tested fast stands with a real camera.

**What happens if someone walks into the frame?** The tracker follows the participant. If another person overlaps them, or the tracked person jumps, those frames are not measured and the affected rises go to review. Someone who looks the same and sits in the same place can't be told apart by pose, which is why the supervisor confirms the person in the images.

**Is it a medical device?** No. It has not been validated and doesn't diagnose or predict falls.

## Splitting the files

| File | Lines | What to be able to explain |
|---|---|---|
| `core/chair_stand.js` | 629 | Seated level, practice stand, full/uncertain/partial, the 30-s rule |
| `core/decision.js` + `core/coverage.js` | 282 | When a number is reported, and why not otherwise |
| `ui/evidence.js` + `ui/report.js` | 198 | Which images are kept and what the record contains |
| `ui/app.js` + `ui/engine.js` | 787 | Screens, camera, the pose model, the review screen |
| `core/params.js` + `core/pose_features.js` + `core/tracker.js` | 272 | Thresholds and where they come from; hip height and angles; following one person |
