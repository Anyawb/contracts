// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title VaultRouterEventLib
/// @notice VaultRouter 事件发出库，提取事件逻辑以减小合约大小
/// @dev 注意：Solidity 库函数无法直接 emit 事件，此库主要用于文档和代码组织
/// @dev 实际事件发出应在合约中使用内联 emit 语句
/// @dev 此库文件可以删除，因为事件发出逻辑太简单，不值得提取
library VaultRouterEventLib {
    // 注意：库函数无法直接 emit 事件
    // 事件发出应在合约中直接使用：
    // emit VaultAction(action, user, amount1, amount2, asset, block.timestamp);
}

