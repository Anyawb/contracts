# Local Funds Flow Smoke (Strict)

This README lists the exact CLI steps to prepare and run the strict smoke test.

## 0) (Production-like) Pre-grant required roles (no auto-grant inside smoke)

The smoke scripts are intentionally **production-like**: they do **not** auto-grant roles when missing.

Required roles (SSOT: `AccessControlManager`):

**A) Create-order smoke (`funds-flow-smoke-create-order.ts`)**
- **deployer** (the script signer that runs setup actions) must have:
  - **`ACTION_ADD_WHITELIST`** (`keccak256("ADD_WHITELIST")`) — to allow the collateral/debt token in `AssetWhitelist` (if not already allowed)
  - **`ACTION_UPDATE_PRICE`** (`keccak256("UPDATE_PRICE")`) — to set price in `PriceOracle` (if not already set)
  - **`ACTION_SET_PARAMETER`** (`keccak256("SET_PARAMETER")`) — to update config such as supported token list in `FeeRouter` (if needed)
- **VaultBusinessLogic** (module contract address) must have:
  - **`ACTION_ORDER_CREATE`** (`keccak256("ORDER_CREATE")`) — to call `OrderEngine.createLoanOrder`
  - **`ACTION_DEPOSIT`** (`keccak256("DEPOSIT")`) — for fee routing paths used during match finalization
- **OrderEngine** (module contract address) must have:
  - **`ACTION_BORROW`** (`keccak256("BORROW")`) — to mint `LoanNFT` certificates

Additionally, protocol configuration must already be in place (this script does **not** auto-config):
- **AssetWhitelist** must allow the token used by the smoke (default: `MockUSDC` on localhost).
- **PriceOracle** must have:
  - an **active** asset config (e.g. `coingeckoId="usd-coin"`, `decimals=8`, `maxPriceAge=3600`)
  - a **fresh & valid** price (so `PriceOracle.getPrice(token)` does not revert with `StalePrice/InvalidPrice`)
- **FeeRouter** must already **support** the token (so `FeeRouter.isTokenSupported(token) == true`).

**B) Keeper-path strict smoke (`funds-flow-smoke-local.ts`)**
- **keeper** (the account that calls `SettlementManager.settleOrLiquidate`) must have:
  - **`ACTION_LIQUIDATE`** (`keccak256("LIQUIDATE")`)
- **SettlementManager** must have:
  - **`ACTION_REPAY`** (`keccak256("REPAY")`)
  - **`ACTION_VIEW_SYSTEM_DATA`** (`keccak256("VIEW_SYSTEM_DATA")`)

On localhost (after deploy), grant them with:

```bash
pnpm -s exec hardhat run "scripts/tests/grant-required-roles-local.ts" --network localhost
```

## 1) Create an order and get `ORDER_ID`

```bash
pnpm -s exec hardhat run "scripts/tests/funds-flow-smoke-create-order.ts" --network localhost
```

The script prints `orderId <N>`. Use that value for the next steps.

## 2) Prepare prerequisites (balances + allowances)

```bash
ORDER_ID=<N> pnpm -s exec hardhat run "scripts/tests/setup-and-test.ts" --network localhost
```

This sets:
- borrower collateral token balance
- borrower debt token balance
- allowance to `CollateralManager` (deposit path)
- allowance to `VaultCore` (repay path)

## 3) Run strict smoke test

```bash
ORDER_ID=<N> pnpm -s exec hardhat run "scripts/tests/funds-flow-smoke-local.ts" --network localhost
```

## Notes: strict repay mode (batchRepay)

`SettlementManager` can enable strict full-repay auto-release:

- If `requireFullRepayRelease == true`, then **batch repay must repay full debt**.
- Partial repay will revert with `SettlementManager__DebtNotCleared` (custom error).

The `setup-and-test.ts` script detects this mode and, if enabled, prepares
borrower balance + allowance for the **full debt amount**.

---

# Funds Conservation Smoke (token-level invariants)

This smoke checks ERC20 **totalSupply invariance** and **tracked-address balance-sum conservation**
across liquidation and repay flows.

```bash
pnpm -s exec hardhat run "scripts/tests/funds-flow-smoke-conservation.ts" --network localhost
```

Useful knobs:
- Run only liquidation: `RUN_REPAY=0 ...`
- Run only repay: `RUN_LIQUIDATION=0 ...`
- Provide your own orders:
  - `ORDER_ID_LIQ=<N> ORDER_ID_REPAY=<M> ...`

## (NEW) Non-stable collateral (mWETH) + liquidation-chain oracle/valuation edge cases

This extends the smoke beyond stablecoin collateral: it deploys a non-stable ERC20 (`mWETH`),
deposits it as collateral, borrows `MockUSDC`, makes the position overdue, then runs
`SettlementManager.settleOrLiquidate`.

It is designed to surface oracle/valuation boundary behavior *in the real liquidation entry*:
- `stale` collateral price: `PriceOracle.getPrice` reverts; `PositionView.getAssetValue` returns 0; liquidation may revert `SettlementManager__NoCollateral`.
- `unreasonable` price: liquidation proceeds (oracle may still return a price; valuation can be extreme).
- `bad_decimals` (<6): liquidation proceeds (PositionView accepts small decimals; GD-only checks differ).

### Prerequisite (recommended for reproducibility)

Run a local node, deploy fresh modules, then run the smoke (dirty state also works; the smoke uses deltas):

```bash
pnpm -s exec hardhat node
```

In a new terminal:

```bash
pnpm -s exec hardhat run "scripts/deploy/deploylocal.ts" --network localhost
```

### 1) Fresh collateral price (should liquidate successfully)

```bash
CREATE_ORDER=1 RUN_LIQUIDATION=1 RUN_REPAY=0 \
USE_NONSTABLE_COLLATERAL=1 COLLATERAL_PRICE_MODE=fresh \
pnpm -s exec hardhat run "scripts/tests/funds-flow-smoke-conservation.ts" --network localhost
```

### 2) Stale collateral price (expected edge behavior: liquidation revert)

In this mode, liquidation is expected to revert with `SettlementManager__NoCollateral` due to collateral value being treated as 0.
Set `EXPECT_LIQUIDATION_REVERT` so the script treats this as an *expected* boundary assertion and continues.

```bash
CREATE_ORDER=1 RUN_LIQUIDATION=1 RUN_REPAY=0 \
USE_NONSTABLE_COLLATERAL=1 COLLATERAL_PRICE_MODE=stale \
EXPECT_LIQUIDATION_REVERT=SettlementManager__NoCollateral \
pnpm -s exec hardhat run "scripts/tests/funds-flow-smoke-conservation.ts" --network localhost
```

### 3) Unreasonable collateral price (should liquidate successfully)

```bash
CREATE_ORDER=1 RUN_LIQUIDATION=1 RUN_REPAY=0 \
USE_NONSTABLE_COLLATERAL=1 COLLATERAL_PRICE_MODE=unreasonable \
pnpm -s exec hardhat run "scripts/tests/funds-flow-smoke-conservation.ts" --network localhost
```

### 4) Bad decimals (< 6) on collateral price (should liquidate successfully)

```bash
CREATE_ORDER=1 RUN_LIQUIDATION=1 RUN_REPAY=0 \
USE_NONSTABLE_COLLATERAL=1 COLLATERAL_PRICE_MODE=bad_decimals \
pnpm -s exec hardhat run "scripts/tests/funds-flow-smoke-conservation.ts" --network localhost
```

### Notes (dirty state & fee assertions)

- The smoke is designed to work in **dirty state**:
  - Assertions are based on **before/after deltas**, not absolute balances.
  - Fee assertions use SSOT (`FeeDistributed` event + FeeRouter stats deltas). If `platformTreasury == ecosystemVault` in your environment,
    the script still validates the split correctly.
- Disable fee assertions (if you only want conservation): `ASSERT_FEES_ON_CREATE=0`

---

# Funds-Flow Invariants Suite (more realistic multi-scenario)

This suite extends beyond a single clean flow and is designed to surface issues you’ll hit on a real lending platform:
- reserve → cancel (funds in/out of `LenderPoolVault`)
- partial repay → full repay (requires strict mode disabled)
- strict full-repay mode + aggregated debt behavior (expects a revert, then succeeds after disabling strict)
- overdue liquidation (keeper path)

Run:

```bash
pnpm -s exec hardhat run "scripts/tests/funds-flow-invariants-suite.ts" --network localhost
```

Token selection:
- Default: uses `FeeRouter.getSupportedTokens()`
- Override: `TOKENS=tokenAddr1,tokenAddr2` (CSV)

Important:
- `TOKENS` must be a comma-separated list of **addresses** (e.g., `TOKENS=0x...`), not a symbol name like `MockUSDC`.
- For localhost, you can use `CONTRACT_ADDRESSES.MockUSDC` from `frontend-config/contracts-localhost.ts`.

Env knobs (all default to enabled):
- Minimal modes (disable all other cases; uses first token only):
  - `RUN_FINALIZE_MATCH_ONLY=1`: validates `finalizeMatch` consume observability:
    - `LendReserveConsumed`
    - `DataPushed(RESERVE_CONSUMED, ...)` (payload decoded & verified)
  - `RUN_MATCH_DISBURSEMENT_ONLY=1`: validates the full match → borrow disbursement SSOT invariants:
    - pool funding (`LenderPoolVault` balance decreases by principal)
    - no retention on `VaultBusinessLogic` (balance delta == 0)
    - borrower receives net in (0, principal]
    - fee recipients receive exactly `principal - net` (handles `platformTreasury == ecosystemVault`)
    - no collateral top-up during match (CollateralManager token balance delta == 0)
    - order/ledger consistency (`LoanOrder.lender == LenderPoolVault`, `debt == principal`)
- `RUN_RESERVE_CANCEL=0`
- `RUN_PARTIAL_REPAY=0`
- `RUN_STRICT_AGGREGATED_DEBT=0`
- `RUN_LIQUIDATION=0`

Optional role-gate checks (requires AccessControlManager owner):
- `ASSERT_ROLE_GATES=1`:
  - Temporarily revokes/grants `ORDER_CREATE` and `DEPOSIT` roles to ensure `finalizeMatch` is properly role-gated.
  - If you are not ACM owner, keep this off (default).

State mode:
- Clean/CI style: restart localhost node + run deploylocal + run suite.
- Dirty state (closer to testnet/mainnet): set `E2E_ALLOW_DIRTY_STATE=1`
  (the suite will try to pick “clean” signers; if none exist it falls back to unused signers).

Recommended minimal commands (copy/paste):

1) Minimal finalizeMatch consume + RESERVE_CONSUMED DataPush (very short output):

```bash
TOKENS=0x071586BA1b380B00B793Cc336fe01106B0BFbE6D \
E2E_ALLOW_DIRTY_STATE=1 RUN_FINALIZE_MATCH_ONLY=1 \
RUN_RESERVE_CANCEL=0 RUN_PARTIAL_REPAY=0 RUN_STRICT_AGGREGATED_DEBT=0 RUN_LIQUIDATION=0 \
pnpm -s exec hardhat run "scripts/tests/funds-flow-invariants-suite.ts" --network localhost
```

2) Minimal match -> borrow disbursement SSOT assertions (covers Funds-Flow-Architecture-Guide.md "Finalize Match" + disbursement semantics):

```bash
TOKENS=0x071586BA1b380B00B793Cc336fe01106B0BFbE6D \
E2E_ALLOW_DIRTY_STATE=1 RUN_MATCH_DISBURSEMENT_ONLY=1 \
RUN_RESERVE_CANCEL=0 RUN_PARTIAL_REPAY=0 RUN_STRICT_AGGREGATED_DEBT=0 RUN_LIQUIDATION=0 \
pnpm -s exec hardhat run "scripts/tests/funds-flow-invariants-suite.ts" --network localhost
```

Tracking set:
- Both `funds-flow-smoke-conservation.ts` and the suite **auto-discover** the tracked address set from SSOT config
  (Registry modules + FeeRouter recipients + LiquidationPayoutManager recipients + VaultCore.viewContractAddrVar()).
  If funds leak to an unexpected address outside this set, the test fails and prints the diff.
