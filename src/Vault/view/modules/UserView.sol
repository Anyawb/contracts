// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ActionKeys } from "../../../constants/ActionKeys.sol";
import { ModuleKeys } from "../../../constants/ModuleKeys.sol";
import { Registry } from "../../../registry/Registry.sol";
import {
    ArrayLengthMismatch,
    BatchTooLarge,
    EmptyArray,
    MissingRole,
    NotAContract,
    ZeroAddress
} from "../../../errors/StandardErrors.sol";
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
 * - UUPS upgrade is role-gated (MissingRole on failure)
 *
 * @custom:security-contact security@example.com
 */
contract UserView is Initializable, UUPSUpgradeable, ViewVersioned {
    /*━━━━━━━━━━━━━━━ Errors ━━━━━━━━━━━━━━━*/

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
        uint256 easyTokenBalance;
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
        uint256 blockNumber;
        bool isActive;
    }

    /*━━━━━━━━━━━━━━━ Constants ━━━━━━━━━━━━━━━*/

    /// @dev Maximum number of items allowed in batch read calls.
    uint256 internal constant _MAX_BATCH_SIZE = ViewConstants.MAX_BATCH_SIZE;

    /// @dev Function selectors for downstream `staticcall` payload encoding (derived from SSOT module contracts).
    bytes4 internal constant _SEL_GET_USER_POSITION_WITH_META = PositionView.getUserPositionWithMeta.selector;
    bytes4 internal constant _SEL_BALANCE_OF = IERC20.balanceOf.selector;
    bytes4 internal constant _SEL_GET_USER_SNAPSHOT_WITH_META = StatisticsView.getUserSnapshotWithMeta.selector;
    bytes4 internal constant _SEL_GET_USER_HEALTH_FACTOR_WITH_META = HealthView.getUserHealthFactorWithMeta.selector;
    bytes4 internal constant _SEL_PREVIEW_BORROW = PreviewView.previewBorrow.selector;
    bytes4 internal constant _SEL_PREVIEW_DEPOSIT = PreviewView.previewDeposit.selector;
    bytes4 internal constant _SEL_PREVIEW_REPAY = PreviewView.previewRepay.selector;
    bytes4 internal constant _SEL_PREVIEW_WITHDRAW = PreviewView.previewWithdraw.selector;
    bytes4 internal constant _SEL_BATCH_GET_USER_POSITIONS = PositionView.batchGetUserPositionsWithMeta.selector;
    bytes4 internal constant _SEL_BATCH_GET_HEALTH_FACTORS_WITH_META =
        HealthView.batchGetHealthFactorsWithMeta.selector;

    /*━━━━━━━━━━━━━━━ Modifiers ━━━━━━━━━━━━━━━*/

    /// @dev Ensures `_registryAddr` is a deployed contract.
    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        if (_registryAddr.code.length == 0) revert NotAContract(_registryAddr);
        _;
    }

    /// @dev Scheme U: self read allowed; non-self requires VIEW_USER_DATA or ADMIN.
    modifier onlyUserDim(address user) {
        _checkUserAccess(user);
        _;
    }

    /// @dev Scheme U batch: no self-bypass for `users[]` enumeration; requires VIEW_USER_DATA or ADMIN.
    modifier onlyUserDimBatch() {
        _checkBatchAccess();
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
                block.number
            )
        );
    }

    /*━━━━━━━━━━━━━━━ Internal helpers ━━━━━━━━━━━━━━━*/

    /// @dev View-only block helper for meta outputs (not used for state changes).
    function _now() internal view returns (uint256) {
        return block.number;
    }

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

    function _checkUserAccess(address user) internal view {
        if (msg.sender == user) return;
        bool ok =
            ViewAccessLib.hasRole(_registryAddr, ActionKeys.ACTION_VIEW_USER_DATA, msg.sender)
                || ViewAccessLib.hasRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender);
        if (!ok) revert MissingRole();
    }

    function _checkBatchAccess() internal view {
        bool ok =
            ViewAccessLib.hasRole(_registryAddr, ActionKeys.ACTION_VIEW_USER_DATA, msg.sender)
                || ViewAccessLib.hasRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender);
        if (!ok) revert MissingRole();
    }

    function _getUserPositionInternal(address user, address asset)
        internal
        view
        returns (uint256 collateral, uint256 debt)
    {
        address pv = _positionView();
        if (pv == address(0)) return (0, 0);
        (bool ok, bytes memory data) =
            pv.staticcall(abi.encodeWithSelector(_SEL_GET_USER_POSITION_WITH_META, user, asset));
        if (!ok || data.length < 160) return (0, 0);
        (collateral, debt, , , ) = abi.decode(data, (uint256, uint256, bool, uint256, uint64));
        return (collateral, debt);
    }

    function _getUserPositionWithMetaInternal(address user, address asset)
        internal
        view
        returns (uint256 collateral, uint256 debt, bool isValid, uint256 blockNumber, uint64 version)
    {
        address pv = _positionView();
        if (pv == address(0)) return (0, 0, false, 0, 0);

        // Prefer the newest interface when available.
        (bool ok, bytes memory data) = pv.staticcall(
            abi.encodeWithSelector(_SEL_GET_USER_POSITION_WITH_META, user, asset)
        );
        if (ok && data.length >= 160) {
            return abi.decode(data, (uint256, uint256, bool, uint256, uint64));
        }
    }

    function _getHealthFactorInternal(address user) internal view returns (uint256 hf) {
        address hv = _healthView();
        if (hv == address(0)) return 0;
        (bool ok, bytes memory data) =
            hv.staticcall(abi.encodeWithSelector(_SEL_GET_USER_HEALTH_FACTOR_WITH_META, user));
        if (!ok || data.length < 96) return 0;
        (hf, , ) = abi.decode(data, (uint256, bool, uint256));
    }

    function _getHealthFactorWithMetaInternal(address user)
        internal
        view
        returns (uint256 hf, bool isValid, uint256 blockNumber)
    {
        address hv = _healthView();
        if (hv == address(0)) return (0, false, 0);

        (bool ok, bytes memory data) = hv.staticcall(
            abi.encodeWithSelector(_SEL_GET_USER_HEALTH_FACTOR_WITH_META, user)
        );
        if (ok && data.length >= 96) {
            return abi.decode(data, (uint256, bool, uint256));
        }
    }

    /*━━━━━━━━━━━━━━━ Position reads (delegates to PositionView) ━━━━━━━━━━━━━━━*/

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
     * @return blockNumber Cache blockNumber (block.number; best-effort)
     * @return version Cache version (best-effort)
     */
    function getUserPosition(address user, address asset)
        external
        view
        onlyValidRegistry
        onlyUserDim(user)
        returns (uint256 collateral, uint256 debt, bool isValid, uint256 blockNumber, uint64 version)
    {
        return _getUserPositionWithMetaInternal(user, asset);
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
     * @return blockNumber Cache blockNumber (block.number; best-effort)
     * @return version Cache version (best-effort)
     */
    function getUserPositionWithMeta(address user, address asset)
        external
        view
        onlyValidRegistry
        onlyUserDim(user)
        returns (uint256 collateral, uint256 debt, bool isValid, uint256 blockNumber, uint64 version)
    {
        return _getUserPositionWithMetaInternal(user, asset);
    }

    /**
     * @notice Service-friendly alias of `getUserPosition`, with cache metadata.
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
     * @return isValid Whether the downstream cache is valid (best-effort on fallback path)
     * @return blockNumber Cache blockNumber (block.number; best-effort)
     * @return version Cache version (best-effort)
     */
    function getUserPositionService(address user, address asset)
        external
        view
        onlyValidRegistry
        onlyUserDim(user)
        returns (uint256 collateral, uint256 debt, bool isValid, uint256 blockNumber, uint64 version)
    {
        return _getUserPositionWithMetaInternal(user, asset);
    }

    /**
     * @notice Read a user's ERC20 balance for a given token, with metadata.
     * @dev Reverts if:
     *      - registry is not set or invalid (`ZeroAddress` / `NotAContract`)
     *
     * Security:
     * - Read-only (`staticcall` to `token.balanceOf(user)`)
     *
     * @param user User address
     * @param token ERC20 token address
     * @return balance Token balance (token decimals depend on `token`)
     * @return isValid Whether the balance was successfully read
     * @return blockNumber Read blockNumber (block.number)
     */
    function getUserTokenBalance(address user, address token)
        external
        view
        onlyValidRegistry
        onlyUserDim(user)
        returns (uint256 balance, bool isValid, uint256 blockNumber)
    {
        // Direct ERC20 `balanceOf` call; no module delegation required.
        (bool success, bytes memory data) = token.staticcall(
            abi.encodeWithSelector(_SEL_BALANCE_OF, user)
        );
        if (!success || data.length < 32) return (0, false, 0);
        balance = abi.decode(data, (uint256));
        return (balance, true, _now());
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
     * @notice Read a user's settlement token balance via the authoritative path, with metadata.
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
     * @return isValid Whether the balance was successfully read
     * @return blockNumber Read blockNumber (block.number)
     */
    function getUserSettlementBalanceStrict(address user)
        external
        view
        onlyValidRegistry
        returns (uint256 balance, bool isValid, uint256 blockNumber)
    {
        _checkUserAccess(user);
        address token = _settlementToken();
        if (token == address(0)) revert UserView__ModuleMissing(ModuleKeys.KEY_SETTLEMENT_TOKEN);
        (bool ok, bytes memory data) = token.staticcall(abi.encodeWithSelector(_SEL_BALANCE_OF, user));
        if (!ok || data.length < 32) {
            revert UserView__ExternalCallFailed(ModuleKeys.KEY_SETTLEMENT_TOKEN, _SEL_BALANCE_OF);
        }
        balance = abi.decode(data, (uint256));
        return (balance, true, _now());
    }

    /**
     * @notice Read the user's total collateral value (settlement-denominated), with cache metadata.
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
     * @return isValid Whether the downstream cache is valid
     * @return blockNumber Cache blockNumber (block.number)
     * @return version Snapshot version (best-effort)
     * @return seq Snapshot sequence (best-effort)
     */
    function getUserTotalCollateral(address user)
        external
        view
        onlyValidRegistry
        returns (uint256 totalValue, bool isValid, uint256 blockNumber, uint64 version, uint64 seq)
    {
        _checkUserAccess(user);
        // Per ARCH 4.7: MUST NOT use asset=0 placeholder. Authority is StatisticsView user snapshot.
        (totalValue, , isValid, blockNumber, version, seq) = _getUserTotalsWithMetaInternal(user);
    }

    /**
     * @notice Read the user's total debt value (settlement-denominated), with cache metadata.
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
     * @return isValid Whether the downstream cache is valid
     * @return blockNumber Cache blockNumber (block.number)
     * @return version Snapshot version (best-effort)
     * @return seq Snapshot sequence (best-effort)
     */
    function getUserTotalDebt(address user)
        external
        view
        onlyValidRegistry
        returns (uint256 totalValue, bool isValid, uint256 blockNumber, uint64 version, uint64 seq)
    {
        _checkUserAccess(user);
        (, totalValue, isValid, blockNumber, version, seq) = _getUserTotalsWithMetaInternal(user);
    }

    function _getUserTotalsWithMetaInternal(address user)
        internal
        view
        returns (
            uint256 totalCollateral,
            uint256 totalDebt,
            bool isValid,
            uint256 blockNumber,
            uint64 version,
            uint64 seq
        )
    {
        address sv = _statisticsView();
        if (sv == address(0)) revert UserView__ModuleMissing(ModuleKeys.KEY_STATS);

        // Prefer the meta snapshot interface:
        // getUserSnapshotWithMeta(address) -> (UserSnapshot, version, seq, requestId, isValid, blockNumber)
        (bool ok, bytes memory data) = sv.staticcall(abi.encodeWithSelector(_SEL_GET_USER_SNAPSHOT_WITH_META, user));
        if (ok && data.length > 0) {
            (StatsUserSnapshot memory s, uint64 v, uint64 sseq, bytes32 rid, bool vld, uint256 snapshotBlockNumber) =
                abi.decode(data, (StatsUserSnapshot, uint64, uint64, bytes32, bool, uint256));
            rid; // silence unused variable warning
            return (s.collateral, s.debt, vld, snapshotBlockNumber, v, sseq);
        }
        revert UserView__ExternalCallFailed(ModuleKeys.KEY_STATS, _SEL_GET_USER_SNAPSHOT_WITH_META);
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
     * @return blockNumber Snapshot blockNumber (block.number)
     * @return version Snapshot schema/cache version (best-effort)
     * @return seq Snapshot sequence number (best-effort)
     */
    function getUserTotalsWithMeta(address user)
        external
        view
        onlyValidRegistry
        onlyUserDim(user)
        returns (
            uint256 totalCollateral,
            uint256 totalDebt,
            bool isValid,
            uint256 blockNumber,
            uint64 version,
            uint64 seq
        )
    {
        return _getUserTotalsWithMetaInternal(user);
    }

    /**
     * @notice Convenience helper: read collateral amount only, with cache metadata.
     * @dev Reverts if:
     *      - registry is not set or invalid (`ZeroAddress` / `NotAContract`)
     *
     * Security:
     * - Read-only
     *
     * @param user User address
     * @param asset Asset address
     * @return collateral Collateral amount (token decimals depend on `asset`)
     * @return isValid Whether the downstream cache is valid (best-effort on fallback path)
     * @return blockNumber Cache blockNumber (block.number; best-effort)
     * @return version Cache version (best-effort)
     */
    function getUserCollateral(address user, address asset)
        external
        view
        onlyValidRegistry
        onlyUserDim(user)
        returns (uint256 collateral, bool isValid, uint256 blockNumber, uint64 version)
    {
        (collateral, , isValid, blockNumber, version) = _getUserPositionWithMetaInternal(user, asset);
    }

    /**
     * @notice Convenience helper: read debt amount only, with cache metadata.
     * @dev Reverts if:
     *      - registry is not set or invalid (`ZeroAddress` / `NotAContract`)
     *
     * Security:
     * - Read-only
     *
     * @param user User address
     * @param asset Asset address
     * @return debt Debt amount (token decimals depend on `asset`)
     * @return isValid Whether the downstream cache is valid (best-effort on fallback path)
     * @return blockNumber Cache blockNumber (block.number; best-effort)
     * @return version Cache version (best-effort)
     */
    function getUserDebt(address user, address asset)
        external
        view
        onlyValidRegistry
        returns (uint256 debt, bool isValid, uint256 blockNumber, uint64 version)
    {
        _checkUserAccess(user);
        (, debt, isValid, blockNumber, version) = _getUserPositionWithMetaInternal(user, asset);
    }

    /*━━━━━━━━━━━━━━━ Health reads (delegates to HealthView) ━━━━━━━━━━━━━━━*/

    /**
     * @notice Read the user's current health factor (bps), with cache metadata.
     * @dev Reverts if:
     *      - registry is not set or invalid (`ZeroAddress` / `NotAContract`)
     *
     * Security:
     * - Read-only (`staticcall`)
     *
     * @param user User address
     * @return hf Health factor (bps, 1e4 = 100%)
     * @return isValid Whether the downstream cache is valid (best-effort on fallback path)
     * @return blockNumber Cache blockNumber (block.number; best-effort)
     */
    function getHealthFactor(address user)
        external
        view
        onlyValidRegistry
        onlyUserDim(user)
        returns (uint256 hf, bool isValid, uint256 blockNumber)
    {
        return _getHealthFactorWithMetaInternal(user);
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
     * @return blockNumber Cache blockNumber (block.number; best-effort)
     */
    function getHealthFactorWithMeta(address user)
        external
        view
        onlyValidRegistry
        onlyUserDim(user)
        returns (uint256 hf, bool isValid, uint256 blockNumber)
    {
        return _getHealthFactorWithMetaInternal(user);
    }

    /**
     * @notice Alias of `getHealthFactor` for backward compatibility, with cache metadata.
     * @dev Reverts if:
     *      - registry is not set or invalid (`ZeroAddress` / `NotAContract`)
     *
     * Security:
     * - Read-only
     *
     * @param user User address
     * @return hf Health factor (bps, 1e4 = 100%)
     * @return isValid Whether the downstream cache is valid (best-effort on fallback path)
     * @return blockNumber Cache blockNumber (block.number; best-effort)
     */
    function getUserHealthFactor(address user)
        external
        view
        onlyValidRegistry
        onlyUserDim(user)
        returns (uint256 hf, bool isValid, uint256 blockNumber)
    {
        return _getHealthFactorWithMetaInternal(user);
    }

    /**
     * @notice Aggregate user statistics for an asset (position + health + derived LTV), with cache metadata.
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
     * @return positionUpdateBlock Position cache update block (block.number)
     * @return positionVersion Position cache version
     * @return healthIsValid Whether the health cache is valid
     * @return healthUpdateBlock Health cache update block (block.number)
     */
    function getUserStats(address user, address asset)
        external
        view
        onlyValidRegistry
        onlyUserDim(user)
        returns (
            UserStats memory stats,
            bool positionIsValid,
            uint256 positionUpdateBlock,
            uint64 positionVersion,
            bool healthIsValid,
            uint256 healthUpdateBlock
        )
    {
        (uint256 collateral, uint256 debt, bool pValid, uint256 pTs, uint64 pVer) =
            _getUserPositionWithMetaInternal(user, asset);
        (uint256 hf, bool hValid, uint256 hTs) = _getHealthFactorWithMetaInternal(user);

        uint256 ltv = RiskUtils.calculateLTV(debt, collateral);
        stats = UserStats({ collateral: collateral, debt: debt, ltv: ltv, hf: hf });

        positionIsValid = pValid;
        positionUpdateBlock = pTs;
        positionVersion = pVer;
        healthIsValid = hValid;
        healthUpdateBlock = hTs;
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
     * @return positionUpdateBlock Position cache update block (block.number)
     * @return positionVersion Position cache version
     * @return healthIsValid Whether the health cache is valid
     * @return healthUpdateBlock Health cache update block (block.number)
     */
    function getUserStatsWithMeta(address user, address asset)
        external
        view
        onlyValidRegistry
        onlyUserDim(user)
        returns (
            UserStats memory stats,
            bool positionIsValid,
            uint256 positionUpdateBlock,
            uint64 positionVersion,
            bool healthIsValid,
            uint256 healthUpdateBlock
        )
    {
        (uint256 collateral, uint256 debt, bool pValid, uint256 pTs, uint64 pVer) =
            _getUserPositionWithMetaInternal(user, asset);
        (uint256 hf, bool hValid, uint256 hTs) = _getHealthFactorWithMetaInternal(user);

        uint256 ltv = RiskUtils.calculateLTV(debt, collateral);
        stats = UserStats({ collateral: collateral, debt: debt, ltv: ltv, hf: hf });

        positionIsValid = pValid;
        positionUpdateBlock = pTs;
        positionVersion = pVer;
        healthIsValid = hValid;
        healthUpdateBlock = hTs;
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
     * @return positionIsValid Whether the PositionView cache is valid
     * @return positionUpdateBlock PositionView cache update block (block.number)
     * @return positionVersion PositionView cache version
     */
    function previewBorrow(
        address user,
        address asset,
        uint256 collateralIn,
        uint256 collateralAdded,
        uint256 borrowAmount
    )
        external
        view
        onlyValidRegistry
        onlyUserDim(user)
        returns (
            uint256 newHF,
            uint256 newLTV,
            uint256 maxBorrowable,
            bool positionIsValid,
            uint256 positionUpdateBlock,
            uint64 positionVersion
        )
    {
        address previewViewAddr = _getModule(ModuleKeys.KEY_PREVIEW_VIEW);
        if (previewViewAddr == address(0)) return (0, 0, 0, false, 0, 0);
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
        if (!success || data.length < 192) return (0, 0, 0, false, 0, 0);
        return abi.decode(data, (uint256, uint256, uint256, bool, uint256, uint64));
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
     * @return positionIsValid Whether the PositionView cache is valid
     * @return positionUpdateBlock PositionView cache update block (block.number)
     * @return positionVersion PositionView cache version
     */
    function previewDeposit(address user, address asset, uint256 amount)
        external
        view
        onlyValidRegistry
        onlyUserDim(user)
        returns (uint256 hfAfter, bool ok, bool positionIsValid, uint256 positionUpdateBlock, uint64 positionVersion)
    {
        address previewViewAddr = _getModule(ModuleKeys.KEY_PREVIEW_VIEW);
        if (previewViewAddr == address(0)) return (0, false, false, 0, 0);
        (bool success, bytes memory data) = previewViewAddr.staticcall(
            abi.encodeWithSelector(_SEL_PREVIEW_DEPOSIT, user, asset, amount)
        );
        if (!success || data.length < 160) return (0, false, false, 0, 0);
        return abi.decode(data, (uint256, bool, bool, uint256, uint64));
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
     * @return positionIsValid Whether the PositionView cache is valid
     * @return positionUpdateBlock PositionView cache update block (block.number)
     * @return positionVersion PositionView cache version
     */
    function previewRepay(address user, address asset, uint256 amount)
        external
        view
        onlyValidRegistry
        onlyUserDim(user)
        returns (uint256 newHF, uint256 newLTV, bool positionIsValid, uint256 positionUpdateBlock, uint64 positionVersion)
    {
        address previewViewAddr = _getModule(ModuleKeys.KEY_PREVIEW_VIEW);
        if (previewViewAddr == address(0)) return (0, 0, false, 0, 0);
        (bool success, bytes memory data) = previewViewAddr.staticcall(
            abi.encodeWithSelector(_SEL_PREVIEW_REPAY, user, asset, amount)
        );
        if (!success || data.length < 160) return (0, 0, false, 0, 0);
        return abi.decode(data, (uint256, uint256, bool, uint256, uint64));
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
     * @return positionIsValid Whether the PositionView cache is valid
     * @return positionUpdateBlock PositionView cache update block (block.number)
     * @return positionVersion PositionView cache version
     */
    function previewWithdraw(address user, address asset, uint256 amount)
        external
        view
        onlyValidRegistry
        onlyUserDim(user)
        returns (uint256 newHF, bool ok, bool positionIsValid, uint256 positionUpdateBlock, uint64 positionVersion)
    {
        address previewViewAddr = _getModule(ModuleKeys.KEY_PREVIEW_VIEW);
        if (previewViewAddr == address(0)) return (0, false, false, 0, 0);
        (bool success, bytes memory data) = previewViewAddr.staticcall(
            abi.encodeWithSelector(_SEL_PREVIEW_WITHDRAW, user, asset, amount)
        );
        if (!success || data.length < 160) return (0, false, false, 0, 0);
        return abi.decode(data, (uint256, bool, bool, uint256, uint64));
    }

    /*━━━━━━━━━━━━━━━ Batch reads ━━━━━━━━━━━━━━━*/

    /**
     * @notice Batch read user positions (best-effort).
     * @dev Reverts if:
     *      - registry is not set or invalid (`ZeroAddress` / `NotAContract`)
     *      - `users.length != assets.length` (`ArrayLengthMismatch`)
     *      - `users.length > ViewConstants.MAX_BATCH_SIZE` (`BatchTooLarge`)
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
    ) external view onlyValidRegistry onlyUserDimBatch returns (uint256[] memory collaterals, uint256[] memory debts) {
        uint256 len = users.length;
        if (len == 0) revert EmptyArray();
        if (len != assets.length) revert ArrayLengthMismatch(len, assets.length);
        if (len > _MAX_BATCH_SIZE) revert BatchTooLarge(len, _MAX_BATCH_SIZE);
        address pv = _positionView();
        if (pv == address(0)) {
            collaterals = new uint256[](len);
            debts = new uint256[](len);
            return (collaterals, debts);
        }
        (bool ok, bytes memory data) =
            pv.staticcall(abi.encodeWithSelector(_SEL_BATCH_GET_USER_POSITIONS, users, assets));
        if (!ok || data.length < 160) {
            collaterals = new uint256[](len);
            debts = new uint256[](len);
            return (collaterals, debts);
        }
        (collaterals, debts, , , ) = abi.decode(data, (uint256[], uint256[], bool[], uint256[], uint64[]));
        return (collaterals, debts);
    }
    
    /**
     * @notice Batch read user health factors (bps) (best-effort).
     * @dev Reverts if:
     *      - registry is not set or invalid (`ZeroAddress` / `NotAContract`)
     *      - `users.length > ViewConstants.MAX_BATCH_SIZE` (`BatchTooLarge`)
     *
     * Security:
     * - Read-only (`staticcall`)
     *
     * @param users User addresses
     * @return healthFactors Health factors (bps)
     */
    function batchGetUserHealthFactors(
        address[] calldata users
    ) external view onlyValidRegistry onlyUserDimBatch returns (uint256[] memory healthFactors) {
        uint256 len = users.length;
        if (len == 0) revert EmptyArray();
        if (len > _MAX_BATCH_SIZE) revert BatchTooLarge(len, _MAX_BATCH_SIZE);
        address hv = _healthView();
        if (hv == address(0)) {
            return new uint256[](len);
        }
        (bool ok, bytes memory data) =
            hv.staticcall(abi.encodeWithSelector(_SEL_BATCH_GET_HEALTH_FACTORS_WITH_META, users));
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
     *      - `users.length > ViewConstants.MAX_BATCH_SIZE` (`BatchTooLarge`)
     *
     * Security:
     * - Read-only (`staticcall`)
     *
     * @param users User addresses
     * @return healthFactors Health factors (bps)
     * @return validFlags Cache validity flags (best-effort on fallback path)
     * @return blockNumbers Cache blockNumbers (block.number; best-effort)
     */
    function batchGetUserHealthFactorsWithMeta(address[] calldata users)
        external
        view
        onlyValidRegistry
        onlyUserDimBatch
        returns (uint256[] memory healthFactors, bool[] memory validFlags, uint256[] memory blockNumbers)
    {
        uint256 len = users.length;
        if (len == 0) revert EmptyArray();
        if (len > _MAX_BATCH_SIZE) revert BatchTooLarge(len, _MAX_BATCH_SIZE);
        address hv = _healthView();
        if (hv == address(0)) {
            healthFactors = new uint256[](len);
            validFlags = new bool[](len);
            blockNumbers = new uint256[](len);
            return (healthFactors, validFlags, blockNumbers);
        }

        (bool ok, bytes memory data) =
            hv.staticcall(abi.encodeWithSelector(_SEL_BATCH_GET_HEALTH_FACTORS_WITH_META, users));
        if (ok && data.length >= 96) {
            return abi.decode(data, (uint256[], bool[], uint256[]));
        }
        healthFactors = new uint256[](len);
        validFlags = new bool[](len);
        blockNumbers = new uint256[](len);
        return (healthFactors, validFlags, blockNumbers);
    }

    /*━━━━━━━━━━━━━━━ Upgrades ━━━━━━━━━━━━━━━*/

    /**
     * @notice Authorize UUPS upgrades.
     * @dev Reverts if:
     *      - registry is not set or invalid (`ZeroAddress` / `NotAContract`)
     *      - caller is missing `ActionKeys.ACTION_ADMIN` (`MissingRole`)
     *      - `newImplementation` is the zero address (`ZeroAddress`)
     *      - `newImplementation` is not a contract (`NotAContract`)
     *
     * Security:
     * - Role-gated upgrade authorization
     *
     * @param newImplementation New implementation address
     */
    function _authorizeUpgrade(address newImplementation) internal view override onlyValidRegistry {
        if (!ViewAccessLib.hasRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender)) {
            revert MissingRole();
        }
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