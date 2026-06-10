# Tern Radio — Project Architecture & Code Reference

**Live at:** https://ternradio.org  
**GitHub:** https://github.com/drewmstep/ternradio  
**Hosting:** Railway (project: zooming-endurance, service: web)  
**Stack:** Python 3.12 / Flask 3.1.3 / Gunicorn + Gevent / Vanilla JS / Web Speech API

---

## Directory Structure

```
global-radio/
├── app.py                  # Main Flask app — all routes, feed fetching, Claude curation
├── config.py               # Dev/prod config classes — read by app.py on startup
├── wsgi.py                 # Gunicorn entry point — loads .env then imports app
├── requirements.txt        # Pinned Python dependencies
├── runtime.txt             # Tells Railway/Render to use Python 3.12
├── Procfile                # Gunicorn start command (used by some hosts, Railway uses railway.toml)
├── railway.toml            # Railway deployment config — build, start command, health check
├── render.yaml             # Alternative: Render.com deployment config (not currently used)
├── .env                    # LOCAL ONLY — never committed — holds ANTHROPIC_API_KEY etc.
├── .env.example            # Template showing required env vars — safe to commit
├── .gitignore              # Excludes .env, venv/, __pycache__/ from git
├── DEPLOYMENT.md           # Step-by-step hosting, DNS, SSL, maintenance guide
├── PROJECT_ARCHITECTURE.md # This file
├── templates/
│   └── index.html          # Single HTML page — Jinja2 template, no server-side logic
└── static/
    ├── style.css           # All CSS — extracted from index.html for cacheability
    └── player.js           # All frontend logic — audio state machine, SSE client
```

---

## Backend: app.py

### Startup sequence (top of file)
```python
load_dotenv()           # Reads .env into os.environ BEFORE anything else
from config import get_config
app = Flask(__name__)
app.config.from_object(get_config())   # Applies Dev or Prod config class
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)
```
- `ProxyFix` is required because Railway sits behind Cloudflare/a load balancer.
  Without it, `request.is_secure` is always False (HTTPS header is stripped),
  which means HSTS never gets sent.
- `get_config()` checks `FLASK_ENV` env var: `"production"` → `Production` class,
  anything else → `Development` class.

### Feed dictionaries
Four dicts at the top of app.py define all RSS sources:
- `ENGLISH_FEEDS` — 8 primary English sources (NPR, CBC, Al Jazeera, DW, ABC AU, RNZ, NHK)
- `ENGLISH_EXTENDED` — 5 fallback English sources used only by "Continue Program"
- `FRENCH_FEEDS` — 6 French sources (RFI, France Info, France Inter, RTS, DW FR, NHK FR)
- `SPANISH_FEEDS` — 5 Spanish sources (RFI ES, DW ES, NHK ES, RNE, ABC AU ES)

Each entry: `"Display Name": ("rss_url", "country_name")`  
The `country_name` string is passed to Claude to help it maximise geographic diversity.

### `_feeds_for_language(lang)` 
Routes a language string (`"en"`, `"fr"`, `"es"`) to the correct feed dict.
Called by both `/api/playlist/stream` and `/api/playlist/continue`.

### `_fetch_one(source, url, country, max_count=2)`
Fetches a single RSS feed. Key implementation details:
- Uses `requests.get(url, timeout=6)` — NOT `feedparser.parse(url)` directly.
  feedparser 6.0.12 doesn't accept a timeout kwarg; we fetch raw bytes first,
  then pass `response.content` to `feedparser.parse()`.
- Looks for audio enclosures with MIME type containing `"audio"` or
  URLs ending in `.mp3`, `.m4a`, `.ogg`.
- Strips HTML tags from summaries with `re.sub(r"<[^>]+>", "", summary)`.
- Returns a list of dicts: `{source, country, title, summary, audio_url,
  duration, published, link}`.

### `_fetch_feeds(feed_dict, max_count=2, timeout=12)`
Runs `_fetch_one` for all feeds **in parallel** using `ThreadPoolExecutor`.
- `max_workers` = number of feeds (one thread per feed).
- `as_completed(futures, timeout=12)` — waits max 12 seconds total for all feeds.
  Slow feeds are abandoned after 12s; their items simply don't appear in the playlist.
- Used by `/api/playlist/continue`. The stream endpoint has its own inline executor
  so it can yield items as each feed completes (true streaming).

### `ensure_source_variety(items)`
Reorders a list so no two consecutive items share the same source.
Simple greedy algorithm: for each position, pick the first remaining item
that doesn't match the previous source. Falls back to same-source if no
alternative exists (e.g. only one source left).

### `curate_with_claude(items, n=5, mood="balanced")`
Sends item titles to Claude Haiku and gets back N indices.
- Model: `claude-haiku-4-5-20251001` (fast, cheap, sufficient for list selection)
- Prompt instructs Claude to maximise geographic + topic diversity, apply mood,
  and avoid consecutive same-source items.
- Claude returns a JSON array of 1-based indices: `[3, 7, 1, 5, 2]`
- Regex `r"\[[\d,\s]+\]"` extracts the array even if Claude adds prose around it.
- Falls back to `ensure_source_variety(items[:n])` if Claude returns garbage.
- **API key is read from `app.config["ANTHROPIC_API_KEY"]`** — never from a
  request parameter or logged anywhere.

### MOOD_INSTRUCTIONS dict
Maps mood names to prompt text injected into the Claude prompt:
- `"light"` — culture, science, solutions journalism, avoid conflict/tragedy
- `"balanced"` — natural mix of all topics
- `"full"` — all major developments regardless of emotional weight
- `"sandwich"` — uplifting start, heavier middle, constructive end

---

## Routes

### `GET /`
Returns `index.html`. No dynamic data — all content comes from JS via API calls.

### `GET /health`
Returns `{"status": "ok"}` with HTTP 200.  
**Critical:** This route is exempted from the canonical domain redirect
(see `enforce_canonical` below). Railway's health check comes from
`healthcheck.railway.app`, which would otherwise be redirected to
`ternradio.org` and return a 301, causing a health check failure.

### `GET /api/playlist/stream?language=en&mood=balanced`
SSE (Server-Sent Events) endpoint. Returns `text/event-stream`.
Two response headers are set:
- `Cache-Control: no-cache` — prevents proxy/browser from buffering the stream
- `X-Accel-Buffering: no` — tells Nginx (used by Railway internally) not to buffer

**Streaming strategy:**
1. Opens a `ThreadPoolExecutor` with one thread per feed.
2. As each feed completes (`as_completed`), checks if this is the first result.
   If yes, immediately yields that item to the browser (`first_sent_url`).
   This means the first clip starts playing within ~1–2 seconds.
3. After all feeds complete, calls `curate_with_claude()` on all collected items.
4. Yields the Claude-curated items (skipping the one already sent as first).
5. Yields `{"type": "done"}` to signal playlist complete.

**SSE event format:** `data: <json>\n\n`  
Three event types: `item`, `error`, `done`.

### `POST /api/playlist/continue`
JSON body: `{heard_urls: [...], language: "en", mood: "balanced"}`  
Returns: `{items: [...], max_clip_seconds: 100}`

**Deduplication strategy:**
1. Fetch up to 4 items per feed (vs 2 for initial stream) — goes deeper into history.
2. Filter out any URL already in `heard_urls`.
3. If fewer than 3 fresh items found, fetch `ENGLISH_EXTENDED` sources too.
4. Curate 3 items with Claude.

---

## Security Middleware

### `@app.before_request — enforce_canonical()`
Runs before every request. Skips `/health` (Railway health check).  
If `CANONICAL_DOMAIN` env var is set and the request hostname doesn't match it,
issues a **301 redirect** to the same path on the canonical domain.

Effect:
- `ternradio.com/anything` → 301 → `ternradio.org/anything`
- `www.ternradio.org/anything` → 301 → `ternradio.org/anything`
- `web-production-9c74b.up.railway.app/anything` → 301 → `ternradio.org/anything`

Note: The Railway internal URL also redirects. This is intentional — the app
should only be accessed via ternradio.org in production.

### `@app.after_request — apply_security_headers()`
Adds security headers to every response:

| Header | Value | Purpose |
|---|---|---|
| `Content-Security-Policy` | see below | Prevents XSS, injection |
| `X-Frame-Options` | `DENY` | Prevents clickjacking |
| `X-Content-Type-Options` | `nosniff` | Prevents MIME sniffing |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Limits referrer leakage |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains; preload` | Forces HTTPS for 1 year |

HSTS is only sent when `request.is_secure` is True OR `X-Forwarded-Proto: https`
is present (set by Cloudflare/Railway). ProxyFix makes `request.is_secure` work
correctly behind the proxy.

**CSP breakdown:**
```
default-src 'self'           — block everything not explicitly allowed
script-src 'self'            — JS only from our own domain (player.js)
style-src 'self' 'unsafe-inline' — CSS from our domain + inline styles (SVG needs this)
media-src https: blob:       — audio from any HTTPS source (RSS feeds vary widely)
connect-src 'self'           — SSE/fetch only to our own domain
img-src 'self' data:         — images from our domain + inline data URIs
frame-ancestors 'none'       — stronger than X-Frame-Options, same effect
base-uri 'self'              — prevents base tag hijacking
upgrade-insecure-requests    — browser upgrades HTTP sub-resources to HTTPS
```

`media-src https:` is intentionally broad — audio files come from NPR, CBC,
Al Jazeera, NHK, etc., all on different domains. Locking to specific CDNs
would break whenever a feed changes its audio host.

---

## Configuration: config.py

```python
class Config:           # Base — shared by both environments
    SECRET_KEY        = os.environ.get("SECRET_KEY", "dev-fallback-...")
    ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
    CANONICAL_DOMAIN  = os.environ.get("CANONICAL_DOMAIN", "")
    MAX_CLIP_SECONDS  = 100

class Development(Config):
    DEBUG = True
    SEND_FILE_MAX_AGE_DEFAULT = timedelta(seconds=0)  # No static file caching

class Production(Config):
    DEBUG = False
    SEND_FILE_MAX_AGE_DEFAULT = timedelta(days=365)   # Cache static files 1 year
    SESSION_COOKIE_SECURE   = True    # Cookie only sent over HTTPS
    SESSION_COOKIE_HTTPONLY = True    # Cookie not accessible via JS
    SESSION_COOKIE_SAMESITE = "Lax"  # CSRF protection
```

`get_config()` reads `FLASK_ENV` and returns the class (not an instance).
`app.config.from_object()` accepts a class directly.

---

## Production Server: wsgi.py + Procfile + railway.toml

### wsgi.py
```python
from dotenv import load_dotenv
load_dotenv()
from app import app
```
`load_dotenv()` must be called BEFORE `from app import app` because `app.py`
reads env vars at import time (when `get_config()` runs).

### Gunicorn command (railway.toml)
```
gunicorn --workers 2 --worker-class gevent --worker-connections 1000
         --bind 0.0.0.0:$PORT --timeout 120
         --access-logfile - --error-logfile -
         wsgi:app
```
- `--worker-class gevent` — uses cooperative (async) I/O instead of threads.
  Critical for SSE: each SSE connection holds a connection open for ~10-30 seconds.
  With standard sync workers, 2 workers = max 2 concurrent streams.
  With gevent, 2 workers × 1000 connections = 2000 concurrent streams.
- `--timeout 120` — allows SSE connections to stay open up to 120 seconds
  before gunicorn kills them (default is 30s, which breaks SSE).
- `--access-logfile -` / `--error-logfile -` — logs to stdout/stderr,
  which Railway captures and displays in the dashboard.

---

## Frontend: templates/index.html

Single Jinja2 template. No server-side logic — `{{ url_for(...) }}` is the
only templating used (to generate cache-busted static file URLs).

### Body class state machine
`body.playing` is the master switch for the entire UI:

| State | CSS | What's visible |
|---|---|---|
| `body` (no class) | Splash screen | Language selector, mood grid, "Start Mix" button, about footer |
| `body.playing` | Player mode | Compact header strip, Now Playing card, Playlist card |

This is set in `player.js` when the first SSE item arrives, and removed when
the user clicks "↺ New Mix" to return to splash.

### SVG bird logo
Inline SVG in the wordmark — a tern bird silhouette in `currentColor`
(inherits `--accent` blue). Seven path/ellipse elements forming wings, body, beak, tail.

---

## Frontend: static/player.js

### State object
```javascript
const state = {
    queue: [],              // Array of clip objects from server
    index: 0,               // Index of currently playing/loading clip
    playing: false,         // True when audio is actively playing
    phase: 'idle',          // 'idle' | 'intro' | 'clip' | 'music'
    cutPoint: null,         // Timestamp (seconds) when music fades in
    musicFadeStarted: false,
    clipFadeStarted: false,
}
let activeSource = null;    // Current EventSource — stored so it can be closed on reset
```

### Audio phase state machine
```
idle
 └─► intro   (Web Speech API speaks "Next: <title>" in UK English Female voice)
      └─► clip    (HTML5 Audio plays the podcast MP3/M4A from RSS)
           └─► music  (background music fades in at MAX_CLIP_SECONDS or clip end)
                └─► intro  (next clip's intro begins — loop)
```

**Phase transitions are driven by two mechanisms:**
1. Speech `onend` event → transitions `intro` to `clip`
2. `tick()` function (setInterval every 500ms) → detects clip progress,
   triggers fade at `cutPoint`, transitions `clip` to `music`

### `tick()` — the heartbeat
Called every 500ms while playing. Responsibilities:
- Updates progress bar (`#progressFill` width %)
- Updates time display (`#timeInfo`)
- Detects when clip reaches `MAX_CLIP_SECONDS` (100s) → starts music fade
- Detects when audio ends naturally → advances to next clip

### Music crossfade
- 5 Pixabay CC0 tracks loaded from CDN URLs in `MUSIC_TRACKS` array
- One track randomly selected per session
- Music volume held at ~0.07 during clips
- Fades up to ~0.35 between clips (during `music` phase)
- Fades back down when next clip's intro starts

### `getSelectedLanguage()` / `getSelectedMood()`
Read the active `.lang-btn` and `.mood-card` DOM elements.
These are passed as query params to `/api/playlist/stream` and as JSON body
to `/api/playlist/continue`.

### EventSource (SSE client)
```javascript
activeSource = new EventSource(`/api/playlist/stream?language=...&mood=...`);
activeSource.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'item') { /* add to queue, start playing if first */ }
    if (msg.type === 'done') { /* mark loading complete */ }
    if (msg.type === 'error') { /* show error in status bar */ }
};
```
First `item` event → `document.body.classList.add('playing')` → reveals player.

### "↺ New Mix" button
- If `body.playing`: stops audio, closes EventSource, resets state, removes
  `body.playing` class → returns to splash screen.
- If not playing: opens new EventSource with current language/mood selections.

### "Continue Program" button
- POSTs `{heard_urls, language, mood}` to `/api/playlist/continue`
- Appends 3 new items to `state.queue`
- If playlist had ended, automatically resumes playback from the new items

### Queue rendering
Each queue item rendered as `<li class="queue-item">` with:
- Timestamp (cumulative runtime at which clip starts)
- Source badge + country
- Title
- Click handler → jumps to that clip immediately

---

## Environment Variables

| Variable | Where used | Dev default | Prod requirement |
|---|---|---|---|
| `FLASK_ENV` | `config.py:get_config()` | `"development"` | `"production"` |
| `SECRET_KEY` | Flask session signing | fallback string | Random 32-byte hex |
| `ANTHROPIC_API_KEY` | `app.py:curate_with_claude()` | must be set | must be set |
| `CANONICAL_DOMAIN` | `app.py:enforce_canonical()` | empty (disabled) | `"ternradio.org"` |
| `PORT` | Gunicorn `--bind` | N/A | Auto-set by Railway |

**Security rule:** `ANTHROPIC_API_KEY` is only ever read server-side in
`curate_with_claude()`. It is never returned in any API response, never
logged (logging uses `app.config.get()` without printing the value), and
never referenced in any template or static file.

---

## Data Flow: Full Request Lifecycle

```
User clicks "Start Mix"
    │
    ├─► JS opens EventSource → GET /api/playlist/stream?language=en&mood=balanced
    │
    ├─► enforce_canonical() checks host → passes (host matches CANONICAL_DOMAIN)
    │
    ├─► Flask starts streaming generator
    │       │
    │       ├─► ThreadPoolExecutor spawns 8 threads (one per English feed)
    │       │
    │       ├─► First thread to finish → yield item immediately to browser
    │       │       └─► JS receives item → body.playing = true → player appears
    │       │           └─► Intro speech plays → then audio clip plays
    │       │
    │       ├─► Remaining 7 threads finish (or timeout at 12s)
    │       │
    │       ├─► curate_with_claude() → sends ~16 titles to Claude Haiku
    │       │       └─► Claude returns e.g. [3, 7, 1, 5, 2]
    │       │
    │       └─► yield 4 more curated items → yield done
    │
    └─► apply_security_headers() adds CSP, HSTS, X-Frame-Options etc. to response
```

---

## Deployment Architecture

```
User Browser
    │ HTTPS
    ▼
Cloudflare (DNS only — no proxy, direct to Railway)
    │ HTTPS
    ▼
Railway Load Balancer
    │ HTTP (internal)
    ▼
Gunicorn (2 gevent workers)
    │
    ├─► Worker 1 (up to 1000 concurrent connections)
    └─► Worker 2 (up to 1000 concurrent connections)
            │
            └─► Flask app (app.py)
                    │
                    ├─► ThreadPoolExecutor (RSS fetching — 8 concurrent HTTP requests)
                    └─► Anthropic API (Claude Haiku — one request per playlist)
```

**Zero-downtime deploys:** Railway keeps the old container alive until the new one
passes the `/health` check, then switches traffic. Push to `master` on GitHub
triggers auto-deploy via the GitHub integration configured in Railway.

---

## How to Add a New Feed

1. Add an entry to the appropriate dict in `app.py`:
   ```python
   "Source Name": ("https://rss-url-here.xml", "Country Name"),
   ```
2. Commit and push — Railway auto-deploys.

No other changes needed. The feed is automatically included in the
parallel fetch and eligible for Claude curation.

---

## Recovery: Rolling Back to v1.0-live

If a future change breaks the site:

```powershell
# Option 1: Revert the last commit (keeps history clean)
git revert HEAD
git push origin master

# Option 2: Hard reset to the stable tag (use carefully — rewrites history)
git checkout v1.0-live
git checkout -b hotfix-rollback
git push origin hotfix-rollback
# Then in Railway: change deploy branch to hotfix-rollback
```

Railway auto-deploys on push. The site is restored within ~2 minutes.
