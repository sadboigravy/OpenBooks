# ---------- Stage 1: build the React web UI ----------
FROM node:20-alpine AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# ---------- Stage 2: Python API + static UI ----------
FROM python:3.11-slim
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=3000 \
    DATA_DIR=/data \
    STATIC_DIR=/app/static

WORKDIR /app
COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/ ./
COPY --from=web /web/dist ./static

RUN useradd --create-home --uid 1000 openbooks \
    && mkdir -p /data && chown openbooks:openbooks /data
USER openbooks
VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
    CMD python -c "import urllib.request,os; urllib.request.urlopen(f'http://127.0.0.1:{os.environ[\"PORT\"]}/health')" || exit 1

# One worker process (SQLite) with several threads; binds to all interfaces so
# the app is reachable from outside the container. The longer timeout leaves
# room for AI assistant answers that look up several reports.
CMD ["sh", "-c", "exec gunicorn --bind 0.0.0.0:${PORT} --workers 1 --threads 8 --timeout 180 --access-logfile - wsgi:app"]
