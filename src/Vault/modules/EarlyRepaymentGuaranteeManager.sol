// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
// 移除 PausableUpgradeable 以保持单一职责
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { 
    AmountIsZero, 
    ZeroAddress, 
    ExternalModuleRevertedRaw,
    GuaranteeNotActive,
    InvalidGuaranteeId,
    GuaranteeAlreadyProcessed,
    GuaranteeRecordNotFound,
    GuaranteeIdOverflow,
    InvalidGuaranteeTerm,
    GuaranteeInterestTooHigh,
    BorrowerCannotBeLender,
    EarlyRepaymentGuaranteeManager__OnlyVaultCore,
    EarlyRepaymentGuaranteeManager__InvalidImplementation,
    EarlyRepaymentGuaranteeManager__RateTooHigh,
    EarlyRepaymentGuaranteeManager__RateUnchanged
} from "../../errors/StandardErrors.sol";
import { ActionKeys } from "../../constants/ActionKeys.sol";
import { ModuleKeys } from "../../constants/ModuleKeys.sol";
import { VaultTypes } from "../VaultTypes.sol";
import { Registry } from "../../registry/Registry.sol";
import { IAccessControlManager } from "../../interfaces/IAccessControlManager.sol";

/// @title EarlyRepaymentGuaranteeManager
/// @notice 提前还款保证金管理模块，处理借款方的提前还款保证金机制
/// @dev 借款时锁定承诺利息作为保证金，提前还款时按规则分配，违约时全部没收
/// @dev 与 ActionKeys 和 ModuleKeys 集成，提供标准化的权限和模块管理
/// @dev 支持 UUPS 升级模式，使用 ReentrancyGuard 防止重入攻击
/// @dev 使用Registry系统进行权限控制和模块管理，确保系统安全性
/// @dev 集成模块地址缓存机制，提高性能和可靠性
/// @custom:security-contact security@example.com
contract EarlyRepaymentGuaranteeManager is 
    Initializable, 
    UUPSUpgradeable, 
    ReentrancyGuardUpgradeable
{
    using SafeERC20 for IERC20;

    /* ============ Structs ============ */
    /// @notice 保证金记录结构
    struct GuaranteeRecord {
        uint256 principal;                    // 借款本金
        uint256 promisedInterest;             // 承诺的利息（保证金）
        uint256 startTime;                    // 借款开始时间
        uint256 maturityTime;                 // 到期时间
        uint256 earlyRepayPenaltyDays;        // 提前还款罚金天数（默认2天）
        bool isActive;                        // 是否活跃
        address lender;                       // 贷款方地址
        address asset;                        // 资产地址
    }

    /// @notice 提前还款结果结构
    struct EarlyRepaymentResult {
        uint256 penaltyToLender;              // 给贷款方的罚金
        uint256 refundToBorrower;             // 返还给借款方的金额
        uint256 platformFee;                  // 平台手续费
        uint256 actualInterestPaid;           // 实际支付的利息
    }

    /* ============ Storage ============ */
    /// @notice 保证金记录映射：guaranteeId → GuaranteeRecord
    mapping(uint256 => GuaranteeRecord) private _guaranteeRecords;
    
    /// @notice 用户保证金ID映射：user → asset → guaranteeId
    mapping(address => mapping(address => uint256)) private _userGuaranteeIds;
    
    /// @notice 保证金ID计数器
    uint256 private _guaranteeIdCounter;
    
    /// @notice VaultCore 合约地址
    address private _vaultCoreAddr;
    
    /// @notice Registry合约地址
    address private _registryAddr;
    
    /// @notice 平台费用接收者地址
    address private _platformFeeReceiverAddr;
    
    /// @notice 默认提前还款罚金天数
    uint256 internal constant DEFAULT_EARLY_REPAY_PENALTY_DAYS = 2;
    
    /// @notice 平台手续费率（基点，默认100 = 1%）
    uint256 private _platformFeeRate;
    
    /// @notice 最大批量操作数量限制
    uint256 internal constant MAX_BATCH_SIZE = 50;

    /// @notice 模块地址缓存映射
    // 移除模块地址缓存相关职责，保持单一职责

    /// @notice Storage gap for upgrade safety
    uint256[47] private _gap__;

    /* ============ Events ============ */
    /// @notice 保证金锁定事件
    /// @param guaranteeId 保证金ID
    /// @param borrower 借款方地址
    /// @param lender 贷款方地址
    /// @param asset 资产地址
    /// @param principal 本金金额
    /// @param promisedInterest 承诺利息金额
    /// @param startTime 开始时间
    /// @param maturityTime 到期时间
    /// @param earlyRepayPenaltyDays 提前还款罚金天数
    /// @param timestamp 时间戳
    event GuaranteeLocked(
        uint256 indexed guaranteeId,
        address indexed borrower,
        address indexed lender,
        address asset,
        uint256 principal,
        uint256 promisedInterest,
        uint256 startTime,
        uint256 maturityTime,
        uint256 earlyRepayPenaltyDays,
        uint256 timestamp
    );

    /// @notice 提前还款处理事件
    /// @param guaranteeId 保证金ID
    /// @param borrower 借款方地址
    /// @param lender 贷款方地址
    /// @param asset 资产地址
    /// @param penaltyToLender 给贷款方的罚金
    /// @param refundToBorrower 返还给借款方的金额
    /// @param platformFee 平台手续费
    /// @param actualInterestPaid 实际支付的利息
    /// @param timestamp 时间戳
    event EarlyRepaymentProcessed(
        uint256 indexed guaranteeId,
        address indexed borrower,
        address indexed lender,
        address asset,
        uint256 penaltyToLender,
        uint256 refundToBorrower,
        uint256 platformFee,
        uint256 actualInterestPaid,
        uint256 timestamp
    );

    /// @notice 保证金没收事件（违约）
    /// @param guaranteeId 保证金ID
    /// @param borrower 借款方地址
    /// @param lender 贷款方地址
    /// @param asset 资产地址
    /// @param forfeitedAmount 没收金额
    /// @param timestamp 时间戳
    event GuaranteeForfeited(
        uint256 indexed guaranteeId,
        address indexed borrower,
        address indexed lender,
        address asset,
        uint256 forfeitedAmount,
        uint256 timestamp
    );

    /// @notice 平台费用接收者更新事件
    /// @param oldReceiver 旧接收者地址
    /// @param newReceiver 新接收者地址
    /// @param timestamp 时间戳
    event PlatformFeeReceiverUpdated(
        address indexed oldReceiver,
        address indexed newReceiver,
        uint256 timestamp
    );

    /// @notice 平台手续费率更新事件
    /// @param oldRate 旧费率
    /// @param newRate 新费率
    /// @param timestamp 时间戳
    event PlatformFeeRateUpdated(
        uint256 oldRate,
        uint256 newRate,
        uint256 timestamp
    );

    /// @notice Registry地址更新事件
    /// @param oldRegistry 旧Registry地址
    /// @param newRegistry 新Registry地址
    event RegistryUpdated(address indexed oldRegistry, address indexed newRegistry);

    /// @notice 模块地址缓存更新事件
    /// @param moduleKey 模块键
    /// @param oldAddress 旧地址
    /// @param newAddress 新地址
    /// @param timestamp 时间戳
    // 移除模块地址缓存更新事件

    /// @notice 权限验证事件
    /// @param caller 调用者地址
    /// @param actionKey 动作键
    /// @param hasPermission 是否有权限
    /// @param timestamp 时间戳
    // 移除权限验证事件冗余

    /// @notice 模块调用失败事件
    /// @param moduleKey 模块键
    /// @param reason 失败原因
    /// @param fallbackUsed 是否使用降级策略
    /// @param timestamp 时间戳
    // 移除模块调用失败事件冗余

    /* ============ Modifiers ============ */
    /// @notice 仅限 VaultCore 合约调用
    modifier onlyVaultCore() {
        if (msg.sender != _vaultCoreAddr) revert EarlyRepaymentGuaranteeManager__OnlyVaultCore();
        _;
    }

    /// @notice 验证Registry地址有效性
    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        _;
    }

    /// @notice 权限验证修饰符
    modifier onlyRole(bytes32 role) {
        _requireRole(role, msg.sender);
        _;
    }

    /* ============ Initializer ============ */
    /// @notice 初始化提前还款保证金管理模块
    /// @param initialVaultCoreAddr VaultCore 合约地址
    /// @param initialRegistryAddr Registry合约地址
    /// @param initialPlatformFeeReceiverAddr 平台费用接收者地址
    /// @param initialPlatformFeeRate 平台手续费率（基点）
    function initialize(
        address initialVaultCoreAddr,
        address initialRegistryAddr,
        address initialPlatformFeeReceiverAddr,
        uint256 initialPlatformFeeRate
    ) external initializer {
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        
        if (initialVaultCoreAddr == address(0)) revert ZeroAddress();
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        if (initialPlatformFeeReceiverAddr == address(0)) revert ZeroAddress();
        
        _vaultCoreAddr = initialVaultCoreAddr;
        _registryAddr = initialRegistryAddr;
        _platformFeeReceiverAddr = initialPlatformFeeReceiverAddr;
        _platformFeeRate = initialPlatformFeeRate;
        
        // 发出标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
    }

    /* ============ Registry 系统集成 ============ */
    /// @notice 获取模块地址（从 Registry）
    /// @param moduleKey 模块键
    /// @return 模块地址
    function getModule(bytes32 moduleKey) external view onlyValidRegistry returns (address) {
        return Registry(_registryAddr).getModule(moduleKey);
    }

    /// @notice 获取模块地址或回滚（从 Registry）
    /// @param moduleKey 模块键
    /// @return 模块地址
    function getModuleOrRevert(bytes32 moduleKey) external view onlyValidRegistry returns (address) {
        return Registry(_registryAddr).getModuleOrRevert(moduleKey);
    }

    /// @notice 检查模块是否已注册
    /// @param moduleKey 模块键
    /// @return 是否已注册
    function isModuleRegistered(bytes32 moduleKey) external view onlyValidRegistry returns (bool) {
        return Registry(_registryAddr).isModuleRegistered(moduleKey);
    }

    /// @notice 获取待升级模块信息
    /// @param moduleKey 模块键
    /// @return newAddr 新模块地址
    /// @return executeAfter 执行时间
    /// @return hasPendingUpgrade 是否有待升级
    function getPendingUpgrade(bytes32 moduleKey) external view onlyValidRegistry returns (address newAddr, uint256 executeAfter, bool hasPendingUpgrade) {
        return Registry(_registryAddr).getPendingUpgrade(moduleKey);
    }

    /// @notice 检查模块升级是否就绪
    /// @param moduleKey 模块键
    /// @return 是否就绪
    function isUpgradeReady(bytes32 moduleKey) external view onlyValidRegistry returns (bool) {
        (, uint256 executeAfter, bool hasPending) = Registry(_registryAddr).getPendingUpgrade(moduleKey);
        return hasPending && block.timestamp >= executeAfter;
    }

    /* ============ 模块地址缓存管理 ============ */
    /// @notice 获取并缓存模块地址 - 用于非view函数
    /// @param moduleKey 模块键
    /// @return 模块地址
    // 移除模块地址缓存相关函数

    /// @notice 刷新模块地址缓存
    /// @param moduleKey 模块键
    // 移除

    /// @notice 批量刷新常用模块地址缓存
    // 移除

    /// @notice 安全获取模块地址（带异常处理）
    /// @param moduleKey 模块键
    /// @return 模块地址
    // 移除

    /// @notice 处理模块调用失败
    /// @param moduleKey 模块键
    /// @param reason 失败原因
    // 移除

    /* ============ 权限控制增强 ============ */
    /// @notice 权限校验内部函数
    /// @param actionKey 动作键
    /// @param user 用户地址
    function _requireRole(bytes32 actionKey, address user) internal view {
        address acmAddr = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        IAccessControlManager(acmAddr).requireRole(actionKey, user);
    }

    /// @notice 角色检查内部函数
    /// @param actionKey 动作键
    /// @param user 用户地址
    /// @return 是否具有角色
    function _hasRole(bytes32 actionKey, address user) internal view returns (bool) {
        address acmAddr = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        try IAccessControlManager(acmAddr).hasRole(actionKey, user) returns (bool hasRole) { return hasRole; } catch { return false; }
    }

    /// @notice 验证模块地址有效性
    /// @param moduleAddr 模块地址
    function _validateModuleAddress(address moduleAddr) internal pure {
        if (moduleAddr == address(0)) revert ZeroAddress();
    }

    /// @notice 获取Registry地址
    /// @return Registry合约地址
    function getRegistry() external view returns (address) {
        return _registryAddr;
    }

    /* ============ View Functions ============ */
    /// @notice 查询保证金记录
    /// @param guaranteeId 保证金ID
    /// @return record 保证金记录
    function getGuaranteeRecord(uint256 guaranteeId) external view returns (GuaranteeRecord memory record) {
        return _guaranteeRecords[guaranteeId];
    }

    /// @notice 查询用户的保证金ID
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @return guaranteeId 保证金ID
    function getUserGuaranteeId(address user, address asset) external view returns (uint256 guaranteeId) {
        return _userGuaranteeIds[user][asset];
    }

    /// @notice 查询用户是否有活跃的保证金
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @return isActive 是否有活跃保证金
    function hasActiveGuarantee(address user, address asset) external view returns (bool isActive) {
        uint256 guaranteeId = _userGuaranteeIds[user][asset];
        if (guaranteeId == 0) return false;
        
        GuaranteeRecord storage record = _guaranteeRecords[guaranteeId];
        return record.isActive;
    }

    /// @notice 预览提前还款结果
    /// @param guaranteeId 保证金ID
    /// @param actualRepayAmount 实际还款金额
    /// @return result 提前还款结果
    function previewEarlyRepayment(
        uint256 guaranteeId,
        uint256 actualRepayAmount
    ) external view returns (EarlyRepaymentResult memory result) {
        GuaranteeRecord storage record = _guaranteeRecords[guaranteeId];
        if (!record.isActive) revert GuaranteeNotActive();
        
        return _calculateEarlyRepaymentResult(record, actualRepayAmount);
    }

    /* ============ Core Functions ============ */
    /// @notice 锁定保证金
    /// @dev 仅 VaultCore 可调用
    /// @param borrower 借款方地址
    /// @param lender 贷款方地址
    /// @param asset 资产地址
    /// @param principal 本金金额
    /// @param promisedInterest 承诺利息金额
    /// @param termDays 借款期限（天）
    /// @return guaranteeId 保证金ID
    function lockGuaranteeRecord(
        address borrower,
        address lender,
        address asset,
        uint256 principal,
        uint256 promisedInterest,
        uint256 termDays
    ) external onlyVaultCore onlyValidRegistry nonReentrant returns (uint256 guaranteeId) {
        // 基础参数验证
        if (borrower == address(0)) revert ZeroAddress();
        if (lender == address(0)) revert ZeroAddress();
        if (asset == address(0)) revert ZeroAddress();
        if (principal == 0) revert AmountIsZero();
        if (promisedInterest == 0) revert AmountIsZero();
        if (termDays == 0) revert AmountIsZero();
        
        // 业务逻辑验证
        if (borrower == lender) revert BorrowerCannotBeLender();
        if (termDays > 365 * 10) revert InvalidGuaranteeTerm(); // 最大10年
        if (promisedInterest > principal * 2) revert GuaranteeInterestTooHigh(); // 利息不超过本金的2倍
        
        // 检查用户是否已有活跃保证金
        if (_userGuaranteeIds[borrower][asset] != 0) {
            uint256 existingId = _userGuaranteeIds[borrower][asset];
            if (_guaranteeRecords[existingId].isActive) {
                revert GuaranteeAlreadyProcessed();
            }
        }
        
        // 检查计数器溢出
        if (_guaranteeIdCounter == type(uint256).max) revert GuaranteeIdOverflow();
        
        // 生成新的保证金ID
        uint256 newGuaranteeId = ++_guaranteeIdCounter;
        guaranteeId = newGuaranteeId;
        
        // 创建保证金记录
        GuaranteeRecord storage record = _guaranteeRecords[newGuaranteeId];
        record.principal = principal;
        record.promisedInterest = promisedInterest;
        record.startTime = block.timestamp;
        record.maturityTime = block.timestamp + (termDays * 1 days);
        record.earlyRepayPenaltyDays = DEFAULT_EARLY_REPAY_PENALTY_DAYS;
        record.isActive = true;
        record.lender = lender;
        record.asset = asset;
        
        // 更新用户保证金ID映射
        _userGuaranteeIds[borrower][asset] = newGuaranteeId;
        
        emit GuaranteeLocked(
            newGuaranteeId,
            borrower,
            lender,
            asset,
            principal,
            promisedInterest,
            record.startTime,
            record.maturityTime,
            record.earlyRepayPenaltyDays,
            block.timestamp
        );
        
        // 发出标准化动作事件
        emit VaultTypes.ActionExecuted(ActionKeys.ACTION_SET_PARAMETER, ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER), msg.sender, block.timestamp);
        
        return guaranteeId;
    }

    /// @notice 处理提前还款
    /// @dev 仅 VaultCore 可调用，遵循 CEI 模式防止重入攻击
    /// @param borrower 借款方地址
    /// @param asset 资产地址
    /// @param actualRepayAmount 实际还款金额（当前规则未用作分配依据，预留参数）
    /// @return result 提前还款结果
    function settleEarlyRepayment(
        address borrower,
        address asset,
        uint256 actualRepayAmount
    ) external onlyVaultCore onlyValidRegistry nonReentrant returns (EarlyRepaymentResult memory result) {
        if (borrower == address(0)) revert ZeroAddress();
        if (asset == address(0)) revert ZeroAddress();
        if (actualRepayAmount == 0) revert AmountIsZero();
        
        uint256 currentGuaranteeId = _userGuaranteeIds[borrower][asset];
        if (currentGuaranteeId == 0) revert GuaranteeRecordNotFound();
        
        GuaranteeRecord storage record = _guaranteeRecords[currentGuaranteeId];
        if (!record.isActive) revert GuaranteeNotActive();
        
        // 计算提前还款结果
        result = _calculateEarlyRepaymentResult(record, actualRepayAmount);
        
        // CEI 模式：先更新状态 (Effects)
        record.isActive = false;
        delete _userGuaranteeIds[borrower][asset];
        
        // 真实转账由 GuaranteeFundManager 执行：一次性三路分发
        address gfm = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_GUARANTEE_FUND);
        // 调用 GFM 进行托管资金结算
        (bool ok, bytes memory data) = gfm.call(
            abi.encodeWithSignature(
                "settleEarlyRepayment(address,address,address,address,uint256,uint256,uint256)",
                borrower,
                asset,
                record.lender,
                _platformFeeReceiverAddr,
                result.refundToBorrower,
                result.penaltyToLender,
                result.platformFee
            )
        );
        if (!ok) revert ExternalModuleRevertedRaw("GuaranteeFundManager", data);
        
        emit EarlyRepaymentProcessed(
            currentGuaranteeId,
            borrower,
            record.lender,
            asset,
            result.penaltyToLender,
            result.refundToBorrower,
            result.platformFee,
            result.actualInterestPaid,
            block.timestamp
        );
        
        // 发出标准化动作事件
        emit VaultTypes.ActionExecuted(ActionKeys.ACTION_REPAY, ActionKeys.getActionKeyString(ActionKeys.ACTION_REPAY), msg.sender, block.timestamp);
        
        return result;
    }

    /// @notice 处理违约（没收保证金）
    /// @dev 仅 VaultCore 可调用，遵循 CEI 模式防止重入攻击
    /// @param borrower 借款方地址
    /// @param asset 资产地址
    /// @return forfeitedAmount 没收金额
    function processDefault(
        address borrower,
        address asset
    ) external onlyVaultCore onlyValidRegistry nonReentrant returns (uint256 forfeitedAmount) {
        if (borrower == address(0)) revert ZeroAddress();
        if (asset == address(0)) revert ZeroAddress();
        
        uint256 currentGuaranteeId = _userGuaranteeIds[borrower][asset];
        if (currentGuaranteeId == 0) revert GuaranteeRecordNotFound();
        
        GuaranteeRecord storage record = _guaranteeRecords[currentGuaranteeId];
        if (!record.isActive) revert GuaranteeNotActive();
        
        // 计算没收金额（全部保证金）
        forfeitedAmount = record.promisedInterest;
        
        // CEI 模式：先更新状态 (Effects)
        record.isActive = false;
        delete _userGuaranteeIds[borrower][asset];
        
        // 托管资金由 GFM 统一执行（多接收人没收亦可）
        address gfm = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_GUARANTEE_FUND);
        (bool ok, bytes memory data) = gfm.call(
            abi.encodeWithSignature(
                "forfeitPartial(address,address,address,uint256)",
                borrower,
                asset,
                record.lender,
                forfeitedAmount
            )
        );
        if (!ok) revert ExternalModuleRevertedRaw("GuaranteeFundManager", data);
        
        emit GuaranteeForfeited(
            currentGuaranteeId,
            borrower,
            record.lender,
            asset,
            forfeitedAmount,
            block.timestamp
        );
        
        // 发出标准化动作事件
        emit VaultTypes.ActionExecuted(ActionKeys.ACTION_LIQUIDATE, ActionKeys.getActionKeyString(ActionKeys.ACTION_LIQUIDATE), msg.sender, block.timestamp);
        
        return forfeitedAmount;
    }

    /* ============ Admin Functions ============ */
    /// @notice 更新平台费用接收者地址
    /// @param newReceiverAddr 新的费用接收者地址
    function setPlatformFeeReceiver(address newReceiverAddr) external onlyValidRegistry onlyRole(ActionKeys.ACTION_SET_PARAMETER) {
        _validateModuleAddress(newReceiverAddr);
        address oldReceiver = _platformFeeReceiverAddr;
        _platformFeeReceiverAddr = newReceiverAddr;
        
        emit PlatformFeeReceiverUpdated(oldReceiver, newReceiverAddr, block.timestamp);
        
        // 发出标准化动作事件
        emit VaultTypes.ActionExecuted(ActionKeys.ACTION_SET_PARAMETER, ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER), msg.sender, block.timestamp);
    }

    /// @notice 更新平台手续费率
    /// @param newRate 新的手续费率（基点）
    function setPlatformFeeRate(uint256 newRate) external onlyValidRegistry onlyRole(ActionKeys.ACTION_SET_PARAMETER) {
        if (newRate > 1000) revert EarlyRepaymentGuaranteeManager__RateTooHigh();
        if (newRate == _platformFeeRate) revert EarlyRepaymentGuaranteeManager__RateUnchanged();
        uint256 oldRate = _platformFeeRate;
        _platformFeeRate = newRate;
        
        emit PlatformFeeRateUpdated(oldRate, newRate, block.timestamp);
        
        // 发出标准化动作事件
        emit VaultTypes.ActionExecuted(ActionKeys.ACTION_SET_PARAMETER, ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER), msg.sender, block.timestamp);
    }

    /// @notice 更新 VaultCore 地址
    /// @param newVaultCoreAddr 新的 VaultCore 地址
    function setVaultCore(address newVaultCoreAddr) external onlyValidRegistry onlyRole(ActionKeys.ACTION_UPGRADE_MODULE) {
        _validateModuleAddress(newVaultCoreAddr);
        _vaultCoreAddr = newVaultCoreAddr;
        
        // 发出标准化动作事件
        emit VaultTypes.ActionExecuted(ActionKeys.ACTION_SET_PARAMETER, ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER), msg.sender, block.timestamp);
    }

    /// @notice 更新Registry地址（治理功能）
    /// @dev 仅治理可调用
    /// @param newRegistryAddr 新的Registry地址
    function setRegistry(address newRegistryAddr) external onlyValidRegistry onlyRole(ActionKeys.ACTION_UPGRADE_MODULE) {
        _validateModuleAddress(newRegistryAddr);
        address oldRegistry = _registryAddr;
        _registryAddr = newRegistryAddr;
        
        emit RegistryUpdated(oldRegistry, newRegistryAddr);
        
        // 发出标准化动作事件
        emit VaultTypes.ActionExecuted(ActionKeys.ACTION_UPGRADE_MODULE, ActionKeys.getActionKeyString(ActionKeys.ACTION_UPGRADE_MODULE), msg.sender, block.timestamp);
    }

    /// @notice 紧急暂停功能
    // 移除暂停/恢复，统一由系统层处理

    /// @notice 刷新模块缓存
    // 移除缓存刷新职责

    /* ============ Internal Functions ============ */
    /// @dev 计算提前还款结果，使用高精度计算
    /// @param record 保证金记录
    /// @return result 提前还款结果
    function _calculateEarlyRepaymentResult(
        GuaranteeRecord storage record,
        uint256 /* _actualRepayAmount */
    ) internal view returns (EarlyRepaymentResult memory result) {
        // 验证时间参数
        if (block.timestamp < record.startTime) revert InvalidGuaranteeId();
        
        // 计算实际借款天数
        uint256 actualDays = (block.timestamp - record.startTime) / 1 days;
        
        // 计算总天数
        uint256 totalDays = (record.maturityTime - record.startTime) / 1 days;
        if (totalDays == 0) totalDays = 1; // 防止除零
        // 若超出期限，按到期天数封顶，避免溢出并保持业务语义
        if (actualDays > totalDays) {
            actualDays = totalDays;
        }
        
        // 使用高精度计算实际应付利息（按比例）
        // 使用 1e18 作为精度基数
        result.actualInterestPaid = (record.promisedInterest * actualDays * 1e18) / (totalDays * 1e18);
        
        // 计算提前还款罚金（额外2天利息）
        uint256 penaltyDays = record.earlyRepayPenaltyDays;
        uint256 dailyInterest = record.promisedInterest / totalDays;
        uint256 penaltyInterest = dailyInterest * penaltyDays;
        
        // 确保罚金不超过剩余保证金
        uint256 remainingGuarantee = record.promisedInterest - result.actualInterestPaid;
        if (penaltyInterest > remainingGuarantee) {
            penaltyInterest = remainingGuarantee;
        }
        
        result.penaltyToLender = penaltyInterest;
        
        // 计算平台手续费
        result.platformFee = (result.penaltyToLender * _platformFeeRate) / 10000;
        
        // 计算返还给借款方的金额
        uint256 totalDeduction = result.actualInterestPaid + result.penaltyToLender;
        if (totalDeduction > record.promisedInterest) {
            totalDeduction = record.promisedInterest;
        }
        
        result.refundToBorrower = record.promisedInterest - totalDeduction;
        
        return result;
    }

    /// @notice 清除所有模块缓存
    // 移除模块缓存清理

    /* ============ Upgrade Auth ============ */
    /// @notice 升级授权函数
    /// @dev onlyRole modifier 已经足够验证权限
    /// @dev 如需接入 Timelock/Multisig 治理，应在此处增加相应的权限检查逻辑
    function _authorizeUpgrade(address newImplementation) internal view override {
        _requireRole(ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
        if (newImplementation == address(0)) revert ZeroAddress();
        
        // 验证新实现合约
        if (newImplementation.code.length == 0) revert EarlyRepaymentGuaranteeManager__InvalidImplementation();
        
        // 可以在这里添加更多的实现合约验证逻辑
        // 例如验证合约是否实现了必要的接口
        // 或者验证合约的存储布局是否兼容
    }
} 