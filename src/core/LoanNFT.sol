// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC721/extensions/ERC721EnumerableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import { ReentrancyGuardSlimUpgradeable } from "../utils/ReentrancyGuardSlimUpgradeable.sol";
import "@openzeppelin/contracts/utils/Strings.sol";
import "@openzeppelin/contracts/utils/Base64.sol";

import { ActionKeys } from "../constants/ActionKeys.sol";
import { ModuleKeys } from "../constants/ModuleKeys.sol";
import { VaultTypes } from "../Vault/VaultTypes.sol";
import { ILoanNFT } from "../interfaces/ILoanNFT.sol";
import { IRegistry } from "../interfaces/IRegistry.sol";
import { IRegistryUpgradeEvents } from "../interfaces/IRegistryUpgradeEvents.sol";
import { IAccessControlManager } from "../interfaces/IAccessControlManager.sol";
import { 
    PausedSystem, 
    ZeroAddress, 
    InvalidCaller,
    ExternalModuleRevertedRaw 
} from "../errors/StandardErrors.sol";
import { DataPushLibrary } from "../libraries/DataPushLibrary.sol";
import { DataPushTypes } from "../constants/DataPushTypes.sol";

/**
 * @title LoanNFT 贷款凭证 NFT 合约
 * @notice 基于 ERC-721 的贷款凭证管理合约，支持灵魂绑定代币功能
 * @dev 核心特性：
 *      - 符合 ERC-721 标准的可转移贷款凭证
 *      - 支持管理员锁定为灵魂绑定代币 (SBT)
 *      - 集成 Registry 模块化管理系统，通过 Registry 统一解析模块地址（架构指南要求）
 *      - 使用 ActionKeys/ModuleKeys 进行标准化权限控制
 *      - 支持 UUPS 可升级代理模式
 *      - 使用 ERC721Enumerable 提供代币枚举功能（避免冗余存储）
 * @dev 安全机制：
 *      - 重入保护 (ReentrancyGuard)
 *      - 可暂停功能 (Pausable)
 *      - 权限控制：通过 Registry 动态解析 AccessControlManager 地址
 *      - 升级授权验证
 * @dev 权限角色：
 *      - MINTER_ROLE: 铸造权限，对应 ACTION_BORROW
 *      - GOVERNANCE_ROLE: 治理权限，对应 ACTION_SET_PARAMETER
 * @dev 架构设计：
 *      - 事件驱动：所有操作通过事件记录，支持数据库收集和 AI 分析
 *      - 统一数据推送：使用 DataPushLibrary 发出标准化事件
 *      - 模块地址解析：通过 Registry.getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL) 获取 ACM
 * @author RWA Lending Platform Development Team
 * @custom:security-contact security@rwalending.com
 * @custom:version 1.0.0
 */
contract LoanNFT is
    Initializable,
    ERC721Upgradeable,
    ERC721EnumerableUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardSlimUpgradeable,
    UUPSUpgradeable,
    ILoanNFT,
    IRegistryUpgradeEvents
{
    

    /*━━━━━━━━━━━━━━━ ROLES 权限角色 ━━━━━━━━━━━━━━━*/

    /**
     * @notice 铸造者角色常量
     * @dev 映射到 ActionKeys.ACTION_BORROW，确保权限管理一致性
     */
    bytes32 internal constant MINTER_ROLE_VALUE = ActionKeys.ACTION_BORROW;
    /// @notice 兼容：原 public 常量 MINTER_ROLE 的显式 getter
    function MINTER_ROLE() external pure returns (bytes32) { return MINTER_ROLE_VALUE; }
    
    /**
     * @notice 治理角色常量
     * @dev 映射到 ActionKeys.ACTION_SET_PARAMETER，用于高权限操作
     */
    bytes32 internal constant GOVERNANCE_ROLE_VALUE = ActionKeys.ACTION_SET_PARAMETER;
    /// @notice 兼容：原 public 常量 GOVERNANCE_ROLE 的显式 getter
    function GOVERNANCE_ROLE() external pure returns (bytes32) { return GOVERNANCE_ROLE_VALUE; }

    /*━━━━━━━━━━━━━━━ STATE 状态变量 ━━━━━━━━━━━━━━━*/

    /**
     * @notice 代币 ID 计数器
     * @dev 用于生成递增的唯一代币 ID
     */
    uint256 private _nextTokenId;

    /**
     * @notice Registry 合约地址
     * @dev 用于通过 Registry 统一解析模块地址（架构指南要求），支持动态模块升级
     */
    address private _registryAddr;

    /**
     * @notice 贷款元数据映射
     * @dev 映射结构：tokenId => LoanMetadata，包含贷款的所有关键信息
     */
    mapping(uint256 tokenId => LoanMetadata) private _loanMetadata;
    
    /**
     * @notice 灵魂绑定状态映射
     * @dev 映射结构：tokenId => bool，true 表示该代币已锁定为 SBT
     */
    mapping(uint256 tokenId => bool) private _soulBound;
    
    /**
     * @notice 贷款铸造状态映射
     * @dev 映射结构：loanId => bool，确保每个贷款 ID 只能铸造一次代币
     */
    mapping(uint256 loanId => bool) private _loanMinted;

    /**
     * @notice 基础代币 URI
     * @dev 用于构建代币元数据 URI，可通过治理角色更新
     */
    string private _baseTokenURI;

    /*━━━━━━━━━━━━━━━ EVENTS 事件定义 ━━━━━━━━━━━━━━━*/

    /**
     * @notice Registry 地址更新事件
     * @param oldRegistry 旧的 Registry 地址
     * @param newRegistry 新的 Registry 地址
     */
    event RegistryUpdated(address indexed oldRegistry, address indexed newRegistry);

    /*━━━━━━━━━━━━━━━ ERRORS 错误定义 ━━━━━━━━━━━━━━━*/

    /**
     * @notice 非铸造者错误
     */
    error LoanNFT__NotMinter();
    
    /**
     * @notice 无效订单错误
     */
    error LoanNFT__InvalidOrder();
    
    // 统一数据推送类型常量已移至 DataPushTypes

    /*━━━━━━━━━━━━━━━ MODIFIERS 修饰符 ━━━━━━━━━━━━━━━*/
    
    /**
     * @notice 验证 Registry 地址有效性修饰符
     * @dev 确保 Registry 地址已正确设置且不为零地址
     */
    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        _;
    }

    /*━━━━━━━━━━━━━━━ INITIALIZER 初始化函数 ━━━━━━━━━━━━━━━*/

    /**
     * @notice 初始化可升级的 LoanNFT 合约
     * @param name_ NFT 集合名称
     * @param symbol_ NFT 集合符号
     * @param baseTokenURI_ 基础代币 URI
     * @param initialRegistryAddr Registry 合约初始地址
     * @dev 初始化组件：
     *      - ERC721Upgradeable: NFT 基础功能
     *      - ERC721EnumerableUpgradeable: 代币枚举功能（避免冗余存储）
     *      - UUPSUpgradeable: 可升级代理功能
     *      - PausableUpgradeable: 暂停功能
     *      - ReentrancyGuardSlimUpgradeable: 重入保护
     */
    function initialize(
        string memory name_,
        string memory symbol_,
        string memory baseTokenURI_,
        address initialRegistryAddr
    ) external initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();

        __ERC721_init(name_, symbol_);
        __ERC721Enumerable_init();
        __UUPSUpgradeable_init();
        __Pausable_init();
        __ReentrancyGuardSlim_init();

        _registryAddr = initialRegistryAddr;
        _baseTokenURI = baseTokenURI_;
        
        // 记录初始化动作
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );

        // 初始化阶段不推送业务数据，避免无效 tokenId 引用
    }

    /**
     * @notice 构造函数 - 禁用初始化器以防止实现合约被直接初始化
     * @custom:oz-upgrades-unsafe-allow constructor
     */
    constructor() {
        _disableInitializers();
    }

    /*━━━━━━━━━━━━━━━ ADMIN FUNCTIONS 管理函数 ━━━━━━━━━━━━━━━*/

    /**
     * @notice 暂停所有敏感业务函数
     * @dev 权限要求：仅治理角色可调用
     * @dev 影响范围：所有标记为 whenNotPaused 的函数将被暂停
     */
    function pause() external onlyValidRegistry {
        _requireRole(GOVERNANCE_ROLE_VALUE, msg.sender);
        _pause();
        
        // 记录暂停动作
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_PAUSE_SYSTEM,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_PAUSE_SYSTEM),
            msg.sender,
            block.timestamp
        );

        // 统一数据推送（架构指南要求）
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_LOAN_NFT_PAUSED,
            abi.encode(msg.sender, block.timestamp)
        );
    }

    /**
     * @notice 解除暂停
     * @dev 权限要求：仅治理角色可调用
     */
    function unpause() external onlyValidRegistry {
        _requireRole(GOVERNANCE_ROLE_VALUE, msg.sender);
        _unpause();
        
        // 记录恢复动作
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_UNPAUSE_SYSTEM,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_UNPAUSE_SYSTEM),
            msg.sender,
            block.timestamp
        );

        // 统一数据推送（架构指南要求）
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_LOAN_NFT_UNPAUSED,
            abi.encode(msg.sender, block.timestamp)
        );
    }
    
    /**
     * @notice 更新 Registry 地址
     * @param newRegistryAddr 新的 Registry 合约地址
     * @dev 权限要求：仅治理角色可调用
     * @dev 架构要求：通过 Registry 统一解析模块地址，避免地址漂移
     */
    function setRegistry(address newRegistryAddr) external onlyValidRegistry {
        _requireRole(GOVERNANCE_ROLE_VALUE, msg.sender);
        _setRegistry(newRegistryAddr);
    }
    
    /**
     * @notice 授予铸造角色
     * @param minter 铸造者地址
     * @dev 权限要求：仅治理角色可调用
     * @dev 架构要求：通过 Registry 动态解析 AccessControlManager 地址
     */
    function grantMinterRole(address minter) external onlyValidRegistry {
        _requireRole(GOVERNANCE_ROLE_VALUE, msg.sender);
        if (minter == address(0)) revert ZeroAddress();
        
        address acmAddr = IRegistry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        IAccessControlManager(acmAddr).grantRole(MINTER_ROLE_VALUE, minter);
        
        // 记录角色授予动作
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_GRANT_ROLE,
            "grantRole",
            msg.sender,
            block.timestamp
        );
    }
    
    /**
     * @notice 撤销铸造角色
     * @param minter 铸造者地址
     * @dev 权限要求：仅治理角色可调用
     * @dev 架构要求：通过 Registry 动态解析 AccessControlManager 地址
     */
    function revokeMinterRole(address minter) external onlyValidRegistry {
        _requireRole(GOVERNANCE_ROLE_VALUE, msg.sender);
        
        address acmAddr = IRegistry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        IAccessControlManager(acmAddr).revokeRole(MINTER_ROLE_VALUE, minter);
        
        // 记录角色撤销动作
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_REVOKE_ROLE,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_REVOKE_ROLE),
            msg.sender,
            block.timestamp
        );
    }

    /*━━━━━━━━━━━━━━━ EXTERNAL API 外部接口 ━━━━━━━━━━━━━━━*/

    /**
     * @notice 铸造贷款凭证 NFT
     * @param to 接收 NFT 的地址
     * @param data 贷款元数据
     * @return tokenId 新铸造的代币 ID
     * @dev 权限要求：仅铸造者角色可调用
     * @dev 安全检查：验证接收地址非零、贷款未被重复铸造、贷款本金大于零、合约未被暂停
     * @dev 事件驱动：发出 LoanCertificateMinted 事件和统一数据推送（架构指南要求）
     * @inheritdoc ILoanNFT
     */
    function mintLoanCertificate(
        address to,
        LoanMetadata calldata data
    ) external override whenNotPaused onlyValidRegistry returns (uint256 tokenId) {
        _reentrancyGuardEnter();
        _requireRole(MINTER_ROLE_VALUE, msg.sender);
        if (to == address(0)) revert ZeroAddress();
        if (_loanMinted[data.loanId]) revert LoanNFT__LoanAlreadyMinted(data.loanId);
        if (data.principal == 0) revert LoanNFT__InvalidOrder();

        _loanMinted[data.loanId] = true;
        tokenId = _nextTokenId;
        unchecked { _nextTokenId = tokenId + 1; }

        LoanMetadata memory meta = data;
        meta.status = LoanStatus.Active;
        _loanMetadata[tokenId] = meta;
        _safeMint(to, tokenId);

        emit LoanCertificateMinted(to, tokenId, data.loanId, data.principal, data.rate, data.term);
        
        // 记录铸造动作
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_BORROW,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_BORROW),
            msg.sender,
            block.timestamp
        );

        // 统一数据推送（架构指南要求）
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_LOAN_NFT_MINTED,
            abi.encode(to, tokenId, data.loanId, data.principal, data.rate, data.term, block.timestamp)
        );
        _reentrancyGuardExit();
    }

    /**
     * @notice 锁定为灵魂绑定代币
     * @param tokenId 要锁定的代币 ID
     * @dev 权限要求：仅治理角色可调用
     * @dev 操作效果：代币将无法在用户间转移（mint 和 burn 除外）
     * @dev 不可逆性：一旦设置为 SBT，无法撤销
     * @dev 事件驱动：发出统一数据推送（架构指南要求）
     * @inheritdoc ILoanNFT
     */
    function lockAsSBT(uint256 tokenId) external override onlyValidRegistry {
        _requireRole(GOVERNANCE_ROLE_VALUE, msg.sender);
        if (_ownerOf(tokenId) == address(0)) revert LoanNFT__InvalidTokenId();
        _soulBound[tokenId] = true;
        emit TokenLocked(tokenId);
        
        // 记录参数设置动作
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );

        // 统一数据推送（架构指南要求）
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_LOAN_NFT_STATUS_UPDATED,
            abi.encode(tokenId, LoanStatus.Active, msg.sender, block.timestamp)
        );
    }

    /**
     * @notice 销毁代币
     * @param tokenId 要销毁的代币 ID
     * @dev 权限要求：仅治理角色可调用
     * @dev 使用场景：贷款完全结清或特殊管理需要
     * @dev 事件驱动：发出统一数据推送（架构指南要求）
     * @inheritdoc ILoanNFT
     */
    function burn(uint256 tokenId) external override onlyValidRegistry {
        _requireRole(GOVERNANCE_ROLE_VALUE, msg.sender);
        if (_ownerOf(tokenId) == address(0)) revert LoanNFT__InvalidTokenId();
        _burn(tokenId);
        emit TokenBurned(tokenId);
        
        // 记录销毁动作
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );

        // 统一数据推送（架构指南要求）
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_LOAN_NFT_STATUS_UPDATED,
            abi.encode(tokenId, LoanStatus.Defaulted, msg.sender, block.timestamp)
        );
    }

    /**
     * @notice 更新贷款状态
     * @param tokenId 代币 ID
     * @param newStatus 新的贷款状态
     * @dev 权限要求：仅铸造者角色可调用
     * @dev 状态类型：Active（活跃）、Repaid（已还清）、Liquidated（已清算）、Defaulted（已违约）
     * @dev 事件驱动：发出统一数据推送（架构指南要求）
     * @inheritdoc ILoanNFT
     */
    function updateLoanStatus(uint256 tokenId, LoanStatus newStatus) external override onlyValidRegistry {
        _requireRole(MINTER_ROLE_VALUE, msg.sender);
        if (_ownerOf(tokenId) == address(0)) revert LoanNFT__InvalidTokenId();
        _loanMetadata[tokenId].status = newStatus;
        emit LoanStatusUpdated(tokenId, newStatus);
        
        // 记录状态更新动作
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
    }

    /*━━━━━━━━━━━━━━━ VIEW FUNCTIONS 视图函数 ━━━━━━━━━━━━━━━*/

    /**
     * @notice 获取代币元数据 URI
     * @param tokenId 代币 ID
     * @return 代币的 base64 编码的 JSON 元数据 URI
     * @dev 元数据格式：符合 ERC-721 标准的 JSON 格式
     * @dev 链上存储：使用 base64 编码避免依赖外部服务器
     */
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        if (_ownerOf(tokenId) == address(0)) revert LoanNFT__InvalidTokenId();
        LoanMetadata memory data = _loanMetadata[tokenId];

        // 链上 base64 元数据（无需外部服务器）
        string memory json = Base64.encode(
            bytes(
                string(
                    abi.encodePacked(
                        '{"name":"Loan #',
                        Strings.toString(tokenId),
                        '","description":"Loan Certificate NFT","attributes":[',
                        '{"trait_type":"LoanId","value":"', Strings.toString(data.loanId), '"},',
                        '{"trait_type":"Principal","value":"', Strings.toString(data.principal), '"},',
                        '{"trait_type":"Rate (bps)","value":"', Strings.toString(data.rate), '"},',
                        '{"trait_type":"Term","value":"', Strings.toString(data.term), '"},',
                        '{"trait_type":"Status","value":"', _statusToString(data.status), '"}',
                        ']}'
                    )
                )
            )
        );
        return string(abi.encodePacked("data:application/json;base64,", json));
    }

    /**
     * @notice 获取贷款元数据
     * @param tokenId 代币 ID
     * @return 贷款元数据结构体
     * @inheritdoc ILoanNFT
     */
    function getLoanMetadata(uint256 tokenId) external view override returns (LoanMetadata memory) {
        if (_ownerOf(tokenId) == address(0)) revert LoanNFT__InvalidTokenId();
        return _loanMetadata[tokenId];
    }

    /**
     * @notice 获取用户持有的代币列表
     * @param user 用户地址
     * @return 用户持有的代币 ID 数组
     * @dev 架构优化：使用 ERC721Enumerable 的 balanceOf 和 tokenOfOwnerByIndex，避免冗余存储
     * @dev 性能注意：大量持有代币的用户可能导致 gas 消耗较高
     * @inheritdoc ILoanNFT
     */
    function getUserTokens(address user) external view override returns (uint256[] memory) {
        uint256 balance = balanceOf(user);
        uint256[] memory tokens = new uint256[](balance);
        for (uint256 i; i < balance; ) {
            tokens[i] = tokenOfOwnerByIndex(user, i);
            unchecked { ++i; }
        }
        return tokens;
    }
    
    /**
     * @notice 获取当前 Registry 地址
     * @return Registry 合约地址
     */
    function getRegistry() external view returns (address) {
        return _registryAddr;
    }

    /**
     * @notice 检查是否为铸造者
     * @param account 待检查的账户地址
     * @return 是否为铸造者
     * @dev 架构要求：通过 Registry 动态解析 AccessControlManager 地址
     * @dev 异常处理：如果 Registry 未设置或 ACM 不可用，返回 false
     */
    function isMinter(address account) external view returns (bool) {
        if (_registryAddr == address(0)) return false;
        try IRegistry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL) returns (address acmAddr) {
            return IAccessControlManager(acmAddr).hasRole(MINTER_ROLE_VALUE, account);
        } catch {
            return false;
        }
    }
    
    /**
     * @notice 检查是否为治理角色
     * @param account 待检查的账户地址
     * @return 是否为治理角色
     * @dev 架构要求：通过 Registry 动态解析 AccessControlManager 地址
     * @dev 异常处理：如果 Registry 未设置或 ACM 不可用，返回 false
     */
    function isGovernance(address account) external view returns (bool) {
        if (_registryAddr == address(0)) return false;
        try IRegistry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL) returns (address acmAddr) {
            return IAccessControlManager(acmAddr).hasRole(GOVERNANCE_ROLE_VALUE, account);
        } catch {
            return false;
        }
    }

    /*━━━━━━━━━━━━━━━ INTERNALS 内部函数 ━━━━━━━━━━━━━━━*/

    /**
     * @notice 验证用户权限
     * @param actionKey 动作键
     * @param user 用户地址
     * @dev 架构要求：通过 Registry 统一解析 AccessControlManager 地址，避免地址漂移
     */
    function _requireRole(bytes32 actionKey, address user) internal view {
        address acmAddr = IRegistry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        if (acmAddr == address(0)) revert ZeroAddress();
        IAccessControlManager(acmAddr).requireRole(actionKey, user);
    }

    /**
     * @notice OZ v5: ERC721 内部状态更新钩子
     * @dev 用于兼容 ERC721EnumerableUpgradeable 的多继承 override（OZ v5 移除了 _beforeTokenTransfer）
     * @dev 灵魂绑定检查：如果代币被锁定为 SBT，禁止用户间转移（mint/burn 例外）
     */
    function _update(
        address to,
        uint256 tokenId,
        address auth
    ) internal override(ERC721Upgradeable, ERC721EnumerableUpgradeable) returns (address) {
        // mint: from == 0；burn: to == 0；仅禁止用户间转移
        address from = _ownerOf(tokenId);
        if (from != address(0) && to != address(0) && _soulBound[tokenId]) {
            revert LoanNFT__SoulBound(tokenId);
        }
        return super._update(to, tokenId, auth);
    }

    /**
     * @notice OZ v5: balance 增量钩子（Enumerable 多继承所需）
     */
    function _increaseBalance(
        address account,
        uint128 value
    ) internal override(ERC721Upgradeable, ERC721EnumerableUpgradeable) {
        super._increaseBalance(account, value);
    }

    /**
     * @notice 升级授权函数
     * @param newImplementation 新实现合约地址
     * @dev 权限验证：只有治理角色可以授权升级
     * @dev 安全机制：使用 UUPS 可升级代理模式
     */
    function _authorizeUpgrade(address newImplementation) internal override {
        _requireRole(GOVERNANCE_ROLE_VALUE, msg.sender);
        require(newImplementation.code.length > 0, "Invalid implementation");
        
        // 记录升级动作
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_UPGRADE_MODULE,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_UPGRADE_MODULE),
            msg.sender,
            block.timestamp
        );
    }

    /**
     * @notice 将贷款状态转换为字符串
     * @param st 贷款状态枚举
     * @return 状态对应的字符串
     */
    function _statusToString(LoanStatus st) private pure returns (string memory) {
        if (st == LoanStatus.Active) return "Active";
        if (st == LoanStatus.Repaid) return "Repaid";
        if (st == LoanStatus.Liquidated) return "Liquidated";
        return "Defaulted";
    }

    /**
     * @notice 支持的接口查询
     * @param interfaceId 接口 ID
     * @return 是否支持该接口
     * @dev 继承链：继承自 ERC721EnumerableUpgradeable 的接口支持
     */
    function supportsInterface(bytes4 interfaceId) public view override(ERC721Upgradeable, ERC721EnumerableUpgradeable) returns (bool) {
        return super.supportsInterface(interfaceId);
    }

    /**
     * @notice 内部函数：设置 Registry 地址
     * @param newRegistryAddr 新的 Registry 合约地址
     * @dev 发出 RegistryUpdated 事件、ActionExecuted 事件和统一数据推送（架构指南要求）
     */
    function _setRegistry(address newRegistryAddr) internal {
        if (newRegistryAddr == address(0)) revert ZeroAddress();
        
        address oldRegistry = _registryAddr;
        _registryAddr = newRegistryAddr;
        
        emit RegistryUpdated(oldRegistry, newRegistryAddr);
        
        // 记录参数设置动作
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
        
        // 发出模块地址更新事件
        emit VaultTypes.ModuleAddressUpdated(
            ModuleKeys.getModuleKeyString(ModuleKeys.KEY_LOAN_NFT),
            oldRegistry,
            newRegistryAddr,
            block.timestamp
        );

        // 统一数据推送（架构指南要求）
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_LOAN_NFT_REGISTRY_UPDATED,
            abi.encode(oldRegistry, newRegistryAddr, msg.sender, block.timestamp)
        );
    }

    /*━━━━━━━━━━━━━━━ GAP 存储间隙 ━━━━━━━━━━━━━━━*/

    /**
     * @notice 存储间隙 - 为未来升级预留存储空间
     * @dev 升级安全：确保在添加新状态变量时不会覆盖现有存储
     * @dev 空间计算：50 - 6 (当前状态变量) = 44 个空位
     * @dev 使用规则：每增加一个状态变量，应相应减少 __gap 数组大小
     */
    uint256[44] private __gap; // storage gap for upgrade safety
}
