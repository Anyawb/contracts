// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title RewardTypes - Reward 子系统共享数据类型
/// @notice 定义 Reward 子系统的枚举和结构体
/// @dev 遵循 docs/SmartContractStandard.md 注释规范
/// @dev Types-only：用于被 Reward 子系统合约继承/引用，不应单独部署
/// @dev 重要：`ServiceLevel` 的枚举顺序是对外 ABI 的一部分（前端/脚本依赖），禁止调整/插入/重排
abstract contract RewardTypes {
    /// @notice 服务等级枚举
    enum ServiceLevel {
        Basic,      // 基础
        Standard,   // 标准
        Premium,    // 高级
        VIP         // VIP
    }
} 