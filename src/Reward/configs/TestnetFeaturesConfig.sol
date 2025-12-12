// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { BaseServiceConfig } from "../BaseServiceConfig.sol";
import { RewardTypes } from "../RewardTypes.sol";
import { ActionKeys } from "../../constants/ActionKeys.sol";
import { ModuleKeys } from "../../constants/ModuleKeys.sol";
import { IAccessControlManager } from "../../interfaces/IAccessControlManager.sol";
import { IRegistry } from "../../interfaces/IRegistry.sol";
import { VaultTypes } from "../../Vault/VaultTypes.sol";

/// @title TestnetFeaturesConfig - 测试网功能配置
/// @notice 管理测试网功能的配置和价格，提供测试网环境下的特殊功能权限
/// @dev 继承BaseServiceConfig，实现测试网功能的具体配置
/// @dev 集成ACM权限控制系统，确保配置操作的安全性
/// @dev 对应ModuleKeys.KEY_TESTNET_FEATURES_CONFIG模块
/// @dev 与 Registry 系统完全集成，使用标准化的模块管理
/// @dev 支持ActionKeys中的权限验证：
///      - ACTION_SET_PARAMETER: 配置更新权限
///      - ACTION_UPGRADE_MODULE: 合约升级权限
///      - ACTION_CONSUME_POINTS: 积分消费权限
///      - ACTION_UPGRADE_SERVICE: 服务升级权限
///      - ACTION_TESTNET_CONFIG: 测试网功能配置权限
///      - ACTION_TESTNET_ACTIVATE: 测试网功能激活权限
///      - ACTION_TESTNET_PAUSE: 测试网功能暂停权限
/// @custom:security-contact security@example.com
contract TestnetFeaturesConfig is BaseServiceConfig {
    
    // ============ 事件定义 ============
    
    /// @notice 测试网功能配置初始化事件
    /// @param acmAddr ACM权限管理合约地址
    /// @param timestamp 初始化时间戳
    event TestnetFeaturesConfigInitialized(
        address indexed acmAddr,
        uint256 timestamp
    );
    
    /// @notice 测试网功能配置更新事件
    /// @param level 服务等级
    /// @param oldPrice 旧价格
    /// @param newPrice 新价格
    /// @param oldDuration 旧持续时间
    /// @param newDuration 新持续时间
    /// @param updatedBy 更新者地址
    /// @param timestamp 更新时间戳
    event TestnetFeaturesConfigUpdated(
        ServiceLevel indexed level,
        uint256 oldPrice,
        uint256 newPrice,
        uint256 oldDuration,
        uint256 newDuration,
        address indexed updatedBy,
        uint256 timestamp
    );
    
    /// @notice 测试网功能冷却期更新事件
    /// @param oldCooldown 旧冷却期
    /// @param newCooldown 新冷却期
    /// @param updatedBy 更新者地址
    /// @param timestamp 更新时间戳
    event TestnetFeaturesCooldownUpdated(
        uint256 oldCooldown,
        uint256 newCooldown,
        address indexed updatedBy,
        uint256 timestamp
    );
    
    /// @notice Registry 地址更新事件
    /// @dev 记录 Registry 地址的变更
    event RegistryUpdated(address indexed oldRegistry, address indexed newRegistry);
    
    // ============ 状态变量 ============
    
    /// @notice 测试网功能配置版本
    /// @dev 用于版本控制和升级追踪
    uint256 public configVersion;
    
    /// @notice 最后配置更新时间
    /// @dev 用于审计和监控
    uint256 public lastConfigUpdateTime;
    
    /// @notice 配置更新者记录
    /// @dev 记录最后一次配置更新的操作者
    address public lastConfigUpdater;
    
    // ============ 构造函数 ============
    
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }
    
    // ============ 初始化函数 ============
    
    /// @notice 初始化合约
    /// @param initialRegistryAddr Registry 合约地址
    /// @dev 初始化测试网功能配置和冷却期
    function initialize(address initialRegistryAddr) external override initializer {
        // 调用父类初始化
        super._initialize(initialRegistryAddr);
        
        // 初始化版本信息
        configVersion = 1;
        lastConfigUpdateTime = block.timestamp;
        lastConfigUpdater = address(0); // 初始化时没有更新者
        
        emit TestnetFeaturesConfigInitialized(registryAddr, block.timestamp);
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_TESTNET_CONFIG,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_TESTNET_CONFIG),
            msg.sender,
            block.timestamp
        );
    }
    
    // ============ 配置管理函数 ============
    
    /// @notice 更新测试网功能配置（重写父类方法）
    /// @param level 服务等级
    /// @param price 价格（积分）
    /// @param duration 持续时间（秒）
    /// @param isActive 是否激活
    /// @dev 需要ACTION_TESTNET_CONFIG权限
    /// @dev 记录详细的配置变更历史
    function updateConfig(
        ServiceLevel level,
        uint256 price,
        uint256 duration,
        bool isActive
    ) external override {
        // 权限验证：需要ACTION_TESTNET_CONFIG权限
        _requireRole(ActionKeys.ACTION_TESTNET_CONFIG, msg.sender);
        
        // 保存旧配置用于事件记录
        ServiceConfig memory oldConfig = configs[level];
        
        // 更新配置
        configs[level] = ServiceConfig({
            price: price,
            duration: duration,
            isActive: isActive,
            level: level,
            description: oldConfig.description // 保持原有描述
        });
        
        // 更新状态变量
        configVersion++;
        lastConfigUpdateTime = block.timestamp;
        lastConfigUpdater = msg.sender;
        
        // 发出详细的事件
        emit TestnetFeaturesConfigUpdated(
            level,
            oldConfig.price,
            price,
            oldConfig.duration,
            duration,
            msg.sender,
            block.timestamp
        );
        
        // 发出父类事件
        emit ConfigUpdated(uint8(level), price, duration, isActive);
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_TESTNET_CONFIG,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_TESTNET_CONFIG),
            msg.sender,
            block.timestamp
        );
    }
    
    /// @notice 设置测试网功能冷却期（重写父类方法）
    /// @param _cooldown 冷却期（秒）
    /// @dev 需要ACTION_TESTNET_CONFIG权限
    /// @dev 记录冷却期变更历史
    function setCooldown(uint256 _cooldown) external override {
        // 权限验证：需要ACTION_TESTNET_CONFIG权限
        _requireRole(ActionKeys.ACTION_TESTNET_CONFIG, msg.sender);
        
        // 保存旧冷却期用于事件记录
        uint256 oldCooldown = cooldown;
        
        // 更新冷却期
        cooldown = _cooldown;
        
        // 更新状态变量
        configVersion++;
        lastConfigUpdateTime = block.timestamp;
        lastConfigUpdater = msg.sender;
        
        // 发出详细的事件
        emit TestnetFeaturesCooldownUpdated(
            oldCooldown,
            _cooldown,
            msg.sender,
            block.timestamp
        );
        
        // 发出父类事件
        emit CooldownUpdated(_cooldown);
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_TESTNET_CONFIG,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_TESTNET_CONFIG),
            msg.sender,
            block.timestamp
        );
    }
    
    /// @notice 批量更新测试网功能配置
    /// @param levels 服务等级数组
    /// @param prices 价格数组
    /// @param durations 持续时间数组
    /// @param isActives 激活状态数组
    /// @dev 需要ACTION_TESTNET_CONFIG权限
    /// @dev 批量更新多个配置，提高效率
    function batchUpdateConfig(
        ServiceLevel[] calldata levels,
        uint256[] calldata prices,
        uint256[] calldata durations,
        bool[] calldata isActives
    ) external {
        // 权限验证：需要ACTION_TESTNET_CONFIG权限
        _requireRole(ActionKeys.ACTION_TESTNET_CONFIG, msg.sender);
        
        // 参数验证
        require(
            levels.length == prices.length &&
            levels.length == durations.length &&
            levels.length == isActives.length,
            "TestnetFeaturesConfig: Array length mismatch"
        );
        
        require(levels.length > 0, "TestnetFeaturesConfig: Empty arrays");
        require(levels.length <= 10, "TestnetFeaturesConfig: Too many configs");
        
        // 批量更新配置
        for (uint256 i = 0; i < levels.length; i++) {
            ServiceConfig memory oldConfig = configs[levels[i]];
            
            configs[levels[i]] = ServiceConfig({
                price: prices[i],
                duration: durations[i],
                isActive: isActives[i],
                level: levels[i],
                description: oldConfig.description
            });
            
            // 发出配置更新事件
            emit TestnetFeaturesConfigUpdated(
                levels[i],
                oldConfig.price,
                prices[i],
                oldConfig.duration,
                durations[i],
                msg.sender,
                block.timestamp
            );
            
            emit ConfigUpdated(uint8(levels[i]), prices[i], durations[i], isActives[i]);
        }
        
        // 更新状态变量
        configVersion++;
        lastConfigUpdateTime = block.timestamp;
        lastConfigUpdater = msg.sender;
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_TESTNET_CONFIG,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_TESTNET_CONFIG),
            msg.sender,
            block.timestamp
        );
    }
    
    // ============ 查询函数 ============
    
    /// @notice 获取测试网功能配置版本
    /// @return 配置版本号
    function getConfigVersion() external view returns (uint256) {
        return configVersion;
    }
    
    /// @notice 获取最后配置更新时间
    /// @return 最后更新时间戳
    function getLastConfigUpdateTime() external view returns (uint256) {
        return lastConfigUpdateTime;
    }
    
    /// @notice 获取最后配置更新者
    /// @return 最后更新者地址
    function getLastConfigUpdater() external view returns (address) {
        return lastConfigUpdater;
    }
    
    /// @notice 获取测试网功能配置摘要
    /// @return version 配置版本
    /// @return lastUpdateTime 最后更新时间
    /// @return lastUpdater 最后更新者
    /// @return cooldown 冷却期
    function getConfigSummary() external view returns (
        uint256 version,
        uint256 lastUpdateTime,
        address lastUpdater,
        uint256 cooldown
    ) {
        return (
            configVersion,
            lastConfigUpdateTime,
            lastConfigUpdater,
            cooldown
        );
    }
    
    /// @notice 检查配置是否有效
    /// @param level 服务等级
    /// @return 配置是否有效
    function isConfigValid(ServiceLevel level) external view returns (bool) {
        ServiceConfig memory config = configs[level];
        return config.isActive && config.price > 0 && config.duration > 0;
    }
    
    // ============ 内部初始化函数 ============
    
    /// @dev 初始化测试网功能配置
    /// @dev 设置不同等级测试网功能的默认配置
    function _initializeConfigs() internal override {
        configs[ServiceLevel.Basic] = ServiceConfig({
            price: 100e18,
            duration: 7 days,
            isActive: true,
            level: ServiceLevel.Basic,
            description: "Simulate large loans (testnet)"
        });
        
        configs[ServiceLevel.Standard] = ServiceConfig({
            price: 300e18,
            duration: 7 days,
            isActive: true,
            level: ServiceLevel.Standard,
            description: "Stress testing tools"
        });
        
        configs[ServiceLevel.Premium] = ServiceConfig({
            price: 800e18,
            duration: 7 days,
            isActive: true,
            level: ServiceLevel.Premium,
            description: "Advanced debugging features"
        });
        
        configs[ServiceLevel.VIP] = ServiceConfig({
            price: 1500e18,
            duration: 7 days,
            isActive: true,
            level: ServiceLevel.VIP,
            description: "Full testnet permissions"
        });
    }
    
    /// @dev 初始化冷却期
    /// @dev 设置测试网功能的默认冷却期
    function _initializeCooldown() internal override {
        cooldown = 1 hours;
    }
    
    // ============ 服务类型函数 ============
    
    /// @notice 获取服务类型
    /// @return serviceType 服务类型
    /// @dev 返回TestnetFeatures服务类型
    function getServiceType() external pure override returns (ServiceType) {
        return ServiceType.TestnetFeatures;
    }
    
    // ============ 权限验证函数 ============
    
    /// @notice 检查调用者是否有配置更新权限
    /// @param caller 调用者地址
    /// @return 是否有权限
    function hasConfigUpdatePermission(address caller) external view returns (bool) {
        address acmAddr = IRegistry(registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        return IAccessControlManager(acmAddr).hasRole(ActionKeys.ACTION_TESTNET_CONFIG, caller);
    }
    
    /// @notice 检查调用者是否有合约升级权限
    /// @param caller 调用者地址
    /// @return 是否有权限
    function hasUpgradePermission(address caller) external view returns (bool) {
        address acmAddr = IRegistry(registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        return IAccessControlManager(acmAddr).hasRole(ActionKeys.ACTION_UPGRADE_MODULE, caller);
    }
    
    /// @notice 检查调用者是否有测试网功能激活权限
    /// @param caller 调用者地址
    /// @return 是否有权限
    function hasTestnetActivatePermission(address caller) external view returns (bool) {
        address acmAddr = IRegistry(registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        return IAccessControlManager(acmAddr).hasRole(ActionKeys.ACTION_TESTNET_ACTIVATE, caller);
    }
    
    /// @notice 检查调用者是否有测试网功能暂停权限
    /// @param caller 调用者地址
    /// @return 是否有权限
    function hasTestnetPausePermission(address caller) external view returns (bool) {
        address acmAddr = IRegistry(registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        return IAccessControlManager(acmAddr).hasRole(ActionKeys.ACTION_TESTNET_PAUSE, caller);
    }
    
    /// @notice 验证调用者权限（内部使用）
    /// @param actionKey 动作Key
    /// @param caller 调用者地址
    /// @dev 内部权限验证函数
    function _validatePermission(bytes32 actionKey, address caller) internal view {
        _requireRole(actionKey, caller);
    }
    
    // ============ 紧急功能 ============
    
    /// @notice 紧急暂停所有测试网功能
    /// @dev 需要ACTION_TESTNET_PAUSE权限
    /// @dev 紧急情况下暂停所有测试网功能
    function emergencyPauseAllFeatures() external {
        // 权限验证：需要ACTION_TESTNET_PAUSE权限
        _requireRole(ActionKeys.ACTION_TESTNET_PAUSE, msg.sender);
        
        // 暂停所有等级的功能
        for (uint8 i = 0; i < 4; i++) {
            ServiceLevel level = ServiceLevel(i);
            if (configs[level].isActive) {
                configs[level].isActive = false;
                
                emit TestnetFeaturesConfigUpdated(
                    level,
                    configs[level].price,
                    configs[level].price,
                    configs[level].duration,
                    configs[level].duration,
                    msg.sender,
                    block.timestamp
                );
            }
        }
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_TESTNET_PAUSE,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_TESTNET_PAUSE),
            msg.sender,
            block.timestamp
        );
    }
    
    /// @notice 恢复所有测试网功能
    /// @dev 需要ACTION_TESTNET_ACTIVATE权限
    /// @dev 恢复所有测试网功能
    function emergencyUnpauseAllFeatures() external {
        // 权限验证：需要ACTION_TESTNET_ACTIVATE权限
        _requireRole(ActionKeys.ACTION_TESTNET_ACTIVATE, msg.sender);
        
        // 恢复所有等级的功能
        for (uint8 i = 0; i < 4; i++) {
            ServiceLevel level = ServiceLevel(i);
            if (!configs[level].isActive) {
                configs[level].isActive = true;
                
                emit TestnetFeaturesConfigUpdated(
                    level,
                    configs[level].price,
                    configs[level].price,
                    configs[level].duration,
                    configs[level].duration,
                    msg.sender,
                    block.timestamp
                );
            }
        }
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_TESTNET_ACTIVATE,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_TESTNET_ACTIVATE),
            msg.sender,
            block.timestamp
        );
    }
    
    // ============ Registry 管理 ============
    
    /// @notice 更新 Registry 地址
    /// @param newRegistryAddr 新的 Registry 地址
    /// @dev 需要 ACTION_TESTNET_CONFIG 权限
    function updateRegistry(address newRegistryAddr) external {
        _requireRole(ActionKeys.ACTION_TESTNET_CONFIG, msg.sender);
        
        if (newRegistryAddr == address(0)) revert("Invalid registry address");
        
        address oldRegistry = registryAddr;
        registryAddr = newRegistryAddr;
        
        emit RegistryUpdated(oldRegistry, newRegistryAddr);
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_TESTNET_CONFIG,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_TESTNET_CONFIG),
            msg.sender,
            block.timestamp
        );
    }
    

} 