// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ISettlementManager} from "../interfaces/ISettlementManager.sol";

/// @title MockVaultCoreForSettlementManager
/// @notice Minimal VaultCore mock for SettlementManager integration tests.
/// @dev Pulls tokens from user to SettlementManager, then calls repayAndSettle.
contract MockVaultCoreForSettlementManager {
    using SafeERC20 for IERC20;

    function repayViaSettlementManager(
        address settlementManager,
        uint256 orderId,
        address debtAsset,
        uint256 amount
    ) external {
        IERC20(debtAsset).safeTransferFrom(
            msg.sender,
            settlementManager,
            amount
        );
        ISettlementManager(settlementManager).repayAndSettle(
            msg.sender,
            debtAsset,
            amount,
            orderId
        );
    }
}
