//! Dial's Zcash testnet wallet service. The Worker can't scan the chain or prove transactions,
//! so it calls this over HTTP with a shared bearer token. See README.md for the API.

mod cache;
mod wallet;

use std::{env, num::NonZeroU32, path::PathBuf, sync::Arc, time::Duration};

use anyhow::{Context, anyhow};
use axum::{
    Json, Router,
    extract::{Path, Request, State},
    http::{StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use bip0039::{English, Mnemonic};
use secrecy::SecretVec;
use serde::Deserialize;
use serde_json::json;
use subtle::ConstantTimeEq;
use tokio::sync::Mutex;
use tracing::{info, warn};

use wallet::{Wallet, WalletError};

#[derive(Clone)]
struct App {
    wallet: Arc<Mutex<Wallet>>,
    token: Arc<String>,
}

impl IntoResponse for WalletError {
    fn into_response(self) -> Response {
        let (status, code, message) = match self {
            WalletError::BadRequest(m) => (StatusCode::BAD_REQUEST, "bad_request", m),
            WalletError::NotFound(m) => (StatusCode::NOT_FOUND, "not_found", m),
            WalletError::Insufficient(m) => (StatusCode::CONFLICT, "insufficient_funds", m),
            WalletError::NotSynced => (StatusCode::SERVICE_UNAVAILABLE, "not_synced", "wallet is still syncing".into()),
            WalletError::Upstream(m) => (StatusCode::BAD_GATEWAY, "upstream", m),
            WalletError::Internal(e) => {
                warn!("internal error: {e:#}");
                (StatusCode::INTERNAL_SERVER_ERROR, "internal", format!("{e:#}"))
            }
        };
        (status, Json(json!({ "error": code, "message": message }))).into_response()
    }
}

type Reply = Result<Json<serde_json::Value>, WalletError>;

async fn auth(State(app): State<App>, req: Request, next: Next) -> Response {
    let presented = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("");
    if bool::from(presented.as_bytes().ct_eq(app.token.as_bytes())) {
        next.run(req).await
    } else {
        (StatusCode::UNAUTHORIZED, Json(json!({ "error": "unauthorized" }))).into_response()
    }
}

async fn healthz(State(app): State<App>) -> Reply {
    let w = app.wallet.lock().await;
    let s = w.status()?;
    Ok(Json(json!({ "ok": true, "synced": s.synced })))
}

async fn status(State(app): State<App>) -> Reply {
    let w = app.wallet.lock().await;
    Ok(Json(serde_json::to_value(w.status()?).map_err(|e| WalletError::Internal(e.into()))?))
}

async fn treasury(State(app): State<App>) -> Reply {
    let w = app.wallet.lock().await;
    Ok(Json(json!({ "account": 0, "address": w.address(0)? })))
}

async fn create_account(State(app): State<App>) -> Reply {
    let mut w = app.wallet.lock().await;
    let (account, address) = w.create_account()?;
    info!(account, "created account");
    Ok(Json(json!({ "account": account, "address": address })))
}

#[derive(Deserialize)]
struct Restore {
    accounts: u32,
}

/// Rebuilds accounts 0..n on a fresh disk. Idempotent.
async fn restore(State(app): State<App>, Json(body): Json<Restore>) -> Reply {
    let mut w = app.wallet.lock().await;
    w.ensure_accounts(body.accounts.max(1))?;
    Ok(Json(json!({ "accounts": w.account_count()? })))
}

async fn balance(State(app): State<App>, Path(address): Path<String>) -> Reply {
    let w = app.wallet.lock().await;
    let synced = w.status()?.synced;
    let (account, b) = w.balance(&address)?;
    Ok(Json(json!({ "account": account, "spendable": b.spendable, "total": b.total, "synced": synced })))
}

#[derive(Deserialize)]
struct Send {
    account: u32,
    to: String,
    #[serde(default)]
    zats: u64,
    memo: Option<String>,
    #[serde(default)]
    sweep: bool,
    /// Seconds to wait for received notes to confirm when the account holds enough but can't spend
    /// it yet. Testnet blocks take ~75s.
    #[serde(default)]
    wait: u64,
}

/// Sends, waiting up to `wait` seconds for unconfirmed funds. The wallet lock is released between
/// tries so the sync loop can scan the block that confirms them.
async fn send_waiting(app: &App, body: &Send) -> Result<String, WalletError> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(body.wait.min(240));
    loop {
        let mut w = app.wallet.lock().await;
        match w.send(body.account, &body.to, body.zats, body.memo.as_deref(), body.sweep).await {
            Err(WalletError::Insufficient(m)) => {
                let need = if body.sweep { 1 } else { w.outgoing(&body.to, body.zats)? + wallet::FEE };
                let held = w.account_balance(body.account)?.total;
                if held < need || tokio::time::Instant::now() >= deadline {
                    return Err(WalletError::Insufficient(m));
                }
            }
            other => return other,
        }
        drop(w);
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
}

async fn send(State(app): State<App>, Json(body): Json<Send>) -> Reply {
    if !body.sweep && body.zats == 0 {
        return Err(WalletError::BadRequest("zats must be positive".into()));
    }
    let txid = send_waiting(&app, &body).await?;
    info!(account = body.account, %txid, sweep = body.sweep, "sent");
    Ok(Json(json!({ "txid": txid })))
}

#[derive(Deserialize)]
struct Fund {
    to: String,
    zats: u64,
    memo: Option<String>,
    #[serde(default)]
    wait: u64,
}

/// Pays from the treasury (account 0).
async fn fund(State(app): State<App>, Json(body): Json<Fund>) -> Reply {
    if body.zats == 0 {
        return Err(WalletError::BadRequest("zats must be positive".into()));
    }
    let send = Send { account: 0, to: body.to, zats: body.zats, memo: body.memo, sweep: false, wait: body.wait };
    let txid = send_waiting(&app, &send).await?;
    info!(%txid, zats = body.zats, "funded");
    Ok(Json(json!({ "txid": txid })))
}

fn required(name: &str) -> anyhow::Result<String> {
    env::var(name).ok().filter(|v| !v.is_empty()).ok_or_else(|| anyhow!("{name} is not set"))
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();

    // `zcash-wallet new-seed` prints a fresh 24-word phrase for ZCASH_SEED_PHRASE.
    if env::args().nth(1).as_deref() == Some("new-seed") {
        println!("{}", <Mnemonic<English>>::generate(bip0039::Count::Words24).phrase());
        return Ok(());
    }

    let _ = rustls::crypto::ring::default_provider().install_default();

    let token = required("ZCASH_SERVICE_TOKEN")?;
    if token.len() < 32 {
        return Err(anyhow!("ZCASH_SERVICE_TOKEN must be at least 32 characters"));
    }
    let phrase = required("ZCASH_SEED_PHRASE")?;
    let mnemonic = <Mnemonic<English>>::from_phrase(phrase.trim()).map_err(|e| anyhow!("ZCASH_SEED_PHRASE: {e}"))?;
    let seed = SecretVec::new(mnemonic.to_seed("").to_vec());
    let birthday: u32 = required("ZCASH_BIRTHDAY")?.parse().context("ZCASH_BIRTHDAY must be a block height")?;
    let lightwalletd = env::var("LIGHTWALLETD_URL").unwrap_or_else(|_| "https://testnet.zec.rocks:443".into());
    let data_dir = PathBuf::from(env::var("DATA_DIR").unwrap_or_else(|_| "/data".into()));
    let min_conf: NonZeroU32 = env::var("ZCASH_MIN_CONFIRMATIONS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(NonZeroU32::MIN);
    let port: u16 = env::var("PORT").ok().and_then(|v| v.parse().ok()).unwrap_or(8080);

    let mut w = Wallet::open(&data_dir, &lightwalletd, seed, birthday, min_conf).await?;
    if let Some(n) = env::var("ZCASH_ACCOUNTS").ok().and_then(|v| v.parse().ok()) {
        w.ensure_accounts(n).map_err(|e| anyhow!("{e:?}"))?;
    }
    info!(treasury = %w.address(0).map_err(|e| anyhow!("{e:?}"))?, %lightwalletd, "wallet open");
    let wallet = Arc::new(Mutex::new(w));

    // Keep scanning: blocks arrive every ~75s on testnet.
    let syncer = wallet.clone();
    tokio::spawn(async move {
        loop {
            {
                let mut w = syncer.lock().await;
                if let Err(e) = w.sync().await {
                    warn!("{e:#}");
                }
            }
            tokio::time::sleep(Duration::from_secs(15)).await;
        }
    });

    let app = App { wallet, token: Arc::new(token) };
    let api = Router::new()
        .route("/v1/status", get(status))
        .route("/v1/treasury", get(treasury))
        .route("/v1/accounts", post(create_account))
        .route("/v1/restore", post(restore))
        .route("/v1/balance/{address}", get(balance))
        .route("/v1/send", post(send))
        .route("/v1/fund", post(fund))
        .route_layer(middleware::from_fn_with_state(app.clone(), auth));
    let router = Router::new().route("/healthz", get(healthz)).merge(api).with_state(app);

    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await?;
    info!(port, "listening");
    axum::serve(listener, router)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
