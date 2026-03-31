// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract MockPositionViewBatch {
    struct Position {
        uint256 collateral;
        uint256 debt;
        uint256 updateBlock;
        uint64 version;
        bool isValid;
    }

    mapping(address => mapping(address => Position)) private _positions;

    function setPosition(address user, address asset, uint256 collateral, uint256 debt) external {
        Position storage p = _positions[user][asset];
        p.collateral = collateral;
        p.debt = debt;
        p.isValid = true;
        p.updateBlock = block.number;
        unchecked {
            p.version += 1;
        }
    }

    function setPositionWithMeta(
        address user,
        address asset,
        uint256 collateral,
        uint256 debt,
        bool isValid,
        uint256 updateBlock,
        uint64 version
    ) external {
        _positions[user][asset] = Position({
            collateral: collateral,
            debt: debt,
            updateBlock: updateBlock,
            version: version,
            isValid: isValid
        });
    }

    function getPositionUpdatedAt(address user, address asset) external view returns (uint256) {
        return _positions[user][asset].updateBlock;
    }

    function getPositionVersion(address user, address asset) external view returns (uint64) {
        return _positions[user][asset].version;
    }

    function getUserPositionWithMeta(address user, address asset)
        external
        view
        returns (uint256 collateral, uint256 debt, bool isValid, uint256 blockNumber, uint64 version)
    {
        Position memory p = _positions[user][asset];
        return (p.collateral, p.debt, p.isValid, p.updateBlock, p.version);
    }

    function batchGetUserPositionsWithMeta(
        address[] calldata users,
        address[] calldata assets
    )
        external
        view
        returns (
            uint256[] memory collaterals,
            uint256[] memory debts,
            bool[] memory validFlags,
            uint256[] memory blockNumbers,
            uint64[] memory versions
        )
    {
        require(users.length == assets.length, "MPVB: len mismatch");
        uint256 len = users.length;
        collaterals = new uint256[](len);
        debts = new uint256[](len);
        validFlags = new bool[](len);
        blockNumbers = new uint256[](len);
        versions = new uint64[](len);
        for (uint256 i; i < len; ++i) {
            Position memory p = _positions[users[i]][assets[i]];
            collaterals[i] = p.collateral;
            debts[i] = p.debt;
            validFlags[i] = p.isValid;
            blockNumbers[i] = p.updateBlock;
            versions[i] = p.version;
        }
    }
}

contract MockHealthViewBatch {
    struct HF {
        uint256 value;
        bool valid;
        uint256 updateBlock;
    }

    mapping(address => HF) private _hfs;

    function setHealth(address user, uint256 healthFactor, bool valid) external {
        _hfs[user] = HF({ value: healthFactor, valid: valid, updateBlock: block.number });
    }

    function setHealthWithTimestamp(address user, uint256 healthFactor, bool valid, uint256 blockNumber) external {
        _hfs[user] = HF({ value: healthFactor, valid: valid, updateBlock: blockNumber });
    }

    function getUserHealthFactorWithMeta(address user)
        external
        view
        returns (uint256 healthFactor, bool isValid, uint256 blockNumber)
    {
        HF memory h = _hfs[user];
        return (h.value, h.valid, h.updateBlock);
    }

    function batchGetHealthFactorsWithMeta(address[] calldata users)
        external
        view
        returns (uint256[] memory healthFactors, bool[] memory valid, uint256[] memory blockNumbers)
    {
        uint256 len = users.length;
        healthFactors = new uint256[](len);
        valid = new bool[](len);
        blockNumbers = new uint256[](len);
        for (uint256 i; i < len; ++i) {
            HF memory h = _hfs[users[i]];
            healthFactors[i] = h.value;
            valid[i] = h.valid;
            blockNumbers[i] = h.updateBlock;
        }
    }
}

contract MockPreviewView {
    struct BorrowResult {
        uint256 hf;
        uint256 ltv;
        uint256 maxBorrowable;
        uint256 positionBlockNumber;
        uint64 positionVersion;
        bool positionIsValid;
    }

    struct DepositResult {
        uint256 hf;
        uint256 positionBlockNumber;
        uint64 positionVersion;
        bool ok;
        bool positionIsValid;
    }

    struct RepayResult {
        uint256 hf;
        uint256 ltv;
        uint256 positionBlockNumber;
        uint64 positionVersion;
        bool positionIsValid;
    }

    struct WithdrawResult {
        uint256 hf;
        uint256 positionBlockNumber;
        uint64 positionVersion;
        bool ok;
        bool positionIsValid;
    }

    mapping(bytes32 => BorrowResult) public borrowResult;
    mapping(bytes32 => DepositResult) public depositResult;
    mapping(bytes32 => RepayResult) public repayResult;
    mapping(bytes32 => WithdrawResult) public withdrawResult;

    function setPreviewBorrow(
        address user,
        address asset,
        uint256 hf,
        uint256 ltv,
        uint256 maxBorrowable
    ) external {
        borrowResult[_key(user, asset)] = BorrowResult({
            hf: hf,
            ltv: ltv,
            maxBorrowable: maxBorrowable,
            positionBlockNumber: block.number,
            positionVersion: 1,
            positionIsValid: true
        });
    }

    function setPreviewDeposit(address user, address asset, uint256 hf, bool ok) external {
        depositResult[_key(user, asset)] = DepositResult({
            hf: hf,
            positionBlockNumber: block.number,
            positionVersion: 1,
            ok: ok,
            positionIsValid: true
        });
    }

    function setPreviewRepay(address user, address asset, uint256 hf, uint256 ltv) external {
        repayResult[_key(user, asset)] = RepayResult({
            hf: hf,
            ltv: ltv,
            positionBlockNumber: block.number,
            positionVersion: 1,
            positionIsValid: true
        });
    }

    function setPreviewWithdraw(address user, address asset, uint256 hf, bool ok) external {
        withdrawResult[_key(user, asset)] = WithdrawResult({
            hf: hf,
            positionBlockNumber: block.number,
            positionVersion: 1,
            ok: ok,
            positionIsValid: true
        });
    }

    function previewBorrow(
        address user,
        address asset,
        uint256,
        uint256,
        uint256
    ) external view returns (
        uint256 newHF,
        uint256 newLTV,
        uint256 maxBorrowable,
        bool positionIsValid,
        uint256 positionBlockNumber,
        uint64 positionVersion
    ) {
        BorrowResult memory r = borrowResult[_key(user, asset)];
        return (r.hf, r.ltv, r.maxBorrowable, r.positionIsValid, r.positionBlockNumber, r.positionVersion);
    }

    function previewDeposit(
        address user,
        address asset,
        uint256
    ) external view returns (
        uint256 hfAfter,
        bool ok,
        bool positionIsValid,
        uint256 positionBlockNumber,
        uint64 positionVersion
    ) {
        DepositResult memory r = depositResult[_key(user, asset)];
        return (r.hf, r.ok, r.positionIsValid, r.positionBlockNumber, r.positionVersion);
    }

    function previewRepay(address user, address asset, uint256)
        external
        view
        returns (uint256 newHF, uint256 newLTV, bool positionIsValid, uint256 positionBlockNumber, uint64 positionVersion)
    {
        RepayResult memory r = repayResult[_key(user, asset)];
        return (r.hf, r.ltv, r.positionIsValid, r.positionBlockNumber, r.positionVersion);
    }

    function previewWithdraw(
        address user,
        address asset,
        uint256
    ) external view returns (
        uint256 newHF,
        bool ok,
        bool positionIsValid,
        uint256 positionBlockNumber,
        uint64 positionVersion
    ) {
        WithdrawResult memory r = withdrawResult[_key(user, asset)];
        return (r.hf, r.ok, r.positionIsValid, r.positionBlockNumber, r.positionVersion);
    }

    function _key(address user, address asset) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(user, asset));
    }
}

