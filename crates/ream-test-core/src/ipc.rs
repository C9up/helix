//! IPC contract with `src/runtime/cli-worker.ts`. The worker frames its
//! messages on stderr: a `result` with a `FileResult` payload, an `error`
//! when loading or running the file fails unrecoverably, or an `unhandled`
//! error raised beside the result. The run instruction it reads on stdin is
//! built by the pool as JSON and has no type here.
//!
//! These types are the Rust mirror of the TS definitions in
//! `packages/helix/src/runtime/run.ts`.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SerializedError {
    pub name: String,
    pub message: String,
    /// The error's code (`E_HELIX_TIMEOUT`, `E_HELIX_ASSERTION_FAILED`, a
    /// library's own), when it carries one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
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
    /// The lifecycle phase `error` was raised in (`setup`, `test`,
    /// `teardown`…), as the worker reports it. Kept as text: a phase this
    /// mirror does not know yet must not turn a whole result into a broken
    /// frame.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_phase: Option<String>,
}

/// A suite's child: a nested describe or a test.
///
/// Untagged, so serde tries the arms in order and takes the first that
/// fits. `Suite` comes first because it is the stricter shape: a test has no
/// `children`, so it cannot be read as a suite, while a suite carries every
/// field a test requires and, read as one, would lose its children and its
/// hook errors without a word.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum SuiteChild {
    Suite(SuiteResult),
    Test(TestResult),
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
    /// An error nobody handled (a floating rejection, a timer that threw),
    /// raised while the file ran or after it reported. Not the end of the
    /// worker: the file carries on, and the parent counts it as a file error.
    #[serde(rename = "unhandled")]
    Unhandled(WorkerError),
}

/// A non-result error from the worker (load failure, uncaught, timeout
/// synthesised by the parent).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerError {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    pub message: String,
    /// The error's code: the thrown error's own when the worker sent it, one
    /// of [`codes`] when the pool diagnosed the file itself.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stack: Option<String>,
}

impl WorkerError {
    /// A file error the pool diagnosed itself, under one of [`codes`]. The
    /// pool fills `file` in once the file settles.
    pub fn coded(code: &str, message: impl Into<String>) -> Self {
        Self {
            file: None,
            message: message.into(),
            code: Some(code.to_string()),
            stack: None,
        }
    }
}

/// The codes the engine raises, declared on the TypeScript side in
/// `src/errors.ts` as the classes of helix's `errors` namespace.
pub mod codes {
    /// A test, a hook or a whole file ran past its deadline.
    pub const TIMEOUT: &str = "E_HELIX_TIMEOUT";
    /// A worker failed outside the tests: it could not start, sent a broken
    /// frame, exited without a result, or exited in a way its result does not
    /// explain.
    pub const WORKER_FAILED: &str = "E_HELIX_WORKER_FAILED";
    /// An invariant of helix itself broke. The engine's own refusals are this
    /// too: the TypeScript side resolves `root` and hands over the file list,
    /// so reaching one is a bug in helix.
    pub const INTERNAL: &str = "E_HELIX_INTERNAL";
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn nested_frame() -> Value {
        json!({
            "type": "result",
            "result": {
                "file": "/a.test.ts",
                "suites": [{
                    "name": "outer",
                    "fullName": "outer",
                    "status": "fail",
                    "durationMs": 3,
                    "hookErrors": [],
                    "children": [
                        {
                            "name": "inner",
                            "fullName": "outer > inner",
                            "status": "fail",
                            "durationMs": 2,
                            "hookErrors": [{ "name": "Error", "message": "afterAll broke" }],
                            "children": [{
                                "name": "leaf",
                                "fullName": "outer > inner > leaf",
                                "status": "fail",
                                "durationMs": 1,
                                "error": { "name": "Error", "message": "boom" },
                                "errorPhase": "teardown"
                            }]
                        },
                        {
                            "name": "sibling",
                            "fullName": "outer > sibling",
                            "status": "pass",
                            "durationMs": 1
                        }
                    ]
                }],
                "tests": [],
                "totals": { "pass": 1, "fail": 1, "skip": 0, "todo": 0 },
                "durationMs": 3
            }
        })
    }

    fn file_result(frame: Value) -> FileResult {
        match serde_json::from_value::<WorkerOutgoing>(frame) {
            Ok(WorkerOutgoing::Result { result }) => result,
            other => panic!("expected a result frame, got {:?}", other),
        }
    }

    #[test]
    fn a_nested_suite_stays_a_suite_with_its_children_and_hook_errors() {
        let result = file_result(nested_frame());
        let outer = &result.suites[0];
        let Some(SuiteChild::Suite(inner)) = outer.children.first() else {
            panic!(
                "the nested describe was read as a test: {:?}",
                outer.children
            );
        };
        assert_eq!(inner.full_name, "outer > inner");
        assert_eq!(inner.hook_errors.len(), 1);
        assert_eq!(inner.hook_errors[0].message, "afterAll broke");
        let Some(SuiteChild::Test(leaf)) = inner.children.first() else {
            panic!("the leaf was not read as a test");
        };
        assert_eq!(leaf.full_name, "outer > inner > leaf");
        assert!(matches!(outer.children.get(1), Some(SuiteChild::Test(_))));
    }

    #[test]
    fn re_serialising_keeps_the_tree_and_the_error_phase() {
        let result = file_result(nested_frame());
        let out = serde_json::to_value(&result).expect("serialises");
        let inner = &out["suites"][0]["children"][0];
        assert_eq!(inner["children"][0]["name"], "leaf");
        assert_eq!(inner["children"][0]["errorPhase"], "teardown");
        assert_eq!(inner["hookErrors"][0]["message"], "afterAll broke");
        // A test with no phase does not grow a null one.
        assert!(out["suites"][0]["children"][1].get("errorPhase").is_none());
    }

    #[test]
    fn an_error_code_survives_the_frame_both_ways() {
        let frame = json!({
            "type": "result",
            "result": {
                "file": "/t.test.ts",
                "suites": [],
                "tests": [{
                    "name": "slow",
                    "fullName": "slow",
                    "status": "fail",
                    "durationMs": 50,
                    "error": {
                        "name": "Exception",
                        "message": "slow exceeded 50ms timeout",
                        "code": "E_HELIX_TIMEOUT"
                    }
                }, {
                    "name": "plain",
                    "fullName": "plain",
                    "status": "fail",
                    "durationMs": 1,
                    "error": { "name": "Error", "message": "boom" }
                }],
                "totals": { "pass": 0, "fail": 2, "skip": 0, "todo": 0 },
                "durationMs": 51
            }
        });
        let result = file_result(frame);
        let error = result.tests[0].error.as_ref().expect("an error");
        assert_eq!(error.code.as_deref(), Some("E_HELIX_TIMEOUT"));
        let out = serde_json::to_value(&result).expect("serialises");
        assert_eq!(out["tests"][0]["error"]["code"], "E_HELIX_TIMEOUT");
        // An error without a code does not grow a null one.
        assert!(out["tests"][1]["error"].get("code").is_none());

        let fatal = serde_json::from_value::<WorkerOutgoing>(json!({
            "type": "error",
            "message": "cannot load",
            "code": "ERR_MODULE_NOT_FOUND"
        }));
        let Ok(WorkerOutgoing::Error(error)) = fatal else {
            panic!("expected an error frame, got {:?}", fatal);
        };
        assert_eq!(error.code.as_deref(), Some("ERR_MODULE_NOT_FOUND"));
    }

    #[test]
    fn a_pool_diagnosis_carries_its_code() {
        let error = WorkerError::coded(codes::WORKER_FAILED, "worker exited");
        assert_eq!(error.code.as_deref(), Some("E_HELIX_WORKER_FAILED"));
        assert_eq!(error.message, "worker exited");
        assert!(error.file.is_none());
        let out = serde_json::to_value(&error).expect("serialises");
        assert_eq!(out["code"], "E_HELIX_WORKER_FAILED");
    }

    /// A describe tree nested `levels` deep, as the worker would frame it.
    /// Built as text: a `Value` that deep would itself recurse to drop.
    fn deep_frame(levels: usize) -> String {
        let mut text = String::from(
            r#"{"type":"result","result":{"file":"/d.test.ts","tests":[],"totals":{"pass":1,"fail":0,"skip":0,"todo":0},"durationMs":0,"suites":["#,
        );
        for level in 0..levels {
            text.push_str(&format!(
                r#"{{"name":"s{level}","fullName":"s{level}","status":"pass","durationMs":0,"hookErrors":[],"children":["#
            ));
        }
        text.push_str(r#"{"name":"leaf","fullName":"leaf","status":"pass","durationMs":0}"#);
        for _ in 0..levels {
            text.push_str("]}");
        }
        text.push_str("]}}");
        text
    }

    #[test]
    fn a_deep_but_legal_tree_survives_the_pool_parse_path() {
        // The pool parses a frame into a Value, then into the typed message.
        let value: Value = serde_json::from_str(&deep_frame(40)).expect("parses");
        let result = file_result(value);
        let mut depth = 0;
        let mut suite = &result.suites[0];
        while let Some(SuiteChild::Suite(child)) = suite.children.first() {
            suite = child;
            depth += 1;
        }
        assert_eq!(depth, 39);
        serde_json::to_string(&result).expect("re-serialises");
    }

    #[test]
    fn a_tree_past_the_nesting_limit_is_an_error_not_a_crash() {
        // Run on a small stack: an unbounded recursion would overflow it and
        // abort the process, which across NAPI takes the whole CLI down.
        let outcome = std::thread::Builder::new()
            .stack_size(256 * 1024)
            .spawn(|| {
                let text = deep_frame(10_000);
                (
                    serde_json::from_str::<Value>(&text).is_err(),
                    serde_json::from_str::<WorkerOutgoing>(&text).is_err(),
                )
            })
            .expect("spawns")
            .join()
            .expect("no panic, no overflow");
        assert_eq!(outcome, (true, true));
    }
}
