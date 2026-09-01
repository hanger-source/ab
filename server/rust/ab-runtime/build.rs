use std::fs;
use std::path::PathBuf;

fn main() {
    // agent-browser's hand-written CDP types include an optional generated module.
    // AB currently compiles the exact hand-written types used by its snapshot,
    // element and interaction engine; the generated module is intentionally empty
    // until the protocol generator is moved into AB's protocol-v3 build pipeline.
    let output = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR is required"));
    fs::write(output.join("cdp_generated.rs"), "").expect("failed to write cdp_generated.rs");
}
