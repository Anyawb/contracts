// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Registry } from "../registry/Registry.sol";
import { ActionKeys } from "../constants/ActionKeys.sol";
import { ModuleKeys } from "../constants/ModuleKeys.sol";
import { RewardEvents } from "./RewardEvents.sol";
import {
    ZeroAddress,
    NotAContract,
    MissingRole,
    InvalidCaller,
    ExternalModuleRevertedRaw
} from "../errors/StandardErrors.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { ReentrancyGuardUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import { RewardModuleBase } from "./internal/RewardModuleBase.sol";
import { RewardFormulaLib } from "./libraries/RewardFormulaLib.sol";

/// @dev Minimal LoanFlowView read adapter used by RewardManagerCore.
interface ILoanFlowViewRewardRead {
    function getUserBorrowFlowForReward(address user)
        external
        view
        returns (uint256 borrowVolumeUsd8, uint256 borrowCount, bool isValid, uint256 blockNumber);
}

/// @dev Minimal EarnConfig read adapter (governance params SSOT).
interface IEarnConfigRewardRead {
    function getDynamicRewardParams()
        external
        view
        returns (uint256 thresholdEasy, uint256 multiplierBps, uint256 updateBlock);

    function getLevelMultiplierBps(uint8 level) external view returns (uint256 multiplierBps);
}

/// @title RewardManagerCore - 积分管理核心业务逻辑
/// @notice 处理积分计算、发放和批量操作的核心逻辑
/// @dev 遵循 docs/SmartContractStandard.md 注释规范，标准化所有动作、模块、事件、错误、合约地址获取
/// @dev 使用 ActionKeys 进行标准化动作标识和权限验证
/// @dev 使用 ModuleKeys 进行模块地址管理
/// @dev 使用 SystemEvents 进行标准化事件记录
/// @dev 通过 Registry 进行模块地址获取，确保架构一致性
/// @dev 现行链上基线（见 docs/Usage-Guide/Reward-System-Usage-Guide.md）：
/// @dev - borrow(duration>0)：锁定 1 积分（不铸币）
/// @dev - repay(duration==0 且 isOnTimeAndFullyRepaid==true)：释放锁定积分并铸币
/// @dev - repay(isOnTimeAndFullyRepaid==false)：不释放，并按提前/逾期规则走扣罚/欠分账本
/// @dev   说明：V1 入口的 `hfHighEnough` 为历史遗留命名；当前语义是 `isOnTimeAndFullyRepaid`（按期且足额还清），不要按旧名误解为 HealthFactor。

contract RewardManagerCore is Initializable, UUPSUpgradeable, ReentrancyGuardUpgradeable, RewardModuleBase {
    /// @notice 入口收紧引导错误（用于提示外部调用者应通过 RewardManager 调用）
    error RewardManagerCore__UseRewardManagerEntry();
    /// @notice DEPRECATED：检测到直接调用核心入口，将被拒绝
    event DeprecatedDirectEntryAttempt(address indexed caller, uint256 blockNumber);
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Registry 合约地址（私有存储，提供显式 getter）
    address private _registryAddr;

    // NOTE (strict read boundary):
    // RewardManagerCore exposes NO external/public view getters for frontends/off-chain consumers.
    // External reads MUST go through RewardView.

    /// @notice 欠分账本：记录用户被扣但余额不足的积分（私有存储）
    mapping(address => uint256) private _penaltyLedger;

    // ========== Level system (protocol/borrow gating) ==========
    /// @notice 用户等级系统 (1-5级，5级最高)
    mapping(address => uint8) private _userLevels;

    /// @notice 最低计分本金：1000 USDC（6 decimals），低于该值不计分/不锁定
    uint256 private constant MIN_ELIGIBLE_PRINCIPAL = 1_000e6;
    /// @notice Earn-side baseline Easy per order (18 decimals).
    uint256 private constant _BASE_LOCK_EASY = 1e18;
    /// @dev MUST match OrderEngine's `_ON_TIME_WINDOW_BLOCKS` (see `src/core/LendingEngine.sol`)
    ///      so "early vs late" classification is consistent across SSOT and reward penalty logic.
    uint256 private constant _DEFAULT_ON_TIME_WINDOW_BLOCKS = 7_200; // block-based SSOT default (deployment/governance may override)

    // ========== 锁定-释放 与 扣罚参数 ==========
    /// @notice 用户锁定 Easy 余额（按用户汇总，最小化改动；虚拟锁定/未铸币）
    mapping(address => uint256) private _lockedEasy;
    /// @notice 用户当前锁定的目标到期时间（以最近一次借款为准，最小化改动）
    mapping(address => uint256) private _lockedMaturity;

    // ========== 按订单维度：锁定（解决多订单错判） ==========
    /// @dev 每个 orderId 对应的锁定 Easy（默认 1e18），0 表示未锁定/已处理
    mapping(uint256 => uint256) private _lockedEasyByOrderId;
    /// @dev 每个 orderId 对应的 borrower（用于一致性校验）
    mapping(uint256 => address) private _lockedUserByOrderId;
    /// @dev 每个 orderId 的 maturity（用于提前/逾期判定与审计）
    mapping(uint256 => uint256) private _lockedMaturityByOrderId;
    /// @notice 按期窗口（区块数），默认 24 小时
    uint256 private _onTimeWindowBlocks;
    /// @notice 提前还款扣罚（BPS）默认 3% = 300
    uint256 private _earlyPenaltyBps;
    /// @notice 逾期还款扣罚（BPS）默认 5% = 500
    uint256 private _latePenaltyBps;
    /// @notice 合格借款计数（本金≥1000USDT）
    mapping(address => uint256) private _eligibleLoanCount;
    /// @notice 按期履约计数
    mapping(address => uint256) private _onTimeRepayCount;

    // ========== Events ==========
    /// @notice 用户等级更新事件
    event UserLevelUpdated(
        bytes32 indexed actionKey,
        address indexed user,
        uint8 oldLevel,
        uint8 newLevel,
        address indexed updatedBy,
        uint256 blockNumber
    );

    /// @notice 惩罚 Easy 扣除事件
    event PenaltyEasyDeducted(
        bytes32 indexed actionKey,
        address indexed user,
        uint256 easyAmount,
        uint256 remainingDebt,
        address indexed deductedBy,
        uint256 blockNumber
    );

    /// @notice 初始化
    /// @param initialRegistryAddr Registry 合约地址
    function initialize(address initialRegistryAddr) external initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        if (initialRegistryAddr.code.length == 0) revert NotAContract(initialRegistryAddr);
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        _registryAddr = initialRegistryAddr;
        // 锁定/扣罚默认参数
        _onTimeWindowBlocks = _DEFAULT_ON_TIME_WINDOW_BLOCKS;
        // 与 Reward-System-Usage-Guide 对齐：提前还款不处罚；逾期默认 5%
        _earlyPenaltyBps = 0;
        _latePenaltyBps = 500;

        // RMCore 不发 ActionExecuted，避免与业务入口/治理入口产生重复语义；参数变更以专用事件为准。
    }

    // ========== 公共接口 ==========

    /// @notice RewardManager 在 borrow 或 repay 后调用此函数（V1 兼容入口）
    /// @param user 用户地址
    /// @param amount 借款金额
    /// @param duration 借款时长（区块数）；borrow 推荐传订单 term；repay 固定传 0
    /// @param hfHighEnough 历史遗留命名；当前语义为 `isOnTimeAndFullyRepaid`（按期且足额还清，由 LendingEngine 计算并传入；主要在 repay 场景有意义）。
    ///        注意：**不要**将其按旧名误解为“健康因子足够（HealthFactor）”。
    function onLoanEvent(address user, uint256 amount, uint256 duration, bool hfHighEnough)
        external
        onlyValidRegistry
        nonReentrant
    {
        // 收紧入口：仅允许 RewardManager 调用，统一路径为 LE -> RM -> RMCore
        address rewardManager = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_RM);
        if (msg.sender != rewardManager) {
            emit DeprecatedDirectEntryAttempt(msg.sender, block.number);
            // IMPORTANT:
            // - We must not revert here, otherwise the audit event is discarded.
            // - "Reject" semantics are implemented as a no-op: no state changes, no mint/burn.
            return;
        }
        
        // 语义归一：V1 入口参数名为 hfHighEnough（legacy），实际语义为“按期且足额还清”。
        bool isOnTimeAndFullyRepaid = hfHighEnough;

        // 业务设定（本地/测试基线）：只要成功借贷（借款事件），即可获得 1 积分。
        // - 借款（duration>0）：锁定 1 积分
        // - 还款（duration=0 且 isOnTimeAndFullyRepaid=true）：释放锁定的 1 积分（不在 RMCore 里铸币；发行由 EasyEmissionController 统一处理）
        //
        // 说明：此处保持“借款锁定、还款释放”的架构语义不变，但将积分计算简化为固定 1。
        //      其中“协议借款总量/次数”等 activity 统计不再由 RMCore 计算，而是优先从 LoanFlowView(USD-8 SSOT)读取并镜像到 RewardView。
        //      amount/duration 仍用于本次事件的资格判断（如 MIN_ELIGIBLE_PRINCIPAL）与到期判断（惩罚路径）等。
        _updateUserActivity(user, amount);

        // 本金不足 1000 USDC 不计分（不锁定、不计合格借款）
        if (duration > 0 && amount < MIN_ELIGIBLE_PRINCIPAL) {
            return;
        }

        if (duration > 0) {
            uint256 easyAmount = 1e18; // 1 Easy with reward token decimals == 18
            _eligibleLoanCount[user] += 1;
            _lockedEasy[user] += easyAmount;
            // 借款时以 duration 推导 maturity：取“最近一次”即可
            _lockedMaturity[user] = block.number + duration;
            return;
        }

        // 还款：根据 isOnTimeAndFullyRepaid（按期且足额）决定释放或扣罚
        if (isOnTimeAndFullyRepaid) {
            uint256 locked = _lockedEasy[user];
            if (locked > 0) {
                // 先抵扣欠分
                uint256 debt = _penaltyLedger[user];
                uint256 toOffset = locked;
                if (debt > 0) {
                    if (toOffset >= debt) {
                        toOffset -= debt;
                        _penaltyLedger[user] = 0;
                        emit PenaltyEasyDeducted(
                            ActionKeys.ACTION_CLAIM_REWARD,
                            user,
                            debt,
                            0,
                            msg.sender,
                            block.number
                        );
                    } else {
                        _penaltyLedger[user] = debt - toOffset;
                        emit PenaltyEasyDeducted(
                            ActionKeys.ACTION_CLAIM_REWARD,
                            user,
                            toOffset,
                            _penaltyLedger[user],
                            msg.sender,
                            block.number
                        );
                        toOffset = 0;
                    }
                }

                // NOTE: Token minting is handled by EasyEmissionController per WhitePaper.
                // RMCore keeps the lock/ledger semantics and offsets penalty ledger best-effort,
                // but does not mint the reward token to avoid double issuance.

                // 清空锁定并增加履约计数
                _lockedEasy[user] = 0;
                _lockedMaturity[user] = 0;
                _onTimeRepayCount[user] += 1;
            }
            return;
        }

        // 非按期足额：作废锁定并扣罚（提前或逾期）
        uint256 lockedEasy = _lockedEasy[user];
        if (lockedEasy > 0) {
            // 清空锁定
            _lockedEasy[user] = 0;
            uint256 m = _lockedMaturity[user];
            _lockedMaturity[user] = 0;

            // 判定提前/逾期：按当前区块与 maturity 比较（容忍窗口）
            uint256 nowBlock = block.number;
            bool isEarly = (nowBlock + _onTimeWindowBlocks < m);
            // 与使用指南对齐：提前还款不处罚（bps=0）；仅逾期按 latePenaltyBps 扣罚
            uint256 bps = isEarly ? 0 : _latePenaltyBps;
            if (bps > 0) {
                uint256 penalty = (lockedEasy * bps) / 10000;
                // 尝试直接烧分；不足则记入欠分账本
                try _getRewardToken().burn(user, penalty) {
                        _tryPushEasyBurned(user, penalty, isEarly ? "EarlyPenalty" : "LatePenalty");
                } catch {
                    // 记录欠分
                    _penaltyLedger[user] += penalty;
                        emit PenaltyEasyDeducted(
                        ActionKeys.ACTION_LIQUIDATE,
                        user,
                        0,
                        _penaltyLedger[user],
                        msg.sender,
                        block.number
                    );
                    _tryPushPenaltyLedger(user, _penaltyLedger[user]);
                }
            }
        }
    }

    /// @notice LendingEngine 在 borrow/repay(足额) 后调用（按订单维度）
    /// @dev
    /// - outcome: 0=Borrow,1=RepayOnTimeFull,2=RepayEarlyFull,3=RepayLateFull
    /// - 仅 RewardManager 可调用（统一入口：LE -> RM -> RMCore）
    function onLoanEventByOrder(
        address user,
        uint256 orderId,
        uint256 amount,
        uint256 maturity,
        uint8 outcome
    ) external onlyValidRegistry nonReentrant {
        address rewardManager = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_RM);
        if (msg.sender != rewardManager) {
            emit DeprecatedDirectEntryAttempt(msg.sender, block.number);
            // See legacy entry: do not revert, otherwise the audit event is discarded.
            return;
        }

        // 记录活跃（协议统计 SSOT：LoanFlowView；RMCore 不做跨资产价值推导/镜像）
        _updateUserActivity(user, amount);

        // Borrow：为该订单锁定 1 积分（按订单维度）
        if (outcome == 0) {
            if (_lockedEasyByOrderId[orderId] != 0) {
                // 幂等：同一订单重复回调忽略
                return;
            }
            // 本金不足 1000 USDC 不计分/不锁定
            if (amount < MIN_ELIGIBLE_PRINCIPAL) {
                return;
            }
            uint8 level = _userLevels[user];
            if (level < 1) level = 1;

            // Read earn-config params best-effort; never revert the main path.
            (uint256 levelMultiplierBps, uint256 dynThresholdEasy, uint256 dynMultiplierBps) =
                _readEarnConfigBestEffort(level);

            // lockedEasy = BASE_EASY * levelMultiplierBps / 10000
            uint256 easyAmount = (_BASE_LOCK_EASY * levelMultiplierBps) / 10000;
            if (easyAmount == 0) {
                // Defensive fallback: keep baseline semantics.
                easyAmount = _BASE_LOCK_EASY;
            }

            // Optional dynamic reward:
            // if enabled (bps>0) and easyAmount >= threshold => easyAmount += easyAmount*bps/10000
            if (dynMultiplierBps != 0 && dynThresholdEasy != 0 && easyAmount >= dynThresholdEasy) {
                easyAmount += (easyAmount * dynMultiplierBps) / 10000;
            }

            _eligibleLoanCount[user] += 1;
            _lockedEasy[user] += easyAmount;

            _lockedEasyByOrderId[orderId] = easyAmount;
            _lockedUserByOrderId[orderId] = user;
            _lockedMaturityByOrderId[orderId] = maturity;
            return;
        }

        // Repay：必须能找到该 orderId 的锁定记录；若已处理/未锁定则幂等忽略
        uint256 locked = _lockedEasyByOrderId[orderId];
        if (locked == 0) {
            return;
        }
        address lockedUser = _lockedUserByOrderId[orderId];
        if (lockedUser != user) revert InvalidCaller();

        // 清除订单锁定（防重放）
        delete _lockedEasyByOrderId[orderId];
        delete _lockedUserByOrderId[orderId];
        delete _lockedMaturityByOrderId[orderId];

        // 同步扣减用户聚合锁定（与旧实现字段兼容）
        if (_lockedEasy[user] >= locked) {
            _lockedEasy[user] -= locked;
        } else {
            _lockedEasy[user] = 0;
        }

        // outcome == 1：按期足额 → 释放并铸币（先抵扣欠分）
        if (outcome == 1) {
            uint256 debt = _penaltyLedger[user];
            uint256 toOffset = locked;
            if (debt > 0) {
                if (toOffset >= debt) {
                    toOffset -= debt;
                    _penaltyLedger[user] = 0;
                    emit PenaltyEasyDeducted(
                        ActionKeys.ACTION_CLAIM_REWARD,
                        user,
                        debt,
                        0,
                        msg.sender,
                        block.number
                    );
                    _tryPushPenaltyLedger(user, 0);
                } else {
                    _penaltyLedger[user] = debt - toOffset;
                    emit PenaltyEasyDeducted(
                        ActionKeys.ACTION_CLAIM_REWARD,
                        user,
                        toOffset,
                        _penaltyLedger[user],
                        msg.sender,
                        block.number
                    );
                    _tryPushPenaltyLedger(user, _penaltyLedger[user]);
                    toOffset = 0;
                }
            }

            // NOTE: Token minting is handled by EasyEmissionController per WhitePaper.
            // We keep only the ledger offset + observability pushes here.
            _onTimeRepayCount[user] += 1;
            return;
        }

        // outcome == 2：提前足额 → 不发放、不处罚（锁定作废）
        if (outcome == 2) {
            return;
        }

        // outcome == 3：逾期足额 → 不发放，按 latePenaltyBps 扣罚（不足则记入欠分账本）
        if (outcome == 3) {
            uint256 bps = _latePenaltyBps;
            if (bps == 0) {
                return;
            }
            uint256 penalty = (locked * bps) / 10000;
            if (penalty == 0) {
                return;
            }
            try _getRewardToken().burn(user, penalty) {
                _tryPushEasyBurned(user, penalty, "LatePenalty");
            } catch {
                _penaltyLedger[user] += penalty;
                emit PenaltyEasyDeducted(
                    ActionKeys.ACTION_LIQUIDATE,
                    user,
                    0,
                    _penaltyLedger[user],
                    msg.sender,
                    block.number
                );
                _tryPushPenaltyLedger(user, _penaltyLedger[user]);
            }
            return;
        }

        // 未知 outcome：忽略（保持向后兼容，避免硬 revert 导致主流程失败）
    }

    /// @notice 扣除用户 Easy（仅清算/惩罚模块可调用）
    /// @param user 用户地址
    /// @param easyAmount 扣除 Easy 数量
    function deductEasy(address user, uint256 easyAmount) external onlyValidRegistry nonReentrant {
        // 检查调用者权限 - 只允许清算/惩罚模块或 RewardManager 调用
        address guaranteeFundManager = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_GUARANTEE_FUND);
        address rewardManager = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_RM);
        if (msg.sender != guaranteeFundManager && msg.sender != rewardManager) {
            revert MissingRole();
        }
        
        if (easyAmount == 0) revert InvalidCaller();
        
        try _getRewardToken().burn(user, easyAmount) {
            _tryPushEasyBurned(user, easyAmount, "Penalty Burn");
        } catch {
            // 如果积分不足，记录到惩罚账本
            _penaltyLedger[user] += easyAmount;
                emit PenaltyEasyDeducted(
                ActionKeys.ACTION_LIQUIDATE,
                user,
                0,
                _penaltyLedger[user],
                msg.sender,
                    block.number
            );
            _tryPushPenaltyLedger(user, _penaltyLedger[user]);
        }
    }

    /// @notice 设置按期窗口（区块数）
    function setOnTimeWindow(uint256 newWindow) external onlyValidRegistry {
        address rewardManager = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_RM);
        if (msg.sender != rewardManager) revert MissingRole();
        _onTimeWindowBlocks = newWindow;
    }

    /// @notice 设置提前/逾期扣罚（BPS）
    function setPenaltyBps(uint256 earlyBps, uint256 lateBps) external onlyValidRegistry {
        address rewardManager = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_RM);
        if (msg.sender != rewardManager) revert MissingRole();
        _earlyPenaltyBps = earlyBps;
        _latePenaltyBps = lateBps;
    }

    // ========== RewardView governance observability pushes (best-effort; no revert) ==========

    /// @notice Best-effort push: dynamic reward params (governance observability) into RewardView cache.
    /// @dev Only RewardManager can call; push failures do not revert (RewardModuleBase emits RewardViewPushFailed).
    function pushDynamicRewardParamsToView(uint256 thresholdEasy, uint256 multiplierBps) external onlyValidRegistry {
        address rewardManager = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_RM);
        if (msg.sender != rewardManager) {
            emit DeprecatedDirectEntryAttempt(msg.sender, block.number);
            return;
        }
        _tryPushDynamicRewardParams(thresholdEasy, multiplierBps, block.number);
    }

    /// @notice Best-effort push: level multiplier (governance observability) into RewardView cache.
    /// @dev Only RewardManager can call; push failures do not revert (RewardModuleBase emits RewardViewPushFailed).
    function pushLevelMultiplierToView(uint8 level, uint256 multiplierBps) external onlyValidRegistry {
        address rewardManager = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_RM);
        if (msg.sender != rewardManager) {
            emit DeprecatedDirectEntryAttempt(msg.sender, block.number);
            return;
        }
        _tryPushLevelMultiplier(level, multiplierBps, block.number);
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
            block.number
        );

        // Best-effort: mirror level into RewardView (external reads must use RewardView).
        _tryPushUserLevel(user, newLevel);
    }

    // ========== 内部函数 ==========

    // NOTE (Audit / readability):
    // - 主路径已收敛为“borrow 锁定 / repay(按期足额) 释放”的 1 积分基线（见 onLoanEvent/onLoanEventByOrder）。
    // - 过去的“公式计分 + 缓存计算”内部函数容易让读者误判主路径依赖公式，因此已从 RMCore 主体中移除。
    // - 如需未来引入公式计分，请以“独立模块/库 + 显式入口”的方式落地（避免与主路径混杂）。

    /// @dev Example-only: formula-based EasyToken calculation is intentionally isolated in RewardFormulaLib.
    ///      Current baseline does NOT call this helper.
    function _calculateBorrowEasyTokenExample(
        uint256 amount,
        uint256 durationBlocks,
        uint8 userLevel,
        uint256 levelMultiplierBps,
        uint256 dynamicThresholdEasy,
        uint256 dynamicMultiplierBps
    ) internal pure returns (uint256 easyTokenAmount) {
        userLevel; // reserved for future rule extensions (e.g., different level curves)
        return RewardFormulaLib.calculateBorrowEasyTokenExample(
            amount, durationBlocks, levelMultiplierBps, dynamicThresholdEasy, dynamicMultiplierBps
        );
    }

    /// @dev Best-effort: observe protocol flow (USD-8 SSOT) and auto-upgrade level.
    function _updateUserActivity(address user, uint256 /* amount */) internal {
        // SSOT boundary:
        // - Protocol borrow statistics MUST come from LoanFlowView (USD-8 SSOT).
        // - RewardManagerCore may read those values for gating/level logic,
        //   without attempting to re-derive cross-asset value locally.
        (bool ok, uint256 borrowCount, uint256 borrowVolumeUsd8) = _readBorrowFlowUsd8BestEffort(user);
        if (!ok) {
            // Deliberately do NOT fabricate protocol flow stats inside RMCore.
            // If LoanFlowView is unavailable/invalid, activity totals remain unchanged.
            // (OrderEngine -> LoanFlowPushManager is the SSOT pipeline for these fields.)
            return;
        }

        borrowCount; // silence unused-variable warning (kept for potential future rule changes)
        _autoUpgradeUserLevelFromLoanFlowUsd8(user, borrowVolumeUsd8);
    }

    /// @dev Best-effort read: EarnConfig parameters.
    ///      IMPORTANT: Reward is post-ledger; do NOT let missing/misconfigured configs break the main path.
    function _readEarnConfigBestEffort(uint8 level)
        internal
        view
        returns (uint256 levelMultiplierBps, uint256 dynThresholdEasy, uint256 dynMultiplierBps)
    {
        // Defaults: 1x multiplier, dynamic disabled.
        levelMultiplierBps = 10000;
        dynThresholdEasy = 0;
        dynMultiplierBps = 0;

        address earnCfg = Registry(_registryAddr).getModule(ModuleKeys.KEY_REWARD_EARN_CONFIG);
        if (earnCfg == address(0) || earnCfg.code.length == 0) {
            return (levelMultiplierBps, dynThresholdEasy, dynMultiplierBps);
        }

        // Dynamic params.
        try IEarnConfigRewardRead(earnCfg).getDynamicRewardParams() returns (
            uint256 thresholdEasy,
            uint256 multiplierBps,
            uint256 /* updateBlock */
        ) {
            dynThresholdEasy = thresholdEasy;
            // Safety cap (defense-in-depth); EarnConfig already caps at 100000.
            if (multiplierBps <= 100000) dynMultiplierBps = multiplierBps;
        } catch {
            // ignore
        }

        // Level multiplier.
        try IEarnConfigRewardRead(earnCfg).getLevelMultiplierBps(level) returns (uint256 bps) {
            if (bps != 0 && bps <= 100000) levelMultiplierBps = bps;
        } catch {
            // ignore
        }
    }

    /// @dev 自动升级用户等级（LoanFlowView / USD-8 SSOT）
    function _autoUpgradeUserLevelFromLoanFlowUsd8(address user, uint256 borrowVolumeUsd8) internal {
        uint8 currentLevel = _userLevels[user];
        uint256 eligibleLoans = _eligibleLoanCount[user];
        uint256 onTimeCount = _onTimeRepayCount[user];
        uint8 newLevel = currentLevel;
        // Thresholds are in USD-8 (SSOT): 10k/50k/100k/500k USD.
        if (borrowVolumeUsd8 >= 10000 * 1e8 && eligibleLoans >= 3 && onTimeCount >= 1 && currentLevel < 2) {
            newLevel = 2;
        } else if (borrowVolumeUsd8 >= 50000 * 1e8 && eligibleLoans >= 10 && onTimeCount >= 5 && currentLevel < 3) {
            newLevel = 3;
        } else if (borrowVolumeUsd8 >= 100000 * 1e8 && eligibleLoans >= 20 && onTimeCount >= 10 && currentLevel < 4) {
            newLevel = 4;
        } else if (borrowVolumeUsd8 >= 500000 * 1e8 && eligibleLoans >= 50 && onTimeCount >= 30 && currentLevel < 5) {
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
                block.number
            );
            // Debug/legacy metric only. Offchain indexing should rely on RewardView.DataPushed streams.
            emit RewardEvents.PerformanceMonitor("UserLevelUpgraded", newLevel, block.number);
            _tryPushUserLevel(user, newLevel);
        }
    }

    /// @dev Best-effort read: borrow-only protocol flow from LoanFlowView (USD-8 SSOT).
    function _readBorrowFlowUsd8BestEffort(address user)
        internal
        view
        returns (bool ok, uint256 borrowCount, uint256 borrowVolumeUsd8)
    {
        address viewAddr;
        try Registry(_registryAddr).getModule(ModuleKeys.KEY_LOAN_FLOW_VIEW) returns (address a) {
            viewAddr = a;
        } catch {
            return (false, 0, 0);
        }
        if (viewAddr == address(0) || viewAddr.code.length == 0) return (false, 0, 0);

        try ILoanFlowViewRewardRead(viewAddr).getUserBorrowFlowForReward(user) returns (
            uint256 volUsd8,
            uint256 cnt,
            bool isValid,
            uint256 /* blockNumber */
        ) {
            if (!isValid) return (false, 0, 0);
            return (true, cnt, volUsd8);
        } catch {
            return (false, 0, 0);
        }
    }

    // NOTE: dynamic reward parameters are governance-controlled and consumed internally.
    // Any external observability must be provided via RewardView (push-based) if needed.

    /// @notice 升级授权函数
    /// @dev 升级权限遵循双轨治理：由 ACM(ActionKeys.ACTION_UPGRADE_MODULE) 控制
    /// @dev 若后续接入 Timelock/Multisig，应在 ACM 层或此处增加“仅 Timelock/Multisig 执行”的约束
    function _authorizeUpgrade(address newImplementation) internal view override {
        _requireRole(ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
        if (newImplementation == address(0)) revert ZeroAddress();
    }

    // ========== 基类抽象实现 ==========
    function _getRegistryAddr() internal view override returns (address) {
        return _registryAddr;
    }

    // ============ UUPS storage gap ============
    uint256[50] private __gap;
} 