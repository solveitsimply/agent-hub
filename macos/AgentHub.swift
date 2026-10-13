import AppKit
import WebKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var origin: HubOrigin?
    private var connectionSheet: NSAlert?

    func applicationDidFinishLaunching(_ notification: Notification) {
        makeMenu()
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1200, height: 820),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "Agent Hub"
        window.minSize = NSSize(width: 390, height: 600)
        window.isReleasedWhenClosed = false
        window.setFrameAutosaveName("AgentHubWindow")
        if !window.setFrameUsingName("AgentHubWindow") { window.center() }
        resetWebView()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        if let saved = UserDefaults.standard.string(forKey: "hubURL"), let target = HubOrigin(saved) {
            origin = target
            loadHub()
        } else {
            configureConnection(nil)
        }
    }

    private func resetWebView() {
        webView?.stopLoading()
        let configuration = WKWebViewConfiguration()
        // Each launch/connection gets isolated, memory-only browser storage.
        configuration.websiteDataStore = .nonPersistent()
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        window.contentView = webView
    }

    private func makeMenu() {
        let bar = NSMenu()
        let appMenu = NSMenu()
        let appItem = NSMenuItem()
        appItem.submenu = appMenu
        bar.addItem(appItem)
        appMenu.addItem(withTitle: "About Agent Hub", action: #selector(showAbout), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Connection Settings…", action: #selector(configureConnection(_:)), keyEquivalent: ",")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide Agent Hub", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Agent Hub", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let edit = NSMenu(title: "Edit")
        let editItem = NSMenuItem(title: "Edit", action: nil, keyEquivalent: "")
        editItem.submenu = edit
        bar.addItem(editItem)
        for (name, selector, key) in [("Undo", "undo:", "z"), ("Cut", "cut:", "x"),
                                      ("Copy", "copy:", "c"), ("Paste", "paste:", "v"),
                                      ("Select All", "selectAll:", "a")] {
            edit.addItem(withTitle: name, action: Selector(selector), keyEquivalent: key)
        }
        let view = NSMenu(title: "View")
        let viewItem = NSMenuItem(title: "View", action: nil, keyEquivalent: "")
        viewItem.submenu = view
        bar.addItem(viewItem)
        view.addItem(withTitle: "Reload Dashboard…", action: #selector(reloadDashboard), keyEquivalent: "r")
        view.addItem(withTitle: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
            .keyEquivalentModifierMask = [.control, .command]
        let windows = NSMenu(title: "Window")
        let windowsItem = NSMenuItem(title: "Window", action: nil, keyEquivalent: "")
        windowsItem.submenu = windows
        bar.addItem(windowsItem)
        windows.addItem(withTitle: "Minimize", action: #selector(NSWindow.miniaturize(_:)), keyEquivalent: "m")
        NSApp.windowsMenu = windows
        NSApp.mainMenu = bar
    }

    @objc private func showAbout() {
        NSApp.orderFrontStandardAboutPanel(options: [
            .applicationName: "Agent Hub", .applicationVersion: "0.1.0",
            .credits: NSAttributedString(string: "Your coordination dashboard on this Mac.\nConnect to your own hosted Hub.")
        ])
    }

    @objc private func configureConnection(_ sender: Any?) {
        guard connectionSheet == nil else { return }
        let alert = NSAlert()
        alert.messageText = "Connect to Agent Hub"
        alert.informativeText = "Enter your hosted Hub’s HTTPS address. Changing it disconnects the current dashboard. Access tokens are entered only in the dashboard and stay in memory."
        let field = NSTextField(string: origin?.url.absoluteString ?? "")
        field.placeholderString = "https://hub.example.com"
        field.frame = NSRect(x: 0, y: 0, width: 360, height: 24)
        field.setAccessibilityLabel("Hub HTTPS address")
        alert.accessoryView = field
        alert.addButton(withTitle: "Connect")
        alert.addButton(withTitle: "Cancel")
        connectionSheet = alert
        alert.beginSheetModal(for: window) { [weak self] response in
            guard let self else { return }
            self.connectionSheet = nil
            guard response == .alertFirstButtonReturn else { return }
            guard let target = HubOrigin(field.stringValue) else {
                self.showError("Enter an HTTPS origin, such as https://hub.example.com, without a path, credentials, query or fragment.")
                return
            }
            self.origin = target
            UserDefaults.standard.set(target.url.absoluteString, forKey: "hubURL")
            self.resetWebView()
            self.loadHub()
        }
        window.makeFirstResponder(field)
    }

    private func loadHub() {
        guard let origin else { return }
        window.subtitle = origin.url.host ?? ""
        webView.load(URLRequest(url: origin.url))
    }

    @objc private func reloadDashboard() {
        guard origin != nil else { configureConnection(nil); return }
        let alert = NSAlert()
        alert.messageText = "Reload the dashboard?"
        alert.informativeText = "Reloading clears your sign-in and any unsent draft. Use the dashboard’s Refresh button to check for updates while staying connected."
        alert.addButton(withTitle: "Reload")
        alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) { [weak self] result in
            if result == .alertFirstButtonReturn { self?.loadHub() }
        }
    }

    private func showError(_ message: String) {
        let alert = NSAlert()
        alert.messageText = "Agent Hub"
        alert.informativeText = message
        alert.addButton(withTitle: "OK")
        alert.beginSheetModal(for: window)
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        if origin?.contains(url) == true {
            // Keep same-origin new-window links within this isolated dashboard.
            if action.targetFrame == nil {
                decisionHandler(.cancel)
                webView.load(action.request)
            } else { decisionHandler(.allow) }
            return
        }
        decisionHandler(.cancel)
        // Only a deliberate HTTP(S) link can open the user's default browser.
        // Redirects, script navigation and custom app schemes cannot launch apps.
        if action.navigationType == .linkActivated,
           action.sourceFrame.isMainFrame,
           ["https", "http"].contains(url.scheme?.lowercased() ?? ""),
           url.user == nil, url.password == nil {
            NSWorkspace.shared.open(url)
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        reportLoadFailure(error)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        guard let url = frame.request.url, frame.isMainFrame, origin?.contains(url) == true else {
            completionHandler(false)
            return
        }
        // The dashboard uses confirm() for releasing claims, revoking and archiving.
        let alert = NSAlert()
        alert.messageText = "Confirm dashboard action"
        alert.informativeText = message
        alert.addButton(withTitle: "Cancel")
        alert.addButton(withTitle: "Continue")
        alert.beginSheetModal(for: window) { result in
            completionHandler(result == .alertSecondButtonReturn)
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        reportLoadFailure(error)
    }

    private func reportLoadFailure(_ error: Error) {
        guard (error as NSError).code != NSURLErrorCancelled else { return }
        // Don't display/log failing URLs: a future navigation may contain private data.
        showError("The dashboard could not be loaded. Check your internet connection and Hub address, then use View → Reload Dashboard. You can change the address in Connection Settings.")
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        showError("The dashboard stopped. Use View → Reload Dashboard to reconnect.")
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        window.makeKeyAndOrderFront(nil)
        return true
    }
}

@main
struct AgentHubMain {
    @MainActor static func main() {
        let application = NSApplication.shared
        let delegate = AppDelegate()
        application.delegate = delegate
        application.setActivationPolicy(.regular)
        withExtendedLifetime(delegate) { application.run() }
    }
}
