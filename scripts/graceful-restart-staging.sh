#!/bin/bash
#
# Graceful restart of the staging proxy with maintenance mode.
# This prevents users from re-registering ZK keys while the proxy is down.
#
# Usage: ./graceful-restart-staging.sh
#
# Runs as deploy user; uses sudo only for Caddy operations (NOPASSWD configured).
#

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NERODOLLA_DIR="/opt/nerodolla"
CADDY_CONFIG="/etc/caddy/Caddyfile"
CADDY_BACKUP="/tmp/Caddyfile.backup"
PROXY_LOG="$NERODOLLA_DIR/proxy_dev.log"
PROXY_PORT=8001

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log() { echo -e "${GREEN}[$(date '+%H:%M:%S')]${NC} $1"; }
warn() { echo -e "${YELLOW}[$(date '+%H:%M:%S')]${NC} $1"; }
error() { echo -e "${RED}[$(date '+%H:%M:%S')]${NC} $1"; }

# Backup current Caddy config
log "Backing up Caddy config..."
sudo cp "$CADDY_CONFIG" "$CADDY_BACKUP"

# Create maintenance mode Caddy config for staging
log "Enabling maintenance mode for staging.nerohedge.app..."
cat > /tmp/Caddyfile.maintenance << 'MAINTENANCE_EOF'
# Landing page
nerodolla.app {
    @www host www.nerodolla.app
    redir @www https://nerodolla.app{uri} permanent

    root * /opt/nerodolla/website
    file_server

    @apk path *.apk
    header @apk Cache-Control "no-cache"
}

www.nerodolla.app {
    redir https://nerodolla.app{uri} permanent
}

# Web app (React SPA + PWA)
app.nerodolla.app {
    root * /opt/nerodolla/dist

    # Required for Monero WASM (SharedArrayBuffer)
    header Cross-Origin-Opener-Policy   "same-origin"
    header Cross-Origin-Embedder-Policy "require-corp"

    # Service worker — never cache
    @sw path /sw.js
    header @sw Cache-Control "no-cache, no-store, must-revalidate"

    # Vite hashed assets — cache forever
    @assets path /assets/*
    header @assets Cache-Control "public, immutable, max-age=31536000"

    # SPA fallback for client-side routing
    try_files {path} /index.html
    file_server
}

# Lighter proxy (existing)
vmi1874634.contaboserver.net {
    reverse_proxy localhost:8000
}

# Staging (EUR hedge feature branch)
staging.nerodolla.app {
    root * /opt/nerodolla/dist-staging
    header Cross-Origin-Opener-Policy "same-origin"
    header Cross-Origin-Embedder-Policy "require-corp"
    @sw path /sw.js
    header @sw Cache-Control "no-cache, no-store, must-revalidate"
    @assets path /assets/*
    header @assets Cache-Control "public, immutable, max-age=31536000"
    handle /lws/* {
        reverse_proxy localhost:8000
    }
    handle /lighter/* {
        reverse_proxy localhost:8000
    }
    handle {
        try_files {path} /index.html
        file_server
    }
}

# ── NeroHedge domains ─────────────────────────────────────────────────────────

# Landing page
nerohedge.app {
    @www host www.nerohedge.app
    redir @www https://nerohedge.app{uri} permanent

    root * /opt/nerodolla/website
    file_server

    @apk path *.apk
    header @apk Cache-Control "no-cache"
}

www.nerohedge.app {
    redir https://nerohedge.app{uri} permanent
}

# Web app (React SPA + PWA)
app.nerohedge.app {
    root * /opt/nerodolla/dist
    header Cross-Origin-Opener-Policy   "same-origin"
    header Cross-Origin-Embedder-Policy "require-corp"
    @sw path /sw.js
    header @sw Cache-Control "no-cache, no-store, must-revalidate"
    @assets path /assets/*
    header @assets Cache-Control "public, immutable, max-age=31536000"
    @api path /lws/* /lighter/* /bot/* /hedge/* /session/* /setup/* /relay/* /market/* /trocador/* /swap/*
    handle @api {
        reverse_proxy localhost:8000
    }
    handle {
        try_files {path} /index.html
        file_server
    }
}

# Staging - MAINTENANCE MODE
# Serves maintenance page, blocks API access to prevent ZK key re-registration
staging.nerohedge.app {
    header Cross-Origin-Opener-Policy "same-origin"
    header Cross-Origin-Embedder-Policy "require-corp"

    # Allow health check endpoint for auto-reload
    @healthcheck path /lighter/market/XMR-USD
    handle @healthcheck {
        reverse_proxy localhost:8001
    }

    # Block all other API calls during maintenance
    @api path /lws/* /lighter/* /bot/* /hedge/* /session/* /setup/* /relay/* /market/* /trocador/* /swap/*
    handle @api {
        respond "Service temporarily unavailable" 503
    }

    # Serve maintenance page for everything else
    handle {
        rewrite * /maintenance.html
        root * /opt/nerodolla
        file_server
    }
}

# nerohedge.com → redirect to nerohedge.app
nerohedge.com, www.nerohedge.com {
    redir https://nerohedge.app{uri} permanent
}
MAINTENANCE_EOF

sudo cp /tmp/Caddyfile.maintenance "$CADDY_CONFIG"
sudo systemctl reload caddy
log "Maintenance mode enabled"

# Wait for in-flight requests to complete
log "Waiting for in-flight requests to drain..."
sleep 3

# Stop the staging proxy
log "Stopping staging proxy..."
pkill -f "lighter_proxy_dev:app.*$PROXY_PORT" 2>/dev/null || true
sleep 2

# Verify proxy is stopped
if pgrep -f "lighter_proxy_dev:app.*$PROXY_PORT" > /dev/null; then
    warn "Proxy still running, force killing..."
    pkill -9 -f "lighter_proxy_dev:app.*$PROXY_PORT" 2>/dev/null || true
    sleep 1
fi

# Start proxy with bot auto-resume
log "Starting staging proxy with RESUME_BOTS=1..."
cd "$NERODOLLA_DIR"
RESUME_BOTS=1 nohup /opt/nerodolla/venv/bin/python -m uvicorn lighter_proxy_dev:app --host 0.0.0.0 --port $PROXY_PORT >> "$PROXY_LOG" 2>&1 &
PROXY_PID=$!

# Wait for proxy to start
log "Waiting for proxy to initialize..."
sleep 5

# Check proxy is running
if ! pgrep -f "lighter_proxy_dev:app.*$PROXY_PORT" > /dev/null; then
    error "Proxy failed to start! Check $PROXY_LOG"
    # Restore Caddy config
    sudo cp "$CADDY_BACKUP" "$CADDY_CONFIG"
    sudo systemctl reload caddy
    exit 1
fi

# Wait for bot resumes to complete
log "Waiting for bots to resume..."
sleep 10

# Count resumed bots
RESUMED_BOTS=$(grep -c "Resumed bot:" "$PROXY_LOG" 2>/dev/null | tail -1 || echo "0")
FAILED_BOTS=$(grep -c "Resume:.*skipping" "$PROXY_LOG" 2>/dev/null | tail -1 || echo "0")

log "Bot resume status: $RESUMED_BOTS resumed, $FAILED_BOTS failed"

# Check active bots in database
ACTIVE_BOTS=$(/opt/nerodolla/venv/bin/python3 -c "
import sqlite3
conn = sqlite3.connect('/opt/nerodolla/wallets/nerodolla.db')
cur = conn.cursor()
cur.execute('SELECT COUNT(*) FROM bot_sessions WHERE active = 1')
print(cur.fetchone()[0])
" 2>/dev/null || echo "unknown")
log "Active bot sessions in DB: $ACTIVE_BOTS"

# Restore normal Caddy config
log "Disabling maintenance mode..."
sudo cp "$CADDY_BACKUP" "$CADDY_CONFIG"
sudo systemctl reload caddy

log "Done! Staging proxy restarted successfully."
log "Check logs: tail -f $PROXY_LOG"

# Show recent bot activity
echo ""
log "Recent bot activity:"
grep -E "Bot\[.*\] [0-9]+ orders|Resumed bot" "$PROXY_LOG" | tail -10
