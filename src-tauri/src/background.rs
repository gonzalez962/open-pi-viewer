#[derive(Debug, PartialEq, Eq)]
pub enum CloseAction {
    Hide,
    Close,
}

pub fn close_action(tray_available: bool, exiting: bool) -> CloseAction {
    if tray_available && !exiting {
        CloseAction::Hide
    } else {
        CloseAction::Close
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn closing_window_with_tray_keeps_runtime_alive() {
        assert_eq!(close_action(true, false), CloseAction::Hide);
    }

    #[test]
    fn explicit_exit_and_missing_tray_allow_normal_cleanup() {
        assert_eq!(close_action(true, true), CloseAction::Close);
        assert_eq!(close_action(false, false), CloseAction::Close);
        assert_eq!(close_action(false, true), CloseAction::Close);
    }
}
