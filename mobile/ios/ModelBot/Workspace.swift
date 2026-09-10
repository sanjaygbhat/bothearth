import Foundation
import Security

struct TaskItem: Decodable, Identifiable {
  let id: String
  let computer_id: String
  let goal: String
  let status: String
}
struct Takeover: Decodable, Identifiable {
  let id: String
  let computer_id: String
  let state: String
}
struct SavedSession: Codable {
  let origin: String
  let cookie: String
}

enum SessionVault {
  private static let query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "ModelBot.operator",
    kSecAttrAccount as String: "workspace",
  ]
  static func read() throws -> SavedSession? {
    var query = query
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var value: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &value)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let data = value as? Data else {
      throw WorkspaceError.message("Unlock this device to restore your connection.")
    }
    return try JSONDecoder().decode(SavedSession.self, from: data)
  }
  static func save(_ value: SavedSession) throws {
    let data = try JSONEncoder().encode(value)
    let status = SecItemUpdate(
      query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
    if status == errSecItemNotFound {
      var item = query
      item[kSecValueData as String] = data
      item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
      guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else {
        throw WorkspaceError.message("The connection could not be saved securely.")
      }
      return
    }
    guard status == errSecSuccess else {
      throw WorkspaceError.message("The connection could not be saved securely.")
    }
  }
  static func clear() { SecItemDelete(query as CFDictionary) }
}
enum WorkspaceError: LocalizedError {
  case message(String)
  case expired
  var errorDescription: String? {
    switch self {
    case .message(let text): return text
    case .expired:
      return "Sign-in expired. Paste a fresh workspace connection link; tasks remain on the server."
    }
  }
}

/// Same-origin operator HTTP client; provider credentials never enter this app.
@MainActor final class WorkspaceClient: NSObject, URLSessionTaskDelegate {
  var origin = "", cookie = "", csrf = ""
  private var generation = 0
  private lazy var session: URLSession = {
    let config = URLSessionConfiguration.ephemeral
    config.httpShouldSetCookies = false
    config.httpCookieStorage = nil
    config.timeoutIntervalForRequest = 30
    return URLSession(configuration: config, delegate: self, delegateQueue: nil)
  }()
  static func connectionURL(_ input: String) throws -> URLComponents {
    guard let url = URLComponents(string: input.trimmingCharacters(in: .whitespacesAndNewlines)),
      let host = url.host,
      url.user == nil, url.password == nil, url.query == nil, url.path.isEmpty || url.path == "/"
    else {
      throw WorkspaceError.message("Use the HTTPS connection link from your own workspace.")
    }
    var allowed = url.scheme?.lowercased() == "https"
    #if DEBUG
      allowed =
        allowed
        || (url.scheme?.lowercased() == "http" && ["localhost", "127.0.0.1", "::1"].contains(host))
    #endif
    guard allowed else {
      throw WorkspaceError.message(
        "Your workspace needs HTTPS. Insecure remote connections are not supported.")
    }
    return url
  }
  func restore() throws {
    guard let saved = try SessionVault.read() else { return }
    _ = try Self.connectionURL(saved.origin)
    origin = saved.origin
    cookie = saved.cookie
  }
  func connect(_ input: String) async throws -> [String: Any] {
    generation += 1
    var url = try Self.connectionURL(input)
    let fragment = URLComponents(string: "?" + (url.fragment ?? ""))?.queryItems
    let token = fragment?.first(where: { $0.name == "bootstrap" })?.value
    url.fragment = nil
    url.path = ""
    url.scheme = url.scheme?.lowercased()
    url.host = url.host?.lowercased()
    if url.scheme?.lowercased() == "https" && url.port == 443 { url.port = nil }
    guard let next = url.string else {
      throw WorkspaceError.message("The connection link is invalid.")
    }
    if next != origin {
      cookie = ""
      csrf = ""
    }
    origin = next
    let result = try await request(
      token == nil ? "GET" : "POST", token == nil ? "/api/v1/session" : "/api/v1/session/bootstrap",
      token.map { ["token": $0, "label": "iPhone / iPad"] })
    csrf = result["csrf"] as? String ?? ""
    guard !cookie.isEmpty, !csrf.isEmpty else {
      throw WorkspaceError.message("Paste a fresh workspace connection link to sign in.")
    }
    try SessionVault.save(SavedSession(origin: origin, cookie: cookie))
    return result
  }
  func request(_ method: String, _ path: String, _ body: [String: Any]? = nil) async throws
    -> [String: Any]
  {
    let currentGeneration = generation
    guard path.hasPrefix("/api/v1/"), let url = URL(string: origin + path) else {
      throw WorkspaceError.message("Connect a workspace first.")
    }
    var request = URLRequest(url: url)
    request.httpMethod = method
    request.setValue(origin, forHTTPHeaderField: "Origin")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    if !cookie.isEmpty { request.setValue(cookie, forHTTPHeaderField: "Cookie") }
    if !csrf.isEmpty { request.setValue(csrf, forHTTPHeaderField: "X-CSRF-Token") }
    if let body {
      request.httpBody = try JSONSerialization.data(withJSONObject: body)
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }
    let (data, response) = try await session.data(for: request)
    guard generation == currentGeneration else {
      throw WorkspaceError.message("The connection changed. Open the current workspace again.")
    }
    guard let response = response as? HTTPURLResponse else {
      throw WorkspaceError.message("The workspace could not be reached.")
    }
    if [401, 403].contains(response.statusCode) {
      generation += 1
      cookie = ""
      csrf = ""
      SessionVault.clear()
      throw WorkspaceError.expired
    }
    guard (200...299).contains(response.statusCode) else {
      throw WorkspaceError.message(
        "The workspace could not complete this request (\(response.statusCode)). Check its status before trying again."
      )
    }
    guard data.count <= 2_000_000 else {
      throw WorkspaceError.message("The response exceeds this app’s size limit.")
    }
    if let fields = response.allHeaderFields as? [String: String],
      let received = HTTPCookie.cookies(withResponseHeaderFields: fields, for: url).first(where: {
        $0.name.range(of: #"^modelbot_session(?:_[0-9]+)?$"#, options: .regularExpression) != nil
      })
    {
      cookie = "\(received.name)=\(received.value)"
    }
    guard let result = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
      throw WorkspaceError.message("The workspace response could not be read.")
    }
    if path == "/api/v1/session" { csrf = result["csrf"] as? String ?? "" }
    return result
  }
  func forget() {
    generation += 1
    origin = ""
    cookie = ""
    csrf = ""
    SessionVault.clear()
  }
  nonisolated func urlSession(
    _ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void
  ) { completionHandler(nil) }
}
