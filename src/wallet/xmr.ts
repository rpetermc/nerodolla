/**
 * xmr.ts — Monero key derivation
 *
 * Native TypeScript using @noble/curves (ed25519) + @noble/hashes (keccak256).
 * No WASM, no CJS compatibility hacks, fully synchronous.
 *
 * Derivation from a 32-byte seed (first 32 bytes of BIP-39 PBKDF2 output):
 *   spend_key = sc_reduce32(seed)               — seed as little-endian scalar mod l
 *   view_key  = sc_reduce32(keccak256(spend))
 *   pub_spend = spend_key × G  (ed25519 base point)
 *   pub_view  = view_key  × G
 *   address   = monero_base58(prefix || pub_spend || pub_view || keccak256[:4])
 *
 * This matches the derivation used by MyMonero and Cake Wallet for BIP-39 seeds.
 */

import { ed25519 } from '@noble/curves/ed25519.js';
import { keccak_256 } from '@noble/hashes/sha3.js';

// ── Constants ─────────────────────────────────────────────────────────────────

// ed25519 group order l = 2^252 + 27742317777372353535851937790883648493
const L = ed25519.Point.Fn.ORDER;

// Monero network prefix bytes (standard addresses)
const NETWORK_BYTE: Record<Network, number> = { mainnet: 18, testnet: 24, stagenet: 53 };

export type Network = 'mainnet' | 'testnet' | 'stagenet';

export interface XmrKeys {
  primaryAddress: string;
  spendKeyPrivate: string; // 64 hex chars (32-byte little-endian scalar)
  spendKeyPublic: string;  // 64 hex chars (32-byte compressed ed25519 point)
  viewKeyPrivate: string;  // 64 hex chars
  viewKeyPublic: string;   // 64 hex chars
}

// ── Monero Base58 ─────────────────────────────────────────────────────────────
// Encodes in 8-byte chunks → 11 chars each; the final partial chunk uses the
// smallest number of chars that can represent the value without ambiguity.

const B58_ALPHA = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
// Encoded character count for partial blocks (index = byte count 0..8)
const ENC_SIZES = [0, 2, 3, 5, 6, 7, 9, 10, 11];

function b58EncBlock(block: Uint8Array, out: string[], offset: number): void {
  let n = 0n;
  for (const b of block) n = n * 256n + BigInt(b);
  for (let i = ENC_SIZES[block.length] - 1; i >= 0; i--) {
    out[offset + i] = B58_ALPHA[Number(n % 58n)];
    n /= 58n;
  }
}

function moneroBase58(data: Uint8Array): string {
  const full = Math.floor(data.length / 8);
  const rem  = data.length % 8;
  const len  = full * 11 + (rem ? ENC_SIZES[rem] : 0);
  const out  = new Array<string>(len).fill('1');
  for (let i = 0; i < full; i++) b58EncBlock(data.slice(i * 8, i * 8 + 8), out, i * 11);
  if (rem) b58EncBlock(data.slice(full * 8), out, full * 11);
  return out.join('');
}

// ── Scalar helpers ────────────────────────────────────────────────────────────

// Monero stores scalars in little-endian byte order.
function leToBI(b: Uint8Array): bigint {
  let n = 0n;
  for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]);
  return n;
}

function biToLE32(n: bigint): Uint8Array {
  const b = new Uint8Array(32);
  for (let i = 0; i < 32; i++) { b[i] = Number(n & 0xffn); n >>= 8n; }
  return b;
}

// ── Byte / hex helpers ────────────────────────────────────────────────────────

function hexToBytes(hex: string): Uint8Array {
  const b = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) b[i >> 1] = parseInt(hex.slice(i, i + 2), 16);
  return b;
}

function bytesToHex(b: Uint8Array): string {
  return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Derive XMR address and key pair from a 32-byte hex seed.
 * Seed should come from seed.ts → xmrSeedFromMaster().
 */
export function deriveXmrKeys(seedHex: string, network: Network = 'mainnet'): XmrKeys {
  const seed = hexToBytes(seedHex);

  // Spend key: sc_reduce32(seed) — treat seed bytes as a little-endian integer, reduce mod l
  const spendScalar = leToBI(seed) % L;
  const spendBytes  = biToLE32(spendScalar);

  // View key: sc_reduce32(keccak256(spend_key))
  const viewScalar = leToBI(keccak_256(spendBytes)) % L;
  const viewBytes  = biToLE32(viewScalar);

  // Public keys: raw scalar × G (compressed ed25519 point, 32 bytes)
  const pubSpend = ed25519.Point.BASE.multiply(spendScalar).toBytes();
  const pubView  = ed25519.Point.BASE.multiply(viewScalar).toBytes();

  // Address: monero_base58(network_byte || pub_spend || pub_view || keccak256[:4])
  const prefix   = new Uint8Array([NETWORK_BYTE[network], ...pubSpend, ...pubView]);
  const checksum = keccak_256(prefix).slice(0, 4);
  const address  = moneroBase58(new Uint8Array([...prefix, ...checksum]));

  return {
    primaryAddress:  address,
    spendKeyPrivate: bytesToHex(spendBytes),
    spendKeyPublic:  bytesToHex(pubSpend),
    viewKeyPrivate:  bytesToHex(viewBytes),
    viewKeyPublic:   bytesToHex(pubView),
  };
}

/**
 * Basic address validation: length + network prefix character.
 * Standard Monero addresses are always 95 characters.
 */
export function validateXmrAddress(address: string, network: Network = 'mainnet'): boolean {
  if (!address || address.length !== 95) return false;
  // Mainnet standard '4', subaddress '8'; testnet '9'/'B'; stagenet '5'/'7'
  const validFirst: Record<Network, string[]> = {
    mainnet:  ['4', '8'],
    testnet:  ['9', 'B'],
    stagenet: ['5', '7'],
  };
  return validFirst[network].includes(address[0]);
}

/**
 * Returns true if the address is a subaddress (index != 0).
 */
export function isSubaddress(address: string, network: Network = 'mainnet'): boolean {
  if (!address || address.length !== 95) return false;
  const subFirst: Record<Network, string> = { mainnet: '8', testnet: 'B', stagenet: '7' };
  return address[0] === subFirst[network];
}
