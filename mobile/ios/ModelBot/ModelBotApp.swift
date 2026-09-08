import SwiftUI
import UserNotifications

@MainActor final class WorkspaceModel: NSObject, ObservableObject, UNUserNotificationCenterDelegate
{
  let client = WorkspaceClient()
  @Published var connected = false
  @Published var busy = false
  @Published var canStart = false
  @Published var error = ""
  @Published var goal = ""
  @Published var tasks: [TaskItem] = []
  @Published var takeovers: [Takeover] = []
  @Published var control: String?
  @Published var report = ""
  private var seen = Set<String>()
  private var resultRevision = 0
  private var refreshing = false
  private func failed(_ failure: Error) {
    if case WorkspaceError.expired = failure {
      connected = false
      control = nil
      tasks = []
      takeovers = []
      report = ""
    }
    error = failure.localizedDescription
  }
  override init() {
    super.init()
    UNUserNotificationCenter.current().delegate = self
  }
  func restore() async {
    do {
      try client.restore()
      if !client.cookie.isEmpty {
        apply(try await client.request("GET", "/api/v1/session"))
        await refresh()
      }
    } catch { failed(error) }
  }
  private func apply(_ session: [String: Any]) {
    connected = true
    canStart =
      session["task_start_available"] as? Bool ?? session["standalone_available"] as? Bool ?? false
    error = ""
  }
  func connect(_ input: String) async {
    guard !busy else { return }
    busy = true
    defer { busy = false }
    do {
      apply(try await client.connect(input))
      await refresh()
    } catch { failed(error) }
  }
  func refresh() async {
    guard connected, !refreshing else { return }
    refreshing = true
    defer { refreshing = false }
    do {
      let taskData = try await client.request("GET", "/api/v1/tasks")
      let leaseData = try await client.request("GET", "/api/v1/takeovers")
      guard connected else { return }
      tasks = try JSONDecoder().decode(
        [TaskItem].self, from: JSONSerialization.data(withJSONObject: taskData["tasks"] ?? []))
      takeovers = try JSONDecoder().decode(
        [Takeover].self, from: JSONSerialization.data(withJSONObject: leaseData["takeovers"] ?? []))
      for lease in takeovers where lease.state == "takeover_requested" && !seen.contains(lease.id) {
        seen.insert(lease.id)
        let content = UNMutableNotificationContent()
        content.title = "ModelBot needs you"
        content.body = "Open your workspace to review a human-control request."
        content.userInfo = ["computer": lease.computer_id]
        content.sound = .default
        try? await UNUserNotificationCenter.current().add(
          UNNotificationRequest(identifier: lease.id, content: content, trigger: nil))
      }
    } catch { failed(error) }
  }
  func start() async {
    guard canStart, !busy, !goal.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      return
    }
    busy = true
    defer { busy = false }
    let submittedGoal = goal
    do {
      _ = try await client.request("POST", "/api/v1/tasks", ["goal": submittedGoal])
      if goal == submittedGoal { goal = "" }
      await refresh()
    } catch { failed(error) }
  }
  func stop(_ task: TaskItem) async {
    do {
      _ = try await client.request("POST", "/api/v1/tasks/\(task.id)/cancel", [:])
      await refresh()
    } catch { failed(error) }
  }
  func loadResult(_ task: TaskItem) async {
    resultRevision += 1
    let revision = resultRevision
    report = "Loading saved updates…"
    do {
      let detail = try await client.request("GET", "/api/v1/tasks/\(task.id)")
      let steps = detail["steps"] as? [[String: Any]] ?? []
      var output: [String] = []
      for step in steps {
        guard let body = step["body"] as? [String: Any] else { continue }
        if let summary = body["summary"] as? String {
          if body["summary_truncated"] as? Bool == true, let id = step["result_id"] as? Int {
            let saved = try await client.request("GET", "/api/v1/tasks/\(task.id)/results/\(id)")
            output.append(
              (saved["truncated"] as? Bool == true
                ? "Export shortened to the server’s size limit.\n\n" : "")
                + (saved["text"] as? String ?? ""))
          } else {
            output.append(summary)
          }
        } else if let text = body["content"] as? String {
          output.append(text)
        }
      }
      guard revision == resultRevision, connected else { return }
      report =
        output.isEmpty
        ? "No saved result yet. Refresh to check progress." : output.joined(separator: "\n\n")
    } catch {
      if revision == resultRevision {
        report = error.localizedDescription
        if case WorkspaceError.expired = error { failed(error) }
      }
    }
  }
  func forget() {
    resultRevision += 1
    client.forget()
    connected = false
    tasks = []
    takeovers = []
    control = nil
    seen.removeAll()
    report = ""
  }
  func logout() async {
    do {
      _ = try await client.request("POST", "/api/v1/session/logout", [:])
      forget()
    } catch { failed(error) }
  }
  nonisolated func userNotificationCenter(
    _ center: UNUserNotificationCenter, willPresent notification: UNNotification
  ) async -> UNNotificationPresentationOptions { [.banner, .sound] }
  nonisolated func userNotificationCenter(
    _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse
  ) async {
    let computer = response.notification.request.content.userInfo["computer"] as? String
    await MainActor.run { if self.connected { self.control = computer.map { "#/live/\($0)" } } }
  }
}

@main struct ModelBotApp: App {
  @StateObject private var model = WorkspaceModel()
  @Environment(\.scenePhase) private var phase
  var body: some Scene {
    WindowGroup {
      RootView().environmentObject(model).task { await model.restore() }.overlay {
        if phase != .active {
          Color(.systemBackground).ignoresSafeArea().overlay(Text("ModelBot screen hidden"))
        }
      }
    }
  }
}
struct RootView: View {
  @EnvironmentObject private var model: WorkspaceModel
  @Environment(\.scenePhase) private var phase
  @State private var link = ""
  @State private var settings = false
  var body: some View {
    NavigationStack {
      Group {
        if !model.connected {
          Form {
            Section("Connect your workspace") {
              Text(
                "On your computer, open ModelBot Settings → Connected devices → Connect a device. Paste its connection link here."
              )
              SecureField("Workspace connection link", text: $link).textInputAutocapitalization(
                .never
              ).autocorrectionDisabled().textContentType(.oneTimeCode)
              Button("Connect") {
                let value = link
                link = ""
                Task { await model.connect(value) }
              }.disabled(model.busy)
              DisclosureGroup("Connecting to a private server?") {
                Text(
                  "Connect Tailscale on this phone first, using the same private network as your server."
                ).font(.footnote)
              }
            }
            if !model.error.isEmpty { Text(model.error).foregroundStyle(.red) }
          }
        } else {
          List {
            Section {
              TextField("What would you like to get done?", text: $model.goal, axis: .vertical)
                .lineLimit(3...6)
              Button("Start task") { Task { await model.start() } }.disabled(
                model.busy || !model.canStart
                  || model.goal.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
              if !model.canStart {
                Text("Connect an AI service in your workspace’s Settings first.").font(.footnote)
              }
            }
            if !model.error.isEmpty { Section { Text(model.error).foregroundStyle(.red) } }
            Section("Recent tasks") {
              if model.tasks.isEmpty {
                Text("Your tasks will appear here.").foregroundStyle(.secondary)
              }
              ForEach(model.tasks) { task in
                NavigationLink {
                  TaskView(task: task)
                } label: {
                  VStack(alignment: .leading) {
                    Text(task.goal)
                    Text(needsHuman(task) ? "Needs you" : task.status.capitalized).font(.caption)
                      .foregroundStyle(.secondary)
                  }
                }
              }
            }
          }.refreshable { await model.refresh() }.toolbar {
            Button("Connection") { settings = true }
          }
        }
      }.navigationTitle("ModelBot")
    }.id(model.connected)
      .onChange(of: model.connected) { _, connected in if !connected { settings = false } }
      .sheet(isPresented: $settings) { SettingsView() }
      .sheet(
        isPresented: Binding(get: { model.control != nil }, set: { if !$0 { model.control = nil } })
      ) {
        NavigationStack {
          if let route = model.control {
            ControlView(client: model.client, route: route, active: phase == .active)
              .navigationTitle("Workspace computer").navigationBarTitleDisplayMode(.inline).toolbar
            { Button("Back to tasks") { model.control = nil } }
          }
        }
      }
      .task(id: phase) {
        guard phase == .active else { return }
        while !Task.isCancelled {
          await model.refresh()
          try? await Task.sleep(for: .seconds(5))
          if Task.isCancelled { return }
        }
      }
  }
  private func needsHuman(_ task: TaskItem) -> Bool {
    ["running", "paused"].contains(task.status)
      && model.takeovers.contains {
        $0.computer_id == task.computer_id
          && ["takeover_requested", "human", "paused"].contains($0.state)
      }
  }
}
struct TaskView: View {
  @EnvironmentObject private var model: WorkspaceModel
  let task: TaskItem
  private var current: TaskItem { model.tasks.first(where: { $0.id == task.id }) ?? task }
  @State private var stopping = false
  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 18) {
        Text(task.goal).font(.title2)
        Text(current.status.capitalized).foregroundStyle(.secondary)
        Button("Open computer") { model.control = "#/live/\(task.computer_id)" }
        if ["running", "paused"].contains(current.status) {
          Button("Stop task", role: .destructive) { stopping = true }
        }
        Text(model.report).textSelection(.enabled)
        HStack {
          Button("Refresh") { Task { await model.loadResult(task) } }
          ShareLink("Share result", item: model.report)
        }
      }.padding()
    }.navigationTitle("Task").navigationBarTitleDisplayMode(.inline).task(id: task.id) {
      await model.loadResult(task)
    }
    .confirmationDialog(
      "Stop this task? Completed actions remain.", isPresented: $stopping, titleVisibility: .visible
    ) { Button("Stop task", role: .destructive) { Task { await model.stop(task) } } }
  }
}
struct SettingsView: View {
  @EnvironmentObject private var model: WorkspaceModel
  @Environment(\.dismiss) private var dismiss
  @State private var notice = ""
  @State private var forget = false
  var body: some View {
    NavigationStack {
      Form {
        Section("Your workspace") {
          Text(model.client.origin)
          Button("Open advanced workspace settings") {
            dismiss()
            model.control = "#/settings"
          }
        }
        Section("Notifications") {
          Button("Enable human-control notifications") {
            Task {
              do {
                let allowed = try await UNUserNotificationCenter.current().requestAuthorization(
                  options: [.alert, .sound])
                notice =
                  allowed
                  ? "Enabled while ModelBot is open."
                  : "Notifications were not enabled. Requests remain visible in the app."
              } catch { notice = "Notification permission could not be requested." }
            }
          }
          Text(notice)
          Text("Requests are checked in the foreground. APNs background push is not configured.")
            .font(.footnote)
        }
        Section {
          Button("Sign out on this device", role: .destructive) {
            Task {
              await model.logout()
              if !model.connected { dismiss() }
            }
          }
          Button("Forget connection locally", role: .destructive) { forget = true }
        }
      }.navigationTitle("Connection").toolbar { Button("Done") { dismiss() } }.confirmationDialog(
        "Forget this connection? Server tasks and sessions are not deleted.", isPresented: $forget,
        titleVisibility: .visible
      ) {
        Button("Forget", role: .destructive) {
          model.forget()
          dismiss()
        }
      }
    }
  }
}
