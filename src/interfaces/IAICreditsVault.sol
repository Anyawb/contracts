// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IAICreditsVault
/// @notice Minimal external interface for AICreditsVault (on-chain credits SSOT).
interface IAICreditsVault {
    function creditsBalance(bytes32 tenantId, address user) external view returns (uint256);

    function buyCredits(
        bytes32 tenantId,
        address payToken,
        uint256 payAmount,
        uint256 credits,
        bytes32 clientOrderId
    ) external;

    function settleBatch(
        bytes32 tenantId,
        bytes32 settlementBatchId,
        bytes32 merkleRoot,
        address[] calldata users,
        uint256[] calldata creditsUsed
    ) external;
}

