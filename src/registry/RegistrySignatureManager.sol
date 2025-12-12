// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/cryptography/ECDSAUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/AddressUpgradeable.sol";

import { ModuleKeys } from "../constants/ModuleKeys.sol";
import { ActionKeys } from "../constants/ActionKeys.sol";
import { VaultTypes } from "../Vault/VaultTypes.sol";
import { 
    ZeroAddress, 
    InvalidCaller, 
    SignatureExpired, 
    InvalidSigner, 
    InvalidNonce, 
    InvalidSignature, 
    SignatureZeroAddress, 
    NotAContract,
    MismatchedArrayLengths,
    UpgradeNotAuthorized,
    InvalidUpgradeAdmin,
    ModuleAlreadyExists
} from "../errors/StandardErrors.sol";
import { RegistryStorage } from "./RegistryStorageLibrary.sol";
import { RegistryEvents } from "./RegistryEventsLibrary.sol";

/// @title RegistrySignatureManager
/// @notice EIP-712 签名管理功能
/// @dev 专门处理基于签名的模块升级授权
contract RegistrySignatureManager is 
    Initializable, 
    OwnableUpgradeable, 
    ReentrancyGuardUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable
{
    using RegistryStorage for RegistryStorage.Layout;
    using ECDSAUpgradeable for bytes32;
    using AddressUpgradeable for address;

    // ============ Constants ============
    bytes32 private constant PERMIT_MODULE_UPGRADE_TYPEHASH = keccak256(
        "PermitModuleUpgrade(bytes32 key,address newAddr,bool allowReplace,uint256 nonce,uint256 deadline)"
    );
    bytes32 private constant PERMIT_BATCH_MODULE_UPGRADE_TYPEHASH = keccak256(
        "PermitBatchModuleUpgrade(bytes32[] keys,address[] addresses,bool allowReplace,uint256 nonce,uint256 deadline)"
    );
    bytes32 private constant DOMAIN_SEPARATOR_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    
    // ECDSA 签名 s 值的最大有效值
    // 防止签名可变性攻击，确保 s 值在有效范围内
    bytes32 private constant MAX_VALID_S = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    // ============ Upgrade Admin ============
    address private _upgradeAdmin;
    
    // ============ Domain Separator Cache ============
    bytes32 private _domainSeparatorValue;
    uint256 private _cachedChainId;

    // ============ Constructor ============
    constructor() {
        _disableInitializers();
    }

    // ============ Initializer ============
    /// @notice 初始化合约
    /// @param upgradeAdmin_ 升级管理员地址
    /// @dev 通过参数传入升级管理员，避免权限集中
    function initialize(address upgradeAdmin_) external initializer {
        require(upgradeAdmin_ != address(0), "Invalid admin");
        __Ownable_init();
        __ReentrancyGuard_init();
        __Pausable_init();
        
        // 设置升级管理员
        _upgradeAdmin = upgradeAdmin_;
        
        // 初始化 domain separator 缓存
        _updateDomainSeparatorCache();
    }

    // ============ Signature Functions ============
    /// @notice 通过 EIP-712 签名授权模块升级
    function permitModuleUpgrade(
        bytes32 key,
        address newAddr,
        bool allowReplace,
        uint256 nonce,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external whenNotPaused nonReentrant {
        RegistryStorage.requireCompatibleVersion(RegistryStorage.CURRENT_STORAGE_VERSION);
        if (block.timestamp > deadline) revert SignatureExpired(deadline, block.timestamp);
        
        // 1) 验证签名并获取签名者地址（不改变状态）
        bytes32 digest = _getModuleUpgradeDigest(
            key,
            newAddr,
            allowReplace,
            nonce,
            deadline,
            address(this)
        );
        address signer = _verifySignature(digest, v, r, s);
        
        // 2) 验证 nonce（不改变状态）
        RegistryStorage.Layout storage l = RegistryStorage.layout();
        if (nonce != l.nonces[signer]) revert InvalidNonce(signer, l.nonces[signer], nonce);
        
        // 3) 消耗 nonce（在确认签名有效后）
        l.nonces[signer]++;
        
        // 4) 执行模块升级
        _executeModuleUpgrade(key, newAddr, allowReplace, signer);
        
        // 发出签名授权事件
        emit RegistryEvents.ModuleUpgradePermitted(key, newAddr, signer, nonce);
    }

    /// @notice 通过 EIP-712 签名授权批量模块升级
    function permitBatchModuleUpgrade(
        bytes32[] calldata keys,
        address[] calldata addresses,
        bool allowReplace,
        uint256 nonce,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external whenNotPaused nonReentrant {
        RegistryStorage.requireCompatibleVersion(RegistryStorage.CURRENT_STORAGE_VERSION);
        if (block.timestamp > deadline) revert SignatureExpired(deadline, block.timestamp);
        if (keys.length != addresses.length) revert MismatchedArrayLengths(keys.length, addresses.length);
        
        // 1) 验证签名并获取签名者地址（不改变状态）
        bytes32 digest = _getBatchModuleUpgradeDigest(
            keys,
            addresses,
            allowReplace,
            nonce,
            deadline,
            address(this)
        );
        address signer = _verifySignature(digest, v, r, s);
        
        // 2) 验证 nonce（不改变状态）
        RegistryStorage.Layout storage l = RegistryStorage.layout();
        if (nonce != l.nonces[signer]) revert InvalidNonce(signer, l.nonces[signer], nonce);
        
        // 3) 消耗 nonce（在确认签名有效后）
        l.nonces[signer]++;
        
        // 4) 执行批量模块升级
        _executeBatchModuleUpgrade(keys, addresses, allowReplace, signer);
        
        // 发出批量签名授权事件
        emit RegistryEvents.BatchModuleUpgradePermitted(keys, addresses, signer, nonce);
    }

    // ============ View Functions ============
    /// @notice 获取 EIP-712 域名分隔符
    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return _getDomainSeparator(address(this));
    }

    /// @notice 获取签名者的当前 nonce
    function nonces(address signer) external view returns (uint256) {
        return RegistryStorage.layout().nonces[signer];
    }

    // ============ Admin Functions ============
    /// @notice 暂停签名功能
    function pause() external onlyOwner {
        _pause();
        
        emit VaultTypes.ActionExecuted(
            keccak256("PAUSE_SYSTEM"),
            "pauseSystem",
            msg.sender,
            block.timestamp
        );
    }

    /// @notice 恢复签名功能
    function unpause() external onlyOwner {
        _unpause();
        
        emit VaultTypes.ActionExecuted(
            keccak256("UNPAUSE_SYSTEM"),
            "unpauseSystem",
            msg.sender,
            block.timestamp
        );
    }

    // ============ UUPS Upgrade Authorization ============
    /// @notice 升级授权函数
    /// @dev 使用内部升级管理员，避免外部依赖
    /// @dev 如需接入 Timelock/Multisig 治理，应在此处增加相应的权限检查逻辑
    function _authorizeUpgrade(address newImplementation) internal override {
        // 使用内部升级管理员，避免外部依赖
        if (msg.sender != _upgradeAdmin) revert UpgradeNotAuthorized(msg.sender, _upgradeAdmin);
        
        // 防御式编程：验证新实现地址是否为合约
        if (!newImplementation.isContract()) revert NotAContract(newImplementation);
        
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_UPGRADE_MODULE,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_UPGRADE_MODULE),
            msg.sender,
            block.timestamp
        );
    }

    // ============ Upgrade Admin Management ============
    /// @notice 设置升级管理员
    /// @param newAdmin 新的升级管理员地址
    function setUpgradeAdmin(address newAdmin) external onlyOwner {
        if (newAdmin == address(0)) revert InvalidUpgradeAdmin(newAdmin);
        _upgradeAdmin = newAdmin;
        
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_UPGRADE_ADMIN,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_UPGRADE_ADMIN),
            msg.sender,
            block.timestamp
        );
    }

    /// @notice 获取升级管理员
    function getUpgradeAdmin() external view returns (address) {
        return _upgradeAdmin;
    }

    // ============ Internal Functions ============
    /// @notice 更新 domain separator 缓存
    /// @dev 当链 ID 变化时调用此函数更新缓存
    /// @dev 此函数会更新 _cachedChainId 和 _domainSeparatorValue
    /// @dev 在合约升级或跨链部署时，应调用此函数确保缓存正确
    function _updateDomainSeparatorCache() internal {
        _cachedChainId = block.chainid;
        _domainSeparatorValue = keccak256(
            abi.encode(
                DOMAIN_SEPARATOR_TYPEHASH,
                keccak256(bytes("Registry")),
                keccak256(bytes("1")),
                _cachedChainId,
                address(this)
            )
        );
    }

    /// @notice 获取 EIP-712 域名分隔符（使用缓存）
    /// @param verifyingContract 验证合约地址
    /// @return 域名分隔符
    /// @dev 优先使用缓存，链 ID 变化时自动更新
    /// @dev ⚠️ 重要提醒：当合约部署到不同链或链 ID 发生变化时，
    /// @dev 需要调用 initialize() 或提供 resetDomainSeparator() 方法来更新缓存
    /// @dev 当前实现为 view 函数，链 ID 变化时只临时重新计算，不更新缓存
    function _getDomainSeparator(address verifyingContract) internal view returns (bytes32) {
        // 检查链 ID 是否变化，如果变化则重新计算
        if (block.chainid != _cachedChainId) {
            return keccak256(
                abi.encode(
                    DOMAIN_SEPARATOR_TYPEHASH,
                    keccak256(bytes("Registry")),
                    keccak256(bytes("1")),
                    block.chainid,
                    verifyingContract
                )
            );
        }
        
        // 使用缓存的值
        return _domainSeparatorValue;
    }

    /// @notice 验证 EIP-712 签名并返回签名者地址
    /// @param digest 消息摘要
    /// @param v, r, s 签名参数
    /// @return 签名者地址
    /// @dev 内部函数，用于验证签名，使用 OpenZeppelin ECDSA 库防止签名可变性攻击
    /// @dev 添加签名可变性保护，确保 s 值在有效范围内
    /// @dev 返回从签名中恢复的地址，避免外部传入的 signer 参数被伪造
    function _verifySignature(bytes32 digest, uint8 v, bytes32 r, bytes32 s) internal pure returns (address) {
        // 添加签名可变性保护，防止签名重放攻击
        // s 值必须小于等于 MAX_VALID_S
        if (s > MAX_VALID_S) {
            revert("Invalid signature 's' value");
        }
        
        // 验证 v 值必须在有效范围内
        if (v != 27 && v != 28) {
            revert("Invalid signature 'v' value");
        }
        
        bytes memory signature = abi.encodePacked(r, s, v);
        address recoveredSigner = digest.recover(signature);
        if (recoveredSigner == address(0)) revert SignatureZeroAddress();
        
        return recoveredSigner;
    }

    /// @notice 生成单个模块升级的签名摘要
    /// @param key 模块键
    /// @param newAddr 新合约地址
    /// @param allowReplace 是否允许替换
    /// @param nonce 当前 nonce
    /// @param deadline 签名过期时间
    /// @param verifyingContract 验证合约地址
    /// @return 签名摘要
    function _getModuleUpgradeDigest(
        bytes32 key,
        address newAddr,
        bool allowReplace,
        uint256 nonce,
        uint256 deadline,
        address verifyingContract
    ) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                PERMIT_MODULE_UPGRADE_TYPEHASH,
                key,
                newAddr,
                allowReplace,
                nonce,
                deadline
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", _getDomainSeparator(verifyingContract), structHash));
    }

    /// @notice 生成批量模块升级的签名摘要
    /// @param keys 模块键数组
    /// @param addresses 新合约地址数组
    /// @param allowReplace 是否允许替换
    /// @param nonce 当前 nonce
    /// @param deadline 签名过期时间
    /// @param verifyingContract 验证合约地址
    /// @return 签名摘要
    function _getBatchModuleUpgradeDigest(
        bytes32[] calldata keys,
        address[] calldata addresses,
        bool allowReplace,
        uint256 nonce,
        uint256 deadline,
        address verifyingContract
    ) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                PERMIT_BATCH_MODULE_UPGRADE_TYPEHASH,
                keccak256(abi.encodePacked(keys)),
                keccak256(abi.encodePacked(addresses)),
                allowReplace,
                nonce,
                deadline
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", _getDomainSeparator(verifyingContract), structHash));
    }

    // ============ Upgrade Functions ============
    /// @notice 执行单个模块升级
    /// @param key 模块键
    /// @param newAddr 新合约地址
    /// @param allowReplace 是否允许替换
    /// @param executor 执行者地址
    function _executeModuleUpgrade(
        bytes32 key,
        address newAddr,
        bool allowReplace,
        address executor
    ) internal {
        if (newAddr == address(0)) revert ZeroAddress();
        if (!newAddr.isContract()) revert NotAContract(newAddr);
        
        // 获取 storage 指针，避免重复 SLOAD
        RegistryStorage.Layout storage l = RegistryStorage.layout();
        
        // 检查是否允许替换现有模块
        if (!allowReplace && l.modules[key] != address(0)) revert ModuleAlreadyExists(key);
        
        // 缓存旧地址并更新模块地址
        address oldAddr = l.modules[key];
        l.modules[key] = newAddr;
        
        // 发出模块升级事件
        emit RegistryEvents.ModuleUpgraded(key, oldAddr, newAddr, executor);
        
        // 记录升级历史（传递 storage 指针以节省 Gas）
        _recordUpgradeHistory(l, key, oldAddr, newAddr, executor);
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_UPGRADE_MODULE,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_UPGRADE_MODULE),
            executor,
            block.timestamp
        );
        
        // 发出模块地址更新事件（使用常量字符串名称，提高日志可读性）
        emit VaultTypes.ModuleAddressUpdated(
            ModuleKeys.getModuleKeyConstantString(key),
            oldAddr,
            newAddr,
            block.timestamp
        );
    }

    /// @notice 执行批量模块升级
    /// @param keys 模块键数组
    /// @param addresses 新合约地址数组
    /// @param allowReplace 是否允许替换
    /// @param executor 执行者地址
    function _executeBatchModuleUpgrade(
        bytes32[] calldata keys,
        address[] calldata addresses,
        bool allowReplace,
        address executor
    ) internal {
        if (keys.length != addresses.length) revert InvalidCaller();
        
        for (uint256 i = 0; i < keys.length; i++) {
            _executeModuleUpgrade(keys[i], addresses[i], allowReplace, executor);
        }
    }

    /// @notice 记录模块升级历史
    /// @param l RegistryStorage.Layout storage 指针
    /// @param key 模块键
    /// @param oldAddr 旧地址
    /// @param newAddr 新地址
    /// @param executor 执行者地址
    function _recordUpgradeHistory(
        RegistryStorage.Layout storage l,
        bytes32 key,
        address oldAddr,
        address newAddr,
        address executor
    ) private {
        RegistryStorage.UpgradeHistory memory history = RegistryStorage.UpgradeHistory({
            oldAddress: oldAddr,
            newAddress: newAddr,
            timestamp: block.timestamp,
            executor: executor
        });
        
        l.upgradeHistory[key].push(history);
        l.historyIndex[key] = l.upgradeHistory[key].length;
        
        // 事件中的 txHash 参数保留用于外部索引器填充
        emit RegistryEvents.UpgradeHistoryRecorded(key, oldAddr, newAddr, block.timestamp, executor, bytes32(0));
    }

    // ============ Storage Gap ============
    uint256[50] private __gap;
} 