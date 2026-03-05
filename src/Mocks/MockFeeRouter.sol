// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IFeeRouter } from "../interfaces/IFeeRouter.sol";

/// @title MockFeeRouter
/// @notice 简易手续费路由器，支持动态设置费率。
contract MockFeeRouter is IFeeRouter {
    uint256 public lastFee;
    uint256 private _feeRate = 100; // default 1%

    /// @notice Thrown when a fee rate is set above the maximum bps (10_000).
    error MockFeeRouter__FeeRateTooHigh();

    function _noop() private pure {
        return;
    }

    function setFeeRate(uint256 _rate) external {
        if (_rate > 10_000) revert MockFeeRouter__FeeRateTooHigh();
        _feeRate = _rate;
    }

    function getFeeRate() external view returns (uint256) {
        return _feeRate;
    }

    function chargeDepositFee(address, uint256 amount) external view returns (uint256 fee) {
        fee = (amount * _feeRate) / 10_000;
    }

    function chargeBorrowFee(address, uint256 amount) external view returns (uint256 fee) {
        fee = (amount * _feeRate) / 10_000;
    }

    function distributeNormal(address, uint256) external pure { _noop(); }
    function distributeDynamic(address, uint256, bytes32) external pure { _noop(); }
    function distributePrepaid(address, uint256, bytes32, address) external pure { _noop(); }
    function batchDistribute(address, uint256[] calldata, bytes32[] calldata) external pure { _noop(); }

    // ===== Admin writes (no-op in mock) =====
    function setFeeConfig(uint256 _platformBps, uint256 _ecosystemBps) external {
        // Keep behavior simple: interpret platform bps as "feeRate" for tests.
        _ecosystemBps; // unused
        _feeRate = _platformBps;
    }

    function setTreasury(address, address) external pure { _noop(); }
    function setDynamicFee(address, bytes32, uint256) external pure { _noop(); }
    function addSupportedToken(address) external pure { _noop(); }
    function removeSupportedToken(address) external pure { _noop(); }
    function clearFeeCache(address, bytes32) external pure { _noop(); }
    function pause() external pure { _noop(); }
    function unpause() external pure { _noop(); }
    function updateRegistry(address) external pure { _noop(); }

    // ===== Views to satisfy IFeeRouter =====
    function isTokenSupported(address) external pure returns (bool) { return true; }
    function getSupportedTokens() external pure returns (address[] memory) { return new address[](0); }
    function getRegistry() external pure returns (address) { return address(0); }
    function getPlatformTreasury() external pure returns (address) { return address(0); }
    function getEcosystemVault() external pure returns (address) { return address(0); }
    function getPlatformFeeBps() external view returns (uint256) { return _feeRate; }
    function getEcosystemFeeBps() external pure returns (uint256) { return 0; }
    function getTotalDistributions() external pure returns (uint256) { return 0; }
    function getTotalAmountDistributed() external pure returns (uint256) { return 0; }
    function getFeeStatistics(address, bytes32) external pure returns (uint256) { return 0; }
    function getDynamicFee(address, bytes32) external pure returns (uint256) { return 0; }
    function getFeeCache(address, bytes32) external pure returns (uint256) { return 0; }
    function getOperationStats() external pure returns (uint256 distributions, uint256 totalAmount) { return (0, 0); }
} 