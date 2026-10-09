//! The wallet: one seed, one ZIP 32 account per Dial wallet, scanned together from lightwalletd.

use std::{
    num::{NonZeroU32, NonZeroUsize},
    path::Path,
    str::FromStr,
};

use anyhow::{Context, anyhow};
use rand::rngs::SysRng;
use rand_core::UnwrapErr;
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
use zcash_client_sqlite::{AccountUuid, ReceivedNoteId, wallet::commitment_tree::Error as CommitmentTreeErr, WalletDb, util::SystemClock, wallet::init::init_wallet_db};
use zcash_keys::{
    address::Address,
    keys::{
        ReceiverRequirement::{Omit, Require},
        UnifiedAddressRequest, UnifiedSpendingKey,
    },
};
use zcash_proofs::prover::LocalTxProver;
use zip321::{Payment, TransactionRequest};
use zcash_protocol::{
    ShieldedPool,
    consensus::Network,
    memo::{Memo, MemoBytes},
    value::Zatoshis,
};

use crate::cache::MemCache;

/// Testnet only. Mainnet would need a real custody review first.
pub const PARAMS: Network = Network::TestNetwork;

/// The ZIP 317 fee for a typical shielded payment (two logical actions). Payments to another
/// account in this wallet carry one of these on top, so the recipient (often an escrow) can
/// move the full amount on later without coming up short for its own fee.
pub const FEE: u64 = 10_000;

type Db = WalletDb<rusqlite::Connection, Network, SystemClock, UnwrapErr<SysRng>>;

pub struct Wallet {
    db: Db,
    client: CompactTxStreamerClient<Channel>,
    cache: MemCache,
    seed: SecretVec<u8>,
    birthday: AccountBirthday,
    confirmations: ConfirmationsPolicy,
    prover: LocalTxProver,
}

#[derive(Debug)]
pub enum WalletError {
    BadRequest(String),
    NotFound(String),
    Insufficient(String),
    NotSynced,
    Upstream(String),
    Internal(anyhow::Error),
}

impl From<anyhow::Error> for WalletError {
    fn from(e: anyhow::Error) -> Self {
        WalletError::Internal(e)
    }
}

pub type Result<T> = std::result::Result<T, WalletError>;

#[derive(serde::Serialize)]
pub struct Balance {
    /// Can be spent now.
    pub spendable: u64,
    /// Everything the account holds, including notes still waiting for confirmations.
    pub total: u64,
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
        .connect_timeout(std::time::Duration::from_secs(15))
        .timeout(std::time::Duration::from_secs(60))
        .connect()
        .await
        .with_context(|| format!("connecting to lightwalletd at {url}"))?;
    Ok(CompactTxStreamerClient::new(channel).max_decoding_message_size(32 * 1024 * 1024))
}

impl Wallet {
    pub async fn open(
        data_dir: &Path,
        lightwalletd: &str,
        seed: SecretVec<u8>,
        birthday_height: u32,
        min_confirmations: NonZeroU32,
    ) -> anyhow::Result<Self> {
        std::fs::create_dir_all(data_dir)?;
        let mut db = WalletDb::for_path(data_dir.join("wallet.sqlite"), PARAMS, SystemClock, UnwrapErr(SysRng))?;
        init_wallet_db(&mut db, Some(SecretVec::new(seed.expose_secret().clone())))
            .map_err(|e| anyhow!("wallet db migration failed: {e}"))?;

        let mut client = connect(lightwalletd).await?;
        let info = client.get_lightd_info(service::Empty {}).await?.into_inner();
        if info.chain_name != "test" {
            return Err(anyhow!("{lightwalletd} serves chain {:?}, expected testnet", info.chain_name));
        }
        // An account's birthday is the chain state as of the block before it.
        let treestate = client
            .get_tree_state(service::BlockId { height: u64::from(birthday_height) - 1, hash: vec![] })
            .await?
            .into_inner();
        let birthday = AccountBirthday::from_treestate(treestate, None).map_err(|e| anyhow!("birthday: {e:?}"))?;

        let mut wallet = Wallet {
            db,
            client,
            cache: MemCache::default(),
            seed,
            birthday,
            confirmations: ConfirmationsPolicy::new_symmetrical(min_confirmations),
            prover: LocalTxProver::bundled(),
        };
        wallet.ensure_accounts(1).map_err(|e| anyhow!("{e:?}"))?; // account 0 is the treasury
        Ok(wallet)
    }

    fn usk(&self, index: u32) -> Result<UnifiedSpendingKey> {
        let account = zip32::AccountId::try_from(index).map_err(|_| WalletError::BadRequest("bad account index".into()))?;
        UnifiedSpendingKey::from_seed(&PARAMS, self.seed.expose_secret(), account)
            .map_err(|e| WalletError::Internal(anyhow!("key derivation: {e:?}")))
    }

    /// The account's address: Orchard and Sapling receivers at the first diversifier index valid for
    /// both, so Sapling-only wallets can pay it too. Deterministic,
    /// so a wallet rebuilt from the seed hands out the same addresses.
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

    /// Makes sure accounts 0..count exist. Every account shares the service birthday, so a wallet
    /// rebuilt on a fresh disk only needs the count.
    pub fn ensure_accounts(&mut self, count: u32) -> Result<()> {
        let have: Vec<u32> = self.accounts()?.into_iter().map(|(i, _)| i).collect();
        for index in 0..count {
            if have.contains(&index) {
                continue;
            }
            let account = zip32::AccountId::try_from(index).map_err(|_| WalletError::BadRequest("bad account index".into()))?;
            let seed = SecretVec::new(self.seed.expose_secret().clone());
            self.db
                .import_account_hd(&format!("dial-{index}"), &seed, account, &self.birthday, None)
                .map_err(db_err)?;
        }
        Ok(())
    }

    pub fn account_count(&self) -> Result<u32> {
        Ok(self.accounts()?.last().map_or(0, |(i, _)| i + 1))
    }

    pub fn create_account(&mut self) -> Result<(u32, String)> {
        let index = self.account_count()?;
        self.ensure_accounts(index + 1)?;
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

    pub fn balance(&self, address: &str) -> Result<(u32, Balance)> {
        let index = self
            .owner(address)?
            .ok_or_else(|| WalletError::NotFound("address does not belong to this wallet".into()))?;
        Ok((index, self.account_balance(index)?))
    }

    pub fn account_balance(&self, index: u32) -> Result<Balance> {
        let id = self.account_id(index)?;
        let summary = self.db.get_wallet_summary(self.confirmations).map_err(db_err)?.ok_or(WalletError::NotSynced)?;
        Ok(summary.account_balances().get(&id).map_or(
            Balance { spendable: 0, total: 0 },
            |b| Balance { spendable: b.spendable_value().into_u64(), total: b.total().into_u64() },
        ))
    }

    /// What a send of `zats` to `to` actually puts on the wire: plus one fee when the recipient is
    /// another account in this wallet.
    pub fn outgoing(&self, to: &str, zats: u64) -> Result<u64> {
        Ok(if self.owner(to)?.is_some() { zats + FEE } else { zats })
    }

    /// Sends from account `index`. `sweep` sends everything spendable (minus the fee) and ignores `zats`.
    pub async fn send(&mut self, index: u32, to: &str, zats: u64, memo: Option<&str>, sweep: bool) -> Result<String> {
        let zats = if sweep { 0 } else { self.outgoing(to, zats)? };
        let account = self.account_id(index)?;
        let recipient = Address::decode(&PARAMS, to).ok_or_else(|| WalletError::BadRequest("not a Zcash testnet address".into()))?;
        if matches!(recipient, Address::Transparent(_) | Address::Tex(_)) {
            return Err(WalletError::BadRequest("send to a shielded address (unified or Sapling)".into()));
        }
        let memo = memo
            .map(|m| Memo::from_str(m).map(|m| MemoBytes::from(&m)))
            .transpose()
            .map_err(|_| WalletError::BadRequest("memo is longer than 512 bytes".into()))?;

        let txid = {
            let usk = self.usk(index)?;
            let txids = if sweep {
                let proposal = propose_send_max_transfer::<_, _, _, CommitmentTreeErr>(
                    &mut self.db,
                    &PARAMS,
                    account,
                    &[ShieldedPool::Sapling, ShieldedPool::Orchard, ShieldedPool::Ironwood],
                    &StandardFeeRule::Zip317,
                    ZcashAddress::from_str(to).map_err(|_| WalletError::BadRequest("bad address".into()))?,
                    memo,
                    MaxSpendMode::MaxSpendable,
                    self.confirmations,
                    &LockedInputPolicy::Exclude,
                    None,
                )
                .map_err(|e| proposal_err(e.to_string()))?;
                self.build(&usk, &proposal)?
            } else {
                let amount = Zatoshis::from_u64(zats).map_err(|_| WalletError::BadRequest("bad amount".into()))?;
                let payment = Payment::new(
                    ZcashAddress::from_str(to).map_err(|_| WalletError::BadRequest("bad address".into()))?,
                    Some(amount),
                    memo,
                    None,
                    None,
                    vec![],
                )
                .map_err(|e| WalletError::BadRequest(format!("payment: {e:?}")))?;
                let request = TransactionRequest::new(vec![payment]).map_err(|e| WalletError::BadRequest(format!("{e:?}")))?;
                // The treasury keeps its change in several notes: change waits a block before it can be
                // spent, and one note would make back-to-back signups queue behind each other.
                let split = if index == 0 {
                    SplitPolicy::with_min_output_value(NonZeroUsize::new(8).expect("nonzero"), Zatoshis::const_from_u64(2_000_000))
                } else {
                    SplitPolicy::single_output()
                };
                let change = MultiOutputChangeStrategy::new(
                    StandardFeeRule::Zip317,
                    None,
                    ShieldedPool::Ironwood,
                    DustOutputPolicy::default(),
                    split,
                );
                let proposal = propose_transfer::<_, _, _, _, CommitmentTreeErr>(
                    &mut self.db,
                    &PARAMS,
                    account,
                    &GreedyInputSelector::new(),
                    &change,
                    request,
                    self.confirmations,
                    &SpendPolicy::default(),
                    None,
                    None,
                )
                .map_err(|e| proposal_err(e.to_string()))?;
                self.build(&usk, &proposal)?
            };
            if txids.len() > 1 {
                return Err(WalletError::Internal(anyhow!("multi-transaction proposals are not supported")));
            }
            *txids.first()
        };

        let tx = self
            .db
            .get_transaction(txid)
            .map_err(db_err)?
            .ok_or_else(|| WalletError::Internal(anyhow!("built transaction {txid} is missing")))?;
        let mut raw = service::RawTransaction::default();
        tx.write(&mut raw.data).map_err(|e| WalletError::Internal(e.into()))?;
        let response = self
            .client
            .send_transaction(raw)
            .await
            .map_err(|e| WalletError::Upstream(format!("lightwalletd: {}", e.message())))?
            .into_inner();
        if response.error_code != 0 {
            return Err(WalletError::Upstream(format!("rejected ({}): {}", response.error_code, response.error_message)));
        }
        Ok(tx.txid().to_string())
    }

    fn build(
        &mut self,
        usk: &UnifiedSpendingKey,
        proposal: &zcash_client_backend::proposal::Proposal<StandardFeeRule, ReceivedNoteId>,
    ) -> Result<nonempty::NonEmpty<zcash_protocol::TxId>> {
        let mut rng = UnwrapErr(SysRng);
        create_proposed_transactions::<_, _, std::convert::Infallible, _, std::convert::Infallible, _>(
            &mut self.db,
            &PARAMS,
            &SystemClock,
            &mut rng,
            &self.prover,
            &self.prover,
            &SpendingKeys::from_unified_spending_key(usk.clone()),
            OvkPolicy::Sender,
            proposal,
            None,
        )
        .map_err(|e| proposal_err(e.to_string()))
    }

    /// Scans up to the chain tip.
    pub async fn sync(&mut self) -> anyhow::Result<()> {
        sync::run(&mut self.client, &PARAMS, &self.cache, &mut self.db, 1000)
            .await
            .map_err(|e| anyhow!("sync: {e}"))
    }
}

fn db_err(e: zcash_client_sqlite::error::SqliteClientError) -> WalletError {
    WalletError::Internal(anyhow!("wallet db: {e}"))
}

fn proposal_err(message: String) -> WalletError {
    if message.to_lowercase().contains("insufficient") {
        WalletError::Insufficient(message)
    } else {
        WalletError::Internal(anyhow!(message))
    }
}
