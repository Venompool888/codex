use axum::extract::FromRef;
use axum::extract::FromRequestParts;
use axum::http::StatusCode;
use axum::http::header::AUTHORIZATION;
use axum::http::request::Parts;
use base64::Engine;
use rand::RngCore;
use sha2::Digest;
use sha2::Sha256;

use crate::Store;

const TOKEN_BYTES: usize = 32;

pub fn generate_token() -> String {
    let mut bytes = [0u8; TOKEN_BYTES];
    rand::rng().fill_bytes(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

pub fn hash_token(token: &str) -> String {
    let digest = Sha256::digest(token.as_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest)
}

pub fn verify_token(token: &str, expected_hash: &str) -> bool {
    let actual_hash = hash_token(token);
    constant_time_eq::constant_time_eq(actual_hash.as_bytes(), expected_hash.as_bytes())
}

pub struct Authenticated;

impl<S> FromRequestParts<S> for Authenticated
where
    Store: FromRef<S>,
    S: Send + Sync,
{
    type Rejection = StatusCode;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let token = bearer_token(parts).ok_or(StatusCode::UNAUTHORIZED)?;
        let store = Store::from_ref(state);
        let setup_state = store
            .setup_state()
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        let Some(expected_hash) = setup_state.session_token_hash else {
            return Err(StatusCode::UNAUTHORIZED);
        };

        if verify_token(token, &expected_hash) {
            Ok(Self)
        } else {
            Err(StatusCode::UNAUTHORIZED)
        }
    }
}

fn bearer_token(parts: &Parts) -> Option<&str> {
    let header = parts.headers.get(AUTHORIZATION)?.to_str().ok()?;
    header.strip_prefix("Bearer ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_token_verifies_against_hash() {
        let token = generate_token();
        let hash = hash_token(&token);

        assert!(verify_token(&token, &hash));
        assert!(!verify_token("wrong", &hash));
    }
}
