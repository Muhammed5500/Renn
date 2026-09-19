//! Events.
//!
//! CAP-86 WARNING (Protocol 28): fields with empty values are no longer
//! published. Write event tests by field NAME, not by position.
//!
//! The shadow ledger listens to `Joined`, `Deposited`, `ExitStarted`,
//! `Withdrawn` and `Settled`. Do NOT rename fields.
//!
//! v3.3: no receipts, the record is read from these events.

use soroban_sdk::{contractevent, Address, BytesN, Symbol};

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Joined {
    #[topic]
    pub who: Address,
    pub key: BytesN<32>,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Deposited {
    #[topic]
    pub who: Address,
    pub amount: i128,
    pub balance: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Settled {
    #[topic]
    pub payer: Address,
    #[topic]
    pub recipient: Address,
    pub amount: i128,
    pub cumulative: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BatchSettled {
    pub total: i128,
    pub settled: u32,
    pub stale: u32,
    pub skipped: u32,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExitStarted {
    #[topic]
    pub who: Address,
    pub at_ledger: u32,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Withdrawn {
    #[topic]
    pub who: Address,
    pub amount: i128,
    /// approved = approved by the operator, exit = escape hatch,
    /// free = unregistered recipient, pushed = permissionless payout
    pub path: Symbol,
}
