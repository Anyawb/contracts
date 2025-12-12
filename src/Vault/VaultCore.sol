// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import { Registry } from "../registry/Registry.sol";
import { ModuleKeys } from "../constants/ModuleKeys.sol";
import { ActionKeys } from "../constants/ActionKeys.sol";
import { IVaultView } from "../interfaces/IVaultView.sol";
import { IAccessControlManager } from "../interfaces/IAccessControlManager.sol";

/// @title VaultCore
/// @notice 双架构设计的极简入口合约 - 事件驱动 + View层缓存
/// @dev 遵循双架构设计：极简入口，传送数据至View层，支持Registry升级
/// @dev 移除复杂逻辑：权限验证、业务委托、资产白名单验证、暂停/恢复功能
/// @dev 只保留核心功能：用户操作传送、Registry升级能力、基础传送合约地址能力
/// @custom:security-contact security@example.com
contract VaultCore is Initializable, UUPSUpgradeable {
    
    /*━━━━━━━━━━━━━━━ 基础配置 ━━━━━━━━━━━━━━━*/
    
    /// @notice Registry 合约地址
    address private _registryAddrVar;
    
    /// @notice View层合约地址
    address private _viewContractAddr;
    
    /*━━━━━━━━━━━━━━━ 错误定义 ━━━━━━━━━━━━━━━*/
    
    error VaultCore__ZeroAddress();
    error VaultCore__InvalidAmount();
    
    /*━━━━━━━━━━━━━━━ 权限控制 ━━━━━━━━━━━━━━━*/
    
    /// @notice 管理员权限验证修饰符
    modifier onlyAdmin() {
        address acmAddr = Registry(_registryAddrVar).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        require(IAccessControlManager(acmAddr).hasRole(ActionKeys.ACTION_ADMIN, msg.sender), "Not admin");
        _;
    }

    /*━━━━━━━━━━━━━━━ 构造和初始化 ━━━━━━━━━━━━━━━*/
    
    /// @notice 初始化函数
    /// @param initialRegistryAddr Registry合约地址
    /// @param initialViewContractAddr View层合约地址
    function initialize(address initialRegistryAddr, address initialViewContractAddr) external initializer {
        if (initialRegistryAddr == address(0)) revert VaultCore__ZeroAddress();
        if (initialViewContractAddr == address(0)) revert VaultCore__ZeroAddress();
        
        __UUPSUpgradeable_init();
        _registryAddrVar = initialRegistryAddr;
        _viewContractAddr = initialViewContractAddr;
    }
    
    /// @notice 显式暴露 Registry 合约地址
    function registryAddrVar() external view returns (address) {
        return _registryAddrVar;
    }
    
    /*━━━━━━━━━━━━━━━ 用户操作（传送数据至 View 层）━━━━━━━━━━━━━━━*/
    
    /// @notice 存款操作 - 传送数据至View层
    /// @param asset 资产地址
    /// @param amount 存款金额
    /// @dev 极简实现：只验证基础参数，传送数据至View层
    function deposit(address asset, uint256 amount) external {
        require(amount > 0, "Amount must be positive");
        IVaultView(_viewContractAddr).processUserOperation(msg.sender, ActionKeys.ACTION_DEPOSIT, asset, amount, block.timestamp);
    }
    
    /// @notice 借款操作 - 传送数据至View层
    /// @param asset 资产地址
    /// @param amount 借款金额
    /// @dev 极简实现：只验证基础参数，传送数据至View层
    function borrow(address asset, uint256 amount) external {
        require(amount > 0, "Amount must be positive");
        IVaultView(_viewContractAddr).processUserOperation(msg.sender, ActionKeys.ACTION_BORROW, asset, amount, block.timestamp);
    }
    
    /// @notice 还款操作 - 传送数据至View层
    /// @param asset 资产地址
    /// @param amount 还款金额
    /// @dev 极简实现：只验证基础参数，传送数据至View层
    function repay(address asset, uint256 amount) external {
        require(amount > 0, "Amount must be positive");
        IVaultView(_viewContractAddr).processUserOperation(msg.sender, ActionKeys.ACTION_REPAY, asset, amount, block.timestamp);
    }
    
    /// @notice 提款操作 - 传送数据至View层
    /// @param asset 资产地址
    /// @param amount 提款金额
    /// @dev 极简实现：只验证基础参数，传送数据至View层
    function withdraw(address asset, uint256 amount) external {
        require(amount > 0, "Amount must be positive");
        IVaultView(_viewContractAddr).processUserOperation(msg.sender, ActionKeys.ACTION_WITHDRAW, asset, amount, block.timestamp);
    }
    
    /*━━━━━━━━━━━━━━━ Registry 基础升级能力 ━━━━━━━━━━━━━━━*/
    
    /// @notice 升级模块 - Registry基础升级能力
    /// @param moduleKey 模块键
    /// @param newAddress 新模块地址
    /// @dev 保留Registry升级能力，支持模块动态升级
    function upgradeModule(bytes32 moduleKey, address newAddress) external onlyAdmin {
        Registry(_registryAddrVar).setModuleWithReplaceFlag(moduleKey, newAddress, true);
    }
    
    /// @notice 执行模块升级 - Registry基础升级能力
    /// @param moduleKey 模块键
    /// @dev 保留Registry升级能力，支持模块升级执行
    function executeModuleUpgrade(bytes32 moduleKey) external onlyAdmin {
        Registry(_registryAddrVar).executeModuleUpgrade(moduleKey);
    }
    
    /*━━━━━━━━━━━━━━━ 基础传送合约地址的能力 ━━━━━━━━━━━━━━━*/
    
    /// @notice 获取模块地址 - 基础传送合约地址能力
    /// @param moduleKey 模块键
    /// @return moduleAddress 模块地址
    /// @dev 保留基础传送合约地址能力，支持动态模块访问
    function getModule(bytes32 moduleKey) external view returns (address moduleAddress) {
        return Registry(_registryAddrVar).getModuleOrRevert(moduleKey);
    }
    
    /// @notice 获取Registry地址 - 基础传送合约地址能力
    /// @return registryAddress Registry地址
    /// @dev 保留基础传送合约地址能力
    function getRegistry() external view returns (address registryAddress) {
        return _registryAddrVar;
    }
    
    /*━━━━━━━━━━━━━━━ 合约升级 ━━━━━━━━━━━━━━━*/
    
    /// @notice 升级授权函数
    /// @param newImplementation 新实现地址
    function _authorizeUpgrade(address newImplementation) internal view override {
        address acmAddr = Registry(_registryAddrVar).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        require(IAccessControlManager(acmAddr).hasRole(ActionKeys.ACTION_UPGRADE_MODULE, msg.sender), "Not authorized");
        
        // 确保新实现地址不为零
        if (newImplementation == address(0)) revert VaultCore__ZeroAddress();
    }
}

 