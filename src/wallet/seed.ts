/**
 * seed.ts — Master seed derivation
 *
 * One BIP-39 mnemonic → dual wallet:
 *   • XMR spend/view keys  (Monero derivation via mymonero-core-js)
 *   • ETH private key      (BIP-44 m/44'/60'/0'/0/0 via ethers.js)
 *
 * Security note: The raw seed bytes are kept in-memory only.
 * Never serialise or log seed/keys.
 */

import * as bip39 from 'bip39';

export interface MasterSeed {
  /** Raw 64-byte BIP-39 seed (PBKDF2 of mnemonic + optional passphrase) */
  seedBytes: Uint8Array;
  /** The mnemonic phrase (12 or 24 words) */
  mnemonic: string;
}

/**
 * Generate a fresh 24-word BIP-39 mnemonic and derive the master seed.
 * Uses 256 bits of entropy → 24 words.
 */
export function generateMnemonic(): string {
  return bip39.generateMnemonic(256);
}

/**
 * Validate a mnemonic phrase.
 */
export function validateMnemonic(mnemonic: string): boolean {
  return bip39.validateMnemonic(mnemonic.trim().toLowerCase());
}

/**
 * Derive the master seed from a mnemonic and optional passphrase.
 * Returns 64 bytes (512 bits) from BIP-39 PBKDF2.
 */
export async function mnemonicToSeed(
  mnemonic: string,
  passphrase = ''
): Promise<MasterSeed> {
  const normalized = mnemonic.trim().toLowerCase();
  if (!bip39.validateMnemonic(normalized)) {
    throw new Error('Invalid mnemonic phrase');
  }
  const seedBuffer = await bip39.mnemonicToSeed(normalized, passphrase);
  return {
    seedBytes: new Uint8Array(seedBuffer),
    mnemonic: normalized,
  };
}

/**
 * Extract the XMR seed slice: first 32 bytes of the 64-byte BIP-39 seed.
 *
 * mymonero-core-js accepts a raw 32-byte hex seed and treats it as the
 * Monero "seed integer" (scalar from which spend key is derived).
 * This is the same approach used by Cake Wallet and MyMonero mobile.
 */
export function xmrSeedFromMaster(seed: MasterSeed): string {
  const slice = seed.seedBytes.slice(0, 32);
  return Array.from(slice).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Extract the ETH seed bytes for BIP-44 derivation (full 64 bytes).
 * ethers.js HDNodeWallet.fromSeed() uses these directly.
 */
export function ethSeedFromMaster(seed: MasterSeed): Uint8Array {
  return seed.seedBytes;
}
