// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import { IAccessControlManager } from "../interfaces/IAccessControlManager.sol";
import { IRegistry } from "../interfaces/IRegistry.sol";
import { IRegistryUpgradeEvents } from "../interfaces/IRegistryUpgradeEvents.sol";
import { ModuleKeys } from "../constants/ModuleKeys.sol";
import { RewardTypes } from "./RewardTypes.sol";
import { RewardCore } from "./RewardCore.sol";
import { IRewardConsumptionErrors } from "../interfaces/IRewardConsumptionErrors.sol";
import { IRewardConsumptionEvents } from "../interfaces/IRewardConsumptionEvents.sol";
import { ActionKeys } from "../constants/ActionKeys.sol";
import { VaultTypes } from "../Vault/VaultTypes.sol";
import { ZeroAddress } from "../errors/StandardErrors.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import { RewardModuleBase } from "./internal/RewardModuleBase.sol";

/// @title RewardConsumption - 积分消费统一管理合约
/// @notice 整合消费管理、逻辑处理、记录存储、验证、权限、查询和配置功能
/// @dev 遵循 docs/SmartContractStandard.md 注释规范
/// @dev 与 Registry 系统完全集成，使用标准化的模块管理
contract RewardConsumption is 
    IRewardConsumptionErrors, 
    IRewardConsumptionEvents,
    Initializable, 
    ReentrancyGuardUpgradeable, 
    UUPSUpgradeable,
    RewardTypes,
    RewardModuleBase,
    IRegistryUpgradeEvents
{
    
    /// @notice 核心业务合约（私有存储）
    RewardCore private _rewardCore;
    
    /// @notice Registry 合约地址（私有存储）
    address private _registryAddr;

    /* ============ Modifiers ============ */
    // onlyValidRegistry 由基类提供

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }
    
    /// @notice Registry 地址更新事件
    /// @dev 记录 Registry 地址的变更
    event RegistryUpdated(address indexed oldRegistry, address indexed newRegistry);

    /// @notice 初始化合约
    /// @param coreAddr 核心业务合约地址
    /// @param initialRegistryAddr Registry 合约地址
    function initialize(address coreAddr, address initialRegistryAddr) external initializer {
        if (coreAddr == address(0)) revert RewardConsumption__ZeroAddress();
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        
        _rewardCore = RewardCore(coreAddr);
        _registryAddr = initialRegistryAddr;
        
        // 记录初始化动作
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
    }

    // ========== 内部函数 ==========
    
    // 权限验证由基类 _requireRole 提供
    
    // ========== 公共接口 ==========

    /// @notice 消费积分购买服务
    /// @param _serviceType 服务类型
    /// @param _level 服务等级
    function consumePointsForService(ServiceType _serviceType, ServiceLevel _level) external nonReentrant onlyValidRegistry {
        _rewardCore.consumePointsForService(_serviceType, _level);
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
        _rewardCore.batchConsumePoints(users, serviceTypes, levels);
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_BATCH_WITHDRAW,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_BATCH_WITHDRAW),
            msg.sender,
            block.timestamp
        );
    }

    /// @notice 升级服务等级
    /// @param serviceType 服务类型
    /// @param newLevel 新等级
    function upgradeServiceLevel(ServiceType serviceType, ServiceLevel newLevel) external nonReentrant onlyValidRegistry {
        _rewardCore.upgradeServiceLevel(serviceType, newLevel);
    }

    // ========== 管理接口 ==========

    /// @notice 更新服务配置
    /// @dev 更新 Reward 服务配置（占位实现，参数留作未来使用）
    function updateServiceConfig(
        ServiceType /*serviceType*/,
        ServiceLevel /*level*/,
        uint256 /*price*/,
        uint256 /*duration*/,
        bool /*isActive*/
    ) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        // 通过 RewardCore 更新配置
        // 这里需要调用具体的服务配置模块
        // 由于模块化架构，这里需要先获取对应的配置模块
        // 暂时保留接口，具体实现需要根据模块化架构调整
        
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
        _rewardCore.setUpgradeMultiplier(multiplier);
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
    }

    /// @notice 更新服务冷却期
    /// @dev 更新服务冷却期（占位实现）
    function setServiceCooldown(ServiceType /*serviceType*/, uint256 /*cooldown*/) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        // 通过 RewardCore 更新冷却期
        // 这里需要调用具体的服务配置模块
        // 暂时保留接口，具体实现需要根据模块化架构调整
        
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
        _rewardCore.setTestnetMode(isTestnet);
        
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

    // ============ 基类抽象实现 ============
    function _getRegistryAddr() internal view override returns (address) {
        return _registryAddr;
    }
    

} 