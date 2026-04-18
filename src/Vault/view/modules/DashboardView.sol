// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import {Registry} from "../../../registry/Registry.sol";
import {ModuleKeys} from "../../../constants/ModuleKeys.sol";
import {ActionKeys} from "../../../constants/ActionKeys.sol";
import {
    BatchTooLarge,
    MissingRole,
    NotAContract,
    ZeroAddress
} from "../../../errors/StandardErrors.sol";
import {ViewConstants} from "../ViewConstants.sol";
import {ViewVersioned} from "../ViewVersioned.sol";
import {ViewAccessLib} from "../../../libraries/ViewAccessLib.sol";
import {IHealthViewBasic} from "../../../interfaces/IHealthViewBasic.sol";
import {IPositionViewBasic} from "../../../interfaces/IPositionViewBasic.sol";
import {IPriceOracleRead} from "../../../interfaces/IPriceOracleRead.sol";
import {IStatisticsViewBasic} from "../../../interfaces/IStatisticsViewBasic.sol";
import {ISystemRiskView} from "../../../interfaces/ISystemRiskView.sol";

/*━━━━━━━━━━━━━━━ Selector SSOT ━━━━━━━━━━━━━━━*/
// Selectors are derived from the canonical module contracts in this repository (SSOT),
// rather than hardcoding hex values or duplicating minimal interfaces in this file.
import {HealthView} from "./HealthView.sol";
import {PositionView} from "./PositionView.sol";

/**
 * @title DashboardView
 * @notice Frontend-friendly aggregator that stitches data from PositionView, HealthView, StatisticsView and
 * PriceOracle.
 * @dev Reverts if:
 *      - registry address is not set or invalid (see `onlyValidRegistry`)
 *      - caller is not authorized to read the requested user-dimensional data (see {onlyUserDim})
 *      - caller lacks required roles for the requested data scope (MissingRole)
 *
 * Security:
 * - View-only facade: delegates to downstream modules via external calls (`staticcall` for best-effort meta probes).
 * - UUPS upgrade is role-gated via AccessControlManager (`ActionKeys.ACTION_ADMIN`).
 */
contract DashboardView is Initializable, UUPSUpgradeable, ViewVersioned {
    struct UserAssetOverview {
        address asset;
        uint256 collateral;
        uint256 debt;
        uint256 price; // raw oracle price (precision depends on PriceOracle)
    }

    /// @notice Per-asset user overview item with PositionView cache metadata (best-effort) and an optional oracle
    /// price.
    /// @dev Position metadata is sourced from PositionView meta APIs when available. Price is best-effort and may be 0.
    struct UserAssetOverviewMeta {
        address asset;
        uint64 positionVersion;
        bool positionIsValid;
        uint256 positionBlockNumber;
        uint256 collateral;
        uint256 debt;
        uint256 price; // raw oracle price
    }

    struct UserOverview {
        uint256 totalCollateral;
        uint256 totalDebt;
        uint256 healthFactor;
        bool healthFactorValid;
        bool isRisky;
    }

    struct SystemOverview {
        uint256 totalUsers;
        uint256 activeUsers;
        uint256 totalCollateral;
        uint256 totalDebt;
        uint256 lastUpdateBlock;
    }

    /*━━━━━━━━━━━━━━━ Constants ━━━━━━━━━━━━━━━*/
    /// @dev Maximum number of items allowed in batch read calls.
    uint256 private constant _MAX_BATCH_SIZE = ViewConstants.MAX_BATCH_SIZE;

    /// @dev Function selectors for downstream `staticcall` payload encoding (derived from SSOT module contracts).
    bytes4 private constant _SEL_GET_USER_POSITION_WITH_META =
        PositionView.getUserPositionWithMeta.selector;
    bytes4 private constant _SEL_GET_USER_HEALTH_FACTOR_WITH_META =
        HealthView.getUserHealthFactorWithMeta.selector;

    address private _registryAddr;

    /// @dev Reverts when `newImplementation` is the zero address. Used by {_authorizeUpgrade}.
    error DashboardView__ZeroImplementation();
    /// @dev Reverts when the system-scoped minimum health factor is misconfigured as 0.
    error DashboardView__InvalidMinHealthFactor();

    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        if (_registryAddr.code.length == 0) revert NotAContract(_registryAddr);
        _;
    }

    /// @dev Scheme U: self read allowed; non-self requires VIEW_USER_DATA or ADMIN.
    modifier onlyUserDim(address user) {
        if (msg.sender != user) {
            bool ok = ViewAccessLib.hasRole(
                _registryAddr,
                ActionKeys.ACTION_VIEW_USER_DATA,
                msg.sender
            ) ||
                ViewAccessLib.hasRole(
                    _registryAddr,
                    ActionKeys.ACTION_ADMIN,
                    msg.sender
                );
            if (!ok) revert MissingRole();
        }
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initializes the module with the system Registry address.
     * @dev Reverts if:
     *      - `initialRegistryAddr` is zero (see {ZeroAddress})
     *      - `initialRegistryAddr` is not a contract (see {NotAContract})
     *
     * Security:
     * - Initializer can only be called once (see {Initializable}).
     * - Sets only the Registry pointer; does not modify any vault/business state.
     *
     * @param initialRegistryAddr The Registry contract address used to resolve module dependencies.
     */
    function initialize(address initialRegistryAddr) external initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        if (initialRegistryAddr.code.length == 0)
            revert NotAContract(initialRegistryAddr);
        __UUPSUpgradeable_init();
        _registryAddr = initialRegistryAddr;
    }

    /*━━━━━━━━━━━━━━━ User queries ━━━━━━━━━━━━━━━*/

    /**
     * @notice Returns an aggregated user overview over `trackedAssets`, plus cache metadata.
     * @dev Reverts if:
     *      - Registry is not configured or not a contract (see {ZeroAddress}, {NotAContract})
     *      - caller is not authorized to read `user` (Scheme U; see {onlyUserDim})
     *      - `trackedAssets.length` exceeds `ViewConstants.MAX_BATCH_SIZE` (see {BatchTooLarge})
     *      - Registry missing `ModuleKeys.KEY_POSITION_VIEW` or `ModuleKeys.KEY_HEALTH_VIEW`
     *        (reverts in {Registry.getModuleOrRevert})
     *      - Registry missing `ModuleKeys.KEY_SYSTEM_RISK_VIEW` (reverts in {Registry.getModuleOrRevert})
     *      - SystemRiskView returns `minHealthFactor == 0` (DashboardView__InvalidMinHealthFactor)
     *
     * Security:
     * - Scheme U user-dimensional read policy (self read allowed; non-self requires VIEW_USER_DATA or ADMIN).
     * - View-only; performs external view calls into PositionView and HealthView.
     * - Uses system-scoped risk parameters from SystemRiskView (SSOT) to derive `isRisky` (no hardcoded threshold).
     *
     * @param user The user to summarize.
     * @param trackedAssets The assets to aggregate. Length must be \(\le MAX_BATCH_SIZE\).
     * @return overview Aggregated totals plus health factor validity and a derived `isRisky` flag.
     * @return positionValidFlags Per-asset validity flags as reported by PositionView (best-effort).
     * @return positionUpdateBlocks Per-asset update blockNumbers (best-effort; 0 may mean unknown).
     * @return positionVersions Per-asset cache/position versions (best-effort; 0 may mean unknown).
     * @return healthUpdateBlock HealthView blockNumber (or per HealthView semantics).
     */
    function getUserOverview(
        address user,
        address[] calldata trackedAssets
    )
        external
        view
        onlyValidRegistry
        onlyUserDim(user)
        returns (
            UserOverview memory overview,
            bool[] memory positionValidFlags,
            uint256[] memory positionUpdateBlocks,
            uint64[] memory positionVersions,
            uint256 healthUpdateBlock
        )
    {
        return _getUserOverviewWithMeta(user, trackedAssets);
    }

    /**
     * @notice Returns an aggregated user overview over `trackedAssets`, plus per-asset PositionView cache metadata and
     * a HealthView blockNumber.
     * @dev Reverts if:
     *      - Registry is not configured or not a contract (see {ZeroAddress}, {NotAContract})
     *      - caller is not authorized to read `user` (Scheme U; see {onlyUserDim})
     *      - `trackedAssets.length` exceeds `ViewConstants.MAX_BATCH_SIZE` (see {BatchTooLarge})
     *      - Registry missing `ModuleKeys.KEY_POSITION_VIEW` or `ModuleKeys.KEY_HEALTH_VIEW`
     *        (reverts in {Registry.getModuleOrRevert})
     *      - Registry missing `ModuleKeys.KEY_SYSTEM_RISK_VIEW` (reverts in {Registry.getModuleOrRevert})
     *      - SystemRiskView returns `minHealthFactor == 0` (DashboardView__InvalidMinHealthFactor)
     *
     * Security:
     * - Scheme U user-dimensional read policy (self read allowed; non-self requires VIEW_USER_DATA or ADMIN).
     * - Best-effort metadata: PositionView and HealthView meta are probed via `staticcall` using SSOT selectors. Older
     *   interfaces are supported via fallback probes; missing fields may return default values.
     * - Callers SHOULD treat `positionUpdateBlocks[i] == 0` or `healthUpdateBlock == 0` as "unknown/unavailable".
     * - Uses system-scoped risk parameters from SystemRiskView (SSOT) to derive `isRisky` (no hardcoded threshold).
     *
     * @param user The user to summarize.
     * @param trackedAssets The assets to aggregate. Length must be \(\le MAX_BATCH_SIZE\).
     * @return overview Aggregated totals plus health factor validity and a derived `isRisky` flag.
     * @return positionValidFlags Per-asset validity flags as reported by PositionView (best-effort).
     * @return positionUpdateBlocks Per-asset update blockNumbers (best-effort; 0 may mean unknown).
     * @return positionVersions Per-asset cache/position versions (best-effort; 0 may mean unknown).
     * @return healthUpdateBlock HealthView blockNumber (or per HealthView semantics).
     */
    function getUserOverviewWithMeta(
        address user,
        address[] calldata trackedAssets
    )
        external
        view
        onlyValidRegistry
        onlyUserDim(user)
        returns (
            UserOverview memory overview,
            bool[] memory positionValidFlags,
            uint256[] memory positionUpdateBlocks,
            uint64[] memory positionVersions,
            uint256 healthUpdateBlock
        )
    {
        return _getUserOverviewWithMeta(user, trackedAssets);
    }

    /**
     * @notice Returns a per-asset breakdown for `assets`, including PositionView cache metadata and optional oracle
     * prices.
     * @dev Reverts if:
     *      - Registry is not configured or not a contract (see {ZeroAddress}, {NotAContract})
     *      - caller is not authorized to read `user` (see {onlyUserDim}; uses Scheme U)
     *      - caller lacks `ACTION_VIEW_PRICE_DATA` (MissingRole)
     *      - `assets.length` exceeds `ViewConstants.MAX_BATCH_SIZE` (see {BatchTooLarge})
     *      - Registry missing `ModuleKeys.KEY_POSITION_VIEW` (reverts in {Registry.getModuleOrRevert})
     *
     * Security:
     * - Role-gated via AccessControlManager.
     * - Best-effort pricing: if `PriceOracle` is not configured or `getPrice(asset)` reverts, `price` is returned as 0.
     *
     * @param user The user to query.
     * @param assets The assets to query. Length must be \(\le MAX_BATCH_SIZE\).
     * @return items Per-asset overview items (with metadata) in the same order as `assets`.
     */
    function getUserAssetBreakdown(
        address user,
        address[] calldata assets
    )
        external
        view
        onlyValidRegistry
        onlyUserDim(user)
        returns (UserAssetOverviewMeta[] memory items)
    {
        return _getUserAssetBreakdownWithMeta(user, assets);
    }

    /**
     * @notice Returns a per-asset breakdown for `assets`, including PositionView cache metadata and optional oracle
     * prices.
     * @dev Reverts if:
     *      - Registry is not configured or not a contract (see {ZeroAddress}, {NotAContract})
     *      - caller is not authorized to read `user` (see {onlyUserDim}; uses Scheme U)
     *      - caller lacks `ACTION_VIEW_PRICE_DATA` (MissingRole)
     *      - `assets.length` exceeds `ViewConstants.MAX_BATCH_SIZE` (see {BatchTooLarge})
     *      - Registry missing `ModuleKeys.KEY_POSITION_VIEW` (reverts in {Registry.getModuleOrRevert})
     *
     * Security:
     * - Role-gated via AccessControlManager.
     * - Best-effort position metadata: uses `staticcall` probes into PositionView meta APIs; older interfaces are
     *   supported.
     * - Best-effort pricing: if `PriceOracle` is not configured or `getPrice(asset)` reverts, `price` is returned as 0.
     *
     * @param user The user to query.
     * @param assets The assets to query. Length must be \(\le MAX_BATCH_SIZE\).
     * @return items Per-asset overview items (with metadata) in the same order as `assets`.
     */
    function getUserAssetBreakdownWithMeta(
        address user,
        address[] calldata assets
    )
        external
        view
        onlyValidRegistry
        onlyUserDim(user)
        returns (UserAssetOverviewMeta[] memory items)
    {
        return _getUserAssetBreakdownWithMeta(user, assets);
    }

    function _getUserOverviewWithMeta(
        address user,
        address[] calldata trackedAssets
    )
        internal
        view
        returns (
            UserOverview memory overview,
            bool[] memory positionValidFlags,
            uint256[] memory positionUpdateBlocks,
            uint64[] memory positionVersions,
            uint256 healthUpdateBlock
        )
    {
        if (trackedAssets.length > _MAX_BATCH_SIZE)
            revert BatchTooLarge(trackedAssets.length, _MAX_BATCH_SIZE);

        address pvAddr = _getModule(ModuleKeys.KEY_POSITION_VIEW);
        uint256 len = trackedAssets.length;
        positionValidFlags = new bool[](len);
        positionUpdateBlocks = new uint256[](len);
        positionVersions = new uint64[](len);

        uint256 totalColl;
        uint256 totalDebt;
        for (uint256 i; i < len; ++i) {
            (
                uint256 c,
                uint256 d,
                bool v,
                uint256 blockNumber,
                uint64 ver
            ) = _readUserPositionWithMeta(pvAddr, user, trackedAssets[i]);
            totalColl += c;
            totalDebt += d;
            positionValidFlags[i] = v;
            positionUpdateBlocks[i] = blockNumber;
            positionVersions[i] = ver;
        }

        (uint256 hf, bool hfValid, uint256 hfTs) = _readHealthFactorWithMeta(
            user
        );
        healthUpdateBlock = hfTs;

        uint256 minHf = _systemRiskView().getMinHealthFactor();
        if (minHf == 0) revert DashboardView__InvalidMinHealthFactor();
        overview = UserOverview({
            totalCollateral: totalColl,
            totalDebt: totalDebt,
            healthFactor: hf,
            healthFactorValid: hfValid,
            // SSOT: derive "risky" from system-scoped min health factor (SystemRiskView -> RiskManager).
            isRisky: hfValid ? hf < minHf : false
        });
    }

    function _getUserAssetBreakdownWithMeta(
        address user,
        address[] calldata assets
    ) internal view returns (UserAssetOverviewMeta[] memory items) {
        _requireRole(ActionKeys.ACTION_VIEW_PRICE_DATA, msg.sender);
        uint256 len = assets.length;
        if (len > _MAX_BATCH_SIZE) revert BatchTooLarge(len, _MAX_BATCH_SIZE);
        items = new UserAssetOverviewMeta[](len);

        address pvAddr = _getModule(ModuleKeys.KEY_POSITION_VIEW);
        IPriceOracleRead oracle = _priceOracle();

        for (uint256 i; i < len; ++i) {
            (
                uint256 collateral,
                uint256 debt,
                bool posValid,
                uint256 posTs,
                uint64 posVer
            ) = _readUserPositionWithMeta(pvAddr, user, assets[i]);

            uint256 price;
            if (address(oracle) != address(0)) {
                try oracle.getPrice(assets[i]) returns (
                    uint256 p,
                    uint256,
                    uint256
                ) {
                    price = p;
                } catch {
                    // Best-effort pricing: return 0 on failure.
                    price = 0;
                }
            }

            items[i] = UserAssetOverviewMeta({
                asset: assets[i],
                positionVersion: posVer,
                positionIsValid: posValid,
                positionBlockNumber: posTs,
                collateral: collateral,
                debt: debt,
                price: price
            });
        }
    }

    /*━━━━━━━━━━━━━━━ System queries ━━━━━━━━━━━━━━━*/

    /**
     * @notice Returns system-wide statistics as reported by StatisticsView.
     * @dev Reverts if:
     *      - Registry is not configured or not a contract (see {ZeroAddress}, {NotAContract})
     *      - caller lacks `ACTION_VIEW_SYSTEM_DATA` (MissingRole)
     *      - Registry missing `ModuleKeys.KEY_STATS` (reverts in {Registry.getModuleOrRevert})
     *      - StatisticsView call reverts (propagated)
     *
     * Security:
     * - Role-gated via AccessControlManager.
     * - View-only; performs an external view call into StatisticsView.
     *
     * @return overview System-wide statistics snapshot.
     */
    function getSystemOverview()
        external
        view
        onlyValidRegistry
        returns (SystemOverview memory overview)
    {
        _requireRole(ActionKeys.ACTION_VIEW_SYSTEM_DATA, msg.sender);
        (IStatisticsViewBasic.GlobalStatistics memory g, , ) = _statisticsView()
            .getGlobalStatisticsWithMeta();
        overview = SystemOverview({
            totalUsers: g.totalUsers,
            activeUsers: g.activeUsers,
            totalCollateral: g.totalCollateral,
            totalDebt: g.totalDebt,
            lastUpdateBlock: g.lastUpdateBlock
        });
    }

    /**
     * @notice Returns system-wide statistics with cache validity metadata from StatisticsView.
     * @dev Reverts if:
     *      - Registry is not configured or not a contract (see {ZeroAddress}, {NotAContract})
     *      - caller lacks `ACTION_VIEW_SYSTEM_DATA` (MissingRole)
     *      - Registry missing `ModuleKeys.KEY_STATS` (reverts in {Registry.getModuleOrRevert})
     *      - StatisticsView call reverts (propagated)
     *
     * Security:
     * - Role-gated via AccessControlManager.
     * - View-only; performs an external view call into StatisticsView.
     *
     * @return overview System-wide statistics snapshot.
     * @return isValid Cache validity as reported by StatisticsView.
     * @return blockNumber Cache update blockNumber (block.number).
     */
    function getSystemOverviewWithMeta()
        external
        view
        onlyValidRegistry
        returns (
            SystemOverview memory overview,
            bool isValid,
            uint256 blockNumber
        )
    {
        _requireRole(ActionKeys.ACTION_VIEW_SYSTEM_DATA, msg.sender);
        (
            IStatisticsViewBasic.GlobalStatistics memory g,
            bool ok,
            uint256 statsBlockNumber
        ) = _statisticsView().getGlobalStatisticsWithMeta();
        overview = SystemOverview({
            totalUsers: g.totalUsers,
            activeUsers: g.activeUsers,
            totalCollateral: g.totalCollateral,
            totalDebt: g.totalDebt,
            lastUpdateBlock: g.lastUpdateBlock
        });
        isValid = ok;
        blockNumber = statsBlockNumber;
    }

    /*━━━━━━━━━━━━━━━ Internal helpers ━━━━━━━━━━━━━━━*/

    function _healthView() internal view returns (IHealthViewBasic) {
        return IHealthViewBasic(_getModule(ModuleKeys.KEY_HEALTH_VIEW));
    }

    function _positionView() internal view returns (IPositionViewBasic) {
        return IPositionViewBasic(_getModule(ModuleKeys.KEY_POSITION_VIEW));
    }

    function _statisticsView() internal view returns (IStatisticsViewBasic) {
        return IStatisticsViewBasic(_getModule(ModuleKeys.KEY_STATS));
    }

    function _systemRiskView() internal view returns (ISystemRiskView) {
        return ISystemRiskView(_getModule(ModuleKeys.KEY_SYSTEM_RISK_VIEW));
    }

    function _priceOracle() internal view returns (IPriceOracleRead) {
        address oracle = Registry(_registryAddr).getModule(
            ModuleKeys.KEY_PRICE_ORACLE
        );
        return IPriceOracleRead(oracle);
    }

    function _getModule(bytes32 key) internal view returns (address) {
        return Registry(_registryAddr).getModuleOrRevert(key);
    }

    function _requireRole(bytes32 actionKey, address user) internal view {
        if (!ViewAccessLib.hasRole(_registryAddr, actionKey, user))
            revert MissingRole();
    }

    /*━━━━━━━━━━━━━━━ Meta passthrough helpers ━━━━━━━━━━━━━━━*/

    function _readUserPositionWithMeta(
        address pvAddr,
        address user,
        address asset
    )
        internal
        view
        returns (
            uint256 collateral,
            uint256 debt,
            bool isValid,
            uint256 blockNumber,
            uint64 version
        )
    {
        if (pvAddr == address(0)) return (0, 0, false, 0, 0);

        (bool ok, bytes memory data) = pvAddr.staticcall(
            abi.encodeWithSelector(
                _SEL_GET_USER_POSITION_WITH_META,
                user,
                asset
            )
        );
        if (ok && data.length >= 160) {
            return abi.decode(data, (uint256, uint256, bool, uint256, uint64));
        }
    }

    function _readHealthFactorWithMeta(
        address user
    )
        internal
        view
        returns (uint256 healthFactor, bool isValid, uint256 blockNumber)
    {
        address hvAddr = _getModule(ModuleKeys.KEY_HEALTH_VIEW);
        if (hvAddr == address(0)) return (0, false, 0);

        (bool ok, bytes memory data) = hvAddr.staticcall(
            abi.encodeWithSelector(_SEL_GET_USER_HEALTH_FACTOR_WITH_META, user)
        );
        if (ok && data.length >= 96) {
            return abi.decode(data, (uint256, bool, uint256));
        }
    }

    /**
     * @notice Authorizes a UUPS upgrade.
     * @dev Reverts if:
     *      - Registry is not configured or not a contract (see {ZeroAddress}, {NotAContract})
     *      - caller lacks `ACTION_ADMIN` (MissingRole)
     *      - `newImplementation` is zero (see {DashboardView__ZeroImplementation})
     *      - `newImplementation` is not a contract (see {NotAContract})
     *
     * Security:
     * - Role-gated upgrade authorization.
     *
     * @param newImplementation The new implementation contract address.
     */
    function _authorizeUpgrade(
        address newImplementation
    ) internal view override onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_ADMIN, msg.sender);
        if (newImplementation == address(0))
            revert DashboardView__ZeroImplementation();
        if (newImplementation.code.length == 0)
            revert NotAContract(newImplementation);
    }

    /// @notice Storage gap reserved for future upgrades.
    uint256[50] private __gap;

    /*━━━━━━━━━━━━━━━ Versioning ━━━━━━━━━━━━━━━*/

    /**
     * @notice Returns the API version exposed by this module.
     * @dev Reverts if: none.
     *
     * Security:
     * - Pure function; does not read state.
     *
     * @return version The API version.
     */
    function apiVersion() public pure override returns (uint256) {
        return 1;
    }

    /**
     * @notice Returns the schema version used by this module's return types.
     * @dev Reverts if: none.
     *
     * Security:
     * - Pure function; does not read state.
     *
     * @return version The schema version.
     */
    function schemaVersion() public pure override returns (uint256) {
        return 2;
    }
}
