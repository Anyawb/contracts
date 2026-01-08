// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import { LiquidationRiskLib } from "../../liquidation/libraries/LiquidationRiskLib.sol";
import { ILiquidationRiskManager } from "../../../interfaces/ILiquidationRiskManager.sol";
import { Registry } from "../../../registry/Registry.sol";
import { ModuleKeys } from "../../../constants/ModuleKeys.sol";
import { ActionKeys } from "../../../constants/ActionKeys.sol";
import { ViewConstants } from "../ViewConstants.sol";
import { ViewAccessLib } from "../../../libraries/ViewAccessLib.sol";
import { ArrayLengthMismatch, EmptyArray, ZeroAddress } from "../../../errors/StandardErrors.sol";
import { ViewVersioned } from "../ViewVersioned.sol";

/// @dev Minimal HealthView interface (read-only).
interface IHealthViewLite {
    function getUserHealthFactor(address user) external view returns (uint256 healthFactor, bool isValid);
    function getCacheTimestamp(address user) external view returns (uint256);
    function batchGetHealthFactors(address[] calldata users)
        external
        view
        returns (uint256[] memory factors, bool[] memory validFlags);
}

/// @title LiquidationRiskView
/// @notice 清算风险只读视图：批量风险计算 + 健康因子缓存读取，遵循双架构只读规范
contract LiquidationRiskView is Initializable, UUPSUpgradeable, ViewVersioned {
    // ============ Errors ============
    error LiquidationRiskView__BatchTooLarge();

    // ============ Storage ============
    address private _registryAddr;

    // ============ Modifiers ============
    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        _;
    }

    modifier onlyRiskViewerSystem() {
        ViewAccessLib.requireRole(_registryAddr, ActionKeys.ACTION_VIEW_RISK_DATA, msg.sender);
        _;
    }

    modifier onlyRiskViewerFor(address user) {
        if (msg.sender != user) {
            ViewAccessLib.requireRole(_registryAddr, ActionKeys.ACTION_VIEW_RISK_DATA, msg.sender);
        }
        _;
    }

    // ============ Initializer ============
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address initialRegistryAddr) external initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        __UUPSUpgradeable_init();
        _registryAddr = initialRegistryAddr;
    }

    // ============ Pure helpers ============
    /// @notice 批量计算健康因子（bps），纯函数
    function batchCalculateHealthFactors(
        uint256[] calldata collaterals,
        uint256[] calldata debts
    ) external pure returns (uint256[] memory healthFactors) {
        uint256 len = collaterals.length;
        if (len != debts.length) revert ArrayLengthMismatch(len, debts.length);
        healthFactors = new uint256[](len);
        for (uint256 i; i < len; ) {
            healthFactors[i] = LiquidationRiskLib.calculateHealthFactor(collaterals[i], debts[i]);
            unchecked { ++i; }
        }
    }

    // ============ Read APIs ============
    /// @notice 获取健康因子缓存 + blockNumber；若无缓存返回全零
    function getHealthFactorCacheWithBlock(address user)
        external
        view
        onlyValidRegistry
        onlyRiskViewerFor(user)
        returns (uint256 healthFactor, uint256 timestamp, uint256 blockNumber)
    {
        (uint256 hf, bool valid) = _hv().getUserHealthFactor(user);
        uint256 ts = _hv().getCacheTimestamp(user);
        if (hf == 0 || !valid || ts == 0) {
            return (0, 0, 0);
        }
        return (hf, ts, block.number);
    }

    /// @notice 检查用户是否可被清算（基于缓存/实时评估）
    function isLiquidatable(address user) external view onlyValidRegistry onlyRiskViewerFor(user) returns (bool) {
        return _rm().isLiquidatable(user);
    }

    /// @notice 检查特定抵押/债务/资产的可清算性（即时计算）
    function isLiquidatable(
        address user,
        uint256 collateral,
        uint256 debt,
        address asset
    ) external view onlyValidRegistry onlyRiskViewerFor(user) returns (bool) {
        return _rm().isLiquidatable(user, collateral, debt, asset);
    }

    /// @notice 获取用户清算风险评分
    function getLiquidationRiskScore(address user) external view onlyValidRegistry onlyRiskViewerFor(user) returns (uint256) {
        return _rm().getLiquidationRiskScore(user);
    }

    /// @notice 获取用户健康因子
    function getUserHealthFactor(address user) external view onlyValidRegistry onlyRiskViewerFor(user) returns (uint256) {
        (uint256 hf, bool valid) = _hv().getUserHealthFactor(user);
        return valid ? hf : 0;
    }

    /// @notice 批量检查是否可清算
    function batchIsLiquidatable(address[] calldata users)
        external
        view
        onlyValidRegistry
        onlyRiskViewerSystem
        returns (bool[] memory)
    {
        uint256 len = users.length;
        if (len == 0) revert EmptyArray();
        if (len > ViewConstants.MAX_BATCH_SIZE) revert LiquidationRiskView__BatchTooLarge();
        return _rm().batchIsLiquidatable(users);
    }

    /// @notice 批量获取健康因子
    function batchGetUserHealthFactors(address[] calldata users)
        external
        view
        onlyValidRegistry
        onlyRiskViewerSystem
        returns (uint256[] memory)
    {
        uint256 len = users.length;
        if (len == 0) revert EmptyArray();
        if (len > ViewConstants.MAX_BATCH_SIZE) revert LiquidationRiskView__BatchTooLarge();
        (uint256[] memory factors, bool[] memory flags) = _hv().batchGetHealthFactors(users);
        uint256[] memory out = new uint256[](len);
        for (uint256 i; i < len; ++i) {
            out[i] = flags[i] ? factors[i] : 0;
        }
        return out;
    }

    /// @notice 批量获取清算风险评分
    function batchGetLiquidationRiskScores(address[] calldata users)
        external
        view
        onlyValidRegistry
        onlyRiskViewerSystem
        returns (uint256[] memory)
    {
        uint256 len = users.length;
        if (len == 0) revert EmptyArray();
        if (len > ViewConstants.MAX_BATCH_SIZE) revert LiquidationRiskView__BatchTooLarge();
        return _rm().batchGetLiquidationRiskScores(users);
    }

    /// @notice 获取清算阈值（bps）
    function getLiquidationThreshold() external view onlyValidRegistry onlyRiskViewerSystem returns (uint256) {
        return _rm().getLiquidationThreshold();
    }

    /// @notice 获取最小健康因子（bps）
    function getMinHealthFactor() external view onlyValidRegistry onlyRiskViewerSystem returns (uint256) {
        return _rm().getMinHealthFactor();
    }

    /// @notice 获取健康因子缓存
    function getHealthFactorCache(address user)
        external
        view
        onlyValidRegistry
        onlyRiskViewerFor(user)
        returns (uint256 healthFactor, uint256 timestamp)
    {
        (uint256 hf, ) = _hv().getUserHealthFactor(user);
        uint256 ts = _hv().getCacheTimestamp(user);
        return (hf, ts);
    }

    /// @notice 返回 Registry 地址（首选接口）
    function getRegistry() external view returns (address) {
        return _registryAddr;
    }

    /// @notice 兼容旧版 getter
    function registryAddr() external view returns (address) {
        return _registryAddr;
    }

    // ============ Internal helpers ============
    function _rm() internal view returns (ILiquidationRiskManager) {
        address rm = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_LIQUIDATION_RISK_MANAGER);
        return ILiquidationRiskManager(rm);
    }

    function _hv() internal view returns (IHealthViewLite) {
        address hv = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_HEALTH_VIEW);
        return IHealthViewLite(hv);
    }

    // ============ UUPS ============
    function _authorizeUpgrade(address newImplementation) internal view override onlyValidRegistry {
        ViewAccessLib.requireRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender);
        if (newImplementation == address(0)) revert ZeroAddress();
    }

    // ============ Versioning (C+B baseline) ============
    function apiVersion() public pure override returns (uint256) {
        return 1;
    }

    function schemaVersion() public pure override returns (uint256) {
        return 1;
    }

    uint256[50] private __gap;
}
