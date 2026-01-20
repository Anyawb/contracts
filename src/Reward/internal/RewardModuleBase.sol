// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Registry } from "../../registry/Registry.sol";
import { ModuleKeys } from "../../constants/ModuleKeys.sol";
import { IAccessControlManager } from "../../interfaces/IAccessControlManager.sol";
import { RewardPoints } from "../../Token/RewardPoints.sol";
import { ZeroAddress } from "../../errors/StandardErrors.sol";

/// @title RewardModuleBase
/// @notice Reward 模块公共基类：统一 Registry 校验、权限校验、模块访问、RewardView 推送工具
/// @dev 仅提供 internal 能力；不暴露 external/public 接口，避免与现有合约产生签名冲突
/// @dev RewardView 最小写入接口（统一合集，覆盖 RMCore 与 RewardCore 各自使用的子集）
interface IRewardViewWriter {
    function pushRewardEarned(address user, uint256 amount, string calldata reason, uint256 ts) external;
    function pushPointsBurned(address user, uint256 amount, string calldata reason, uint256 ts) external;
    function pushPenaltyLedger(address user, uint256 pendingDebt, uint256 ts) external;
    function pushUserLevel(address user, uint8 newLevel, uint256 ts) external;
    function pushUserPrivilege(address user, uint256 privilegePacked, uint256 ts) external;
    function pushSystemStats(uint256 totalBatchOps, uint256 totalCachedRewards, uint256 ts) external;
    function pushConsumptionRecord(
        address user,
        uint8 serviceType,
        uint8 serviceLevel,
        uint256 points,
        uint256 expirationTime,
        uint256 ts
    ) external;
}

abstract contract RewardModuleBase {
    // ============ RewardView 推送失败事件（用于链下告警与手动重试） ============
    /// @notice RewardView 推送失败事件（不回滚，链下监听后可人工重放）
    /// @dev 参照 Architecture-Guide 的“推送失败发事件 + 链下重试队列”模式
    /// @param user 关联用户（若为系统级推送则为 address(0)）
    /// @param rewardView 当前解析到的 RewardView 地址（可能为 address(0)）
    /// @param op 推送操作类型（如 keccak256("REWARD_EARNED")）
    /// @param payload 期望写入的 payload（abi.encode(...)）
    /// @param reason revert 原因（若 rewardView==0 则为 bytes("rewardView unavailable")）
    event RewardViewPushFailed(
        address indexed user,
        address indexed rewardView,
        bytes32 indexed op,
        bytes payload,
        bytes reason
    );

    bytes32 internal constant RV_OP_REWARD_EARNED = keccak256("REWARD_EARNED");
    bytes32 internal constant RV_OP_POINTS_BURNED = keccak256("POINTS_BURNED");
    bytes32 internal constant RV_OP_PENALTY_LEDGER = keccak256("PENALTY_LEDGER");
    bytes32 internal constant RV_OP_USER_LEVEL = keccak256("USER_LEVEL");
    bytes32 internal constant RV_OP_USER_PRIVILEGE = keccak256("USER_PRIVILEGE");
    bytes32 internal constant RV_OP_SYSTEM_STATS = keccak256("SYSTEM_STATS");
    bytes32 internal constant RV_OP_CONSUMPTION_RECORD = keccak256("CONSUMPTION_RECORD");
    // ============ 抽象依赖 ============
    /// @notice 由子合约实现：返回当前合约使用的 Registry 地址
    /// @dev 子合约通常持有私有存储变量 `address private _registryAddr;`
    function _getRegistryAddr() internal view virtual returns (address);

    // ============ 修饰符 ============
    /// @notice 校验 Registry 地址已设置
    modifier onlyValidRegistry() {
        if (_getRegistryAddr() == address(0)) revert ZeroAddress();
        _;
    }

    // ============ 权限工具 ============
    /// @notice 统一的权限校验
    /// @param actionKey 动作键（参考 ActionKeys）
    /// @param user 被校验用户地址
    function _requireRole(bytes32 actionKey, address user) internal view {
        address acmAddr = Registry(_getRegistryAddr()).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        IAccessControlManager(acmAddr).requireRole(actionKey, user);
    }

    // ============ 模块访问 ============
    /// @notice 获取 RewardPoints 合约实例
    function _getRewardToken() internal view returns (RewardPoints) {
        address tokenAddr = Registry(_getRegistryAddr()).getModuleOrRevert(ModuleKeys.KEY_REWARD_POINTS);
        return RewardPoints(tokenAddr);
    }

    // ============ RewardView 推送工具（统一实现，尽力而为，不可回滚） ============
    address private _cachedRewardViewAddr;
    uint256 private _cachedRewardViewTs;
    uint256 private constant RV_CACHE_TTL = 1 hours;

    /// @notice 解析并缓存 RewardView 地址（1 小时 TTL）
    function _getRewardViewCached() internal returns (address rv) {
        if (_cachedRewardViewAddr != address(0) && block.timestamp < _cachedRewardViewTs + RV_CACHE_TTL) {
            return _cachedRewardViewAddr;
        }
        // 尝试解析：失败时返回 address(0)，调用方需忽略
        try Registry(_getRegistryAddr()).getModuleOrRevert(ModuleKeys.KEY_REWARD_VIEW) returns (address viewAddr) {
            _cachedRewardViewAddr = viewAddr;
            _cachedRewardViewTs = block.timestamp;
            return viewAddr;
        } catch {
            return address(0);
        }
    }

    /// @notice 推送：获得积分
    function _tryPushRewardEarned(address user, uint256 amount, string memory reason) internal {
        address rv = _getRewardViewCached();
        bytes memory payload = abi.encode(user, amount, reason, block.timestamp);
        if (rv == address(0)) {
            emit RewardViewPushFailed(user, rv, RV_OP_REWARD_EARNED, payload, bytes("rewardView unavailable"));
            return;
        }
        try IRewardViewWriter(rv).pushRewardEarned(user, amount, reason, block.timestamp) { } catch (bytes memory err) {
            emit RewardViewPushFailed(user, rv, RV_OP_REWARD_EARNED, payload, err);
        }
    }

    /// @notice 推送：扣减积分
    function _tryPushPointsBurned(address user, uint256 amount, string memory reason) internal {
        address rv = _getRewardViewCached();
        bytes memory payload = abi.encode(user, amount, reason, block.timestamp);
        if (rv == address(0)) {
            emit RewardViewPushFailed(user, rv, RV_OP_POINTS_BURNED, payload, bytes("rewardView unavailable"));
            return;
        }
        try IRewardViewWriter(rv).pushPointsBurned(user, amount, reason, block.timestamp) { } catch (bytes memory err) {
            emit RewardViewPushFailed(user, rv, RV_OP_POINTS_BURNED, payload, err);
        }
    }

    /// @notice 推送：惩罚账本（欠分）
    function _tryPushPenaltyLedger(address user, uint256 pendingDebt) internal {
        address rv = _getRewardViewCached();
        bytes memory payload = abi.encode(user, pendingDebt, block.timestamp);
        if (rv == address(0)) {
            emit RewardViewPushFailed(user, rv, RV_OP_PENALTY_LEDGER, payload, bytes("rewardView unavailable"));
            return;
        }
        try IRewardViewWriter(rv).pushPenaltyLedger(user, pendingDebt, block.timestamp) { } catch (bytes memory err) {
            emit RewardViewPushFailed(user, rv, RV_OP_PENALTY_LEDGER, payload, err);
        }
    }

    /// @notice 推送：用户等级
    function _tryPushUserLevel(address user, uint8 newLevel) internal {
        address rv = _getRewardViewCached();
        bytes memory payload = abi.encode(user, newLevel, block.timestamp);
        if (rv == address(0)) {
            emit RewardViewPushFailed(user, rv, RV_OP_USER_LEVEL, payload, bytes("rewardView unavailable"));
            return;
        }
        try IRewardViewWriter(rv).pushUserLevel(user, newLevel, block.timestamp) { } catch (bytes memory err) {
            emit RewardViewPushFailed(user, rv, RV_OP_USER_LEVEL, payload, err);
        }
    }

    /// @notice 推送：用户特权（压缩位图）
    function _tryPushUserPrivilege(address user, uint256 privilegePacked) internal {
        address rv = _getRewardViewCached();
        bytes memory payload = abi.encode(user, privilegePacked, block.timestamp);
        if (rv == address(0)) {
            emit RewardViewPushFailed(user, rv, RV_OP_USER_PRIVILEGE, payload, bytes("rewardView unavailable"));
            return;
        }
        try IRewardViewWriter(rv).pushUserPrivilege(user, privilegePacked, block.timestamp) { } catch (bytes memory err) {
            emit RewardViewPushFailed(user, rv, RV_OP_USER_PRIVILEGE, payload, err);
        }
    }

    /// @notice 推送：系统统计
    function _tryPushSystemStats(uint256 totalBatchOps, uint256 totalCachedRewards) internal {
        address rv = _getRewardViewCached();
        bytes memory payload = abi.encode(totalBatchOps, totalCachedRewards, block.timestamp);
        if (rv == address(0)) {
            emit RewardViewPushFailed(address(0), rv, RV_OP_SYSTEM_STATS, payload, bytes("rewardView unavailable"));
            return;
        }
        try IRewardViewWriter(rv).pushSystemStats(totalBatchOps, totalCachedRewards, block.timestamp) { } catch (bytes memory err) {
            emit RewardViewPushFailed(address(0), rv, RV_OP_SYSTEM_STATS, payload, err);
        }
    }

    /// @notice 推送：消费记录（Spend 侧由 RewardConsumption 调用）
    function _tryPushConsumptionRecord(
        address user,
        uint8 serviceType,
        uint8 serviceLevel,
        uint256 points,
        uint256 expirationTime,
        uint256 ts
    ) internal {
        address rv = _getRewardViewCached();
        bytes memory payload = abi.encode(user, serviceType, serviceLevel, points, expirationTime, ts);
        if (rv == address(0)) {
            emit RewardViewPushFailed(user, rv, RV_OP_CONSUMPTION_RECORD, payload, bytes("rewardView unavailable"));
            return;
        }
        try IRewardViewWriter(rv).pushConsumptionRecord(user, serviceType, serviceLevel, points, expirationTime, ts) { } catch (bytes memory err) {
            emit RewardViewPushFailed(user, rv, RV_OP_CONSUMPTION_RECORD, payload, err);
        }
    }
}


