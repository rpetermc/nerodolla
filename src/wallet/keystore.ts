/**
 * keystore.ts — AES-256-GCM encrypted mnemonic storage (multi-wallet)
 *
 * Uses the Web Crypto API (built-in, no external deps):
 *   - PBKDF2 (SHA-256, 210 000 iterations) to derive a key from the PIN
 *   - AES-256-GCM to encrypt/decrypt the mnemonic
 *
 * Each wallet is identified by a `walletId` (first 8 chars of XMR primary address).
 * Per-wallet data is stored under `nerodolla_keystore_<walletId>` etc.
 * A wallet index at `nerodolla_wallet_list` tracks all wallets.
 *
 * All wallets share a single PIN. Changing PIN re-encrypts all wallets.
 */

const KEYSTORE_PREFIX     = 'nerodolla_keystore';
const ZK_KEY_PREFIX       = 'nerodolla_zk_key';
const WALLET_LIST_KEY     = 'nerodolla_wallet_list';
const PBKDF2_ITERATIONS   = 210_000;

// Legacy single-wallet keys (for migration)
const LEGACY_KEYSTORE_KEY = 'nerodolla_keystore';
const LEGACY_ZK_KEY       = 'nerodolla_zk_key';

export interface WalletEntry {
  id: string;              // first 8 chars of XMR primary address
  label: string;
  createdAt: number;
  restoreHeight: number | null;
  hedgeCurrency: 'USD' | 'EUR' | 'GBP' | 'XAU' | 'XAG';
}

interface StoredKeystore {
  version: 1;
  salt: string;        // 16-byte salt, hex
  iv: string;          // 12-byte GCM IV, hex
  ciphertext: string;  // encrypted mnemonic, hex
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function bytesToHex(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const buf = new ArrayBuffer(hex.length / 2);
  const arr = new Uint8Array(buf);
  for (let i = 0; i < hex.length; i += 2) {
    arr[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return arr;
}

async function deriveKey(pin: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pin),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

function keystoreKey(walletId: string): string {
  return `${KEYSTORE_PREFIX}_${walletId}`;
}

function zkKeyKey(walletId: string): string {
  return `${ZK_KEY_PREFIX}_${walletId}`;
}

// ── Wallet List Management ────────────────────────────────────────────────────

export function getWalletList(): WalletEntry[] {
  const raw = localStorage.getItem(WALLET_LIST_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as WalletEntry[];
  } catch {
    return [];
  }
}

function saveWalletList(list: WalletEntry[]): void {
  localStorage.setItem(WALLET_LIST_KEY, JSON.stringify(list));
}

export function addWallet(entry: WalletEntry): void {
  const list = getWalletList();
  // Prevent duplicates
  if (list.some(w => w.id === entry.id)) {
    throw new Error(`Wallet ${entry.id} already exists`);
  }
  list.push(entry);
  saveWalletList(list);
}

export function removeWallet(walletId: string): void {
  const list = getWalletList().filter(w => w.id !== walletId);
  saveWalletList(list);
  // Clean up per-wallet storage
  localStorage.removeItem(keystoreKey(walletId));
  localStorage.removeItem(zkKeyKey(walletId));
  localStorage.removeItem(`nerodolla_pending_swap_${walletId}`);
  localStorage.removeItem(`nerodolla_pending_hedge_${walletId}`);
  localStorage.removeItem(`nerodolla_unhedge_${walletId}`);
  localStorage.removeItem(`nerodolla_bot_active_${walletId}`);
  localStorage.removeItem(`nerodolla_wallet_cache_${walletId}`);
}

export function updateWalletLabel(walletId: string, label: string): void {
  const list = getWalletList();
  const wallet = list.find(w => w.id === walletId);
  if (!wallet) throw new Error(`Wallet ${walletId} not found`);
  wallet.label = label;
  saveWalletList(list);
}

export function getWalletEntry(walletId: string): WalletEntry | undefined {
  return getWalletList().find(w => w.id === walletId);
}

export function getNextWalletLabel(): string {
  const list = getWalletList();
  return `Wallet ${list.length + 1}`;
}

// ── Mnemonic Keystore (per-wallet) ────────────────────────────────────────────

/** Encrypt the mnemonic with PIN and persist to localStorage for a specific wallet. */
export async function saveKeystore(mnemonic: string, pin: string, walletId?: string): Promise<void> {
  const salt       = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(16)));
  const iv         = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12)));
  const key        = await deriveKey(pin, salt);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(mnemonic),
  );
  const stored: StoredKeystore = {
    version: 1,
    salt: bytesToHex(salt),
    iv: bytesToHex(iv),
    ciphertext: bytesToHex(ciphertext),
  };
  const storageKey = walletId ? keystoreKey(walletId) : LEGACY_KEYSTORE_KEY;
  localStorage.setItem(storageKey, JSON.stringify(stored));
}

/**
 * Decrypt the stored mnemonic using the given PIN.
 * Throws 'Incorrect PIN' if the PIN is wrong, 'No keystore found' if nothing is stored.
 */
export async function loadKeystore(pin: string, walletId?: string): Promise<string> {
  const storageKey = walletId ? keystoreKey(walletId) : LEGACY_KEYSTORE_KEY;
  const raw = localStorage.getItem(storageKey);
  if (!raw) throw new Error('No keystore found');
  const stored = JSON.parse(raw) as StoredKeystore;
  const salt   = hexToBytes(stored.salt);
  const iv     = hexToBytes(stored.iv);
  const cipher = hexToBytes(stored.ciphertext);
  const key    = await deriveKey(pin, salt);
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
    return new TextDecoder().decode(plain);
  } catch {
    throw new Error('Incorrect PIN');
  }
}

/**
 * Check if a keystore exists.
 * - No args: returns true if ANY wallet keystore exists (checks wallet list, then legacy key)
 * - With walletId: returns true if that specific wallet's keystore exists
 */
export function keystoreExists(walletId?: string): boolean {
  if (walletId) {
    return !!localStorage.getItem(keystoreKey(walletId));
  }
  // Any wallet exists: check wallet list or legacy key
  const list = getWalletList();
  if (list.length > 0) return true;
  return !!localStorage.getItem(LEGACY_KEYSTORE_KEY);
}

export function clearKeystore(walletId?: string): void {
  if (walletId) {
    localStorage.removeItem(keystoreKey(walletId));
    clearZkKey(walletId);
  } else {
    localStorage.removeItem(LEGACY_KEYSTORE_KEY);
    clearZkKey();
  }
}

// ── ZK key encryption (ETH private key as HKDF source) ────────────────────────

interface StoredZkKey {
  iv: string;          // 12-byte GCM IV, hex
  ciphertext: string;  // encrypted ZK private key, hex
}

/** Derive an AES-256-GCM key from the ETH private key via HKDF-SHA256. */
async function deriveZkEncKey(ethPrivKey: string): Promise<CryptoKey> {
  const raw = hexToBytes(ethPrivKey.replace('0x', ''));
  const keyMaterial = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']);
  const info = new TextEncoder().encode('nerodolla-zk-key-v1');
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Encrypt the ZK private key with the ETH private key and persist to localStorage. */
export async function saveZkKey(ethPrivKey: string, zkPrivKey: string, walletId?: string): Promise<void> {
  const key = await deriveZkEncKey(ethPrivKey);
  const iv = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12)));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(zkPrivKey),
  );
  const stored: StoredZkKey = { iv: bytesToHex(iv), ciphertext: bytesToHex(ciphertext) };
  const storageKey = walletId ? zkKeyKey(walletId) : LEGACY_ZK_KEY;
  localStorage.setItem(storageKey, JSON.stringify(stored));
}

/**
 * Decrypt and return the ZK private key.
 * Returns null if no key is stored or decryption fails (wrong ethPrivKey).
 */
export async function loadZkKey(ethPrivKey: string, walletId?: string): Promise<string | null> {
  const storageKey = walletId ? zkKeyKey(walletId) : LEGACY_ZK_KEY;
  const raw = localStorage.getItem(storageKey);
  if (!raw) return null;
  const { iv, ciphertext } = JSON.parse(raw) as StoredZkKey;
  const key = await deriveZkEncKey(ethPrivKey);
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: hexToBytes(iv) },
      key,
      hexToBytes(ciphertext),
    );
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

/**
 * Check if a ZK key exists.
 * - No args: returns true if ANY ZK key exists (checks wallet list entries, then legacy key)
 * - With walletId: returns true if that specific wallet's ZK key exists
 */
export function zkKeyExists(walletId?: string): boolean {
  if (walletId) {
    return !!localStorage.getItem(zkKeyKey(walletId));
  }
  // Check all wallets in list
  const list = getWalletList();
  for (const w of list) {
    if (localStorage.getItem(zkKeyKey(w.id))) return true;
  }
  return !!localStorage.getItem(LEGACY_ZK_KEY);
}

export function clearZkKey(walletId?: string): void {
  if (walletId) {
    localStorage.removeItem(zkKeyKey(walletId));
  } else {
    localStorage.removeItem(LEGACY_ZK_KEY);
  }
}

// ── Migration (single-wallet → multi-wallet) ─────────────────────────────────

/**
 * Check if legacy single-wallet data exists that needs migration.
 */
export function needsMigration(): boolean {
  const hasLegacy = !!localStorage.getItem(LEGACY_KEYSTORE_KEY);
  const hasList = getWalletList().length > 0;
  return hasLegacy && !hasList;
}

/**
 * Migrate legacy single-wallet data to multi-wallet format.
 * Call after unlocking (PIN verified) when needsMigration() is true.
 *
 * @param walletId - The walletId derived from the mnemonic's XMR address
 * @param pin - The PIN (already verified)
 * @param restoreHeight - The wallet's restore height (from legacy walletRestoreHeight setting)
 */
export async function migrateLegacyWallet(
  walletId: string,
  pin: string,
  restoreHeight: number | null = null,
): Promise<void> {
  // 1. Read legacy keystore and re-save under new key
  const mnemonic = await loadKeystore(pin); // reads from legacy key
  await saveKeystore(mnemonic, pin, walletId);

  // 2. Move ZK key if it exists (read raw, copy to new key)
  const legacyZk = localStorage.getItem(LEGACY_ZK_KEY);
  if (legacyZk) {
    localStorage.setItem(zkKeyKey(walletId), legacyZk);
  }

  // 3. Move per-wallet state keys
  const stateSuffixes = ['pending_swap', 'pending_hedge', 'unhedge', 'bot_active'];
  for (const suffix of stateSuffixes) {
    const legacyKey = `nerodolla_${suffix}`;
    const val = localStorage.getItem(legacyKey);
    if (val) {
      localStorage.setItem(`nerodolla_${suffix}_${walletId}`, val);
      localStorage.removeItem(legacyKey);
    }
  }

  // 4. Create wallet list entry
  addWallet({
    id: walletId,
    label: 'Wallet 1',
    createdAt: Date.now(),
    restoreHeight,
    hedgeCurrency: 'USD',
  });

  // 5. Remove legacy keystore and ZK key
  localStorage.removeItem(LEGACY_KEYSTORE_KEY);
  localStorage.removeItem(LEGACY_ZK_KEY);
}

/**
 * Re-encrypt all wallets with a new PIN.
 * Requires the old PIN to decrypt each wallet first.
 */
export async function changePinAllWallets(oldPin: string, newPin: string): Promise<void> {
  const list = getWalletList();
  if (list.length === 0) {
    // Legacy single-wallet: just re-encrypt in place
    const mnemonic = await loadKeystore(oldPin);
    await saveKeystore(mnemonic, newPin);
    return;
  }
  // Decrypt all, then re-encrypt all with new PIN
  const mnemonics: Array<{ walletId: string; mnemonic: string }> = [];
  for (const w of list) {
    const m = await loadKeystore(oldPin, w.id);
    mnemonics.push({ walletId: w.id, mnemonic: m });
  }
  for (const { walletId, mnemonic } of mnemonics) {
    await saveKeystore(mnemonic, newPin, walletId);
  }
}
