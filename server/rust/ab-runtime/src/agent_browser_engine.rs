//! AB's direct dependency surface over the complete agent-browser Rust crate.
//!
//! Upstream: https://github.com/vercel-labs/agent-browser
//! Commit: fbd046c23a2c1156891bda294aaaee715c23b3f1
//! License: Apache-2.0
//!
//! The complete source tree lives at `server/rust/agent-browser`; its `cli`
//! crate is a member of this Cargo workspace. AB owns the outer daemon,
//! protocol, browser identity, multi-client resource ownership and
//! persistent-profile lifecycle.

pub use agent_browser::native::{
    actions, cdp, diff, element, interaction, pointer_action, screenshot, snapshot,
};
