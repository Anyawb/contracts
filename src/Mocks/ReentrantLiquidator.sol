// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IVaultBusinessLogicLike {
    function liquidate(
        address targetUser,
        address collateralAsset,
        address debtAsset,
        uint256 collateralAmount,
        uint256 debtAmount,
        uint256 bonus
    ) external;
}

/// @title ReentrantLiquidator
/// @notice Attempts to reenter VaultBusinessLogic.liquidate to validate nonReentrancy
contract ReentrantLiquidator {
    IVaultBusinessLogicLike public vbl;

    constructor(address _vbl) {
        vbl = IVaultBusinessLogicLike(_vbl);
    }

    function attack(
        address user,
        address collateralAsset,
        address debtAsset,
        uint256 cAmt,
        uint256 dAmt
    ) external {
        // First call should succeed, second should revert due to nonReentrancy
        vbl.liquidate(user, collateralAsset, debtAsset, cAmt, dAmt, 0);
        vbl.liquidate(user, collateralAsset, debtAsset, cAmt, dAmt, 0);
    }
}






