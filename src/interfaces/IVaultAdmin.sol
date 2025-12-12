// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IVaultAdmin
/// @notice 治理和管理函数接口定义
/// @dev 极简治理入口，仅保留必要的参数下发能力
interface IVaultAdmin {
    /* ============ Events ============ */
    // 事件已在 CollateralVaultStorage 中定义，这里不需要重复定义

    /* ============ Governance Functions ============ */
    /// @notice 设置最小健康因子
    /// @param hf 新的最小健康因子（基点）
    function setMinHealthFactor(uint256 hf) external;

    // 其余参数写入请调用对应模块（如 VaultStorage、LiquidationRiskManager 等）
} 