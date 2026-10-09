#[cfg(windows)]
mod desktop;
#[cfg(any(windows, test))]
mod geometry;
mod permit;
#[cfg(any(windows, test))]
mod safety;
#[cfg(windows)]
fn main() {
    desktop::run();
}
#[cfg(not(windows))]
fn main() {
    eprintln!("F5 computer control requires Windows.");
    std::process::exit(1);
}
