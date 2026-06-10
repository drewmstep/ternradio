import os, re, json, random, logging
from concurrent.futures import ThreadPoolExecutor, as_completed
import requests as req, feedparser, anthropic
from flask import Flask, render_template, jsonify, Response, stream_with_context, request, redirect
from dotenv import load_dotenv
from datetime import datetime, timezone
from werkzeug.middleware.proxy_fix import ProxyFix

load_dotenv()

from config import get_config

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%SZ",
)
log = logging.getLogger("tern")

# ── App setup ─────────────────────────────────────────────────────────────────
app = Flask(__name__)
app.config.from_object(get_config())
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)

# ── English feeds (primary) ───────────────────────────────────────────────────
ENGLISH_FEEDS = {
    "NPR News Now":    ("https://feeds.npr.org/500005/podcast.xml",           "the United States"),
    "NPR Up First":    ("https://feeds.npr.org/510318/podcast.xml",           "the United States"),
    "CBC Front Burner":("https://www.cbc.ca/podcasting/includes/frontburner.xml", "Canada"),
    "Al Jazeera":      ("https://www.omnycontent.com/d/playlist/9c074afa-3313-47e8-b802-a9f900789975/63048eda-2427-408a-b47c-ad5001293fca/6677d422-fd43-4aaa-be74-ad5001293fd8/podcast.rss", "Qatar"),
    "DW Inside Europe":("https://rss.dw.com/xml/podcast_inside-europe",      "Germany"),
    "ABC News Daily":  ("https://www.abc.net.au/feeds/9443166/podcast.xml",   "Australia"),
    "RNZ News":        ("https://www.rnz.co.nz/acast/news-bulletin-podcast.rss", "New Zealand"),
    "NHK World Radio": ("http://www3.nhk.or.jp/rj/podcast/rss/english.xml",   "Japan"),
}

# ── English extended (used by Continue Program when primary feeds are exhausted)
ENGLISH_EXTENDED = {
    "AP Radio":         ("https://feeds.megaphone.fm/apnewsradio",                            "the United States"),
    "BBC Global News":  ("https://podcasts.files.bbci.co.uk/p02nq0gn.rss",                   "United Kingdom"),
    "Guardian Today":   ("https://www.theguardian.com/news/series/todayinfocus/podcast.xml",  "United Kingdom"),
    "France 24 English":("https://rss.france24.com/rss/en/france24-en-podcast-latest",        "France"),
    "Monocle Daily":    ("https://feeds.monocle.com/daily-briefing",                           "United Kingdom"),
}

# ── French feeds ──────────────────────────────────────────────────────────────
FRENCH_FEEDS = {
    "RFI Français Facile": ("https://podcast.rfi.fr/podcast/rss/rf-fr-journalfrancaisfacile.xml", "France"),
    "France Info":          ("https://radiofrance-podcast.net/podcasts/rss_14969.xml",             "France"),
    "France Inter Journal": ("https://radiofrance-podcast.net/podcasts/rss_14278.xml",             "France"),
    "RTS Info":             ("https://www.rts.ch/la-1ere/programmes/rts-info/podcast/rss.xml",     "Switzerland"),
    "DW Français":          ("https://rss.dw.com/xml/podcast_le-magazine-francophone",             "Germany"),
    "NHK Japonais":         ("http://www3.nhk.or.jp/rj/podcast/rss/french.xml",                   "Japan"),
}

# ── Spanish feeds ─────────────────────────────────────────────────────────────
SPANISH_FEEDS = {
    "RFI Español":      ("https://podcast.rfi.fr/podcast/rss/rf-es-InfosMundiales.xml",         "France"),
    "DW Español":       ("https://rss.dw.com/rdf/podcast-es-top-stories",                       "Germany"),
    "NHK Japonés":      ("http://www3.nhk.or.jp/rj/podcast/rss/spanish.xml",                    "Japan"),
    "RNE Radio Ext.":   ("https://www.rtve.es/api/programas/8813/audios.rss",                    "Spain"),
    "ABC Australia ES": ("https://www.abc.net.au/feeds/8294764/podcast.xml",                     "Australia"),
}

MAX_CLIP_SECONDS = 100

MOOD_INSTRUCTIONS = {
    "light":    "Prefer culture, science, innovation, solutions journalism, and positive developments. Avoid heavy conflict or tragedy.",
    "balanced": "Include a natural mix — politics, economy, science, culture, environment, and society.",
    "full":     "Include all major international developments regardless of emotional weight, prioritising global significance.",
    "sandwich": "Order the clips: start with an uplifting or interesting story, build through heavier news, and end on a constructive note.",
}


def _feeds_for_language(lang):
    l = (lang or "en").lower()
    if l in ("fr", "french"):  return FRENCH_FEEDS
    if l in ("es", "spanish"): return SPANISH_FEEDS
    return ENGLISH_FEEDS


def _fetch_one(source, url, country, max_count=2):
    items = []
    try:
        response = req.get(url, timeout=6, headers={"User-Agent": "TernRadio/1.0"})
        response.raise_for_status()
        feed = feedparser.parse(response.content)
        count = 0
        for entry in feed.entries:
            if count >= max_count:
                break
            audio_url = None
            for enc in getattr(entry, "enclosures", []):
                t, u = enc.get("type", ""), enc.get("url", "")
                if "audio" in t or u.endswith((".mp3", ".m4a", ".ogg")):
                    audio_url = u
                    break
            if not audio_url:
                continue

            summary = re.sub(r"<[^>]+>", "", entry.get("summary", entry.get("description", ""))).strip()
            published = ""
            pt = entry.get("published_parsed")
            if pt:
                try:
                    published = datetime(*pt[:6], tzinfo=timezone.utc).isoformat()
                except Exception:
                    pass

            items.append({
                "source":    source,
                "country":   country,
                "title":     entry.get("title", "").strip(),
                "summary":   summary[:250],
                "audio_url": audio_url,
                "duration":  entry.get("itunes_duration", ""),
                "published": published,
                "link":      entry.get("link", ""),
            })
            count += 1

        log.info("[%s] %d item(s)", source, count)
    except Exception as e:
        log.warning("[%s] fetch error: %s", source, e)
    return items


def _fetch_feeds(feed_dict, max_count=2, timeout=12):
    all_items = []
    with ThreadPoolExecutor(max_workers=max(1, len(feed_dict))) as pool:
        futures = {pool.submit(_fetch_one, s, u, c, max_count): s for s, (u, c) in feed_dict.items()}
        for future in as_completed(futures, timeout=timeout):
            try:
                all_items.extend(future.result())
            except Exception as e:
                log.warning("Future error: %s", e)
    return all_items


def ensure_source_variety(items):
    if len(items) <= 1:
        return items
    result, remaining = [items[0]], list(items[1:])
    while remaining:
        last = result[-1]["source"]
        placed = False
        for i, item in enumerate(remaining):
            if item["source"] != last:
                result.append(remaining.pop(i))
                placed = True
                break
        if not placed:
            result.append(remaining.pop(0))
    return result


def curate_with_claude(items, n=5, mood="balanced"):
    api_key = app.config.get("ANTHROPIC_API_KEY") or os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        raise ValueError("ANTHROPIC_API_KEY not configured")

    random.shuffle(items)
    client = anthropic.Anthropic(api_key=api_key)

    target_n = min(n, len(items))
    mood_note = MOOD_INSTRUCTIONS.get(mood, MOOD_INSTRUCTIONS["balanced"])
    items_text = "\n".join(
        f"{i+1}. [{item['source']}, {item['country']}] {item['title']}"
        for i, item in enumerate(items)
    )

    response = client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=300,
        messages=[{
            "role": "user",
            "content": (
                f"You are producing Tern Radio, a global audio news programme. "
                f"Select exactly {target_n} clips from this list. Requirements:\n"
                "- Maximum geographic diversity (different countries/continents)\n"
                "- Maximum topic diversity (politics, economy, science, culture, environment, etc.)\n"
                "- No two clips from the same source consecutively\n"
                f"- Mood instruction: {mood_note}\n\n"
                f"{items_text}\n\n"
                f"Reply with ONLY a JSON array of exactly {target_n} item numbers."
            ),
        }],
    )

    raw = response.content[0].text.strip()
    match = re.search(r"\[[\d,\s]+\]", raw)
    if match:
        indices = json.loads(match.group())
        selected = [items[i - 1] for i in indices if 1 <= i <= len(items)]
        if selected:
            return ensure_source_variety(selected[:target_n])
    return ensure_source_variety(items[:target_n])


# ── Canonical domain redirect ─────────────────────────────────────────────────
@app.before_request
def enforce_canonical():
    if request.path == "/health":
        return
    canonical = app.config.get("CANONICAL_DOMAIN", "")
    if not canonical:
        return
    host = request.host.split(":")[0]
    if host == canonical:
        return
    url = request.url.replace(f"://{request.host}", f"://{ canonical}", 1)
    return redirect(url, code=301)


# ── Security headers ──────────────────────────────────────────────────────────
@app.after_request
def apply_security_headers(response):
    csp = (
        "default-src 'self'; "
        "script-src 'self'; "
        "style-src 'self' 'unsafe-inline'; "
        "media-src https: blob:; "
        "connect-src 'self'; "
        "img-src 'self' data:; "
        "frame-ancestors 'none'; "
        "base-uri 'self'; "
        "upgrade-insecure-requests"
    )
    response.headers["Content-Security-Policy"] = csp
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    if request.is_secure or request.headers.get("X-Forwarded-Proto") == "https":
        response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains; preload"
    return response


# ── Routes ────────────────────────────────────────────────────────────────────
@app.route("/")
def index():
    return render_template("index.html")


@app.route("/health")
def health():
    return jsonify({"status": "ok"}), 200


@app.route("/api/playlist/stream")
def playlist_stream():
    lang  = request.args.get("language", "en")
    mood  = request.args.get("mood", "balanced")
    feeds = _feeds_for_language(lang)
    log.info("Stream request lang=%s mood=%s", lang, mood)

    def generate():
        first_sent_url = None
        all_items = []

        with ThreadPoolExecutor(max_workers=len(feeds)) as pool:
            futures = {pool.submit(_fetch_one, s, u, c, 2): s for s, (u, c) in feeds.items()}
            for future in as_completed(futures, timeout=12):
                try:
                    items = future.result()
                    all_items.extend(items)
                    if first_sent_url is None and items:
                        first_sent_url = items[0]["audio_url"]
                        yield f"data: {json.dumps({'type': 'item', 'item': items[0]})}\n\n"
                except Exception as e:
                    log.warning("Stream future error: %s", e)

        if not all_items:
            yield f"data: {json.dumps({'type': 'error', 'message': 'No audio found in any feed'})}\n\n"
            return

        try:
            curated = curate_with_claude(all_items, n=5, mood=mood)
            for item in curated:
                if item["audio_url"] != first_sent_url:
                    yield f"data: {json.dumps({'type': 'item', 'item': item})}\n\n"
        except Exception as e:
            log.error("Curation error: %s", e)
            yield f"data: {json.dumps({'type': 'error', 'message': 'Curation unavailable'})}\n\n"

        yield f"data: {json.dumps({'type': 'done'})}\n\n"

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.route("/api/playlist/continue", methods=["POST"])
def playlist_continue():
    data       = request.get_json() or {}
    heard_urls = set(data.get("heard_urls", []))
    lang       = data.get("language", "en")
    mood       = data.get("mood", "balanced")
    feeds      = _feeds_for_language(lang)

    all_items = _fetch_feeds(feeds, max_count=4)
    fresh = [i for i in all_items if i["audio_url"] not in heard_urls]

    if len(fresh) < 3:
        extra_feeds = ENGLISH_EXTENDED if lang in ("en", "english") else {}
        if extra_feeds:
            extra = _fetch_feeds(extra_feeds, max_count=3)
            fresh += [i for i in extra if i["audio_url"] not in heard_urls]

    if not fresh:
        return jsonify({"error": "No new clips available right now — try again shortly"}), 404

    try:
        curated = curate_with_claude(fresh, n=3, mood=mood)
        return jsonify({"items": curated, "max_clip_seconds": MAX_CLIP_SECONDS})
    except Exception as e:
        log.error("Continue curation error: %s", e)
        return jsonify({"error": "Curation unavailable"}), 500


# ── Error handlers ────────────────────────────────────────────────────────────
@app.errorhandler(404)
def not_found(_e):
    if request.path.startswith("/api/"):
        return jsonify({"error": "Not found"}), 404
    return render_template("index.html"), 404


@app.errorhandler(500)
def server_error(e):
    log.error("500 error: %s", e)
    if request.path.startswith("/api/"):
        return jsonify({"error": "Internal server error"}), 500
    return render_template("index.html"), 500


if __name__ == "__main__":
    app.run(debug=True, threaded=True)
