// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Registry } from "../registry/Registry.sol";
import { ModuleKeys } from "../constants/ModuleKeys.sol";
import { ActionKeys } from "../constants/ActionKeys.sol";
import { ILendingEngineBasic } from "../interfaces/ILendingEngineBasic.sol";
import { IVaultRouter } from "../interfaces/IVaultRouter.sol";
import { ICollateralManager } from "../interfaces/ICollateralManager.sol";

/// @notice 测试专用的 VaultCore 替身，实现核心转发逻辑，贴近现行 VaultCore（精简版）
contract SettlementBorrowCoreMock {
    address public registry;
    address private _viewContractAddr;

    constructor(address registryAddr, address viewContractAddr) {
        registry = registryAddr;
        _viewContractAddr = viewContractAddr;
    }

    /// @notice Registry 地址
    function registryAddrVar() external view returns (address) {
        return registry;
    }

    /// @notice View 合约地址（供业务模块解析 VaultRouter）
    function viewContractAddrVar() external view returns (address) {
        return _viewContractAddr;
    }

    /// @notice 供 SettlementMatchLib 调用的记账入口
    function borrowFor(address borrower, address asset, uint256 amount, uint16 termDays) external {
        // termDays 在当前实现中未使用，仅为兼容签名
        termDays;
        address le = Registry(registry).getModuleOrRevert(ModuleKeys.KEY_LE);
        ILendingEngineBasic(le).borrow(borrower, asset, amount, 0, 0);
    }

    /// @notice 存入抵押物，转发至 VaultRouter 标准入口
    function deposit(address asset, uint256 amount) external {
        require(amount > 0, "Amount must be positive");
        IVaultRouter(_viewContractAddr).processUserOperation(
            msg.sender,
            ActionKeys.ACTION_DEPOSIT,
            asset,
            amount,
            block.timestamp
        );
    }

    /// @notice 提取抵押物
    function withdraw(address asset, uint256 amount) external {
        require(amount > 0, "Amount must be positive");
        IVaultRouter(_viewContractAddr).processUserOperation(
            msg.sender,
            ActionKeys.ACTION_WITHDRAW,
            asset,
            amount,
            block.timestamp
        );
    }

    /// @notice 借款（透传到 LendingEngine）
    function borrow(address asset, uint256 amount) external {
        require(amount > 0, "Amount must be positive");
        address le = Registry(registry).getModuleOrRevert(ModuleKeys.KEY_LE);
        ILendingEngineBasic(le).borrow(msg.sender, asset, amount, 0, 0);
    }

    /// @notice 还款（透传到 LendingEngine；兼容 VaultCore.repay(orderId, asset, amount) 新签名）
    function repay(uint256 orderId, address asset, uint256 amount) external {
        orderId; // mock: orderId is not used in this simplified forwarder
        require(amount > 0, "Amount must be positive");
        address le = Registry(registry).getModuleOrRevert(ModuleKeys.KEY_LE);
        ILendingEngineBasic(le).repay(msg.sender, asset, amount);
    }

    /// @notice 业务模块推送用户头寸更新（简化版）
    function pushUserPositionUpdate(
        address user,
        address asset,
        uint256 collateral,
        uint256 debt,
        bytes32 requestId,
        uint64 seq,
        uint64 nextVersion
    ) external {
        IVaultRouter(_viewContractAddr).pushUserPositionUpdate(user, asset, collateral, debt, requestId, seq, nextVersion);
    }

    /// @notice 业务模块推送用户头寸增量更新（简化版）
    function pushUserPositionUpdateDelta(
        address user,
        address asset,
        int256 collateralDelta,
        int256 debtDelta,
        bytes32 requestId,
        uint64 seq,
        uint64 nextVersion
    ) external {
        IVaultRouter(_viewContractAddr).pushUserPositionUpdateDelta(
            user,
            asset,
            collateralDelta,
            debtDelta,
            requestId,
            seq,
            nextVersion
        );
    }
}

