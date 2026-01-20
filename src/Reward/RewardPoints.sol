// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice 兼容导入入口（barrel file）
/// @dev
/// - 权威实现位于 `src/Token/RewardPoints.sol`
/// - 保留此文件仅用于兼容旧 import 路径与 Reward 子系统的语义归类（docs/Usage-Guide/Reward-System-Usage-Guide.md）
/// - 此文件不再重复声明合约，避免出现“同名合约拷贝”导致的维护与审计风险
import { RewardPoints } from "../Token/RewardPoints.sol";
