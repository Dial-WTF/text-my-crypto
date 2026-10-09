//! dial_escrow for Arbitrum, as a Stylus contract. The same rules as the Solana program
//! (solana/programs/dial_escrow):
//!
//! - `fund`: the sender's ERC-20 moves into this contract under the payment's id, with an expiry.
//!   One fund per id, ever.
//! - `claim`: before expiry, the attestor fixed at deploy pays it to a recipient. The operator calls it
//!   once the recipient proves they hold the phone (the code texted to it).
//! - `refund`: from expiry on, the sender takes it back. Dial doesn't have to be up, and it can't stop it.
//!
//! There is no owner, no upgrade path and no admin withdraw. The attestor can only move an open escrow
//! before its expiry, and only by paying it out; after expiry the money can only go back to the sender.
//!
//! Dial's wallets never hold ETH, so the treasury relays for them: `fund_with_authorization` takes the
//! sender's EIP-3009 `receiveWithAuthorization` signature (one transaction, no approve), and
//! `refund_with_signature` takes the sender's EIP-712 signature over the id. A sender with gas can call
//! `fund` (after `approve`) and `refund` directly.

#![cfg_attr(not(any(test, feature = "export-abi")), no_main)]
#![cfg_attr(feature = "contract-client-gen", allow(unused_imports))]
extern crate alloc;

use alloc::vec::Vec;
use alloy_primitives::{Address, B256, U8, U64, U256, address, uint};
use alloy_sol_types::{SolCall, SolValue, sol};
use stylus_sdk::{crypto::keccak, prelude::*};

sol! {
    /// `token` is the ERC-20 held; `expiry` is unix seconds.
    event Funded(bytes32 indexed id, address indexed sender, address indexed token, uint256 amount, uint64 expiry);
    event Claimed(bytes32 indexed id, address indexed to, uint256 amount);
    event Refunded(bytes32 indexed id, address indexed sender, uint256 amount);

    error ZeroAmount();
    error ZeroAddress();
    error ExpiryInPast();
    error AlreadyFunded(bytes32 id);
    error NotOpen(bytes32 id);
    error NotAttestor();
    error NotSender();
    error Expired();
    error NotExpired();
    error BadSignature();
    error NoCode(address token);
    error TokenCallFailed(address token);
    error ArbSysFailed();
    error Reentrancy();
}

sol! {
    interface IERC20 {
        function transfer(address to, uint256 value) external returns (bool);
        function transferFrom(address from, address to, uint256 value) external returns (bool);
    }
    interface IERC3009 {
        function receiveWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external;
    }
    interface IArbSys {
        function arbBlockNumber() external view returns (uint256);
    }
}

#[derive(SolidityError)]
pub enum EscrowError {
    ZeroAmount(ZeroAmount),
    ZeroAddress(ZeroAddress),
    ExpiryInPast(ExpiryInPast),
    AlreadyFunded(AlreadyFunded),
    NotOpen(NotOpen),
    NotAttestor(NotAttestor),
    NotSender(NotSender),
    Expired(Expired),
    NotExpired(NotExpired),
    BadSignature(BadSignature),
    NoCode(NoCode),
    TokenCallFailed(TokenCallFailed),
    ArbSysFailed(ArbSysFailed),
    Reentrancy(Reentrancy),
}

/// Arbitrum's system precompile. `block.number` on Arbitrum is the L1 block; this gives the L2 block,
/// which is what log queries need.
const ARBSYS: Address = address!("0000000000000000000000000000000000000064");
const ECRECOVER: Address = address!("0000000000000000000000000000000000000001");
/// secp256k1 order / 2. Signatures with a higher `s` are the malleable twin and are refused.
const HALF_ORDER: U256 =
    uint!(0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0_U256);

pub const NONE: u8 = 0;
pub const OPEN: u8 = 1;
pub const CLAIMED: u8 = 2;
pub const REFUNDED: u8 = 3;

sol_storage! {
    #[entrypoint]
    pub struct DialEscrow {
        /// The only address that can claim. Set once, at deploy.
        address attestor;
        bool locked;
        mapping(bytes32 => Escrow) escrows;
    }

    /// Kept after it closes, so an id is never funded twice and anyone can see how it ended.
    pub struct Escrow {
        address sender;
        uint64 expiry;
        uint8 status;
        address token;
        /// Arbitrum (L2) block numbers, so a client can find the transactions from the chain alone.
        uint64 funded_block;
        uint64 closed_block;
        uint256 amount;
    }
}

#[public]
impl DialEscrow {
    #[constructor]
    pub fn constructor(&mut self, attestor: Address) -> Result<(), EscrowError> {
        if attestor.is_zero() {
            return Err(EscrowError::ZeroAddress(ZeroAddress {}));
        }
        self.attestor.set(attestor);
        Ok(())
    }

    pub fn attestor(&self) -> Address {
        self.attestor.get()
    }

    /// (sender, token, amount, expiry, status, funded_block, closed_block). Status: 0 none, 1 open,
    /// 2 claimed, 3 refunded.
    pub fn escrow(&self, id: B256) -> (Address, Address, U256, u64, u8, u64, u64) {
        let e = self.escrows.getter(id);
        (
            e.sender.get(),
            e.token.get(),
            e.amount.get(),
            e.expiry.get().to(),
            e.status.get().to(),
            e.funded_block.get().to(),
            e.closed_block.get().to(),
        )
    }

    /// The EIP-3009 nonce `fund_with_authorization` expects: keccak256(abi.encode(id, expiry)). It ties
    /// the sender's signature to this escrow's id and expiry, so nobody can reuse it for another.
    pub fn funding_nonce(&self, id: B256, expiry: u64) -> B256 {
        keccak((id, expiry).abi_encode())
    }

    /// The EIP-712 digest a sender signs to have someone else send their refund: Refund(bytes32 id) under
    /// the domain ("DialEscrow", "1", chain id, this contract).
    pub fn refund_digest(&self, id: B256) -> B256 {
        let domain = keccak(
            (
                keccak(b"EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak(b"DialEscrow"),
                keccak(b"1"),
                U256::from(self.vm().chain_id()),
                self.vm().contract_address(),
            )
                .abi_encode(),
        );
        let message = keccak((keccak(b"Refund(bytes32 id)"), id).abi_encode());
        keccak([&b"\x19\x01"[..], domain.as_slice(), message.as_slice()].concat())
    }

    /// Pulls `amount` of `token` from the caller (who must have approved this contract) into escrow `id`.
    pub fn fund(
        &mut self,
        id: B256,
        token: Address,
        amount: U256,
        expiry: u64,
    ) -> Result<(), EscrowError> {
        self.enter()?;
        let sender = self.vm().msg_sender();
        let result = self.open(id, sender, token, amount, expiry).and_then(|()| {
            let to = self.vm().contract_address();
            self.call_token(
                token,
                &IERC20::transferFromCall {
                    from: sender,
                    to,
                    value: amount,
                }
                .abi_encode(),
            )
        });
        self.exit();
        result
    }

    /// Funds escrow `id` from `from` with their EIP-3009 authorization, in one transaction anyone can
    /// send. The authorization must name this contract as `to`, `validAfter` 0, and
    /// `funding_nonce(id, expiry)` as its nonce.
    #[allow(clippy::too_many_arguments)]
    pub fn fund_with_authorization(
        &mut self,
        id: B256,
        token: Address,
        from: Address,
        amount: U256,
        expiry: u64,
        valid_before: U256,
        v: u8,
        r: B256,
        s: B256,
    ) -> Result<(), EscrowError> {
        self.enter()?;
        let result = self.open(id, from, token, amount, expiry).and_then(|()| {
            let call = IERC3009::receiveWithAuthorizationCall {
                from,
                to: self.vm().contract_address(),
                value: amount,
                validAfter: U256::ZERO,
                validBefore: valid_before,
                nonce: self.funding_nonce(id, expiry),
                v,
                r,
                s,
            };
            self.call_token(token, &call.abi_encode())
        });
        self.exit();
        result
    }

    /// Pays escrow `id` to `to`. Only the attestor, only before expiry.
    pub fn claim(&mut self, id: B256, to: Address) -> Result<(), EscrowError> {
        self.enter()?;
        let result = self.claim_inner(id, to);
        self.exit();
        result
    }

    /// Sends escrow `id` back to its sender. Only the sender, only from expiry on.
    pub fn refund(&mut self, id: B256) -> Result<(), EscrowError> {
        self.enter()?;
        let caller = self.vm().msg_sender();
        let result = self.refund_inner(id, caller);
        self.exit();
        result
    }

    /// `refund` for a sender without gas: anyone can send it with the sender's signature over
    /// `refund_digest(id)`. The money still only goes to the sender.
    pub fn refund_with_signature(
        &mut self,
        id: B256,
        v: u8,
        r: B256,
        s: B256,
    ) -> Result<(), EscrowError> {
        self.enter()?;
        let result = self
            .recover(self.refund_digest(id), v, r, s)
            .and_then(|signer| self.refund_inner(id, signer));
        self.exit();
        result
    }
}

impl DialEscrow {
    /// The reentrancy lock. Every state change happens before the token call anyway; this makes a token
    /// that calls back in fail outright.
    fn enter(&mut self) -> Result<(), EscrowError> {
        if self.locked.get() {
            return Err(EscrowError::Reentrancy(Reentrancy {}));
        }
        self.locked.set(true);
        Ok(())
    }

    fn exit(&mut self) {
        self.locked.set(false);
    }

    fn status(&self, id: B256) -> u8 {
        self.escrows.getter(id).status.get().to()
    }

    fn open(
        &mut self,
        id: B256,
        sender: Address,
        token: Address,
        amount: U256,
        expiry: u64,
    ) -> Result<(), EscrowError> {
        if amount.is_zero() {
            return Err(EscrowError::ZeroAmount(ZeroAmount {}));
        }
        if sender.is_zero() || token.is_zero() {
            return Err(EscrowError::ZeroAddress(ZeroAddress {}));
        }
        if expiry <= self.vm().block_timestamp() {
            return Err(EscrowError::ExpiryInPast(ExpiryInPast {}));
        }
        if self.status(id) != NONE {
            return Err(EscrowError::AlreadyFunded(AlreadyFunded { id }));
        }
        let block = self.arb_block()?;
        {
            let mut e = self.escrows.setter(id);
            e.sender.set(sender);
            e.token.set(token);
            e.amount.set(amount);
            e.expiry.set(U64::from(expiry));
            e.status.set(U8::from(OPEN));
            e.funded_block.set(U64::from(block));
        }
        self.vm().log(Funded {
            id,
            sender,
            token,
            amount,
            expiry,
        });
        Ok(())
    }

    /// Marks an open escrow closed before any token moves. Returns (sender, token, amount, expiry).
    fn close(
        &mut self,
        id: B256,
        outcome: u8,
    ) -> Result<(Address, Address, U256, u64), EscrowError> {
        if self.status(id) != OPEN {
            return Err(EscrowError::NotOpen(NotOpen { id }));
        }
        let block = self.arb_block()?;
        let mut e = self.escrows.setter(id);
        e.status.set(U8::from(outcome));
        e.closed_block.set(U64::from(block));
        Ok((
            e.sender.get(),
            e.token.get(),
            e.amount.get(),
            e.expiry.get().to(),
        ))
    }

    fn claim_inner(&mut self, id: B256, to: Address) -> Result<(), EscrowError> {
        if self.vm().msg_sender() != self.attestor.get() {
            return Err(EscrowError::NotAttestor(NotAttestor {}));
        }
        if to.is_zero() {
            return Err(EscrowError::ZeroAddress(ZeroAddress {}));
        }
        if self.status(id) != OPEN {
            return Err(EscrowError::NotOpen(NotOpen { id }));
        }
        let expiry: u64 = self.escrows.getter(id).expiry.get().to();
        if self.vm().block_timestamp() >= expiry {
            return Err(EscrowError::Expired(Expired {}));
        }
        let (_, token, amount, _) = self.close(id, CLAIMED)?;
        self.call_token(
            token,
            &IERC20::transferCall { to, value: amount }.abi_encode(),
        )?;
        self.vm().log(Claimed { id, to, amount });
        Ok(())
    }

    /// `caller` is whoever asked for the refund: the transaction's sender, or the signature's signer.
    fn refund_inner(&mut self, id: B256, caller: Address) -> Result<(), EscrowError> {
        let (sender, expiry) = {
            let e = self.escrows.getter(id);
            (e.sender.get(), e.expiry.get().to::<u64>())
        };
        if self.status(id) != OPEN {
            return Err(EscrowError::NotOpen(NotOpen { id }));
        }
        if caller != sender {
            return Err(EscrowError::NotSender(NotSender {}));
        }
        if self.vm().block_timestamp() < expiry {
            return Err(EscrowError::NotExpired(NotExpired {}));
        }
        let (_, token, amount, _) = self.close(id, REFUNDED)?;
        self.call_token(
            token,
            &IERC20::transferCall {
                to: sender,
                value: amount,
            }
            .abi_encode(),
        )?;
        self.vm().log(Refunded { id, sender, amount });
        Ok(())
    }

    /// Calls the token and checks the result: the call must succeed, and return either nothing (tokens
    /// that predate the standard's bool) or `true`. A token address without code is refused, since a
    /// call to it would "succeed" without moving anything.
    fn call_token(&mut self, token: Address, data: &[u8]) -> Result<(), EscrowError> {
        if self.vm().code_size(token) == 0 {
            return Err(EscrowError::NoCode(NoCode { token }));
        }
        let context = Call::new_mutating(self);
        let ret = call(self.vm(), context, token, data)
            .map_err(|_| EscrowError::TokenCallFailed(TokenCallFailed { token }))?;
        let returned_true = ret.len() >= 32 && ret[..31].iter().all(|b| *b == 0) && ret[31] == 1;
        if ret.is_empty() || returned_true {
            Ok(())
        } else {
            Err(EscrowError::TokenCallFailed(TokenCallFailed { token }))
        }
    }

    fn arb_block(&self) -> Result<u64, EscrowError> {
        let out = static_call(
            self.vm(),
            Call::new(),
            ARBSYS,
            &IArbSys::arbBlockNumberCall {}.abi_encode(),
        )
        .map_err(|_| EscrowError::ArbSysFailed(ArbSysFailed {}))?;
        let block =
            U256::abi_decode(&out).map_err(|_| EscrowError::ArbSysFailed(ArbSysFailed {}))?;
        Ok(block.saturating_to())
    }

    /// The signer of `digest`, through the ecrecover precompile. Refuses malformed and malleable signatures.
    fn recover(&self, digest: B256, v: u8, r: B256, s: B256) -> Result<Address, EscrowError> {
        let bad = || EscrowError::BadSignature(BadSignature {});
        let s_num = U256::from_be_bytes(s.0);
        if (v != 27 && v != 28) || r.is_zero() || s_num.is_zero() || s_num > HALF_ORDER {
            return Err(bad());
        }
        let out = static_call(
            self.vm(),
            Call::new(),
            ECRECOVER,
            &(digest, U256::from(v), r, s).abi_encode(),
        )
        .map_err(|_| bad())?;
        if out.len() != 32 {
            return Err(bad());
        }
        let signer = Address::from_slice(&out[12..]);
        if signer.is_zero() {
            Err(bad())
        } else {
            Ok(signer)
        }
    }
}

#[cfg(test)]
mod tests;
