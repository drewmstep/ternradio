# Handoff — where we left off

**Bookmark date:** 2026-07-28
**Live and healthy:** https://ternradio.org
**Deployed commit:** `c1682a9` on `master`

---

## Start here when you come back

```bash
cd C:\Users\amste\global-radio
venv\Scripts\activate
python app.py                     # → http://127.0.0.1:5000
```

Everything is committed and pushed. `master` and the live site are in sync.
Nothing is half-finished — this is a clean stopping point.

To check production without opening a browser:

```bash
railway link --project natural-connection   # once per machine
railway status
railway logs --service web
```

---

## What happened this session

**The site was down and came back.** Railway had suspended the service when the
free-trial credits ran out. Not a code fault and not DNS — the app was fine the
whole time. Upgrading to the Hobby plan ($5/mo) un-suspended it, and Railway
auto-deployed `master`, which shipped the three commits that had been sitting
unpushed since June.

**Ads were reaching listeners.** The gist engine had been detecting them
correctly all along (`"Amazon Business ad + NPR station intro"`, skip to
29.56s) — the ads got on air through three client-side paths, all now fixed in
`ba20dca`:

1. Clips loaded at 0:00 and seeked afterwards; that seek fails across NPR's
   redirect chain. Now they load at `#t=<start>` so the browser starts at the
   news via its own ranged request.
2. Both failure handlers deliberately replayed from 0:00 "so the story is never
   silently skipped" — which aired the exact ad the gist had measured. Now
   capped at skips under `AD_SKIP_SEC` (10s, i.e. real station intros); past
   that the story is dropped instead. **Losing a story beats airing an ad.**
3. The first clip started the instant it arrived over SSE, before its gist
   existed, so sessions reliably opened on an ad. Now waits up to 9s
   ("Finding where the news starts…").

**New feature** (`c1682a9`): a **+** on every upcoming brief moves the story
wholesale to Full Stories and drops the brief from the play-next list. The
transport button reads "Queue Full Story" again.

**Config fix:** `GROQ_API_KEY` and `SMART_GIST_ENABLED` were never set on
Railway, so Smart Gist was silently off in production. Both now set. This was
also added to `DEPLOYMENT.md`, which had never listed them.

---

## Open items

### 1. DNS — one record still wrong (low urgency, do it before cert renewal)

`www.ternradio.org` doesn't resolve and its certificate is stuck in
`VALIDATING_OWNERSHIP`. The www verification token was **edited into** the apex
record instead of **added** as a new one, so:

```
_railway-verify.ternradio.org      -> railway-verify=55041855…   ← the WWW token, wrong place
_railway-verify.www.ternradio.org  -> absent
```

In Namecheap (Advanced DNS), both TXT records must exist side by side. Use
**Add New Record**, don't edit:

| Type | Host | Value |
|---|---|---|
| TXT | `_railway-verify` | `railway-verify=89350c45d3d6b05cba69e5d8cba6958872632d6e3644f9c612b5ea04c57a5111` |
| TXT | `_railway-verify.www` | `railway-verify=55041855b65ffe3be7067f2b7cf0e77872881546e3c49ae4209bb190d243085f` |

The first is a **restore** (the apex lost its token); the second is **new**.
Leave both CNAMEs alone — they are correct. `ternradio.org` works regardless;
this only affects `www` and future cert renewal.

Full record set: `OneDrive/Documents/Project Tern Radio/Railway/DNS Records.txt`

### 2. Unverified: do the ads actually sound gone?

The three code paths are fixed and the plumbing is verified (CDNs answer `206`
to Range requests, so `#t=` works). What hasn't been confirmed is a real
listening session. **Listen to 5–10 briefs and note any source where an ad still
plays** — the browser console logs every decision:

```
[gist] playing NPR News Now from 29.56s to 40.5s
[gist] seek failed for BBC — skipping story rather than airing a 31s ad
```

If ads persist, that console output identifies which path is failing.

### 3. Watch the Railway bill in the first month

Hobby includes $5/mo of usage; a mostly-idle Flask process costs roughly $3–5.
Smart Gist's ffmpeg work is CPU-spiky, so real traffic could push past the
included credit. Audio streams from the podcast CDNs straight to the browser and
never transits the server, so bandwidth isn't the risk — CPU is.

Groq and Anthropic are billed separately per brief, and scale with listeners.

### 4. `PROJECT_ARCHITECTURE.md` needs a real refresh

Its header now lists what's superseded, but the body still describes
Claude-curated playlists and doesn't mention Smart Gist. Fine for the mechanics
it does cover; misleading on the playlist path.

### 5. Housekeeping

`feature/smart-gist` is identical to `master` and can be deleted.

---

## Ideas parked for the customisation pass

Not started, no code written — just what came up while working:

- **Mid-roll ads.** Smart Gist only inspects the first ~120s, so it catches
  pre-roll. A mid-story ad break inside a Full Story would still play.
- **`RAW_FALLBACK_SEC` gap.** When a gist can't be computed the clip plays 45s
  from 0:00, ads included — we have no ad information in that case. Rare now
  (all sources returned gists in testing), but it's the remaining hole.
- **Story Recency** currently bounds *age*. There's no topic or region filter
  once a mix is running.
- **Thumbs up/down** are recorded on the item but don't yet influence what gets
  selected next.
