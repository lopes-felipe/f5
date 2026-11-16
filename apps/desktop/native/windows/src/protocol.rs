use serde_json::{json, Value};

/// Only a pre-write interruption is retryable. A partly posted action needs recovery.
pub fn interrupted_response(mut error: Value, action_started: bool) -> Value {
    if error["_tag"] == "Interrupted" {
        if action_started {
            return json!({"_tag":"OutcomeUnknown"});
        }
        error["actionStarted"] = json!(false);
    }
    error
}

pub fn encode_packet(value: &Value, maximum: usize) -> Option<Vec<u8>> {
    let bytes = serde_json::to_vec(value).ok()?;
    if bytes.len() <= maximum {
        return Some(bytes);
    }
    if value["type"] != "response" {
        return None;
    }
    let id = value["requestId"].as_str()?;
    let bounded = serde_json::to_vec(
        &json!({"type":"response","requestId":id,"error":{"_tag":"ResultTooLarge"}}),
    )
    .ok()?;
    (bounded.len() <= maximum).then_some(bounded)
}
/// Preserve background activation recovery, while treating foreground post-dispatch failures as ambiguous.
pub fn action_response(error: Value, action_started: bool, background: bool) -> Value {
    if action_started && !background {
        json!({"_tag":"OutcomeUnknown"})
    } else {
        interrupted_response(error, action_started)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn foreground_failures_after_dispatch_are_unknown() {
        for tag in ["Interrupted", "Execution", "StaleElement", "TargetBlocked"] {
            assert_eq!(
                action_response(json!({"_tag":tag}), true, false),
                json!({"_tag":"OutcomeUnknown"})
            );
        }
        let recovery = json!({"_tag":"ForegroundRequired","reason":"activation-side-effect"});
        assert_eq!(action_response(recovery.clone(), true, true), recovery);
        assert_eq!(
            action_response(json!({"_tag":"Interrupted"}), false, true)["actionStarted"],
            false
        );
    }
    #[test]
    fn preflight_interruption_is_retryable_but_partial_input_is_unknown() {
        for cause in ["user-input", "permit-expired"] {
            let failure = json!({"_tag":"Interrupted","cause":cause});
            assert_eq!(
                interrupted_response(failure.clone(), false),
                json!({"_tag":"Interrupted","cause":cause,"actionStarted":false})
            );
            assert_eq!(
                interrupted_response(failure, true),
                json!({"_tag":"OutcomeUnknown"})
            );
        }
        let failure = json!({"_tag":"ForegroundRequired","reason":"activation-side-effect"});
        assert_eq!(interrupted_response(failure.clone(), true), failure);
    }
    #[test]
    fn oversized_response_returns_correlated_error_without_crashing_transport() {
        let value = json!({"type":"response","requestId":"r","result":{"data":"é".repeat(256)}});
        let encoded = encode_packet(&value, 128).unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&encoded).unwrap(),
            json!({"type":"response","requestId":"r","error":{"_tag":"ResultTooLarge"}})
        );
        assert!(encoded.len() <= 128);
        assert!(encode_packet(&json!({"type":"status","data":"x".repeat(256)}), 128).is_none());
    }
}
