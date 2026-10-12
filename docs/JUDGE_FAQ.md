# Judge FAQ and likely technical questions

Updated 2026-10-12.

**Q: Isn't this just MediaPipe with a counter on top?**
The pose model is off the shelf, and pose-based repetition counting is ordinary. Browser counters and a validated iPad app already exist (for example a University of Alberta iPad app, ICC 0.93 against an exercise physiologist, PLOS Digital Health 2026). The work here is what happens around the count:
- the participant's own confirmed full stand is the standard for "full";
- doubtful rises are held as uncertain instead of guessed;
- the CDC halfway rule is applied at 30 s;
- a gate refuses to interpret any count whose evidence is missing;
- the supervisor can correct errors in both directions from temporary images, without keeping a video.

**Q: How accurate is it?**
Not established for real people. On development landmark data (public 5×sit-to-stand clips with AI-made labels), every rise is sent to review, and the candidate counts match the labels on 15/15 scored development clips and 17/18 on a second set. That set can no longer be called a holdout: it was used during development. None of this is validation. With a real laptop camera (one session at home, October 5, Safari, a team member as participant): on the first try the head and shoulders left the frame, the app was sure of 3 stands and asked about 4 more (3 to 7), our own count was 8, and the app reported no number. On the second try, with the whole body in view, it found 8 full stands with no doubtful rises; we kept no separate count of that run.

**Q: Why not just report the number the camera counts?**
A camera count can be silently wrong in ways pose data alone cannot reveal, for example a different person at the same spot, or a bent "full" stand. A number shown with a CDC category looks authoritative. So the app shows the category only after the evidence behind each counted rise has been checked, and otherwise says exactly what is missing.

**Q: Why is the observer's own count kept separately?**
The CDC form is designed for a human counting. When the two counts disagree, silently picking one hides the disagreement. The app shows both and requires an explicit choice with a reason. If the counts later change, the choice has to be made again.

**Q: What is the "practice stand"?**
One stand before GO. The observer confirms it from its image as this person's full standing posture. The CDC form does not include it; practice repetitions are suggested in the original Rikli & Jones protocol. It makes "full stand" personal: a person with a habitual stoop is not penalised, and a shallow rise is not counted.

**Q: What happens at exactly 30 seconds?**
The CDC rule counts a rise that is over halfway up at 30 s. The app decides by position. It sends the case to the observer when the person is near halfway, when the smoothed and raw hip heights disagree, or when a rise has just started.

**Q: Privacy?**
- Video is analysed in the tab. The CSP blocks every third-party request, including one usage-log request that the MediaPipe library itself attempts (measured: 1 attempt blocked, 0 completed).
- Still images are opt-in, kept only in memory in that tab, never in the downloaded record, and released at New test, Back or when the tab closes.
- The app cannot control the browser's own internal caching, and it says so.

**Q: Who is it for?**
A supervising adult (a trained volunteer, fitness professional or clinician) who runs the CDC 30-Second Chair Stand and wants the timing and counting done without taking their eyes off the participant, plus a checkable record. It is **not** for unsupervised self-testing: CDC requires a helper beside the participant.

**Q: Would it actually help anyone?**
Unknown. A fair comparison against "record a video and count it afterwards" has not been run, and it has not been tried with older adults.

**Q: What did you test?**
- 344 automated tests (342 pass; 2 are known limitations marked to-do), including:
  - two independent decision oracles written from the specification;
  - regression tests for every audit finding, each shown to fail before its fix.
- Adversarial reviews by independent AI reviewers across several checkpoints.
- 26 real-browser journeys: replayed video, Chrome's simulated camera and the simulated-participant demo.
- One real-camera session at home (see "How accurate is it?").

**Q: What are the known limitations?**
- A person swapping in at the same spot with no visible transition cannot be detected from pose. Only the image review can catch it.
- An observer who confirms a nearly-full practice stand, or confirms everything carelessly, can still get a wrong result.
- Everything depends on side-on camera placement.
- The review burden (5+ decisions and a scan of about 60 thumbnails) has not been measured.
- All labels so far are AI-made.

**Q: Can I try it without a chair or a camera?**
Yes. "Try the demo" on the first screen runs the whole test with a computer-drawn participant. It is labelled SIMULATED DEMO on every screen, image and record, and it measures no one.

**Q: Why no TUG or balance test?**
Checkpoint 2 dropped them to do one test properly. The earlier plan for them is in git history.
