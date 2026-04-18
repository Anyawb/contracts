// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Registry} from "../../../registry/Registry.sol";
import {ModuleKeys} from "../../../constants/ModuleKeys.sol";
import {ActionKeys} from "../../../constants/ActionKeys.sol";
import {
    ArrayLengthMismatch,
    BatchTooLarge,
    EmptyArray,
    MissingRole,
    NotAContract,
    ZeroAddress
} from "../../../errors/StandardErrors.sol";
import {ViewConstants} from "../ViewConstants.sol";
import {DataPushLibrary} from "../../../libraries/DataPushLibrary.sol";
import {DataPushTypes} from "../../../constants/DataPushTypes.sol";
import {ViewAccessLib} from "../../../libraries/ViewAccessLib.sol";
import {ViewVersioned} from "../ViewVersioned.sol";
import {IFeeRouterView} from "../../../interfaces/IFeeRouterView.sol";
import {IVaultCoreMinimal} from "../../../interfaces/IVaultCoreMinimal.sol";

// Constants migrated to DataPushTypes.

/**
 * @title FeeRouterView
 * @notice FeeRouter view mirror (view/cache): best-effort, low-gas reads backed by FeeRouter pushes.
 * @dev Reverts if:
 *      - registry is not configured or not a contract (see {ZeroAddress}, {NotAContract})
 *      - caller lacks required read permissions for the requested scope (see access-control modifiers)
 *      - caller is not the SSOT FeeRouter writer for push entrypoints (see {FeeRouterView__OnlyFeeRouter})
 *
 * Security:
 * - Role-gated reads via {ViewAccessLib} and {ActionKeys}
 * - Writer-gated pushes: only the FeeRouter module or the canonical view gateway resolved via VaultCore.viewContractAddrVar()
 */
contract FeeRouterView is
    Initializable,
    UUPSUpgradeable,
    ViewVersioned,
    IFeeRouterView
{
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
    mapping(address => mapping(bytes32 => uint256))
        private _globalFeeStatistics;

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
        /// @dev Time-Dependency-Refactor: block-based time axis marker (block.number).
        uint256 lastActivityBlock;
    }
    mapping(address => UserStats) private _userStats;
    /// @notice Per-user cache write marker (legacy naming in APIs may still call this "blockNumber").
    /// @dev Stored value is `updateBlock` (block.number), not seconds.
    mapping(address => uint256) private _userCacheUpdateBlocks;

    /// @notice Last sync marker (legacy naming in APIs may still call this "blockNumber").
    /// @dev Stored value is `lastSyncBlock` (block.number), not seconds.
    uint256 private _lastSyncBlock;

    /// @notice Sync interval expressed in blocks (SSOT for time-dependency refactor).
    /// @dev Default aligns with `ViewConstants.CACHE_DURATION_BLOCKS` (block-based; chain-dependent).
    uint256 public constant SYNC_INTERVAL_BLOCKS =
        ViewConstants.CACHE_DURATION_BLOCKS;

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
     * @param blockNumber Legacy field: emit-time axis marker (treated as blockNumber in this repo)
     */
    event DataSynced(address indexed caller, uint256 blockNumber);

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
     * @param blockNumber Legacy field: emit-time axis marker (treated as blockNumber in this repo)
     */
    event UserDataPushed(
        address indexed user,
        string dataType,
        uint256 blockNumber
    ); // DEPRECATED – use IDataPush.DataPushed

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
     * @param blockNumber Legacy field: emit-time axis marker (treated as blockNumber in this repo)
     */
    event SystemDataPushed(
        address indexed pusher,
        string dataType,
        uint256 blockNumber
    ); // DEPRECATED – use IDataPush.DataPushed

    /*━━━━━━━━━━━━━━━ ERRORS ━━━━━━━━━━━━━━━*/

    /// @notice Thrown when a push entrypoint is called by neither FeeRouter nor the canonical view gateway.
    error FeeRouterView__OnlyFeeRouter();
    // Batch errors use StandardErrors for cross-module consistency.

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
        if (
            !ViewAccessLib.hasRole(
                _registryAddr,
                ActionKeys.ACTION_ADMIN,
                msg.sender
            )
        ) {
            revert MissingRole();
        }
        _;
    }

    /**
     * @notice Restrict caller to FeeRouter (Registry.KEY_FR) or the canonical view gateway.
     * @dev Reverts if:
     *      - caller is neither FeeRouter nor the view gateway (FeeRouterView__OnlyFeeRouter)
     */
    modifier onlyFeeRouter() {
        address feeRouter = _getFeeRouter();
        address viewGateway = _getViewGateway();
        if (msg.sender != feeRouter && msg.sender != viewGateway)
            revert FeeRouterView__OnlyFeeRouter();
        _;
    }

    /**
     * @notice Require caller to be authorized to access `user` data.
     * @dev Reverts if:
     *      - msg.sender != user and lacks ACTION_VIEW_USER_DATA or ACTION_ADMIN (MissingRole)
     *
     * @param user Target user address
     */
    modifier onlyAuthorizedFor(address user) {
        // Scheme U (SSOT):
        // - self read: allowed
        // - non-self: ops/admin only
        if (msg.sender != user) {
            bool ok = ViewAccessLib.hasRole(
                _registryAddr,
                ActionKeys.ACTION_VIEW_USER_DATA,
                msg.sender
            ) ||
                ViewAccessLib.hasRole(
                    _registryAddr,
                    ActionKeys.ACTION_ADMIN,
                    msg.sender
                );
            if (!ok) revert MissingRole();
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
        if (initialRegistryAddr.code.length == 0)
            revert NotAContract(initialRegistryAddr);

        _registryAddr = initialRegistryAddr;
        _lastSyncBlock = block.number;

        __UUPSUpgradeable_init();
    }

    /*━━━━━━━━━━━━━━━ PUSH FROM FEEROUTER ━━━━━━━━━━━━━━━*/

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
        _userStats[user].lastActivityBlock = block.number;
        _userCacheUpdateBlocks[user] = block.number;
        _lastSyncBlock = block.number;

        emit UserDataPushed(user, "FeeUpdate", block.number);
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_USER_FEE,
            abi.encode(user, feeType, feeAmount, personalFeeBps)
        );
    }

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
        _lastSyncBlock = block.number;

        emit SystemDataPushed(msg.sender, "GlobalStatsUpdate", block.number);
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

        _lastSyncBlock = block.number;
        emit DataSynced(msg.sender, block.number);
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_FEE_ROUTER_SYSTEM_CONFIG_UPDATED,
            abi.encode(
                platformTreasury,
                ecosystemVault,
                platformFeeBps,
                ecosystemFeeBps,
                supportedTokens
            )
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
        _lastSyncBlock = block.number;
        DataPushLibrary._emitData(
            DataPushTypes.DATA_TYPE_FEE_ROUTER_GLOBAL_FEE_STATISTIC_UPDATED,
            abi.encode(token, feeType, amount)
        );
    }

    /*━━━━━━━━━━━━━━━ USER QUERY FUNCTIONS (ACCESS CONTROLLED) ━━━━━━━━━━━━━━━*/

    /**
     * @notice Check whether this view cache appears stale based on the last sync blockNumber.
     * @dev Reverts if: (never)
     *
     * Security:
     * - Block-based heuristic using block.number (Time-Dependency-Refactor).
     *
     * @return True if `(block.number - _lastSyncBlock) > SYNC_INTERVAL_BLOCKS`.
     */
    function _needsSync() internal view returns (bool) {
        uint256 last = _lastSyncBlock;
        if (last == 0 || last > block.number) return true;
        return (block.number - last) > SYNC_INTERVAL_BLOCKS;
    }

    /**
     * @notice Returns cache sync metadata for this view module.
     * @dev Reverts if:
     *      - (never)
     *
     * Security:
     * - Block-based heuristic using block.number via {needsSync}
     *
     * @return isValid True if cache is considered valid by the time heuristic
     * @return lastSyncBlock Last sync marker (blockNumber axis)
     * @return needsSyncFlag True if cache is considered stale by the time heuristic
     */
    function getSyncStatus()
        external
        view
        returns (bool isValid, uint256 lastSyncBlock, bool needsSyncFlag)
    {
        lastSyncBlock = _lastSyncBlock;
        needsSyncFlag = _needsSync();
        isValid = lastSyncBlock > 0 && !needsSyncFlag;
    }

    /**
     * @notice Get user fee statistics for a fee type, with cache metadata (user-scoped; access-controlled).
     * @dev Reverts if:
     *      - _registryAddr == address(0) (ZeroAddress)
     *      - msg.sender is not authorized for `user` (MissingRole via Scheme U)
     *
     * Security:
     * - Access-controlled via ACTION_VIEW_USER_DATA (self) or ACTION_ADMIN (non-self).
     *
     * @param user Target user address
     * @param feeType Fee type identifier (bytes32)
     * @return amount Accumulated fee amount (token decimals; as pushed by FeeRouter)
     * @return blockNumber Cache blockNumber (blocks)
     * @return isValid Cache validity (TTL based on SYNC_INTERVAL)
     */
    function getUserFeeStatisticsWithMeta(
        address user,
        bytes32 feeType
    )
        external
        view
        onlyValidRegistry
        onlyAuthorizedFor(user)
        returns (uint256 amount, uint256 blockNumber, bool isValid)
    {
        amount = _userFeeStatistics[user][feeType];
        blockNumber = _userCacheUpdateBlocks[user];
        isValid = _isUserCacheValid(blockNumber);
    }

    /**
     * @notice Get the last pushed personal fee rate for a user and fee type, with cache metadata.
     * @dev Reverts if:
     *      - _registryAddr == address(0) (ZeroAddress)
     *      - msg.sender is not authorized for `user` (MissingRole via Scheme U)
     *
     * Security:
     * - Access-controlled via ACTION_VIEW_USER_DATA (self) or ACTION_ADMIN (non-self).
     *
     * @param user Target user address
     * @param feeType Fee type identifier (bytes32)
     * @return feeBps Personal fee rate in bps (\(1e4 = 100%\))
     * @return blockNumber Cache blockNumber (blocks)
     * @return isValid Cache validity (TTL based on SYNC_INTERVAL)
     */
    function getUserDynamicFeeWithMeta(
        address user,
        bytes32 feeType
    )
        external
        view
        onlyValidRegistry
        onlyAuthorizedFor(user)
        returns (uint256 feeBps, uint256 blockNumber, bool isValid)
    {
        feeBps = _userDynamicFees[user][feeType];
        blockNumber = _userCacheUpdateBlocks[user];
        isValid = _isUserCacheValid(blockNumber);
    }

    /**
     * @notice Get per-user aggregate stats, with cache metadata (user-scoped; access-controlled).
     * @dev Reverts if:
     *      - _registryAddr == address(0) (ZeroAddress)
     *      - msg.sender is not authorized for `user` (MissingRole via Scheme U)
     *
     * Security:
     * - Access-controlled via ACTION_VIEW_USER_DATA (self) or ACTION_ADMIN (non-self).
     *
     * @param user Target user address
     * @return stats User stats struct (amounts in token decimals, blockNumbers as blocks)
     * @return blockNumber Cache blockNumber (blocks)
     * @return isValid Cache validity (TTL based on SYNC_INTERVAL)
     */
    function getUserStatsWithMeta(
        address user
    )
        external
        view
        onlyValidRegistry
        onlyAuthorizedFor(user)
        returns (UserStats memory stats, uint256 blockNumber, bool isValid)
    {
        stats = _userStats[user];
        blockNumber = _userCacheUpdateBlocks[user];
        isValid = _isUserCacheValid(blockNumber);
    }

    /**
     * @notice Get a derived user fee config view, with cache metadata (placeholder analytics; access-controlled).
     * @dev Reverts if:
     *      - _registryAddr == address(0) (ZeroAddress)
     *      - msg.sender is not authorized for `user` (MissingRole via Scheme U)
     *
     * Security:
     * - Access-controlled via ACTION_VIEW_USER_DATA (self) or ACTION_ADMIN (non-self).
     *
     * @param user Target user address
     * @return config Derived config view (bps in 1e4 scale; counts unitless; amounts in token decimals)
     * @return blockNumber Cache blockNumber (blocks)
     * @return isValid Cache validity (TTL based on SYNC_INTERVAL)
     */
    function getUserFeeConfigWithMeta(
        address user
    )
        external
        view
        onlyValidRegistry
        onlyAuthorizedFor(user)
        returns (UserFeeConfig memory config, uint256 blockNumber, bool isValid)
    {
        config.personalFeeBps = _userDynamicFees[user][bytes32(0)]; // Default fee rate
        config.totalFeePaid = _userStats[user].totalFeePaid;
        config.transactionCount = _userStats[user].transactionCount;
        // Calculate VIP status and discount level based on fee payments.
        config.vipStatus = _userStats[user].totalFeePaid > 1000 ether;
        config.discountLevel = _calculateDiscountLevel(user);
        blockNumber = _userCacheUpdateBlocks[user];
        isValid = _isUserCacheValid(blockNumber);
    }

    /**
     * @notice Check whether a token is supported, with cache metadata (public view).
     * @dev Reverts if: (never)
     *
     * @param token ERC20 token address
     * @return supported True if token is currently marked as supported in the cached config.
     * @return blockNumber Cache blockNumber (blocks)
     * @return isValid Cache validity (TTL based on SYNC_INTERVAL)
     */
    function isTokenSupportedWithMeta(
        address token
    )
        external
        view
        returns (bool supported, uint256 blockNumber, bool isValid)
    {
        supported = _supportedTokens[token];
        blockNumber = _lastSyncBlock;
        isValid = _isSystemCacheValid(blockNumber);
    }

    /**
     * @notice Get supported token list, with cache metadata (public view).
     * @dev Reverts if: (never)
     *
     * @return tokens List of supported ERC20 token addresses (cached)
     * @return blockNumber Cache blockNumber (blocks)
     * @return isValid Cache validity (TTL based on SYNC_INTERVAL)
     */
    function getSupportedTokensWithMeta()
        external
        view
        returns (address[] memory tokens, uint256 blockNumber, bool isValid)
    {
        tokens = _systemConfig.supportedTokens;
        blockNumber = _lastSyncBlock;
        isValid = _isSystemCacheValid(blockNumber);
    }

    /*━━━━━━━━━━━━━━━ ADMIN QUERY FUNCTIONS (ONLY ADMIN) ━━━━━━━━━━━━━━━*/

    /**
     * @notice Get global fee statistics for (token, feeType), with cache metadata (admin-only).
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
     * @return blockNumber Cache blockNumber (blocks)
     * @return isValid Cache validity (TTL based on SYNC_INTERVAL)
     */
    function getGlobalFeeStatisticsWithMeta(
        address token,
        bytes32 feeType
    )
        external
        view
        onlyValidRegistry
        onlyAdmin
        returns (uint256 amount, uint256 blockNumber, bool isValid)
    {
        amount = _globalFeeStatistics[token][feeType];
        blockNumber = _lastSyncBlock;
        isValid = _isSystemCacheValid(blockNumber);
    }

    /**
     * @notice Get global operation stats, with cache metadata (admin-only).
     * @dev Reverts if:
     *      - _registryAddr == address(0) (ZeroAddress)
     *      - msg.sender lacks ACTION_ADMIN (ACM)
     *
     * Security:
     * - Admin-gated via ACTION_ADMIN.
     *
     * @return distributions Total distribution count (unitless)
     * @return totalAmount Total distributed amount (token decimals aggregated by FeeRouter)
     * @return blockNumber Cache blockNumber (blocks)
     * @return isValid Cache validity (TTL based on SYNC_INTERVAL)
     */
    function getGlobalOperationStatsWithMeta()
        external
        view
        onlyValidRegistry
        onlyAdmin
        returns (
            uint256 distributions,
            uint256 totalAmount,
            uint256 blockNumber,
            bool isValid
        )
    {
        distributions = _globalStats.totalDistributions;
        totalAmount = _globalStats.totalAmountDistributed;
        blockNumber = _lastSyncBlock;
        isValid = _isSystemCacheValid(blockNumber);
    }

    /**
     * @notice Get cached system config, with cache metadata (admin-only).
     * @dev Reverts if:
     *      - _registryAddr == address(0) (ZeroAddress)
     *      - msg.sender lacks ACTION_ADMIN (ACM)
     *
     * Security:
     * - Admin-gated via ACTION_ADMIN.
     *
     * @return config Cached system config (addresses + bps + token list)
     * @return blockNumber Cache blockNumber (blocks)
     * @return isValid Cache validity (TTL based on SYNC_INTERVAL)
     */
    function getSystemConfigWithMeta()
        external
        view
        onlyValidRegistry
        onlyAdmin
        returns (SystemConfig memory config, uint256 blockNumber, bool isValid)
    {
        config = _systemConfig;
        blockNumber = _lastSyncBlock;
        isValid = _isSystemCacheValid(blockNumber);
    }

    /**
     * @notice Get derived system fee analytics, with cache metadata (admin-only; placeholder).
     * @dev Reverts if:
     *      - _registryAddr == address(0) (ZeroAddress)
     *      - msg.sender lacks ACTION_ADMIN (ACM)
     *
     * Security:
     * - Admin-gated via ACTION_ADMIN.
     *
     * @return analytics Derived analytics values (amounts in token decimals; bps in 1e4 scale)
     * @return blockNumber Cache blockNumber (blocks)
     * @return isValid Cache validity (TTL based on SYNC_INTERVAL)
     */
    function getSystemFeeAnalyticsWithMeta()
        external
        view
        onlyValidRegistry
        onlyAdmin
        returns (
            SystemFeeAnalytics memory analytics,
            uint256 blockNumber,
            bool isValid
        )
    {
        analytics.distributionCount = _globalStats.totalDistributions;
        analytics.totalVolume = _globalStats.totalAmountDistributed;

        uint256 platformFeeBps = _systemConfig.platformFeeBps;
        uint256 ecosystemFeeBps = _systemConfig.ecosystemFeeBps;

        analytics.totalFees =
            (analytics.totalVolume * (platformFeeBps + ecosystemFeeBps)) /
            10000;
        analytics.platformRevenue =
            (analytics.totalVolume * platformFeeBps) / 10000;
        analytics.ecosystemRevenue =
            (analytics.totalVolume * ecosystemFeeBps) / 10000;
        analytics.averageFeeRate = platformFeeBps + ecosystemFeeBps;
        blockNumber = _lastSyncBlock;
        isValid = _isSystemCacheValid(blockNumber);
    }

    /*━━━━━━━━━━━━━━━ BATCH QUERY FUNCTIONS ━━━━━━━━━━━━━━━*/

    /**
     * @notice Batch get user fee statistics for multiple fee types, with cache metadata.
     *         (User-scoped; access-controlled.)
     * @dev Reverts if:
     *      - _registryAddr == address(0) (see {ZeroAddress})
     *      - msg.sender is not authorized for `user` (MissingRole via Scheme U)
     *      - feeTypes.length > MAX_BATCH_SIZE (see {BatchTooLarge})
     *
     * Security:
     * - Access-controlled via ACTION_VIEW_USER_DATA (self) or ACTION_ADMIN (non-self).
     *
     * @param user Target user address
     * @param feeTypes Fee type identifiers (bytes32[])
     * @return feeStatistics Per-feeType accumulated amounts (token decimals; as pushed by FeeRouter)
     * @return blockNumber Cache blockNumber (blocks)
     * @return isValid Cache validity (TTL based on SYNC_INTERVAL)
     */
    function batchGetUserFeeStatisticsWithMeta(
        address user,
        bytes32[] calldata feeTypes
    )
        external
        view
        onlyValidRegistry
        onlyAuthorizedFor(user)
        returns (
            uint256[] memory feeStatistics,
            uint256 blockNumber,
            bool isValid
        )
    {
        if (feeTypes.length == 0) revert EmptyArray();
        if (feeTypes.length > MAX_BATCH_SIZE) {
            revert BatchTooLarge(feeTypes.length, MAX_BATCH_SIZE);
        }

        feeStatistics = new uint256[](feeTypes.length);
        for (uint256 i = 0; i < feeTypes.length; i++) {
            feeStatistics[i] = _userFeeStatistics[user][feeTypes[i]];
        }
        blockNumber = _userCacheUpdateBlocks[user];
        isValid = _isUserCacheValid(blockNumber);
    }

    /**
     * @notice Batch get global fee statistics for multiple (token, feeType) pairs, with cache metadata (admin-only).
     * @dev Reverts if:
     *      - _registryAddr == address(0) (ZeroAddress)
     *      - msg.sender lacks ACTION_ADMIN (ACM)
     *      - tokens.length != feeTypes.length (ArrayLengthMismatch)
     *      - tokens.length > MAX_BATCH_SIZE (BatchTooLarge)
     *
     * Security:
     * - Admin-gated via ACTION_ADMIN.
     *
     * @param tokens ERC20 token addresses
     * @param feeTypes Fee type identifiers (bytes32[])
     * @return feeStatistics Per-pair accumulated amounts (token decimals)
     * @return blockNumber Cache blockNumber (blocks)
     * @return isValid Cache validity (TTL based on SYNC_INTERVAL)
     */
    function batchGetGlobalFeeStatisticsWithMeta(
        address[] calldata tokens,
        bytes32[] calldata feeTypes
    )
        external
        view
        onlyValidRegistry
        onlyAdmin
        returns (
            uint256[] memory feeStatistics,
            uint256 blockNumber,
            bool isValid
        )
    {
        if (tokens.length == 0) revert EmptyArray();
        if (tokens.length != feeTypes.length)
            revert ArrayLengthMismatch(tokens.length, feeTypes.length);
        if (tokens.length > MAX_BATCH_SIZE) {
            revert BatchTooLarge(tokens.length, MAX_BATCH_SIZE);
        }

        feeStatistics = new uint256[](tokens.length);
        for (uint256 i = 0; i < tokens.length; i++) {
            feeStatistics[i] = _globalFeeStatistics[tokens[i]][feeTypes[i]];
        }
        blockNumber = _lastSyncBlock;
        isValid = _isSystemCacheValid(blockNumber);
    }

    /**
     * @notice Batch check token support status, with cache metadata (public view).
     * @dev Reverts if:
     *      - tokens.length == 0 (EmptyArray)
     *      - tokens.length > MAX_BATCH_SIZE (BatchTooLarge)
     *
     * @param tokens ERC20 token addresses
     * @return supported Per-token support flags
     * @return blockNumber Cache blockNumber (blocks)
     * @return isValid Cache validity (TTL based on SYNC_INTERVAL)
     */
    function batchCheckTokenSupportWithMeta(
        address[] calldata tokens
    )
        external
        view
        returns (bool[] memory supported, uint256 blockNumber, bool isValid)
    {
        if (tokens.length == 0) revert EmptyArray();
        if (tokens.length > MAX_BATCH_SIZE) {
            revert BatchTooLarge(tokens.length, MAX_BATCH_SIZE);
        }

        supported = new bool[](tokens.length);
        for (uint256 i = 0; i < tokens.length; i++) {
            supported[i] = _supportedTokens[tokens[i]];
        }
        blockNumber = _lastSyncBlock;
        isValid = _isSystemCacheValid(blockNumber);
    }

    /*━━━━━━━━━━━━━━━ ADVANCED ANALYTICS FUNCTIONS ━━━━━━━━━━━━━━━*/

    /**
     * @notice Get derived user fee analytics, with cache metadata (placeholder; access-controlled).
     * @dev Reverts if:
     *      - _registryAddr == address(0) (ZeroAddress)
     *      - msg.sender is not authorized for `user` (MissingRole via Scheme U)
     *      - feeTypes.length > MAX_BATCH_SIZE (BatchTooLarge)
     *
     * Security:
     * - Access-controlled via ACTION_VIEW_USER_DATA (self) or ACTION_ADMIN (non-self).
     *
     * @param user Target user address
     * @param feeTypes Fee type identifiers (bytes32[])
     * @return analytics Derived analytics (amounts in token decimals; counts unitless; blockNumbers as blocks)
     * @return blockNumber Cache blockNumber (blocks)
     * @return isValid Cache validity (TTL based on SYNC_INTERVAL)
     */
    function getUserFeeAnalyticsWithMeta(
        address user,
        bytes32[] calldata feeTypes
    )
        external
        view
        onlyValidRegistry
        onlyAuthorizedFor(user)
        returns (
            UserFeeAnalytics memory analytics,
            uint256 blockNumber,
            bool isValid
        )
    {
        if (feeTypes.length == 0) revert EmptyArray();
        if (feeTypes.length > MAX_BATCH_SIZE) {
            revert BatchTooLarge(feeTypes.length, MAX_BATCH_SIZE);
        }

        UserStats memory userStats = _userStats[user];

        analytics.totalPaidFees = userStats.totalFeePaid;
        analytics.transactionCount = userStats.transactionCount;
        analytics.lastTransactionTime = userStats.lastActivityBlock;
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
            analytics.averageFeeRate =
                (totalFees * 10000) / analytics.transactionCount;
        }
        blockNumber = _userCacheUpdateBlocks[user];
        isValid = _isUserCacheValid(blockNumber);
    }

    /*━━━━━━━━━━━━━━━ INTERNAL HELPER FUNCTIONS ━━━━━━━━━━━━━━━*/

    /**
     * @notice Compute a derived discount level for a user (placeholder).
     * @dev Reverts if: (never)
     *
     * Security:
     * - View-only; uses cached aggregates as input.
     *
     * @param user Target user address
     * @return level Discount level (unitless; higher means larger discount)
     */
    function _calculateDiscountLevel(
        address user
    ) internal view returns (uint256) {
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
     * @dev Reverts if: (never)
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
     * @param newImplementation New implementation address.
     */
    function _authorizeUpgrade(
        address newImplementation
    ) internal view override onlyValidRegistry {
        if (
            !ViewAccessLib.hasRole(
                _registryAddr,
                ActionKeys.ACTION_ADMIN,
                msg.sender
            )
        ) {
            revert MissingRole();
        }
        if (newImplementation == address(0)) revert ZeroAddress();
        if (newImplementation.code.length == 0)
            revert NotAContract(newImplementation);
    }

    function _getFeeRouter() internal view returns (address) {
        return Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_FR);
    }

    function _getViewGateway() internal view returns (address viewGateway) {
        try
            Registry(_registryAddr).getModule(ModuleKeys.KEY_VAULT_CORE)
        returns (address vaultCore) {
            if (vaultCore == address(0) || vaultCore.code.length == 0)
                return address(0);
            try IVaultCoreMinimal(vaultCore).viewContractAddrVar() returns (
                address gateway
            ) {
                viewGateway = gateway;
            } catch {
                viewGateway = address(0);
            }
        } catch {
            viewGateway = address(0);
        }
    }

    function _isUserCacheValid(
        uint256 blockNumber
    ) internal view returns (bool) {
        // Time-Dependency-Refactor: `blockNumber` is an updateBlock marker (legacy name).
        if (blockNumber == 0 || blockNumber > block.number) return false;
        return (block.number - blockNumber) <= SYNC_INTERVAL_BLOCKS;
    }

    function _isSystemCacheValid(
        uint256 blockNumber
    ) internal view returns (bool) {
        // Time-Dependency-Refactor: `blockNumber` is a lastSyncBlock marker (legacy name).
        if (blockNumber == 0 || blockNumber > block.number) return false;
        return (block.number - blockNumber) <= SYNC_INTERVAL_BLOCKS;
    }

    /**
     * @notice Return the API semantic version of this view module.
     * @dev Reverts if: (never)
     *
     * Security:
     * - Pure function.
     *
     * @return version Semantic API version.
     */
    function apiVersion() public pure override returns (uint256 version) {
        return 1;
    }

    /**
     * @notice Return the schema version of this view module.
     * @dev Reverts if: (never)
     *
     * Security:
     * - Pure function.
     *
     * @return version Schema version.
     */
    function schemaVersion() public pure override returns (uint256 version) {
        return 1;
    }

    /*━━━━━━━━━━━━━━━ STORAGE GAP FOR UPGRADE-SAFE LAYOUT CHANGES ━━━━━━━━━━━━━━━*/

    /// @notice Reserved storage gap for upgrade-safe layout changes.
    uint256[50] private __gap;
}
