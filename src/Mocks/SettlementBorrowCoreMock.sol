// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Registry } from "../registry/Registry.sol";
import { ModuleKeys } from "../constants/ModuleKeys.sol";
import { ActionKeys } from "../constants/ActionKeys.sol";
import { ILendingEngineBasic } from "../interfaces/ILendingEngineBasic.sol";
import { IVaultView } from "../interfaces/IVaultView.sol";

/// @notice 测试专用的 VaultCore 替身，实现 borrowFor 以便撮合流程调用
contract SettlementBorrowCoreMock {
    address public registry;
    bytes32 private constant KEY_VAULT_VIEW = keccak256("VAULT_VIEW");

    constructor(address registryAddr) {
        registry = registryAddr;
    }

    /// @notice 供 SettlementMatchLib 调用的记账入口
    function borrowFor(address borrower, address asset, uint256 amount, uint16 termDays) external {
        // termDays 在当前实现中未使用，仅为兼容签名
        termDays;
        address le = Registry(registry).getModuleOrRevert(ModuleKeys.KEY_LE);
        ILendingEngineBasic(le).borrow(borrower, asset, amount, 0, 0);
    }

    /// @notice 简化版存入：透传到 VaultView 的 processUserOperation
    function deposit(address asset, uint256 amount) external {
        IVaultView viewModule = IVaultView(Registry(registry).getModuleOrRevert(KEY_VAULT_VIEW));
        viewModule.processUserOperation(msg.sender, ActionKeys.ACTION_DEPOSIT, asset, amount, block.timestamp);
    }

    /// @notice 供 CollateralManager 解析 VaultView 地址
    function viewContractAddrVar() external view returns (address) {
        return Registry(registry).getModuleOrRevert(KEY_VAULT_VIEW);
    }
}

