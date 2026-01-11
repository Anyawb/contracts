// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IRegistryUpgradeEvents } from "../interfaces/IRegistryUpgradeEvents.sol";
import { RewardTypes } from "./RewardTypes.sol";
import { IServiceConfig } from "./interfaces/IServiceConfig.sol";
import { ActionKeys } from "../constants/ActionKeys.sol";
import { ModuleKeys } from "../constants/ModuleKeys.sol";
import { VaultTypes } from "../Vault/VaultTypes.sol";
import { ZeroAddress } from "../errors/StandardErrors.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { RewardModuleBase } from "./internal/RewardModuleBase.sol";

/// @title BaseServiceConfig - 服务配置基础抽象合约
/// @notice 提供服务配置模块的基础功能和通用逻辑
/// @dev 所有服务配置子模块都应继承此合约
abstract contract BaseServiceConfig is 
    Initializable, 
    UUPSUpgradeable,
    IServiceConfig,
    RewardTypes,
    RewardModuleBase,
    IRegistryUpgradeEvents
{
    /// @notice Registry 合约地址（内部存储，供子模块使用）
    /// @dev 存储布局已上线，字段名保持兼容；外部读入口推荐统一从 RewardView 走（或透传）。
    address internal registryAddr;

    // NOTE:
    // - 本合约不做本地 ACM 地址缓存；权限校验统一走 RewardModuleBase._requireRole() → Registry.KEY_ACCESS_CONTROL。
    // - 这与 Architecture-Guide / Cache-Architecture-Guide 的主线一致：避免引入“易 stale 的模块地址缓存”，只在 A 类模块缓存中统一治理刷新。

    /* ============ Modifiers ============ */
    // onlyValidRegistry 由基类提供
    
    /// @notice 服务配置映射
    mapping(ServiceLevel => ServiceConfig) internal configs;
    
    /// @notice 服务冷却期 (秒)
    uint256 internal cooldown;

    event ConfigUpdated(uint8 level, uint256 price, uint256 duration, bool isActive);
    event CooldownUpdated(uint256 cooldown);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice 初始化合约
    /// @param initialRegistryAddr Registry 合约地址
    function initialize(address initialRegistryAddr) external virtual initializer {
        _initialize(initialRegistryAddr);
    }
    
    /// @dev 内部初始化函数
    /// @param initialRegistryAddr Registry 合约地址
    function _initialize(address initialRegistryAddr) internal virtual {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        
        __UUPSUpgradeable_init();
        registryAddr = initialRegistryAddr;
        
        _initializeConfigs();
        _initializeCooldown();
    }

    // ========== 接口实现 ==========

    /// @notice 获取Registry地址
    /// @return Registry合约地址
    function getRegistry() external view virtual returns (address) {
        return registryAddr;
    }

    /// @inheritdoc IServiceConfig
    function getConfig(ServiceLevel level) external view override onlyValidRegistry returns (ServiceConfig memory config) {
        return configs[level];
    }

    /// @inheritdoc IServiceConfig
    function updateConfig(
        ServiceLevel level,
        uint256 price,
        uint256 duration,
        bool isActive
    ) external virtual override onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        configs[level] = ServiceConfig({
            price: price,
            duration: duration,
            isActive: isActive,
            level: level,
            description: configs[level].description
        });
        
        emit ConfigUpdated(uint8(level), price, duration, isActive);
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
    }

    /// @inheritdoc IServiceConfig
    function getCooldown() external view override onlyValidRegistry returns (uint256) {
        return cooldown;
    }

    // NOTE: 如需进一步 gas 优化，应在 ACM/Registry 侧做批量校验或专用入口，
    // 而不是在各业务合约内引入本地“模块地址缓存”（易 stale + 难审计）。

    /// @inheritdoc IServiceConfig
    function setCooldown(uint256 newCooldown) external virtual override onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        cooldown = newCooldown;
        emit CooldownUpdated(newCooldown);
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
    }

    // ========== 抽象函数 ==========

    /// @dev 初始化服务配置 - 子合约必须实现
    function _initializeConfigs() internal virtual;
    
    /// @dev 初始化冷却期 - 子合约必须实现
    function _initializeCooldown() internal virtual;

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
        return registryAddr;
    }

    /// @notice 更新Registry地址
    /// @param newRegistryAddr 新的Registry地址
    /// @dev Registry地址不能为零地址
    function setRegistry(address newRegistryAddr) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        if (newRegistryAddr == address(0)) revert ZeroAddress();
        
        address oldRegistry = registryAddr;
        registryAddr = newRegistryAddr;
        
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

    // ============ UUPS storage gap ============
    uint256[50] private __gap;
} 