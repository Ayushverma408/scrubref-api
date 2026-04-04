#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
#  deploy-app.sh  —  Deploy scrubref-api + scrubref-web on App box
#
#  Usage:
#    ./deploy-app.sh           → deploy both services
#    ./deploy-app.sh api       → deploy scrubref-api only
#    ./deploy-app.sh web       → deploy scrubref-web only
#    ./deploy-app.sh status    → show PM2 service status
# ──────────────────────────────────────────────────────────────

API_DIR="/home/ubuntu/scrubref-api"
WEB_DIR="/home/ubuntu/scrubref-web"

API_PORT=3001
WEB_PORT=3000

BOLD="\033[1m"; RESET="\033[0m"
GREEN="\033[32m"; YELLOW="\033[33m"; RED="\033[31m"; CYAN="\033[36m"

info()    { echo -e "${CYAN}${BOLD}[deploy]${RESET} $*"; }
success() { echo -e "${GREEN}${BOLD}[deploy]${RESET} $*"; }
warn()    { echo -e "${YELLOW}${BOLD}[deploy]${RESET} $*"; }
err()     { echo -e "${RED}${BOLD}[deploy]${RESET} $*"; }

is_running() { curl -sf "http://localhost:$1/health" >/dev/null 2>&1 || curl -sf "http://localhost:$1" >/dev/null 2>&1; }

wait_for_port() {
    local port=$1 label=$2 max=${3:-30} i=0
    while (( i < max )); do
        is_running "$port" && return 0
        sleep 2; (( i += 2 ))
        (( i % 6 == 0 )) && echo -ne "    ${label}: ${i}s elapsed…\r"
    done
    return 1
}

# ── status ────────────────────────────────────────────────────
if [[ "$1" == "status" ]]; then
    echo ""; echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}         🩺  ScrubRef App Box  —  Status${RESET}"
    echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"; echo ""
    pm2 status
    echo ""
    is_running $API_PORT && success "scrubref-api  ✓  port $API_PORT responding" || err "scrubref-api  ✗  port $API_PORT not responding"
    is_running $WEB_PORT && success "scrubref-web  ✓  port $WEB_PORT responding" || err "scrubref-web  ✗  port $WEB_PORT not responding"
    echo ""; echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"; echo ""
    exit 0
fi

TARGET="${1:-both}"
if [[ "$TARGET" != "both" && "$TARGET" != "api" && "$TARGET" != "web" ]]; then
    err "Unknown target: $TARGET. Use: api | web | both | status"; exit 1
fi

echo ""; echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "${BOLD}         🩺  ScrubRef  —  Deploying App Box${RESET}"
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"; echo ""

# ── scrubref-api ──────────────────────────────────────────────
if [[ "$TARGET" == "both" || "$TARGET" == "api" ]]; then
    info "── scrubref-api ──────────────────────────"

    cd "$API_DIR" || { err "Cannot find $API_DIR"; exit 1; }

    info "Pulling latest code…"
    git pull || { err "git pull failed"; exit 1; }
    success "git pull ✓"

    info "Installing dependencies…"
    npm install --silent || { err "npm install failed"; exit 1; }
    success "npm install ✓"

    info "Building TypeScript…"
    npm run build || { err "Build failed — aborting deploy"; exit 1; }
    success "Build ✓"

    info "Restarting service…"
    pm2 restart scrubref-api --update-env || { err "pm2 restart failed"; exit 1; }
    sleep 3

    if is_running $API_PORT; then
        success "scrubref-api  ✓  running on port $API_PORT"
    else
        err "scrubref-api did not come up — check: pm2 logs scrubref-api"
        exit 1
    fi
    echo ""
fi

# ── scrubref-web ──────────────────────────────────────────────
if [[ "$TARGET" == "both" || "$TARGET" == "web" ]]; then
    info "── scrubref-web ──────────────────────────"

    cd "$WEB_DIR" || { err "Cannot find $WEB_DIR"; exit 1; }

    info "Pulling latest code…"
    git pull || { err "git pull failed"; exit 1; }
    success "git pull ✓"

    info "Installing dependencies…"
    npm install --silent || { err "npm install failed"; exit 1; }
    success "npm install ✓"

    info "Building Next.js (this takes ~1-2 min)…"
    npm run build || { err "Build failed — aborting deploy"; exit 1; }
    success "Build ✓"

    info "Restarting service…"
    pm2 restart scrubref-web --update-env || { err "pm2 restart failed"; exit 1; }

    if wait_for_port $WEB_PORT "scrubref-web" 30; then
        success "scrubref-web  ✓  running on port $WEB_PORT"
    else
        err "scrubref-web did not come up — check: pm2 logs scrubref-web"
        exit 1
    fi
    echo ""
fi

# ── Summary ───────────────────────────────────────────────────
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
success "Deploy complete!"
echo -e "  Site   : ${BOLD}https://scrubref.shuf.site${RESET}"
echo -e "  Logs   : ${BOLD}pm2 logs${RESET}"
echo -e "  Status : ${BOLD}./deploy-app.sh status${RESET}"
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"; echo ""
