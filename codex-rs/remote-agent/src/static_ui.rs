use axum::extract::Path;
use axum::http::StatusCode;
use axum::http::header::CONTENT_SECURITY_POLICY;
use axum::http::header::CONTENT_TYPE;
use axum::http::header::REFERRER_POLICY;
use axum::http::header::X_CONTENT_TYPE_OPTIONS;
use axum::response::IntoResponse;

const INDEX_HTML: &str = include_str!("../static/index.html");
const STYLES_CSS: &str = include_str!("../static/styles.css");
const APP_JS: &str = include_str!("../static/app.js");

pub(crate) async fn index() -> impl IntoResponse {
    static_response("text/html; charset=utf-8", INDEX_HTML)
}

pub(crate) async fn asset_root() -> impl IntoResponse {
    missing_asset()
}

pub(crate) async fn asset(Path(path): Path<String>) -> impl IntoResponse {
    match path.as_str() {
        "styles.css" => static_response("text/css; charset=utf-8", STYLES_CSS).into_response(),
        "app.js" => {
            static_response("application/javascript; charset=utf-8", APP_JS).into_response()
        }
        _ => missing_asset(),
    }
}

fn missing_asset() -> axum::response::Response {
    (
        StatusCode::NOT_FOUND,
        static_response("text/plain; charset=utf-8", ""),
    )
        .into_response()
}

fn static_response(content_type: &'static str, body: &'static str) -> impl IntoResponse {
    (
        [
            (CONTENT_TYPE, content_type),
            (
                CONTENT_SECURITY_POLICY,
                "default-src 'self'; connect-src 'self'; form-action 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
            ),
            (X_CONTENT_TYPE_OPTIONS, "nosniff"),
            (REFERRER_POLICY, "no-referrer"),
        ],
        body,
    )
}
