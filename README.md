# Nerodolla

Self-custody Monero wallet with delta-neutral USD hedge via [Lighter.xyz](https://lighter.xyz).

Lock in the USD value of your XMR and earn funding yield (~19% APY historically) — no token, no KYC, no custodian.

## How It Works

1. **Deposit XMR** into the in-app wallet (standard Monero light wallet)
2. **Lock USD value** — one tap opens a short XMR/USD position on Lighter equal to your balance. If XMR drops, the short gains equivalently. Your USD value stays flat.
3. **Earn funding yield** — long traders pay you a continuous funding rate for holding the short side

Unlock any time — close the short, withdraw USDC, swap back to XMR.

## Architecture

```
┌─────────────────────┐        ┌──────────────────────┐
│  Mobile / Browser   │        │  lighter_proxy.py     │
│  (React + Vite)     │◄──────►│  (FastAPI, Python)    │
│                     │ HTTPS  │                       │
│  - Wallet UI        │        │  - Lighter SDK (ZK)   │
│  - Key management   │        │  - monero-wallet-rpc  │
│  - EIP-3009 signing │        │  - EIP-3009 relay     │
│  - PIN encryption   │        │  - MM bot (per-user)  │
└─────────────────────┘        └──────────────────────┘
                                        │
                        ┌───────────────┼───────────────┐
                        ▼               ▼               ▼
                   Lighter.xyz    monero-lws        Ethereum
                   (ZK orderbook)  (balance/tx)    (USDC relay)
```

**Key design choice**: Lighter uses ZK-native signing via a prebuilt `.so` — this cannot run in a browser, so a backend proxy is required. The proxy handles Lighter SDK calls and monero-wallet-rpc signing. See [SECURITY.md](SECURITY.md) for the full trust model.

## Tech Stack

- **Frontend**: React 18, TypeScript, Vite 5, Zustand, Capacitor 6 (Android)
- **Crypto**: `@noble/curves` (ed25519), `@noble/hashes` (keccak256), `ethers` v6, `bip39`
- **Backend**: Python 3.12, FastAPI, lighter-sdk, SQLite
- **No WASM, no mymonero-core-js** — all Monero key derivation is native TypeScript

## Setup

### Prerequisites

- Node.js 18+
- Python 3.12+
- A running `monerod` + `monero-lws` instance (for balance/tx queries)
- A Lighter.xyz account (for the hedge)

### Frontend

```bash
cp .env.example .env
# Fill in your values (see .env.example for descriptions)
npm install
npm run dev          # http://localhost:3000
```

### Proxy

```bash
python -m venv venv
source venv/bin/activate
pip install fastapi uvicorn lighter-sdk web3 eth-account
python lighter_proxy.py   # http://localhost:8000
```

The Vite dev server proxies `/lighter/*` and `/lws/*` to the proxy automatically.

### Android

```bash
npm run build
npx cap sync android
npx cap open android     # Opens in Android Studio
```

## Configuration

All user-facing settings are in the Settings screen:

| Setting | Default | Notes |
|---------|---------|-------|
| monero-lws endpoint | `/lws` (proxied) | Point to your own LWS instance |
| Proxy server URL | `https://proxy.example.com` | Required on Android — set to your server |
| Network | mainnet | Switch to stagenet for testing |

## Project Structure

```
src/
  wallet/          Key derivation and encryption
    seed.ts          BIP-39 mnemonic -> XMR + ETH seeds
    xmr.ts           Monero key derivation (native @noble/curves)
    eth.ts           ETH wallet + EIP-3009 signing
    keystore.ts      AES-256-GCM encrypted storage (PBKDF2, PIN-derived)
  backend/         API clients
    lighter.ts       Proxy client (hedge, bot, relay, market data)
    lws.ts           monero-lws client (balance, transfers)
    wagyu.ts         wagyu.xyz client (XMR<->USDC swaps)
  store/
    wallet.ts        Zustand global store (keys in-memory, settings persisted)
  ui/
    screens/         App screens (Home, Send, Receive, Swap, Hedge, Settings)
    components/      Orchestrators (Hedge, Unhedge, TopUp, Bot, Setup)
lighter_proxy.py   Backend proxy (FastAPI, multi-tenant, SQLite)
```

## License

[GPL-3.0](LICENSE)
