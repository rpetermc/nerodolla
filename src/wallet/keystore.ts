/**
 * keystore.ts — AES-256-GCM encrypted mnemonic storage
 *
 * Uses the Web Crypto API (built-in, no external deps):
 *   - PBKDF2 (SHA-256, 210 000 iterations) to derive a key from the PIN
 *   - AES-256-GCM to encrypt/decrypt the mnemonic
 *
 * Stored in localStorage as JSON: { version, salt, iv, ciphertext } — all hex.
 * Without the PIN the ciphertext is computationally indistinguishable from random.
 */

const KEYSTORE_KEY      = 'nerodolla_keystore';
const ZK_KEY_STORAGE_KEY = 'nerodolla_zk_key';
const PBKDF2_ITERATIONS = 210_000;

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

// ── Public API ────────────────────────────────────────────────────────────────

/** Encrypt the mnemonic with PIN and persist to localStorage. */
export async function saveKeystore(mnemonic: string, pin: string): Promise<void> {
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
  localStorage.setItem(KEYSTORE_KEY, JSON.stringify(stored));
}

/**
 * Decrypt the stored mnemonic using the given PIN.
 * Throws 'Incorrect PIN' if the PIN is wrong, 'No keystore found' if nothing is stored.
 */
export async function loadKeystore(pin: string): Promise<string> {
  const raw = localStorage.getItem(KEYSTORE_KEY);
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

export function keystoreExists(): boolean {
  return !!localStorage.getItem(KEYSTORE_KEY);
}

export function clearKeystore(): void {
  localStorage.removeItem(KEYSTORE_KEY);
  clearZkKey();
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
export async function saveZkKey(ethPrivKey: string, zkPrivKey: string): Promise<void> {
  const key = await deriveZkEncKey(ethPrivKey);
  const iv = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12)));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(zkPrivKey),
  );
  const stored: StoredZkKey = { iv: bytesToHex(iv), ciphertext: bytesToHex(ciphertext) };
  localStorage.setItem(ZK_KEY_STORAGE_KEY, JSON.stringify(stored));
}

/**
 * Decrypt and return the ZK private key.
 * Returns null if no key is stored or decryption fails (wrong ethPrivKey).
 */
export async function loadZkKey(ethPrivKey: string): Promise<string | null> {
  const raw = localStorage.getItem(ZK_KEY_STORAGE_KEY);
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

export function zkKeyExists(): boolean {
  return !!localStorage.getItem(ZK_KEY_STORAGE_KEY);
}

export function clearZkKey(): void {
  localStorage.removeItem(ZK_KEY_STORAGE_KEY);
}
