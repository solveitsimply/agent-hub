# Agent Hub for macOS

The native app opens your existing hosted Hub in an isolated WebKit window.
It uses macOS frameworks only and runs on macOS 13 or later. Internet access
and a deployed Hub are required. It does not start the disposable local fixture
or create another database, deployment, agent session or background service.

With Apple's Command Line Tools installed, build for the current Mac:

```sh
bash scripts/build-macos.sh
```

The build runs the HTTPS origin tests, compiles the app and creates a local
ad-hoc signature. Copy `.build/macos/Agent Hub.app` into Applications and open
it. This local build is not notarized for distribution to other Macs.

On first launch, enter your Hub's HTTPS origin in Connection Settings. The
address is saved in this Mac user's application preferences, outside source
control. Enter your owner or invitation token directly in the dashboard.
Browser storage is ephemeral; tokens are never added to app preferences,
arguments or URLs. Quitting, reloading or switching the Hub requires signing
in again. Use the dashboard's Refresh button to check for updates without
reloading. Standard Mac copy, paste, window and quit shortcuts are available.

The embedded window stays on the configured HTTPS origin. Deliberately clicked
HTTP(S) documentation links open in the default browser. Cross-origin redirects
and custom app schemes are refused. All existing project/principal permissions
and message custody remain enforced by the hosted application.

Use **Agent Hub → Connection Settings…** (`⌘,`) to change the Hub address, or
**View → Reload Dashboard…** (`⌘R`) to retry loading after a connection failure.
Closing the window keeps the current in-memory connection; opening the app
again restores the window. **Quit Agent Hub** (`⌘Q`) ends the connection.
