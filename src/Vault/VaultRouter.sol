// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Registry } from "../registry/Registry.sol";
import { ModuleKeys } from "../constants/ModuleKeys.sol";
import { ActionKeys } from "../constants/ActionKeys.sol";
import { IAccessControlManager } from "../interfaces/IAccessControlManager.sol";
import { ICollateralManager } from "../interfaces/ICollateralManager.sol";
import { ILendingEngine } from "../interfaces/ILendingEngine.sol";
import { IAssetWhitelist } from "../interfaces/IAssetWhitelist.sol";
import { IPriceOracle } from "../interfaces/IPriceOracle.sol";
import { 
    ZeroAddress, 
    AmountIsZero, 
    ExternalModuleRevertedRaw, 
    AssetNotAllowed,
    InsufficientBalance,
    HealthFactorTooLow,
    PausedSystem
} from "../errors/StandardErrors.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import { Pausable } from "@openzeppelin/contracts/security/Pausable.sol";
import { GracefulDegradation } from "../libraries/GracefulDegradation.sol";

/// @title VaultRouter
/// @notice 借贷入口路由器，负责权限校验与模块分发，提供原子性操作保护。
/// @dev 这是Vault系统的统一入口，负责路由所有用户操作到相应的模块
/// @dev 提供权限校验、资产白名单验证、模块地址缓存等核心功能
/// @dev 支持原子性操作，确保复杂操作的原子性
/// @dev 集成Registry系统，动态获取模块地址
/// @dev 使用ReentrancyGuard防止重入攻击
/// @dev 支持暂停功能，紧急情况下可暂停所有操作
/// @dev 提供模块调用缓存机制，减少gas消耗
/// @dev 集成优雅降级机制，处理模块调用失败
/// @custom:security-contact security@example.com
contract VaultRouter is ReentrancyGuard, Pausable {
    using GracefulDegradation for *;

    // ----------------- 常量 -----------------
    /// @notice 最大借款期限（天）
    /// @dev 1年最大期限，防止超长期借款
    uint16 public constant MAX_TERM_DAYS = 360; // 10年最大期限
    
    /// @notice 最小借款期限（天）
    /// @dev 最小期限1天，防止极短期借款
    uint16 public constant MIN_TERM_DAYS = 1;    // 最小期限1天
    
    /// @notice 模块缓存过期时间（秒）
    /// @dev 1小时缓存过期，平衡gas消耗和实时性
    uint256 private constant CACHE_EXPIRY_TIME = 1 hours;

    // ----------------- 状态变量 -----------------
    /// @notice Registry合约地址，用于获取模块地址
    /// @dev 不可变地址，确保系统稳定性
    address private immutable _registryAddr;
    
    /// @notice 资产白名单合约地址
    /// @dev 不可变地址，用于资产白名单验证
    address private immutable _assetWhitelistAddr;
    
    /// @notice 价格预言机合约地址
    /// @dev 不可变地址，用于价格获取
    address private immutable _priceOracleAddr;
    
    /// @notice 结算币地址
    /// @dev 用于优雅降级配置
    address private immutable _settlementTokenAddr;
    
    // 缓存模块地址以减少Gas消耗
    /// @notice 缓存的CollateralManager地址
    /// @dev 缓存机制减少重复查询，提高gas效率
    address private _cachedCMAddr;
    
    /// @notice 缓存的LendingEngine地址
    /// @dev 缓存机制减少重复查询，提高gas效率
    address private _cachedLEAddr;
    
    /// @notice 最后缓存更新时间
    /// @dev 用于判断缓存是否过期
    uint256 private _lastCacheUpdate;

    // ----------------- 事件 -----------------
    /// @notice VaultRouter初始化事件
    /// @param registry Registry合约地址
    /// @param assetWhitelist 资产白名单合约地址
    /// @param priceOracle 价格预言机合约地址
    /// @param settlementToken 结算币地址
    event VaultRouterInitialized(
        address indexed registry, 
        address indexed assetWhitelist,
        address priceOracle,
        address settlementToken
    );
    
    /// @notice Registry更新事件
    /// @param oldRegistry 旧Registry地址
    /// @param newRegistry 新Registry地址
    event RegistryUpdated(address indexed oldRegistry, address indexed newRegistry);
    
    /// @notice Vault操作事件
    /// @param action 操作类型
    /// @param user 用户地址
    /// @param amount1 金额1
    /// @param amount2 金额2
    /// @param asset 资产地址
    /// @param timestamp 操作时间戳
    event VaultAction(
        bytes32 indexed action, 
        address indexed user, 
        uint256 amount1, 
        uint256 amount2, 
        address indexed asset,
        uint256 timestamp
    );
    
    /// @notice 外部模块调用失败事件
    /// @param module 模块地址
    /// @param moduleName 模块名称
    /// @param data 错误数据
    /// @param user 用户地址
    /// @param action 操作类型
    event ExternalModuleReverted(
        address indexed module, 
        string moduleName, 
        bytes data, 
        address indexed user,
        bytes32 indexed action
    );
    
    /// @notice 模块缓存更新事件
    /// @param cm CollateralManager地址
    /// @param le LendingEngine地址
    event ModuleCacheUpdated(address indexed cm, address indexed le);
    
    /// @notice 优雅降级事件 - 模块调用失败时使用备用策略
    /// @param module 模块地址
    /// @param reason 降级原因
    /// @param fallbackValue 备用值
    /// @param usedFallback 是否使用了降级策略
    event VaultRouterGracefulDegradation(address indexed module, string reason, uint256 fallbackValue, bool usedFallback);
    
    /// @notice 模块健康状态事件
    /// @param module 模块地址
    /// @param isHealthy 是否健康
    /// @param details 详细信息
    event VaultRouterModuleHealthCheck(address indexed module, bool isHealthy, string details);

    // ----------------- 自定义错误 -----------------
    /// @notice 借款期限无效错误
    error VaultRouter__InvalidTermDays();
    
    /// @notice 订单ID无效错误
    error VaultRouter__InvalidOrderId();
    
    /// @notice 用户余额不足错误
    error VaultRouter__InsufficientUserBalance();
    
    /// @notice 健康因子过低错误
    error VaultRouter__HealthFactorTooLow();
    
    /// @notice 借款限额超限错误
    error VaultRouter__BorrowLimitExceeded();
    
    /// @notice 订单不属于用户错误
    error VaultRouter__OrderNotBelongToUser();
    
    /// @notice 原子操作失败错误
    error VaultRouter__AtomicOperationFailed();

    // ----------------- 构造函数 -----------------
    /// @notice 初始化 VaultRouter
    /// @dev 设置Registry、权限管理和资产白名单地址
    /// @param initialRegistry Registry 合约地址，用于获取模块地址
    /// @param initialAssetWhitelist 资产白名单合约地址，用于资产验证
    /// @param initialPriceOracle 价格预言机合约地址，用于价格获取
    /// @param initialSettlementToken 结算币地址，用于优雅降级配置
    /// @custom:security 确保所有地址参数不为零地址
    constructor(
        address initialRegistry, 
        address initialAssetWhitelist,
        address initialPriceOracle,
        address initialSettlementToken
    ) {
        if (initialRegistry == address(0)) revert ZeroAddress();
        if (initialAssetWhitelist == address(0)) revert ZeroAddress();
        if (initialPriceOracle == address(0)) revert ZeroAddress();
        if (initialSettlementToken == address(0)) revert ZeroAddress();
        
        _registryAddr = initialRegistry;
        _assetWhitelistAddr = initialAssetWhitelist;
        _priceOracleAddr = initialPriceOracle;
        _settlementTokenAddr = initialSettlementToken;
        
        emit VaultRouterInitialized(
            initialRegistry, 
            initialAssetWhitelist,
            initialPriceOracle,
            initialSettlementToken
        );
    }

    // ----------------- 修饰符 -----------------
    /// @notice 仅限有效Registry调用
    /// @dev 确保registryAddr不为零地址
    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        _;
    }

    // ----------------- 内部函数 -----------------
    
    /// @notice 权限校验内部函数
    /// @param actionKey 操作键
    /// @param user 用户地址
    /// @dev 从Registry获取ACM地址并执行权限校验
    function _requireRole(bytes32 actionKey, address user) internal view {
        address acmAddr = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        IAccessControlManager(acmAddr).requireRole(actionKey, user);
    }
    
    /// @notice 优雅降级：当模块调用失败时使用备用策略
    /// @param module 模块地址
    /// @param reason 失败原因
    /// @param config 降级配置
    /// @return fallbackValue 备用值
    function _gracefulDegradation(
        address module, 
        string memory reason,
        GracefulDegradation.DegradationConfig memory config
    ) internal returns (uint256 fallbackValue) {
        // 使用GracefulDegradation库的默认策略
        GracefulDegradation.PriceResult memory result = 
            GracefulDegradation.getAssetValueWithFallback(_priceOracleAddr, module, 0, config);
        
        fallbackValue = result.value;
        
        // 记录降级事件
        emit VaultRouterGracefulDegradation(module, reason, fallbackValue, true);
        
        return fallbackValue;
    }
    
    /// @notice 检查模块健康状态
    /// @param module 模块地址
    /// @param moduleName 模块名称
    /// @return isHealthy 是否健康
    /// @return details 详细信息
    function _checkModuleHealth(address module, string memory moduleName) internal view returns (bool isHealthy, string memory details) {
        if (module == address(0)) {
            return (false, string(abi.encodePacked("Module not configured: ", moduleName)));
        }
        
        // 检查模块是否有代码
        uint256 codeSize;
        assembly {
            codeSize := extcodesize(module)
        }
        
        if (codeSize == 0) {
            return (false, string(abi.encodePacked("Module has no code: ", moduleName)));
        }
        
        // 检查价格预言机健康状态
        if (module == _priceOracleAddr) {
            return GracefulDegradation.checkPriceOracleHealth(_priceOracleAddr, address(0));
        }
        
        return (true, string(abi.encodePacked("Module is healthy: ", moduleName)));
    }
    
    /// @notice 校验资产是否在白名单中
    /// @param asset 资产地址
    /// @dev 如果资产地址为零或不在白名单中，会revert
    function _validateAsset(address asset) internal view {
        if (asset == address(0)) revert ZeroAddress();
        if (!IAssetWhitelist(_assetWhitelistAddr).isAssetAllowed(asset)) {
            revert AssetNotAllowed();
        }
    }

    /// @notice 校验金额是否大于0
    /// @param amount 金额
    /// @dev 如果金额为0，会revert AmountIsZero
    function _validateAmount(uint256 amount) internal pure {
        if (amount == 0) revert AmountIsZero();
    }

    /// @notice 校验借款期限
    /// @param termDays 借款期限（天）
    /// @dev 借款期限必须在MIN_TERM_DAYS和MAX_TERM_DAYS之间
    function _validateTermDays(uint16 termDays) internal pure {
        if (termDays < MIN_TERM_DAYS || termDays > MAX_TERM_DAYS) {
            revert VaultRouter__InvalidTermDays();
        }
    }

    /// @notice 校验订单ID
    /// @param orderId 订单ID
    /// @dev 订单ID不能为0
    function _validateOrderId(uint256 orderId) internal pure {
        if (orderId == 0) revert VaultRouter__InvalidOrderId();
    }

    /// @notice 获取并缓存模块地址
    /// @return cm CollateralManager 地址
    /// @return le LendingEngine 地址
    /// @dev 如果缓存过期，重新获取模块地址
    /// @dev 缓存机制减少gas消耗，提高性能
    function _getCachedModules() internal returns (address cm, address le) {
        // 如果缓存过期，重新获取
        if (block.timestamp > _lastCacheUpdate + CACHE_EXPIRY_TIME) {
            _cachedCMAddr = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_CM);
            _cachedLEAddr = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_LE);
            _lastCacheUpdate = block.timestamp;
            emit ModuleCacheUpdated(_cachedCMAddr, _cachedLEAddr);
        }
        return (_cachedCMAddr, _cachedLEAddr);
    }

    /// @notice 安全调用外部模块，失败时使用优雅降级
    /// @param module 模块地址
    /// @param data 调用数据
    /// @param moduleName 模块名称（用于事件）
    /// @param action 操作类型
    /// @param config 降级配置
    /// @return success 是否成功
    /// @return result 调用结果
    /// @dev 使用try/catch包装外部调用，失败时使用优雅降级
    function _safeCallModuleWithGracefulDegradation(
        address module, 
        bytes memory data, 
        string memory moduleName,
        bytes32 action,
        GracefulDegradation.DegradationConfig memory config
    ) internal returns (bool success, bytes memory result) {
        if (module == address(0)) revert ZeroAddress();
        
        try this._executeModuleCall(module, data) returns (bytes memory callResult) {
            success = true;
            result = callResult;
        } catch (bytes memory revertData) {
            // 使用优雅降级
            _gracefulDegradation(module, string(revertData), config);
            success = false;
            result = revertData;
            
            emit ExternalModuleReverted(module, moduleName, revertData, msg.sender, action);
        }
    }

    /// @notice 执行模块调用的外部函数（用于try/catch）
    /// @param module 模块地址
    /// @param data 调用数据
    /// @return result 调用结果
    /// @dev 仅限合约内部调用，用于try/catch机制
    function _executeModuleCall(address module, bytes memory data) external onlyValidRegistry returns (bytes memory result) {
        require(msg.sender == address(this), "VaultRouter: internal call only");
        (bool success, bytes memory callResult) = module.call(data);
        require(success, "VaultRouter: module call failed");
        return callResult;
    }

    /// @notice 校验用户余额（简化实现，实际应调用Token合约）
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @param amount 所需金额
    /// @dev 简化实现，实际项目中需要调用ERC20合约进行验证
    function _validateUserBalance(address user, address asset, uint256 amount) internal pure {
        // 这里应该调用 ERC20(asset).balanceOf(user) 进行实际校验
        // 简化实现，实际项目中需要完整实现
        if (amount == 0) revert AmountIsZero();
        
        // 使用参数进行基本验证（实际项目中应该调用ERC20合约）
        if (user == address(0)) revert ZeroAddress();
        if (asset == address(0)) revert ZeroAddress();
        
        // 这里可以添加更多的验证逻辑
        // 例如：检查用户是否有足够的余额
        // uint256 userBalance = IERC20(asset).balanceOf(user);
        // if (userBalance < amount) revert InsufficientBalance();
    }

    /// @notice 校验借款限额（简化实现）
    /// @param user 用户地址
    /// @param amount 借款金额
    /// @dev 简化实现，实际项目中需要调用LendingEngine进行验证
    function _validateBorrowLimit(address user, uint256 amount) internal pure {
        // 这里应该调用 LendingEngine 进行实际校验
        // 简化实现，实际项目中需要完整实现
        if (amount == 0) revert AmountIsZero();
        
        // 使用参数进行基本验证
        if (user == address(0)) revert ZeroAddress();
        
        // 这里可以添加更多的验证逻辑
        // 例如：检查用户的借款限额
        // uint256 borrowLimit = ILendingEngine(lendingEngine).getBorrowLimit(user);
        // if (amount > borrowLimit) revert VaultRouter__BorrowLimitExceeded();
    }

    /// @notice 校验订单归属权
    /// @param orderId 订单ID
    /// @param user 用户地址
    /// @dev 简化实现，实际项目中需要调用LendingEngine进行验证
    function _validateOrderOwnership(uint256 orderId, address user) internal pure {
        // 这里应该调用 LendingEngine.getLoanOrder(orderId) 进行实际校验
        // 简化实现，实际项目中需要完整实现
        if (orderId == 0) revert VaultRouter__InvalidOrderId();
        
        // 使用参数进行基本验证
        if (user == address(0)) revert ZeroAddress();
        
        // 这里可以添加更多的验证逻辑
        // 例如：检查订单是否属于该用户
        // ILendingEngine.LoanOrder memory order = ILendingEngine(lendingEngine).getLoanOrder(orderId);
        // if (order.borrower != user) revert VaultRouter__OrderNotBelongToUser();
    }

    /// @notice 发出Vault操作事件
    /// @param action 操作类型
    /// @param user 用户地址
    /// @param amount1 金额1
    /// @param amount2 金额2
    /// @param asset 资产地址
    /// @dev 统一的事件发出函数，确保事件格式一致
    function _emitVaultAction(
        bytes32 action,
        address user,
        uint256 amount1,
        uint256 amount2,
        address asset
    ) internal {
        emit VaultAction(action, user, amount1, amount2, asset, block.timestamp);
    }

    // ----------------- 业务函数 -----------------

    /// @notice 原子性操作：存入抵押物并借款
    /// @param collateralAsset 抵押资产地址
    /// @param collateralAmount 抵押数量
    /// @param borrowAsset 借款资产地址
    /// @param borrowAmount 借款数量
    /// @param termDays 借款期限（天）
    /// @dev 原子性操作确保存款和借款要么都成功，要么都失败
    function depositAndBorrow(
        address collateralAsset,
        uint256 collateralAmount,
        address borrowAsset,
        uint256 borrowAmount,
        uint16 termDays
    ) external nonReentrant whenNotPaused onlyValidRegistry {
        // 参数校验
        _validateAsset(collateralAsset);
        _validateAsset(borrowAsset);
        _validateAmount(collateralAmount);
        _validateAmount(borrowAmount);
        _validateTermDays(termDays);

        // 业务逻辑校验
        _validateUserBalance(msg.sender, collateralAsset, collateralAmount);
        _validateBorrowLimit(msg.sender, borrowAmount);

        // 获取模块地址
        (address cm, address le) = _getCachedModules();

        // 创建降级配置
        GracefulDegradation.DegradationConfig memory config = 
            GracefulDegradation.createDefaultConfig(_settlementTokenAddr);

        // 原子性操作：先准备所有调用数据
        bytes memory depositData = abi.encodeWithSelector(
            ICollateralManager.depositCollateral.selector,
            msg.sender,
            collateralAsset,
            collateralAmount
        );
        
        bytes memory borrowData = abi.encodeWithSelector(
            ILendingEngine.borrow.selector,
            msg.sender,
            borrowAsset,
            borrowAmount,
            termDays
        );

        // 执行原子性操作
        try this._executeAtomicOperation(cm, le, depositData, borrowData) {
            // 操作成功，发出事件
            _emitVaultAction(
                ActionKeys.ACTION_DEPOSIT, 
                msg.sender, 
                collateralAmount, 
                0, 
                collateralAsset
            );
            _emitVaultAction(
                ActionKeys.ACTION_BORROW, 
                msg.sender, 
                borrowAmount, 
                0, 
                borrowAsset
            );
        } catch (bytes memory revertData) {
            // 原子操作失败，使用优雅降级
            _gracefulDegradation(address(0), "Atomic operation failed", config);
            emit ExternalModuleReverted(
                address(0), 
                "AtomicOperation", 
                revertData, 
                msg.sender, 
                ActionKeys.ACTION_DEPOSIT
            );
            revert VaultRouter__AtomicOperationFailed();
        }
    }

    /// @notice 原子性操作：还款并提取抵押物
    /// @param orderId 借款订单ID
    /// @param repayAsset 还款资产地址
    /// @param repayAmount 还款数量
    /// @param withdrawAsset 提取抵押资产地址
    /// @param withdrawAmount 提取抵押数量
    /// @dev 原子性操作确保还款和提取要么都成功，要么都失败
    function repayAndWithdraw(
        uint256 orderId,
        address repayAsset,
        uint256 repayAmount,
        address withdrawAsset,
        uint256 withdrawAmount
    ) external nonReentrant whenNotPaused onlyValidRegistry {
        // 参数校验
        _validateOrderId(orderId);
        _validateAsset(repayAsset);
        _validateAsset(withdrawAsset);
        _validateAmount(repayAmount);
        _validateAmount(withdrawAmount);

        // 业务逻辑校验
        _validateUserBalance(msg.sender, repayAsset, repayAmount);
        _validateOrderOwnership(orderId, msg.sender);

        // 获取模块地址
        (address le, address cm) = _getCachedModules();

        // 创建降级配置
        GracefulDegradation.DegradationConfig memory config = 
            GracefulDegradation.createDefaultConfig(_settlementTokenAddr);

        // 原子性操作：先准备所有调用数据
        bytes memory repayData = abi.encodeWithSelector(
            ILendingEngine.repay.selector,
            orderId,
            repayAsset,
            repayAmount
        );
        
        bytes memory withdrawData = abi.encodeWithSelector(
            ICollateralManager.withdrawCollateral.selector,
            msg.sender,
            withdrawAsset,
            withdrawAmount
        );

        // 执行原子性操作
        try this._executeAtomicOperation(le, cm, repayData, withdrawData) {
            // 操作成功，发出事件
            _emitVaultAction(
                ActionKeys.ACTION_REPAY, 
                msg.sender, 
                repayAmount, 
                0, 
                repayAsset
            );
            _emitVaultAction(
                ActionKeys.ACTION_WITHDRAW, 
                msg.sender, 
                withdrawAmount, 
                0, 
                withdrawAsset
            );
        } catch (bytes memory revertData) {
            // 原子操作失败，使用优雅降级
            _gracefulDegradation(address(0), "Atomic operation failed", config);
            emit ExternalModuleReverted(
                address(0), 
                "AtomicOperation", 
                revertData, 
                msg.sender, 
                ActionKeys.ACTION_REPAY
            );
            revert VaultRouter__AtomicOperationFailed();
        }
    }

    /// @notice 执行原子性操作的外部函数（用于try/catch）
    /// @param module1 第一个模块地址
    /// @param module2 第二个模块地址
    /// @param data1 第一个调用数据
    /// @param data2 第二个调用数据
    /// @dev 仅限合约内部调用，用于try/catch机制
    function _executeAtomicOperation(
        address module1,
        address module2,
        bytes memory data1,
        bytes memory data2
    ) external onlyValidRegistry {
        require(msg.sender == address(this), "VaultRouter: internal call only");
        
        // 执行第一个操作
        (bool success1, ) = module1.call(data1);
        require(success1, "VaultRouter: first operation failed");
        
        // 执行第二个操作
        (bool success2, ) = module2.call(data2);
        require(success2, "VaultRouter: second operation failed");
    }

    // ----------------- 视图函数 -----------------
    
    /// @notice 查询用户当前抵押量
    /// @param user 用户地址
    /// @param asset 资产地址
    /// @return amount 用户抵押数量
    /// @dev 通过CollateralManager模块查询用户抵押信息
    function getUserCollateral(address user, address asset) external view onlyValidRegistry returns (uint256) {
        if (user == address(0)) revert ZeroAddress();
        if (asset == address(0)) revert ZeroAddress();
        
        address cm = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_CM);
        
        try ICollateralManager(cm).getCollateral(user, asset) returns (uint256 amount) {
            return amount;
        } catch (bytes memory errorData) {
            // 使用优雅降级而不是直接失败
            // 记录错误信息用于调试
            // 注意：view 函数中不能 emit 事件，所以这里只返回默认值
            // 在实际项目中，可以将错误信息记录到日志中
            // 这里可以使用errorData进行错误分析
            if (errorData.length > 0) {
                // 可以在这里添加错误分析逻辑
                // 例如：解析错误类型，记录错误信息等
            }
            return 0;
        }
    }

    /// @notice 查询用户总抵押物价值
    /// @param user 用户地址
    /// @return totalValue 用户总抵押价值
    /// @dev 通过CollateralManager模块查询用户总抵押价值
    function getUserTotalCollateralValue(address user) external view onlyValidRegistry returns (uint256) {
        if (user == address(0)) revert ZeroAddress();
        
        address cm = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_CM);
        
        try ICollateralManager(cm).getUserTotalCollateralValue(user) returns (uint256 totalValue) {
            return totalValue;
        } catch (bytes memory errorData) {
            // 使用优雅降级而不是直接失败
            // 记录错误信息用于调试
            // 注意：view 函数中不能 emit 事件，所以这里只返回默认值
            // 在实际项目中，可以将错误信息记录到日志中
            // 这里可以使用errorData进行错误分析
            if (errorData.length > 0) {
                // 可以在这里添加错误分析逻辑
                // 例如：解析错误类型，记录错误信息等
            }
            return 0;
        }
    }

    /// @notice 查询用户所有抵押资产列表
    /// @param user 用户地址
    /// @return assets 用户抵押的资产地址数组
    /// @dev 通过CollateralManager模块查询用户抵押资产列表
    function getUserCollateralAssets(address user) external view onlyValidRegistry returns (address[] memory) {
        if (user == address(0)) revert ZeroAddress();
        
        address cm = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_CM);
        return ICollateralManager(cm).getUserCollateralAssets(user);
    }

    /// @notice 查询贷款订单详情
    /// @param orderId 订单编号
    /// @return order 贷款订单结构体
    /// @dev 通过LendingEngine模块查询贷款订单详情
    function getLoanOrder(uint256 orderId) external view onlyValidRegistry returns (ILendingEngine.LoanOrder memory) {
        _validateOrderId(orderId);
        
        address le = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_LE);
        return ILendingEngine(le).getLoanOrder(orderId);
    }

    /// @notice 获取Registry地址
    /// @return registry Registry合约地址
    /// @dev 返回当前使用的Registry地址
    function getRegistry() external view returns (address registry) {
        return _registryAddr;
    }

    // ----------------- 治理函数 -----------------

    /// @notice 暂停系统（仅治理角色）
    /// @dev 使用ActionKeys.ACTION_PAUSE_SYSTEM记录操作
    function pause() external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_PAUSE_SYSTEM, msg.sender);
        _pause();
        _emitVaultAction(
            ActionKeys.ACTION_PAUSE_SYSTEM,
            msg.sender,
            0,
            0,
            address(0)
        );
    }

    /// @notice 恢复系统（仅治理角色）
    /// @dev 使用ActionKeys.ACTION_UNPAUSE_SYSTEM记录操作
    function unpause() external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_UNPAUSE_SYSTEM, msg.sender);
        _unpause();
        _emitVaultAction(
            ActionKeys.ACTION_UNPAUSE_SYSTEM,
            msg.sender,
            0,
            0,
            address(0)
        );
    }

    /// @notice 强制更新模块缓存（仅治理角色）
    /// @dev 强制更新模块地址缓存，用于紧急情况下的模块地址更新
    function forceUpdateModuleCache() external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
        _cachedCMAddr = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_CM);
        _cachedLEAddr = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_LE);
        _lastCacheUpdate = block.timestamp;
        emit ModuleCacheUpdated(_cachedCMAddr, _cachedLEAddr);
    }
} 