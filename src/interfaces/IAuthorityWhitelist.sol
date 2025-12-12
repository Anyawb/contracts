// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IAuthorityWhitelist 权限白名单接口
/// @notice 用于检查指定权限（如角色或模块名称）是否在白名单中
/// @dev 调用者应在执行受限操作前先行调用此接口进行校验
interface IAuthorityWhitelist {
    /**
     * @notice 判断给定名称是否通过白名单校验
     * @param name 权限/角色/模块名称
     * @return pass 是否在白名单中（true=通过）
     */
    function check(string calldata name) external view returns (bool);
} 