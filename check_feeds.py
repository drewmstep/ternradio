"""Quick check of which news feeds actually return audio right now.

Run it in the terminal where the app works (venv activated):
    python check_feeds.py

It prints, per source, whether it returned an audio item, is empty, or failed
(and why) — so we can see which French/Spanish/English feeds are broken.
"""
from dotenv import load_dotenv
load_dotenv()

from app import ENGLISH_FEEDS, ENGLISH_EXTENDED, FRENCH_FEEDS, SPANISH_FEEDS, _fetch_one


def check(name, feeds):
    print(f"\n=== {name} ===")
    for src, (url, country) in feeds.items():
        try:
            items = _fetch_one(src, url, country, max_count=1)
            status = "OK  " if items else "EMPTY"
            print(f"  {status} {src:<22} {len(items)} item(s)  {country}")
        except Exception as e:                       # noqa: BLE001
            print(f"  FAIL {src:<22} {type(e).__name__}: {str(e)[:90]}")


# Candidate replacement feeds to test (many may fail — that's expected; we keep
# the ones that print OK and wire them in).
CANDIDATES = {
    # --- Spanish (Latin America + NPR en español) ---
    "NPR en Español":      ("https://feeds.npr.org/1102186359/podcast.xml",       "the United States"),
    "Radio Ambulante":     ("https://feeds.npr.org/510311/podcast.xml",           "the United States"),
    "El hilo (LatAm)":     ("https://feeds.simplecast.com/sQ8Ev9rk",              "Colombia"),
    "RNE Las Mañanas":     ("https://api.rtve.es/api/programas/2289/audios.rss",  "Spain"),
    "DW Español (alt)":    ("https://rss.dw.com/xml/podcast_spanish",             "Germany"),
    # --- French (Quebec + more) ---
    "Radio-Canada Info":   ("https://www.radio-canada.ca/rss/4159686/balado",     "Canada"),
    "France Inter Journal":("https://radiofrance-podcast.net/podcasts/rss_10174.xml", "France"),
    "France Culture Actu": ("https://radiofrance-podcast.net/podcasts/rss_11710.xml", "France"),
    "Euronews Français":   ("https://fr.euronews.com/api/podcasts/rss",           "France"),
}


if __name__ == "__main__":
    check("ENGLISH", ENGLISH_FEEDS)
    check("FRENCH", FRENCH_FEEDS)
    check("SPANISH", SPANISH_FEEDS)
    check("CANDIDATES (testing new sources — some will fail)", CANDIDATES)
    print("\nDone. Paste this whole output back.")
