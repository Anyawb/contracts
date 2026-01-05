// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./IVaultCore.sol";
import "./IVaultRouter.sol";
import "./IVaultAdmin.sol";

/// @title IVaultModules
/// @notice 统一模块接口，聚合所有 Vault 模块接口
/// @dev 作为模块间交互的统一接口定义
interface IVaultModules is IVaultCore, IVaultRouter, IVaultAdmin {
    // 继承所有子接口的函数
} 