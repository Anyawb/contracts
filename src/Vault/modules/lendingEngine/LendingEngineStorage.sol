// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title LendingEngineStorage
 * @notice Provides the shared storage layout used by VaultLendingEngine libraries.
 * @dev Reverts if:
 *      - (none)
 *
 * Security:
 * - Layout mirrors the exact storage order of VaultLendingEngine and must not change.
 */
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
        uint256[45] _gapStorage;
    }

    /// @notice Return the storage pointer for VaultLendingEngine libraries.
    /// @dev Uses slot 0 to match VaultLendingEngine's first storage variable.
    function layout() internal pure returns (Layout storage storageLayout) {
        // solhint-disable-next-line no-inline-assembly
        assembly {
            storageLayout.slot := 0
        }
    }
}
