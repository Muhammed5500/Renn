#![no_std]
//! Shadow Ledger - many-to-many, instant agent payments
//!
//! Agents pay each other instantly. Nobody can spend more than they hold in
//! the vault. The whole network settles in one transaction.
//!
//! This contract is the VAULT: it holds the money, nets vouchers that carry
//! two signatures, and updates internal balances. The spendable balance is
//! tracked off chain by the shadow ledger (the operator). The contract rejects
//! any voucher without the operator's acceptance signature, so the ledger
//! cannot be bypassed.
//!
//! The operator CANNOT steal (a voucher needs the payer's signature, a
//! withdrawal the owner's) and CANNOT lock funds (the exit_start escape hatch
//! works without the operator).
//!
//! Plan: `PLAN-golge-defter.md` v3.3 (outside the repo).

use soroban_sdk::{contract, contractimpl, token, Address, Bytes, BytesN, Env, Vec};

mod errors;
mod events;
mod exit;
mod settle;
mod storage;
mod types;
mod voucher;

pub use errors::Error;
pub use types::*;

use storage as st;

#[contract]
pub struct Hub;

#[contractimpl]
impl Hub {
    // ================= setup and registration =================

    pub fn __constructor(
        e: Env,
        token: Address,
        operator: BytesN<32>,
        exit_delay: u32,
    ) -> Result<(), Error> {
        if exit_delay == 0 {
            return Err(Error::BadConfig);
        }
        st::set_config(
            &e,
            &Config {
                token,
                operator,
                exit_delay,
            },
        );
        Ok(())
    }

    /// A participant registers its own voucher signing key.
    ///
    /// `commitment_key` is not a Stellar address, it is a raw 32-byte ed25519
    /// public key. It is a hot key: if stolen, the attacker can spend up to the
    /// spendable balance. Agent and key security is the wallet's job, not this
    /// contract's. There is NO key rotation (NOTES.md).
    ///
    /// Required ONLY for those who will pay. A pure recipient does not join.
    pub fn join(e: Env, who: Address, commitment_key: BytesN<32>) -> Result<(), Error> {
        who.require_auth();
        if st::get_signer(&e, &who).is_some() {
            return Err(Error::AlreadyJoined);
        }
        st::set_signer(&e, &who, &commitment_key);
        events::Joined {
            who,
            key: commitment_key,
        }
        .publish(&e);
        Ok(())
    }

    /// Pulls the token into the contract and raises the internal balance.
    ///
    /// NO JOIN REQUIRED. The vault does not ask where the money comes from;
    /// adding the SPP entry later depends on this (plan section 11, item 2).
    pub fn deposit(e: Env, who: Address, amount: i128) -> Result<(), Error> {
        who.require_auth();
        if amount <= 0 {
            return Err(Error::BadAmount);
        }
        let cfg = st::get_config(&e)?;
        let t = token::TokenClient::new(&e, &cfg.token);
        t.transfer(&who, &e.current_contract_address(), &amount);

        let nb = st::get_balance(&e, &who)
            .checked_add(amount)
            .ok_or(Error::BadAmount)?;
        st::set_balance(&e, &who, nb);
        events::Deposited {
            who,
            amount,
            balance: nb,
        }
        .publish(&e);
        Ok(())
    }

    // ================= settlement (permissionless) =================

    /// One voucher. Permissionless; the caller is only the fee payer.
    /// In escape mode a recipient settles its own accepted voucher this way.
    pub fn settle_one(e: Env, caller: Address, v: Voucher) -> Result<i128, Error> {
        let _ = caller;
        settle::settle_one(&e, &v)
    }

    /// Many-to-many netting. Permissionless.
    /// A stale voucher does not fail the batch, it is skipped. A bad signature
    /// still fails the whole batch.
    pub fn settle_batch(
        e: Env,
        caller: Address,
        vs: Vec<Voucher>,
    ) -> Result<SettleOutcome, Error> {
        let _ = caller;
        settle::settle_batch(&e, &vs)
    }

    // ================= exit and withdrawal =================

    /// Exit announcement. When the ledger sees it, it stops accepting the
    /// payer's vouchers and settles the pending ones. Settlement KEEPS WORKING
    /// during this period.
    pub fn exit_start(e: Env, who: Address) -> Result<(), Error> {
        who.require_auth();
        exit::exit_start(&e, &who)
    }

    /// INSTANT withdrawal approved by the operator. Can be partial. Registered
    /// participants only.
    pub fn withdraw_approved(
        e: Env,
        who: Address,
        amount: i128,
        valid_until: u32,
        op_sig: BytesN<64>,
    ) -> Result<i128, Error> {
        who.require_auth();
        exit::withdraw_approved(&e, &who, amount, valid_until, &op_sig)
    }

    /// Withdrawal without the operator, the whole balance.
    /// Unregistered recipient: immediately. Registered participant:
    /// exit_start + exit_delay.
    pub fn withdraw(e: Env, who: Address) -> Result<i128, Error> {
        who.require_auth();
        exit::withdraw(&e, &who)
    }

    /// PASSIVE RECIPIENT. Permissionless, pushes the money to its owner.
    /// Unregistered recipients only.
    pub fn payout(e: Env, who: Address) -> Result<i128, Error> {
        exit::payout(&e, &who)
    }

    /// Permissionless. Extends the lifetime of a participant's persistent entries.
    pub fn extend_ttl(e: Env, who: Address) {
        st::touch(&e, &who);
    }

    // ================= reads =================

    pub fn config(e: Env) -> Result<Config, Error> {
        st::get_config(&e)
    }

    pub fn balance_of(e: Env, who: Address) -> i128 {
        st::get_balance(&e, &who)
    }

    pub fn paid_between(e: Env, payer: Address, recipient: Address) -> i128 {
        st::get_paid(&e, &payer, &recipient)
    }

    pub fn signer_of(e: Env, who: Address) -> Option<BytesN<32>> {
        st::get_signer(&e, &who)
    }

    /// Whether an exit was announced. When the ledger sees it, it stops
    /// accepting the payer's vouchers.
    pub fn exit_at_of(e: Env, who: Address) -> Option<u32> {
        st::get_exit_at(&e, &who)
    }

    /// The nonce the next withdrawal approval must carry.
    pub fn withdraw_nonce_of(e: Env, who: Address) -> u64 {
        st::get_withdraw_nonce(&e, &who)
    }

    // ================= signed payloads (debugging + SDK) =================
    //
    // The off-chain side (ledger, SDK) MUST produce the same bytes.
    // If a signature does not verify, compare against the raw bytes here first.

    pub fn voucher_preimage(e: Env, payer: Address, recipient: Address, cumulative: i128) -> Bytes {
        voucher::voucher_preimage(&e, &payer, &recipient, cumulative)
    }

    pub fn accept_preimage(e: Env, payer: Address, recipient: Address, cumulative: i128) -> Bytes {
        voucher::accept_preimage(&e, &payer, &recipient, cumulative)
    }

    pub fn withdraw_preimage(
        e: Env,
        who: Address,
        amount: i128,
        nonce: u64,
        valid_until: u32,
    ) -> Bytes {
        voucher::withdraw_preimage(&e, &who, amount, nonce, valid_until)
    }

    pub fn voucher_hash(e: Env, payer: Address, recipient: Address, cumulative: i128) -> BytesN<32> {
        voucher::voucher_hash(&e, &payer, &recipient, cumulative)
    }

    pub fn accept_hash(e: Env, payer: Address, recipient: Address, cumulative: i128) -> BytesN<32> {
        voucher::accept_hash(&e, &payer, &recipient, cumulative)
    }

    pub fn withdraw_hash(
        e: Env,
        who: Address,
        amount: i128,
        nonce: u64,
        valid_until: u32,
    ) -> BytesN<32> {
        voucher::withdraw_hash(&e, &who, amount, nonce, valid_until)
    }

    /// Verifies both signatures of a voucher. PANICS if invalid.
    /// A recipient can simulate this before delivering the service.
    pub fn verify_voucher(e: Env, v: Voucher) -> Result<(), Error> {
        voucher::verify(&e, &v)
    }
}

#[cfg(test)]
mod test;
#[cfg(test)]
mod test_voucher;
#[cfg(test)]
mod test_settle;
#[cfg(test)]
mod test_exit;
