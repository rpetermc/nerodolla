/**
 * eth.ts — ETH key derivation and signing
 *
 * Uses ethers.js v6 HDNodeWallet with BIP-44 path m/44'/60'/0'/0/0.
 * Derives the ETH wallet from the same BIP-39 seed as the XMR wallet
 * so the user only needs one recovery phrase.
 *
 * The ETH wallet is used for:
 *   • Hyperliquid L1 (EVM-compatible) — receiving XMR1/USDC after wagyu bridge
 *   • Lighter.xyz — signing deposit + hedge transactions
 */

import { ethers } from 'ethers';

export const ETH_DERIVATION_PATH = "m/44'/60'/0'/0/0";

export interface EthWallet {
  address: string;          // 0x... checksum address
  privateKey: string;       // 0x... 32-byte private key (keep secret)
  publicKey: string;        // 0x... 33-byte compressed public key
}

/**
 * Derive an ETH wallet from a 64-byte BIP-39 seed.
 * Seed should come from seed.ts :: ethSeedFromMaster().
 *
 * Compatible with MetaMask / hardware wallets using the same mnemonic.
 */
export function deriveEthWallet(seedBytes: Uint8Array): EthWallet {
  const hdNode = ethers.HDNodeWallet.fromSeed(seedBytes);
  const wallet = hdNode.derivePath(ETH_DERIVATION_PATH);

  return {
    address: wallet.address,
    privateKey: wallet.privateKey,
    publicKey: wallet.publicKey,
  };
}

/**
 * Create an ethers Signer backed by the derived private key.
 * Optionally attach a provider for on-chain calls.
 */
export function createEthSigner(
  ethWallet: EthWallet,
  provider?: ethers.Provider
): ethers.Wallet {
  const signer = new ethers.Wallet(ethWallet.privateKey, provider);
  return signer;
}

/**
 * Query ETH balance via a JSON-RPC provider URL.
 * Uses Ankr free-tier by default; user can override in settings.
 */
export async function getEthBalance(
  address: string,
  rpcUrl: string = 'https://rpc.ankr.com/eth'
): Promise<{ balanceEth: string; balanceWei: bigint }> {
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const balanceWei = await provider.getBalance(address);
  return {
    balanceEth: ethers.formatEther(balanceWei),
    balanceWei,
  };
}

/**
 * Sign an arbitrary message (EIP-191 personal_sign).
 * Used for Lighter API key authentication if Lighter uses secp256k1 signatures.
 */
export async function signMessage(
  ethWallet: EthWallet,
  message: string
): Promise<string> {
  const signer = new ethers.Wallet(ethWallet.privateKey);
  return signer.signMessage(message);
}

/**
 * Sign a typed data payload (EIP-712).
 * May be required by Lighter for certain operations.
 */
export async function signTypedData(
  ethWallet: EthWallet,
  domain: ethers.TypedDataDomain,
  types: Record<string, ethers.TypedDataField[]>,
  value: Record<string, unknown>
): Promise<string> {
  const signer = new ethers.Wallet(ethWallet.privateKey);
  return signer.signTypedData(domain, types, value);
}

/**
 * Validate an ETH address (checksum or lowercase).
 */
export function validateEthAddress(address: string): boolean {
  return ethers.isAddress(address);
}

// ── EIP-3009 TransferWithAuthorization ────────────────────────────────────────

const USDC_ARB_ADDRESS = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const USDC_ETH_ADDRESS = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

function eip3009Domain(chain: 'arbitrum' | 'ethereum') {
  return {
    name: 'USD Coin',
    version: '2',
    chainId: chain === 'ethereum' ? 1 : 42161,
    verifyingContract: chain === 'ethereum' ? USDC_ETH_ADDRESS : USDC_ARB_ADDRESS,
  };
}

const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: 'from',        type: 'address' },
    { name: 'to',          type: 'address' },
    { name: 'value',       type: 'uint256' },
    { name: 'validAfter',  type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce',       type: 'bytes32' },
  ],
};

export interface TransferAuthResult {
  from: string;
  to: string;
  value: string;       // USDC atomic units as decimal string
  validAfter: string;
  validBefore: string;
  nonce: string;       // 0x-prefixed bytes32
  v: number;
  r: string;           // 0x-prefixed bytes32
  s: string;           // 0x-prefixed bytes32
}

/**
 * Sign an EIP-3009 TransferWithAuthorization for USDC.
 * @param wallet     The ETH wallet whose USDC will be transferred
 * @param to         Destination address (e.g. wagyu deposit address)
 * @param valueMicro USDC amount in atomic units (6 decimals)
 * @param chain      'arbitrum' (default) or 'ethereum' — determines chainId + USDC contract
 */
export async function signTransferAuthorization(
  wallet: EthWallet,
  to: string,
  valueMicro: bigint,
  chain: 'arbitrum' | 'ethereum' = 'arbitrum',
): Promise<TransferAuthResult> {
  const signer = new ethers.Wallet(wallet.privateKey);
  const nonce = ethers.hexlify(ethers.randomBytes(32));
  const validAfter  = BigInt(0);
  const validBefore = BigInt(Math.floor(Date.now() / 1000) + 3 * 60 * 60); // 3h

  const message = {
    from:        wallet.address,
    to,
    value:       valueMicro,
    validAfter,
    validBefore,
    nonce,
  };

  const sig = await signer.signTypedData(eip3009Domain(chain), EIP3009_TYPES, message);
  const { v, r, s } = ethers.Signature.from(sig);

  return {
    from:        wallet.address,
    to,
    value:       valueMicro.toString(),
    validAfter:  validAfter.toString(),
    validBefore: validBefore.toString(),
    nonce,
    v,
    r,
    s,
  };
}
