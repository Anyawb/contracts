// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Registry } from "../../../registry/Registry.sol";
import { ModuleKeys } from "../../../constants/ModuleKeys.sol";
import { DataPushLibrary } from "../../../libraries/DataPushLibrary.sol";
import { DataPushTypes } from "../../../constants/DataPushTypes.sol";
import { IAccessControlManager } from "../../../interfaces/IAccessControlManager.sol";
import { ActionKeys } from "../../../constants/ActionKeys.sol";
import { RewardTypes } from "../../../Reward/RewardTypes.sol";
import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

/// @title RewardView
/// @notice 专用于积分系统的只读聚合与统一 DataPush 的视图模块
/// @dev 仅允许白名单业务模块写入（RewardManagerCore / RewardConsumption），其余为只读 0 gas 查询
contract RewardView is Initializable, UUPSUpgradeable {
    // ============ Storage ============
    address private _registryAddr;

    struct UserSummary {
        uint256 totalEarned;
        uint256 totalBurned;
        uint256 pendingPenalty;
        uint8 level;
        uint256 privilegesPacked;
        uint256 lastActivity;
        uint256 totalLoans;
        uint256 totalVolume;
    }

    mapping(address => UserSummary) private _userSummary;

    // 活动记录
    struct Activity { uint8 kind; uint256 amount; uint256 ts; }
    // kind: 1=earned, 2=burned, 3=penalty
    mapping(address => Activity[]) private _activities;
    uint256 private constant MAX_ACTIVITY_SCAN = 500;
    
    // Top Earners 缓存（固定长度）
    uint256 private constant TOP_N = 10;
    address[TOP_N] private _topEarners;
    uint256[TOP_N] private _topEarnedAmounts;
    mapping(address => bool) private _isActiveUser;

    struct SystemStats {
        uint256 totalBatchOps;
        uint256 totalCachedRewards;
        uint256 activeUsers;
    }

    SystemStats private _systemStats;

    // ============ Modifiers ============
    modifier onlyValidRegistry() {
        require(_registryAddr != address(0), "Registry not set");
        _;
    }

    modifier onlyWriter() {
        require(_registryAddr != address(0), "Registry not set");
        address rmc = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_REWARD_MANAGER_CORE);
        address rc  = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_REWARD_CONSUMPTION);
        require(msg.sender == rmc || msg.sender == rc, "Unauthorized writer");
        _;
    }

    /// @notice 仅限本人或具有查看用户数据权限的调用者
    modifier onlyAuthorizedFor(address user) {
        if (msg.sender != user) {
            _requireRole(ActionKeys.ACTION_VIEW_USER_DATA, msg.sender);
        }
        _;
    }

    // ============ Init & Admin ============
    /// @notice 初始化函数（UUPS）
    /// @param initialRegistryAddr Registry 地址
    function initialize(address initialRegistryAddr) external initializer {
        require(initialRegistryAddr != address(0), "Zero registry");
        _registryAddr = initialRegistryAddr;
    }

    /// @notice 更新 Registry 地址（需治理权限）
    /// @dev 仅允许具有 ACTION_SET_PARAMETER 权限的治理/管理员调用
    /// @param newRegistry 新的 Registry 地址
    function setRegistry(address newRegistry) external {
        _requireRole(ActionKeys.ACTION_SET_PARAMETER, msg.sender);
        require(newRegistry != address(0), "Zero registry");
        _registryAddr = newRegistry;
    }

    // ============ Push (writers only) ============
    /// @notice 写入：记录用户获得积分，并触发统一 DataPush
    /// @dev 仅允许业务写入方（RewardManagerCore/RewardConsumption）调用
    /// @param user 用户地址
    /// @param amount 获得的积分数量
    /// @param reason 获得原因（短字符串）
    /// @param ts 业务发生时间戳
    function pushRewardEarned(address user, uint256 amount, string calldata reason, uint256 ts) external onlyWriter {
        UserSummary storage s = _userSummary[user];
        s.totalEarned += amount;
        if (ts > s.lastActivity) s.lastActivity = ts;
        if (!_isActiveUser[user]) { _isActiveUser[user] = true; _systemStats.activeUsers++; }
        _activities[user].push(Activity({ kind: 1, amount: amount, ts: ts }));
        _updateTopEarners(user, s.totalEarned);
        DataPushLibrary._emitData(DataPushTypes.DATA_TYPE_REWARD_EARNED, abi.encode(user, amount, reason, ts));
    }

    /// @notice 写入：记录用户被扣减的积分，并触发统一 DataPush
    /// @dev 仅允许业务写入方调用
    /// @param user 用户地址
    /// @param amount 扣减的积分数量
    /// @param reason 扣减原因
    /// @param ts 业务发生时间戳
    function pushPointsBurned(address user, uint256 amount, string calldata reason, uint256 ts) external onlyWriter {
        UserSummary storage s = _userSummary[user];
        s.totalBurned += amount;
        if (ts > s.lastActivity) s.lastActivity = ts;
        if (!_isActiveUser[user]) { _isActiveUser[user] = true; _systemStats.activeUsers++; }
        _activities[user].push(Activity({ kind: 2, amount: amount, ts: ts }));
        DataPushLibrary._emitData(DataPushTypes.DATA_TYPE_REWARD_BURNED, abi.encode(user, amount, reason, ts));
    }

    /// @notice 写入：记录用户欠分账本（余额不足时的待扣减积分）
    /// @dev 仅允许业务写入方调用
    /// @param user 用户地址
    /// @param pendingDebt 欠分数量
    /// @param ts 业务发生时间戳
    function pushPenaltyLedger(address user, uint256 pendingDebt, uint256 ts) external onlyWriter {
        UserSummary storage s = _userSummary[user];
        s.pendingPenalty = pendingDebt;
        if (ts > s.lastActivity) s.lastActivity = ts;
        if (!_isActiveUser[user]) { _isActiveUser[user] = true; _systemStats.activeUsers++; }
        _activities[user].push(Activity({ kind: 3, amount: pendingDebt, ts: ts }));
        // 复用 STATS_UPDATED 承载账本更新亦可另设类型；先最小集
        DataPushLibrary._emitData(DataPushTypes.DATA_TYPE_REWARD_STATS_UPDATED, abi.encode(user, pendingDebt, ts));
    }

    /// @notice 写入：更新用户等级（1-5）
    /// @dev 仅允许业务写入方调用
    /// @param user 用户地址
    /// @param newLevel 新等级（1-5）
    /// @param ts 业务发生时间戳
    function pushUserLevel(address user, uint8 newLevel, uint256 ts) external onlyWriter {
        _userSummary[user].level = newLevel;
        if (ts > _userSummary[user].lastActivity) _userSummary[user].lastActivity = ts;
        DataPushLibrary._emitData(DataPushTypes.DATA_TYPE_REWARD_LEVEL_UPDATED, abi.encode(user, newLevel, ts));
    }

    /// @notice 写入：更新用户特权（按位压缩的 uint256）
    /// @dev 仅允许业务写入方调用
    /// @param user 用户地址
    /// @param privilegePacked 特权打包位图
    /// @param ts 业务发生时间戳
    function pushUserPrivilege(address user, uint256 privilegePacked, uint256 ts) external onlyWriter {
        _userSummary[user].privilegesPacked = privilegePacked;
        if (ts > _userSummary[user].lastActivity) _userSummary[user].lastActivity = ts;
        DataPushLibrary._emitData(DataPushTypes.DATA_TYPE_REWARD_PRIVILEGE_UPDATED, abi.encode(user, privilegePacked, ts));
    }

    /// @notice 写入：系统统计（批量次数、缓存命中次数）
    /// @dev 仅允许业务写入方调用
    /// @param totalBatchOps 批量操作总次数
    /// @param totalCachedRewards 积分缓存命中总次数
    /// @param ts 业务发生时间戳
    function pushSystemStats(uint256 totalBatchOps, uint256 totalCachedRewards, uint256 ts) external onlyWriter {
        _systemStats.totalBatchOps = totalBatchOps;
        _systemStats.totalCachedRewards = totalCachedRewards;
        DataPushLibrary._emitData(DataPushTypes.DATA_TYPE_REWARD_STATS_UPDATED, abi.encode(totalBatchOps, totalCachedRewards, ts));
    }

    // ============ Views (0 gas) ============
    /// @notice 查询：用户奖励汇总
    /// @param user 用户地址
    /// @return totalEarned 累计获得积分
    /// @return totalBurned 累计扣减积分
    /// @return pendingPenalty 欠分数量
    /// @return level 用户等级
    /// @return privilegesPacked 特权位图
    /// @return lastActivity 最近活跃时间
    /// @return totalLoans 预留（当前未维护）
    /// @return totalVolume 预留（当前未维护）
    function getUserRewardSummary(address user) external view onlyAuthorizedFor(user) returns (
        uint256 totalEarned,
        uint256 totalBurned,
        uint256 pendingPenalty,
        uint8 level,
        uint256 privilegesPacked,
        uint256 lastActivity,
        uint256 totalLoans,
        uint256 totalVolume
    ) {
        UserSummary storage s = _userSummary[user];
        return (s.totalEarned, s.totalBurned, s.pendingPenalty, s.level, s.privilegesPacked, s.lastActivity, s.totalLoans, s.totalVolume);
    }

    /// @notice 查询：系统奖励统计
    /// @return totalBatchOps 批量操作总次数
    /// @return totalCachedRewards 积分缓存命中总次数
    /// @return activeUsers 活跃用户数量
    function getSystemRewardStats() external view returns (uint256 totalBatchOps, uint256 totalCachedRewards, uint256 activeUsers) {
        return (_systemStats.totalBatchOps, _systemStats.totalCachedRewards, _systemStats.activeUsers);
    }

    /// @notice 查询：当前 Registry 地址
    function getRegistry() external view returns (address) {
        return _registryAddr;
    }

    // ============ Extended Views ============
    /// @notice 查询：用户最近奖励相关活动（按时间窗口、限制数量，倒序扫描）
    /// @param user 用户地址
    /// @param fromTs 起始时间（含），0 表示不限制
    /// @param toTs 截止时间（含），0 表示不限制
    /// @param limit 最大返回条目数
    /// @return out 活动记录数组
    function getUserRecentActivities(address user, uint256 fromTs, uint256 toTs, uint256 limit) external view onlyAuthorizedFor(user) returns (Activity[] memory out) {
        Activity[] storage arr = _activities[user];
        if (arr.length == 0 || limit == 0) return new Activity[](0);
        uint256 count;
        uint256 scanned;
        // 从末尾向前扫描，最多扫描 MAX_ACTIVITY_SCAN
        for (uint256 i = arr.length; i > 0 && scanned < MAX_ACTIVITY_SCAN && count < limit; i--) {
            Activity storage a = arr[i-1];
            scanned++;
            if ((fromTs == 0 || a.ts >= fromTs) && (toTs == 0 || a.ts <= toTs)) {
                count++;
            }
        }
        out = new Activity[](count);
        uint256 idx;
        scanned = 0;
        for (uint256 i = arr.length; i > 0 && scanned < MAX_ACTIVITY_SCAN && idx < count; i--) {
            Activity storage a2 = arr[i-1];
            scanned++;
            if ((fromTs == 0 || a2.ts >= fromTs) && (toTs == 0 || a2.ts <= toTs)) {
                out[idx++] = a2;
            }
        }
    }

    /// @notice 查询：Top N（固定 N=10）累计获得积分最多的用户
    /// @return addrs 地址数组（长度固定 N）
    /// @return amounts 对应累计获得积分数组
    function getTopEarners() external view returns (address[] memory addrs, uint256[] memory amounts) {
        // 返回固定 TOP_N 列表，按当前缓存
        uint256 n = TOP_N;
        addrs = new address[](n);
        amounts = new uint256[](n);
        for (uint256 i = 0; i < n; i++) { addrs[i] = _topEarners[i]; amounts[i] = _topEarnedAmounts[i]; }
    }
    
    // ============ Additional Views (pass-through to modules) ============
    /// @notice 查询：用户消费记录（透传 RewardCore）
    function getUserConsumptions(address user) external view onlyValidRegistry onlyAuthorizedFor(user) returns (RewardTypes.ConsumptionRecord[] memory records) {
        address core = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_REWARD_CORE);
        return IRewardCoreView(core).getUserConsumptions(user);
    }

    /// @notice 查询：服务配置（透传各配置模块）
    function getServiceConfig(RewardTypes.ServiceType serviceType, RewardTypes.ServiceLevel level) 
        external view onlyValidRegistry returns (RewardTypes.ServiceConfig memory config) 
    {
        address core = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_REWARD_CORE);
        return IRewardCoreView(core).getServiceConfig(serviceType, level);
    }

    /// @notice 查询：用户积分余额（透传 RewardPoints.balanceOf）
    function getUserBalance(address user) external view onlyValidRegistry onlyAuthorizedFor(user) returns (uint256 balance) {
        address rp = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_REWARD_POINTS);
        return IRewardPointsMinimal(rp).balanceOf(user);
    }

    /// @notice 查询：服务使用统计（透传 RewardCore）
    function getServiceUsage(RewardTypes.ServiceType serviceType) external view onlyValidRegistry returns (uint256 usage) {
        address core = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_REWARD_CORE);
        return IRewardCoreView(core).getServiceUsage(serviceType);
    }

    /// @notice 查询：用户最后消费时间（透传 RewardCore）
    function getUserLastConsumption(address user, RewardTypes.ServiceType serviceType) external view onlyValidRegistry onlyAuthorizedFor(user) returns (uint256 timestamp) {
        address core = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_REWARD_CORE);
        return IRewardCoreView(core).getUserLastConsumption(user, serviceType);
    }

    /// @notice 查询：用户特权（打包位图，来自本地缓存）
    function getUserPrivilegePacked(address user) external view onlyAuthorizedFor(user) returns (uint256 privilegePacked) {
        return _userSummary[user].privilegesPacked;
    }

    // ============ RewardManagerCore 相关视图透传（统一从 View 查询） ============
    function getRewardParametersView() external view onlyValidRegistry returns (uint256 baseUsd, uint256 perDay, uint256 bonus, uint256 baseEth) {
        address core = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_REWARD_MANAGER_CORE);
        return IRewardManagerCoreView(core).getRewardParameters();
    }

    function getUserCacheView(address user) external view onlyValidRegistry onlyAuthorizedFor(user) returns (uint256 points, uint256 timestamp, bool isValid) {
        address core = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_REWARD_MANAGER_CORE);
        return IRewardManagerCoreView(core).getUserCache(user);
    }

    function getCacheExpirationTimeView() external view onlyValidRegistry returns (uint256) {
        address core = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_REWARD_MANAGER_CORE);
        return IRewardManagerCoreView(core).getCacheExpirationTime();
    }

    function getDynamicRewardParametersView() external view onlyValidRegistry returns (uint256 threshold, uint256 multiplier) {
        address core = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_REWARD_MANAGER_CORE);
        return IRewardManagerCoreView(core).getDynamicRewardParameters();
    }

    function getLastRewardResetTimeView() external view onlyValidRegistry returns (uint256) {
        address core = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_REWARD_MANAGER_CORE);
        return IRewardManagerCoreView(core).getLastRewardResetTime();
    }

    function getUserLevelView(address user) external view onlyValidRegistry onlyAuthorizedFor(user) returns (uint8) {
        address core = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_REWARD_MANAGER_CORE);
        return IRewardManagerCoreView(core).getUserLevel(user);
    }

    function getLevelMultiplierView(uint8 level) external view onlyValidRegistry returns (uint256) {
        address core = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_REWARD_MANAGER_CORE);
        return IRewardManagerCoreView(core).getLevelMultiplier(level);
    }

    function getUserActivityView(address user) external view onlyValidRegistry onlyAuthorizedFor(user) returns (uint256 lastActivity, uint256 totalLoans, uint256 totalVolume) {
        address core = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_REWARD_MANAGER_CORE);
        return IRewardManagerCoreView(core).getUserActivity(user);
    }

    function getUserPenaltyDebtView(address user) external view onlyValidRegistry onlyAuthorizedFor(user) returns (uint256) {
        address core = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_REWARD_MANAGER_CORE);
        return IRewardManagerCoreView(core).getUserPenaltyDebt(user);
    }

    function getSystemRewardCoreStatsView() external view onlyValidRegistry returns (uint256 totalBatchOps, uint256 totalCachedRewards) {
        address core = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_REWARD_MANAGER_CORE);
        totalBatchOps = IRewardManagerCoreView(core).getTotalBatchOperations();
        totalCachedRewards = IRewardManagerCoreView(core).getTotalCachedRewards();
    }

    // ============ Internals ============
    function _updateTopEarners(address user, uint256 totalEarned) internal {
        // 如果已在列表中，更新位置（简单插入排序思路）
        uint256 pos = TOP_N; 
        for (uint256 i = 0; i < TOP_N; i++) {
            if (_topEarners[i] == user) { pos = i; break; }
        }
        if (pos == TOP_N) {
            // 不在列表，则若优于最末项则插入
            if (totalEarned <= _topEarnedAmounts[TOP_N-1]) return;
            pos = TOP_N - 1;
            _topEarners[pos] = user;
            _topEarnedAmounts[pos] = totalEarned;
        } else {
            _topEarnedAmounts[pos] = totalEarned;
        }
        // 向前冒泡保持降序
        while (pos > 0 && _topEarnedAmounts[pos] > _topEarnedAmounts[pos-1]) {
            ( _topEarners[pos], _topEarners[pos-1] ) = ( _topEarners[pos-1], _topEarners[pos] );
            ( _topEarnedAmounts[pos], _topEarnedAmounts[pos-1] ) = ( _topEarnedAmounts[pos-1], _topEarnedAmounts[pos] );
            pos--;
        }
    }

    // ============ Internal ============
    function _requireRole(bytes32 actionKey, address user) internal view {
        address acmAddr = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        IAccessControlManager(acmAddr).requireRole(actionKey, user);
    }

    function _authorizeUpgrade(address) internal view override {
        _requireRole(ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
    }
}

/// @dev RewardCore 只读最小接口（本地定义，避免直接依赖完整实现）
interface IRewardCoreView {
    function getUserConsumptions(address user) external view returns (RewardTypes.ConsumptionRecord[] memory);
    function getServiceUsage(RewardTypes.ServiceType serviceType) external view returns (uint256);
    function getUserLastConsumption(address user, RewardTypes.ServiceType serviceType) external view returns (uint256);
    function getServiceConfig(RewardTypes.ServiceType serviceType, RewardTypes.ServiceLevel level) external view returns (RewardTypes.ServiceConfig memory);
}

/// @dev RewardManagerCore 只读最小接口（供视图透传查询）
interface IRewardManagerCoreView {
    function getRewardParameters() external view returns (uint256 baseUsd, uint256 perDay, uint256 bonus, uint256 baseEth);
    function getUserCache(address user) external view returns (uint256 points, uint256 timestamp, bool isValid);
    function getCacheExpirationTime() external view returns (uint256);
    function getDynamicRewardParameters() external view returns (uint256 threshold, uint256 multiplier);
    function getLastRewardResetTime() external view returns (uint256);
    function getUserLevel(address user) external view returns (uint8);
    function getLevelMultiplier(uint8 level) external view returns (uint256);
    function getUserActivity(address user) external view returns (uint256 lastActivity, uint256 totalLoans, uint256 totalVolume);
    function getUserPenaltyDebt(address user) external view returns (uint256);
    function getTotalBatchOperations() external view returns (uint256);
    function getTotalCachedRewards() external view returns (uint256);
}

/// @dev RewardPoints 最小接口
interface IRewardPointsMinimal {
    function balanceOf(address owner) external view returns (uint256);
}


