import Foundation
import Observation

enum APIError: LocalizedError {
    case badRequest
    case signedOut
    case server(String)
    case transport(String)

    var errorDescription: String? {
        switch self {
        case .badRequest: "Could not build that request."
        case .signedOut: "Your session ended. Sign in again."
        case .server(let message): message
        case .transport(let message): message
        }
    }
}

/// Talks to the web app's /api/v1. Every rule lives on the server; this only
/// carries requests and keeps the session fresh.
@Observable
final class APIClient {
    /// One client per process. The app and its Shortcuts actions share it, so
    /// a refresh token rotated by one is never replayed by the other.
    static let shared = APIClient()

    private(set) var session: AuthSession?
    /// Where the web app runs. Debug builds can point elsewhere; see
    /// `adoptLaunchSession`.
    static let productionServer = URL(string: "https://your-api.vercel.app")!  // set to your deployed API
    private(set) var serverURL: URL = APIClient.productionServer

    var isSignedIn: Bool { session != nil }
    private let urlSession: URLSession
    private let cache: ResponseCache

    init(urlSession: URLSession = .shared, cache: ResponseCache = .shared) {
        self.urlSession = urlSession
        self.cache = cache
        self.session = Keychain.load()
        #if DEBUG
        adoptLaunchSession()
        #endif
    }

    #if DEBUG
    /// Simulator smoke tests: `FINANCE_SERVER` points the app at another
    /// server (e.g. localhost:3000 for `pnpm dev`), and `FINANCE_ACCESS_TOKEN`
    /// signs in without a password. Debug builds only.
    private func adoptLaunchSession() {
        let env = ProcessInfo.processInfo.environment
        if let server = env["FINANCE_SERVER"].flatMap(Self.normaliseServer) {
            serverURL = server
        }
        guard let token = env["FINANCE_ACCESS_TOKEN"], !token.isEmpty else { return }
        session = AuthSession(
            accessToken: token,
            refreshToken: "",
            expiresAt: Int(Date().timeIntervalSince1970) + 3000,
            email: "launch session"
        )
    }
    #endif

    static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return decoder
    }()

    static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.keyEncodingStrategy = .convertToSnakeCase
        return encoder
    }()

    /// Accepts "finance.example.com" or a full URL; no trailing slash.
    static func normaliseServer(_ text: String) -> URL? {
        var trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        while trimmed.hasSuffix("/") { trimmed.removeLast() }
        guard !trimmed.isEmpty else { return nil }
        if !trimmed.contains("://") {
            let local = trimmed.hasPrefix("localhost") || trimmed.hasPrefix("127.0.0.1")
            trimmed = (local ? "http://" : "https://") + trimmed
        }
        guard let url = URL(string: trimmed), url.host != nil else { return nil }
        return url
    }

    // MARK: Session

    func signIn(email: String, password: String) async throws {
        struct Body: Encodable { let email: String; let password: String }
        let fresh: AuthSession = try await perform(
            "POST", "auth/sign-in", body: Body(email: email, password: password), authorized: false
        )
        adopt(fresh)
    }

    func signOut() {
        session = nil
        Keychain.clear()
        cache.clear()
    }

    private func adopt(_ fresh: AuthSession) {
        session = fresh
        Keychain.save(fresh)
    }

    /// Refreshes a minute before expiry. A failed refresh signs out.
    private func validAccessToken() async throws -> String {
        guard let current = session else { throw APIError.signedOut }
        if Double(current.expiresAt) - Date().timeIntervalSince1970 > 60 {
            return current.accessToken
        }
        return try await refresh(current).accessToken
    }

    /// The refresh in flight. Requests that find the token expired at the
    /// same moment (launch fetches five at once) wait on this one instead of
    /// each spending the same refresh token.
    private var refreshing: Task<AuthSession, Error>?

    private func refresh(_ current: AuthSession) async throws -> AuthSession {
        if let refreshing { return try await refreshing.value }
        let task = Task { try await performRefresh(current) }
        refreshing = task
        defer { refreshing = nil }
        return try await task.value
    }

    private func performRefresh(_ current: AuthSession) async throws -> AuthSession {
        struct Body: Encodable { let refreshToken: String }
        do {
            let fresh: AuthSession = try await perform(
                "POST", "auth/refresh", body: Body(refreshToken: current.refreshToken), authorized: false
            )
            adopt(fresh)
            return fresh
        } catch {
            signOut()
            throw APIError.signedOut
        }
    }

    // MARK: Requests

    /// The last reply to this GET, if there was one. Shown while `get` runs.
    func cached<T: Decodable>(_ path: String, query: [String: String?] = [:]) -> T? {
        cache.value(ResponseCache.key(path, query: query))
    }

    /// Fetches and, unless `cache` is false, keeps the reply for `cached`.
    func get<T: Decodable>(_ path: String, query: [String: String?] = [:], cache: Bool = true) async throws -> T {
        let data = try await fetch("GET", path, query: query, payload: nil)
        let value: T = try Self.decode(data)
        // A reply that lands after sign out belongs to nobody.
        if cache, isSignedIn {
            self.cache.store(value, data: data, for: ResponseCache.key(path, query: query))
        }
        return value
    }

    /// `timeout` is how long to wait for the server, in seconds.
    func send<T: Decodable, B: Encodable>(
        _ method: String, _ path: String, body: B, timeout: TimeInterval = 60
    ) async throws -> T {
        try await perform(method, path, body: body, timeout: timeout)
    }

    /// Uploads one file as multipart form data alongside plain text fields.
    func upload<T: Decodable>(
        _ path: String, file: Data, fileName: String, fields: [String: String]
    ) async throws -> T {
        let boundary = "Boundary-\(UUID().uuidString)"
        var body = Data()
        func line(_ text: String) { body.append(Data((text + "\r\n").utf8)) }
        for (name, value) in fields {
            line("--\(boundary)")
            line("Content-Disposition: form-data; name=\"\(name)\"")
            line("")
            line(value)
        }
        line("--\(boundary)")
        line("Content-Disposition: form-data; name=\"file\"; filename=\"\(fileName)\"")
        line("Content-Type: application/octet-stream")
        line("")
        body.append(file)
        line("")
        line("--\(boundary)--")
        let data = try await fetch(
            "POST", path, payload: (body, "multipart/form-data; boundary=\(boundary)"), timeout: 120
        )
        return try Self.decode(data)
    }
    private struct ErrorBody: Decodable { let error: String }

    private func perform<T: Decodable, B: Encodable>(
        _ method: String,
        _ path: String,
        query: [String: String?] = [:],
        body: B?,
        authorized: Bool = true,
        timeout: TimeInterval = 60
    ) async throws -> T {
        let payload = try body.map { (try Self.encoder.encode($0), "application/json") }
        return try Self.decode(try await fetch(method, path, query: query, payload: payload, authorized: authorized, timeout: timeout))
    }

    private static func decode<T: Decodable>(_ data: Data) throws -> T {
        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw APIError.server("Unexpected reply from the server.")
        }
    }

    /// The reply's body once the status is 2xx.
    private func fetch(
        _ method: String,
        _ path: String,
        query: [String: String?] = [:],
        payload: (data: Data, contentType: String)?,
        authorized: Bool = true,
        timeout: TimeInterval = 60,
        retried: Bool = false
    ) async throws -> Data {
        var components = URLComponents(
            url: serverURL.appending(path: "api/v1/\(path)"), resolvingAgainstBaseURL: false
        )
        let items = query.compactMap { key, value in value.map { URLQueryItem(name: key, value: $0) } }
        if !items.isEmpty { components?.queryItems = items }
        guard let url = components?.url else { throw APIError.badRequest }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = timeout
        if let payload {
            request.httpBody = payload.data
            request.setValue(payload.contentType, forHTTPHeaderField: "Content-Type")
        }
        if authorized {
            request.setValue("Bearer \(try await validAccessToken())", forHTTPHeaderField: "Authorization")
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await urlSession.data(for: request)
        } catch {
            throw APIError.transport("Could not reach the server. \(error.localizedDescription)")
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0

        // The token was rejected before its expiry: refresh once and retry.
        if status == 401, authorized, !retried, let current = session {
            _ = try await refresh(current)
            return try await fetch(method, path, query: query, payload: payload, authorized: authorized, timeout: timeout, retried: true)
        }

        guard (200..<300).contains(status) else {
            let message = (try? Self.decoder.decode(ErrorBody.self, from: data))?.error
            if status == 401, authorized { signOut() }
            throw APIError.server(message ?? "The server answered \(status).")
        }
        return data
    }
}
