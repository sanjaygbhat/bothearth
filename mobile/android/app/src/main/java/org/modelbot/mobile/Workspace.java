package org.modelbot.mobile;

import org.json.JSONObject;
import java.io.InputStream;
import java.net.HttpCookie;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;

final class Workspace {
    volatile String origin = "", cookie = "", csrf = "";
    private int generation;
    static final class Expired extends Exception { Expired() { super("Sign-in expired. Paste a fresh workspace connection link. Tasks remain on the server."); } }
    final SessionVault vault;
    Workspace(SessionVault vault) { this.vault = vault; }
    static URI connectionURL(String input) throws Exception {
        URI url; try { url = new URI(input.trim()); } catch (java.net.URISyntaxException error) { throw new Exception("The connection link is invalid. Copy a fresh link from your workspace."); } String host = url.getHost();
        boolean local = host != null && (host.equals("localhost") || host.equals("127.0.0.1"));
        if (host == null || url.getUserInfo() != null || url.getRawQuery() != null || !(url.getPath().isEmpty() || url.getPath().equals("/"))
            || !("https".equalsIgnoreCase(url.getScheme()) || (BuildConfig.DEBUG && local && "http".equalsIgnoreCase(url.getScheme()))))
            throw new Exception("Use your workspace’s HTTPS connection link. HTTP is allowed only for local debug tests.");
        return url;
    }
    void restore() throws Exception {
        String saved = vault.read(); if (saved == null) return;
        JSONObject data = new JSONObject(saved); origin = data.getString("origin"); connectionURL(origin); cookie = data.getString("cookie");
    }
    JSONObject connect(String input) throws Exception {
        URI url = connectionURL(input);
        final int version; synchronized(this) { version = ++generation; }
        String next = new URI(url.getScheme().toLowerCase(java.util.Locale.ROOT), null, url.getHost().toLowerCase(java.util.Locale.ROOT), ("https".equalsIgnoreCase(url.getScheme()) && url.getPort()==443) ? -1 : url.getPort(), null, null, null).toString();
        String token = null;
        if (url.getRawFragment() != null) for (String pair : url.getRawFragment().split("&")) {
            String[] entry = pair.split("=", 2);
            if (entry.length == 2 && entry[0].equals("bootstrap")) token = java.net.URLDecoder.decode(entry[1], "UTF-8");
        }
        if (!next.equals(origin)) { cookie = ""; csrf = ""; }
        origin = next;
        JSONObject session = token == null ? request("GET", "/api/v1/session", null) : request("POST", "/api/v1/session/bootstrap", new JSONObject().put("token", token).put("label", "Android"));
        csrf = session.optString("csrf");
        if (cookie.isEmpty() || csrf.isEmpty()) throw new Exception("Paste a fresh connection link from your workspace to sign in.");
        synchronized(this) { if(version != generation) throw new Exception("The connection changed. Open the current workspace again."); vault.save(new JSONObject().put("origin", origin).put("cookie", cookie).toString()); }
        return session;
    }
    JSONObject request(String method, String path, JSONObject body) throws Exception {
        final int version; final String base, sessionCookie, requestCsrf;
        synchronized(this) { version = generation; base = origin; sessionCookie = cookie; requestCsrf = csrf; }
        if (!path.startsWith("/api/v1/")) throw new Exception("Invalid workspace request.");
        HttpURLConnection connection = (HttpURLConnection) new URL(base + path).openConnection();
        connection.setInstanceFollowRedirects(false); connection.setConnectTimeout(15000); connection.setReadTimeout(30000);
        connection.setRequestMethod(method); connection.setRequestProperty("Origin", base); connection.setRequestProperty("Accept", "application/json");
        if (!sessionCookie.isEmpty()) connection.setRequestProperty("Cookie", sessionCookie);
        if (!requestCsrf.isEmpty()) connection.setRequestProperty("X-CSRF-Token", requestCsrf);
        try {
            if (body != null) { connection.setDoOutput(true); connection.setRequestProperty("Content-Type", "application/json"); connection.getOutputStream().write(body.toString().getBytes(StandardCharsets.UTF_8)); }
            int code = connection.getResponseCode();
            synchronized(this) { if(version != generation) throw new Exception("The connection changed. Open the current workspace again."); if (code == 401 || code == 403) { generation++; cookie=""; csrf=""; vault.clear(); throw new Expired(); } }
            if (code < 200 || code >= 300) throw new Exception("The workspace could not complete this request (" + code + "). Check its status before trying again.");
            String setCookie = connection.getHeaderField("Set-Cookie");
            synchronized(this) { if(version != generation) throw new Exception("The connection changed."); if (setCookie != null) for (HttpCookie value : HttpCookie.parse(setCookie)) if (value.getName().equals("modelbot_session")) cookie = value.getName() + "=" + value.getValue(); }
            try (InputStream stream = connection.getInputStream()) {
                java.io.ByteArrayOutputStream buffer = new java.io.ByteArrayOutputStream(); byte[] chunk = new byte[8192]; int count;
                while ((count = stream.read(chunk)) != -1) { if (buffer.size() + count > 2_000_000) throw new Exception("Workspace response exceeds this app’s size limit."); buffer.write(chunk, 0, count); }
                byte[] bytes = buffer.toByteArray();
                JSONObject result = new JSONObject(new String(bytes, StandardCharsets.UTF_8));
                synchronized(this) { if(version != generation) throw new Exception("The connection changed."); if (path.equals("/api/v1/session")) csrf = result.optString("csrf"); }
                return result;
            }
        } finally { connection.disconnect(); }
    }
    synchronized void forget() { generation++; origin = ""; cookie = ""; csrf = ""; vault.clear(); }
}
