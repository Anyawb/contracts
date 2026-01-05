// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import { Registry } from "../../../registry/Registry.sol";
import { ModuleKeys } from "../../../constants/ModuleKeys.sol";
import { ActionKeys } from "../../../constants/ActionKeys.sol";
import { IAccessControlManager } from "../../../interfaces/IAccessControlManager.sol";
import { ZeroAddress } from "../../../errors/StandardErrors.sol";
import { ViewConstants } from "../ViewConstants.sol";
import { ViewVersioned } from "../ViewVersioned.sol";

interface IHealthViewLite {
    function getUserHealthFactor(address user) external view returns (uint256 healthFactor, bool isValid);
}

interface IPositionViewLite {
    function getUserPosition(address user, address asset) external view returns (uint256 collateral, uint256 debt);
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

/// @title DashboardView
/// @notice Front-end friendly aggregator that stitches data from PositionView / HealthView / StatisticsView.
/// @dev This contract stores no business state; every query delegates to authoritative view modules.
contract DashboardView is Initializable, UUPSUpgradeable, ViewVersioned {
    struct UserAssetOverview {
        address asset;
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

    uint256 private constant DEFAULT_RISK_THRESHOLD = 11_000; // 110% in bps
    uint256 private constant MAX_BATCH_SIZE = ViewConstants.MAX_BATCH_SIZE;

    address private _registryAddr;

    error DashboardView__BatchTooLarge(uint256 length, uint256 max);
    error DashboardView__ZeroImplementation();

    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address initialRegistryAddr) external initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        __UUPSUpgradeable_init();
        _registryAddr = initialRegistryAddr;
    }

    function registryAddr() external view returns (address) {
        return _registryAddr;
    }

    /* -------------------------------------------------------------------------- */
    /*                               User Queries                                */
    /* -------------------------------------------------------------------------- */

    function getUserOverview(address user, address[] calldata trackedAssets)
        external
        view
        onlyValidRegistry
        returns (UserOverview memory overview)
    {
        _requireRole(ActionKeys.ACTION_VIEW_USER_DATA, msg.sender);

        IPositionViewLite pv = _positionView();
        if (trackedAssets.length > MAX_BATCH_SIZE) revert DashboardView__BatchTooLarge(trackedAssets.length, MAX_BATCH_SIZE);
        uint256 totalColl;
        uint256 totalDebt;
        for (uint256 i; i < trackedAssets.length; ++i) {
            (uint256 c, uint256 d) = pv.getUserPosition(user, trackedAssets[i]);
            totalColl += c;
            totalDebt += d;
        }

        (uint256 hf, bool valid) = _healthView().getUserHealthFactor(user);

        overview = UserOverview({
            totalCollateral: totalColl,
            totalDebt: totalDebt,
            healthFactor: hf,
            healthFactorValid: valid,
            isRisky: valid ? hf < DEFAULT_RISK_THRESHOLD : false
        });
    }

    function getUserAssetBreakdown(address user, address[] calldata assets)
        external
        view
        onlyValidRegistry
        returns (UserAssetOverview[] memory items)
    {
        _requireRole(ActionKeys.ACTION_VIEW_USER_DATA, msg.sender);
        uint256 len = assets.length;
        if (len > MAX_BATCH_SIZE) revert DashboardView__BatchTooLarge(len, MAX_BATCH_SIZE);
        items = new UserAssetOverview[](len);
        IPositionViewLite pv = _positionView();
        IPriceOracleLite oracle = _priceOracle();

        for (uint256 i; i < len; ++i) {
            (uint256 collateral, uint256 debt) = pv.getUserPosition(user, assets[i]);
            uint256 price;
            if (address(oracle) != address(0)) {
                try oracle.getPrice(assets[i]) returns (uint256 p, uint256, uint256) { price = p; } catch {}
            }
            items[i] = UserAssetOverview({ asset: assets[i], collateral: collateral, debt: debt, price: price });
        }
    }

    /* -------------------------------------------------------------------------- */
    /*                               System Queries                              */
    /* -------------------------------------------------------------------------- */

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

    /* -------------------------------------------------------------------------- */
    /*                               Internal Helpers                            */
    /* -------------------------------------------------------------------------- */

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

    function _authorizeUpgrade(address newImplementation) internal view override onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_ADMIN, msg.sender);
        if (newImplementation == address(0)) revert DashboardView__ZeroImplementation();
    }

    /// @notice Storage gap for future upgrades
    uint256[50] private __gap;

    // ============ Versioning (C+B baseline) ============
    function apiVersion() public pure override returns (uint256) {
        return 1;
    }

    function schemaVersion() public pure override returns (uint256) {
        return 1;
    }
}
