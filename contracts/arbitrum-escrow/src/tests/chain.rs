//! A test host: stylus-test's TestVM with calls that behave like the chain's.
//!
//! TestVM 0.10.10 hands every call the return data of whichever mock was registered last, and lets a
//! call nobody mocked succeed with no data. This contract makes several calls per transaction (ArbSys,
//! the token, ecrecover) and treats an empty return from a token as success, so both would hide bugs.
//! MockChain answers each call with its own mock and reverts calls nobody mocked, and `transact` undoes
//! a failed call's storage writes and logs the way a reverted transaction would. Everything else is
//! TestVM's.

use std::{cell::RefCell, collections::HashMap, ops::Deref, rc::Rc, slice};

use alloy_primitives::{Address, B256, U256};
use stylus_sdk::stylus_core::host::*;
use stylus_sdk::testing::TestVM;

type Mocks = Rc<RefCell<HashMap<(Address, Vec<u8>, U256), Result<Vec<u8>, Vec<u8>>>>>;

#[derive(Clone, Default)]
pub struct MockChain {
    vm: TestVM,
    calls: Mocks,
    static_calls: Mocks,
    return_data: Rc<RefCell<Vec<u8>>>,
}

impl MockChain {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn mock_call(
        &self,
        to: Address,
        data: Vec<u8>,
        value: U256,
        result: Result<Vec<u8>, Vec<u8>>,
    ) {
        self.calls.borrow_mut().insert((to, data, value), result);
    }

    pub fn mock_static_call(&self, to: Address, data: Vec<u8>, result: Result<Vec<u8>, Vec<u8>>) {
        self.static_calls
            .borrow_mut()
            .insert((to, data, U256::ZERO), result);
    }

    /// Runs `f` as a transaction: if it fails, its storage writes and logs are undone.
    pub fn transact<E>(&self, f: impl FnOnce() -> Result<(), E>) -> Result<(), E> {
        let before = self.vm.snapshot();
        let result = f();
        if result.is_err() {
            self.vm.clear_storage();
            for (key, value) in before.storage {
                self.vm.set_storage(key, value);
            }
            // Also drops TestVM's own mocks, which nothing here uses.
            self.vm.clear_mocks();
            for (topics, data) in before.emitted_logs {
                self.vm.raw_log(&topics, &data).unwrap();
            }
        }
        result
    }

    /// Looks up the mock, keeps its data for read_return_data, and returns the hostio status.
    unsafe fn answer(
        &self,
        mocks: &Mocks,
        to: *const u8,
        data: *const u8,
        data_len: usize,
        value: U256,
        outs_len: &mut usize,
    ) -> u8 {
        let key = unsafe {
            (
                Address::from_slice(slice::from_raw_parts(to, 20)),
                slice::from_raw_parts(data, data_len).to_vec(),
                value,
            )
        };
        let result = mocks.borrow().get(&key).cloned().unwrap_or(Err(Vec::new()));
        let (status, out) = match result {
            Ok(out) => (0, out),
            Err(out) => (1, out),
        };
        *outs_len = out.len();
        *self.return_data.borrow_mut() = out;
        status
    }
}

impl Deref for MockChain {
    type Target = TestVM;
    fn deref(&self) -> &TestVM {
        &self.vm
    }
}

impl Host for MockChain {}

unsafe impl UnsafeCallAccess for MockChain {
    unsafe fn call_contract(
        &self,
        to: *const u8,
        data: *const u8,
        data_len: usize,
        value: *const u8,
        _gas: u64,
        outs_len: &mut usize,
    ) -> u8 {
        let value = unsafe { U256::from_be_slice(slice::from_raw_parts(value, 32)) };
        unsafe { self.answer(&self.calls, to, data, data_len, value, outs_len) }
    }
    unsafe fn static_call_contract(
        &self,
        to: *const u8,
        data: *const u8,
        data_len: usize,
        _gas: u64,
        outs_len: &mut usize,
    ) -> u8 {
        unsafe { self.answer(&self.static_calls, to, data, data_len, U256::ZERO, outs_len) }
    }
    unsafe fn delegate_call_contract(
        &self,
        _to: *const u8,
        _data: *const u8,
        _data_len: usize,
        _gas: u64,
        outs_len: &mut usize,
    ) -> u8 {
        *outs_len = 0;
        1
    }
}

impl CalldataAccess for MockChain {
    fn read_args(&self, len: usize) -> Vec<u8> {
        self.vm.read_args(len)
    }
    fn read_return_data(&self, offset: usize, size: Option<usize>) -> Vec<u8> {
        let data = self.return_data.borrow();
        let start = offset.min(data.len());
        let end = size.map_or(data.len(), |s| (start + s).min(data.len()));
        data[start..end].to_vec()
    }
    fn return_data_size(&self) -> usize {
        self.return_data.borrow().len()
    }
    fn write_result(&self, data: &[u8]) {
        self.vm.write_result(data)
    }
}

impl CryptographyAccess for MockChain {
    fn native_keccak256(&self, input: &[u8]) -> B256 {
        self.vm.native_keccak256(input)
    }
}

unsafe impl UnsafeDeploymentAccess for MockChain {
    unsafe fn create1(
        &self,
        code: *const u8,
        code_len: usize,
        endowment: *const u8,
        contract: *mut u8,
        revert_data_len: *mut usize,
    ) {
        unsafe {
            self.vm
                .create1(code, code_len, endowment, contract, revert_data_len)
        }
    }
    unsafe fn create2(
        &self,
        code: *const u8,
        code_len: usize,
        endowment: *const u8,
        salt: *const u8,
        contract: *mut u8,
        revert_data_len: *mut usize,
    ) {
        unsafe {
            self.vm
                .create2(code, code_len, endowment, salt, contract, revert_data_len)
        }
    }
}

impl StorageAccess for MockChain {
    fn storage_load_bytes32(&self, key: U256) -> B256 {
        self.vm.storage_load_bytes32(key)
    }
    unsafe fn storage_cache_bytes32(&self, key: U256, value: B256) {
        unsafe { self.vm.storage_cache_bytes32(key, value) }
    }
    fn flush_cache(&self, clear: bool) {
        self.vm.flush_cache(clear)
    }
}

impl BlockAccess for MockChain {
    fn block_basefee(&self) -> U256 {
        self.vm.block_basefee()
    }
    fn block_coinbase(&self) -> Address {
        self.vm.block_coinbase()
    }
    fn block_number(&self) -> u64 {
        self.vm.block_number()
    }
    fn block_timestamp(&self) -> u64 {
        self.vm.block_timestamp()
    }
    fn block_gas_limit(&self) -> u64 {
        self.vm.block_gas_limit()
    }
}

impl ChainAccess for MockChain {
    fn chain_id(&self) -> u64 {
        self.vm.chain_id()
    }
}

impl AccountAccess for MockChain {
    fn balance(&self, account: Address) -> U256 {
        self.vm.balance(account)
    }
    fn contract_address(&self) -> Address {
        self.vm.contract_address()
    }
    fn code(&self, account: Address) -> Vec<u8> {
        self.vm.code(account)
    }
    fn code_size(&self, account: Address) -> usize {
        self.vm.code_size(account)
    }
    fn code_hash(&self, account: Address) -> B256 {
        self.vm.code_hash(account)
    }
}

impl MemoryAccess for MockChain {
    fn pay_for_memory_grow(&self, pages: u16) {
        self.vm.pay_for_memory_grow(pages)
    }
}

impl MessageAccess for MockChain {
    fn msg_sender(&self) -> Address {
        self.vm.msg_sender()
    }
    fn msg_reentrant(&self) -> bool {
        self.vm.msg_reentrant()
    }
    fn msg_value(&self) -> U256 {
        self.vm.msg_value()
    }
    fn tx_origin(&self) -> Address {
        self.vm.tx_origin()
    }
}

impl MeteringAccess for MockChain {
    fn evm_gas_left(&self) -> u64 {
        self.vm.evm_gas_left()
    }
    fn evm_ink_left(&self) -> u64 {
        self.vm.evm_ink_left()
    }
    fn tx_gas_price(&self) -> U256 {
        self.vm.tx_gas_price()
    }
    fn tx_ink_price(&self) -> u32 {
        self.vm.tx_ink_price()
    }
}

impl RawLogAccess for MockChain {
    fn emit_log(&self, input: &[u8], num_topics: usize) {
        self.vm.emit_log(input, num_topics)
    }
    fn raw_log(&self, topics: &[B256], data: &[u8]) -> Result<(), &'static str> {
        self.vm.raw_log(topics, data)
    }
}
