// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { VaultUtils } from "./VaultUtils.sol";
import { VaultMath } from "./VaultMath.sol";
import { ModuleKeys } from "../constants/ModuleKeys.sol";
import { ActionKeys } from "../constants/ActionKeys.sol";
import { ExternalModuleRevertedRaw, ZeroAddress, AmountIsZero, InvalidHealthFactor, InvalidLTV } from "../errors/StandardErrors.sol";
import { IVaultStorage } from "../interfaces/IVaultStorage.sol";
import { IAccessControlManager } from "../interfaces/IAccessControlManager.sol";

/// @title VaultBase
/// @notice 基础逻辑合约，实现通用功能和权限控制
/// @dev 通过接口调用 VaultStorage，提供统一的权限管理和工具函数
/// @dev 继承 GovernanceRole 以使用统一的治理权限系统
/// @dev 使用 ActionKeys 和 ModuleKeys 进行模块化管理
/// @dev 这是一个抽象合约，供其他模块继承使用
/// @custom:security-contact security@example.com
abstract contract VaultBase {
    
    // ============ 自定义错误 ============
    /// @notice 仅限 VaultStorage 调用
    error VaultBase__OnlyVaultStorage();
    /// @notice 无效的模块地址
    error VaultBase__InvalidModuleAddress();
    /// @notice 模块未配置
    error VaultBase__ModuleNotConfigured();
    /// @notice 治理地址无效
    error VaultBase__InvalidGovernanceAddress();
    /// @notice 操作被拒绝
    error VaultBase__OperationDenied();
    
    // ============ 存储变量 ============
    /// @notice VaultStorage 合约地址
    address private _vaultStorage;
    /// @notice 访问控制管理器
    IAccessControlManager private _acm;
    
    // ============ 事件 ============
    /// @notice VaultStorage 地址更新事件
    /// @param oldStorage 旧的存储地址
    /// @param newStorage 新的存储地址
    /// @param sender 操作发起者
    event VaultStorageUpdated(address indexed oldStorage, address indexed newStorage, address indexed sender);
    
    /// @notice 治理地址更新事件
    /// @param oldGovernance 旧的治理地址
    /// @param newGovernance 新的治理地址
    /// @param sender 操作发起者
    event GovernanceUpdated(address indexed oldGovernance, address indexed newGovernance, address indexed sender);

    // ============ 修饰符 ============
    /// @notice 仅限 VaultStorage 调用
    modifier onlyVaultStorage() {
        if (msg.sender != _vaultStorage) revert VaultBase__OnlyVaultStorage();
        _;
    }

    /// @notice 仅限治理角色调用
    modifier onlyGovernance() {
        IAccessControlManager(IVaultStorage(_vaultStorage).getModule(ModuleKeys.KEY_ACCESS_CONTROL))
            .requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        _;
    }

    /// @notice 验证治理动作
    /// @param action 治理动作
    modifier validGovernanceAction(bytes32 action) {
        if (!ActionKeys.isValidActionKey(action)) revert VaultBase__OperationDenied();
        _;
    }

    // ============ 查询函数 ============
    /// @notice 获取治理地址
    /// @return 当前治理地址
    function getGovernance() external view returns (address) {
        return IVaultStorage(_vaultStorage).governance();
    }

    /// @notice 获取模块地址
    /// @param name 模块名称（bytes32 格式）
    /// @return 模块地址
    function getModule(bytes32 name) external view returns (address) {
        return IVaultStorage(_vaultStorage).getModule(name);
    }

    /// @notice 获取命名模块地址
    /// @param name 模块名称（string 格式）
    /// @return 模块地址
    function getNamedModule(string calldata name) external view returns (address) {
        return IVaultStorage(_vaultStorage).getNamedModule(name);
    }

    // 已废弃：健康因子计算器接口

    /// @notice 获取抵押物管理器地址
    /// @return 抵押物管理器地址
    function getCollateralManager() external view returns (address) {
        return IVaultStorage(_vaultStorage).getModule(ModuleKeys.KEY_CM);
    }

    /// @notice 获取借贷引擎地址
    /// @return 借贷引擎地址
    function getLendingEngine() external view returns (address) {
        return IVaultStorage(_vaultStorage).getModule(ModuleKeys.KEY_LE);
    }

    /// @notice 获取手续费路由地址
    /// @return 手续费路由地址
    function getFeeRouter() external view returns (address) {
        return IVaultStorage(_vaultStorage).getModule(ModuleKeys.KEY_FR);
    }

    /// @notice 获取奖励管理器地址
    /// @return 奖励管理器地址
    function getRewardManager() external view returns (address) {
        return IVaultStorage(_vaultStorage).getModule(ModuleKeys.KEY_RM);
    }

    /// @notice 获取保证金基金管理器地址
    /// @return 保证金基金管理器地址
    function getGuaranteeFundManager() external view returns (address) {
        return IVaultStorage(_vaultStorage).getModule(ModuleKeys.KEY_GUARANTEE_FUND);
    }

    /// @notice 获取访问控制管理器地址
    /// @return 访问控制管理器地址
    function getAccessControlManager() external view returns (address) {
        return IVaultStorage(_vaultStorage).getModule(ModuleKeys.KEY_ACCESS_CONTROL);
    }

    /// @notice 检查模块是否已注册
    /// @param name 模块名称（bytes32 格式）
    /// @return 是否已注册
    function isModuleRegistered(bytes32 name) external view returns (bool) {
        return IVaultStorage(_vaultStorage).isModuleRegistered(name);
    }

    /// @notice 检查命名模块是否已注册
    /// @param name 模块名称（string 格式）
    /// @return 是否已注册
    function isNamedModuleRegistered(string calldata name) external view returns (bool) {
        return IVaultStorage(_vaultStorage).isNamedModuleRegistered(name);
    }

    // ============ 内部函数 ============
    
    /// @notice 设置 VaultStorage 地址
    /// @param vaultStorageNew 新的 VaultStorage 地址
    function _setVaultStorage(address vaultStorageNew) internal {
        VaultUtils.validateAddress(vaultStorageNew);
        address oldStorage = _vaultStorage;
        _vaultStorage = vaultStorageNew;
        emit VaultStorageUpdated(oldStorage, vaultStorageNew, msg.sender);
    }

    /// @notice 验证地址不为零地址
    /// @param addr 待验证的地址
    function _validateAddress(address addr) internal pure {
        VaultUtils.validateAddress(addr);
    }

    /// @notice 验证金额大于零
    /// @param amount 待验证的金额
    function _validateAmount(uint256 amount) internal pure {
        VaultUtils.validateAmount(amount);
    }

    /// @notice 验证健康因子在有效范围内
    /// @param hf 健康因子值（基点）
    /// @dev 健康因子必须在 100% (10000) 以上
    function _validateHealthFactor(uint256 hf) internal pure {
        VaultUtils.validateHealthFactor(hf);
    }

    /// @notice 验证 LTV 在有效范围内
    /// @param ltv 贷款价值比（基点）
    /// @dev LTV 必须在 0-100% (0-10000) 范围内
    function _validateLTV(uint256 ltv) internal pure {
        VaultUtils.validateLTV(ltv);
    }

    /// @notice 验证治理地址
    /// @param governance 治理地址
    function _validateGovernanceAddress(address governance) internal pure {
        if (governance == address(0)) revert VaultBase__InvalidGovernanceAddress();
    }

    // ============ 模块地址工具函数 ============
    /// @notice 验证模块地址是否已设置
    /// @param moduleAddr 模块地址
    /// @return 是否已设置
    function _isModuleConfigured(address moduleAddr) internal pure returns (bool) {
        return VaultUtils.isModuleConfigured(moduleAddr);
    }

    /// @notice 获取模块地址，如果未配置则回退到默认值
    /// @param moduleAddr 模块地址
    /// @param fallbackAddr 回退地址
    /// @return 有效的模块地址
    function _getModuleAddress(address moduleAddr, address fallbackAddr) internal pure returns (address) {
        return VaultUtils.getModuleAddress(moduleAddr, fallbackAddr);
    }

    /// @notice 安全获取模块地址
    /// @param moduleAddr 模块地址
    /// @param fallbackAddr 回退地址
    /// @param moduleName 模块名称
    /// @return 有效的模块地址
    function _getModuleAddressSafe(
        address moduleAddr, 
        address fallbackAddr, 
        string memory moduleName
    ) internal pure returns (address) {
        return VaultUtils.getModuleAddressSafe(moduleAddr, fallbackAddr, moduleName);
    }

    // ============ 数学工具函数 ============
    /// @notice 计算 LTV（贷款价值比）- 使用 VaultMath 库
    /// @param debt 债务金额
    /// @param collateral 抵押物价值
    /// @return ltv 贷款价值比（basis points）
    function _calculateLTV(uint256 debt, uint256 collateral) internal pure returns (uint256 ltv) {
        return VaultMath.calculateLTV(debt, collateral);
    }

    /// @notice 计算健康因子 - 使用 VaultMath 库
    /// @param collateral 抵押物价值
    /// @param debt 债务金额
    /// @param bonusBps 奖励基点
    /// @return 健康因子（basis points）
    function _calculateHealthFactor(uint256 collateral, uint256 debt, uint256 bonusBps) internal pure returns (uint256) {
        if (debt == 0) return type(uint256).max;
        uint256 baseHF = VaultMath.calculateHealthFactor(collateral, debt);
        if (bonusBps > 0) {
            return baseHF + VaultMath.percentageMul(baseHF, bonusBps);
        }
        return baseHF;
    }

    /// @notice 计算最小健康因子 - 使用 VaultMath 库
    /// @param collateral 抵押物价值
    /// @param debt 债务金额
    /// @return 最小健康因子
    function _calculateMinHealthFactor(uint256 collateral, uint256 debt) internal pure returns (uint256) {
        return VaultMath.calculateHealthFactor(collateral, debt);
    }

    // ============ 治理函数 ============
    /// @notice 设置治理地址
    /// @param newGovernance 新的治理地址
    /// @dev 仅限治理角色调用
    function setGovernance(address newGovernance) external onlyGovernance validGovernanceAction(ActionKeys.ACTION_SET_PARAMETER) {
        _validateGovernanceAddress(newGovernance);
        address oldGovernance = IVaultStorage(_vaultStorage).governance();
        IVaultStorage(_vaultStorage).setGovernance(newGovernance);
        emit GovernanceUpdated(oldGovernance, newGovernance, msg.sender);
    }

    /// @notice 更新 VaultStorage 地址
    /// @param newVaultStorage 新的 VaultStorage 地址
    /// @dev 仅限治理角色调用
    function updateVaultStorage(address newVaultStorage) external onlyGovernance validGovernanceAction(ActionKeys.ACTION_SET_PARAMETER) {
        _setVaultStorage(newVaultStorage);
    }

    /// @notice 注册模块
    /// @param name 模块名称（bytes32 格式）
    /// @param moduleAddress 模块地址
    /// @dev 仅限治理角色调用
    function registerModule(bytes32 name, address moduleAddress) external onlyGovernance validGovernanceAction(ActionKeys.ACTION_SET_PARAMETER) {
        _validateAddress(moduleAddress);
        IVaultStorage(_vaultStorage).registerModule(name, moduleAddress);
    }

    /// @notice 注册命名模块
    /// @param name 模块名称（string 格式）
    /// @param moduleAddress 模块地址
    /// @dev 仅限治理角色调用
    function registerNamedModule(string calldata name, address moduleAddress) external onlyGovernance validGovernanceAction(ActionKeys.ACTION_SET_PARAMETER) {
        _validateAddress(moduleAddress);
        IVaultStorage(_vaultStorage).registerNamedModule(name, moduleAddress);
    }

    /// @notice 更新模块地址
    /// @param name 模块名称（bytes32 格式）
    /// @param newAddress 新的模块地址
    /// @dev 仅限治理角色调用
    function updateModule(bytes32 name, address newAddress) external onlyGovernance validGovernanceAction(ActionKeys.ACTION_SET_PARAMETER) {
        _validateAddress(newAddress);
        IVaultStorage(_vaultStorage).updateModule(name, newAddress);
    }

    /// @notice 更新命名模块地址
    /// @param name 模块名称（string 格式）
    /// @param newAddress 新的模块地址
    /// @dev 仅限治理角色调用
    function updateNamedModule(string calldata name, address newAddress) external onlyGovernance validGovernanceAction(ActionKeys.ACTION_SET_PARAMETER) {
        _validateAddress(newAddress);
        IVaultStorage(_vaultStorage).updateNamedModule(name, newAddress);
    }

    // ============ 辅助函数 ============
    /// @notice 获取模块字符串名称
    /// @param moduleKey 模块Key
    /// @return 模块字符串名称
    function getModuleString(bytes32 moduleKey) external pure returns (string memory) {
        return ModuleKeys.getModuleKeyString(moduleKey);
    }

    /// @notice 验证治理动作的有效性
    /// @param action 治理动作
    /// @return 是否为有效的治理动作
    function isValidGovernanceAction(bytes32 action) external pure returns (bool) {
        return ActionKeys.isValidActionKey(action);
    }

    /// @notice 获取治理动作的字符串名称
    /// @param action 治理动作Key
    /// @return 对应的字符串名称
    function getGovernanceActionString(bytes32 action) external pure returns (string memory) {
        return ActionKeys.getActionKeyString(action);
    }
} 