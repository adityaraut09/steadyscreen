// Opt-in temporary evidence images for post-test review (checkpoint 4; audit B/D of checkpoint 3).
// What the app controls: images are kept only as in-memory Blob references inside this tab while the review is
// open; the app does not upload them or save them to files; clear() releases the app's references and revokes
// object URLs. The browser itself may cache Blob data in its own temporary storage; the app cannot control that.
//
// Lifecycle guarantees (tested in tests/regression_cp4.test.mjs and the browser journeys):
//  - generation ownership: clear() starts a new generation; a pending encoder callback from an older generation
//    is discarded, so a cleared store cannot be repopulated by late work;
//  - ordering: images are inserted by timestamp even if encoder callbacks finish out of order;
//  - finalize(): stops capture, waits (bounded) for pending callbacks, then freezes the store; later captures and
//    late callbacks are ignored. Coverage is computed only after finalize().
//  - null encoder results (allowed by canvas.toBlob) are counted as failures, never as images.
//  - pins (overnight fix ON-01): images inside a pinned time range (the practice stand being asked about / accepted)
//    are exempt from the rolling trim, so the reference image survives however long the observer waits before GO.
//    A pin key holds one range; pinning the same key again replaces it; clear() removes all pins.
function canvasEncoder() {
  let canvas = null;
  return (video, w, h, cb) => {
    canvas = canvas || document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    canvas.getContext("2d").drawImage(video, 0, 0, w, h);
    canvas.toBlob(cb, "image/jpeg", 0.72);
  };
}

export function createEvidenceStore({ maxWidth = 480, minIntervalMs = 150, keepBeforeMs = 20000, maxPending = 4, encode = null } = {}) {
  const enc = encode || canvasEncoder();
  let frames = [], urls = new Set(), lastT = -Infinity, pending = 0, bytes = 0, dropped = 0, skippedBusy = 0, late = 0;
  let gen = 0, frozen = false, sealed = false, waiters = [], pins = new Map();   // frozen: no new captures; sealed: no more callbacks accepted
  const pinned = (t) => { for (const [a, b] of pins.values()) if (t >= a && t <= b) return true; return false; };
  const revoke = (f) => { if (f && f.url) { URL.revokeObjectURL(f.url); urls.delete(f.url); f.url = null; } };
  const settle = () => { if (pending === 0) { const w = waiters; waiters = []; w.forEach((r) => r()); } };
  const boxOf = (pose) => {
    if (!pose) return null;
    let x0 = 1, y0 = 1, x1 = 0, y1 = 0, n = 0;
    for (const p of pose) { if ((p[3] ?? 0) < 0.3) continue; n++; x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
    return n ? [Math.max(0, x0 - 0.02), Math.max(0, y0 - 0.02), Math.min(1, x1 + 0.02), Math.min(1, y1 + 0.02)] : null;
  };
  return {
    capture(video, t, pose, keepFromT = null, { priority = false } = {}) {
      if (frozen || t - lastT < minIntervalMs || !video.videoWidth) return;
      // (overnight ON-38: near a required anchor such as the 30-s mark, allow twice the pending encodes so a slow encoder
      //  does not leave the endpoint without an image)
      if (pending >= (priority ? 2 * maxPending : maxPending)) { skippedBusy++; return; }
      lastT = t;
      const w = Math.min(maxWidth, video.videoWidth), h = Math.round(video.videoHeight * w / video.videoWidth);
      const box = boxOf(pose), myGen = gen;
      pending++;
      enc(video, w, h, (blob) => {
        pending--;
        if (myGen !== gen || sealed) { late++; settle(); return; }          // stale generation, or arrived after finalize() settled
        if (!blob) { dropped++; settle(); return; }
        const f = { t, blob, box, w, h, url: null };
        let i = frames.length; while (i > 0 && frames[i - 1].t > t) i--; // ordered insert
        frames.splice(i, 0, f); bytes += blob.size || 0;
        const cutoff = keepFromT !== null ? keepFromT : t - keepBeforeMs;
        if (frames.length && frames[0].t < cutoff) {
          frames = frames.filter((x) => { if (x.t >= cutoff || pinned(x.t)) return true; bytes -= x.blob.size || 0; revoke(x); return false; });
        }
        settle();
      });
    },
    /** Stop capturing and wait (max timeoutMs) for pending callbacks; afterwards the store is frozen. */
    finalize(timeoutMs = 1500) {
      frozen = true;                                                      // captures already started may still land
      const seal = () => { sealed = true; return this.stats(); };
      if (pending === 0) return Promise.resolve(seal());
      return new Promise((res) => { const to = setTimeout(() => { waiters = waiters.filter((w) => w !== done); res(seal()); }, timeoutMs); const done = () => { clearTimeout(to); res(seal()); }; waiters.push(done); });
    },
    get frozen() { return frozen; },
    /** Protect images in [t0, t1] from the rolling trim (one range per key; re-pinning a key replaces it). */
    pin(key, t0, t1) { if (Number.isFinite(t0) && Number.isFinite(t1)) pins.set(key, [t0, t1]); },
    unpin(key) { pins.delete(key); },
    times() { return frames.map((f) => f.t); },
    nearest(t, maxMs = Infinity) {
      let best = null, bd = Infinity;
      for (const f of frames) { const d = Math.abs(f.t - t); if (d < bd) { bd = d; best = f; } }
      return best && bd <= maxMs ? best : null;
    },
    at(t) { return frames.find((f) => Math.abs(f.t - t) <= 1) || null; },
    /** Images in [t0, t1], at most `max`, ALWAYS keeping the required anchor times (e.g. start, top, end). */
    between(t0, t1, max = 8, anchors = []) {
      const inRange = frames.filter((f) => f.t >= t0 && f.t <= t1);
      const keep = new Set(anchors.filter(Boolean));
      if (inRange.length <= max) return inRange;
      const rest = inRange.filter((f) => !keep.has(f));
      const slots = Math.max(0, max - keep.size);
      const step = rest.length > 1 && slots > 1 ? (rest.length - 1) / (slots - 1) : 1;
      const picked = new Set(keep);
      for (let i = 0; i < slots && i * step < rest.length; i++) picked.add(rest[Math.round(i * step)]);
      return inRange.filter((f) => picked.has(f));
    },
    url(frame) { if (!frame.url) { frame.url = URL.createObjectURL(frame.blob); urls.add(frame.url); } return frame.url; },
    clear() { gen++; for (const f of frames) revoke(f); for (const u of urls) URL.revokeObjectURL(u); urls = new Set(); frames = []; bytes = 0; lastT = -Infinity; frozen = false; sealed = false; pins = new Map(); settle(); },
    stats() { return { frames: frames.length, bytes, dropped, skippedBusy, lateOrStale: late, pending, frozen, sealed, objectUrls: urls.size, pins: pins.size, firstT: frames.length ? frames[0].t : null, lastT: frames.length ? frames[frames.length - 1].t : null }; },
  };
}
