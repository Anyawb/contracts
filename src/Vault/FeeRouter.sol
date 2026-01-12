// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { PausableUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { ActionKeys } from "../constants/ActionKeys.sol";
import { ModuleKeys } from "../constants/ModuleKeys.sol";
import { IAccessControlManager } from "../interfaces/IAccessControlManager.sol";
import { IRegistry } from "../interfaces/IRegistry.sol";
import { DataPushLibrary } from "../libraries/DataPushLibrary.sol";
import { DataPushTypes } from "../constants/DataPushTypes.sol";
import { IRegistryUpgradeEvents } from "../interfaces/IRegistryUpgradeEvents.sol";
import { IFeeRouter } from "../interfaces/IFeeRouter.sol";
import { VaultTypes } from "../Vault/VaultTypes.sol";
import { VaultMath } from "../Vault/VaultMath.sol";
import { 
    AmountIsZero, 
    FeeRouter__ZeroAddress
} from "../errors/StandardErrors.sol";

/// @notice Minimal VaultCore interface for resolving View (VaultRouter) address
interface IVaultCoreMinimal {
    function viewContractAddrVar() external view returns (address);
}

/// @notice Minimal interface for FeeRouterView push functions (best-effort)
interface IFeeRouterViewMinimal {
    function pushUserFeeUpdate(address user, bytes32 feeType, uint256 feeAmount, uint256 personalFeeBps) external;
    function pushGlobalStatsUpdate(uint256 totalDistributions, uint256 totalAmountDistributed) external;
    function pushSystemConfigUpdate(
        address platformTreasury,
        address ecosystemVault,
        uint256 platformFeeBps,
        uint256 ecosystemFeeBps,
        address[] calldata supportedTokens
    ) external;
    function pushGlobalFeeStatistic(address token, bytes32 feeType, uint256 amount) external;
}

/**
 * @title FeeRouter
 * @notice 管理平台手续费分配，把撮合费/清算费按比例分发到金库地址。
 * @dev 重构后：简化架构，直接返回本地数据，View合约通过VaultRouter统一访问
 * @dev 统一传参架构：复杂查询通过VaultRouter协调器，简单查询直接返回本地数据
 * @custom:security-contact security@example.com
 */
contract FeeRouter is 
    Initializable, 
    PausableUpgradeable, 
    UUPSUpgradeable,
    IFeeRouter,
    IRegistryUpgradeEvents 
{
    using SafeERC20 for IERC20;

    /*━━━━━━━━━━━━━━━ STATE ━━━━━━━━━━━━━━━*/
    /// @notice Registry 合约地址
    address private _registryAddr;
    
    /// @notice 平台金库地址
    address private _platformTreasury;
    
    /// @notice 生态金库地址
    address private _ecosystemVault;

    /// @notice 平台手续费比例（以万分比计，eg 50 = 0.5%）
    uint256 private _platformFeeBps;
    
    /// @notice 生态手续费比例（以万分比计，eg 20 = 0.2%）
    uint256 private _ecosystemFeeBps;

    /// @notice 费用缓存：token → feeType → cachedAmount
    mapping(address => mapping(bytes32 => uint256)) private _feeCache;
    
    /// @notice 动态费用配置：token → feeType → feeBps
    mapping(address => mapping(bytes32 => uint256)) private _dynamicFees;
    
    /// @notice 支持的代币列表
    address[] private _supportedTokens;
    
    /// @notice 代币支持状态映射
    mapping(address => bool) private _isSupportedToken;
    
    /// @notice 费用统计：token → feeType → totalAmount
    mapping(address => mapping(bytes32 => uint256)) private _feeStatistics;

    /// @notice 操作统计
    uint256 private _totalDistributions;
    uint256 private _totalAmountDistributed;
    
    // ============ Gas优化缓存 ============
    // 方案A：移除本地ACM缓存，统一通过Registry读取



    /*━━━━━━━━━━━━━━━ EVENTS ━━━━━━━━━━━━━━━*/
    // All events are imported from IFeeRouter interface
    
    // 新增安全化事件
    event PlatformTreasuryUpdated(address indexed oldAddr, address indexed newAddr);
    event EcosystemVaultUpdated(address indexed oldAddr, address indexed newAddr);

	/*━━━━━━━━━━━━━━━ DATA PUSH CONSTANTS ━━━━━━━━━━━━━━━*/
	// 常量统一迁移至 DataPushTypes

    /*━━━━━━━━━━━━━━━ ERRORS ━━━━━━━━━━━━━━━*/
    /// @notice 无效配置错误
    error FeeRouter__InvalidConfig();
    
    /// @notice 代币不支持错误
    error FeeRouter__TokenNotSupported();
    
    /// @notice 无效费用类型错误
    error FeeRouter__InvalidFeeType();

    /// @notice 批量操作大小错误
    error FeeRouter__InvalidBatchSize();



    /*━━━━━━━━━━━━━━━ MODIFIERS ━━━━━━━━━━━━━━━*/
    
    /// @notice 验证 Registry 地址
    modifier onlyValidRegistry() {
        if (_registryAddr == address(0) || _registryAddr.code.length == 0) revert FeeRouter__ZeroAddress();
        _;
    }

    /// @notice 统一权限验证修饰符
    modifier onlyRole(bytes32 actionKey) {
        _requireRole(actionKey, msg.sender);
        _;
    }

    /*━━━━━━━━━━━━━━━ INITIALIZER ━━━━━━━━━━━━━━━*/

    /**
     * @notice 初始化手续费路由器
     * @param initialRegistryAddr Registry 合约地址
     * @param platformTreasury_ 平台金库地址
     * @param ecosystemVault_ 生态金库地址
     * @param platformBps_ 平台手续费比例（基点）
     * @param ecoBps_ 生态手续费比例（基点）
     */
    function initialize(
        address initialRegistryAddr,
        address platformTreasury_,
        address ecosystemVault_,
        uint256 platformBps_,
        uint256 ecoBps_
    ) external initializer {
        // 验证参数
        if (initialRegistryAddr == address(0) || platformTreasury_ == address(0) || ecosystemVault_ == address(0)) {
            revert FeeRouter__ZeroAddress();
        }
        if (platformBps_ + ecoBps_ >= 1e4) {
            revert FeeRouter__InvalidConfig();
        }

        __UUPSUpgradeable_init();
        __Pausable_init();

        _registryAddr = initialRegistryAddr;
        _platformTreasury = platformTreasury_;
        _ecosystemVault = ecosystemVault_;
        _platformFeeBps = platformBps_;
        _ecosystemFeeBps = ecoBps_;
        
        _emitActionExecuted(ActionKeys.ACTION_SET_PARAMETER);
        _pushSystemConfigToView();
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /*━━━━━━━━━━━━━━━ EXTERNAL FUNCTIONS ━━━━━━━━━━━━━━━*/

    /**
     * @notice 撮合成功后的常规手续费分配
     * @param token 代币地址
     * @param amount 手续费金额
     */
    function distributeNormal(address token, uint256 amount) external override onlyValidRegistry onlyRole(ActionKeys.ACTION_DEPOSIT) {
        if (amount == 0) revert AmountIsZero();
        if (!_isSupportedToken[token]) revert FeeRouter__TokenNotSupported();
        
        _distribute(token, amount, ActionKeys.ACTION_DEPOSIT);
        _updateStats(1, amount);
        _emitActionExecuted(ActionKeys.ACTION_DEPOSIT);
    }

    /**
     * @notice 批量费用分配 - Gas优化
     * @param token 代币地址
     * @param amounts 金额数组
     * @param feeTypes 费用类型数组
     */
    function batchDistribute(
        address token,
        uint256[] calldata amounts,
        bytes32[] calldata feeTypes
    ) external onlyValidRegistry onlyRole(ActionKeys.ACTION_DEPOSIT) {
        if (!_isSupportedToken[token]) revert FeeRouter__TokenNotSupported();
        
        uint256 length = amounts.length;
        if (length != feeTypes.length || length > 50) revert FeeRouter__InvalidBatchSize();
        
        uint256 totalAmount = 0;
        for (uint256 i = 0; i < length; i++) {
            if (amounts[i] == 0) continue;
            _distribute(token, amounts[i], feeTypes[i]);
            totalAmount += amounts[i];
        }
        
		_updateStats(length, totalAmount);
		emit BatchFeeDistributed(token, totalAmount, length);
		_emitActionExecuted(ActionKeys.ACTION_DEPOSIT);

		// 统一数据推送（批量分发摘要）
		DataPushLibrary._emitData(
			DataPushTypes.DATA_TYPE_BATCH_FEE_DISTRIBUTED,
			abi.encode(token, totalAmount, length, msg.sender, block.timestamp)
		);
    }

    /**
     * @notice 动态费用分配
     * @param token 代币地址
     * @param amount 金额
     * @param feeType 费用类型
     */
    function distributeDynamic(address token, uint256 amount, bytes32 feeType) external onlyValidRegistry onlyRole(ActionKeys.ACTION_DEPOSIT) {
        if (amount == 0) revert AmountIsZero();
        if (!_isSupportedToken[token]) revert FeeRouter__TokenNotSupported();
        if (_dynamicFees[token][feeType] == 0) revert FeeRouter__InvalidFeeType();
        
        _distributeDynamic(token, amount, feeType);
        _updateStats(1, amount);
        _emitActionExecuted(ActionKeys.ACTION_DEPOSIT);
    }

    /*━━━━━━━━━━━━━━━ VIEW FUNCTIONS ━━━━━━━━━━━━━━━*/

    // ============ 基础查询功能（保留在主文件）============
    
    /// @notice 查询代币是否支持
    function isTokenSupported(address token) external view returns (bool) {
        return _isSupportedToken[token];
    }

    /**
     * @notice 获取当前手续费率
     * @return 当前手续费率（基点，10000 = 100%）
     */
    function getFeeRate() external view override returns (uint256) {
        return _platformFeeBps + _ecosystemFeeBps;
    }

    /**
     * @notice 向用户收取存款手续费
     * @param user 用户地址
     * @param amount 存款金额
     * @return fee 实际收取的手续费
     */
    function chargeDepositFee(address user, uint256 amount) external view override returns (uint256 fee) {
        user; // silence unused parameter
        return _calculateFee(amount);
    }

    /**
     * @notice 向用户收取借款手续费
     * @param user 用户地址
     * @param amount 借款金额
     * @return fee 实际收取的手续费
     */
    function chargeBorrowFee(address user, uint256 amount) external view override returns (uint256 fee) {
        user; // silence unused parameter
        return _calculateFee(amount);
    }

    // ============ 只读getter函数（安全化）============
    
    /// @notice 获取Registry地址
    function getRegistry() external view returns (address registry) {
        return _registryAddr;
    }
    
    /// @notice 获取平台金库地址
    function getPlatformTreasury() external view returns (address treasury) {
        return _platformTreasury;
    }
    
    /// @notice 获取生态金库地址
    function getEcosystemVault() external view returns (address vault) {
        return _ecosystemVault;
    }
    
    /// @notice 获取平台手续费比例
    function getPlatformFeeBps() external view returns (uint256 feeBps) {
        return _platformFeeBps;
    }
    
    /// @notice 获取生态手续费比例
    function getEcosystemFeeBps() external view returns (uint256 feeBps) {
        return _ecosystemFeeBps;
    }
    
    /// @notice 获取总分发次数
    function getTotalDistributions() external view returns (uint256 distributions) {
        return _totalDistributions;
    }
    
    /// @notice 获取总分发金额
    function getTotalAmountDistributed() external view returns (uint256 amount) {
        return _totalAmountDistributed;
    }

    // ============ 基础查询功能（直接返回本地数据）============
    
    /// @notice 获取支持的代币列表
    function getSupportedTokens() external view returns (address[] memory) {
        return _supportedTokens;
    }

    /// @notice 获取费用统计
    function getFeeStatistics(address token, bytes32 feeType) external view returns (uint256) {
        return _feeStatistics[token][feeType];
    }

    /// @notice 获取动态费用配置
    function getDynamicFee(address token, bytes32 feeType) external view returns (uint256) {
        return _dynamicFees[token][feeType];
    }

    /// @notice 获取费用缓存
    function getFeeCache(address token, bytes32 feeType) external view returns (uint256) {
        return _feeCache[token][feeType];
    }

    /// @notice 获取操作统计信息
    function getOperationStats() external view returns (uint256 distributions, uint256 totalAmount) {
        return (_totalDistributions, _totalAmountDistributed);
    }

    /**
     * @notice 设置费用配置
     * @param platformBps 平台手续费比例（基点）
     * @param ecoBps 生态手续费比例（基点）
     */
    function setFeeConfig(uint256 platformBps, uint256 ecoBps) external onlyValidRegistry onlyRole(ActionKeys.ACTION_SET_PARAMETER) {
        if (platformBps + ecoBps >= 1e4) revert FeeRouter__InvalidConfig();
        
        _platformFeeBps = platformBps;
        _ecosystemFeeBps = ecoBps;
        
        emit FeeConfigUpdated(platformBps, ecoBps);
        _emitActionExecuted(ActionKeys.ACTION_SET_PARAMETER);
        _pushSystemConfigToView();

		// 统一数据推送
		DataPushLibrary._emitData(
			DataPushTypes.DATA_TYPE_FEE_CONFIG_UPDATED,
			abi.encode(platformBps, ecoBps, msg.sender, block.timestamp)
		);
    }

    /**
     * @notice 设置金库地址
     * @param platformTreasury_ 平台金库地址
     * @param ecosystemVault_ 生态金库地址
     */
    function setTreasury(address platformTreasury_, address ecosystemVault_) external onlyValidRegistry onlyRole(ActionKeys.ACTION_SET_PARAMETER) {
        if (platformTreasury_ == address(0) || ecosystemVault_ == address(0)) revert FeeRouter__ZeroAddress();
        
        address oldPlatformTreasury = _platformTreasury;
        address oldEcosystemVault = _ecosystemVault;
        
        _platformTreasury = platformTreasury_;
        _ecosystemVault = ecosystemVault_;
        
        emit PlatformTreasuryUpdated(oldPlatformTreasury, platformTreasury_);
        emit EcosystemVaultUpdated(oldEcosystemVault, ecosystemVault_);
        _emitActionExecuted(ActionKeys.ACTION_SET_PARAMETER);
        _pushSystemConfigToView();

		// 统一数据推送
		DataPushLibrary._emitData(
			DataPushTypes.DATA_TYPE_TREASURY_UPDATED,
			abi.encode(oldPlatformTreasury, platformTreasury_, oldEcosystemVault, ecosystemVault_, msg.sender, block.timestamp)
		);
    }

    /**
     * @notice 设置动态费用
     * @param token 代币地址
     * @param feeType 费用类型
     * @param feeBps 费用比例（基点）
     */
    function setDynamicFee(address token, bytes32 feeType, uint256 feeBps) external onlyValidRegistry onlyRole(ActionKeys.ACTION_SET_PARAMETER) {
        if (token == address(0)) revert FeeRouter__ZeroAddress();
        if (feeBps >= 1e4) revert FeeRouter__InvalidConfig();
        // 动态费率与生态分成（50%）叠加后不得超过100%
        if (feeBps + (feeBps / 2) >= 1e4) revert FeeRouter__InvalidConfig();
        
        uint256 oldFee = _dynamicFees[token][feeType];
        _dynamicFees[token][feeType] = feeBps;
        
        emit DynamicFeeUpdated(token, feeType, oldFee, feeBps);
        _emitActionExecuted(ActionKeys.ACTION_SET_PARAMETER);
        _pushSystemConfigToView();

		// 统一数据推送
		DataPushLibrary._emitData(
			DataPushTypes.DATA_TYPE_DYNAMIC_FEE_UPDATED,
			abi.encode(token, feeType, oldFee, feeBps, msg.sender, block.timestamp)
		);
    }

    /**
     * @notice 添加支持的代币
     * @param token 代币地址
     */
    function addSupportedToken(address token) external onlyValidRegistry onlyRole(ActionKeys.ACTION_SET_PARAMETER) {
        if (token == address(0)) revert FeeRouter__ZeroAddress();
        if (_isSupportedToken[token]) revert FeeRouter__InvalidConfig();
        
        _isSupportedToken[token] = true;
        _supportedTokens.push(token);
        
        emit TokenSupported(token, true);
        _emitActionExecuted(ActionKeys.ACTION_SET_PARAMETER);
        _pushSystemConfigToView();

		// 统一数据推送
		DataPushLibrary._emitData(
			DataPushTypes.DATA_TYPE_TOKEN_SUPPORTED,
			abi.encode(token, true, msg.sender, block.timestamp)
		);
    }

    /**
     * @notice 移除支持的代币
     * @param token 代币地址
     */
    function removeSupportedToken(address token) external onlyValidRegistry onlyRole(ActionKeys.ACTION_SET_PARAMETER) {
        if (!_isSupportedToken[token]) revert FeeRouter__InvalidConfig();
        
        _isSupportedToken[token] = false;
        
        // 从数组中移除
        for (uint256 i = 0; i < _supportedTokens.length; i++) {
            if (_supportedTokens[i] == token) {
                _supportedTokens[i] = _supportedTokens[_supportedTokens.length - 1];
                _supportedTokens.pop();
                break;
            }
        }
        
        emit TokenSupported(token, false);
        _emitActionExecuted(ActionKeys.ACTION_SET_PARAMETER);
        _pushSystemConfigToView();

		// 统一数据推送
		DataPushLibrary._emitData(
			DataPushTypes.DATA_TYPE_TOKEN_SUPPORTED,
			abi.encode(token, false, msg.sender, block.timestamp)
		);
    }

    /**
     * @notice 清空费用缓存
     * @param token 代币地址
     * @param feeType 费用类型
     */
    function clearFeeCache(address token, bytes32 feeType) external onlyValidRegistry onlyRole(ActionKeys.ACTION_SET_PARAMETER) {
        delete _feeCache[token][feeType];
        _emitActionExecuted(ActionKeys.ACTION_SET_PARAMETER);

		// 统一数据推送
		DataPushLibrary._emitData(
			DataPushTypes.DATA_TYPE_FEE_CACHE_CLEARED,
			abi.encode(token, feeType, msg.sender, block.timestamp)
		);
    }

    /// @notice 暂停所有分发
    function pause() external onlyValidRegistry onlyRole(ActionKeys.ACTION_PAUSE_SYSTEM) {
        _pause();
        _emitActionExecuted(ActionKeys.ACTION_PAUSE_SYSTEM);

		// 统一数据推送
		DataPushLibrary._emitData(
			DataPushTypes.DATA_TYPE_PAUSE_STATUS_UPDATED,
			abi.encode(true, msg.sender, block.timestamp)
		);
    }

    /// @notice 恢复分发
    function unpause() external onlyValidRegistry onlyRole(ActionKeys.ACTION_UNPAUSE_SYSTEM) {
        _unpause();
        _emitActionExecuted(ActionKeys.ACTION_UNPAUSE_SYSTEM);

		// 统一数据推送
		DataPushLibrary._emitData(
			DataPushTypes.DATA_TYPE_PAUSE_STATUS_UPDATED,
			abi.encode(false, msg.sender, block.timestamp)
		);
    }
    
    /// @notice 更新 Registry 地址（标准升级）
    function updateRegistry(address newRegistryAddr) external onlyValidRegistry onlyRole(ActionKeys.ACTION_UPGRADE_MODULE) {
        if (newRegistryAddr == address(0)) revert FeeRouter__ZeroAddress();
        
        address oldRegistry = _registryAddr;
        _registryAddr = newRegistryAddr;
        
        emit RegistryUpdated(oldRegistry, newRegistryAddr);
        _emitActionExecuted(ActionKeys.ACTION_UPGRADE_MODULE);
        
        // 发出模块地址更新事件
        emit VaultTypes.ModuleAddressUpdated(
            ModuleKeys.getModuleKeyString(ModuleKeys.KEY_FR),
            oldRegistry,
            newRegistryAddr,
            block.timestamp
        );

		// 统一数据推送
		DataPushLibrary._emitData(
			DataPushTypes.DATA_TYPE_REGISTRY_UPDATED,
			abi.encode(oldRegistry, newRegistryAddr, msg.sender, block.timestamp)
		);

        // 同步新视图（最佳努力，避免新 View 落后）
        _pushSystemConfigToView();
        _pushGlobalStatsToView();
    }

    // ============ 公共逻辑函数（消除重复）============
    
    /**
     * @notice 记录标准化动作事件（公共函数）
     * @param actionKey 动作键
     */
    function _emitActionExecuted(bytes32 actionKey) internal {
        emit VaultTypes.ActionExecuted(
            actionKey,
            ActionKeys.getActionKeyString(actionKey),
            msg.sender,
            block.timestamp
        );
    }
    
    /**
     * @notice 更新统计信息（公共函数）
     * @param distributions 分发次数增量
     * @param amount 分发金额增量
     */
    function _updateStats(uint256 distributions, uint256 amount) internal {
        _totalDistributions += distributions;
        _totalAmountDistributed += amount;
        _pushGlobalStatsToView();
    }

    /**
     * @notice 验证用户权限（使用标准ACM，Gas优化）
     * @param actionKey 动作键
     * @param user 用户地址
     */
    function _requireRole(bytes32 actionKey, address user) internal view {
        address acmAddr = IRegistry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        IAccessControlManager(acmAddr).requireRole(actionKey, user);
    }

    /**
     * @notice 统一的费用计算函数
     * @param amount 基础金额
     * @return fee 费用金额
     */
    function _calculateFee(uint256 amount) internal view returns (uint256 fee) {
        uint256 totalFeeBps = _platformFeeBps + _ecosystemFeeBps;
        return VaultMath.calculateFee(amount, totalFeeBps);
    }

    /**
     * @notice 内部费用分发逻辑（使用固定费率）
     * @param token 代币地址
     * @param amount 金额
     * @param feeType 费用类型
     */
    function _distribute(address token, uint256 amount, bytes32 feeType) internal whenNotPaused {
        uint256 platformBps = _platformFeeBps;
        uint256 ecoBps = _ecosystemFeeBps;
        (uint256 platformAmt, uint256 ecoAmt, uint256 remaining) = _calculateDistribution(amount, platformBps, ecoBps);
        _executeFeeDistribution(token, platformAmt, ecoAmt, remaining, feeType, amount, msg.sender, platformBps + ecoBps);
    }

    /**
     * @notice 内部动态费用分发逻辑
     * @param token 代币地址
     * @param amount 金额
     * @param feeType 费用类型
     */
    function _distributeDynamic(address token, uint256 amount, bytes32 feeType) internal whenNotPaused {
        uint256 dynamicFeeBps = _dynamicFees[token][feeType];
        uint256 halfDynamicFee = dynamicFeeBps / 2; // 生态费用为动态费用的一半
        
        (uint256 platformAmt, uint256 ecoAmt, uint256 remaining) = _calculateDistribution(amount, dynamicFeeBps, halfDynamicFee);
        _executeFeeDistribution(token, platformAmt, ecoAmt, remaining, feeType, amount, msg.sender, dynamicFeeBps + halfDynamicFee);
    }

    /**
     * @notice 计算费用分配
     * @param amount 总金额
     * @param platformBps 平台费率
     * @param ecoBps 生态费率
     * @return platformAmt 平台费用
     * @return ecoAmt 生态费用
     * @return remaining 剩余金额
     */
    function _calculateDistribution(uint256 amount, uint256 platformBps, uint256 ecoBps) 
        internal 
        pure 
        returns (uint256 platformAmt, uint256 ecoAmt, uint256 remaining) 
    {
        platformAmt = VaultMath.calculateFee(amount, platformBps);
        ecoAmt = VaultMath.calculateFee(amount, ecoBps);
        remaining = amount - platformAmt - ecoAmt;
    }

    /**
     * @notice 获取 FeeRouterView 地址（最佳努力，不回滚主流程）
     */
    function _resolveFeeRouterViewAddr() internal view returns (address) {
        address registryAddr = _registryAddr;
        if (registryAddr == address(0) || registryAddr.code.length == 0) return address(0);

        // 主路径：Registry -> VaultCore -> viewContractAddrVar()（统一视图解析策略）
        try IRegistry(registryAddr).getModule(ModuleKeys.KEY_VAULT_CORE) returns (address vaultCore) {
            if (vaultCore != address(0)) {
                try IVaultCoreMinimal(vaultCore).viewContractAddrVar() returns (address viewAddr) {
                    if (viewAddr != address(0)) return viewAddr;
                } catch { }
            }
        } catch { }

        // 回退：直接读取 FeeRouterView（兼容部署/过渡阶段）
        try IRegistry(registryAddr).getModule(ModuleKeys.KEY_FRV) returns (address frv) {
            return frv;
        } catch { }

        return address(0);
    }

    /**
     * @notice 推送系统配置到 FeeRouterView（最佳努力）
     */
    function _pushSystemConfigToView() internal {
        address viewAddr = _resolveFeeRouterViewAddr();
        if (viewAddr == address(0) || viewAddr.code.length == 0) return;

        address[] memory tokens = _copySupportedTokens();
        try IFeeRouterViewMinimal(viewAddr).pushSystemConfigUpdate(
            _platformTreasury,
            _ecosystemVault,
            _platformFeeBps,
            _ecosystemFeeBps,
            tokens
        ) {
            // success
        } catch {
            // best-effort: 不阻断主流程
        }
    }

    /**
     * @notice 推送全局统计到 FeeRouterView（最佳努力）
     */
    function _pushGlobalStatsToView() internal {
        address viewAddr = _resolveFeeRouterViewAddr();
        if (viewAddr == address(0) || viewAddr.code.length == 0) return;

        try IFeeRouterViewMinimal(viewAddr).pushGlobalStatsUpdate(_totalDistributions, _totalAmountDistributed) {
            // success
        } catch {
            // best-effort
        }
    }

    /**
     * @notice 分发后推送用户与全局费用统计到 FeeRouterView（最佳努力）
     */
    function _pushFeeRouterViewAfterDistribution(
        address payer,
        address token,
        bytes32 feeType,
        uint256 totalAmount,
        uint256 appliedFeeBps
    ) internal {
        address viewAddr = _resolveFeeRouterViewAddr();
        if (viewAddr == address(0) || viewAddr.code.length == 0) return;

        try IFeeRouterViewMinimal(viewAddr).pushUserFeeUpdate(payer, feeType, totalAmount, appliedFeeBps) {
            // success
        } catch {
            // best-effort
        }

        try IFeeRouterViewMinimal(viewAddr).pushGlobalFeeStatistic(token, feeType, _feeStatistics[token][feeType]) {
            // success
        } catch {
            // best-effort
        }
    }

    /**
     * @notice 复制当前支持的代币列表到内存
     */
    function _copySupportedTokens() internal view returns (address[] memory tokens) {
        uint256 len = _supportedTokens.length;
        tokens = new address[](len);
        for (uint256 i = 0; i < len; i++) {
            tokens[i] = _supportedTokens[i];
        }
    }

    /**
     * @notice 执行费用分发和统计更新
     * @param token 代币地址
     * @param platformAmt 平台费用
     * @param ecoAmt 生态费用
     * @param remaining 剩余金额
     * @param feeType 费用类型
     * @param totalAmount 总金额（用于统计）
     */
    function _executeFeeDistribution(
        address token,
        uint256 platformAmt,
        uint256 ecoAmt,
        uint256 remaining,
        bytes32 feeType,
        uint256 totalAmount,
        address payer,
        uint256 appliedFeeBps
    ) internal {
        // 先从调用者地址拉取全部费用金额（需要调用者预先 approve 给本合约）
        if (totalAmount > 0) {
            IERC20(token).safeTransferFrom(msg.sender, address(this), totalAmount);
        }

        // 分发费用
        if (platformAmt > 0) {
            IERC20(token).safeTransfer(_platformTreasury, platformAmt);
        }
        if (ecoAmt > 0) {
            IERC20(token).safeTransfer(_ecosystemVault, ecoAmt);
        }
        if (remaining > 0) {
            // 余量返还给调用者（通常是资金池/编排合约）
            IERC20(token).safeTransfer(msg.sender, remaining);
        }

        // 更新统计和缓存
        _feeStatistics[token][feeType] += totalAmount;
        _feeCache[token][feeType] += totalAmount;
        _pushFeeRouterViewAfterDistribution(payer, token, feeType, totalAmount, appliedFeeBps);

        emit FeeDistributed(token, platformAmt, ecoAmt);
        emit FeeStatisticsUpdated(token, feeType, _feeStatistics[token][feeType]);
		// 统一数据推送
		DataPushLibrary._emitData(
			DataPushTypes.DATA_TYPE_FEE_DISTRIBUTED,
			abi.encode(token, platformAmt, ecoAmt, remaining, feeType, totalAmount, msg.sender, block.timestamp)
		);
    }



    /**
     * @notice 升级授权函数
     * @param newImpl 新实现地址
     */
    function _authorizeUpgrade(address newImpl) internal override {
        _requireRole(ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
        _emitActionExecuted(ActionKeys.ACTION_UPGRADE_MODULE);
        newImpl; // silence unused parameter
    }

    /*━━━━━━━━━━━━━━━ GAP ━━━━━━━━━━━━━━━*/
    uint256[32] private __gap; // 调整为32以适应新增的存储变量
}



 