// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { RewardPoints } from "../Token/RewardPoints.sol";
import { IAccessControlManager } from "../interfaces/IAccessControlManager.sol";
import { Registry } from "../registry/Registry.sol";
import { ActionKeys } from "../constants/ActionKeys.sol";
import { ModuleKeys } from "../constants/ModuleKeys.sol";
import { VaultTypes } from "../Vault/VaultTypes.sol";
import {
    ZeroAddress,
    NotGovernance,
    MissingRole,
    InvalidCaller,
    InsufficientBalance,
    ExternalModuleRevertedRaw
} from "../errors/StandardErrors.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import { RewardModuleBase } from "./internal/RewardModuleBase.sol";

/// @title RewardManagerCore - 积分管理核心业务逻辑
/// @notice 处理积分计算、发放和批量操作的核心逻辑
/// @dev 遵循 docs/SmartContractStandard.md 注释规范，标准化所有动作、模块、事件、错误、合约地址获取
/// @dev 使用 ActionKeys 进行标准化动作标识和权限验证
/// @dev 使用 ModuleKeys 进行模块地址管理
/// @dev 使用 VaultTypes 进行标准化事件记录
/// @dev 通过 Registry 进行模块地址获取，确保架构一致性
/// @dev 积分计算公式：
/// @dev BasePoints = 金额_USDT ÷ 100 × 期限_天 ÷ 5
/// @dev Bonus = BasePoints × 5%（当且仅当借款全过程 HealthFactor ≥ 1.5）
/// @dev Total = BasePoints + Bonus

contract RewardManagerCore is Initializable, UUPSUpgradeable, ReentrancyGuardUpgradeable, RewardModuleBase {
    /// @notice 入口收紧引导错误（用于提示外部调用者应通过 RewardManager 调用）
    error RewardManagerCore__UseRewardManagerEntry();
    /// @notice DEPRECATED：检测到直接调用核心入口，将被拒绝
    event DeprecatedDirectEntryAttempt(address indexed caller, uint256 timestamp);
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Registry 合约地址（私有存储，提供显式 getter）
    address private _registryAddr;

    /// @notice 基础积分权重参数（私有存储，提供显式 getter）
    uint256 private _basePointPerHundredUsd; // 每 100 USD 稳定币借款基础分
    uint256 private _durationPointPerDay;  // 每借款 1 天的积分
    uint256 private _earlyRepayBonus;      // Bonus BPS (0–10000)，默认 500 (=5%)
    uint256 private _basePointPerEth;      // 每 1 ETH 借款的基础分（保留兼容性）

    /// @notice 欠分账本：记录用户被扣但余额不足的积分（私有存储）
    mapping(address => uint256) private _penaltyLedger;

    // ========== 新增高级功能 ==========
    
    /// @notice 用户等级系统 (1-5级，5级最高)
    mapping(address => uint8) private _userLevels;
    
    /// @notice 等级对应的积分倍数 (BPS, 10000 = 1x)
    mapping(uint8 => uint256) private _levelMultipliers;
    
    /// @notice 动态奖励参数
    uint256 private _dynamicRewardThreshold; // 触发动态奖励的阈值
    uint256 private _dynamicRewardMultiplier; // 动态奖励倍数 (BPS)
    uint256 private _lastRewardResetTime; // 上次重置时间
    
    /// @notice 积分缓存系统
    struct PointCache {
        uint256 points;
        uint256 timestamp;
        bool isValid;
    }
    
    mapping(address => PointCache) private _pointCache;
    uint256 private _cacheExpirationTime; // 缓存过期时间
    
    /// @notice 批量操作统计
    uint256 private _totalBatchOperations;
    uint256 private _totalCachedRewards;
    
    /// @notice 用户活跃度追踪
    mapping(address => uint256) private _userLastActivity;
    mapping(address => uint256) private _userTotalLoans;
    mapping(address => uint256) private _userTotalVolume;

    // ========== 锁定-释放 与 扣罚参数 ==========
    /// @notice 用户锁定积分余额（按用户汇总，最小化改动）
    mapping(address => uint256) private _lockedPoints;
    /// @notice 用户当前锁定的目标到期时间（以最近一次借款为准，最小化改动）
    mapping(address => uint256) private _lockedMaturity;
    /// @notice 按期窗口（秒），默认 24 小时
    uint256 private _onTimeWindow;
    /// @notice 提前还款扣罚（BPS）默认 3% = 300
    uint256 private _earlyPenaltyBps;
    /// @notice 逾期还款扣罚（BPS）默认 5% = 500
    uint256 private _latePenaltyBps;
    /// @notice 合格借款计数（本金≥1000USDT）
    mapping(address => uint256) private _eligibleLoanCount;
    /// @notice 按期履约计数
    mapping(address => uint256) private _onTimeRepayCount;

    // ========== 事件定义 ==========
    
    /// @notice 积分参数更新事件
    event RewardParametersUpdated(
        bytes32 indexed actionKey,
        uint256 basePointPerHundredUsd,
        uint256 durationPointPerDay,
        uint256 earlyRepayBonus,
        uint256 basePointPerEth,
        address indexed updatedBy,
        uint256 timestamp
    );

    /// @notice 用户等级更新事件
    event UserLevelUpdated(
        bytes32 indexed actionKey,
        address indexed user,
        uint8 oldLevel,
        uint8 newLevel,
        address indexed updatedBy,
        uint256 timestamp
    );

    /// @notice 动态奖励参数更新事件
    event DynamicRewardParametersUpdated(
        bytes32 indexed actionKey,
        uint256 threshold,
        uint256 multiplier,
        address indexed updatedBy,
        uint256 timestamp
    );

    /// @notice 缓存参数更新事件
    event CacheParametersUpdated(
        bytes32 indexed actionKey,
        uint256 expirationTime,
        address indexed updatedBy,
        uint256 timestamp
    );

    /// @notice 惩罚积分扣除事件
    event PenaltyPointsDeducted(
        bytes32 indexed actionKey,
        address indexed user,
        uint256 points,
        uint256 remainingDebt,
        address indexed deductedBy,
        uint256 timestamp
    );

    /// @notice 批量操作完成事件
    event BatchOperationCompleted(
        bytes32 indexed actionKey,
        uint256 totalUsers,
        uint256 totalPoints,
        address indexed operator,
        uint256 timestamp
    );

    /// @notice 初始化
    /// @param initialRegistryAddr Registry 合约地址
    /// @param baseUsd 基础分/100 USD
    /// @param perDay 每天积分
    /// @param bonus 健康因子奖励 (BPS, 默认500=5%)
    /// @param baseEth 基础分/ETH（保留兼容性）
    function initialize(address initialRegistryAddr, uint256 baseUsd, uint256 perDay, uint256 bonus, uint256 baseEth) external initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        _registryAddr = initialRegistryAddr;
        _basePointPerHundredUsd = baseUsd;
        _durationPointPerDay = perDay;
        _earlyRepayBonus = bonus;
        _basePointPerEth = baseEth;

        // 初始化等级倍数
        _levelMultipliers[1] = 10000; // 1x
        _levelMultipliers[2] = 11000; // 1.1x
        _levelMultipliers[3] = 12500; // 1.25x
        _levelMultipliers[4] = 15000; // 1.5x
        _levelMultipliers[5] = 20000; // 2x
        
        // 初始化动态奖励参数
        _dynamicRewardThreshold = 1000e18; // 1000积分阈值
        _dynamicRewardMultiplier = 12000; // 1.2x倍数
        _lastRewardResetTime = block.timestamp;
        
        // 设置默认健康因子奖励为5%（500 BPS）
        if (_earlyRepayBonus == 0) {
            _earlyRepayBonus = 500; // 5% = 500 BPS
        }
        
        // 初始化缓存过期时间
        _cacheExpirationTime = 1 hours;
        // 锁定/扣罚默认参数
        _onTimeWindow = 1 days;
        _earlyPenaltyBps = 300;
        _latePenaltyBps = 500;

        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
    }

    // ========== 修饰符 ==========

    /// @dev 验证Registry地址有效性（由基类 onlyValidRegistry 提供）

    // ========== 权限管理 ==========

    /// @dev 权限校验内部函数（由基类 _requireRole 提供）

    // ========== 内部模块获取 ==========

    /// @dev 获取积分代币合约（由基类 _getRewardToken 提供）

    // ========== 公共接口 ==========

    /// @notice LendingEngine 在 borrow 或 repay 后调用此函数
    /// @param user 用户地址
    /// @param amount 借款金额
    /// @param duration 借款时长
    /// @param hfHighEnough 健康因子是否足够
    function onLoanEvent(address user, uint256 amount, uint256 duration, bool hfHighEnough) external nonReentrant onlyValidRegistry {
        // 收紧入口：仅允许 RewardManager 调用，统一路径为 LE -> RM -> RMCore
        address rewardManager = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_RM);
        if (msg.sender != rewardManager) {
            // 使用自定义错误进行 DEPRECATED 引导，提示调用方改为通过 RewardManager
            emit DeprecatedDirectEntryAttempt(msg.sender, block.timestamp);
            revert RewardManagerCore__UseRewardManagerEntry();
        }
        
        // 合格借款门槛：< 1000 USDT/USDC 的本金不计分（仍统计活跃度）
        // 注意：amount 采用 6 位精度的稳定币最小单位；1000 USDT = 1000 * 1e6
        if (duration > 0 && amount < 1000 * 1e6) {
            // 仅更新活跃度，直接返回
            _updateUserActivity(user, amount);
            return;
        }
        // 新规则：借款（duration>0）仅锁定积分，不立即发放；还款（duration=0）释放或作废并扣罚
        uint256 points = _calculatePointsWithCache(user, amount, duration, hfHighEnough);
        _updateUserActivity(user, amount);

        if (duration > 0) {
            // 借款：增加合格借款计数与锁定积分（若 points>0）
            if (amount >= 1000 * 1e6 && points > 0) {
                _eligibleLoanCount[user] += 1;
                _lockedPoints[user] += points;
                // 借款时以 duration 推导 maturity：取“最近一次”即可
                _lockedMaturity[user] = block.timestamp + duration;
            }
            return;
        }

        // 还款：根据 hfHighEnough（按期且足额）决定释放或扣罚
        if (hfHighEnough) {
            uint256 locked = _lockedPoints[user];
            if (locked > 0) {
                // 先抵扣欠分
                uint256 debt = _penaltyLedger[user];
                uint256 toMint = locked;
                if (debt > 0) {
                    if (toMint >= debt) {
                        toMint -= debt;
                        _penaltyLedger[user] = 0;
                        emit PenaltyPointsDeducted(
                            ActionKeys.ACTION_CLAIM_REWARD,
                            user,
                            debt,
                            0,
                            msg.sender,
                            block.timestamp
                        );
                    } else {
                        _penaltyLedger[user] = debt - toMint;
                        emit PenaltyPointsDeducted(
                            ActionKeys.ACTION_CLAIM_REWARD,
                            user,
                            toMint,
                            _penaltyLedger[user],
                            msg.sender,
                            block.timestamp
                        );
                        toMint = 0;
                    }
                }

                if (toMint > 0) {
                    try _getRewardToken().mintPoints(user, toMint) {
                        emit VaultTypes.ActionExecuted(
                            ActionKeys.ACTION_CLAIM_REWARD,
                            ActionKeys.getActionKeyString(ActionKeys.ACTION_CLAIM_REWARD),
                            user,
                            block.timestamp
                        );
                        emit VaultTypes.RewardEarned(user, toMint, "OnTimeRelease", block.timestamp);
                        _tryPushRewardEarned(user, toMint, "OnTimeRelease");
                    } catch {
                        revert ExternalModuleRevertedRaw("RewardPoints", "");
                    }
                }

                // 清空锁定并增加履约计数
                _lockedPoints[user] = 0;
                _lockedMaturity[user] = 0;
                _onTimeRepayCount[user] += 1;
            }
            return;
        }

        // 非按期足额：作废锁定并扣罚（提前或逾期）
        uint256 lockedPoints = _lockedPoints[user];
        if (lockedPoints > 0) {
            // 清空锁定
            _lockedPoints[user] = 0;
            uint256 m = _lockedMaturity[user];
            _lockedMaturity[user] = 0;

            // 判定提前/逾期：按当前时间与 maturity 比较（容忍窗口）
            uint256 nowTs = block.timestamp;
            bool isEarly = (nowTs + _onTimeWindow < m);
            uint256 bps = isEarly ? _earlyPenaltyBps : _latePenaltyBps;
            if (bps > 0) {
                uint256 penalty = (lockedPoints * bps) / 10000;
                // 尝试直接烧分；不足则记入欠分账本
                try _getRewardToken().burnPoints(user, penalty) {
                    emit VaultTypes.ActionExecuted(
                        ActionKeys.ACTION_LIQUIDATE,
                        ActionKeys.getActionKeyString(ActionKeys.ACTION_LIQUIDATE),
                        user,
                        block.timestamp
                    );
                    _tryPushPointsBurned(user, penalty, isEarly ? "EarlyPenalty" : "LatePenalty");
                } catch {
                    // 记录欠分
                    _penaltyLedger[user] += penalty;
                    emit PenaltyPointsDeducted(
                        ActionKeys.ACTION_LIQUIDATE,
                        user,
                        0,
                        _penaltyLedger[user],
                        msg.sender,
                        block.timestamp
                    );
                    _tryPushPenaltyLedger(user, _penaltyLedger[user]);
                }
            }
        }
    }

    /// @notice 批量处理借贷事件
    /// @param users 用户地址数组
    /// @param amounts 借款金额数组
    /// @param durations 借款时长数组
    /// @param hfHighEnoughs 健康因子是否足够数组
    function onBatchLoanEvents(
        address[] calldata users,
        uint256[] calldata amounts,
        uint256[] calldata durations,
        bool[] calldata hfHighEnoughs
    ) external nonReentrant onlyValidRegistry {
        // 收紧入口：仅允许 RewardManager 调用，统一路径为 LE -> RM -> RMCore
        address rewardManager = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_RM);
        if (msg.sender != rewardManager) {
            // 使用自定义错误进行 DEPRECATED 引导，提示调用方改为通过 RewardManager
            emit DeprecatedDirectEntryAttempt(msg.sender, block.timestamp);
            revert RewardManagerCore__UseRewardManagerEntry();
        }
        
        if (users.length == 0 || users.length > 100) revert InvalidCaller();
        if (users.length != amounts.length || users.length != durations.length || users.length != hfHighEnoughs.length) {
            revert InvalidCaller();
        }
        
        uint256 totalPoints = 0;
        uint256[] memory pointAmounts = new uint256[](users.length);
        
        for (uint256 i = 0; i < users.length; i++) {
            uint256 points = _calculatePointsWithCache(users[i], amounts[i], durations[i], hfHighEnoughs[i]);
            pointAmounts[i] = points;
            totalPoints += points;
            _updateUserActivity(users[i], amounts[i]);
        }
        
        for (uint256 i = 0; i < users.length; i++) {
            if (pointAmounts[i] > 0) {
                uint256 debt = _penaltyLedger[users[i]];
                if (debt > 0) {
                    if (pointAmounts[i] >= debt) {
                        pointAmounts[i] -= debt;
                        _penaltyLedger[users[i]] = 0;
                        emit PenaltyPointsDeducted(
                            ActionKeys.ACTION_CLAIM_REWARD,
                            users[i],
                            debt,
                            0,
                            msg.sender,
                            block.timestamp
                        );
                        _tryPushPenaltyLedger(users[i], 0);
                    } else {
                        _penaltyLedger[users[i]] = debt - pointAmounts[i];
                        emit PenaltyPointsDeducted(
                            ActionKeys.ACTION_CLAIM_REWARD,
                            users[i],
                            pointAmounts[i],
                            _penaltyLedger[users[i]],
                            msg.sender,
                            block.timestamp
                        );
                        _tryPushPenaltyLedger(users[i], _penaltyLedger[users[i]]);
                        pointAmounts[i] = 0;
                    }
                }
                
                if (pointAmounts[i] > 0) {
                    try _getRewardToken().mintPoints(users[i], pointAmounts[i]) {
                        emit VaultTypes.ActionExecuted(
                            ActionKeys.ACTION_CLAIM_REWARD,
                            ActionKeys.getActionKeyString(ActionKeys.ACTION_CLAIM_REWARD),
                            users[i],
                            block.timestamp
                        );
                        emit VaultTypes.RewardEarned(users[i], pointAmounts[i], "Batch Loan Event", block.timestamp);
                        _tryPushRewardEarned(users[i], pointAmounts[i], "Batch Loan Event");
                    } catch {
                        revert ExternalModuleRevertedRaw("RewardPoints", "");
                    }
                }
            }
        }
        
        _totalBatchOperations++;
        emit BatchOperationCompleted(
            ActionKeys.ACTION_CLAIM_REWARD,
            users.length,
            totalPoints,
            msg.sender,
            block.timestamp
        );
        _tryPushSystemStats(_totalBatchOperations, _totalCachedRewards);
    }

    /// @notice 扣除用户积分（仅清算/惩罚模块可调用）
    /// @param user 用户地址
    /// @param points 扣除积分数量
    function deductPoints(address user, uint256 points) external nonReentrant onlyValidRegistry {
        // 检查调用者权限 - 只允许清算/惩罚模块或 RewardManager 调用
        address guaranteeFundManager = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_GUARANTEE_FUND);
        address rewardManager = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_RM);
        if (msg.sender != guaranteeFundManager && msg.sender != rewardManager) {
            revert MissingRole();
        }
        
        if (points == 0) revert InvalidCaller();
        
        try _getRewardToken().burnPoints(user, points) {
            emit VaultTypes.ActionExecuted(
                ActionKeys.ACTION_LIQUIDATE,
                ActionKeys.getActionKeyString(ActionKeys.ACTION_LIQUIDATE),
                user,
                block.timestamp
            );
            _tryPushPointsBurned(user, points, "Penalty Burn");
        } catch {
            // 如果积分不足，记录到惩罚账本
            _penaltyLedger[user] += points;
            emit PenaltyPointsDeducted(
                ActionKeys.ACTION_LIQUIDATE,
                user,
                0,
                _penaltyLedger[user],
                msg.sender,
                block.timestamp
            );
            _tryPushPenaltyLedger(user, _penaltyLedger[user]);
        }
    }

    // ========== 管理接口 ==========

    /// @notice 更新积分参数
    /// @param baseUsd 基础分/100 USD
    /// @param perDay 每天积分
    /// @param bonus 健康因子奖励 (BPS)
    /// @param baseEth 基础分/ETH（保留兼容性）
    function updateRewardParameters(
        uint256 baseUsd,
        uint256 perDay,
        uint256 bonus,
        uint256 baseEth
    ) external onlyValidRegistry {
        // 检查调用者权限 - 只允许 RewardManager 调用
        address rewardManager = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_RM);
        if (msg.sender != rewardManager) {
            revert MissingRole();
        }
        
        _basePointPerHundredUsd = baseUsd;
        _durationPointPerDay = perDay;
        _earlyRepayBonus = bonus;
        _basePointPerEth = baseEth;
        
        emit RewardParametersUpdated(
            ActionKeys.ACTION_SET_PARAMETER,
            baseUsd,
            perDay,
            bonus,
            baseEth,
            msg.sender,
            block.timestamp
        );
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
    }

    /// @notice 设置按期窗口（秒）
    function setOnTimeWindow(uint256 newWindow) external onlyValidRegistry {
        address rewardManager = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_RM);
        if (msg.sender != rewardManager) revert MissingRole();
        _onTimeWindow = newWindow;
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
    }

    /// @notice 设置提前/逾期扣罚（BPS）
    function setPenaltyBps(uint256 earlyBps, uint256 lateBps) external onlyValidRegistry {
        address rewardManager = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_RM);
        if (msg.sender != rewardManager) revert MissingRole();
        _earlyPenaltyBps = earlyBps;
        _latePenaltyBps = lateBps;
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
    }

    /// @notice 更新用户等级
    /// @param user 用户地址
    /// @param newLevel 新等级 (1-5)
    function updateUserLevel(address user, uint8 newLevel) external onlyValidRegistry {
        // 检查调用者权限 - 只允许 RewardManager 调用
        address rewardManager = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_RM);
        if (msg.sender != rewardManager) {
            revert MissingRole();
        }
        
        if (newLevel < 1 || newLevel > 5) revert InvalidCaller();
        
        uint8 oldLevel = _userLevels[user];
        _userLevels[user] = newLevel;
        
        emit UserLevelUpdated(
            ActionKeys.ACTION_SET_PARAMETER,
            user,
            oldLevel,
            newLevel,
            msg.sender,
            block.timestamp
        );
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
    }

    /// @notice 更新等级倍数
    /// @param level 等级 (1-5)
    /// @param newMultiplier 倍数 (BPS)
    function updateLevelMultiplier(uint8 level, uint256 newMultiplier) external onlyValidRegistry {
        // 检查调用者权限 - 只允许 RewardManager 调用
        address rewardManager = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_RM);
        if (msg.sender != rewardManager) {
            revert MissingRole();
        }
        
        if (level < 1 || level > 5) revert InvalidCaller();
        if (newMultiplier == 0) revert InvalidCaller();
        
        _levelMultipliers[level] = newMultiplier;
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
    }

    /// @notice 更新动态奖励参数
    /// @param newThreshold 触发阈值
    /// @param newMultiplier 奖励倍数 (BPS)
    function updateDynamicRewardParameters(uint256 newThreshold, uint256 newMultiplier) external onlyValidRegistry {
        // 检查调用者权限 - 只允许 RewardManager 调用
        address rewardManager = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_RM);
        if (msg.sender != rewardManager) {
            revert MissingRole();
        }
        
        _dynamicRewardThreshold = newThreshold;
        _dynamicRewardMultiplier = newMultiplier;
        
        emit DynamicRewardParametersUpdated(
            ActionKeys.ACTION_SET_PARAMETER,
            newThreshold,
            newMultiplier,
            msg.sender,
            block.timestamp
        );
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
    }

    /// @notice 更新缓存过期时间
    /// @param newExpirationTime 过期时间 (秒)
    function updateCacheExpirationTime(uint256 newExpirationTime) external onlyValidRegistry {
        // 检查调用者权限 - 只允许 RewardManager 调用
        address rewardManager = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_RM);
        if (msg.sender != rewardManager) {
            revert MissingRole();
        }
        
        _cacheExpirationTime = newExpirationTime;
        
        emit CacheParametersUpdated(
            ActionKeys.ACTION_SET_PARAMETER,
            newExpirationTime,
            msg.sender,
            block.timestamp
        );
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
    }

    /// @notice 清除用户积分缓存
    /// @param user 用户地址
    function clearUserCache(address user) external onlyValidRegistry {
        // 检查调用者权限 - 只允许 RewardManager 调用
        address rewardManager = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_RM);
        if (msg.sender != rewardManager) {
            revert MissingRole();
        }
        
        delete _pointCache[user];
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
    }

    /// @notice 重置动态奖励时间
    function resetDynamicRewardTime() external onlyValidRegistry {
        // 检查调用者权限 - 只允许 RewardManager 调用
        address rewardManager = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_RM);
        if (msg.sender != rewardManager) {
            revert MissingRole();
        }
        
        _lastRewardResetTime = block.timestamp;
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
    }

    /// @notice 设置健康因子奖励
    /// @param newBonus 健康因子奖励 (BPS, 500 = 5%)
    function setHealthFactorBonus(uint256 newBonus) external onlyValidRegistry {
        // 检查调用者权限 - 只允许 RewardManager 调用
        address rewardManager = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_RM);
        if (msg.sender != rewardManager) {
            revert MissingRole();
        }
        
        _earlyRepayBonus = newBonus;
        
        // 记录标准化动作事件
        emit VaultTypes.ActionExecuted(
            ActionKeys.ACTION_SET_PARAMETER,
            ActionKeys.getActionKeyString(ActionKeys.ACTION_SET_PARAMETER),
            msg.sender,
            block.timestamp
        );
    }

    // ========== 查询接口 ==========

    /// @notice 查询用户等级
    /// @param user 用户地址
    /// @return level 用户等级
    function getUserLevel(address user) external view returns (uint8 level) {
        return _userLevels[user];
    }

    /// @notice 查询等级倍数
    /// @param level 等级
    /// @return multiplier 倍数
    function getLevelMultiplier(uint8 level) external view returns (uint256 multiplier) {
        return _levelMultipliers[level];
    }

    /// @notice 查询用户活跃度信息
    /// @param user 用户地址
    /// @return lastActivity 最后活跃时间
    /// @return totalLoans 总借款次数
    /// @return totalVolume 总借款金额
    function getUserActivity(address user) external view returns (uint256 lastActivity, uint256 totalLoans, uint256 totalVolume) {
        return (_userLastActivity[user], _userTotalLoans[user], _userTotalVolume[user]);
    }

    /// @notice 查询用户积分缓存
    /// @param user 用户地址
    /// @return points 缓存积分
    /// @return timestamp 缓存时间戳
    /// @return isValid 是否有效
    function getUserCache(address user) external view returns (uint256 points, uint256 timestamp, bool isValid) {
        PointCache storage cache = _pointCache[user];
        return (cache.points, cache.timestamp, cache.isValid);
    }

    /// @notice 查询积分计算参数
    /// @return baseUsd 基础分/100 USD
    /// @return perDay 每天积分
    /// @return bonus 健康因子奖励 (BPS)
    /// @return baseEth 基础分/ETH
    function getRewardParameters() external view returns (uint256 baseUsd, uint256 perDay, uint256 bonus, uint256 baseEth) {
        return (_basePointPerHundredUsd, _durationPointPerDay, _earlyRepayBonus, _basePointPerEth);
    }

    /// @notice 查询用户欠分
    function getUserPenaltyDebt(address user) external view returns (uint256) {
        return _penaltyLedger[user];
    }

    /// @notice 查询缓存过期时间
    function getCacheExpirationTime() external view returns (uint256) {
        return _cacheExpirationTime;
    }

    /// @notice 查询系统统计（批量操作与缓存命中次数）
    function getTotalBatchOperations() external view returns (uint256) {
        return _totalBatchOperations;
    }

    function getTotalCachedRewards() external view returns (uint256) {
        return _totalCachedRewards;
    }

    /// @notice 查询最后重置时间
    function getLastRewardResetTime() external view returns (uint256) {
        return _lastRewardResetTime;
    }

    /// @notice 计算示例积分（用于测试和验证）
    /// @param amount 借款金额 (USDT, 6位小数)
    /// @param duration 借款期限 (秒)
    /// @param hfHighEnough 健康因子是否足够
    /// @return basePoints 基础积分
    /// @return bonus 奖励积分
    /// @return totalPoints 总积分
    function calculateExamplePoints(uint256 amount, uint256 duration, bool hfHighEnough) external view returns (uint256 basePoints, uint256 bonus, uint256 totalPoints) {
        if (amount == 0) return (0, 0, 0);
        
        // BasePoints = 金额_USDT ÷ 100 × 期限_天 ÷ 5
        basePoints = (amount / 100) * (duration / 5);
        
        // 应用基础积分权重
        basePoints = (basePoints * _basePointPerHundredUsd) / 1e18;
        
        // Bonus = BasePoints × 5%（当且仅当借款全过程 HealthFactor ≥ 1.5）
        totalPoints = basePoints;
        if (hfHighEnough && _earlyRepayBonus > 0) {
            bonus = (basePoints * _earlyRepayBonus) / 10000;
            totalPoints += bonus;
        }
        
        return (basePoints, bonus, totalPoints);
    }

    /// @notice 获取Registry地址
    /// @return registry 当前Registry地址
    function getRegistry() external view returns (address registry) {
        return _registryAddr;
    }

    // ========== 内部函数 ==========

    /// @dev 计算积分（带缓存）
    function _calculatePointsWithCache(address user, uint256 amount, uint256 duration, bool hfHighEnough) internal returns (uint256) {
        PointCache storage cache = _pointCache[user];
        if (cache.isValid && block.timestamp < cache.timestamp + _cacheExpirationTime) {
            _totalCachedRewards++;
            return cache.points;
        }
        uint256 points = _calculatePoints(user, amount, duration, hfHighEnough);
        cache.points = points;
        cache.timestamp = block.timestamp;
        cache.isValid = true;
        emit VaultTypes.PerformanceMonitor("PointCacheUpdated", points, block.timestamp);
        return points;
    }

    /// @dev 计算积分
    /// @dev 按照公式：BasePoints = 金额_USDT ÷ 100 × 期限_天 ÷ 5
    /// @dev Bonus = BasePoints × 5%（当且仅当借款全过程 HealthFactor ≥ 1.5）
    /// @dev Total = BasePoints + Bonus
    function _calculatePoints(address user, uint256 amount, uint256 duration, bool hfHighEnough) internal view returns (uint256) {
        if (amount == 0) return 0;
        
        // BasePoints = 金额_USDT ÷ 100 × 期限_天 ÷ 5
        uint256 basePoints = (amount / 100) * (duration / 5);
        
        // 应用基础积分权重
        basePoints = (basePoints * _basePointPerHundredUsd) / 1e18;
        
        // 应用用户等级倍数
        uint8 userLevel = _userLevels[user];
        if (userLevel > 0) {
            uint256 multiplier = _levelMultipliers[userLevel];
            basePoints = (basePoints * multiplier) / 10000;
        }
        
        // Bonus = BasePoints × 5%（当且仅当借款全过程 HealthFactor ≥ 1.5）
        uint256 totalPoints = basePoints;
        if (hfHighEnough && _earlyRepayBonus > 0) {
            uint256 bonus = (basePoints * _earlyRepayBonus) / 10000;
            totalPoints += bonus;
        }
        
        // 动态奖励（可选，当积分达到阈值时）
        if (totalPoints >= _dynamicRewardThreshold) {
            uint256 dynamicBonus = (totalPoints * _dynamicRewardMultiplier) / 10000;
            totalPoints += dynamicBonus;
        }
        
        return totalPoints;
    }

    /// @dev 更新用户活跃度
    function _updateUserActivity(address user, uint256 amount) internal {
        _userLastActivity[user] = block.timestamp;
        _userTotalLoans[user]++;
        _userTotalVolume[user] += amount;
        _autoUpgradeUserLevel(user);
    }

    /// @dev 自动升级用户等级
    function _autoUpgradeUserLevel(address user) internal {
        uint8 currentLevel = _userLevels[user];
        uint256 totalVolume = _userTotalVolume[user]; // USDT 6 位精度
        uint256 eligibleLoans = _eligibleLoanCount[user];
        uint256 onTimeCount = _onTimeRepayCount[user];
        uint8 newLevel = currentLevel;
        // 阈值使用 USDT 6 位：10000/50000/100000/500000
        if (totalVolume >= 10000 * 1e6 && eligibleLoans >= 3 && onTimeCount >= 1 && currentLevel < 2) {
            newLevel = 2;
        } else if (totalVolume >= 50000 * 1e6 && eligibleLoans >= 10 && onTimeCount >= 5 && currentLevel < 3) {
            newLevel = 3;
        } else if (totalVolume >= 100000 * 1e6 && eligibleLoans >= 20 && onTimeCount >= 10 && currentLevel < 4) {
            newLevel = 4;
        } else if (totalVolume >= 500000 * 1e6 && eligibleLoans >= 50 && onTimeCount >= 30 && currentLevel < 5) {
            newLevel = 5;
        }
        if (newLevel != currentLevel) {
            _userLevels[user] = newLevel;
            emit UserLevelUpdated(
                ActionKeys.ACTION_SET_PARAMETER,
                user,
                currentLevel,
                newLevel,
                address(this),
                block.timestamp
            );
            emit VaultTypes.PerformanceMonitor("UserLevelUpgraded", newLevel, block.timestamp);
            _tryPushUserLevel(user, newLevel);
        }
    }

    /// @notice 动态奖励参数返回结构
    struct DynamicRewardParams { uint256 threshold; uint256 multiplier; }

    /// @notice 查询动态奖励参数
    /// @return params 包含阈值与倍数（BPS）
    function getDynamicRewardParameters() external view returns (DynamicRewardParams memory params) {
        params.threshold = _dynamicRewardThreshold;
        params.multiplier = _dynamicRewardMultiplier;
    }

    /// @notice 升级授权函数
    /// @dev onlyRole modifier 已经足够验证权限
    /// @dev 如需接入 Timelock/Multisig 治理，应在此处增加相应的权限检查逻辑
    function _authorizeUpgrade(address) internal view override {
        // 检查调用者权限 - 只允许 RewardManager 调用
        address rewardManager = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_RM);
        if (msg.sender != rewardManager) {
            revert MissingRole();
        }
    }

    // ========== 基类抽象实现 ==========
    function _getRegistryAddr() internal view override returns (address) {
        return _registryAddr;
    }
} 