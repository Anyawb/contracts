// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title MockHealthView
/// @notice Mock HealthView contract used in tests.
contract MockHealthView {
    // User health-factor caches.
    mapping(address => uint256) private _userHealthFactors;
    mapping(address => uint256) private _cacheBlocks;

    // Events.
    event HealthFactorCached(
        address indexed user,
        uint256 healthFactor,
        uint256 cacheBlock
    );

    /// @notice Pushes a mocked risk-status update.
    function pushRiskStatus(
        address user,
        uint256 healthFactor,
        uint256 /* _threshold */,
        bool /* _isLiquidatable */,
        uint256 cacheBlock
    ) external {
        require(user != address(0), "MockHealthView: user is zero");
        _userHealthFactors[user] = healthFactor;
        _cacheBlocks[user] = cacheBlock;
        emit HealthFactorCached(user, healthFactor, cacheBlock);
    }

    /// @notice Returns the cached user health factor together with metadata.
    function getUserHealthFactorWithMeta(
        address user
    )
        external
        view
        returns (uint256 healthFactor, bool isValid, uint256 cacheBlock)
    {
        healthFactor = _userHealthFactors[user];
        cacheBlock = _cacheBlocks[user];
        isValid = cacheBlock != 0;
    }
}
