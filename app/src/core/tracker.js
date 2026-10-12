// Keeps measuring the SAME person (the seated participant) when a helper or bystander is visible.
// Rule: follow the pose whose torso centre continues the participant's recent position.
// If two poses are both plausible continuations, the frame is "ambiguous" and not used for measurement.
import { PARAMS } from "./params.js";
import { torsoGeometry, iou } from "./pose_features.js";

export class ParticipantTracker {
  constructor(width, height, params = PARAMS) {
    this.w = width; this.h = height; this.p = params;
    this.centre = null; this.size = null; this.box = null; this.sizes = []; this.lockT = null;
    this.lockGen = 0;                        // increments on every NEW acquisition (a reference is bound to it)
  }

  get locked() { return this.centre !== null; }

  reset() { this.centre = null; this.size = null; this.box = null; this.sizes = []; }
  acquire(geom, t) { this.lockGen += 1; this.lock(geom, t); }

  lock(geom, t = null) {
    this.lockT = t;
    this.centre = geom.centre; this.box = geom.box;
    this.sizes.push(geom.size); if (this.sizes.length > 30) this.sizes.shift();
    const s = [...this.sizes].sort((a, b) => a - b); this.size = s[s.length >> 1];
  }

  /**
   * @param poses array of landmark arrays
   * @param chooseInitial optional fn(candidates) -> index, used only while not yet locked
   * @returns {status: 'ok'|'none'|'lost'|'ambiguous'|'unlocked', pose, geom, others, overlap}
   */
  update(poses, chooseInitial = null, t = null) {
    const geoms = poses.map((lm) => torsoGeometry(lm, this.w, this.h));
    if (!this.locked) {
      if (!poses.length) return { status: "none", pose: null, others: 0, overlap: false };
      const idx = chooseInitial ? chooseInitial(poses, geoms) : (poses.length === 1 ? 0 : -1);
      if (idx < 0) return { status: "unlocked", pose: null, others: poses.length, overlap: false };
      this.acquire(geoms[idx], t);
      return { status: "ok", pose: poses[idx], geom: geoms[idx], others: poses.length - 1, overlap: false };
    }
    const cands = [];
    geoms.forEach((g, i) => {
      if (g.size < this.p.minRelativeSize * this.size) return;   // distant or spurious detection
      cands.push({ i, g, d: Math.hypot(g.centre[0] - this.centre[0], g.centre[1] - this.centre[1]) / this.size });
    });
    if (!cands.length) return { status: poses.length ? "lost" : "none", pose: null, others: poses.length, overlap: false };
    cands.sort((a, b) => a.d - b.d);
    const best = cands[0];
    const dt = t !== null && this.lockT !== null ? Math.max(0, (t - this.lockT) / 1000) : 0;
    const radius = Math.min(this.p.trackJumpCap, this.p.trackMaxJump + this.p.trackJumpPerSec * dt);
    if (best.d > radius) return { status: "lost", pose: null, others: poses.length, overlap: false };
    if (cands.length > 1 && cands[1].d <= radius) {
      return { status: "ambiguous", pose: null, others: poses.length - 1, overlap: true };
    }
    const overlap = geoms.some((g, i) => i !== best.i && iou(g.box, best.g.box) > this.p.overlapIoU);
    this.lock(best.g, t);
    return { status: "ok", pose: poses[best.i], geom: best.g, others: poses.length - 1, overlap };
  }
}
