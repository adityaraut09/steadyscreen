# SteadyScreen

A supervised, checkable version of the CDC 30-Second Chair Stand test that runs in a web browser with a laptop camera. Built for UnivaBio 2026 by Aditya Raut, Neeraj Movva, Sagar Raut and Sathvik Loke.

It is a prototype, not a medical device. It does not diagnose anything or predict falls, and it has not been validated.

**Try it:** https://adityaraut09.github.io/steadyscreen/app/ . With no chair or helper at hand, press "Try the demo" on the first screen. It runs the whole test with a computer-drawn participant in about 2 minutes, and everything in it is labelled SIMULATED DEMO.

One-page summary: [docs/SteadyScreen_one_page.pdf](docs/SteadyScreen_one_page.pdf). Code walkthrough: [docs/WALKTHROUGH.md](docs/WALKTHROUGH.md).

## What it does

A supervising adult sets up a chair and a side-on laptop camera, and the participant does one practice stand. The supervisor confirms from its picture that it was a full stand. The app then gives the "Go", times 30 seconds and counts full stands against that practice stand. Any rise it can't confirm is marked "needs your decision". Afterwards the supervisor can check every counted stand against temporary still images, fix mistakes in either direction, and scan for missed stands. The CDC comparison table is only shown once every check is done, and only for ages 60 to 94.

The pose model (Google's MediaPipe Pose Landmarker) runs in the browser. Video is not uploaded, and the still images are not saved in the downloaded record.

## Running it

Open the hosted version above, or run it yourself:

```bash
python3 -m http.server 8932 --bind 127.0.0.1
```

Then open http://127.0.0.1:8932/app/ in Chrome or Safari. The camera needs either `localhost`/`127.0.0.1` or an HTTPS address.

The model files in `app/vendor/` come from `@mediapipe/tasks-vision` 1.0.1 and the `pose_landmarker_full` model (both Apache-2.0). `scripts/setup_vendor.sh` downloads them again and checks them against `scripts/vendor.sha256`.

## Tests

```bash
npm test
```

This runs 344 tests with Node's built-in test runner; Node 20 or newer is needed. 342 pass. The other 2 are marked as known limitations:
- a different person sitting in the same spot can't be told apart by pose alone;
- an observer who confirms a nearly-full practice stand can't be caught.

## Where things are

- `app/src/core/`: the counting and decision logic, the same code in the browser and in the tests.
- `app/src/ui/`: the screens, camera loop, temporary images and printable summary.
- `docs/`: the rules the app follows, a code walkthrough, and answers to likely judge questions.

The CDC STEADI "Assessment: 30-Second Chair Stand" form is the source for the protocol and the comparison table. The CDC does not endorse this tool.
