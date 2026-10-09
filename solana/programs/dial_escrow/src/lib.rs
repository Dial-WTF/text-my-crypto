//! Escrow for Dial payments to phone numbers that are not on Dial yet.
//!
//! The sender's USDC sits in a vault owned by this program, keyed by the payment's intent id. It leaves
//! in one of two ways:
//! - `claim`: the recipient proved they hold the phone (the texted code), and the operator's attestor key
//!   signs the payout to the recipient's token account. Only before expiry.
//! - `refund`: after expiry, anyone can crank it, and the money can only go back to the sender.
//!
//! What the operator is trusted with shrinks to one thing: its attestor key says who proved the phone
//! before expiry. It can't hold the money past expiry, and it can't stop the refund.

use anchor_lang::prelude::*;
use anchor_spl::associated_token::get_associated_token_address;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, TransferChecked};

declare_id!("4YiZvobJvYBVrqcT6Lzs8y87iNagzuhu7NWu1zu1vxi3");

pub const ESCROW_SEED: &[u8] = b"escrow";
pub const VAULT_SEED: &[u8] = b"vault";

#[program]
pub mod dial_escrow {
    use super::*;

    /// Moves `amount` from the sender into a fresh vault for this intent. The payer covers rent for the
    /// escrow and vault accounts and gets it back when the escrow closes.
    pub fn create_escrow(ctx: Context<CreateEscrow>, intent_id_hash: [u8; 32], amount: u64, expires_at: i64) -> Result<()> {
        require!(amount > 0, EscrowError::ZeroAmount);
        let now = Clock::get()?.unix_timestamp;
        require!(expires_at > now, EscrowError::ExpiryInPast);

        ctx.accounts.escrow.set_inner(Escrow {
            intent_id_hash,
            sender: ctx.accounts.sender.key(),
            payer: ctx.accounts.payer.key(),
            attestor: ctx.accounts.attestor.key(),
            mint: ctx.accounts.mint.key(),
            amount,
            created_at: now,
            expires_at,
            bump: ctx.bumps.escrow,
            vault_bump: ctx.bumps.vault,
        });

        token::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.sender_token.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.sender.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;

        emit!(EscrowCreated {
            intent_id_hash,
            escrow: ctx.accounts.escrow.key(),
            sender: ctx.accounts.sender.key(),
            attestor: ctx.accounts.attestor.key(),
            mint: ctx.accounts.mint.key(),
            amount,
            expires_at,
        });
        Ok(())
    }

    /// Pays the vault to `recipient`'s token account and closes it. Needs the attestor's signature, which
    /// the operator gives once the recipient proves their phone. Only before expiry.
    pub fn claim(ctx: Context<Claim>, recipient: Pubkey) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(now < ctx.accounts.escrow.expires_at, EscrowError::Expired);
        let amount = pay_out_and_close(
            &ctx.accounts.escrow,
            &ctx.accounts.vault,
            &ctx.accounts.recipient_token,
            &ctx.accounts.mint,
            &ctx.accounts.payer,
            &ctx.accounts.token_program,
        )?;
        emit!(EscrowClaimed {
            intent_id_hash: ctx.accounts.escrow.intent_id_hash,
            escrow: ctx.accounts.escrow.key(),
            recipient,
            amount,
        });
        Ok(())
    }

    /// Sends the vault back to the sender after expiry. Anyone can call it; nobody needs Dial.
    pub fn refund(ctx: Context<Refund>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(now >= ctx.accounts.escrow.expires_at, EscrowError::NotExpired);
        let amount = pay_out_and_close(
            &ctx.accounts.escrow,
            &ctx.accounts.vault,
            &ctx.accounts.sender_token,
            &ctx.accounts.mint,
            &ctx.accounts.payer,
            &ctx.accounts.token_program,
        )?;
        emit!(EscrowRefunded {
            intent_id_hash: ctx.accounts.escrow.intent_id_hash,
            escrow: ctx.accounts.escrow.key(),
            sender: ctx.accounts.escrow.sender,
            amount,
        });
        Ok(())
    }
}

/// Moves the vault's whole balance to `to` and closes the vault, rent to the payer. The whole balance,
/// not `escrow.amount`: tokens someone sends to the vault on top must not block it from closing.
fn pay_out_and_close<'info>(
    escrow: &Account<'info, Escrow>,
    vault: &Account<'info, TokenAccount>,
    to: &Account<'info, TokenAccount>,
    mint: &Account<'info, Mint>,
    payer: &SystemAccount<'info>,
    token_program: &Program<'info, Token>,
) -> Result<u64> {
    let seeds: &[&[u8]] = &[ESCROW_SEED, escrow.intent_id_hash.as_ref(), &[escrow.bump]];
    let signer = &[seeds];
    let amount = vault.amount;
    token::transfer_checked(
        CpiContext::new_with_signer(
            token_program.to_account_info(),
            TransferChecked {
                from: vault.to_account_info(),
                mint: mint.to_account_info(),
                to: to.to_account_info(),
                authority: escrow.to_account_info(),
            },
            signer,
        ),
        amount,
        mint.decimals,
    )?;
    token::close_account(CpiContext::new_with_signer(
        token_program.to_account_info(),
        CloseAccount {
            account: vault.to_account_info(),
            destination: payer.to_account_info(),
            authority: escrow.to_account_info(),
        },
        signer,
    ))?;
    Ok(amount)
}

#[derive(Accounts)]
#[instruction(intent_id_hash: [u8; 32])]
pub struct CreateEscrow<'info> {
    /// Pays rent and fees (the operator's treasury). Gets the rent back when the escrow closes.
    #[account(mut)]
    pub payer: Signer<'info>,
    pub sender: Signer<'info>,
    #[account(mut, token::mint = mint, token::authority = sender)]
    pub sender_token: Account<'info, TokenAccount>,
    pub mint: Account<'info, Mint>,
    /// CHECK: only recorded. Claims must be signed by this key.
    pub attestor: UncheckedAccount<'info>,
    #[account(
        init,
        payer = payer,
        space = 8 + Escrow::INIT_SPACE,
        seeds = [ESCROW_SEED, intent_id_hash.as_ref()],
        bump,
    )]
    pub escrow: Account<'info, Escrow>,
    #[account(
        init,
        payer = payer,
        seeds = [VAULT_SEED, escrow.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = escrow,
    )]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(recipient: Pubkey)]
pub struct Claim<'info> {
    pub attestor: Signer<'info>,
    #[account(
        mut,
        seeds = [ESCROW_SEED, escrow.intent_id_hash.as_ref()],
        bump = escrow.bump,
        has_one = attestor @ EscrowError::WrongAttestor,
        has_one = payer,
        has_one = mint,
        close = payer,
    )]
    pub escrow: Account<'info, Escrow>,
    #[account(mut, seeds = [VAULT_SEED, escrow.key().as_ref()], bump = escrow.vault_bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        address = get_associated_token_address(&recipient, &mint.key()) @ EscrowError::NotAssociatedTokenAccount,
        token::mint = mint,
        token::authority = recipient,
    )]
    pub recipient_token: Account<'info, TokenAccount>,
    pub mint: Account<'info, Mint>,
    #[account(mut)]
    pub payer: SystemAccount<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Refund<'info> {
    #[account(
        mut,
        seeds = [ESCROW_SEED, escrow.intent_id_hash.as_ref()],
        bump = escrow.bump,
        has_one = sender,
        has_one = payer,
        has_one = mint,
        close = payer,
    )]
    pub escrow: Account<'info, Escrow>,
    #[account(mut, seeds = [VAULT_SEED, escrow.key().as_ref()], bump = escrow.vault_bump)]
    pub vault: Account<'info, TokenAccount>,
    /// CHECK: checked against `escrow.sender`.
    pub sender: UncheckedAccount<'info>,
    #[account(
        mut,
        address = get_associated_token_address(&sender.key(), &mint.key()) @ EscrowError::NotAssociatedTokenAccount,
        token::mint = mint,
        token::authority = sender,
    )]
    pub sender_token: Account<'info, TokenAccount>,
    pub mint: Account<'info, Mint>,
    #[account(mut)]
    pub payer: SystemAccount<'info>,
    pub token_program: Program<'info, Token>,
}

#[account]
#[derive(InitSpace)]
pub struct Escrow {
    /// SHA-256 of the Dial intent id, e.g. sha256("pi_…"). Matches the escrow to the ledger row.
    pub intent_id_hash: [u8; 32],
    pub sender: Pubkey,
    /// Paid the rent; gets it back on claim or refund.
    pub payer: Pubkey,
    /// The operator key whose signature releases the escrow to a recipient.
    pub attestor: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub created_at: i64,
    pub expires_at: i64,
    pub bump: u8,
    pub vault_bump: u8,
}

#[event]
pub struct EscrowCreated {
    pub intent_id_hash: [u8; 32],
    pub escrow: Pubkey,
    pub sender: Pubkey,
    pub attestor: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub expires_at: i64,
}

#[event]
pub struct EscrowClaimed {
    pub intent_id_hash: [u8; 32],
    pub escrow: Pubkey,
    pub recipient: Pubkey,
    pub amount: u64,
}

#[event]
pub struct EscrowRefunded {
    pub intent_id_hash: [u8; 32],
    pub escrow: Pubkey,
    pub sender: Pubkey,
    pub amount: u64,
}

#[error_code]
pub enum EscrowError {
    #[msg("Amount must be more than zero")]
    ZeroAmount,
    #[msg("Expiry must be in the future")]
    ExpiryInPast,
    #[msg("This escrow has expired; it can only be refunded")]
    Expired,
    #[msg("This escrow has not expired yet")]
    NotExpired,
    #[msg("Claims must be signed by the escrow's attestor")]
    WrongAttestor,
    #[msg("Payouts go to the owner's associated token account")]
    NotAssociatedTokenAccount,
}
