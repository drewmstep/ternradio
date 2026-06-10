"""
WSGI entry point for production.
Gunicorn targets this module: gunicorn wsgi:app
"""
from dotenv import load_dotenv
load_dotenv()

from app import app  # noqa: E402 — must import after load_dotenv

if __name__ == "__main__":
    app.run()
