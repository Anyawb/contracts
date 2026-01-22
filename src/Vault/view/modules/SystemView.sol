// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// solhint-disable-next-line no-global-import
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
// solhint-disable-next-line no-global-import
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { Registry } from "../../../registry/Registry.sol";
import { ModuleKeys } from "../../../constants/ModuleKeys.sol";
import { ActionKeys } from "../../../constants/ActionKeys.sol";
import { IAccessControlManager } from "../../../interfaces/IAccessControlManager.sol";
import { ILiquidationRiskManager } from "../../../interfaces/ILiquidationRiskManager.sol";
import { ViewAccessLib } from "../../../libraries/ViewAccessLib.sol";
import { NotAContract, ZeroAddress } from "../../../errors/StandardErrors.sol";
import { ViewVersioned } from "../ViewVersioned.sol";

/**
 * @dev Minimal interface for best-effort cross-module staticcalls.
 */
interface IPositionView {
    function getMaxBorrowable(address user, address asset) external view returns (uint256);
}

/**
 * @title SystemView
 * @notice Unified read-only facade for registry discovery and cross-module view routing.
 * @dev Reverts if:
 *      - registry is zero / not a contract (ZeroAddress / NotAContract)
 *      - caller lacks ACTION_VIEW_SYSTEM_DATA permission (via ViewAccessLib / ACM)
 *      - a requested module is missing when using a strict resolver (Registry.getModuleOrRevert)
 *      - a named module is unknown (SystemView__UnknownModuleName)
 *      - UUPS upgrade is unauthorized (MissingRole via ACM)
 *
 * Security:
 * - Read-only facade: does not write business state and does not emit DataPush events.
 * - Access control is enforced via ACTION_VIEW_SYSTEM_DATA for discovery endpoints.
 * - UUPS upgradeability is role-gated (ACTION_ADMIN via ACM).
 */
contract SystemView is Initializable, UUPSUpgradeable, ViewVersioned {
    /*━━━━━━━━━━━━━━━ Types ━━━━━━━━━━━━━━━*/

    struct GlobalStatisticsView {
        uint256 totalUsers;
        uint256 activeUsers;
        uint256 totalCollateral;
        uint256 totalDebt;
        uint256 lastUpdateTime;
    }

    struct RewardSystemView {
        uint256 rewardRate;
        uint256 totalRewardPoints;
    }

    struct GuaranteeSystemView {
        uint256 totalGuarantee;
    }

    struct RouteInfo {
        bytes32 moduleKey;
        address moduleAddr;
    }

    struct RouteHint {
        RouteInfo primaryRoute;
        RouteInfo fallbackRoute;
    }

    /*━━━━━━━━━━━━━━━ Errors ━━━━━━━━━━━━━━━*/

    /// @notice Named module string is unknown to both ModuleKeys mapping and legacy Registry entries.
    error SystemView__UnknownModuleName();

    /// @notice Deprecated entrypoint: use `routeStatistics()` and query the StatisticsView directly.
    error SystemView__DeprecatedUseStatisticsView();

    /// @notice Deprecated entrypoint: use `routeReward()` and query the RewardView directly.
    error SystemView__DeprecatedUseRewardView();

    /// @notice Deprecated entrypoint: use `routePrice()` and query the ValuationOracleView (or PRICE_ORACLE fallback).
    error SystemView__DeprecatedUseValuationOracleView();

    /*━━━━━━━━━━━━━━━ Storage ━━━━━━━━━━━━━━━*/

    address private _registryAddr;
    // NOTE: Keep this storage slot for upgrade-safe layout compatibility.
    // The authoritative ViewCache address must be resolved from Registry on each read.
    address private _viewCacheAddr;

    /*━━━━━━━━━━━━━━━ Modifiers ━━━━━━━━━━━━━━━*/

    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        if (_registryAddr.code.length == 0) revert NotAContract(_registryAddr);
        _;
    }

    modifier onlyViewRole() {
        ViewAccessLib.requireRole(_registryAddr, ActionKeys.ACTION_VIEW_SYSTEM_DATA, msg.sender);
        _;
    }

    /*━━━━━━━━━━━━━━━ Initializer ━━━━━━━━━━━━━━━*/

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initialize the SystemView (UUPS).
     * @dev Reverts if:
     *      - initialRegistryAddr is zero (ZeroAddress)
     *      - initialRegistryAddr is not a contract (NotAContract)
     *
     * Security:
     * - initializer (UUPS)
     *
     * @param initialRegistryAddr Registry contract address
     */
    function initialize(address initialRegistryAddr) external initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        if (initialRegistryAddr.code.length == 0) revert NotAContract(initialRegistryAddr);
        __UUPSUpgradeable_init();
        _registryAddr = initialRegistryAddr;
        // Best-effort resolve ViewCache for backward-compatible storage layout. (Getter resolves dynamically.)
        _viewCacheAddr = Registry(initialRegistryAddr).getModule(ModuleKeys.KEY_VIEW_CACHE);
    }

    /*━━━━━━━━━━━━━━━ Basic metadata ━━━━━━━━━━━━━━━*/

    /**
     * @notice Get the Registry contract address (legacy getter).
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Read-only
     *
     * @return registryAddr_ Registry contract address
     */
    function registry() external view returns (address registryAddr_) {
        return _registryAddr;
    }

    /**
     * @notice Get the Registry contract address (legacy getter).
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Read-only
     *
     * @return registryAddr_ Registry contract address
     */
    function registryAddr() external view returns (address registryAddr_) {
        return _registryAddr;
    }

    /**
     * @notice Get the Registry contract address (preferred naming for frontend integration).
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Read-only
     *
     * @return registryAddr_ Registry contract address
     */
    function registryAddrVar() external view returns (address registryAddr_) {
        return _registryAddr;
    }

    /**
     * @notice Get the AccessControlManager contract address resolved from Registry.
     * @dev Reverts if:
     *      - Registry has no module for KEY_ACCESS_CONTROL (via Registry.getModuleOrRevert)
     *
     * Security:
     * - Read-only
     *
     * @return accessControlManagerAddr AccessControlManager module address
     */
    function acm() external view returns (address accessControlManagerAddr) {
        return Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
    }

    /**
     * @notice Get the ViewCache module address resolved from Registry.
     * @dev Reverts if:
     *      - (none) (returns address(0) if not configured)
     *
     * Security:
     * - Read-only
     *
     * @return viewCacheAddr ViewCache module address (or address(0) if not configured)
     */
    function viewCache() external view returns (address viewCacheAddr) {
        return Registry(_registryAddr).getModule(ModuleKeys.KEY_VIEW_CACHE);
    }

    /**
     * @notice Get the ViewCache module address resolved from Registry (preferred naming for frontend integration).
     * @dev Reverts if:
     *      - (none) (returns address(0) if not configured)
     *
     * Security:
     * - Read-only
     *
     * @return viewCacheAddr ViewCache module address (or address(0) if not configured)
     */
    function viewCacheAddrVar() external view returns (address viewCacheAddr) {
        return Registry(_registryAddr).getModule(ModuleKeys.KEY_VIEW_CACHE);
    }

    /**
     * @notice Resolve a module address by its key (strict).
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks ACTION_VIEW_SYSTEM_DATA permission (via onlyViewRole)
     *      - module is not configured (via Registry.getModuleOrRevert)
     *
     * Security:
     * - Role-gated via ACTION_VIEW_SYSTEM_DATA
     *
     * @param key Module key (bytes32)
     * @return moduleAddr Module address (non-zero)
     */
    function getModule(bytes32 key) external view onlyValidRegistry onlyViewRole returns (address) {
        return Registry(_registryAddr).getModuleOrRevert(key);
    }

    /**
     * @notice Resolve a module address by its key (optional).
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks ACTION_VIEW_SYSTEM_DATA permission (via onlyViewRole)
     *
     * Security:
     * - Role-gated via ACTION_VIEW_SYSTEM_DATA
     *
     * @param key Module key (bytes32)
     * @return moduleAddr Module address (or address(0) if not configured)
     */
    function getModuleOptional(bytes32 key) external view onlyValidRegistry onlyViewRole returns (address) {
        return Registry(_registryAddr).getModule(key);
    }

    /**
     * @notice Resolve a module address by its legacy string name (strict).
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks ACTION_VIEW_SYSTEM_DATA permission (via onlyViewRole)
     *      - `name` is not recognized by ModuleKeys mapping and no legacy Registry entry exists
     *        (SystemView__UnknownModuleName)
     *
     * Security:
     * - Role-gated via ACTION_VIEW_SYSTEM_DATA
     *
     * @param name Module name (string); first resolved via ModuleKeys.getModuleKeyFromString(name),
     *             then falls back to Registry.getModule(keccak256(bytes(name))).
     * @return moduleAddr Module address (non-zero)
     */
    function getNamedModule(string calldata name) external view onlyValidRegistry onlyViewRole returns (address) {
        // Prefer the canonical mapping (ModuleKeys legacy string compatibility).
        bytes32 key = ModuleKeys.getModuleKeyFromString(name);
        if (key != bytes32(0)) {
            return Registry(_registryAddr).getModuleOrRevert(key);
        }

        // Legacy fallback: some historical scripts stored keccak256(name) directly as the module key.
        address legacyModuleAddr = Registry(_registryAddr).getModule(keccak256(bytes(name)));
        if (legacyModuleAddr == address(0)) revert SystemView__UnknownModuleName();
        return legacyModuleAddr;
    }

    /**
     * @notice Resolve a module address by its legacy string name (optional).
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks ACTION_VIEW_SYSTEM_DATA permission (via onlyViewRole)
     *
     * Security:
     * - Role-gated via ACTION_VIEW_SYSTEM_DATA
     *
     * @param name Module name (string); first resolved via ModuleKeys.getModuleKeyFromString(name),
     *             then falls back to Registry.getModule(keccak256(bytes(name))).
     * @return moduleAddr Module address (or address(0) if not configured)
     */
    function getNamedModuleOptional(string calldata name)
        external
        view
        onlyValidRegistry
        onlyViewRole
        returns (address)
    {
        bytes32 key = ModuleKeys.getModuleKeyFromString(name);
        if (key != bytes32(0)) {
            return Registry(_registryAddr).getModule(key);
        }
        return Registry(_registryAddr).getModule(keccak256(bytes(name)));
    }

    /*━━━━━━━━━━━━━━━ Routing / discovery ━━━━━━━━━━━━━━━*/

    /**
     * @notice Get the canonical price view route (primary + fallback).
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks ACTION_VIEW_SYSTEM_DATA permission (via onlyViewRole)
     *
     * Security:
     * - Role-gated via ACTION_VIEW_SYSTEM_DATA
     *
     * @return routeHint_ Price route hint (primary: ValuationOracleView, fallback: PRICE_ORACLE)
     */
    function routePrice() external view onlyValidRegistry onlyViewRole returns (RouteHint memory routeHint_) {
        routeHint_.primaryRoute = RouteInfo({
            moduleKey: ModuleKeys.KEY_VALUATION_ORACLE_VIEW,
            moduleAddr: Registry(_registryAddr).getModule(ModuleKeys.KEY_VALUATION_ORACLE_VIEW)
        });
        routeHint_.fallbackRoute = RouteInfo({
            moduleKey: ModuleKeys.KEY_PRICE_ORACLE,
            moduleAddr: Registry(_registryAddr).getModule(ModuleKeys.KEY_PRICE_ORACLE)
        });
    }

    /**
     * @notice Get the StatisticsView route.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks ACTION_VIEW_SYSTEM_DATA permission (via onlyViewRole)
     *
     * Security:
     * - Role-gated via ACTION_VIEW_SYSTEM_DATA
     *
     * @return routeInfo_ Route info for StatisticsView (may return address(0) if not configured)
     */
    function routeStatistics() external view onlyValidRegistry onlyViewRole returns (RouteInfo memory routeInfo_) {
        routeInfo_ = RouteInfo({
            moduleKey: ModuleKeys.KEY_STATS,
            moduleAddr: Registry(_registryAddr).getModule(ModuleKeys.KEY_STATS)
        });
    }

    /**
     * @notice Get the RewardView route.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks ACTION_VIEW_SYSTEM_DATA permission (via onlyViewRole)
     *
     * Security:
     * - Role-gated via ACTION_VIEW_SYSTEM_DATA
     *
     * @return routeInfo_ Route info for RewardView (may return address(0) if not configured)
     */
    function routeReward() external view onlyValidRegistry onlyViewRole returns (RouteInfo memory routeInfo_) {
        routeInfo_ = RouteInfo({
            moduleKey: ModuleKeys.KEY_REWARD_VIEW,
            moduleAddr: Registry(_registryAddr).getModule(ModuleKeys.KEY_REWARD_VIEW)
        });
    }

    /**
     * @notice Get the LiquidationView route.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks ACTION_VIEW_SYSTEM_DATA permission (via onlyViewRole)
     *
     * Security:
     * - Role-gated via ACTION_VIEW_SYSTEM_DATA
     *
     * @return routeInfo_ Route info for LiquidationView (may return address(0) if not configured)
     */
    function routeLiquidation() external view onlyValidRegistry onlyViewRole returns (RouteInfo memory routeInfo_) {
        routeInfo_ = RouteInfo({
            moduleKey: ModuleKeys.KEY_LIQUIDATION_VIEW,
            moduleAddr: Registry(_registryAddr).getModule(ModuleKeys.KEY_LIQUIDATION_VIEW)
        });
    }

    /**
     * @notice Get the RiskView route.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks ACTION_VIEW_SYSTEM_DATA permission (via onlyViewRole)
     *
     * Security:
     * - Role-gated via ACTION_VIEW_SYSTEM_DATA
     *
     * @return routeInfo_ Route info for RiskView (may return address(0) if not configured)
     */
    function routeRisk() external view onlyValidRegistry onlyViewRole returns (RouteInfo memory routeInfo_) {
        routeInfo_ = RouteInfo({
            moduleKey: ModuleKeys.KEY_RISK_VIEW,
            moduleAddr: Registry(_registryAddr).getModule(ModuleKeys.KEY_RISK_VIEW)
        });
    }

    /**
     * @notice Get the UserView route.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks ACTION_VIEW_SYSTEM_DATA permission (via onlyViewRole)
     *
     * Security:
     * - Role-gated via ACTION_VIEW_SYSTEM_DATA
     *
     * @return routeInfo_ Route info for UserView (may return address(0) if not configured)
     */
    function routeUser() external view onlyValidRegistry onlyViewRole returns (RouteInfo memory routeInfo_) {
        routeInfo_ = RouteInfo({
            moduleKey: ModuleKeys.KEY_USER_VIEW,
            moduleAddr: Registry(_registryAddr).getModule(ModuleKeys.KEY_USER_VIEW)
        });
    }

    /**
     * @notice Get the PositionView route.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks ACTION_VIEW_SYSTEM_DATA permission (via onlyViewRole)
     *
     * Security:
     * - Role-gated via ACTION_VIEW_SYSTEM_DATA
     *
     * @return routeInfo_ Route info for PositionView (may return address(0) if not configured)
     */
    function routePosition() external view onlyValidRegistry onlyViewRole returns (RouteInfo memory routeInfo_) {
        routeInfo_ = RouteInfo({
            moduleKey: ModuleKeys.KEY_POSITION_VIEW,
            moduleAddr: Registry(_registryAddr).getModule(ModuleKeys.KEY_POSITION_VIEW)
        });
    }

    /**
     * @notice Get the BatchView route.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks ACTION_VIEW_SYSTEM_DATA permission (via onlyViewRole)
     *
     * Security:
     * - Role-gated via ACTION_VIEW_SYSTEM_DATA
     *
     * @return routeInfo_ Route info for BatchView (may return address(0) if not configured)
     */
    function routeBatch() external view onlyValidRegistry onlyViewRole returns (RouteInfo memory routeInfo_) {
        routeInfo_ = RouteInfo({
            moduleKey: ModuleKeys.KEY_BATCH_VIEW,
            moduleAddr: Registry(_registryAddr).getModule(ModuleKeys.KEY_BATCH_VIEW)
        });
    }

    /**
     * @notice Get the DashboardView route.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks ACTION_VIEW_SYSTEM_DATA permission (via onlyViewRole)
     *
     * Security:
     * - Role-gated via ACTION_VIEW_SYSTEM_DATA
     *
     * @return routeInfo_ Route info for DashboardView (may return address(0) if not configured)
     */
    function routeDashboard() external view onlyValidRegistry onlyViewRole returns (RouteInfo memory routeInfo_) {
        routeInfo_ = RouteInfo({
            moduleKey: ModuleKeys.KEY_DASHBOARD_VIEW,
            moduleAddr: Registry(_registryAddr).getModule(ModuleKeys.KEY_DASHBOARD_VIEW)
        });
    }

    /**
     * @notice Get the PreviewView route.
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks ACTION_VIEW_SYSTEM_DATA permission (via onlyViewRole)
     *
     * Security:
     * - Role-gated via ACTION_VIEW_SYSTEM_DATA
     *
     * @return routeInfo_ Route info for PreviewView (may return address(0) if not configured)
     */
    function routePreview() external view onlyValidRegistry onlyViewRole returns (RouteInfo memory routeInfo_) {
        routeInfo_ = RouteInfo({
            moduleKey: ModuleKeys.KEY_PREVIEW_VIEW,
            moduleAddr: Registry(_registryAddr).getModule(ModuleKeys.KEY_PREVIEW_VIEW)
        });
    }

    /*━━━━━━━━━━━━━━━ Assets & debt (legacy helpers) ━━━━━━━━━━━━━━━*/

    /**
     * @notice Get a legacy bundle of vault parameters (best-effort).
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks ACTION_VIEW_SYSTEM_DATA permission (via onlyViewRole)
     *
     * Security:
     * - Role-gated via ACTION_VIEW_SYSTEM_DATA
     * - Best-effort cross-module reads; returns 0 for unavailable sources.
     *
     * @return minHealthFactor Minimum health factor (best-effort; see ILiquidationRiskManager for semantics)
     * @return vaultCap Vault cap (best-effort; legacy compatibility only, may be 0)
     * @return liquidationThreshold Liquidation threshold (best-effort; see ILiquidationRiskManager for semantics)
     */
    function getVaultParams()
        external
        view
        onlyValidRegistry
        onlyViewRole
        returns (uint256 minHealthFactor, uint256 vaultCap, uint256 liquidationThreshold)
    {
        minHealthFactor = _tryGetMinHealthFactor();
        vaultCap = _tryGetVaultCap();
        liquidationThreshold = _tryGetLiquidationThreshold();
    }

    /**
     * @notice Get the vault cap (legacy helper; best-effort).
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks ACTION_VIEW_SYSTEM_DATA permission (via onlyViewRole)
     *
     * Security:
     * - Role-gated via ACTION_VIEW_SYSTEM_DATA
     *
     * @return vaultCap Vault cap (legacy compatibility only, may be 0)
     */
    function getVaultCap() external view onlyValidRegistry onlyViewRole returns (uint256 vaultCap) {
        return _tryGetVaultCap();
    }

    /**
     * @notice Get the remaining vault cap (legacy placeholder).
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks ACTION_VIEW_SYSTEM_DATA permission (via onlyViewRole)
     *
     * Security:
     * - Role-gated via ACTION_VIEW_SYSTEM_DATA
     *
     * @param asset Asset address (unused; kept for legacy ABI compatibility)
     * @return remaining Remaining cap (always 0 until a dedicated SSOT module exists)
     */
    function getVaultCapRemaining(address asset)
        external
        view
        onlyValidRegistry
        onlyViewRole
        returns (uint256 remaining)
    {
        asset; // silence unused variable warnings
        return 0;
    }

    /**
     * @notice Get a user's max borrowable amount for an asset (best-effort).
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks ACTION_VIEW_SYSTEM_DATA permission (via onlyViewRole)
     *
     * Security:
     * - Role-gated via ACTION_VIEW_SYSTEM_DATA
     * - Best-effort: returns 0 if PositionView is not configured or does not support the selector.
     *
     * @param user Target user address
     * @param asset Asset address
     * @return maxBorrowable Max borrowable amount (asset decimals; best-effort, may be 0)
     */
    function getMaxBorrowable(address user, address asset)
        external
        view
        onlyValidRegistry
        onlyViewRole
        returns (uint256)
    {
        // 统一入口：优先走 PositionView 的权威实现（若存在）
        address pv = Registry(_registryAddr).getModule(ModuleKeys.KEY_POSITION_VIEW);
        if (pv == address(0)) return 0;
        (bool ok, bytes memory data) = pv.staticcall(
            abi.encodeCall(IPositionView.getMaxBorrowable, (user, asset))
        );
        if (!ok || data.length < 32) return 0;
        return abi.decode(data, (uint256));
    }

    /**
     * @notice Get the settlement token module address (best-effort).
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks ACTION_VIEW_SYSTEM_DATA permission (via onlyViewRole)
     *
     * Security:
     * - Role-gated via ACTION_VIEW_SYSTEM_DATA
     *
     * @return settlementTokenAddr Settlement token address (or Registry address as a non-zero placeholder)
     */
    function getSettlementToken() external view onlyValidRegistry onlyViewRole returns (address settlementTokenAddr) {
        address token = Registry(_registryAddr).getModule(ModuleKeys.KEY_SETTLEMENT_TOKEN);
        return token == address(0) ? _registryAddr : token;
    }

    /**
     * @notice Get the minimum health factor (best-effort).
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks ACTION_VIEW_SYSTEM_DATA permission (via onlyViewRole)
     *
     * Security:
     * - Role-gated via ACTION_VIEW_SYSTEM_DATA
     *
     * @return minHealthFactor Minimum health factor (best-effort; see ILiquidationRiskManager for semantics)
     */
    function getMinHealthFactor() external view onlyValidRegistry onlyViewRole returns (uint256 minHealthFactor) {
        return _tryGetMinHealthFactor();
    }

    /**
     * @notice Get the governance module address (best-effort).
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks ACTION_VIEW_SYSTEM_DATA permission (via onlyViewRole)
     *
     * Security:
     * - Role-gated via ACTION_VIEW_SYSTEM_DATA
     *
     * @return governanceAddr Governance module address (or Registry address as a non-zero placeholder)
     */
    function governance() external view onlyValidRegistry onlyViewRole returns (address governanceAddr) {
        address gov = Registry(_registryAddr).getModule(ModuleKeys.KEY_CROSS_CHAIN_GOV);
        return gov == address(0) ? _registryAddr : gov;
    }

    /**
     * @notice DEPRECATED: Use `routeStatistics()` to discover the StatisticsView, then call it directly.
     * @dev Reverts if:
     *      - always (SystemView__DeprecatedUseStatisticsView)
     *
     * Security:
     * - Read-only (always reverts)
     */
    function getTotalCollateral(address) public pure returns (uint256) {
        revert SystemView__DeprecatedUseStatisticsView();
    }

    /**
     * @notice DEPRECATED: Use `routeStatistics()` to discover the StatisticsView, then call it directly.
     * @dev Reverts if:
     *      - always (SystemView__DeprecatedUseStatisticsView)
     *
     * Security:
     * - Read-only (always reverts)
     */
    function getTotalDebt(address) public pure returns (uint256) {
        revert SystemView__DeprecatedUseStatisticsView();
    }

    /**
     * @notice DEPRECATED: Use `routePrice()` to discover ValuationOracleView (or PRICE_ORACLE fallback),
     *         then call it directly.
     * @dev Reverts if:
     *      - always (SystemView__DeprecatedUseValuationOracleView)
     *
     * Security:
     * - Read-only (always reverts)
     */
    function getAssetPrice(address) public pure returns (uint256) {
        revert SystemView__DeprecatedUseValuationOracleView();
    }

    /*━━━━━━━━━━━━━━━ Statistics & health ━━━━━━━━━━━━━━━*/

    /**
     * @notice Get a snapshot of global statistics (best-effort).
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks ACTION_VIEW_SYSTEM_DATA permission (via onlyViewRole)
     *
     * Security:
     * - Role-gated via ACTION_VIEW_SYSTEM_DATA
     * - Best-effort: returns zeros if StatisticsView is not configured or does not support the selector.
     *
     * @return globalStats_ Global statistics snapshot (best-effort; fields may be zero)
     */
    function getGlobalStatisticsView()
        external
        view
        onlyValidRegistry
        onlyViewRole
        returns (GlobalStatisticsView memory globalStats_)
    {
        address stats = Registry(_registryAddr).getModule(ModuleKeys.KEY_STATS);
        if (stats != address(0)) {
            (bool ok, bytes memory data) = stats.staticcall(abi.encodeWithSignature("getGlobalStatistics()"));
            if (ok && data.length >= 160) {
                (
                    globalStats_.totalUsers,
                    globalStats_.activeUsers,
                    globalStats_.totalCollateral,
                    globalStats_.totalDebt,
                    globalStats_.lastUpdateTime
                ) = abi.decode(data, (uint256, uint256, uint256, uint256, uint256));
            }
        }
    }

    /**
     * @notice DEPRECATED: Use `routeReward()` to discover RewardView, then call it directly.
     * @dev Reverts if:
     *      - always (SystemView__DeprecatedUseRewardView)
     *
     * Security:
     * - Read-only (always reverts)
     */
    function getRewardSystemView() external pure returns (RewardSystemView memory) {
        revert SystemView__DeprecatedUseRewardView();
    }

    /**
     * @notice DEPRECATED: Use `routeStatistics()` to discover StatisticsView, then call it directly.
     * @dev Reverts if:
     *      - always (SystemView__DeprecatedUseStatisticsView)
     *
     * Security:
     * - Read-only (always reverts)
     */
    function getGuaranteeSystemView() external pure returns (GuaranteeSystemView memory) {
        revert SystemView__DeprecatedUseStatisticsView();
    }

    /**
     * @notice Get degradation stats from StatisticsView (best-effort passthrough).
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks ACTION_VIEW_SYSTEM_DATA permission (via onlyViewRole)
     *
     * Security:
     * - Role-gated via ACTION_VIEW_SYSTEM_DATA
     *
     * @return stats Degradation stats payload (ABI-encoded; empty if unavailable)
     */
    function getGracefulDegradationStats() external view onlyValidRegistry onlyViewRole returns (bytes memory stats) {
        address statsView = Registry(_registryAddr).getModule(ModuleKeys.KEY_STATS);
        if (statsView != address(0)) {
            (bool ok, bytes memory data) = statsView.staticcall(abi.encodeWithSignature("getDegradationStats()"));
            if (ok) return data;
        }
        return "";
    }

    /**
     * @notice Perform a minimal sanity check for a module address (no external calls).
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks ACTION_VIEW_SYSTEM_DATA permission (via onlyViewRole)
     *
     * Security:
     * - Role-gated via ACTION_VIEW_SYSTEM_DATA
     * - Read-only; does not perform external calls to the module.
     *
     * @param moduleAddr Module address to check
     * @return healthy Whether the module looks healthy
     * @return details Human-readable status string (intended for off-chain tools; not for on-chain branching)
     */
    function checkModuleHealth(address moduleAddr)
        external
        view
        onlyValidRegistry
        onlyViewRole
        returns (bool healthy, string memory details)
    {
        if (moduleAddr == address(0)) return (false, "Module not configured");
        if (moduleAddr.code.length == 0) return (false, "Module has no code");
        return (true, "OK");
    }

    /*━━━━━━━━━━━━━━━ UUPS upgradeability ━━━━━━━━━━━━━━━*/

    /**
     * @notice Authorize UUPS upgrade (internal, called by upgradeTo/upgradeToAndCall).
     * @dev Reverts if:
     *      - registry is zero / not a contract (ZeroAddress / NotAContract via onlyValidRegistry)
     *      - caller lacks ACTION_ADMIN role (MissingRole via ACM)
     *      - newImplementation is zero (ZeroAddress)
     *      - newImplementation is not a contract (NotAContract)
     *
     * Security:
     * - onlyValidRegistry modifier
     * - ACTION_ADMIN role-gated via ACM
     *
     * @param newImplementation New implementation contract address
     */
    function _authorizeUpgrade(address newImplementation) internal view override onlyValidRegistry {
        address acmAddr = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        IAccessControlManager(acmAddr).requireRole(ActionKeys.ACTION_ADMIN, msg.sender);
        if (newImplementation == address(0)) revert ZeroAddress();
        if (newImplementation.code.length == 0) revert NotAContract(newImplementation);
    }

    /*━━━━━━━━━━━━━━━ Internal helpers (best-effort) ━━━━━━━━━━━━━━━*/
    function _readUint(bytes32 moduleKey, bytes memory callData) private view returns (uint256) {
        (bool ok, bytes memory data) = _staticCall(moduleKey, callData);
        if (!ok || data.length < 32) return 0;
        return abi.decode(data, (uint256));
    }

    function _staticCall(bytes32 moduleKey, bytes memory callData) private view returns (bool, bytes memory) {
        address module = Registry(_registryAddr).getModuleOrRevert(moduleKey);
        return module.staticcall(callData);
    }

    function _readUintOptional(bytes32 moduleKey, bytes memory callData) private view returns (uint256) {
        (bool ok, bytes memory data) = _staticCallOptional(moduleKey, callData);
        if (!ok || data.length < 32) return 0;
        return abi.decode(data, (uint256));
    }

    function _staticCallOptional(bytes32 moduleKey, bytes memory callData) private view returns (bool, bytes memory) {
        address module = Registry(_registryAddr).getModule(moduleKey);
        if (module == address(0)) return (false, bytes(""));
        return module.staticcall(callData);
    }

    function _tryGetMinHealthFactor() internal view returns (uint256) {
        address rm = Registry(_registryAddr).getModule(ModuleKeys.KEY_LIQUIDATION_RISK_MANAGER);
        if (rm == address(0)) return 0;
        try ILiquidationRiskManager(rm).getMinHealthFactor() returns (uint256 v) { return v; } catch { return 0; }
    }

    function _tryGetLiquidationThreshold() internal view returns (uint256) {
        address rm = Registry(_registryAddr).getModule(ModuleKeys.KEY_LIQUIDATION_RISK_MANAGER);
        if (rm == address(0)) return 0;
        try ILiquidationRiskManager(rm).getLiquidationThreshold() returns (uint256 v) { return v; } catch { return 0; }
    }

    function _tryGetVaultCap() internal pure returns (uint256) {
        // Architecture-Guide alignment:
        // VaultCap is not an SSOT in the current refactored stack (no dedicated config module).
        // Keep the getter for backward compatibility, but return 0 until a proper config module is introduced.
        return 0;
    }

    /*━━━━━━━━━━━━━━━ Versioning (C+B baseline) ━━━━━━━━━━━━━━━*/

    /**
     * @notice Get the API semantic version for this module.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Read-only
     *
     * @return apiVersion_ API semantic version
     */
    function apiVersion() public pure override returns (uint256 apiVersion_) {
        return 1;
    }

    /**
     * @notice Get the output/schema version for this module.
     * @dev Reverts if:
     *      - (none)
     *
     * Security:
     * - Read-only
     *
     * @return schemaVersion_ Schema version
     */
    function schemaVersion() public pure override returns (uint256 schemaVersion_) {
        return 1;
    }

    /*━━━━━━━━━━━━━━━ Storage gap ━━━━━━━━━━━━━━━*/

    /// @notice Storage gap for future upgrades.
    uint256[50] private __gap;
}
