//! Synthetic fixture state only. No helper protocol, grants or input injection.
pub const EXPECTED_TEXT: &str = "F5_WINDOWS_REHEARSAL Ω🙂";
pub const ELECTRON_TEXT: &str = "F5_ELECTRON_REHEARSAL Ω🙂";
pub const SECURE_TEXT: &str = "F5_SYNTHETIC_PASSWORD_SENTINEL";
pub mod capture;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Mode {
    Granted,
    Ungranted,
    Shaped,
    Transparent,
}

#[derive(Debug, PartialEq)]
pub enum Command {
    Check,
    Run(Mode),
    Stop,
    VerifyCapture,
}

pub fn command(args: &[String]) -> Result<Command, &'static str> {
    match args
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        ["--check"] => Ok(Command::Check),
        ["--run-stop"] => Ok(Command::Stop),
        ["--verify-capture"] => Ok(Command::VerifyCapture),
        ["--run"] => Ok(Command::Run(Mode::Granted)),
        ["--run", "--ungranted"] => Ok(Command::Run(Mode::Ungranted)),
        ["--run", "--shaped"] => Ok(Command::Run(Mode::Shaped)),
        ["--run", "--transparent"] => Ok(Command::Run(Mode::Transparent)),
        _ => Err("Explicit --check or --run [--ungranted|--shaped|--transparent] required"),
    }
}

/// Commands can affect this synthetic window only, never a supplied HWND or app.
#[derive(Debug, PartialEq)]
pub enum WindowCommand {
    Reset,
    PerformanceTree { nodes: usize },
    DelayButton,
    DelayedInput,
    PasswordTransition,
    Status,
    Close,
    Place { x: i32, y: i32 },
    Fullscreen,
    Restore,
    ReplaceInput,
    Cue(&'static str),
}
impl WindowCommand {
    pub fn parse(line: &str) -> Option<Self> {
        match line.split_whitespace().collect::<Vec<_>>().as_slice() {
            ["performance-reset"] => Some(Self::Reset),
            ["performance-tree", nodes] => nodes
                .parse::<usize>()
                .ok()
                .filter(|nodes| (1..=800).contains(nodes))
                .map(|nodes| Self::PerformanceTree { nodes }),
            ["performance-delayed-button"] => Some(Self::DelayButton),
            ["performance-delayed-input"] => Some(Self::DelayedInput),
            ["performance-password-transition"] => Some(Self::PasswordTransition),
            ["status"] => Some(Self::Status),
            ["close"] => Some(Self::Close),
            ["fullscreen"] => Some(Self::Fullscreen),
            ["restore"] => Some(Self::Restore),
            ["replace-input"] => Some(Self::ReplaceInput),
            ["PROFILE_HOLD"] => Some(Self::Cue("Isolation waiting")),
            ["PROFILE_RELEASE"] => Some(Self::Cue("Isolation released")),
            ["WINDOWLESS_READY"] => Some(Self::Cue("Ready: keep input idle")),
            ["WINDOWLESS_COUNTDOWN_3"] => Some(Self::Cue("Starting in 3")),
            ["WINDOWLESS_COUNTDOWN_2"] => Some(Self::Cue("Starting in 2")),
            ["WINDOWLESS_COUNTDOWN_1"] => Some(Self::Cue("Starting in 1")),
            ["WINDOWLESS_RUNNING"] => Some(Self::Cue("Running: keep input idle")),
            ["WINDOWLESS_FINISHED"] => Some(Self::Cue("Finished: click Finish check")),
            ["place", x, y] => {
                let (x, y): (i32, i32) = (x.parse().ok()?, y.parse().ok()?);
                if x.unsigned_abs() > 65536 || y.unsigned_abs() > 65536 {
                    return None;
                }
                Some(Self::Place { x, y })
            }
            _ => None,
        }
    }
}

#[derive(Default)]
pub struct Receipt {
    pub presses: u32,
    pub input_events: u32,
    pub secure_events: u32,
    pub expected_text_received: bool,
    pub overflow: bool,
}
impl Receipt {
    pub fn press(&mut self) {
        self.presses = self.presses.saturating_add(1);
        self.overflow |= self.presses > 100;
    }
    pub fn input(&mut self, text: &[u16], secure: bool) {
        if secure {
            self.secure_events = self.secure_events.saturating_add(1);
        } else {
            self.input_events = self.input_events.saturating_add(1);
            self.expected_text_received |= text.iter().copied().eq(EXPECTED_TEXT.encode_utf16())
                || text.iter().copied().eq(ELECTRON_TEXT.encode_utf16());
        }
        self.overflow |=
            text.len() > 10_000 || self.input_events > 10_000 || self.secure_events > 10_000;
    }
    pub fn summary(&self) -> serde_json::Value {
        serde_json::json!({
            "presses": self.presses.min(100),
            "inputEvents": self.input_events.min(10_000),
            "secureEvents": self.secure_events.min(10_000),
            "expectedSyntheticTextReceived": self.expected_text_received,
            "overflow": self.overflow,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn window_commands_accept_only_bounded_fixture_operations() {
        assert_eq!(
            WindowCommand::parse("performance-tree 380"),
            Some(WindowCommand::PerformanceTree { nodes: 380 })
        );
        for command in [
            "performance-tree 0",
            "performance-tree 801",
            "performance-tree 3.5",
            "performance-tree 380 extra",
        ] {
            assert_eq!(WindowCommand::parse(command), None);
        }
        assert_eq!(
            WindowCommand::parse("performance-password-transition"),
            Some(WindowCommand::PasswordTransition)
        );
        assert_eq!(
            WindowCommand::parse("place -1920 40"),
            Some(WindowCommand::Place { x: -1920, y: 40 })
        );
        for command in [
            "place -2147483648 0",
            "place 65537 0",
            "place 0 1 2",
            "focus 123",
            "shell x",
        ] {
            assert_eq!(WindowCommand::parse(command), None);
        }
    }
    #[test]
    fn check_cannot_launch_and_run_requires_explicit_scope() {
        assert_eq!(command(&["--check".into()]), Ok(Command::Check));
        assert_eq!(command(&["--run".into()]), Ok(Command::Run(Mode::Granted)));
        for args in [
            vec![],
            vec!["--check", "--run"],
            vec!["--run", "--shell"],
            vec!["--run", "--shaped", "--transparent"],
        ] {
            assert!(command(&args.into_iter().map(String::from).collect::<Vec<_>>()).is_err());
        }
    }
    #[test]
    fn receipts_never_include_editable_or_secure_text() {
        let mut state = Receipt::default();
        state.input(
            &"PRIVATE_SENTINEL".encode_utf16().collect::<Vec<_>>(),
            false,
        );
        state.input(&SECURE_TEXT.encode_utf16().collect::<Vec<_>>(), true);
        assert!(!state.expected_text_received);
        let summary = state.summary().to_string();
        assert!(!summary.contains("PRIVATE_SENTINEL"));
        assert!(!summary.contains(SECURE_TEXT));
        assert_eq!(state.secure_events, 1);
    }
    #[test]
    fn exact_unicode_value_is_independently_observed_and_counts_are_bounded() {
        let mut state = Receipt::default();
        state.input(&EXPECTED_TEXT.encode_utf16().collect::<Vec<_>>(), false);
        assert!(state.expected_text_received);
        for _ in 0..101 {
            state.press();
        }
        assert!(state.overflow);
        assert_eq!(state.summary()["presses"], 100);
        assert!(!state.summary().to_string().contains(EXPECTED_TEXT));
    }
}
