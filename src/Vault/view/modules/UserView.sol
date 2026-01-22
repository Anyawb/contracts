// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ActionKeys } from "../../../constants/ActionKeys.sol";
import { ModuleKeys } from "../../../constants/ModuleKeys.sol";
import { Registry } from "../../../registry/Registry.sol";
import { NotAContract, ZeroAddress } from "../../../errors/StandardErrors.sol";
import { RiskUtils } from "../../utils/RiskUtils.sol";
import { ViewConstants } from "../ViewConstants.sol";
import { DataPushLibrary } from "../../../libraries/DataPushLibrary.sol";
import { DataPushTypes } from "../../../constants/DataPushTypes.sol";
import { ViewAccessLib } from "../../../libraries/ViewAccessLib.sol";
import { ViewVersioned } from "../ViewVersioned.sol";

/*━━━━━━━━━━━━━━━ Selector SSOT (B方案) ━━━━━━━━━━━━━━━*/
// Selectors are derived from the canonical module contracts in this repository (SSOT),
// rather than duplicating minimal interfaces in this file.
import {PositionView} from "./PositionView.sol";
import {HealthView} from "./HealthView.sol";
import {StatisticsView} from "./StatisticsView.sol";
import {PreviewView} from "./PreviewView.sol";

/**
 * @title UserView
 * @notice User-facing read facade that delegates to specialized view modules.
 * @dev Reverts if:
 *      - registry address is not set or invalid (see `onlyValidRegistry`)
 *
 * Security:
 * - Read-only facade: uses `staticcall` for downstream module calls
 * - UUPS upgrade is role-gated via `ViewAccessLib.requireRole(...)`
 *
 * @custom:security-contact security@example.com
 */
contract UserView is Initializable, UUPSUpgradeable, ViewVersioned {
    /*━━━━━━━━━━━━━━━ Errors ━━━━━━━━━━━━━━━*/

    /**
     * @notice Batch size exceeds the configured maximum.
     * @dev Reverts if:
     *      - `size` is greater than `ViewConstants.MAX_BATCH_SIZE`
     *
     * Security:
     * - Defensive input validation to bound gas/CPU for offchain callers
     *
     * @param size Number of items requested in the batch
     */
    error UserView__BatchTooLarge(uint256 size);

    /**
     * @notice Input array lengths do not match.
     * @dev Reverts if:
     *      - `users.length != assets.length`
     *
     * Security:
     * - Defensive input validation
     */
    error UserView__LengthMismatch();

    /**
     * @notice A required module is missing from the Registry.
     * @dev Reverts if:
     *      - Registry returns `address(0)` for `moduleKey`
     *
     * Security:
     * - Prevents ambiguous reads when a dependency is not configured
     *
     * @param moduleKey Registry module key that is required
     */
    error UserView__ModuleMissing(bytes32 moduleKey);

    /**
     * @notice A downstream `staticcall` failed or returned unexpected data.
     * @dev Reverts if:
     *      - downstream `staticcall` fails (some functions are best-effort and may return zeros instead)
     *
     * Security:
     * - Read-only: this is emitted via revert, no state changes occur here
     *
     * @param moduleKey Registry module key that was called
     * @param selector Function selector attempted on the downstream contract
     */
    error UserView__ExternalCallFailed(bytes32 moduleKey, bytes4 selector);

    /*━━━━━━━━━━━━━━━ Storage ━━━━━━━━━━━━━━━*/

    /// @dev Registry contract address (private storage)
    address private _registryAddr;

    /*━━━━━━━━━━━━━━━ Types ━━━━━━━━━━━━━━━*/

    /** @notice Compact user statistics used by this facade. */
    struct UserStats {
        uint256 collateral; // Collateral amount (token decimals depend on underlying asset)
        uint256 debt; // Debt amount (token decimals depend on underlying asset)
        uint256 ltv; // Loan-to-value ratio (bps, 1e4 = 100%)
        uint256 hf; // Health factor (bps, 1e4 = 100%)
    }

    /** @notice Full user view payload (legacy/compat struct). */
    struct UserFullView {
        uint256 collateral;
        uint256 debt;
        uint256 ltv;
        uint256 hf;
        uint256 maxBorrowable;
        bool isRisky;
    }

    /** @notice Extended user statistics payload (legacy/compat struct). */
    struct UserStatisticsView {
        uint256 totalCollateral;
        uint256 totalDebt;
        uint256 healthFactor;
        uint256 lastActiveTime;
        uint256 guaranteeBalance;
        uint256 rewardPoints;
        uint256 activityScore;
        bool isActive;
        uint8 userLevel;
    }

    /// @dev Mirror of StatisticsView.UserSnapshot (for ABI decoding in facade calls)
    struct StatsUserSnapshot {
        uint256 collateral;
        uint256 debt;
        uint256 ltv;
        uint256 healthFactor;
        uint256 timestamp;
        bool isActive;
    }

    /*━━━━━━━━━━━━━━━ Constants ━━━━━━━━━━━━━━━*/

    /// @dev Maximum number of items allowed in batch read calls.
    uint256 internal constant _MAX_BATCH_SIZE = ViewConstants.MAX_BATCH_SIZE;

    /// @dev Function selectors for downstream `staticcall` payload encoding (derived from SSOT module contracts).
    bytes4 internal constant _SEL_GET_USER_POSITION = PositionView.getUserPosition.selector;
    bytes4 internal constant _SEL_GET_USER_POSITION_WITH_META = PositionView.getUserPositionWithMeta.selector;
    bytes4 internal constant _SEL_GET_USER_POSITION_WITH_VALIDITY = PositionView.getUserPositionWithValidity.selector;
    bytes4 internal constant _SEL_GET_POSITION_UPDATED_AT = PositionView.getPositionUpdatedAt.selector;
    bytes4 internal constant _SEL_GET_POSITION_VERSION = PositionView.getPositionVersion.selector;
    bytes4 internal constant _SEL_BALANCE_OF = IERC20.balanceOf.selector;
    bytes4 internal constant _SEL_GET_USER_SNAPSHOT_WITH_META = StatisticsView.getUserSnapshotWithMeta.selector;
    bytes4 internal constant _SEL_GET_USER_SNAPSHOT = StatisticsView.getUserSnapshot.selector;
    bytes4 internal constant _SEL_GET_USER_HEALTH_FACTOR = HealthView.getUserHealthFactor.selector;
    bytes4 internal constant _SEL_GET_USER_HEALTH_FACTOR_WITH_META = HealthView.getUserHealthFactorWithMeta.selector;
    bytes4 internal constant _SEL_PREVIEW_BORROW = PreviewView.previewBorrow.selector;
    bytes4 internal constant _SEL_PREVIEW_DEPOSIT = PreviewView.previewDeposit.selector;
    bytes4 internal constant _SEL_PREVIEW_REPAY = PreviewView.previewRepay.selector;
    bytes4 internal constant _SEL_PREVIEW_WITHDRAW = PreviewView.previewWithdraw.selector;
    bytes4 internal constant _SEL_BATCH_GET_USER_POSITIONS = PositionView.batchGetUserPositions.selector;
    bytes4 internal constant _SEL_BATCH_GET_HEALTH_FACTORS = HealthView.batchGetHealthFactors.selector;
    bytes4 internal constant _SEL_BATCH_GET_HEALTH_FACTORS_WITH_META =
        HealthView.batchGetHealthFactorsWithMeta.selector;

    /*━━━━━━━━━━━━━━━ Modifiers ━━━━━━━━━━━━━━━*/

    /// @dev Ensures `_registryAddr` is a deployed contract.
    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        if (_registryAddr.code.length == 0) revert NotAContract(_registryAddr);
        _;
    }

    /*━━━━━━━━━━━━━━━ Constructor / Initializer ━━━━━━━━━━━━━━━*/

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initialize this view module with a Registry address.
     * @dev Reverts if:
     *      - `initialRegistryAddr` is the zero address (`ZeroAddress`)
     *      - `initialRegistryAddr` is not a contract (`NotAContract`)
     *
     * Security:
     * - Initializer can only be called once (UUPS/Initializable)
     *
     * @param initialRegistryAddr Registry contract address
     */
    function initialize(address initialRegistryAddr) external initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        if (initialRegistryAddr.code.length == 0) revert NotAContract(initialRegistryAddr);

        __UUPSUpgradeable_init();
        _registryAddr = initialRegistryAddr;

        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_USER_VIEW_INITIALIZED,
            abi.encode(
                initialRegistryAddr,
                // solhint-disable-next-line not-rely-on-time
                block.timestamp
            )
        );
    }

    /*━━━━━━━━━━━━━━━ Internal helpers ━━━━━━━━━━━━━━━*/

    /**
     * @notice Resolve a module address from the Registry.
     * @dev Reverts if:
     *      - never reverts (best-effort; returns `address(0)` on failure)
     *
     * Security:
     * - Read-only
     *
     * @param key Module key in the Registry
     * @return module Module address, or `address(0)` if missing/unavailable
     */
    function _getModule(bytes32 key) internal view returns (address module) {
        if (_registryAddr == address(0)) return address(0);
        try Registry(_registryAddr).getModule(key) returns (address m) {
            return m;
        } catch {
            return address(0);
        }
    }

    /**
     * @notice Resolve the `HealthView` module address.
     * @dev Reverts if:
     *      - never reverts (best-effort)
     *
     * Security:
     * - Read-only
     *
     * @return HealthView module address, or `address(0)` if missing
     */
    function _healthView() internal view returns (address) {
        return _getModule(ModuleKeys.KEY_HEALTH_VIEW);
    }

    /**
     * @notice Resolve the `PositionView` module address.
     * @dev Reverts if:
     *      - never reverts (best-effort)
     *
     * Security:
     * - Read-only
     *
     * @return PositionView module address, or `address(0)` if missing
     */
    function _positionView() internal view returns (address) {
        return _getModule(ModuleKeys.KEY_POSITION_VIEW);
    }

    /**
     * @notice Resolve the `StatisticsView` module address.
     * @dev Reverts if:
     *      - never reverts (best-effort)
     *
     * Security:
     * - Read-only
     *
     * @return StatisticsView module address, or `address(0)` if missing
     */
    function _statisticsView() internal view returns (address) {
        return _getModule(ModuleKeys.KEY_STATS);
    }

    /**
     * @notice Resolve the settlement token address from the Registry.
     * @dev Reverts if:
     *      - never reverts (best-effort)
     *
     * Security:
     * - Read-only
     *
     * @return Settlement token address, or `address(0)` if missing
     */
    function _settlementToken() internal view returns (address) {
        return _getModule(ModuleKeys.KEY_SETTLEMENT_TOKEN);
    }

    /*━━━━━━━━━━━━━━━ Position reads (delegates to PositionView) ━━━━━━━━━━━━━━━*/

    /**
     * @notice Get a user's collateral and debt for a given asset (best-effort).
     * @dev Reverts if:
     *      - registry is not set or invalid (`ZeroAddress` / `NotAContract`)
     *
     * Security:
     * - Read-only (`staticcall`)
     *
     * @param user User address
     * @param asset Asset address
     * @return collateral Collateral amount (token decimals depend on `asset`)
     * @return debt Debt amount (token decimals depend on `asset`)
     */
    function getUserPosition(address user, address asset)
        external
        view
        onlyValidRegistry
        returns (uint256 collateral, uint256 debt)
    {
        address pv = _positionView();
        if (pv == address(0)) return (0, 0);
        (bool ok, bytes memory data) =
            pv.staticcall(abi.encodeWithSelector(_SEL_GET_USER_POSITION, user, asset));
        if (!ok || data.length < 64) return (0, 0);
        return abi.decode(data, (uint256, uint256));
    }

    /**
     * @notice Get a user's collateral and debt for a given asset, with cache metadata.
     * @dev Reverts if:
     *      - registry is not set or invalid (`ZeroAddress` / `NotAContract`)
     *
     * Security:
     * - Read-only (`staticcall`)
     *
     * @param user User address
     * @param asset Asset address
     * @return collateral Collateral amount (token decimals depend on `asset`)
     * @return debt Debt amount (token decimals depend on `asset`)
     * @return isValid Whether the downstream cache is valid (best-effort on fallback path)
     * @return timestamp Cache timestamp (seconds since epoch; best-effort)
     * @return version Cache version (best-effort)
     */
    function getUserPositionWithMeta(address user, address asset)
        external
        view
        onlyValidRegistry
        returns (uint256 collateral, uint256 debt, bool isValid, uint256 timestamp, uint64 version)
    {
        address pv = _positionView();
        if (pv == address(0)) return (0, 0, false, 0, 0);

        // Prefer the newest interface when available.
        (bool ok, bytes memory data) =
            pv.staticcall(abi.encodeWithSelector(_SEL_GET_USER_POSITION_WITH_META, user, asset));
        if (ok && data.length >= 160) {
            return abi.decode(data, (uint256, uint256, bool, uint256, uint64));
        }

        // Backward compatibility: fall back to legacy calls and reconstruct meta (best-effort).
        (ok, data) = pv.staticcall(abi.encodeWithSelector(_SEL_GET_USER_POSITION_WITH_VALIDITY, user, asset));
        if (ok && data.length >= 96) {
            (collateral, debt, isValid) = abi.decode(data, (uint256, uint256, bool));
        }
        (ok, data) = pv.staticcall(abi.encodeWithSelector(_SEL_GET_POSITION_UPDATED_AT, user, asset));
        if (ok && data.length >= 32) timestamp = abi.decode(data, (uint256));
        (ok, data) = pv.staticcall(abi.encodeWithSelector(_SEL_GET_POSITION_VERSION, user, asset));
        if (ok && data.length >= 32) version = abi.decode(data, (uint64));
    }

    /**
     * @notice Service-friendly alias of `getUserPosition`.
     * @dev Reverts if:
     *      - registry is not set or invalid (`ZeroAddress` / `NotAContract`)
     *
     * Security:
     * - Read-only
     *
     * @param user User address
     * @param asset Asset address
     * @return collateral Collateral amount (token decimals depend on `asset`)
     * @return debt Debt amount (token decimals depend on `asset`)
     */
    function getUserPositionService(address user, address asset)
        external
        view
        onlyValidRegistry
        returns (uint256 collateral, uint256 debt)
    {
        return this.getUserPosition(user, asset);
    }

    /**
     * @notice Read a user's ERC20 balance for a given token.
     * @dev Reverts if:
     *      - registry is not set or invalid (`ZeroAddress` / `NotAContract`)
     *
     * Security:
     * - Read-only (`staticcall` to `token.balanceOf(user)`)
     *
     * @param user User address
     * @param token ERC20 token address
     * @return balance Token balance (token decimals depend on `token`)
     */
    function getUserTokenBalance(address user, address token)
        external
        view
        onlyValidRegistry
        returns (uint256 balance)
    {
        // Direct ERC20 `balanceOf` call; no module delegation required.
        (bool success, bytes memory data) = token.staticcall(
            abi.encodeWithSelector(_SEL_BALANCE_OF, user)
        );
        if (!success || data.length < 32) return 0;
        return abi.decode(data, (uint256));
    }

    /**
     * @notice Legacy placeholder for settlement token balance (deprecated).
     * @dev Reverts if:
     *      - always reverts (kept only for source compatibility)
     *
     * Security:
     * - Read-only
     *
     * @param user User address (unused)
     * @return balance Unused; this function always reverts
     */
    function getUserSettlementBalance(address user) external pure returns (uint256) {
        // Deprecated placeholder kept for source compatibility only.
        // Intentionally revert to avoid ambiguous "0" values in production integrations.
        user;
        revert UserView__ExternalCallFailed(ModuleKeys.KEY_SETTLEMENT_TOKEN, bytes4(0));
    }


    /**
     * @notice Read a user's settlement token balance via the authoritative path.
     * @dev Reverts if:
     *      - registry is not set or invalid (`ZeroAddress` / `NotAContract`)
     *      - settlement token module is missing in Registry (`UserView__ModuleMissing`)
     *      - `balanceOf(address)` staticcall fails (`UserView__ExternalCallFailed`)
     *
     * Security:
     * - Read-only (`staticcall`)
     *
     * @param user User address
     * @return balance Settlement token balance (token decimals depend on the settlement token)
     */
    function getUserSettlementBalanceStrict(address user) external view onlyValidRegistry returns (uint256 balance) {
        address token = _settlementToken();
        if (token == address(0)) revert UserView__ModuleMissing(ModuleKeys.KEY_SETTLEMENT_TOKEN);
        (bool ok, bytes memory data) = token.staticcall(abi.encodeWithSelector(_SEL_BALANCE_OF, user));
        if (!ok || data.length < 32) {
            revert UserView__ExternalCallFailed(ModuleKeys.KEY_SETTLEMENT_TOKEN, _SEL_BALANCE_OF);
        }
        return abi.decode(data, (uint256));
    }

    /**
     * @notice Read the user's total collateral value (settlement-denominated).
     * @dev Reverts if:
     *      - registry is not set or invalid (`ZeroAddress` / `NotAContract`)
     *      - StatisticsView is missing (`UserView__ModuleMissing`) via `getUserTotalsWithMeta`
     *      - downstream call fails (`UserView__ExternalCallFailed`) via `getUserTotalsWithMeta`
     *
     * Security:
     * - Read-only
     *
     * @param user User address
     * @return totalValue Total collateral value (denomination depends on system settlement unit)
     */
    function getUserTotalCollateral(address user) external view onlyValidRegistry returns (uint256 totalValue) {
        // Per ARCH 4.7: MUST NOT use asset=0 placeholder. Authority is StatisticsView user snapshot.
        (totalValue, , , , , ) = this.getUserTotalsWithMeta(user);
    }

    /**
     * @notice Read the user's total debt value (settlement-denominated).
     * @dev Reverts if:
     *      - registry is not set or invalid (`ZeroAddress` / `NotAContract`)
     *      - StatisticsView is missing (`UserView__ModuleMissing`) via `getUserTotalsWithMeta`
     *      - downstream call fails (`UserView__ExternalCallFailed`) via `getUserTotalsWithMeta`
     *
     * Security:
     * - Read-only
     *
     * @param user User address
     * @return totalValue Total debt value (denomination depends on system settlement unit)
     */
    function getUserTotalDebt(address user) external view onlyValidRegistry returns (uint256 totalValue) {
        (, totalValue, , , , ) = this.getUserTotalsWithMeta(user);
    }

    /**
     * @notice Read the user's total collateral and debt with cache metadata.
     * @dev Reverts if:
     *      - registry is not set or invalid (`ZeroAddress` / `NotAContract`)
     *      - StatisticsView module is missing in Registry (`UserView__ModuleMissing`)
     *      - downstream call fails (`UserView__ExternalCallFailed`)
     *
     * Security:
     * - Read-only (`staticcall`)
     *
     * @param user User address
     * @return totalCollateral Total collateral (settlement-denominated)
     * @return totalDebt Total debt (settlement-denominated)
     * @return isValid Whether the returned values are within cache freshness window
     * @return timestamp Snapshot timestamp (seconds since epoch)
     * @return version Snapshot schema/cache version (best-effort)
     * @return seq Snapshot sequence number (best-effort)
     */
    function getUserTotalsWithMeta(address user)
        external
        view
        onlyValidRegistry
        returns (
            uint256 totalCollateral,
            uint256 totalDebt,
            bool isValid,
            uint256 timestamp,
            uint64 version,
            uint64 seq
        )
    {
        address sv = _statisticsView();
        if (sv == address(0)) revert UserView__ModuleMissing(ModuleKeys.KEY_STATS);

        // Prefer v2: getUserSnapshotWithMeta(address) -> (UserSnapshot, version, seq, requestId, isValid, timestamp)
        (bool ok, bytes memory data) =
            sv.staticcall(abi.encodeWithSelector(_SEL_GET_USER_SNAPSHOT_WITH_META, user));
        if (ok && data.length > 0) {
            (StatsUserSnapshot memory s, uint64 v, uint64 sseq, bytes32 rid, bool vld, uint256 ts) =
                abi.decode(data, (StatsUserSnapshot, uint64, uint64, bytes32, bool, uint256));
            rid; // silence unused variable warning
            return (s.collateral, s.debt, vld, ts, v, sseq);
        }

        // Fallback: getUserSnapshot(address) -> (UserSnapshot). Compute validity locally.
        (ok, data) = sv.staticcall(abi.encodeWithSelector(_SEL_GET_USER_SNAPSHOT, user));
        if (!ok || data.length == 0) {
            revert UserView__ExternalCallFailed(ModuleKeys.KEY_STATS, _SEL_GET_USER_SNAPSHOT_WITH_META);
        }
        StatsUserSnapshot memory s2 = abi.decode(data, (StatsUserSnapshot));
        timestamp = s2.timestamp;
        // solhint-disable-next-line not-rely-on-time
        isValid = timestamp > 0 && block.timestamp - timestamp <= ViewConstants.CACHE_DURATION;
        return (s2.collateral, s2.debt, isValid, timestamp, 0, 0);
    }

    /**
     * @notice Convenience helper: read collateral amount only.
     * @dev Reverts if:
     *      - registry is not set or invalid (`ZeroAddress` / `NotAContract`)
     *
     * Security:
     * - Read-only
     *
     * @param user User address
     * @param asset Asset address
     * @return collateral Collateral amount (token decimals depend on `asset`)
     */
    function getUserCollateral(address user, address asset)
        external
        view
        onlyValidRegistry
        returns (uint256 collateral)
    {
        (collateral, ) = this.getUserPosition(user, asset);
    }

    /**
     * @notice Convenience helper: read debt amount only.
     * @dev Reverts if:
     *      - registry is not set or invalid (`ZeroAddress` / `NotAContract`)
     *
     * Security:
     * - Read-only
     *
     * @param user User address
     * @param asset Asset address
     * @return debt Debt amount (token decimals depend on `asset`)
     */
    function getUserDebt(address user, address asset) external view onlyValidRegistry returns (uint256 debt) {
        (, debt) = this.getUserPosition(user, asset);
    }

    /*━━━━━━━━━━━━━━━ Health reads (delegates to HealthView) ━━━━━━━━━━━━━━━*/

    /**
     * @notice Read the user's current health factor (bps).
     * @dev Reverts if:
     *      - registry is not set or invalid (`ZeroAddress` / `NotAContract`)
     *
     * Security:
     * - Read-only (`staticcall`)
     *
     * @param user User address
     * @return hf Health factor (bps, 1e4 = 100%)
     */
    function getHealthFactor(address user) external view onlyValidRegistry returns (uint256 hf) {
        address hv = _healthView();
        if (hv == address(0)) return 0;
        (bool ok, bytes memory data) = hv.staticcall(abi.encodeWithSelector(_SEL_GET_USER_HEALTH_FACTOR, user));
        if (!ok || data.length < 96) return 0;
        (hf, , ) = abi.decode(data, (uint256, bool, uint256));
    }

    /**
     * @notice Read the user's health factor (bps) with cache metadata.
     * @dev Reverts if:
     *      - registry is not set or invalid (`ZeroAddress` / `NotAContract`)
     *
     * Security:
     * - Read-only (`staticcall`)
     *
     * @param user User address
     * @return hf Health factor (bps, 1e4 = 100%)
     * @return isValid Whether the downstream cache is valid (best-effort on fallback path)
     * @return timestamp Cache timestamp (seconds since epoch; best-effort)
     */
    function getHealthFactorWithMeta(address user)
        external
        view
        onlyValidRegistry
        returns (uint256 hf, bool isValid, uint256 timestamp)
    {
        address hv = _healthView();
        if (hv == address(0)) return (0, false, 0);

        // Prefer the newest interface when available.
        (bool ok, bytes memory data) =
            hv.staticcall(abi.encodeWithSelector(_SEL_GET_USER_HEALTH_FACTOR_WITH_META, user));
        if (ok && data.length >= 96) {
            return abi.decode(data, (uint256, bool, uint256));
        }

        // Backward compatibility: fall back to legacy call (best-effort).
        (ok, data) = hv.staticcall(abi.encodeWithSelector(_SEL_GET_USER_HEALTH_FACTOR, user));
        if (ok && data.length >= 96) {
            (hf, isValid, timestamp) = abi.decode(data, (uint256, bool, uint256));
        }
    }

    /**
     * @notice Alias of `getHealthFactor` for backward compatibility.
     * @dev Reverts if:
     *      - registry is not set or invalid (`ZeroAddress` / `NotAContract`)
     *
     * Security:
     * - Read-only
     *
     * @param user User address
     * @return hf Health factor (bps, 1e4 = 100%)
     */
    function getUserHealthFactor(address user) external view onlyValidRegistry returns (uint256 hf) {
        return this.getHealthFactor(user);
    }

    /**
     * @notice Aggregate user statistics for an asset (position + health + derived LTV).
     * @dev Reverts if:
     *      - registry is not set or invalid (`ZeroAddress` / `NotAContract`)
     *
     * Security:
     * - Read-only
     *
     * @param user User address
     * @param asset Asset address
     * @return stats Aggregated stats (LTV/HF in bps)
     */
    function getUserStats(address user, address asset)
        external
        view
        onlyValidRegistry
        returns (UserStats memory stats)
    {
        (uint256 collateral, uint256 debt) = this.getUserPosition(user, asset);
        uint256 hf = this.getHealthFactor(user);

        // Compute LTV (loan-to-value ratio).
        uint256 ltv = RiskUtils.calculateLTV(debt, collateral);

        stats = UserStats({
            collateral: collateral,
            debt: debt,
            ltv: ltv,
            hf: hf
        });
    }

    /**
     * @notice Aggregate user statistics for an asset, with downstream cache metadata.
     * @dev Reverts if:
     *      - registry is not set or invalid (`ZeroAddress` / `NotAContract`)
     *
     * Security:
     * - Read-only
     *
     * @param user User address
     * @param asset Asset address
     * @return stats Aggregated stats (LTV/HF in bps)
     * @return positionIsValid Whether the position cache is valid
     * @return positionTimestamp Position cache timestamp (seconds since epoch)
     * @return positionVersion Position cache version
     * @return healthIsValid Whether the health cache is valid
     * @return healthTimestamp Health cache timestamp (seconds since epoch)
     */
    function getUserStatsWithMeta(address user, address asset)
        external
        view
        onlyValidRegistry
        returns (
            UserStats memory stats,
            bool positionIsValid,
            uint256 positionTimestamp,
            uint64 positionVersion,
            bool healthIsValid,
            uint256 healthTimestamp
        )
    {
        (uint256 collateral, uint256 debt, bool pValid, uint256 pTs, uint64 pVer) =
            this.getUserPositionWithMeta(user, asset);
        (uint256 hf, bool hValid, uint256 hTs) = this.getHealthFactorWithMeta(user);

        uint256 ltv = RiskUtils.calculateLTV(debt, collateral);
        stats = UserStats({ collateral: collateral, debt: debt, ltv: ltv, hf: hf });

        positionIsValid = pValid;
        positionTimestamp = pTs;
        positionVersion = pVer;
        healthIsValid = hValid;
        healthTimestamp = hTs;
    }

    /*━━━━━━━━━━━━━━━ Previews (delegates to PreviewView) ━━━━━━━━━━━━━━━*/

    /**
     * @notice Preview borrow effects on health factor, LTV and max borrowable.
     * @dev Reverts if:
     *      - registry is not set or invalid (`ZeroAddress` / `NotAContract`)
     *
     * Security:
     * - Read-only (`staticcall`)
     *
     * @param user User address
     * @param asset Asset address
     * @param collateralIn Current collateral amount (token decimals depend on `asset`)
     * @param collateralAdded Added collateral amount (token decimals depend on `asset`)
     * @param borrowAmount Borrow amount (token decimals depend on system debt token for `asset`)
     * @return newHF New health factor (bps)
     * @return newLTV New LTV (bps)
     * @return maxBorrowable Max borrowable amount (token decimals depend on system)
     */
    function previewBorrow(
        address user,
        address asset,
        uint256 collateralIn,
        uint256 collateralAdded,
        uint256 borrowAmount
    ) external view onlyValidRegistry returns (uint256 newHF, uint256 newLTV, uint256 maxBorrowable) {
        address previewViewAddr = _getModule(ModuleKeys.KEY_PREVIEW_VIEW);
        if (previewViewAddr == address(0)) return (0, 0, 0);
        (bool success, bytes memory data) = previewViewAddr.staticcall(
            abi.encodeWithSelector(
                _SEL_PREVIEW_BORROW,
                user,
                asset,
                collateralIn,
                collateralAdded,
                borrowAmount
            )
        );
        if (!success || data.length < 96) return (0, 0, 0);
        return abi.decode(data, (uint256, uint256, uint256));
    }

    /**
     * @notice Preview health factor after depositing additional collateral.
     * @dev Reverts if:
     *      - registry is not set or invalid (`ZeroAddress` / `NotAContract`)
     *
     * Security:
     * - Read-only (`staticcall`)
     *
     * @param user User address
     * @param asset Asset address
     * @param amount Collateral amount (token decimals depend on `asset`)
     * @return hfAfter Health factor after deposit (bps)
     * @return ok Whether the post-action state is considered safe by PreviewView
     */
    function previewDeposit(address user, address asset, uint256 amount)
        external
        view
        onlyValidRegistry
        returns (uint256 hfAfter, bool ok)
    {
        address previewViewAddr = _getModule(ModuleKeys.KEY_PREVIEW_VIEW);
        if (previewViewAddr == address(0)) return (0, false);
        (bool success, bytes memory data) = previewViewAddr.staticcall(
            abi.encodeWithSelector(_SEL_PREVIEW_DEPOSIT, user, asset, amount)
        );
        if (!success || data.length < 64) return (0, false);
        return abi.decode(data, (uint256, bool));
    }

    /**
     * @notice Preview health factor and LTV after a repayment.
     * @dev Reverts if:
     *      - registry is not set or invalid (`ZeroAddress` / `NotAContract`)
     *
     * Security:
     * - Read-only (`staticcall`)
     *
     * @param user User address
     * @param asset Asset address
     * @param amount Repay amount (token decimals depend on system debt token for `asset`)
     * @return newHF Health factor after repayment (bps)
     * @return newLTV LTV after repayment (bps)
     */
    function previewRepay(address user, address asset, uint256 amount)
        external
        view
        onlyValidRegistry
        returns (uint256 newHF, uint256 newLTV)
    {
        address previewViewAddr = _getModule(ModuleKeys.KEY_PREVIEW_VIEW);
        if (previewViewAddr == address(0)) return (0, 0);
        (bool success, bytes memory data) = previewViewAddr.staticcall(
            abi.encodeWithSelector(_SEL_PREVIEW_REPAY, user, asset, amount)
        );
        if (!success || data.length < 64) return (0, 0);
        return abi.decode(data, (uint256, uint256));
    }

    /**
     * @notice Preview health factor after withdrawing collateral.
     * @dev Reverts if:
     *      - registry is not set or invalid (`ZeroAddress` / `NotAContract`)
     *
     * Security:
     * - Read-only (`staticcall`)
     *
     * @param user User address
     * @param asset Asset address
     * @param amount Withdraw amount (token decimals depend on `asset`)
     * @return newHF Health factor after withdrawal (bps)
     * @return ok Whether the post-action state is considered safe by PreviewView
     */
    function previewWithdraw(address user, address asset, uint256 amount)
        external
        view
        onlyValidRegistry
        returns (uint256 newHF, bool ok)
    {
        address previewViewAddr = _getModule(ModuleKeys.KEY_PREVIEW_VIEW);
        if (previewViewAddr == address(0)) return (0, false);
        (bool success, bytes memory data) = previewViewAddr.staticcall(
            abi.encodeWithSelector(_SEL_PREVIEW_WITHDRAW, user, asset, amount)
        );
        if (!success || data.length < 64) return (0, false);
        return abi.decode(data, (uint256, bool));
    }

    /*━━━━━━━━━━━━━━━ Batch reads ━━━━━━━━━━━━━━━*/

    /**
     * @notice Batch read user positions (best-effort).
     * @dev Reverts if:
     *      - registry is not set or invalid (`ZeroAddress` / `NotAContract`)
     *      - `users.length != assets.length` (`UserView__LengthMismatch`)
     *      - `users.length > ViewConstants.MAX_BATCH_SIZE` (`UserView__BatchTooLarge`)
     *
     * Security:
     * - Read-only (`staticcall`)
     *
     * @param users User addresses
     * @param assets Asset addresses (must match `users` length)
     * @return collaterals Collateral amounts (token decimals depend on each asset)
     * @return debts Debt amounts (token decimals depend on each asset)
     */
    function batchGetUserPositions(
        address[] calldata users,
        address[] calldata assets
    ) external view onlyValidRegistry returns (uint256[] memory collaterals, uint256[] memory debts) {
        uint256 len = users.length;
        if (len != assets.length) revert UserView__LengthMismatch();
        if (len > _MAX_BATCH_SIZE) revert UserView__BatchTooLarge(len);
        address pv = _positionView();
        if (pv == address(0)) {
            collaterals = new uint256[](len);
            debts = new uint256[](len);
            return (collaterals, debts);
        }
        (bool ok, bytes memory data) =
            pv.staticcall(abi.encodeWithSelector(_SEL_BATCH_GET_USER_POSITIONS, users, assets));
        if (!ok || data.length < 64) {
            collaterals = new uint256[](len);
            debts = new uint256[](len);
            return (collaterals, debts);
        }
        return abi.decode(data, (uint256[], uint256[]));
    }
    
    /**
     * @notice Batch read user health factors (bps) (best-effort).
     * @dev Reverts if:
     *      - registry is not set or invalid (`ZeroAddress` / `NotAContract`)
     *      - `users.length > ViewConstants.MAX_BATCH_SIZE` (`UserView__BatchTooLarge`)
     *
     * Security:
     * - Read-only (`staticcall`)
     *
     * @param users User addresses
     * @return healthFactors Health factors (bps)
     */
    function batchGetUserHealthFactors(
        address[] calldata users
    ) external view onlyValidRegistry returns (uint256[] memory healthFactors) {
        uint256 len = users.length;
        if (len > _MAX_BATCH_SIZE) revert UserView__BatchTooLarge(len);
        address hv = _healthView();
        if (hv == address(0)) {
            return new uint256[](len);
        }
        (bool ok, bytes memory data) =
            hv.staticcall(abi.encodeWithSelector(_SEL_BATCH_GET_HEALTH_FACTORS, users));
        if (!ok || data.length < 96) {
            return new uint256[](len);
        }
        (healthFactors, , ) = abi.decode(data, (uint256[], bool[], uint256[]));
        return healthFactors;
    }

    /**
     * @notice Batch read user health factors (bps) with cache metadata.
     * @dev Reverts if:
     *      - registry is not set or invalid (`ZeroAddress` / `NotAContract`)
     *      - `users.length > ViewConstants.MAX_BATCH_SIZE` (`UserView__BatchTooLarge`)
     *
     * Security:
     * - Read-only (`staticcall`)
     *
     * @param users User addresses
     * @return healthFactors Health factors (bps)
     * @return validFlags Cache validity flags (best-effort on fallback path)
     * @return timestamps Cache timestamps (seconds since epoch; best-effort)
     */
    function batchGetUserHealthFactorsWithMeta(address[] calldata users)
        external
        view
        onlyValidRegistry
        returns (uint256[] memory healthFactors, bool[] memory validFlags, uint256[] memory timestamps)
    {
        uint256 len = users.length;
        if (len > _MAX_BATCH_SIZE) revert UserView__BatchTooLarge(len);
        address hv = _healthView();
        if (hv == address(0)) {
            healthFactors = new uint256[](len);
            validFlags = new bool[](len);
            timestamps = new uint256[](len);
            return (healthFactors, validFlags, timestamps);
        }

        // Prefer the newest interface when available.
        (bool ok, bytes memory data) =
            hv.staticcall(abi.encodeWithSelector(_SEL_BATCH_GET_HEALTH_FACTORS_WITH_META, users));
        if (ok && data.length >= 96) {
            return abi.decode(data, (uint256[], bool[], uint256[]));
        }

        // Backward compatibility: fall back to legacy call (best-effort).
        (ok, data) = hv.staticcall(abi.encodeWithSelector(_SEL_BATCH_GET_HEALTH_FACTORS, users));
        if (!ok || data.length < 96) {
            healthFactors = new uint256[](len);
            validFlags = new bool[](len);
            timestamps = new uint256[](len);
            return (healthFactors, validFlags, timestamps);
        }
        (healthFactors, validFlags, timestamps) = abi.decode(data, (uint256[], bool[], uint256[]));
    }

    /*━━━━━━━━━━━━━━━ Upgrades ━━━━━━━━━━━━━━━*/

    /**
     * @notice Authorize UUPS upgrades.
     * @dev Reverts if:
     *      - registry is not set or invalid (`ZeroAddress` / `NotAContract`)
     *      - caller is missing `ActionKeys.ACTION_ADMIN` (`ViewAccessLib.requireRole`)
     *      - `newImplementation` is the zero address (`ZeroAddress`)
     *      - `newImplementation` is not a contract (`NotAContract`)
     *
     * Security:
     * - Role-gated upgrade authorization
     *
     * @param newImplementation New implementation address
     */
    function _authorizeUpgrade(address newImplementation) internal view override onlyValidRegistry {
        ViewAccessLib.requireRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender);
        if (newImplementation == address(0)) revert ZeroAddress();
        if (newImplementation.code.length == 0) revert NotAContract(newImplementation);
    }

    /*━━━━━━━━━━━━━━━ Compatibility getters ━━━━━━━━━━━━━━━*/

    /**
     * @notice Read the Registry address (backward compatibility).
     * @dev Reverts if:
     *      - never reverts
     *
     * Security:
     * - Read-only
     *
     * @return Registry address
     */
    function getRegistry() external view returns (address) {
        return _registryAddr;
    }

    /**
     * @notice Legacy auto-getter compatible name for Registry address.
     * @dev Reverts if:
     *      - never reverts
     *
     * Security:
     * - Read-only
     *
     * @return Registry address
     */
    function registryAddr() external view returns (address) {
        return _registryAddr;
    }

    /*━━━━━━━━━━━━━━━ Versioning ━━━━━━━━━━━━━━━*/

    /**
     * @notice API version for offchain integrations.
     * @dev Reverts if:
     *      - never reverts
     *
     * Security:
     * - Read-only
     *
     * @return API version
     */
    function apiVersion() public pure override returns (uint256) {
        return 1;
    }

    /**
     * @notice Schema version for returned payloads.
     * @dev Reverts if:
     *      - never reverts
     *
     * Security:
     * - Read-only
     *
     * @return Schema version
     */
    function schemaVersion() public pure override returns (uint256) {
        return 1;
    }

    /// @dev UUPS storage gap to avoid layout collisions.
    uint256[50] private __gap;
}