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
}

abstract contract RewardModuleBase {
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
        if (rv == address(0)) return;
        try IRewardViewWriter(rv).pushRewardEarned(user, amount, reason, block.timestamp) { } catch { }
    }

    /// @notice 推送：扣减积分
    function _tryPushPointsBurned(address user, uint256 amount, string memory reason) internal {
        address rv = _getRewardViewCached();
        if (rv == address(0)) return;
        try IRewardViewWriter(rv).pushPointsBurned(user, amount, reason, block.timestamp) { } catch { }
    }

    /// @notice 推送：惩罚账本（欠分）
    function _tryPushPenaltyLedger(address user, uint256 pendingDebt) internal {
        address rv = _getRewardViewCached();
        if (rv == address(0)) return;
        try IRewardViewWriter(rv).pushPenaltyLedger(user, pendingDebt, block.timestamp) { } catch { }
    }

    /// @notice 推送：用户等级
    function _tryPushUserLevel(address user, uint8 newLevel) internal {
        address rv = _getRewardViewCached();
        if (rv == address(0)) return;
        try IRewardViewWriter(rv).pushUserLevel(user, newLevel, block.timestamp) { } catch { }
    }

    /// @notice 推送：用户特权（压缩位图）
    function _tryPushUserPrivilege(address user, uint256 privilegePacked) internal {
        address rv = _getRewardViewCached();
        if (rv == address(0)) return;
        try IRewardViewWriter(rv).pushUserPrivilege(user, privilegePacked, block.timestamp) { } catch { }
    }

    /// @notice 推送：系统统计
    function _tryPushSystemStats(uint256 totalBatchOps, uint256 totalCachedRewards) internal {
        address rv = _getRewardViewCached();
        if (rv == address(0)) return;
        try IRewardViewWriter(rv).pushSystemStats(totalBatchOps, totalCachedRewards, block.timestamp) { } catch { }
    }
}


