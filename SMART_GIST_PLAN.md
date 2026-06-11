# Smart Gist Mode — Implementation Plan (Whisper + Claude)

Status: **planned, not built.** This is the design we'll implement in a later
backend phase, after the current frontend milestone is committed/archived.

## Goal
Replace the dumb "cut at 30s" headline preview with an intelligently chosen
30-second window: skip the station intro/jingle, start on the first real news
beat, and end on a clean sentence boundary — without ever cutting mid-word or
mid-sentence, and without modifying the source audio.

---

## Architecture decision (the important one)

The naïve pipeline (fetch → transcribe → Claude → play) is **synchronous and
blocks playback**, which kills the "first clip starts instantly" behavior we
built. Instead:

**Gist points are computed asynchronously and cached, then pushed to the
client as an SSE enrichment event. Playback never waits on them.**

```
stream begins ──► item sent immediately ──► client plays with FALLBACK gist
                       │                          (5s skip / 30s cut)
                       ▼
            background: ensure_gist(audio_url)
              1. cache hit?  → reuse
              2. fetch first ~90s of audio (ffmpeg/range)
              3. Whisper → word timestamps
              4. Claude → {start,end,reasons}
              5. cache by audio_url
                       │
                       ▼
        SSE event: {type:"gist", audio_url, start, end, reasons}
                       │
                       ▼
   client stores gist on the matching queue item; applies it the NEXT time
   that item starts (never retroactively seeks an already-playing clip)
```

While clip N plays (~30s), clips N+1…N+5 get enriched in the background, so by
the time the user reaches them the smart points are already attached. Cache
means each clip is transcribed **once, ever**.

---

## Backend

### New module: `gist.py`
- `ensure_gist(audio_url, language) -> dict | None`
  - Check cache (see below). On hit, return immediately.
  - `extract_head(audio_url)` — pull the **first ~90s** only (not the whole
    file; clips can be 28-min podcasts). Use `ffmpeg -ss 0 -t 90 -i URL` to a
    temp wav, or an HTTP range request + decode. 90s (not 60s) because some
    bulletins open with 10–20s of jingle/station ID.
  - `transcribe(head)` — Whisper with **word-level timestamps**.
    - Phase-1 provider: **OpenAI Whisper API** (simplest, ~$0.006/min, no local
      compute). Phase-2 option: `faster-whisper` `base` model locally (no
      per-call cost, but adds memory + an `ffmpeg` build dependency).
  - `analyze(transcript, language)` — one small Claude call (reuse the existing
    `anthropic` client + key). Returns `{start_time, end_time, skip_reason,
    end_reason}`. Prompt encodes the start/end rules from the task spec; pass
    the clip language so FR/ES work.
  - Validate + clamp the result (see Pitfalls), cache it, return it.

### Caching
- Key: `audio_url` (RSS episode URLs are immutable, so content is stable).
- Phase 1: in-process `dict` (and/or a small SQLite table so it survives
  restarts — Railway's filesystem is ephemeral, so SQLite in a mounted volume
  or an external store is the durable option; in-memory is fine to start).
- Store: `{start, end, skip_reason, end_reason, duration, model_version}`.
  Include `model_version` so we can invalidate when we change the prompt/model.

### SSE wiring (`/api/playlist/stream`)
- Keep sending `item` events immediately (unchanged — instant start preserved).
- After the playlist is finalized, spawn background enrichment for each item and
  emit `data: {"type":"gist","audio_url":...,"start":...,"end":...,
  "skip_reason":...,"end_reason":...}` as each completes.
- `/api/playlist/continue` returns gist inline if cached, omits it otherwise
  (client falls back).

### Constraints honored
- **Never download/modify the full file** — only the first ~90s is fetched for
  analysis; full-story playback still streams the original URL untouched.
- **Lightweight** — only the first ~90s of transcript is analyzed.
- **Graceful** — any failure (no Whisper, fetch blocked, Claude error, bad
  JSON) logs and returns `None`; client uses the existing fallback.

---

## Frontend (mostly reuses existing machinery)

`player.js` already seeks (`clipAudio.currentTime`), fades (`fadeAudio`/
`fadeClipOut`), has a `cutPoint` + `timeupdate` cut, and `onCutReached()`.
Mapping:

- `item.gist = {start, end}` attached when the SSE `gist` event arrives.
- In `startClip(item)` **for headline (non-full-story) playback only**:
  - `const g = item.gist;`
  - start: after `loadedmetadata`/`canplay`, `clipAudio.currentTime = g.start`,
    set `volume = 0`, then `fadeAudio(clipAudio, 0, 1, 300)` (0.3s fade-in).
  - end: `state.cutPoint = g.end` (the existing `timeupdate` handler already
    fades out `CLIP_FADE_SEC` before and calls `onCutReached`). Set the
    fade-out to 0.5s for gist.
  - If no `item.gist`: current fallback (segment length cut). **No behavior
    change** when gist is absent.
- **Full story** (`Queue Full Story` / No-Headlines): ignore gist entirely —
  play from 0 to natural end. (Already the case via `fullStory`/`cutPoint =
  Infinity`; just make sure the start-seek is gated on `!fullStory && item.gist`.)
- `onGistComplete()` = the existing `onCutReached()` → music bridge → next.
- User actions already exist: **Add to Program = "Queue Full Story"** (appends
  `{...item, fullStory:true}`); **Skip = Next / thumbs-down**; **no action =
  auto-advance**. Reuse them; don't build a parallel `userQueue`.
- Console logging in this phase: log `audio_url`, `start`, `end`, `skip_reason`,
  `end_reason` when a gist is applied.

---

## Pitfalls we'd regret later (and the guard for each)

1. **Seeking before metadata is ready** — setting `currentTime` before
   `loadedmetadata` is ignored or resets to 0. → Apply the start-seek on the
   `loadedmetadata`/`canplay` event, not synchronously in `startClip`.
2. **Retroactive seek mid-playback** — a `gist` SSE event can arrive *after* a
   clip already started raw. Jumping then is jarring. → Only apply gist when the
   item *starts*; never seek a clip that's already playing. (It still benefits
   next time, e.g. on replay.)
3. **end_time past clip duration / clip shorter than 30s** — clamp
   `end = min(end, duration)`; if `duration < start + ~10s`, drop the gist and
   fall back. Whisper gives us `duration` of the head; use audio metadata for
   the true length.
4. **Off-by/mid-word cuts** — use **word-level** timestamps; snap `start` to a
   word *start* and `end` to a word *end*; add ~150ms padding so we never clip a
   consonant.
5. **First 90s is all intro** (long jingles) — if no valid start found in the
   window, fall back to the 5s/30s default rather than returning garbage.
6. **Cost runaway** — without caching, every page load re-transcribes. Caching
   by `audio_url` is **mandatory**, not optional.
7. **Railway ephemeral FS** — in-memory cache is wiped on each deploy/restart;
   acceptable short-term, but plan an external/volume-backed cache before this
   matters at scale.
8. **`ffmpeg` availability** — required for head extraction (and local Whisper).
   Add it to the Nixpacks build (`aptPkgs`/`nixPkgs`) — easy to forget.
9. **CDN range/hotlink restrictions** — some feeds may reject partial/range
   requests or need a `User-Agent`. Reuse the existing feed `User-Agent`; on
   failure, fall back (don't crash).
10. **Non-English clips** — pass language to both Whisper and Claude; the
    skip/end keyword rules in the prompt must be language-aware (or rely on
    Claude's understanding rather than literal English keyword lists).
11. **`timeupdate` granularity** — fires ~4×/sec, so the cut lands within
    ~250ms of `end_time`. The 0.5s fade-out absorbs this; don't expect
    sample-accurate stops.
12. **`+10s` (Add Time) vs gist end** — extending should push `cutPoint` past
    `gist.end` (already works, since Add Time mutates `cutPoint`); just confirm
    it cancels the gist fade-out.
13. **Claude returns invalid JSON / hallucinated times** — validate shape and
    numeric ranges; on any violation, fall back. Never trust raw model output.

---

## Suggested phasing (de-risk before paying for Whisper+Claude)

- **Phase 0 (now):** ship the frontend; this doc archived with the milestone.
- **Phase A — rules-first, cheap:** Whisper head transcription + **deterministic
  start/end in code** (first segment after intro; nearest sentence boundary to
  ~30s). No Claude. Fully loggable; lets us judge gist quality and the
  async/caching plumbing in isolation. *(Even cheaper baseline to compare:
  `ffmpeg silencedetect` to find speech onset + sentence pauses, no
  transcription at all.)*
- **Phase B — add Claude** only where rules underperform (named-entity / "is
  this a clean self-contained sentence" judgments are where the LLM earns its
  cost). Same cache/SSE plumbing; swap the `analyze()` implementation.

## Definition of done (Phase A/B)
- Gist points computed async, cached by `audio_url`, delivered via SSE.
- Headline playback seeks + fades in/out; full-story playback unaffected.
- Fallback path verified by disabling Whisper (no crash, raw 30s).
- Quick Start still starts instantly.
- start/end/reasons logged to console.
