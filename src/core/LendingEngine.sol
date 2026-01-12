// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";

import { ActionKeys } from "../constants/ActionKeys.sol";
import { ModuleKeys } from "../constants/ModuleKeys.sol";
import { ILoanNFT } from "../interfaces/ILoanNFT.sol";
import { IFeeRouter } from "../interfaces/IFeeRouter.sol";
import { IRegistry } from "../interfaces/IRegistry.sol";
import { IRegistryUpgradeEvents } from "../interfaces/IRegistryUpgradeEvents.sol";
import { IAccessControlManager } from "../interfaces/IAccessControlManager.sol";
import { IRegistryDynamicModuleKey } from "../interfaces/IRegistryDynamicModuleKey.sol";
import { VaultTypes } from "../Vault/VaultTypes.sol";
import { 
    PausedSystem, 
    ZeroAddress, 
    InvalidCaller,
    ExternalModuleRevertedRaw 
} from "../errors/StandardErrors.sol";
import { GracefulDegradation } from "../libraries/GracefulDegradation.sol";
import { DataPushLibrary } from "../libraries/DataPushLibrary.sol";
import { DataPushTypes } from "../constants/DataPushTypes.sol";
import { IRewardManager, IRewardManagerV2 } from "../interfaces/IRewardManager.sol";
// 移除对已删除库文件的引用

/**
 * @title LendingEngine
 * @notice 管理链上贷款订单生命周期：创建、还款、状态更新。
 * @dev 集成模块化管理，使用 ActionKeys 和 ModuleKeys 进行标准化操作
 * @dev 通过 Registry 获取其他模块地址，支持动态模块升级
 * @dev 使用标准化事件记录，确保系统操作的可追溯性
 * @dev 使用ACM进行权限控制，确保系统安全性
 * @dev 与 Registry 系统完全集成，使用标准化的模块管理
 * @custom:security-contact security@example.com
 */
contract LendingEngine is Initializable, PausableUpgradeable, UUPSUpgradeable, IRegistryUpgradeEvents {
    using SafeERC20 for IERC20;
    using GracefulDegradation for *;

    /*━━━━━━━━━━━━━━━ STRUCTS ━━━━━━━━━━━━━━━*/

    struct LoanOrder {
        uint256 principal;
        uint256 rate;       // bps
        uint256 term;       // 秒
        address borrower;
        address lender;
        address asset;      // ERC20 地址
        uint256 startTimestamp;
        uint256 maturity;
        uint256 repaidAmount;
    }

    /*━━━━━━━━━━━━━━━ STATE ━━━━━━━━━━━━━━━*/

    uint256 private _orderIdCounter;

    /// @notice Registry 合约地址，用于获取其他模块
    address private _registryAddr;
    
    /// @notice RegistryDynamicModuleKey 合约地址，用于动态模块键管理
    IRegistryDynamicModuleKey private _registryDynamicModuleKey;
    
    /// @notice 贷款 NFT 合约地址
    ILoanNFT private _loanNft;
    
    /// @notice 手续费路由合约地址
    IFeeRouter private _feeRouter;
    
    /// @notice 还款手续费基点，例如 6 = 0.06%
    uint256 private constant REPAY_FEE_BPS = 6;
    /// @notice 按期窗口（默认 24 小时）
    uint256 private constant ON_TIME_WINDOW = 24 hours;

    /// @notice 期限白名单（秒）
    uint256 private constant DUR_5D   = 5 days;
    uint256 private constant DUR_10D  = 10 days;
    uint256 private constant DUR_15D  = 15 days;
    uint256 private constant DUR_30D  = 30 days;
    uint256 private constant DUR_60D  = 60 days;
    uint256 private constant DUR_90D  = 90 days;
    uint256 private constant DUR_180D = 180 days;
    uint256 private constant DUR_360D = 360 days;

    /// @notice 贷款订单映射
    mapping(uint256 orderId => LoanOrder) private _loanOrders;
    
    /// @notice 订单ID到NFT TokenID的映射
    mapping(uint256 orderId => uint256 tokenId) private _orderToTokenId;

    /*━━━━━━━━━━━━━━━ GRACEFUL DEGRADATION ━━━━━━━━━━━━━━━*/
    
    /// @notice NFT操作失败重试计数
    mapping(uint256 => uint256) private _nftRetryCount;
    
    /// @notice 费用分发失败记录：订单ID → 失败费用金额
    mapping(uint256 => uint256) private _failedFeeAmount;
    
    /// @notice 外部模块健康状态缓存
    mapping(address => bool) private _moduleHealthCache;
    
    /// @notice 最大重试次数常量
    uint256 private constant MAX_RETRY_COUNT = 3;
    


    /*━━━━━━━━━━━━━━━ EVENTS ━━━━━━━━━━━━━━━*/

    /// @notice 贷款订单创建事件（兼容保留）
    event LoanOrderCreated(uint256 indexed orderId, address indexed borrower, address indexed lender, uint256 principal); // DEPRECATED: 统一使用 DataPush
    
    /// @notice 贷款还款事件（兼容保留）
    event LoanRepaid(uint256 indexed orderId, address indexed payer, uint256 repayAmount); // DEPRECATED: 统一使用 DataPush
    
    /// @notice Registry 地址更新事件
    event RegistryUpdated(address indexed oldRegistry, address indexed newRegistry);
    
    /// @notice RegistryDynamicModuleKey 地址更新事件
    event RegistryDynamicModuleKeyUpdated(address indexed oldAddr, address indexed newAddr);
    


    /*━━━━━━━━━━━━━━━ MONITORING EVENTS ━━━━━━━━━━━━━━━*/
    
    /// @notice NFT操作失败重试事件
    event NftOperationRetried(uint256 indexed orderId, string operation, uint256 retryCount, bool success);

    /// @notice 费用分发失败事件（业务事件）
    event FeeDistributionFailed(uint256 indexed orderId, uint256 feeAmount, string reason);

    /*━━━━━━━━━━━━━━━ ERRORS ━━━━━━━━━━━━━━━*/

    error LendingEngine__NotMatchEngine();
    error LendingEngine__InvalidOrder();
    error LendingEngine__AlreadyRepaid();
    error LendingEngine__InvalidRepayAmount();
    error LendingEngine__ZeroAddress();
    error LendingEngine__RegistryNotSet();
    error LendingEngine__InvalidTerm();
    error LendingEngine__LevelTooLow();

    /*━━━━━━━━━━━━━━━ MODIFIERS ━━━━━━━━━━━━━━━*/
    
    /// @notice 验证 Registry 地址
    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert LendingEngine__ZeroAddress();
        _;
    }

    /*━━━━━━━━━━━━━━━ INITIALIZER ━━━━━━━━━━━━━━━*/

    /// @notice Initialize upgradeable LendingEngine contract.
    /// @dev This function can be called only once during deployment.
    /// @param initialRegistryAddr Registry 合约地址
    /// @dev 使用 Registry 进行模块管理，使用 StandardErrors 进行错误处理
    function initialize(address initialRegistryAddr) external initializer {
        if (initialRegistryAddr == address(0)) revert LendingEngine__ZeroAddress();

        __UUPSUpgradeable_init();
        __Pausable_init();

        _registryAddr = initialRegistryAddr;
        
        // 记录初始化动作
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /*━━━━━━━━━━━━━━━ ADMIN FUNCTIONS ━━━━━━━━━━━━━━━*/

    /// @notice 暂停所有敏感业务函数
    /// @dev 需要 ACTION_PAUSE_SYSTEM 权限
    function pause() external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_PAUSE_SYSTEM, msg.sender);
        _pause();
        
        // 记录暂停动作
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_PAUSE_SYSTEM,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_PAUSE_SYSTEM),
            msg.sender,
            block.timestamp
        );
    }

    /// @notice 解除暂停
    /// @dev 需要 ACTION_UNPAUSE_SYSTEM 权限
    function unpause() external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_UNPAUSE_SYSTEM, msg.sender);
        _unpause();
        
        // 记录恢复动作
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_UNPAUSE_SYSTEM,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_UNPAUSE_SYSTEM),
            msg.sender,
            block.timestamp
        );
    }
    
    /// @notice 更新 Registry 地址
    /// @param newRegistryAddr 新的 Registry 地址
    /// @dev 需要 ACTION_SET_PARAMETER 权限
    function updateRegistry(address newRegistryAddr) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        if (newRegistryAddr == address(0)) revert LendingEngine__ZeroAddress();
        
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
            ModuleKeys.getModuleKeyString(ModuleKeys.KEY_LE),
            oldRegistry,
            newRegistryAddr,
            block.timestamp
        );
    }
    
    /// @notice 设置 RegistryDynamicModuleKey 合约地址
    /// @param dynamicModuleKeyAddr RegistryDynamicModuleKey 合约地址
    /// @dev 需要 ACTION_SET_PARAMETER 权限
    function setRegistryDynamicModuleKey(address dynamicModuleKeyAddr) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        if (dynamicModuleKeyAddr == address(0)) revert LendingEngine__ZeroAddress();
        
        address oldAddr = address(_registryDynamicModuleKey);
        _registryDynamicModuleKey = IRegistryDynamicModuleKey(dynamicModuleKeyAddr);
        
        emit RegistryDynamicModuleKeyUpdated(oldAddr, dynamicModuleKeyAddr);
        
        // 记录参数设置动作
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
    }
    
    /* ============ DataPush 类型常量（迁移至 DataPushTypes） ============ */

    /*━━━━━━━━━━━━━━━ EXTERNAL FUNCTIONS ━━━━━━━━━━━━━━━*/

    /**
     * @notice Create a new loan order and mint an NFT certificate. Caller must hold ACTION_ORDER_CREATE permission.
     * @param order LoanOrder struct containing principal, rate, term, borrower/lender and asset info
     * @return orderId Newly created order ID
     * @dev 需要 ACTION_ORDER_CREATE 权限（ACTION_BORROW 仅保留为事件语义）
     */
    function createLoanOrder(LoanOrder calldata order) external onlyValidRegistry returns (uint256 orderId) {
        _requireRole(ActionKeys.ACTION_ORDER_CREATE, msg.sender);
        if (paused()) revert PausedSystem();
        if (order.principal == 0 || order.borrower == address(0) || order.lender == address(0)) revert LendingEngine__InvalidOrder();
        // Option A enforcement: LoanOrder.lender must be the funding pool contract address (LenderPoolVault).
        // This prevents any path from writing an EOA/multisig into the order's lender field.
        address pool = IRegistry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_LENDER_POOL_VAULT);
        if (order.lender != pool) revert LendingEngine__InvalidOrder();

        // 校验期限白名单
        if (!_isAllowedDuration(order.term)) revert LendingEngine__InvalidTerm();
        // 长期限（≥90天）需要等级≥4
        if (_isLongDuration(order.term)) {
            address rewardView = IRegistry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_REWARD_VIEW);
            uint8 level = IRewardViewBorrowCheck(rewardView).getUserLevelForBorrowCheck(order.borrower);
            if (level < 4) revert LendingEngine__LevelTooLow();
        }

        // 获取最新模块地址
        _updateModuleAddresses();

        orderId = _orderIdCounter;
        unchecked {
            _orderIdCounter++;
        }

        // 计算开始与到期时间
        uint256 startTs = block.timestamp;
        uint256 maturity;
        
        // Gas优化：使用unchecked减少Gas消耗
        unchecked {
            maturity = startTs + order.term;
        }

        // 存储订单
        _loanOrders[orderId] = LoanOrder({
            principal: order.principal,
            rate: order.rate,
            term: order.term,
            borrower: order.borrower,
            lender: order.lender,
            asset: order.asset,
            startTimestamp: startTs,
            maturity: maturity,
            repaidAmount: 0
        });

        // 铸造贷款 NFT（带重试机制的优雅降级）
        ILoanNFT.LoanMetadata memory meta = ILoanNFT.LoanMetadata({
            principal: order.principal,
            rate: order.rate,
            term: order.term,
            oraclePrice: 0, // 由 MatchEngine 可填充实际快照
            loanId: orderId,
            collateralHash: bytes32(0),
            status: ILoanNFT.LoanStatus.Active
        });
        uint256 tokenId = _mintNftWithRetry(orderId, order.borrower, meta);
        _orderToTokenId[orderId] = tokenId;

        emit LoanOrderCreated(orderId, order.borrower, order.lender, order.principal);
        // 统一数据推送
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_LOAN_CREATED,
            abi.encode(address(this), orderId, order.borrower, order.lender, order.principal, order.asset, tokenId, block.timestamp)
        );

        // 落账后触发奖励（借款）：按“已落账”为准
        // - V2：按订单锁定（带 orderId/maturity/outcome）
        // - 回退：若目标实现不支持 V2，则回退到 V1（duration=order.term）
        address rewardManagerBorrow = IRegistry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_RM);
        try IRewardManagerV2(rewardManagerBorrow).onLoanEventV2(
            order.borrower,
            orderId,
            order.principal,
            maturity,
            IRewardManagerV2.LoanEventOutcome.Borrow
        ) { } catch {
            try IRewardManager(rewardManagerBorrow).onLoanEvent(order.borrower, order.principal, order.term, true) { } catch { }
        }

        // 记录借款动作
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_BORROW,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_BORROW),
            msg.sender,
            block.timestamp
        );
    }

    /**
     * @notice Repay a loan, either partially or fully. Can be called by borrower or 3rd party.
     * @param orderId Target loan order ID
     * @param _repayAmount Amount of tokens to repay (principal + interest)
     * @dev 需要 ACTION_REPAY 权限
     */
    function repay(uint256 orderId, uint256 _repayAmount) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_REPAY, msg.sender);
        if (paused()) revert PausedSystem();
        LoanOrder storage ord = _loanOrders[orderId];
        if (ord.borrower == address(0)) revert LendingEngine__InvalidOrder();

        // 获取最新模块地址
        _updateModuleAddresses();

        uint256 totalDue = _calculateTotalDue(ord);
        if (ord.repaidAmount >= totalDue) revert LendingEngine__AlreadyRepaid();
        if (_repayAmount == 0 || _repayAmount > totalDue - ord.repaidAmount) revert LendingEngine__InvalidRepayAmount();

        uint256 feeAmount;
        uint256 lenderAmount;
        uint256 repaidBefore = ord.repaidAmount;
        
        // Gas优化：使用unchecked减少Gas消耗
        unchecked {
            feeAmount = (_repayAmount * REPAY_FEE_BPS) / 1e4;
            lenderAmount = _repayAmount - feeAmount;
            
            // --- Effects: 先更新内部状态，防御重入 ---
            ord.repaidAmount += _repayAmount;
        }

        // 同步回写 VaultLendingEngine 账本：
        // OrderEngine 的 _repayAmount 包含利息与手续费，VaultLendingEngine 仅跟踪“本金债务”。
        // 这里采用 principal-first 规则将还款映射为“本金偿还增量”，用于减少 VaultLendingEngine debt。
        {
            uint256 principal = ord.principal;
            uint256 principalBefore = repaidBefore < principal ? repaidBefore : principal;
            uint256 principalAfter = ord.repaidAmount < principal ? ord.repaidAmount : principal;
            uint256 principalDelta = principalAfter - principalBefore;
            if (principalDelta > 0) {
                address vaultCore = IRegistry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_VAULT_CORE);
                (bool ok, bytes memory reason) = vaultCore.call(
                    abi.encodeWithSignature(
                        "repayFor(address,address,uint256)",
                        ord.borrower,
                        ord.asset,
                        principalDelta
                    )
                );
                if (!ok) revert ExternalModuleRevertedRaw("VaultCore", reason);
            }
        }

        // --- Interactions: 处理外部调用 ---
        if (feeAmount > 0) {
            IERC20(ord.asset).safeTransferFrom(msg.sender, address(this), feeAmount);
            // slither-disable-next-line unchecked-transfer
            IERC20(ord.asset).approve(address(_feeRouter), feeAmount);
            
            // 尝试分发费用，失败时记录但不中断还款流程
            _distributeFeeWithFallback(orderId, ord.asset, feeAmount);
        }

        // 将剩余金额转给贷方
        IERC20(ord.asset).safeTransferFrom(msg.sender, ord.lender, lenderAmount);

        emit LoanRepaid(orderId, msg.sender, _repayAmount);
        // 统一数据推送
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_LOAN_REPAID,
            abi.encode(address(this), orderId, msg.sender, ord.borrower, ord.lender, _repayAmount, ord.repaidAmount, totalDue, ord.asset, block.timestamp)
        );
        
        // 检查是否全部还清 + 是否在按期窗口内
        bool isFullyRepaid = ord.repaidAmount >= totalDue;
        bool isOnTime = (block.timestamp + ON_TIME_WINDOW >= ord.maturity) && (block.timestamp <= ord.maturity + ON_TIME_WINDOW);
        bool isOnTimeAndFullyRepaid = isFullyRepaid && isOnTime;
        
        // 记录还款动作
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_REPAY,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_REPAY),
            msg.sender,
            block.timestamp
        );

        // 若全部还清则更新 NFT 状态
        if (isFullyRepaid) {
            uint256 tokenId = _orderToTokenId[orderId];
            _loanNft.updateLoanStatus(tokenId, ILoanNFT.LoanStatus.Repaid);
        }

        // 落账后触发奖励（还款）：
        // - 仅在“足额还清”时触发（避免 partial repay 导致锁定被提前清空/误判扣罚）
        // - amount 取实际还款金额（最小单位），duration=0，hfHighEnough 传按期且足额布尔
        if (isFullyRepaid) {
            address rewardManagerRepay = IRegistry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_RM);

            // V2 outcome（按订单）
            IRewardManagerV2.LoanEventOutcome outcome;
            if (isOnTimeAndFullyRepaid) {
                outcome = IRewardManagerV2.LoanEventOutcome.RepayOnTimeFull;
            } else {
                // early: now + window < maturity
                bool isEarly = (block.timestamp + ON_TIME_WINDOW < ord.maturity);
                outcome = isEarly ? IRewardManagerV2.LoanEventOutcome.RepayEarlyFull : IRewardManagerV2.LoanEventOutcome.RepayLateFull;
            }

            // 优先 V2，失败回退 V1
            try IRewardManagerV2(rewardManagerRepay).onLoanEventV2(ord.borrower, orderId, _repayAmount, ord.maturity, outcome) { } catch {
                try IRewardManager(rewardManagerRepay).onLoanEvent(ord.borrower, _repayAmount, 0, isOnTimeAndFullyRepaid) { } catch { }
            }
        }
    }

    /*━━━━━━━━━━━━━━━ 专用于 LendingEngineView 的内部查询函数 ━━━━━━━━━━━━━━━*/
    
    /// @notice 获取贷款订单详情（仅供LendingEngineView调用）
    /// @param orderId 订单ID
    /// @return order 贷款订单信息
    /// @dev 只允许具有VIEW_SYSTEM_DATA权限的地址调用
    function _getLoanOrderForView(uint256 orderId) external view onlyValidRegistry returns (LoanOrder memory order) {
        // 验证调用者具有系统数据查看权限
        _requireRole(ActionKeys.ACTION_VIEW_SYSTEM_DATA, msg.sender);
        
        return _loanOrders[orderId];
    }
    
    /// @notice 获取用户贷款数量（仅供LendingEngineView调用）
    /// @param user 用户地址
    /// @return count 贷款数量
    function _getUserLoanCountForView(address user) external view onlyValidRegistry returns (uint256 count) {
        // 验证调用者具有系统数据查看权限
        _requireRole(ActionKeys.ACTION_VIEW_SYSTEM_DATA, msg.sender);
        
        uint256 currentOrderId = _orderIdCounter;
        for (uint256 i = 0; i < currentOrderId; i++) {
            if (_loanOrders[i].borrower == user) {
                count++;
            }
        }
    }
    
    /// @notice 获取失败费用金额（仅供LendingEngineView调用）
    /// @param orderId 订单ID
    /// @return feeAmount 失败费用金额
    function _getFailedFeeAmountForView(uint256 orderId) external view onlyValidRegistry returns (uint256 feeAmount) {
        // 验证调用者具有管理员权限
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        
        return _failedFeeAmount[orderId];
    }
    
    /// @notice 获取NFT重试次数（仅供LendingEngineView调用）
    /// @param orderId 订单ID
    /// @return retryCount 重试次数
    function _getNftRetryCountForView(uint256 orderId) external view onlyValidRegistry returns (uint256 retryCount) {
        // 验证调用者具有管理员权限
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        
        return _nftRetryCount[orderId];
    }
    
    /// @notice 获取注册监控数量（仅供LendingEngineView调用）
    /// @return count 监控数量
    // 监控已移除：不再提供注册监控数量查询
    
    /// @notice 检查用户访问权限（仅供LendingEngineView调用）
    /// @param orderId 订单ID
    /// @param user 用户地址
    /// @return hasAccess 是否有访问权限
    function _canAccessLoanOrderForView(uint256 orderId, address user) external view returns (bool hasAccess) {
        // 验证调用者是LendingEngineView模块（这里不需要Registry验证避免循环）
        LoanOrder memory order = _loanOrders[orderId];
        
        // 订单不存在
        if (order.borrower == address(0)) return false;
        
        // 是借款人或放款人
        if (order.borrower == user || order.lender == user) return true;
        
        // 检查是否有管理员权限
        if (_registryAddr == address(0)) return false;
        
        try IRegistry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL) returns (address acmAddr) {
            return IAccessControlManager(acmAddr).hasRole(ActionKeys.ACTION_SET_PARAMETER, user);
        } catch {
            return false;
        }
    }
    
    /// @notice 检查是否为匹配引擎（仅供LendingEngineView调用）
    /// @param account 待检查的账户
    /// @return isMatch 是否为匹配引擎
    function _isMatchEngineForView(address account) external view returns (bool isMatch) {
        if (_registryAddr == address(0)) return false;
        
        try IRegistry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL) returns (address acmAddr) {
            return IAccessControlManager(acmAddr).hasRole(ActionKeys.ACTION_ORDER_CREATE, account);
        } catch {
            return false;
        }
    }
    
    /// @notice 获取Registry地址（仅供LendingEngineView调用）
    /// @return registry Registry地址
    function _getRegistryForView() external view returns (address registry) {
        return _registryAddr;
    }
    


    /*━━━━━━━━━━━━━━━ INTERNALS ━━━━━━━━━━━━━━━*/

    /* ============ Graceful Degradation Functions ============ */
    
    /// @notice 带重试机制的NFT铸造
    /// @param orderId 订单ID
    /// @param borrower 借款人地址
    /// @param meta NFT元数据
    /// @return tokenId 铸造的NFT令牌ID
    function _mintNftWithRetry(uint256 orderId, address borrower, ILoanNFT.LoanMetadata memory meta) internal returns (uint256 tokenId) {
        uint256 retryCount = _nftRetryCount[orderId];
        
        // Gas优化：使用unchecked减少Gas消耗
        unchecked {
            for (uint256 i = 0; i <= MAX_RETRY_COUNT; i++) {
                try _loanNft.mintLoanCertificate(borrower, meta) returns (uint256 _tokenId) {
                    tokenId = _tokenId;
                    
                    // 铸造成功，清除重试计数
                    if (_nftRetryCount[orderId] > 0) {
                        delete _nftRetryCount[orderId];
                        emit NftOperationRetried(orderId, "mint", i, true);
                    }
                    
                    return tokenId;
                } catch (bytes memory reason) {
                    retryCount = i + 1;
                    _nftRetryCount[orderId] = retryCount;
                    
                    emit NftOperationRetried(orderId, "mint", retryCount, false);
                    
                    // 如果是最后一次重试，则revert
                    if (i == MAX_RETRY_COUNT) {
                        // 记录失败，通过统一数据推送
                        string memory errorMsg = reason.length > 0 ? string(reason) : "NFT mint failed after retries";
                        DataPushLibrary._emitData(
                            DataPushTypes.DATA_TYPE_MODULE_HEALTH,
                            abi.encode(address(_loanNft), "LoanNFT", false, errorMsg, block.timestamp)
                        );
                        // 用户级降级事件：与该订单借款人相关
                        // 无法直接从元数据获取资产，回退为订单中的资产
                        address orderAsset = _loanOrders[orderId].asset;
                        DataPushLibrary._emitData(
                            DataPushTypes.DATA_TYPE_USER_DEGRADATION,
                            abi.encode(borrower, address(this), orderAsset, errorMsg, true, uint256(0), block.timestamp)
                        );
                        revert("NFT mint failed after all retries");
                    }
                }
            }
        }
    }
    
    /// @notice 带降级处理的费用分发
    /// @param orderId 订单ID
    /// @param asset 资产地址
    /// @param feeAmount 费用金额
    function _distributeFeeWithFallback(uint256 orderId, address asset, uint256 feeAmount) internal {
        try _feeRouter.distributeNormal(asset, feeAmount) {
            // 费用分发成功
        } catch (bytes memory reason) {
            // Gas优化：使用unchecked减少Gas消耗
            unchecked {
                // 费用分发失败，记录失败费用供后续处理
                _failedFeeAmount[orderId] += feeAmount;
            }
            
            string memory errorMsg = reason.length > 0 ? string(reason) : "Fee distribution failed";
            emit FeeDistributionFailed(orderId, feeAmount, errorMsg);
            DataPushLibrary._emitData(
                DataPushTypes.DATA_TYPE_MODULE_HEALTH,
                abi.encode(address(_feeRouter), "FeeRouter", false, errorMsg, block.timestamp)
            );
            // 用户级降级事件：与本订单借款人相关
            address borrower = _loanOrders[orderId].borrower;
            DataPushLibrary._emitData(
                DataPushTypes.DATA_TYPE_USER_DEGRADATION,
                abi.encode(borrower, address(this), asset, errorMsg, true, uint256(feeAmount), block.timestamp)
            );
            
            // 注意：这里不revert，允许还款流程继续，只是记录失败的费用
        }
    }

    /// @notice 验证用户权限
    /// @param actionKey 动作键
    /// @param user 用户地址
    function _requireRole(bytes32 actionKey, address user) internal view {
        if (_registryAddr == address(0)) revert LendingEngine__ZeroAddress();
        
        address acmAddr = IRegistry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        IAccessControlManager(acmAddr).requireRole(actionKey, user);
    }

    /// @dev 更新模块地址，从 Registry 获取最新地址
    function _updateModuleAddresses() internal {
        if (_registryAddr == address(0)) revert LendingEngine__RegistryNotSet();
        
        try IRegistry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_LOAN_NFT) returns (address loanNFTAddr) {
            if (loanNFTAddr != address(0) && loanNFTAddr != address(_loanNft)) {
                _loanNft = ILoanNFT(loanNFTAddr);
            }
        } catch {
            // 如果获取失败，保持当前地址不变
        }
        
        try IRegistry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_FR) returns (address feeRouterAddr) {
            if (feeRouterAddr != address(0) && feeRouterAddr != address(_feeRouter)) {
                _feeRouter = IFeeRouter(feeRouterAddr);
            }
        } catch {
            // 如果获取失败，保持当前地址不变
        }
    }

    /// @dev 判断是否为白名单期限
    function _isAllowedDuration(uint256 durationSec) internal pure returns (bool) {
        return (
            durationSec == DUR_5D   || durationSec == DUR_10D || durationSec == DUR_15D ||
            durationSec == DUR_30D  || durationSec == DUR_60D || durationSec == DUR_90D ||
            durationSec == DUR_180D || durationSec == DUR_360D
        );
    }

    /// @dev 判断是否为长期限（≥90天）
    function _isLongDuration(uint256 durationSec) internal pure returns (bool) {
        return (durationSec == DUR_90D || durationSec == DUR_180D || durationSec == DUR_360D);
    }

    /// @dev 计算应还总额（本金 + 简易按天计息）
    /// @param ord 贷款订单数据
    /// @return totalDue 本金+利息
    function _calculateTotalDue(LoanOrder memory ord) internal pure returns (uint256) {
        // Gas优化：使用unchecked减少Gas消耗
        unchecked {
            // 简易利息计算：principal * rate / 1e4 * term / 365 days
            uint256 interest = (ord.principal * ord.rate * ord.term) / (365 days * 1e4);
            return ord.principal + interest;
        }
    }

    /// @notice 升级授权函数
    /// @dev onlyRole modifier 已经足够验证权限
    /// @dev 如需接入 Timelock/Multisig 治理，应在此处增加相应的权限检查逻辑
    function _authorizeUpgrade(address newImplementation) internal override {
        _requireRole(ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
        if (newImplementation == address(0)) revert LendingEngine__ZeroAddress();
        require(newImplementation.code.length > 0, "Invalid implementation");
        
        // 记录升级动作
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_UPGRADE_MODULE,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_UPGRADE_MODULE),
            msg.sender,
            block.timestamp
        );
    }

    /*━━━━━━━━━━━━━━━ GAP ━━━━━━━━━━━━━━━*/

    uint256[44] private __gap;
} 

/// @dev RewardManagerCore 最小只读接口（仅用于等级门槛校验）
interface IRewardViewBorrowCheck {
    function getUserLevelForBorrowCheck(address user) external view returns (uint8);
}