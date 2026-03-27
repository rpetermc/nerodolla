// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import { deriveEthWallet, validateEthAddress, createEthSigner, signMessage, ETH_DERIVATION_PATH } from './eth';

// Helper: convert hex to proper Uint8Array that ethers.js accepts
function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) {
    bytes[i / 2] = parseInt(clean.slice(i, i + 2), 16);
  }
  return bytes;
}

describe('eth', () => {
  // Known 64-byte seed (hex) — derived from "abandon...art" mnemonic
  // We use a fixed hex string to avoid bip39's Buffer compat issues in tests
  const TEST_SEED_HEX =
    '235b34cd7c9f6d7e4595ffe9ae4b1cb5606df8aca2b527d20a07c8f56b2342f4' +
    'f40eaad21641ca7cb5ac00f9ce21cac9ba070bb673a237f7bce57acda54386a4';

  function getSeedBytes() {
    return hexToBytes(TEST_SEED_HEX);
  }

  function getExpectedAddress() {
    return ethers.HDNodeWallet.fromSeed(getSeedBytes())
      .derivePath(ETH_DERIVATION_PATH).address;
  }

  describe('deriveEthWallet', () => {
    it('produces a valid checksummed ETH address', () => {
      const wallet = deriveEthWallet(getSeedBytes());
      expect(wallet.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(validateEthAddress(wallet.address)).toBe(true);
    });

    it('matches ethers.js direct derivation', () => {
      const wallet = deriveEthWallet(getSeedBytes());
      expect(wallet.address).toBe(getExpectedAddress());
    });

    it('produces a 0x-prefixed private key', () => {
      const wallet = deriveEthWallet(getSeedBytes());
      expect(wallet.privateKey).toMatch(/^0x[0-9a-f]{64}$/);
    });

    it('produces a 0x-prefixed compressed public key', () => {
      const wallet = deriveEthWallet(getSeedBytes());
      expect(wallet.publicKey).toMatch(/^0x(02|03)[0-9a-f]{64}$/);
    });

    it('is deterministic', () => {
      const a = deriveEthWallet(getSeedBytes());
      const b = deriveEthWallet(getSeedBytes());
      expect(a).toEqual(b);
    });
  });

  describe('validateEthAddress', () => {
    it('accepts valid checksum address', () => {
      expect(validateEthAddress('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045')).toBe(true);
    });

    it('accepts lowercase address', () => {
      expect(validateEthAddress('0xd8da6bf26964af9d7eed9e03e53415d37aa96045')).toBe(true);
    });

    it('rejects invalid address', () => {
      expect(validateEthAddress('not-an-address')).toBe(false);
    });

    it('rejects empty string', () => {
      expect(validateEthAddress('')).toBe(false);
    });
  });

  describe('createEthSigner', () => {
    it('creates a signer with matching address', () => {
      const wallet = deriveEthWallet(getSeedBytes());
      const signer = createEthSigner(wallet);
      expect(signer.address).toBe(wallet.address);
    });
  });

  describe('signMessage', () => {
    it('produces a valid signature', async () => {
      const wallet = deriveEthWallet(getSeedBytes());
      const sig = await signMessage(wallet, 'hello');
      expect(sig).toMatch(/^0x[0-9a-f]{130}$/);
    });

    it('is deterministic for same message', async () => {
      const wallet = deriveEthWallet(getSeedBytes());
      const a = await signMessage(wallet, 'test message');
      const b = await signMessage(wallet, 'test message');
      expect(a).toBe(b);
    });

    it('different messages produce different signatures', async () => {
      const wallet = deriveEthWallet(getSeedBytes());
      const a = await signMessage(wallet, 'message A');
      const b = await signMessage(wallet, 'message B');
      expect(a).not.toBe(b);
    });
  });
});
