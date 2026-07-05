# AR Betel Leaf Invitation

Open this page on a phone, hold a real betel leaf on your palm, and point
the camera at it. The hero title and invitation message materialize onto
the leaf in a magical fade/sparkle effect, and track it as you move your
hand. Once fully appeared, an **Accept Invitation** button fades in;
tapping it opens a full scrollable e-invitation with the date, venue, dress
code, and time line.

## How it works

- `js/leaf-detect.js` downsamples each camera frame and flags glossy-green
  pixels (tuned for a betel leaf's color), then finds the largest connected
  blob of those pixels via flood fill. That gives a bounding box for "the leaf".
- `js/app.js` smooths that box frame-to-frame (so the text doesn't jitter),
  clips the invitation text to a heart-shaped path matching a real betel
  leaf's silhouette (`betelLeafPath`), and redraws it every frame — giving
  the effect of text "painted" onto the leaf. The leaf itself is left
  untouched (no darkening overlay) — only the gold text is drawn over it.
- A dashed heart-shaped reticle guides you to the target while scanning;
  it disappears the moment a leaf is detected, and no outline is drawn
  around the leaf once tracking begins.
- As the leaf fills more of the frame (you move the phone closer), the whole
  invitation zooms in beyond its tracked size (see `ZOOM_START`/`ZOOM_END`/
  `ZOOM_BOOST` in `js/app.js`) so the text stays comfortably readable up
  close instead of just scaling 1:1 with the leaf.
- No build step and no runtime dependencies besides two Google Fonts
  (`Great Vibes` for the script hero word, `Cormorant Garamond` for the
  supporting serif text), loaded via a `<link>` in `index.html` — the page
  needs internet access once to fetch those, same as any font-hosted site.
  Camera access uses the standard `getUserMedia` API, which requires HTTPS
  (or `localhost`) — GitHub Pages serves over HTTPS, so it works out of the box.
- `js/sparkle-fx.js` is a small particle system: twinkling gold glints drift
  ambiently around the leaf, plus a scattered burst the instant each item
  starts appearing.
- Only the hero word and the invitation message appear on the leaf (kept
  short on purpose — the heart shape narrows a lot at the top and bottom,
  so less content fits comfortably there). Date, venue, dress code, and
  time line only appear on the full e-invitation after Accept is tapped.
- Each item materializes with a fade + scale-settle (from slightly oversized
  down to full size) plus a gold bloom and moving highlight sweep, cascading
  top to bottom with overlapping stagger — not a left-to-right typewriter —
  restarting each time the leaf reappears after being hidden.
- If a file exists at `assets/hero-logo.png`, it's drawn on the leaf (with
  the same materialize animation) in place of the styled hero word text —
  probed once at page load, falling back to text if missing. It's
  deliberately only used on the leaf, not the landing screen, so scanning
  still reveals it as a surprise.
- The landing screen itself will use `assets/welcome-bg.jpg` (preferred) or
  `assets/welcome-bg.png` as its background if present, with a tinted scrim
  over it for legibility, instead of the plain cream gradient.
- The wrapping/font-size layout is computed **once**, the moment the leaf
  locks in (`lockInvitation` in `js/app.js`), using the leaf's size at that
  instant as the reference frame. After that, moving/zooming/tilting the
  leaf only pans, scales, and rotates that frozen layout via a canvas
  transform — it never re-wraps or re-arranges, so the text doesn't visibly
  shuffle around as your hand moves.
- Leaf tilt is estimated via PCA on the detected blob (`blobOrientation` in
  `js/leaf-detect.js`) and applied as a rotation. Because an axis angle is
  ambiguous by 180° (it's a line, not a direction), only the *change* in
  tilt since lock is used — not the raw absolute angle — and it's clamped
  to ±35°, so a noisy reading can't flip the invitation upside down.
- Once every item has finished materializing, an **Accept Invitation** button
  fades in (`js/app.js`, driven by the reveal-complete flag). Tapping it stops the
  camera and shows `#eCard`. By default that's a plain HTML/CSS page
  populated from `INVITE_CONFIG` with the full message, date, venue, dress
  code, and time line — but if a file exists at `assets/e-invitation.png`,
  that image is shown instead automatically (see below). A **Back** button
  returns to the landing screen.

## Using a designed e-invitation image instead of the generated card

Drop your own designed e-invitation as a PNG at `assets/e-invitation.png`.
`js/app.js` probes for that file when Accept is tapped — if it loads, the
image replaces the generated text card entirely; if it's missing, the text
card is shown as a fallback. No code changes needed, just add the file.

The fallback card's look (cream/botanical background, green script title,
brown/gold info band, ornamental dividers, time line) is styled in
`css/style.css` to match a purchased "Blessings of Healing" invitation
design, so it looks reasonably close even without a custom PNG.

This is a color-based heuristic, not real object recognition. It works best
with a single leaf held against skin or a plain background, good lighting,
and the leaf reasonably close to the camera. There's a dashed heart-shaped
reticle shown until a leaf is detected.

Text is laid out within a "safe interior band" of the heart shape (`safeCy`/
`safeHalfHeight` in `drawInvitationOnLeaf`), not the full height, since the
silhouette narrows sharply at the top notch and bottom tip — content placed
across the full height would get clipped there. On top of that, the whole
block is auto-shrunk (a canvas scale transform) if it still doesn't fit, so
it's never clipped regardless of leaf shape/aspect ratio or message length.

## Customize your wording

Edit `js/config.js` — that's the only file you need to touch for your event
details:

```js
const INVITE_CONFIG = {
  heroWord: "🍀 Blessings of Healing 🍀",
  message:
    "You are honorably invited to awaken your inherent healing gifts. Join us to uncover the deep methods of bringing healing to others.",
  date: "19th July 2026",
  venue: "Hilton Colombo | Onyx",
  dressCode: "Traditional attire, Ethnic attire or Ethereal Attire (comfortable for meditations)",
  timeline: [
    { time: "7:30am – 9:30am", activity: "Theory Training" },
    { time: "9:30am – 10:00am", activity: "Q&A" },
    { time: "10:00am – 10:45am", activity: "Harmonious Pause & Refreshments" },
    { time: "10:45am – 11:45am", activity: "Meditation" },
  ],
};
```

`heroWord` and `message` appear on the leaf; `date`, `venue`, `dressCode`,
and `timeline` appear only on the full e-invitation after Accept is tapped,
since they're too much text to fit gracefully on a small leaf-tracked AR
overlay.

## Run it locally

Any static file server works, e.g.:

```bash
python3 -m http.server 8080
```

Then open `http://localhost:8080` (camera works on `localhost` without HTTPS).

## Deploy with GitHub Pages

1. Push this repo to GitHub (already done if you're reading this from the repo).
2. In the repo, go to **Settings → Pages**.
3. Under **Build and deployment → Source**, choose **Deploy from a branch**,
   pick this branch and the `/ (root)` folder, then save.
4. GitHub will give you a URL like
   `https://<user>.github.io/<repo>/` — share that link. It serves over
   HTTPS automatically, so the camera will work on any phone.
