// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IVaultView } from "../interfaces/IVaultView.sol";

/// @title RevertingVaultView
/// @notice Mock view contract that always reverts on push,用于测试缓存推送失败场景
contract RevertingVaultView is IVaultView {
    function processUserOperation(
        address,
        bytes32,
        address,
        uint256,
        uint256
    ) external pure override {
        revert("revert-processUserOperation");
    }

    function pushUserPositionUpdate(
        address,
        address,
        uint256,
        uint256
    ) external pure override {
        revert("revert-pushUserPositionUpdate");
    }

    function pushAssetStatsUpdate(
        address,
        uint256,
        uint256,
        uint256
    ) external pure override {
        revert("revert-pushAssetStatsUpdate");
    }
}





