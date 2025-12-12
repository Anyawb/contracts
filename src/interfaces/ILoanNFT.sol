// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ILoanNFT 贷款凭证 NFT 接口
/// @notice 在贷款撮合成功后铸造 ERC-721 NFT，可选锁定为 SBT
/// @dev 实现合约需继承 ERC721 与 AccessControl，并确保与 LendingEngine 状态同步
interface ILoanNFT {
    /*━━━━━━━━━━━━━━━ ENUMS ━━━━━━━━━━━━━━━*/

    enum LoanStatus {
        Active,
        Repaid,
        Liquidated,
        Defaulted
    }

    /*━━━━━━━━━━━━━━━ STRUCTS ━━━━━━━━━━━━━━━*/

    /**
     * @dev 撮合成功后一次性填充全部字段；后续仅 `status` 字段可变动，其他字段视为只读常量。
     */
    struct LoanMetadata {
        uint256 principal;
        uint256 rate;          // 年化利率，bps （≤100_000）
        uint256 term;          // 借款周期（秒）
        uint256 oraclePrice;   // Oracle 快照价格
        uint256 loanId;        // LendingEngine 订单 ID
        bytes32 collateralHash;// 抵押物哈希
        LoanStatus status;     // 当前状态
    }

    /*━━━━━━━━━━━━━━━ EVENTS ━━━━━━━━━━━━━━━*/

    /// @notice 成功铸造 Loan NFT
    event LoanCertificateMinted(
        address indexed to,
        uint256 indexed tokenId,
        uint256 loanId,
        uint256 principal,
        uint256 rate,
        uint256 term
    );

    /// @notice 将已铸 NFT 锁定为不可转的 SBT
    event TokenLocked(uint256 indexed tokenId);
    /// @notice 已销毁 NFT
    event TokenBurned(uint256 indexed tokenId);

    /// @notice 状态更新
    event LoanStatusUpdated(uint256 indexed tokenId, LoanStatus newStatus);

    /*━━━━━━━━━━━━━━━ ERRORS ━━━━━━━━━━━━━━━*/

    error LoanNFT__NotAuthorized();
    error LoanNFT__SoulBound(uint256 tokenId);
    error LoanNFT__InvalidTokenId();
    error LoanNFT__LoanAlreadyMinted(uint256 loanId);

    /*━━━━━━━━━━━━━━━ EXTERNAL API ━━━━━━━━━━━━━━━*/

    /**
     * @notice 铸造贷款凭证 NFT
     * @param to NFT 接收方地址（通常为借方）
     * @param data 贷款元数据结构体
     * @return tokenId 新铸 NFT 的 ID
     */
    function mintLoanCertificate(address to, LoanMetadata calldata data) external returns (uint256 tokenId);

    /**
     * @notice 将 NFT 锁定为 SBT 模式，锁定后无法转移
     * @param tokenId NFT ID
     */
    function lockAsSBT(uint256 tokenId) external;

    /**
     * @notice 销毁 NFT 凭证
     * @dev 仅 `DEFAULT_ADMIN_ROLE` 或治理合约调用；清算/违约结算后可销毁。
     */
    function burn(uint256 tokenId) external;

    /**
     * @notice 更新贷款状态（如还清、清算等）
     * @dev 通常由 LendingEngine 或具备 `MINTER_ROLE` 的状态管理模块调用。
     */
    function updateLoanStatus(uint256 tokenId, LoanStatus newStatus) external;

    /**
     * @notice 获取指定用户持有的所有贷款凭证 ID
     * @param user 用户地址
     * @return tokenIds 用户持有的 tokenId 数组
     */
    function getUserTokens(address user) external view returns (uint256[] memory tokenIds);

    /**
     * @notice 查询贷款元数据详情
     * @param tokenId NFT ID
     * @return metadata 贷款元数据
     */
    function getLoanMetadata(uint256 tokenId) external view returns (LoanMetadata memory metadata);

    // ───────────────────── reserved for future upgrade ─────────────────────
    // /**
    //  * @notice 批量铸造贷款 NFT（例如同一组贷款打包发行）
    //  * @dev 未来用于批量匹配订单后一次性铸造
    //  */
    // function batchMintLoanCertificate(address[] calldata to, LoanMetadata[] calldata data) external;
} 