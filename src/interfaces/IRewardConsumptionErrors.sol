// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IRewardConsumptionErrors - 积分消费错误定义接口
/// @notice 统一管理所有积分消费相关的错误定义
/// @dev 遵循 docs/SmartContractStandard.md 注释规范
interface IRewardConsumptionErrors {
    // 基础错误
    error RewardConsumption__ZeroAddress();
    error RewardConsumption__InvalidAmount();
    error RewardConsumption__InsufficientPoints();
    error RewardConsumption__ServiceNotAvailable();
    error RewardConsumption__ServiceExpired();
    error RewardConsumption__InsufficientPrivilege();
    
    // 验证错误
    error RewardConsumption__InvalidServiceType();
    error RewardConsumption__InvalidServiceLevel();
    error RewardConsumption__InvalidBatchOperation();
    error RewardConsumption__InvalidUpgradeCost();
    
    // 权限错误
    error RewardConsumption__NotGovernance();
    error RewardConsumption__NotAuthorized();
    
    // 状态错误
    error RewardConsumption__AlreadyInitialized();
    error RewardConsumption__NotInitialized();
    error RewardConsumption__ServiceInactive();
} 