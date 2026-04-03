#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
#  medrag.sh  —  Start / stop the ScrubRef full stack
#
#  Usage:
#    ./medrag.sh          → prod mode (build + tunnel + scrubref.shuf.site)
#    ./medrag.sh prod     → same as above
#    ./medrag.sh dev      → dev mode  (npm run dev, localhost only, no tunnel)
#    ./medrag.sh stop     → kill everything
#    ./medrag.sh status   → show what's running
# ──────────────────────────────────────────────────────────────

ROOT="$(cd "$(dirname "$0")" && pwd)"
RAG_DIR="$ROOT/advanced-rag-poc"
API_DIR="$ROOT/scrubref-api"
WEB_DIR="$ROOT/scrubref-web"

RAG_PORT=8000
API_PORT=3001
WEB_PORT=3000

RAG_LOG="/tmp/scrubref-rag.log"
API_LOG="/tmp/scrubref-api.log"
WEB_LOG="/tmp/scrubref-web.log"
CF_LOG="/tmp/scrubref-cf.log"

BOLD="\033[1m"; RESET="\033[0m"
GREEN="\033[32m"; YELLOW="\033[33m"; RED="\033[31m"; CYAN="\033[36m"

PROD_URL="https://scrubref.shuf.site"
DEV_URL="http://localhost:3000"

info()    { echo -e "${CYAN}${BOLD}[scrubref]${RESET} $*"; }
success() { echo -e "${GREEN}${BOLD}[scrubref]${RESET} $*"; }
warn()    { echo -e "${YELLOW}${BOLD}[scrubref]${RESET} $*"; }
err()     { echo -e "${RED}${BOLD}[scrubref]${RESET} $*"; }

port_pids() { lsof -ti:"$1" -sTCP:LISTEN 2>/dev/null; }
is_running() { [[ -n "$(port_pids "$1")" ]]; }

check_db() {
    if [[ ! -f "$API_DIR/.env" ]]; then
        warn "scrubref-api .env not found — skipping DB check"
        return 0
    fi

    info "Checking Supabase database connection…"
    local result attempt
    # Retry up to 3 times — Supabase pooler can take a moment on first connection
    for attempt in 1 2 3; do
        result=$(cd "$API_DIR" && node -e "
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
p.\$connect()
  .then(() => p.\$queryRaw\`SELECT 1\`)
  .then(() => { p.\$disconnect(); console.log('ok'); process.exit(0); })
  .catch(e => { console.error(e.message); process.exit(1); });
" 2>&1)
        [[ "$result" == "ok" ]] && break
        [[ $attempt -lt 3 ]] && { info "  attempt $attempt failed, retrying…"; sleep 2; }
    done

    if [[ "$result" == "ok" ]]; then
        success "Supabase DB  ✓  connection healthy"
        return 0
    else
        local short_err; short_err=$(echo "$result" | grep -v "^$" | grep -v "^ " | head -1)
        err "Supabase DB  ✗  connection FAILED after 3 attempts"
        err "  Error : $short_err"
        err "  Fix   : go to app.supabase.com → your project → if it shows 'Restore project', click it"
        err "          (free tier pauses after 7 days of inactivity — password reset is NOT needed)"
        return 1
    fi
}

stop_services() {
    local killed=0
    for port in $RAG_PORT $API_PORT $WEB_PORT; do
        local pids; pids=$(port_pids "$port")
        if [[ -n "$pids" ]]; then
            echo "$pids" | xargs kill -9 2>/dev/null
            warn "Killed process on port $port"
            killed=1
        fi
    done
    if pgrep -f "cloudflared tunnel run medrag" >/dev/null 2>&1; then
        pkill -f "cloudflared tunnel run medrag" 2>/dev/null
        warn "Killed cloudflared tunnel"
        killed=1
    fi
    [[ $killed -eq 1 ]] && sleep 1
}

wait_for_port() {
    local port=$1 label=$2 max=${3:-30} i=0
    while (( i < max )); do
        if curl -sf "http://localhost:${port}" >/dev/null 2>&1 || \
           curl -sf "http://localhost:${port}/health" >/dev/null 2>&1; then
            return 0
        fi
        sleep 2; (( i += 2 ))
        (( i % 10 == 0 )) && echo -ne "    ${label}: ${i}s elapsed…\r"
    done
    return 1
}

# ── status ────────────────────────────────────────────────────
if [[ "$1" == "status" ]]; then
    echo ""; echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}         🩺  ScrubRef  —  Status${RESET}"
    echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"; echo ""
    is_running $RAG_PORT && success "RAG API  ✓  port $RAG_PORT  (PID $(port_pids $RAG_PORT))" || err "RAG API  ✗  not running"
    is_running $API_PORT && success "API      ✓  port $API_PORT  (PID $(port_pids $API_PORT))" || err "API      ✗  not running"
    is_running $WEB_PORT && success "Web      ✓  port $WEB_PORT  (PID $(port_pids $WEB_PORT))" || err "Web      ✗  not running"
    if pgrep -f "cloudflared tunnel run medrag" >/dev/null 2>&1; then
        success "Tunnel   ✓  (PID $(pgrep -f 'cloudflared tunnel run medrag'))  →  $PROD_URL"
    else
        warn "Tunnel   ✗  not running"
    fi
    echo ""; echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"; echo ""
    exit 0
fi

# ── stop ──────────────────────────────────────────────────────
if [[ "$1" == "stop" ]]; then
    stop_services && success "All services stopped." || info "Nothing was running."
    exit 0
fi

# ── mode ──────────────────────────────────────────────────────
MODE="${1:-prod}"
if [[ "$MODE" != "dev" && "$MODE" != "prod" ]]; then
    err "Unknown mode: $MODE. Use: dev | prod | stop | status"; exit 1
fi

echo ""; echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
if [[ "$MODE" == "dev" ]]; then
    echo -e "${BOLD}         🩺  ScrubRef  —  Dev mode${RESET}"
else
    echo -e "${BOLD}         🩺  ScrubRef  —  Production mode${RESET}"
fi
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"; echo ""

stop_services

# ── Pre-flight: DB check ──────────────────────────────────────
check_db || warn "Continuing — RAG pipeline works without DB, but scrubref-api queries will fail."
echo ""

# ── 1. RAG API (same in both modes) ──────────────────────────
info "Starting RAG API (port $RAG_PORT) — loading 4 books…"
cd "$RAG_DIR" || { err "Cannot find $RAG_DIR"; exit 1; }
nohup venv/bin/uvicorn src.api:app --port "$RAG_PORT" > "$RAG_LOG" 2>&1 &

info "Waiting for RAG API to warm up (~20s)…"
if wait_for_port $RAG_PORT "RAG API" 90; then
    success "RAG API ready ✓  (port $RAG_PORT)"
else
    err "RAG API did not start. Check: $RAG_LOG"; exit 1
fi
echo ""

# ── 2. scrubref-api (same in both modes) ─────────────────────
info "Building scrubref-api…"
cd "$API_DIR" || { err "Cannot find $API_DIR"; exit 1; }
npm run build >> "$API_LOG" 2>&1
if [[ $? -ne 0 ]]; then
    err "scrubref-api build failed. Check: $API_LOG"; exit 1
fi

info "Starting scrubref-api (port $API_PORT)…"
nohup npm start > "$API_LOG" 2>&1 &

sleep 3
if is_running $API_PORT; then
    success "scrubref-api ready ✓  (port $API_PORT)"
else
    err "scrubref-api failed to start. Check: $API_LOG"; exit 1
fi
echo ""

# ── 3. scrubref-web ───────────────────────────────────────────
cd "$WEB_DIR" || { err "Cannot find $WEB_DIR"; exit 1; }

if [[ "$MODE" == "dev" ]]; then
    # Dev: hot-reload, no build, localhost URLs
    info "Starting scrubref-web in dev mode (port $WEB_PORT)…"
    NEXT_PUBLIC_SITE_URL="$DEV_URL" nohup npm run dev > "$WEB_LOG" 2>&1 &
    if wait_for_port $WEB_PORT "Web" 30; then
        success "scrubref-web ready ✓  (port $WEB_PORT, hot-reload)"
    else
        err "scrubref-web failed to start. Check: $WEB_LOG"; exit 1
    fi
else
    # Prod: build with production URL baked in, then start
    info "Building scrubref-web (production)…"
    NEXT_PUBLIC_SITE_URL="$PROD_URL" npm run build > "$WEB_LOG" 2>&1
    if [[ $? -ne 0 ]]; then
        err "scrubref-web build failed. Check: $WEB_LOG"; exit 1
    fi

    info "Starting scrubref-web (port $WEB_PORT)…"
    NEXT_PUBLIC_SITE_URL="$PROD_URL" nohup npm start >> "$WEB_LOG" 2>&1 &

    if wait_for_port $WEB_PORT "Web" 30; then
        success "scrubref-web ready ✓  (port $WEB_PORT)"
    else
        err "scrubref-web failed to start. Check: $WEB_LOG"; exit 1
    fi
fi
echo ""

# ── 4. Cloudflare tunnel (prod only) ─────────────────────────
if [[ "$MODE" == "prod" ]]; then
    if command -v cloudflared >/dev/null 2>&1; then
        info "Starting Cloudflare tunnel → $PROD_URL…"
        nohup cloudflared tunnel run medrag > "$CF_LOG" 2>&1 &
        sleep 3
        if pgrep -f "cloudflared tunnel run medrag" >/dev/null 2>&1; then
            success "Tunnel live ✓  →  $PROD_URL"
        else
            warn "Tunnel did not start. Check: $CF_LOG"
        fi
    else
        warn "cloudflared not found — skipping (brew install cloudflared)"
    fi
else
    info "Dev mode — tunnel skipped. App available at $DEV_URL"
fi

echo ""
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
success "ScrubRef is live!  [mode: $MODE]"
if [[ "$MODE" == "prod" ]]; then
    echo -e "  Local  : ${BOLD}http://localhost:$WEB_PORT${RESET}"
    echo -e "  Public : ${BOLD}$PROD_URL${RESET}"
else
    echo -e "  URL    : ${BOLD}$DEV_URL${RESET}  (hot-reload)"
fi
echo -e "  Logs   : $RAG_LOG  |  $API_LOG  |  $WEB_LOG"
echo -e "  Stop   : ${BOLD}./medrag.sh stop${RESET}"
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"; echo ""
