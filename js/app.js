(() => {
  const video = document.getElementById("camera");
  const canvas = document.getElementById("stage");
  const ctx = canvas.getContext("2d");
  const startBtn = document.getElementById("startBtn");
  const switchBtn = document.getElementById("switchBtn");
  const snapBtn = document.getElementById("snapBtn");
  const overlay = document.getElementById("overlay");
  const hint = document.getElementById("hint");
  const errorBox = document.getElementById("errorBox");
  const acceptBtn = document.getElementById("acceptBtn");
  const eCard = document.getElementById("eCard");
  const backBtn = document.getElementById("backBtn");

  let stream = null;
  let facingMode = "environment";
  let running = false;
  let lastTime = 0;
  let invitationAccepted = false;

  // Smoothed leaf box, in normalized [0,1] coords, plus a confidence/visibility value
  const smooth = { cx: 0.5, cy: 0.5, w: 0.4, h: 0.4, visible: 0 };
  const SMOOTH_ALPHA = 0.18;

  // Magical-reveal animation state: restarts each time the leaf reappears
  // after being hidden, so the invitation materializes anew each time. Each
  // item (hero word, message lines) fades + scales in with a sparkle
  // burst, staggered in a cascade rather than a per-character typewriter.
  let revealStart = null;
  let wasHidden = true;
  const HIDE_THRESHOLD = 0.12;
  const SHOW_TRIGGER_THRESHOLD = 0.55;
  // The leaf's bounding-box width, as a fraction of the screen width, that
  // counts as "filling" the full-screen scan guide. The dashed reticle (and
  // hint text) stays up — even once a leaf is detected — until the leaf is
  // actually held this close/large, so the invitation only starts appearing
  // once the scanning area is genuinely filled, not just as soon as any
  // leaf-colored blob is seen.
  const FILL_TRIGGER_THRESHOLD = 0.85;
  const ITEM_STAGGER_MS = 260;
  const ITEM_DURATION_MS = 700;

  // An uploaded background photo replaces the plain cream gradient behind
  // the landing screen, if present, with a tinted scrim layered over it so
  // the title/button stay legible. Tries .jpg first (recommended — a
  // photographic background compresses far smaller as JPEG than PNG),
  // falling back to .png.
  function loadWelcomeBg(paths) {
    if (!paths.length) return;
    const probe = new Image();
    probe.onload = () => {
      const overlayBg = document.getElementById("overlayBg");
      overlayBg.style.setProperty("--bg-url", 'url("' + probe.src + '")');
      overlayBg.classList.add("has-image");
    };
    probe.onerror = () => loadWelcomeBg(paths.slice(1));
    probe.src = paths[0];
  }
  loadWelcomeBg(["assets/welcome-bg.jpg", "assets/welcome-bg.png"]);

  // The text layout (wrapping, font sizes, positions) is computed ONCE per
  // "capture" — the moment the leaf locks in — and cached here. After that,
  // the leaf moving/zooming only pans and scales this frozen layout; it
  // never re-wraps or re-arranges. (Rotation tracking was tried and
  // removed — the detector's angle estimate didn't reliably match the
  // leaf's actual visible tilt, so the invitation is kept upright and
  // simply follows the leaf's position/size.)
  let cachedLayout = null;

  const CURSIVE_FONT = "'Great Vibes', 'Brush Script MT', 'Segoe Script', cursive";
  const SERIF_FONT = "'Cormorant Garamond', Georgia, 'Times New Roman', serif";

  // How close the leaf has to get (as a fraction of screen width) before the
  // invitation starts zooming in beyond the leaf's actual tracked size, so
  // the text stays comfortably readable when the leaf fills the frame.
  const ZOOM_START = 0.34;
  const ZOOM_END = 0.62;
  const ZOOM_BOOST = 0.55;

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }
  function clamp01(v) {
    return Math.max(0, Math.min(1, v));
  }
  function easeOut(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  // A heart-shaped path with a pointed tip, matching a real betel leaf's
  // silhouette — used for the pre-scan guide and the on-leaf text mask.
  function betelLeafPath(cx, cy, rx, ry) {
    ctx.beginPath();
    ctx.moveTo(cx, cy + ry);
    ctx.bezierCurveTo(cx - rx * 1.35, cy + ry * 0.35, cx - rx * 1.05, cy - ry * 0.78, cx, cy - ry * 0.6);
    ctx.bezierCurveTo(cx + rx * 1.05, cy - ry * 0.78, cx + rx * 1.35, cy + ry * 0.35, cx, cy + ry);
    ctx.closePath();
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
      running = true;
    } catch (err) {
      errorBox.hidden = false;
      errorBox.textContent = "Camera access failed (" + err.message + "). Please allow camera access and try again.";
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

  // Lays out just the hero word and the message body into individual
  // renderable items with resolved size/position (relative to the given
  // center/half-height), but does not paint anything yet. Returns the items
  // plus the total height they need, so the caller can shrink everything
  // uniformly if it doesn't fit.
  function layoutInvitation(cx, cy, rx, ry) {
    const unit = ry * 2;
    const rendered = [];

    const heroMaxWidthPx = rx * 2 * 0.78;
    let heroFontSize = Math.max(8, unit * 0.1);
    const heroFontFor = (size) => "normal 400 " + size + "px " + CURSIVE_FONT;
    ctx.font = heroFontFor(heroFontSize);
    const longestHeroWord = INVITE_CONFIG.heroWord
      .split(" ")
      .reduce((a, w) => (ctx.measureText(w).width > ctx.measureText(a).width ? w : a), "");
    while (heroFontSize > 8 && ctx.measureText(longestHeroWord).width > heroMaxWidthPx) {
      heroFontSize *= 0.92;
      ctx.font = heroFontFor(heroFontSize);
    }
    ctx.font = heroFontFor(heroFontSize);
    for (const l of wrapLines(INVITE_CONFIG.heroWord, heroMaxWidthPx)) {
      ctx.font = heroFontFor(heroFontSize);
      rendered.push({
        type: "text",
        text: l,
        size: heroFontSize,
        weight: "400",
        family: CURSIVE_FONT,
        italic: false,
        gold: true,
        gap: 0.12,
        width: ctx.measureText(l).width,
      });
    }

    // message is a list of forced lines (not one flowing paragraph) — an
    // empty string is a blank spacer between the two sentences. Each
    // non-empty line is still safety-wrapped in case it doesn't fit a
    // narrow/small leaf, but normally renders as the single line given.
    const msgMaxWidthPx = rx * 2 * 0.87;
    let msgFontSize = Math.max(12, unit * 0.048);
    const msgFontFor = (size) => "italic 400 " + size + "px " + SERIF_FONT;
    const longestMsgWord = INVITE_CONFIG.message
      .join(" ")
      .split(" ")
      .reduce((a, w) => (ctx.measureText(w).width > ctx.measureText(a).width ? w : a), "");
    ctx.font = msgFontFor(msgFontSize);
    while (msgFontSize > 8 && ctx.measureText(longestMsgWord).width > msgMaxWidthPx) {
      msgFontSize *= 0.92;
      ctx.font = msgFontFor(msgFontSize);
    }

    let pendingGap = 0.085; // gap before the first message line stands in for the blank line after the hero word
    INVITE_CONFIG.message.forEach((line) => {
      if (line === "") {
        pendingGap += 0.065; // blank spacer: fold into the gap before the next real line
        return;
      }
      ctx.font = msgFontFor(msgFontSize);
      const subLines = wrapLines(line, msgMaxWidthPx);
      subLines.forEach((l, i) => {
        ctx.font = msgFontFor(msgFontSize);
        rendered.push({
          type: "text",
          text: l,
          size: msgFontSize,
          weight: "400",
          family: SERIF_FONT,
          italic: true,
          gold: false,
          gap: i === 0 ? pendingGap : 0.05,
          width: ctx.measureText(l).width,
        });
      });
      pendingGap = 0.05;
    });

    const totalHeight = rendered.reduce((sum, r) => sum + unit * r.gap, 0);
    let y = cy - totalHeight / 2;
    for (const r of rendered) {
      y += (unit * r.gap) / 2;
      r.y = y;
      r.x0 = cx - r.width / 2;
      y += (unit * r.gap) / 2;
    }
    return { items: rendered, totalHeight };
  }

  // Paints one line materializing in: fades and settles from slightly
  // oversized down to full size (rather than a left-to-right typewriter
  // wipe). Two shadow passes first — a dark one for contrast against a
  // bright green leaf, then a warm gold glow for the magical feel — then a
  // crisp fill (light gold for the hero word, ivory for the message) and a
  // moving highlight sweep once revealed.
  function paintLine(line, cx, progress, now) {
    if (progress <= 0) return;
    const eased = easeOut(clamp01(progress));

    ctx.save();
    ctx.globalAlpha *= eased;
    ctx.translate(cx, line.y);
    ctx.scale(1.18 - 0.18 * eased, 1.18 - 0.18 * eased);
    ctx.translate(-cx, -line.y);

    ctx.font = (line.italic ? "italic " : "normal ") + line.weight + " " + line.size + "px " + line.family;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    const fillColor = line.gold ? "#f6dfa3" : "#fffdf3";

    // Dark contrast shadow so the text stays legible against a bright leaf.
    ctx.shadowColor = "rgba(8, 25, 12, 0.8)";
    ctx.shadowBlur = line.size * 0.32;
    ctx.shadowOffsetY = line.size * 0.03;
    ctx.fillStyle = fillColor;
    ctx.fillText(line.text, cx, line.y);
    ctx.fillText(line.text, cx, line.y);

    // Warm gold magic glow, softer than the contrast shadow so it doesn't
    // fight legibility.
    ctx.shadowOffsetY = 0;
    ctx.shadowColor = "rgba(255, 205, 110, 0.75)";
    ctx.shadowBlur = line.size * (line.gold ? 0.5 : 0.32);
    ctx.fillText(line.text, cx, line.y);

    ctx.shadowBlur = 0;
    ctx.fillStyle = fillColor;
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
  }

  // Computes and freezes the layout exactly once per "capture" — using the
  // leaf's size at that instant as the reference frame. Every later frame
  // just scales/rotates/pans this frozen layout to match the live leaf.
  function lockInvitation(refRx, refRy) {
    const safeCyLocal = refRy * 0.06;
    const safeHalfHeightLocal = refRy * 0.46;
    const { items, totalHeight } = layoutInvitation(0, safeCyLocal, refRx, safeHalfHeightLocal);
    items.forEach((item, i) => {
      item._startAt = i * ITEM_STAGGER_MS;
      item._sparked = false;
    });
    const fitScale = Math.min(1, (safeHalfHeightLocal * 2) / totalHeight);
    cachedLayout = { items, refRx, refRy, safeCyLocal, fitScale };
  }

  function drawInvitationOnLeaf(cx, cy, w, h, now, dt) {
    if (!cachedLayout) return false;
    const rx = w / 2;
    const ry = h / 2;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(rx / cachedLayout.refRx, ry / cachedLayout.refRy);

    // The heart shape narrows sharply at the top notch and the bottom tip,
    // so text was laid out within a smaller interior band — shifted slightly
    // below center, where the shape stays widest — instead of the full
    // height, which would push the first/last lines into the narrow parts
    // and get them clipped by the silhouette.
    betelLeafPath(0, 0, cachedLayout.refRx, cachedLayout.refRy);
    ctx.clip();

    if (cachedLayout.fitScale < 1) {
      const scy = cachedLayout.safeCyLocal;
      ctx.translate(0, scy);
      ctx.scale(cachedLayout.fitScale, cachedLayout.fitScale);
      ctx.translate(0, -scy);
    }

    let allDone = revealStart != null;
    const transformForSparkles = ctx.getTransform();
    for (const item of cachedLayout.items) {
      const elapsed = revealStart == null ? ITEM_DURATION_MS : now - revealStart - item._startAt;
      const progress = clamp01(elapsed / ITEM_DURATION_MS);
      if (progress < 1) allDone = false;

      // The instant an item starts materializing, scatter a burst of
      // sparkles across it — once per capture — for the "magic appearing"
      // feel, instead of a single point trailing a typewriter cursor.
      if (!item._sparked && progress > 0) {
        item._sparked = true;
        const itemHeight = item.height || item.size * 1.4 || 20;
        for (let i = 0; i < 6; i++) {
          const px = item.x0 + Math.random() * item.width;
          const py = item.y + (Math.random() - 0.5) * itemHeight;
          const screenPt = transformForSparkles.transformPoint(new DOMPoint(px, py));
          Sparkles.spawnBurst(screenPt.x, screenPt.y, 1, {
            life: 550 + Math.random() * 350,
            size: 1.5 + Math.random() * 2.2,
            spread: 60,
            rise: 25,
          });
        }
      }

      paintLine(item, 0, progress, now);
    }

    // Clip region is already the rotated/scaled leaf shape (set above, still
    // active). Reset the CTM to identity so sparkles draw in the same
    // absolute coordinates their persisted x/y were computed in, while
    // staying confined to the tilted leaf outline via the still-active clip.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    Sparkles.spawnAmbient({ cx, cy, rx: rx * 0.85, ry: ry * 0.85 }, dt, 9);
    Sparkles.draw(ctx);

    ctx.restore();

    return allDone;
  }

  // betelLeafPath's bezier control points (rx*1.35, ry*0.78, etc.) are only
  // an upper bound on the curve's true rendered extent — a cubic bezier
  // stays inside its control polygon but doesn't reach its corners. So the
  // guide's real on-screen size is measured once (by sampling the actual
  // curve for a unit rx/ry) rather than guessed from those control-point
  // factors, guaranteeing the dashed outline's width exactly matches
  // FILL_TRIGGER_THRESHOLD of the screen — the same fraction that actually
  // triggers the reveal — so filling the guide is a reliable, honest target.
  let unitLeafExtent = null;
  function measureUnitLeafExtent(ryFactor) {
    const P0 = { x: 0, y: ryFactor };
    const P1 = { x: -1.35, y: ryFactor * 0.35 };
    const P2 = { x: -1.05, y: -ryFactor * 0.78 };
    const P3 = { x: 0, y: -ryFactor * 0.6 };
    let halfWidth = 0;
    const STEPS = 200;
    for (let i = 0; i <= STEPS; i++) {
      const t = i / STEPS;
      const mt = 1 - t;
      const x = mt * mt * mt * P0.x + 3 * mt * mt * t * P1.x + 3 * mt * t * t * P2.x + t * t * t * P3.x;
      if (Math.abs(x) > halfWidth) halfWidth = Math.abs(x);
    }
    return { halfWidth };
  }

  function drawHintReticle() {
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    if (!unitLeafExtent) unitLeafExtent = measureUnitLeafExtent(1.2);
    const r = (canvas.width * FILL_TRIGGER_THRESHOLD) / (2 * unitLeafExtent.halfWidth);
    ctx.save();
    ctx.setLineDash([14, 10]);
    ctx.strokeStyle = "rgba(255,255,255,0.55)";
    ctx.lineWidth = 3;
    betelLeafPath(cx, cy, r, r * 1.2);
    ctx.stroke();
    ctx.restore();
    hint.hidden = false;
  }

  function frame(now) {
    if (!running) return;
    const dt = lastTime ? now - lastTime : 16;
    lastTime = now;

    drawVideoCover();

    let detection = null;
    if (video.readyState >= 2) {
      detection = LeafDetector.detect(video);
    }

    if (detection) {
      const px = detection.cx * canvas.width;
      const py = detection.cy * canvas.height;
      const pw = detection.w * canvas.width;
      const ph = detection.h * canvas.height;
      smooth.cx = lerp(smooth.cx, px, SMOOTH_ALPHA);
      smooth.cy = lerp(smooth.cy, py, SMOOTH_ALPHA);
      smooth.w = lerp(smooth.w, pw, SMOOTH_ALPHA);
      smooth.h = lerp(smooth.h, ph, SMOOTH_ALPHA);
      smooth.visible = lerp(smooth.visible, 1, 0.25);
    } else {
      smooth.visible = lerp(smooth.visible, 0, 0.1);
    }

    // Instantaneous (not smoothed) fill ratio, so the "has the user filled
    // the scan area" check reacts immediately rather than lagging behind an
    // EMA — the reticle/hint stays up and the text withholds itself for as
    // long as the leaf is detected but still too small/far.
    const instantFillRatio = detection ? detection.w : 0;

    // Keep showing the full-screen dashed guide (and hint text) until a
    // qualifying leaf — confidently detected AND filling the scan area —
    // actually locks in, rather than hiding it the instant any leaf-colored
    // blob appears.
    if (wasHidden) {
      drawHintReticle();
    } else {
      hint.hidden = true;
    }

    let justLocked = false;
    if (smooth.visible < HIDE_THRESHOLD) {
      wasHidden = true;
    } else if (
      wasHidden &&
      smooth.visible > SHOW_TRIGGER_THRESHOLD &&
      instantFillRatio > FILL_TRIGGER_THRESHOLD
    ) {
      revealStart = now;
      wasHidden = false;
      justLocked = true;
      // smooth.w/h may still be mid-convergence this early (the EMA only
      // started averaging once the leaf came into view, same issue the
      // rotation tracking used to have) — snap to the instantaneous
      // reading so the frozen layout's reference size matches the leaf's
      // real current size, not a lagging average still catching up. Without
      // this, the layout could freeze at a too-small size and wrap text
      // more tightly than the leaf actually needs.
      if (detection) {
        smooth.w = detection.w * canvas.width;
        smooth.h = detection.h * canvas.height;
      }
      Sparkles.clear();
    }

    // The closer the leaf gets (the more of the frame it fills), the more
    // the invitation zooms in past its tracked size, so it stays readable
    // up close instead of shrinking off the edges of a small phone screen.
    // Computed after the possible snap above so it reflects the corrected size.
    const fillRatio = smooth.w / canvas.width;
    const zoomT = clamp01((fillRatio - ZOOM_START) / (ZOOM_END - ZOOM_START));
    const zoom = 1 + easeOut(zoomT) * ZOOM_BOOST;
    const rxNow = (smooth.w * zoom) / 2;
    const ryNow = (smooth.h * zoom) / 2;

    if (justLocked) {
      lockInvitation(rxNow, ryNow);
    }

    let fullyRevealed = false;
    if (smooth.visible > 0.05) {
      ctx.save();
      ctx.globalAlpha = Math.min(1, smooth.visible);
      fullyRevealed = drawInvitationOnLeaf(smooth.cx, smooth.cy, rxNow * 2, ryNow * 2, now, dt);
      ctx.restore();
    }

    if (!invitationAccepted) {
      acceptBtn.classList.toggle("visible", fullyRevealed && smooth.visible > 0.5);
    }

    requestAnimationFrame(frame);
  }

  startBtn.addEventListener("click", async () => {
    await startCamera();
    if (running) requestAnimationFrame(frame);
  });

  switchBtn.addEventListener("click", async () => {
    facingMode = facingMode === "environment" ? "user" : "environment";
    await startCamera();
  });

  snapBtn.addEventListener("click", () => {
    const link = document.createElement("a");
    link.download = "invitation-snapshot.png";
    link.href = canvas.toDataURL("image/png");
    link.click();
  });

  acceptBtn.addEventListener("click", () => {
    invitationAccepted = true;
    running = false;
    stopCamera();
    acceptBtn.classList.remove("visible");
    eCard.hidden = false;
  });

  backBtn.addEventListener("click", () => {
    invitationAccepted = false;
    eCard.hidden = true;
    overlay.hidden = false;
    hint.hidden = true;
    smooth.visible = 0;
    revealStart = null;
    wasHidden = true;
    cachedLayout = null;
    Sparkles.clear();
  });
})();
