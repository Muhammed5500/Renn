#![no_std]
//! STEP 1 - Test token (SEP-41).
//!
//! We issue our own token because Circle's testnet faucet has no API
//! (reCAPTCHA), so automated tests cannot be set up. With our own token the
//! trustline hassle goes away too.
//!
//! 7 decimals, read from a single constant. Two different constants in two
//! places would make amounts off by a factor of 100.

use soroban_sdk::{contract, contracterror, contractimpl, contracttype, Address, Env, String};

pub const DECIMALS: u32 = 7;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum TokenError {
    InsufficientBalance = 1,
    InsufficientAllowance = 2,
    NegativeAmount = 3,
    BadExpiration = 4,
}

#[contracttype]
pub enum DataKey {
    Balance(Address),
    Allowance(Address, Address),
    Admin,
    Meta,
}

#[contracttype]
#[derive(Clone)]
pub struct AllowanceValue {
    pub amount: i128,
    pub expiration_ledger: u32,
}

#[contracttype]
#[derive(Clone)]
pub struct Meta {
    pub name: String,
    pub symbol: String,
}

fn read_balance(e: &Env, id: &Address) -> i128 {
    e.storage()
        .persistent()
        .get(&DataKey::Balance(id.clone()))
        .unwrap_or(0)
}

fn write_balance(e: &Env, id: &Address, amount: i128) {
    let key = DataKey::Balance(id.clone());
    e.storage().persistent().set(&key, &amount);
    e.storage().persistent().extend_ttl(&key, 100_000, 500_000);
}

fn check_nonneg(amount: i128) -> Result<(), TokenError> {
    if amount < 0 {
        return Err(TokenError::NegativeAmount);
    }
    Ok(())
}

#[contract]
pub struct TestToken;

#[contractimpl]
impl TestToken {
    pub fn __constructor(e: Env, admin: Address, name: String, symbol: String) {
        e.storage().instance().set(&DataKey::Admin, &admin);
        e.storage()
            .instance()
            .set(&DataKey::Meta, &Meta { name, symbol });
    }

    /// Test only.
    pub fn mint(e: Env, to: Address, amount: i128) -> Result<(), TokenError> {
        check_nonneg(amount)?;
        let admin: Address = e.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
        let b = read_balance(&e, &to);
        write_balance(&e, &to, b + amount);
        Ok(())
    }

    pub fn balance(e: Env, id: Address) -> i128 {
        read_balance(&e, &id)
    }

    pub fn transfer(e: Env, from: Address, to: Address, amount: i128) -> Result<(), TokenError> {
        check_nonneg(amount)?;
        from.require_auth();
        Self::do_transfer(&e, &from, &to, amount)
    }

    pub fn transfer_from(
        e: Env,
        spender: Address,
        from: Address,
        to: Address,
        amount: i128,
    ) -> Result<(), TokenError> {
        check_nonneg(amount)?;
        spender.require_auth();
        Self::spend_allowance(&e, &from, &spender, amount)?;
        Self::do_transfer(&e, &from, &to, amount)
    }

    pub fn burn(e: Env, from: Address, amount: i128) -> Result<(), TokenError> {
        check_nonneg(amount)?;
        from.require_auth();
        let b = read_balance(&e, &from);
        if b < amount {
            return Err(TokenError::InsufficientBalance);
        }
        write_balance(&e, &from, b - amount);
        Ok(())
    }

    pub fn burn_from(
        e: Env,
        spender: Address,
        from: Address,
        amount: i128,
    ) -> Result<(), TokenError> {
        check_nonneg(amount)?;
        spender.require_auth();
        Self::spend_allowance(&e, &from, &spender, amount)?;
        let b = read_balance(&e, &from);
        if b < amount {
            return Err(TokenError::InsufficientBalance);
        }
        write_balance(&e, &from, b - amount);
        Ok(())
    }

    pub fn approve(
        e: Env,
        from: Address,
        spender: Address,
        amount: i128,
        expiration_ledger: u32,
    ) -> Result<(), TokenError> {
        check_nonneg(amount)?;
        from.require_auth();
        if amount > 0 && expiration_ledger < e.ledger().sequence() {
            return Err(TokenError::BadExpiration);
        }
        e.storage().temporary().set(
            &DataKey::Allowance(from, spender),
            &AllowanceValue {
                amount,
                expiration_ledger,
            },
        );
        Ok(())
    }

    pub fn allowance(e: Env, from: Address, spender: Address) -> i128 {
        match e
            .storage()
            .temporary()
            .get::<_, AllowanceValue>(&DataKey::Allowance(from, spender))
        {
            Some(a) if a.expiration_ledger >= e.ledger().sequence() => a.amount,
            _ => 0,
        }
    }

    pub fn decimals(_e: Env) -> u32 {
        DECIMALS
    }

    pub fn name(e: Env) -> String {
        let m: Meta = e.storage().instance().get(&DataKey::Meta).unwrap();
        m.name
    }

    pub fn symbol(e: Env) -> String {
        let m: Meta = e.storage().instance().get(&DataKey::Meta).unwrap();
        m.symbol
    }
}

impl TestToken {
    fn do_transfer(e: &Env, from: &Address, to: &Address, amount: i128) -> Result<(), TokenError> {
        let bf = read_balance(e, from);
        if bf < amount {
            return Err(TokenError::InsufficientBalance);
        }
        let bt = read_balance(e, to);
        write_balance(e, from, bf - amount);
        write_balance(e, to, bt + amount);
        Ok(())
    }

    fn spend_allowance(
        e: &Env,
        from: &Address,
        spender: &Address,
        amount: i128,
    ) -> Result<(), TokenError> {
        let key = DataKey::Allowance(from.clone(), spender.clone());
        let a: AllowanceValue = e
            .storage()
            .temporary()
            .get(&key)
            .unwrap_or(AllowanceValue {
                amount: 0,
                expiration_ledger: 0,
            });
        let live = a.expiration_ledger >= e.ledger().sequence();
        if !live || a.amount < amount {
            return Err(TokenError::InsufficientAllowance);
        }
        e.storage().temporary().set(
            &key,
            &AllowanceValue {
                amount: a.amount - amount,
                expiration_ledger: a.expiration_ledger,
            },
        );
        Ok(())
    }
}

#[cfg(test)]
mod test;
