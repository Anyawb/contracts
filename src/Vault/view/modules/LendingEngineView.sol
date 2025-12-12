// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import { Registry } from "../../../registry/Registry.sol";
import { IAccessControlManager } from "../../../interfaces/IAccessControlManager.sol";
import { ActionKeys } from "../../../constants/ActionKeys.sol";
import { ModuleKeys } from "../../../constants/ModuleKeys.sol";

// 与核心引擎的最小接口适配，提供仅 View 所需方法（顶层定义，避免在合约内定义接口）
interface ILendingEngineViewAdapter {
	struct LoanOrder {
		uint256 principal;
		uint256 rate;
		uint256 term;
		address borrower;
		address lender;
		address asset;
		uint256 startTimestamp;
		uint256 maturity;
		uint256 repaidAmount;
	}

	function _getLoanOrderForView(uint256 orderId) external view returns (LoanOrder memory order);
	function _getUserLoanCountForView(address user) external view returns (uint256 count);
	function _getFailedFeeAmountForView(uint256 orderId) external view returns (uint256 feeAmount);
	function _getNftRetryCountForView(uint256 orderId) external view returns (uint256 retryCount);
	function _canAccessLoanOrderForView(uint256 orderId, address user) external view returns (bool hasAccess);
	function _isMatchEngineForView(address account) external view returns (bool isMatch);
	function _getRegistryForView() external view returns (address registry);
}

/// @title LendingEngineView
/// @notice 仅负责借贷引擎相关的数据查询（0 gas），不承载任何业务写操作
/// @dev 与核心 LendingEngine 解耦，通过 Registry 获取模块地址
contract LendingEngineView is Initializable, UUPSUpgradeable {
	// =========================  Errors  =========================

	error LendingEngineView__ZeroAddress();
	error LendingEngineView__Unauthorized();

	// =========================  Storage  =========================

	address private _registryAddr;

	// =========================  Modifiers  =========================

	modifier onlyValidRegistry() {
		if (_registryAddr == address(0)) revert LendingEngineView__ZeroAddress();
		_;
	}

	// =========================  Initialiser  =========================

	function initialize(address initialRegistryAddr) external initializer {
		if (initialRegistryAddr == address(0)) revert LendingEngineView__ZeroAddress();

		__UUPSUpgradeable_init();
		_registryAddr = initialRegistryAddr;
	}

	// =========================  Read APIs  =========================

	/// @notice 查询贷款订单详情
	function getLoanOrder(uint256 orderId) external view onlyValidRegistry returns (ILendingEngineViewAdapter.LoanOrder memory order) {
		return _engine()._getLoanOrderForView(orderId);
	}

	/// @notice 查询用户贷款数量
	function getUserLoanCount(address user) external view onlyValidRegistry returns (uint256 count) {
		return _engine()._getUserLoanCountForView(user);
	}

	/// @notice 查询某订单累计失败手续费（用于运维排查）
	function getFailedFeeAmount(uint256 orderId) external view onlyValidRegistry returns (uint256 feeAmount) {
		return _engine()._getFailedFeeAmountForView(orderId);
	}

	/// @notice 查询某订单的 NFT 铸造重试次数
	function getNftRetryCount(uint256 orderId) external view onlyValidRegistry returns (uint256 retryCount) {
		return _engine()._getNftRetryCountForView(orderId);
	}

	/// @notice 判断用户是否可访问某订单（借款人/贷方/管理员）
	function canAccessLoanOrder(uint256 orderId, address user) external view onlyValidRegistry returns (bool hasAccess) {
		return _engine()._canAccessLoanOrderForView(orderId, user);
	}

	/// @notice 判断账户是否具备撮合权限（撮合引擎）
	function isMatchEngine(address account) external view onlyValidRegistry returns (bool isMatch) {
		return _engine()._isMatchEngineForView(account);
	}

	/// @notice 便利函数：返回当前 Registry 地址（来自引擎视图）
	function getRegistryFromEngine() external view onlyValidRegistry returns (address registry) {
		return _engine()._getRegistryForView();
	}

	// =========================  Internal helpers  =========================

	function _engine() internal view returns (ILendingEngineViewAdapter) {
		address engineAddr = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_LE);
		return ILendingEngineViewAdapter(engineAddr);
	}

	function _authorizeUpgrade(address newImplementation) internal view override onlyValidRegistry {
		// 仅管理员可升级
		address acm = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
		IAccessControlManager(acm).requireRole(ActionKeys.ACTION_ADMIN, msg.sender);
		if (newImplementation == address(0)) revert LendingEngineView__ZeroAddress();
	}

	/// @notice 兼容旧版 getter
	function registryAddr() external view returns(address){ return _registryAddr; }
}
