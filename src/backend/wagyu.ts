/**
 * wagyu.ts — wagyu.xyz Swap API client
 *
 * wagyu provides atomic cross-chain swaps. For XMR → USDC on Arbitrum:
 *
 *   1. POST /v1/quote  — get expected output (optional, for display)
 *   2. POST /v1/order  — create order, receive XMR deposit address
 *   3. Send exactly depositAmount XMR to depositAddress
 *      (triggered from within the app via the /lws/transfer proxy endpoint)
 *   4. GET /v1/order/:orderId — poll until status is 'complete' or terminal
 *
 * Gas note: wagyu handles everything server-side. The user's ETH wallet requires
 * no ETH gas for the swap — USDC lands directly at toAddress on Arbitrum.
 * ETH gas is only needed for Phase 4 (Lighter deposit), handled via the proxy relay wallet.
 *
 * Integrator fees are configured once in the wagyu dashboard (wagyu.xyz/api).
 * Attach VITE_WAGYU_API_KEY as X-API-KEY header to earn fees automatically.
 *
 * API base: https://api.wagyu.xyz
 * Docs:     https://docs.wagyu.xyz
 */

export const WAGYU_API_BASE = 'https://api.wagyu.xyz';
/** 0% fee key — used for Swap tab (XMR↔anything, user-initiated). */
export const WAGYU_API_KEY: string = import.meta.env.VITE_WAGYU_API_KEY ?? '';
/**
 * Hedge key — used for hedge/unhedge flows (XMR→USDC and USDC→XMR).
 * Configure this key with a ~0.5% integrator fee in the wagyu dashboard.
 * Fee is collected in the **output token** of each swap:
 *   • XMR→USDC (top-up):  fee paid in USDC at your ETH integrator address
 *   • USDC→XMR (unhedge): fee deducted from the USDC input, also paid as USDC
 *     at your ETH integrator address (wagyu has no XMR payout address option)
 * Falls back to WAGYU_API_KEY if not set (zero fee).
 */
export const WAGYU_HEDGE_API_KEY: string =
  import.meta.env.VITE_WAGYU_HEDGE_API_KEY || WAGYU_API_KEY;

// Chain IDs from GET /v1/chains
export const MONERO_CHAIN_ID   = 0;
export const BITCOIN_CHAIN_ID  = 20000000000001;
export const ETHEREUM_CHAIN_ID = 1;
export const OPTIMISM_CHAIN_ID = 10;
export const BSC_CHAIN_ID      = 56;
export const HYPEREVM_CHAIN_ID = 999;
export const BASE_CHAIN_ID     = 8453;
export const ARBITRUM_CHAIN_ID = 42161;
export const AVALANCHE_CHAIN_ID = 43114;
export const SOLANA_CHAIN_ID   = 1151111081099710;

// USDC contract on Arbitrum One
export const USDC_ARB_ADDRESS = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
// USDC contract on Ethereum mainnet (Lighter withdrawals always land here)
export const USDC_ETH_ADDRESS = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

// wagyu uses the ERC-7528 sentinel address for EVM native tokens (ETH, BNB, AVAX, etc.)
// Non-EVM chains (BTC, XMR) use symbol strings; Solana uses program/mint addresses.
const EVM_NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

// ── Swap token definitions ──────────────────────────────────────────────────────

export interface SwapToken {
  symbol: string;
  name: string;
  chainId: number;
  chainName: string;  // display label for <optgroup> grouping
  /** Symbol string for BTC/XMR, Solana mint/program address, or EVM contract address */
  tokenId: string;
  decimals: number;
}

export const XMR_TOKEN: SwapToken = {
  symbol: 'XMR', name: 'Monero', chainId: MONERO_CHAIN_ID, chainName: 'Monero', tokenId: 'XMR', decimals: 12,
};

/** Full list of wagyu-confirmed tokens, grouped by chain for the pair selector. */
export const SWAP_TOKENS: SwapToken[] = [
  // ── Monero ────────────────────────────────────────────────────────────────
  XMR_TOKEN,

  // ── Bitcoin ───────────────────────────────────────────────────────────────
  { symbol: 'BTC',    name: 'Bitcoin',            chainId: BITCOIN_CHAIN_ID,   chainName: 'Bitcoin',   tokenId: 'BTC',                                             decimals: 8  },

  // ── Ethereum ──────────────────────────────────────────────────────────────
  { symbol: 'ETH',    name: 'Ether',               chainId: ETHEREUM_CHAIN_ID,  chainName: 'Ethereum',  tokenId: EVM_NATIVE,                                        decimals: 18 },
  { symbol: 'USDC',   name: 'USD Coin',             chainId: ETHEREUM_CHAIN_ID,  chainName: 'Ethereum',  tokenId: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',     decimals: 6  },
  { symbol: 'USDT',   name: 'Tether USD',           chainId: ETHEREUM_CHAIN_ID,  chainName: 'Ethereum',  tokenId: '0xdAC17F958D2ee523a2206206994597C13D831ec7',     decimals: 6  },
  { symbol: 'WBTC',   name: 'Wrapped Bitcoin',      chainId: ETHEREUM_CHAIN_ID,  chainName: 'Ethereum',  tokenId: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',     decimals: 8  },
  { symbol: 'DAI',    name: 'Dai',                  chainId: ETHEREUM_CHAIN_ID,  chainName: 'Ethereum',  tokenId: '0x6B175474E89094C44Da98b954EedeAC495271d0F',     decimals: 18 },
  { symbol: 'WETH',   name: 'Wrapped Ether',        chainId: ETHEREUM_CHAIN_ID,  chainName: 'Ethereum',  tokenId: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',     decimals: 18 },
  { symbol: 'UNI',    name: 'Uniswap',              chainId: ETHEREUM_CHAIN_ID,  chainName: 'Ethereum',  tokenId: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984',     decimals: 18 },
  { symbol: 'LINK',   name: 'Chainlink',            chainId: ETHEREUM_CHAIN_ID,  chainName: 'Ethereum',  tokenId: '0x514910771AF9Ca656af840dff83E8264EcF986CA',     decimals: 18 },
  { symbol: 'MATIC',  name: 'Polygon',              chainId: ETHEREUM_CHAIN_ID,  chainName: 'Ethereum',  tokenId: '0x7D1AfA7B718fb893dB30A3aBc0Cfc608AaCfeBB0',     decimals: 18 },
  { symbol: 'stETH',  name: 'Lido Staked ETH',      chainId: ETHEREUM_CHAIN_ID,  chainName: 'Ethereum',  tokenId: '0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84',     decimals: 18 },
  { symbol: 'wstETH', name: 'Wrapped stETH',        chainId: ETHEREUM_CHAIN_ID,  chainName: 'Ethereum',  tokenId: '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0',     decimals: 18 },
  { symbol: 'rETH',   name: 'Rocket Pool ETH',      chainId: ETHEREUM_CHAIN_ID,  chainName: 'Ethereum',  tokenId: '0xae78736Cd615f374D3085123A210448E74Fc6393',     decimals: 18 },
  { symbol: 'LDO',    name: 'Lido DAO',             chainId: ETHEREUM_CHAIN_ID,  chainName: 'Ethereum',  tokenId: '0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32',     decimals: 18 },
  { symbol: 'MKR',    name: 'Maker',                chainId: ETHEREUM_CHAIN_ID,  chainName: 'Ethereum',  tokenId: '0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2',     decimals: 18 },
  { symbol: 'AAVE',   name: 'Aave',                 chainId: ETHEREUM_CHAIN_ID,  chainName: 'Ethereum',  tokenId: '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9',     decimals: 18 },
  { symbol: 'CRV',    name: 'Curve DAO',            chainId: ETHEREUM_CHAIN_ID,  chainName: 'Ethereum',  tokenId: '0xD533a949740bb3306d119CC777fa900bA034cd52',     decimals: 18 },
  { symbol: 'SNX',    name: 'Synthetix',            chainId: ETHEREUM_CHAIN_ID,  chainName: 'Ethereum',  tokenId: '0xC011a73ee8576Fb46F5E1c5751cA3B9Fe0af2a6F',     decimals: 18 },
  { symbol: 'GRT',    name: 'The Graph',            chainId: ETHEREUM_CHAIN_ID,  chainName: 'Ethereum',  tokenId: '0xc944E90C64B2c07662A292be6244BDf05Cda44a7',     decimals: 18 },
  { symbol: 'ENS',    name: 'Ethereum Name Service',chainId: ETHEREUM_CHAIN_ID,  chainName: 'Ethereum',  tokenId: '0xC18360217D8F7Ab5e7c516566761Ea12Ce7F9D72',     decimals: 18 },
  { symbol: 'PEPE',   name: 'Pepe',                 chainId: ETHEREUM_CHAIN_ID,  chainName: 'Ethereum',  tokenId: '0x6982508145454Ce325dDbE47a25d4ec3d2311933',     decimals: 18 },
  { symbol: 'SHIB',   name: 'Shiba Inu',            chainId: ETHEREUM_CHAIN_ID,  chainName: 'Ethereum',  tokenId: '0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE',     decimals: 18 },
  { symbol: 'DYDX',   name: 'dYdX',                 chainId: ETHEREUM_CHAIN_ID,  chainName: 'Ethereum',  tokenId: '0x92D6C1e31e14520e676a687F0a93788B716BEff5',     decimals: 18 },
  { symbol: 'ENA',    name: 'Ethena',               chainId: ETHEREUM_CHAIN_ID,  chainName: 'Ethereum',  tokenId: '0x57e114B691Db790C35207b2e685D4A43181e6061',     decimals: 18 },
  { symbol: 'EIGEN',  name: 'Eigenlayer',           chainId: ETHEREUM_CHAIN_ID,  chainName: 'Ethereum',  tokenId: '0xec53bF9167f50cDEB3Ae105f56099aaaB9061F83',     decimals: 18 },
  { symbol: 'APE',    name: 'ApeCoin',              chainId: ETHEREUM_CHAIN_ID,  chainName: 'Ethereum',  tokenId: '0x4d224452801ACEd8B2F0aebE155379bb5D594381',     decimals: 18 },
  { symbol: 'WLD',    name: 'Worldcoin',            chainId: ETHEREUM_CHAIN_ID,  chainName: 'Ethereum',  tokenId: '0x163f8C2467924be0ae7B5347228CABF260318753',     decimals: 18 },
  { symbol: '1INCH',  name: '1inch',                chainId: ETHEREUM_CHAIN_ID,  chainName: 'Ethereum',  tokenId: '0x111111111117dC0aa78b770fA6A738034120C302',     decimals: 18 },
  { symbol: 'FRAX',   name: 'Frax',                 chainId: ETHEREUM_CHAIN_ID,  chainName: 'Ethereum',  tokenId: '0x853d955aCEf822Db058eb8505911ED77F175b99e',     decimals: 18 },
  { symbol: 'LUSD',   name: 'LUSD Stablecoin',      chainId: ETHEREUM_CHAIN_ID,  chainName: 'Ethereum',  tokenId: '0x5f98805A4E8be255a32880FDeC7F6728C6568bA0',     decimals: 18 },
  { symbol: 'BAL',    name: 'Balancer',             chainId: ETHEREUM_CHAIN_ID,  chainName: 'Ethereum',  tokenId: '0xba100000625a3754423978a60c9317c58a424e3D',     decimals: 18 },

  // ── Optimism ──────────────────────────────────────────────────────────────
  { symbol: 'ETH',    name: 'Ether',               chainId: OPTIMISM_CHAIN_ID,  chainName: 'Optimism',  tokenId: EVM_NATIVE,                                        decimals: 18 },
  { symbol: 'USDC',   name: 'USD Coin',             chainId: OPTIMISM_CHAIN_ID,  chainName: 'Optimism',  tokenId: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',     decimals: 6  },
  { symbol: 'USDT',   name: 'Tether USD',           chainId: OPTIMISM_CHAIN_ID,  chainName: 'Optimism',  tokenId: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58',     decimals: 6  },
  { symbol: 'DAI',    name: 'Dai',                  chainId: OPTIMISM_CHAIN_ID,  chainName: 'Optimism',  tokenId: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1',     decimals: 18 },
  { symbol: 'WETH',   name: 'Wrapped Ether',        chainId: OPTIMISM_CHAIN_ID,  chainName: 'Optimism',  tokenId: '0x4200000000000000000000000000000000000006',     decimals: 18 },
  { symbol: 'OP',     name: 'Optimism',             chainId: OPTIMISM_CHAIN_ID,  chainName: 'Optimism',  tokenId: '0x4200000000000000000000000000000000000042',     decimals: 18 },
  { symbol: 'wstETH', name: 'Wrapped stETH',        chainId: OPTIMISM_CHAIN_ID,  chainName: 'Optimism',  tokenId: '0x1F32b1c2345538c0c6f582fCB022739c4A194Ebb',     decimals: 18 },
  { symbol: 'SNX',    name: 'Synthetix',            chainId: OPTIMISM_CHAIN_ID,  chainName: 'Optimism',  tokenId: '0x8700dAec35aF8Ff88c16BdF0418774CB3D7599B4',     decimals: 18 },

  // ── Base ──────────────────────────────────────────────────────────────────
  { symbol: 'ETH',    name: 'Ether',               chainId: BASE_CHAIN_ID,      chainName: 'Base',      tokenId: EVM_NATIVE,                                        decimals: 18 },
  { symbol: 'USDC',   name: 'USD Coin',             chainId: BASE_CHAIN_ID,      chainName: 'Base',      tokenId: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',     decimals: 6  },
  { symbol: 'USDT',   name: 'Tether USD',           chainId: BASE_CHAIN_ID,      chainName: 'Base',      tokenId: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2',     decimals: 6  },
  { symbol: 'DAI',    name: 'Dai',                  chainId: BASE_CHAIN_ID,      chainName: 'Base',      tokenId: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb',     decimals: 18 },
  { symbol: 'WETH',   name: 'Wrapped Ether',        chainId: BASE_CHAIN_ID,      chainName: 'Base',      tokenId: '0x4200000000000000000000000000000000000006',     decimals: 18 },
  { symbol: 'cbETH',  name: 'Coinbase ETH',         chainId: BASE_CHAIN_ID,      chainName: 'Base',      tokenId: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22',     decimals: 18 },
  { symbol: 'cbBTC',  name: 'Coinbase BTC',         chainId: BASE_CHAIN_ID,      chainName: 'Base',      tokenId: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf',     decimals: 8  },
  { symbol: 'rETH',   name: 'Rocket Pool ETH',      chainId: BASE_CHAIN_ID,      chainName: 'Base',      tokenId: '0xB6fe221Fe9EeF5aBa221c348bA20A1Bf5e73624c',     decimals: 18 },
  { symbol: 'weETH',  name: 'Wrapped eETH',         chainId: BASE_CHAIN_ID,      chainName: 'Base',      tokenId: '0x04C0599Ae5A44757c0af6F9eC3b93da8976c150A',     decimals: 18 },
  { symbol: 'AERO',   name: 'Aerodrome',            chainId: BASE_CHAIN_ID,      chainName: 'Base',      tokenId: '0x940181a94A35A4569E4529A3CDfB74e38FD98631',     decimals: 18 },
  { symbol: 'EURC',   name: 'Euro Coin',            chainId: BASE_CHAIN_ID,      chainName: 'Base',      tokenId: '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42',     decimals: 6  },

  // ── Arbitrum ──────────────────────────────────────────────────────────────
  { symbol: 'ETH',    name: 'Ether',               chainId: ARBITRUM_CHAIN_ID,  chainName: 'Arbitrum',  tokenId: EVM_NATIVE,                                        decimals: 18 },
  { symbol: 'USDC',   name: 'USD Coin',             chainId: ARBITRUM_CHAIN_ID,  chainName: 'Arbitrum',  tokenId: USDC_ARB_ADDRESS,                                  decimals: 6  },
  { symbol: 'USDT',   name: 'Tether USD',           chainId: ARBITRUM_CHAIN_ID,  chainName: 'Arbitrum',  tokenId: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',     decimals: 6  },
  { symbol: 'DAI',    name: 'Dai',                  chainId: ARBITRUM_CHAIN_ID,  chainName: 'Arbitrum',  tokenId: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1',     decimals: 18 },
  { symbol: 'WETH',   name: 'Wrapped Ether',        chainId: ARBITRUM_CHAIN_ID,  chainName: 'Arbitrum',  tokenId: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',     decimals: 18 },
  { symbol: 'WBTC',   name: 'Wrapped Bitcoin',      chainId: ARBITRUM_CHAIN_ID,  chainName: 'Arbitrum',  tokenId: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f',     decimals: 8  },
  { symbol: 'ARB',    name: 'Arbitrum',             chainId: ARBITRUM_CHAIN_ID,  chainName: 'Arbitrum',  tokenId: '0x912CE59144191C1204E64559FE8253a0e49E6548',     decimals: 18 },
  { symbol: 'GMX',    name: 'GMX',                  chainId: ARBITRUM_CHAIN_ID,  chainName: 'Arbitrum',  tokenId: '0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a',     decimals: 18 },
  { symbol: 'wstETH', name: 'Wrapped stETH',        chainId: ARBITRUM_CHAIN_ID,  chainName: 'Arbitrum',  tokenId: '0x5979D7b546E38E414F7E9822514be443A4800529',     decimals: 18 },
  { symbol: 'LINK',   name: 'Chainlink',            chainId: ARBITRUM_CHAIN_ID,  chainName: 'Arbitrum',  tokenId: '0xf97f4df75117a78c1A5a0DBb814Af92458539FB4',     decimals: 18 },
  { symbol: 'PENDLE', name: 'Pendle',               chainId: ARBITRUM_CHAIN_ID,  chainName: 'Arbitrum',  tokenId: '0x0c880f6761F1af8d9Aa9C466984b80DAb9a8c9e8',     decimals: 18 },
  { symbol: 'CRV',    name: 'Curve DAO',            chainId: ARBITRUM_CHAIN_ID,  chainName: 'Arbitrum',  tokenId: '0x11cDb42B0EB46D95f990BeDD4695A6e3fA034978',     decimals: 18 },
  { symbol: 'FRAX',   name: 'Frax',                 chainId: ARBITRUM_CHAIN_ID,  chainName: 'Arbitrum',  tokenId: '0x17FC002b466eEc40DaE837Fc4bE5c67993ddBd6F',     decimals: 18 },

  // ── BSC ───────────────────────────────────────────────────────────────────
  { symbol: 'BNB',    name: 'BNB',                  chainId: BSC_CHAIN_ID,       chainName: 'BSC',       tokenId: EVM_NATIVE,                                        decimals: 18 },
  { symbol: 'USDT',   name: 'Tether USD',           chainId: BSC_CHAIN_ID,       chainName: 'BSC',       tokenId: '0x55d398326f99059fF775485246999027B3197955',     decimals: 18 },
  { symbol: 'USDC',   name: 'USD Coin',             chainId: BSC_CHAIN_ID,       chainName: 'BSC',       tokenId: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',     decimals: 18 },
  { symbol: 'WETH',   name: 'Wrapped ETH',          chainId: BSC_CHAIN_ID,       chainName: 'BSC',       tokenId: '0x2170Ed0880ac9A755fd29B2688956BD959F933F8',     decimals: 18 },
  { symbol: 'DAI',    name: 'Dai',                  chainId: BSC_CHAIN_ID,       chainName: 'BSC',       tokenId: '0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3',     decimals: 18 },
  { symbol: 'CAKE',   name: 'PancakeSwap',          chainId: BSC_CHAIN_ID,       chainName: 'BSC',       tokenId: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82',     decimals: 18 },
  { symbol: 'XRP',    name: 'XRP (BEP-20)',         chainId: BSC_CHAIN_ID,       chainName: 'BSC',       tokenId: '0x1D2F0da169ceB9fC7B3144628dB156f3F6c60dBE',     decimals: 18 },
  { symbol: 'ADA',    name: 'Cardano (BEP-20)',     chainId: BSC_CHAIN_ID,       chainName: 'BSC',       tokenId: '0x3EE2200Efb3400fAbB9AacF31297cBdD1d435D47',     decimals: 18 },
  { symbol: 'DOT',    name: 'Polkadot (BEP-20)',    chainId: BSC_CHAIN_ID,       chainName: 'BSC',       tokenId: '0x7083609fCE4d1d8Dc0C979AAb8c869Ea2C873402',     decimals: 18 },
  { symbol: 'LINK',   name: 'Chainlink',            chainId: BSC_CHAIN_ID,       chainName: 'BSC',       tokenId: '0xF8A0BF9cF54Bb92F17374d9e9A321E6a111a51bD',     decimals: 18 },

  // ── Avalanche ─────────────────────────────────────────────────────────────
  { symbol: 'AVAX',   name: 'Avalanche',            chainId: AVALANCHE_CHAIN_ID, chainName: 'Avalanche', tokenId: EVM_NATIVE,                                        decimals: 18 },
  { symbol: 'USDC',   name: 'USD Coin',             chainId: AVALANCHE_CHAIN_ID, chainName: 'Avalanche', tokenId: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',     decimals: 6  },
  { symbol: 'USDT',   name: 'Tether USD',           chainId: AVALANCHE_CHAIN_ID, chainName: 'Avalanche', tokenId: '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7',     decimals: 6  },
  { symbol: 'DAI.e',  name: 'Dai (bridged)',        chainId: AVALANCHE_CHAIN_ID, chainName: 'Avalanche', tokenId: '0xd586E7F844cEa2F87f50152665BCbc2C279D8d70',     decimals: 18 },
  { symbol: 'WETH.e', name: 'Wrapped ETH (bridged)',chainId: AVALANCHE_CHAIN_ID, chainName: 'Avalanche', tokenId: '0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB',     decimals: 18 },
  { symbol: 'WBTC',   name: 'Wrapped Bitcoin',      chainId: AVALANCHE_CHAIN_ID, chainName: 'Avalanche', tokenId: '0x50b7545627a5162F82A992c33b87aDc75187B218',     decimals: 8  },

  // ── Solana ────────────────────────────────────────────────────────────────
  { symbol: 'SOL',    name: 'Solana',               chainId: SOLANA_CHAIN_ID,    chainName: 'Solana',    tokenId: '11111111111111111111111111111111',                decimals: 9  },
  { symbol: 'wSOL',   name: 'Wrapped SOL',          chainId: SOLANA_CHAIN_ID,    chainName: 'Solana',    tokenId: 'So11111111111111111111111111111111111111112',    decimals: 9  },
  { symbol: 'USDC',   name: 'USD Coin',             chainId: SOLANA_CHAIN_ID,    chainName: 'Solana',    tokenId: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6  },
  { symbol: 'USDT',   name: 'Tether USD',           chainId: SOLANA_CHAIN_ID,    chainName: 'Solana',    tokenId: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', decimals: 6  },
  { symbol: 'JUP',    name: 'Jupiter',              chainId: SOLANA_CHAIN_ID,    chainName: 'Solana',    tokenId: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', decimals: 6  },
  { symbol: 'RAY',    name: 'Raydium',              chainId: SOLANA_CHAIN_ID,    chainName: 'Solana',    tokenId: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', decimals: 6  },
  { symbol: 'mSOL',   name: 'Marinade SOL',         chainId: SOLANA_CHAIN_ID,    chainName: 'Solana',    tokenId: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', decimals: 9  },
  { symbol: 'WIF',    name: 'dogwifhat',            chainId: SOLANA_CHAIN_ID,    chainName: 'Solana',    tokenId: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', decimals: 6  },
  { symbol: 'PYTH',   name: 'Pyth Network',         chainId: SOLANA_CHAIN_ID,    chainName: 'Solana',    tokenId: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3', decimals: 6  },

  // ── HyperEVM ──────────────────────────────────────────────────────────────
  { symbol: 'HYPE',   name: 'Hyperliquid',          chainId: HYPEREVM_CHAIN_ID,  chainName: 'HyperEVM',  tokenId: EVM_NATIVE,                                        decimals: 18 },
];

/**
 * Stable unique key for a SwapToken — safe to use as a React key or select value.
 * chainId and tokenId together are always unique across the full SWAP_TOKENS list.
 */
export function tokenKey(t: SwapToken): string {
  return `${t.chainId}::${t.tokenId}`;
}

/** Reverse of tokenKey — find a token by its key. */
export function findToken(key: string): SwapToken | undefined {
  return SWAP_TOKENS.find((t) => tokenKey(t) === key);
}

/** Group an array of SwapTokens by chainName, preserving insertion order. */
export function groupByChain(tokens: SwapToken[]): { chainName: string; tokens: SwapToken[] }[] {
  const map = new Map<string, SwapToken[]>();
  for (const t of tokens) {
    const list = map.get(t.chainName) ?? [];
    list.push(t);
    map.set(t.chainName, list);
  }
  return [...map.entries()].map(([chainName, tokens]) => ({ chainName, tokens }));
}

// Decimal precision
export const XMR_DECIMALS  = 12;  // picoXMR — Monero's atomic unit
export const USDC_DECIMALS = 6;
export const ETH_DECIMALS  = 18;  // used for Phase 4 ETH balance display

// wagyu minimum swap is ~$25 equivalent. At ~$250/XMR, 0.1 XMR ≈ $25.
export const MIN_SWAP_XMR = '0.1';

// ── Unit conversion ────────────────────────────────────────────────────────────

/**
 * Convert human-readable XMR (e.g. "1.5") to picoXMR string.
 * Uses BigInt arithmetic to avoid floating-point precision loss.
 */
export function xmrToAtomic(xmrStr: string): string {
  const parts = xmrStr.split('.');
  const whole = BigInt(parts[0] || '0');
  const fracStr = (parts[1] || '').padEnd(XMR_DECIMALS, '0').slice(0, XMR_DECIMALS);
  return (whole * 1_000_000_000_000n + BigInt(fracStr)).toString();
}

/**
 * Convert picoXMR (BigInt) back to an exact XMR string with full 12 decimal places.
 * Inverse of xmrToAtomic — uses BigInt throughout so no floating-point rounding.
 */
export function atomicToXmrStr(picoXmr: bigint): string {
  const whole = picoXmr / 1_000_000_000_000n;
  const frac  = picoXmr % 1_000_000_000_000n;
  return `${whole}.${frac.toString().padStart(12, '0')}`;
}

/** Convert USDC atomic units to human-readable string (2 d.p.). */
export function atomicToUsdc(atomic: string | number): string {
  return (Number(atomic) / 10 ** USDC_DECIMALS).toFixed(2);
}

/** Convert picoXMR to human-readable XMR (6 d.p.). */
export function atomicToXmr(picoXmr: string | number): string {
  return (Number(picoXmr) / 10 ** XMR_DECIMALS).toFixed(6);
}

/** Convert wei to human-readable ETH (6 d.p.). */
export function atomicToEth(wei: string | number): string {
  return (Number(wei) / 10 ** ETH_DECIMALS).toFixed(6);
}

// ── Response types ─────────────────────────────────────────────────────────────

export interface WagyuQuote {
  fromAmount: string;         // human-readable XMR (e.g. "1")
  fromAmountUsd: string;
  fromSymbol: string;         // "XMR"
  toAmount: string;           // output token in atomic units
  toAmountUsd: string;
  toSymbol: string;           // "USDC" or "ETH"
  estimatedTime: number;      // seconds
  gasCostUsd: string;
  priceImpact: string;
  minReceived: string;        // human-readable output after slippage
  integratorFee: {
    feePercent: number;
    feeUsd: string;
    willCollect: boolean;
    gasCostUsd: string;
    integratorName: string;
  } | null;
}

export type WagyuOrderStatus =
  | 'awaiting_deposit'
  | 'confirming'
  | 'swapping'
  | 'complete'
  | 'failed'
  | 'refunded'
  | 'expired';

export interface WagyuOrder {
  orderId: string;
  sessionId: string;
  depositAddress: string;       // XMR address — send exactly depositAmount here
  depositAmount: string;        // picoXMR — must match EXACTLY
  depositAmountFormatted: string;
  toAddress: string;            // destination ETH address
  toTokenSymbol: string;        // "USDC" or "ETH"
  expectedOutput: string;       // output token atomic units
  expectedOutputUsd: string;
  expiresAt: string;            // ISO timestamp (2-hour window)
  status: WagyuOrderStatus;
}

export interface WagyuOrderDetail extends WagyuOrder {
  currentStep: string;
  confirmations: number;
  requiredConfirmations: number;
  depositTxHash: string | null;
  actualOutput: string | null;  // output atomic units once complete
  errorMessage: string | null;
  completedAt: string | null;
}

// ── Internal ───────────────────────────────────────────────────────────────────

async function wagyuFetch<T>(path: string, options: RequestInit = {}, apiKey = WAGYU_API_KEY): Promise<T> {
  const url = `${WAGYU_API_BASE}${path}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };
  if (apiKey) headers['X-API-KEY'] = apiKey;
  const res = await fetch(url, { ...options, headers });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`wagyu ${path} ${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Get a quote for XMR → USDC (Arbitrum) for hedge/top-up flows.
 * Uses WAGYU_HEDGE_API_KEY so the integrator fee is applied.
 *
 * @param xmrAmount  Human-readable XMR, e.g. "0.9"
 */
export async function getQuote(xmrAmount: string): Promise<WagyuQuote> {
  return wagyuFetch<WagyuQuote>('/v1/quote', {
    method: 'POST',
    body: JSON.stringify({
      fromChainId: MONERO_CHAIN_ID,
      toChainId:   ARBITRUM_CHAIN_ID,
      fromToken:   'XMR',
      toToken:     USDC_ARB_ADDRESS,
      fromAmount:  xmrToAtomic(xmrAmount),
    }),
  }, WAGYU_HEDGE_API_KEY);
}

/**
 * Create a swap order: XMR → USDC (Arbitrum) for hedge/top-up flows.
 * Uses WAGYU_HEDGE_API_KEY so the integrator fee is applied.
 * Send exactly order.depositAmount picoXMR to order.depositAddress to trigger the swap.
 *
 * @param xmrAmount  Human-readable XMR, e.g. "0.9"
 * @param toAddress  Destination ETH address for USDC output
 */
export async function createOrder(xmrAmount: string, toAddress: string): Promise<WagyuOrder> {
  return wagyuFetch<WagyuOrder>('/v1/order', {
    method: 'POST',
    body: JSON.stringify({
      fromChainId: MONERO_CHAIN_ID,
      toChainId:   ARBITRUM_CHAIN_ID,
      fromToken:   'XMR',
      toToken:     USDC_ARB_ADDRESS,
      fromAmount:  xmrToAtomic(xmrAmount),
      toAddress,
    }),
  }, WAGYU_HEDGE_API_KEY);
}

/**
 * Poll order status. Call until status is 'complete', 'failed', 'refunded', or 'expired'.
 */
export async function getOrder(orderId: string): Promise<WagyuOrderDetail> {
  return wagyuFetch<WagyuOrderDetail>(`/v1/order/${orderId}`);
}

/**
 * Get a quote for USDC (Arbitrum) → XMR.
 * @param usdcMicro  USDC in atomic units (6 decimals), e.g. "63000000" for $63
 */
// Lighter always withdraws to Ethereum L1, so reverse swaps use Ethereum USDC.
// Uses WAGYU_HEDGE_API_KEY so the integrator fee is applied.
export async function getReverseQuote(usdcMicro: string): Promise<WagyuQuote> {
  return wagyuFetch<WagyuQuote>('/v1/quote', {
    method: 'POST',
    body: JSON.stringify({
      fromChainId: ETHEREUM_CHAIN_ID,
      toChainId:   MONERO_CHAIN_ID,
      fromToken:   USDC_ETH_ADDRESS,
      toToken:     'XMR',
      fromAmount:  usdcMicro,
    }),
  }, WAGYU_HEDGE_API_KEY);
}

/**
 * Create a USDC (Arbitrum) → XMR swap order.
 * Returns an EVM deposit address on Arbitrum where USDC must be sent.
 *
 * @param usdcMicro   USDC in atomic units, e.g. "63000000"
 * @param xmrAddress  Destination Monero address for XMR output
 */
export async function createReverseOrder(
  usdcMicro: string,
  xmrAddress: string,
): Promise<WagyuOrder> {
  return wagyuFetch<WagyuOrder>('/v1/order', {
    method: 'POST',
    body: JSON.stringify({
      fromChainId: ETHEREUM_CHAIN_ID,
      toChainId:   MONERO_CHAIN_ID,
      fromToken:   USDC_ETH_ADDRESS,
      toToken:     'XMR',
      fromAmount:  usdcMicro,
      toAddress:   xmrAddress,
    }),
  }, WAGYU_HEDGE_API_KEY);
}

async function fetchUsdcBalance(address: string, rpc: string, usdcContract: string): Promise<string> {
  const data = '0x70a08231' + address.slice(2).padStart(64, '0');
  const res = await fetch(rpc, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'eth_call',
      params: [{ to: usdcContract, data }, 'latest'],
      id: 1,
    }),
  });
  const { result } = await res.json() as { result: string };
  const raw = BigInt(result ?? '0x0');
  return (Number(raw) / 10 ** USDC_DECIMALS).toFixed(2);
}

/** Fetch USDC balance on Arbitrum One. Returns human-readable string e.g. "42.50". */
export async function fetchArbUsdcBalance(address: string): Promise<string> {
  return fetchUsdcBalance(address, 'https://arb1.arbitrum.io/rpc', USDC_ARB_ADDRESS);
}

/** Fetch USDC balance on Ethereum mainnet. Returns human-readable string e.g. "42.50". */
export async function fetchEthUsdcBalance(address: string): Promise<string> {
  return fetchUsdcBalance(address, 'https://rpc.ankr.com/eth', USDC_ETH_ADDRESS);
}

// ── Generic swap functions ──────────────────────────────────────────────────────

/**
 * Convert a human-readable amount string to atomic units for any token.
 * e.g. "0.01" BTC (8 decimals) → "1000000"
 */
export function toAtomicStr(amount: string, decimals: number): string {
  const [whole, frac = ''] = amount.split('.');
  const fracPadded = frac.padEnd(decimals, '0').slice(0, decimals);
  return (BigInt(whole || '0') * (10n ** BigInt(decimals)) + BigInt(fracPadded || '0')).toString();
}

/**
 * Format an atomic amount string as human-readable for a given token.
 * Uses 8 dp for BTC, 2 dp for USDC, 6 dp for everything else.
 */
export function formatTokenAmount(atomic: string, token: SwapToken): string {
  const n = Number(atomic) / (10 ** token.decimals);
  const dp = token.symbol === 'USDC' ? 2 : token.symbol === 'BTC' ? 8 : 6;
  return `${n.toFixed(dp)} ${token.symbol}`;
}

/** Get a quote for any token pair via wagyu. */
export async function getSwapQuote(
  from: SwapToken,
  to: SwapToken,
  fromAmount: string,
): Promise<WagyuQuote> {
  return wagyuFetch<WagyuQuote>('/v1/quote', {
    method: 'POST',
    body: JSON.stringify({
      fromChainId: from.chainId,
      toChainId:   to.chainId,
      fromToken:   from.tokenId,
      toToken:     to.tokenId,
      fromAmount:  toAtomicStr(fromAmount, from.decimals),
    }),
  });
}

/** Create a swap order for any token pair via wagyu. */
export async function createSwapOrder(
  from: SwapToken,
  to: SwapToken,
  fromAmount: string,
  toAddress: string,
): Promise<WagyuOrder> {
  return wagyuFetch<WagyuOrder>('/v1/order', {
    method: 'POST',
    body: JSON.stringify({
      fromChainId: from.chainId,
      toChainId:   to.chainId,
      fromToken:   from.tokenId,
      toToken:     to.tokenId,
      fromAmount:  toAtomicStr(fromAmount, from.decimals),
      toAddress,
    }),
  });
}
