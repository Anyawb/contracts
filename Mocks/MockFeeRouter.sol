// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IFeeRouter } from "../interfaces/IFeeRouter.sol";

/// @title MockFeeRouter
/// @notice 简易手续费路由器，支持动态设置费率。
contract MockFeeRouter is IFeeRouter {
    uint256 public lastFee;
    uint256 private feeRate = 100; // 默认 1%

    function setFeeRate(uint256 _rate) external {
        require(_rate <= 10000, "Fee rate too high"); // 最高 100%
        feeRate = _rate;
    }

    function getFeeRate() external view returns (uint256) {
        return feeRate;
    }

    function chargeDepositFee(address, uint256 amount) external view returns (uint256 fee) {
        fee = (amount * feeRate) / 10000;
    }

    function chargeBorrowFee(address, uint256 amount) external view returns (uint256 fee) {
        fee = (amount * feeRate) / 10000;
    }

    function distributeNormal(address, uint256) external {}

    // ===== Views to satisfy IFeeRouter =====
    function isTokenSupported(address) external pure returns (bool) { return true; }
    function getSupportedTokens() external pure returns (address[] memory) { return new address[](0); }
    function getRegistry() external pure returns (address) { return address(0); }
    function getPlatformTreasury() external pure returns (address) { return address(0); }
    function getEcosystemVault() external pure returns (address) { return address(0); }
    function getPlatformFeeBps() external view returns (uint256) { return feeRate; }
    function getEcosystemFeeBps() external pure returns (uint256) { return 0; }
    function getTotalDistributions() external pure returns (uint256) { return 0; }
    function getTotalAmountDistributed() external pure returns (uint256) { return 0; }
    function getFeeStatistics(address, bytes32) external pure returns (uint256) { return 0; }
    function getDynamicFee(address, bytes32) external pure returns (uint256) { return 0; }
    function getFeeCache(address, bytes32) external pure returns (uint256) { return 0; }
    function getOperationStats() external pure returns (uint256 distributions, uint256 totalAmount) { return (0, 0); }
} 