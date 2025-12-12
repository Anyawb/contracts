// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { MockLendingEngineBasic } from "./MockLendingEngineBasic.sol";

/// @title MockLendingEngineConcrete
/// @notice 向后兼容的 Mock，复用 MockLendingEngineBasic 的实现，满足测试中的命名依赖
contract MockLendingEngineConcrete is MockLendingEngineBasic {}


