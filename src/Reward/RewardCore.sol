// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { RewardPoints } from "../Token/RewardPoints.sol";
import { IAccessControlManager } from "../interfaces/IAccessControlManager.sol";
import { RewardTypes } from "./RewardTypes.sol";
import { IServiceConfig } from "./interfaces/IServiceConfig.sol";
import { Registry } from "../registry/Registry.sol";
import { ActionKeys } from "../constants/ActionKeys.sol";
import { ModuleKeys } from "../constants/ModuleKeys.sol";
import { VaultTypes } from "../Vault/VaultTypes.sol";
import { RewardModuleBase } from "./internal/RewardModuleBase.sol";
import {
    ZeroAddress,
    NotGovernance,
    InvalidCaller,
    InsufficientBalance,
    ExternalModuleRevertedRaw
} from "../errors/StandardErrors.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";

/// @title RewardCore - 积分消费核心业务逻辑
/// @notice 处理积分消费、升级和批量操作的核心逻辑
/// @dev 遵循 docs/SmartContractStandard.md 注释规范
/// @dev 使用 ActionKeys、ModuleKeys、VaultTypes、StandardErrors 进行标准化管理
/// @dev 通过 Registry 进行模块地址管理，确保架构一致性
contract RewardCore is 
    Initializable, 
    ReentrancyGuardUpgradeable, 
    UUPSUpgradeable,
    RewardModuleBase,
    RewardTypes
{
    
    /// @notice Registry 合约地址（私有存储）
    address private _registryAddr;
    
    /// @notice 特权升级费用倍数 (BPS)
    uint256 private _upgradeMultiplier;
    
    /// @notice 测试网模式
    bool private _isTestnetMode;
    
    /// @notice 用户消费记录（私有存储）
    mapping(address => ConsumptionRecord[]) private _userConsumptions;
    
    /// @notice 用户特权状态（私有存储）
    mapping(address => UserPrivilege) private _userPrivileges;
    
    /// @notice 服务统计（私有存储）
    mapping(ServiceType => uint256) private _serviceUsage;
    
    /// @notice 总消费积分（私有存储）
    uint256 private _totalConsumedPoints;
    
    /// @notice 用户最后消费时间（私有存储）
    mapping(address => mapping(ServiceType => uint256)) private _userLastConsumption;
    
    /// @notice 批量操作统计（私有存储）
    uint256 private _totalBatchConsumptions;

    

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice 初始化合约
    /// @param initialRegistryAddr Registry 合约地址
    function initialize(address initialRegistryAddr) external initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        
        _registryAddr = initialRegistryAddr;
        
        // 初始化默认值
        _upgradeMultiplier = 15000; // 1.5x
        _isTestnetMode = true;
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
    }

    // ========== 修饰符 ==========

    // onlyValidRegistry 由基类提供

    // ========== 权限管理 ==========

    // _requireRole 由基类提供

    // ========== 公共接口 ==========

    /// @notice 消费积分购买服务
    /// @param serviceType 服务类型
    /// @param level 服务等级
    function consumePointsForService(ServiceType serviceType, ServiceLevel level) external nonReentrant onlyValidRegistry {
        _consumePointsForService(msg.sender, serviceType, level);
    }

    /// @notice 批量消费积分
    /// @param users 用户地址数组
    /// @param serviceTypes 服务类型数组
    /// @param levels 服务等级数组
    function batchConsumePoints(
        address[] calldata users,
        ServiceType[] calldata serviceTypes,
        ServiceLevel[] calldata levels
    ) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_BATCH_WITHDRAW, msg.sender);
        _batchConsumePoints(users, serviceTypes, levels);
    }

    /// @notice 升级服务等级
    /// @param serviceType 服务类型
    /// @param newLevel 新等级
    function upgradeServiceLevel(ServiceType serviceType, ServiceLevel newLevel) external nonReentrant onlyValidRegistry {
        _upgradeServiceLevel(msg.sender, serviceType, newLevel);
    }

    // ========== 查询接口 ==========

    /// @notice 查询用户特权状态
    /// @param user 用户地址
    /// @return privilege 用户特权状态
    function getUserPrivilege(address user) external view returns (UserPrivilege memory privilege) {
        return _userPrivileges[user];
    }

    /// @notice 查询用户消费记录
    /// @param user 用户地址
    /// @return records 消费记录数组
    function getUserConsumptions(address user) external view returns (ConsumptionRecord[] memory records) {
        return _userConsumptions[user];
    }

    /// @notice 查询服务使用统计
    /// @param serviceType 服务类型
    /// @return usage 使用次数
    function getServiceUsage(ServiceType serviceType) external view returns (uint256 usage) {
        return _serviceUsage[serviceType];
    }

    /// @notice 查询用户最后消费时间
    /// @param user 用户地址
    /// @param serviceType 服务类型
    /// @return timestamp 最后消费时间
    function getUserLastConsumption(address user, ServiceType serviceType) external view returns (uint256 timestamp) {
        return _userLastConsumption[user][serviceType];
    }

    /// @notice 查询服务配置
    /// @param serviceType 服务类型
    /// @param level 服务等级
    /// @return config 服务配置
    function getServiceConfig(ServiceType serviceType, ServiceLevel level) external view returns (ServiceConfig memory config) {
        IServiceConfig configModule = _getServiceConfigModule(serviceType);
        return configModule.getConfig(level);
    }

    /// @notice 获取服务冷却期
    /// @param serviceType 服务类型
    /// @return cooldown 冷却期 (秒)
    function serviceCooldowns(ServiceType serviceType) external view returns (uint256 cooldown) {
        IServiceConfig configModule = _getServiceConfigModule(serviceType);
        return configModule.getCooldown();
    }

    /// @notice 获取Registry地址
    /// @return registry 当前Registry地址
    function getRegistry() external view returns (address registry) {
        return _registryAddr;
    }

    // ========== 管理接口 ==========

    /// @notice 更新升级倍数
    /// @param newMultiplier 新倍数 (BPS)
    function setUpgradeMultiplier(uint256 newMultiplier) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        _upgradeMultiplier = newMultiplier;
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
        
        // 记录参数更新事件
        emit VaultTypes.VaultParamsUpdated(newMultiplier, 0, block.timestamp);
    }

    /// @notice 设置测试网模式
    /// @param newIsTestnet 是否为测试网模式
    function setTestnetMode(bool newIsTestnet) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        _isTestnetMode = newIsTestnet;
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
    }

    // ========== 内部逻辑 ==========

    /// @dev 消费积分购买服务 - 核心逻辑
    function _consumePointsForService(address user, ServiceType serviceType, ServiceLevel level) internal {
        _validateServiceAvailability(serviceType, level);
        _validateCooldown(user, serviceType);
        
        ServiceConfig memory config = _getServiceConfig(serviceType, level);
        _validateUserBalance(user, config.price);
        
        _processConsumptionRecord(user, serviceType, level, config.price);
    }
    
    /// @dev 升级服务等级 - 核心逻辑
    function _upgradeServiceLevel(address user, ServiceType serviceType, ServiceLevel newLevel) internal {
        ServiceConfig memory config = _getServiceConfig(serviceType, newLevel);
        
        if (!config.isActive) {
            revert InvalidCaller();
        }
        
        // 计算升级费用
        uint256 upgradeCost = (config.price * _upgradeMultiplier) / 10000;
        _validateUpgradeCost(upgradeCost);
        
        _validateUserBalance(user, upgradeCost);
        _processUpgradeRecord(user, serviceType, newLevel, upgradeCost);
    }
    
    /// @dev 批量消费积分 - 核心逻辑
    function _batchConsumePoints(
        address[] calldata users,
        ServiceType[] calldata serviceTypes,
        ServiceLevel[] calldata levels
    ) internal returns (uint256 totalPoints) {
        return _processBatchConsumption(users, serviceTypes, levels);
    }

    // ========== 验证逻辑 ==========

    /// @dev 验证服务可用性
    function _validateServiceAvailability(ServiceType serviceType, ServiceLevel level) internal view {
        if (serviceType > ServiceType.TestnetFeatures) {
            revert InvalidCaller();
        }
        
        if (level > ServiceLevel.VIP) {
            revert InvalidCaller();
        }
        
        ServiceConfig memory config = _getServiceConfig(serviceType, level);
        if (!config.isActive) {
            revert InvalidCaller();
        }
    }

    /// @dev 验证冷却期
    function _validateCooldown(address user, ServiceType serviceType) internal view {
        uint256 lastConsumption = _userLastConsumption[user][serviceType];
        uint256 cooldown = _getServiceCooldown(serviceType);
        
        if (block.timestamp < lastConsumption + cooldown) {
            revert InvalidCaller();
        }
    }

    /// @dev 验证用户余额
    function _validateUserBalance(address user, uint256 requiredPoints) internal view {
        RewardPoints rewardToken = RewardPoints(Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_REWARD_POINTS));
        uint256 balance = rewardToken.balanceOf(user);
        if (balance < requiredPoints) {
            revert InsufficientBalance();
        }
    }

    /// @dev 验证升级费用
    function _validateUpgradeCost(uint256 upgradeCost) internal pure {
        if (upgradeCost == 0) {
            revert InvalidCaller();
        }
    }

    // ========== 内部查询函数 ==========

    /// @dev 获取服务配置模块
    function _getServiceConfigModule(ServiceType serviceType) internal view returns (IServiceConfig configModule) {
        bytes32 moduleKey;
        
        if (serviceType == ServiceType.AdvancedAnalytics) {
            moduleKey = ModuleKeys.KEY_ADVANCED_ANALYTICS_CONFIG;
        } else if (serviceType == ServiceType.PriorityService) {
            moduleKey = ModuleKeys.KEY_PRIORITY_SERVICE_CONFIG;
        } else if (serviceType == ServiceType.FeatureUnlock) {
            moduleKey = ModuleKeys.KEY_FEATURE_UNLOCK_CONFIG;
        } else if (serviceType == ServiceType.GovernanceAccess) {
            moduleKey = ModuleKeys.KEY_GOVERNANCE_ACCESS_CONFIG;
        } else if (serviceType == ServiceType.TestnetFeatures) {
            moduleKey = ModuleKeys.KEY_TESTNET_FEATURES_CONFIG;
        } else {
            revert InvalidCaller();
        }
        
        address configAddr = Registry(_registryAddr).getModuleOrRevert(moduleKey);
        return IServiceConfig(configAddr);
    }

    /// @dev 获取服务配置
    function _getServiceConfig(ServiceType serviceType, ServiceLevel level) internal view returns (ServiceConfig memory config) {
        IServiceConfig configModule = _getServiceConfigModule(serviceType);
        return configModule.getConfig(level);
    }

    /// @dev 获取服务冷却期
    function _getServiceCooldown(ServiceType serviceType) internal view returns (uint256 cooldown) {
        IServiceConfig configModule = _getServiceConfigModule(serviceType);
        return configModule.getCooldown();
    }

    // ========== 处理逻辑 ==========

    /// @dev 处理消费记录
    function _processConsumptionRecord(address user, ServiceType serviceType, ServiceLevel level, uint256 points) internal {
        // 获取积分代币合约
        RewardPoints rewardToken = RewardPoints(Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_REWARD_POINTS));
        
        // 扣除积分
        rewardToken.burnPoints(user, points);
        
        // 更新统计
        _totalConsumedPoints += points;
        _serviceUsage[serviceType]++;
        _userLastConsumption[user][serviceType] = block.timestamp;
        
        // 记录消费
        ConsumptionRecord memory record = ConsumptionRecord({
            points: points,
            timestamp: block.timestamp,
            serviceType: serviceType,
            serviceLevel: level,
            isActive: true,
            expirationTime: block.timestamp + 30 days
        });
        
        _userConsumptions[user].push(record);
        
        // 更新特权状态
        _updateUserPrivilege(user, serviceType, level);
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_CONSUME_POINTS,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_CONSUME_POINTS),
            user,
            block.timestamp
        );
        
        // 记录奖励消费事件
        emit VaultTypes.RewardEarned(user, points, "Service Consumption", block.timestamp);
        _tryPushPointsBurned(user, points, "Service Consumption");
    }
    
    /// @dev 处理升级记录
    function _processUpgradeRecord(address user, ServiceType serviceType, ServiceLevel newLevel, uint256 points) internal {
        // 获取积分代币合约
        RewardPoints rewardToken = RewardPoints(Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_REWARD_POINTS));
        
        // 扣除积分
        rewardToken.burnPoints(user, points);
        
        // 更新统计
        _totalConsumedPoints += points;
        
        // 记录升级
        ConsumptionRecord memory record = ConsumptionRecord({
            points: points,
            timestamp: block.timestamp,
            serviceType: serviceType,
            serviceLevel: newLevel,
            isActive: true,
            expirationTime: block.timestamp + 30 days
        });
        
        _userConsumptions[user].push(record);
        
        // 更新特权状态
        _updateUserPrivilege(user, serviceType, newLevel);
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_UPGRADE_SERVICE,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_UPGRADE_SERVICE),
            user,
            block.timestamp
        );
        
        // 记录奖励消费事件
        emit VaultTypes.RewardEarned(user, points, "Service Upgrade", block.timestamp);
        _tryPushPointsBurned(user, points, "Service Upgrade");
    }
    
    /// @dev 处理批量消费
    function _processBatchConsumption(
        address[] calldata users,
        ServiceType[] calldata serviceTypes,
        ServiceLevel[] calldata levels
    ) internal returns (uint256 totalPoints) {
        if (users.length != serviceTypes.length || users.length != levels.length) {
            revert InvalidCaller();
        }
        
        for (uint256 i = 0; i < users.length; i++) {
            ServiceConfig memory config = _getServiceConfig(serviceTypes[i], levels[i]);
            totalPoints += config.price;
            
            _processConsumptionRecord(users[i], serviceTypes[i], levels[i], config.price);
        }
        
        _totalBatchConsumptions++;
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_CONSUME_POINTS,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_CONSUME_POINTS),
            msg.sender,
            block.timestamp
        );
        
        return totalPoints;
    }
    
    /// @dev 更新用户特权状态
    function _updateUserPrivilege(address user, ServiceType serviceType, ServiceLevel level) internal {
        UserPrivilege storage privilege = _userPrivileges[user];
        
        if (serviceType == ServiceType.AdvancedAnalytics) {
            privilege.hasAdvancedAnalytics = true;
            privilege.analyticsLevel = uint256(level);
        } else if (serviceType == ServiceType.PriorityService) {
            privilege.hasPriorityService = true;
            privilege.priorityLevel = uint256(level);
        } else if (serviceType == ServiceType.FeatureUnlock) {
            privilege.hasFeatureUnlock = true;
            privilege.featureLevel = uint256(level);
        } else if (serviceType == ServiceType.GovernanceAccess) {
            privilege.hasGovernanceAccess = true;
            privilege.governanceLevel = uint256(level);
        } else if (serviceType == ServiceType.TestnetFeatures) {
            privilege.hasTestnetFeatures = true;
            privilege.testnetLevel = uint256(level);
        }
        // 将 privilege 打包（最小实现：压成一个 uint256，按位编码）
        uint256 packed = 0;
        if (privilege.hasAdvancedAnalytics) packed |= 1 << 0;
        if (privilege.hasPriorityService)   packed |= 1 << 1;
        if (privilege.hasFeatureUnlock)     packed |= 1 << 2;
        if (privilege.hasGovernanceAccess)  packed |= 1 << 3;
        if (privilege.hasTestnetFeatures)   packed |= 1 << 4;
        packed |= (privilege.analyticsLevel & 0xFF) << 8;
        packed |= (privilege.priorityLevel & 0xFF) << 16;
        packed |= (privilege.featureLevel & 0xFF) << 24;
        packed |= (privilege.governanceLevel & 0xFF) << 32;
        packed |= (privilege.testnetLevel & 0xFF) << 40;
        _tryPushUserPrivilege(user, packed);
    }

    // RewardView 推送工具由基类提供

    /// @notice 升级授权函数
    /// @dev onlyRole modifier 已经足够验证权限
    /// @dev 如需接入 Timelock/Multisig 治理，应在此处增加相应的权限检查逻辑
    function _authorizeUpgrade(address) internal view override {
        _requireRole(ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
    }

    // ========== 基类抽象实现 ==========
    function _getRegistryAddr() internal view override returns (address) {
        return _registryAddr;
    }
} 