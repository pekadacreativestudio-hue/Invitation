(() => {
  const video = document.getElementById("camera");
  const canvas = document.getElementById("stage");
  const ctx = canvas.getContext("2d");
  const startBtn = document.getElementById("startBtn");
  const switchBtn = document.getElementById("switchBtn");
  const testBtn = document.getElementById("testBtn");
  const snapBtn = document.getElementById("snapBtn");
  const overlay = document.getElementById("overlay");
  const hint = document.getElementById("hint");
  const errorBox = document.getElementById("errorBox");

  let stream = null;
  let facingMode = "environment";
  let testMode = false;
  let running = false;
  let lastTime = 0;

  // Smoothed leaf box, in normalized [0,1] coords, plus a confidence/visibility value
  const smooth = { cx: 0.5, cy: 0.5, w: 0.4, h: 0.4, visible: 0 };
  const SMOOTH_ALPHA = 0.18;

  // Writing-reveal animation state: restarts each time the leaf reappears
  // after being hidden, so the invitation "writes itself" anew each time.
  let revealStart = null;
  let wasHidden = true;
  const HIDE_THRESHOLD = 0.12;
  const SHOW_TRIGGER_THRESHOLD = 0.55;
  const MS_PER_CHAR = 42;
  const MIN_LINE_MS = 260;

  const CURSIVE_FONT = "'Great Vibes', 'Brush Script MT', 'Segoe Script', cursive";
  const SERIF_FONT = "'Cormorant Garamond', Georgia, 'Times New Roman', serif";

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }
  function clamp01(v) {
    return Math.max(0, Math.min(1, v));
  }

  async function startCamera() {
    stopCamera();
    errorBox.hidden = true;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      video.srcObject = stream;
      await video.play();
      overlay.hidden = true;
      testMode = false;
      running = true;
    } catch (err) {
      errorBox.hidden = false;
      errorBox.textContent =
        "Camera access failed (" + err.message + "). You can still preview the invitation with 'Preview without camera'.";
    }
  }

  function stopCamera() {
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
  }

  function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  window.addEventListener("resize", resizeCanvas);
  resizeCanvas();

  function drawVideoCover() {
    const vw = video.videoWidth || canvas.width;
    const vh = video.videoHeight || canvas.height;
    const cw = canvas.width;
    const ch = canvas.height;
    const scale = Math.max(cw / vw, ch / vh);
    const dw = vw * scale;
    const dh = vh * scale;
    const dx = (cw - dw) / 2;
    const dy = (ch - dh) / 2;
    ctx.drawImage(video, dx, dy, dw, dh);
  }

  // Wraps by actual measured pixel width for the font currently set on ctx,
  // so script/serif glyphs (which run wider than a char-count estimate)
  // never overflow the ellipse they're clipped to.
  function wrapLines(text, maxWidthPx) {
    const words = text.split(" ");
    const lines = [];
    let line = "";
    for (const word of words) {
      const candidate = line ? line + " " + word : word;
      if (ctx.measureText(candidate).width > maxWidthPx && line) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    if (line) lines.push(line);
    return lines;
  }

  // Lays out the invitation blocks (hero word, ornaments, subtitle, details)
  // into individual renderable items with resolved font size and vertical
  // position, but does not paint anything yet.
  function layoutInvitation(cx, cy, rx, ry) {
    const unit = ry * 2;
    const ornamentWidth = rx * 2 * 0.62;
    const blocks = [
      { type: "ornament", width: ornamentWidth, gap: 0.075 },
      { type: "text", text: INVITE_CONFIG.heroWord, size: 0.155, weight: "400", family: CURSIVE_FONT, gap: 0.13, maxWidthFactor: 0.88, gold: true },
      { type: "text", text: "—  " + INVITE_CONFIG.greeting + "  —", size: 0.042, weight: "500", family: SERIF_FONT, italic: true, gap: 0.075, maxWidthFactor: 0.82 },
      { type: "ornament", width: ornamentWidth * 0.8, gap: 0.075 },
      { type: "text", text: INVITE_CONFIG.eventName, size: 0.058, weight: "600", family: SERIF_FONT, gap: 0.085, maxWidthFactor: 0.8 },
      { type: "text", text: INVITE_CONFIG.hostNames, size: 0.05, weight: "500", family: SERIF_FONT, gap: 0.075, maxWidthFactor: 0.78 },
      { type: "text", text: INVITE_CONFIG.date + "  •  " + INVITE_CONFIG.time, size: 0.044, weight: "400", family: SERIF_FONT, gap: 0.065, maxWidthFactor: 0.78 },
      { type: "text", text: INVITE_CONFIG.venue, size: 0.042, weight: "400", family: SERIF_FONT, gap: 0.06, maxWidthFactor: 0.78 },
    ];

    const rendered = [];
    for (const b of blocks) {
      if (b.type === "ornament") {
        rendered.push({ type: "ornament", width: b.width, gap: b.gap });
        continue;
      }
      const maxWidthPx = rx * 2 * (b.maxWidthFactor || 0.78);
      let fontSize = Math.max(8, unit * b.size);
      const fontFor = (size) => (b.italic ? "italic " : "normal ") + b.weight + " " + size + "px " + b.family;
      ctx.font = fontFor(fontSize);
      const longestWord = b.text.split(" ").reduce((a, w) => (ctx.measureText(w).width > ctx.measureText(a).width ? w : a), "");
      while (fontSize > 8 && ctx.measureText(longestWord).width > maxWidthPx) {
        fontSize *= 0.92;
        ctx.font = fontFor(fontSize);
      }
      ctx.font = fontFor(fontSize);
      const lines = wrapLines(b.text, maxWidthPx);
      for (const l of lines) {
        ctx.font = fontFor(fontSize);
        rendered.push({
          type: "text",
          text: l,
          size: fontSize,
          weight: b.weight,
          family: b.family,
          italic: !!b.italic,
          gold: !!b.gold,
          gap: b.gap,
          width: ctx.measureText(l).width,
        });
      }
    }

    const totalHeight = rendered.reduce((sum, r) => sum + unit * r.gap, 0);
    let y = cy - totalHeight / 2;
    for (const r of rendered) {
      y += (unit * r.gap) / 2;
      r.y = y;
      if (r.type === "text") r.x0 = cx - r.width / 2;
      y += (unit * r.gap) / 2;
    }
    return rendered;
  }

  // A symmetric filigree divider: two curled arms plus a center diamond,
  // drawn stroke-first so it can "grow" outward from the middle on reveal.
  function paintOrnament(item, cx, progress) {
    if (progress <= 0) return;
    const width = item.width * easeOut(clamp01(progress));
    const halfW = width / 2;
    const armLen = halfW * 0.82;
    const y = item.y;

    ctx.save();
    ctx.globalAlpha *= Math.min(1, progress * 1.6);
    ctx.strokeStyle = "rgba(243,217,139,0.85)";
    ctx.lineWidth = Math.max(1, width * 0.0065);
    ctx.lineCap = "round";
    ctx.shadowColor = "rgba(255,195,80,0.75)";
    ctx.shadowBlur = width * 0.03;

    ctx.beginPath();
    ctx.moveTo(cx - width * 0.05, y);
    ctx.quadraticCurveTo(cx - armLen * 0.55, y - width * 0.025, cx - armLen, y);
    ctx.quadraticCurveTo(cx - armLen * 1.06, y + width * 0.028, cx - armLen * 0.9, y + width * 0.032);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(cx + width * 0.05, y);
    ctx.quadraticCurveTo(cx + armLen * 0.55, y - width * 0.025, cx + armLen, y);
    ctx.quadraticCurveTo(cx + armLen * 1.06, y + width * 0.028, cx + armLen * 0.9, y + width * 0.032);
    ctx.stroke();

    const d = width * 0.022;
    ctx.beginPath();
    ctx.moveTo(cx, y - d);
    ctx.lineTo(cx + d, y);
    ctx.lineTo(cx, y + d);
    ctx.lineTo(cx - d, y);
    ctx.closePath();
    ctx.fillStyle = "rgba(243,217,139,0.9)";
    ctx.fill();

    ctx.restore();
  }

  function easeOut(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  // Paints one line with a soft gold bloom, a crisp fill (gradient for the
  // hero word), and a moving highlight sweep, clipped to its reveal progress.
  function paintLine(line, cx, progress, now) {
    if (progress <= 0) return null;

    const revealWidth = line.width * clamp01(progress);
    ctx.save();
    ctx.beginPath();
    ctx.rect(line.x0, line.y - line.size, revealWidth, line.size * 2.2);
    ctx.clip();

    ctx.font = (line.italic ? "italic " : "normal ") + line.weight + " " + line.size + "px " + line.family;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    ctx.shadowColor = "rgba(255, 195, 80, 0.85)";
    ctx.shadowBlur = line.size * (line.gold ? 0.55 : 0.4);
    ctx.fillStyle = "#f3d98b";
    ctx.fillText(line.text, cx, line.y);
    ctx.fillText(line.text, cx, line.y);

    ctx.shadowBlur = 0;
    if (line.gold) {
      const g = ctx.createLinearGradient(0, line.y - line.size * 0.55, 0, line.y + line.size * 0.55);
      g.addColorStop(0, "#fff6d8");
      g.addColorStop(0.5, "#f0c34d");
      g.addColorStop(1, "#b6841f");
      ctx.fillStyle = g;
    } else {
      ctx.fillStyle = "#fbe7ad";
    }
    ctx.fillText(line.text, cx, line.y);

    const band = line.width * 0.16 + 1;
    const sweepPos = line.x0 + ((Math.sin(now / 1500 + line.y * 0.01) + 1) / 2) * (line.width + band * 2) - band;
    const sweepGrad = ctx.createLinearGradient(sweepPos - band, 0, sweepPos + band, 0);
    sweepGrad.addColorStop(0, "rgba(255,255,255,0)");
    sweepGrad.addColorStop(0.5, "rgba(255,255,255,0.85)");
    sweepGrad.addColorStop(1, "rgba(255,255,255,0)");
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = sweepGrad;
    ctx.fillText(line.text, cx, line.y);
    ctx.restore();

    ctx.restore();

    if (progress < 1) {
      return { x: line.x0 + revealWidth, y: line.y };
    }
    return null;
  }

  function drawInvitationOnLeaf(cx, cy, w, h, now, dt) {
    const rx = w / 2;
    const ry = h / 2;

    ctx.save();
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.clip();

    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(rx, ry));
    grad.addColorStop(0, "rgba(10, 30, 15, 0.55)");
    grad.addColorStop(1, "rgba(10, 30, 15, 0.25)");
    ctx.fillStyle = grad;
    ctx.fillRect(cx - rx, cy - ry, rx * 2, ry * 2);

    const rendered = layoutInvitation(cx, cy, rx, ry);

    let cursor = 0;
    let penTip = null;
    for (const item of rendered) {
      const durationMs = item.type === "ornament" ? 450 : Math.max(MIN_LINE_MS, item.text.length * MS_PER_CHAR);
      const elapsed = revealStart == null ? durationMs : now - revealStart - cursor;
      const progress = clamp01(elapsed / durationMs);
      if (item.type === "ornament") {
        paintOrnament(item, cx, progress);
      } else {
        const tip = paintLine(item, cx, progress, now);
        if (tip) penTip = tip;
      }
      cursor += durationMs;
    }

    if (penTip) {
      Sparkles.spawnBurst(penTip.x, penTip.y, 1, { life: 500 + Math.random() * 300, size: 1.5 + Math.random() * 2, spread: 40, rise: 15 });
    }
    Sparkles.spawnAmbient({ cx, cy, rx: rx * 0.85, ry: ry * 0.85 }, dt, 6);
    Sparkles.draw(ctx);

    ctx.restore();

    ctx.save();
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(243, 217, 139, 0.55)";
    ctx.lineWidth = Math.max(1, h * 0.006);
    ctx.stroke();
    ctx.restore();
  }

  function drawHintReticle() {
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    const r = Math.min(canvas.width, canvas.height) * 0.22;
    ctx.save();
    ctx.setLineDash([10, 8]);
    ctx.strokeStyle = "rgba(255,255,255,0.55)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(cx, cy, r, r * 1.15, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    hint.hidden = false;
  }

  function frame(now) {
    if (!running) return;
    const dt = lastTime ? now - lastTime : 16;
    lastTime = now;

    if (testMode) {
      ctx.fillStyle = "#1a2c1c";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    } else {
      drawVideoCover();
    }

    let detection = null;
    if (!testMode && video.readyState >= 2) {
      detection = LeafDetector.detect(video);
    }

    if (testMode) {
      smooth.visible = lerp(smooth.visible, 1, 0.2);
      smooth.cx = canvas.width / 2;
      smooth.cy = canvas.height / 2;
      smooth.w = Math.min(canvas.width, canvas.height) * 0.5;
      smooth.h = smooth.w * 1.2;
      hint.hidden = true;
    } else if (detection) {
      const px = detection.cx * canvas.width;
      const py = detection.cy * canvas.height;
      const pw = detection.w * canvas.width;
      const ph = detection.h * canvas.height;
      smooth.cx = lerp(smooth.cx, px, SMOOTH_ALPHA);
      smooth.cy = lerp(smooth.cy, py, SMOOTH_ALPHA);
      smooth.w = lerp(smooth.w, pw, SMOOTH_ALPHA);
      smooth.h = lerp(smooth.h, ph, SMOOTH_ALPHA);
      smooth.visible = lerp(smooth.visible, 1, 0.25);
      hint.hidden = true;
    } else {
      smooth.visible = lerp(smooth.visible, 0, 0.1);
      if (smooth.visible < 0.05) drawHintReticle();
    }

    if (smooth.visible < HIDE_THRESHOLD) {
      wasHidden = true;
    } else if (wasHidden && smooth.visible > SHOW_TRIGGER_THRESHOLD) {
      revealStart = now;
      wasHidden = false;
      Sparkles.clear();
    }

    if (smooth.visible > 0.05) {
      ctx.save();
      ctx.globalAlpha = Math.min(1, smooth.visible);
      drawInvitationOnLeaf(smooth.cx, smooth.cy, smooth.w, smooth.h, now, dt);
      ctx.restore();
    }

    requestAnimationFrame(frame);
  }

  startBtn.addEventListener("click", async () => {
    await startCamera();
    if (running) requestAnimationFrame(frame);
  });

  switchBtn.addEventListener("click", async () => {
    facingMode = facingMode === "environment" ? "user" : "environment";
    if (!testMode) await startCamera();
  });

  testBtn.addEventListener("click", () => {
    stopCamera();
    overlay.hidden = true;
    errorBox.hidden = true;
    testMode = true;
    running = true;
    requestAnimationFrame(frame);
  });

  snapBtn.addEventListener("click", () => {
    const link = document.createElement("a");
    link.download = "invitation-snapshot.png";
    link.href = canvas.toDataURL("image/png");
    link.click();
  });
})();
