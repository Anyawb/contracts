// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { BaseServiceConfig } from "../BaseServiceConfig.sol";
import { RewardTypes } from "../RewardTypes.sol";
import { ActionKeys } from "../../constants/ActionKeys.sol";
import { VaultTypes } from "../../Vault/VaultTypes.sol";

/// @title FeatureUnlockConfig - 功能解锁配置
/// @notice 管理功能解锁服务的配置和价格
/// @dev 继承BaseServiceConfig，实现功能解锁服务的具体配置
/// @dev 与 Registry 系统完全集成，使用标准化的模块管理
contract FeatureUnlockConfig is BaseServiceConfig {
    
    // ============ 事件定义 ============
    
    /// @notice Registry 地址更新事件
    /// @dev 记录 Registry 地址的变更
    event RegistryUpdated(address indexed oldRegistry, address indexed newRegistry);
    
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }
    
    /// @notice 初始化合约
    /// @param initialRegistryAddr Registry 合约地址
    function initialize(address initialRegistryAddr) external override initializer {
        super._initialize(initialRegistryAddr);
    }
    
    /// @dev 初始化功能解锁配置
    function _initializeConfigs() internal override {
        configs[ServiceLevel.Basic] = ServiceConfig({
            price: 200e18, // 200积分
            duration: 30 days,
            isActive: true,
            level: ServiceLevel.Basic,
            description: "Custom interest rate calculator"
        });
        
        configs[ServiceLevel.Standard] = ServiceConfig({
            price: 800e18, // 800积分
            duration: 30 days,
            isActive: true,
            level: ServiceLevel.Standard,
            description: "Batch operation tools"
        });
        
        configs[ServiceLevel.Premium] = ServiceConfig({
            price: 1500e18, // 1500积分
            duration: 30 days,
            isActive: true,
            level: ServiceLevel.Premium,
            description: "Advanced risk management tools"
        });
        
        configs[ServiceLevel.VIP] = ServiceConfig({
            price: 3000e18, // 3000积分
            duration: 30 days,
            isActive: true,
            level: ServiceLevel.VIP,
            description: "Full feature unlock"
        });
    }
    
    /// @dev 初始化冷却期
    function _initializeCooldown() internal override {
        cooldown = 7 days;
    }
    
    /// @notice 获取服务类型
    /// @return serviceType 服务类型
    function getServiceType() external pure override returns (ServiceType) {
        return ServiceType.FeatureUnlock;
    }
    
    // ============ Registry 管理 ============
    
    /// @notice 更新 Registry 地址
    /// @param newRegistryAddr 新的 Registry 地址
    /// @dev 需要 ACTION_SET_PARAMETER 权限
    function updateRegistry(address newRegistryAddr) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        
        if (newRegistryAddr == address(0)) revert("Invalid registry address");
        
        address oldRegistry = registryAddr;
        registryAddr = newRegistryAddr;
        
        emit RegistryUpdated(oldRegistry, newRegistryAddr);
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
    }
    
    /// @notice 获取 Registry 地址
    /// @return registryAddr Registry 地址
    function getRegistry() external view override returns (address) {
        return registryAddr;
    }
} 