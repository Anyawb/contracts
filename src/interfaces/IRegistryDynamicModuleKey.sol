// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IRegistryDynamicModuleKey
/// @notice 动态模块键注册管理器接口
/// @dev 专注于动态注册功能，查询功能委托给RegistryQueryLibrary
interface IRegistryDynamicModuleKey {
    // ============ Events ============
    /// @notice 模块键注册事件
    event ModuleKeyRegistered(bytes32 indexed moduleKey, string name, bytes32 indexed nameHash, address indexed registrant, uint256 timestamp);
    /// @notice 模块键注销事件
    event ModuleKeyUnregistered(bytes32 indexed moduleKey, string name, address indexed unregistrant, uint256 timestamp);
    /// @notice 注册管理员变更事件
    event RegistrationAdminChanged(address indexed oldAdmin, address indexed newAdmin, uint256 timestamp);
    /// @notice 系统管理员变更事件
    event SystemAdminChanged(address indexed oldAdmin, address indexed newAdmin, uint256 timestamp);

    // ============ Custom Errors ============
    /// @notice 模块键已存在错误
    error RegistryDynamicModuleKey__ModuleKeyAlreadyExists(bytes32 moduleKey);
    /// @notice 模块键不存在错误
    error RegistryDynamicModuleKey__ModuleKeyNotExists(bytes32 moduleKey);
    /// @notice 模块名称不存在错误
    error RegistryDynamicModuleKey__ModuleNameNotExists(string name);
    /// @notice 无效的模块键名称错误
    error RegistryDynamicModuleKey__InvalidModuleKeyName(string name);
    /// @notice 模块键数量超限错误
    error RegistryDynamicModuleKey__ModuleKeyLimitExceeded(uint256 current, uint256 limit);
    /// @notice 批量注册数量超限错误
    error RegistryDynamicModuleKey__BatchSizeLimitExceeded(uint256 batchSize, uint256 limit);
    /// @notice 只有注册管理员可以操作错误
    error RegistryDynamicModuleKey__OnlyRegistrationAdmin(address caller);
    /// @notice 只有系统管理员可以操作错误
    error RegistryDynamicModuleKey__OnlySystemAdmin(address caller);
    /// @notice 名称包含无效字符错误
    error RegistryDynamicModuleKey__InvalidCharacterInName(string name, uint256 position);

    // ============ Module Key Registration ============
    
    /// @notice 注册新的动态模块键
    /// @param name 模块键名称
    /// @return moduleKey 生成的模块键
    function registerModuleKey(string calldata name) external returns (bytes32 moduleKey);

    /// @notice 批量注册动态模块键
    /// @param names 模块键名称数组
    /// @return moduleKeys 生成的模块键数组
    /// @dev ⚠️ 注意：如果数组中任何一个名称不符合规范，整个交易将回滚
    /// @dev 建议在调用前验证所有名称的合法性，或使用 tryRegister 版本
    function batchRegisterModuleKeys(string[] calldata names) external returns (bytes32[] memory moduleKeys);

    /// @notice 注销动态模块键
    /// @param moduleKey 要注销的模块键
    function unregisterModuleKey(bytes32 moduleKey) external;

    // ============ Core Dynamic Module Key Functions ============
    
    /// @notice 检查模块键是否为动态模块键
    /// @param moduleKey 要检查的模块键
    /// @return 是否为动态模块键
    function isDynamicModuleKey(bytes32 moduleKey) external view returns (bool);

    /// @notice 检查模块键是否有效（包括静态和动态）
    /// @param moduleKey 要检查的模块键
    /// @return 是否为有效模块键
    function isValidModuleKey(bytes32 moduleKey) external view returns (bool);

    /// @notice 根据名称获取模块键
    /// @param name 模块键名称
    /// @return moduleKey 对应的模块键
    function getModuleKeyByName(string calldata name) external view returns (bytes32 moduleKey);

    /// @notice 根据模块键获取名称
    /// @param moduleKey 模块键
    /// @return name 对应的名称
    function getModuleKeyName(bytes32 moduleKey) external view returns (string memory name);

    // ============ Dynamic Module Key Management Functions ============
    
    /// @notice 获取所有动态模块键
    /// @return keys 动态模块键数组
    function getDynamicModuleKeys() external view returns (bytes32[] memory keys);
    
    /// @notice 获取动态模块键总数
    function getDynamicKeyCount() external view returns (uint256);
    
    /// @notice 获取动态模块键名称（原始数据）
    /// @param moduleKey 模块键
    /// @return name 模块键名称
    function getDynamicModuleKeyName(bytes32 moduleKey) external view returns (string memory name);
    
    /// @notice 根据名称哈希获取模块键
    /// @param nameHash 名称哈希
    /// @return moduleKey 对应的模块键
    function getNameHashToModuleKey(bytes32 nameHash) external view returns (bytes32 moduleKey);
    
    /// @notice 获取动态模块键列表中的指定索引
    /// @param index 索引
    /// @return moduleKey 模块键
    function getDynamicModuleKeyByIndex(uint256 index) external view returns (bytes32 moduleKey);

    // ============ Admin Functions ============
    
    /// @notice 获取注册管理员地址
    function getRegistrationAdmin() external view returns (address);
    
    /// @notice 获取系统管理员地址
    function getSystemAdmin() external view returns (address);
    
    /// @notice 设置注册管理员
    /// @param newRegistrationAdmin 新的注册管理员地址
    function setRegistrationAdmin(address newRegistrationAdmin) external;

    /// @notice 设置系统管理员
    /// @param newSystemAdmin 新的系统管理员地址
    function setSystemAdmin(address newSystemAdmin) external;

    /// @notice 紧急暂停
    function pause() external;

    /// @notice 恢复运行
    function unpause() external;
} 