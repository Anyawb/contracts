// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title MockSimpleContract
/// @notice Simple mock contract used as a module address in tests.
/// @dev This contract exists only to satisfy Registry's contract-address requirement.
contract MockSimpleContract {
    /// @notice Simple state variable.
    uint256 public value;

    /// @notice Sets the stored value.
    function setValue(uint256 _value) external {
        value = _value;
    }

    /// @notice Returns the stored value.
    function getValue() external view returns (uint256) {
        return value;
    }
}
