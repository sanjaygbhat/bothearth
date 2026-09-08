package org.modelbot.mobile;

import android.Manifest;
import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.net.http.SslError;
import android.os.*;
import android.text.InputType;
import android.view.*;
import android.view.inputmethod.EditorInfo;
import android.webkit.*;
import android.widget.*;
import org.json.*;
import java.util.*;
import java.util.concurrent.*;

public final class MainActivity extends Activity {
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    private Workspace workspace;
    private LinearLayout root, list;
    private TextView status;
    private EditText goal;
    private Button start, connectButton;
    private WebView web;
    private String pendingComputer;
    private String screen = "connection", taskId = "", controlId = "", draft = "", resultText = "";
    private int revision = 0;
    private boolean foreground = false, refreshing = false, canStart = false, submitting = false;
    private int sessionRevision = 0;
    private final Set<String> notified = new HashSet<>();
    private JSONArray tasks = new JSONArray(), takeovers = new JSONArray();
    private final Runnable poll = new Runnable() { public void run() { if (foreground && !workspace.cookie.isEmpty()) refresh(); main.postDelayed(this, 5000); } };

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        if (!BuildConfig.DEBUG) getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE);
        workspace = new Workspace(new SessionVault(this));
        pendingComputer=getIntent().getStringExtra("computer");
        getSystemService(NotificationManager.class).createNotificationChannel(new NotificationChannel("human", "Human control requests", NotificationManager.IMPORTANCE_DEFAULT));
        try { workspace.restore(); } catch (Exception ignored) { workspace.forget(); }
        showConnection();
        if (!workspace.cookie.isEmpty()) run(() -> workspace.request("GET", "/api/v1/session", null), value -> { showHome(value); openPendingComputer(); refresh(); });
    }
    @Override public void onResume() { super.onResume(); foreground = true; main.removeCallbacks(poll); main.post(poll); if (screen.equals("control") && web != null) loadControl(); }
    @Override public void onPause() {
        foreground = false; main.removeCallbacks(poll);
        if (web != null) { web.loadUrl("about:blank"); web.onPause(); CookieManager.getInstance().removeAllCookies(null); }
        super.onPause();
    }
    @Override public void onDestroy() { main.removeCallbacks(poll); worker.shutdownNow(); destroyWeb(); super.onDestroy(); }
    @Override public void onBackPressed() { if (!screen.equals("home") && !workspace.cookie.isEmpty()) showHome(null); else super.onBackPressed(); }
    @Override protected void onNewIntent(Intent intent) { super.onNewIntent(intent); String computer = intent.getStringExtra("computer"); if (computer != null && !workspace.cookie.isEmpty()) showControl(computer); }
    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    private TextView text(LinearLayout host, String value, int size) { TextView view = new TextView(this); view.setText(value); view.setTextSize(size); view.setTextColor(Color.rgb(25, 48, 41)); view.setPadding(0, dp(6), 0, dp(6)); host.addView(view); return view; }
    private Button button(LinearLayout host, String label, Runnable action) { Button b = new Button(this); b.setText(label); b.setAllCaps(false); b.setOnClickListener(v -> action.run()); host.addView(b); return b; }
    private void layout(String title) {
        revision++; destroyWeb(); root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL); root.setPadding(dp(20), dp(12), dp(20), dp(12)); root.setBackgroundColor(Color.rgb(247,249,244));
        setContentView(root);
        root.setOnApplyWindowInsetsListener((v, insets) -> { v.setPadding(dp(20)+insets.getSystemWindowInsetLeft(), dp(12)+insets.getSystemWindowInsetTop(), dp(20)+insets.getSystemWindowInsetRight(), dp(12)+insets.getSystemWindowInsetBottom()); return insets; });
        text(root, title, 26); status = text(root, "", 14); status.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
    }
    private EditText input(LinearLayout parent, String label, boolean secret) {
        text(parent, label, 15); EditText input = new EditText(this); input.setSingleLine(secret); input.setContentDescription(label);
        input.setInputType(InputType.TYPE_CLASS_TEXT | (secret ? InputType.TYPE_TEXT_VARIATION_PASSWORD : InputType.TYPE_TEXT_FLAG_MULTI_LINE));
        input.setImeOptions(EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING); parent.addView(input); return input;
    }
    private void showConnection() {
        screen = "connection"; layout("Connect ModelBot");
        text(root, "On your computer, open ModelBot Settings → Connected devices → Connect a device. Paste its connection link here.", 16);
        EditText link = input(root, "Workspace connection link", true); link.setAutofillHints((String[])null);
        connectButton = button(root, "Connect", () -> {
            connectButton.setEnabled(false);
            String value = link.getText().toString(); link.setText(""); sessionRevision++;
            run(() -> workspace.connect(value), session -> { showHome(session); openPendingComputer(); refresh(); });
        });
        button(root, "Connecting to a private server?", () -> new AlertDialog.Builder(this).setMessage("Connect Tailscale on this phone first, using the same private network as your server.").setPositiveButton("OK", null).show());
    }
    private void showHome(JSONObject session) {
        screen = "home"; taskId = ""; layout("ModelBot");
        if (session != null) canStart = session.optBoolean("task_start_available", session.optBoolean("standalone_available"));
        if (!canStart) status.setText("Connect an AI service in your workspace’s Settings before starting tasks.");
        else status.setText("Your workspace · " + Uri.parse(workspace.origin).getHost());
        goal = input(root, "What would you like to get done?", false); goal.setMinLines(2); goal.setText(draft);
        start = button(root, "Start task", () -> {
            draft = goal.getText().toString(); if (draft.trim().isEmpty()) { goal.setError("Describe the task first."); return; }
            submitting=true; start.setEnabled(false); final String submittedGoal = draft.trim();
            run(() -> workspace.request("POST", "/api/v1/tasks", new JSONObject().put("goal", submittedGoal)), value -> { submitting=false; draft = ""; showTask(value.optJSONObject("task")); });
        });
        start.setEnabled(canStart && !submitting);
        button(root, "Connection & advanced settings", this::showSettings);
        text(root, "Recent tasks", 19);
        ScrollView scroll = new ScrollView(this); root.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1)); list = new LinearLayout(this); list.setOrientation(LinearLayout.VERTICAL); scroll.addView(list); updateList();
    }
    private void updateList() {
        if (!screen.equals("home") || list == null) return;
        list.removeAllViews();
        for (int i = 0; i < tasks.length(); i++) { JSONObject task = tasks.optJSONObject(i); if (task == null) continue;
            String state = task.optString("status");
            for (int j = 0; j < takeovers.length(); j++) { JSONObject lease = takeovers.optJSONObject(j); if (Arrays.asList("running", "paused").contains(task.optString("status")) && lease != null && lease.optString("computer_id").equals(task.optString("computer_id")) && Arrays.asList("takeover_requested", "human", "paused").contains(lease.optString("state"))) state = "Needs you"; }
            button(list, task.optString("goal", "Untitled task") + "\n" + state, () -> { draft = goal.getText().toString(); showTask(task); });
        }
        if (tasks.length() == 0) text(list, "Your tasks will appear here.", 16);
    }
    private void showTask(JSONObject task) {
        if (task == null) return; screen = "task"; taskId = task.optString("id"); final String id = taskId; layout("Task");
        button(root, "Back to tasks", () -> showHome(null)); text(root, task.optString("goal"), 20); status.setText(task.optString("status"));
        button(root, "Open computer", () -> showControl(task.optString("computer_id")));
        if (Arrays.asList("running", "paused").contains(task.optString("status"))) button(root, "Stop task", () -> new AlertDialog.Builder(this).setTitle("Stop this task?").setMessage("Completed actions will remain. Review them before starting again.").setNegativeButton("Keep running", null).setPositiveButton("Stop task", (d,w) -> run(() -> workspace.request("POST", "/api/v1/tasks/" + Uri.encode(id) + "/cancel", new JSONObject()), v -> showTask(v.optJSONObject("task")))).show());
        ScrollView scroll = new ScrollView(this); root.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1)); LinearLayout content = new LinearLayout(this); content.setOrientation(LinearLayout.VERTICAL); scroll.addView(content);
        TextView result = text(content, "Loading saved updates…", 16); result.setTextIsSelectable(true);
        button(root, "Share result", () -> { if (!resultText.isEmpty()) startActivity(Intent.createChooser(new Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, resultText), "Share task result")); });
        resultText = "";
        run(() -> workspace.request("GET", "/api/v1/tasks/" + Uri.encode(id), null), detail -> {
            JSONArray steps = detail.optJSONArray("steps"); StringBuilder output = new StringBuilder(); JSONObject terminal = null;
            if (steps != null) for (int i=0;i<steps.length();i++) { JSONObject step=steps.optJSONObject(i), body=step==null?null:step.optJSONObject("body"); if(body==null)continue;
                String summary=body.optString("summary", ""), text=body.optString("content", "");
                if(!summary.isEmpty()) { output.append(summary).append("\n\n"); terminal=step; } else if(!text.isEmpty()) output.append(text).append("\n\n");
            }
            resultText = output.length()==0?"No saved result yet. Refresh to check progress.":output.toString(); result.setText(resultText);
            if(terminal!=null && terminal.optJSONObject("body").optBoolean("summary_truncated") && terminal.has("result_id")) {
                String path="/api/v1/tasks/"+Uri.encode(id)+"/results/"+terminal.optInt("result_id");
                run(() -> workspace.request("GET",path,null), saved -> {resultText=(saved.optBoolean("truncated")?"Export shortened to the server’s size limit.\n\n":"")+saved.optString("text");result.setText(resultText);});
            }
        });
        button(root, "Refresh task", () -> run(() -> workspace.request("GET", "/api/v1/tasks/" + Uri.encode(id), null), detail -> showTask(detail.optJSONObject("task"))));
    }
    private void showSettings() {
        if (goal != null && screen.equals("home")) draft=goal.getText().toString(); screen="settings"; layout("Connection");
        text(root, workspace.origin, 16); button(root,"Back to tasks",()->showHome(null));
        button(root,"Open workspace settings",()->showWeb("#/settings"));
        button(root,"Enable human-control notifications",()->{ if(Build.VERSION.SDK_INT>=33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)!=PackageManager.PERMISSION_GRANTED)requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS},1); else status.setText("Notifications are available while the app is open. Background push is not configured."); });
        text(root,"Requests are checked while the app is in the foreground. No APNs/FCM push service is configured.",14);
        button(root,"Sign out on this device",()->run(()->workspace.request("POST","/api/v1/session/logout",new JSONObject()),v->{forget();}));
        button(root,"Forget this connection locally",()->new AlertDialog.Builder(this).setMessage("This removes the saved session from this phone. It does not cancel tasks or revoke the server session.").setNegativeButton("Cancel",null).setPositiveButton("Forget",(d,w)->{forget();}).show());
    }
    private void openPendingComputer(){if(pendingComputer!=null){String computer=pendingComputer;pendingComputer=null;showControl(computer);}}
    private void showControl(String computer) { controlId=computer; showWeb("#/live/"+Uri.encode(computer)); }
    private String webRoute="";
    private void showWeb(String route) {
        screen="control"; webRoute=route; layout("Workspace computer"); button(root,"Back to tasks",()->showHome(null));
        web=new WebView(this); web.setBackgroundColor(Color.WHITE); root.addView(web,new LinearLayout.LayoutParams(-1,0,1));
        web.getSettings().setJavaScriptEnabled(true); web.getSettings().setDomStorageEnabled(false); web.getSettings().setAllowFileAccess(false); web.getSettings().setAllowContentAccess(false); web.getSettings().setMixedContentMode(android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web,false);
        web.setOnLongClickListener(v->true);
        web.setWebViewClient(new WebViewClient(){
            @Override public boolean shouldOverrideUrlLoading(WebView view,WebResourceRequest request){ Uri target=request.getUrl(); if(sameOrigin(target))return false; if(request.hasGesture() && "https".equals(target.getScheme())) { try { startActivity(new Intent(Intent.ACTION_VIEW,target)); } catch(ActivityNotFoundException ignored) { status.setText("No browser is available to open this link."); } } return true; }
            @Override public void onReceivedSslError(WebView view,SslErrorHandler handler,SslError error){handler.cancel();status.setText("The server certificate is not trusted. Fix HTTPS on the workspace; this app will not bypass it.");}
            @Override public void onReceivedError(WebView view,WebResourceRequest request,WebResourceError error){if(request.isForMainFrame())status.setText("Connection interrupted. Return to tasks and check your connection.");}
        }); loadControl();
    }
    private boolean sameOrigin(Uri target) { Uri base=Uri.parse(workspace.origin);return Objects.equals(base.getScheme(),target.getScheme())&&Objects.equals(base.getHost(),target.getHost())&&base.getPort()==target.getPort(); }
    private void loadControl(){ if(web==null)return; web.onResume(); final WebView target=web; CookieManager.getInstance().setCookie(workspace.origin,workspace.cookie+"; Path=/; HttpOnly; SameSite=Strict"+(workspace.origin.startsWith("https:")?"; Secure":""),ok->{if(web==target&&foreground)target.loadUrl(workspace.origin+(webRoute.startsWith("#/live/")?"/?view=control":"/")+webRoute);}); }
    private void destroyWeb(){if(web!=null){web.loadUrl("about:blank");web.destroy();web=null;CookieManager.getInstance().removeAllCookies(null);}}
    private void forget() { sessionRevision++; workspace.forget(); tasks=new JSONArray(); takeovers=new JSONArray(); notified.clear(); resultText=""; canStart=false; showConnection(); }
    private void failed(Exception error) { submitting=false; if(connectButton!=null)connectButton.setEnabled(true); if(error instanceof Workspace.Expired) { sessionRevision++; tasks=new JSONArray(); takeovers=new JSONArray(); notified.clear(); canStart=false; showConnection(); } status.setText(error.getMessage()); }
    private void refresh(){
        if(refreshing)return; refreshing=true; final int version=sessionRevision;
        worker.execute(()->{ try {
            JSONObject session=workspace.request("GET","/api/v1/session",null), values=workspace.request("GET","/api/v1/tasks",null), leases=workspace.request("GET","/api/v1/takeovers",null);
            main.post(()->{ if(version!=sessionRevision||!foreground)return; canStart=session.optBoolean("task_start_available",session.optBoolean("standalone_available")); if(screen.equals("home")&&start!=null)start.setEnabled(canStart && !submitting); tasks=values.optJSONArray("tasks");if(tasks==null)tasks=new JSONArray();takeovers=leases.optJSONArray("takeovers");if(takeovers==null)takeovers=new JSONArray();updateList();notifyRequests(); });
        } catch(Exception error) { main.post(()->{if(version==sessionRevision)failed(error);}); }
        finally { main.post(()->refreshing=false); } });
    }
    private void notifyRequests(){for(int i=0;i<takeovers.length();i++){JSONObject lease=takeovers.optJSONObject(i);if(lease==null||!lease.optString("state").equals("takeover_requested"))continue;String id=lease.optString("id");if(!notified.add(id))continue;
        if(Build.VERSION.SDK_INT>=33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)!=PackageManager.PERMISSION_GRANTED)continue;
        Intent intent=new Intent(this,MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP).putExtra("computer",lease.optString("computer_id"));PendingIntent pending=PendingIntent.getActivity(this,id.hashCode(),intent,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);
        getSystemService(NotificationManager.class).notify(id.hashCode(),new Notification.Builder(this,"human").setSmallIcon(android.R.drawable.ic_dialog_info).setContentTitle("ModelBot needs you").setContentText("Open your workspace to review a human-control request.").setContentIntent(pending).setAutoCancel(true).build());
    }}
    interface Job {JSONObject call() throws Exception;} interface Done {void accept(JSONObject result);}
    private void run(Job job,Done done){final int version=revision;status.setText("Working…");worker.execute(()->{try{JSONObject value=job.call();main.post(()->{if(version==revision&&!isFinishing())done.accept(value);});}catch(Exception error){main.post(()->{if(version==revision){failed(error);if(start!=null)start.setEnabled(canStart && !submitting);}});}});}
}
