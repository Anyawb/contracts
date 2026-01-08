// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import { Registry } from "../../registry/Registry.sol";
import { ModuleKeys } from "../../constants/ModuleKeys.sol";
import { ActionKeys } from "../../constants/ActionKeys.sol";
import { IAccessControlManager } from "../../interfaces/IAccessControlManager.sol";
import { ILenderPoolVault } from "../../interfaces/ILenderPoolVault.sol";
import { ZeroAddress, AmountIsZero } from "../../errors/StandardErrors.sol";

/// @title LenderPoolVault
/// @notice 线上流动性资金池（推荐）：撮合/借款放款资金集中托管于本合约
/// @dev 当前为“托管 + 受限转出”的最小可用实现：
/// - 入金：任何资金方可 deposit（transferFrom → 本合约）
/// - 出金：仅允许 Registry 绑定的 `VaultBusinessLogic` 调用 transferOut（用于撮合拨付）
/// - 订单语义：在订单引擎中 lender 字段应写入本合约地址（资金池）
contract LenderPoolVault is
    Initializable,
    UUPSUpgradeable,
    ReentrancyGuardUpgradeable,
    PausableUpgradeable,
    ILenderPoolVault
{
    using SafeERC20 for IERC20;

    /// @notice Registry address for module resolution and access control.
    /// @dev Stored privately; exposed via explicit getter `registryAddrVar()` (no public state variable).
    address private _registryAddr;

    /// @notice Get Registry address.
    function registryAddrVar() external view returns (address) {
        return _registryAddr;
    }

    error LenderPoolVault__OnlyVaultBusinessLogic();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address initialRegistryAddr) external initializer {
        if (initialRegistryAddr == address(0)) revert ZeroAddress();
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        __Pausable_init();
        _registryAddr = initialRegistryAddr;
    }

    function pause() external {
        _requireRole(ActionKeys.ACTION_ADMIN, msg.sender);
        _pause();
    }

    function unpause() external {
        _requireRole(ActionKeys.ACTION_ADMIN, msg.sender);
        _unpause();
    }

    /// @inheritdoc ILenderPoolVault
    function deposit(address asset, uint256 amount) external override whenNotPaused nonReentrant {
        if (asset == address(0)) revert ZeroAddress();
        if (amount == 0) revert AmountIsZero();
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @inheritdoc ILenderPoolVault
    function transferOut(address asset, address to, uint256 amount) external override whenNotPaused nonReentrant {
        if (asset == address(0) || to == address(0)) revert ZeroAddress();
        if (amount == 0) revert AmountIsZero();
        _requireVaultBusinessLogic(msg.sender);
        IERC20(asset).safeTransfer(to, amount);
    }

    function _requireVaultBusinessLogic(address caller) internal view {
        address vbl = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_VAULT_BUSINESS_LOGIC);
        if (caller != vbl) revert LenderPoolVault__OnlyVaultBusinessLogic();
    }

    function _requireRole(bytes32 role, address caller) internal view {
        address acmAddr = Registry(_registryAddr).getModuleOrRevert(ModuleKeys.KEY_ACCESS_CONTROL);
        IAccessControlManager(acmAddr).requireRole(role, caller);
    }

    function _authorizeUpgrade(address newImplementation) internal view override {
        if (newImplementation == address(0)) revert ZeroAddress();
        _requireRole(ActionKeys.ACTION_UPGRADE_MODULE, msg.sender);
    }
}

