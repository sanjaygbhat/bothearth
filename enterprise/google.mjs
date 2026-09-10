import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";

// Fixed endpoints from Google's discovery document; no user-provided issuer or key URL.
const issuer = "https://accounts.google.com";
const tokenEndpoint = "https://oauth2.googleapis.com/token";
const jwksEndpoint = "https://www.googleapis.com/oauth2/v3/certs";

export function createGoogleLogin({ clientId, clientSecret, origin, fetcher = fetch, now = Date.now }) {
  if (!clientId || !clientSecret) throw new Error("Configure the Google web client ID and secret.");
  const redirectUri = `${origin}/account/auth/google/callback`;
  const keys = createRemoteJWKSet(new URL(jwksEndpoint), {
    timeoutDuration: 10000, cacheMaxAge: 3600000, cooldownDuration: 30000,
    [customFetch]: fetcher,
  });
  return {
    start() {
      const state = randomBytes(32).toString("base64url");
      const nonce = randomBytes(32).toString("base64url");
      const verifier = randomBytes(32).toString("base64url");
      const destination = new URL(`${issuer}/o/oauth2/v2/auth`);
      destination.search = new URLSearchParams({
        client_id: clientId, redirect_uri: redirectUri, response_type: "code", scope: "openid email",
        state, nonce, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
        prompt: "select_account",
      }).toString();
      return { state, nonce, verifier, destination: destination.href };
    },
    async finish(code, { nonce, verifier }) {
      if (typeof code !== "string" || !code || code.length > 4096) throw new Error("Invalid Google authorization code.");
      const response = await fetcher(tokenEndpoint, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(10000),
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri,
          grant_type: "authorization_code", code_verifier: verifier }),
      });
      if (!response.ok) throw new Error("Google sign-in could not be completed.");
      const text = await response.text();
      if (text.length > 65536) throw new Error("Invalid Google token response.");
      const result = JSON.parse(text);
      if (typeof result.id_token !== "string" || result.id_token.length > 16384) throw new Error("Invalid Google ID token.");
      const { payload } = await jwtVerify(result.id_token, keys, {
        algorithms: ["RS256"], issuer: [issuer, "accounts.google.com"], audience: clientId,
        requiredClaims: ["sub", "email", "email_verified", "iat", "exp", "nonce"],
        maxTokenAge: "10m", clockTolerance: 30, currentDate: new Date(now()),
      });
      if (payload.nonce !== nonce || (payload.azp !== undefined && payload.azp !== clientId)
        || (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== clientId)
        || typeof payload.sub !== "string" || !/^[\x21-\x7e]{1,255}$/.test(payload.sub)
        || payload.email_verified !== true || typeof payload.email !== "string" || payload.email.length > 254
        || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(payload.email)) throw new Error("Invalid Google account identity.");
      // Access/refresh tokens, names, avatars, and other claims are deliberately not retained.
      return { subject: payload.sub, email: payload.email, issuer };
    },
  };
}
