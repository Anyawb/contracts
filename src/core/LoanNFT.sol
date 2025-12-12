// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/StringsUpgradeable.sol";
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
 *         ERC-721 based loan certificate management contract with Soul Bound Token capability
 * @dev 核心特性 Core Features：
 *      - 符合 ERC-721 标准的可转移贷款凭证
 *      - 支持管理员锁定为灵魂绑定代币 (SBT)
 *      - 集成 Registry 模块化管理系统
 *      - 使用 ActionKeys/ModuleKeys 进行标准化权限控制
 *      - 支持 UUPS 可升级代理模式
 * @dev 安全机制 Security Mechanisms：
 *      - 重入保护 (ReentrancyGuard)
 *      - 可暂停功能 (Pausable)
 *      - 权限控制 (AccessControlManager)
 *      - 升级授权验证
 * @dev 权限角色 Permission Roles：
 *      - MINTER_ROLE: 铸造权限，对应 ACTION_BORROW
 *      - GOVERNANCE_ROLE: 治理权限，对应 ACTION_SET_PARAMETER
 * @dev 存储结构 Storage Structure：
 *      - _loanMetadata: 贷款元数据映射
 *      - _soulBound: 灵魂绑定标记映射
 *      - _userTokenIds: 用户持有代币列表
 *      - _loanMinted: 贷款铸造状态映射
 * @author RWA Lending Platform Development Team
 * @custom:security-contact security@rwalending.com
 * @custom:version 1.0.0
 */
contract LoanNFT is
    Initializable,
    ERC721Upgradeable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable,
    UUPSUpgradeable,
    ILoanNFT,
    IRegistryUpgradeEvents
{
    

    /*━━━━━━━━━━━━━━━ ROLES 权限角色 ━━━━━━━━━━━━━━━*/

    /**
     * @notice 铸造者角色常量 - 负责铸造贷款 NFT
     *         Minter role constant - responsible for minting loan NFTs
     * @dev 映射到 ActionKeys.ACTION_BORROW，确保权限管理一致性
     *      Mapped to ActionKeys.ACTION_BORROW for consistent permission management
     */
    bytes32 internal constant MINTER_ROLE_VALUE = ActionKeys.ACTION_BORROW;
    /// @notice 兼容：原 public 常量 MINTER_ROLE 的显式 getter
    function MINTER_ROLE() external pure returns (bytes32) { return MINTER_ROLE_VALUE; }
    
    /**
     * @notice 治理角色常量 - 负责系统参数管理和关键操作
     *         Governance role constant - responsible for system parameter management and critical operations
     * @dev 映射到 ActionKeys.ACTION_SET_PARAMETER，用于高权限操作
     *      Mapped to ActionKeys.ACTION_SET_PARAMETER for high-privilege operations
     */
    bytes32 internal constant GOVERNANCE_ROLE_VALUE = ActionKeys.ACTION_SET_PARAMETER;
    /// @notice 兼容：原 public 常量 GOVERNANCE_ROLE 的显式 getter
    function GOVERNANCE_ROLE() external pure returns (bytes32) { return GOVERNANCE_ROLE_VALUE; }

    /*━━━━━━━━━━━━━━━ STATE 状态变量 ━━━━━━━━━━━━━━━*/

    /**
     * @notice 代币 ID 计数器 - 用于生成递增的唯一代币 ID
     *         Token ID counter - used to generate incremental unique token IDs
     * @dev 使用 OpenZeppelin CountersUpgradeable 确保升级安全性
     *      Uses OpenZeppelin CountersUpgradeable for upgrade safety
     */
    uint256 private _nextTokenId;

    /**
     * @notice Registry 合约地址 - 模块注册中心地址
     *         Registry contract address - module registry center address
     * @dev 用于获取其他模块地址，支持动态模块升级
     *      Used to get other module addresses and support dynamic module upgrades
     */
    address private _registryAddr;

    /**
     * @notice 贷款元数据映射 - 存储每个代币的贷款详细信息
     *         Loan metadata mapping - stores detailed loan information for each token
     * @dev 映射结构：tokenId => LoanMetadata，包含贷款的所有关键信息
     *      Mapping structure: tokenId => LoanMetadata, contains all key loan information
     */
    mapping(uint256 tokenId => LoanMetadata) private _loanMetadata;
    
    /**
     * @notice 灵魂绑定状态映射 - 标记代币是否为 SBT
     *         Soul bound status mapping - marks whether tokens are SBTs
     * @dev 映射结构：tokenId => bool，true 表示该代币已锁定为 SBT
     *      Mapping structure: tokenId => bool, true means the token is locked as SBT
     */
    mapping(uint256 tokenId => bool) private _soulBound;
    
    /**
     * @notice 用户代币列表映射 - 记录每个用户持有的代币列表
     *         User token list mapping - records the list of tokens held by each user
     * @dev 映射结构：userAddress => tokenIds[]，便于查询用户持有的所有代币
     *      Mapping structure: userAddress => tokenIds[], convenient for querying all tokens held by users
     */
    mapping(address user => uint256[]) private _userTokenIds;
    
    /**
     * @notice 贷款铸造状态映射 - 防止同一贷款被重复铸造
     *         Loan minting status mapping - prevents the same loan from being minted multiple times
     * @dev 映射结构：loanId => bool，确保每个贷款 ID 只能铸造一次代币
     *      Mapping structure: loanId => bool, ensures each loan ID can only mint one token
     */
    mapping(uint256 loanId => bool) private _loanMinted;

    /**
     * @notice 基础代币 URI - 用于构建代币元数据 URI
     *         Base token URI - used to construct token metadata URI
     * @dev 可通过治理角色更新，支持元数据服务器迁移
     *      Can be updated by governance role, supports metadata server migration
     */
    string private _baseTokenURI;

    /*━━━━━━━━━━━━━━━ EVENTS 事件定义 ━━━━━━━━━━━━━━━*/

    /**
     * @notice Registry 地址更新事件 - 当 Registry 地址变更时触发
     *         Registry address update event - triggered when Registry address changes
     * @param oldRegistry 旧的 Registry 地址 Old Registry address
     * @param newRegistry 新的 Registry 地址 New Registry address
     * @dev 用于追踪系统核心依赖的变更，确保透明度
     *      Used to track changes to core system dependencies, ensuring transparency
     */
    event RegistryUpdated(address indexed oldRegistry, address indexed newRegistry);

    /*━━━━━━━━━━━━━━━ ERRORS 错误定义 ━━━━━━━━━━━━━━━*/

    /**
     * @notice 非铸造者错误 - 当非授权账户尝试铸造时抛出
     *         Non-minter error - thrown when unauthorized account attempts to mint
     */
    error LoanNFT__NotMinter();
    
    /**
     * @notice 无效订单错误 - 当贷款参数无效时抛出
     *         Invalid order error - thrown when loan parameters are invalid
     */
    error LoanNFT__InvalidOrder();
    
    //
    // 统一数据推送类型常量（供链下索引服务订阅）
    // Unified DataPush type constants moved to DataPushTypes

    /*━━━━━━━━━━━━━━━ MODIFIERS 修饰符 ━━━━━━━━━━━━━━━*/
    
    /**
     * @notice 验证 Registry 地址有效性修饰符
     *         Modifier to validate Registry address validity
     * @dev 确保 Registry 地址已正确设置且不为零地址
     *      Ensures Registry address is properly set and not zero address
     * @dev 使用场景：所有需要与 Registry 交互的函数
     *      Usage scenarios: All functions that need to interact with Registry
     */
    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        _;
    }

    /*━━━━━━━━━━━━━━━ INITIALIZER 初始化函数 ━━━━━━━━━━━━━━━*/

    /**
     * @notice 初始化可升级的 LoanNFT 合约
     *         Initialize the upgradeable LoanNFT contract
     * @dev 此函数在部署时只能被调用一次，使用 initializer 修饰符确保
     *      This function can only be called once during deployment, ensured by initializer modifier
     * @param name_ NFT 集合名称 NFT collection name
     * @param symbol_ NFT 集合符号 NFT collection symbol  
     * @param baseTokenURI_ 基础代币 URI Base token URI
     * @param initialRegistryAddr Registry 合约初始地址 Initial Registry contract address
     * @dev 安全检查 Security checks：
     *      - 验证 Registry 地址非零
     *      - 初始化所有必要的 OpenZeppelin 组件
     *      - 发出标准化的初始化事件
     * @dev 初始化组件 Initialized components：
     *      - ERC721EnumerableUpgradeable: NFT 基础功能
     *      - UUPSUpgradeable: 可升级代理功能
     *      - PausableUpgradeable: 暂停功能
     */
    function initialize(
        string memory name_,
        string memory symbol_,
        string memory baseTokenURI_,
        address initialRegistryAddr
    ) external initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();

        __ERC721_init(name_, symbol_);
        __UUPSUpgradeable_init();
        __Pausable_init();
        __ReentrancyGuard_init();

        _registryAddr = initialRegistryAddr;
        _baseTokenURI = baseTokenURI_;
        
        // 记录初始化动作 Record initialization action
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
     *         Constructor - disables initializers to prevent implementation contract from being directly initialized
     * @dev 使用 OpenZeppelin 的安全升级模式，确保只有代理合约可以被初始化
     *      Uses OpenZeppelin's secure upgrade pattern, ensuring only proxy contracts can be initialized
     * @custom:oz-upgrades-unsafe-allow constructor
     */
    constructor() {
        _disableInitializers();
    }

    /*━━━━━━━━━━━━━━━ ADMIN FUNCTIONS 管理函数 ━━━━━━━━━━━━━━━*/

    /**
     * @notice 暂停所有敏感业务函数 - 紧急情况下停止合约运行
     *         Pause all sensitive business functions - stop contract operation in emergency
     * @dev 权限要求：仅治理角色可调用
     *      Permission requirement: Only governance role can call
     * @dev 安全机制：使用 OpenZeppelin 的 Pausable 模式
     *      Security mechanism: Uses OpenZeppelin's Pausable pattern
     * @dev 影响范围：所有标记为 whenNotPaused 的函数将被暂停
     *      Impact scope: All functions marked as whenNotPaused will be paused
     */
    function pause() external onlyValidRegistry {
        _requireRole(GOVERNANCE_ROLE_VALUE, msg.sender);
        _pause();
        
        // 记录暂停动作 Record pause action
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_PAUSE_SYSTEM,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_PAUSE_SYSTEM),
            msg.sender,
            block.timestamp
        );

        // 统一数据推送：合约已暂停
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_LOAN_NFT_PAUSED,
            abi.encode(msg.sender, block.timestamp)
        );
    }

    /**
     * @notice 解除暂停 - 恢复合约正常运行
     *         Unpause - restore normal contract operation
     * @dev 权限要求：仅治理角色可调用
     *      Permission requirement: Only governance role can call
     * @dev 安全机制：确保只有授权管理员可以恢复操作
     *      Security mechanism: Ensure only authorized admin can restore operations
     * @dev 操作效果：重新启用所有 whenNotPaused 函数
     *      Operation effect: Re-enable all whenNotPaused functions
     */
    function unpause() external onlyValidRegistry {
        _requireRole(GOVERNANCE_ROLE_VALUE, msg.sender);
        _unpause();
        
        // 记录恢复动作 Record unpause action
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_UNPAUSE_SYSTEM,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_UNPAUSE_SYSTEM),
            msg.sender,
            block.timestamp
        );

        // 统一数据推送：合约已解除暂停
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_LOAN_NFT_UNPAUSED,
            abi.encode(msg.sender, block.timestamp)
        );
    }
    
    /**
     * @notice 更新 Registry 地址 - 修改模块注册中心地址
     *         Update Registry address - modify module registry center address
     * @param newRegistryAddr 新的 Registry 合约地址 New Registry contract address
     * @dev 权限要求：仅治理角色可调用
     *      Permission requirement: Only governance role can call
     * @dev 安全检查：验证新地址非零地址
     *      Security check: Validate new address is not zero address
     * @dev 操作影响：影响所有依赖 Registry 的模块交互
     *      Operation impact: Affects all module interactions that depend on Registry
     * @dev 事件发出：同时发出 RegistryUpdated 和 ActionExecuted 事件
     *      Events emitted: Emits both RegistryUpdated and ActionExecuted events
     */
    function updateRegistry(address newRegistryAddr) external onlyValidRegistry {
        _requireRole(GOVERNANCE_ROLE_VALUE, msg.sender);
        if (newRegistryAddr == address(0)) revert ZeroAddress();
        
        address oldRegistry = _registryAddr;
        _registryAddr = newRegistryAddr;
        
        emit RegistryUpdated(oldRegistry, newRegistryAddr);
        
        // 记录参数设置动作 Record parameter setting action
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
        
        // 发出模块地址更新事件 Emit module address update event
        emit VaultTypes.ModuleAddressUpdated(
            ModuleKeys.getModuleKeyString(ModuleKeys.KEY_LOAN_NFT),
            oldRegistry,
            newRegistryAddr,
            block.timestamp
        );

        // 统一数据推送（架构指南） Unified data push (Architecture Guide)
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_LOAN_NFT_REGISTRY_UPDATED,
            abi.encode(oldRegistry, newRegistryAddr, msg.sender, block.timestamp)
        );
    }
    
    /**
     * @notice 授予铸造角色 - 为指定地址分配贷款 NFT 铸造权限
     *         Grant minter role - assign loan NFT minting permission to specified address
     * @param minter 铸造者地址 Minter address
     * @dev 权限要求：仅治理角色可调用
     *      Permission requirement: Only governance role can call
     * @dev 安全检查：验证铸造者地址非零地址
     *      Security check: Validate minter address is not zero address
     * @dev 权限管理：通过 AccessControlManager 管理角色权限
     *      Permission management: Manage role permissions through AccessControlManager
     * @dev 角色类型：MINTER_ROLE 对应 ACTION_BORROW 权限
     *      Role type: MINTER_ROLE corresponds to ACTION_BORROW permission
     */
    function grantMinterRole(address minter) external onlyValidRegistry {
        _requireRole(GOVERNANCE_ROLE_VALUE, msg.sender);
        if (minter == address(0)) revert ZeroAddress();
        
        address acmAddr = IRegistry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        IAccessControlManager(acmAddr).grantRole(MINTER_ROLE_VALUE, minter);
        
        // 记录角色授予动作 Record role grant action
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_GRANT_ROLE,
            "grantRole",
            msg.sender,
            block.timestamp
        );
    }
    
    /**
     * @notice 撤销铸造角色 - 移除指定地址的贷款 NFT 铸造权限
     *         Revoke minter role - remove loan NFT minting permission from specified address
     * @param minter 铸造者地址 Minter address
     * @dev 权限要求：仅治理角色可调用
     *      Permission requirement: Only governance role can call
     * @dev 权限管理：通过 AccessControlManager 撤销角色权限
     *      Permission management: Revoke role permissions through AccessControlManager
     * @dev 安全性：防止未授权的铸造操作
     *      Security: Prevent unauthorized minting operations
     * @dev 角色类型：撤销 MINTER_ROLE 对应的 ACTION_BORROW 权限
     *      Role type: Revoke MINTER_ROLE corresponding to ACTION_BORROW permission
     */
    function revokeMinterRole(address minter) external onlyValidRegistry {
        _requireRole(GOVERNANCE_ROLE_VALUE, msg.sender);
        
        address acmAddr = IRegistry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        IAccessControlManager(acmAddr).revokeRole(MINTER_ROLE_VALUE, minter);
        
        // 记录角色撤销动作 Record role revoke action
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_REVOKE_ROLE,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_REVOKE_ROLE),
            msg.sender,
            block.timestamp
        );
    }

    /*━━━━━━━━━━━━━━━ EXTERNAL API 外部接口 ━━━━━━━━━━━━━━━*/

    /**
     * @notice 铸造贷款凭证 NFT - 为新贷款创建 NFT 代币
     *         Mint loan certificate NFT - create NFT token for new loan
     * @param to 接收 NFT 的地址 Address to receive the NFT
     * @param data 贷款元数据 Loan metadata
     * @return tokenId 新铸造的代币 ID New minted token ID
     * @dev 权限要求：仅铸造者角色可调用
     *      Permission requirement: Only minter role can call
     * @dev 安全检查：
     *      Security checks:
     *      - 验证接收地址非零地址
     *      - 验证贷款未被重复铸造
     *      - 验证贷款本金大于零
     *      - 合约未被暂停
     * @dev 操作流程：
     *      Operation flow:
     *      - 标记贷款已铸造
     *      - 生成新的代币 ID
     *      - 设置贷款元数据
     *      - 安全铸造 NFT
     *      - 发出铸造事件
     * @inheritdoc ILoanNFT
     */
    function mintLoanCertificate(
        address to,
        LoanMetadata calldata data
    ) external override whenNotPaused onlyValidRegistry nonReentrant returns (uint256 tokenId) {
        _requireRole(MINTER_ROLE_VALUE, msg.sender);
        if (to == address(0)) revert ZeroAddress();
        if (_loanMinted[data.loanId]) revert LoanNFT__LoanAlreadyMinted(data.loanId);
        if (data.principal == 0) revert LoanNFT__InvalidOrder();

        // 获取最新模块地址 Update latest module addresses
        

        _loanMinted[data.loanId] = true;
        tokenId = _nextTokenId;
        unchecked { _nextTokenId = tokenId + 1; }

        LoanMetadata memory meta = data;
        meta.status = LoanStatus.Active;
        _loanMetadata[tokenId] = meta;
        _safeMint(to, tokenId);

        emit LoanCertificateMinted(to, tokenId, data.loanId, data.principal, data.rate, data.term);
        
        // 记录铸造动作 Record minting action
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_BORROW,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_BORROW),
            msg.sender,
            block.timestamp
        );

        // 统一数据推送（架构指南） Unified data push (Architecture Guide)
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_LOAN_NFT_MINTED,
            abi.encode(to, tokenId, data.loanId, data.principal, data.rate, data.term, block.timestamp)
        );
    }

    /**
     * @notice 锁定为灵魂绑定代币 - 将指定代币设置为不可转移的 SBT
     *         Lock as Soul Bound Token - set specified token as non-transferable SBT
     * @param tokenId 要锁定的代币 ID Token ID to be locked
     * @dev 权限要求：仅治理角色可调用
     *      Permission requirement: Only governance role can call
     * @dev 安全检查：验证代币存在
     *      Security check: Validate token exists
     * @dev 操作效果：代币将无法在用户间转移（mint 和 burn 除外）
     *      Operation effect: Token cannot be transferred between users (except mint and burn)
     * @dev 不可逆性：一旦设置为 SBT，无法撤销
     *      Irreversibility: Once set as SBT, cannot be reversed
     * @inheritdoc ILoanNFT
     */
    function lockAsSBT(uint256 tokenId) external override onlyValidRegistry {
        _requireRole(GOVERNANCE_ROLE_VALUE, msg.sender);
        if (!_exists(tokenId)) revert LoanNFT__InvalidTokenId();
        _soulBound[tokenId] = true;
        emit TokenLocked(tokenId);
        
        // 记录参数设置动作 Record parameter setting action
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );

        // 统一数据推送（架构指南）: 锁定为 SBT 视为状态更新
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_LOAN_NFT_STATUS_UPDATED,
            abi.encode(tokenId, LoanStatus.Active, msg.sender, block.timestamp)
        );
    }

    /**
     * @notice 销毁代币 - 永久删除指定的贷款凭证 NFT
     *         Burn token - permanently delete specified loan certificate NFT
     * @param tokenId 要销毁的代币 ID Token ID to be burned
     * @dev 权限要求：仅治理角色可调用
     *      Permission requirement: Only governance role can call
     * @dev 安全机制：使用重入保护防止攻击
     *      Security mechanism: Uses reentrancy protection to prevent attacks
     * @dev 安全检查：验证代币存在
     *      Security check: Validate token exists
     * @dev 操作流程：
     *      Operation flow:
     *      - 获取代币当前持有者
     *      - 销毁 NFT 代币
     *      - 更新用户代币列表
     *      - 发出销毁事件
     * @dev 使用场景：贷款完全结清或特殊管理需要
     *      Use cases: Loan fully repaid or special administrative needs
     * @inheritdoc ILoanNFT
     */
    function burn(uint256 tokenId) external override onlyValidRegistry {
        _requireRole(GOVERNANCE_ROLE_VALUE, msg.sender);
        if (!_exists(tokenId)) revert LoanNFT__InvalidTokenId();
        address owner = ownerOf(tokenId);
        _burn(tokenId);
        _removeTokenFromUser(owner, tokenId);
        emit TokenBurned(tokenId);
        
        // 记录销毁动作 Record burn action
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );

        // 统一数据推送（架构指南）：状态更新为已销毁
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_LOAN_NFT_STATUS_UPDATED,
            abi.encode(tokenId, LoanStatus.Defaulted, msg.sender, block.timestamp)
        );
    }

    /**
     * @notice 更新贷款状态 - 修改指定代币的贷款状态
     *         Update loan status - modify loan status of specified token
     * @param tokenId 代币 ID Token ID
     * @param newStatus 新的贷款状态 New loan status
     * @dev 权限要求：仅铸造者角色可调用
     *      Permission requirement: Only minter role can call
     * @dev 安全机制：使用重入保护防止攻击
     *      Security mechanism: Uses reentrancy protection to prevent attacks
     * @dev 安全检查：验证代币存在
     *      Security check: Validate token exists
     * @dev 状态类型：
     *      Status types:
     *      - Active: 活跃贷款
     *      - Repaid: 已还清
     *      - Liquidated: 已清算
     *      - Defaulted: 已违约
     * @dev 使用场景：贷款状态变更时调用
     *      Use cases: Called when loan status changes
     * @inheritdoc ILoanNFT
     */
    function updateLoanStatus(uint256 tokenId, LoanStatus newStatus) external override onlyValidRegistry {
        _requireRole(MINTER_ROLE_VALUE, msg.sender);
        if (!_exists(tokenId)) revert LoanNFT__InvalidTokenId();
        _loanMetadata[tokenId].status = newStatus;
        emit LoanStatusUpdated(tokenId, newStatus);
        
        // 记录状态更新动作 Record status update action
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
    }

    /*━━━━━━━━━━━━━━━ VIEW FUNCTIONS 视图函数 ━━━━━━━━━━━━━━━*/

    /**
     * @notice 获取代币元数据 URI - 返回包含代币详细信息的 JSON 数据
     *         Get token metadata URI - returns JSON data containing detailed token information
     * @param tokenId 代币 ID Token ID
     * @return 代币的 base64 编码的 JSON 元数据 URI
     *         Base64 encoded JSON metadata URI of the token
     * @dev 元数据格式：符合 ERC-721 标准的 JSON 格式
     *      Metadata format: ERC-721 standard compliant JSON format
     * @dev 链上存储：使用 base64 编码避免依赖外部服务器
     *      On-chain storage: Uses base64 encoding to avoid dependency on external servers
     * @dev 包含信息：
     *      Included information:
     *      - 代币名称和描述
     *      - 贷款 ID
     *      - 贷款本金
     *      - 利率 (bps)
     *      - 贷款期限
     *      - 当前状态
     */
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        if (!_exists(tokenId)) revert LoanNFT__InvalidTokenId();
        LoanMetadata memory data = _loanMetadata[tokenId];

        // 链上 base64 元数据 (无需外部服务器) On-chain base64 metadata (no external server required)
        string memory json = Base64.encode(
            bytes(
                string(
                    abi.encodePacked(
                        '{"name":"Loan #',
                        StringsUpgradeable.toString(tokenId),
                        '","description":"Loan Certificate NFT","attributes":[',
                        '{"trait_type":"LoanId","value":"', StringsUpgradeable.toString(data.loanId), '"},',
                        '{"trait_type":"Principal","value":"', StringsUpgradeable.toString(data.principal), '"},',
                        '{"trait_type":"Rate (bps)","value":"', StringsUpgradeable.toString(data.rate), '"},',
                        '{"trait_type":"Term","value":"', StringsUpgradeable.toString(data.term), '"},',
                        '{"trait_type":"Status","value":"', _statusToString(data.status), '"}',
                        ']}'
                    )
                )
            )
        );
        return string(abi.encodePacked("data:application/json;base64,", json));
    }

    /**
     * @notice 获取贷款元数据 - 返回指定代币的完整贷款信息
     *         Get loan metadata - returns complete loan information for specified token
     * @param tokenId 代币 ID Token ID
     * @return 贷款元数据结构体 Loan metadata structure
     * @dev 安全检查：验证代币存在
     *      Security check: Validate token exists
     * @dev 返回信息：
     *      Returned information:
     *      - loanId: 贷款唯一标识
     *      - principal: 贷款本金
     *      - rate: 年利率 (bps)
     *      - term: 贷款期限
     *      - status: 当前状态
     *      - timestamp: 创建时间戳
     * @inheritdoc ILoanNFT
     */
    function getLoanMetadata(uint256 tokenId) external view override returns (LoanMetadata memory) {
        if (!_exists(tokenId)) revert LoanNFT__InvalidTokenId();
        return _loanMetadata[tokenId];
    }

    /**
     * @notice 获取用户持有的代币列表 - 返回指定用户持有的所有代币 ID
     *         Get user token list - returns all token IDs held by specified user
     * @param user 用户地址 User address
     * @return 用户持有的代币 ID 数组 Array of token IDs held by the user
     * @dev 实时更新：代币转移时自动更新此列表
     *      Real-time update: This list is automatically updated when tokens are transferred
     * @dev 性能注意：大量持有代币的用户可能导致 gas 消耗较高
     *      Performance note: Users holding many tokens may cause high gas consumption
     * @inheritdoc ILoanNFT
     */
    function getUserTokens(address user) external view override returns (uint256[] memory) {
        return _userTokenIds[user];
    }
    
    /**
     * @notice 获取当前 Registry 地址 - 返回模块注册中心地址
     *         Get current Registry address - returns module registry center address
     * @return Registry 合约地址 Registry contract address
     * @dev 用途：外部合约可以通过此函数获取当前使用的 Registry 地址
     *      Purpose: External contracts can get the currently used Registry address through this function
     */
    function getRegistry() external view returns (address) {
        return _registryAddr;
    }
    
    /**
     * @notice 检查是否为铸造者 - 验证指定账户是否具有铸造权限
     *         Check if is minter - verify if specified account has minting permission
     * @param account 待检查的账户地址 Account address to be checked
     * @return 是否为铸造者 Whether is a minter
     * @dev 权限检查：通过 AccessControlManager 验证 MINTER_ROLE
     *      Permission check: Verify MINTER_ROLE through AccessControlManager
     * @dev 异常处理：如果 Registry 未设置或 ACM 不可用，返回 false
     *      Exception handling: Returns false if Registry is not set or ACM is unavailable
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
     * @notice 检查是否为治理角色 - 验证指定账户是否具有治理权限
     *         Check if is governance - verify if specified account has governance permission
     * @param account 待检查的账户地址 Account address to be checked
     * @return 是否为治理角色 Whether is a governance role
     * @dev 权限检查：通过 AccessControlManager 验证 GOVERNANCE_ROLE
     *      Permission check: Verify GOVERNANCE_ROLE through AccessControlManager
     * @dev 异常处理：如果 Registry 未设置或 ACM 不可用，返回 false
     *      Exception handling: Returns false if Registry is not set or ACM is unavailable
     * @dev 治理权限：包括暂停/解除暂停、更新 Registry、授予/撤销角色等
     *      Governance permissions: Include pause/unpause, update Registry, grant/revoke roles, etc.
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
     * @notice 验证用户权限 - 检查用户是否具有指定动作的权限
     *         Validate user permission - check if user has permission for specified action
     * @param actionKey 动作键 Action key
     * @param user 用户地址 User address
     * @dev 权限验证流程：
     *      Permission validation process:
     *      1. 验证 Registry 地址有效
     *      2. 获取 AccessControlManager 地址
     *      3. 调用 ACM 的 requireRole 进行权限验证
     * @dev 失败处理：如果权限不足，将 revert 并返回相应错误信息
     *      Failure handling: If insufficient permission, will revert with corresponding error message
     */
    function _requireRole(bytes32 actionKey, address user) internal view {
        if (_registryAddr == address(0)) revert ZeroAddress();
        
        address acmAddr = IRegistry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        if (acmAddr == address(0)) revert ZeroAddress();
        IAccessControlManager(acmAddr).requireRole(actionKey, user);
    }

    /**
     * @notice 代币转移前的钩子函数 - 在代币转移前执行必要的检查和更新
     *         Pre-transfer hook function - execute necessary checks and updates before token transfer
     * @param from 转出地址 (零地址表示铸造) From address (zero address means minting)
     * @param to 转入地址 (零地址表示销毁) To address (zero address means burning)
     * @param tokenId 代币 ID Token ID
     * @param batchSize 批量大小 Batch size
     * @dev 灵魂绑定检查：如果代币被锁定为 SBT，禁止用户间转移
     *      Soul bound check: If token is locked as SBT, prevent transfers between users
     * @dev 索引更新：自动维护用户代币列表的准确性
     *      Index update: Automatically maintain accuracy of user token lists
     * @dev 特殊情况：铸造 (from = 0) 和销毁 (to = 0) 不受 SBT 限制
     *      Special cases: Minting (from = 0) and burning (to = 0) are not restricted by SBT
     */
    function _beforeTokenTransfer(
        address from,
        address to,
        uint256 tokenId,
        uint256 batchSize
    ) internal override(ERC721Upgradeable) {
        // SBT：若已锁定，则禁止用户之间转移（mint 和 burn 例外）
        // SBT: If locked, prevent transfers between users (except mint and burn)
        if (from != address(0) && to != address(0) && _soulBound[tokenId]) {
            revert LoanNFT__SoulBound(tokenId);
        }
        // 更新 _userTokenIds 索引 Update _userTokenIds index
        if (from != address(0)) {
            _removeTokenFromUser(from, tokenId);
        }
        if (to != address(0)) {
            _userTokenIds[to].push(tokenId);
        }
        super._beforeTokenTransfer(from, to, tokenId, batchSize);
    }

    /**
     * @notice 更新模块地址 - 从 Registry 获取最新的模块地址
     *         Update module addresses - get latest module addresses from Registry
     * @dev 架构一致性：保持与其他合约相同的模块管理模式
     *      Architectural consistency: Maintain same module management pattern as other contracts
     * @dev 当前实现：LoanNFT 暂时不需要获取其他模块地址
     *      Current implementation: LoanNFT temporarily doesn't need to get other module addresses
     * @dev 未来扩展：如需要依赖其他模块，可在此函数中添加相应逻辑
     *      Future expansion: If other modules are needed, corresponding logic can be added to this function
     */
    

    /**
     * @notice 从用户代币列表中移除指定代币 - 维护用户持有代币索引的准确性
     *         Remove specified token from user token list - maintain accuracy of user token index
     * @param user 用户地址 User address
     * @param tokenId 要移除的代币 ID Token ID to be removed
     * @dev 算法：使用交换删除法，将最后一个元素移动到删除位置以提高效率
     *      Algorithm: Use swap-and-pop method, move last element to deletion position for efficiency
     * @dev 时间复杂度：O(n) 其中 n 是用户持有的代币数量
     *      Time complexity: O(n) where n is the number of tokens held by user
     * @dev Gas 优化：使用 unchecked 块避免不必要的溢出检查
     *      Gas optimization: Use unchecked block to avoid unnecessary overflow checks
     */
    function _removeTokenFromUser(address user, uint256 tokenId) private {
        uint256[] storage tokens = _userTokenIds[user];
        uint256 len = tokens.length;
        for (uint256 i; i < len; ) {
            if (tokens[i] == tokenId) {
                tokens[i] = tokens[len - 1];
                tokens.pop();
                break;
            }
            unchecked {
                ++i;
            }
        }
    }

    /**
     * @notice 升级授权函数 - 验证合约升级权限
     *         Upgrade authorization function - verify contract upgrade permission
     * @param newImplementation 新实现合约地址 New implementation contract address
     * @dev 权限验证：只有治理角色可以授权升级
     *      Permission verification: Only governance role can authorize upgrades
     * @dev 安全机制：使用 UUPS 可升级代理模式，确保升级安全性
     *      Security mechanism: Uses UUPS upgradeable proxy pattern to ensure upgrade security
     * @dev 治理集成：支持与 Timelock/Multisig 治理系统集成
     *      Governance integration: Supports integration with Timelock/Multisig governance systems
     * @dev 参数使用：newImplementation 参数由 UUPSUpgradeable 内部使用
     *      Parameter usage: newImplementation parameter is used internally by UUPSUpgradeable
     */
    function _authorizeUpgrade(address newImplementation) internal override {
        _requireRole(GOVERNANCE_ROLE_VALUE, msg.sender);
        // 升级逻辑由 UUPSUpgradeable 处理
        // Upgrade logic is handled by UUPSUpgradeable
        // 参数 newImplementation 由 UUPSUpgradeable 使用
        // Parameter newImplementation is used by UUPSUpgradeable
        newImplementation; // 避免未使用参数警告 Avoid unused parameter warning
        
        // 记录升级动作 Record upgrade action
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_UPGRADE_MODULE,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_UPGRADE_MODULE),
            msg.sender,
            block.timestamp
        );
    }

    /**
     * @notice 将贷款状态转换为字符串 - 用于 tokenURI 元数据显示
     *         Convert loan status to string - used for tokenURI metadata display
     * @param st 贷款状态枚举 Loan status enum
     * @return 状态对应的字符串 String corresponding to the status
     * @dev 状态映射：
     *      Status mapping:
     *      - LoanStatus.Active -> "Active"
     *      - LoanStatus.Repaid -> "Repaid"
     *      - LoanStatus.Liquidated -> "Liquidated"
     *      - 其他 -> "Defaulted"
     * @dev 纯函数：不读取或修改状态，仅进行数据转换
     *      Pure function: Does not read or modify state, only performs data conversion
     */
    function _statusToString(LoanStatus st) private pure returns (string memory) {
        if (st == LoanStatus.Active) return "Active";
        if (st == LoanStatus.Repaid) return "Repaid";
        if (st == LoanStatus.Liquidated) return "Liquidated";
        return "Defaulted";
    }

    /**
     * @notice 支持的接口查询 - 检查合约是否支持特定接口
     *         Supported interface query - check if contract supports specific interface
     * @param interfaceId 接口 ID Interface ID
     * @return 是否支持该接口 Whether the interface is supported
     * @dev ERC-165 标准：允许合约声明其支持的接口
     *      ERC-165 standard: Allows contracts to declare supported interfaces
     * @dev 继承链：继承自 ERC721EnumerableUpgradeable 的接口支持
     *      Inheritance chain: Interface support inherited from ERC721EnumerableUpgradeable
     * @dev 接口支持：
     *      Interface support:
     *      - ERC721: 基础 NFT 功能
     *      - ERC721Enumerable: 可枚举 NFT 功能  
     *      - ERC721Metadata: 元数据功能
     *      - ILoanNFT: 自定义贷款 NFT 接口
     */
    function supportsInterface(bytes4 interfaceId) public view override(ERC721Upgradeable) returns (bool) {
        return super.supportsInterface(interfaceId);
    }

    /*━━━━━━━━━━━━━━━ GAP 存储间隙 ━━━━━━━━━━━━━━━*/

    /**
     * @notice 存储间隙 - 为未来升级预留存储空间
     *         Storage gap - reserve storage space for future upgrades
     * @dev 升级安全：确保在添加新状态变量时不会覆盖现有存储
     *      Upgrade safety: Ensure adding new state variables won't override existing storage
     * @dev 空间计算：50 - 6 (当前状态变量) = 44 个空位
     *      Space calculation: 50 - 6 (current state variables) = 44 slots
     * @dev 使用规则：每增加一个状态变量，应相应减少 __gap 数组大小
     *      Usage rule: For each added state variable, should correspondingly reduce __gap array size
     */
    uint256[44] private __gap; // storage gap for upgrade safety
} 