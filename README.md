# Tern Radio

A radio station for the world's news. Press play and you get a continuous stream
of short news briefs pulled from public radio broadcasters across 15 countries —
NPR, BBC, the Guardian, CBC, Al Jazeera, DW, RNZ, NHK, SBS, and the Nordic
English services — newest story first.

**Live:** https://ternradio.org · **Repo:** https://github.com/drewmstep/ternradio

---

## What makes it more than a podcast shuffle

Raw podcast audio is a bad radio experience: every clip opens with 15–40 seconds
of sponsor read, station ident and host greeting before any news happens. Tern
Radio's **Smart Gist** listens to the first two minutes of each clip and picks
the window where the actual news lives.

```
ffmpeg (first ~120s) → Groq Whisper (transcript) → Claude (choose the window)
```

Claude returns a start and end time with its reasoning, e.g.

```json
{"start_time": 29.56, "end_time": 40.5,
 "skip_reason": "Amazon Business ad + NPR station intro",
 "end_reason":  "Topic shift from Iran-US negotiations to Japan earthquake"}
```

The player starts the clip at `start_time` using a `#t=` media fragment, so the
listener's first sound is the news. Briefs end on a complete sentence, never
mid-word and never on a "our correspondent has more" hand-off.

## How listening works

- **Briefs** play continuously, newest first, with a short music bridge between.
- **Story Recency** (last hour → this month → no limit) bounds how far back the
  mix reaches. It expands into older stories automatically when the window is
  too sparse to fill a batch.
- **Listen Now** drops the brief cut and lets the current story run to its
  natural end.
- **Queue Full Story**, or the **+** on any upcoming brief, saves the
  full-length version to the Full Stories queue. The `+` also removes that brief
  from the play-next list — if the headline already sold you, the 30-second cut
  is wasted time.
- **Launch Full Stories** plays the saved queue, then returns to the brief stream
  where it left off.

---

## Running it locally

```bash
cd C:\Users\amste\global-radio
venv\Scripts\activate
python app.py                     # → http://127.0.0.1:5000
```

Copy `.env.example` → `.env` and fill in:

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Claude — picks the brief window |
| `GROQ_API_KEY` | Whisper — transcribes the clip |
| `SMART_GIST_ENABLED` | `true`, or briefs play raw from 0:00 with ads |

**ffmpeg must be on PATH** for Smart Gist to work locally. Without it the code
falls back to a raw byte-range grab, which often makes Groq 502.

`python check_feeds.py` reports which RSS sources are alive.
`python gist.py "<audio_url>"` runs the gist pipeline on one clip and prints the
transcript, chosen window and reasoning — the fastest way to debug a bad brief.

---

## Layout

```
app.py                  Flask routes, feed fetching, recency selection
gist.py                 Smart Gist: ffmpeg → Whisper → Claude
config.py               Dev/prod config classes
static/player.js        All playback logic — audio state machine, SSE client
static/style.css        All styling
templates/index.html    Single page
```

| Doc | Covers |
|---|---|
| `HANDOFF.md` | **Current state and what to pick up next — start here** |
| `DEPLOYMENT.md` | Railway, DNS, env vars, health checks |
| `PROJECT_ARCHITECTURE.md` | Deep code reference (partially stale — see its header) |
| `SMART_GIST_PLAN.md` | Smart Gist design and tuning history |

---

## Deployment

Railway project `natural-connection`, service `web`, **auto-deploys on push to
`master`**. Health check `/health`. ffmpeg comes from `nixpacks.toml`.

Two things bite here, both documented in `DEPLOYMENT.md`:

- `SMART_GIST_ENABLED` **fails closed.** Unset, the site deploys green and
  `/health` passes while every brief plays raw with ads. If briefs sound like
  podcast openings, check this before anything else.
- A `*.up.railway.app` CNAME target **always** returns "Application not found"
  when browsed directly — it's a routing anchor, not an address. Railway routes
  by Host header. Never diagnose from that 404.
