// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title RegistryEvents
/// @notice Registry 合约的事件定义库
/// @dev 这是一个库文件，用于分离事件定义，减少主合约大小
/// @dev 通过 using RegistryEvents for * 语法在其他合约中使用
/// @dev 所有 Registry 相关的事件都在这里统一定义，便于维护和复用
library RegistryEvents {
    event ModuleUpgradeScheduled(bytes32 indexed key, address indexed oldAddress, address indexed newAddress, uint256 executeAfter);
    event ModuleUpgraded(bytes32 indexed key, address indexed oldAddress, address indexed newAddress);
    event ModuleUpgradeCancelled(bytes32 indexed key, address indexed oldAddress, address indexed newAddress);
    event MinDelayChanged(uint256 oldDelay, uint256 newDelay);
    event UpgradeHistoryRecorded(bytes32 indexed key, address indexed oldAddress, address indexed newAddress, uint256 timestamp, address executor);
    event ModuleUpgradePermitted(bytes32 indexed key, address indexed newAddress, address indexed signer, uint256 nonce);
    event BatchModuleUpgradePermitted(bytes32[] keys, address[] addresses, address indexed signer, uint256 nonce);
} 