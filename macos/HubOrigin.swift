import Foundation

// Connection preferences contain an origin only. Never accept credentials or tokens.
struct HubOrigin {
    let url: URL

    init?(_ value: String) {
        guard let parts = URLComponents(string: value.trimmingCharacters(in: .whitespacesAndNewlines)),
              parts.scheme?.lowercased() == "https",
              let host = parts.host, !host.isEmpty,
              parts.user == nil, parts.password == nil,
              parts.query == nil, parts.fragment == nil,
              parts.path.isEmpty || parts.path == "/",
              parts.port == nil || (1...65535).contains(parts.port!),
              let url = parts.url else { return nil }
        self.url = url
    }

    func contains(_ candidate: URL) -> Bool {
        candidate.scheme?.lowercased() == "https" &&
        candidate.host?.lowercased() == url.host?.lowercased() &&
        (candidate.port ?? 443) == (url.port ?? 443) &&
        candidate.user == nil && candidate.password == nil
    }
}
