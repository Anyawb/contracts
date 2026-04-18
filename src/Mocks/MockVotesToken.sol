// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title MockVotesToken
 * @notice Minimal mock implementing IVotes selectors used in this repo tests.
 * @dev Intentionally does NOT implement the full IVotes interface; only the required selectors exist.
 */
contract MockVotesToken {
    mapping(address => uint256) private _votes;
    uint256 private _totalSupply;

    function setVotes(address user, uint256 votes) external {
        _votes[user] = votes;
    }

    function setTotalSupply(uint256 totalSupply_) external {
        _totalSupply = totalSupply_;
    }

    function getPastVotes(
        address account,
        uint256 /* timepoint */
    ) external view returns (uint256) {
        return _votes[account];
    }

    function getPastTotalSupply(
        uint256 /* timepoint */
    ) external view returns (uint256) {
        return _totalSupply;
    }
}
