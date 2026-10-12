// Simple local tones (Web Audio). No speech services, nothing leaves the browser.
let ctx = null;
export function beep(freq = 660, ms = 150) {
  try {
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.value = freq; g.gain.value = 0.2;
    o.connect(g); g.connect(ctx.destination);
    o.start(); o.stop(ctx.currentTime + ms / 1000);
  } catch { /* audio unavailable: visual cues still shown */ }
}
