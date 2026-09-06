//! API-key storage.
//!
//! Production (Windows, default feature `keyring`): Windows Credential Manager via the
//! `keyring` crate — keys never touch disk, the database, or logs. Entry name:
//! `polylab/provider/{id}`.
//!
//! Sandbox/CI builds without the `keyring` feature fall back to a JSON file inside the
//! data directory (permissions 0600) so the rest of the system stays testable. The
//! fallback prints a loud warning at startup and must never be used in production
//! packaging (`electron-builder` builds use default features).

// The imports below back the file-backed fallback store. When the `keyring`
// feature is enabled (Windows packaging) the fallback is compiled out, so the
// imports must be feature-gated too — otherwise the release build warns.
#[cfg(not(feature = "keyring"))]
use std::collections::HashMap;
#[cfg(not(feature = "keyring"))]
use std::path::PathBuf;
#[cfg(not(feature = "keyring"))]
use std::sync::Mutex;

use anyhow::Context;

pub const SERVICE: &str = "polylab";

pub trait SecretStore: Send + Sync {
    fn set(&self, key: &str, value: &str) -> anyhow::Result<()>;
    fn get(&self, key: &str) -> anyhow::Result<Option<String>>;
    fn delete(&self, key: &str) -> anyhow::Result<()>;
}

pub fn provider_key(provider_id: &str) -> String {
    format!("provider/{provider_id}")
}

pub fn new_store(data_dir: &std::path::Path) -> anyhow::Result<Box<dyn SecretStore>> {
    #[cfg(feature = "keyring")]
    {
        let _ = data_dir;
        Ok(Box::new(KeyringStore))
    }
    #[cfg(not(feature = "keyring"))]
    {
        tracing::warn!(
            "built WITHOUT the keyring feature: API keys are stored in a plaintext JSON \
             file ({}) — sandbox/CI only, never package like this",
            data_dir.join("secrets.json").display()
        );
        Ok(Box::new(FileStore::open(data_dir)?))
    }
}

#[cfg(feature = "keyring")]
struct KeyringStore;

#[cfg(feature = "keyring")]
impl SecretStore for KeyringStore {
    fn set(&self, key: &str, value: &str) -> anyhow::Result<()> {
        keyring::Entry::new(SERVICE, key)
            .context("opening credential manager entry")?
            .set_password(value)
            .context("writing credential")
    }

    fn get(&self, key: &str) -> anyhow::Result<Option<String>> {
        match keyring::Entry::new(SERVICE, key)
            .context("opening credential manager entry")?
            .get_password()
        {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(anyhow::Error::new(error).context("reading credential")),
        }
    }

    fn delete(&self, key: &str) -> anyhow::Result<()> {
        match keyring::Entry::new(SERVICE, key)
            .context("opening credential manager entry")?
            .delete_credential()
        {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(anyhow::Error::new(error).context("deleting credential")),
        }
    }
}

#[cfg(not(feature = "keyring"))]
struct FileStore {
    path: PathBuf,
    map: Mutex<HashMap<String, String>>,
}

#[cfg(not(feature = "keyring"))]
impl FileStore {
    fn open(data_dir: &std::path::Path) -> anyhow::Result<Self> {
        std::fs::create_dir_all(data_dir)?;
        let path = data_dir.join("secrets.json");
        let map = if path.exists() {
            serde_json::from_slice(&std::fs::read(&path).context("reading secrets file")?)
                .context("parsing secrets file")?
        } else {
            HashMap::new()
        };
        Ok(Self { path, map: Mutex::new(map) })
    }

    fn persist(&self, map: &HashMap<String, String>) -> anyhow::Result<()> {
        let bytes = serde_json::to_vec_pretty(map)?;
        std::fs::write(&self.path, bytes)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&self.path, std::fs::Permissions::from_mode(0o600));
        }
        Ok(())
    }
}

#[cfg(not(feature = "keyring"))]
impl SecretStore for FileStore {
    fn set(&self, key: &str, value: &str) -> anyhow::Result<()> {
        let mut map = self.map.lock().unwrap();
        map.insert(key.to_string(), value.to_string());
        self.persist(&map)
    }

    fn get(&self, key: &str) -> anyhow::Result<Option<String>> {
        Ok(self.map.lock().unwrap().get(key).cloned())
    }

    fn delete(&self, key: &str) -> anyhow::Result<()> {
        let mut map = self.map.lock().unwrap();
        map.remove(key);
        self.persist(&map)
    }
}
