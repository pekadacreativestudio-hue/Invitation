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

  // Smoothed leaf box, in normalized [0,1] coords, plus a confidence/visibility value
  const smooth = { cx: 0.5, cy: 0.5, w: 0.4, h: 0.4, visible: 0 };
  const SMOOTH_ALPHA = 0.18;

  function lerp(a, b, t) {
    return a + (b - a) * t;
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
  // so bold/italic serif glyphs (which run wider than a char-count estimate)
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

  function drawInvitationOnLeaf(cx, cy, w, h) {
    const rx = w / 2;
    const ry = h / 2;

    ctx.save();
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.clip();

    // Soft dark scrim so gold text stays legible against the leaf
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(rx, ry));
    grad.addColorStop(0, "rgba(10, 30, 15, 0.55)");
    grad.addColorStop(1, "rgba(10, 30, 15, 0.25)");
    ctx.fillStyle = grad;
    ctx.fillRect(cx - rx, cy - ry, rx * 2, ry * 2);

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#f3d98b";
    ctx.shadowColor = "rgba(0,0,0,0.85)";
    ctx.shadowBlur = Math.max(2, h * 0.02);

    const unit = h; // scale everything off leaf height
    const blocks = [
      { text: INVITE_CONFIG.greeting, size: 0.075, weight: "400", style: "italic", gap: 0.09 },
      { text: INVITE_CONFIG.eventName, size: 0.1, weight: "700", style: "normal", gap: 0.12 },
      { text: INVITE_CONFIG.hostNames, size: 0.06, weight: "600", style: "normal", gap: 0.08 },
      { text: INVITE_CONFIG.date + "  •  " + INVITE_CONFIG.time, size: 0.052, weight: "400", style: "normal", gap: 0.07 },
      { text: INVITE_CONFIG.venue, size: 0.05, weight: "400", style: "normal", gap: 0.065 },
    ];

    const maxWidthPx = rx * 2 * 0.78; // inset from the ellipse's widest point
    const rendered = [];
    for (const b of blocks) {
      let fontSize = Math.max(8, unit * b.size);
      const fontFor = (size) => b.style + " " + b.weight + " " + size + "px Georgia, 'Times New Roman', serif";
      ctx.font = fontFor(fontSize);
      // Shrink until even the longest single word fits; wrapping alone can't help that case.
      const longestWord = b.text.split(" ").reduce((a, w) => (ctx.measureText(w).width > ctx.measureText(a).width ? w : a), "");
      while (fontSize > 8 && ctx.measureText(longestWord).width > maxWidthPx) {
        fontSize *= 0.92;
        ctx.font = fontFor(fontSize);
      }
      const lines = wrapLines(b.text, maxWidthPx);
      for (const l of lines) rendered.push({ text: l, size: fontSize, weight: b.weight, style: b.style, gap: b.gap });
    }

    const totalHeight = rendered.reduce((sum, r) => sum + unit * r.gap, 0);
    let y = cy - totalHeight / 2;
    for (const r of rendered) {
      y += (unit * r.gap) / 2;
      ctx.font = r.style + " " + r.weight + " " + r.size + "px Georgia, 'Times New Roman', serif";
      ctx.fillText(r.text, cx, y);
      y += (unit * r.gap) / 2;
    }

    ctx.restore();

    // Thin gold outline tracing the leaf edge for a subtle "AR lock" feel
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

  function frame() {
    if (!running) return;

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

    if (smooth.visible > 0.05) {
      ctx.save();
      ctx.globalAlpha = Math.min(1, smooth.visible);
      drawInvitationOnLeaf(smooth.cx, smooth.cy, smooth.w, smooth.h);
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
