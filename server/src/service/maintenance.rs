//! Maintenance: retention and quota enforcement, run on a background task.

use std::time::Duration;

use crate::error::Result;
use crate::state::SharedState;
use crate::wire::Event;

const SWEEP_INTERVAL: Duration = Duration::from_secs(60);

pub fn spawn_sweeper(st: SharedState) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(SWEEP_INTERVAL);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            ticker.tick().await;
            if let Err(e) = sweep(&st).await {
                tracing::error!("sweep failed: {e:?}");
            }
        }
    });
}

async fn sweep(st: &SharedState) -> Result<()> {
    let now = now_ms();
    purge_stale_uploads(st, now).await?;

    let expired = crate::repo::files::expired_ids(&st.db, now).await?;
    for file_id in &expired {
        purge_file(st, file_id).await?;
    }
    if !expired.is_empty() {
        tracing::info!("sweeper: removed {} expired file(s)", expired.len());
    }

    // Enforce the total cap: evict oldest-uploaded first until under quota.
    loop {
        let used = crate::repo::files::used_bytes(&st.db).await?;
        if used <= st.cfg.max_total_bytes {
            break;
        }
        let Some(victim) = crate::repo::files::oldest(&st.db).await? else {
            break;
        };
        tracing::info!(
            "sweeper: storage cap exceeded ({} > {}), evicting oldest-uploaded file {}",
            used,
            st.cfg.max_total_bytes,
            victim.id
        );
        purge_file(st, &victim.id).await?;
    }
    Ok(())
}

/// Abandoned upload sessions hold reserved quota (in-flight bytes count
/// toward the cap) and leave staging blobs on disk. Sessions untouched for
/// `upload_ttl_hours` are treated as dead: row deleted, staging blob removed.
async fn purge_stale_uploads(st: &SharedState, now_ms: i64) -> Result<()> {
    let cutoff = now_ms - st.cfg.upload_ttl_ms();
    let stale = crate::repo::uploads::expired(&st.db, cutoff).await?;
    for session in &stale {
        crate::repo::uploads::delete_row(&st.db, session.id.clone()).await?;
        if let Err(e) = st.blobs.remove_staging(&session.id).await {
            tracing::error!("upload {}: staging removal failed: {e:?}", session.id);
        }
    }
    if !stale.is_empty() {
        tracing::info!("sweeper: reaped {} stale upload session(s)", stale.len());
    }
    Ok(())
}

/// Remove a stored file everywhere: `files` row + referencing messages in
/// one transaction, then the blob bytes, then a fan-out so clients drop it.
/// Returns true when the file existed.
pub async fn purge_file(st: &SharedState, file_id: &str) -> Result<bool> {
    let existed = crate::repo::files::delete_everywhere(&st.db, file_id.to_string()).await?;
    if existed {
        match st.blobs.remove(file_id).await {
            Ok(true) => {}
            Ok(false) => {
                tracing::warn!("file {file_id}: blob already gone, metadata cleaned");
            }
            Err(e) => {
                tracing::error!("file {file_id}: blob removal failed: {e:?}");
            }
        }
        st.registry.broadcast(
            &Event::FileDeleted {
                file_id: file_id.to_string(),
            },
            None,
        );
    }
    Ok(existed)
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
