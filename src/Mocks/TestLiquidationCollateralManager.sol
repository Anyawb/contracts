// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { RegistryQuery } from "../registry/RegistryQueryLibrary.sol";
import { ModuleKeys } from "../constants/ModuleKeys.sol";
import { LiquidationCollateralManager } from "../Vault/liquidation/modules/LiquidationCollateralManager.sol";
import { ICollateralManager } from "../interfaces/ICollateralManager.sol";
import { IRegistryDynamicModuleKey } from "../interfaces/IRegistryDynamicModuleKey.sol";
import { RegistryStorage } from "../registry/RegistryStorageLibrary.sol";
import { ZeroAddress, AmountIsZero, InsufficientCollateral } from "../errors/StandardErrors.sol";

/// @notice 测试专用的可部署实现，继承抽象的 LiquidationCollateralManager
contract TestLiquidationCollateralManager is LiquidationCollateralManager {
    /// @notice 仅测试用途：直接写入 Registry modules 映射
    function forceSetModule(bytes32 key, address value) external {
        RegistryStorage.layout().modules[key] = value;
    }

    function seizeCollateral(
        address user,
        address asset,
        uint256 amount,
        address liquidator
    ) public override returns (uint256 seizedAmount) {
        if (user == address(0) || asset == address(0) || liquidator == address(0)) revert ZeroAddress();
        if (amount == 0) revert AmountIsZero();

        uint256 available = _getAvailableCollateralForLiquidation(user, asset);
        if (available < amount) revert InsufficientCollateral();

        address collateralManager = RegistryQuery.getModule(ModuleKeys.KEY_CM);
        if (collateralManager == address(0)) revert ZeroAddress();

        ICollateralManager(collateralManager).withdrawCollateral(user, asset, amount);
        // 将扣押资产暂存到清算人名义，方便后续 transfer 测试
        ICollateralManager(collateralManager).depositCollateral(liquidator, asset, amount);

        emit LiquidationCollateralSeized(liquidator, user, asset, amount, block.timestamp);
        seizedAmount = amount;
    }

    function batchSeizeCollateral(
        address user,
        address[] calldata assets,
        uint256[] calldata amounts,
        address liquidator
    ) public override returns (uint256[] memory seizedAmounts) {
        uint256 len = assets.length;
        require(len == amounts.length, "Array length mismatch");
        seizedAmounts = new uint256[](len);
        for (uint256 i = 0; i < len; ) {
            seizedAmounts[i] = seizeCollateral(user, assets[i], amounts[i], liquidator);
            unchecked { ++i; }
        }
    }

    // View/utility functions返回默认值，供测试使用
    function getSeizableCollaterals(address) external pure override returns (address[] memory assets, uint256[] memory amounts) {
        assets = new address[](0);
        amounts = new uint256[](0);
    }

    function getUserTotalCollateralValue(address) external pure override returns (uint256 totalValue) {
        return 0;
    }

    function previewLiquidationCollateralState(address, address, uint256) external pure override returns (uint256, uint256) {
        return (0, 0);
    }

    function getUserAllLiquidationCollateralRecords(address)
        external
        pure
        override
        returns (address[] memory assets, uint256[] memory seizedAmounts, uint256[] memory lastSeizedTimes)
    {
        assets = new address[](0);
        seizedAmounts = new uint256[](0);
        lastSeizedTimes = new uint256[](0);
    }

    function batchCalculateCollateralValues(address[] calldata, uint256[] calldata amounts)
        external
        pure
        override
        returns (uint256[] memory values)
    {
        values = new uint256[](amounts.length);
    }

    // 动态模块键相关实现
    function registerDynamicModuleKey(string memory name) external override {
        // 调用实际的 RegistryDynamicModuleKey
        address dynamicRegistry = RegistryQuery.getModule(ModuleKeys.KEY_DYNAMIC_MODULE_REGISTRY);
        if (dynamicRegistry != address(0)) {
            IRegistryDynamicModuleKey(dynamicRegistry).registerModuleKey(name);
        }
    }

    function batchRegisterDynamicModuleKeys(string[] calldata names) external pure override returns (bytes32[] memory moduleKeys) {
        moduleKeys = new bytes32[](names.length);
    }

    function refreshDynamicModuleKeyCache(bytes32[] calldata) external override {
        // no-op
    }

    function clearExpiredDynamicModuleKeyCache() external override {
        // no-op
    }

    function isDynamicModuleKeyRegistered(bytes32) external pure override returns (bool) {
        return false;
    }

    function isDynamicModuleKey(bytes32) external pure override returns (bool) {
        return false;
    }

    function isValidModuleKey(bytes32) external pure override returns (bool) {
        return true;
    }

    function getDynamicModuleKeyName(bytes32) external pure override returns (string memory name) {
        return "";
    }

    function getModuleKeyByName(string calldata) external pure override returns (bytes32) {
        return bytes32(0);
    }

    function getAllDynamicModuleKeys() external pure override returns (bytes32[] memory keys) {
        keys = new bytes32[](0);
    }

    function getAllModuleKeys() external pure override returns (bytes32[] memory keys) {
        keys = new bytes32[](0);
    }

    function getTotalModuleKeyCount() external pure override returns (uint256) {
        return 0;
    }
}
