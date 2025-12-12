// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ILendingEngine 借贷账本与资金流核心接口
/// @notice 负责贷款订单的创建、结算与查询，不处理抵押物逻辑
/// @dev 设计遵循 docs/SmartContractStandard.md 中的命名及错误规范
interface ILendingEngine {
    /*━━━━━━━━━━━━━━━ STRUCTS ━━━━━━━━━━━━━━━*/

    struct LoanOrder {
        uint256 principal;     // 借款本金
        uint256 rate;          // 年化利率（bps，10000 = 100%）
        uint256 term;          // 借款周期 (秒)
        address borrower;      // 借方
        address lender;        // 贷方
        address asset;         // 借贷资产 (ERC20)
        uint256 startTimestamp;// 借款开始时间
        uint256 maturity;      // 到期时间
        uint256 repaidAmount;  // 已还金额（本金+息）
    }

    /*━━━━━━━━━━━━━━━ EVENTS ━━━━━━━━━━━━━━━*/
    event LoanOrderCreated(uint256 indexed orderId, address indexed borrower, address indexed lender, uint256 principal);
    event LoanRepaid(uint256 indexed orderId, address indexed payer, uint256 repayAmount);

    /*━━━━━━━━━━━━━━━ ERRORS ━━━━━━━━━━━━━━━*/
    error LendingEngine__InvalidOrder();
    error LendingEngine__NotAuthorized();
    error LendingEngine__AlreadyRepaid();

    /*━━━━━━━━━━━━━━━ EXTERNAL API ━━━━━━━━━━━━━━━*/

    /**
     * @notice 创建贷款订单
     * @param order 贷款订单结构体
     * @return orderId 生成的订单编号
     */
    function createLoanOrder(LoanOrder calldata order) external returns (uint256 orderId);

    /**
     * @notice 归还贷款
     * @param orderId 订单编号
     * @param asset 还款资产地址
     * @param repayAmount 归还金额（本金+利息）
     */
    function repay(uint256 orderId, address asset, uint256 repayAmount) external;

    /**
     * @notice 查询贷款订单详情
     * @param orderId 订单编号
     * @return order 贷款订单结构体
     */
    function getLoanOrder(uint256 orderId) external view returns (LoanOrder memory order);

    /**
     * @notice 记录借款操作（仅测试用途）
     * @param user 借款人
     * @param asset 借款资产地址
     * @param amount 借款金额
     */
    function recordBorrow(address user, address asset, uint256 amount) external;

    /**
     * @notice 发起借款操作
     * @param user 借款人
     * @param asset 借款资产地址
     * @param amount 借款金额
     * @param termDays 借款期限（天）
     */
    function borrow(address user, address asset, uint256 amount, uint16 termDays) external;

    /*━━━━━━━━━━━━━━━ ENHANCED VIEW FUNCTIONS ━━━━━━━━━━━━━━━*/

    /**
     * @notice 获取用户的贷款订单数量（作为借款人）
     * @param user 用户地址
     * @return count 贷款订单数量
     */
    function getUserLoanCount(address user) external view returns (uint256 count);

    /**
     * @notice 检查用户是否有查看特定订单的权限
     * @param orderId 订单ID
     * @param user 用户地址
     * @return hasAccess 是否有访问权限
     */
    function canAccessLoanOrder(uint256 orderId, address user) external view returns (bool hasAccess);

    /**
     * @notice 获取当前Registry地址
     * @return Registry合约地址
     */
    function getRegistry() external view returns (address);

    /**
     * @notice 检查是否为匹配引擎
     * @param account 待检查的账户
     * @return 是否为匹配引擎
     */
    function isMatchEngine(address account) external view returns (bool);

    /*━━━━━━━━━━━━━━━ ADMIN VIEW FUNCTIONS ━━━━━━━━━━━━━━━*/

    /**
     * @notice 获取失败的费用金额（管理员功能）
     * @param orderId 订单ID
     * @return feeAmount 失败的费用金额
     */
    function getFailedFeeAmount(uint256 orderId) external view returns (uint256 feeAmount);

    /**
     * @notice 获取NFT重试次数（管理员功能）
     * @param orderId 订单ID
     * @return retryCount 重试次数
     */
    function getNftRetryCount(uint256 orderId) external view returns (uint256 retryCount);

    /**
     * @notice 获取已注册的监控服务数量（管理员功能）
     * @return count 监控服务数量
     */
    function getRegisteredMonitorCount() external view returns (uint256 count);
} 