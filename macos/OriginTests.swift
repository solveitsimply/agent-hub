import Foundation

@main
struct OriginTests {
    static func main() {
        let valid = HubOrigin(" https://hub.example.invalid/ ")!
        for value in ["http://hub.example.invalid", "https://user:secret@hub.example.invalid",
                      "https://hub.example.invalid/path", "https://hub.example.invalid?token=secret",
                      "https://hub.example.invalid#secret", "file:///tmp/hub", "javascript:alert(1)",
                      "https://", "https://hub.example.invalid:0", "https://hub.example.invalid:65536"] {
            precondition(HubOrigin(value) == nil, "Accepted an unsafe origin")
        }
        for value in ["https://hub.example.invalid/api/me", "https://HUB.example.invalid:443/", "https://hub.example.invalid/#top"] {
            precondition(valid.contains(URL(string: value)!), "Rejected same-origin navigation")
        }
        for value in ["https://other.example.invalid/", "http://hub.example.invalid/", "https://hub.example.invalid:444/",
                      "https://hub.example.invalid.evil.invalid/", "https://user@hub.example.invalid/",
                      "file:///tmp/hub", "codex://threads/example"] {
            precondition(!valid.contains(URL(string: value)!), "Allowed cross-origin navigation")
        }
        precondition(HubOrigin("https://hub.example.invalid:8443")!.contains(URL(string: "https://hub.example.invalid:8443/api/me")!))
        print("Mac connection tests passed: HTTPS configuration, credential refusal and exact-origin navigation.")
    }
}
