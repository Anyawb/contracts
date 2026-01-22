// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import { Registry } from "../../../registry/Registry.sol";
import { ModuleKeys } from "../../../constants/ModuleKeys.sol";
import { ActionKeys } from "../../../constants/ActionKeys.sol";
import { IAccessControlManager } from "../../../interfaces/IAccessControlManager.sol";
import { BatchTooLarge, NotAContract, ZeroAddress } from "../../../errors/StandardErrors.sol";
import { ViewConstants } from "../ViewConstants.sol";
import { ViewVersioned } from "../ViewVersioned.sol";

/*━━━━━━━━━━━━━━━ Selector SSOT ━━━━━━━━━━━━━━━*/
// Selectors are derived from the canonical module contracts in this repository (SSOT),
// rather than hardcoding hex values or duplicating minimal interfaces in this file.
import { HealthView } from "./HealthView.sol";
import { PositionView } from "./PositionView.sol";

interface IHealthViewLite {
    function getUserHealthFactor(address user)
        external
        view
        returns (uint256 healthFactor, bool isValid, uint256 timestamp);
}

interface IPositionViewLite {
    function getUserPosition(address user, address asset)
        external
        view
        returns (uint256 collateral, uint256 debt);
}

interface IStatisticsViewLite {
    struct GlobalStatistics {
        uint256 totalUsers;
        uint256 activeUsers;
        uint256 totalCollateral;
        uint256 totalDebt;
        uint256 lastUpdateTime;
    }

    function getGlobalStatistics() external view returns (GlobalStatistics memory);
}

interface IPriceOracleLite {
    function getPrice(address asset) external view returns (uint256 price, uint256, uint256);
}

/**
 * @title DashboardView
 * @notice Frontend-friendly aggregator that stitches data from PositionView, HealthView, StatisticsView and
 * PriceOracle.
 * @dev Reverts if:
 *      - registry address is not set or invalid (see `onlyValidRegistry`)
 *
 * Security:
 * - Read-only facade: delegates to downstream modules via external calls (`staticcall` for best-effort meta probes)
 * - UUPS upgrade is role-gated via AccessControlManager (`ActionKeys.ACTION_ADMIN`)
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
        uint256 positionTimestamp;
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
        uint256 lastUpdateTime;
    }

    /*━━━━━━━━━━━━━━━ Constants ━━━━━━━━━━━━━━━*/
    /// @dev Default risk threshold in bps (1e4 = 100%).
    uint256 private constant _DEFAULT_RISK_THRESHOLD_BPS = 11_000; // 110%

    /// @dev Maximum number of items allowed in batch read calls.
    uint256 private constant _MAX_BATCH_SIZE = ViewConstants.MAX_BATCH_SIZE;

    /// @dev Function selectors for downstream `staticcall` payload encoding (derived from SSOT module contracts).
    bytes4 private constant _SEL_GET_USER_POSITION_WITH_META = PositionView.getUserPositionWithMeta.selector;
    bytes4 private constant _SEL_GET_USER_POSITION_WITH_VALIDITY = PositionView.getUserPositionWithValidity.selector;
    bytes4 private constant _SEL_GET_USER_POSITION = PositionView.getUserPosition.selector;
    bytes4 private constant _SEL_GET_POSITION_UPDATED_AT = PositionView.getPositionUpdatedAt.selector;
    bytes4 private constant _SEL_GET_POSITION_VERSION = PositionView.getPositionVersion.selector;
    bytes4 private constant _SEL_GET_USER_HEALTH_FACTOR_WITH_META = HealthView.getUserHealthFactorWithMeta.selector;

    address private _registryAddr;

    /// @dev Reverts when `newImplementation` is the zero address. Used by {_authorizeUpgrade}.
    error DashboardView__ZeroImplementation();

    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        if (_registryAddr.code.length == 0) revert NotAContract(_registryAddr);
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
        if (initialRegistryAddr.code.length == 0) revert NotAContract(initialRegistryAddr);
        __UUPSUpgradeable_init();
        _registryAddr = initialRegistryAddr;
    }

    /**
     * @notice Returns the Registry address used for module resolution.
     * @dev Reverts if: none.
     *
     * Security:
     * - Read-only.
     *
     * @return registry The Registry contract address.
     */
    function registryAddr() external view returns (address) {
        return _registryAddr;
    }

    /*━━━━━━━━━━━━━━━ User queries ━━━━━━━━━━━━━━━*/

    /**
     * @notice Returns an aggregated user overview over `trackedAssets`, including health factor and a derived `isRisky`
     * flag.
     * @dev Reverts if:
     *      - Registry is not configured or not a contract (see {ZeroAddress}, {NotAContract})
     *      - caller lacks `ACTION_VIEW_USER_DATA` (reverts in {IAccessControlManager.requireRole})
     *      - caller lacks `ACTION_VIEW_RISK_DATA` (reverts in {IAccessControlManager.requireRole})
     *      - `trackedAssets.length` exceeds `ViewConstants.MAX_BATCH_SIZE` (see {BatchTooLarge})
     *      - Registry missing `ModuleKeys.KEY_POSITION_VIEW` or `ModuleKeys.KEY_HEALTH_VIEW`
     *        (reverts in {Registry.getModuleOrRevert})
     *      - PositionView/HealthView call reverts (propagated)
     *
     * Security:
     * - Role-gated via AccessControlManager.
     * - Read-only; performs external view calls into PositionView and HealthView.
     *
     * @param user The user to summarize.
     * @param trackedAssets The assets to aggregate. Length must be \(\le MAX_BATCH_SIZE\).
     * @return overview Aggregated totals plus health factor validity and a derived `isRisky` flag.
     */
    function getUserOverview(address user, address[] calldata trackedAssets)
        external
        view
        onlyValidRegistry
        returns (UserOverview memory overview)
    {
        // Mix of user-scoped positions (USER_DATA) + health factor (RISK_DATA).
        _requireRole(ActionKeys.ACTION_VIEW_USER_DATA, msg.sender);
        _requireRole(ActionKeys.ACTION_VIEW_RISK_DATA, msg.sender);

        IPositionViewLite pv = _positionView();
        if (trackedAssets.length > _MAX_BATCH_SIZE) revert BatchTooLarge(trackedAssets.length, _MAX_BATCH_SIZE);
        uint256 totalColl;
        uint256 totalDebt;
        for (uint256 i; i < trackedAssets.length; ++i) {
            (uint256 c, uint256 d) = pv.getUserPosition(user, trackedAssets[i]);
            totalColl += c;
            totalDebt += d;
        }

        (uint256 hf, bool valid, ) = _healthView().getUserHealthFactor(user);

        overview = UserOverview({
            totalCollateral: totalColl,
            totalDebt: totalDebt,
            healthFactor: hf,
            healthFactorValid: valid,
            isRisky: valid ? hf < _DEFAULT_RISK_THRESHOLD_BPS : false
        });
    }

    /**
     * @notice Returns an aggregated user overview over `trackedAssets`, plus per-asset PositionView cache metadata and
     * a HealthView timestamp.
     * @dev Reverts if:
     *      - Registry is not configured or not a contract (see {ZeroAddress}, {NotAContract})
     *      - caller lacks `ACTION_VIEW_USER_DATA` (reverts in {IAccessControlManager.requireRole})
     *      - caller lacks `ACTION_VIEW_RISK_DATA` (reverts in {IAccessControlManager.requireRole})
     *      - `trackedAssets.length` exceeds `ViewConstants.MAX_BATCH_SIZE` (see {BatchTooLarge})
     *      - Registry missing `ModuleKeys.KEY_POSITION_VIEW` or `ModuleKeys.KEY_HEALTH_VIEW`
     *        (reverts in {Registry.getModuleOrRevert})
     *
     * Security:
     * - Role-gated via AccessControlManager.
     * - Best-effort metadata: PositionView and HealthView meta are probed via `staticcall` using SSOT selectors. Older
     *   interfaces are supported via fallback probes; missing fields may return default values.
     * - Callers SHOULD treat `positionTimestamps[i] == 0` or `healthTimestamp == 0` as "unknown/unavailable".
     *
     * @param user The user to summarize.
     * @param trackedAssets The assets to aggregate. Length must be \(\le MAX_BATCH_SIZE\).
     * @return overview Aggregated totals plus health factor validity and a derived `isRisky` flag.
     * @return positionValidFlags Per-asset validity flags as reported by PositionView (best-effort).
     * @return positionTimestamps Per-asset update timestamps in seconds (best-effort; 0 may mean unknown).
     * @return positionVersions Per-asset cache/position versions (best-effort; 0 may mean unknown).
     * @return healthTimestamp HealthView timestamp in seconds (or per HealthView semantics).
     */
    function getUserOverviewWithMeta(address user, address[] calldata trackedAssets)
        external
        view
        onlyValidRegistry
        returns (
            UserOverview memory overview,
            bool[] memory positionValidFlags,
            uint256[] memory positionTimestamps,
            uint64[] memory positionVersions,
            uint256 healthTimestamp
        )
    {
        // Mix of user-scoped positions (USER_DATA) + health factor (RISK_DATA).
        _requireRole(ActionKeys.ACTION_VIEW_USER_DATA, msg.sender);
        _requireRole(ActionKeys.ACTION_VIEW_RISK_DATA, msg.sender);
        if (trackedAssets.length > _MAX_BATCH_SIZE) revert BatchTooLarge(trackedAssets.length, _MAX_BATCH_SIZE);

        address pvAddr = _getModule(ModuleKeys.KEY_POSITION_VIEW);
        uint256 len = trackedAssets.length;
        positionValidFlags = new bool[](len);
        positionTimestamps = new uint256[](len);
        positionVersions = new uint64[](len);

        uint256 totalColl;
        uint256 totalDebt;
        for (uint256 i; i < len; ++i) {
            (uint256 c, uint256 d, bool v, uint256 ts, uint64 ver) =
                _readUserPositionWithMeta(pvAddr, user, trackedAssets[i]);
            totalColl += c;
            totalDebt += d;
            positionValidFlags[i] = v;
            positionTimestamps[i] = ts;
            positionVersions[i] = ver;
        }

        (uint256 hf, bool hfValid, uint256 hfTs) = _readHealthFactorWithMeta(user);
        healthTimestamp = hfTs;
        overview = UserOverview({
            totalCollateral: totalColl,
            totalDebt: totalDebt,
            healthFactor: hf,
            healthFactorValid: hfValid,
            isRisky: hfValid ? hf < _DEFAULT_RISK_THRESHOLD_BPS : false
        });
    }

    /**
     * @notice Returns a per-asset breakdown for `assets`, including PositionView values and optional oracle prices.
     * @dev Reverts if:
     *      - Registry is not configured or not a contract (see {ZeroAddress}, {NotAContract})
     *      - caller lacks `ACTION_VIEW_USER_DATA` (reverts in {IAccessControlManager.requireRole})
     *      - caller lacks `ACTION_VIEW_PRICE_DATA` (reverts in {IAccessControlManager.requireRole})
     *      - `assets.length` exceeds `ViewConstants.MAX_BATCH_SIZE` (see {BatchTooLarge})
     *      - Registry missing `ModuleKeys.KEY_POSITION_VIEW` (reverts in {Registry.getModuleOrRevert})
     *      - PositionView call reverts (propagated)
     *
     * Security:
     * - Role-gated via AccessControlManager.
     * - Best-effort pricing: if `PriceOracle` is not configured or `getPrice(asset)` reverts, `price` is returned as 0.
     *   Callers SHOULD treat `price == 0` as "unknown/unavailable" (oracle precision/units are oracle-defined).
     *
     * @param user The user to query.
     * @param assets The assets to query. Length must be \(\le MAX_BATCH_SIZE\).
     * @return items Per-asset overview items in the same order as `assets`.
     */
    function getUserAssetBreakdown(address user, address[] calldata assets)
        external
        view
        onlyValidRegistry
        returns (UserAssetOverview[] memory items)
    {
        // Mix of user-scoped positions (USER_DATA) + prices (PRICE_DATA).
        _requireRole(ActionKeys.ACTION_VIEW_USER_DATA, msg.sender);
        _requireRole(ActionKeys.ACTION_VIEW_PRICE_DATA, msg.sender);
        uint256 len = assets.length;
        if (len > _MAX_BATCH_SIZE) revert BatchTooLarge(len, _MAX_BATCH_SIZE);
        items = new UserAssetOverview[](len);
        IPositionViewLite pv = _positionView();
        IPriceOracleLite oracle = _priceOracle();

        for (uint256 i; i < len; ++i) {
            (uint256 collateral, uint256 debt) = pv.getUserPosition(user, assets[i]);
            uint256 price;
            if (address(oracle) != address(0)) {
                try oracle.getPrice(assets[i]) returns (uint256 p, uint256, uint256) {
                    price = p;
                } catch {
                    // Best-effort pricing: return 0 on failure.
                    price = 0;
                }
            }
            items[i] = UserAssetOverview({ asset: assets[i], collateral: collateral, debt: debt, price: price });
        }
    }

    /**
     * @notice Returns a per-asset breakdown for `assets`, including PositionView cache metadata and optional oracle
     * prices.
     * @dev Reverts if:
     *      - Registry is not configured or not a contract (see {ZeroAddress}, {NotAContract})
     *      - caller lacks `ACTION_VIEW_USER_DATA` (reverts in {IAccessControlManager.requireRole})
     *      - caller lacks `ACTION_VIEW_PRICE_DATA` (reverts in {IAccessControlManager.requireRole})
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
    function getUserAssetBreakdownWithMeta(address user, address[] calldata assets)
        external
        view
        onlyValidRegistry
        returns (UserAssetOverviewMeta[] memory items)
    {
        // Mix of user-scoped positions (USER_DATA) + prices (PRICE_DATA).
        _requireRole(ActionKeys.ACTION_VIEW_USER_DATA, msg.sender);
        _requireRole(ActionKeys.ACTION_VIEW_PRICE_DATA, msg.sender);
        uint256 len = assets.length;
        if (len > _MAX_BATCH_SIZE) revert BatchTooLarge(len, _MAX_BATCH_SIZE);
        items = new UserAssetOverviewMeta[](len);

        address pvAddr = _getModule(ModuleKeys.KEY_POSITION_VIEW);
        IPriceOracleLite oracle = _priceOracle();

        for (uint256 i; i < len; ++i) {
            (uint256 collateral, uint256 debt, bool posValid, uint256 posTs, uint64 posVer) =
                _readUserPositionWithMeta(pvAddr, user, assets[i]);

            uint256 price;
            if (address(oracle) != address(0)) {
                try oracle.getPrice(assets[i]) returns (uint256 p, uint256, uint256) {
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
                positionTimestamp: posTs,
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
     *      - caller lacks `ACTION_VIEW_SYSTEM_DATA` (reverts in {IAccessControlManager.requireRole})
     *      - Registry missing `ModuleKeys.KEY_STATS` (reverts in {Registry.getModuleOrRevert})
     *      - StatisticsView call reverts (propagated)
     *
     * Security:
     * - Role-gated via AccessControlManager.
     * - Read-only; performs an external view call into StatisticsView.
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
        IStatisticsViewLite.GlobalStatistics memory g = _statisticsView().getGlobalStatistics();
        overview = SystemOverview({
            totalUsers: g.totalUsers,
            activeUsers: g.activeUsers,
            totalCollateral: g.totalCollateral,
            totalDebt: g.totalDebt,
            lastUpdateTime: g.lastUpdateTime
        });
    }

    /*━━━━━━━━━━━━━━━ Internal helpers ━━━━━━━━━━━━━━━*/

    function _healthView() internal view returns (IHealthViewLite) {
        return IHealthViewLite(_getModule(ModuleKeys.KEY_HEALTH_VIEW));
    }

    function _positionView() internal view returns (IPositionViewLite) {
        return IPositionViewLite(_getModule(ModuleKeys.KEY_POSITION_VIEW));
    }

    function _statisticsView() internal view returns (IStatisticsViewLite) {
        return IStatisticsViewLite(_getModule(ModuleKeys.KEY_STATS));
    }

    function _priceOracle() internal view returns (IPriceOracleLite) {
        address oracle = Registry(_registryAddr).getModule(ModuleKeys.KEY_PRICE_ORACLE);
        return IPriceOracleLite(oracle);
    }

    function _getModule(bytes32 key) internal view returns (address) {
        return Registry(_registryAddr).getModuleOrRevert(key);
    }

    function _requireRole(bytes32 actionKey, address user) internal view {
        address acmAddr = _getModule(ModuleKeys.KEY_ACCESS_CONTROL);
        IAccessControlManager(acmAddr).requireRole(actionKey, user);
    }

    /*━━━━━━━━━━━━━━━ Meta passthrough helpers ━━━━━━━━━━━━━━━*/

    function _readUserPositionWithMeta(address pvAddr, address user, address asset)
        internal
        view
        returns (uint256 collateral, uint256 debt, bool isValid, uint256 timestamp, uint64 version)
    {
        if (pvAddr == address(0)) return (0, 0, false, 0, 0);

        // Prefer the unified meta API.
        (bool ok, bytes memory data) =
            pvAddr.staticcall(abi.encodeWithSelector(_SEL_GET_USER_POSITION_WITH_META, user, asset));
        if (ok && data.length >= 160) {
            return abi.decode(data, (uint256, uint256, bool, uint256, uint64));
        }

        // Backward compatible fallback: validity + timestamp/version best-effort.
        (ok, data) = pvAddr.staticcall(
            abi.encodeWithSelector(_SEL_GET_USER_POSITION_WITH_VALIDITY, user, asset)
        );
        if (ok && data.length >= 96) {
            (collateral, debt, isValid) = abi.decode(data, (uint256, uint256, bool));
        } else {
            (ok, data) = pvAddr.staticcall(abi.encodeWithSelector(_SEL_GET_USER_POSITION, user, asset));
            if (ok && data.length >= 64) (collateral, debt) = abi.decode(data, (uint256, uint256));
        }

        (ok, data) = pvAddr.staticcall(abi.encodeWithSelector(_SEL_GET_POSITION_UPDATED_AT, user, asset));
        if (ok && data.length >= 32) timestamp = abi.decode(data, (uint256));

        (ok, data) = pvAddr.staticcall(abi.encodeWithSelector(_SEL_GET_POSITION_VERSION, user, asset));
        if (ok && data.length >= 32) version = abi.decode(data, (uint64));
    }

    function _readHealthFactorWithMeta(address user)
        internal
        view
        returns (uint256 healthFactor, bool isValid, uint256 timestamp)
    {
        address hvAddr = _getModule(ModuleKeys.KEY_HEALTH_VIEW);
        if (hvAddr == address(0)) return (0, false, 0);

        // Prefer the unified meta API.
        (bool ok, bytes memory data) =
            hvAddr.staticcall(abi.encodeWithSelector(_SEL_GET_USER_HEALTH_FACTOR_WITH_META, user));
        if (ok && data.length >= 96) {
            return abi.decode(data, (uint256, bool, uint256));
        }

        // Backward compatible fallback: call the canonical API directly.
        (healthFactor, isValid, timestamp) = _healthView().getUserHealthFactor(user);
    }

    /**
     * @notice Authorizes a UUPS upgrade.
     * @dev Reverts if:
     *      - Registry is not configured or not a contract (see {ZeroAddress}, {NotAContract})
     *      - caller lacks `ACTION_ADMIN` (reverts in {IAccessControlManager.requireRole})
     *      - `newImplementation` is zero (see {DashboardView__ZeroImplementation})
     *      - `newImplementation` is not a contract (see {NotAContract})
     *
     * Security:
     * - Role-gated upgrade authorization.
     *
     * @param newImplementation The new implementation contract address.
     */
    function _authorizeUpgrade(address newImplementation) internal view override onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_ADMIN, msg.sender);
        if (newImplementation == address(0)) revert DashboardView__ZeroImplementation();
        if (newImplementation.code.length == 0) revert NotAContract(newImplementation);
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
