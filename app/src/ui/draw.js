// Canvas drawing: skeleton overlay and the review timeline.
const BONES = [[11, 12], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28], [11, 13], [13, 15], [12, 14], [14, 16], [27, 31], [28, 32]];

export function drawOverlay(canvas, video, poses, participant) {
  const w = video.videoWidth, h = video.videoHeight;
  if (!w) return;
  if (canvas.width !== w) { canvas.width = w; canvas.height = h; }
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, w, h);
  const lw = Math.max(3, w / 180);
  for (const p of poses) {
    const isP = participant && p === participant;
    ctx.strokeStyle = isP ? "#18c964" : "#9a9a9a"; ctx.fillStyle = ctx.strokeStyle; ctx.lineWidth = isP ? lw * 1.6 : lw;
    for (const [a, b] of BONES) {
      if ((p[a][3] ?? 0) < 0.3 || (p[b][3] ?? 0) < 0.3) continue;
      ctx.beginPath(); ctx.moveTo(p[a][0] * w, p[a][1] * h); ctx.lineTo(p[b][0] * w, p[b][1] * h); ctx.stroke();
    }
    for (const i of [11, 12, 23, 24, 25, 26, 27, 28]) {
      if ((p[i][3] ?? 0) < 0.3) continue;
      ctx.beginPath(); ctx.arc(p[i][0] * w, p[i][1] * h, lw * 1.4, 0, 2 * Math.PI); ctx.fill();
    }
  }
}

/** Review timeline from the core trace and result. Shows exactly what was measured, including gaps. */
export function drawTimeline(canvas, trace, result, params) {
  const W = canvas.clientWidth || 900, H = canvas.height;
  canvas.width = W;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, W, H);
  const { tGo, tEnd } = result.window;
  const t0 = tGo - 1000, t1 = Math.max(tEnd, tGo + result.window.observedMs) + 500;
  const hSit = result.calibration.hSit, standH = result.calibration.stand ? result.calibration.stand.h : null;
  const lo = Math.min(hSit - 0.3, 0), hi = Math.max(1.4, (standH || 1.1) + 0.2);
  const X = (t) => 50 + ((t - t0) / (t1 - t0)) * (W - 60);
  const Y = (v) => H - 25 - ((v - lo) / (hi - lo)) * (H - 40);
  ctx.font = "13px system-ui";
  ctx.fillStyle = "rgba(179,38,30,0.18)";
  for (const g of result.gaps) ctx.fillRect(X(g.t0), 10, Math.max(2, X(g.t1) - X(g.t0)), H - 35);
  ctx.strokeStyle = "#333"; ctx.setLineDash([5, 4]);
  for (const [t, label] of [[tGo, "GO"], [tEnd, "30 s"]]) { ctx.beginPath(); ctx.moveTo(X(t), 8); ctx.lineTo(X(t), H - 25); ctx.stroke(); ctx.fillStyle = "#333"; ctx.fillText(label, X(t) + 4, 20); }
  const lines = [[hSit + params.seatReturnRise, "#888", "seated"], [result.calibration.halfway, "#1d4ed8", "halfway"]];
  if (standH) lines.push([standH, "#127a3a", "practice stand"]);
  for (const [v, col, label] of lines) { if (v === null || v === undefined) continue; ctx.strokeStyle = col; ctx.beginPath(); ctx.moveTo(50, Y(v)); ctx.lineTo(W - 10, Y(v)); ctx.stroke(); ctx.fillStyle = col; ctx.fillText(label, 2, Y(v) - 2); }
  ctx.setLineDash([]);
  ctx.strokeStyle = "#1d4ed8"; ctx.lineWidth = 2; ctx.beginPath(); let pen = false;
  for (const r of trace) {
    if (r.t < t0 || r.t > t1) continue;
    if (r.h === null) { pen = false; continue; }
    if (!pen) { ctx.moveTo(X(r.t), Y(r.h)); pen = true; } else ctx.lineTo(X(r.t), Y(r.h));
  }
  ctx.stroke(); ctx.lineWidth = 1;
  const COL = { full: "#127a3a", expiry: "#1d4ed8", uncertain: "#b85c00", partial: "#888" };
  ctx.font = "bold 15px system-ui";
  for (const e of result.events) {
    const t = e.tFull || e.tExpiry || e.tPeak || e.tRise; if (t === null || t === undefined) continue;
    const x = X(t); ctx.fillStyle = COL[e.cls] || "#333"; ctx.strokeStyle = ctx.fillStyle;
    ctx.beginPath(); ctx.moveTo(x, 12); ctx.lineTo(x, H - 25); ctx.stroke();
    ctx.fillText(e.cls === "partial" ? "·" : e.cls === "uncertain" ? `${e.n}?` : String(e.n), x + 3, 34 + (e.n % 2) * 16);
  }
  ctx.fillStyle = "#555"; ctx.font = "13px system-ui";
  for (let s = 0; s <= 30; s += 5) ctx.fillText(`${s}s`, X(tGo + s * 1000) - 8, H - 6);
}
