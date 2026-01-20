// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Registry } from "../registry/Registry.sol";
import { ModuleKeys } from "../constants/ModuleKeys.sol";
import { ActionKeys } from "../constants/ActionKeys.sol";
import { IAccessControlManager } from "../interfaces/IAccessControlManager.sol";
import { IVaultRouter } from "../interfaces/IVaultRouter.sol";
import { ICollateralManager } from "../interfaces/ICollateralManager.sol";
import { IAssetWhitelist } from "../interfaces/IAssetWhitelist.sol";
import { NotAContract, ZeroAddress, AmountIsZero, AssetNotAllowed } from "../errors/StandardErrors.sol";
import { OwnableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { PausableUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import { ReentrancyGuardUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import { IPositionView } from "../interfaces/IPositionView.sol";
import { ICacheRefreshable } from "../interfaces/ICacheRefreshable.sol";

interface IStatisticsViewMinimal {
    function pushUserStatsUpdate(
        address user,
        uint256 collateralIn,
        uint256 collateralOut,
        uint256 borrow,
        uint256 repay
    ) external;
}

/**
 * @title VaultRouter
 * @notice Dual-architecture router that routes deposit/withdraw and forwards push updates to View modules.
 * @dev Architecture-Guide SSOT:
 *      - User write entrypoints live in VaultCore (authority path).
 *      - VaultRouter ONLY routes deposit/withdraw (VaultCore -> VaultRouter -> CollateralManager).
 *      - Borrow/repay/settle do NOT go through VaultRouter.
 *      - All read-only queries live in dedicated View modules (PositionView/UserView/etc).
 *      - A-class module address cache is refreshable via CacheMaintenanceManager (ICacheRefreshable).
 *
 * Security:
 * - UUPS upgradeable; upgrades restricted to owner
 * - External entrypoints are role-gated and/or restricted to VaultCore
 */
contract VaultRouter is
    OwnableUpgradeable,
    UUPSUpgradeable,
    ReentrancyGuardUpgradeable,
    PausableUpgradeable,
    IVaultRouter,
    ICacheRefreshable
{
    /*━━━━━━━━━━━━━━━ Constants ━━━━━━━━━━━━━━━*/
    /// @dev Module address cache expiry (A-class cache).
    uint256 private constant _CACHE_EXPIRY_TIME = 1 hours;

    /*━━━━━━━━━━━━━━━ Storage ━━━━━━━━━━━━━━━*/
    /// @dev Registry address used to resolve module addresses (proxy-friendly: NOT immutable).
    address private _registryAddr;

    /// @dev AssetWhitelist address used to validate collateral assets (proxy-friendly: NOT immutable).
    address private _assetWhitelistAddr;

    /// @dev Cached CollateralManager address (gas optimization).
    address private _cachedCmAddr;

    /// @dev Last cache refresh timestamp (seconds since epoch).
    uint256 private _lastCacheUpdate;

    /*━━━━━━━━━━━━━━━ Events ━━━━━━━━━━━━━━━*/
    /**
     * @notice Emitted when VaultRouter is initialized.
     * @param registry Registry address
     * @param assetWhitelist AssetWhitelist address
     */
    event VaultRouterInitialized(
        address indexed registry, 
        address indexed assetWhitelist
    );

    /**
     * @notice Emitted when VaultCore routes a deposit/withdraw user operation.
     * @param action Operation type (see ActionKeys)
     * @param user User address
     * @param amount1 Primary amount (token decimals)
     * @param amount2 Secondary amount (reserved; currently 0)
     * @param asset Asset address
     * @param timestamp Timestamp supplied by VaultCore (seconds)
     */
    event VaultAction(
        bytes32 indexed action, 
        address indexed user, 
        uint256 amount1, 
        uint256 amount2, 
        address indexed asset,
        uint256 timestamp
    );

    /**
     * @notice Emitted when a full user position push is forwarded to PositionView.
     * @param user User address
     * @param asset Asset address
     * @param collateral Collateral amount (token decimals)
     * @param debt Debt amount (token decimals)
     * @param timestamp Block timestamp recorded by VaultRouter (seconds)
     * @param requestId Idempotency key (optional; may be 0x0)
     * @param seq Monotonic sequence (optional; may be 0)
     */
    event UserPositionPushed(
        address indexed user,
        address indexed asset,
        uint256 collateral,
        uint256 debt,
        uint256 timestamp,
        bytes32 requestId,
        uint64 seq
    );

    /**
     * @notice Emitted when a delta user position push is forwarded to PositionView.
     * @param user User address
     * @param asset Asset address
     * @param collateralDelta Collateral delta (token decimals; signed)
     * @param debtDelta Debt delta (token decimals; signed)
     * @param timestamp Block timestamp recorded by VaultRouter (seconds)
     * @param requestId Idempotency key (optional; may be 0x0)
     * @param seq Monotonic sequence (optional; may be 0)
     */
    event UserPositionDeltaPushed(
        address indexed user,
        address indexed asset,
        int256 collateralDelta,
        int256 debtDelta,
        uint256 timestamp,
        bytes32 requestId,
        uint64 seq
    );

    /**
     * @notice Emitted when a best-effort user stats push to StatisticsView fails.
     * @dev Must not revert core flows; used for off-chain alerting / retry.
     */
    event UserStatsPushFailed(
        address indexed user,
        address indexed statsView,
        uint256 collateralIn,
        uint256 collateralOut,
        uint256 borrow,
        uint256 repay,
        bytes reason
    );

    /**
     * @notice Emitted when aggregated asset stats are pushed (for off-chain consumers).
     * @param asset Asset address
     * @param totalCollateral Total collateral (token decimals)
     * @param totalDebt Total debt (token decimals)
     * @param price Asset price (precision defined by upstream oracle/view)
     * @param timestamp Block timestamp recorded by VaultRouter (seconds)
     * @param requestId Idempotency key (optional; may be 0x0)
     * @param seq Monotonic sequence (optional; may be 0)
     */
    event AssetStatsPushed(
        address indexed asset,
        uint256 totalCollateral,
        uint256 totalDebt,
        uint256 price,
        uint256 timestamp,
        bytes32 requestId,
        uint64 seq
    );

    /**
     * @notice Emitted when A-class module address cache is refreshed.
     * @param timestamp Refresh timestamp (seconds)
     */
    event ModuleCacheRefreshed(uint256 timestamp);

    /*━━━━━━━━━━━━━━━ Custom errors ━━━━━━━━━━━━━━━*/
    /// @notice Thrown when caller is not authorized for the operation.
    error VaultRouter__UnauthorizedAccess();
    /// @notice Thrown when operationType is not deposit/withdraw.
    error VaultRouter__UnsupportedOperation(bytes32 operation);
    /// @notice Thrown when an A-class cached module address is stale compared to Registry.
    /// @dev Prevents silent wrong route after module upgrades; governance must refresh via CacheMaintenanceManager.
    /// @param cached Cached module address stored in VaultRouter.
    /// @param current Current module address resolved from Registry.
    error VaultRouter__StaleModuleCache(address cached, address current);

    /*━━━━━━━━━━━━━━━ Construction & initialization ━━━━━━━━━━━━━━━*/
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initialize VaultRouter (UUPS).
     * @dev Reverts if:
     *      - initialRegistry == address(0)
     *      - initialAssetWhitelist == address(0)
     *      - initialOwner == address(0)
     *
     * Security:
     * - initializer (callable once)
     * - UUPS upgrade authorization is owner-gated
     *
     * @param initialRegistry Registry address
     * @param initialAssetWhitelist AssetWhitelist address
     * @param initialPriceOracle Unused (kept for deployment compatibility)
     * @param initialSettlementToken Unused (kept for deployment compatibility)
     * @param initialOwner Initial owner of this contract
     */
    function initialize(
        address initialRegistry,
        address initialAssetWhitelist,
        address initialPriceOracle,
        address initialSettlementToken,
        address initialOwner
    ) external initializer {
        if (initialRegistry == address(0)) revert ZeroAddress();
        if (initialAssetWhitelist == address(0)) revert ZeroAddress();
        if (initialOwner == address(0)) revert ZeroAddress();

        __Ownable_init(initialOwner);
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        __Pausable_init();

        _registryAddr = initialRegistry;
        _assetWhitelistAddr = initialAssetWhitelist;
        // NOTE: priceOracle/settlementToken are no longer used by VaultRouter in strict architecture.
        // Keep initializer signature for deploy script compatibility.
        initialPriceOracle;
        initialSettlementToken;

        emit VaultRouterInitialized(initialRegistry, initialAssetWhitelist);
    }

    /// @dev UUPS upgrade authorization.
    function _authorizeUpgrade(address) internal view override onlyOwner {
        _noop();
    }

    /*━━━━━━━━━━━━━━━ Modifiers ━━━━━━━━━━━━━━━*/
    /**
     * @notice Ensures Registry is configured (non-zero).
     * @dev Reverts with ZeroAddress() if Registry is not set.
     */
    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        if (_registryAddr.code.length == 0) revert NotAContract(_registryAddr);
        _;
    }

    /**
     * @notice Restricts calls to the VaultCore module.
     * @dev Reverts with VaultRouter__UnauthorizedAccess() if caller is not VaultCore.
     */
    modifier onlyVaultCore() {
        address vaultCore = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_VAULT_CORE);
        if (msg.sender != vaultCore) revert VaultRouter__UnauthorizedAccess();
        _;
    }

    /*━━━━━━━━━━━━━━━ Internal helpers ━━━━━━━━━━━━━━━*/

    /**
     * @dev Return the current block timestamp in seconds.
     *      This repo's Solhint configuration forbids time-based logic by default; VaultRouter
     *      uses timestamps only for cache bookkeeping / observability, not for business decisions.
     */
    function _now() internal view returns (uint256) {
        // solhint-disable-next-line not-rely-on-time
        return block.timestamp;
    }

    /// @dev Helper to avoid "no-empty-blocks" in intentionally empty branches.
    function _noop() internal pure returns (uint256) {
        return 0;
    }

    /**
     * @dev Require that `user` has role `actionKey` in ACM.
     * @param actionKey Action key (see ActionKeys)
     * @param user Caller to be checked
     */
    function _requireRole(bytes32 actionKey, address user) internal view {
        address acmAddr = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        IAccessControlManager(acmAddr).requireRole(actionKey, user);
    }

    /**
     * @dev Validate that `asset` is non-zero and allowed by AssetWhitelist.
     * @param asset Asset address
     */
    function _validateAsset(address asset) internal view {
        if (asset == address(0)) revert ZeroAddress();
        if (!IAssetWhitelist(_assetWhitelistAddr).isAssetAllowed(asset)) {
            revert AssetNotAllowed();
        }
    }

    /**
     * @dev Validate that `amount` is non-zero.
     * @param amount Amount (token decimals)
     */
    function _validateAmount(uint256 amount) internal pure {
        if (amount == 0) revert AmountIsZero();
    }

    /**
     * @notice Return cached CollateralManager address, refreshing if expired.
     * @dev Reverts if:
     *      - Registry is misconfigured (getModuleOrRevert fails)
     *
     * @return cm CollateralManager address
     */
    function _getCachedCollateralManager() internal returns (address cm) {
        // A-class cache hardening (Architecture-Guide / Security-Guards SSOT):
        // If the Registry module address changed since our last refresh, we MUST NOT continue routing to the old
        // cached address (silent wrong route). Governance must refresh A-class caches via CacheMaintenanceManager.
        address current = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_CM);
        uint256 nowTs = _now();
        // Uninitialized or expired cache: refresh to current.
        if (_cachedCmAddr == address(0) || nowTs > _lastCacheUpdate + _CACHE_EXPIRY_TIME) {
            _cachedCmAddr = current;
            _lastCacheUpdate = nowTs;
            return current;
        }
        // Cache is within expiry: reject if Registry changed to avoid silent wrong route.
        if (_cachedCmAddr != current) revert VaultRouter__StaleModuleCache(_cachedCmAddr, current);
        return _cachedCmAddr;
    }

    /**
     * @dev Emit a VaultAction event using the current block timestamp.
     * @param action Action key (see ActionKeys)
     * @param user User address
     * @param amount1 Amount1 (token decimals)
     * @param amount2 Amount2 (token decimals)
     * @param asset Asset address
     */
    function _emitVaultAction(
        bytes32 action,
        address user,
        uint256 amount1,
        uint256 amount2,
        address asset
    ) internal {
        emit VaultAction(action, user, amount1, amount2, asset, _now());
    }

    /*━━━━━━━━━━━━━━━ Core routing ━━━━━━━━━━━━━━━*/

    /**
     * @notice Route a user deposit/withdraw operation from VaultCore to CollateralManager.
     * @dev Reverts if:
     *      - Registry is not configured
     *      - caller != VaultCore
     *      - asset == address(0) or asset is not allowed by AssetWhitelist
     *      - amount == 0
     *      - operationType is not ACTION_DEPOSIT or ACTION_WITHDRAW
     *
     * Security:
     * - onlyVaultCore (single write entrypoint)
     * - nonReentrant
     * - pausable (whenNotPaused)
     *
     * @param user User address
     * @param operationType Action key (see ActionKeys)
     * @param asset Asset address
     * @param amount Amount (token decimals)
     * @param timestamp Timestamp supplied by VaultCore (seconds)
     */
    function processUserOperation(
        address user,
        bytes32 operationType,
        address asset,
        uint256 amount,
        uint256 timestamp
    ) external override whenNotPaused onlyValidRegistry onlyVaultCore nonReentrant {
        // Basic validation
        _validateAsset(asset);
        _validateAmount(amount);

        // Resolve target module (cached)
        address cm = _getCachedCollateralManager();

        if (operationType == ActionKeys.ACTION_DEPOSIT) {
            ICollateralManager(cm).depositCollateral(user, asset, amount);
        } else if (operationType == ActionKeys.ACTION_WITHDRAW) {
            ICollateralManager(cm).withdrawCollateral(user, asset, amount);
        } else {
            // Other write operations should go through VaultCore -> LendingEngine directly.
            revert VaultRouter__UnsupportedOperation(operationType);
        }

        emit VaultAction(operationType, user, amount, 0, asset, timestamp);
    }

    /**
     * @notice Forward a full user position update to PositionView (versioned + contexted).
     * @dev Reverts if:
     *      - Registry is not configured
     *      - caller != VaultCore
     *      - PositionView is not registered in Registry
     *      - PositionView reverts
     *
     * Security:
     * - onlyVaultCore (single push entrypoint)
     * - onlyValidRegistry
     *
     * Architecture note:
     * - VaultRouter is a slim forwarder. It MUST NOT read PositionView to compute deltas.
     * - Statistics updates, if any, should be pushed via the delta push path.
     *
     * @param user User address
     * @param asset Asset address
     * @param collateral Collateral amount (token decimals)
     * @param debt Debt amount (token decimals)
     * @param requestId Idempotency key (may be 0x0)
     * @param seq Sequence number (may be 0)
     * @param nextVersion Target cache version in PositionView (0 means auto-increment mode)
     */
    function pushUserPositionUpdate(
        address user,
        address asset,
        uint256 collateral,
        uint256 debt,
        bytes32 requestId,
        uint64 seq,
        uint64 nextVersion
    ) external override onlyValidRegistry onlyVaultCore {
        address pv = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_POSITION_VIEW);
        IPositionView(pv).pushUserPositionUpdate(user, asset, collateral, debt, requestId, seq, nextVersion);
        emit UserPositionPushed(user, asset, collateral, debt, _now(), requestId, seq);
    }

    /**
     * @notice Forward a delta user position update to PositionView (versioned + contexted).
     * @dev Reverts if:
     *      - Registry is not configured
     *      - caller != VaultCore
     *      - PositionView is not registered in Registry
     *      - PositionView reverts
     *
     * Security:
     * - onlyVaultCore (single push entrypoint)
     * - onlyValidRegistry
     *
     * Architecture note:
     * - StatisticsView updates are best-effort and driven by deltas (no reads in VaultRouter).
     *
     * @param user User address
     * @param asset Asset address
     * @param collateralDelta Collateral delta (token decimals; signed)
     * @param debtDelta Debt delta (token decimals; signed)
     * @param requestId Idempotency key (may be 0x0)
     * @param seq Sequence number (may be 0)
     * @param nextVersion Target cache version in PositionView (0 means auto-increment mode)
     */
    function pushUserPositionUpdateDelta(
        address user,
        address asset,
        int256 collateralDelta,
        int256 debtDelta,
        bytes32 requestId,
        uint64 seq,
        uint64 nextVersion
    ) external override onlyValidRegistry onlyVaultCore {
        address pv = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_POSITION_VIEW);
        IPositionView(pv).pushUserPositionUpdateDelta(
            user,
            asset,
            collateralDelta,
            debtDelta,
            requestId,
            seq,
            nextVersion
        );
        _tryPushUserStatsUpdateFromDelta(user, collateralDelta, debtDelta);
        emit UserPositionDeltaPushed(user, asset, collateralDelta, debtDelta, _now(), requestId, seq);
    }

    function _tryPushUserStatsUpdateFromDelta(address user, int256 collateralDelta, int256 debtDelta) internal {
        // StatisticsView is push-based; keep best-effort and never block core flows.
        address stats = Registry(_registryAddr).getModule(ModuleKeys.KEY_STATS);
        if (stats == address(0)) return;
        if (stats.code.length == 0) {
            emit UserStatsPushFailed(user, stats, 0, 0, 0, 0, abi.encodeWithSelector(NotAContract.selector, stats));
            return;
        }

        uint256 collateralIn = 0;
        uint256 collateralOut = 0;
        uint256 borrow = 0;
        uint256 repay = 0;

        if (collateralDelta > 0) {
            collateralIn = uint256(collateralDelta);
        } else if (collateralDelta < 0) {
            collateralOut = _absToUint(collateralDelta);
        }

        if (debtDelta > 0) {
            borrow = uint256(debtDelta);
        } else if (debtDelta < 0) {
            repay = _absToUint(debtDelta);
        }

        if (collateralIn == 0 && collateralOut == 0 && borrow == 0 && repay == 0) return;

        // Best-effort: ignore failures (e.g., missing permissions on StatisticsView).
        try IStatisticsViewMinimal(stats).pushUserStatsUpdate(user, collateralIn, collateralOut, borrow, repay) {
            _noop();
        } catch (bytes memory reason) {
            emit UserStatsPushFailed(user, stats, collateralIn, collateralOut, borrow, repay, reason);
        }
    }

    function _absToUint(int256 x) internal pure returns (uint256) {
        if (x >= 0) return uint256(x);
        if (x == type(int256).min) return uint256(type(int256).max) + 1;
        return uint256(-x);
    }

    /**
     * @notice Emit asset stats push event with idempotency context.
     * @dev Reverts if:
     *      - Registry is not configured
     *      - caller != VaultCore
     *
     * Security:
     * - onlyVaultCore
     * - nonReentrant
     *
     * @param asset Asset address
     * @param totalCollateral Total collateral (token decimals)
     * @param totalDebt Total debt (token decimals)
     * @param price Asset price (precision defined by upstream oracle/view)
     * @param requestId Idempotency key (may be 0x0)
     * @param seq Sequence number (may be 0)
     */
    function pushAssetStatsUpdate(
        address asset,
        uint256 totalCollateral,
        uint256 totalDebt,
        uint256 price,
        bytes32 requestId,
        uint64 seq
    ) external override onlyValidRegistry onlyVaultCore nonReentrant {
        _emitAssetStatsUpdate(asset, totalCollateral, totalDebt, price, requestId, seq);
    }

    function _emitAssetStatsUpdate(
        address asset,
        uint256 totalCollateral,
        uint256 totalDebt,
        uint256 price,
        bytes32 requestId,
        uint64 seq
    ) internal {
        emit AssetStatsPushed(asset, totalCollateral, totalDebt, price, _now(), requestId, seq);
    }

    /*━━━━━━━━━━━━━━━ Governance ━━━━━━━━━━━━━━━*/

    /**
     * @notice Pause the router (governance only).
     * @dev Reverts if:
     *      - Registry is not configured
     *      - msg.sender lacks ACTION_PAUSE_SYSTEM
     *
     * Security:
     * - role-gated via ACM
     */
    function pause() external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_PAUSE_SYSTEM, msg.sender);
        _pause();
        _emitVaultAction(
            ActionKeys.ACTION_PAUSE_SYSTEM,
            msg.sender,
            0,
            0,
            address(0)
        );
    }

    /**
     * @notice Unpause the router (governance only).
     * @dev Reverts if:
     *      - Registry is not configured
     *      - msg.sender lacks ACTION_UNPAUSE_SYSTEM
     *
     * Security:
     * - role-gated via ACM
     */
    function unpause() external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_UNPAUSE_SYSTEM, msg.sender);
        _unpause();
        _emitVaultAction(
            ActionKeys.ACTION_UNPAUSE_SYSTEM,
            msg.sender,
            0,
            0,
            address(0)
        );
    }

    /*━━━━━━━━━━━━━━━ Module cache refresh (A-class cache) ━━━━━━━━━━━━━━━*/

    /**
     * @notice Refresh A-class module address cache (CM/LE).
     * @dev Reverts if:
     *      - Registry is not configured
     *      - msg.sender != CacheMaintenanceManager
     *      - Registry module resolution fails
     *
     * Security:
     * - restricted to CacheMaintenanceManager (single operational entrypoint)
     * - nonReentrant
     */
    function refreshModuleCache() external override onlyValidRegistry nonReentrant {
        // Unified entry: only CacheMaintenanceManager can refresh module caches.
        address maint = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_CACHE_MAINTENANCE_MANAGER);
        if (msg.sender != maint) revert VaultRouter__UnauthorizedAccess();
        _cachedCmAddr = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_CM);
        _lastCacheUpdate = _now();
        emit ModuleCacheRefreshed(_lastCacheUpdate);
    }

    /**
     * @notice Returns true if module cache is initialized and not expired.
     * @return isValid True if cache timestamp is within CACHE_EXPIRY_TIME window
     */
    function isModuleCacheValid() external view returns (bool) {
        return _lastCacheUpdate != 0 && _now() <= _lastCacheUpdate + _CACHE_EXPIRY_TIME;
    }

    /*━━━━━━━━━━━━━━━ Storage gap ━━━━━━━━━━━━━━━*/
    uint256[50] private __gap;
} 