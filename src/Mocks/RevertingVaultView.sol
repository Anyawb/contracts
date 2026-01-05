// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IVaultRouter } from "../interfaces/IVaultRouter.sol";

/// @title RevertingVaultRouter
/// @notice Mock router contract that always reverts on push,用于测试缓存推送失败场景
contract RevertingVaultRouter is IVaultRouter {
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

    function pushUserPositionUpdate(
        address,
        address,
        uint256,
        uint256,
        bytes32,
        uint64
    ) external pure override {
        revert("revert-pushUserPositionUpdate");
    }

    function pushUserPositionUpdate(
        address,
        address,
        uint256,
        uint256,
        uint64
    ) external pure override {
        revert("revert-pushUserPositionUpdate");
    }

    function pushUserPositionUpdate(
        address,
        address,
        uint256,
        uint256,
        bytes32,
        uint64,
        uint64
    ) external pure override {
        revert("revert-pushUserPositionUpdate");
    }

    function pushUserPositionUpdateDelta(
        address,
        address,
        int256,
        int256
    ) external pure override {
        revert("revert-pushUserPositionUpdateDelta");
    }

    function pushUserPositionUpdateDelta(
        address,
        address,
        int256,
        int256,
        bytes32,
        uint64
    ) external pure override {
        revert("revert-pushUserPositionUpdateDelta");
    }

    function pushUserPositionUpdateDelta(
        address,
        address,
        int256,
        int256,
        uint64
    ) external pure override {
        revert("revert-pushUserPositionUpdateDelta");
    }

    function pushUserPositionUpdateDelta(
        address,
        address,
        int256,
        int256,
        bytes32,
        uint64,
        uint64
    ) external pure override {
        revert("revert-pushUserPositionUpdateDelta");
    }

    function pushAssetStatsUpdate(
        address,
        uint256,
        uint256,
        uint256
    ) external pure override {
        revert("revert-pushAssetStatsUpdate");
    }

    function pushAssetStatsUpdate(
        address,
        uint256,
        uint256,
        uint256,
        bytes32,
        uint64
    ) external pure override {
        revert("revert-pushAssetStatsUpdate");
    }
}





