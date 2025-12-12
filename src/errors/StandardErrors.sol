// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Project-wide custom errors collected here for consistency and easier decoding.

// ============ 基础错误 ============
error AmountIsZero();
error AmountMismatch();
error InsufficientBalance();
error InsufficientLiquidity();
error InsufficientCollateral();
error HealthFactorTooLow();
error InvalidHealthFactor();
error InvalidLTV();
error CapIsZero();
error InvalidAmounts();
error RepayAmountZero();
error PausedSystem();
error ZeroAddress();
error MissingRole();
error NotEnoughDebt();
error Overpay();
error DivisionByZero();
error InvalidCaller();
error VaultCapExceeded();
error StatsNotFound();
error InvalidStatsData();

// ============ Registry 模块精确错误 ============
error MismatchedArrayLengths(uint256 keysLength, uint256 addressesLength);
error ModuleAlreadyRegistered(bytes32 key);
error ModuleNotRegistered(bytes32 key);
error ModuleUpgradeNotReady(bytes32 key, uint256 executeAfter, uint256 currentTime);
error ModuleUpgradeNotFound(bytes32 key);
error ModuleUpgradeAlreadyExists(bytes32 key);
error ModuleUpgradeDuplicate(bytes32 key, address oldAddr, address newAddr);
error ModuleAlreadyExists(bytes32 key);
error DelayTooLong(uint256 delay, uint256 maxDelay);
error DelayTooShort(uint256 delay, uint256 minDelay);
error InvalidDelayValue(uint256 delay);
error UpgradeNotAuthorized(address caller, address requiredAdmin);
error EmergencyAdminNotAuthorized(address caller, address emergencyAdmin);
error InvalidPendingAdmin(address pendingAdmin);
error NotPendingAdmin(address caller, address pendingAdmin);
error InvalidUpgradeAdmin(address upgradeAdmin);
error InvalidEmergencyAdmin(address emergencyAdmin);

// ============ 签名相关错误 ============
error SignatureExpired(uint256 deadline, uint256 currentTime);
error InvalidSigner(address signer);
error InvalidNonce(address signer, uint256 expectedNonce, uint256 providedNonce);
error InvalidSignature(address recoveredSigner, address expectedSigner);
error SignatureZeroAddress();

// ============ 合约验证错误 ============
error NotAContract(address addr);

// ============ 索引和数组相关错误 ============
error IndexOutOfBounds(uint256 index, uint256 length);
error EmptyArray();
error ArrayLengthMismatch(uint256 length1, uint256 length2);

// ============ 存储和初始化相关错误 ============
error AlreadyInitialized();
error NotInitialized();
error StorageVersionMismatch(uint256 expected, uint256 actual);
error InvalidStorageVersion(uint256 version);
error MinDelayTooLarge(uint256 delay, uint256 maxDelay);
error MinDelayOverflow(uint256 delay);

// ============ 模块相关错误 ============
error ModuleCapExceeded(uint256 count, uint256 maxCount);

// ============ 权限相关错误 ============
error NotGovernance();
error NotKeeper();
error NotWhitelisted();
error AssetNotAllowed();

// ============ 模块特定错误 ============
// PriceOracle 相关
error PriceOracle__AssetAlreadySupported();
error PriceOracle__AssetNotSupported();
error PriceOracle__StalePrice();
error PriceOracle__InvalidPrice();
error PriceOracle__Unauthorized();

// FeeRouter 相关
error FeeRouter__ZeroAddress();
error FeeRouter__InvalidFeeRate();
error FeeRouter__InvalidRecipient();

// LendingEngine 相关
error LendingEngine__ZeroAddress();
error LendingEngine__InvalidLoan();
error LendingEngine__InsufficientLiquidity();

// Registry 相关
error Registry__ZeroAddress();
error Registry__ModuleNotFound();
error Registry__ModuleAlreadyExists();

// Reward 相关
error RewardManager__ZeroAddress();
error RewardManager__MissingMinterRole();
error RewardConsumption__ZeroAddress();
error RewardManagerCore__ZeroAddress();

// AccessControl 相关
error AccessControlManager__ZeroAddress();
error AccessControlManager__MissingRole(bytes32 role, address account);
error AccessControlManager__MissingEitherRole(bytes32 role1, bytes32 role2, address account);

// 新增：RWA 借出资产未被授权
error RWAAssetNotAllowed(address token);

// ============ 保证金相关错误 ============
error GuaranteeNotPaid();
error GuaranteeAlreadyReleased();
error InvalidGuaranteeAmount();
error NotEnoughGuarantee();
error GuaranteeNotActive();
error InvalidGuaranteeId();
error GuaranteeAlreadyProcessed();
error GuaranteeRecordNotFound();
error GuaranteeIdOverflow();
error InvalidGuaranteeTerm();
error GuaranteeInterestTooHigh();
error BorrowerCannotBeLender();

// ============ EarlyRepaymentGuaranteeManager 专用错误 ============
error EarlyRepaymentGuaranteeManager__OnlyVaultCore();
error EarlyRepaymentGuaranteeManager__InvalidImplementation();
error EarlyRepaymentGuaranteeManager__RateTooHigh();
error EarlyRepaymentGuaranteeManager__RateUnchanged();

/// @dev 统一外部模块 revert 捕获后抛出的错误，`module` 为易读字符串标识模块名，`data` 为底层 revert data。
error ExternalModuleRevertedRaw(string module, bytes data); 