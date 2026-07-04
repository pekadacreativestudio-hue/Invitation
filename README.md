# AR Betel Leaf Invitation

Open this page on a phone, hold a real betel leaf on your palm, and point the
camera at it. The invitation wording appears overlaid directly on the leaf
and tracks it as you move your hand — a simple augmented-reality invite.

## How it works

- `js/leaf-detect.js` downsamples each camera frame and flags glossy-green
  pixels (tuned for a betel leaf's color), then finds the largest connected
  blob of those pixels via flood fill. That gives a bounding box for "the leaf".
- `js/app.js` smooths that box frame-to-frame (so the text doesn't jitter),
  clips a soft dark scrim + the invitation text to an ellipse matching the
  leaf's box, and redraws it every frame — giving the effect of text
  "painted" onto the leaf.
- No external libraries, no build step, no network calls after the page loads.
  Camera access uses the standard `getUserMedia` API, which requires HTTPS
  (or `localhost`) — GitHub Pages serves over HTTPS, so it works out of the box.

This is a color-based heuristic, not real object recognition. It works best
with a single leaf held against skin or a plain background, good lighting,
and the leaf reasonably close to the camera. There's a dashed reticle shown
until a leaf is detected, and a "Preview without camera" button for testing
the wording/layout without a real leaf.

## Customize your wording

Edit `js/config.js` — that's the only file you need to touch for your event
details:

```js
const INVITE_CONFIG = {
  eventName: "Betel Leaf Ceremony",
  greeting: "You're Cordially Invited",
  hostNames: "The Family of ___ & ___",
  date: "DD Month YYYY",
  time: "H:MM AM/PM",
  venue: "Venue Name, City",
  message: "Please join us in celebration and blessings",
};
```

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
