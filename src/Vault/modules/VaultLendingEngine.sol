// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { ReentrancyGuardSlimUpgradeable } from "../../utils/ReentrancyGuardSlimUpgradeable.sol";

import { ActionKeys } from "../../constants/ActionKeys.sol";
import { ModuleKeys } from "../../constants/ModuleKeys.sol";
import { AmountIsZero, Overpay, ZeroAddress, MissingRole } from "../../errors/StandardErrors.sol";
import { IPriceOracle } from "../../interfaces/IPriceOracle.sol";
import { ILendingEngineBasic } from "../../interfaces/ILendingEngineBasic.sol";
import { IAccessControlManager } from "../../interfaces/IAccessControlManager.sol";
import { ICollateralManager } from "../../interfaces/ICollateralManager.sol";
import { IVaultRouter } from "../../interfaces/IVaultRouter.sol";
import { ViewConstants } from "../view/ViewConstants.sol";
import { Registry } from "../../registry/Registry.sol";
import { HealthFactorLib } from "../../libraries/HealthFactorLib.sol";
import { ILiquidationRiskManager } from "../../interfaces/ILiquidationRiskManager.sol";
import { VaultTypes } from "../VaultTypes.sol";
import { LendingEngineStorage } from "./lendingEngine/LendingEngineStorage.sol";
import { LendingEngineValuation } from "./lendingEngine/LendingEngineValuation.sol";
import { LendingEngineCore } from "./lendingEngine/LendingEngineCore.sol";

/// @notice 最小化 VaultCore 接口（用于解析 View 地址）
interface IVaultCoreMinimal {
    function viewContractAddrVar() external view returns (address);
}

/// @title VaultLendingEngine
/// @notice Vault 内部多资产债务记账模块，记录用户借款、还款与清算等操作
/// @dev 支持多种结算币的债务管理，每种资产独立记账，集成价格预言机
/// @dev 这是Vault系统的核心借贷引擎，负责所有债务相关的记账和查询
/// @dev 支持多资产借贷，每个用户可以同时借入多种不同的ERC20代币
/// @dev 集成价格预言机，实时计算债务的价值（以结算币计价）
/// @dev 提供优化的数据结构，支持快速查询用户债务列表和总价值
/// @dev 支持利率管理，不同资产可以设置不同的年利率
/// @dev 继承GovernanceRole提供治理权限控制
/// @dev 支持升级功能，可升级实现合约
/// @dev 使用ReentrancyGuard防止重入攻击
/// @dev 支持暂停功能，紧急情况下可暂停所有借贷操作
/// @dev 与ActionKeys和ModuleKeys集成，提供标准化的动作和模块管理
/// @dev 与Registry系统集成，支持模块地址的动态管理
/// @dev 集成AccessControlManager权限控制，支持细粒度权限管理
/// @dev 使用Registry系统进行权限控制和模块管理，确保系统安全性
/// @dev 集成RegistryUpgradeLibrary和RegistryDynamicLibrary，支持基础升级管理功能
/// @custom:security-contact security@example.com
contract VaultLendingEngine is 
    Initializable, 
    UUPSUpgradeable, 
    ReentrancyGuardSlimUpgradeable,
    ILendingEngineBasic
{
    using LendingEngineValuation for LendingEngineStorage.Layout;
    using LendingEngineCore for LendingEngineStorage.Layout;

    /// @dev Storage accessor for library-based modules (slot 0)
    function _s() internal pure returns (LendingEngineStorage.Layout storage stor) {
        return LendingEngineStorage.layout();
    }

    /* ============ Storage ============ */
    /// @notice 用户多资产债务映射：user → asset → debtAmount
    /// @dev 记录每个用户每种资产的债务数量
    mapping(address => mapping(address => uint256)) private _userDebt;
    
    /// @notice 各资产总债务：asset → totalDebtAmount
    /// @dev 记录每种资产在系统中的总债务量
    mapping(address => uint256) private _totalDebtByAsset;
    
    /// @notice 用户总债务价值（以结算币计价）
    /// @dev 缓存用户所有债务的总价值，避免重复计算
    mapping(address => uint256) private _userTotalDebtValue;
    
    /// @notice 系统总债务价值（以结算币计价）
    /// @dev 记录整个系统的总债务价值
    uint256 private _totalDebtValue;

    /// @notice 价格预言机地址（私有存储）
    /// @dev 用于获取各种资产的价格，计算债务价值
    address private _priceOracleAddr;

    /// @notice 结算币地址（用于价值计算，私有存储）
    /// @dev 所有价值计算都以结算币为基准
    address private _settlementTokenAddr;

    /// @notice Registry合约地址（私有存储）
    /// @dev 用于获取其他模块地址和记录标准化事件
    address private _registryAddr;

    /// @notice 用户债务资产列表缓存：user → asset[] - 优化查询性能
    /// @dev 记录每个用户借入的所有资产列表，便于快速遍历
    mapping(address => address[]) private _userDebtAssets;

    /// @notice 用户债务资产索引映射：user → asset → index - 快速查找
    /// @dev 记录每个用户每种资产在_userDebtAssets数组中的索引位置
    mapping(address => mapping(address => uint256)) private _userDebtAssetIndex;

    /// @notice 用户债务资产数量：user → count - 优化遍历
    /// @dev 记录每个用户借入的资产种类数量
    mapping(address => uint256) private _userDebtAssetCount;

    // 移除价格预言机调用超时常量：统一由预言机/监控层处理

    /// @notice 最大批量操作数量限制（统一引用 ViewConstants）
    /// @dev 与 View 层保持一致，避免常量分叉
    uint256 internal constant MAX_BATCH_SIZE = ViewConstants.MAX_BATCH_SIZE;

    /// @notice 各资产年利率映射：asset → annualInterestRate (以 1e18 为基数)
    /// @dev 记录每种资产的年利率，用于计算利息
    mapping(address => uint256) private _interestRatePerYear;

    // 移除未使用的费用接收者治理项

    /// @notice Storage gap for upgrade safety
    /// @dev 存储间隙，为未来升级预留空间
    uint256[45] private _gap__;

    /* ============ Modifiers ============ */
    /// @notice 验证Registry地址有效性
    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        _;
    }

    /// @notice 仅限 VaultCore 调用
    /// @dev msg.sender 必须等于 Registry(KEY_VAULT_CORE)
    modifier onlyVaultCore() {
        if (msg.sender != _getModuleAddress(ModuleKeys.KEY_VAULT_CORE)) {
            revert VaultLendingEngine__OnlyVaultCore();
        }
        _;
    }

    /// @notice 允许 VaultCore 或 SettlementManager 调用（统一结算入口）
    modifier onlyVaultCoreOrSettlementManager() {
        address vaultCore = _getModuleAddress(ModuleKeys.KEY_VAULT_CORE);
        // best-effort：未注册 SettlementManager 时不应阻断 VaultCore 正常调用
        address settlementManager = LendingEngineCore._getModuleAddressOrZero(_s(), ModuleKeys.KEY_SETTLEMENT_MANAGER);
        if (msg.sender != vaultCore && msg.sender != settlementManager) {
            revert VaultLendingEngine__OnlyVaultCore();
        }
        _;
    }

    /* ============ Custom Errors ============ */
    error VaultLendingEngine__OnlyVaultCore();
    error VaultLendingEngine__LengthMismatch();
    error VaultLendingEngine__EmptyArray();
    error VaultLendingEngine__BatchTooLarge();
    error VaultLendingEngine__InvalidImplementation();

    /* ============ Internal Functions ============ */
    
    /// @notice 获取模块地址（带缓存）
    /// @param moduleKey 模块键
    /// @return 模块地址
    function _getModuleAddress(bytes32 moduleKey) internal view returns (address) {
        return LendingEngineCore._getModuleAddress(_s(), moduleKey);
    }

    /// @notice 权限校验内部函数
    /// @param actionKey 动作键
    /// @param user 用户地址
    function _requireRole(bytes32 actionKey, address user) internal view {
        LendingEngineCore._requireRole(_s(), actionKey, user);
    }

    /* ============ 基础升级管理功能 ============ */
    
    /// @notice Getter: Registry地址（向后兼容）
    function registryAddr() external view returns (address) {
        return _registryAddr;
    }

    /// @notice Getter: 价格预言机地址
    function priceOracleAddr() external view returns (address) {
        return _priceOracleAddr;
    }

    /// @notice Getter: 结算币地址
    function settlementTokenAddr() external view returns (address) {
        return _settlementTokenAddr;
    }

    // 费用接收者 getter 移除

    /* ============ Events ============ */
    /// @notice 债务记录事件
    /// @param user 用户地址
    /// @param asset 债务资产地址
    /// @param amount 债务金额
    /// @param isBorrow 是否为借款操作
    event DebtRecorded(address indexed user, address indexed asset, uint256 amount, bool isBorrow);

    /// @notice 用户总债务价值更新事件
    /// @param user 用户地址
    /// @param oldValue 旧总价值
    /// @param newValue 新总价值
    event UserTotalDebtValueUpdated(address indexed user, uint256 oldValue, uint256 newValue);

    /// @notice 价格预言机更新事件
    /// @param oldOracle 旧预言机地址
    /// @param newOracle 新预言机地址
    event PriceOracleUpdated(address indexed oldOracle, address indexed newOracle);

    /// @notice 结算币更新事件
    /// @param oldToken 旧结算币地址
    /// @param newToken 新结算币地址
    event SettlementTokenUpdated(address indexed oldToken, address indexed newToken);

    /// @notice Registry更新事件
    /// @param oldRegistry 旧Registry地址
    /// @param newRegistry 新Registry地址
    event RegistryUpdated(address indexed oldRegistry, address indexed newRegistry);

    /// @notice 批量操作事件
    /// @param user 用户地址
    /// @param operations 操作数量
    event BatchDebtOperationsCompleted(address indexed user, uint256 operations);

    /// @notice 利率更新事件
    /// @param asset 资产地址
    /// @param oldRate 旧利率
    /// @param newRate 新利率
    event InterestRateUpdated(address indexed asset, uint256 oldRate, uint256 newRate);

    // 费用接收者相关事件移除
    
    /// @notice 优雅降级事件 - 价格获取失败时使用备用策略
    /// @param asset 资产地址
    /// @param reason 降级原因
    /// @param fallbackPrice 备用价格
    /// @param usedFallback 是否使用了降级策略
    event VaultLendingEngineGracefulDegradation(address indexed asset, string reason, uint256 fallbackPrice, bool usedFallback);
    
    /// @notice 价格预言机健康状态事件
    /// @param asset 资产地址
    /// @param isHealthy 是否健康
    /// @param details 详细信息
    event VaultLendingEnginePriceOracleHealthCheck(address indexed asset, bool isHealthy, string details);

    // UpgradeManagementEvent 移除以减小字节码，升级事件可由外层治理记录

    /* ============ Initializer ============ */
    /// @notice 初始化 VaultLendingEngine 模块
    /// @dev 设置价格预言机、结算币和Registry地址
    /// @param initialPriceOracle 价格预言机地址，用于获取资产价格
    /// @param initialSettlementToken 结算币地址，用于价值计算
    /// @param initialRegistry Registry合约地址，用于模块管理
    /// @custom:security 确保priceOracle_、settlementToken_和registry_不为零地址
    function initialize(
        address initialPriceOracle, 
        address initialSettlementToken,
        address initialRegistry
    ) external initializer {
        __UUPSUpgradeable_init();
        __ReentrancyGuardSlim_init();
        // 不再在模块层启用 Pausable
        
        if (initialPriceOracle == address(0)) revert ZeroAddress();
        if (initialSettlementToken == address(0)) revert ZeroAddress();
        if (initialRegistry == address(0)) revert ZeroAddress();
        
        _priceOracleAddr = initialPriceOracle;
        _settlementTokenAddr = initialSettlementToken;
        _registryAddr = initialRegistry;
        
        // 同时初始化 library storage layout 中的地址
        LendingEngineStorage.Layout storage s = _s();
        s._priceOracleAddr = initialPriceOracle;
        s._settlementTokenAddr = initialSettlementToken;
        s._registryAddr = initialRegistry;
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
    }

    /* ============ View Functions ============ */
    /// @notice 查询指定用户指定资产的债务
    /// @param user 用户地址
    /// @param asset 债务资产地址
    /// @return debt 当前债务金额
    /// @dev 如果用户或资产地址为零，会revert ZeroAddress
    function getDebt(address user, address asset) external view onlyValidRegistry returns (uint256 debt) {
        if (user == address(0)) revert ZeroAddress();
        if (asset == address(0)) revert ZeroAddress();
        return _s()._userDebt[user][asset];
    }

    /// @notice 查询指定资产的总债务
    /// @param asset 债务资产地址
    /// @return totalDebt 总债务金额
    /// @dev 如果资产地址为零，会revert ZeroAddress
    function getTotalDebtByAsset(address asset) external view onlyValidRegistry returns (uint256 totalDebt) {
        if (asset == address(0)) revert ZeroAddress();
        return _s()._totalDebtByAsset[asset];
    }

    /// @notice 查询用户总债务价值（以结算币计价）
    /// @param user 用户地址
    /// @return totalValue 用户总债务价值
    /// @dev 如果用户地址为零，会revert ZeroAddress
    function getUserTotalDebtValue(address user) external view onlyValidRegistry returns (uint256 totalValue) {
        if (user == address(0)) revert ZeroAddress();
        return _s()._userTotalDebtValue[user];
    }

    /// @notice 查询系统总债务价值（以结算币计价）
    /// @return totalValue 系统总债务价值
    /// @dev 返回整个系统的总债务价值
    function getTotalDebtValue() external view onlyValidRegistry returns (uint256 totalValue) {
        return _s()._totalDebtValue;
    }

    /// @notice 查询用户所有债务资产列表
    /// @param user 用户地址
    /// @return assets 用户债务的资产地址数组
    /// @dev 如果用户地址为零，会revert ZeroAddress
    /// @dev 返回用户当前借入的所有资产地址
    function getUserDebtAssets(address user) external view onlyValidRegistry returns (address[] memory assets) {
        if (user == address(0)) revert ZeroAddress();
        LendingEngineStorage.Layout storage s = _s();
        uint256 count = s._userDebtAssetCount[user];
        assets = new address[](count);
        
        for (uint256 i = 0; i < count; i++) {
            assets[i] = s._userDebtAssets[user][i];
        }
    }

    /// @notice 计算用户借款一定数量资产时应该产生的利息
    /// @param user 用户地址
    /// @param asset 债务资产地址
    /// @param amount 借款金额
    /// @return interest 预估利息金额
    function calculateExpectedInterest(address user, address asset, uint256 amount) external view onlyValidRegistry returns (uint256 interest) {
        user; // silence unused parameter
        if (asset == address(0)) revert ZeroAddress();
        if (amount == 0) return 0;
        
        uint256 rate = _interestRatePerYear[asset];
        if (rate == 0) return 0;
        
        // 计算利息：amount * rate / 1e18
        interest = (amount * rate) / 1e18;
    }

    /// @notice 估算资产的年化利率（bps，1e4=100%）
    /// @dev 将内部 1e18 精度的年化利率转换为 bps 输出
    function estimateAnnualRateBps(address asset) external view onlyValidRegistry returns (uint256 annualRateBps) {
        if (asset == address(0)) revert ZeroAddress();
        uint256 rate1e18 = _interestRatePerYear[asset];
        if (rate1e18 == 0) return 0;
        // annualRateBps = rate1e18 * 1e4 / 1e18
        unchecked { annualRateBps = (rate1e18 * 10000) / 1e18; }
    }

    /// @notice 按天计算预计利息（termDays=0 时按全年计算）
    /// @param asset 债务资产地址
    /// @param principal 借款本金
    /// @param termDays 期限天数（0 表示按全年利息）
    function estimateInterest(address asset, uint256 principal, uint16 termDays) external view onlyValidRegistry returns (uint256 interest) {
        if (asset == address(0)) revert ZeroAddress();
        if (principal == 0) return 0;
        uint256 rate = _interestRatePerYear[asset];
        if (rate == 0) return 0;
        unchecked {
            if (termDays == 0) {
                // 全年利息
                return (principal * rate) / 1e18;
            }
            // principal * rate(1e18) * termDays / (365 * 1e18)
            return (principal * rate * uint256(termDays)) / (365 * 1e18);
        }
    }

    /* ============ Internal Functions ============ */
    
    /// @notice 检查价格预言机健康状态
    /// @param oracle 预言机地址
    /// @param asset 资产地址
    /// @return isHealthy 是否健康
    /// @return details 详细信息
    function _checkPriceOracleHealth(address oracle, address asset) internal view returns (bool isHealthy, string memory details) {
        return LendingEngineValuation.checkPriceOracleHealth(oracle, asset);
    }
    
    /* ============ Business Logic ============ */
    /// @notice 记录一次借款操作
    /// @dev 仅由 CollateralVault 主合约调用
    /// @param user 借款人地址
    /// @param asset 债务资产地址
    /// @param amount 借款金额
    /// @param collateralAdded 本次伴随的新增抵押物价值（占位参数）
    /// @param termDays 借款期限（天，预留参数）
    function borrow(
        address user, 
        address asset, 
        uint256 amount, 
        uint256 collateralAdded, 
        uint16 termDays
    ) external override onlyValidRegistry onlyVaultCore {
        _reentrancyGuardEnter();
        collateralAdded; // silence unused parameter
        _s().borrow(user, asset, amount, termDays);
        _reentrancyGuardExit();
    }

    /// @notice 记录一次还款操作
    /// @dev 仅由 CollateralVault 主合约调用
    /// @param user 用户地址
    /// @param asset 债务资产地址
    /// @param amount 还款金额
    function repay(address user, address asset, uint256 amount) external override onlyValidRegistry onlyVaultCoreOrSettlementManager {
        _reentrancyGuardEnter();
        _s().repay(user, asset, amount);
        _reentrancyGuardExit();
    }

    /// @notice 强制减少用户指定资产的债务（清算场景）
    /// @dev 仅由清算模块调用，用于清算时的债务减少
    /// @param user 用户地址
    /// @param asset 债务资产地址
    /// @param amount 减少的债务金额
    function forceReduceDebt(address user, address asset, uint256 amount) external override onlyValidRegistry {
        _reentrancyGuardEnter();
        _s().forceReduceDebt(user, asset, amount);
        _reentrancyGuardExit();
    }

    /// @notice 更新用户总债务价值（内部函数）- 优化版本
    /// @dev 使用价格预言机计算用户所有债务资产的总价值
    /// @param user 用户地址
    function _updateUserTotalDebtValue(address user) internal {
        _s().updateUserTotalDebtValue(user);
    }

    /* ============ Admin Functions ============ */
    /// @notice 批量更新用户债务价值（治理功能）
    /// @dev 仅治理可调用，用于批量更新用户债务价值
    /// @param users 用户地址数组
    function batchUpdateUserDebtValues(address[] calldata users) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        if (users.length == 0) revert VaultLendingEngine__EmptyArray();
        if (users.length > MAX_BATCH_SIZE) revert VaultLendingEngine__BatchTooLarge();
        
        // Gas优化：使用unchecked减少Gas消耗
        unchecked {
            for (uint256 i = 0; i < users.length; i++) {
                if (users[i] == address(0)) revert ZeroAddress();
                _updateUserTotalDebtValue(users[i]);
            }
        }
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
    }

    /// @notice 更新价格预言机地址（治理功能）
    /// @dev 仅治理可调用
    /// @param newPriceOracle 新的价格预言机地址
    function setPriceOracle(address newPriceOracle) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
        if (newPriceOracle == address(0)) revert ZeroAddress();
        
        address oldOracle = _priceOracleAddr;
        _priceOracleAddr = newPriceOracle;
        
        emit PriceOracleUpdated(oldOracle, newPriceOracle);
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
    }

    /// @notice 更新结算币地址（治理功能）
    /// @dev 仅治理可调用
    /// @param newSettlementToken 新的结算币地址
    function setSettlementToken(address newSettlementToken) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        if (newSettlementToken == address(0)) revert ZeroAddress();
        
        address oldToken = _settlementTokenAddr;
        _settlementTokenAddr = newSettlementToken;
        
        emit SettlementTokenUpdated(oldToken, newSettlementToken);
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
    }

    /// @notice 更新Registry地址（治理功能）
    /// @dev 仅治理可调用
    /// @param newRegistry 新的Registry地址
    // Registry 直改入口移除：改由 VaultCore/Registry 管理

    /// @notice 设置资产年利率（治理功能）
    /// @dev 仅治理可调用，利率以 1e18 为基数
    /// @param asset 资产地址
    /// @param annualRate 年利率（以 1e18 为基数）
    function setInterestRate(address asset, uint256 annualRate) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        if (asset == address(0)) revert ZeroAddress();
        
        uint256 oldRate = _interestRatePerYear[asset];
        _interestRatePerYear[asset] = annualRate;
        
        emit InterestRateUpdated(asset, oldRate, annualRate);
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
    }

    /// @notice Getter: 读取资产年利率（向后兼容）
    function interestRatePerYear(address asset) external view returns (uint256) {
        return _interestRatePerYear[asset];
    }

    /// @notice 设置费用接收者地址（治理功能）
    /// @dev 仅治理可调用
    /// @param newFeeReceiver 新的费用接收者地址
    // 未使用的 feeReceiver 治理移除

    /// @notice 紧急暂停功能
    /// @dev 仅治理可调用
    // 移除本地暂停/恢复，由系统层统一控制

    /* ============ Upgrade Auth ============ */
    /// @notice 升级授权函数
    /// @dev 使用RegistryUpgradeLibrary进行权限验证
    /// @dev 如需接入 Timelock/Multisig 治理，应在此处增加相应的权限检查逻辑
    function _authorizeUpgrade(address newImplementation) internal override {
        _requireRole(ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
        if (newImplementation == address(0)) revert ZeroAddress();
        
        // 验证新实现合约
        if (newImplementation.code.length == 0) revert VaultLendingEngine__InvalidImplementation();
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_UPGRADE_MODULE,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_UPGRADE_MODULE),
            msg.sender,
            block.timestamp
        );
    }

    /* ============ ILendingEngineBasic: Minimal Ledger Implementations ============ */
    /// @notice 获取可清算的债务数量（账本域最小实现：返回当前债务余额）
    function getReducibleDebtAmount(address user, address asset) external view onlyValidRegistry returns (uint256 reducibleAmount) {
        if (user == address(0)) revert ZeroAddress();
        if (asset == address(0)) revert ZeroAddress();
        return _s()._userDebt[user][asset];
    }

    /// @notice 兼容接口：视图/聚合能力已下沉至 View/风险模块，这里返回默认值
    // 视图/聚合能力已下沉至 View/风险模块，上述接口不再在账本层实现

    /// @notice 计算单资产债务价值（以结算币计价）
    function calculateDebtValue(address user, address asset) external view onlyValidRegistry returns (uint256 value) {
        if (user == address(0)) revert ZeroAddress();
        if (asset == address(0)) revert ZeroAddress();
        return LendingEngineValuation.calculateDebtValue(_s(), user, asset);
    }

    /// @notice 通知RewardManager处理积分奖励
    /// @param user 用户地址
    /// @param amount 操作金额
    /// @param isRepayment 是否为还款操作
    // 奖励触发函数移除

    /// @notice 推送用户仓位到 View 缓存
    /// @param user 用户地址
    /// @param asset 资产地址
    function _pushUserPositionToView(address user, address asset) internal {
        LendingEngineCore._pushUserPositionToView(_s(), user, asset);
    }

    /// @notice 解析当前有效的 VaultRouter 地址（通过 Registry -> VaultCore）
    function _resolveVaultRouterAddr() internal view returns (address) {
        address vaultCore = _getModuleAddress(ModuleKeys.KEY_VAULT_CORE);
        return IVaultCoreMinimal(vaultCore).viewContractAddrVar();
    }

    /// @notice 汇总用户总抵押与总债务，并推送健康状态到 HealthView
    function _pushHealthStatus(address user) internal {
        LendingEngineCore._pushHealthStatus(_s(), user);
    }

    /* ============ Storage Gap ============ */
    uint256[50] private __gap;
} 