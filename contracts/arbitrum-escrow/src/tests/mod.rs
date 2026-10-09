use super::*;
use alloy_primitives::{Address, B256, U256, address, b256, hex};
use alloy_sol_types::{SolCall, SolEvent, SolValue};
use k256::ecdsa::{RecoveryId, Signature, SigningKey, VerifyingKey};

mod chain;
use chain::MockChain;

const ESCROW: Address = address!("00000000000000000000000000000000000e5c00");
const TOKEN: Address = address!("75faf114eafb1bdbe2f0316df893fd58ce46aa4d");
const ATTESTOR: Address = address!("00000000000000000000000000000000000a7e57");
const SENDER: Address = address!("0000000000000000000000000000000000005e4d");
const RECIPIENT: Address = address!("000000000000000000000000000000000000beef");
const RELAYER: Address = address!("0000000000000000000000000000000000000e1a");
const STRANGER: Address = address!("0000000000000000000000000000000000000bad");
/// A token someone else deployed, which does whatever its author wants.
const FAKE_TOKEN: Address = address!("00000000000000000000000000000000000fa4e0");
const ID: B256 = b256!("94f7a868a972292409e93a5940cfab67927a26a03f4336345a35dc65082f59f8"); // keccak256("pi_test")
const AMOUNT: U256 = U256::from_limbs([5_000_000, 0, 0, 0]);
const NOW: u64 = 1_000;
const EXPIRY: u64 = 2_000;

fn name(r: Result<(), EscrowError>) -> &'static str {
    match r {
        Ok(()) => "ok",
        Err(e) => match e {
            EscrowError::ZeroAmount(_) => "ZeroAmount",
            EscrowError::ZeroAddress(_) => "ZeroAddress",
            EscrowError::WrongToken(_) => "WrongToken",
            EscrowError::ExpiryInPast(_) => "ExpiryInPast",
            EscrowError::AlreadyFunded(_) => "AlreadyFunded",
            EscrowError::NotOpen(_) => "NotOpen",
            EscrowError::NotAttestor(_) => "NotAttestor",
            EscrowError::NotSender(_) => "NotSender",
            EscrowError::Expired(_) => "Expired",
            EscrowError::NotExpired(_) => "NotExpired",
            EscrowError::BadSignature(_) => "BadSignature",
            EscrowError::NoCode(_) => "NoCode",
            EscrowError::TokenCallFailed(_) => "TokenCallFailed",
            EscrowError::ArbSysFailed(_) => "ArbSysFailed",
            EscrowError::Reentrancy(_) => "Reentrancy",
        },
    }
}

/// Sends a call as a transaction (a failure reverts it) and names the outcome.
fn tx(vm: &MockChain, f: impl FnOnce() -> Result<(), EscrowError>) -> &'static str {
    name(vm.transact(f))
}

fn arb_block(vm: &MockChain, block: u64) {
    vm.mock_static_call(
        ARBSYS,
        IArbSys::arbBlockNumberCall {}.abi_encode(),
        Ok(U256::from(block).abi_encode()),
    );
}

fn token_returns(vm: &MockChain, data: Vec<u8>, result: Result<Vec<u8>, Vec<u8>>) {
    vm.mock_call(TOKEN, data, U256::ZERO, result);
}

fn pull(from: Address, amount: U256) -> Vec<u8> {
    IERC20::transferFromCall {
        from,
        to: ESCROW,
        value: amount,
    }
    .abi_encode()
}

fn pay(to: Address, amount: U256) -> Vec<u8> {
    IERC20::transferCall { to, value: amount }.abi_encode()
}

const TRUE: fn() -> Vec<u8> = || true.abi_encode();

fn setup() -> (MockChain, DialEscrow) {
    let vm = MockChain::new();
    vm.set_contract_address(ESCROW);
    vm.set_chain_id(421614);
    vm.set_block_timestamp(NOW);
    vm.set_code(TOKEN, vec![0xfe]);
    arb_block(&vm, 7);
    let mut contract = DialEscrow::from(&vm);
    assert_eq!(tx(&vm, || contract.constructor(ATTESTOR, TOKEN)), "ok");
    (vm, contract)
}

/// A contract with escrow ID funded by SENDER for AMOUNT until EXPIRY.
fn funded() -> (MockChain, DialEscrow) {
    let (vm, mut contract) = setup();
    token_returns(&vm, pull(SENDER, AMOUNT), Ok(TRUE()));
    vm.set_sender(SENDER);
    assert_eq!(tx(&vm, || contract.fund(ID, TOKEN, AMOUNT, EXPIRY)), "ok");
    (vm, contract)
}

fn topics_of(vm: &MockChain, signature: B256) -> Vec<Vec<B256>> {
    vm.get_emitted_logs()
        .into_iter()
        .filter(|(t, _)| t[0] == signature)
        .map(|(t, _)| t)
        .collect()
}

#[test]
fn constructor_fixes_the_attestor_and_token_and_refuses_zero() {
    let (_, contract) = setup();
    assert_eq!(contract.attestor(), ATTESTOR);
    assert_eq!(contract.token(), TOKEN);

    let vm = MockChain::new();
    vm.set_code(TOKEN, vec![0xfe]);
    let mut empty = DialEscrow::from(&vm);
    assert_eq!(
        tx(&vm, || empty.constructor(Address::ZERO, TOKEN)),
        "ZeroAddress"
    );
    assert_eq!(
        tx(&vm, || empty.constructor(ATTESTOR, Address::ZERO)),
        "ZeroAddress"
    );
    // A token address without code can't be fixed in: it would never move anything.
    assert_eq!(
        tx(&vm, || empty.constructor(ATTESTOR, FAKE_TOKEN)),
        "NoCode"
    );
}

#[test]
fn fund_pulls_from_the_caller_and_records_the_escrow() {
    let (vm, contract) = funded();
    assert_eq!(
        contract.escrow(ID),
        (SENDER, TOKEN, AMOUNT, EXPIRY, OPEN, 7, 0)
    );
    let funded = topics_of(&vm, Funded::SIGNATURE_HASH);
    assert_eq!(funded.len(), 1);
    assert_eq!(funded[0][1], ID);
    assert_eq!(funded[0][2], SENDER.into_word());
    assert_eq!(funded[0][3], TOKEN.into_word());
}

#[test]
fn fund_refuses_bad_input() {
    let (vm, mut contract) = setup();
    vm.set_sender(SENDER);
    token_returns(&vm, pull(SENDER, AMOUNT), Ok(TRUE()));
    assert_eq!(
        tx(&vm, || contract.fund(ID, TOKEN, U256::ZERO, EXPIRY)),
        "ZeroAmount"
    );
    assert_eq!(
        tx(&vm, || contract.fund(ID, Address::ZERO, AMOUNT, EXPIRY)),
        "WrongToken"
    );
    assert_eq!(
        tx(&vm, || contract.fund(ID, TOKEN, AMOUNT, NOW)),
        "ExpiryInPast"
    );
    assert_eq!(
        tx(&vm, || contract.fund(ID, TOKEN, AMOUNT, NOW - 1)),
        "ExpiryInPast"
    );
    // None of those left the lock held or the id taken.
    assert_eq!(tx(&vm, || contract.fund(ID, TOKEN, AMOUNT, EXPIRY)), "ok");
}

#[test]
fn one_fund_per_id_even_after_it_closes() {
    let (vm, mut contract) = funded();
    assert_eq!(
        tx(&vm, || contract.fund(ID, TOKEN, AMOUNT, EXPIRY)),
        "AlreadyFunded"
    );

    token_returns(&vm, pay(RECIPIENT, AMOUNT), Ok(TRUE()));
    vm.set_sender(ATTESTOR);
    assert_eq!(tx(&vm, || contract.claim(ID, RECIPIENT)), "ok");
    vm.set_sender(SENDER);
    assert_eq!(
        tx(&vm, || contract.fund(ID, TOKEN, AMOUNT, EXPIRY)),
        "AlreadyFunded"
    );
}

#[test]
fn fund_checks_the_token_call() {
    let (vm, mut contract) = setup();
    vm.set_sender(SENDER);

    // transferFrom returned false.
    token_returns(&vm, pull(SENDER, AMOUNT), Ok(false.abi_encode()));
    assert_eq!(
        tx(&vm, || contract.fund(ID, TOKEN, AMOUNT, EXPIRY)),
        "TokenCallFailed"
    );

    // transferFrom reverted (no allowance, say).
    let other = B256::repeat_byte(2);
    token_returns(&vm, pull(SENDER, U256::from(9)), Err(vec![]));
    assert_eq!(
        tx(&vm, || contract.fund(other, TOKEN, U256::from(9), EXPIRY)),
        "TokenCallFailed"
    );

    // A token that returns nothing (pre-standard, like USDT) is fine.
    let quiet = B256::repeat_byte(3);
    token_returns(&vm, pull(SENDER, U256::from(4)), Ok(vec![]));
    assert_eq!(
        tx(&vm, || contract.fund(quiet, TOKEN, U256::from(4), EXPIRY)),
        "ok"
    );

    // An address without code "succeeds" without moving anything, so it is refused, even if the token
    // somehow lost its code after deploy.
    vm.set_code(TOKEN, vec![]);
    token_returns(&vm, pull(SENDER, AMOUNT), Ok(TRUE()));
    assert_eq!(
        tx(&vm, || contract.fund(
            B256::repeat_byte(4),
            TOKEN,
            AMOUNT,
            EXPIRY
        )),
        "NoCode"
    );
}

#[test]
fn escrows_hold_only_the_token_fixed_at_deploy() {
    let (vm, mut contract) = setup();
    vm.set_code(FAKE_TOKEN, vec![0xfe]);
    vm.mock_call(
        FAKE_TOKEN,
        IERC20::transferFromCall {
            from: SENDER,
            to: ESCROW,
            value: AMOUNT,
        }
        .abi_encode(),
        U256::ZERO,
        Ok(TRUE()),
    );
    vm.set_sender(SENDER);
    assert_eq!(
        tx(&vm, || contract.fund(ID, FAKE_TOKEN, AMOUNT, EXPIRY)),
        "WrongToken"
    );
    assert_eq!(
        contract.escrow(ID),
        (Address::ZERO, Address::ZERO, U256::ZERO, 0, NONE, 0, 0)
    );
}

#[test]
fn a_stranger_cant_open_an_escrow_in_the_senders_name_with_a_fake_token() {
    let (vm, mut contract) = setup();
    // The stranger's token "accepts" any authorization: it checks no signature and moves nothing.
    let far = EXPIRY * 1_000;
    let junk = (27u8, B256::repeat_byte(0x33), B256::repeat_byte(0x44));
    let valid_before = U256::from(5_000);
    let fake_receive = IERC3009::receiveWithAuthorizationCall {
        from: SENDER,
        to: ESCROW,
        value: AMOUNT,
        validAfter: U256::ZERO,
        validBefore: valid_before,
        nonce: contract.funding_nonce(ID, far),
        v: junk.0,
        r: junk.1,
        s: junk.2,
    };
    vm.set_code(FAKE_TOKEN, vec![0xfe]);
    vm.mock_call(
        FAKE_TOKEN,
        fake_receive.abi_encode(),
        U256::ZERO,
        Ok(vec![]),
    );

    vm.set_sender(STRANGER);
    assert_eq!(
        tx(&vm, || contract.fund_with_authorization(
            ID,
            FAKE_TOKEN,
            SENDER,
            AMOUNT,
            far,
            valid_before,
            junk.0,
            junk.1,
            junk.2
        )),
        "WrongToken"
    );
    assert_eq!(contract.escrow(ID).4, NONE);
    assert!(topics_of(&vm, Funded::SIGNATURE_HASH).is_empty());

    // The id is still free, so the sender's real funding goes through and the claim pays the real token.
    token_returns(&vm, pull(SENDER, AMOUNT), Ok(TRUE()));
    vm.set_sender(SENDER);
    assert_eq!(tx(&vm, || contract.fund(ID, TOKEN, AMOUNT, EXPIRY)), "ok");
    assert_eq!(
        contract.escrow(ID),
        (SENDER, TOKEN, AMOUNT, EXPIRY, OPEN, 7, 0)
    );
    token_returns(&vm, pay(RECIPIENT, AMOUNT), Ok(TRUE()));
    vm.set_sender(ATTESTOR);
    assert_eq!(tx(&vm, || contract.claim(ID, RECIPIENT)), "ok");
}

#[test]
fn fund_with_authorization_records_the_signer_as_sender() {
    let (vm, mut contract) = setup();
    let (v, r, s) = (27u8, B256::repeat_byte(0x11), B256::repeat_byte(0x22));
    let valid_before = U256::from(5_000);
    let receive = IERC3009::receiveWithAuthorizationCall {
        from: SENDER,
        to: ESCROW,
        value: AMOUNT,
        validAfter: U256::ZERO,
        validBefore: valid_before,
        nonce: contract.funding_nonce(ID, EXPIRY),
        v,
        r,
        s,
    };
    token_returns(&vm, receive.abi_encode(), Ok(vec![]));

    // The authorization is bound to its expiry through the nonce: another expiry is a different call,
    // which the token would refuse.
    vm.set_sender(RELAYER);
    assert_eq!(
        tx(&vm, || contract.fund_with_authorization(
            ID,
            TOKEN,
            SENDER,
            AMOUNT,
            EXPIRY + 1,
            valid_before,
            v,
            r,
            s
        )),
        "TokenCallFailed"
    );

    assert_eq!(
        tx(&vm, || contract.fund_with_authorization(
            ID,
            TOKEN,
            SENDER,
            AMOUNT,
            EXPIRY,
            valid_before,
            v,
            r,
            s
        )),
        "ok"
    );
    assert_eq!(contract.escrow(ID).0, SENDER);
    assert_eq!(
        topics_of(&vm, Funded::SIGNATURE_HASH)[0][2],
        SENDER.into_word()
    );
}

#[test]
fn claim_pays_the_recipient() {
    let (vm, mut contract) = funded();
    arb_block(&vm, 9);
    token_returns(&vm, pay(RECIPIENT, AMOUNT), Ok(TRUE()));
    vm.set_sender(ATTESTOR);
    vm.set_block_timestamp(EXPIRY - 1);
    assert_eq!(tx(&vm, || contract.claim(ID, RECIPIENT)), "ok");
    assert_eq!(
        contract.escrow(ID),
        (SENDER, TOKEN, AMOUNT, EXPIRY, CLAIMED, 7, 9)
    );
    let claimed = topics_of(&vm, Claimed::SIGNATURE_HASH);
    assert_eq!(claimed.len(), 1);
    assert_eq!(claimed[0][1], ID);
    assert_eq!(claimed[0][2], RECIPIENT.into_word());
}

#[test]
fn only_the_attestor_can_claim() {
    let (vm, mut contract) = funded();
    token_returns(&vm, pay(STRANGER, AMOUNT), Ok(TRUE()));
    for caller in [STRANGER, SENDER, RECIPIENT, ESCROW] {
        vm.set_sender(caller);
        assert_eq!(tx(&vm, || contract.claim(ID, STRANGER)), "NotAttestor");
    }
    assert_eq!(contract.escrow(ID).4, OPEN);
}

#[test]
fn claim_refuses_after_expiry_closed_missing_and_zero() {
    let (vm, mut contract) = funded();
    token_returns(&vm, pay(RECIPIENT, AMOUNT), Ok(TRUE()));
    vm.set_sender(ATTESTOR);
    assert_eq!(tx(&vm, || contract.claim(ID, Address::ZERO)), "ZeroAddress");
    assert_eq!(
        tx(&vm, || contract.claim(B256::repeat_byte(9), RECIPIENT)),
        "NotOpen"
    );
    vm.set_block_timestamp(EXPIRY);
    assert_eq!(tx(&vm, || contract.claim(ID, RECIPIENT)), "Expired");

    vm.set_block_timestamp(NOW);
    assert_eq!(tx(&vm, || contract.claim(ID, RECIPIENT)), "ok");
    assert_eq!(tx(&vm, || contract.claim(ID, RECIPIENT)), "NotOpen");
}

#[test]
fn claim_fails_when_the_transfer_fails() {
    let (vm, mut contract) = funded();
    token_returns(&vm, pay(RECIPIENT, AMOUNT), Ok(false.abi_encode()));
    vm.set_sender(ATTESTOR);
    assert_eq!(tx(&vm, || contract.claim(ID, RECIPIENT)), "TokenCallFailed");
    assert!(topics_of(&vm, Claimed::SIGNATURE_HASH).is_empty());
    assert_eq!(contract.escrow(ID).4, OPEN);
}

#[test]
fn refund_returns_it_to_the_sender_from_expiry_on() {
    let (vm, mut contract) = funded();
    token_returns(&vm, pay(SENDER, AMOUNT), Ok(TRUE()));
    vm.set_sender(SENDER);
    vm.set_block_timestamp(EXPIRY - 1);
    assert_eq!(tx(&vm, || contract.refund(ID)), "NotExpired");

    arb_block(&vm, 11);
    vm.set_block_timestamp(EXPIRY);
    assert_eq!(tx(&vm, || contract.refund(ID)), "ok");
    assert_eq!(
        contract.escrow(ID),
        (SENDER, TOKEN, AMOUNT, EXPIRY, REFUNDED, 7, 11)
    );
    let refunded = topics_of(&vm, Refunded::SIGNATURE_HASH);
    assert_eq!(refunded.len(), 1);
    assert_eq!(refunded[0][1], ID);
    assert_eq!(refunded[0][2], SENDER.into_word());

    assert_eq!(tx(&vm, || contract.refund(ID)), "NotOpen");
    vm.set_sender(ATTESTOR);
    vm.set_block_timestamp(NOW);
    assert_eq!(tx(&vm, || contract.claim(ID, RECIPIENT)), "NotOpen");
}

#[test]
fn only_the_sender_can_refund() {
    let (vm, mut contract) = funded();
    token_returns(&vm, pay(SENDER, AMOUNT), Ok(TRUE()));
    vm.set_block_timestamp(EXPIRY + 1);
    for caller in [ATTESTOR, STRANGER, RECIPIENT, ESCROW] {
        vm.set_sender(caller);
        assert_eq!(tx(&vm, || contract.refund(ID)), "NotSender");
    }
    assert_eq!(contract.escrow(ID).4, OPEN);
}

/// A real secp256k1 key, so the signature handed to ecrecover is a genuine one.
struct Signer {
    key: SigningKey,
    address: Address,
}

impl Signer {
    fn new(seed: u8) -> Self {
        let key = SigningKey::from_bytes(&[seed; 32].into()).unwrap();
        let point = key.verifying_key().to_encoded_point(false);
        let address = Address::from_slice(&keccak(&point.as_bytes()[1..])[12..]);
        Signer { key, address }
    }

    fn sign(&self, digest: B256) -> (u8, B256, B256) {
        let (sig, recid) = self
            .key
            .sign_prehash_recoverable(digest.as_slice())
            .unwrap();
        let bytes = sig.to_bytes();
        (
            27 + recid.to_byte(),
            B256::from_slice(&bytes[..32]),
            B256::from_slice(&bytes[32..]),
        )
    }
}

/// Answers the ecrecover precompile for this input the way the chain would.
fn mock_ecrecover(vm: &MockChain, digest: B256, (v, r, s): (u8, B256, B256)) {
    let sig = Signature::from_scalars(r.0, s.0).unwrap();
    let key = VerifyingKey::recover_from_prehash(
        digest.as_slice(),
        &sig,
        RecoveryId::from_byte(v - 27).unwrap(),
    )
    .unwrap();
    let point = key.to_encoded_point(false);
    let signer = Address::from_slice(&keccak(&point.as_bytes()[1..])[12..]);
    vm.mock_static_call(
        ECRECOVER,
        (digest, U256::from(v), r, s).abi_encode(),
        Ok(signer.into_word().to_vec()),
    );
}

#[test]
fn refund_digest_matches_eip712_as_viem_computes_it() {
    let (_, contract) = setup();
    // hashTypedData({ domain: { name: "DialEscrow", version: "1", chainId: 421614, verifyingContract: ESCROW },
    //   types: { Refund: [{ name: "id", type: "bytes32" }] }, primaryType: "Refund", message: { id: ID } })
    assert_eq!(
        contract.refund_digest(ID),
        b256!("94e4516b05ddbc591e2ce1e855281146a06549244a393674e9effd580523cee9")
    );
    // keccak256(encodeAbiParameters([bytes32, uint64], [ID, 2000]))
    assert_eq!(
        contract.funding_nonce(ID, EXPIRY),
        b256!("e1aef94d42fb31c0479065559722803a9b6f574c72eb9a6e70f7374fc9f97061")
    );
}

#[test]
fn refund_with_signature_lets_anyone_send_the_senders_refund() {
    let (vm, mut contract) = setup();
    let sender = Signer::new(7);
    token_returns(&vm, pull(sender.address, AMOUNT), Ok(TRUE()));
    vm.set_sender(sender.address);
    assert_eq!(tx(&vm, || contract.fund(ID, TOKEN, AMOUNT, EXPIRY)), "ok");

    let digest = contract.refund_digest(ID);
    let sig = sender.sign(digest);
    mock_ecrecover(&vm, digest, sig);
    token_returns(&vm, pay(sender.address, AMOUNT), Ok(TRUE()));
    vm.set_sender(RELAYER);

    vm.set_block_timestamp(EXPIRY - 1);
    assert_eq!(
        tx(&vm, || contract
            .refund_with_signature(ID, sig.0, sig.1, sig.2)),
        "NotExpired"
    );
    vm.set_block_timestamp(EXPIRY);
    assert_eq!(
        tx(&vm, || contract
            .refund_with_signature(ID, sig.0, sig.1, sig.2)),
        "ok"
    );
    assert_eq!(contract.escrow(ID).4, REFUNDED);
    assert_eq!(
        topics_of(&vm, Refunded::SIGNATURE_HASH)[0][2],
        sender.address.into_word()
    );
}

#[test]
fn refund_with_signature_refuses_other_signers_and_bad_signatures() {
    let (vm, mut contract) = funded();
    vm.set_block_timestamp(EXPIRY);
    vm.set_sender(RELAYER);
    let digest = contract.refund_digest(ID);

    // Someone other than the sender signed it (the attestor, say).
    let attestor = Signer::new(9);
    let sig = attestor.sign(digest);
    mock_ecrecover(&vm, digest, sig);
    assert_eq!(
        tx(&vm, || contract
            .refund_with_signature(ID, sig.0, sig.1, sig.2)),
        "NotSender"
    );

    // The malleable twin (high s, flipped v) is refused before ecrecover.
    let n = U256::from_be_bytes(hex!(
        "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141"
    ));
    let high_s = B256::from(n - U256::from_be_bytes(sig.2.0));
    let flipped = if sig.0 == 27 { 28 } else { 27 };
    assert_eq!(
        tx(&vm, || contract
            .refund_with_signature(ID, flipped, sig.1, high_s)),
        "BadSignature"
    );
    assert_eq!(
        tx(&vm, || contract.refund_with_signature(ID, 29, sig.1, sig.2)),
        "BadSignature"
    );
    assert_eq!(
        tx(&vm, || contract.refund_with_signature(
            ID,
            sig.0,
            B256::ZERO,
            sig.2
        )),
        "BadSignature"
    );

    // ecrecover found no signer.
    let junk = (27u8, B256::repeat_byte(1), B256::repeat_byte(1));
    vm.mock_static_call(
        ECRECOVER,
        (digest, U256::from(27u8), junk.1, junk.2).abi_encode(),
        Ok(vec![]),
    );
    assert_eq!(
        tx(&vm, || contract
            .refund_with_signature(ID, junk.0, junk.1, junk.2)),
        "BadSignature"
    );
    assert_eq!(contract.escrow(ID).4, OPEN);
}

#[test]
fn a_token_calling_back_in_is_refused() {
    let (vm, mut contract) = funded();
    // What a reentrant call sees: the lock held by the call already running.
    contract.locked.set(true);
    vm.set_sender(ATTESTOR);
    assert_eq!(tx(&vm, || contract.claim(ID, RECIPIENT)), "Reentrancy");
    vm.set_sender(SENDER);
    vm.set_block_timestamp(EXPIRY);
    assert_eq!(tx(&vm, || contract.refund(ID)), "Reentrancy");
    assert_eq!(
        tx(&vm, || contract.fund(
            B256::repeat_byte(5),
            TOKEN,
            AMOUNT,
            EXPIRY + 10
        )),
        "Reentrancy"
    );
    assert_eq!(contract.escrow(ID).4, OPEN);
}

#[test]
fn the_lock_is_released_after_every_call() {
    let (vm, mut contract) = funded();
    vm.set_sender(STRANGER);
    assert_eq!(tx(&vm, || contract.claim(ID, RECIPIENT)), "NotAttestor");
    assert!(!contract.locked.get());
    token_returns(&vm, pay(RECIPIENT, AMOUNT), Ok(TRUE()));
    vm.set_sender(ATTESTOR);
    assert_eq!(tx(&vm, || contract.claim(ID, RECIPIENT)), "ok");
    assert!(!contract.locked.get());
}
