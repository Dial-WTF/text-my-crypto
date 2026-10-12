// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Circle's USDC: the EIP-3009 receive this contract pulls with.
interface IUSDC {
    function approve(address spender, uint256 value) external returns (bool);
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

/// Circle's CoreDepositWallet on HyperEVM: moves USDC into a HyperCore balance.
interface ICoreDepositWallet {
    function depositFor(address recipient, uint256 amount, uint32 destinationDex) external;
}

/// @title Dial Core Deposit
/// @notice Moves a Dial user's USDC from their HyperEVM wallet into a HyperCore spot balance in one
/// transaction. The user signs an EIP-3009 ReceiveWithAuthorization to this contract; the operator
/// submits it (users never hold gas); this contract takes the USDC and deposits it for `recipient`
/// through Circle's CoreDepositWallet. Either the deposit happens or nothing moves.
/// Only the operator can call it: the signature names this contract, not the recipient, so anyone
/// else holding it could choose a different recipient.
contract DialCoreDeposit {
    /// CoreDepositWallet's destinationDex for the spot balance (0 is perps).
    uint32 public constant SPOT_DEX = type(uint32).max;

    IUSDC public immutable usdc;
    ICoreDepositWallet public immutable coreDepositWallet;
    address public immutable operator;

    /// `nonce` is the EIP-3009 nonce: keccak256 of the Dial payment id, so every deposit names its payment.
    event CoreDeposit(address indexed from, address indexed recipient, uint256 amount, bytes32 indexed nonce);

    constructor(IUSDC usdc_, ICoreDepositWallet coreDepositWallet_) {
        usdc = usdc_;
        coreDepositWallet = coreDepositWallet_;
        operator = msg.sender;
        // The contract only ever holds USDC inside `deposit`, so a standing allowance risks nothing.
        require(usdc_.approve(address(coreDepositWallet_), type(uint256).max), "approve failed");
    }

    function deposit(
        address from,
        address recipient,
        uint256 amount,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        require(msg.sender == operator, "only operator");
        usdc.receiveWithAuthorization(from, address(this), amount, 0, validBefore, nonce, v, r, s);
        coreDepositWallet.depositFor(recipient, amount, SPOT_DEX);
        emit CoreDeposit(from, recipient, amount, nonce);
    }
}
