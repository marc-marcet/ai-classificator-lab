// Minimal 2D latency chart: sparkline bars for the last N decision timings.
// Canvas 2D on purpose - one flat layer, zero dependencies, sub-millisecond draw.

export function createLatencyChart(canvas, maxPoints = 30) {
  const ctx = canvas.getContext('2d');
  const times = [];

  function resize() {
    const dpr = Math.min(devicePixelRatio, 2);
    const w = canvas.clientWidth || 300;
    const h = canvas.clientHeight || 72;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }

  function draw() {
    const w = canvas.clientWidth || 300;
    const h = canvas.clientHeight || 72;
    ctx.clearRect(0, 0, w, h);
    if (!times.length) return;

    const max = Math.max(...times, 1);
    const slot = w / maxPoints;
    const bw = Math.max(3, Math.min(14, slot - 3));
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, '#5eead4');
    grad.addColorStop(1, '#818cf8');

    times.forEach((ms, i) => {
      const x = w - (times.length - i) * slot;
      const bh = Math.max(3, (ms / max) * (h - 12));
      ctx.fillStyle = grad;
      ctx.globalAlpha = i === times.length - 1 ? 1 : 0.55;
      ctx.beginPath();
      ctx.roundRect(x + (slot - bw) / 2, h - bh, bw, bh, 3);
      ctx.fill();
    });
    ctx.globalAlpha = 1;
  }

  new ResizeObserver(resize).observe(canvas);
  resize();

  return {
    add(ms) {
      times.push(ms);
      if (times.length > maxPoints) times.shift();
      draw();
    },
    reset() {
      times.length = 0;
      draw();
    },
  };
}
