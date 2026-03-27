import { describe, it, expect } from 'vitest';
import { generateMnemonic, validateMnemonic, mnemonicToSeed, xmrSeedFromMaster, ethSeedFromMaster } from './seed';

describe('seed', () => {
  const TEST_MNEMONIC =
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art';

  describe('generateMnemonic', () => {
    it('produces a 24-word phrase', () => {
      const m = generateMnemonic();
      expect(m.split(' ')).toHaveLength(24);
    });

    it('produces valid BIP-39 mnemonics', () => {
      for (let i = 0; i < 5; i++) {
        expect(validateMnemonic(generateMnemonic())).toBe(true);
      }
    });

    it('produces different mnemonics each call', () => {
      const a = generateMnemonic();
      const b = generateMnemonic();
      expect(a).not.toBe(b);
    });
  });

  describe('validateMnemonic', () => {
    it('accepts valid 24-word mnemonic', () => {
      expect(validateMnemonic(TEST_MNEMONIC)).toBe(true);
    });

    it('accepts valid 12-word mnemonic', () => {
      expect(validateMnemonic('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about')).toBe(true);
    });

    it('rejects invalid words', () => {
      expect(validateMnemonic('foo bar baz')).toBe(false);
    });

    it('rejects empty string', () => {
      expect(validateMnemonic('')).toBe(false);
    });

    it('trims and lowercases', () => {
      expect(validateMnemonic('  ' + TEST_MNEMONIC.toUpperCase() + '  ')).toBe(true);
    });
  });

  describe('mnemonicToSeed', () => {
    it('derives a 64-byte seed', async () => {
      const seed = await mnemonicToSeed(TEST_MNEMONIC);
      expect(seed.seedBytes).toHaveLength(64);
    });

    it('is deterministic', async () => {
      const a = await mnemonicToSeed(TEST_MNEMONIC);
      const b = await mnemonicToSeed(TEST_MNEMONIC);
      expect(Array.from(a.seedBytes)).toEqual(Array.from(b.seedBytes));
    });

    it('throws for invalid mnemonic', async () => {
      await expect(mnemonicToSeed('invalid words here')).rejects.toThrow('Invalid mnemonic');
    });

    it('different passphrase produces different seed', async () => {
      const a = await mnemonicToSeed(TEST_MNEMONIC, '');
      const b = await mnemonicToSeed(TEST_MNEMONIC, 'password');
      expect(Array.from(a.seedBytes)).not.toEqual(Array.from(b.seedBytes));
    });
  });

  describe('xmrSeedFromMaster', () => {
    it('returns 64 hex chars (32 bytes)', async () => {
      const seed = await mnemonicToSeed(TEST_MNEMONIC);
      const xmrSeed = xmrSeedFromMaster(seed);
      expect(xmrSeed).toMatch(/^[0-9a-f]{64}$/);
    });

    it('is the first 32 bytes of the master seed', async () => {
      const seed = await mnemonicToSeed(TEST_MNEMONIC);
      const xmrSeed = xmrSeedFromMaster(seed);
      const first32Hex = Array.from(seed.seedBytes.slice(0, 32))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
      expect(xmrSeed).toBe(first32Hex);
    });
  });

  describe('ethSeedFromMaster', () => {
    it('returns full 64 bytes', async () => {
      const seed = await mnemonicToSeed(TEST_MNEMONIC);
      const ethSeed = ethSeedFromMaster(seed);
      expect(ethSeed).toHaveLength(64);
      expect(Array.from(ethSeed)).toEqual(Array.from(seed.seedBytes));
    });
  });
});
