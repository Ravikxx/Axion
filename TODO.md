# Axion TODO — next features

- **Upload profile picture** in account settings. Not urgent — nice-to-have polish, not blocking anything.
  Store the image in Cloudflare R2 (or Cloudflare Images for automatic resizing), not D1. Needs: an upload
  endpoint with file-type/size validation, a new R2 bucket + binding, a D1 column for the avatar URL, and
  frontend file-picker UI in settings.html.

- **"Slow mode" for chat** — a user-facing toggle that routes a request to the old Hugging Face Space
  (CPU inference, same Lumen 1.2.5 weights, just ~220s instead of ~2-3s) instead of the RunPod GPU backend.
  Deferred: at current traffic, RunPod's GPU-second cost is already tiny, so the savings from offloading to
  HF probably don't justify reviving and permanently maintaining a second inference backend (the Gradio
  submit/poll/SSE adapter that was deliberately removed from `lumen-upstream.js` this session). Worth
  revisiting if traffic grows enough for RunPod cost to matter, or if RunPod reliability becomes a recurring
  problem and this doubles as a fallback. The user has a more ambitious idea building on this — ask before
  starting, don't assume the scope above is the final shape.