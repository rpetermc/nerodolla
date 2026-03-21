"""
Wrapper that patches lighter_proxy with:

1. Await wallet refresh before balance queries (fixes stale LWS data)
2. EUR hedge support: open EUR-USD LONG alongside XMR-USD SHORT
3. Generic /market/{symbol} endpoint for EUR-USD, GBP-USD, XAU-USD, XAG-USD

Usage:
  uvicorn lighter_proxy_fix:app --host 0.0.0.0 --port 8000
"""

import importlib
import logging
import math
import time

import lighter_proxy

from fastapi import Depends, HTTPException

log = logging.getLogger('lighter_proxy')

# ── Bot config override ───────────────────────────────────────────────────────
# The bot is a market maker placing BOTH bids and asks, but for hedging we need
# it to build a SHORT. Crank skew so asks are tight+large, bids are wide+tiny.
#
# With skew maxed (skew_norm=1.0) and base_spread=20bps:
#   price_skew = 1.0 * 0.45 * 0.002 = 0.0009
#   ask_spread = 0.002 - 0.0009 = 11 bps  (tight, fills fast)
#   bid_spread = 0.002 + 0.0009 = 29 bps  (wide, rarely fills)
#   ask_size = base * 1.9  (large)
#   bid_size = base * 0.1  (tiny)
lighter_proxy._BOT_CFG['skew_factor'] = 0.45
lighter_proxy._BOT_CFG['size_skew_factor'] = 0.9

# ── Market registry ────────────────────────────────────────────────────────────

# Maps symbols to Lighter market IDs.  FX pairs use "EURUSD" on Lighter but
# the frontend calls them "EUR-USD".  We normalise by stripping dashes.
MARKET_REGISTRY = {
    'EURUSD': {'id': 96, 'size_dec': 1, 'price_dec': 5, 'min_base': 10.0},
    'GBPUSD': {'id': 97, 'size_dec': 1, 'price_dec': 5, 'min_base': 10.0},
    'XAUUSD': {'id': 92, 'size_dec': 4, 'price_dec': 2, 'min_base': 0.003},
    'XAGUSD': {'id': 93, 'size_dec': 2, 'price_dec': 4, 'min_base': 0.15},
}

# XMR market config (from existing code)
XMR_SIZE_DECIMALS = 3
XMR_PRICE_DECIMALS = 3


# ── Patch 1: await wallet refresh ──────────────────────────────────────────────

_original_ensure_wallet = lighter_proxy._ensure_wallet


async def _patched_ensure_wallet(address, view_key, spend_key='', restore_height=None):
    """Open wallet, then await a blocking refresh so data is current."""
    await _original_ensure_wallet(address, view_key, spend_key, restore_height)
    try:
        await lighter_proxy._wallet_rpc('refresh')
    except Exception:
        pass


lighter_proxy._ensure_wallet = _patched_ensure_wallet


# ── Patch 2: generic /market/{symbol} endpoint ────────────────────────────────

app = lighter_proxy.app


def _swap_route_endpoint(path: str, new_endpoint):
    """Replace a route in-place (same position) so it stays ahead of the static mount."""
    from fastapi.routing import APIRoute
    for i, route in enumerate(app.routes):
        if hasattr(route, 'path') and route.path == path and isinstance(route, APIRoute):
            # Build a fresh APIRoute with the new endpoint, preserving HTTP methods
            new_route = APIRoute(
                path=route.path,
                endpoint=new_endpoint,
                methods=route.methods,
                name=route.name,
            )
            app.routes[i] = new_route
            return True
    return False


# ── Patch: /account endpoint — fallback to index-based lookup ─────────────────
# The compiled get_account uses accounts_by_l1_address which can return empty
# (CloudFront 403, API changes, etc.). We override the endpoint to fall back
# to our SQLite DB account_index → account(by='index') lookup.

_original_get_account = None
for route in app.routes:
    if hasattr(route, 'path') and route.path == '/account':
        _original_get_account = route.endpoint
        break

if _original_get_account:
    async def patched_get_account(eth_address: str = None):
        """Account lookup — always use index-based query for reliable position data."""
        if not eth_address:
            return {'address': '', 'usdcBalance': 0.0, 'totalCollateral': 0.0, 'positions': []}

        # Resolve account_index: try original l1_address lookup for the index,
        # then fall back to our DB.
        account_index = None
        try:
            from lighter import AccountApi as _AA
            lookup = await lighter_proxy._account_api.accounts_by_l1_address(
                l1_address=eth_address
            )
            subs = getattr(lookup, 'sub_accounts', []) or getattr(lookup, 'accounts', []) or []
            if subs:
                account_index = int(getattr(subs[0], 'index', 0))
        except Exception:
            pass

        if not account_index:
            account_index = await lighter_proxy._db_get_account_index(eth_address.lower())
            log.info('patched_get_account: DB fallback index=%s for %s', account_index, eth_address)
        if not account_index:
            return {'address': eth_address, 'usdcBalance': 0.0, 'totalCollateral': 0.0, 'positions': []}

        try:
            from lighter import ApiClient, AccountApi, Configuration
            config = Configuration(host=lighter_proxy.LIGHTER_URL)
            api_client = ApiClient(configuration=config)
            acct_api = AccountApi(api_client)

            ar = await acct_api.account(
                by='index', value=str(account_index)
            )
            al = getattr(ar, 'accounts', []) or []
            log.info('patched_get_account: got %d accounts from index lookup', len(al))
            if not al:
                return {'address': eth_address, 'usdcBalance': 0.0, 'totalCollateral': 0.0, 'positions': []}

            acct = al[0]
            collateral = float(getattr(acct, 'collateral', 0) or 0)
            avail = float(getattr(acct, 'available_balance', collateral) or collateral)

            # Parse positions ourselves to fix sign→side mapping
            positions = []
            for p in getattr(acct, 'positions', []) or []:
                size = abs(float(getattr(p, 'position', 0) or 0))
                if size == 0:
                    continue
                sign = int(getattr(p, 'sign', 0) or 0)
                is_short = sign < 0
                entry_price = float(getattr(p, 'avg_entry_price', 0) or 0)
                raw_sym = getattr(p, 'symbol', 'UNKNOWN') or 'UNKNOWN'
                # Normalise symbol names
                sym_map = {'XMR': 'XMR-USD', 'EURUSD': 'EUR-USD', 'GBPUSD': 'GBP-USD'}
                symbol = sym_map.get(raw_sym, raw_sym)

                pos_dict = {
                    'symbol': symbol,
                    'side': 'SHORT' if is_short else 'LONG',
                    'size': size,
                    'entryPrice': entry_price,
                    'markPrice': 0.0,
                    'unrealizedPnl': float(getattr(p, 'unrealized_pnl', 0) or 0),
                    'marginUsed': float(getattr(p, 'allocated_margin', 0) or 0),
                    'fundingRate': 0.0,
                    'annualizedFundingPct': 0.0,
                    'lockedUsdValue': size * entry_price,
                }

                # Enrich with live market data
                if symbol == 'XMR-USD':
                    try:
                        mi = await lighter_proxy._get_market_info_inner()
                        pos_dict['markPrice'] = mi.get('markPrice', 0)
                        pos_dict['fundingRate'] = mi.get('fundingRate8h', mi.get('fundingRate', 0))
                        pos_dict['annualizedFundingPct'] = mi.get('annualizedFundingPct', 0)
                    except Exception:
                        pass
                else:
                    clean_sym = symbol.replace('-', '')
                    if clean_sym in MARKET_REGISTRY:
                        try:
                            mi = await _get_market_info(MARKET_REGISTRY[clean_sym]['id'], symbol)
                            pos_dict['markPrice'] = mi.get('markPrice', 0)
                            pos_dict['fundingRate'] = mi.get('fundingRate8h', mi.get('fundingRate', 0))
                            pos_dict['annualizedFundingPct'] = mi.get('annualizedFundingPct', 0)
                        except Exception:
                            pass

                positions.append(pos_dict)

            return {
                'address': eth_address,
                'usdcBalance': avail,
                'totalCollateral': collateral,
                'positions': positions,
            }
        except Exception as exc:
            import traceback
            log.warning('patched_get_account: index fallback failed: %s\n%s', exc, traceback.format_exc())
            return {'address': eth_address, 'usdcBalance': 0.0, 'totalCollateral': 0.0, 'positions': []}

    _swap_route_endpoint('/account', patched_get_account)


async def _get_market_info(market_id: int, symbol: str) -> dict:
    """Fetch mark price, open interest, and funding rate for any market."""
    from lighter import ApiClient, OrderApi, FundingApi, Configuration

    config = Configuration(host=lighter_proxy.LIGHTER_URL)
    client = ApiClient(config)

    mark_price = 0.0
    open_interest = 0.0
    funding_8h = 0.0

    try:
        order_api = OrderApi(client)
        details = await order_api.order_book_details(market_id=market_id)
        ob = details.order_book_details[0] if details.order_book_details else None
        if ob:
            mark_price = float(ob.last_trade_price or 0)
            open_interest = float(ob.open_interest or 0)
    except Exception as exc:
        log.error('order_book_details(%d) failed: %s', market_id, exc)

    try:
        funding_api = FundingApi(client)
        fr = await funding_api.funding_rates()
        if fr.funding_rates:
            for rate in fr.funding_rates:
                if getattr(rate, 'market_id', None) == market_id:
                    funding_8h = float(getattr(rate, 'funding_rate', 0) or 0)
                    break
    except Exception as exc:
        log.error('funding_rates(%d) failed: %s', market_id, exc)

    await client.close()

    annualized = funding_8h * 3 * 365 * 100  # 8h → annual %

    return {
        'markPrice': mark_price,
        'indexPrice': mark_price,
        'openInterest': open_interest,
        'fundingRate8h': funding_8h,
        'annualizedFundingPct': round(annualized, 2),
        'symbol': symbol,
    }


@app.get('/market/{symbol}')
async def get_market_by_symbol(symbol: str):
    """Generic market info endpoint.  Supports XMR-USD, EUR-USD, GBP-USD, etc."""
    normalised = symbol.replace('-', '').upper()
    if normalised in ('XMR', 'XMRUSD'):
        # Delegate to existing handler
        return await lighter_proxy._get_market_info_inner()

    market = MARKET_REGISTRY.get(normalised)
    if not market:
        raise HTTPException(status_code=404, detail=f'Unknown market: {symbol}')

    return await _get_market_info(market['id'], symbol)


# ── Patch 3: EUR leg in open_hedge ─────────────────────────────────────────────

# Find and wrap the existing open_hedge route handler
_original_open_hedge = None
for route in app.routes:
    if hasattr(route, 'path') and route.path == '/hedge/open':
        _original_open_hedge = route.endpoint
        break


async def _open_eur_leg(session, notional_usd: float, slippage_bps: int = 50):
    """Open a EUR-USD LONG position sized to match the XMR short notional."""
    market = MARKET_REGISTRY['EURUSD']
    market_id = market['id']
    size_dec = market['size_dec']
    price_dec = market['price_dec']
    min_base = market['min_base']

    # Get EUR-USD mark price
    info = await _get_market_info(market_id, 'EUR-USD')
    eur_price = info['markPrice']
    if eur_price <= 0:
        raise ValueError(f'Invalid EUR-USD mark price: {eur_price}')

    # EUR size = USD notional / EUR-USD price
    eur_size = notional_usd / eur_price
    if eur_size < min_base:
        raise ValueError(
            f'EUR position size {eur_size:.1f} below minimum {min_base}'
        )

    slippage = slippage_bps / 10_000
    # LONG → we're buying, so set max price (1 + slippage)
    avg_price_scaled = int(round(eur_price * (1 + slippage) * 10**price_dec))
    base_amount_scaled = int(round(eur_size * 10**size_dec))
    client_order_index = int(time.time() * 1000) % 2147483648

    log.info(
        'open_eur_leg: market=%d size_eur=%.1f price=%.5f scaled_size=%d scaled_price=%d',
        market_id, eur_size, eur_price, base_amount_scaled, avg_price_scaled,
    )

    order, resp, err = await session.signer_client.create_market_order(
        market_index=market_id,
        client_order_index=client_order_index,
        base_amount=base_amount_scaled,
        avg_execution_price=avg_price_scaled,
        is_ask=False,       # LONG (buy)
        reduce_only=False,
    )

    log.info('open_eur_leg result: err=%r resp=%r order=%r', err, resp, order)

    if err:
        err_str = str(err)
        if not err_str.startswith('code=200'):
            raise RuntimeError(f'EUR-USD order error: {err}')
        log.info('open_eur_leg: ignoring non-fatal SDK note: %s', err)

    resp_code = getattr(resp, 'code', None) or getattr(resp, 'error_code', None)
    if resp_code and int(resp_code) not in (0, 200):
        resp_msg = getattr(resp, 'message', None) or getattr(resp, 'error_message', None)
        raise RuntimeError(f'EUR-USD order rejected: code={resp_code} msg={resp_msg}')

    tx_hash = getattr(resp, 'tx_hash', None) or ''
    log.info('Opened EUR-USD LONG: size=%.1f price=%.5f tx=%s', eur_size, eur_price, tx_hash)
    return {'eur_size': eur_size, 'eur_price': eur_price, 'tx_hash': tx_hash}


async def _close_eur_leg(session):
    """Close any EUR-USD LONG position (reduce_only market order)."""
    from lighter import ApiClient, AccountApi, Configuration

    config = Configuration(host=lighter_proxy.LIGHTER_URL)
    client = ApiClient(config)
    account_api = AccountApi(client)

    result = await account_api.account(by='index', value=str(session.account_index))
    await client.close()

    positions = lighter_proxy._parse_positions(result)
    eur_longs = [p for p in positions if p.get('symbol') in ('EURUSD', 'EUR-USD') and p.get('side') == 'LONG']

    if not eur_longs:
        log.info('close_eur_leg: no EUR-USD LONG position found, skipping')
        return

    eur_pos = eur_longs[0]
    eur_size = abs(eur_pos['size'])
    market = MARKET_REGISTRY['EURUSD']
    market_id = market['id']
    size_dec = market['size_dec']
    price_dec = market['price_dec']

    info = await _get_market_info(market_id, 'EUR-USD')
    eur_price = info['markPrice']

    # CLOSE LONG → sell (is_ask=True), reduce_only=True
    slippage = 50 / 10_000  # 0.5%
    avg_price_scaled = int(round(eur_price * (1 - slippage) * 10**price_dec))
    base_amount_scaled = int(round(eur_size * 10**size_dec))
    client_order_index = int(time.time() * 1000) % 2147483648

    log.info('close_eur_leg: size=%.1f price=%.5f', eur_size, eur_price)

    order, resp, err = await session.signer_client.create_market_order(
        market_index=market_id,
        client_order_index=client_order_index,
        base_amount=base_amount_scaled,
        avg_execution_price=avg_price_scaled,
        is_ask=True,         # sell to close long
        reduce_only=True,
    )

    if err:
        err_str = str(err)
        if not err_str.startswith('code=200'):
            log.warning('close_eur_leg error (non-fatal): %s', err)
        else:
            log.info('close_eur_leg: ignoring SDK note: %s', err)

    tx_hash = getattr(resp, 'tx_hash', None) or ''
    log.info('Closed EUR-USD LONG: size=%.1f tx=%s', eur_size, tx_hash)


if _original_open_hedge:
    async def _patched_open_hedge(req, session=Depends(lighter_proxy.get_session)):
        """Open XMR short + optional EUR-USD LONG."""
        result = await _original_open_hedge(req, session)

        currency = getattr(req, 'currency', None) or 'USD'
        if currency == 'EUR' and getattr(result, 'success', False):
            try:
                xmr_size = float(req.xmr_size or 0)
                xmr_market = await lighter_proxy._get_market_info_inner()
                xmr_price = xmr_market.get('markPrice', 0)
                notional_usd = xmr_size * xmr_price
                await _open_eur_leg(session, notional_usd, req.slippage_bps or 50)
            except Exception as exc:
                log.error('EUR leg failed (XMR short already open): %s', exc)

        return result

    _swap_route_endpoint('/hedge/open', _patched_open_hedge)


# ── Patch 4: close EUR leg before closing XMR short ───────────────────────────

_original_close_hedge = None
for route in app.routes:
    if hasattr(route, 'path') and route.path == '/hedge/close':
        _original_close_hedge = route.endpoint
        break

if _original_close_hedge:
    async def _patched_close_hedge(session=Depends(lighter_proxy.get_session)):
        """Close EUR-USD LONG (if any) then close XMR short and withdraw."""
        try:
            await _close_eur_leg(session)
        except Exception as exc:
            log.error('close_eur_leg failed (continuing with XMR close): %s', exc)
        return await _original_close_hedge(session)

    _swap_route_endpoint('/hedge/close', _patched_close_hedge)


# ── Patch 5: add 'currency' field to OpenHedgeRequest ─────────────────────────
# The original model doesn't have it; pydantic ignores extra fields by default.
# We need to add it so the patched open_hedge can read req.currency.

from pydantic import BaseModel
from typing import Optional


class PatchedOpenHedgeRequest(BaseModel):
    usdc_amount: str
    xmr_size: Optional[str] = None
    slippage_bps: Optional[int] = None
    currency: Optional[str] = None


lighter_proxy.OpenHedgeRequest = PatchedOpenHedgeRequest


# ── Patch 7: open EUR leg when bot starts ─────────────────────────────────────

class PatchedBotStartRequest(BaseModel):
    xmr_address: str
    view_key: str
    xmr_balance: float
    currency: Optional[str] = None


_original_bot_start = None
for route in app.routes:
    if hasattr(route, 'path') and route.path == '/bot/start':
        _original_bot_start = route.endpoint
        break

if _original_bot_start:
    async def _patched_bot_start(req: PatchedBotStartRequest, session=Depends(lighter_proxy.get_session)):
        """Start bot + open EUR-USD LONG if currency is EUR."""
        original_req = lighter_proxy.BotStartRequest(
            xmr_address=req.xmr_address,
            view_key=req.view_key,
            xmr_balance=req.xmr_balance,
        )
        result = await _original_bot_start(original_req, session)

        currency = req.currency or 'USD'
        if currency == 'EUR':
            try:
                xmr_market = await lighter_proxy._get_market_info_inner()
                xmr_price = xmr_market.get('markPrice', 0)
                notional_usd = req.xmr_balance * xmr_price
                await _open_eur_leg(session, notional_usd)
                log.info('EUR leg opened alongside bot start: %.2f USD notional', notional_usd)
            except Exception as exc:
                log.error('EUR leg failed on bot start (bot already running): %s', exc)

        return result

    _swap_route_endpoint('/bot/start', _patched_bot_start)
