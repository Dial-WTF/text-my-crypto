// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Dial Test USD
/// @notice A test dollar for testnets without a Circle test USDC (Robinhood Chain testnet).
/// ERC-20 with 6 decimals plus EIP-3009 transferWithAuthorization, the same signed, gasless
/// transfer Circle's USDC offers, so the Dial operator settles on it exactly as it does on USDC.
/// Testnet only: the deployer can mint.
contract DialTestUSD {
    string public constant name = "Dial Test USD";
    string public constant symbol = "dUSD";
    string public constant version = "1";
    uint8 public constant decimals = 6;

    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    /// Upper bound for `s` (EIP-2): rejects the second, malleable form of every signature.
    uint256 private constant HALF_ORDER = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    address public immutable minter;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => mapping(bytes32 => bool)) public authorizationState;

    uint256 private immutable deployedChainId;
    bytes32 private immutable deployedSeparator;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);

    constructor() {
        minter = msg.sender;
        deployedChainId = block.chainid;
        deployedSeparator = _separator();
    }

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return block.chainid == deployedChainId ? deployedSeparator : _separator();
    }

    function mint(address to, uint256 value) external {
        require(msg.sender == minter, "only minter");
        totalSupply += value;
        balanceOf[to] += value;
        emit Transfer(address(0), to, value);
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= value, "allowance");
            allowance[from][msg.sender] = allowed - value;
        }
        _transfer(from, to, value);
        return true;
    }

    /// @notice Moves `value` from `from` to `to` with `from`'s signature; anyone can submit it and pay the gas.
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        require(block.timestamp > validAfter, "not yet valid");
        require(block.timestamp < validBefore, "expired");
        require(!authorizationState[from][nonce], "authorization used");
        require(uint256(s) <= HALF_ORDER, "bad signature");
        bytes32 structHash =
            keccak256(abi.encode(TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));
        address signer = ecrecover(digest, v, r, s);
        require(signer != address(0) && signer == from, "bad signature");
        authorizationState[from][nonce] = true;
        emit AuthorizationUsed(from, nonce);
        _transfer(from, to, value);
    }

    function _transfer(address from, address to, uint256 value) private {
        require(to != address(0), "zero address");
        uint256 balance = balanceOf[from];
        require(balance >= value, "balance");
        unchecked {
            balanceOf[from] = balance - value;
        }
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }

    function _separator() private view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256(bytes(name)), keccak256(bytes(version)), block.chainid, address(this)));
    }
}
