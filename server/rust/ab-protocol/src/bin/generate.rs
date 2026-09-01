use ab_protocol::{typescript_declarations, ProtocolContract};
use schemars::schema_for;
use std::env;
use std::fs;
use std::path::PathBuf;

fn main() {
    let mut arguments = env::args_os().skip(1);
    let root = arguments
        .next()
        .map(PathBuf::from)
        .expect("usage: generate-ab-protocol <workspace-root> [--check]");
    let check = arguments.any(|argument| argument == "--check");
    let typescript_path = root.join("sdk/ts/src/protocol/generated/protocol-v3.ts");
    let schema_path = root.join("protocol/schema/protocol-v3.schema.json");
    let typescript = typescript_declarations();
    let schema = schema_for!(ProtocolContract);
    let schema = format!(
        "{}\n",
        serde_json::to_string_pretty(&schema).expect("serialize schema")
    );
    write_or_check(&typescript_path, &typescript, check).expect("TypeScript protocol is stale");
    write_or_check(&schema_path, &schema, check).expect("JSON protocol schema is stale");
    let action = if check { "checked" } else { "generated" };
    println!("{action} {}", typescript_path.display());
    println!("{action} {}", schema_path.display());
}

fn write_or_check(path: &PathBuf, expected: &str, check: bool) -> std::io::Result<()> {
    if check {
        let actual = fs::read_to_string(path)?;
        if actual == expected {
            return Ok(());
        }
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("{} differs from generated protocol", path.display()),
        ));
    }
    fs::create_dir_all(path.parent().expect("generated protocol parent"))?;
    fs::write(path, expected)
}
