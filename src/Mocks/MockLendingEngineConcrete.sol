// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {MockLendingEngineBasic} from "./MockLendingEngineBasic.sol";

/// @title MockLendingEngineConcrete
/// @notice Backward-compatible mock that reuses MockLendingEngineBasic for naming-dependent tests.
// solhint-disable-next-line no-empty-blocks
contract MockLendingEngineConcrete is MockLendingEngineBasic {}
