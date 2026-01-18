// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IFeeRouter
 * @notice Fee routing SSOT interface: fee calculation and fee distribution to configured treasuries.
 * @dev Reverts if:
 *      - caller is not authorized (implementation-defined; typically role-gated via ACM)
 *      - input validation fails (implementation-defined; zero address/amount)
 *
 * Security:
 * - Role-gated in implementation (e.g. ACTION_DEPOSIT / ACTION_SET_PARAMETER)
 * - Token transfers are performed in the implementation and must be non-reentrant / CEI-compliant as applicable
 */
interface IFeeRouter {
    /*━━━━━━━━━━━━━━━ EVENTS ━━━━━━━━━━━━━━━*/
    
    /**
     * @notice Emitted when fees are distributed to treasuries.
     * @dev Reverts if:
     *      - N/A (event emission only)
     *
     * Security:
     * - Event-only; FeeRouter implementation is SSOT for fee movements
     *
     * @param token Fee token address
     * @param platformAmount Amount distributed to platform treasury (token decimals)
     * @param ecoAmount Amount distributed to ecosystem vault (token decimals)
     */
    event FeeDistributed(address indexed token, uint256 platformAmount, uint256 ecoAmount);
    /**
     * @notice Emitted when fixed fee bps configuration is updated.
     * @dev Reverts if:
     *      - N/A (event emission only)
     *
     * @param platformFeeBps Platform fee bps (\(1e4 = 100%\))
     * @param ecoFeeBps Ecosystem fee bps (\(1e4 = 100%\))
     */
    event FeeConfigUpdated(uint256 platformFeeBps, uint256 ecoFeeBps);
    /// @notice Aggregated treasury update (ABI-compat; implementations may also emit granular events below).
    event TreasuryUpdated(address platformTreasury, address ecoVault);
    /// @notice Granular treasury update events (preferred for indexing)
    event PlatformTreasuryUpdated(address indexed oldAddr, address indexed newAddr);
    event EcosystemVaultUpdated(address indexed oldAddr, address indexed newAddr);
    event DynamicFeeUpdated(address indexed token, bytes32 indexed feeType, uint256 oldFee, uint256 newFee);
    event TokenSupported(address indexed token, bool supported);
    event BatchFeeDistributed(address indexed token, uint256 totalAmount, uint256 distribution);
    event FeeStatisticsUpdated(address indexed token, bytes32 indexed feeType, uint256 totalAmount);
    event RegistryUpdated(address indexed oldRegistry, address indexed newRegistry);

    /*━━━━━━━━━━━━━━━ CORE FUNCTIONS ━━━━━━━━━━━━━━━*/

    /**
     * @notice Calculate deposit fee for a user.
     * @dev Reverts if:
     *      - implementation-defined
     *
     * Security:
     * - View only
     *
     * @param user User address
     * @param amount Deposit amount (token decimals; implementation-defined)
     * @return fee Fee amount (token decimals; 0 if disabled)
     */
    function chargeDepositFee(address user, uint256 amount) external view returns (uint256 fee);

    /**
     * @notice Calculate borrow fee for a user.
     * @dev Reverts if:
     *      - implementation-defined
     *
     * Security:
     * - View only
     *
     * @param user User address
     * @param amount Borrow amount (token decimals; implementation-defined)
     * @return fee Fee amount (token decimals)
     */
    function chargeBorrowFee(address user, uint256 amount) external view returns (uint256 fee);

    /**
     * @notice Distribute fee amount according to the current configuration.
     * @dev Reverts if:
     *      - caller is not authorized (implementation-defined)
     *      - `token` is zero (implementation-defined)
     *      - `amount` is zero (implementation-defined)
     *      - token is not supported (implementation-defined)
     *      - underlying ERC20 transfer fails (implementation-defined)
     *
     * Security:
     * - Role-gated in implementation
     *
     * @param token ERC20 token address
     * @param amount Fee amount (token decimals of `token`)
     */
    function distributeNormal(address token, uint256 amount) external;

    /**
     * @notice Distribute fee amount according to the dynamic fee configuration for (token, feeType).
     * @dev Reverts if:
     *      - implementation-defined (authorization/validation/paused/token support)
     *
     * Security:
     * - Role-gated in implementation
     *
     * @param token ERC20 token address
     * @param amount Fee amount (token decimals of `token`)
     * @param feeType Fee type identifier
     */
    function distributeDynamic(address token, uint256 amount, bytes32 feeType) external;

    /**
     * @notice Batch distribute multiple fee items for a token (gas-optimized).
     * @dev Reverts if:
     *      - implementation-defined (authorization/validation/paused/token support)
     *
     * Security:
     * - Role-gated in implementation
     *
     * @param token ERC20 token address
     * @param amounts Per-item total amounts (token decimals of `token`)
     * @param feeTypes Per-item fee type identifiers (must match `amounts.length`)
     */
    function batchDistribute(address token, uint256[] calldata amounts, bytes32[] calldata feeTypes) external;

    /**
     * @notice Get current fee rate (implementation-defined aggregation of fee config).
     * @dev Reverts if:
     *      - none
     *
     * Security:
     * - View only
     *
     * @return Current fee rate in bps (\(1e4 = 100%\))
     */
    function getFeeRate() external view returns (uint256);

    /*━━━━━━━━━━━━━━━ ADMIN WRITE FUNCTIONS ━━━━━━━━━━━━━━━*/

    /**
     * @notice Set fixed fee configuration (platform + ecosystem).
     * @dev Reverts if:
     *      - implementation-defined (authorization/validation)
     *
     * Security:
     * - Role-gated in implementation
     */
    function setFeeConfig(uint256 platformBps, uint256 ecosystemBps) external;

    /**
     * @notice Set treasury recipient addresses.
     * @dev Reverts if:
     *      - implementation-defined (authorization/validation)
     *
     * Security:
     * - Role-gated in implementation
     */
    function setTreasury(address platformTreasury, address ecosystemVault) external;

    /**
     * @notice Set dynamic fee bps for (token, feeType).
     * @dev Reverts if:
     *      - implementation-defined (authorization/validation)
     *
     * Security:
     * - Role-gated in implementation
     */
    function setDynamicFee(address token, bytes32 feeType, uint256 feeBps) external;

    /**
     * @notice Add a supported token.
     * @dev Reverts if:
     *      - implementation-defined (authorization/validation)
     *
     * Security:
     * - Role-gated in implementation
     */
    function addSupportedToken(address token) external;

    /**
     * @notice Remove a supported token.
     * @dev Reverts if:
     *      - implementation-defined (authorization/validation)
     *
     * Security:
     * - Role-gated in implementation
     */
    function removeSupportedToken(address token) external;

    /**
     * @notice Clear fee cache for (token, feeType).
     * @dev Reverts if:
     *      - implementation-defined (authorization)
     *
     * Security:
     * - Role-gated in implementation
     */
    function clearFeeCache(address token, bytes32 feeType) external;

    /**
     * @notice Pause fee distributions.
     * @dev Reverts if:
     *      - implementation-defined (authorization)
     *
     * Security:
     * - Role-gated in implementation
     */
    function pause() external;

    /**
     * @notice Unpause fee distributions.
     * @dev Reverts if:
     *      - implementation-defined (authorization)
     *
     * Security:
     * - Role-gated in implementation
     */
    function unpause() external;

    /**
     * @notice Update Registry address (module migration hook).
     * @dev Reverts if:
     *      - implementation-defined (authorization/validation)
     *
     * Security:
     * - Role-gated in implementation
     */
    function updateRegistry(address newRegistryAddr) external;

    /*━━━━━━━━━━━━━━━ VIEW FUNCTIONS ━━━━━━━━━━━━━━━*/

    /**
     * @notice Check whether a token is supported for fee routing.
     * @dev Reverts if:
     *      - none
     *
     * Security:
     * - View only
     *
     * @param token Token address
     * @return True if supported
     */
    function isTokenSupported(address token) external view returns (bool);

    /**
     * @notice Get supported token list.
     * @dev Reverts if:
     *      - none
     *
     * Security:
     * - View only
     *
     * @return Array of supported token addresses
     */
    function getSupportedTokens() external view returns (address[] memory);



    /**
     * @notice Get Registry address.
     * @dev Reverts if:
     *      - none
     *
     * Security:
     * - View only
     *
     * @return Registry address
     */
    function getRegistry() external view returns (address);

    /**
     * @notice Get platform treasury address.
     * @dev Reverts if:
     *      - none
     *
     * Security:
     * - View only
     *
     * @return Platform treasury address
     */
    function getPlatformTreasury() external view returns (address);

    /**
     * @notice Get ecosystem vault address.
     * @dev Reverts if:
     *      - none
     *
     * Security:
     * - View only
     *
     * @return Ecosystem vault address
     */
    function getEcosystemVault() external view returns (address);

    /**
     * @notice Get platform fee bps.
     * @dev Reverts if:
     *      - none
     *
     * Security:
     * - View only
     *
     * @return Platform fee bps (\(1e4 = 100%\))
     */
    function getPlatformFeeBps() external view returns (uint256);

    /**
     * @notice Get ecosystem fee bps.
     * @dev Reverts if:
     *      - none
     *
     * Security:
     * - View only
     *
     * @return Ecosystem fee bps (\(1e4 = 100%\))
     */
    function getEcosystemFeeBps() external view returns (uint256);

    /**
     * @notice Get total distribution count.
     * @dev Reverts if:
     *      - none
     *
     * Security:
     * - View only
     */
    function getTotalDistributions() external view returns (uint256);

    /**
     * @notice Get total distributed amount.
     * @dev Reverts if:
     *      - none
     *
     * Security:
     * - View only
     */
    function getTotalAmountDistributed() external view returns (uint256);

    /*━━━━━━━━━━━━━━━ ADMIN VIEW FUNCTIONS ━━━━━━━━━━━━━━━*/

    /**
     * @notice Get fee statistics (admin view).
     * @dev Reverts if:
     *      - implementation-defined
     *
     * Security:
     * - View only (may be role-gated in implementation)
     */
    function getFeeStatistics(address token, bytes32 feeType) external view returns (uint256);

    /**
     * @notice Get dynamic fee config (admin view).
     * @dev Reverts if:
     *      - implementation-defined
     *
     * Security:
     * - View only (may be role-gated in implementation)
     */
    function getDynamicFee(address token, bytes32 feeType) external view returns (uint256);

    /**
     * @notice Get fee cache (admin view).
     * @dev Reverts if:
     *      - implementation-defined
     *
     * Security:
     * - View only (may be role-gated in implementation)
     */
    function getFeeCache(address token, bytes32 feeType) external view returns (uint256);

    /**
     * @notice Get operation stats (admin view).
     * @dev Reverts if:
     *      - implementation-defined
     *
     * Security:
     * - View only (may be role-gated in implementation)
     */
    function getOperationStats() external view returns (uint256 distributions, uint256 totalAmount);
} 