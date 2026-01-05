// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { RewardPoints } from "../Token/RewardPoints.sol";
/// @dev 最小接口：通过 RMCore 代理销毁积分，保持 MINTER_ROLE 仅授予 RMCore
interface IRewardManagerCoreBurn {
    function burnPointsFor(address user, uint256 points) external;
}
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
    /// @notice 入口收紧引导错误（用于提示外部调用者应通过 RewardConsumption 调用）
    error RewardCore__UseRewardConsumptionEntry();
    /// @notice DEPRECATED：检测到直接调用核心入口，将被拒绝
    event DeprecatedDirectEntryAttempt(address indexed caller, uint256 timestamp);
    
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
    function consumePointsForService(ServiceType serviceType, ServiceLevel level) external onlyValidRegistry {
        serviceType; level; // deprecated entry: keep signature stable, silence unused warnings
        // 收紧入口：仅允许 RewardConsumption 调用（对外统一入口）
        address consumption = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_REWARD_CONSUMPTION);
        if (msg.sender != consumption) {
            emit DeprecatedDirectEntryAttempt(msg.sender, block.timestamp);
            revert RewardCore__UseRewardConsumptionEntry();
        }
        // 兼容旧签名：由 RewardConsumption 使用新函数携带 user；此处不再支持“隐式 user=msg.sender”语义
        revert RewardCore__UseRewardConsumptionEntry();
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
        address consumption = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_REWARD_CONSUMPTION);
        if (msg.sender != consumption) {
            emit DeprecatedDirectEntryAttempt(msg.sender, block.timestamp);
            revert RewardCore__UseRewardConsumptionEntry();
        }
        // 仅 RewardConsumption 可触发批量；权限校验由 RewardConsumption 负责
        _batchConsumePoints(users, serviceTypes, levels);
    }

    /// @notice 升级服务等级
    /// @param serviceType 服务类型
    /// @param newLevel 新等级
    function upgradeServiceLevel(ServiceType serviceType, ServiceLevel newLevel) external onlyValidRegistry {
        serviceType; newLevel; // deprecated entry: keep signature stable, silence unused warnings
        address consumption = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_REWARD_CONSUMPTION);
        if (msg.sender != consumption) {
            emit DeprecatedDirectEntryAttempt(msg.sender, block.timestamp);
            revert RewardCore__UseRewardConsumptionEntry();
        }
        revert RewardCore__UseRewardConsumptionEntry();
    }

    /// @notice 消费积分购买服务（仅 RewardConsumption 调用，显式指定 user）
    function consumePointsForServiceFor(address user, ServiceType serviceType, ServiceLevel level)
        external
        nonReentrant
        onlyValidRegistry
        returns (uint256 pointsBurned, uint256 privilegePacked, uint256 expirationTime)
    {
        address consumption = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_REWARD_CONSUMPTION);
        if (msg.sender != consumption) {
            emit DeprecatedDirectEntryAttempt(msg.sender, block.timestamp);
            revert RewardCore__UseRewardConsumptionEntry();
        }
        ServiceConfig memory config = _getServiceConfig(serviceType, level);
        pointsBurned = config.price;
        expirationTime = block.timestamp + config.duration;
        _consumePointsForService(user, serviceType, level);
        privilegePacked = _packUserPrivilege(user);
    }

    /// @notice 升级服务等级（仅 RewardConsumption 调用，显式指定 user）
    function upgradeServiceLevelFor(address user, ServiceType serviceType, ServiceLevel newLevel)
        external
        nonReentrant
        onlyValidRegistry
        returns (uint256 pointsBurned, uint256 privilegePacked, uint256 expirationTime)
    {
        address consumption = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_REWARD_CONSUMPTION);
        if (msg.sender != consumption) {
            emit DeprecatedDirectEntryAttempt(msg.sender, block.timestamp);
            revert RewardCore__UseRewardConsumptionEntry();
        }
        ServiceConfig memory config = _getServiceConfig(serviceType, newLevel);
        pointsBurned = (config.price * _upgradeMultiplier) / 10000;
        expirationTime = block.timestamp + config.duration;
        _upgradeServiceLevel(user, serviceType, newLevel);
        privilegePacked = _packUserPrivilege(user);
    }

    /// @notice 批量消费（仅 RewardConsumption 调用）；返回每个用户的扣减积分与最新特权 packed
    function batchConsumePointsFor(
        address[] calldata users,
        ServiceType[] calldata serviceTypes,
        ServiceLevel[] calldata levels
    )
        external
        onlyValidRegistry
        returns (uint256[] memory pointsBurned, uint256[] memory privilegePacked, uint256[] memory expirationTimes)
    {
        address consumption = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_REWARD_CONSUMPTION);
        if (msg.sender != consumption) {
            emit DeprecatedDirectEntryAttempt(msg.sender, block.timestamp);
            revert RewardCore__UseRewardConsumptionEntry();
        }
        if (users.length != serviceTypes.length || users.length != levels.length) revert InvalidCaller();
        pointsBurned = new uint256[](users.length);
        privilegePacked = new uint256[](users.length);
        expirationTimes = new uint256[](users.length);
        for (uint256 i = 0; i < users.length; i++) {
            ServiceConfig memory config = _getServiceConfig(serviceTypes[i], levels[i]);
            pointsBurned[i] = config.price;
            expirationTimes[i] = block.timestamp + config.duration;
            _consumePointsForService(users[i], serviceTypes[i], levels[i]);
            privilegePacked[i] = _packUserPrivilege(users[i]);
        }
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

        // expirationTime 必须严格以配置模块的 duration 为准（与 RewardConsumption→RewardView 推送对齐）
        uint256 expirationTime = block.timestamp + config.duration;
        _processConsumptionRecord(user, serviceType, level, config.price, expirationTime);
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
        // expirationTime 必须严格以配置模块的 duration 为准（与 RewardConsumption→RewardView 推送对齐）
        uint256 expirationTime = block.timestamp + config.duration;
        _processUpgradeRecord(user, serviceType, newLevel, upgradeCost, expirationTime);
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
    function _processConsumptionRecord(
        address user,
        ServiceType serviceType,
        ServiceLevel level,
        uint256 points,
        uint256 expirationTime
    ) internal {
        // 扣减积分通过 RMCore 代理，保持 MINTER_ROLE 仅授予 RMCore
        _getRewardManagerCore().burnPointsFor(user, points);
        
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
            expirationTime: expirationTime
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

        // DEPRECATED：消费侧事件以 RewardView.DataPushed(DATA_TYPE_REWARD_BURNED/...) 为准，避免重复与语义混淆（RewardEarned 名称不适用于消费）。
    }
    
    /// @dev 处理升级记录
    function _processUpgradeRecord(
        address user,
        ServiceType serviceType,
        ServiceLevel newLevel,
        uint256 points,
        uint256 expirationTime
    ) internal {
        // 扣减积分通过 RMCore 代理，保持 MINTER_ROLE 仅授予 RMCore
        _getRewardManagerCore().burnPointsFor(user, points);
        
        // 更新统计
        _totalConsumedPoints += points;
        
        // 记录升级
        ConsumptionRecord memory record = ConsumptionRecord({
            points: points,
            timestamp: block.timestamp,
            serviceType: serviceType,
            serviceLevel: newLevel,
            isActive: true,
            expirationTime: expirationTime
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

        // DEPRECATED：消费侧事件以 RewardView.DataPushed 为准，避免重复与语义混淆。
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

            uint256 expirationTime = block.timestamp + config.duration;
            _processConsumptionRecord(users[i], serviceTypes[i], levels[i], config.price, expirationTime);
        }
        
        _totalBatchConsumptions++;
        
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
        // push 由 RewardConsumption 负责（RewardView.onlyWriter 白名单）
    }

    function _packUserPrivilege(address user) internal view returns (uint256 packed) {
        UserPrivilege storage privilege = _userPrivileges[user];
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
    }

    // RewardView 推送工具由基类提供

    /// @notice 升级授权函数
    /// @dev onlyRole modifier 已经足够验证权限
    /// @dev 如需接入 Timelock/Multisig 治理，应在此处增加相应的权限检查逻辑
    function _authorizeUpgrade(address newImplementation) internal view override {
        _requireRole(ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
        if (newImplementation == address(0)) revert ZeroAddress();
    }

    // ========== 基类抽象实现 ==========
    function _getRegistryAddr() internal view override returns (address) {
        return _registryAddr;
    }

    /// @dev 获取 RewardManagerCore（用于代理 burn，保持 MINTER_ROLE 仅在 RMCore）
    function _getRewardManagerCore() internal view returns (IRewardManagerCoreBurn) {
        address rmCore = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_REWARD_MANAGER_CORE);
        return IRewardManagerCoreBurn(rmCore);
    }

    // ============ UUPS storage gap ============
    uint256[50] private __gap;
} 