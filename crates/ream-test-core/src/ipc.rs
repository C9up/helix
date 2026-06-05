//! IPC contract with `src/runtime/worker.ts main()`. The TypeScript worker
//! sends two message shapes: a `result` with a `FileResult` payload, or an
//! `error` when loading or running the file fails unrecoverably.
//!
//! These types are the Rust mirror of the TS definitions in
//! `packages/helix/src/runtime/run.ts`.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SerializedError {
    pub name: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stack: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actual: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operator: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TestStatus {
    Pass,
    Fail,
    Skip,
    Todo,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SuiteStatus {
    Pass,
    Fail,
    Skip,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    pub name: String,
    pub full_name: String,
    pub status: TestStatus,
    #[serde(default)]
    pub duration_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<SerializedError>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum SuiteChild {
    Test(TestResult),
    Suite(SuiteResult),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuiteResult {
    pub name: String,
    pub full_name: String,
    pub children: Vec<SuiteChild>,
    pub status: SuiteStatus,
    #[serde(default)]
    pub duration_ms: u64,
    #[serde(default)]
    pub hook_errors: Vec<SerializedError>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileTotals {
    pub pass: u64,
    pub fail: u64,
    pub skip: u64,
    pub todo: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileResult {
    pub file: String,
    pub suites: Vec<SuiteResult>,
    pub tests: Vec<TestResult>,
    pub totals: FileTotals,
    #[serde(default)]
    pub duration_ms: u64,
}

/// Messages sent FROM the worker TO the parent.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum WorkerOutgoing {
    #[serde(rename = "result")]
    Result { result: FileResult },
    #[serde(rename = "error")]
    Error(WorkerError),
}

/// A non-result error from the worker (load failure, uncaught, timeout
/// synthesised by the parent).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerError {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stack: Option<String>,
}

/// Messages sent FROM the parent TO the worker.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum WorkerIncoming {
    #[serde(rename = "run")]
    Run {
        file: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        timeout_ms: Option<u64>,
    },
}
