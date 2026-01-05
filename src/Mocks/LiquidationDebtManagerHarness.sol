// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../Vault/liquidation/modules/LiquidationDebtManager.sol";

/// @title LiquidationDebtManagerHarness
/// @notice Concrete deployable harness for testing `LiquidationDebtManager` logic.
/// @dev The production module is marked `abstract` to prevent direct deployment; this wrapper makes it deployable for tests.
contract LiquidationDebtManagerHarness is LiquidationDebtManager {}







