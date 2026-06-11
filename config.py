"""
Configuration classes for Tern Radio.
FLASK_ENV=development (default) → Development
FLASK_ENV=production            → Production
"""
import os
from datetime import timedelta


class Config:
    SECRET_KEY         = os.environ.get("SECRET_KEY", "dev-fallback-change-in-prod")
    ANTHROPIC_API_KEY  = os.environ.get("ANTHROPIC_API_KEY", "")
    GROQ_API_KEY       = os.environ.get("GROQ_API_KEY", "")
    CANONICAL_DOMAIN   = os.environ.get("CANONICAL_DOMAIN", "")
    MAX_CLIP_SECONDS   = 100
    # Smart Gist (Whisper + Claude). OFF by default — when off the app behaves
    # exactly as before; the /api/gist endpoint just returns null.
    SMART_GIST_ENABLED = os.environ.get("SMART_GIST_ENABLED", "").strip().lower() in (
        "1", "true", "yes", "on",
    )


class Development(Config):
    DEBUG = True
    TESTING = False
    SEND_FILE_MAX_AGE_DEFAULT = timedelta(seconds=0)


class Production(Config):
    DEBUG = False
    TESTING = False
    SEND_FILE_MAX_AGE_DEFAULT = timedelta(days=365)
    SESSION_COOKIE_SECURE   = True
    SESSION_COOKIE_HTTPONLY = True
    SESSION_COOKIE_SAMESITE = "Lax"


def get_config():
    env = os.environ.get("FLASK_ENV", "development").lower()
    return Production if env == "production" else Development
