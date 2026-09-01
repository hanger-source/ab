use sha2::{Digest, Sha256};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

const INPUTS: &[&str] = &[
    "Cargo.toml",
    "Cargo.lock",
    "server/rust/ab-protocol/Cargo.toml",
    "server/rust/ab-protocol/build.rs",
    "server/rust/ab-protocol/src",
    "server/rust/ab-runtime/Cargo.toml",
    "server/rust/ab-runtime/build.rs",
    "server/rust/ab-runtime/src",
    "server/rust/agent-browser/cli/Cargo.toml",
    "server/rust/agent-browser/cli/build.rs",
    "server/rust/agent-browser/cli/src",
    "sdk/ts/package.json",
    "sdk/ts/tsconfig.json",
    "sdk/ts/docs",
    "sdk/ts/src",
];

fn main() {
    println!("cargo:rerun-if-env-changed=AB_BUILD_ID_OVERRIDE");
    let workspace = workspace_root();
    let files = build_input_files(&workspace).expect("failed to enumerate AB build inputs");
    for path in &files {
        println!("cargo:rerun-if-changed={}", path.display());
    }

    let build_id = env::var("AB_BUILD_ID_OVERRIDE").unwrap_or_else(|_| {
        let digest =
            source_digest(&workspace, &files).expect("failed to fingerprint AB build inputs");
        format!("ab-runtime@{}+{}", env!("CARGO_PKG_VERSION"), &digest[..16])
    });
    println!("cargo:rustc-env=AB_SOURCE_BUILD_ID={build_id}");
}

fn workspace_root() -> PathBuf {
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("manifest directory"));
    manifest
        .ancestors()
        .nth(3)
        .expect("ab-protocol must remain under server/rust")
        .to_owned()
}

fn build_input_files(workspace: &Path) -> std::io::Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    for input in INPUTS {
        collect_files(&workspace.join(input), &mut files)?;
    }
    files.sort();
    files.dedup();
    Ok(files)
}

fn source_digest(workspace: &Path, files: &[PathBuf]) -> std::io::Result<String> {
    let generated_protocol = workspace.join("sdk/ts/src/protocol/generated/protocol-v3.ts");
    let mut digest = Sha256::new();
    for path in files {
        if *path == generated_protocol {
            continue;
        }
        let relative = path
            .strip_prefix(workspace)
            .expect("fingerprint input in workspace");
        digest.update(relative.to_string_lossy().as_bytes());
        digest.update([0]);
        digest.update(fs::read(path)?);
        digest.update([0]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn collect_files(path: &Path, output: &mut Vec<PathBuf>) -> std::io::Result<()> {
    if path.is_file() {
        output.push(path.to_owned());
        return Ok(());
    }
    let mut entries = fs::read_dir(path)?.collect::<Result<Vec<_>, _>>()?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let path = entry.path();
        if path.is_dir() {
            collect_files(&path, output)?;
        } else if path.is_file() {
            output.push(path);
        }
    }
    Ok(())
}
