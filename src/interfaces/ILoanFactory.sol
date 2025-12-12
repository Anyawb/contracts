// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ILoanFactory 贷款合约工厂接口
/// @notice 根据撮合结果部署可升级 Loan 合约（Proxy 或 Clone）
/// @dev 通常由撮合匹配模块或治理合约调用
interface ILoanFactory {
    /*━━━━━━━━━━━━━━━ EVENTS ━━━━━━━━━━━━━━━*/

    event LoanDeployed(uint256 indexed orderId, address indexed proxyAddr);

    /*━━━━━━━━━━━━━━━ ERRORS ━━━━━━━━━━━━━━━*/
    error LoanFactory__NotAuthorized();

    /*━━━━━━━━━━━━━━━ EXTERNAL API ━━━━━━━━━━━━━━━*/

    /**
     * @notice 部署 Loan 合约
     * @param orderId LendingEngine 订单编号
     * @param initCalldata 初始化参数（ABI 编码）
     * @return proxyAddr 新部署的 Proxy/Clone 地址
     */
    function deployLoan(uint256 orderId, bytes calldata initCalldata) external returns (address proxyAddr);
} 