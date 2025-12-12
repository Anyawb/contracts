// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { BaseServiceConfig } from "../BaseServiceConfig.sol";
import { RewardTypes } from "../RewardTypes.sol";
import { ActionKeys } from "../../constants/ActionKeys.sol";
import { VaultTypes } from "../../Vault/VaultTypes.sol";
import { ZeroAddress } from "../../errors/StandardErrors.sol";

/// @title PriorityServiceConfig - 优先服务配置
/// @notice 管理优先服务的配置和价格
/// @dev 继承BaseServiceConfig，实现优先服务的具体配置
/// @dev 使用ACM权限控制，确保只有授权用户可以修改配置
/// @dev 记录标准化动作事件，与系统架构保持一致
/// @dev 与 Registry 系统完全集成，使用标准化的模块管理
/// @custom:security-contact security@example.com
contract PriorityServiceConfig is BaseServiceConfig {
    
    // =================== 事件定义 ===================
    
    /// @notice 优先服务配置初始化事件
    event PriorityServiceConfigInitialized(
        address indexed governance,
        uint256 timestamp
    );
    
    /// @notice 优先服务配置更新事件
    event PriorityServiceConfigUpdated(
        ServiceLevel indexed level,
        uint256 oldPrice,
        uint256 newPrice,
        uint256 oldDuration,
        uint256 newDuration,
        bool oldIsActive,
        bool newIsActive,
        address indexed updatedBy,
        uint256 timestamp
    );
    
    /// @notice 优先服务冷却期更新事件
    event PriorityServiceCooldownUpdated(
        uint256 oldCooldown,
        uint256 newCooldown,
        address indexed updatedBy,
        uint256 timestamp
    );
    
    /// @notice Registry 地址更新事件
    /// @dev 记录 Registry 地址的变更
    event RegistryUpdated(address indexed oldRegistry, address indexed newRegistry);
    
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }
    
    /// @notice 初始化合约
    /// @param initialRegistryAddr Registry 合约地址
    /// @dev 只有治理合约可以调用此函数
    /// @dev 初始化后记录标准化动作事件
    function initialize(address initialRegistryAddr) external override initializer {
        // 验证地址不为零
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        
        // 调用基类初始化
        super._initialize(initialRegistryAddr);
        
        // 记录初始化事件
        emit PriorityServiceConfigInitialized(registryAddr, block.timestamp);
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
    }
    
    /// @dev 初始化优先服务配置
    /// @dev 设置不同等级的服务价格和描述
    function _initializeConfigs() internal override {
        configs[ServiceLevel.Basic] = ServiceConfig({
            price: 200e18, // 200积分
            duration: 30 days,
            isActive: true,
            level: ServiceLevel.Basic,
            description: "Priority loan processing (24h)"
        });
        
        configs[ServiceLevel.Standard] = ServiceConfig({
            price: 500e18, // 500积分
            duration: 30 days,
            isActive: true,
            level: ServiceLevel.Standard,
            description: "Dedicated customer service"
        });
        
        configs[ServiceLevel.Premium] = ServiceConfig({
            price: 1000e18, // 1000积分
            duration: 30 days,
            isActive: true,
            level: ServiceLevel.Premium,
            description: "Emergency transaction processing (4h)"
        });
        
        configs[ServiceLevel.VIP] = ServiceConfig({
            price: 2000e18, // 2000积分
            duration: 30 days,
            isActive: true,
            level: ServiceLevel.VIP,
            description: "VIP exclusive manager service"
        });
    }
    
    /// @dev 初始化冷却期
    /// @dev 设置服务升级的冷却时间为12小时
    function _initializeCooldown() internal override {
        cooldown = 12 hours;
    }
    
    /// @notice 获取服务类型
    /// @return serviceType 服务类型
    function getServiceType() external pure override returns (ServiceType) {
        return ServiceType.PriorityService;
    }
    
    /// @notice 更新优先服务配置（重写基类方法以添加详细事件）
    /// @param level 服务等级
    /// @param price 服务价格
    /// @param duration 服务时长
    /// @param isActive 是否激活
    /// @dev 需要 ACTION_SET_PARAMETER 权限
    /// @dev 记录详细的配置变更事件
    function updateConfig(
        ServiceLevel level,
        uint256 price,
        uint256 duration,
        bool isActive
    ) external override {
        // 权限验证
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        
        // 保存旧配置用于事件记录
        ServiceConfig memory oldConfig = configs[level];
        
        // 更新配置
        configs[level] = ServiceConfig({
            price: price,
            duration: duration,
            isActive: isActive,
            level: level,
            description: oldConfig.description // 保持描述不变
        });
        
        // 记录详细的事件
        emit PriorityServiceConfigUpdated(
            level,
            oldConfig.price,
            price,
            oldConfig.duration,
            duration,
            oldConfig.isActive,
            isActive,
            msg.sender,
            block.timestamp
        );
        
        // 记录基类事件
        emit ConfigUpdated(uint8(level), price, duration, isActive);
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
    }
    
    /// @notice 设置优先服务冷却期（重写基类方法以添加详细事件）
    /// @param _cooldown 新的冷却期
    /// @dev 需要 ACTION_SET_PARAMETER 权限
    /// @dev 记录详细的冷却期变更事件
    function setCooldown(uint256 _cooldown) external override {
        // 权限验证
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        
        // 保存旧冷却期用于事件记录
        uint256 oldCooldown = cooldown;
        
        // 更新冷却期
        cooldown = _cooldown;
        
        // 记录详细的事件
        emit PriorityServiceCooldownUpdated(
            oldCooldown,
            _cooldown,
            msg.sender,
            block.timestamp
        );
        
        // 记录基类事件
        emit CooldownUpdated(_cooldown);
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
    }
    
    /// @notice 批量更新优先服务配置
    /// @param levels 服务等级数组
    /// @param prices 价格数组
    /// @param durations 时长数组
    /// @param isActives 激活状态数组
    /// @dev 需要 ACTION_SET_PARAMETER 权限
    /// @dev 批量更新多个服务等级配置
    function batchUpdateConfig(
        ServiceLevel[] calldata levels,
        uint256[] calldata prices,
        uint256[] calldata durations,
        bool[] calldata isActives
    ) external {
        // 权限验证
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        
        // 验证数组长度一致
        require(
            levels.length == prices.length &&
            prices.length == durations.length &&
            durations.length == isActives.length,
            "PriorityServiceConfig: array length mismatch"
        );
        
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
            
            // 记录每个配置的更新事件
            emit PriorityServiceConfigUpdated(
                levels[i],
                oldConfig.price,
                prices[i],
                oldConfig.duration,
                durations[i],
                oldConfig.isActive,
                isActives[i],
                msg.sender,
                block.timestamp
            );
            
            emit ConfigUpdated(uint8(levels[i]), prices[i], durations[i], isActives[i]);
        }
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
    }
    
    /// @notice 获取所有优先服务配置
    /// @return 所有服务等级的配置数组
    function getAllConfigs() external view returns (ServiceConfig[] memory) {
        ServiceConfig[] memory allConfigs = new ServiceConfig[](4);
        allConfigs[0] = configs[ServiceLevel.Basic];
        allConfigs[1] = configs[ServiceLevel.Standard];
        allConfigs[2] = configs[ServiceLevel.Premium];
        allConfigs[3] = configs[ServiceLevel.VIP];
        return allConfigs;
    }
    
    /// @notice 检查服务等级是否激活
    /// @param level 服务等级
    /// @return 是否激活
    function isServiceActive(ServiceLevel level) external view returns (bool) {
        return configs[level].isActive;
    }
    
    /// @notice 获取服务价格
    /// @param level 服务等级
    /// @return 服务价格
    function getServicePrice(ServiceLevel level) external view returns (uint256) {
        return configs[level].price;
    }
    
    /// @notice 获取服务时长
    /// @param level 服务等级
    /// @return 服务时长
    function getServiceDuration(ServiceLevel level) external view returns (uint256) {
        return configs[level].duration;
    }
    
    // ============ Registry 管理 ============
    
    /// @notice 更新 Registry 地址
    /// @param newRegistryAddr 新的 Registry 地址
    /// @dev 需要 ACTION_SET_PARAMETER 权限
    function updateRegistry(address newRegistryAddr) external {
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