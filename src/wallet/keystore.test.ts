import { describe, it, expect, beforeEach } from 'vitest';

// Mock localStorage for jsdom
const mockStorage: Record<string, string> = {};
beforeEach(() => {
  Object.keys(mockStorage).forEach(k => delete mockStorage[k]);
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (k: string) => mockStorage[k] ?? null,
      setItem: (k: string, v: string) => { mockStorage[k] = v; },
      removeItem: (k: string) => { delete mockStorage[k]; },
    },
    writable: true,
    configurable: true,
  });
});

// Import after mocking localStorage
import {
  saveKeystore, loadKeystore, keystoreExists, clearKeystore,
  saveZkKey, loadZkKey, zkKeyExists, clearZkKey,
  getWalletList, addWallet, removeWallet, updateWalletLabel, getWalletEntry, getNextWalletLabel,
  needsMigration, migrateLegacyWallet, changePinAllWallets,
  WalletEntry,
} from './keystore';

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const TEST_PIN = '1234';
const WALLET_A = '4ABC1234';
const WALLET_B = '4DEF5678';

describe('keystore', () => {
  // ── Legacy (no walletId) backward compat ──────────────────────────────────

  describe('legacy mnemonic keystore (no walletId)', () => {
    it('round-trips mnemonic with correct PIN', async () => {
      await saveKeystore(TEST_MNEMONIC, TEST_PIN);
      const result = await loadKeystore(TEST_PIN);
      expect(result).toBe(TEST_MNEMONIC);
    });

    it('fails with wrong PIN', async () => {
      await saveKeystore(TEST_MNEMONIC, TEST_PIN);
      await expect(loadKeystore('9999')).rejects.toThrow();
    });

    it('keystoreExists returns true after save', async () => {
      expect(keystoreExists()).toBe(false);
      await saveKeystore(TEST_MNEMONIC, TEST_PIN);
      expect(keystoreExists()).toBe(true);
    });

    it('clearKeystore removes stored data', async () => {
      await saveKeystore(TEST_MNEMONIC, TEST_PIN);
      clearKeystore();
      expect(keystoreExists()).toBe(false);
    });
  });

  // ── Per-wallet keystore ───────────────────────────────────────────────────

  describe('per-wallet mnemonic keystore', () => {
    it('round-trips mnemonic with walletId', async () => {
      await saveKeystore(TEST_MNEMONIC, TEST_PIN, WALLET_A);
      const result = await loadKeystore(TEST_PIN, WALLET_A);
      expect(result).toBe(TEST_MNEMONIC);
    });

    it('different wallets are isolated', async () => {
      const mnemonicB = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong';
      await saveKeystore(TEST_MNEMONIC, TEST_PIN, WALLET_A);
      await saveKeystore(mnemonicB, TEST_PIN, WALLET_B);

      expect(await loadKeystore(TEST_PIN, WALLET_A)).toBe(TEST_MNEMONIC);
      expect(await loadKeystore(TEST_PIN, WALLET_B)).toBe(mnemonicB);
    });

    it('keystoreExists checks specific wallet', async () => {
      await saveKeystore(TEST_MNEMONIC, TEST_PIN, WALLET_A);
      expect(keystoreExists(WALLET_A)).toBe(true);
      expect(keystoreExists(WALLET_B)).toBe(false);
    });

    it('clearKeystore only removes specified wallet', async () => {
      await saveKeystore(TEST_MNEMONIC, TEST_PIN, WALLET_A);
      await saveKeystore(TEST_MNEMONIC, TEST_PIN, WALLET_B);
      clearKeystore(WALLET_A);
      expect(keystoreExists(WALLET_A)).toBe(false);
      expect(keystoreExists(WALLET_B)).toBe(true);
    });

    it('fails with wrong PIN', async () => {
      await saveKeystore(TEST_MNEMONIC, TEST_PIN, WALLET_A);
      await expect(loadKeystore('9999', WALLET_A)).rejects.toThrow('Incorrect PIN');
    });

    it('throws when wallet not found', async () => {
      await expect(loadKeystore(TEST_PIN, 'NONEXIST')).rejects.toThrow('No keystore found');
    });
  });

  // ── ZK key storage ─────────────────────────────────────────────────────────

  describe('ZK key storage', () => {
    const ETH_PRIV = '0x' + '1a'.repeat(32);
    const ZK_KEY = '0xdeadbeef' + 'ab'.repeat(36);

    it('round-trips ZK key (legacy, no walletId)', async () => {
      await saveZkKey(ETH_PRIV, ZK_KEY);
      const result = await loadZkKey(ETH_PRIV);
      expect(result).toBe(ZK_KEY);
    });

    it('round-trips ZK key with walletId', async () => {
      await saveZkKey(ETH_PRIV, ZK_KEY, WALLET_A);
      const result = await loadZkKey(ETH_PRIV, WALLET_A);
      expect(result).toBe(ZK_KEY);
    });

    it('returns null with wrong ETH key', async () => {
      await saveZkKey(ETH_PRIV, ZK_KEY, WALLET_A);
      const wrong = '0x' + '2b'.repeat(32);
      const result = await loadZkKey(wrong, WALLET_A);
      expect(result).toBeNull();
    });

    it('zkKeyExists checks specific wallet', async () => {
      expect(zkKeyExists(WALLET_A)).toBe(false);
      await saveZkKey(ETH_PRIV, ZK_KEY, WALLET_A);
      expect(zkKeyExists(WALLET_A)).toBe(true);
      expect(zkKeyExists(WALLET_B)).toBe(false);
    });

    it('clearZkKey removes specific wallet key', async () => {
      await saveZkKey(ETH_PRIV, ZK_KEY, WALLET_A);
      await saveZkKey(ETH_PRIV, ZK_KEY, WALLET_B);
      clearZkKey(WALLET_A);
      expect(zkKeyExists(WALLET_A)).toBe(false);
      expect(zkKeyExists(WALLET_B)).toBe(true);
    });
  });

  // ── Wallet list management ──────────────────────────────────────────────────

  describe('wallet list management', () => {
    const entryA: WalletEntry = {
      id: WALLET_A, label: 'Trading', createdAt: 1711100000,
      restoreHeight: null, hedgeCurrency: 'USD',
    };
    const entryB: WalletEntry = {
      id: WALLET_B, label: 'Savings', createdAt: 1711200000,
      restoreHeight: 100000, hedgeCurrency: 'EUR',
    };

    it('starts with empty list', () => {
      expect(getWalletList()).toEqual([]);
    });

    it('addWallet adds to list', () => {
      addWallet(entryA);
      expect(getWalletList()).toEqual([entryA]);
    });

    it('addWallet prevents duplicates', () => {
      addWallet(entryA);
      expect(() => addWallet(entryA)).toThrow('already exists');
    });

    it('addWallet supports multiple wallets', () => {
      addWallet(entryA);
      addWallet(entryB);
      expect(getWalletList()).toHaveLength(2);
    });

    it('removeWallet removes from list', () => {
      addWallet(entryA);
      addWallet(entryB);
      removeWallet(WALLET_A);
      const list = getWalletList();
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe(WALLET_B);
    });

    it('removeWallet cleans up per-wallet storage', async () => {
      addWallet(entryA);
      await saveKeystore(TEST_MNEMONIC, TEST_PIN, WALLET_A);
      await saveZkKey('0x' + '1a'.repeat(32), '0xabc', WALLET_A);
      mockStorage[`nerodolla_pending_swap_${WALLET_A}`] = 'test';

      removeWallet(WALLET_A);
      expect(keystoreExists(WALLET_A)).toBe(false);
      expect(zkKeyExists(WALLET_A)).toBe(false);
      expect(mockStorage[`nerodolla_pending_swap_${WALLET_A}`]).toBeUndefined();
    });

    it('updateWalletLabel changes label', () => {
      addWallet(entryA);
      updateWalletLabel(WALLET_A, 'New Name');
      expect(getWalletEntry(WALLET_A)?.label).toBe('New Name');
    });

    it('updateWalletLabel throws for unknown wallet', () => {
      expect(() => updateWalletLabel('NONEXIST', 'x')).toThrow('not found');
    });

    it('getWalletEntry returns entry or undefined', () => {
      addWallet(entryA);
      expect(getWalletEntry(WALLET_A)?.label).toBe('Trading');
      expect(getWalletEntry('NONEXIST')).toBeUndefined();
    });

    it('getNextWalletLabel increments', () => {
      expect(getNextWalletLabel()).toBe('Wallet 1');
      addWallet(entryA);
      expect(getNextWalletLabel()).toBe('Wallet 2');
      addWallet(entryB);
      expect(getNextWalletLabel()).toBe('Wallet 3');
    });

    it('keystoreExists() returns true when wallet list has entries', () => {
      addWallet(entryA);
      expect(keystoreExists()).toBe(true);
    });
  });

  // ── Migration ───────────────────────────────────────────────────────────────

  describe('migration (single → multi)', () => {
    it('needsMigration detects legacy data without wallet list', async () => {
      expect(needsMigration()).toBe(false);

      await saveKeystore(TEST_MNEMONIC, TEST_PIN); // legacy save
      expect(needsMigration()).toBe(true);
    });

    it('needsMigration returns false if wallet list exists', async () => {
      await saveKeystore(TEST_MNEMONIC, TEST_PIN);
      addWallet({
        id: WALLET_A, label: 'Wallet 1', createdAt: Date.now(),
        restoreHeight: null, hedgeCurrency: 'USD',
      });
      expect(needsMigration()).toBe(false);
    });

    it('migrateLegacyWallet moves data to per-wallet keys', async () => {
      // Set up legacy data
      await saveKeystore(TEST_MNEMONIC, TEST_PIN);
      const ETH_PRIV = '0x' + '1a'.repeat(32);
      const ZK_KEY = '0xdeadbeef';
      await saveZkKey(ETH_PRIV, ZK_KEY);
      mockStorage['nerodolla_pending_swap'] = '{"test": true}';

      // Migrate
      await migrateLegacyWallet(WALLET_A, TEST_PIN, 50000);

      // Legacy keys should be gone
      expect(mockStorage['nerodolla_keystore']).toBeUndefined();
      expect(mockStorage['nerodolla_zk_key']).toBeUndefined();
      expect(mockStorage['nerodolla_pending_swap']).toBeUndefined();

      // New per-wallet keys should exist
      expect(keystoreExists(WALLET_A)).toBe(true);
      expect(await loadKeystore(TEST_PIN, WALLET_A)).toBe(TEST_MNEMONIC);

      // ZK key migrated (raw copy, so same ciphertext)
      expect(zkKeyExists(WALLET_A)).toBe(true);
      expect(await loadZkKey(ETH_PRIV, WALLET_A)).toBe(ZK_KEY);

      // State migrated
      expect(mockStorage[`nerodolla_pending_swap_${WALLET_A}`]).toBe('{"test": true}');

      // Wallet list created
      const list = getWalletList();
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe(WALLET_A);
      expect(list[0].restoreHeight).toBe(50000);
    });
  });

  // ── Change PIN ──────────────────────────────────────────────────────────────

  describe('changePinAllWallets', () => {
    it('re-encrypts legacy wallet with new PIN', async () => {
      await saveKeystore(TEST_MNEMONIC, TEST_PIN);
      await changePinAllWallets(TEST_PIN, '9999');

      await expect(loadKeystore(TEST_PIN)).rejects.toThrow();
      expect(await loadKeystore('9999')).toBe(TEST_MNEMONIC);
    });

    it('re-encrypts all multi-wallet keystores', async () => {
      const mnemonicB = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong';
      addWallet({
        id: WALLET_A, label: 'A', createdAt: 0,
        restoreHeight: null, hedgeCurrency: 'USD',
      });
      addWallet({
        id: WALLET_B, label: 'B', createdAt: 0,
        restoreHeight: null, hedgeCurrency: 'USD',
      });
      await saveKeystore(TEST_MNEMONIC, TEST_PIN, WALLET_A);
      await saveKeystore(mnemonicB, TEST_PIN, WALLET_B);

      await changePinAllWallets(TEST_PIN, '5555');

      expect(await loadKeystore('5555', WALLET_A)).toBe(TEST_MNEMONIC);
      expect(await loadKeystore('5555', WALLET_B)).toBe(mnemonicB);
      await expect(loadKeystore(TEST_PIN, WALLET_A)).rejects.toThrow();
    });
  });
});
