use f5_computer_fixture::{command, Command};

#[cfg(windows)]
mod stop;
#[cfg(windows)]
mod window;

fn main() {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    match command(&args) {
        Ok(Command::Check) => {
            // No window, input, capture, accessibility request or helper connection.
            println!(
                "{}",
                serde_json::json!({
                    "protocolVersion": 1, "fixtureVersion": "1.0.0",
                    "platform": if cfg!(windows) { "win32" } else { "unsupported" },
                    "kind": "synthetic-native-window", "windowCreated": false,
                    "nativeInputAvailable": false,
                })
            );
        }
        Ok(Command::VerifyCapture) => {
            if f5_computer_fixture::capture::run().is_err() {
                eprintln!("Synthetic capture verification failed");
                std::process::exit(1);
            }
        }
        Ok(Command::Run(mode)) => {
            #[cfg(windows)]
            if window::run(mode).is_err() {
                eprintln!("Synthetic Windows fixture failed");
                std::process::exit(1);
            }
            #[cfg(not(windows))]
            {
                let _ = mode;
                eprintln!("Synthetic Windows fixture requires Windows");
                std::process::exit(1);
            }
        }
        Ok(Command::Stop) => {
            #[cfg(windows)]
            if stop::run().is_err() {
                std::process::exit(1);
            }
            #[cfg(not(windows))]
            std::process::exit(1);
        }
        Err(message) => {
            eprintln!("{message}");
            std::process::exit(1);
        }
    }
}
