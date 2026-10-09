//! The wallet: one seed, one ZIP 32 account per Dial wallet, scanned together from lightwalletd.

use std::{
    num::{NonZeroU32, NonZeroUsize},
    path::{Path, PathBuf},
    str::FromStr,
    time::Duration,
};

use anyhow::{Context, anyhow};
use rand::rngs::SysRng;
use rand_core::UnwrapErr;
use rusqlite::{Connection, OptionalExtension, params};
use secrecy::{ExposeSecret, SecretVec};
use tonic::transport::{Channel, ClientTlsConfig, Endpoint};
use zcash_address::ZcashAddress;
use zcash_client_backend::{
    data_api::{
        Account, AccountBirthday, MaxSpendMode, WalletRead, WalletWrite,
        locking::LockedInputPolicy,
        wallet::{
            ConfirmationsPolicy, SpendingKeys, create_proposed_transactions,
            input_selection::{GreedyInputSelector, SpendPolicy},
            propose_send_max_transfer, propose_transfer,
        },
    },
    fees::{DustOutputPolicy, SplitPolicy, StandardFeeRule, standard::MultiOutputChangeStrategy},
    proto::service::{self, compact_tx_streamer_client::CompactTxStreamerClient},
    sync,
    wallet::OvkPolicy,
};
use zcash_client_sqlite::{
    AccountUuid, WalletDb, util::SystemClock, wallet::commitment_tree::Error as CommitmentTreeErr,
    wallet::init::init_wallet_db,
};
use zcash_keys::{
    address::Address,
    keys::{
        ReceiverRequirement::{Omit, Require},
        UnifiedAddressRequest, UnifiedSpendingKey,
    },
};
use zcash_proofs::prover::LocalTxProver;
use zcash_protocol::{
    ShieldedPool,
    consensus::Network,
    memo::{Memo, MemoBytes},
    value::Zatoshis,
};
use zip321::{Payment, TransactionRequest};

use crate::cache::MemCache;

/// Testnet only. Mainnet would need a real custody review first.
pub const PARAMS: Network = Network::TestNetwork;

/// Accounts made ahead of signups, and how few left before making more.
const POOL: u32 = 100;
const POOL_LOW: u32 = 10;

/// The ZIP 317 fee for a typical shielded payment (two logical actions). A payment to another
/// account in this wallet carries `carry` of these on top, so the recipient can spend what it
/// was sent without coming up short for its own fee.
pub const FEE: u64 = 10_000;

type Db = WalletDb<Connection, Network, SystemClock, UnwrapErr<SysRng>>;

/// Opens the wallet database for one user of it. The request handlers and the sync loop each get
/// their own connection, so a long rescan never blocks a balance read; WAL lets them read while
/// the other writes, and the busy timeout queues writers instead of failing them.
fn open_db(path: &Path) -> anyhow::Result<Db> {
    let conn = Connection::open(path)?;
    rusqlite::vtab::array::load_module(&conn)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.busy_timeout(Duration::from_secs(120))?;
    Ok(WalletDb::from_connection(conn, PARAMS, SystemClock, UnwrapErr(SysRng)))
}

pub struct Wallet {
    db: Db,
    client: CompactTxStreamerClient<Channel>,
    seed: SecretVec<u8>,
    /// The service birthday: rebuilt accounts scan from here.
    birthday: AccountBirthday,
    confirmations: ConfirmationsPolicy,
    prover: LocalTxProver,
    /// Every send this wallet broadcast, by (account, recipient, memo), so a retried request returns
    /// the transaction it already sent instead of paying twice.
    sends: Connection,
}

/// The sync loop's half: its own connection and block cache.
pub struct Syncer {
    db: Db,
    client: CompactTxStreamerClient<Channel>,
    cache: MemCache,
}

#[derive(Debug)]
pub enum WalletError {
    BadRequest(String),
    NotFound(String),
    Insufficient(String),
    NotSynced,
    /// lightwalletd refused the transaction. It was rolled back: nothing moved.
    Rejected(String),
    /// The transaction was built and recorded but the broadcast got no answer. It may be on the network;
    /// asking again with the same (account, recipient, memo) re-broadcasts the same transaction.
    Unknown(String),
    Internal(anyhow::Error),
}

impl From<anyhow::Error> for WalletError {
    fn from(e: anyhow::Error) -> Self {
        WalletError::Internal(e)
    }
}

impl From<rusqlite::Error> for WalletError {
    fn from(e: rusqlite::Error) -> Self {
        WalletError::Internal(e.into())
    }
}

pub type Result<T> = std::result::Result<T, WalletError>;

#[derive(serde::Serialize)]
pub struct Balance {
    /// Can be spent now.
    pub spendable: u64,
    /// Everything the account holds, including notes still waiting for confirmations.
    pub total: u64,
    /// What the account could send out after paying the fee to spend everything it holds.
    pub sendable: u64,
}

#[derive(serde::Serialize)]
pub struct SyncStatus {
    pub chain_tip: Option<u32>,
    pub scanned: Option<u32>,
    pub synced: bool,
    pub accounts: usize,
}

pub async fn connect(url: &str) -> anyhow::Result<CompactTxStreamerClient<Channel>> {
    let mut endpoint = Endpoint::from_shared(url.to_string())?;
    if url.starts_with("https://") {
        endpoint = endpoint.tls_config(ClientTlsConfig::new().with_webpki_roots())?;
    }
    let channel = endpoint
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(60))
        .connect()
        .await
        .with_context(|| format!("connecting to lightwalletd at {url}"))?;
    Ok(CompactTxStreamerClient::new(channel).max_decoding_message_size(32 * 1024 * 1024))
}

/// The chain state as of `height - 1`: what an account born at `height` starts from.
async fn birthday_at(client: &mut CompactTxStreamerClient<Channel>, height: u64) -> anyhow::Result<AccountBirthday> {
    let treestate = client.get_tree_state(service::BlockId { height: height - 1, hash: vec![] }).await?.into_inner();
    AccountBirthday::from_treestate(treestate, None).map_err(|e| anyhow!("birthday: {e:?}"))
}

impl Syncer {
    /// Scans up to the chain tip, committing every batch, so a rescan from the birthday shows
    /// progress and a send can slot in between batches.
    pub async fn sync(&mut self) -> anyhow::Result<()> {
        sync::run(&mut self.client, &PARAMS, &self.cache, &mut self.db, 1000)
            .await
            .map_err(|e| anyhow!("sync: {e}"))
    }
}

impl Wallet {
    pub async fn open(
        data_dir: &Path,
        lightwalletd: &str,
        seed: SecretVec<u8>,
        birthday_height: u32,
        min_confirmations: NonZeroU32,
    ) -> anyhow::Result<(Self, Syncer)> {
        std::fs::create_dir_all(data_dir)?;
        let path: PathBuf = data_dir.join("wallet.sqlite");
        let mut db = open_db(&path)?;
        init_wallet_db(&mut db, Some(SecretVec::new(seed.expose_secret().clone())))
            .map_err(|e| anyhow!("wallet db migration failed: {e}"))?;

        let sends = Connection::open(data_dir.join("sends.sqlite"))?;
        sends.execute_batch(
            "CREATE TABLE IF NOT EXISTS sends (key TEXT PRIMARY KEY, txid TEXT NOT NULL, at INTEGER NOT NULL);
             CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);",
        )?;

        let mut client = connect(lightwalletd).await?;
        let info = client.get_lightd_info(service::Empty {}).await?.into_inner();
        if info.chain_name != "test" {
            return Err(anyhow!("{lightwalletd} serves chain {:?}, expected testnet", info.chain_name));
        }
        let birthday = birthday_at(&mut client, u64::from(birthday_height)).await?;

        let mut wallet = Wallet {
            db,
            client: client.clone(),
            seed,
            birthday,
            confirmations: ConfirmationsPolicy::new_symmetrical(min_confirmations),
            prover: LocalTxProver::bundled(),
            sends,
        };
        wallet.restore(1).map_err(|e| anyhow!("{e:?}"))?; // account 0 is the treasury
        let syncer = Syncer { db: open_db(&path)?, client, cache: MemCache::default() };
        Ok((wallet, syncer))
    }

    fn usk(&self, index: u32) -> Result<UnifiedSpendingKey> {
        let account = zip32::AccountId::try_from(index).map_err(|_| WalletError::BadRequest("bad account index".into()))?;
        UnifiedSpendingKey::from_seed(&PARAMS, self.seed.expose_secret(), account)
            .map_err(|e| WalletError::Internal(anyhow!("key derivation: {e:?}")))
    }

    /// The account's address: Orchard and Sapling receivers at the first diversifier index valid for
    /// both, so Sapling-only wallets can pay it too. Deterministic, so a wallet rebuilt from the seed
    /// hands out the same addresses.
    pub fn address(&self, index: u32) -> Result<String> {
        let ufvk = self.usk(index)?.to_unified_full_viewing_key();
        let (ua, _) = ufvk
            .default_address(UnifiedAddressRequest::unsafe_custom(Require, Require, Omit))
            .map_err(|e| WalletError::Internal(anyhow!("address: {e:?}")))?;
        Ok(ua.encode(&PARAMS))
    }

    /// ZIP 32 account index → wallet account id, for every account in the wallet.
    fn accounts(&self) -> Result<Vec<(u32, AccountUuid)>> {
        let mut out = vec![];
        for id in self.db.get_account_ids().map_err(db_err)? {
            let Some(account) = self.db.get_account(id).map_err(db_err)? else { continue };
            if let Some(d) = account.source().key_derivation() {
                out.push((u32::from(d.account_index()), id));
            }
        }
        out.sort_by_key(|(i, _)| *i);
        Ok(out)
    }

    fn account_id(&self, index: u32) -> Result<AccountUuid> {
        self.accounts()?
            .into_iter()
            .find(|(i, _)| *i == index)
            .map(|(_, id)| id)
            .ok_or_else(|| WalletError::NotFound(format!("account {index} is not in this wallet")))
    }

    fn import(&mut self, index: u32, birthday: &AccountBirthday) -> Result<()> {
        let account = zip32::AccountId::try_from(index).map_err(|_| WalletError::BadRequest("bad account index".into()))?;
        let seed = SecretVec::new(self.seed.expose_secret().clone());
        self.db.import_account_hd(&format!("dial-{index}"), &seed, account, birthday, None).map_err(db_err)?;
        Ok(())
    }

    /// Makes sure accounts 0..count exist, all born at the service birthday.
    fn ensure_accounts(&mut self, count: u32) -> Result<()> {
        let have: Vec<u32> = self.accounts()?.into_iter().map(|(i, _)| i).collect();
        let birthday = self.birthday.clone();
        for index in (0..count).filter(|i| !have.contains(i)) {
            self.import(index, &birthday)?;
        }
        Ok(())
    }

    fn account_count(&self) -> Result<u32> {
        Ok(self.accounts()?.last().map_or(0, |(i, _)| i + 1))
    }

    /// How many accounts have been handed out (the treasury counts).
    pub fn handed_out(&self) -> Result<u32> {
        let n: Option<u32> = self.sends.query_row("SELECT value FROM meta WHERE key = 'handed_out'", [], |r| r.get(0)).optional()?;
        Ok(n.unwrap_or(1))
    }

    fn set_handed_out(&self, n: u32) -> Result<()> {
        self.sends.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('handed_out', ?1)", params![n])?;
        Ok(())
    }

    /// Makes sure the first `handed` accounts count as handed out and a pool of unused accounts waits
    /// behind them. Every account is born at the service birthday, so a wallet rebuilt on a fresh disk
    /// only needs this count. Importing accounts sends the wallet back to rescan from the birthday,
    /// which is why they're made a pool at a time rather than one per signup.
    pub fn restore(&mut self, handed: u32) -> Result<u32> {
        let handed = handed.max(self.handed_out()?).max(1);
        self.set_handed_out(handed)?;
        if self.account_count()? < handed + POOL_LOW {
            self.ensure_accounts(handed + POOL)?;
        }
        Ok(handed)
    }

    /// Hands out the next pooled account. No import and no rescan, so it's instant; the pool is topped
    /// up when it runs low.
    pub fn create_account(&mut self) -> Result<(u32, String)> {
        let index = self.handed_out()?;
        self.restore(index + 1)?;
        Ok((index, self.address(index)?))
    }

    pub fn status(&self) -> Result<SyncStatus> {
        let tip = self.db.chain_height().map_err(db_err)?;
        let scanned = self.db.block_fully_scanned().map_err(db_err)?.map(|m| m.block_height());
        Ok(SyncStatus {
            chain_tip: tip.map(u32::from),
            scanned: scanned.map(u32::from),
            synced: matches!((tip, scanned), (Some(t), Some(s)) if s >= t),
            accounts: self.accounts()?.len(),
        })
    }

    /// The seed account an address belongs to, if any.
    fn owner(&self, address: &str) -> Result<Option<u32>> {
        let decoded = Address::decode(&PARAMS, address)
            .ok_or_else(|| WalletError::BadRequest("not a Zcash testnet address".into()))?;
        let Some(id) = self
            .db
            .find_account_for_address(&PARAMS, &decoded)
            .map_err(|e| WalletError::Internal(anyhow!("address lookup: {e:?}")))?
        else {
            return Ok(None);
        };
        Ok(self.accounts()?.into_iter().find(|(_, a)| *a == id).map(|(i, _)| i))
    }

    pub fn balance(&mut self, address: &str) -> Result<(u32, Balance)> {
        let index = self
            .owner(address)?
            .ok_or_else(|| WalletError::NotFound("address does not belong to this wallet".into()))?;
        Ok((index, self.account_balance(index)?))
    }

    pub fn account_balance(&mut self, index: u32) -> Result<Balance> {
        let id = self.account_id(index)?;
        let summary = self.db.get_wallet_summary(self.confirmations).map_err(db_err)?.ok_or(WalletError::NotSynced)?;
        let (spendable, total) = summary
            .account_balances()
            .get(&id)
            .map_or((0, 0), |b| (b.spendable_value().into_u64(), b.total().into_u64()));
        // The fee to spend every spendable note, from the same proposal a sweep would build. Notes still
        // confirming add a fee's worth until they can be counted properly.
        let fee = if spendable == 0 {
            if total > 0 { FEE } else { 0 }
        } else {
            let own = ZcashAddress::from_str(&self.address(index)?).map_err(|_| WalletError::Internal(anyhow!("own address")))?;
            match propose_send_max_transfer::<_, _, _, CommitmentTreeErr>(
                &mut self.db,
                &PARAMS,
                id,
                &[ShieldedPool::Sapling, ShieldedPool::Orchard, ShieldedPool::Ironwood],
                &StandardFeeRule::Zip317,
                own,
                None,
                MaxSpendMode::MaxSpendable,
                self.confirmations,
                &LockedInputPolicy::Exclude,
                None,
            ) {
                Ok(p) => p.steps().iter().map(|s| s.balance().fee_required().into_u64()).sum::<u64>() + if total > spendable { FEE } else { 0 },
                Err(_) => FEE,
            }
        };
        Ok(Balance { spendable, total, sendable: total.saturating_sub(fee) })
    }

    /// What a send of `zats` to `to` puts on the wire: plus `carry` fees when the recipient is another
    /// account in this wallet.
    pub fn outgoing(&self, to: &str, zats: u64, carry: u64) -> Result<u64> {
        Ok(if self.owner(to)?.is_some() { zats + carry * FEE } else { zats })
    }

    fn sent(&self, key: &str) -> Result<Option<String>> {
        Ok(self.sends.query_row("SELECT txid FROM sends WHERE key = ?1", params![key], |r| r.get(0)).optional()?)
    }

    /// Sends from account `index`. `sweep` sends everything spendable (minus the fee) and ignores `zats`.
    /// Idempotent per (account, recipient, memo): a repeat returns the first transaction's id.
    pub fn send(&mut self, index: u32, to: &str, zats: u64, memo: Option<&str>, sweep: bool, carry: u64) -> Result<String> {
        let key = memo.map(|m| format!("{index}|{to}|{m}"));
        if let Some(txid) = key.as_deref().map(|k| self.sent(k)).transpose()?.flatten() {
            self.rebroadcast(&txid);
            return Ok(txid);
        }
        let zats = if sweep { 0 } else { self.outgoing(to, zats, carry)? };
        let account = self.account_id(index)?;
        let recipient = Address::decode(&PARAMS, to).ok_or_else(|| WalletError::BadRequest("not a Zcash testnet address".into()))?;
        if matches!(recipient, Address::Transparent(_) | Address::Tex(_)) {
            return Err(WalletError::BadRequest("send to a shielded address (unified or Sapling)".into()));
        }
        let to_addr = ZcashAddress::from_str(to).map_err(|_| WalletError::BadRequest("bad address".into()))?;
        let memo = memo
            .map(|m| Memo::from_str(m).map(|m| MemoBytes::from(&m)))
            .transpose()
            .map_err(|_| WalletError::BadRequest("memo is longer than 512 bytes".into()))?;
        let usk = self.usk(index)?;
        let keys = SpendingKeys::from_unified_spending_key(usk);
        let confirmations = self.confirmations;
        let Wallet { db, client, prover, sends, .. } = self;
        let handle = tokio::runtime::Handle::current();

        // Build, broadcast and record in one database transaction: if lightwalletd rejects the
        // transaction it rolls back, and the notes it would have spent stay spendable.
        tokio::task::block_in_place(|| {
            db.transactionally::<_, _, WalletError>(|wdb| -> Result<Sent> {
                let proposal = if sweep {
                    propose_send_max_transfer::<_, _, _, CommitmentTreeErr>(
                        wdb,
                        &PARAMS,
                        account,
                        &[ShieldedPool::Sapling, ShieldedPool::Orchard, ShieldedPool::Ironwood],
                        &StandardFeeRule::Zip317,
                        to_addr,
                        memo,
                        MaxSpendMode::MaxSpendable,
                        confirmations,
                        &LockedInputPolicy::Exclude,
                        None,
                    )
                    .map_err(|e| proposal_err(e.to_string()))?
                } else {
                    let amount = Zatoshis::from_u64(zats).map_err(|_| WalletError::BadRequest("bad amount".into()))?;
                    let payment = Payment::new(to_addr, Some(amount), memo, None, None, vec![])
                        .map_err(|e| WalletError::BadRequest(format!("payment: {e:?}")))?;
                    let request =
                        TransactionRequest::new(vec![payment]).map_err(|e| WalletError::BadRequest(format!("{e:?}")))?;
                    // The treasury keeps its change in several notes: change waits a block before it can
                    // be spent, and one note would make back-to-back signups queue behind each other.
                    let split = if index == 0 {
                        SplitPolicy::with_min_output_value(NonZeroUsize::new(8).expect("nonzero"), Zatoshis::const_from_u64(2_000_000))
                    } else {
                        SplitPolicy::single_output()
                    };
                    let change =
                        MultiOutputChangeStrategy::new(StandardFeeRule::Zip317, None, ShieldedPool::Ironwood, DustOutputPolicy::default(), split);
                    propose_transfer::<_, _, _, _, CommitmentTreeErr>(
                        wdb,
                        &PARAMS,
                        account,
                        &GreedyInputSelector::new(),
                        &change,
                        request,
                        confirmations,
                        &SpendPolicy::default(),
                        None,
                        None,
                    )
                    .map_err(|e| proposal_err(e.to_string()))?
                };
                let mut rng = UnwrapErr(SysRng);
                let txids = create_proposed_transactions::<_, _, std::convert::Infallible, _, std::convert::Infallible, _>(
                    wdb,
                    &PARAMS,
                    &SystemClock,
                    &mut rng,
                    &*prover,
                    &*prover,
                    &keys,
                    OvkPolicy::Sender,
                    &proposal,
                    None,
                )
                .map_err(|e| proposal_err(e.to_string()))?;
                if txids.len() > 1 {
                    return Err(WalletError::Internal(anyhow!("multi-transaction proposals are not supported")));
                }
                let txid = *txids.first();
                let tx = wdb
                    .get_transaction(txid)
                    .map_err(db_err)?
                    .ok_or_else(|| WalletError::Internal(anyhow!("built transaction {txid} is missing")))?;
                let mut raw = service::RawTransaction::default();
                tx.write(&mut raw.data).map_err(|e| WalletError::Internal(e.into()))?;
                let txid = tx.txid().to_string();
                let record = |sends: &Connection| -> Result<()> {
                    if let Some(key) = &key {
                        let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
                        sends.execute("INSERT OR REPLACE INTO sends (key, txid, at) VALUES (?1, ?2, ?3)", params![key, txid, at])?;
                    }
                    Ok(())
                };
                match handle.block_on(client.send_transaction(raw)) {
                    Ok(r) if r.get_ref().error_code == 0 => {
                        record(sends)?;
                        Ok(Sent::Done(txid))
                    }
                    // A refusal is definite: roll back, so the notes stay spendable.
                    Ok(r) => Err(WalletError::Rejected(format!("({}) {}", r.get_ref().error_code, r.get_ref().error_message))),
                    // No answer: it may be out there. Keep the transaction (its notes stay spent until it
                    // expires) and its ledger entry, so a retry re-broadcasts it instead of paying again.
                    Err(e) => {
                        record(sends)?;
                        Ok(Sent::Unanswered(txid, e.message().to_string()))
                    }
                }
            })
        })
        .and_then(|sent| match sent {
            Sent::Done(txid) => Ok(txid),
            Sent::Unanswered(txid, why) => Err(WalletError::Unknown(format!("broadcast of {txid} got no answer: {why}"))),
        })
    }

    /// Sends a recorded transaction again. Harmless when it's already in the mempool or mined.
    fn rebroadcast(&mut self, txid: &str) {
        let Some(id) = zcash_protocol::TxId::from_hex(txid) else { return };
        let Ok(Some(tx)) = self.db.get_transaction(id) else { return };
        let mut raw = service::RawTransaction::default();
        if tx.write(&mut raw.data).is_err() {
            return;
        }
        let handle = tokio::runtime::Handle::current();
        let client = &mut self.client;
        match tokio::task::block_in_place(|| handle.block_on(client.send_transaction(raw))) {
            Ok(r) if r.get_ref().error_code != 0 => {
                tracing::info!(txid, code = r.get_ref().error_code, "rebroadcast: {}", r.get_ref().error_message)
            }
            Err(e) => tracing::warn!(txid, "rebroadcast failed: {}", e.message()),
            Ok(_) => {}
        }
    }
}

enum Sent {
    Done(String),
    Unanswered(String, String),
}

fn db_err(e: zcash_client_sqlite::error::SqliteClientError) -> WalletError {
    WalletError::Internal(anyhow!("wallet db: {e}"))
}

fn proposal_err(message: String) -> WalletError {
    let lower = message.to_lowercase();
    if lower.contains("insufficient") {
        WalletError::Insufficient(message)
    } else if lower.contains("must scan blocks") {
        WalletError::NotSynced
    } else {
        WalletError::Internal(anyhow!(message))
    }
}
