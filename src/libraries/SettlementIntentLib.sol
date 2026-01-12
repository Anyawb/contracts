// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";

/// @title SettlementIntentLib
/// @notice 撮合意向（借/贷）EIP-712 结构校验与状态管理的轻量库
library SettlementIntentLib {
    /*━━━━━━━━━━━━━━━ STRUCTS ━━━━━━━━━━━━━━━*/
    struct BorrowIntent {
        address borrower;
        address collateralAsset;
        uint256 collateralAmount;
        address borrowAsset;
        uint256 amount;
        uint16 termDays;
        uint256 rateBps;
        uint256 expireAt;
        bytes32 salt;
    }

    struct LendIntent {
        /// @notice 出借意向签名者（EOA / ERC-1271）
        /// @dev 注意：这是“撮合授权者/资金提供者”，不等于 LoanOrder.lender（后者在 Option A 下固定为 LenderPoolVault）
        address lenderSigner;
        address asset;
        uint256 amount;
        uint16 minTermDays;
        uint16 maxTermDays;
        uint256 minRateBps;
        uint256 expireAt;
        bytes32 salt;
    }

    /*━━━━━━━━━━━━━━━ ERRORS ━━━━━━━━━━━━━━━*/
    error Settlement__IntentExpired();
    error Settlement__AlreadyMatched();
    error Settlement__InvalidSignature();

    /*━━━━━━━━━━━━━━━ API ━━━━━━━━━━━━━━━*/
    /// @notice 计算 BorrowIntent 的哈希（用于 EIP-712）
    function hashBorrowIntent(BorrowIntent memory bi) internal pure returns (bytes32) {
        return keccak256(abi.encode(
            keccak256(
                "BorrowIntent(address borrower,address collateralAsset,uint256 collateralAmount,address borrowAsset,uint256 amount,uint16 termDays,uint256 rateBps,uint256 expireAt,bytes32 salt)"
            ),
            bi.borrower,
            bi.collateralAsset,
            bi.collateralAmount,
            bi.borrowAsset,
            bi.amount,
            bi.termDays,
            bi.rateBps,
            bi.expireAt,
            bi.salt
        ));
    }

    /// @notice 计算 LendIntent 的哈希（用于 EIP-712）
    function hashLendIntent(LendIntent memory li) internal pure returns (bytes32) {
        return keccak256(abi.encode(
            keccak256(
                "LendIntent(address lenderSigner,address asset,uint256 amount,uint16 minTermDays,uint16 maxTermDays,uint256 minRateBps,uint256 expireAt,bytes32 salt)"
            ),
            li.lenderSigner,
            li.asset,
            li.amount,
            li.minTermDays,
            li.maxTermDays,
            li.minRateBps,
            li.expireAt,
            li.salt
        ));
    }

    /// @notice 组装 EIP-712 域分隔符
    function buildDomainSeparator(
        string memory name,
        string memory version,
        uint256 chainId,
        address verifyingContract
    ) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(name)),
                keccak256(bytes(version)),
                chainId,
                verifyingContract
            )
        );
    }

    /// @notice 计算 EIP-712 Typed Data 哈希
    function toTypedDataHash(bytes32 domainSeparator, bytes32 structHash) internal pure returns (bytes32) {
        return MessageHashUtils.toTypedDataHash(domainSeparator, structHash);
    }

    /// @notice 校验 EOA/合约钱包签名（ERC-1271）并返回是否有效
    function verifySignature(
        address signer,
        bytes32 digest,
        bytes memory signature
    ) internal view returns (bool) {
        if (signer == address(0)) return false;
        if (isContract(signer)) {
            return IERC1271(signer).isValidSignature(digest, signature) == 0x1626ba7e;
        }
        return ECDSA.recover(digest, signature) == signer;
    }

    function isContract(address account) internal view returns (bool) {
        return account.code.length > 0;
    }

    /// @notice 校验过期与已匹配状态
    function validateOpen(
        mapping(bytes32 => bool) storage matched,
        bytes32 intentHash,
        uint256 expireAt
    ) internal view {
        if (block.timestamp > expireAt) revert Settlement__IntentExpired();
        if (matched[intentHash]) revert Settlement__AlreadyMatched();
    }

    /// @notice 设置意向为已匹配
    function markMatched(
        mapping(bytes32 => bool) storage matched,
        bytes32 intentHash
    ) internal {
        matched[intentHash] = true;
    }
}


