// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { ILoanNFT } from "../interfaces/ILoanNFT.sol";

/**
 * @notice Minimal in-memory mock for LoanNFT enumeration + metadata.
 * @dev Not a full ERC721 implementation; only the surface required by LoanNFTView tests.
 */
contract MockLoanNFTEnumerable {
    mapping(address => uint256[]) private _owned;
    mapping(uint256 => ILoanNFT.LoanMetadata) private _meta;
    mapping(uint256 => bool) private _exists;

    function seedToken(address owner, uint256 tokenId, uint256 loanId, ILoanNFT.LoanStatus status) external {
        _owned[owner].push(tokenId);
        _exists[tokenId] = true;
        _meta[tokenId] = ILoanNFT.LoanMetadata({
            principal: 0,
            rate: 0,
            term: 0,
            oraclePrice: 0,
            loanId: loanId,
            collateralHash: bytes32(0),
            status: status
        });
    }

    function balanceOf(address owner) external view returns (uint256) {
        return _owned[owner].length;
    }

    function tokenOfOwnerByIndex(address owner, uint256 index) external view returns (uint256) {
        return _owned[owner][index];
    }

    function getUserTokens(address user) external view returns (uint256[] memory tokenIds) {
        return _owned[user];
    }

    function getLoanMetadata(uint256 tokenId) external view returns (ILoanNFT.LoanMetadata memory metadata) {
        if (!_exists[tokenId]) revert ILoanNFT.LoanNFT__InvalidTokenId();
        return _meta[tokenId];
    }
}
