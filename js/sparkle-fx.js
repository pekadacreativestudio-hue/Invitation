// Small particle system for the "magic dust" look: soft glowing dots plus a
// four-point glint, drifting and twinkling. Used both as ambient sparkle
// around the leaf and as a burst trailing the writing-reveal edge.

const Sparkles = (() => {
  let particles = [];

  function spawn(x, y, opts = {}) {
    particles.push({
      x,
      y,
      vx: (Math.random() - 0.5) * (opts.spread || 10),
      vy: (Math.random() - 0.5) * (opts.spread || 10) - (opts.rise || 0),
      age: 0,
      life: opts.life || 700 + Math.random() * 500,
      size: opts.size || 2 + Math.random() * 2.5,
      twinklePhase: Math.random() * Math.PI * 2,
      twinkleSpeed: 4 + Math.random() * 3,
    });
  }

  function spawnBurst(x, y, count, opts = {}) {
    for (let i = 0; i < count; i++) spawn(x, y, opts);
  }

  // Spawns ambient sparkles at a low rate inside an ellipse region.
  function spawnAmbient(region, dt, ratePerSecond) {
    const expected = (ratePerSecond * dt) / 1000;
    let n = Math.floor(expected);
    if (Math.random() < expected - n) n++;
    for (let i = 0; i < n; i++) {
      const angle = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random());
      const x = region.cx + Math.cos(angle) * region.rx * r;
      const y = region.cy + Math.sin(angle) * region.ry * r;
      spawn(x, y, { life: 900 + Math.random() * 900, size: 1.5 + Math.random() * 2, spread: 6, rise: 4 });
    }
  }

  function update(dt) {
    particles = particles.filter((p) => {
      p.age += dt;
      if (p.age >= p.life) return false;
      p.x += (p.vx * dt) / 1000;
      p.y += (p.vy * dt) / 1000;
      return true;
    });
  }

  function draw(ctx) {
    for (const p of particles) {
      const lifeT = p.age / p.life;
      const fade = lifeT < 0.15 ? lifeT / 0.15 : 1 - (lifeT - 0.15) / 0.85;
      const twinkle = 0.55 + 0.45 * Math.sin(p.twinklePhase + (p.age / 1000) * p.twinkleSpeed);
      const alpha = Math.max(0, fade * twinkle);
      if (alpha <= 0.01) continue;
      const size = p.size * (0.7 + 0.3 * twinkle);

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(p.x, p.y);

      const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, size * 2.2);
      glow.addColorStop(0, "rgba(255,250,235,1)");
      glow.addColorStop(0.4, "rgba(255,215,120,0.85)");
      glow.addColorStop(1, "rgba(255,215,120,0)");
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(0, 0, size * 2.2, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.lineWidth = Math.max(0.5, size * 0.18);
      ctx.beginPath();
      ctx.moveTo(-size * 1.8, 0);
      ctx.lineTo(size * 1.8, 0);
      ctx.moveTo(0, -size * 1.8);
      ctx.lineTo(0, size * 1.8);
      ctx.stroke();

      ctx.restore();
    }
  }

  function clear() {
    particles = [];
  }

  return { spawnBurst, spawnAmbient, update, draw, clear };
})();
