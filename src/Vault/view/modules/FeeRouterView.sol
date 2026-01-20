// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { Registry } from "../../../registry/Registry.sol";
import { ModuleKeys } from "../../../constants/ModuleKeys.sol";
import { ActionKeys } from "../../../constants/ActionKeys.sol";
import { NotAContract, ZeroAddress } from "../../../errors/StandardErrors.sol";
import { ViewConstants } from "../ViewConstants.sol";
import { DataPushLibrary } from "../../../libraries/DataPushLibrary.sol";
import { DataPushTypes } from "../../../constants/DataPushTypes.sol";
import { ViewAccessLib } from "../../../libraries/ViewAccessLib.sol";
import { ViewVersioned } from "../ViewVersioned.sol";
import { IFeeRouterView } from "../../../interfaces/IFeeRouterView.sol";

// Constants migrated to DataPushTypes.

/**
 * @title FeeRouterView
 * @notice FeeRouter read-only mirror (view/cache): best-effort, low-gas reads backed by FeeRouter pushes.
 * @dev Reverts if:
 *      - Registry is not configured (see `onlyValidRegistry`)
 *      - caller is not authorized to access the requested user/system data (see modifiers)
 *      - caller is not FeeRouter for push entrypoints (see `onlyFeeRouter`)
 *
 * Security:
 * - Role-gated via `ViewAccessLib.requireRole(...)`
 * - Push entrypoints are restricted to FeeRouter (Registry.KEY_FR)
 *
 * @custom:security-contact security@example.com
 */
contract FeeRouterView is Initializable, UUPSUpgradeable, ViewVersioned, IFeeRouterView {
    
    /// @notice Registry address (module resolution SSOT).
    address private _registryAddr;
    
    /// @notice Maximum batch query size (shared constant).
    uint256 public constant MAX_BATCH_SIZE = ViewConstants.MAX_BATCH_SIZE;
    
    /*━━━━━━━━━━━━━━━ INTERNAL MIRRORS (LOW-GAS) ━━━━━━━━━━━━━━━*/
    
    /// @notice User fee statistics: user => feeType => amount.
    mapping(address => mapping(bytes32 => uint256)) private _userFeeStatistics;
    
    /// @notice User dynamic fee config: user => feeType => feeBps.
    mapping(address => mapping(bytes32 => uint256)) private _userDynamicFees;
    
    /// @notice Global fee statistics (admin-only): token => feeType => amount.
    mapping(address => mapping(bytes32 => uint256)) private _globalFeeStatistics;
    
    /// @notice Global operation stats (admin-only).
    struct GlobalStats {
        uint256 totalDistributions;
        uint256 totalAmountDistributed;
    }
    GlobalStats private _globalStats;
    
    /// @notice System config (admin-only).
    struct SystemConfig {
        address platformTreasury;
        address ecosystemVault;
        uint256 platformFeeBps;
        uint256 ecosystemFeeBps;
        address[] supportedTokens;
    }
    SystemConfig private _systemConfig;
    
    /// @notice Supported token flags (publicly readable via view functions).
    mapping(address => bool) private _supportedTokens;
    
    /// @notice User personal stats (per-user).
    struct UserStats {
        uint256 totalFeePaid;
        uint256 transactionCount;
        uint256 lastActivityTime;
    }
    mapping(address => UserStats) private _userStats;
    
    /// @notice Last sync timestamp (seconds).
    uint256 private _lastSyncTimestamp;
    
    /// @notice Sync interval (seconds).
    uint256 public constant SYNC_INTERVAL = 300; // 5 minutes
    
    /*━━━━━━━━━━━━━━━ TYPES ━━━━━━━━━━━━━━━*/

    /// @notice User fee config view.
    struct UserFeeConfig {
        uint256 personalFeeBps;
        uint256 discountLevel;
        bool vipStatus;
        uint256 totalFeePaid;
        uint256 transactionCount;
    }

    /// @notice System fee analytics (admin-only; placeholder).
    struct SystemFeeAnalytics {
        uint256 totalVolume;
        uint256 totalFees;
        uint256 platformRevenue;
        uint256 ecosystemRevenue;
        uint256 averageFeeRate;
        uint256 distributionCount;
    }

    /// @notice User fee analytics (placeholder).
    struct UserFeeAnalytics {
        uint256 totalPaidFees;
        uint256 averageFeeRate;
        uint256 transactionCount;
        uint256 lastTransactionTime;
        bytes32[] feeTypes;
        uint256[] feeAmounts;
    }

    /*━━━━━━━━━━━━━━━ EVENTS ━━━━━━━━━━━━━━━*/
    
    /**
     * @notice Emitted when this view cache is synced by the authorized writer.
     * @dev Reverts if:
     *      - N/A (event emission only)
     *
     * @param caller Writer address that performed the sync (expected: FeeRouter)
     * @param timestamp Block timestamp (seconds)
     */
    event DataSynced(address indexed caller, uint256 timestamp);
    
    /**
     * @notice DEPRECATED: emitted when user-scoped data is pushed.
     * @dev Reverts if:
     *      - N/A (event emission only)
     *
     * Security:
     * - Prefer off-chain consumers to rely on DataPushLibrary/IDataPush.DataPushed instead.
     *
     * @param user User address
     * @param dataType Human-readable data type label (deprecated)
     * @param timestamp Block timestamp (seconds)
     */
    // solhint-disable-next-line max-line-length
    event UserDataPushed(address indexed user, string dataType, uint256 timestamp); // DEPRECATED – use IDataPush.DataPushed
    
    /**
     * @notice DEPRECATED: emitted when system-scoped data is pushed.
     * @dev Reverts if:
     *      - N/A (event emission only)
     *
     * Security:
     * - Prefer off-chain consumers to rely on DataPushLibrary/IDataPush.DataPushed instead.
     *
     * @param pusher Writer address
     * @param dataType Human-readable data type label (deprecated)
     * @param timestamp Block timestamp (seconds)
     */
    // solhint-disable-next-line max-line-length
    event SystemDataPushed(address indexed pusher, string dataType, uint256 timestamp); // DEPRECATED – use IDataPush.DataPushed

    /*━━━━━━━━━━━━━━━ ERRORS ━━━━━━━━━━━━━━━*/
    
    /// @notice Thrown when caller is not authorized to access the requested user-scoped data.
    error FeeRouterView__UnauthorizedAccess();
    /// @notice Thrown when an input user address is invalid (reserved for future validation).
    error FeeRouterView__InvalidUser();
    /// @notice Thrown when caller has insufficient permissions (reserved for future use).
    error FeeRouterView__InsufficientPermission();
    /// @notice Thrown when a push entrypoint is called by a non-FeeRouter address.
    error FeeRouterView__OnlyFeeRouter();
    /// @notice Thrown when a batch query exceeds MAX_BATCH_SIZE.
    error FeeRouterView__BatchSizeTooLarge();
    /// @notice Thrown when two batch arrays have mismatched lengths.
    error FeeRouterView__ArrayLengthMismatch();
    /// @notice Thrown when an empty array is provided where a non-empty array is required.
    error FeeRouterView__EmptyArray();

    /*━━━━━━━━━━━━━━━ MODIFIERS ━━━━━━━━━━━━━━━*/

    /**
     * @notice Ensure Registry is configured.
     * @dev Reverts if:
     *      - `_registryAddr` is zero
     */
    modifier onlyValidRegistry() {
        if (_registryAddr == address(0)) revert ZeroAddress();
        if (_registryAddr.code.length == 0) revert NotAContract(_registryAddr);
        _;
    }
    
    /**
     * @notice Require admin role.
     * @dev Reverts if:
     *      - caller lacks ACTION_ADMIN
     */
    modifier onlyAdmin() {
        ViewAccessLib.requireRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender);
        _;
    }
    
    /**
     * @notice Restrict caller to FeeRouter (Registry.KEY_FR).
     * @dev Reverts if:
     *      - caller is not FeeRouter (FeeRouterView__OnlyFeeRouter)
     */
    modifier onlyFeeRouter() {
        if (msg.sender != _getFeeRouter()) revert FeeRouterView__OnlyFeeRouter();
        _;
    }
    
    /**
     * @notice Require caller to be authorized to access `user` data.
     * @dev Reverts if:
     *      - caller lacks ACTION_VIEW_USER_DATA for self access
     *      - caller is not admin for non-self access
     *
     * @param user Target user address
     */
    modifier onlyAuthorizedFor(address user) {
        if (msg.sender != user) {
            bool isAdmin = ViewAccessLib.hasRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender);
            if (!isAdmin) revert FeeRouterView__UnauthorizedAccess();
        } else {
            ViewAccessLib.requireRole(_registryAddr, ActionKeys.ACTION_VIEW_USER_DATA, msg.sender);
        }
        _;
    }

    /*━━━━━━━━━━━━━━━ CONSTRUCTION & INITIALIZATION ━━━━━━━━━━━━━━━*/

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }
    
    /**
     * @notice Initialize FeeRouterView.
     * @dev Reverts if:
     *      - initialRegistryAddr == address(0) (ZeroAddress)
     *
     * Security:
     * - Initializer guarded (initializer modifier)
     *
     * @param initialRegistryAddr Registry address (module resolver SSOT)
     */
    function initialize(address initialRegistryAddr) external initializer {
        // Validate the provided registry address instead of the un-initialised storage slot
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        if (initialRegistryAddr.code.length == 0) revert NotAContract(initialRegistryAddr);

        _registryAddr = initialRegistryAddr;
        // solhint-disable-next-line not-rely-on-time
        _lastSyncTimestamp = block.timestamp;
        
        __UUPSUpgradeable_init();
    }
    
    /*━━━━━━━━━━━━━━━ PUSH FROM FEEROUTER ━━━━━━━━━━━━━━━*/
    
    /**
     * @notice Push user fee update from FeeRouter.
     * @dev Reverts if:
     *      - Registry is not configured
     *      - caller is not FeeRouter (FeeRouterView__OnlyFeeRouter)
     *
     * Security:
     * - Restricted to FeeRouter (SSOT)
     *
     * @param user User address
     * @param feeType Fee type key
     * @param feeAmount Fee amount paid (token decimals; implementation-defined)
     * @param personalFeeBps Personal fee bps (\(1e4 = 100%\))
     */
    /**
     * @notice Push a user-scoped fee update into the view cache.
     * @dev Reverts if:
     *      - _registryAddr == address(0) (ZeroAddress)
     *      - msg.sender != Registry(_registryAddr).getModuleOrRevert(KEY_FR) (FeeRouterView__OnlyFeeRouter)
     *
     * Security:
     * - Writer-gated: only the SSOT FeeRouter may push updates.
     * - Emits DataPushTypes.DATA_TYPE_USER_FEE for off-chain consumers.
     *
     * @param user User address (cache key)
     * @param feeType Fee type identifier (bytes32)
     * @param feeAmount Fee amount to accumulate (token decimals; same unit as FeeRouter writer)
     * @param personalFeeBps Applied personal fee rate in bps (\(1e4 = 100%\))
     */
    function pushUserFeeUpdate(
        address user,
        bytes32 feeType,
        uint256 feeAmount,
        uint256 personalFeeBps
    ) external override onlyValidRegistry onlyFeeRouter {
        
        // Update user fee data
        _userFeeStatistics[user][feeType] += feeAmount;
        _userDynamicFees[user][feeType] = personalFeeBps;
        
        // Update user statistics
        _userStats[user].totalFeePaid += feeAmount;
        _userStats[user].transactionCount += 1;
        // solhint-disable-next-line not-rely-on-time
        _userStats[user].lastActivityTime = block.timestamp;
        
        // solhint-disable-next-line not-rely-on-time
        emit UserDataPushed(user, "FeeUpdate", block.timestamp);
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_USER_FEE,
            abi.encode(user, feeType, feeAmount, personalFeeBps)
        );
    }
    
    /**
     * @notice Push global stats update from FeeRouter.
     * @dev Reverts if:
     *      - Registry is not configured
     *      - caller is not FeeRouter (FeeRouterView__OnlyFeeRouter)
     *
     * Security:
     * - Restricted to FeeRouter (SSOT)
     *
     * @param totalDistributions Total distributions count
     * @param totalAmountDistributed Total distributed amount (token decimals; implementation-defined)
     */
    /**
     * @notice Push global distribution counters into the view cache.
     * @dev Reverts if:
     *      - _registryAddr == address(0) (ZeroAddress)
     *      - msg.sender != Registry(_registryAddr).getModuleOrRevert(KEY_FR) (FeeRouterView__OnlyFeeRouter)
     *
     * Security:
     * - Writer-gated: only the SSOT FeeRouter may push updates.
     * - Emits DataPushTypes.DATA_TYPE_GLOBAL_FEE_STATS for off-chain consumers.
     *
     * @param totalDistributions Total distribution count (unitless)
     * @param totalAmountDistributed Total distributed amount (token decimals aggregated by FeeRouter)
     */
    function pushGlobalStatsUpdate(
        uint256 totalDistributions,
        uint256 totalAmountDistributed
    ) external override onlyValidRegistry onlyFeeRouter {
        _globalStats.totalDistributions = totalDistributions;
        _globalStats.totalAmountDistributed = totalAmountDistributed;
        // solhint-disable-next-line not-rely-on-time
        _lastSyncTimestamp = block.timestamp;

        // solhint-disable-next-line not-rely-on-time
        emit SystemDataPushed(msg.sender, "GlobalStatsUpdate", block.timestamp);
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_GLOBAL_FEE_STATS,
            abi.encode(totalDistributions, totalAmountDistributed)
        );
    }

    /**
     * @notice Push the FeeRouter system config into the view cache.
     * @dev Reverts if:
     *      - _registryAddr == address(0) (ZeroAddress)
     *      - msg.sender != Registry(_registryAddr).getModuleOrRevert(KEY_FR) (FeeRouterView__OnlyFeeRouter)
     *
     * Security:
     * - Writer-gated: only the SSOT FeeRouter may push updates.
     * - Emits DataPushTypes.DATA_TYPE_FEE_ROUTER_SYSTEM_CONFIG_UPDATED for off-chain consumers.
     *
     * @param platformTreasury Platform treasury address
     * @param ecosystemVault Ecosystem vault address
     * @param platformFeeBps Platform fee rate in bps (\(1e4 = 100%\))
     * @param ecosystemFeeBps Ecosystem fee rate in bps (\(1e4 = 100%\))
     * @param supportedTokens Supported token list (ERC20 addresses)
     */
    function pushSystemConfigUpdate(
        address platformTreasury,
        address ecosystemVault,
        uint256 platformFeeBps,
        uint256 ecosystemFeeBps,
        address[] calldata supportedTokens
    ) external override onlyValidRegistry onlyFeeRouter {
        address[] memory previousTokens = _systemConfig.supportedTokens;
        for (uint256 i; i < previousTokens.length; ++i) {
            _supportedTokens[previousTokens[i]] = false;
        }

        _systemConfig.platformTreasury = platformTreasury;
        _systemConfig.ecosystemVault = ecosystemVault;
        _systemConfig.platformFeeBps = platformFeeBps;
        _systemConfig.ecosystemFeeBps = ecosystemFeeBps;
        _systemConfig.supportedTokens = supportedTokens;

        for (uint256 i; i < supportedTokens.length; ++i) {
            _supportedTokens[supportedTokens[i]] = true;
        }

        // solhint-disable-next-line not-rely-on-time
        emit DataSynced(msg.sender, block.timestamp);
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_FEE_ROUTER_SYSTEM_CONFIG_UPDATED,
            abi.encode(platformTreasury, ecosystemVault, platformFeeBps, ecosystemFeeBps, supportedTokens)
        );
    }

    /**
     * @notice Push a single global fee statistic value for (token, feeType).
     * @dev Reverts if:
     *      - _registryAddr == address(0) (ZeroAddress)
     *      - msg.sender != Registry(_registryAddr).getModuleOrRevert(KEY_FR) (FeeRouterView__OnlyFeeRouter)
     *
     * Security:
     * - Writer-gated: only the SSOT FeeRouter may push updates.
     * - Emits DataPushTypes.DATA_TYPE_FEE_ROUTER_GLOBAL_FEE_STATISTIC_UPDATED for off-chain consumers.
     *
     * @param token ERC20 token address (cache key)
     * @param feeType Fee type identifier (bytes32)
     * @param amount Total accumulated amount (token decimals)
     */
    function pushGlobalFeeStatistic(
        address token,
        bytes32 feeType,
        uint256 amount
    ) external override onlyValidRegistry onlyFeeRouter {
        _globalFeeStatistics[token][feeType] = amount;
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_FEE_ROUTER_GLOBAL_FEE_STATISTIC_UPDATED,
            abi.encode(token, feeType, amount)
        );
    }
    
    /*━━━━━━━━━━━━━━━ USER QUERY FUNCTIONS (ACCESS CONTROLLED) ━━━━━━━━━━━━━━━*/
    
    /**
     * @notice Check whether this view cache appears stale based on the last sync timestamp.
     * @dev Reverts if:
     *      - none
     *
     * Security:
     * - Reads block.timestamp (time-based heuristic).
     *
     * @return True if `(block.timestamp - _lastSyncTimestamp) > SYNC_INTERVAL`.
     */
    function needsSync() public view returns (bool) {
        // solhint-disable-next-line not-rely-on-time
        return (block.timestamp - _lastSyncTimestamp) > SYNC_INTERVAL;
    }
    
    /**
     * @notice Get user fee statistics for a fee type (user-scoped view; access-controlled).
     * @dev Reverts if:
     *      - _registryAddr == address(0) (ZeroAddress)
     *      - msg.sender is not authorized for `user` (FeeRouterView__UnauthorizedAccess / ACM roles)
     *
     * Security:
     * - Access-controlled via ACTION_VIEW_USER_DATA (self) or ACTION_ADMIN (non-self).
     *
     * @param user Target user address
     * @param feeType Fee type identifier (bytes32)
     * @return amount Accumulated fee amount (token decimals; as pushed by FeeRouter)
     */
    function getUserFeeStatistics(address user, bytes32 feeType) 
        external view onlyValidRegistry onlyAuthorizedFor(user) returns (uint256) {
        return _userFeeStatistics[user][feeType];
    }

    /**
     * @notice Get the last pushed personal fee rate for a user and fee type (user-scoped; access-controlled).
     * @dev Reverts if:
     *      - _registryAddr == address(0) (ZeroAddress)
     *      - msg.sender is not authorized for `user` (FeeRouterView__UnauthorizedAccess / ACM roles)
     *
     * Security:
     * - Access-controlled via ACTION_VIEW_USER_DATA (self) or ACTION_ADMIN (non-self).
     *
     * @param user Target user address
     * @param feeType Fee type identifier (bytes32)
     * @return feeBps Personal fee rate in bps (\(1e4 = 100%\))
     */
    function getUserDynamicFee(address user, bytes32 feeType) 
        external view onlyValidRegistry onlyAuthorizedFor(user) returns (uint256) {
        return _userDynamicFees[user][feeType];
    }

    /**
     * @notice Get per-user aggregate stats (user-scoped; access-controlled).
     * @dev Reverts if:
     *      - _registryAddr == address(0) (ZeroAddress)
     *      - msg.sender is not authorized for `user` (FeeRouterView__UnauthorizedAccess / ACM roles)
     *
     * Security:
     * - Access-controlled via ACTION_VIEW_USER_DATA (self) or ACTION_ADMIN (non-self).
     *
     * @param user Target user address
     * @return stats User stats struct (amounts in token decimals, timestamps in seconds)
     */
    function getUserStats(address user) 
        external view onlyValidRegistry onlyAuthorizedFor(user) returns (UserStats memory stats) {
        return _userStats[user];
    }

    /**
     * @notice Get a derived user fee config view (placeholder analytics; access-controlled).
     * @dev Reverts if:
     *      - _registryAddr == address(0) (ZeroAddress)
     *      - msg.sender is not authorized for `user` (FeeRouterView__UnauthorizedAccess / ACM roles)
     *
     * Security:
     * - Access-controlled via ACTION_VIEW_USER_DATA (self) or ACTION_ADMIN (non-self).
     *
     * @param user Target user address
     * @return config Derived config view (bps in 1e4 scale; counts unitless; amounts in token decimals)
     */
    function getUserFeeConfig(address user) 
        external view onlyValidRegistry onlyAuthorizedFor(user) returns (UserFeeConfig memory config) {
        config.personalFeeBps = _userDynamicFees[user][bytes32(0)]; // Default fee rate
        config.totalFeePaid = _userStats[user].totalFeePaid;
        config.transactionCount = _userStats[user].transactionCount;
        // Calculate VIP status and discount level based on fee payments.
        config.vipStatus = _userStats[user].totalFeePaid > 1000 ether;
        config.discountLevel = _calculateDiscountLevel(user);
    }

    /**
     * @notice Check whether a token is supported (public view).
     * @dev Reverts if:
     *      - none
     *
     * @param token ERC20 token address
     * @return supported True if token is currently marked as supported in the cached config.
     */
    function isTokenSupported(address token) external view returns (bool) {
        return _supportedTokens[token];
    }

    /**
     * @notice Get supported token list (public view).
     * @dev Reverts if:
     *      - none
     *
     * @return tokens List of supported ERC20 token addresses (cached)
     */
    function getSupportedTokens() external view returns (address[] memory) {
        return _systemConfig.supportedTokens;
    }

    /*━━━━━━━━━━━━━━━ ADMIN QUERY FUNCTIONS (ONLY ADMIN) ━━━━━━━━━━━━━━━*/
    
    /**
     * @notice Get global fee statistics for (token, feeType) (admin-only).
     * @dev Reverts if:
     *      - _registryAddr == address(0) (ZeroAddress)
     *      - msg.sender lacks ACTION_ADMIN (ACM)
     *
     * Security:
     * - Admin-gated via ACTION_ADMIN.
     *
     * @param token ERC20 token address
     * @param feeType Fee type identifier (bytes32)
     * @return amount Total accumulated amount (token decimals; as pushed by FeeRouter)
     */
    function getGlobalFeeStatistics(address token, bytes32 feeType) 
        external view onlyValidRegistry onlyAdmin returns (uint256) {
        return _globalFeeStatistics[token][feeType];
    }

    /**
     * @notice Get global operation stats (admin-only).
     * @dev Reverts if:
     *      - _registryAddr == address(0) (ZeroAddress)
     *      - msg.sender lacks ACTION_ADMIN (ACM)
     *
     * Security:
     * - Admin-gated via ACTION_ADMIN.
     *
     * @return distributions Total distribution count (unitless)
     * @return totalAmount Total distributed amount (token decimals aggregated by FeeRouter)
     */
    function getGlobalOperationStats() 
        external view onlyValidRegistry onlyAdmin returns (uint256 distributions, uint256 totalAmount) {
        return (_globalStats.totalDistributions, _globalStats.totalAmountDistributed);
    }

    /**
     * @notice Get cached system config (admin-only).
     * @dev Reverts if:
     *      - _registryAddr == address(0) (ZeroAddress)
     *      - msg.sender lacks ACTION_ADMIN (ACM)
     *
     * Security:
     * - Admin-gated via ACTION_ADMIN.
     *
     * @return config Cached system config (addresses + bps + token list)
     */
    function getSystemConfig() 
        external view onlyValidRegistry onlyAdmin returns (SystemConfig memory config) {
        return _systemConfig;
    }

    /**
     * @notice Get derived system fee analytics (admin-only; placeholder).
     * @dev Reverts if:
     *      - _registryAddr == address(0) (ZeroAddress)
     *      - msg.sender lacks ACTION_ADMIN (ACM)
     *
     * Security:
     * - Admin-gated via ACTION_ADMIN.
     *
     * @return analytics Derived analytics values (amounts in token decimals; bps in 1e4 scale)
     */
    function getSystemFeeAnalytics() 
        external view onlyValidRegistry onlyAdmin returns (SystemFeeAnalytics memory analytics) {
        analytics.distributionCount = _globalStats.totalDistributions;
        analytics.totalVolume = _globalStats.totalAmountDistributed;
        
        uint256 platformFeeBps = _systemConfig.platformFeeBps;
        uint256 ecosystemFeeBps = _systemConfig.ecosystemFeeBps;
        
        analytics.totalFees = (analytics.totalVolume * (platformFeeBps + ecosystemFeeBps)) / 10000;
        analytics.platformRevenue = (analytics.totalVolume * platformFeeBps) / 10000;
        analytics.ecosystemRevenue = (analytics.totalVolume * ecosystemFeeBps) / 10000;
        analytics.averageFeeRate = platformFeeBps + ecosystemFeeBps;
    }

    /*━━━━━━━━━━━━━━━ BATCH QUERY FUNCTIONS ━━━━━━━━━━━━━━━*/
    
    /**
     * @notice Batch get user fee statistics for multiple fee types (user-scoped; access-controlled).
     * @dev Reverts if:
     *      - _registryAddr == address(0) (ZeroAddress)
     *      - msg.sender is not authorized for `user` (FeeRouterView__UnauthorizedAccess / ACM roles)
     *      - feeTypes.length > MAX_BATCH_SIZE (FeeRouterView__BatchSizeTooLarge)
     *
     * Security:
     * - Access-controlled via ACTION_VIEW_USER_DATA (self) or ACTION_ADMIN (non-self).
     *
     * @param user Target user address
     * @param feeTypes Fee type identifiers (bytes32[])
     * @return feeStatistics Per-feeType accumulated amounts (token decimals; as pushed by FeeRouter)
     */
    function batchGetUserFeeStatistics(
        address user,
        bytes32[] calldata feeTypes
    ) external view onlyValidRegistry onlyAuthorizedFor(user) returns (uint256[] memory feeStatistics) {
        if (feeTypes.length > MAX_BATCH_SIZE) revert FeeRouterView__BatchSizeTooLarge();
        
        feeStatistics = new uint256[](feeTypes.length);
        for (uint256 i = 0; i < feeTypes.length; i++) {
            feeStatistics[i] = _userFeeStatistics[user][feeTypes[i]];
        }
    }

    /**
     * @notice Batch get global fee statistics for multiple (token, feeType) pairs (admin-only).
     * @dev Reverts if:
     *      - _registryAddr == address(0) (ZeroAddress)
     *      - msg.sender lacks ACTION_ADMIN (ACM)
     *      - tokens.length != feeTypes.length (FeeRouterView__ArrayLengthMismatch)
     *      - tokens.length > MAX_BATCH_SIZE (FeeRouterView__BatchSizeTooLarge)
     *
     * Security:
     * - Admin-gated via ACTION_ADMIN.
     *
     * @param tokens ERC20 token addresses
     * @param feeTypes Fee type identifiers (bytes32[])
     * @return feeStatistics Per-pair accumulated amounts (token decimals)
     */
    function batchGetGlobalFeeStatistics(
        address[] calldata tokens, 
        bytes32[] calldata feeTypes
    ) external view onlyValidRegistry onlyAdmin returns (uint256[] memory feeStatistics) {
        if (tokens.length != feeTypes.length) revert FeeRouterView__ArrayLengthMismatch();
        if (tokens.length > MAX_BATCH_SIZE) revert FeeRouterView__BatchSizeTooLarge();
        
        feeStatistics = new uint256[](tokens.length);
        for (uint256 i = 0; i < tokens.length; i++) {
            feeStatistics[i] = _globalFeeStatistics[tokens[i]][feeTypes[i]];
        }
    }

    /**
     * @notice Batch check token support status (public view).
     * @dev Reverts if:
     *      - tokens.length == 0 (FeeRouterView__EmptyArray)
     *      - tokens.length > MAX_BATCH_SIZE (FeeRouterView__BatchSizeTooLarge)
     *
     * @param tokens ERC20 token addresses
     * @return supported Per-token support flags
     */
    function batchCheckTokenSupport(address[] calldata tokens) 
        external view returns (bool[] memory supported) {
        if (tokens.length == 0) revert FeeRouterView__EmptyArray();
        if (tokens.length > MAX_BATCH_SIZE) revert FeeRouterView__BatchSizeTooLarge();
        
        supported = new bool[](tokens.length);
        for (uint256 i = 0; i < tokens.length; i++) {
            supported[i] = _supportedTokens[tokens[i]];
        }
    }
    
    /*━━━━━━━━━━━━━━━ ADVANCED ANALYTICS FUNCTIONS ━━━━━━━━━━━━━━━*/
    
    /**
     * @notice Get derived user fee analytics (placeholder; access-controlled).
     * @dev Reverts if:
     *      - _registryAddr == address(0) (ZeroAddress)
     *      - msg.sender is not authorized for `user` (FeeRouterView__UnauthorizedAccess / ACM roles)
     *      - feeTypes.length > MAX_BATCH_SIZE (FeeRouterView__BatchSizeTooLarge)
     *
     * Security:
     * - Access-controlled via ACTION_VIEW_USER_DATA (self) or ACTION_ADMIN (non-self).
     *
     * @param user Target user address
     * @param feeTypes Fee type identifiers (bytes32[])
     * @return analytics Derived analytics (amounts in token decimals; counts unitless; timestamps in seconds)
     */
    function getUserFeeAnalytics(address user, bytes32[] calldata feeTypes) 
        external view onlyValidRegistry onlyAuthorizedFor(user) returns (UserFeeAnalytics memory analytics) {
        if (feeTypes.length > MAX_BATCH_SIZE) revert FeeRouterView__BatchSizeTooLarge();
        
        UserStats memory userStats = _userStats[user];
        
        analytics.totalPaidFees = userStats.totalFeePaid;
        analytics.transactionCount = userStats.transactionCount;
        analytics.lastTransactionTime = userStats.lastActivityTime;
        analytics.feeTypes = feeTypes;
        analytics.feeAmounts = new uint256[](feeTypes.length);
        
        uint256 totalFees = 0;
        for (uint256 i = 0; i < feeTypes.length; i++) {
            uint256 feeAmount = _userFeeStatistics[user][feeTypes[i]];
            analytics.feeAmounts[i] = feeAmount;
            totalFees += feeAmount;
        }
        
        // Compute a simple average fee rate proxy (placeholder).
        if (analytics.transactionCount > 0) {
            analytics.averageFeeRate = (totalFees * 10000) / analytics.transactionCount;
        }
    }

    /*━━━━━━━━━━━━━━━ INTERNAL HELPER FUNCTIONS ━━━━━━━━━━━━━━━*/
    
    /**
     * @notice Compute a derived discount level for a user (placeholder).
     * @dev Reverts if:
     *      - none
     *
     * Security:
     * - View-only; uses cached aggregates as input.
     *
     * @param user Target user address
     * @return level Discount level (unitless; higher means larger discount)
     */
    function _calculateDiscountLevel(address user) internal view returns (uint256) {
        UserStats memory userStats = _userStats[user];
        
        if (userStats.totalFeePaid >= 10000 ether) return 5; // highest level
        if (userStats.totalFeePaid >= 5000 ether) return 4;
        if (userStats.totalFeePaid >= 1000 ether) return 3;
        if (userStats.totalFeePaid >= 500 ether) return 2;
        if (userStats.totalFeePaid >= 100 ether) return 1;
        return 0; // no discount
    }
    
    /*━━━━━━━━━━━━━━━ Registry Management Functions ━━━━━━━━━━━━━━━*/
    
    /**
     * @notice Get configured Registry address.
     * @dev Reverts if:
     *      - none
     *
     * @return registry Registry address (module resolver)
     */
    function getRegistry() external view returns (address) {
        return _registryAddr;
    }

    /**
     * @notice Resolve current FeeRouter address from Registry (SSOT writer address).
     * @dev Reverts if:
     *      - Registry resolution reverts (Registry.getModuleOrRevert)
     *
     * @return feeRouter FeeRouter module address (Registry.KEY_FR)
     */
    function getFeeRouter() external view returns (address) {
        return _getFeeRouter();
    }

    /**
     * @notice Legacy getter for registry address (backwards compatibility).
     * @dev Reverts if:
     *      - none
     *
     * @return registry Registry address
     */
    function registryAddr() external view returns(address){return _registryAddr;}

    /*━━━━━━━━━━━━━━━ CONTRACT UPGRADE ━━━━━━━━━━━━━━━*/
    
    /**
     * @notice Authorize UUPS upgrade.
     * @dev Reverts if:
     *      - _registryAddr == address(0) (ZeroAddress)
     *      - msg.sender lacks ACTION_ADMIN (ACM)
     *      - newImplementation == address(0) (ZeroAddress)
     *
     * Security:
     * - Role-gated via ACTION_ADMIN.
     *
     * @param newImplementation New implementation address
     */
    function _authorizeUpgrade(address newImplementation) internal view override onlyValidRegistry {
        ViewAccessLib.requireRole(_registryAddr, ActionKeys.ACTION_ADMIN, msg.sender);
        if (newImplementation == address(0)) revert ZeroAddress();
        if (newImplementation.code.length == 0) revert NotAContract(newImplementation);
    }

    function _getFeeRouter() internal view returns (address) {
        return Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_FR);
    }

    /**
     * @notice API version of this view module.
     * @dev Reverts if:
     *      - none
     *
     * @return version Semantic API version (uint256)
     */
    function apiVersion() public pure override returns (uint256) {
        return 1;
    }

    /**
     * @notice Schema version of this view module.
     * @dev Reverts if:
     *      - none
     *
     * @return version Schema version (uint256)
     */
    function schemaVersion() public pure override returns (uint256) {
        return 1;
    }

    /*━━━━━━━━━━━━━━━ STORAGE GAP FOR UPGRADE-SAFE LAYOUT CHANGES ━━━━━━━━━━━━━━━*/
    
    /// @notice Reserved storage gap for upgrade-safe layout changes.
    uint256[35] private __gap;
}