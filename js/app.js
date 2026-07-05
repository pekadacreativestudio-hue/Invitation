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
  // item (hero logo/word, message lines) fades + scales in with a sparkle
  // burst, staggered in a cascade rather than a per-character typewriter.
  let revealStart = null;
  let wasHidden = true;
  const HIDE_THRESHOLD = 0.12;
  const SHOW_TRIGGER_THRESHOLD = 0.55;
  const ITEM_STAGGER_MS = 260;
  const ITEM_DURATION_MS = 700;

  // An uploaded logo (assets/hero-logo.png) is drawn on the leaf in place of
  // the hero word text, if present. Probed once at load time; falls back to
  // the styled text hero word if missing.
  let heroLogo = null;
  const heroLogoProbe = new Image();
  heroLogoProbe.onload = () => {
    heroLogo = heroLogoProbe;
  };
  heroLogoProbe.src = "assets/hero-logo.png";

  // The text layout (wrapping, font sizes, positions) is computed ONCE per
  // "capture" — the moment the leaf locks in — and cached here. After that,
  // the leaf moving/zooming/tilting only pans, scales, and rotates this
  // frozen layout; it never re-wraps or re-arranges.
  let cachedLayout = null;

  // Leaf tilt tracking: the detector's axis angle is ambiguous by 180° (it's
  // a line, not a direction), so we track it as a smoothed double-angle unit
  // vector, and only ever use the *change* since lock (not the raw absolute
  // angle) — clamped, so a noisy detection can't flip the invitation upside
  // down or spin it wildly.
  let angleVec = { cos: 1, sin: 0 };
  let lockAngleBaseline = 0;
  const ANGLE_ALPHA = 0.15;
  const MIN_ANGLE_CONFIDENCE = 0.12;
  const MAX_TILT = (35 * Math.PI) / 180;

  function wrapAxisDelta(delta) {
    let d = delta;
    while (d > Math.PI / 2) d -= Math.PI;
    while (d <= -Math.PI / 2) d += Math.PI;
    return d;
  }

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

  document.getElementById("overlayHero").textContent = INVITE_CONFIG.heroWord;

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

  // Lays out just the hero (logo image, or styled hero word) and the message
  // body into individual renderable items with resolved size/position
  // (relative to the given center/half-height), but does not paint anything
  // yet. Returns the items plus the total height they need, so the caller
  // can shrink everything uniformly if it doesn't fit.
  function layoutInvitation(cx, cy, rx, ry) {
    const unit = ry * 2;
    const rendered = [];

    const heroMaxWidthPx = rx * 2 * 0.74;
    if (heroLogo) {
      const heroMaxHeightPx = unit * 0.22;
      const scale = Math.min(heroMaxWidthPx / heroLogo.naturalWidth, heroMaxHeightPx / heroLogo.naturalHeight);
      rendered.push({
        type: "logo",
        img: heroLogo,
        width: heroLogo.naturalWidth * scale,
        height: heroLogo.naturalHeight * scale,
        gap: 0.13,
      });
    } else {
      let fontSize = Math.max(8, unit * 0.062);
      const fontFor = (size) => "normal 700 " + size + "px " + SERIF_FONT;
      ctx.font = fontFor(fontSize);
      const longestWord = INVITE_CONFIG.heroWord
        .split(" ")
        .reduce((a, w) => (ctx.measureText(w).width > ctx.measureText(a).width ? w : a), "");
      while (fontSize > 8 && ctx.measureText(longestWord).width > heroMaxWidthPx) {
        fontSize *= 0.92;
        ctx.font = fontFor(fontSize);
      }
      ctx.font = fontFor(fontSize);
      for (const l of wrapLines(INVITE_CONFIG.heroWord, heroMaxWidthPx)) {
        ctx.font = fontFor(fontSize);
        rendered.push({
          type: "text",
          text: l,
          size: fontSize,
          weight: "700",
          family: SERIF_FONT,
          italic: false,
          gold: true,
          gap: 0.095,
          width: ctx.measureText(l).width,
        });
      }
    }

    const msgMaxWidthPx = rx * 2 * 0.66;
    let msgFontSize = Math.max(8, unit * 0.042);
    const msgFontFor = (size) => "italic 400 " + size + "px " + SERIF_FONT;
    ctx.font = msgFontFor(msgFontSize);
    const longestMsgWord = INVITE_CONFIG.message
      .split(" ")
      .reduce((a, w) => (ctx.measureText(w).width > ctx.measureText(a).width ? w : a), "");
    while (msgFontSize > 8 && ctx.measureText(longestMsgWord).width > msgMaxWidthPx) {
      msgFontSize *= 0.92;
      ctx.font = msgFontFor(msgFontSize);
    }
    ctx.font = msgFontFor(msgFontSize);
    wrapLines(INVITE_CONFIG.message, msgMaxWidthPx).forEach((l, i) => {
      ctx.font = msgFontFor(msgFontSize);
      rendered.push({
        type: "text",
        text: l,
        size: msgFontSize,
        weight: "400",
        family: SERIF_FONT,
        italic: true,
        gold: false,
        gap: i === 0 ? 0.16 : 0.062, // extra gap before the first message line stands in for the blank line
        width: ctx.measureText(l).width,
      });
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
  // wipe), with a soft gold bloom, a crisp fill (gradient for the hero
  // word), and a moving highlight sweep once revealed.
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
  }

  // Paints the hero logo materializing in the same way as a text line:
  // fade + settle from slightly oversized, with a soft gold glow.
  function paintLogo(item, progress) {
    if (progress <= 0) return;
    const eased = easeOut(clamp01(progress));
    const cx = item.x0 + item.width / 2;
    const cy = item.y;

    ctx.save();
    ctx.globalAlpha *= eased;
    ctx.translate(cx, cy);
    ctx.scale(1.18 - 0.18 * eased, 1.18 - 0.18 * eased);
    ctx.shadowColor = "rgba(255, 195, 80, 0.65)";
    ctx.shadowBlur = item.height * 0.18;
    ctx.drawImage(item.img, -item.width / 2, -item.height / 2, item.width, item.height);
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

  function drawInvitationOnLeaf(cx, cy, w, h, angle, now, dt) {
    if (!cachedLayout) return false;
    const rx = w / 2;
    const ry = h / 2;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle);
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

      if (item.type === "logo") {
        paintLogo(item, progress);
      } else {
        paintLine(item, 0, progress, now);
      }
    }

    // Clip region is already the rotated/scaled leaf shape (set above, still
    // active). Reset the CTM to identity so sparkles draw in the same
    // absolute coordinates their persisted x/y were computed in, while
    // staying confined to the tilted leaf outline via the still-active clip.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    Sparkles.spawnAmbient({ cx, cy, rx: rx * 0.85, ry: ry * 0.85 }, dt, 6);
    Sparkles.draw(ctx);

    ctx.restore();

    return allDone;
  }

  function drawHintReticle() {
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    const r = Math.min(canvas.width, canvas.height) * 0.32;
    ctx.save();
    ctx.setLineDash([10, 8]);
    ctx.strokeStyle = "rgba(255,255,255,0.55)";
    ctx.lineWidth = 2;
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
      hint.hidden = true;

      if (detection.angleConfidence > MIN_ANGLE_CONFIDENCE) {
        const a = ANGLE_ALPHA * detection.angleConfidence;
        angleVec.cos = lerp(angleVec.cos, Math.cos(2 * detection.angle), a);
        angleVec.sin = lerp(angleVec.sin, Math.sin(2 * detection.angle), a);
      }
    } else {
      smooth.visible = lerp(smooth.visible, 0, 0.1);
      if (smooth.visible < 0.05) drawHintReticle();
    }

    // The closer the leaf gets (the more of the frame it fills), the more
    // the invitation zooms in past its tracked size, so it stays readable
    // up close instead of shrinking off the edges of a small phone screen.
    const fillRatio = smooth.w / canvas.width;
    const zoomT = clamp01((fillRatio - ZOOM_START) / (ZOOM_END - ZOOM_START));
    const zoom = 1 + easeOut(zoomT) * ZOOM_BOOST;
    const rxNow = (smooth.w * zoom) / 2;
    const ryNow = (smooth.h * zoom) / 2;

    if (smooth.visible < HIDE_THRESHOLD) {
      wasHidden = true;
    } else if (wasHidden && smooth.visible > SHOW_TRIGGER_THRESHOLD) {
      revealStart = now;
      wasHidden = false;
      // The angle EMA may still be mid-convergence this early (it only
      // started accumulating once the leaf came into view) — snap it to
      // the instantaneous reading so "zero rotation" is defined from the
      // real current tilt, not a lagging average that would otherwise keep
      // drifting toward the true value for the next second or two, which
      // would look like spurious rotation even on a leaf that never moved.
      if (detection) {
        angleVec = { cos: Math.cos(2 * detection.angle), sin: Math.sin(2 * detection.angle) };
      }
      lockAngleBaseline = 0.5 * Math.atan2(angleVec.sin, angleVec.cos);
      lockInvitation(rxNow, ryNow);
      Sparkles.clear();
    }

    // Rotation applied to the frozen layout is the *change* in leaf tilt
    // since it was captured — not the raw absolute angle — so an ambiguous
    // or noisy detection can't flip the invitation upside down.
    const absoluteAngle = 0.5 * Math.atan2(angleVec.sin, angleVec.cos);
    const renderAngle = Math.max(
      -MAX_TILT,
      Math.min(MAX_TILT, wrapAxisDelta(absoluteAngle - lockAngleBaseline))
    );

    let fullyRevealed = false;
    if (smooth.visible > 0.05) {
      ctx.save();
      ctx.globalAlpha = Math.min(1, smooth.visible);
      fullyRevealed = drawInvitationOnLeaf(smooth.cx, smooth.cy, rxNow * 2, ryNow * 2, renderAngle, now, dt);
      ctx.restore();
    }

    if (!invitationAccepted) {
      acceptBtn.classList.toggle("visible", fullyRevealed && smooth.visible > 0.5);
    }

    requestAnimationFrame(frame);
  }

  // Prefers a designer-provided e-invitation image (assets/e-invitation.png)
  // over the generated text card. Drop a PNG at that path and it takes over
  // automatically — no code changes needed.
  function populateECard() {
    const eCardImage = document.getElementById("eCardImage");
    const eCardContent = document.getElementById("eCardContent");
    const probe = new Image();
    probe.onload = () => {
      eCardImage.src = probe.src;
      eCardImage.hidden = false;
      eCardContent.hidden = true;
    };
    probe.onerror = () => {
      eCardImage.hidden = true;
      eCardContent.hidden = false;
    };
    probe.src = "assets/e-invitation.png";

    document.getElementById("eCardHero").textContent = INVITE_CONFIG.heroWord;
    document.getElementById("eCardMessage").textContent = INVITE_CONFIG.message;
    document.getElementById("eCardDate").textContent = "Date : " + INVITE_CONFIG.date;
    document.getElementById("eCardVenue").textContent = "Venue : " + INVITE_CONFIG.venue;
    document.getElementById("eCardDressCode").textContent = INVITE_CONFIG.dressCode;

    const list = document.getElementById("eCardTimeline");
    list.innerHTML = "";
    for (const item of INVITE_CONFIG.timeline) {
      const li = document.createElement("li");
      const time = document.createElement("span");
      time.className = "time";
      time.textContent = item.time;
      const activity = document.createElement("span");
      activity.textContent = item.activity;
      li.append(time, activity);
      list.appendChild(li);
    }
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
    populateECard();
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
    angleVec = { cos: 1, sin: 0 };
    lockAngleBaseline = 0;
    Sparkles.clear();
  });
})();
