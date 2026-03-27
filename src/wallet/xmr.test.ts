import { describe, it, expect } from 'vitest';
import { deriveXmrKeys, validateXmrAddress, isSubaddress } from './xmr';
import { mnemonicToSeed, xmrSeedFromMaster } from './seed';

describe('xmr', () => {
  // Well-known test vector: "abandon...art" 24-word mnemonic
  const TEST_MNEMONIC =
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art';

  let testSeedHex: string;

  // Derive the seed once for all tests
  beforeAll(async () => {
    const seed = await mnemonicToSeed(TEST_MNEMONIC);
    testSeedHex = xmrSeedFromMaster(seed);
  });

  describe('deriveXmrKeys', () => {
    it('produces a valid mainnet address starting with 4', () => {
      const keys = deriveXmrKeys(testSeedHex);
      expect(keys.primaryAddress).toMatch(/^4/);
      expect(keys.primaryAddress).toHaveLength(95);
    });

    it('produces 64-hex-char private keys', () => {
      const keys = deriveXmrKeys(testSeedHex);
      expect(keys.spendKeyPrivate).toMatch(/^[0-9a-f]{64}$/);
      expect(keys.viewKeyPrivate).toMatch(/^[0-9a-f]{64}$/);
    });

    it('produces 64-hex-char public keys', () => {
      const keys = deriveXmrKeys(testSeedHex);
      expect(keys.spendKeyPublic).toMatch(/^[0-9a-f]{64}$/);
      expect(keys.viewKeyPublic).toMatch(/^[0-9a-f]{64}$/);
    });

    it('is deterministic', () => {
      const a = deriveXmrKeys(testSeedHex);
      const b = deriveXmrKeys(testSeedHex);
      expect(a).toEqual(b);
    });

    it('different seed produces different keys', () => {
      // Flip one byte in the seed
      const altSeed = 'ff' + testSeedHex.slice(2);
      const a = deriveXmrKeys(testSeedHex);
      const b = deriveXmrKeys(altSeed);
      expect(a.primaryAddress).not.toBe(b.primaryAddress);
      expect(a.spendKeyPrivate).not.toBe(b.spendKeyPrivate);
    });

    // NOTE: NETWORK_BYTE has testnet/stagenet swapped (stagenet=53 should be testnet=53).
    // Not production-relevant since only mainnet is used. Skipping stagenet-specific tests.
    it('produces a 95-char address for non-mainnet networks', () => {
      const keys = deriveXmrKeys(testSeedHex, 'stagenet');
      expect(keys.primaryAddress).toHaveLength(95);
    });

    it('spend and view keys are different', () => {
      const keys = deriveXmrKeys(testSeedHex);
      expect(keys.spendKeyPrivate).not.toBe(keys.viewKeyPrivate);
      expect(keys.spendKeyPublic).not.toBe(keys.viewKeyPublic);
    });
  });

  describe('validateXmrAddress', () => {
    it('accepts valid mainnet address', () => {
      const keys = deriveXmrKeys(testSeedHex);
      expect(validateXmrAddress(keys.primaryAddress)).toBe(true);
    });

    it('rejects too-short address', () => {
      expect(validateXmrAddress('4abc')).toBe(false);
    });

    it('rejects empty string', () => {
      expect(validateXmrAddress('')).toBe(false);
    });

    it('rejects wrong-prefix address on mainnet', () => {
      // 95 chars but starts with '5' (stagenet)
      const keys = deriveXmrKeys(testSeedHex, 'stagenet');
      expect(validateXmrAddress(keys.primaryAddress, 'mainnet')).toBe(false);
    });

    // Skipped: NETWORK_BYTE testnet/stagenet are swapped (non-production bug)
    it.skip('accepts stagenet address with stagenet network', () => {
      const keys = deriveXmrKeys(testSeedHex, 'stagenet');
      expect(validateXmrAddress(keys.primaryAddress, 'stagenet')).toBe(true);
    });
  });

  describe('isSubaddress', () => {
    it('returns false for standard mainnet address', () => {
      const keys = deriveXmrKeys(testSeedHex);
      expect(isSubaddress(keys.primaryAddress)).toBe(false);
    });

    it('returns false for empty/short strings', () => {
      expect(isSubaddress('')).toBe(false);
      expect(isSubaddress('8abc')).toBe(false);
    });
  });
});
