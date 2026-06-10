# Tern Radio — Deployment Guide

## Hosting

Tern Radio requires a server that supports:
- Python 3.12+
- Long-lived HTTP connections (SSE / Server-Sent Events)
- Custom environment variables

**Recommended: Railway** (~$5–20/month)  
Alternative: Render (free tier available, but SSE may time out on free plan)

---

## 1. Prepare the repository

```bash
git init
git add .
git commit -m "Initial commit"
gh repo create tern-radio --private --push
```

Ensure `.env` is in `.gitignore` and never committed.

---

## 2. Deploy to Railway

1. Go to [railway.app](https://railway.app) and create a new project from your GitHub repo.
2. Railway detects `railway.toml` automatically.
3. Set environment variables in the Railway dashboard (Variables tab):

| Variable | Value |
|---|---|
| `FLASK_ENV` | `production` |
| `ANTHROPIC_API_KEY` | your key from console.anthropic.com |
| `SECRET_KEY` | run `python -c "import secrets; print(secrets.token_hex(32))"` |
| `CANONICAL_DOMAIN` | `ternradio.org` |

4. Railway assigns a `*.up.railway.app` URL. Test it before setting up DNS.

---

## 3. DNS with Cloudflare (free)

Cloudflare provides free DNS, SSL termination, CDN, and DDoS protection.

1. Register `ternradio.org` and `ternradio.com` at any registrar.
2. Add both domains to Cloudflare (free plan).
3. Point nameservers to Cloudflare's (shown in Cloudflare dashboard).
4. In Cloudflare DNS for `ternradio.org`, add:
   - `CNAME @ → your-app.up.railway.app` (proxied ☁️)
   - `CNAME www → ternradio.org` (proxied ☁️)
5. In Cloudflare DNS for `ternradio.com`, add:
   - `CNAME @ → ternradio.org` (proxied ☁️)
   - `CNAME www → ternradio.org` (proxied ☁️)

In Railway, add both custom domains under Settings → Domains.

---

## 4. SSL

Cloudflare issues a free shared TLS certificate automatically.  
Set Cloudflare SSL/TLS mode to **Full (strict)** once Railway has its own cert provisioned (usually within minutes of adding the custom domain).

HSTS is sent by the app itself via the `Strict-Transport-Security` header on any HTTPS response.

---

## 5. Domain redirects

The app handles canonical redirects via `CANONICAL_DOMAIN` in `app.py`:

- Any request to `ternradio.com` → 301 redirect to `ternradio.org`
- Any request to `www.ternradio.org` → 301 redirect to `ternradio.org`

This happens at the application layer (`@app.before_request`), so it works regardless of how the DNS is configured. Cloudflare's Page Rules can do the same at the CDN layer for faster redirects if needed.

---

## 6. Environment variables

| Variable | Required | Description |
|---|---|---|
| `FLASK_ENV` | yes | Set to `production` in prod |
| `ANTHROPIC_API_KEY` | yes | Claude API key — never expose to browser |
| `SECRET_KEY` | yes | Random 32-byte hex string for Flask session signing |
| `CANONICAL_DOMAIN` | recommended | Hostname to redirect to (e.g. `ternradio.org`) |
| `PORT` | auto | Set by Railway/Render automatically |

Never commit `.env`. Copy `.env.example` → `.env` locally, fill in values.

---

## 7. Deploying updates

```bash
git add -p          # review changes
git commit -m "..."
git push origin main
```

Railway auto-deploys on push. Zero-downtime: Railway keeps the old instance alive until the new one passes the `/health` check.

---

## 8. Health check

The app exposes `GET /health` → `{"status": "ok"}` (HTTP 200).  
Railway uses this as its liveness probe (configured in `railway.toml`).

---

## 9. Monitoring and logs

**Railway logs:** dashboard → Deployments → View logs (stdout/stderr).  
Structured log format: `YYYY-MM-DDTHH:MM:SSZ LEVEL logger: message`

Key log events to watch:
- `[SourceName] N item(s)` — feed fetch result per source
- `[SourceName] fetch error: ...` — feed unreachable (not fatal)
- `Curation error: ...` — Claude API failure (returns error to client)
- `500 error: ...` — unhandled exception

---

## 10. Scaling

The Procfile uses 2 gunicorn gevent workers, each handling up to 1000 concurrent connections. SSE streams (one per active listener) are lightweight with gevent.

To scale: increase `--workers` (2× CPU cores is a safe default) or add a second Railway service instance. Each worker is stateless, so horizontal scaling is safe.

---

## 11. Maintenance

- **Rotate `ANTHROPIC_API_KEY`:** Update in Railway Variables, redeploy.
- **Update dependencies:** Edit `requirements.txt`, commit, push.
- **Add a new feed:** Edit the feed dictionaries in `app.py`, commit, push.
- **Backups:** The app has no persistent state. No database backup needed.
