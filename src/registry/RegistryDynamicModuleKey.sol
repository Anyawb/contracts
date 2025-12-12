// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";

import { ModuleKeys } from "../constants/ModuleKeys.sol";
import { 
    ZeroAddress, 
    EmptyArray, 
    IndexOutOfBounds 
} from "../errors/StandardErrors.sol";

/// @title RegistryDynamicModuleKey
/// @notice 动态模块键注册管理器
/// @dev 支持链上动态注册新的模块键，但要限制权限
/// @dev 解决ModuleKeys.getAllKeys()硬编码问题，避免升级时必须动逻辑合约
/// @dev 专注于动态注册功能，查询功能委托给RegistryQueryLibrary
contract RegistryDynamicModuleKey is 
    Initializable, 
    OwnableUpgradeable, 
    UUPSUpgradeable,
    PausableUpgradeable
{
    // ============ Custom Errors ============
    /// @notice 模块键已存在错误
    error RegistryDynamicModuleKey__ModuleKeyAlreadyExists(bytes32 moduleKey);
    /// @notice 模块键不存在错误
    error RegistryDynamicModuleKey__ModuleKeyNotExists(bytes32 moduleKey);
    /// @notice 模块名称不存在错误
    error RegistryDynamicModuleKey__ModuleNameNotExists(bytes32 nameHash);
    /// @notice 无效的模块键名称错误
    error RegistryDynamicModuleKey__InvalidModuleKeyName();
    /// @notice 模块键数量超限错误
    error RegistryDynamicModuleKey__ModuleKeyLimitExceeded(uint256 current, uint256 limit);
    /// @notice 批量注册数量超限错误
    error RegistryDynamicModuleKey__BatchSizeLimitExceeded(uint256 batchSize, uint256 limit);
    /// @notice 只有注册管理员可以操作错误
    error RegistryDynamicModuleKey__OnlyRegistrationAdmin();
    /// @notice 只有系统管理员可以操作错误
    error RegistryDynamicModuleKey__OnlySystemAdmin();
    /// @notice 名称包含无效字符错误
    error RegistryDynamicModuleKey__InvalidCharacterInName(uint256 position);

    // ============ Events ============
    /// @notice 模块键注册事件（移除冗余 timestamp，同时精简 name 以节省日志开销）
    event ModuleKeyRegistered(bytes32 indexed moduleKey, bytes32 indexed nameHash, address indexed registrant);
    /// @notice 模块键注销事件（保留 name 便于链下快速消费）
    event ModuleKeyUnregistered(bytes32 indexed moduleKey, string name, address indexed unregistrant);
    /// @notice 注册管理员变更事件
    event RegistrationAdminChanged(address indexed oldAdmin, address indexed newAdmin);
    /// @notice 系统管理员变更事件
    event SystemAdminChanged(address indexed oldAdmin, address indexed newAdmin);

    // ============ Constants ============
    uint256 private constant MAX_DYNAMIC_KEYS = 100; // 动态模块键最大数量
    uint256 private constant MIN_NAME_LENGTH = 3; // 模块键名称最小长度（字节）
    uint256 private constant MAX_NAME_LENGTH = 50; // 模块键名称最大长度（字节）
    uint256 private constant MAX_BATCH_SIZE = 20; // 批量注册最大数量
    /// @notice 生成模块键的盐（固定前缀，防止拼接歧义，节省 gas）
    bytes32 private constant MODULE_KEY_SALT = keccak256("rwa.registry.dynamic.module.key.v1");

    // ============ State Variables ============
    /// @notice 注册管理员地址
    address private _registrationAdminAddr;
    /// @notice 系统管理员地址
    address private _systemAdminAddr;
    
    /// @notice 动态模块键集合
    mapping(bytes32 => bool) private _dynamicModuleKeys;
    /// @notice 模块键名称映射
    mapping(bytes32 => string) private _moduleKeyNames;
    /// @notice 规范化名称哈希到模块键的映射
    mapping(bytes32 => bytes32) private _nameHashToModuleKey;
    
    /// @notice 动态模块键列表
    bytes32[] private _dynamicModuleKeyList;
    /// @notice 列表索引映射（index + 1，0 表示不存在）
    mapping(bytes32 => uint256) private _keyIndexPlus1;

    // ============ Modifiers ============
    /// @notice 只有注册管理员可以操作
    modifier onlyRegistrationAdmin() {
        if (msg.sender != _registrationAdminAddr) revert RegistryDynamicModuleKey__OnlyRegistrationAdmin();
        _;
    }

    /// @notice 只有系统管理员可以操作
    modifier onlySystemAdmin() {
        if (msg.sender != _systemAdminAddr) revert RegistryDynamicModuleKey__OnlySystemAdmin();
        _;
    }

    // ============ Constructor ============
    constructor() {
        _disableInitializers();
    }

    // ============ Initializer ============
    function initialize(address initialRegistrationAdmin, address initialSystemAdmin) external initializer {
        if (initialRegistrationAdmin == address(0)) revert ZeroAddress();
        if (initialSystemAdmin == address(0)) revert ZeroAddress();
        
        __Ownable_init();
        __UUPSUpgradeable_init();
        __Pausable_init();
        
        _registrationAdminAddr = initialRegistrationAdmin;
        _systemAdminAddr = initialSystemAdmin;
        
        emit RegistrationAdminChanged(address(0), initialRegistrationAdmin);
        emit SystemAdminChanged(address(0), initialSystemAdmin);
    }

    // ============ UUPS Upgrade Authorization ============
    /// @notice 升级授权函数
    /// @dev onlyOwner modifier 已经足够验证权限
    /// @dev 如需接入 Timelock/Multisig 治理，应在此处增加相应的权限检查逻辑
    function _authorizeUpgrade(address) internal override onlyOwner {
        // onlyOwner modifier 已经足够验证权限
    }

    // ============ Internal Helper Functions ============
    
    /// @notice 规范化并校验模块键名称（单次遍历）
    /// @param name 原始名称
    /// @return normalizedName 规范化后的名称
    /// @return nameHash 名称哈希
    /// @dev 去除首尾空格、将 A-Z 转小写，并校验仅包含 [a-z0-9_-]
    function _normalizeAndValidate(string memory name) internal pure returns (string memory normalizedName, bytes32 nameHash) {
        bytes memory nameBytes = bytes(name);
        uint256 start = 0;
        uint256 end = nameBytes.length;
        while (start < end && nameBytes[start] == 0x20) { start++; }
        while (end > start && nameBytes[end - 1] == 0x20) { end--; }
        uint256 length = end - start;
        if (length < MIN_NAME_LENGTH || length > MAX_NAME_LENGTH) {
            revert RegistryDynamicModuleKey__InvalidModuleKeyName();
        }
        bytes memory normalizedBytes = new bytes(length);
        uint256 invalidPos = type(uint256).max;
        for (uint256 i = 0; i < length; ) {
            uint8 c = uint8(nameBytes[start + i]);
            if (c >= 65 && c <= 90) { c = c + 32; }
            bool ok = (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || (c == 95) || (c == 45);
            if (!ok && invalidPos == type(uint256).max) { invalidPos = i; }
            normalizedBytes[i] = bytes1(c);
            unchecked { ++i; }
        }
        normalizedName = string(normalizedBytes);
        if (invalidPos != type(uint256).max) {
            revert RegistryDynamicModuleKey__InvalidCharacterInName(invalidPos);
        }
        nameHash = keccak256(abi.encodePacked(normalizedName));
    }

    /// @notice 生成模块键
    /// @param name 模块键名称
    /// @return moduleKey 生成的模块键
    function _generateModuleKey(string memory name) internal pure returns (bytes32 moduleKey) {
        // 使用固定盐 + encodePacked，避免拼接歧义并节省 gas
        moduleKey = keccak256(abi.encodePacked(MODULE_KEY_SALT, name));
    }

    // ============ Module Key Registration ============
    
    /// @notice 注册新的动态模块键
    /// @param name 模块键名称
    /// @return moduleKey 生成的模块键
    function registerModuleKey(string calldata name) external onlyRegistrationAdmin whenNotPaused returns (bytes32 moduleKey) {
        return _registerModuleKeyCalldata(name);
    }

    /// @notice 内部注册新的动态模块键（calldata版本，节省gas）
    /// @param name 模块键名称
    /// @return moduleKey 生成的模块键
    function _registerModuleKeyCalldata(string calldata name) internal returns (bytes32 moduleKey) {
        // 规范化名称并校验（单次遍历）
        (string memory normalizedName, bytes32 nameHash) = _normalizeAndValidate(name);
        
        // 检查规范化后的名称是否已存在
        bytes32 existingKey = _nameHashToModuleKey[nameHash];
        if (existingKey != bytes32(0)) {
            revert RegistryDynamicModuleKey__ModuleKeyAlreadyExists(existingKey);
        }
        
        // 检查是否超过限制
        if (_dynamicModuleKeyList.length >= MAX_DYNAMIC_KEYS) {
            revert RegistryDynamicModuleKey__ModuleKeyLimitExceeded(_dynamicModuleKeyList.length, MAX_DYNAMIC_KEYS);
        }
        
        // 生成模块键
        moduleKey = _generateModuleKey(normalizedName);
        
        // 检查模块键是否已存在
        if (_dynamicModuleKeys[moduleKey]) {
            revert RegistryDynamicModuleKey__ModuleKeyAlreadyExists(moduleKey);
        }
        
        // 注册模块键
        _dynamicModuleKeys[moduleKey] = true;
        _moduleKeyNames[moduleKey] = normalizedName;
        _nameHashToModuleKey[nameHash] = moduleKey;
        _dynamicModuleKeyList.push(moduleKey);
        _keyIndexPlus1[moduleKey] = _dynamicModuleKeyList.length; // 记录位置（index+1）
        
        emit ModuleKeyRegistered(moduleKey, nameHash, msg.sender);
    }

    // 删除未使用的 memory 版本注册函数以减小字节码

    /// @notice 批量注册动态模块键
    /// @param names 模块键名称数组
    /// @return moduleKeys 生成的模块键数组
    /// @dev ⚠️ 注意：如果数组中任何一个名称不符合规范，整个交易将回滚
    /// @dev 建议在调用前验证所有名称的合法性，或使用 tryRegister 版本
    function batchRegisterModuleKeys(string[] calldata names) external onlyRegistrationAdmin whenNotPaused returns (bytes32[] memory moduleKeys) {
        uint256 len = names.length;
        if (len == 0) revert EmptyArray();
        if (len > MAX_BATCH_SIZE) {
            revert RegistryDynamicModuleKey__BatchSizeLimitExceeded(len, MAX_BATCH_SIZE);
        }
        uint256 current = _dynamicModuleKeyList.length;
        if (len + current > MAX_DYNAMIC_KEYS) {
            revert RegistryDynamicModuleKey__ModuleKeyLimitExceeded(len + current, MAX_DYNAMIC_KEYS);
        }
        moduleKeys = new bytes32[](len);
        for (uint256 i = 0; i < len; ) {
            moduleKeys[i] = _registerModuleKeyCalldata(names[i]);
            unchecked { ++i; }
        }
    }

    /// @notice 从列表中移除模块键
    /// @param moduleKey 要移除的模块键
    /// @return found 是否找到并移除
    function _removeFromList(bytes32 moduleKey) private returns (bool found) {
        uint256 idxPlus1 = _keyIndexPlus1[moduleKey];
        if (idxPlus1 == 0) {
            return false;
        }
        uint256 idx = idxPlus1 - 1;
        uint256 last = _dynamicModuleKeyList.length - 1;
        if (idx != last) {
            bytes32 lastKey = _dynamicModuleKeyList[last];
            _dynamicModuleKeyList[idx] = lastKey;
            _keyIndexPlus1[lastKey] = idx + 1;
        }
        _dynamicModuleKeyList.pop();
        delete _keyIndexPlus1[moduleKey];
        return true;
    }

    /// @notice 注销动态模块键
    /// @param moduleKey 要注销的模块键
    function unregisterModuleKey(bytes32 moduleKey) external onlySystemAdmin whenNotPaused {
        if (!_dynamicModuleKeys[moduleKey]) {
            revert RegistryDynamicModuleKey__ModuleKeyNotExists(moduleKey);
        }
        
        string memory name = _moduleKeyNames[moduleKey];
        bytes32 nameHash = keccak256(abi.encodePacked(name));
        
        // 清理映射
        delete _dynamicModuleKeys[moduleKey];
        delete _moduleKeyNames[moduleKey];
        delete _nameHashToModuleKey[nameHash];
        
        // 从列表中移除，使用统一的 _removeFromList 函数
        if (!_removeFromList(moduleKey)) {
            revert RegistryDynamicModuleKey__ModuleKeyNotExists(moduleKey);
        }
        
        emit ModuleKeyUnregistered(moduleKey, name, msg.sender);
    }

    // ============ Core Dynamic Module Key Functions ============
    
    /// @notice 检查模块键是否为动态模块键
    /// @param moduleKey 要检查的模块键
    /// @return 是否为动态模块键
    function isDynamicModuleKey(bytes32 moduleKey) external view returns (bool) {
        return _dynamicModuleKeys[moduleKey];
    }

    /// @notice 检查模块键是否有效（包括静态和动态）
    /// @param moduleKey 要检查的模块键
    /// @return 是否为有效模块键
    function isValidModuleKey(bytes32 moduleKey) external view returns (bool) {
        return ModuleKeys.isValidModuleKey(moduleKey) || _dynamicModuleKeys[moduleKey];
    }

    /// @notice 根据名称获取模块键
    /// @param name 模块键名称
    /// @return moduleKey 对应的模块键
    function getModuleKeyByName(string calldata name) external view returns (bytes32 moduleKey) {
        (, bytes32 nameHash) = _normalizeAndValidate(name);
        moduleKey = _nameHashToModuleKey[nameHash];
        if (moduleKey == bytes32(0)) {
            // 使用更明确的错误信息（返回名称哈希）
            revert RegistryDynamicModuleKey__ModuleNameNotExists(nameHash);
        }
    }

    /// @notice 根据模块键获取名称
    /// @param moduleKey 模块键
    /// @return name 对应的名称
    function getModuleKeyName(bytes32 moduleKey) external view returns (string memory name) {
        if (ModuleKeys.isValidModuleKey(moduleKey)) {
            return ModuleKeys.getModuleKeyString(moduleKey);
        } else if (_dynamicModuleKeys[moduleKey]) {
            return _moduleKeyNames[moduleKey];
        } else {
            revert RegistryDynamicModuleKey__ModuleKeyNotExists(moduleKey);
        }
    }

    // ============ Dynamic Module Key Management Functions ============
    
    /// @notice 获取所有动态模块键
    /// @return keys 动态模块键数组
    function getDynamicModuleKeys() external view returns (bytes32[] memory keys) {
        uint256 len = _dynamicModuleKeyList.length;
        keys = new bytes32[](len);
        for (uint256 i = 0; i < len; ) {
            keys[i] = _dynamicModuleKeyList[i];
            unchecked { ++i; }
        }
    }

    /// @notice 获取动态模块键总数
    function getDynamicKeyCount() external view returns (uint256) {
        return _dynamicModuleKeyList.length;
    }

    /// @notice 获取动态模块键名称（原始数据）
    /// @param moduleKey 模块键
    /// @return name 模块键名称
    function getDynamicModuleKeyName(bytes32 moduleKey) external view returns (string memory name) {
        if (!_dynamicModuleKeys[moduleKey]) {
            revert RegistryDynamicModuleKey__ModuleKeyNotExists(moduleKey);
        }
        return _moduleKeyNames[moduleKey];
    }

    /// @notice 根据名称哈希获取模块键
    /// @param nameHash 名称哈希
    /// @return moduleKey 对应的模块键
    function getNameHashToModuleKey(bytes32 nameHash) external view returns (bytes32 moduleKey) {
        return _nameHashToModuleKey[nameHash];
    }

    /// @notice 获取动态模块键列表中的指定索引
    /// @param index 索引
    /// @return moduleKey 模块键
    function getDynamicModuleKeyByIndex(uint256 index) external view returns (bytes32 moduleKey) {
        if (index >= _dynamicModuleKeyList.length) revert IndexOutOfBounds(index, _dynamicModuleKeyList.length);
        return _dynamicModuleKeyList[index];
    }

    // ============ Admin Functions ============
    
    /// @notice 获取注册管理员地址
    function getRegistrationAdmin() external view returns (address) {
        return _registrationAdminAddr;
    }

    /// @notice 获取系统管理员地址
    function getSystemAdmin() external view returns (address) {
        return _systemAdminAddr;
    }

    /// @notice 设置注册管理员
    /// @param newRegistrationAdmin 新的注册管理员地址
    function setRegistrationAdmin(address newRegistrationAdmin) external onlyOwner {
        if (newRegistrationAdmin == address(0)) revert ZeroAddress();
        
        address oldAdmin = _registrationAdminAddr;
        _registrationAdminAddr = newRegistrationAdmin;
        
        emit RegistrationAdminChanged(oldAdmin, newRegistrationAdmin);
    }

    /// @notice 设置系统管理员
    /// @param newSystemAdmin 新的系统管理员地址
    function setSystemAdmin(address newSystemAdmin) external onlyOwner {
        if (newSystemAdmin == address(0)) revert ZeroAddress();
        
        address oldAdmin = _systemAdminAddr;
        _systemAdminAddr = newSystemAdmin;
        
        emit SystemAdminChanged(oldAdmin, newSystemAdmin);
    }

    /// @notice 紧急暂停
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice 恢复运行
    function unpause() external onlyOwner {
        _unpause();
    }

    // ============ Internal Functions ============
    
    /// @dev 为可升级合约保留存储槽，防止存储布局冲突
    uint256[49] private __gap;
} 