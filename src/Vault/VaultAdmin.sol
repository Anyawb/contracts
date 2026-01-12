// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { IRegistry } from "../interfaces/IRegistry.sol";
import { VaultTypes } from "./VaultTypes.sol";
import { ModuleKeys } from "../constants/ModuleKeys.sol";
import { ActionKeys } from "../constants/ActionKeys.sol";
import { InvalidHealthFactor, ZeroAddress } from "../errors/StandardErrors.sol";
import { IAccessControlManager } from "../interfaces/IAccessControlManager.sol";

/* -------------------------------------------------------------------------- */
/*                                Interfaces                                 */
/* -------------------------------------------------------------------------- */
/// @dev 精简版接口，仅包含治理需要调用的 setter，可避免在此文件引入完整合约。
import { ILiquidationRiskManager } from "../interfaces/ILiquidationRiskManager.sol";
/// @title CollateralVaultAdmin
/// @notice 治理/运营相关的参数管理函数，只允许治理地址调用。
/// @dev 独立部署的合约，通过接口与其他模块交互
/// @dev 使用 ActionKeys 和 ModuleKeys 进行标准化管理
/// @dev 使用 Registry 进行模块化管理，支持动态模块升级
/// @dev 与 Registry 系统完全集成，使用标准化的模块管理
/// @dev 简化版本，移除对已删除库文件的依赖
contract VaultAdmin is 
    Initializable,
    UUPSUpgradeable
{
    /* ============ Errors ============ */
    
    error VaultAdmin__InvalidImplementation();
    /* ============ Constructor ============ */
    /// @dev 禁用实现合约的初始化器
    /// @notice 可升级合约不能有构造函数，使用 initializer 函数
    constructor() {
        _disableInitializers();
    }

    /* ============ Storage ============ */
    // 私有存储变量 - 安全加固（重命名避免与父类冲突）
    address private _adminRegistryAddr;

    /* ============ Modifiers ============ */
    
    /// @notice 验证 Registry 地址
    modifier onlyValidRegistry() {
        if (_adminRegistryAddr == address(0)) revert ZeroAddress();
        _;
    }

    /// @notice 统一权限验证修饰符
    modifier onlyRole(bytes32 actionKey) {
        _requireRole(actionKey, msg.sender);
        _;
    }

    /* ============ Events ============ */
    

    /* ============ Initializer ============ */
    /// @notice 初始化 VaultAdmin 合约
    /// @param initialRegistryAddr Registry 合约地址
    /// @dev 使用 Registry 进行模块管理，使用 StandardErrors 进行错误处理
    function initialize(
        address initialRegistryAddr
    ) external initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        
        __UUPSUpgradeable_init();
        
        _adminRegistryAddr = initialRegistryAddr; // 设置私有变量
        
        // 发出标准化动作事件
        _emitActionExecuted(ActionKeys.ACTION_SET_PARAMETER);
    }

    /* ============ Registry 调用模式 ============ */
    /// @notice 通过Registry获取模块地址（必定revert版本）
    function _getModule(bytes32 moduleKey) internal view returns (address) {
        return IRegistry(_adminRegistryAddr).getModuleOrRevert(moduleKey);
    }

    /// @notice 验证用户权限（使用标准ACM，Gas优化）
    function _requireRole(bytes32 actionKey, address user) internal view {
        address acmAddr = _getModule(ModuleKeys.KEY_ACCESS_CONTROL);
        IAccessControlManager(acmAddr).requireRole(actionKey, user);
    }

    /// @notice 记录标准化动作事件（公共函数）
    function _emitActionExecuted(bytes32 actionKey) internal {
        emit VaultTypes.ActionExecuted(
            actionKey,
            "",
            msg.sender,
            block.timestamp
        );
    }

    /* ============ 只读 Getter 函数 ============ */
    /// @notice 获取 Registry 地址
    function getRegistryAddr() external view returns (address) {
        return _adminRegistryAddr;
    }

    /* ============ 核心业务函数 ============ */
    /// @notice 设置最小健康因子并同步到清算风险管理器
    /// @dev 改为调用 LiquidationRiskManager，移除 HealthFactorCalculator 依赖
    /// @dev 使用 ActionKeys.SET_PARAMETER 进行事件记录
    /// @dev 使用 Registry 进行模块化管理
    function setMinHealthFactor(uint256 hf) external onlyValidRegistry onlyRole(ActionKeys.ACTION_SET_PARAMETER) {
        if (!(hf > 0 && hf <= 20_000)) revert InvalidHealthFactor();

        // 1. 参数下发到 LiquidationRiskManager 模块（直接外呼，失败让底层 reason 冒泡）
        address lrm = _getModule(ModuleKeys.KEY_LIQUIDATION_RISK_MANAGER);
        if (lrm == address(0)) revert ZeroAddress();
        ILiquidationRiskManager(lrm).updateMinHealthFactor(hf);

        // 2. 记录事件，便于链上追溯
        // 注意：vaultCap现在需要通过其他方式获取，这里暂时使用0
        uint256 vaultCap = 0; // TODO: 需要从其他模块获取vaultCap
        emit VaultTypes.VaultParamsUpdated(hf, vaultCap, block.timestamp);
        
        // 3. 记录标准化动作事件
        _emitActionExecuted(ActionKeys.ACTION_SET_PARAMETER);
    }

    // 删除冗余的 VaultCap/LTV/治理地址设置与本地暂停控制，职责下沉至对应模块

    /* ============ Upgrade Auth ============ */
    /// @notice 升级授权函数
    /// @dev 使用RegistryUpgradeLibrary进行权限验证
    /// @dev 如需接入 Timelock/Multisig 治理，应在此处增加相应的权限检查逻辑
    function _authorizeUpgrade(address newImplementation) internal override {
        _requireRole(ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
        if (newImplementation == address(0)) revert ZeroAddress();
        
        // 验证新实现合约
        if (newImplementation.code.length == 0) revert VaultAdmin__InvalidImplementation();
        
        // 记录标准化动作事件
        _emitActionExecuted(ActionKeys.ACTION_UPGRADE_MODULE);
    }

    /* ============ Storage Gap ============ */
    uint256[50] private __gap;
} 