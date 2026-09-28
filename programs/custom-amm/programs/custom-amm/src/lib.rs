use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Burn, Mint as ClassicMint, MintTo, Token, TokenAccount as ClassicTokenAccount},
    token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked},
};

declare_id!("HwtbuEdcs3i8Y1pugfH8MTvzxvqwUUYNjE96QW5NFy3j");

const AUTHORITY_SEED: &[u8] = b"authority";
const LP_SEED: &[u8] = b"lp";
const MINIMUM_LIQUIDITY: u64 = 1_000;

#[program]
pub mod custom_amm {
    use super::*;

    pub fn initialize_pool(ctx: Context<InitializePool>, fee_bps: u16) -> Result<()> {
        require!(fee_bps <= 1_000, AmmError::InvalidFee);
        require!(
            ctx.accounts.mint_a.key().to_bytes() < ctx.accounts.mint_b.key().to_bytes(),
            AmmError::MintOrder
        );
        ctx.accounts.pool.set_inner(Pool {
            initializer: ctx.accounts.initializer.key(),
            mint_a: ctx.accounts.mint_a.key(),
            mint_b: ctx.accounts.mint_b.key(),
            token_program_a: ctx.accounts.token_program_a.key(),
            token_program_b: ctx.accounts.token_program_b.key(),
            lp_mint: ctx.accounts.lp_mint.key(),
            fee_bps,
            authority_bump: ctx.bumps.pool_authority,
        });
        Ok(())
    }

    pub fn add_liquidity(
        ctx: Context<AddLiquidity>,
        max_a: u64,
        max_b: u64,
        min_lp_out: u64,
    ) -> Result<()> {
        require!(max_a > 0 && max_b > 0, AmmError::ZeroAmount);
        let reserve_a = ctx.accounts.vault_a.amount;
        let reserve_b = ctx.accounts.vault_b.amount;
        let first_deposit = reserve_a == 0 && reserve_b == 0;
        require!(
            (reserve_a == 0) == (reserve_b == 0),
            AmmError::InvalidReserves
        );
        if first_deposit {
            require_keys_eq!(
                ctx.accounts.provider.key(),
                ctx.accounts.pool.initializer,
                AmmError::InitializerOnly
            );
        }

        // Later deposits consume only the largest proportional pair covered by
        // the caller's maxima. This prevents an imbalanced deposit becoming an
        // accidental donation to existing LPs.
        let (deposit_a, deposit_b) = if first_deposit {
            (max_a, max_b)
        } else if (max_a as u128)
            .checked_mul(reserve_b as u128)
            .ok_or(AmmError::MathOverflow)?
            <= (max_b as u128)
                .checked_mul(reserve_a as u128)
                .ok_or(AmmError::MathOverflow)?
        {
            (max_a, mul_div(max_a, reserve_b, reserve_a)?)
        } else {
            (mul_div(max_b, reserve_a, reserve_b)?, max_b)
        };
        require!(deposit_a > 0 && deposit_b > 0, AmmError::DepositTooSmall);

        transfer_in(
            &ctx.accounts.provider,
            &ctx.accounts.provider_a,
            &ctx.accounts.vault_a,
            &ctx.accounts.mint_a,
            &ctx.accounts.token_program_a,
            deposit_a,
        )?;
        transfer_in(
            &ctx.accounts.provider,
            &ctx.accounts.provider_b,
            &ctx.accounts.vault_b,
            &ctx.accounts.mint_b,
            &ctx.accounts.token_program_b,
            deposit_b,
        )?;
        ctx.accounts.vault_a.reload()?;
        ctx.accounts.vault_b.reload()?;
        let received_a = ctx
            .accounts
            .vault_a
            .amount
            .checked_sub(reserve_a)
            .ok_or(AmmError::MathOverflow)?;
        let received_b = ctx
            .accounts
            .vault_b
            .amount
            .checked_sub(reserve_b)
            .ok_or(AmmError::MathOverflow)?;
        require!(received_a > 0 && received_b > 0, AmmError::ZeroAmount);

        let lp_out = if first_deposit {
            integer_sqrt(
                (received_a as u128)
                    .checked_mul(received_b as u128)
                    .ok_or(AmmError::MathOverflow)?,
            )
            .checked_sub(MINIMUM_LIQUIDITY)
            .ok_or(AmmError::DepositTooSmall)?
        } else {
            let total_liquidity = ctx
                .accounts
                .lp_mint
                .supply
                .checked_add(MINIMUM_LIQUIDITY)
                .ok_or(AmmError::MathOverflow)?;
            let by_a = mul_div(received_a, total_liquidity, reserve_a)?;
            let by_b = mul_div(received_b, total_liquidity, reserve_b)?;
            by_a.min(by_b)
        };
        require!(
            lp_out >= min_lp_out && lp_out > 0,
            AmmError::LiquidityTooSmall
        );

        let pool_key = ctx.accounts.pool.key();
        let bump = [ctx.accounts.pool.authority_bump];
        let seeds: &[&[u8]] = &[AUTHORITY_SEED, pool_key.as_ref(), &bump];
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                MintTo {
                    mint: ctx.accounts.lp_mint.to_account_info(),
                    to: ctx.accounts.provider_lp.to_account_info(),
                    authority: ctx.accounts.pool_authority.to_account_info(),
                },
                &[seeds],
            ),
            lp_out,
        )?;
        emit!(LiquidityAdded {
            provider: ctx.accounts.provider.key(),
            amount_a: received_a,
            amount_b: received_b,
            lp_out
        });
        Ok(())
    }

    pub fn remove_liquidity(
        ctx: Context<RemoveLiquidity>,
        lp_amount: u64,
        min_a_out: u64,
        min_b_out: u64,
    ) -> Result<()> {
        require!(lp_amount > 0, AmmError::ZeroAmount);
        let total = ctx
            .accounts
            .lp_mint
            .supply
            .checked_add(MINIMUM_LIQUIDITY)
            .ok_or(AmmError::MathOverflow)?;
        let amount_a = mul_div(lp_amount, ctx.accounts.vault_a.amount, total)?;
        let amount_b = mul_div(lp_amount, ctx.accounts.vault_b.amount, total)?;
        require!(
            amount_a >= min_a_out && amount_b >= min_b_out,
            AmmError::OutputTooSmall
        );

        token::burn(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                Burn {
                    mint: ctx.accounts.lp_mint.to_account_info(),
                    from: ctx.accounts.provider_lp.to_account_info(),
                    authority: ctx.accounts.provider.to_account_info(),
                },
            ),
            lp_amount,
        )?;
        transfer_out(
            &ctx.accounts.pool,
            &ctx.accounts.pool_authority,
            &ctx.accounts.vault_a,
            &ctx.accounts.provider_a,
            &ctx.accounts.mint_a,
            &ctx.accounts.token_program_a,
            amount_a,
        )?;
        transfer_out(
            &ctx.accounts.pool,
            &ctx.accounts.pool_authority,
            &ctx.accounts.vault_b,
            &ctx.accounts.provider_b,
            &ctx.accounts.mint_b,
            &ctx.accounts.token_program_b,
            amount_b,
        )?;
        emit!(LiquidityRemoved {
            provider: ctx.accounts.provider.key(),
            amount_a,
            amount_b,
            lp_amount
        });
        Ok(())
    }

    pub fn swap_exact_in(
        ctx: Context<SwapExactIn>,
        a_to_b: bool,
        amount_in: u64,
        min_amount_out: u64,
    ) -> Result<()> {
        require!(amount_in > 0, AmmError::ZeroAmount);
        let reserve_a = ctx.accounts.vault_a.amount;
        let reserve_b = ctx.accounts.vault_b.amount;
        require!(reserve_a > 0 && reserve_b > 0, AmmError::InvalidReserves);
        let user_output_before = if a_to_b {
            ctx.accounts.trader_b.amount
        } else {
            ctx.accounts.trader_a.amount
        };
        if a_to_b {
            transfer_in(
                &ctx.accounts.trader,
                &ctx.accounts.trader_a,
                &ctx.accounts.vault_a,
                &ctx.accounts.mint_a,
                &ctx.accounts.token_program_a,
                amount_in,
            )?;
            ctx.accounts.vault_a.reload()?;
        } else {
            transfer_in(
                &ctx.accounts.trader,
                &ctx.accounts.trader_b,
                &ctx.accounts.vault_b,
                &ctx.accounts.mint_b,
                &ctx.accounts.token_program_b,
                amount_in,
            )?;
            ctx.accounts.vault_b.reload()?;
        }
        let actual_in = if a_to_b {
            ctx.accounts
                .vault_a
                .amount
                .checked_sub(reserve_a)
                .ok_or(AmmError::MathOverflow)?
        } else {
            ctx.accounts
                .vault_b
                .amount
                .checked_sub(reserve_b)
                .ok_or(AmmError::MathOverflow)?
        };
        let fee_multiplier = 10_000u64
            .checked_sub(ctx.accounts.pool.fee_bps as u64)
            .ok_or(AmmError::MathOverflow)?;
        let after_fee = mul_div(actual_in, fee_multiplier, 10_000)?;
        let (reserve_in, reserve_out) = if a_to_b {
            (reserve_a, reserve_b)
        } else {
            (reserve_b, reserve_a)
        };
        let amount_out = ((after_fee as u128)
            .checked_mul(reserve_out as u128)
            .ok_or(AmmError::MathOverflow)?
            .checked_div(
                (reserve_in as u128)
                    .checked_add(after_fee as u128)
                    .ok_or(AmmError::MathOverflow)?,
            )
            .ok_or(AmmError::MathOverflow)?) as u64;
        require!(amount_out > 0, AmmError::OutputTooSmall);
        if a_to_b {
            transfer_out(
                &ctx.accounts.pool,
                &ctx.accounts.pool_authority,
                &ctx.accounts.vault_b,
                &ctx.accounts.trader_b,
                &ctx.accounts.mint_b,
                &ctx.accounts.token_program_b,
                amount_out,
            )?;
            ctx.accounts.trader_b.reload()?;
            require!(
                ctx.accounts
                    .trader_b
                    .amount
                    .checked_sub(user_output_before)
                    .ok_or(AmmError::MathOverflow)?
                    >= min_amount_out,
                AmmError::OutputTooSmall
            );
        } else {
            transfer_out(
                &ctx.accounts.pool,
                &ctx.accounts.pool_authority,
                &ctx.accounts.vault_a,
                &ctx.accounts.trader_a,
                &ctx.accounts.mint_a,
                &ctx.accounts.token_program_a,
                amount_out,
            )?;
            ctx.accounts.trader_a.reload()?;
            require!(
                ctx.accounts
                    .trader_a
                    .amount
                    .checked_sub(user_output_before)
                    .ok_or(AmmError::MathOverflow)?
                    >= min_amount_out,
                AmmError::OutputTooSmall
            );
        }
        ctx.accounts.vault_a.reload()?;
        ctx.accounts.vault_b.reload()?;
        let old_k = (reserve_a as u128)
            .checked_mul(reserve_b as u128)
            .ok_or(AmmError::MathOverflow)?;
        let new_k = (ctx.accounts.vault_a.amount as u128)
            .checked_mul(ctx.accounts.vault_b.amount as u128)
            .ok_or(AmmError::MathOverflow)?;
        require!(new_k >= old_k, AmmError::InvariantViolated);
        emit!(SwapExecuted {
            trader: ctx.accounts.trader.key(),
            a_to_b,
            amount_in: actual_in,
            amount_out
        });
        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitializePool<'info> {
    #[account(mut)]
    pub initializer: Signer<'info>,
    #[account(mint::token_program = token_program_a)]
    pub mint_a: InterfaceAccount<'info, Mint>,
    #[account(mint::token_program = token_program_b)]
    pub mint_b: InterfaceAccount<'info, Mint>,
    #[account(init, payer = initializer, space = 8 + Pool::INIT_SPACE, seeds = [b"pool", mint_a.key().as_ref(), mint_b.key().as_ref()], bump)]
    pub pool: Box<Account<'info, Pool>>,
    /// CHECK: PDA signs for pool vaults and the LP mint.
    #[account(seeds = [AUTHORITY_SEED, pool.key().as_ref()], bump)]
    pub pool_authority: UncheckedAccount<'info>,
    #[account(init, payer = initializer, seeds = [LP_SEED, pool.key().as_ref()], bump, mint::decimals = 9, mint::authority = pool_authority)]
    pub lp_mint: Account<'info, ClassicMint>,
    #[account(init, payer = initializer, associated_token::mint = mint_a, associated_token::authority = pool_authority, associated_token::token_program = token_program_a)]
    pub vault_a: InterfaceAccount<'info, TokenAccount>,
    #[account(init, payer = initializer, associated_token::mint = mint_b, associated_token::authority = pool_authority, associated_token::token_program = token_program_b)]
    pub vault_b: InterfaceAccount<'info, TokenAccount>,
    pub token_program_a: Interface<'info, TokenInterface>,
    pub token_program_b: Interface<'info, TokenInterface>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AddLiquidity<'info> {
    #[account(has_one = mint_a, has_one = mint_b, has_one = lp_mint, seeds = [b"pool", mint_a.key().as_ref(), mint_b.key().as_ref()], bump)]
    pub pool: Account<'info, Pool>,
    /// CHECK: Validated PDA.
    #[account(seeds = [AUTHORITY_SEED, pool.key().as_ref()], bump = pool.authority_bump)]
    pub pool_authority: UncheckedAccount<'info>,
    #[account(mut)]
    pub provider: Signer<'info>,
    pub mint_a: Box<InterfaceAccount<'info, Mint>>,
    pub mint_b: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, address = pool.lp_mint)]
    pub lp_mint: Box<Account<'info, ClassicMint>>,
    #[account(mut, associated_token::mint = mint_a, associated_token::authority = pool_authority, associated_token::token_program = token_program_a)]
    pub vault_a: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, associated_token::mint = mint_b, associated_token::authority = pool_authority, associated_token::token_program = token_program_b)]
    pub vault_b: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, associated_token::mint = mint_a, associated_token::authority = provider, associated_token::token_program = token_program_a)]
    pub provider_a: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, associated_token::mint = mint_b, associated_token::authority = provider, associated_token::token_program = token_program_b)]
    pub provider_b: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(init_if_needed, payer = provider, associated_token::mint = lp_mint, associated_token::authority = provider)]
    pub provider_lp: Box<Account<'info, ClassicTokenAccount>>,
    #[account(address = pool.token_program_a)]
    pub token_program_a: Interface<'info, TokenInterface>,
    #[account(address = pool.token_program_b)]
    pub token_program_b: Interface<'info, TokenInterface>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RemoveLiquidity<'info> {
    #[account(has_one = mint_a, has_one = mint_b, has_one = lp_mint, seeds = [b"pool", mint_a.key().as_ref(), mint_b.key().as_ref()], bump)]
    pub pool: Box<Account<'info, Pool>>,
    /// CHECK: Validated PDA.
    #[account(seeds = [AUTHORITY_SEED, pool.key().as_ref()], bump = pool.authority_bump)]
    pub pool_authority: UncheckedAccount<'info>,
    #[account(mut)]
    pub provider: Signer<'info>,
    pub mint_a: Box<InterfaceAccount<'info, Mint>>,
    pub mint_b: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, address = pool.lp_mint)]
    pub lp_mint: Box<Account<'info, ClassicMint>>,
    #[account(mut, associated_token::mint = mint_a, associated_token::authority = pool_authority, associated_token::token_program = token_program_a)]
    pub vault_a: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, associated_token::mint = mint_b, associated_token::authority = pool_authority, associated_token::token_program = token_program_b)]
    pub vault_b: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, associated_token::mint = mint_a, associated_token::authority = provider, associated_token::token_program = token_program_a)]
    pub provider_a: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, associated_token::mint = mint_b, associated_token::authority = provider, associated_token::token_program = token_program_b)]
    pub provider_b: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, associated_token::mint = lp_mint, associated_token::authority = provider)]
    pub provider_lp: Box<Account<'info, ClassicTokenAccount>>,
    #[account(address = pool.token_program_a)]
    pub token_program_a: Interface<'info, TokenInterface>,
    #[account(address = pool.token_program_b)]
    pub token_program_b: Interface<'info, TokenInterface>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct SwapExactIn<'info> {
    #[account(has_one = mint_a, has_one = mint_b, seeds = [b"pool", mint_a.key().as_ref(), mint_b.key().as_ref()], bump)]
    pub pool: Account<'info, Pool>,
    /// CHECK: Validated PDA.
    #[account(seeds = [AUTHORITY_SEED, pool.key().as_ref()], bump = pool.authority_bump)]
    pub pool_authority: UncheckedAccount<'info>,
    #[account(mut)]
    pub trader: Signer<'info>,
    pub mint_a: InterfaceAccount<'info, Mint>,
    pub mint_b: InterfaceAccount<'info, Mint>,
    #[account(mut, associated_token::mint = mint_a, associated_token::authority = pool_authority, associated_token::token_program = token_program_a)]
    pub vault_a: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, associated_token::mint = mint_b, associated_token::authority = pool_authority, associated_token::token_program = token_program_b)]
    pub vault_b: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, associated_token::mint = mint_a, associated_token::authority = trader, associated_token::token_program = token_program_a)]
    pub trader_a: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, associated_token::mint = mint_b, associated_token::authority = trader, associated_token::token_program = token_program_b)]
    pub trader_b: InterfaceAccount<'info, TokenAccount>,
    #[account(address = pool.token_program_a)]
    pub token_program_a: Interface<'info, TokenInterface>,
    #[account(address = pool.token_program_b)]
    pub token_program_b: Interface<'info, TokenInterface>,
}

#[account]
#[derive(InitSpace)]
pub struct Pool {
    pub initializer: Pubkey,
    pub mint_a: Pubkey,
    pub mint_b: Pubkey,
    pub token_program_a: Pubkey,
    pub token_program_b: Pubkey,
    pub lp_mint: Pubkey,
    pub fee_bps: u16,
    pub authority_bump: u8,
}

#[event]
pub struct LiquidityAdded {
    pub provider: Pubkey,
    pub amount_a: u64,
    pub amount_b: u64,
    pub lp_out: u64,
}
#[event]
pub struct LiquidityRemoved {
    pub provider: Pubkey,
    pub amount_a: u64,
    pub amount_b: u64,
    pub lp_amount: u64,
}
#[event]
pub struct SwapExecuted {
    pub trader: Pubkey,
    pub a_to_b: bool,
    pub amount_in: u64,
    pub amount_out: u64,
}

fn transfer_in<'info>(
    authority: &Signer<'info>,
    from: &InterfaceAccount<'info, TokenAccount>,
    to: &InterfaceAccount<'info, TokenAccount>,
    mint: &InterfaceAccount<'info, Mint>,
    program: &Interface<'info, TokenInterface>,
    amount: u64,
) -> Result<()> {
    token_interface::transfer_checked(
        CpiContext::new(
            program.key(),
            TransferChecked {
                from: from.to_account_info(),
                mint: mint.to_account_info(),
                to: to.to_account_info(),
                authority: authority.to_account_info(),
            },
        ),
        amount,
        mint.decimals,
    )
}

fn transfer_out<'info>(
    pool: &Account<'info, Pool>,
    authority: &UncheckedAccount<'info>,
    from: &InterfaceAccount<'info, TokenAccount>,
    to: &InterfaceAccount<'info, TokenAccount>,
    mint: &InterfaceAccount<'info, Mint>,
    program: &Interface<'info, TokenInterface>,
    amount: u64,
) -> Result<()> {
    let pool_key = pool.key();
    let bump = [pool.authority_bump];
    let seeds: &[&[u8]] = &[AUTHORITY_SEED, pool_key.as_ref(), &bump];
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            program.key(),
            TransferChecked {
                from: from.to_account_info(),
                mint: mint.to_account_info(),
                to: to.to_account_info(),
                authority: authority.to_account_info(),
            },
            &[seeds],
        ),
        amount,
        mint.decimals,
    )
}

fn mul_div(a: u64, b: u64, denominator: u64) -> Result<u64> {
    require!(denominator > 0, AmmError::MathOverflow);
    let value = (a as u128)
        .checked_mul(b as u128)
        .ok_or(AmmError::MathOverflow)?
        .checked_div(denominator as u128)
        .ok_or(AmmError::MathOverflow)?;
    u64::try_from(value).map_err(|_| error!(AmmError::MathOverflow))
}

fn integer_sqrt(value: u128) -> u64 {
    value.isqrt().min(u64::MAX as u128) as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn integer_square_root_rounds_down() {
        assert_eq!(integer_sqrt(0), 0);
        assert_eq!(integer_sqrt(15), 3);
        assert_eq!(integer_sqrt(16), 4);
    }

    #[test]
    fn mul_div_uses_wide_intermediate() {
        assert_eq!(mul_div(u64::MAX, 2, 2).unwrap(), u64::MAX);
        assert_eq!(mul_div(5, 3, 2).unwrap(), 7);
    }
}

#[error_code]
pub enum AmmError {
    #[msg("Fee must be at most 10%.")]
    InvalidFee,
    #[msg("Mint addresses must be supplied in canonical byte order.")]
    MintOrder,
    #[msg("Amount must be greater than zero.")]
    ZeroAmount,
    #[msg("Pool reserves are invalid.")]
    InvalidReserves,
    #[msg("Only the initializer can make the first deposit.")]
    InitializerOnly,
    #[msg("The first deposit is too small.")]
    DepositTooSmall,
    #[msg("LP output is below the requested minimum.")]
    LiquidityTooSmall,
    #[msg("Token output is below the requested minimum.")]
    OutputTooSmall,
    #[msg("Arithmetic overflow.")]
    MathOverflow,
    #[msg("Constant-product invariant decreased.")]
    InvariantViolated,
}
