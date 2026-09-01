mod dialog;
mod download;
mod events;
mod init_scripts;
mod network;
mod registry;
mod state;

use serde_json::Value;
use tokio::sync::mpsc;

type ClientOutbound = mpsc::UnboundedSender<Value>;

pub use registry::ResourceRegistry;
