"""
Smart Gist — pick a ~30s "just the gist" window from a news clip.

PHASE A (this file): rules-based. Fetch the first ~90s of audio, transcribe it
with Groq Whisper, then choose a start/end with deterministic rules (skip the
station intro, start on the first news beat, end on a clean sentence boundary).

This module is intentionally STANDALONE — app.py does not import it yet. Run it
directly to validate before any integration:

    python gist.py --selftest                 # offline: exercises the rules only
    python gist.py "<audio_url>" [lang]        # real: needs GROQ_API_KEY + network

Everything fails SOFT: any error returns None so the caller can fall back to the
current raw-30s behavior. Nothing here changes app behavior until we wire it in.
"""
import os
import sys
import json
import logging

import requests as req

log = logging.getLogger("tern.gist")

# ── Config ──────────────────────────────────────────────────────────────────
GROQ_URL        = "https://api.groq.com/openai/v1/audio/transcriptions"
GROQ_MODEL      = "whisper-large-v3-turbo"   # fast + cheap; good enough for headlines
HEAD_BYTES      = 2_000_000                   # ~90-120s of audio is plenty for a 30s gist
HTTP_TIMEOUT    = 20

# Gist window targets (seconds)
TARGET_LO       = 28
TARGET_HI       = 32
TARGET_HARD     = 35
DEFAULT_SKIP    = 8.0

# ── Rule vocabularies ───────────────────────────────────────────────────────
# Phrases that signal an intro/jingle/station ID we want to skip past.
INTRO_MARKERS = (
    "good morning", "good afternoon", "good evening", "you're listening",
    "you are listening", "welcome back", "welcome to", "this is", "i'm ",
    "coming up", "stay with us", "brought to you", "from npr", "bbc news",
    "nhk", "this is the", "headlines", "top stories", "[music]", "(music)",
    "jingle", "world radio",
)
# A real news beat: an action verb or a time reference.
NEWS_VERBS = (
    "confirmed", "announced", "killed", "signed", "erupted", "reported",
    "warned", "declared", "launched", "voted", "died", "attacked", "arrested",
    "agreed", "resigned", "elected", "struck", "passed", "ruled", "found",
    "accused", "rejected", "approved", "imposed", "fled", "clashed",
)
TIME_REFS = (
    "today", "tonight", "overnight", "this morning", "this afternoon",
    "this evening", "this week", "yesterday", "earlier", "on monday",
    "on tuesday", "on wednesday", "on thursday", "on friday", "on saturday",
    "on sunday",
)
# Tails that lead into something unresolved — never END on these.
TRANSITION_TAILS = (
    "coming up", "more on this", "our correspondent", "stay with us",
    "after the break", "reporting live", "more after", "we'll have more",
    "next", "joining us", "let's go", "live in",
)

# In-memory cache, keyed by audio_url. RSS episode URLs are immutable, so a
# given clip is transcribed at most once per process. (A durable cache comes
# later; see SMART_GIST_PLAN.md.)
_CACHE = {}


# ── Rule helpers ────────────────────────────────────────────────────────────
def _has_news_signal(text):
    t = text.lower()
    return any(v in t for v in NEWS_VERBS) or any(r in t for r in TIME_REFS)


def _is_intro(text):
    t = text.lower()
    return any(m in t for m in INTRO_MARKERS)


def _ends_sentence(text):
    return text.strip().endswith((".", "?", "!"))


def _is_transitional(text):
    tail = text.lower().strip()[-45:]
    return any(p in tail for p in TRANSITION_TAILS)


def pick_start(segments):
    """First real news beat; skip intro. Returns (start_seconds, reason)."""
    for seg in segments:
        if seg["start"] > 25:           # don't hunt for the start too deep in
            break
        if _is_intro(seg["text"]) and not _has_news_signal(seg["text"]):
            continue                     # skip a pure intro/jingle line
        if _has_news_signal(seg["text"]):
            return seg["start"], f'first news beat: "{seg["text"].strip()[:70]}"'
    # No clear signal: default to an 8s skip, snapped to a segment boundary.
    for seg in segments:
        if seg["end"] >= DEFAULT_SKIP:
            return max(seg["start"], DEFAULT_SKIP), "no clear signal — default 8s skip"
    return DEFAULT_SKIP, "no usable segments — default 8s skip"


def pick_end(segments, start):
    """Clean sentence boundary near ~30s after start. (end, reason).

    Priority: (1) clean sentence in the ideal 28-32s window, (2) nearest clean
    sentence in [start+20, start+35], (3) any clean sentence, (4) last resort a
    non-transitional segment end. A "clean" end completes a sentence and does
    NOT trail into a transitional phrase — we never end on those, even if it
    means a slightly shorter gist.
    """
    lo, hi, hard = start + TARGET_LO, start + TARGET_HI, start + TARGET_HARD
    soft_lo = start + 20            # tolerate a slightly-short clean cut over a bad one
    target  = start + 30

    clean = [s for s in segments
             if start + 10 < s["end"] <= hard
             and _ends_sentence(s["text"]) and not _is_transitional(s["text"])]

    ideal = [s for s in clean if lo <= s["end"] <= hi]
    if ideal:
        s = min(ideal, key=lambda s: abs(s["end"] - target))
        return s["end"], f"complete sentence at {s['end']:.1f}s"

    near = [s for s in clean if soft_lo <= s["end"] <= hard]
    if near:
        s = min(near, key=lambda s: abs(s["end"] - target))
        return s["end"], f"nearest clean sentence at {s['end']:.1f}s"

    if clean:
        s = min(clean, key=lambda s: abs(s["end"] - target))
        return s["end"], f"clean sentence at {s['end']:.1f}s"

    # Last resort: nearest NON-transitional segment end — never a transitional tail.
    safe = [s for s in segments
            if start + 12 < s["end"] <= hard and not _is_transitional(s["text"])]
    if safe:
        s = min(safe, key=lambda s: abs(s["end"] - target))
        return s["end"], f"no sentence boundary — segment end {s['end']:.1f}s"
    last = segments[-1]["end"] if segments else target
    return min(target, last), "no boundary — raw ~30s"


def pick_gist(segments, duration=None):
    """Run the rules over Whisper segments → validated gist dict (or None)."""
    if not segments:
        return None
    start, skip_reason = pick_start(segments)
    end, end_reason = pick_end(segments, start)

    # ── Validate + clamp (never trust the window blindly) ──
    if duration:
        end = min(end, duration)
    end = min(end, start + TARGET_HARD)
    if end - start < 10:                 # too short to be a useful gist
        return None
    return {
        "start_time": round(float(start), 2),
        "end_time":   round(float(end), 2),
        "skip_reason": skip_reason,
        "end_reason":  end_reason,
        "source": "rules",
    }


# ── Audio + transcription ───────────────────────────────────────────────────
def _fetch_head(audio_url):
    """Grab the first ~HEAD_BYTES of the clip via an HTTP range request.

    Avoids downloading 28-minute podcasts in full and avoids an ffmpeg
    dependency. A truncated MP3 transcribes fine (frame-based); truncated
    MP4/m4a may not decode — in that case transcription fails and we fall back.
    """
    headers = {"User-Agent": "TernRadio/1.0", "Range": f"bytes=0-{HEAD_BYTES - 1}"}
    r = req.get(audio_url, headers=headers, timeout=HTTP_TIMEOUT, stream=True)
    r.raise_for_status()
    data = r.content[:HEAD_BYTES]
    if not data:
        raise ValueError("empty audio head")
    return data


def _transcribe(audio_bytes, audio_url, language=None):
    """Transcribe via Groq Whisper. Returns (segments, duration)."""
    api_key = os.getenv("GROQ_API_KEY")
    if not api_key:
        raise ValueError("GROQ_API_KEY not configured")

    ext = "mp3"
    low = audio_url.lower()
    for e in ("mp3", "m4a", "ogg", "wav", "aac"):
        if f".{e}" in low:
            ext = e
            break

    files = {"file": (f"clip.{ext}", audio_bytes)}
    data = {"model": GROQ_MODEL, "response_format": "verbose_json"}
    if language and language in ("en", "fr", "es"):
        data["language"] = language

    r = req.post(
        GROQ_URL,
        headers={"Authorization": f"Bearer {api_key}"},
        files=files, data=data, timeout=60,
    )
    r.raise_for_status()
    body = r.json()
    segments = [
        {"start": float(s["start"]), "end": float(s["end"]), "text": s.get("text", "")}
        for s in body.get("segments", [])
    ]
    return segments, body.get("duration")


def compute_gist(audio_url, language="en", force=False):
    """Full pipeline with caching. Returns a gist dict or None (→ caller falls back)."""
    if not audio_url:
        return None
    if not force and audio_url in _CACHE:
        return _CACHE[audio_url]
    try:
        head = _fetch_head(audio_url)
        segments, duration = _transcribe(head, audio_url, language)
        gist = pick_gist(segments, duration)
        _CACHE[audio_url] = gist          # cache None too, so we don't retry a dud
        return gist
    except Exception as e:                 # noqa: BLE001 — fail soft, never crash playback
        log.warning("gist failed for %s: %s", audio_url, e)
        _CACHE[audio_url] = None
        return None


# ── CLI / self-test ─────────────────────────────────────────────────────────
_MOCK_SEGMENTS = [
    {"start": 0.0,  "end": 4.2,  "text": " This is NHK World Radio Japan."},
    {"start": 4.2,  "end": 8.9,  "text": " Good evening, here are the latest headlines."},
    {"start": 8.9,  "end": 13.0, "text": " Japan's prime minister announced a new economic package today."},
    {"start": 13.0, "end": 18.5, "text": " Officials confirmed the plan will take effect next month."},
    {"start": 18.5, "end": 24.0, "text": " The opposition rejected the proposal, calling it insufficient."},
    {"start": 24.0, "end": 29.5, "text": " In Europe, leaders agreed on a new climate target overnight."},
    {"start": 29.5, "end": 35.8, "text": " Markets in Tokyo closed slightly higher on the news."},
    {"start": 35.8, "end": 41.0, "text": " And in sport, the national team won its opening match."},
    {"start": 41.0, "end": 46.0, "text": " Coming up after the break, our correspondent in Brussels."},
]


def _selftest():
    print("=== self-test: rules on a mock NHK-style transcript (no network) ===")
    g = pick_gist(_MOCK_SEGMENTS, duration=46.0)
    print(json.dumps(g, indent=2))
    assert g, "expected a gist"
    assert g["start_time"] >= 8.0, "should skip the station intro"
    window = g["end_time"] - g["start_time"]
    assert 20 <= window <= 35, f"window should be a sensible gist length, got {window:.1f}s"
    # Must end on a real sentence — NOT the trailing transitional segment (41-46).
    assert g["end_time"] <= 41.0, "should not end on the 'coming up...' transitional tail"
    # And the chosen end must be a genuine segment boundary.
    assert any(abs(s["end"] - g["end_time"]) < 0.01 for s in _MOCK_SEGMENTS), "end must be a segment boundary"
    print(f"\nOK — start {g['start_time']}s skips intro; {window:.1f}s window; clean sentence end {g['end_time']}s.")


def _run(url, language="en"):
    logging.basicConfig(level=logging.INFO)
    print(f"=== transcribing first ~{HEAD_BYTES} bytes of:\n{url}\n")
    head = _fetch_head(url)
    print(f"fetched {len(head)} bytes")
    segments, duration = _transcribe(head, url, language)
    print(f"duration≈{duration}, {len(segments)} segments")
    for s in segments[:14]:
        print(f"  [{s['start']:5.1f}-{s['end']:5.1f}] {s['text'].strip()}")
    print("\n=== chosen gist ===")
    print(json.dumps(pick_gist(segments, duration), indent=2))


if __name__ == "__main__":
    if len(sys.argv) >= 2 and sys.argv[1] == "--selftest":
        _selftest()
    elif len(sys.argv) >= 2:
        _run(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "en")
    else:
        print("usage:\n  python gist.py --selftest\n  python gist.py <audio_url> [lang]")
