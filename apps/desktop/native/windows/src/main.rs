#[cfg(any(windows, test))]
mod composition;
#[cfg(windows)]
mod desktop;
#[cfg(any(windows, test))]
mod geometry;
#[cfg(any(windows, test))]
mod inspection;
mod permits;
#[cfg(any(windows, test))]
mod protocol;
#[cfg(any(windows, test))]
mod safety;
#[cfg(any(windows, test))]
mod scheduler;
#[cfg(any(windows, test))]
mod timing;
#[cfg(any(windows, test))]
mod traversal;
#[cfg(windows)]
fn main() {
    desktop::run();
}
#[cfg(not(windows))]
fn main() {
    eprintln!("F5 computer control requires Windows.");
    std::process::exit(1);
}
