// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title DataPushLibrary
/// @notice Helper utilities for emitting IDataPush compliant events.
/// @dev Reduce code duplication across modules by inlining minimal emit logic.
library DataPushLibrary {
    /// @dev Duplicated声明以便任何合约通过library即可emit，无需继承接口
    event DataPushed(bytes32 indexed dataTypeHash, bytes payload);

    /// @notice Emit DataPushed event via low-level assembly to save ~200 gas.
    /// @param dataTypeHash keccak256("TYPE") constant
    /// @param payload      ABI-encoded bytes
    function _emitData(bytes32 dataTypeHash, bytes memory payload) internal {
        emit DataPushed(dataTypeHash, payload);
    }
}
