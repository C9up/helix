//! Aggregated results across all test files in a run.

use crate::ipc::{FileResult, WorkerError};
use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Totals {
    pub pass: u64,
    pub fail: u64,
    pub skip: u64,
    pub todo: u64,
    /// Files that failed to load / timed out / crashed without producing a
    /// `FileResult`.
    pub file_errors: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub totals: Totals,
    pub files: Vec<FileResult>,
    pub file_errors: Vec<WorkerError>,
    #[serde(with = "duration_ms")]
    pub duration: Duration,
}

impl Default for Summary {
    fn default() -> Self {
        Self {
            totals: Totals::default(),
            files: Vec::new(),
            file_errors: Vec::new(),
            duration: Duration::ZERO,
        }
    }
}

impl Summary {
    pub fn from_results(
        files: Vec<FileResult>,
        file_errors: Vec<WorkerError>,
        duration: Duration,
    ) -> Self {
        let mut totals = Totals {
            file_errors: file_errors.len() as u64,
            ..Default::default()
        };
        for f in &files {
            totals.pass += f.totals.pass;
            totals.fail += f.totals.fail;
            totals.skip += f.totals.skip;
            totals.todo += f.totals.todo;
        }
        Self {
            totals,
            files,
            file_errors,
            duration,
        }
    }

    /// Exit code convention: 0 on success, 1 on any failure.
    pub fn exit_code(&self) -> i32 {
        if self.totals.fail > 0 || self.totals.file_errors > 0 {
            1
        } else {
            0
        }
    }
}

mod duration_ms {
    use serde::{Deserialize, Deserializer, Serialize, Serializer};
    use std::time::Duration;

    pub fn serialize<S: Serializer>(d: &Duration, s: S) -> Result<S::Ok, S::Error> {
        (d.as_millis() as u64).serialize(s)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Duration, D::Error> {
        let ms = u64::deserialize(d)?;
        Ok(Duration::from_millis(ms))
    }
}
