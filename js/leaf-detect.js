// Lightweight, dependency-free "leaf finder".
// Downsamples the video frame, flags glossy-green pixels, finds the
// largest connected blob of them (flood fill on the small grid), and
// returns its bounding box scaled back up to full frame coordinates.
// This is a color-segmentation heuristic, not real object recognition —
// it is tuned for a single glossy green betel leaf against skin/background.

const LeafDetector = (() => {
  const SAMPLE_W = 96;
  const SAMPLE_H = 72;

  let sampleCanvas, sampleCtx;

  function ensureCanvas() {
    if (!sampleCanvas) {
      sampleCanvas = document.createElement("canvas");
      sampleCanvas.width = SAMPLE_W;
      sampleCanvas.height = SAMPLE_H;
      sampleCtx = sampleCanvas.getContext("2d", { willReadFrequently: true });
    }
  }

  function isLeafGreen(r, g, b) {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const brightness = (r + g + b) / 3;
    if (brightness < 18 || brightness > 235) return false;
    if (max - min < 12) return false; // too gray/desaturated
    // Green must clearly dominate red and blue (glossy leaf, not yellow-green background)
    return g > r * 1.12 && g > b * 1.05 && g - min > 15;
  }

  function largestBlob(mask, w, h) {
    const visited = new Uint8Array(w * h);
    let best = null;
    let bestSize = 0;
    const stack = [];

    for (let start = 0; start < w * h; start++) {
      if (!mask[start] || visited[start]) continue;

      let minX = w, maxX = 0, minY = h, maxY = 0, size = 0;
      let sumX = 0, sumY = 0, sumXX = 0, sumYY = 0, sumXY = 0;
      stack.length = 0;
      stack.push(start);
      visited[start] = 1;

      while (stack.length) {
        const idx = stack.pop();
        const x = idx % w;
        const y = (idx / w) | 0;
        size++;
        sumX += x;
        sumY += y;
        sumXX += x * x;
        sumYY += y * y;
        sumXY += x * y;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;

        const neighbors = [idx - 1, idx + 1, idx - w, idx + w];
        for (const n of neighbors) {
          if (n < 0 || n >= w * h) continue;
          if (n % w === 0 && idx % w === w - 1) continue;
          if (n % w === w - 1 && idx % w === 0) continue;
          if (!visited[n] && mask[n]) {
            visited[n] = 1;
            stack.push(n);
          }
        }
      }

      if (size > bestSize) {
        bestSize = size;
        best = { minX, maxX, minY, maxY, size, sumX, sumY, sumXX, sumYY, sumXY };
      }
    }

    return best;
  }

  // PCA orientation of the blob's major axis, in radians. Ambiguous by 180°
  // (a line, not a direction) and correcting for the sample grid's aspect
  // ratio possibly differing from the source video's. Also returns a 0-1
  // confidence (how elongated the blob is) since a near-circular blob has
  // no meaningful axis and would otherwise produce a noisy angle.
  function blobOrientation(blob, scaleX, scaleY) {
    const n = blob.size;
    const meanX = blob.sumX / n;
    const meanY = blob.sumY / n;
    let mu20 = blob.sumXX / n - meanX * meanX;
    let mu02 = blob.sumYY / n - meanY * meanY;
    let mu11 = blob.sumXY / n - meanX * meanY;
    // Correct for independent x/y scaling between sample grid and source video.
    mu20 *= scaleX * scaleX;
    mu02 *= scaleY * scaleY;
    mu11 *= scaleX * scaleY;

    const angle = 0.5 * Math.atan2(2 * mu11, mu20 - mu02);
    const spread = mu20 + mu02;
    const eccentricity = spread > 1e-6 ? Math.sqrt((mu20 - mu02) ** 2 + 4 * mu11 * mu11) / spread : 0;
    return { angle, confidence: Math.max(0, Math.min(1, eccentricity)) };
  }

  // Returns { x, y, w, h, cx, cy } in [0,1] normalized frame coordinates,
  // or null if no confident leaf-shaped blob was found.
  function detect(videoEl) {
    if (!videoEl.videoWidth) return null;
    ensureCanvas();
    sampleCtx.drawImage(videoEl, 0, 0, SAMPLE_W, SAMPLE_H);
    const { data } = sampleCtx.getImageData(0, 0, SAMPLE_W, SAMPLE_H);

    const mask = new Uint8Array(SAMPLE_W * SAMPLE_H);
    let total = 0;
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      if (isLeafGreen(data[i], data[i + 1], data[i + 2])) {
        mask[p] = 1;
        total++;
      }
    }

    const minPixels = SAMPLE_W * SAMPLE_H * 0.02; // at least ~2% of frame
    if (total < minPixels) return null;

    const blob = largestBlob(mask, SAMPLE_W, SAMPLE_H);
    if (!blob || blob.size < minPixels) return null;

    const bw = blob.maxX - blob.minX + 1;
    const bh = blob.maxY - blob.minY + 1;
    // Reject implausibly thin slivers (stray green pixels, not a leaf)
    const density = blob.size / (bw * bh);
    if (density < 0.25) return null;

    const { angle, confidence } = blobOrientation(blob, videoEl.videoWidth / SAMPLE_W, videoEl.videoHeight / SAMPLE_H);

    return {
      x: blob.minX / SAMPLE_W,
      y: blob.minY / SAMPLE_H,
      w: bw / SAMPLE_W,
      h: bh / SAMPLE_H,
      cx: (blob.minX + bw / 2) / SAMPLE_W,
      cy: (blob.minY + bh / 2) / SAMPLE_H,
      angle,
      angleConfidence: confidence,
    };
  }

  return { detect };
})();
