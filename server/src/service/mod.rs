//! Application/use-case layer. Business rules (validation, quotas,
//! retention, delivery semantics) live here and nowhere else; this layer
//! orchestrates `repo` (metadata), `blob` (bytes) and `realtime` (events)
//! and must stay free of transport types (no axum).

pub mod devices;
pub mod maintenance;
pub mod messaging;
pub mod transfers;
