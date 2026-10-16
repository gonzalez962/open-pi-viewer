use std::collections::HashSet;

#[derive(Default)]
pub struct Activity {
    working: HashSet<String>,
    failed: HashSet<String>,
}

impl Activity {
    pub fn update(&mut self, channel: &str, event: &serde_json::Value) -> bool {
        let before = self.color(false);
        let Some(cwd) = event.get("cwd").and_then(|v| v.as_str()) else {
            return false;
        };
        if channel == "pi://event" {
            match event.get("type").and_then(|v| v.as_str()) {
                Some("agent_start") => {
                    self.failed.remove(cwd);
                    self.working.insert(cwd.to_owned());
                }
                Some("message_start" | "tool_execution_start") => {
                    self.working.insert(cwd.to_owned());
                }
                Some("agent_settled") => {
                    self.working.remove(cwd);
                }
                Some("tool_execution_end")
                    if event.get("isError").and_then(|v| v.as_bool()) == Some(true) =>
                {
                    self.failed.insert(cwd.to_owned());
                }
                _ => {}
            }
        } else if channel == "pi://error" {
            self.failed.insert(cwd.to_owned());
        } else if matches!(
            event.get("state").and_then(|v| v.as_str()),
            Some("disconnected" | "error")
        ) {
            self.working.remove(cwd);
            if event.get("state").and_then(|v| v.as_str()) == Some("error") {
                self.failed.insert(cwd.to_owned());
            }
        } else if event.get("state").and_then(|v| v.as_str()) == Some("connected") {
            self.failed.remove(cwd);
        }
        before != self.color(false)
    }

    pub fn color(&self, amber_phase: bool) -> [u8; 4] {
        if !self.failed.is_empty() {
            [248, 81, 73, 255]
        } else if self.busy() {
            if amber_phase {
                [210, 153, 34, 255]
            } else {
                [31, 111, 235, 255]
            }
        } else {
            [63, 185, 80, 255]
        }
    }

    pub fn busy(&self) -> bool {
        !self.working.is_empty()
    }
}

pub fn dotted_rgba(base: &[u8], width: u32, height: u32, dot_color: [u8; 4]) -> Vec<u8> {
    let mut pixels = base.to_vec();
    let radius = (width.min(height) as f64 * 0.18).max(1.0);
    let cx = width as f64 - radius - 1.0;
    let cy = height as f64 - radius - 1.0;
    for y in 0..height {
        for x in 0..width {
            let distance = ((x as f64 - cx).powi(2) + (y as f64 - cy).powi(2)).sqrt();
            if distance <= radius {
                let offset = ((y * width + x) * 4) as usize;
                let color = if distance > radius * 0.72 {
                    [255, 255, 255, 255]
                } else {
                    dot_color
                };
                if let Some(pixel) = pixels.get_mut(offset..offset + 4) {
                    pixel.copy_from_slice(&color);
                }
            }
        }
    }
    pixels
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn dot_remains_until_all_sessions_settle_or_exit() {
        let mut activity = Activity::default();
        assert!(activity.update("pi://event", &json!({"cwd":"a","type":"agent_start"})));
        assert!(!activity.update("pi://event", &json!({"cwd":"b","type":"agent_start"})));
        assert!(!activity.update("pi://event", &json!({"cwd":"a","type":"agent_settled"})));
        assert!(activity.busy());
        assert!(!activity.update(
            "pi://event",
            &json!({"cwd":"b","type":"agent_end","willRetry":true})
        ));
        assert!(activity.update(
            "pi://status-change",
            &json!({"cwd":"b","state":"disconnected"})
        ));
        assert!(!activity.busy());
    }

    #[test]
    fn failures_override_work_and_clear_on_recovery() {
        let mut activity = Activity::default();
        activity.update("pi://event", &json!({"cwd":"a","type":"agent_start"}));
        activity.update("pi://event", &json!({"cwd":"b","type":"agent_start"}));
        activity.update(
            "pi://event",
            &json!({"cwd":"a","type":"tool_execution_end","isError":true}),
        );
        assert_eq!(activity.color(false), [248, 81, 73, 255]);
        activity.update("pi://event", &json!({"cwd":"a","type":"agent_settled"}));
        assert_eq!(activity.color(true), [248, 81, 73, 255]);
        activity.update(
            "pi://status-change",
            &json!({"cwd":"a","state":"connected"}),
        );
        assert_eq!(activity.color(false), [31, 111, 235, 255]);
        assert_eq!(activity.color(true), [210, 153, 34, 255]);
        activity.update("pi://event", &json!({"cwd":"b","type":"agent_settled"}));
        assert_eq!(activity.color(false), [63, 185, 80, 255]);
        activity.update("pi://error", &json!({"cwd":"b","error":"broken"}));
        assert_eq!(activity.color(false), [248, 81, 73, 255]);
        activity.update("pi://event", &json!({"cwd":"b","type":"agent_start"}));
        assert_eq!(activity.color(false), [31, 111, 235, 255]);
        activity.update("pi://status-change", &json!({"cwd":"b","state":"error"}));
        assert_eq!(activity.color(true), [248, 81, 73, 255]);
        assert!(!activity.busy());
    }

    #[test]
    fn dot_overlay_preserves_base_and_dimensions() {
        let base = vec![0; 32 * 32 * 4];
        let dotted = dotted_rgba(&base, 32, 32, [63, 185, 80, 255]);
        let busy = dotted_rgba(&base, 32, 32, [31, 111, 235, 255]);
        assert!(busy.chunks_exact(4).any(|p| p == [31, 111, 235, 255]));
        assert!(!busy.chunks_exact(4).any(|p| p == [63, 185, 80, 255]));
        for color in [[210, 153, 34, 255], [248, 81, 73, 255]] {
            assert!(dotted_rgba(&base, 32, 32, color)
                .chunks_exact(4)
                .any(|p| p == color));
        }
        assert_eq!(base, vec![0; 32 * 32 * 4]);
        assert_eq!(dotted.len(), base.len());
        assert_eq!(&dotted[..4], &[0, 0, 0, 0]);
        assert!(dotted.chunks_exact(4).any(|p| p == [63, 185, 80, 255]));
    }
}
