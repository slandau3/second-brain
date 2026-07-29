//! OS-secure storage for what setup produces: the Worker URL and the user's
//! AUTH_TOKEN. Backed by the macOS Keychain / Windows Credential Manager via
//! the `keyring` crate. Nothing here ever touches disk in plaintext.
//!
//! The Cloudflare OAuth token is deliberately NOT stored — it's only needed
//! during provisioning and lives in memory for that window.
//!
//! Tests swap the keyring for an in-process map (keyring's mock store scopes
//! credentials to a single Entry instance, so it can't test save→load).

const KEY_WORKER_URL: &str = "worker-url";
const KEY_AUTH_TOKEN: &str = "auth-token";

#[derive(Debug, Clone)]
pub struct SetupInfo {
    pub worker_url: String,
    pub auth_token: String,
}

#[derive(Debug, thiserror::Error)]
#[error("secure storage error: {0}")]
pub struct StoreError(String);

#[cfg(not(test))]
mod backend {
    use super::StoreError;
    use keyring::Entry;

    const SERVICE: &str = "com.secondbrain.desktop";

    pub fn set(key: &str, value: &str) -> Result<(), StoreError> {
        Entry::new(SERVICE, key)
            .and_then(|e| e.set_password(value))
            .map_err(|e| StoreError(e.to_string()))
    }

    pub fn get(key: &str) -> Option<String> {
        Entry::new(SERVICE, key).ok()?.get_password().ok()
    }

    pub fn delete(key: &str) {
        if let Ok(e) = Entry::new(SERVICE, key) {
            let _ = e.delete_credential();
        }
    }
}

#[cfg(test)]
mod backend {
    use super::StoreError;
    use std::collections::HashMap;
    use std::sync::Mutex;

    static MAP: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

    pub fn set(key: &str, value: &str) -> Result<(), StoreError> {
        MAP.lock()
            .unwrap()
            .get_or_insert_with(HashMap::new)
            .insert(key.to_string(), value.to_string());
        Ok(())
    }

    pub fn get(key: &str) -> Option<String> {
        MAP.lock().unwrap().as_ref()?.get(key).cloned()
    }

    pub fn delete(key: &str) {
        if let Some(map) = MAP.lock().unwrap().as_mut() {
            map.remove(key);
        }
    }
}

pub fn save_setup(worker_url: &str, auth_token: &str) -> Result<(), StoreError> {
    backend::set(KEY_WORKER_URL, worker_url)?;
    backend::set(KEY_AUTH_TOKEN, auth_token)?;
    Ok(())
}

/// Both values present ⇒ setup completed ⇒ the app boots in wrapper mode.
pub fn load_setup() -> Option<SetupInfo> {
    Some(SetupInfo {
        worker_url: backend::get(KEY_WORKER_URL)?,
        auth_token: backend::get(KEY_AUTH_TOKEN)?,
    })
}

pub fn clear_setup() {
    backend::delete(KEY_WORKER_URL);
    backend::delete(KEY_AUTH_TOKEN);
}

#[cfg(test)]
mod tests {
    use super::*;

    // One test: the backing map is shared process state, so scenarios run
    // sequentially to avoid cross-test races.
    #[test]
    fn roundtrip_clear_and_partial_state() {
        clear_setup();
        assert!(load_setup().is_none());

        save_setup("https://second-brain.demo.workers.dev", "hunter2hunter2").unwrap();
        let info = load_setup().expect("saved setup loads");
        assert_eq!(info.worker_url, "https://second-brain.demo.workers.dev");
        assert_eq!(info.auth_token, "hunter2hunter2");

        clear_setup();
        assert!(load_setup().is_none());

        backend::set(super::KEY_WORKER_URL, "https://x.workers.dev").unwrap();
        assert!(load_setup().is_none(), "URL without token must not count as set up");
        clear_setup();
    }
}
