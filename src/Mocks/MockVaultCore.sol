// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Minimal interface for GuaranteeFundManager core functions
interface IGuaranteeFundManagerMinimal {
    function lockGuarantee(address user, address asset, uint256 amount) external;
    function releaseGuarantee(address user, address asset, uint256 amount) external;
    function forfeitGuarantee(address user, address asset, address feeReceiver) external;
    function batchLockGuarantees(address user, address[] calldata assets, uint256[] calldata amounts) external;
    function batchReleaseGuarantees(address user, address[] calldata assets, uint256[] calldata amounts) external;
}

/// @title MockVaultCore
/// @notice VaultCore 的模拟合约，用于测试保证金管理模块
contract MockVaultCore is Ownable {
    address public guaranteeFundManager;
    address public viewContractAddr;

    /// @notice LendingEngine.repay 会通过 VaultCore.repayFor 同步账本（测试中只需不 revert）
    event RepayForCalled(address indexed user, address indexed asset, uint256 amount);

    function setGuaranteeFundManager(address _guaranteeFundManager) external onlyOwner {
        guaranteeFundManager = _guaranteeFundManager;
    }

    function setViewContractAddr(address _viewContractAddr) external onlyOwner {
        viewContractAddr = _viewContractAddr;
    }

    function viewContractAddrVar() external view returns (address) {
        return viewContractAddr;
    }

    // =========================
    // GuaranteeFundManager forwarding (acts as VaultCore caller)
    // =========================

    function lockGuarantee(address user, address asset, uint256 amount) external {
        IGuaranteeFundManagerMinimal(guaranteeFundManager).lockGuarantee(user, asset, amount);
    }

    function releaseGuarantee(address user, address asset, uint256 amount) external {
        IGuaranteeFundManagerMinimal(guaranteeFundManager).releaseGuarantee(user, asset, amount);
    }

    function forfeitGuarantee(address user, address asset, address feeReceiver) external {
        IGuaranteeFundManagerMinimal(guaranteeFundManager).forfeitGuarantee(user, asset, feeReceiver);
    }

    function batchLockGuarantees(address user, address[] calldata assets, uint256[] calldata amounts) external {
        IGuaranteeFundManagerMinimal(guaranteeFundManager).batchLockGuarantees(user, assets, amounts);
    }

    function batchReleaseGuarantees(address user, address[] calldata assets, uint256[] calldata amounts) external {
        IGuaranteeFundManagerMinimal(guaranteeFundManager).batchReleaseGuarantees(user, assets, amounts);
    }

    // =========================
    // LendingEngine callback (acts as VaultCore)
    // =========================
    function repayFor(address user, address asset, uint256 amount) external {
        emit RepayForCalled(user, asset, amount);
    }
} 