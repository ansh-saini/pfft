import CryptoKit
import Foundation

/// The last reply to each GET, kept on disk so a screen opens on what it showed
/// before and refreshes in place. Decoded values are also held in memory, since
/// a view reads its cache every time it is created.
final class ResponseCache {
    static let shared = ResponseCache()

    private let directory: URL
    private var decoded: [String: Any] = [:]

    init(directory: URL = URL.cachesDirectory.appending(path: "APIResponses", directoryHint: .isDirectory)) {
        self.directory = directory
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    /// One key per path and query, whatever order the query was built in.
    static func key(_ path: String, query: [String: String?]) -> String {
        let items = query.compactMap { key, value in value.map { "\(key)=\($0)" } }.sorted()
        return items.isEmpty ? path : "\(path)?\(items.joined(separator: "&"))"
    }

    func value<T: Decodable>(_ key: String) -> T? {
        if let hit = decoded[key] as? T { return hit }
        guard let data = try? Data(contentsOf: file(key)),
              let value = try? APIClient.decoder.decode(T.self, from: data)
        else { return nil }
        decoded[key] = value
        return value
    }

    func store<T>(_ value: T, data: Data, for key: String) {
        decoded[key] = value
        let file = file(key)
        Task.detached(priority: .utility) {
            try? data.write(to: file, options: .atomic)
        }
    }

    /// On sign out: the next person must not see the last one's money.
    func clear() {
        decoded = [:]
        try? FileManager.default.removeItem(at: directory)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    private func file(_ key: String) -> URL {
        let digest = SHA256.hash(data: Data(key.utf8)).map { String(format: "%02x", $0) }.joined()
        return directory.appending(path: "\(digest).json")
    }
}
