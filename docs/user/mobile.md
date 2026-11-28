# F5 Phone access

The iPhone companion uses iOS 17 or later. Agents, projects, and files stay on the F5 host. Closing the app or losing the connection leaves turns running on the host.

Milestone 0 covers pairing, live conversations, approvals, questions, Stop, and APNs. The reply composer, durable sends, and new conversations follow physical TestFlight acceptance.

## Pair a phone

1. Connect the F5 host and iPhone to the same Tailscale network. For a Linux VM profile, connect the VM itself.
2. Open **Settings → Phone access** from F5 desktop or the web UI served by the host. Turn on **Allow paired phones**. If F5 found Tailscale without its CLI, confirm the detected address against Tailscale.
3. Choose **Pair a phone**. Open F5 on the phone and scan the QR code, or enter the displayed origin and ten-character code. Check the address on the confirmation sheet. Each code expires after five minutes and works once.
4. Allow local-network access if iOS asks. Open **Needs you** to see pending approvals and questions, including requests that arrived before pairing. Open a conversation to follow the agent or respond to a supported request.

Phone access binds to the Tailscale interface and starts with port 37730. F5 saves the selected port for the profile. The QR offers MagicDNS and the numeric Tailscale address when both are available. If MagicDNS is unavailable, enter the numeric origin shown for the host. If iOS denies local-network access, allow it in iOS Settings before retrying.

Turn Phone access off to disconnect phones temporarily. Choose **Revoke** beside a paired device to invalidate its token and force it to pair again. **Forget server** on the phone deletes its local credentials. A restored host profile receives a fresh identity and requires new pairing.

## Apple setup and TestFlight

Create explicit iOS App IDs for `io.github.lopesfelipe.f5.mobile` and, if needed, `io.github.lopesfelipe.f5.mobile.dev`. Enable Push Notifications on each ID. Create an iOS app record for the production bundle ID in App Store Connect and configure automatic signing for the team. The desktop Developer ID certificate is separate.

Set `ASC_TEAM_ID` on the repository’s `testflight` GitHub environment. Add `ASC_KEY_ID`, `ASC_ISSUER_ID`, and the App Store Connect API private key in `ASC_KEY_P8` as environment secrets. Run **Upload iOS build to TestFlight** from the default branch. App Store Connect processes the archive before testers can install it.

Create an APNs signing key from the same Apple team as the app. In **Settings → Phone access** on the host, enter the team ID, APNs key ID, and bundle ID, then upload the APNs `.p8` file and save. The APNs key is separate from the App Store Connect key. Pair the phone, grant notifications, and choose **Send test notification** beside the device after push registration appears. TestFlight uses production APNs. Self-builders use their own bundle ID and team key. Personal Team builds omit push.

F5 sends generic notification text by default. Push delivery pauses while the host sleeps. **Settings → Threads → Keep the host awake while agents work** helps while a turn is running.

## Physical iPhone acceptance

Record the TestFlight build, host version, iOS version, network, and results before opening Milestone 1.

- Pair by QR over Tailscale. Check HTTP, WebSocket, and attachment access with the MagicDNS and numeric origins. Repeat with local-network permission denied. Record which origins iOS accepts.
- Open a host profile with an approval and a question already pending. Check both appear in **Needs you** before opening the conversation. Approve from the phone and confirm the request resolves on the host.
- Lock the iPhone and trigger a new approval. Record production push latency against the five-second target.
- Leave the socket idle for 90 seconds. On LTE, record gzip shell bytes, decode time, and time to first render for the largest available profile and for a 100-project, 2,000-thread fixture. Add activity paging before rollout if the gzip shell exceeds 1 MB.
- Run the mobile v1 compatibility tests with a changed desktop protocol number. Confirm the same installed build still connects.
- Switch Wi-Fi to cellular during a response, toggle Tailscale, revoke the device, and put the host to sleep. Check reconnection, duplicate-free text, credential removal on revocation, and the offline state.

If iOS App Transport Security rejects every plain HTTP origin, hold rollout and validate a Tailscale HTTPS endpoint before using it with credentials. The phone still needs a verified connection to the same server.
