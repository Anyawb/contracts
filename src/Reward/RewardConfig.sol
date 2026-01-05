// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IRegistryUpgradeEvents } from "../interfaces/IRegistryUpgradeEvents.sol";
import { IRegistry } from "../interfaces/IRegistry.sol";
import { ModuleKeys } from "../constants/ModuleKeys.sol";
import { RewardTypes } from "./RewardTypes.sol";
import { IServiceConfig } from "./interfaces/IServiceConfig.sol";
import { ActionKeys } from "../constants/ActionKeys.sol";
import { VaultTypes } from "../Vault/VaultTypes.sol";
import { ZeroAddress } from "../errors/StandardErrors.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { RewardModuleBase } from "./internal/RewardModuleBase.sol";

/// @title RewardConfig - 积分系统配置管理
/// @notice 管理服务配置、价格和冷却期设置
/// @dev 遵循 docs/SmartContractStandard.md 注释规范
/// @dev 使用模块化架构，每个服务类型对应一个子配置合约
/// @dev 与 Registry 系统完全集成，使用标准化的模块管理
contract RewardConfig is 
    Initializable, 
    UUPSUpgradeable,
    RewardTypes,
    RewardModuleBase,
    IRegistryUpgradeEvents
{
    // ============ Errors ============
    error RewardConfig__InvalidServiceType(uint8 serviceType);
    error RewardConfig__InvalidServiceLevel(uint8 level);
    error RewardConfig__ServiceConfigModuleNotFound(uint8 serviceType);
    error RewardConfig__InvalidConfigModuleAddress();
    
    /// @notice Registry 合约地址（私有存储）
    address private _registryAddr;

    /* ============ Modifiers ============ */
    // onlyValidRegistry 由基类提供
    
    /// @notice 服务配置模块映射（私有存储）
    mapping(ServiceType => IServiceConfig) private _serviceConfigModules;
    
    /// @notice 特权升级费用倍数 (BPS)
    uint256 private _upgradeMultiplier;
    
    /// @notice 测试网模式
    bool private _isTestnetMode;

    event ServiceConfigModuleUpdated(uint8 serviceType, address configModule);
    event UpgradeMultiplierUpdated(uint256 multiplier);
    event TestnetModeUpdated(bool isTestnet);
    
    /// @notice Registry 地址更新事件
    /// @dev 记录 Registry 地址的变更
    event RegistryUpdated(address indexed oldRegistry, address indexed newRegistry);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice 初始化合约
    /// @param initialRegistryAddr Registry 合约地址
    function initialize(address initialRegistryAddr) external initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        
        __UUPSUpgradeable_init();
        _registryAddr = initialRegistryAddr;
        
        // 初始化默认值
        _upgradeMultiplier = 15000; // 1.5x
        _isTestnetMode = true;
        
        // 记录初始化动作
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
    }

    // ========== 内部函数 ==========
    
    /// @notice 获取Registry地址
    /// @return Registry合约地址
    function getRegistry() external view returns (address) {
        return _registryAddr;
    }

    /// @notice 兼容：读取服务配置模块地址
    function serviceConfigModules(ServiceType serviceType) external view returns (address) {
        return address(_serviceConfigModules[serviceType]);
    }

    /// @notice 兼容：读取测试网模式开关
    function isTestnetMode() external view returns (bool) {
        return _isTestnetMode;
    }

    /// @notice 兼容：读取升级倍数（BPS）
    function upgradeMultiplier() external view returns (uint256) {
        return _upgradeMultiplier;
    }
    
    // 权限验证由基类 _requireRole 提供
    
    // ========== 公共接口 ==========

    /// @notice 查询服务配置
    /// @param serviceType 服务类型
    /// @param level 服务等级
    /// @return config 服务配置
    function getServiceConfig(ServiceType serviceType, ServiceLevel level) external view onlyValidRegistry returns (ServiceConfig memory config) {
        IServiceConfig configModule = _getServiceConfigModuleOrRevert(serviceType);
        return configModule.getConfig(level);
    }

    /// @notice 更新服务配置
    /// @param serviceType 服务类型
    /// @param level 服务等级
    /// @param price 价格
    /// @param duration 持续时间
    /// @param isActive 是否激活
    function updateServiceConfig(
        ServiceType serviceType,
        ServiceLevel level,
        uint256 price,
        uint256 duration,
        bool isActive
    ) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        IServiceConfig configModule = _getServiceConfigModuleOrRevert(serviceType);
        configModule.updateConfig(level, price, duration, isActive);
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
    }

    /// @notice 获取服务冷却期
    /// @param serviceType 服务类型
    /// @return cooldown 冷却期 (秒)
    function serviceCooldowns(ServiceType serviceType) external view onlyValidRegistry returns (uint256 cooldown) {
        IServiceConfig configModule = _getServiceConfigModuleOrRevert(serviceType);
        return configModule.getCooldown();
    }

    /// @notice 更新服务冷却期
    /// @param serviceType 服务类型
    /// @param cooldown 冷却期 (秒)
    function setServiceCooldown(ServiceType serviceType, uint256 cooldown) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        IServiceConfig configModule = _getServiceConfigModuleOrRevert(serviceType);
        configModule.setCooldown(cooldown);
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
    }

    /// @notice 设置服务配置模块
    /// @param serviceType 服务类型
    /// @param configModule 配置模块地址
    function setServiceConfigModule(ServiceType serviceType, IServiceConfig configModule) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        if (uint8(serviceType) > uint8(ServiceType.TestnetFeatures)) revert RewardConfig__InvalidServiceType(uint8(serviceType));
        if (address(configModule) == address(0)) revert RewardConfig__InvalidConfigModuleAddress();
        _serviceConfigModules[serviceType] = configModule;
        emit ServiceConfigModuleUpdated(uint8(serviceType), address(configModule));
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
    }

    /// @notice 更新升级倍数
    /// @param multiplier 新倍数 (BPS)
    function setUpgradeMultiplier(uint256 multiplier) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        _upgradeMultiplier = multiplier;
        emit UpgradeMultiplierUpdated(multiplier);
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
    }

    /// @notice 设置测试网模式
    /// @param isTestnet 是否为测试网模式
    function setTestnetMode(bool isTestnet) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        _isTestnetMode = isTestnet;
        emit TestnetModeUpdated(isTestnet);
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
    }

    /// @notice 升级授权函数
    /// @dev onlyRole modifier 已经足够验证权限
    /// @dev 如需接入 Timelock/Multisig 治理，应在此处增加相应的权限检查逻辑
    function _authorizeUpgrade(address newImplementation) internal override {
        _requireRole(ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
        if (newImplementation == address(0)) revert ZeroAddress();
        
        // 记录升级动作
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_UPGRADE_MODULE,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_UPGRADE_MODULE),
            msg.sender,
            block.timestamp
        );
    }

    // ============ 基类抽象实现 ============
    function _getRegistryAddr() internal view override returns (address) {
        return _registryAddr;
    }

    // ============ Internals ============
    /// @dev 解析服务配置模块：优先使用 RewardConfig 内部映射（用于“可选聚合入口”），否则回退到 Registry 的 ModuleKeys（避免地址漂移）
    function _getServiceConfigModuleOrRevert(ServiceType serviceType) internal view returns (IServiceConfig configModule) {
        if (uint8(serviceType) > uint8(ServiceType.TestnetFeatures)) revert RewardConfig__InvalidServiceType(uint8(serviceType));

        // 1) 优先读取 RewardConfig 内部映射（向后兼容：RewardConfig.test.ts & 既有部署脚本）
        configModule = _serviceConfigModules[serviceType];
        if (address(configModule) != address(0)) return configModule;

        // 2) 回退到 Registry（架构一致性：Registry 为唯一真实来源）
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
            // defensive, should be unreachable due to first check
            revert RewardConfig__InvalidServiceType(uint8(serviceType));
        }

        address cfg = IRegistry(_registryAddr).getModuleOrRevert(moduleKey);
        if (cfg == address(0)) revert RewardConfig__ServiceConfigModuleNotFound(uint8(serviceType));
        return IServiceConfig(cfg);
    }

    // ============ UUPS storage gap ============
    uint256[50] private __gap;

    /// @notice 更新Registry地址
    /// @param newRegistryAddr 新的Registry地址
    /// @dev Registry地址不能为零地址
    function setRegistry(address newRegistryAddr) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        if (newRegistryAddr == address(0)) revert ZeroAddress();
        
        address oldRegistry = _registryAddr;
        _registryAddr = newRegistryAddr;
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
        
        // 发出模块地址更新事件
        emit VaultTypes.ModuleAddressUpdated(
            ModuleKeys.getModuleKeyString(ModuleKeys.KEY_REGISTRY),
            oldRegistry,
            newRegistryAddr,
            block.timestamp
        );
    }
    
    // ============ Registry 管理 ============
    
    /// @notice 更新 Registry 地址
    /// @param newRegistryAddr 新的 Registry 地址
    /// @dev 需要 ACTION_SET_PARAMETER 权限
    function updateRegistry(address newRegistryAddr) external {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        
        if (newRegistryAddr == address(0)) revert ZeroAddress();
        
        address oldRegistry = _registryAddr;
        _registryAddr = newRegistryAddr;
        
        emit RegistryUpdated(oldRegistry, newRegistryAddr);
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
    }
    

} 