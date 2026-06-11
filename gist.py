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
import re
import sys
import json
import time
import shutil
import logging
import subprocess

import requests as req

log = logging.getLogger("tern.gist")

# ── Config ──────────────────────────────────────────────────────────────────
GROQ_URL        = "https://api.groq.com/openai/v1/audio/transcriptions"
GROQ_MODEL      = "whisper-large-v3-turbo"   # fast + cheap; good enough for headlines
HEAD_BYTES      = 1_200_000                   # ~90s at speech bitrates — enough for a 30s gist
HTTP_TIMEOUT    = 20                          # download timeout
GROQ_TIMEOUT    = (15, 150)                   # (connect, read) — Groq upload+transcribe

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
    "says", "said", "told", "closed", "hit", "fired", "targeted", "completed",
    "called", "ordered", "claimed", "denied", "met", "won", "lost",
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
    # No clear signal: skip ~8s, but snap to a segment START so we never begin
    # mid-sentence (e.g. partway through the host's greeting).
    for seg in segments:
        if seg["start"] >= DEFAULT_SKIP:
            return seg["start"], "no clear signal — skipped to first segment after 8s"
    return (segments[0]["end"] if segments else DEFAULT_SKIP), "no clear signal — after first segment"


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


# ── Claude analysis (Phase B) ───────────────────────────────────────────────
CLAUDE_MODEL = "claude-haiku-4-5-20251001"   # same cheap model app.py uses


def _snap(t, values):
    return min(values, key=lambda v: abs(v - t)) if values else t


def analyze_claude(segments, language="en"):
    """Ask Claude to pick the gist window. Returns a gist dict or None.

    Far more robust than keyword rules — it understands intro vs. lead story.
    Output is snapped to real segment boundaries and clamped, so a hallucinated
    timestamp can't produce a mid-word cut.
    """
    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key or not segments:
        return None
    import anthropic

    lines = "\n".join(f"[{s['start']:.1f}-{s['end']:.1f}] {s['text'].strip()}" for s in segments)
    duration = segments[-1]["end"]
    prompt = (
        "You pick a ~30-second 'headline gist' from the START of a news audio clip.\n"
        "Below is a timestamped transcript (seconds). Choose start_time and end_time so the gist:\n"
        "- SKIPS station intros, jingles, and host greetings ('welcome to', \"I'm <name>\", "
        "\"you're listening to\", 'this is <station>').\n"
        "- STARTS at the first substantive news sentence.\n"
        "- Is about 28-32 seconds long (35 max).\n"
        "- ENDS at the end of a complete sentence — NEVER mid-sentence.\n"
        "- Does NOT end on a lead-in to something unresolved ('coming up', 'more on this', "
        "'our correspondent', 'after the break').\n"
        "- start_time must equal a segment START and end_time a segment END from the transcript.\n\n"
        f"Transcript:\n{lines}\n\n"
        'Reply with ONLY JSON: {"start_time": <float>, "end_time": <float>, '
        '"skip_reason": "<short>", "end_reason": "<short>"}'
    )
    try:
        client = anthropic.Anthropic(api_key=api_key)
        resp = client.messages.create(
            model=CLAUDE_MODEL, max_tokens=200,
            messages=[{"role": "user", "content": prompt}],
        )
        raw = resp.content[0].text.strip()
        m = re.search(r"\{.*\}", raw, re.S)
        if not m:
            return None
        data = json.loads(m.group())
        start = _snap(float(data["start_time"]), [s["start"] for s in segments])
        end   = _snap(float(data["end_time"]),   [s["end"] for s in segments])
        end = min(end, duration, start + TARGET_HARD)
        if end - start < 10:
            return None
        return {
            "start_time": round(start, 2),
            "end_time":   round(end, 2),
            "skip_reason": str(data.get("skip_reason", ""))[:120],
            "end_reason":  str(data.get("end_reason", ""))[:120],
            "source": "claude",
        }
    except Exception as e:  # noqa: BLE001 — fail soft → caller uses rules
        log.warning("Claude gist analysis failed: %s", e)
        return None


# ── Audio + transcription ───────────────────────────────────────────────────
def _ffmpeg_path():
    """Locate ffmpeg without relying on PATH: FFMPEG_PATH env, then PATH, then a
    copy dropped next to this file (ffmpeg.exe / bin/ffmpeg.exe)."""
    env = os.getenv("FFMPEG_PATH")
    if env and os.path.isfile(env):
        return env
    found = shutil.which("ffmpeg")
    if found:
        return found
    here = os.path.dirname(os.path.abspath(__file__))
    for cand in ("ffmpeg.exe", "ffmpeg", os.path.join("bin", "ffmpeg.exe"),
                 os.path.join("bin", "ffmpeg")):
        p = os.path.join(here, cand)
        if os.path.isfile(p):
            return p
    return None


def _have_ffmpeg():
    return _ffmpeg_path() is not None


def _url_ext(audio_url):
    low = audio_url.lower()
    for e in ("mp3", "m4a", "ogg", "wav", "aac"):
        if f".{e}" in low:
            return e
    return "mp3"


def _extract_with_ffmpeg(audio_url, seconds=90):
    """First `seconds` of the clip as clean 16kHz mono WAV (in memory, no disk).

    ffmpeg re-encodes, so the output's headers describe ONLY the extracted
    window — no truncated-frame / wrong-duration problem that makes the
    transcription service 502. ffmpeg reads the remote URL directly.
    """
    cmd = [
        _ffmpeg_path(), "-nostdin", "-loglevel", "error",
        "-user_agent", "TernRadio/1.0",
        "-ss", "0", "-t", str(seconds),
        "-i", audio_url,
        "-ac", "1", "-ar", "16000", "-f", "wav", "pipe:1",
    ]
    p = subprocess.run(cmd, capture_output=True, timeout=120)
    if p.returncode != 0 or not p.stdout:
        raise RuntimeError(f"ffmpeg failed: {p.stderr.decode('utf-8', 'ignore')[:300]}")
    return p.stdout


def _fetch_head(audio_url):
    """Grab the first ~HEAD_BYTES of the clip via an HTTP range request.

    Avoids downloading 28-minute podcasts in full and avoids an ffmpeg
    dependency. A truncated MP3 transcribes fine (frame-based); truncated
    MP4/m4a may not decode — in that case transcription fails and we fall back.
    """
    headers = {"User-Agent": "TernRadio/1.0", "Range": f"bytes=0-{HEAD_BYTES - 1}"}
    r = req.get(audio_url, headers=headers, timeout=HTTP_TIMEOUT, stream=True)
    r.raise_for_status()
    # Stop downloading at HEAD_BYTES even if the server ignored the Range header.
    chunks, total = [], 0
    for chunk in r.iter_content(8192):
        chunks.append(chunk)
        total += len(chunk)
        if total >= HEAD_BYTES:
            break
    r.close()
    data = b"".join(chunks)[:HEAD_BYTES]
    if not data:
        raise ValueError("empty audio head")
    return data


def _get_clip_audio(audio_url, seconds=90):
    """(audio_bytes, ext) for the first ~`seconds`. Prefer ffmpeg; fall back to
    a raw byte-range head when ffmpeg isn't installed (fragile — truncated MP3s
    can make Groq 502, so ffmpeg is strongly recommended)."""
    if _have_ffmpeg():
        return _extract_with_ffmpeg(audio_url, seconds), "wav"
    data = _fetch_head(audio_url)
    ext = _url_ext(audio_url)
    if ext == "mp3":
        data = _trim_to_mp3_frame(data)
    return data, ext


_CONTENT_TYPES = {
    "mp3": "audio/mpeg", "m4a": "audio/mp4", "ogg": "audio/ogg",
    "wav": "audio/wav", "aac": "audio/aac",
}


def _trim_to_mp3_frame(data):
    """Drop a partial trailing MP3 frame so Groq receives a clean file.

    Scans back to the last MP3 frame-sync (0xFF, then top 3 bits set) and cuts
    just before it — removing the incomplete final frame left by the byte cut.
    """
    i = data.rfind(b"\xff")
    while i > 0:
        if i + 1 < len(data) and (data[i + 1] & 0xE0) == 0xE0:
            return data[:i]
        i = data.rfind(b"\xff", 0, i)
    return data


def _transcribe(audio_bytes, ext, language=None):
    """Transcribe via Groq Whisper (with retry on 5xx). Returns (segments, duration)."""
    api_key = os.getenv("GROQ_API_KEY")
    if not api_key:
        raise ValueError("GROQ_API_KEY not configured")

    files = {"file": (f"clip.{ext}", audio_bytes, _CONTENT_TYPES.get(ext, "application/octet-stream"))}
    data = {"model": GROQ_MODEL, "response_format": "verbose_json"}
    if language and language in ("en", "fr", "es"):
        data["language"] = language

    r = None
    for attempt in range(3):
        r = req.post(
            GROQ_URL,
            headers={"Authorization": f"Bearer {api_key}"},
            files=files, data=data, timeout=GROQ_TIMEOUT,
        )
        if r.status_code < 500:
            break
        log.warning("Groq %s (attempt %d/3) — retrying", r.status_code, attempt + 1)
        time.sleep(1.5 * (attempt + 1))
    # Surface Groq's actual error message (not just the HTTP status).
    if r.status_code >= 400:
        raise RuntimeError(f"Groq HTTP {r.status_code}: {(r.text or '')[:800]}")
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
        audio, ext = _get_clip_audio(audio_url)
        segments, duration = _transcribe(audio, ext, language)
        # Prefer Claude (understands intro vs. lead story); fall back to rules.
        gist = analyze_claude(segments, language) or pick_gist(segments, duration)
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


def _ping():
    """Send a tiny generated WAV to Groq to test the key + endpoint in isolation."""
    import io, wave, struct
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(struct.pack("<" + "h" * 16000, *([0] * 16000)))  # 1s silence
    data = buf.getvalue()
    print(f"pinging Groq with a {len(data)}-byte test WAV…")
    segments, duration = _transcribe(data, "wav", None)
    print(f"OK — Groq responded. duration={duration}, segments={len(segments)}")
    print("=> your key + the Groq endpoint work. Any NHK failure is about the audio.")


def _run(url, language="en"):
    logging.basicConfig(level=logging.INFO)
    via = "ffmpeg" if _have_ffmpeg() else "byte-range (no ffmpeg found — install it for reliability)"
    print(f"=== extracting first ~90s via {via}:\n{url}\n")
    audio, ext = _get_clip_audio(url)
    print(f"got {len(audio)} bytes ({ext})")
    print("sending to Groq Whisper (usually ~5-30s)…")
    segments, duration = _transcribe(audio, ext, language)
    print(f"duration≈{duration}, {len(segments)} segments")
    for s in segments[:16]:
        print(f"  [{s['start']:5.1f}-{s['end']:5.1f}] {s['text'].strip()}")

    print("\n=== RULES gist (fallback) ===")
    print(json.dumps(pick_gist(segments, duration), indent=2))

    if os.getenv("ANTHROPIC_API_KEY"):
        print("\n=== CLAUDE gist (primary) ===")
        print(json.dumps(analyze_claude(segments, language), indent=2))
    else:
        print("\n(ANTHROPIC_API_KEY not set — skipping Claude comparison)")


if __name__ == "__main__":
    # Standalone runs aren't started via app.py, so load .env here to pick up
    # GROQ_API_KEY. (When imported by the app, app.py already calls load_dotenv.)
    try:
        from dotenv import load_dotenv
        load_dotenv()
    except Exception:
        pass

    if len(sys.argv) >= 2 and sys.argv[1] == "--selftest":
        _selftest()
    elif len(sys.argv) >= 2 and sys.argv[1] == "--ping":
        logging.basicConfig(level=logging.INFO)
        _ping()
    elif len(sys.argv) >= 2:
        _run(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "en")
    else:
        print("usage:\n  python gist.py --selftest\n  python gist.py <audio_url> [lang]")
