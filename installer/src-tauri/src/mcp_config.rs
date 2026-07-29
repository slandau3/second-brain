//! Writes MCP connector entries for locally-installed AI tools.
//!
//! Paths are resolved from the user's home directory, which is what both tools
//! use on macOS and Windows alike (`~/.claude.json`, `~/.cursor/mcp.json`).
//! Existing config is merged, never replaced.

use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};

pub const SERVER_KEY: &str = "second-brain";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tool {
    ClaudeCode,
    Cursor,
}

impl Tool {
    pub fn from_id(id: &str) -> Option<Self> {
        match id {
            "claude-code" => Some(Tool::ClaudeCode),
            "cursor" => Some(Tool::Cursor),
            _ => None,
        }
    }

    fn config_path(self, home: &Path) -> PathBuf {
        match self {
            Tool::ClaudeCode => home.join(".claude.json"),
            Tool::Cursor => home.join(".cursor").join("mcp.json"),
        }
    }

    /// Server entry formats differ slightly: Claude Code wants an explicit
    /// transport type; Cursor infers HTTP from `url`.
    fn server_entry(self, mcp_url: &str) -> Value {
        match self {
            Tool::ClaudeCode => json!({ "type": "http", "url": mcp_url }),
            Tool::Cursor => json!({ "url": mcp_url }),
        }
    }
}

/// "Installed" = the tool has left its config footprint in the home dir.
pub fn detect(tool: Tool, home: &Path) -> bool {
    match tool {
        Tool::ClaudeCode => home.join(".claude.json").exists() || home.join(".claude").is_dir(),
        Tool::Cursor => home.join(".cursor").is_dir(),
    }
}

#[derive(Debug, thiserror::Error)]
pub enum McpConfigError {
    #[error("could not read the tool's settings file: {0}")]
    Io(#[from] std::io::Error),
    #[error("the tool's settings file contains something unexpected")]
    Malformed,
}

/// Merges the Second Brain server into the tool's MCP config and returns the
/// path written. Creates the file (and parent dir) when missing.
pub fn connect(tool: Tool, home: &Path, mcp_url: &str) -> Result<PathBuf, McpConfigError> {
    let path = tool.config_path(home);

    let mut root: Value = match fs::read_to_string(&path) {
        Ok(text) if !text.trim().is_empty() => {
            serde_json::from_str(&text).map_err(|_| McpConfigError::Malformed)?
        }
        _ => Value::Object(Map::new()),
    };
    let obj = root.as_object_mut().ok_or(McpConfigError::Malformed)?;

    let servers = obj
        .entry("mcpServers")
        .or_insert_with(|| Value::Object(Map::new()));
    let servers = servers.as_object_mut().ok_or(McpConfigError::Malformed)?;
    servers.insert(SERVER_KEY.to_string(), tool.server_entry(mcp_url));

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&path, serde_json::to_string_pretty(&root)? + "\n")?;
    Ok(path)
}

impl From<serde_json::Error> for McpConfigError {
    fn from(_: serde_json::Error) -> Self {
        McpConfigError::Malformed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_home() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "sb-installer-test-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    const MCP: &str = "https://second-brain.demo.workers.dev/mcp";

    #[test]
    fn creates_fresh_configs() {
        let home = temp_home();
        let claude = connect(Tool::ClaudeCode, &home, MCP).unwrap();
        assert_eq!(claude, home.join(".claude.json"));
        let parsed: Value = serde_json::from_str(&fs::read_to_string(&claude).unwrap()).unwrap();
        assert_eq!(parsed["mcpServers"][SERVER_KEY]["type"], "http");
        assert_eq!(parsed["mcpServers"][SERVER_KEY]["url"], MCP);

        let cursor = connect(Tool::Cursor, &home, MCP).unwrap();
        assert_eq!(cursor, home.join(".cursor").join("mcp.json"));
        let parsed: Value = serde_json::from_str(&fs::read_to_string(&cursor).unwrap()).unwrap();
        assert_eq!(parsed["mcpServers"][SERVER_KEY]["url"], MCP);
        assert!(parsed["mcpServers"][SERVER_KEY].get("type").is_none());
    }

    #[test]
    fn merge_preserves_existing_settings() {
        let home = temp_home();
        fs::write(
            home.join(".claude.json"),
            r#"{"theme":"dark","mcpServers":{"other":{"type":"stdio","command":"x"}}}"#,
        )
        .unwrap();
        connect(Tool::ClaudeCode, &home, MCP).unwrap();
        let parsed: Value =
            serde_json::from_str(&fs::read_to_string(home.join(".claude.json")).unwrap()).unwrap();
        assert_eq!(parsed["theme"], "dark");
        assert_eq!(parsed["mcpServers"]["other"]["command"], "x");
        assert_eq!(parsed["mcpServers"][SERVER_KEY]["url"], MCP);
    }

    #[test]
    fn rewrites_stale_url_on_reconnect() {
        let home = temp_home();
        connect(Tool::Cursor, &home, "https://old.workers.dev/mcp").unwrap();
        connect(Tool::Cursor, &home, MCP).unwrap();
        let parsed: Value = serde_json::from_str(
            &fs::read_to_string(home.join(".cursor").join("mcp.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(parsed["mcpServers"][SERVER_KEY]["url"], MCP);
    }

    #[test]
    fn malformed_config_is_not_clobbered() {
        let home = temp_home();
        fs::write(home.join(".claude.json"), "not json at all {{{").unwrap();
        let err = connect(Tool::ClaudeCode, &home, MCP).unwrap_err();
        assert!(matches!(err, McpConfigError::Malformed));
        // Original content untouched.
        assert_eq!(
            fs::read_to_string(home.join(".claude.json")).unwrap(),
            "not json at all {{{"
        );
    }

    #[test]
    fn detect_by_footprint() {
        let home = temp_home();
        assert!(!detect(Tool::ClaudeCode, &home));
        assert!(!detect(Tool::Cursor, &home));
        fs::create_dir_all(home.join(".cursor")).unwrap();
        assert!(detect(Tool::Cursor, &home));
        fs::write(home.join(".claude.json"), "{}").unwrap();
        assert!(detect(Tool::ClaudeCode, &home));
    }
}
