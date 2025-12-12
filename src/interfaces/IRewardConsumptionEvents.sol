// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../Reward/RewardTypes.sol";

/// @title IRewardConsumptionEvents - 积分消费事件定义接口
/// @notice 统一管理所有积分消费相关的事件定义
/// @dev 遵循 docs/SmartContractStandard.md 注释规范
interface IRewardConsumptionEvents {
    // 消费事件
    event ServiceConsumed(
        address indexed user, 
        uint8 serviceType, 
        uint8 level, 
        uint256 points, 
        uint256 timestamp
    );
    
    // 配置更新事件
    event ServiceConfigUpdated(
        uint8 serviceType, 
        uint8 level, 
        uint256 price, 
        uint256 duration
    );
    
    // 特权更新事件
    event UserPrivilegeUpdated(
        address indexed user, 
        uint8 serviceType, 
        uint8 level, 
        bool granted
    );
    
    // 批量操作事件
    event BatchConsumptionProcessed(
        uint256 userCount, 
        uint256 totalPoints
    );
    
    // 系统设置事件
    event TestnetModeUpdated(bool isTestnet);
    event UpgradeMultiplierUpdated(uint256 multiplier);
    event ServiceCooldownUpdated(uint8 serviceType, uint256 cooldown);
    
    // 消费记录事件
    event ConsumptionRecordAdded(address indexed user, RewardTypes.ConsumptionRecord record);
} 