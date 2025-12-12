// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title MockLiquidationDebtManager
/// @notice 简化的清算临时债务管理器（不继承完整接口），仅提供测试所需方法
contract MockLiquidationDebtManager {
    mapping(address => mapping(address => uint256)) private _tempDebt;

    function setLiquidatorTempDebt(address liquidator, address asset, uint256 amount) external {
        _tempDebt[liquidator][asset] = amount;
    }

    function getLiquidatorTempDebt(address liquidator, address asset) external view returns (uint256 tempDebt) {
        return _tempDebt[liquidator][asset];
    }
}


