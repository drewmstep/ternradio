# Tern Radio — Project Architecture

## Overview

Tern Radio is a server-rendered Flask application that:
1. Fetches audio clips from public radio RSS feeds in parallel
2. Uses Claude (Haiku) to curate a geographically and topically diverse playlist
3. Streams the playlist to the browser via SSE so the first clip plays within ~1–2 seconds
4. Serves a single-page HTML/JS frontend that plays the audio with a music crossfade

There is no database, no user accounts, and no persistent state.

---

## Directory structure

```
global-radio/
├── app.py                  # Flask application (routes, feed fetching, Claude curation)
├── config.py               # Dev/prod configuration classes
├── wsgi.py                 # Gunicorn entry point
├── requirements.txt        # Python dependencies (pinned)
├── runtime.txt             # Python version for Railway/Render
├── Procfile                # Gunicorn start command
├── railway.toml            # Railway deployment config
├── render.yaml             # Render deployment config (alternative)
├── .env                    # Local secrets — never committed
├── .env.example            # Template for .env
├── .gitignore
├── templates/
│   └── index.html          # Single HTML page (Jinja2 template)
└── static/
    ├── style.css           # All application CSS
    └── player.js           # Frontend state machine
```

---

## Backend (`app.py`)

### Startup sequence
1. `load_dotenv()` reads `.env`
2. `get_config()` returns `Development` or `Production` class based on `FLASK_ENV`
3. `app.config.from_object(config)` applies it to Flask
4. `ProxyFix` middleware trusts `X-Forwarded-*` headers from Cloudflare

### Feed layer
- `ENGLISH_FEEDS`, `FRENCH_FEEDS`, `SPANISH_FEEDS` — dicts of `{name: (rss_url, country)}`
- `ENGLISH_EXTENDED` — fallback sources used by "Continue Program" when primary feeds are exhausted
- `_fetch_one(source, url, country, max_count)` — fetches one RSS feed, extracts audio enclosures
- `_fetch_feeds(feed_dict, max_count, timeout)` — runs `_fetch_one` in parallel via `ThreadPoolExecutor`

### Curation layer
- `curate_with_claude(items, n, mood)` — sends titles to Claude Haiku, gets back N indices
- Claude is instructed to maximise geographic/topic diversity and apply mood constraints
- The API key is read from `app.config["ANTHROPIC_API_KEY"]` — never from a query param or body

### Routes

| Method | Path | Description |
|---|---|---|
| GET | `/` | Serves `index.html` |
| GET | `/health` | Health check → `{"status": "ok"}` |
| GET | `/api/playlist/stream` | SSE stream: `?language=en&mood=balanced` |
| POST | `/api/playlist/continue` | JSON body: `{heard_urls, language, mood}` → 3 new clips |

### SSE streaming protocol
Each event is `data: <json>\n\n`. Three event types:
- `{"type": "item", "item": {...}}` — one clip ready to play
- `{"type": "error", "message": "..."}` — non-fatal, displayed to user
- `{"type": "done"}` — playlist complete

### Security
- `@app.before_request` → canonical domain redirect (301) if `CANONICAL_DOMAIN` is set
- `@app.after_request` → security headers on every response:
  - `Content-Security-Policy` — restricts script/style/media sources
  - `Strict-Transport-Security` — HSTS, sent only on HTTPS
  - `X-Frame-Options: DENY`
  - `X-Content-Type-Options: nosniff`
  - `Referrer-Policy: strict-origin-when-cross-origin`

---

## Configuration (`config.py`)

Two config classes, both inherit from `Config`:

| Setting | Development | Production |
|---|---|---|
| `DEBUG` | True | False |
| `SEND_FILE_MAX_AGE_DEFAULT` | 0s (no cache) | 365 days |
| `SESSION_COOKIE_SECURE` | — | True |
| `SESSION_COOKIE_HTTPONLY` | — | True |
| `SESSION_COOKIE_SAMESITE` | — | `"Lax"` |

`get_config()` reads `FLASK_ENV` (defaults to `"development"`).

---

## Frontend

### `templates/index.html`
- Single Jinja2 template, no dynamic server-side rendering
- `body.playing` CSS class is the master state switch:
  - absent → splash screen (language/mood selectors visible)
  - present → header strip + player cards visible, splash options hidden
- All interactivity is in `player.js`

### `static/style.css`
All styles. Uses CSS custom properties (`--bg`, `--accent`, etc.) for theming.  
No CSS framework dependency.

### `static/player.js`

**State object:**
```js
const state = {
  queue: [],         // array of clip objects from the server
  index: 0,          // currently playing clip index
  playing: false,
  phase: 'idle',     // idle | intro | clip | music
  cutPoint: null,
  musicFadeStarted: false,
  clipFadeStarted: false,
}
```

**Audio phases (state machine):**
```
idle → intro (Web Speech API TTS: "Next: <title>")
     → clip  (HTML5 Audio plays the podcast clip)
     → music (background music crossfades in at MAX_CLIP_SECONDS or clip end)
     → (next clip)
```

**Key functions:**
- `startPlayback()` — opens SSE `EventSource`, handles `item`/`done`/`error` events
- `playItem(index)` — sets `phase = 'intro'`, speaks the title, then plays audio
- `tick()` — called every 500ms, drives progress bar and clip→music transitions
- `continueProgram()` — POSTs to `/api/playlist/continue`, appends items to queue

**Music:**  
Five Pixabay CC0 tracks loaded from CDN, randomly selected per session. Music volume is held low during clips and fades up between them.

---

## Environment variables

| Variable | Where used | Description |
|---|---|---|
| `FLASK_ENV` | `config.py` | `development` or `production` |
| `SECRET_KEY` | Flask internals | Session cookie signing |
| `ANTHROPIC_API_KEY` | `curate_with_claude()` | Claude API — server-side only |
| `CANONICAL_DOMAIN` | `enforce_canonical()` | e.g. `ternradio.org` |
| `PORT` | Gunicorn (via shell) | Set automatically by Railway/Render |

---

## Development workflow

```bash
cd c:\Users\amste\global-radio
venv\Scripts\activate          # Windows
python -m flask run            # Dev server on http://localhost:5000
```

The dev server uses `Debug=True` and zero static-file caching.  
`FLASK_ENV` defaults to `development` when not set.

### Testing with ngrok (sharing locally)
```bash
ngrok http 5000
```
Share the `https://*.ngrok-free.app` URL. No `CANONICAL_DOMAIN` needed for ngrok.

---

## Production workflow

```bash
git push origin main   # triggers Railway auto-deploy
```

Railway runs:
```
gunicorn --workers 2 --worker-class gevent --worker-connections 1000 \
         --bind 0.0.0.0:$PORT --timeout 120 \
         --access-logfile - --error-logfile - wsgi:app
```

`wsgi.py` calls `load_dotenv()` before importing `app`, ensuring `.env` is read even if the shell doesn't pre-load it.

Gevent workers handle SSE long-polling efficiently: each worker can hold thousands of concurrent SSE connections using cooperative I/O instead of threads.
