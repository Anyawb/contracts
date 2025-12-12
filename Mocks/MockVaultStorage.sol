// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IVaultStorage } from "../interfaces/IVaultStorage.sol";

/// @title MockVaultStorage
/// @notice VaultStorage 的模拟合约，用于测试环境
/// @dev 实现 IVaultStorage 接口的基本功能，提供测试所需的模拟数据
contract MockVaultStorage is IVaultStorage {
    
    /// @notice 治理地址
    address public governance;
    
    /// @notice 结算代币地址
    address public settlementToken;
    
    /// @notice RWA 代币地址
    address public rwaToken;
    
    /// @notice 保证金管理模块地址
    address public guaranteeFundManager;
    
    /// @notice 金库容量
    uint256 public vaultCapValue;
    
    /// @notice 模块映射
    mapping(bytes32 => address) private _modules;
    
    /// @notice 命名模块映射
    mapping(string => address) private _namedModules;
    
    /// @notice 模块注册状态
    mapping(bytes32 => bool) private _moduleRegistered;
    
    /// @notice 命名模块注册状态
    mapping(string => bool) private _namedModuleRegistered;

    constructor() {
        governance = msg.sender;
        settlementToken = address(0x1234567890123456789012345678901234567890); // 模拟地址
        rwaToken = address(0x2345678901234567890123456789012345678901); // 模拟地址
        guaranteeFundManager = address(0x3456789012345678901234567890123456789012); // 模拟地址
        vaultCapValue = 1000000 * 10**18; // 100万代币
    }

    /* ============ View Functions ============ */
    
    function getModule(bytes32 name) external view override returns (address) {
        return _modules[name];
    }
    
    function getNamedModule(string calldata name) external view override returns (address) {
        return _namedModules[name];
    }
    
    function isModuleRegistered(bytes32 name) external view override returns (bool) {
        return _moduleRegistered[name];
    }
    
    function isNamedModuleRegistered(string calldata name) external view override returns (bool) {
        return _namedModuleRegistered[name];
    }
    
    function getSettlementTokenAddr() external view override returns (address) {
        return settlementToken;
    }
    
    function vaultCap() external view override returns (uint256) {
        return vaultCapValue;
    }
    
    function getRwaTokenAddr() external view override returns (address) {
        return rwaToken;
    }
    
    function getGuaranteeFundManager() external view override returns (address) {
        return guaranteeFundManager;
    }

    /* ============ Admin Functions ============ */
    
    function registerModule(bytes32 name, address moduleAddress) external override {
        require(msg.sender == governance, "Only governance can register modules");
        _modules[name] = moduleAddress;
        _moduleRegistered[name] = true;
        emit ModuleRegistered(name, moduleAddress);
    }
    
    function registerNamedModule(string calldata name, address moduleAddress) external override {
        require(msg.sender == governance, "Only governance can register modules");
        _namedModules[name] = moduleAddress;
        _namedModuleRegistered[name] = true;
        emit NamedModuleRegistered(name, moduleAddress);
    }
    
    function updateModule(bytes32 name, address newAddress) external override {
        require(msg.sender == governance, "Only governance can update modules");
        require(_moduleRegistered[name], "Module not registered");
        _modules[name] = newAddress;
        emit ModuleRegistered(name, newAddress);
    }
    
    function updateNamedModule(string calldata name, address newAddress) external override {
        require(msg.sender == governance, "Only governance can update modules");
        require(_namedModuleRegistered[name], "Module not registered");
        _namedModules[name] = newAddress;
        emit NamedModuleRegistered(name, newAddress);
    }
    
    function setGovernance(address newGovernance) external override {
        require(msg.sender == governance, "Only governance can set governance");
        require(newGovernance != address(0), "Invalid governance address");
        address oldGovernance = governance;
        governance = newGovernance;
        emit GovernanceTransferred(oldGovernance, newGovernance);
    }
    
    /* ============ Test Helper Functions ============ */
    
    /// @notice 设置结算代币地址（仅测试用）
    function setSettlementToken(address _settlementToken) external {
        require(msg.sender == governance, "Only governance can set settlement token");
        settlementToken = _settlementToken;
    }
    
    /// @notice 设置 RWA 代币地址（仅测试用）
    function setRwaToken(address _rwaToken) external {
        require(msg.sender == governance, "Only governance can set RWA token");
        rwaToken = _rwaToken;
    }
    
    /// @notice 设置保证金管理模块地址（仅测试用）
    function setGuaranteeFundManager(address _guaranteeFundManager) external {
        require(msg.sender == governance, "Only governance can set guarantee fund manager");
        guaranteeFundManager = _guaranteeFundManager;
    }
    
    /// @notice 设置金库容量（仅测试用）
    function setVaultCap(uint256 _vaultCap) external {
        require(msg.sender == governance, "Only governance can set vault cap");
        vaultCapValue = _vaultCap;
    }

    /// @notice 设置Mock模块（仅测试用）
    function setMockModule(string calldata name, address moduleAddress) external {
        _namedModules[name] = moduleAddress;
        _namedModuleRegistered[name] = true;
    }
}
