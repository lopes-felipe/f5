# Keep Awake

The main process owns one controller for all profiles. Preferences live in
userData/keep-awake.json; keep-awake-lid.json is a recovery marker, not a
preference. No HTTP or agent tool can change keep-awake preferences.

Idle sleep uses Electron's prevent-app-suspension assertion. The opt-in Keep
display on preference swaps it for prevent-display-sleep, which also blocks idle
display sleep and the idle screen lock. The controller holds exactly one blocker
and starts a replacement before stopping the old one. Display-on falls back to
prevent-app-suspension while a closed internal-only panel is darkened, and under
the battery (<20% or unknown) and thermal holds. macOS closed-lid
support uses the global pmset disablesleep flag. The controller only resets
flags associated with its recovery marker. Other utilities can race the
read-then-write operation because pmset has no atomic compare-and-swap.

The optional sudoers rule permits exactly two pmset commands. Any process
running as the same user can invoke them; the preload gesture gate only
protects F5's renderer IPC path. Existing compatible rules can be reused.

Automated tests never invoke real sudo or change sleep settings. Watchdog
integration tests use a stub executable and require permission to inspect
process identities. Agent sandbox restrictions can skip those tests.

Watchdogs wait for a commitment over stdin after their process group is
persisted. Startup fences all new sleep writes until the previous watchdog's
entire process group has exited, including privileged reset children. If that
cannot be verified, recovery remains pending. Markers from before the current
system boot bypass obsolete process identities because those processes cannot
survive a reboot. Markers require protocol 2.

Each main-process power write also has a durably registered process group. The
watchdog waits for that group to exit before resetting sleep. A command timeout
requests termination but never claims that a privileged child has stopped.

A corrupt recovery marker is deliberately fail-closed: permission checks still
run and recovery is retried, but F5 cannot safely infer ownership from corrupt
data. Transient power-state read failures only pause the current attempt.

Permission and installed-rule status are cached. After changing sudoers outside
F5, toggle the lid setting or restart F5 to refresh them. Reading settings never
runs sudo.

## Desktop acceptance checks

Run from a normal Terminal with a desktop build:

1. Select Always. Check pmset -g assertions for the idle sleep assertion.
   Let the display turn off and lock. Select Off and verify assertion removal.
2. Enable the lid switch. Check pmset -g for SleepDisabled 1. Close the lid
   with only internal displays, test on battery and AC, and verify reachability
   from a second device and a dark panel within about five seconds.
3. Quit and verify SleepDisabled 0. Re-enable, force-kill the Electron main
   process, and verify recovery within about five seconds. Relaunch immediately
   and verify an old watchdog does not reset a new engagement. Test update
   installation while engaged.
4. Select While agents are working. Start a turn and close all windows. Verify
   the assertion remains through the turn and about five minutes afterward.
5. While engaged, manually run sudo pmset -a disablesleep 0. Verify F5 pauses
   until demand restarts or settings change. With another utility holding
   SleepDisabled 1, verify F5 reports an external override without resetting it.
6. On an admin account without a compatible rule, use Set up and Remove
   permission. Verify only /etc/sudoers.d/f5-keep-awake is installed/removed.
7. Select Always and enable Keep display on. Check pmset -g assertions for an
   F5 PreventUserIdleDisplaySleep assertion.
   Stay idle past the displaysleep timeout and verify the screen stays on and
   unlocked. With the lid switch engaged and only the internal display, close
   the lid: the panel goes dark and the assertion drops back to NoIdleSleep;
   reopening restores PreventUserIdleDisplaySleep.

Real closed-lid, administrator prompt, crash, and update checks require a
normal desktop session; they cannot be certified by mocked unit tests.
