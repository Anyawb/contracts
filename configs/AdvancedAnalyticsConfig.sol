// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { BaseServiceConfig } from "../BaseServiceConfig.sol";
import { RewardTypes } from "../RewardTypes.sol";
import { ActionKeys } from "../../constants/ActionKeys.sol";
import { ModuleKeys } from "../../constants/ModuleKeys.sol";
import { VaultTypes } from "../../Vault/VaultTypes.sol";
import { ZeroAddress } from "../../errors/StandardErrors.sol";

/// @title AdvancedAnalyticsConfig - 高级数据分析服务配置
/// @notice 管理高级数据分析服务的配置和价格
/// @dev 继承BaseServiceConfig，实现高级数据分析服务的具体配置
/// @dev 与 ACM 权限系统集成，使用 ActionKeys 进行权限验证
/// @dev 支持标准化动作事件记录，确保系统操作的一致性
/// @dev 对应 ModuleKeys.KEY_ADVANCED_ANALYTICS_CONFIG
/// @custom:security-contact security@example.com
contract AdvancedAnalyticsConfig is BaseServiceConfig {
    
    // ============ 事件定义 ============
    
    /// @notice 高级数据分析服务配置更新事件
    /// @dev 记录服务配置的变更，与 VaultTypes.ActionExecuted 配合使用
    event AdvancedAnalyticsConfigUpdated(
        uint8 indexed level,
        uint256 price,
        uint256 duration,
        bool isActive,
        string description,
        uint256 timestamp
    );
    
    /// @notice 高级数据分析服务激活状态变更事件
    /// @dev 记录服务激活状态的变更
    event AdvancedAnalyticsServiceToggled(
        uint8 indexed level,
        bool isActive,
        uint256 timestamp
    );
    
    /// @notice 高级数据分析服务价格更新事件
    /// @dev 记录服务价格的变更
    event AdvancedAnalyticsPriceUpdated(
        uint8 indexed level,
        uint256 oldPrice,
        uint256 newPrice,
        uint256 timestamp
    );
    
    /// @notice 高级数据分析服务时长更新事件
    /// @dev 记录服务时长的变更
    event AdvancedAnalyticsDurationUpdated(
        uint8 indexed level,
        uint256 oldDuration,
        uint256 newDuration,
        uint256 timestamp
    );
    
    /// @notice Registry 地址更新事件
    /// @dev 记录 Registry 地址的变更
    event RegistryUpdated(address indexed oldRegistry, address indexed newRegistry);

    // ============ 状态变量 ============
    
    /// @notice 服务描述映射
    /// @dev 存储各等级服务的详细描述
    mapping(ServiceLevel => string) public serviceDescriptions;
    
    /// @notice 服务使用统计
    /// @dev 记录各等级服务的使用次数
    mapping(ServiceLevel => uint256) public serviceUsageCount;
    
    /// @notice 服务收入统计
    /// @dev 记录各等级服务的总收入
    mapping(ServiceLevel => uint256) public serviceRevenue;

    // ============ 构造函数 ============
    
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }
    
    // ============ 初始化函数 ============
    
    /// @dev 内部初始化函数（重写父合约方法）
    /// @param initialRegistryAddr Registry 合约地址
    function _initialize(address initialRegistryAddr) internal override {
        super._initialize(initialRegistryAddr);
        
        // 记录初始化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
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
    
    // ============ 配置初始化 ============
    
    /// @dev 初始化高级数据分析服务配置
    /// @dev 设置各等级服务的价格、时长和描述
    function _initializeConfigs() internal override {
        // 基础等级配置
        configs[ServiceLevel.Basic] = ServiceConfig({
            price: 200e18, // 200积分
            duration: 30 days,
            isActive: true,
            level: ServiceLevel.Basic,
            description: "Basic data analysis report with market trends"
        });
        
        // 标准等级配置
        configs[ServiceLevel.Standard] = ServiceConfig({
            price: 500e18, // 500积分
            duration: 30 days,
            isActive: true,
            level: ServiceLevel.Standard,
            description: "Deep risk assessment with portfolio analysis"
        });
        
        // 高级等级配置
        configs[ServiceLevel.Premium] = ServiceConfig({
            price: 1000e18, // 1000积分
            duration: 30 days,
            isActive: true,
            level: ServiceLevel.Premium,
            description: "Personalized investment advice with AI insights"
        });
        
        // VIP等级配置
        configs[ServiceLevel.VIP] = ServiceConfig({
            price: 2000e18, // 2000积分
            duration: 30 days,
            isActive: true,
            level: ServiceLevel.VIP,
            description: "VIP exclusive analyst service with 24/7 support"
        });
        
        // 初始化服务描述映射
        serviceDescriptions[ServiceLevel.Basic] = "Basic data analysis report with market trends";
        serviceDescriptions[ServiceLevel.Standard] = "Deep risk assessment with portfolio analysis";
        serviceDescriptions[ServiceLevel.Premium] = "Personalized investment advice with AI insights";
        serviceDescriptions[ServiceLevel.VIP] = "VIP exclusive analyst service with 24/7 support";
    }
    
    /// @dev 初始化冷却期
    /// @dev 设置服务使用的冷却期，防止频繁调用
    function _initializeCooldown() internal override {
        cooldown = 1 days;
    }
    
    // ============ 服务类型 ============
    
    /// @notice 获取服务类型
    /// @return serviceType 服务类型
    /// @dev 返回高级数据分析服务类型
    function getServiceType() external pure override returns (ServiceType) {
        return ServiceType.AdvancedAnalytics;
    }
    
    // ============ 配置管理 ============
    
    /// @notice 更新服务配置（重写父合约方法）
    /// @param level 服务等级
    /// @param price 价格
    /// @param duration 持续时间
    /// @param isActive 是否激活
    /// @dev 需要 ACTION_SET_PARAMETER 权限
    function updateConfig(
        ServiceLevel level,
        uint256 price,
        uint256 duration,
        bool isActive
    ) external override {
        // 权限验证
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        
        // 参数验证
        if (price == 0) revert("Price cannot be zero");
        if (duration == 0) revert("Duration cannot be zero");
        
        // 记录旧值用于事件
        uint256 oldPrice = configs[level].price;
        uint256 oldDuration = configs[level].duration;
        bool oldIsActive = configs[level].isActive;
        
        // 更新配置
        configs[level] = ServiceConfig({
            price: price,
            duration: duration,
            isActive: isActive,
            level: level,
            description: serviceDescriptions[level]
        });
        
        // 发出详细事件
        emit AdvancedAnalyticsConfigUpdated(
            uint8(level),
            price,
            duration,
            isActive,
            serviceDescriptions[level],
            block.timestamp
        );
        
        // 发出价格变更事件
        if (oldPrice != price) {
            emit AdvancedAnalyticsPriceUpdated(
                uint8(level),
                oldPrice,
                price,
                block.timestamp
            );
        }
        
        // 发出时长变更事件
        if (oldDuration != duration) {
            emit AdvancedAnalyticsDurationUpdated(
                uint8(level),
                oldDuration,
                duration,
                block.timestamp
            );
        }
        
        // 发出激活状态变更事件
        if (oldIsActive != isActive) {
            emit AdvancedAnalyticsServiceToggled(
                uint8(level),
                isActive,
                block.timestamp
            );
        }
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
    }
    
    /// @notice 更新服务描述
    /// @param level 服务等级
    /// @param description 新描述
    /// @dev 需要 ACTION_SET_PARAMETER 权限
    function updateServiceDescription(ServiceLevel level, string calldata description) external {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        
        if (bytes(description).length == 0) revert("Description cannot be empty");
        
        serviceDescriptions[level] = description;
        
        // 更新配置中的描述
        configs[level].description = description;
        
        emit AdvancedAnalyticsConfigUpdated(
            uint8(level),
            configs[level].price,
            configs[level].duration,
            configs[level].isActive,
            description,
            block.timestamp
        );
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
    }
    
    /// @notice 切换服务激活状态
    /// @param level 服务等级
    /// @param isActive 是否激活
    /// @dev 需要 ACTION_SET_PARAMETER 权限
    function toggleServiceActive(ServiceLevel level, bool isActive) external {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        
        configs[level].isActive = isActive;
        
        emit AdvancedAnalyticsServiceToggled(
            uint8(level),
            isActive,
            block.timestamp
        );
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
    }
    
    // ============ 统计功能 ============
    
    /// @notice 记录服务使用
    /// @param level 服务等级
    /// @param points 消费积分
    /// @dev 内部函数，由消费模块调用
    function recordServiceUsage(ServiceLevel level, uint256 points) external {
        // 只有授权的消费模块可以调用
        _requireRole(ActionKeys.ACTION_CONSUME_POINTS, msg.sender);
        
        serviceUsageCount[level]++;
        serviceRevenue[level] += points;
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_CONSUME_POINTS,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_CONSUME_POINTS),
            msg.sender,
            block.timestamp
        );
    }
    
    /// @notice 获取服务使用统计
    /// @param level 服务等级
    /// @return usageCount 使用次数
    /// @return revenue 总收入
    function getServiceStats(ServiceLevel level) external view returns (uint256 usageCount, uint256 revenue) {
        return (serviceUsageCount[level], serviceRevenue[level]);
    }
    
    /// @notice 获取所有服务统计
    /// @return usageCounts 各等级使用次数数组
    /// @return revenues 各等级总收入数组
    function getAllServiceStats() external view returns (uint256[4] memory usageCounts, uint256[4] memory revenues) {
        usageCounts[0] = serviceUsageCount[ServiceLevel.Basic];
        usageCounts[1] = serviceUsageCount[ServiceLevel.Standard];
        usageCounts[2] = serviceUsageCount[ServiceLevel.Premium];
        usageCounts[3] = serviceUsageCount[ServiceLevel.VIP];
        
        revenues[0] = serviceRevenue[ServiceLevel.Basic];
        revenues[1] = serviceRevenue[ServiceLevel.Standard];
        revenues[2] = serviceRevenue[ServiceLevel.Premium];
        revenues[3] = serviceRevenue[ServiceLevel.VIP];
        
        return (usageCounts, revenues);
    }
    
    // ============ 查询功能 ============
    
    /// @notice 获取服务描述
    /// @param level 服务等级
    /// @return description 服务描述
    function getServiceDescription(ServiceLevel level) external view returns (string memory description) {
        return serviceDescriptions[level];
    }
    
    /// @notice 检查服务是否可用
    /// @param level 服务等级
    /// @return isAvailable 是否可用
    function isServiceAvailable(ServiceLevel level) external view returns (bool isAvailable) {
        return configs[level].isActive;
    }
    
    /// @notice 获取服务价格
    /// @param level 服务等级
    /// @return price 服务价格
    function getServicePrice(ServiceLevel level) external view returns (uint256 price) {
        return configs[level].price;
    }
    
    /// @notice 获取服务时长
    /// @param level 服务等级
    /// @return duration 服务时长
    function getServiceDuration(ServiceLevel level) external view returns (uint256 duration) {
        return configs[level].duration;
    }
    
    // ============ 批量操作 ============
    
    /// @notice 批量更新服务价格
    /// @param levels 服务等级数组
    /// @param prices 价格数组
    /// @dev 需要 ACTION_SET_PARAMETER 权限
    function batchUpdatePrices(ServiceLevel[] calldata levels, uint256[] calldata prices) external {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        
        if (levels.length != prices.length) revert("Array length mismatch");
        if (levels.length > 10) revert("Too many items");
        
        for (uint256 i = 0; i < levels.length; i++) {
            if (prices[i] == 0) revert("Price cannot be zero");
            
            uint256 oldPrice = configs[levels[i]].price;
            configs[levels[i]].price = prices[i];
            
            emit AdvancedAnalyticsPriceUpdated(
                uint8(levels[i]),
                oldPrice,
                prices[i],
                block.timestamp
            );
        }
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
    }
    
    /// @notice 批量切换服务激活状态
    /// @param levels 服务等级数组
    /// @param isActive 是否激活
    /// @dev 需要 ACTION_SET_PARAMETER 权限
    function batchToggleServiceActive(ServiceLevel[] calldata levels, bool isActive) external {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        
        if (levels.length > 10) revert("Too many items");
        
        for (uint256 i = 0; i < levels.length; i++) {
            configs[levels[i]].isActive = isActive;
            
            emit AdvancedAnalyticsServiceToggled(
                uint8(levels[i]),
                isActive,
                block.timestamp
            );
        }
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
    }
    
    // ============ 紧急功能 ============
    
    /// @notice 紧急暂停所有服务
    /// @dev 需要 ACTION_PAUSE_SYSTEM 权限
    function emergencyPauseAllServices() external {
        _requireRole(ActionKeys.ACTION_PAUSE_SYSTEM, msg.sender);
        
        for (uint8 i = 0; i < 4; i++) {
            ServiceLevel level = ServiceLevel(i);
            if (configs[level].isActive) {
                configs[level].isActive = false;
                
                emit AdvancedAnalyticsServiceToggled(
                    i,
                    false,
                    block.timestamp
                );
            }
        }
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_PAUSE_SYSTEM,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_PAUSE_SYSTEM),
            msg.sender,
            block.timestamp
        );
    }
    
    /// @notice 恢复所有服务
    /// @dev 需要 ACTION_UNPAUSE_SYSTEM 权限
    function emergencyUnpauseAllServices() external {
        _requireRole(ActionKeys.ACTION_UNPAUSE_SYSTEM, msg.sender);
        
        for (uint8 i = 0; i < 4; i++) {
            ServiceLevel level = ServiceLevel(i);
            if (!configs[level].isActive) {
                configs[level].isActive = true;
                
                emit AdvancedAnalyticsServiceToggled(
                    i,
                    true,
                    block.timestamp
                );
            }
        }
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_UNPAUSE_SYSTEM,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_UNPAUSE_SYSTEM),
            msg.sender,
            block.timestamp
        );
    }
} 