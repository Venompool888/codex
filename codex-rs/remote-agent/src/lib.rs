mod auth;
pub mod config;
mod models;
mod routes;
mod sessions;
mod static_ui;
mod store;
mod workspaces;

pub use routes::build_router;
