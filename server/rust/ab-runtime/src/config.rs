use crate::error::{AbError, AbResult};
use serde::Deserialize;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct Config {
    pub runtime_dir: PathBuf,
    pub socket_path: PathBuf,
    pub lock_path: PathBuf,
    pub startup_path: PathBuf,
    pub data_dir: PathBuf,
    pub logs_dir: PathBuf,
    pub artifacts_dir: PathBuf,
    pub browser_provider: BrowserProviderConfig,
}

#[derive(Debug, Clone)]
pub enum BrowserProviderConfig {
    Managed {
        profile_dir: PathBuf,
        chrome_path: PathBuf,
        headless: bool,
    },
    External {
        web_socket_url: String,
    },
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProductConfig {
    chrome_path: Option<PathBuf>,
    profile_path: Option<PathBuf>,
}

impl Config {
    pub fn load() -> AbResult<Self> {
        let data_dir = match std::env::var_os("AB_DATA_DIR") {
            Some(value) => PathBuf::from(value),
            None => {
                let home = std::env::var_os("HOME").ok_or_else(|| {
                    AbError::new("configuration_error", "config", "HOME is not set")
                })?;
                PathBuf::from(home)
                    .join("Library")
                    .join("Application Support")
                    .join("ab")
            }
        };

        let runtime_dir = match std::env::var_os("AB_RUNTIME_DIR") {
            Some(value) => PathBuf::from(value),
            None => {
                let uid = unsafe { libc::geteuid() };
                std::env::temp_dir().join(format!("ab-{uid}"))
            }
        };

        create_private_dir(&runtime_dir)?;
        create_private_dir(&data_dir)?;
        let logs_dir = data_dir.join("logs");
        create_private_dir(&logs_dir)?;
        let artifacts_dir = data_dir.join("artifacts");
        create_private_dir(&artifacts_dir)?;

        let browser_provider = match std::env::var("AB_CHROME_WS_URL") {
            Ok(value) if !value.trim().is_empty() => BrowserProviderConfig::External {
                web_socket_url: value.trim().to_owned(),
            },
            Ok(_) | Err(std::env::VarError::NotPresent) => {
                let product_config = read_product_config(&data_dir.join("config.json"))?;
                let profile_dir = std::env::var_os("AB_PROFILE_DIR")
                    .map(PathBuf::from)
                    .or(product_config.profile_path)
                    .unwrap_or_else(|| data_dir.join("chrome-profile"));
                create_private_dir(&profile_dir)?;
                let chrome_path = std::env::var_os("AB_CHROME_PATH")
                    .map(PathBuf::from)
                    .or(product_config.chrome_path)
                    .unwrap_or_else(|| {
                        PathBuf::from(
                            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
                        )
                    });
                BrowserProviderConfig::Managed {
                    profile_dir,
                    chrome_path,
                    headless: read_headless()?,
                }
            }
            Err(error) => {
                return Err(AbError::new(
                    "configuration_error",
                    "config.external_chrome",
                    format!("AB_CHROME_WS_URL is not valid UTF-8: {error}"),
                ));
            }
        };

        Ok(Self {
            socket_path: runtime_dir.join("browser.sock"),
            lock_path: runtime_dir.join("daemon.lock"),
            startup_path: runtime_dir.join("startup.json"),
            runtime_dir,
            data_dir,
            logs_dir,
            artifacts_dir,
            browser_provider,
        })
    }
}

fn read_headless() -> AbResult<bool> {
    match std::env::var("AB_HEADLESS") {
        Ok(value) if matches!(value.as_str(), "1" | "true") => Ok(true),
        Ok(value) if matches!(value.as_str(), "0" | "false") => Ok(false),
        Ok(value) => Err(AbError::new(
            "configuration_error",
            "config.headless",
            format!("AB_HEADLESS must be 1, true, 0, or false; received {value:?}"),
        )),
        Err(std::env::VarError::NotPresent) => Ok(false),
        Err(error) => Err(AbError::new(
            "configuration_error",
            "config.headless",
            format!("AB_HEADLESS is not valid UTF-8: {error}"),
        )),
    }
}

fn create_private_dir(path: &Path) -> AbResult<()> {
    fs::create_dir_all(path).map_err(|error| {
        AbError::new(
            "filesystem_error",
            "config.directory",
            format!("failed to create {}: {error}", path.display()),
        )
    })?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|error| {
        AbError::new(
            "filesystem_error",
            "config.permissions",
            format!("failed to set permissions on {}: {error}", path.display()),
        )
    })
}

fn read_product_config(path: &Path) -> AbResult<ProductConfig> {
    if !path.exists() {
        return Ok(ProductConfig::default());
    }
    let bytes = fs::read(path).map_err(|error| {
        AbError::new(
            "configuration_error",
            "config.read",
            format!("failed to read {}: {error}", path.display()),
        )
    })?;
    serde_json::from_slice(&bytes).map_err(|error| {
        AbError::new(
            "configuration_error",
            "config.parse",
            format!("failed to parse {}: {error}", path.display()),
        )
    })
}
