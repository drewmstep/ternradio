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


if __name__ == "__main__":
    check("ENGLISH", ENGLISH_FEEDS)
    check("ENGLISH (extended)", ENGLISH_EXTENDED)
    check("FRENCH", FRENCH_FEEDS)
    check("SPANISH", SPANISH_FEEDS)
    print("\nDone. Paste this whole output back.")
