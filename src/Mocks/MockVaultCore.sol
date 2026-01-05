// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

/// @title MockVaultCore
/// @notice VaultCore 的模拟合约，用于测试保证金管理模块
contract MockVaultCore is Ownable {
    address public guaranteeFundManager;
    address public viewContractAddr;

    function setGuaranteeFundManager(address _guaranteeFundManager) external onlyOwner {
        guaranteeFundManager = _guaranteeFundManager;
    }

    function setViewContractAddr(address _viewContractAddr) external onlyOwner {
        viewContractAddr = _viewContractAddr;
    }

    function viewContractAddrVar() external view returns (address) {
        return viewContractAddr;
    }

} 