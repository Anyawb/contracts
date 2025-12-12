// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { RewardPoints } from "../Token/RewardPoints.sol";
import { IAccessControlManager } from "../interfaces/IAccessControlManager.sol";
import { RewardManagerCore } from "./RewardManagerCore.sol";
import { IRewardManager } from "../interfaces/IRewardManager.sol";
import { ActionKeys } from "../constants/ActionKeys.sol";
import { ModuleKeys } from "../constants/ModuleKeys.sol";
import { VaultTypes } from "../Vault/VaultTypes.sol";
import { Registry } from "../registry/Registry.sol";
import {
    ZeroAddress,
    NotGovernance,
    MissingRole,
    RewardManager__ZeroAddress,
    RewardManager__MissingMinterRole,
    ExternalModuleRevertedRaw
} from "../errors/StandardErrors.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";

/// @title RewardManager - 积分管理统一入口
/// @notice 整合积分计算、发放、惩罚和查询功能
/// @dev 遵循 docs/SmartContractStandard.md 注释规范
/// @dev 使用 ActionKeys 进行标准化动作标识
/// @dev 使用 ModuleKeys 进行模块地址管理
/// @dev 使用 VaultTypes 进行标准化事件记录
/// @dev 使用 StandardErrors 进行统一错误处理
/// @dev 通过 Registry 进行模块地址获取
contract RewardManager is Initializable, UUPSUpgradeable, ReentrancyGuardUpgradeable, IRewardManager {
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Registry 合约地址（私有存储，提供 getter）
    address private _registryAddr;
    
    /// @notice 奖励率（基点，10000 = 100%）（私有存储）
    uint256 private _rewardRate;

    /// @notice 初始化合约
    /// @param initialRegistryAddr Registry 合约地址
    function initialize(address initialRegistryAddr) external initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        _registryAddr = initialRegistryAddr;
        _rewardRate = 100; // 默认 1%
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
    }

    // ========== 修饰符 ==========

    /// @dev 验证Registry地址有效性
    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        _;
    }

    // ========== 权限管理 ==========

    /// @dev 权限校验内部函数
    /// @param actionKey 动作键
    /// @param user 用户地址
    function _requireRole(bytes32 actionKey, address user) internal view {
        address acmAddr = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        IAccessControlManager(acmAddr).requireRole(actionKey, user);
    }

    // ========== 内部模块获取 ==========

    /// @dev 获取积分代币合约
    function _getRewardToken() internal view returns (RewardPoints) {
        return RewardPoints(Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_REWARD_POINTS));
    }

    /// @dev 获取核心业务合约
    function _getRewardManagerCore() internal view returns (RewardManagerCore) {
        return RewardManagerCore(Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_REWARD_MANAGER_CORE));
    }

    // ========== 公共接口 ==========

    /// @notice 兼容旧入口：VaultBusinessLogic 的通知入口（不再发放积分）
    /// @dev 仅允许 KEY_LE 或 KEY_VAULT_BUSINESS_LOGIC 调用；当来源为 VBL 时直接返回
    /// @param user 操作用户
    /// @param debtChange 借款变化量（+ 借款，- 还款）
    /// @param collateralChange 抵押变化量（+ 存，- 取）
    function onLoanEvent(address user, int256 debtChange, int256 collateralChange) external onlyValidRegistry nonReentrant {
        // 调用者白名单：LE 或 VBL
        address lendingEngine = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_LE);
        address vbl = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_VAULT_BUSINESS_LOGIC);
        if (msg.sender != lendingEngine && msg.sender != vbl) revert MissingRole();

        // 兼容旧通知：来自 VBL 的调用不触发发放，直接返回，确保“落账后触发”为准
        if (msg.sender == vbl) {
            return;
        }

        // 来自 LE 的调用才允许下沉到统一入口（已在 uint 版本入口再次校验）
        uint256 amount = debtChange > 0 ? uint256(debtChange) : 0;
        uint256 duration = 0;
        bool hfHighEnough = true;
        collateralChange; // silence unused
        _getRewardManagerCore().onLoanEvent(user, amount, duration, hfHighEnough);

        // 记录标准化动作事件（来自 LE 且有意义的情况下）
        if (debtChange > 0) {
            emit VaultTypes.ActionExecuted(
                ActionKeys.ACTION_BORROW,
                ActionKeys.getActionKeyString(ActionKeys.ACTION_BORROW),
                user,
                block.timestamp
            );
        } else if (debtChange < 0) {
            emit VaultTypes.ActionExecuted(
                ActionKeys.ACTION_REPAY,
                ActionKeys.getActionKeyString(ActionKeys.ACTION_REPAY),
                user,
                block.timestamp
            );
        }
    }

    /// @notice 实现 IRewardManager 接口的 setRewardRate 函数
    /// @param newRate 新的奖励率（基点，10000 = 100%）
    function setRewardRate(uint256 newRate) external onlyValidRegistry nonReentrant {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        if (newRate > 10000) revert(); // 最大 100%
        
        _rewardRate = newRate;
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
    }

    /// @notice 实现 IRewardManager 接口的 getRewardRate 函数
    /// @return 当前奖励率（基点）
    function getRewardRate() external view returns (uint256) {
        return _rewardRate;
    }

    /// @notice 实现 IRewardManager 接口的 getUserReward 函数
    /// @param user 用户地址
    /// @return 用户的奖励数量
    function getUserReward(address user) external view returns (uint256) {
        return _getRewardToken().balanceOf(user);
    }

    /// @notice LendingEngine 在 borrow 或 repay 后调用此函数
    /// @param user 用户地址
    /// @param amount 借款金额 (18 位精度)
    /// @param duration 借款时长（秒），borrow 时可填 0
    /// @param hfHighEnough 是否提前还款
    function onLoanEvent(address user, uint256 amount, uint256 duration, bool hfHighEnough) external onlyValidRegistry nonReentrant {
        // 通过 Registry 获取 LendingEngine 地址进行权限验证
        address lendingEngine = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_LE);
        if (msg.sender != lendingEngine) revert MissingRole();
        
        _getRewardManagerCore().onLoanEvent(user, amount, duration, hfHighEnough);
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_BORROW,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_BORROW),
            user,
            block.timestamp
        );
    }

    /// @notice 批量处理借贷事件 - 大幅提升性能
    /// @param users 用户地址数组
    /// @param amounts 借款金额数组
    /// @param durations 借款时长数组
    /// @param hfHighEnoughs 提前还款标志数组
    function onBatchLoanEvents(
        address[] calldata users,
        uint256[] calldata amounts,
        uint256[] calldata durations,
        bool[] calldata hfHighEnoughs
    ) external onlyValidRegistry {
        // 通过 Registry 获取 LendingEngine 地址进行权限验证
        address lendingEngine = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_LE);
        if (msg.sender != lendingEngine) revert MissingRole();
        
        _getRewardManagerCore().onBatchLoanEvents(users, amounts, durations, hfHighEnoughs);
        
        // 记录批量操作事件
        for (uint256 i = 0; i < users.length; i++) {
            emit VaultTypes.ActionExecuted(
                ActionKeys.ACTION_BATCH_BORROW,
                ActionKeys.getActionKeyString(ActionKeys.ACTION_BATCH_BORROW),
                users[i],
                block.timestamp
            );
        }
    }

    /// @notice 惩罚用户积分（清算模块调用）
    /// @param user 用户地址
    /// @param points 扣除积分数量
    function applyPenalty(address user, uint256 points) external onlyValidRegistry {
        // 通过 Registry 获取清算相关模块地址进行权限验证
        address guaranteeFundManager = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_GUARANTEE_FUND);
        if (msg.sender != guaranteeFundManager) revert MissingRole();
        
        // 调用核心合约的惩罚功能
        _getRewardManagerCore().deductPoints(user, points);
        
        // 使用标准化事件记录惩罚
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_LIQUIDATE,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_LIQUIDATE),
            user,
            block.timestamp
        );
    }

    // ========== 查询接口 ==========

    /// @notice 获取用户积分缓存
    /// @param user 用户地址
    /// @return points 缓存的积分数量
    function getPointCache(address user) external view returns (uint256 points) {
        (points, , ) = _getRewardManagerCore().getUserCache(user);
        return points;
    }

    /// @notice 获取用户等级
    /// @param user 用户地址
    /// @return level 用户等级
    function getUserLevel(address user) external view returns (uint8 level) {
        return _getRewardManagerCore().getUserLevel(user);
    }

    /// @notice 获取用户活跃度信息
    /// @param user 用户地址
    /// @return lastActivity 最后活跃时间
    /// @return totalLoans 总借款次数
    /// @return totalVolume 总借款金额
    function getUserActivity(address user) external view returns (
        uint256 lastActivity,
        uint256 totalLoans,
        uint256 totalVolume
    ) {
        return _getRewardManagerCore().getUserActivity(user);
    }

    /// @notice 获取等级倍数
    /// @param level 等级
    /// @return multiplier 倍数 (BPS)
    function getLevelMultiplier(uint8 level) external view returns (uint256 multiplier) {
        return _getRewardManagerCore().getLevelMultiplier(level);
    }

    /// @notice 获取用户欠分
    /// @param user 用户地址
    /// @return debt 欠分数量
    function getUserPenaltyDebt(address user) external view returns (uint256 debt) {
        return _getRewardManagerCore().getUserPenaltyDebt(user);
    }

    /// @notice 获取系统统计信息
    /// @return totalBatchOps 总批量操作次数
    /// @return totalCachedRewards 总缓存奖励次数
    /// @return dynamicThreshold 动态奖励阈值
    /// @return dynamicMultiplier 动态奖励倍数
    function getSystemStats() external view returns (
        uint256 totalBatchOps,
        uint256 totalCachedRewards,
        uint256 dynamicThreshold,
        uint256 dynamicMultiplier
    ) {
        totalBatchOps = _getRewardManagerCore().getTotalBatchOperations();
        totalCachedRewards = _getRewardManagerCore().getTotalCachedRewards();
        {
            RewardManagerCore.DynamicRewardParams memory p = _getRewardManagerCore().getDynamicRewardParameters();
            dynamicThreshold = p.threshold;
            dynamicMultiplier = p.multiplier;
        }
    }

    /// @notice 获取Registry地址
    /// @return registry 当前Registry地址
    function getRegistry() external view returns (address registry) {
        return _registryAddr;
    }

    // ========== 管理接口 ==========

    /// @notice 更新奖励参数
    /// @param baseEth 基础分/ETH
    /// @param perDay 每天积分
    /// @param bonus 提前还款奖励
    /// @param baseUsd 基础分/100 USD
    function updateRewardParameters(
        uint256 baseEth,
        uint256 perDay,
        uint256 bonus,
        uint256 baseUsd
    ) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        
        // 调用核心合约更新参数
        _getRewardManagerCore().updateRewardParameters(baseUsd, perDay, bonus, baseEth);
    }

    /// @notice 更新等级倍数
    /// @param level 等级
    /// @param newMultiplier 倍数 (BPS)
    function setLevelMultiplier(uint8 level, uint256 newMultiplier) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        if (level == 0 || level > 5) revert();
        if (newMultiplier < 10000 || newMultiplier > 50000) revert();
        
        // 调用核心合约更新等级倍数
        _getRewardManagerCore().updateLevelMultiplier(level, newMultiplier);
    }

    /// @notice 更新动态奖励参数
    /// @param newThreshold 阈值
    /// @param newMultiplier 倍数 (BPS)
    function setDynamicRewardParams(uint256 newThreshold, uint256 newMultiplier) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        
        // 调用核心合约更新动态奖励参数
        _getRewardManagerCore().updateDynamicRewardParameters(newThreshold, newMultiplier);
    }

    /// @notice 设置缓存过期时间
    /// @param newExpirationTime 过期时间 (秒)
    function setCacheExpirationTime(uint256 newExpirationTime) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        
        // 调用核心合约设置缓存过期时间
        _getRewardManagerCore().updateCacheExpirationTime(newExpirationTime);
    }

    /// @notice 清除用户缓存
    /// @param user 用户地址
    function clearUserCache(address user) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        
        // 调用核心合约清除用户缓存
        _getRewardManagerCore().clearUserCache(user);
    }

    /// @notice 更新用户等级
    /// @param user 用户地址
    /// @param newLevel 新等级 (1-5)
    function updateUserLevel(address user, uint8 newLevel) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        
        // 调用核心合约更新用户等级
        _getRewardManagerCore().updateUserLevel(user, newLevel);
    }

    /// @notice 设置健康因子奖励
    /// @param newBonus 健康因子奖励 (BPS, 500 = 5%)
    function setHealthFactorBonus(uint256 newBonus) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        
        // 调用核心合约设置健康因子奖励
        _getRewardManagerCore().setHealthFactorBonus(newBonus);
    }

    /// @notice 重置动态奖励时间
    function resetDynamicRewardTime() external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        
        // 调用核心合约重置动态奖励时间
        _getRewardManagerCore().resetDynamicRewardTime();
    }

    /// @notice 设置按期窗口（秒）
    function setOnTimeWindow(uint256 newWindow) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        _getRewardManagerCore().setOnTimeWindow(newWindow);
    }

    /// @notice 设置提前/逾期扣罚（BPS）
    function setPenaltyBps(uint256 earlyBps, uint256 lateBps) external onlyValidRegistry {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        _getRewardManagerCore().setPenaltyBps(earlyBps, lateBps);
    }

    // ========== 计算接口 ==========

    /// @notice 计算示例积分（用于测试和验证）
    /// @param amount 借款金额 (USDT, 6位小数)
    /// @param duration 借款期限 (秒)
    /// @param hfHighEnough 健康因子是否足够
    /// @return basePoints 基础积分
    /// @return bonus 奖励积分
    /// @return totalPoints 总积分
    function calculateExamplePoints(uint256 amount, uint256 duration, bool hfHighEnough) external view returns (uint256 basePoints, uint256 bonus, uint256 totalPoints) {
        return _getRewardManagerCore().calculateExamplePoints(amount, duration, hfHighEnough);
    }

    // ========== 查询接口（与架构一致：仅保留入口职责；只读查询迁移至 RewardView） ==========

    /// @notice 升级授权函数
    /// @dev onlyRole modifier 已经足够验证权限
    /// @dev 如需接入 Timelock/Multisig 治理，应在此处增加相应的权限检查逻辑
    function _authorizeUpgrade(address) internal view override {
        _requireRole(ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
    }
} 