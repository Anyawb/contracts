// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Registry } from "../registry/Registry.sol";
import { ModuleKeys } from "../constants/ModuleKeys.sol";
import { ActionKeys } from "../constants/ActionKeys.sol";
import { IAccessControlManager } from "../interfaces/IAccessControlManager.sol";
import { IVaultRouter } from "../interfaces/IVaultRouter.sol";
import { ICollateralManager } from "../interfaces/ICollateralManager.sol";
import "../interfaces/IAssetWhitelistRead.sol";
import { NotAContract, ZeroAddress, AmountIsZero, AssetNotAllowed } from "../errors/StandardErrors.sol";
import { OwnableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { PausableUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import { ReentrancyGuardUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import { IPositionView } from "../interfaces/IPositionView.sol";
import { ICacheRefreshable } from "../interfaces/ICacheRefreshable.sol";
import { IFeeRouterView } from "../interfaces/IFeeRouterView.sol";

/**
 * @title VaultRouter
 * @notice Dual-architecture router that routes deposit/withdraw and forwards push updates to View modules.
 * @dev Reverts if:
 *      - Registry, AssetWhitelist, owner, VaultCore, or downstream module dependencies are unset or invalid on gated paths
 *      - caller is not the required governance module or VaultCore for restricted entrypoints
 *      - asset or amount validation fails for routed deposit/withdraw operations
 *      - downstream Registry resolution, CollateralManager calls, or PositionView forwarding paths revert
 *
 * Security:
 * - VaultRouter only routes deposit and withdraw; borrow, repay, and settle flows do not pass through this contract.
 * - FeeRouter-originated mirror pushes also enter through this gateway and forward to FeeRouterView.
 * - UUPS upgradeable; upgrades are restricted to the owner.
 * - External write and push entrypoints are role-gated and/or restricted to VaultCore.
 */
contract VaultRouter is
    OwnableUpgradeable,
    UUPSUpgradeable,
    ReentrancyGuardUpgradeable,
    PausableUpgradeable,
    IVaultRouter,
    ICacheRefreshable,
    IFeeRouterView
{
    /*━━━━━━━━━━━━━━━ Constants ━━━━━━━━━━━━━━━*/
    /// @dev Module address cache expiry (A-class cache), expressed in blocks.
    /// NOTE (Time-Dependency-Refactor): legacy "seconds" TTLs are migrated to block-based TTLs.
    /// We keep numeric parity for backwards compatibility, but the unit is "blocks" (do NOT interpret as seconds).
    uint256 private constant _CACHE_EXPIRY_BLOCKS = 3600;

    /*━━━━━━━━━━━━━━━ Storage ━━━━━━━━━━━━━━━*/
    /// @dev Registry address used to resolve module addresses (proxy-friendly: NOT immutable).
    address private _registryAddr;

    /// @dev AssetWhitelist address used to validate collateral assets (proxy-friendly: NOT immutable).
    address private _assetWhitelistAddr;

    /// @dev Cached CollateralManager address (gas optimization).
    address private _cachedCmAddr;

    /// @dev Last cache refresh block number (monotonic).
    uint256 private _lastCacheUpdateBlock;

    /// @dev Dedicated FeeRouterView target resolved by the canonical gateway.
    address private _feeRouterViewAddr;

    /*━━━━━━━━━━━━━━━ Events ━━━━━━━━━━━━━━━*/
    /**
     * @notice Emitted when VaultRouter is initialized.
        * @dev Event only.
        * @param registry Registry address.
        * @param assetWhitelist AssetWhitelist address.
     */
    event VaultRouterInitialized(
        address indexed registry, 
        address indexed assetWhitelist
    );

    /**
     * @notice Emitted when VaultCore routes a deposit/withdraw user operation.
        * @dev Event only.
        * @param action Operation type defined in ActionKeys.
        * @param user User address.
        * @param amount1 Primary amount in token decimals.
        * @param amount2 Secondary amount, reserved and currently zero.
        * @param asset Asset address.
     * @param blockNumber Legacy field: the time axis marker supplied by VaultCore.
     *                  NOTE: in this repo, this is treated as `blockNumber` (observability only).
     */
    event VaultAction(
        bytes32 indexed action, 
        address indexed user, 
        uint256 amount1, 
        uint256 amount2, 
        address indexed asset,
        uint256 blockNumber
    );

    /// @notice Explicit block-based companion event for VaultAction.
    /// @dev Event only.
    event VaultActionAtBlock(
        bytes32 indexed action,
        address indexed user,
        uint256 amount1,
        uint256 amount2,
        address indexed asset,
        uint256 blockNumber
    );

    /**
     * @notice Emitted when a full user position push is forwarded to PositionView.
        * @dev Event only.
        * @param user User address.
        * @param asset Asset address.
        * @param collateral Collateral amount in token decimals.
        * @param debt Debt amount in token decimals.
     * @param blockNumber Legacy field: emitted time axis marker (treated as blockNumber in this repo)
        * @param requestId Idempotency key, which may be zero.
        * @param seq Monotonic sequence, which may be zero.
     */
    event UserPositionPushed(
        address indexed user,
        address indexed asset,
        uint256 collateral,
        uint256 debt,
        uint256 blockNumber,
        bytes32 requestId,
        uint64 seq
    );

    /// @notice Explicit block-based companion event for UserPositionPushed.
    /// @dev Event only.
    event UserPositionPushedAtBlock(
        address indexed user,
        address indexed asset,
        uint256 collateral,
        uint256 debt,
        uint256 blockNumber,
        bytes32 requestId,
        uint64 seq
    );

    /**
     * @notice Emitted when a delta user position push is forwarded to PositionView.
        * @dev Event only.
        * @param user User address.
        * @param asset Asset address.
        * @param collateralDelta Signed collateral delta in token decimals.
        * @param debtDelta Signed debt delta in token decimals.
     * @param blockNumber Legacy field: emitted time axis marker (treated as blockNumber in this repo)
        * @param requestId Idempotency key, which may be zero.
        * @param seq Monotonic sequence, which may be zero.
     */
    event UserPositionDeltaPushed(
        address indexed user,
        address indexed asset,
        int256 collateralDelta,
        int256 debtDelta,
        uint256 blockNumber,
        bytes32 requestId,
        uint64 seq
    );

    /// @notice Explicit block-based companion event for UserPositionDeltaPushed.
    /// @dev Event only.
    event UserPositionDeltaPushedAtBlock(
        address indexed user,
        address indexed asset,
        int256 collateralDelta,
        int256 debtDelta,
        uint256 blockNumber,
        bytes32 requestId,
        uint64 seq
    );

    /**
     * @notice Emitted when aggregated asset stats are pushed (for off-chain consumers).
        * @dev Event only.
        * @param asset Asset address.
        * @param totalCollateral Total collateral in token decimals.
        * @param totalDebt Total debt in token decimals.
        * @param price Asset price in upstream oracle-defined precision.
     * @param blockNumber Legacy field: emitted time axis marker (treated as blockNumber in this repo)
        * @param requestId Idempotency key, which may be zero.
        * @param seq Monotonic sequence, which may be zero.
     */
    event AssetStatsPushed(
        address indexed asset,
        uint256 totalCollateral,
        uint256 totalDebt,
        uint256 price,
        uint256 blockNumber,
        bytes32 requestId,
        uint64 seq
    );

    /// @notice Explicit block-based companion event for AssetStatsPushed.
    /// @dev Event only.
    event AssetStatsPushedAtBlock(
        address indexed asset,
        uint256 totalCollateral,
        uint256 totalDebt,
        uint256 price,
        uint256 blockNumber,
        bytes32 requestId,
        uint64 seq
    );

    /**
     * @notice Emitted when A-class module address cache is refreshed.
        * @dev Event only.
     * @param updateBlock Legacy field: refresh time axis marker (treated as updateBlock in this repo)
     */
    event ModuleCacheRefreshed(uint256 updateBlock);

    /// @notice Explicit block-based companion event for ModuleCacheRefreshed.
    /// @dev Event only.
    event ModuleCacheRefreshedAtBlock(uint256 updateBlock);

    /// @notice Emitted when the dedicated FeeRouterView target is updated.
    event FeeRouterViewUpdated(address indexed oldView, address indexed newView);

    /*━━━━━━━━━━━━━━━ Custom errors ━━━━━━━━━━━━━━━*/
    /// @dev Reverts when the caller is not authorized for the requested operation.
    error VaultRouter__UnauthorizedAccess();
    /// @dev Reverts when `operation` is not a supported deposit or withdraw action.
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
    * - Initializer: callable once.
    * - UUPS upgrade authorization is owner-gated.
     *
    * @param initialRegistry Registry address.
    * @param initialAssetWhitelist AssetWhitelist address.
    * @param initialPriceOracle Unused parameter kept for deployment compatibility.
    * @param initialSettlementToken Unused parameter kept for deployment compatibility.
    * @param initialOwner Initial owner of this contract.
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

    /// @dev UUPS upgrade authorization hook. Ownership gating is enforced by `onlyOwner`.
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

    /**
     * @notice Restricts FeeRouter mirror pushes to the FeeRouter SSOT module.
     * @dev Reverts with VaultRouter__UnauthorizedAccess() if caller is not Registry.KEY_FR.
     */
    modifier onlyFeeRouter() {
        address feeRouter = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_FR);
        if (msg.sender != feeRouter) revert VaultRouter__UnauthorizedAccess();
        _;
    }

    /*━━━━━━━━━━━━━━━ Internal helpers ━━━━━━━━━━━━━━━*/

    /// @dev Return the current block number (monotonic chain time axis).
    function _now() internal view returns (uint256) {
        return block.number;
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
        if (!IAssetWhitelistRead(_assetWhitelistAddr).isAssetAllowed(asset)) {
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
        uint256 nowBlock = _now();
        // Uninitialized or expired cache: refresh to current.
        if (_cachedCmAddr == address(0) || nowBlock > _lastCacheUpdateBlock + _CACHE_EXPIRY_BLOCKS) {
            _cachedCmAddr = current;
            _lastCacheUpdateBlock = nowBlock;
            return current;
        }
        // Cache is within expiry: reject if Registry changed to avoid silent wrong route.
        if (_cachedCmAddr != current) revert VaultRouter__StaleModuleCache(_cachedCmAddr, current);
        return _cachedCmAddr;
    }

    /**
     * @dev Emit a VaultAction event using the current block number.
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
        emit VaultAction(action, user, amount1, amount2, asset, block.number);
        emit VaultActionAtBlock(action, user, amount1, amount2, asset, block.number);
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
    * - onlyVaultCore single write entrypoint.
    * - Non-reentrant.
    * - Pausable via `whenNotPaused`.
     *
    * @param user User address.
    * @param operationType Action key defined in ActionKeys.
    * @param asset Asset address.
    * @param amount Amount in token decimals.
    * @param blockNumber Block marker supplied by VaultCore.
     */
    function processUserOperation(
        address user,
        bytes32 operationType,
        address asset,
        uint256 amount,
        uint256 blockNumber
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

        emit VaultAction(operationType, user, amount, 0, asset, blockNumber);
        emit VaultActionAtBlock(operationType, user, amount, 0, asset, blockNumber);
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
    * - onlyVaultCore single push entrypoint.
    * - Registry-gated dependency resolution.
     *
     * Architecture note:
     * - VaultRouter is a slim forwarder. It MUST NOT read PositionView to compute deltas.
     * - Statistics updates, if any, should be pushed via the delta push path.
     *
    * @param user User address.
    * @param asset Asset address.
    * @param collateral Collateral amount in token decimals.
    * @param debt Debt amount in token decimals.
    * @param requestId Idempotency key, which may be zero.
    * @param seq Sequence number, which may be zero.
    * @param nextVersion Target cache version in PositionView. Zero means auto-increment mode.
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
        emit UserPositionPushed(user, asset, collateral, debt, block.number, requestId, seq);
        emit UserPositionPushedAtBlock(user, asset, collateral, debt, block.number, requestId, seq);
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
    * - onlyVaultCore single push entrypoint.
    * - Registry-gated dependency resolution.
     *
     * Architecture note:
     * - StatisticsView updates are best-effort and driven by deltas (no reads in VaultRouter).
     *
    * @param user User address.
    * @param asset Asset address.
    * @param collateralDelta Signed collateral delta in token decimals.
    * @param debtDelta Signed debt delta in token decimals.
    * @param requestId Idempotency key, which may be zero.
    * @param seq Sequence number, which may be zero.
    * @param nextVersion Target cache version in PositionView. Zero means auto-increment mode.
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
        emit UserPositionDeltaPushed(user, asset, collateralDelta, debtDelta, block.number, requestId, seq);
        emit UserPositionDeltaPushedAtBlock(user, asset, collateralDelta, debtDelta, block.number, requestId, seq);
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
    * - onlyVaultCore.
    * - Non-reentrant.
     *
    * @param asset Asset address.
    * @param totalCollateral Total collateral in token decimals.
    * @param totalDebt Total debt in token decimals.
    * @param price Asset price in upstream oracle-defined precision.
    * @param requestId Idempotency key, which may be zero.
    * @param seq Sequence number, which may be zero.
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
        emit AssetStatsPushed(asset, totalCollateral, totalDebt, price, block.number, requestId, seq);
        emit AssetStatsPushedAtBlock(asset, totalCollateral, totalDebt, price, block.number, requestId, seq);
    }

    /// @dev Resolve the dedicated FeeRouterView module.
    function _getFeeRouterView() internal view returns (IFeeRouterView feeRouterView) {
        address feeRouterViewAddr = _feeRouterViewAddr;
        if (feeRouterViewAddr == address(0) || feeRouterViewAddr.code.length == 0) {
            revert VaultRouter__UnauthorizedAccess();
        }
        feeRouterView = IFeeRouterView(feeRouterViewAddr);
    }

    /**
     * @notice Return the configured FeeRouterView target behind the canonical gateway.
     */
    function feeRouterViewAddrVar() external view returns (address feeRouterViewAddr) {
        return _feeRouterViewAddr;
    }

    /**
     * @notice Configure the dedicated FeeRouterView target used by gateway forwarding.
     * @dev Reverts if:
     *      - Registry is not configured
     *      - caller lacks ACTION_SET_PARAMETER
     *      - newFeeRouterView is a non-zero EOA or empty-code address
     */
    function setFeeRouterView(address newFeeRouterView) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        if (newFeeRouterView != address(0) && newFeeRouterView.code.length == 0) {
            revert NotAContract(newFeeRouterView);
        }

        address oldFeeRouterView = _feeRouterViewAddr;
        _feeRouterViewAddr = newFeeRouterView;
        emit FeeRouterViewUpdated(oldFeeRouterView, newFeeRouterView);
    }

    /**
     * @notice Forward a user-scoped fee update to FeeRouterView.
     */
    function pushUserFeeUpdate(
        address user,
        bytes32 feeType,
        uint256 feeAmount,
        uint256 personalFeeBps
    ) external override onlyValidRegistry onlyFeeRouter {
        _getFeeRouterView().pushUserFeeUpdate(user, feeType, feeAmount, personalFeeBps);
    }

    /**
     * @notice Forward global fee stats to FeeRouterView.
     */
    function pushGlobalStatsUpdate(
        uint256 totalDistributions,
        uint256 totalAmountDistributed
    ) external override onlyValidRegistry onlyFeeRouter {
        _getFeeRouterView().pushGlobalStatsUpdate(totalDistributions, totalAmountDistributed);
    }

    /**
     * @notice Forward FeeRouter system config to FeeRouterView.
     */
    function pushSystemConfigUpdate(
        address platformTreasury,
        address ecosystemVault,
        uint256 platformFeeBps,
        uint256 ecosystemFeeBps,
        address[] calldata supportedTokens
    ) external override onlyValidRegistry onlyFeeRouter {
        _getFeeRouterView().pushSystemConfigUpdate(
            platformTreasury,
            ecosystemVault,
            platformFeeBps,
            ecosystemFeeBps,
            supportedTokens
        );
    }

    /**
     * @notice Forward a global fee statistic update to FeeRouterView.
     */
    function pushGlobalFeeStatistic(
        address token,
        bytes32 feeType,
        uint256 amount
    ) external override onlyValidRegistry onlyFeeRouter {
        _getFeeRouterView().pushGlobalFeeStatistic(token, feeType, amount);
    }

    /*━━━━━━━━━━━━━━━ Governance ━━━━━━━━━━━━━━━*/

    /**
     * @notice Pause the router (governance only).
     * @dev Reverts if:
     *      - Registry is not configured
     *      - msg.sender lacks ACTION_PAUSE_SYSTEM
     *
     * Security:
    * - Role-gated via ACM.
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
    * - Role-gated via ACM.
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
    * - Restricted to CacheMaintenanceManager as the single operational refresh entrypoint.
    * - Non-reentrant.
     */
    function refreshModuleCache() external override onlyValidRegistry nonReentrant {
        // Unified entry: only CacheMaintenanceManager can refresh module caches.
        address maint = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_CACHE_MAINTENANCE_MANAGER);
        if (msg.sender != maint) revert VaultRouter__UnauthorizedAccess();
        _cachedCmAddr = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_CM);
        _lastCacheUpdateBlock = _now();
        emit ModuleCacheRefreshed(_lastCacheUpdateBlock);
        emit ModuleCacheRefreshedAtBlock(_lastCacheUpdateBlock);
    }

    /**
     * @notice Returns true if module cache is initialized and not expired.
        * @dev Reverts if: (never)
        *
        * Security:
        * - View-only cache-health check.
        *
        * @return isValid True if the cache block number is within the configured expiry window.
     */
    function isModuleCacheValid() external view returns (bool) {
        return _lastCacheUpdateBlock != 0 && _now() <= _lastCacheUpdateBlock + _CACHE_EXPIRY_BLOCKS;
    }

    /*━━━━━━━━━━━━━━━ Storage gap ━━━━━━━━━━━━━━━*/
    uint256[49] private __gap;
} 