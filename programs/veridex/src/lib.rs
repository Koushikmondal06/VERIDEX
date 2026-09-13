use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use std::f64::consts::E;

declare_id!("6cD9BZG2bddZZ1xoNReLVEvdYVaxpxY97F7MfZyov7XW");

pub const SHARE_DECIMALS: u8 = 6;

pub const LMSR_B_DEFAULT: u64 = 1_000_000;

#[program]
pub mod veridex {
    use super::*;

/// Initialize global config (indexer authority + oracle).
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.oracle = ctx.accounts.oracle.key();
        config.usdc_mint = ctx.accounts.usdc_mint.key();
        config.bump = ctx.bumps.config;
        Ok(())
    }

    /// Create a binary market mirrored from Polymarket (stub 50/50 pricing).
    pub fn create_market(
        ctx: Context<CreateMarket>,
        polymarket_id: String,
        question: String,
        end_ts: i64,
        price_yes_bps: u16,
    ) -> Result<()> {
        require!(polymarket_id.len() <= 64, VeridexError::IdTooLong);
        require!(question.len() <= 200, VeridexError::QuestionTooLong);
        require!(end_ts > Clock::get()?.unix_timestamp, VeridexError::EndTsInPast);
        require!(price_yes_bps > 0 && price_yes_bps < 10_000, VeridexError::InvalidPrice);

        let market = &mut ctx.accounts.market;
        market.authority = ctx.accounts.config.authority;
        market.oracle = ctx.accounts.config.oracle;
        market.usdc_mint = ctx.accounts.config.usdc_mint;
        market.polymarket_id = polymarket_id;
        market.question = question;
        market.end_ts = end_ts;
        market.status = MarketStatus::Open;
        market.winning_outcome = None;
        market.price_yes_bps = price_yes_bps;
        market.price_no_bps = 10_000 - price_yes_bps;
        market.yes_supply = 0;
        market.no_supply = 0;
        market.lmsr_b = LMSR_B_DEFAULT;
        market.bump = ctx.bumps.market;
        market.vault_bump = ctx.bumps.vault;

        emit!(MarketCreated {
            market: market.key(),
            polymarket_id: market.polymarket_id.clone(),
            end_ts,
        });

        Ok(())
    }

    /// Buy YES or NO shares using LMSR bonding curve.
    /// cost = b * (e^(shares/B) - 1) approximately, exact via log sum.
    /// `outcome`: 0 = YES, 1 = NO.
    pub fn buy(ctx: Context<Trade>, outcome: u8, share_amount: u64) -> Result<()> {
        require!(share_amount > 0, VeridexError::ZeroAmount);
        let market = &mut ctx.accounts.market;
        require!(market.status == MarketStatus::Open, VeridexError::MarketNotOpen);
        require!(
            Clock::get()?.unix_timestamp < market.end_ts,
            VeridexError::PastEndTs
        );
        require!(outcome <= 1, VeridexError::InvalidOutcome);

        // LMSR: cost = b * (ln(new_yes) + ln(new_no) - ln(old_yes) - ln(old_no))
        // where s+1 smoothing avoids ln(0) for initial shares.
        let b = market.lmsr_b as f64;
        let old_yes = market.yes_supply as f64 + 1.0;
        let old_no = market.no_supply as f64 + 1.0;
        let (new_yes, new_no) = if outcome == 0 {
            (market.yes_supply as f64 + 1.0 + (share_amount as f64), market.no_supply as f64 + 1.0)
        } else {
            (market.yes_supply as f64 + 1.0, market.no_supply as f64 + 1.0 + (share_amount as f64))
        };
        let cost = (b * (new_yes.ln() + new_no.ln() - old_yes - old_no)) as u64;
        require!(cost > 0, VeridexError::ZeroAmount);

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_usdc.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            cost,
        )?;

        let position = &mut ctx.accounts.position;
        if position.owner == Pubkey::default() {
            position.owner = ctx.accounts.user.key();
            position.market = market.key();
            position.bump = ctx.bumps.position;
        }

        match outcome {
            0 => {
                position.yes_shares = position
                    .yes_shares
                    .checked_add(share_amount)
                    .ok_or(VeridexError::MathOverflow)?;
                market.yes_supply = market
                    .yes_supply
                    .checked_add(share_amount)
                    .ok_or(VeridexError::MathOverflow)?;
            }
            1 => {
                position.no_shares = position
                    .no_shares
                    .checked_add(share_amount)
                    .ok_or(VeridexError::MathOverflow)?;
                market.no_supply = market
                    .no_supply
                    .checked_add(share_amount)
                    .ok_or(VeridexError::MathOverflow)?;
            }
            _ => unreachable!(),
        }

        emit!(TradeExecuted {
            market: market.key(),
            user: ctx.accounts.user.key(),
            side: 0, // buy
            outcome,
            shares: share_amount,
            usdc: cost,
        });

        Ok(())
    }

    /// Sell shares back using LMSR bonding curve.
    /// Returns `proceeds` USDC; shares burned, supply decreases.
    /// `outcome`: 0 = YES, 1 = NO.
    pub fn sell(ctx: Context<Trade>, outcome: u8, share_amount: u64) -> Result<()> {
        require!(share_amount > 0, VeridexError::ZeroAmount);
        let market = &mut ctx.accounts.market;
        require!(
            market.status == MarketStatus::Open,
            VeridexError::MarketNotOpen
        );
        require!(
            Clock::get()?.unix_timestamp < market.end_ts,
            VeridexError::PastEndTs
        );
        require!(outcome <= 1, VeridexError::InvalidOutcome);

        // LMSR: selling decreases supply, gets USDC via reverse pricing
        // Use +1 smoothing to avoid ln(0).
        let b = market.lmsr_b as f64;
        let old_yes = market.yes_supply as f64 + 1.0;
        let old_no = market.no_supply as f64 + 1.0;
        let (new_yes, new_no) = if outcome == 0 {
            (market.yes_supply as f64 + 1.0 - (share_amount as f64), market.no_supply as f64 + 1.0)
        } else {
            (market.yes_supply as f64 + 1.0, market.no_supply as f64 + 1.0 - (share_amount as f64))
        };
        let proceeds = (b * (new_yes.ln() + new_no.ln() - old_yes - old_no)) as u64;
        require!(proceeds > 0, VeridexError::ZeroAmount);

        match outcome {
            0 => require!(
                ctx.accounts.position.yes_shares >= share_amount,
                VeridexError::InsufficientShares
            ),
            1 => require!(
                ctx.accounts.position.no_shares >= share_amount,
                VeridexError::InsufficientShares
            ),
            _ => return err!(VeridexError::InvalidOutcome),
        }

        match outcome {
            0 => {
                ctx.accounts.position.yes_shares -= share_amount;
                ctx.accounts.market.yes_supply -= share_amount;
            }
            1 => {
                ctx.accounts.position.no_shares -= share_amount;
                ctx.accounts.market.no_supply -= share_amount;
            }
            _ => unreachable!(),
        }

        let market_key = ctx.accounts.market.key();
        let bump = ctx.accounts.market.bump;
        let polymarket_id = ctx.accounts.market.polymarket_id.clone();
        let signer_seeds: &[&[&[u8]]] = &[&[b"market", polymarket_id.as_bytes(), &[bump]]];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.user_usdc.to_account_info(),
                    authority: ctx.accounts.market.to_account_info(),
                },
                signer_seeds,
            ),
            proceeds,
        )?;

        emit!(TradeExecuted {
            market: market_key,
            user: ctx.accounts.user.key(),
            side: 1, // sell
            outcome,
            shares: share_amount,
            usdc: proceeds,
        });

        Ok(())
    }

    /// Halt trading at/after Polymarket end_date (before resolution is known).
    pub fn freeze(ctx: Context<OracleOnly>) -> Result<()> {
        let market = &mut ctx.accounts.market;
        require!(market.status == MarketStatus::Open, VeridexError::MarketNotOpen);
        require!(
            Clock::get()?.unix_timestamp >= market.end_ts,
            VeridexError::TooEarlyToFreeze
        );
        market.status = MarketStatus::Frozen;
        emit!(MarketFrozen {
            market: market.key(),
        });
        Ok(())
    }

    /// Oracle submits Polymarket resolution. `winning_outcome`: 0 = YES, 1 = NO.
    pub fn resolve(ctx: Context<OracleOnly>, winning_outcome: u8) -> Result<()> {
        require!(winning_outcome <= 1, VeridexError::InvalidOutcome);
        let market = &mut ctx.accounts.market;
        require!(
            market.status == MarketStatus::Frozen || market.status == MarketStatus::Open,
            VeridexError::CannotResolve
        );
        // Auto-freeze if still open past end (oracle may resolve after end without separate freeze)
        if market.status == MarketStatus::Open {
            require!(
                Clock::get()?.unix_timestamp >= market.end_ts,
                VeridexError::TooEarlyToResolve
            );
            market.status = MarketStatus::Frozen;
        }
        market.winning_outcome = Some(winning_outcome);
        market.status = MarketStatus::Resolved;
        emit!(MarketResolved {
            market: market.key(),
            winning_outcome,
        });
        Ok(())
    }

    /// Redeem winning shares 1:1 for USDC; losing shares worthless.
    pub fn redeem(ctx: Context<Redeem>) -> Result<()> {
        require!(
            ctx.accounts.market.status == MarketStatus::Resolved,
            VeridexError::NotResolved
        );
        let winning = ctx
            .accounts
            .market
            .winning_outcome
            .ok_or(VeridexError::NotResolved)?;

        let payout = match winning {
            0 => ctx.accounts.position.yes_shares,
            1 => ctx.accounts.position.no_shares,
            _ => return err!(VeridexError::InvalidOutcome),
        };
        require!(payout > 0, VeridexError::NothingToRedeem);

        ctx.accounts.position.yes_shares = 0;
        ctx.accounts.position.no_shares = 0;

        let market_key = ctx.accounts.market.key();
        let bump = ctx.accounts.market.bump;
        let polymarket_id = ctx.accounts.market.polymarket_id.clone();
        let signer_seeds: &[&[&[u8]]] = &[&[b"market", polymarket_id.as_bytes(), &[bump]]];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.user_usdc.to_account_info(),
                    authority: ctx.accounts.market.to_account_info(),
                },
                signer_seeds,
            ),
            payout,
        )?;

        emit!(Redeemed {
            market: market_key,
            user: ctx.accounts.user.key(),
            usdc: payout,
        });

        Ok(())
    }
}

// ─── Accounts ───────────────────────────────────────────────────────────────

#[account]
pub struct Config {
    pub authority: Pubkey,
    pub oracle: Pubkey,
    pub usdc_mint: Pubkey,
    pub bump: u8,
}

impl Config {
    pub const LEN: usize = 8 + 32 + 32 + 32 + 1;
}

#[account]
pub struct Market {
    pub authority: Pubkey,
    pub oracle: Pubkey,
    pub usdc_mint: Pubkey,
    pub polymarket_id: String,
    pub question: String,
    pub end_ts: i64,
    pub status: MarketStatus,
    pub winning_outcome: Option<u8>,
    pub price_yes_bps: u16,
    pub price_no_bps: u16,
    pub yes_supply: u64,
    pub no_supply: u64,
    pub bump: u8,
    pub vault_bump: u8,
    pub lmsr_b: u64,
}

impl Market {
    // discriminator + fields; strings: 4 + max len
    pub const LEN: usize = 8
        + 32
        + 32
        + 32
        + (4 + 64)
        + (4 + 200)
        + 8
        + 1
        + 2
        + 2
        + 2
        + 8
        + 8
        + 1
        + 1
        + 8; // lmsr_b
}

#[account]
pub struct Position {
    pub market: Pubkey,
    pub owner: Pubkey,
    pub yes_shares: u64,
    pub no_shares: u64,
    pub bump: u8,
}

impl Position {
    pub const LEN: usize = 8 + 32 + 32 + 8 + 8 + 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum MarketStatus {
    Open,
    Frozen,
    Resolved,
}

// ─── Contexts ───────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    /// CHECK: stored as oracle pubkey
    pub oracle: UncheckedAccount<'info>,
    pub usdc_mint: Account<'info, Mint>,
    #[account(
        init,
        payer = authority,
        space = Config::LEN,
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, Config>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(polymarket_id: String)]
pub struct CreateMarket<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        seeds = [b"config"],
        bump = config.bump,
        has_one = authority,
        has_one = usdc_mint
    )]
    pub config: Account<'info, Config>,
    pub usdc_mint: Account<'info, Mint>,
    #[account(
        init,
        payer = authority,
        space = Market::LEN,
        seeds = [b"market", polymarket_id.as_bytes()],
        bump
    )]
    pub market: Account<'info, Market>,
    #[account(
        init,
        payer = authority,
        token::mint = usdc_mint,
        token::authority = market,
        seeds = [b"vault", market.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct Trade<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        mut,
        seeds = [b"market", market.polymarket_id.as_bytes()],
        bump = market.bump
    )]
    pub market: Account<'info, Market>,
    #[account(
        init_if_needed,
        payer = user,
        space = Position::LEN,
        seeds = [b"position", market.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub position: Account<'info, Position>,
    #[account(
        mut,
        seeds = [b"vault", market.key().as_ref()],
        bump = market.vault_bump,
        token::mint = market.usdc_mint,
        token::authority = market
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = user_usdc.mint == market.usdc_mint @ VeridexError::InvalidMint,
        constraint = user_usdc.owner == user.key() @ VeridexError::InvalidOwner
    )]
    pub user_usdc: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct OracleOnly<'info> {
    pub oracle: Signer<'info>,
    #[account(
        mut,
        seeds = [b"market", market.polymarket_id.as_bytes()],
        bump = market.bump,
        has_one = oracle
    )]
    pub market: Account<'info, Market>,
}

#[derive(Accounts)]
pub struct Redeem<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        seeds = [b"market", market.polymarket_id.as_bytes()],
        bump = market.bump
    )]
    pub market: Account<'info, Market>,
    #[account(
        mut,
        seeds = [b"position", market.key().as_ref(), user.key().as_ref()],
        bump = position.bump,
        constraint = position.owner == user.key() @ VeridexError::InvalidOwner,
        constraint = position.market == market.key() @ VeridexError::InvalidOwner
    )]
    pub position: Account<'info, Position>,
    #[account(
        mut,
        seeds = [b"vault", market.key().as_ref()],
        bump = market.vault_bump,
        token::mint = market.usdc_mint,
        token::authority = market
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = user_usdc.mint == market.usdc_mint @ VeridexError::InvalidMint,
        constraint = user_usdc.owner == user.key() @ VeridexError::InvalidOwner
    )]
    pub user_usdc: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

// ─── Events / Errors ────────────────────────────────────────────────────────

#[event]
pub struct MarketCreated {
    pub market: Pubkey,
    pub polymarket_id: String,
    pub end_ts: i64,
}

#[event]
pub struct TradeExecuted {
    pub market: Pubkey,
    pub user: Pubkey,
    pub side: u8,
    pub outcome: u8,
    pub shares: u64,
    pub usdc: u64,
}

#[event]
pub struct MarketFrozen {
    pub market: Pubkey,
}

#[event]
pub struct MarketResolved {
    pub market: Pubkey,
    pub winning_outcome: u8,
}

#[event]
pub struct Redeemed {
    pub market: Pubkey,
    pub user: Pubkey,
    pub usdc: u64,
}

#[error_code]
pub enum VeridexError {
    #[msg("Polymarket id too long")]
    IdTooLong,
    #[msg("Question too long")]
    QuestionTooLong,
    #[msg("End timestamp is in the past")]
    EndTsInPast,
    #[msg("Invalid stub price")]
    InvalidPrice,
    #[msg("Amount must be > 0")]
    ZeroAmount,
    #[msg("Market is not open for trading")]
    MarketNotOpen,
    #[msg("Past market end_ts — trading halted")]
    PastEndTs,
    #[msg("Invalid outcome (use 0=YES, 1=NO)")]
    InvalidOutcome,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Insufficient shares")]
    InsufficientShares,
    #[msg("Too early to freeze (before end_ts)")]
    TooEarlyToFreeze,
    #[msg("Too early to resolve")]
    TooEarlyToResolve,
    #[msg("Cannot resolve market in current status")]
    CannotResolve,
    #[msg("Market not resolved")]
    NotResolved,
    #[msg("Nothing to redeem")]
    NothingToRedeem,
    #[msg("Invalid USDC mint")]
    InvalidMint,
    #[msg("Invalid token account owner")]
    InvalidOwner,
}
