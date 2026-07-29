//! Cloudflare OAuth (authorization code + PKCE, public client).
//!
//! Uses wrangler's published public client — the same ID community tools like
//! PartyKit embed — because its redirect URI is a fixed localhost loopback and
//! it may request every scope we need (verified live, including
//! `vectorize:write`). To switch to a self-managed Cloudflare OAuth client
//! later, change CLIENT_ID/REDIRECT_URI below; the flow is identical. See
//! installer/README.md for the audit trail.
//!
//! Tokens returned here live in memory only, for the duration of setup.

use base64::Engine;
use rand::RngCore;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::time::{Duration, Instant};

pub const CLIENT_ID: &str = "54d11594-84e4-41aa-b438-e81b8fa78ee7";
pub const AUTH_URL: &str = "https://dash.cloudflare.com/oauth2/auth";
pub const TOKEN_URL: &str = "https://dash.cloudflare.com/oauth2/token";
pub const REDIRECT_URI: &str = "http://localhost:8976/oauth/callback";
const CALLBACK_PORT: u16 = 8976;
const CALLBACK_TIMEOUT: Duration = Duration::from_secs(300);

/// Everything provisioning needs, nothing more.
pub const SCOPES: &[&str] = &[
    "account:read",       // resolve the account id
    "user:read",          // required alongside account:read for membership reads
    "workers:write",      // Workers platform umbrella
    "workers_scripts:write", // script upload, secrets, subdomain, cron
    "workers_kv:write",   // OAUTH_KV namespace
    "d1:write",           // memory database
    "ai:write",           // Workers AI binding usage
    "vectorize:write",    // vector index creation
    "offline_access",     // refresh token
];

#[derive(Debug, Clone)]
pub struct Tokens {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_at: Instant,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    #[serde(default)]
    expires_in: Option<u64>,
}

#[derive(Debug, thiserror::Error)]
pub enum OauthError {
    #[error("another setup is already waiting for a Cloudflare sign-in (port {CALLBACK_PORT} is in use)")]
    PortBusy,
    #[error("sign-in was cancelled")]
    Denied,
    #[error("sign-in timed out — the browser never came back to the app")]
    Timeout,
    #[error("sign-in response didn't match this app's request")]
    StateMismatch,
    #[error("could not exchange the sign-in code: {0}")]
    Exchange(String),
    #[error("network problem during sign-in: {0}")]
    Network(#[from] reqwest::Error),
}

pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
}

impl Pkce {
    pub fn generate() -> Self {
        let mut bytes = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut bytes);
        let verifier = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
        Self::from_verifier(verifier)
    }

    pub fn from_verifier(verifier: String) -> Self {
        let digest = Sha256::digest(verifier.as_bytes());
        let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest);
        Self {
            verifier,
            challenge,
        }
    }
}

pub fn random_state() -> String {
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

pub fn auth_url(pkce: &Pkce, state: &str) -> String {
    let mut url = url::Url::parse(AUTH_URL).expect("static url parses");
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", CLIENT_ID)
        .append_pair("redirect_uri", REDIRECT_URI)
        .append_pair("scope", &SCOPES.join(" "))
        .append_pair("state", state)
        .append_pair("code_challenge", &pkce.challenge)
        .append_pair("code_challenge_method", "S256");
    url.to_string()
}

const SUCCESS_PAGE: &str = r#"<!doctype html><html><head><meta charset="utf-8"><title>Second Brain</title>
<style>body{font-family:system-ui,sans-serif;background:#f4f1ea;color:#26241f;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{text-align:center;max-width:360px;padding:40px}h1{font-size:22px;margin:0 0 10px}p{color:#6e6b62;font-size:15px;line-height:1.5}</style></head>
<body><div class="card"><h1>You&rsquo;re signed in ✓</h1><p>You can close this tab and return to the Second Brain app.</p></div>
<script>setTimeout(function(){window.close()},1500)</script></body></html>"#;

const DENIED_PAGE: &str = r#"<!doctype html><html><head><meta charset="utf-8"><title>Second Brain</title>
<style>body{font-family:system-ui,sans-serif;background:#f4f1ea;color:#26241f;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{text-align:center;max-width:360px;padding:40px}h1{font-size:22px;margin:0 0 10px}p{color:#6e6b62;font-size:15px;line-height:1.5}</style></head>
<body><div class="card"><h1>Sign-in cancelled</h1><p>You can close this tab. Head back to the Second Brain app to try again.</p></div></body></html>"#;

struct CallbackResult {
    code: String,
    state: String,
}

/// Blocks (call from `spawn_blocking`) until the browser hits the loopback
/// callback, then returns the authorization code.
fn wait_for_callback(server: tiny_http::Server) -> Result<CallbackResult, OauthError> {
    let deadline = Instant::now() + CALLBACK_TIMEOUT;
    loop {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or(OauthError::Timeout)?;
        let Some(req) = server
            .recv_timeout(remaining.min(Duration::from_secs(1)))
            .map_err(|_| OauthError::Timeout)?
        else {
            continue;
        };
        let raw_url = format!("http://localhost:{CALLBACK_PORT}{}", req.url());
        let Ok(parsed) = url::Url::parse(&raw_url) else {
            let _ = req.respond(tiny_http::Response::empty(404));
            continue;
        };
        if parsed.path() != "/oauth/callback" {
            let _ = req.respond(tiny_http::Response::empty(404));
            continue;
        }
        let mut code = None;
        let mut state = None;
        let mut error = None;
        for (k, v) in parsed.query_pairs() {
            match k.as_ref() {
                "code" => code = Some(v.into_owned()),
                "state" => state = Some(v.into_owned()),
                "error" => error = Some(v.into_owned()),
                _ => {}
            }
        }
        if error.is_some() {
            let _ = req.respond(html_response(DENIED_PAGE));
            return Err(OauthError::Denied);
        }
        match (code, state) {
            (Some(code), Some(state)) => {
                let _ = req.respond(html_response(SUCCESS_PAGE));
                return Ok(CallbackResult { code, state });
            }
            _ => {
                let _ = req.respond(tiny_http::Response::empty(400));
            }
        }
    }
}

fn html_response(body: &str) -> tiny_http::Response<std::io::Cursor<Vec<u8>>> {
    tiny_http::Response::from_string(body).with_header(
        tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"text/html; charset=utf-8"[..])
            .expect("static header"),
    )
}

fn tokens_from(resp: TokenResponse) -> Tokens {
    Tokens {
        access_token: resp.access_token,
        refresh_token: resp.refresh_token,
        // Default conservatively when the server omits expires_in.
        expires_at: Instant::now() + Duration::from_secs(resp.expires_in.unwrap_or(600)),
    }
}

/// Full login: bind the loopback listener FIRST, then hand the browser URL to
/// `open` (Rust-side opener — the URL never passes through the webview), wait
/// for the redirect, and exchange the code.
pub async fn run_login_flow(open: impl FnOnce(String)) -> Result<Tokens, OauthError> {
    let server = tiny_http::Server::http(("127.0.0.1", CALLBACK_PORT))
        .map_err(|_| OauthError::PortBusy)?;

    let pkce = Pkce::generate();
    let state = random_state();
    open(auth_url(&pkce, &state));

    let callback = tokio::task::spawn_blocking(move || wait_for_callback(server))
        .await
        .map_err(|_| OauthError::Timeout)??;

    if callback.state != state {
        return Err(OauthError::StateMismatch);
    }

    exchange_code(&callback.code, &pkce.verifier).await
}

async fn exchange_code(code: &str, verifier: &str) -> Result<Tokens, OauthError> {
    let http = reqwest::Client::new();
    let resp = http
        .post(TOKEN_URL)
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", REDIRECT_URI),
            ("client_id", CLIENT_ID),
            ("code_verifier", verifier),
        ])
        .timeout(Duration::from_secs(30))
        .send()
        .await?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        let mut short = body;
        short.truncate(300);
        return Err(OauthError::Exchange(format!("HTTP {status}: {short}")));
    }
    let parsed: TokenResponse = serde_json::from_str(&body)
        .map_err(|e| OauthError::Exchange(format!("unexpected token response: {e}")))?;
    Ok(tokens_from(parsed))
}

/// Refresh an expired access token (refresh tokens may rotate — keep the new
/// one when present, fall back to the old one otherwise, per RFC 6749 §6).
pub async fn refresh(tokens: &Tokens) -> Result<Tokens, OauthError> {
    let refresh_token = tokens
        .refresh_token
        .clone()
        .ok_or_else(|| OauthError::Exchange("no refresh token held".into()))?;
    let http = reqwest::Client::new();
    let resp = http
        .post(TOKEN_URL)
        .form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", &refresh_token),
            ("client_id", CLIENT_ID),
        ])
        .timeout(Duration::from_secs(30))
        .send()
        .await?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        let mut short = body;
        short.truncate(300);
        return Err(OauthError::Exchange(format!("HTTP {status}: {short}")));
    }
    let parsed: TokenResponse = serde_json::from_str(&body)
        .map_err(|e| OauthError::Exchange(format!("unexpected token response: {e}")))?;
    let mut new_tokens = tokens_from(parsed);
    if new_tokens.refresh_token.is_none() {
        new_tokens.refresh_token = Some(refresh_token);
    }
    Ok(new_tokens)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_matches_rfc7636_vector() {
        let pkce =
            Pkce::from_verifier("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk".to_string());
        assert_eq!(pkce.challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }

    #[test]
    fn generated_pkce_is_url_safe() {
        let pkce = Pkce::generate();
        assert!(pkce.verifier.len() >= 43);
        assert!(!pkce.verifier.contains('+'));
        assert!(!pkce.verifier.contains('/'));
        assert!(!pkce.verifier.contains('='));
    }

    #[test]
    fn auth_url_contains_required_params() {
        let pkce = Pkce::from_verifier("test-verifier-test-verifier-test-verifier-x".into());
        let url = auth_url(&pkce, "st4te");
        assert!(url.starts_with(AUTH_URL));
        for needle in [
            "response_type=code",
            "client_id=54d11594-84e4-41aa-b438-e81b8fa78ee7",
            "code_challenge_method=S256",
            "state=st4te",
            "offline_access",
            "vectorize%3Awrite",
            "d1%3Awrite",
        ] {
            assert!(url.contains(needle), "missing {needle} in {url}");
        }
    }
}
