import SwiftUI
import WebKit

/// The authenticated workspace owns control and input; this view adds no message bridge.
struct ControlView: UIViewRepresentable {
  let client: WorkspaceClient
  let route: String
  let active: Bool
  func makeCoordinator() -> Coordinator { Coordinator(origin: client.origin) }
  func makeUIView(context: Context) -> WKWebView {
    let config = WKWebViewConfiguration()
    config.websiteDataStore = .nonPersistent()
    let view = WKWebView(frame: .zero, configuration: config)
    view.navigationDelegate = context.coordinator
    view.isOpaque = false
    view.backgroundColor = .systemBackground
    return view
  }
  func updateUIView(_ view: WKWebView, context: Context) {
    guard active else {
      context.coordinator.loaded = nil
      view.loadHTMLString(
        "<html><body>Screen hidden. Return to reconnect.</body></html>", baseURL: nil)
      return
    }
    guard let base = URL(string: client.origin),
      let url = URL(
        string: client.origin + (route.hasPrefix("#/live/") ? "/?view=control" : "/") + route)
    else { return }
    context.coordinator.origin = base
    let stamp = client.origin + client.cookie + route
    guard context.coordinator.loaded != stamp else { return }
    context.coordinator.loaded = stamp
    let header =
      client.cookie + "; Path=/; HttpOnly; SameSite=Strict"
      + (base.scheme == "https" ? "; Secure" : "")
    guard
      let cookie = HTTPCookie.cookies(withResponseHeaderFields: ["Set-Cookie": header], for: base)
        .first
    else { return }
    view.configuration.websiteDataStore.httpCookieStore.setCookie(cookie) {
      [weak view, weak coordinator = context.coordinator] in
      guard coordinator?.loaded == stamp else { return }
      view?.load(URLRequest(url: url))
    }
  }
  static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) {
    coordinator.loaded = nil
    view.stopLoading()
    view.loadHTMLString("", baseURL: nil)
  }
  final class Coordinator: NSObject, WKNavigationDelegate {
    var origin: URL?
    var loaded: String?
    init(origin: String) { self.origin = URL(string: origin) }
    func webView(
      _ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
      decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
      guard let url = navigationAction.request.url else {
        decisionHandler(.cancel)
        return
      }
      if url.absoluteString == "about:blank" {
        decisionHandler(.allow)
        return
      }
      let same =
        url.scheme == origin?.scheme && url.host == origin?.host && url.port == origin?.port
      if !same, navigationAction.navigationType == .linkActivated, url.scheme == "https" {
        UIApplication.shared.open(url)
      }
      decisionHandler(same ? .allow : .cancel)
    }
  }
}
