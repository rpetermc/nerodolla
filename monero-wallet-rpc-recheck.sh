#!/bin/bash
# monero-wallet-rpc-recheck.sh
# Called by systemd timer every 15 minutes.
# If local monerod has become fully synced but wallet-rpc is still using a
# public node, restart wallet-rpc so the wrapper picks up the local node.

SYNCED=$(curl -sf --max-time 3 "http://127.0.0.1:29798/get_info" \
    | python3 -c "import json,sys; print(json.load(sys.stdin).get('synchronized', False))" \
    2>/dev/null || echo "False")

if [ "$SYNCED" != "True" ]; then
    exit 0
fi

# Check if wallet-rpc is currently using a public node (not local)
if pgrep -af monero-wallet-rpc | grep -q "127.0.0.1:29798"; then
    exit 0  # Already using local node, nothing to do
fi

logger -t monero-wallet-rpc "Local node now fully synced — restarting wallet-rpc to switch from public fallback"
systemctl restart monero-wallet-rpc
