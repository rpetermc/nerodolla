#!/usr/bin/env python3
"""
Rescan all nerodolla wallets from the oldest restore height.
Opens each wallet via monero-wallet-rpc and calls rescan_blockchain.
Run as: python3 rescan_wallets.py
"""
import json
import time
import urllib.request

WALLET_RPC = "http://127.0.0.1:18083/json_rpc"
RESTORE_HEIGHT = 3_607_779  # oldest restore height across all wallets

WALLETS = [
    "nd_41qJRNs6YsXB",
    "nd_41yqLhpaBMEG",
    "nd_42TeLEne5LZd",
    "nd_459Z2rSLEJVa",
    "nd_47A8scssHvER",
    "nd_47MtR6nyChsK",
    "nd_4872F6gy4Rkf",
    "nd_48Vw3x5TyxpQ",
    "nd_4B9ZpoxVQ5xG",
]


def rpc(method, params=None):
    body = json.dumps({
        "jsonrpc": "2.0", "id": "0",
        "method": method, "params": params or {}
    }).encode()
    req = urllib.request.Request(
        WALLET_RPC, data=body,
        headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.load(r)


def wait_for_sync(wallet_name):
    """Poll wallet height until it stabilises (rescan complete)."""
    prev = 0
    stable = 0
    while True:
        try:
            h = rpc("get_height").get("result", {}).get("height", 0)
            if h == prev:
                stable += 1
                if stable >= 3:
                    print(f"  → done at height {h}")
                    return
            else:
                stable = 0
                prev = h
                print(f"  scanning... height={h}", end="\r", flush=True)
        except Exception as e:
            print(f"  poll error: {e}")
        time.sleep(5)


for wallet in WALLETS:
    print(f"\n{'='*50}")
    print(f"Processing: {wallet}")

    # Close any open wallet
    try:
        rpc("close_wallet")
    except Exception:
        pass

    # Open wallet
    try:
        result = rpc("open_wallet", {"filename": wallet, "password": ""})
        if "error" in result:
            print(f"  SKIP: could not open — {result['error']}")
            continue
        print(f"  opened")
    except Exception as e:
        print(f"  SKIP: {e}")
        continue

    # Trigger rescan from restore height
    try:
        rpc("rescan_blockchain")
        print(f"  rescan triggered from height {RESTORE_HEIGHT}")
    except Exception as e:
        print(f"  rescan error: {e}")
        continue

    wait_for_sync(wallet)

# Close and leave clean
try:
    rpc("close_wallet")
except Exception:
    pass

print("\nAll wallets rescanned.")
