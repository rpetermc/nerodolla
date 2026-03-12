# Security

## Trust Model

Nerodolla is a light wallet — it does not run a full Monero node. This means:

- **Balance queries** go through a monero-lws (Light Wallet Server) instance. The LWS
  sees your view key and can observe your balance and incoming transactions. It cannot
  spend your funds.

- **XMR transfers** are currently signed server-side via monero-wallet-rpc. Your spend
  key is sent to the proxy over HTTPS for the duration of the signing operation. It is
  not persisted. This means you must trust the proxy operator during transfers. Client-side
  WASM signing is planned to eliminate this.

- **Lighter.xyz operations** (hedge open/close, bot, withdrawals) are signed server-side
  using a ZK API key that is stored encrypted in your browser (AES-GCM, keyed by your
  ETH private key). The proxy decrypts and uses it transiently.

- **EIP-3009 relay**: The proxy's ETH wallet pays gas for USDC transfers on your behalf.
  The transfer authorization is signed client-side — the proxy cannot redirect your funds,
  only submit the pre-signed transfer.

## Reporting a Vulnerability

If you find a security issue, please report it responsibly:

- **Do NOT open a public GitHub issue for security vulnerabilities**
- Contact the maintainer via an encrypted channel (details TBD)
- You will receive acknowledgement within 72 hours
- Critical issues (fund loss risk) will be patched within 24 hours of confirmation

## Key Storage

| Secret | Where | Encryption |
|--------|-------|------------|
| Mnemonic | localStorage | AES-256-GCM, PBKDF2 (210k iterations), PIN-derived key |
| XMR keys | In-memory only | Cleared on lock |
| ETH private key | In-memory only | Derived from mnemonic on unlock |
| Lighter ZK key | localStorage | AES-256-GCM, HKDF (keyed by ETH private key) |
| PIN | Never stored | Used to derive PBKDF2 key, then discarded |

## Self-Hosting

For maximum security, run your own instance of:
1. `lighter_proxy.py` — the backend proxy
2. `monero-lws` — light wallet server (connected to your own `monerod`)

See README.md for setup instructions.
