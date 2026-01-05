// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import { Registry } from "../../../registry/Registry.sol";
import { ModuleKeys } from "../../../constants/ModuleKeys.sol";
import { ActionKeys } from "../../../constants/ActionKeys.sol";
import { IAccessControlManager } from "../../../interfaces/IAccessControlManager.sol";
import { ZeroAddress, EmptyArray, ArrayLengthMismatch } from "../../../errors/StandardErrors.sol";
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

/// @title CacheOptimizedView
/// @notice 轻量级、零写入的查询门面：仅负责把请求转发到已有 View，再将数据封装成前端友好的结构。
/// @dev 不持久化任何业务状态；所有数据均来源于 PositionView / HealthView / StatisticsView。
contract CacheOptimizedView is Initializable, UUPSUpgradeable, ViewVersioned {
    uint256 private constant MAX_BATCH_SIZE = ViewConstants.MAX_BATCH_SIZE;

    address private _registryAddr;

    error CacheOptimizedView__BatchTooLarge(uint256 length, uint256 max);
    error CacheOptimizedView__ZeroImplementation();

    struct UserPositionItem {
        address user;
        address asset;
        uint256 collateral;
        uint256 debt;
    }

    struct UserSummary {
        uint256 totalCollateral;
        uint256 totalDebt;
        uint256 healthFactor;
        bool cacheValid;
    }

    struct SystemStats {
        uint256 totalUsers;
        uint256 activeUsers;
        uint256 totalCollateral;
        uint256 totalDebt;
        uint256 lastUpdateTime;
    }

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

    function getUserHealthFactor(address user)
        external
        view
        onlyValidRegistry
        returns (uint256 healthFactor, bool cacheValid)
    {
        _requireRole(ActionKeys.ACTION_VIEW_USER_DATA, msg.sender);
        return _healthView().getUserHealthFactor(user);
    }

    function batchGetUserHealthFactors(address[] calldata users)
        external
        view
        onlyValidRegistry
        returns (uint256[] memory factors, bool[] memory validFlags)
    {
        _requireRole(ActionKeys.ACTION_VIEW_USER_DATA, msg.sender);
        uint256 len = users.length;
        _validateBatchLength(len);

        IHealthViewLite hv = _healthView();
        factors = new uint256[](len);
        validFlags = new bool[](len);
        for (uint256 i; i < len; ++i) {
            (uint256 hf, bool ok) = hv.getUserHealthFactor(users[i]);
            factors[i] = hf;
            validFlags[i] = ok;
        }
    }

    function batchGetUserPositions(address[] calldata users, address[] calldata assets)
        external
        view
        onlyValidRegistry
        returns (UserPositionItem[] memory positions)
    {
        _requireRole(ActionKeys.ACTION_VIEW_USER_DATA, msg.sender);
        uint256 len = users.length;
        if (len == 0) revert EmptyArray();
        if (len != assets.length) revert ArrayLengthMismatch(len, assets.length);
        _validateBatchLength(len);

        IPositionViewLite pv = _positionView();
        positions = new UserPositionItem[](len);
        for (uint256 i; i < len; ++i) {
            (uint256 collateral, uint256 debt) = pv.getUserPosition(users[i], assets[i]);
            positions[i] = UserPositionItem({ user: users[i], asset: assets[i], collateral: collateral, debt: debt });
        }
    }

    function getUserSummary(address user, address[] calldata trackedAssets)
        external
        view
        onlyValidRegistry
        returns (UserSummary memory summary)
    {
        _requireRole(ActionKeys.ACTION_VIEW_USER_DATA, msg.sender);
        IHealthViewLite hv = _healthView();
        (summary.healthFactor, summary.cacheValid) = hv.getUserHealthFactor(user);

        IPositionViewLite pv = _positionView();
        uint256 totalCollateral;
        uint256 totalDebt;
        for (uint256 i; i < trackedAssets.length; ++i) {
            (uint256 collateral, uint256 debt) = pv.getUserPosition(user, trackedAssets[i]);
            totalCollateral += collateral;
            totalDebt += debt;
        }
        summary.totalCollateral = totalCollateral;
        summary.totalDebt = totalDebt;
    }

    /* -------------------------------------------------------------------------- */
    /*                               System Queries                              */
    /* -------------------------------------------------------------------------- */

    function getSystemStats()
        external
        view
        onlyValidRegistry
        returns (SystemStats memory stats)
    {
        _requireRole(ActionKeys.ACTION_VIEW_SYSTEM_DATA, msg.sender);
        IStatisticsViewLite.GlobalStatistics memory g = _statisticsView().getGlobalStatistics();
        stats = SystemStats({
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

    function _getModule(bytes32 key) internal view returns (address) {
        return Registry(_registryAddr).getModuleOrRevert(key);
    }

    function _acm() internal view returns (address) {
        return _getModule(ModuleKeys.KEY_ACCESS_CONTROL);
    }

    function _requireRole(bytes32 actionKey, address user) internal view {
        IAccessControlManager(_acm()).requireRole(actionKey, user);
    }

    function _validateBatchLength(uint256 len) internal pure {
        if (len == 0) revert EmptyArray();
        if (len > MAX_BATCH_SIZE) revert CacheOptimizedView__BatchTooLarge(len, MAX_BATCH_SIZE);
    }

    function _authorizeUpgrade(address newImplementation) internal view override onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_ADMIN, msg.sender);
        if (newImplementation == address(0)) revert CacheOptimizedView__ZeroImplementation();
    }

    // ============ Versioning (C+B baseline) ============
    function apiVersion() public pure override returns (uint256) {
        return 1;
    }

    function schemaVersion() public pure override returns (uint256) {
        return 1;
    }

    /// @notice Storage gap for future upgrades
    uint256[50] private __gap;
}
