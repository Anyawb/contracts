// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IVaultStorage
/// @notice VaultStorage 合约的接口定义
/// @dev 提供统一的存储访问接口，供所有模块使用
interface IVaultStorage {
    
    /* ============ Events ============ */
    /// @notice 治理地址转移事件
    event GovernanceTransferred(address indexed oldGovernance, address indexed newGovernance);
    
    /// @notice 模块注册事件
    event ModuleRegistered(bytes32 indexed moduleName, address indexed moduleAddress);
    
    /// @notice 命名模块注册事件
    event NamedModuleRegistered(string indexed moduleName, address indexed moduleAddress);

    /* ============ View Functions ============ */
    
    /// @notice 获取治理地址
    /// @return 当前治理地址
    function governance() external view returns (address);
    
    /// @notice 获取模块地址
    /// @param name 模块名称（bytes32 格式）
    /// @return 模块地址
    function getModule(bytes32 name) external view returns (address);
    
    /// @notice 获取命名模块地址
    /// @param name 模块名称（string 格式）
    /// @return 模块地址
    function getNamedModule(string calldata name) external view returns (address);
    
    /// @notice 检查模块是否已注册
    /// @param name 模块名称（bytes32 格式）
    /// @return 是否已注册
    function isModuleRegistered(bytes32 name) external view returns (bool);
    
    /// @notice 检查命名模块是否已注册
    /// @param name 模块名称（string 格式）
    /// @return 是否已注册
    function isNamedModuleRegistered(string calldata name) external view returns (bool);

    /* ============ Admin Functions ============ */
    
    /// @notice 注册模块
    /// @param name 模块名称（bytes32 格式）
    /// @param moduleAddress 模块地址
    function registerModule(bytes32 name, address moduleAddress) external;
    
    /// @notice 注册命名模块
    /// @param name 模块名称（string 格式）
    /// @param moduleAddress 模块地址
    function registerNamedModule(string calldata name, address moduleAddress) external;
    
    /// @notice 更新模块地址
    /// @param name 模块名称（bytes32 格式）
    /// @param newAddress 新的模块地址
    function updateModule(bytes32 name, address newAddress) external;
    
    /// @notice 更新命名模块地址
    /// @param name 模块名称（string 格式）
    /// @param newAddress 新的模块地址
    function updateNamedModule(string calldata name, address newAddress) external;
    
    /// @notice 设置治理地址
    /// @param newGovernance 新的治理地址
    function setGovernance(address newGovernance) external;

    function getSettlementTokenAddr() external view returns (address);
    function vaultCap() external view returns (uint256);
    function getRwaTokenAddr() external view returns (address);
    
    /// @notice 获取保证金管理模块地址
    /// @return 保证金管理模块地址
    function getGuaranteeFundManager() external view returns (address);
    
    // 如有其他需要外部调用的函数可在此补充
} 