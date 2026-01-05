// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Storage helper for VaultLendingEngine to allow library-based refactors
/// @dev Layout mirrors the exact storage order of VaultLendingEngine; do not change
library LendingEngineStorage {
    struct Layout {
        mapping(address => mapping(address => uint256)) _userDebt;
        mapping(address => uint256) _totalDebtByAsset;
        mapping(address => uint256) _userTotalDebtValue;
        uint256 _totalDebtValue;

        address _priceOracleAddr;
        address _settlementTokenAddr;
        address _registryAddr;

        mapping(address => address[]) _userDebtAssets;
        mapping(address => mapping(address => uint256)) _userDebtAssetIndex;
        mapping(address => uint256) _userDebtAssetCount;

        mapping(address => uint256) _interestRatePerYear;
        uint256[45] _gap__;
    }

    /// @notice Return storage pointer for VaultLendingEngine
    /// @dev Uses slot 0, matching the contract's first variable
    function layout() internal pure returns (Layout storage l) {
        assembly {
            l.slot := 0
        }
    }
}








