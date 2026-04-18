// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Registry} from "../registry/Registry.sol";
import {ModuleKeys} from "../constants/ModuleKeys.sol";
import {ActionKeys} from "../constants/ActionKeys.sol";
import {ILendingEngineDebtWrite} from "../interfaces/ILendingEngineDebtWrite.sol";
import {IVaultRouter} from "../interfaces/IVaultRouter.sol";
import {ICollateralManager} from "../interfaces/ICollateralManager.sol";

/// @notice Test-only VaultCore stand-in that forwards the current core paths in simplified form.
contract SettlementBorrowCoreMock {
    address public registry;
    address private _viewContractAddr;

    constructor(address registryAddr, address viewContractAddr) {
        registry = registryAddr;
        _viewContractAddr = viewContractAddr;
    }

    /// @notice Returns the registry address.
    function registryAddrVar() external view returns (address) {
        return registry;
    }

    /// @notice Returns the view contract address used to resolve VaultRouter.
    function viewContractAddrVar() external view returns (address) {
        return _viewContractAddr;
    }

    /// @notice Accounting entry point used by SettlementMatchLib.
    function borrowFor(
        address borrower,
        address asset,
        uint256 amount,
        uint16 termDays
    ) external {
        // termDays is unused in this simplified implementation but kept for signature compatibility.
        termDays;
        address le = Registry(registry).getModuleOrRevert(ModuleKeys.KEY_LE);
        ILendingEngineDebtWrite(le).borrow(borrower, asset, amount, 0, 0);
    }

    /// @notice Deposits collateral through the standard VaultRouter entrypoint.
    function deposit(address asset, uint256 amount) external {
        require(amount > 0, "Amount must be positive");
        IVaultRouter(_viewContractAddr).processUserOperation(
            msg.sender,
            ActionKeys.ACTION_DEPOSIT,
            asset,
            amount,
            block.number
        );
    }

    /// @notice Withdraws collateral.
    function withdraw(address asset, uint256 amount) external {
        require(amount > 0, "Amount must be positive");
        IVaultRouter(_viewContractAddr).processUserOperation(
            msg.sender,
            ActionKeys.ACTION_WITHDRAW,
            asset,
            amount,
            block.number
        );
    }

    /// @notice Borrows through the LendingEngine.
    function borrow(address asset, uint256 amount) external {
        require(amount > 0, "Amount must be positive");
        address le = Registry(registry).getModuleOrRevert(ModuleKeys.KEY_LE);
        ILendingEngineDebtWrite(le).borrow(msg.sender, asset, amount, 0, 0);
    }

    /// @notice Repays through the LendingEngine using the current repay signature.
    function repay(uint256 orderId, address asset, uint256 amount) external {
        orderId; // mock: orderId is not used in this simplified forwarder
        require(amount > 0, "Amount must be positive");
        address le = Registry(registry).getModuleOrRevert(ModuleKeys.KEY_LE);
        ILendingEngineDebtWrite(le).repay(msg.sender, asset, amount);
    }

    /// @notice Pushes a full user-position update from a business module.
    function pushUserPositionUpdate(
        address user,
        address asset,
        uint256 collateral,
        uint256 debt,
        bytes32 requestId,
        uint64 seq,
        uint64 nextVersion
    ) external {
        IVaultRouter(_viewContractAddr).pushUserPositionUpdate(
            user,
            asset,
            collateral,
            debt,
            requestId,
            seq,
            nextVersion
        );
    }

    /// @notice Pushes a delta user-position update from a business module.
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
