// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
// import "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol"; // 模块不再直接继承暂停/恢复

import { ActionKeys } from "../../constants/ActionKeys.sol";
import { ModuleKeys } from "../../constants/ModuleKeys.sol";
import { AmountIsZero, Overpay, ZeroAddress } from "../../errors/StandardErrors.sol";
import { IPriceOracle } from "../../interfaces/IPriceOracle.sol";
import { ILendingEngineBasic } from "../../interfaces/ILendingEngineBasic.sol";
import { IAccessControlManager } from "../../interfaces/IAccessControlManager.sol";
// 奖励触发移除：避免在账本层产生双计
import { ICollateralManager } from "../../interfaces/ICollateralManager.sol";
import { IVaultView } from "../../interfaces/IVaultView.sol";
import { ViewConstants } from "../view/ViewConstants.sol";
import { Registry } from "../../registry/Registry.sol";
import { HealthFactorLib } from "../../libraries/HealthFactorLib.sol";
import { ILiquidationRiskManager } from "../../interfaces/ILiquidationRiskManager.sol";
// DataPush 由 core/LendingEngine 统一发 LOAN_*，本模块不再直接引用 DataPush 库
import { VaultTypes } from "../VaultTypes.sol";
import { GracefulDegradation } from "../../libraries/GracefulDegradation.sol";

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
    ReentrancyGuardUpgradeable,
    ILendingEngineBasic
{
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

    /* ============ Custom Errors ============ */
    error VaultLendingEngine__OnlyVaultCore();
    error VaultLendingEngine__LengthMismatch();
    error VaultLendingEngine__EmptyArray();
    error VaultLendingEngine__BatchTooLarge();
    error VaultLendingEngine__InvalidImplementation();
    /// @notice 仅用于指示应由 View 层提供只读/聚合能力
    error VaultLendingEngine__UseViewLayer();

    /* ============ Internal Functions ============ */
    
    /// @notice 获取模块地址（带缓存）
    /// @param moduleKey 模块键
    /// @return 模块地址
    function _getModuleAddress(bytes32 moduleKey) internal view returns (address) {
        return Registry(_registryAddr).getModuleOrRevert(moduleKey);
    }
   
    /// @notice 权限校验内部函数
    /// @param actionKey 动作键
    /// @param user 用户地址
    function _requireRole(bytes32 actionKey, address user) internal view {
        address acmAddr = _getModuleAddress(ModuleKeys.KEY_ACCESS_CONTROL);
        IAccessControlManager(acmAddr).requireRole(actionKey, user);
    }

    /* ============ 基础升级管理功能 ============ */
    
    /// @notice 验证升级权限
    /// @param caller 调用者地址
    function _requireUpgradePermission(address caller) internal view {
        // 注意：这里需要根据RegistryUpgradeManager的实际接口调整
        // 暂时使用简单的权限检查
        _requireRole(ActionKeys.ACTION_UPGRADE_MODULE, caller);
    }

    /// @notice 验证动态模块权限
    /// @param caller 调用者地址
    function _requireDynamicModulePermission(address caller) internal view {
        // 注意：这里需要根据IRegistryDynamicModuleKey的实际接口调整
        // 暂时使用简单的权限检查
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, caller);
    }

    /// @notice 获取Registry地址
    /// @return Registry合约地址
    function getRegistry() external view returns (address) {
        return _registryAddr;
    }

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

    /// @notice 升级管理事件
    /// @param operationType 操作类型
    /// @param moduleKey 模块键
    /// @param oldAddress 旧地址
    /// @param newAddress 新地址
    /// @param caller 调用者地址
    /// @param timestamp 时间戳
    event UpgradeManagementEvent(
        string indexed operationType,
        bytes32 indexed moduleKey,
        address indexed oldAddress,
        address newAddress,
        address caller,
        uint256 timestamp
    );

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
        __ReentrancyGuard_init();
        // 不再在模块层启用 Pausable
        
        if (initialPriceOracle == address(0)) revert ZeroAddress();
        if (initialSettlementToken == address(0)) revert ZeroAddress();
        if (initialRegistry == address(0)) revert ZeroAddress();
        
        _priceOracleAddr = initialPriceOracle;
        _settlementTokenAddr = initialSettlementToken;
        _registryAddr = initialRegistry;
        
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
        return _userDebt[user][asset];
    }

    /// @notice 查询指定资产的总债务
    /// @param asset 债务资产地址
    /// @return totalDebt 总债务金额
    /// @dev 如果资产地址为零，会revert ZeroAddress
    function getTotalDebtByAsset(address asset) external view onlyValidRegistry returns (uint256 totalDebt) {
        if (asset == address(0)) revert ZeroAddress();
        return _totalDebtByAsset[asset];
    }

    /// @notice 查询用户总债务价值（以结算币计价）
    /// @param user 用户地址
    /// @return totalValue 用户总债务价值
    /// @dev 如果用户地址为零，会revert ZeroAddress
    function getUserTotalDebtValue(address user) external view onlyValidRegistry returns (uint256 totalValue) {
        if (user == address(0)) revert ZeroAddress();
        return _userTotalDebtValue[user];
    }

    /// @notice 查询系统总债务价值（以结算币计价）
    /// @return totalValue 系统总债务价值
    /// @dev 返回整个系统的总债务价值
    function getTotalDebtValue() external view onlyValidRegistry returns (uint256 totalValue) {
        return _totalDebtValue;
    }

    /// @notice 查询用户所有债务资产列表
    /// @param user 用户地址
    /// @return assets 用户债务的资产地址数组
    /// @dev 如果用户地址为零，会revert ZeroAddress
    /// @dev 返回用户当前借入的所有资产地址
    function getUserDebtAssets(address user) external view onlyValidRegistry returns (address[] memory assets) {
        if (user == address(0)) revert ZeroAddress();
        uint256 count = _userDebtAssetCount[user];
        assets = new address[](count);
        
        for (uint256 i = 0; i < count; i++) {
            assets[i] = _userDebtAssets[user][i];
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
        if (oracle == address(0)) {
            return (false, "No oracle configured");
        }
        
        return GracefulDegradation.checkPriceOracleHealth(oracle, asset);
    }
    
    /* ============ Business Logic ============ */
    /// @dev 内部借款记录函数
    /// @param user 用户地址
    /// @param asset 债务资产地址
    /// @param amount 借款金额
    function recordBorrow(address user, address asset, uint256 amount) internal {
        if (amount == 0) revert AmountIsZero();
        if (asset == address(0)) revert ZeroAddress();
        if (user == address(0)) revert ZeroAddress();
        
        uint256 oldDebt = _userDebt[user][asset];
        _userDebt[user][asset] = oldDebt + amount;
        _totalDebtByAsset[asset] += amount;
        
        // 如果是新债务资产，添加到用户债务资产列表
        if (oldDebt == 0) {
            _addUserDebtAsset(user, asset);
        }
        
        // 更新用户总债务价值
        _updateUserTotalDebtValue(user);
        
        emit DebtRecorded(user, asset, amount, true);
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_BORROW,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_BORROW),
            msg.sender,
            block.timestamp
        );
    }

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
    ) external override onlyValidRegistry nonReentrant onlyVaultCore {
        collateralAdded; termDays; // silence unused parameters
        
        recordBorrow(user, asset, amount);
        
        // 推送最新仓位到 View 缓存（抵押由 CollateralManager 维护，债务由本模块维护）
        _pushUserPositionToView(user, asset);
        _pushHealthStatus(user);

        // 注意：LOAN_* 事件由 core/LendingEngine 统一发出；Vault 侧不重复推送
    }

    /// @notice 记录一次还款操作
    /// @dev 仅由 CollateralVault 主合约调用
    /// @param user 用户地址
    /// @param asset 债务资产地址
    /// @param amount 还款金额
    function repay(address user, address asset, uint256 amount) external override onlyValidRegistry nonReentrant onlyVaultCore {
        if (amount == 0) revert AmountIsZero();
        if (asset == address(0)) revert ZeroAddress();
        if (user == address(0)) revert ZeroAddress();
        
        uint256 debt = _userDebt[user][asset];
        if (debt < amount) revert Overpay();
        
        _userDebt[user][asset] = debt - amount;
        _totalDebtByAsset[asset] -= amount;
        
        // 如果债务为0，从用户债务资产列表中移除
        if (_userDebt[user][asset] == 0) {
            _removeUserDebtAsset(user, asset);
        }
        
        // 更新用户总债务价值
        _updateUserTotalDebtValue(user);
        
        emit DebtRecorded(user, asset, amount, false);
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_REPAY,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_REPAY),
            msg.sender,
            block.timestamp
        );

        // 推送最新仓位到 View 缓存（抵押由 CollateralManager 维护，债务由本模块维护）
        _pushUserPositionToView(user, asset);
        _pushHealthStatus(user);

        // 注意：LOAN_* 事件由 core/LendingEngine 统一发出；Vault 侧不重复推送
    }

    /// @notice 强制减少用户指定资产的债务（清算场景）
    /// @dev 仅由清算模块调用，用于清算时的债务减少
    /// @param user 用户地址
    /// @param asset 债务资产地址
    /// @param amount 减少的债务金额
    function forceReduceDebt(address user, address asset, uint256 amount) external override onlyValidRegistry nonReentrant {
        // 权限检查：仅清算模块可调用
        _requireRole(ActionKeys.ACTION_LIQUIDATE, msg.sender);
        
        if (asset == address(0)) revert ZeroAddress();
        if (user == address(0)) revert ZeroAddress();
        if (amount == 0) revert AmountIsZero();
        
        uint256 debt = _userDebt[user][asset];
        if (amount > debt) amount = debt;
        
        _userDebt[user][asset] = debt - amount;
        _totalDebtByAsset[asset] -= amount;
        
        // 如果债务为0，从用户债务资产列表中移除
        if (_userDebt[user][asset] == 0) {
            _removeUserDebtAsset(user, asset);
        }
        
        // 更新用户总债务价值
        _updateUserTotalDebtValue(user);
        
        emit DebtRecorded(user, asset, amount, false);
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_LIQUIDATE,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_LIQUIDATE),
            msg.sender,
            block.timestamp
        );

        // 推送最新仓位到 View 缓存
        _pushUserPositionToView(user, asset);
        _pushHealthStatus(user);

    }

    /// @notice 批量借款操作 - Gas优化
    /// @param user 用户地址
    /// @param assets 资产地址数组
    /// @param amounts 数量数组
    // 对外批量借款入口移除：统一由业务层批量编排，LE 仅保留内部工具
    
    /// @notice 使用Assembly优化的批量借款处理
    /// @param user 用户地址
    /// @param assets 资产地址数组
    /// @param amounts 金额数组
    /// @param length 数组长度
    function _batchBorrowAssembly(
        address user,
        address[] calldata assets,
        uint256[] calldata amounts,
        uint256 length
    ) internal {
        // 使用Assembly优化循环处理
        assembly {
            // 获取calldata中数组的偏移量
            let assetsOffset := add(assets.offset, 0x20) // 跳过长度字段
            let amountsOffset := add(amounts.offset, 0x20) // 跳过长度字段
            
            // 循环处理每个元素
            for { let i := 0 } lt(i, length) { i := add(i, 1) } {
                // 从calldata加载资产地址和金额
                let asset := calldataload(assetsOffset)
                let amount := calldataload(amountsOffset)
                
                // 跳过零金额
                if iszero(amount) {
                    // 移动到下一个元素
                    assetsOffset := add(assetsOffset, 0x20)
                    amountsOffset := add(amountsOffset, 0x20)
                    continue
                }
                
                // 检查资产地址是否为零
                if iszero(asset) {
                    // 回滚交易
                    revert(0, 0)
                }
                
                // 移动到下一个元素
                assetsOffset := add(assetsOffset, 0x20)
                amountsOffset := add(amountsOffset, 0x20)
            }
        }
        
        // 使用优化的Solidity循环处理具体逻辑
        unchecked {
            for (uint256 i = 0; i < length; i++) {
                address asset = assets[i];
                uint256 amount = amounts[i];
                
                if (amount == 0) continue;
                if (asset == address(0)) revert ZeroAddress();
                
                uint256 oldDebt = _userDebt[user][asset];
                _userDebt[user][asset] = oldDebt + amount;
                _totalDebtByAsset[asset] += amount;
                
                // 如果是新债务资产，添加到用户债务资产列表
                if (oldDebt == 0) {
                    _addUserDebtAsset(user, asset);
                }
                
                emit DebtRecorded(user, asset, amount, true);
            }
        }
    }
    
    /// @notice 完全使用Assembly优化的批量借款处理（高级版本）
    /// @param user 用户地址
    /// @param assets 资产地址数组
    /// @param amounts 金额数组
    /// @param length 数组长度
    function _batchBorrowFullAssembly(
        address user,
        address[] calldata assets,
        uint256[] calldata amounts,
        uint256 length
    ) internal {
        // 完全使用Assembly处理，包括映射操作
        assembly {
            // 获取calldata中数组的偏移量
            let assetsOffset := add(assets.offset, 0x20)
            let amountsOffset := add(amounts.offset, 0x20)
            
            // 循环处理每个元素
            for { let i := 0 } lt(i, length) { i := add(i, 1) } {
                // 从calldata加载数据
                let asset := calldataload(assetsOffset)
                let amount := calldataload(amountsOffset)
                
                // 跳过零金额
                if iszero(amount) {
                    assetsOffset := add(assetsOffset, 0x20)
                    amountsOffset := add(amountsOffset, 0x20)
                    continue
                }
                
                // 检查资产地址
                if iszero(asset) {
                    revert(0, 0)
                }
                
                // 移动到下一个元素
                assetsOffset := add(assetsOffset, 0x20)
                amountsOffset := add(amountsOffset, 0x20)
            }
        }
        
        // 使用优化的Solidity循环处理具体逻辑
        unchecked {
            for (uint256 i = 0; i < length; i++) {
                address asset = assets[i];
                uint256 amount = amounts[i];
                
                if (amount == 0) continue;
                if (asset == address(0)) revert ZeroAddress();
                
                uint256 oldDebt = _userDebt[user][asset];
                _userDebt[user][asset] = oldDebt + amount;
                _totalDebtByAsset[asset] += amount;
                
                // 如果是新债务资产，添加到用户债务资产列表
                if (oldDebt == 0) {
                    _addUserDebtAsset(user, asset);
                }
                
                emit DebtRecorded(user, asset, amount, true);
            }
        }
    }
    
    /// @notice 使用Assembly优化的批量更新用户债务价值
    /// @param user 用户地址
    function _updateUserTotalDebtValueAssembly(address user) internal {
        uint256 totalValue = 0;
        uint256 count = _userDebtAssetCount[user];
        
        // 使用Assembly优化循环
        assembly {
            // 循环处理每个资产
            for { let i := 0 } lt(i, count) { i := add(i, 1) } {
                // 这里需要复杂的存储操作，暂时用Solidity处理
            }
        }
        
        // 使用优化的Solidity循环处理具体逻辑
        unchecked {
            for (uint256 i = 0; i < count; i++) {
                address asset = _userDebtAssets[user][i];
                uint256 amount = _userDebt[user][asset];
                if (amount == 0) continue;
                
                // 使用标准优雅降级库
                GracefulDegradation.DegradationConfig memory config = GracefulDegradation.createDefaultConfig(_settlementTokenAddr);
                GracefulDegradation.PriceResult memory result = GracefulDegradation.getAssetValueWithFallback(_priceOracleAddr, asset, amount, config);
                
                if (result.usedFallback) {
                    emit VaultLendingEngineGracefulDegradation(asset, result.reason, result.value, true);
                } else {
                    emit VaultLendingEnginePriceOracleHealthCheck(asset, true, "Price calculation successful");
                }
                
                totalValue += result.value;
            }
        }
        
        uint256 oldValue = _userTotalDebtValue[user];
        _userTotalDebtValue[user] = totalValue;
        
        if (oldValue != totalValue) {
            emit UserTotalDebtValueUpdated(user, oldValue, totalValue);
        }
    }

    /* ============ Internal Functions ============ */
    /// @notice 添加用户债务资产到列表
    /// @param user 用户地址
    /// @param asset 资产地址
    function _addUserDebtAsset(address user, address asset) internal {
        uint256 index = _userDebtAssetIndex[user][asset];
        if (index == 0) {
            // 新资产，添加到列表末尾
            _userDebtAssets[user].push(asset);
            _userDebtAssetIndex[user][asset] = _userDebtAssets[user].length;
            _userDebtAssetCount[user]++;
        }
    }

    /// @notice 从用户债务资产列表中移除资产
    /// @param user 用户地址
    /// @param asset 资产地址
    function _removeUserDebtAsset(address user, address asset) internal {
        uint256 index = _userDebtAssetIndex[user][asset];
        if (index > 0) {
            uint256 lastIndex = _userDebtAssets[user].length - 1;
            address lastAsset = _userDebtAssets[user][lastIndex];
            
            // 将最后一个资产移到要删除的位置
            _userDebtAssets[user][index - 1] = lastAsset;
            _userDebtAssetIndex[user][lastAsset] = index;
            
            // 删除最后一个元素
            _userDebtAssets[user].pop();
            delete _userDebtAssetIndex[user][asset];
            _userDebtAssetCount[user]--;
        }
    }

    /// @notice 更新用户总债务价值（内部函数）- 优化版本
    /// @dev 使用价格预言机计算用户所有债务资产的总价值
    /// @param user 用户地址
    function _updateUserTotalDebtValue(address user) internal {
        uint256 totalValue = 0;
        uint256 count = _userDebtAssetCount[user];
        
        // Gas优化：使用unchecked减少Gas消耗
        unchecked {
            for (uint256 i = 0; i < count; i++) {
                address asset = _userDebtAssets[user][i];
                uint256 amount = _userDebt[user][asset];
                if (amount == 0) continue;
                
                // 使用标准优雅降级库
                GracefulDegradation.DegradationConfig memory config = GracefulDegradation.createDefaultConfig(_settlementTokenAddr);
                GracefulDegradation.PriceResult memory result = GracefulDegradation.getAssetValueWithFallback(_priceOracleAddr, asset, amount, config);
                
                if (result.usedFallback) {
                    emit VaultLendingEngineGracefulDegradation(asset, result.reason, result.value, true);
                } else {
                    emit VaultLendingEnginePriceOracleHealthCheck(asset, true, "Price calculation successful");
                }
                
                totalValue += result.value;
            }
        }
        
        uint256 oldValue = _userTotalDebtValue[user];
        _userTotalDebtValue[user] = totalValue;
        
        // 更新系统总债务价值
        _totalDebtValue = _totalDebtValue - oldValue + totalValue;
        
        emit UserTotalDebtValueUpdated(user, oldValue, totalValue);
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
        _requireUpgradePermission(msg.sender);
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
        
        // 记录升级事件
        emit UpgradeManagementEvent("contract_upgrade", bytes32(0), address(0), newImplementation, msg.sender, block.timestamp);
    }

    /* ============ ILendingEngineBasic: Minimal Ledger Implementations ============ */
    /// @notice 获取可清算的债务数量（账本域最小实现：返回当前债务余额）
    function getReducibleDebtAmount(address user, address asset) external view onlyValidRegistry returns (uint256 reducibleAmount) {
        if (user == address(0)) revert ZeroAddress();
        if (asset == address(0)) revert ZeroAddress();
        return _userDebt[user][asset];
    }

    /// @notice 计算单资产债务价值（以结算币计价）
    function calculateDebtValue(address user, address asset) external view onlyValidRegistry returns (uint256 value) {
        if (user == address(0)) revert ZeroAddress();
        if (asset == address(0)) revert ZeroAddress();
        uint256 amount = _userDebt[user][asset];
        if (amount == 0) return 0;

        GracefulDegradation.DegradationConfig memory cfg = GracefulDegradation.createDefaultConfig(_settlementTokenAddr);
        GracefulDegradation.PriceResult memory pr = GracefulDegradation.getAssetValueWithFallback(_priceOracleAddr, asset, amount, cfg);
        return pr.value;
    }

    /// @notice 复杂视图/聚合/风控函数均下沉至 View 层，本模块统一拒绝并提示
    function calculateOptimalLiquidation(
        address,
        uint256,
        uint256
    ) external pure returns (uint256, uint256, uint256) {
        revert VaultLendingEngine__UseViewLayer();
    }

    function previewLiquidationState(
        address,
        uint256,
        uint256
    ) external pure returns (uint256, uint256, uint256) {
        revert VaultLendingEngine__UseViewLayer();
    }

    function getUserHealthFactor(address) external pure returns (uint256) {
        revert VaultLendingEngine__UseViewLayer();
    }

    function getUserRiskScore(address) external pure returns (uint256) {
        revert VaultLendingEngine__UseViewLayer();
    }

    function getHighRiskUsers(
        uint256,
        uint256
    ) external pure returns (address[] memory, uint256[] memory) {
        revert VaultLendingEngine__UseViewLayer();
    }

    function getLiquidatableUsers(
        uint256,
        uint256
    ) external pure returns (address[] memory, uint256[] memory) {
        revert VaultLendingEngine__UseViewLayer();
    }

    function calculateOptimalLiquidationPath(
        address,
        uint256
    ) external pure returns (address[] memory, uint256, uint256) {
        revert VaultLendingEngine__UseViewLayer();
    }

    function optimizeLiquidationStrategy(
        address,
        uint256
    ) external pure returns (bytes memory) {
        revert VaultLendingEngine__UseViewLayer();
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
        // 解析 CollateralManager 地址与 VaultView 地址
        address cm = _getModuleAddress(ModuleKeys.KEY_CM);
        address viewAddr = _resolveVaultViewAddr();

        // 读取当前抵押与债务绝对值快照
        uint256 collateral = ICollateralManager(cm).getCollateral(user, asset);
        uint256 debt = _userDebt[user][asset];

        // 推送到 View 层缓存
        IVaultView(viewAddr).pushUserPositionUpdate(user, asset, collateral, debt);
    }

    /// @notice 解析当前有效的 VaultView 地址（通过 Registry -> VaultCore）
    function _resolveVaultViewAddr() internal view returns (address) {
        address vaultCore = _getModuleAddress(ModuleKeys.KEY_VAULT_CORE);
        return IVaultCoreMinimal(vaultCore).viewContractAddrVar();
    }

    /// @notice 汇总用户总抵押与总债务，并推送健康状态到 HealthView
    function _pushHealthStatus(address user) internal {
        // 聚合总抵押与总债务（使用模块提供的总价值接口，避免遗漏“无债务但有抵押”的资产）
        address cm = _getModuleAddress(ModuleKeys.KEY_CM);
        address lrm = _getModuleAddress(ModuleKeys.KEY_LIQUIDATION_RISK_MANAGER);
        address hv = _getModuleAddress(ModuleKeys.KEY_HEALTH_VIEW);
        if (hv == address(0) || lrm == address(0) || cm == address(0)) {
            return; // 配置缺失则跳过
        }
        
        uint256 totalDebt = _userTotalDebtValue[user];
        uint256 totalCollateral = 0;
        // 使用 CollateralManager 的总价值接口（以结算币计价）
        try ICollateralManager(cm).getUserTotalCollateralValue(user) returns (uint256 v) {
            totalCollateral = v;
        } catch {}

        uint256 minHFBps = ILiquidationRiskManager(lrm).getMinHealthFactor();
        bool under = HealthFactorLib.isUnderCollateralized(totalCollateral, totalDebt, minHFBps);
        uint256 hfBps = HealthFactorLib.calcHealthFactor(totalCollateral, totalDebt);

        // 推送到 HealthView
        // interface: function pushRiskStatus(address user,uint256 hfBps,uint256 minHFBps,bool under,uint256 timestamp)
        (bool ok, ) = hv.call(abi.encodeWithSignature(
            "pushRiskStatus(address,uint256,uint256,bool,uint256)",
            user,
            hfBps,
            minHFBps,
            under,
            block.timestamp
        ));
        ok; // silence
    }
} 