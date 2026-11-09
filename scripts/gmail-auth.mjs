#!/usr/bin/env node
/**
 * One-time Gmail OAuth bootstrap for Houge's identity (ADR 0008 / ADR 0022 amendment).
 *
 * Runs the OAuth 2.0 loopback flow (with PKCE) against the wukong.houge@gmail.com identity and
 * captures a long-lived REFRESH TOKEN, scoped read-only (`gmail.readonly`). Zero dependencies.
 *
 * Prereqs (Google Cloud Console, logged in AS wukong.houge@gmail.com):
 *   1. Project with Gmail API enabled.
 *   2. OAuth consent screen PUBLISHED (Audience → Publishing status: "In production").
 *      In "Testing" status the refresh token silently expires after 7 days — publish FIRST,
 *      then run this script. The "unverified app" warning during consent is expected; click
 *      Advanced → continue.
 *   3. OAuth client of type "Desktop app"; download client_secret*.json.
 *
 * Usage:
 *   node scripts/gmail-auth.mjs <path/to/client_secret.json>
 *   node scripts/gmail-auth.mjs --account paco [path/to/client_secret.json]
 *     Paco's own mailbox (SP2 mail triage, read-only): client id/secret from .env (or the optional json), the account from
 *     HOUGE_PACO_GMAIL_ADDRESS (login hint and identity check), and exactly one HOUGE_PACO_GMAIL_REFRESH_TOKEN line written
 *     into .env (or $HOUGE_ENV_FILE), replacing an existing one. `houge mail auth` runs this.
 *
 * A browser window opens for the consent tap (must run on a machine with a browser; the
 * resulting .env lines are portable to the mini). On success the three values are appended to
 * ./.env if present (values masked on stdout), otherwise printed in full for manual copy.
 * HOUGE_GMAIL_CLIENT_SECRET / HOUGE_GMAIL_REFRESH_TOKEN match the secrets-firewall name pattern
 * (ADR 0015) and are stripped from process.env at daemon boot once the firewall learns their
 * broker getters — by design.
 */

import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, existsSync, appendFileSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { parseEnvText, upsertEnvLine } from "./gmail-env.mjs";

const SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const PROFILE_ENDPOINT = "https://gmail.googleapis.com/gmail/v1/users/me/profile";
const EXPECTED_IDENTITY = "wukong.houge@gmail.com";

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

const accountAt = process.argv.indexOf("--account");
const paco = accountAt !== -1;
if (paco && process.argv[accountAt + 1] !== "paco") fail('usage: node scripts/gmail-auth.mjs --account paco [path/to/client_secret.json]');
const secretPath = paco ? process.argv.slice(2).find((a, i, all) => a !== "--account" && all[i - 1] !== "--account") : process.argv[2];
const envFile = process.env.HOUGE_ENV_FILE || ".env";
const envValues = paco ? { ...parseEnvText(existsSync(envFile) ? readFileSync(envFile, "utf8") : ""), ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("HOUGE_"))) } : {};
const expectedIdentity = paco ? (envValues.HOUGE_PACO_GMAIL_ADDRESS ?? "").trim().toLowerCase() : EXPECTED_IDENTITY;
if (paco && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(expectedIdentity)) fail(`HOUGE_PACO_GMAIL_ADDRESS is not set in ${envFile}`);
if (paco && !existsSync(envFile)) fail(`no ${envFile} to write the token into — create it first (the token is never printed)`);
if (!paco && !secretPath) fail("usage: node scripts/gmail-auth.mjs <path/to/client_secret.json>");
if (secretPath && !existsSync(secretPath)) fail(`no such file: ${secretPath}`);

let clientId, clientSecret;
if (paco && !secretPath) {
  clientId = envValues.HOUGE_GMAIL_CLIENT_ID;
  clientSecret = envValues.HOUGE_GMAIL_CLIENT_SECRET;
  if (!clientId || !clientSecret) fail(`HOUGE_GMAIL_CLIENT_ID / HOUGE_GMAIL_CLIENT_SECRET are not set in ${envFile}`);
} else try {
  const parsed = JSON.parse(readFileSync(secretPath, "utf8"));
  const conf = parsed.installed ?? parsed.web;
  clientId = conf.client_id;
  clientSecret = conf.client_secret;
  if (!clientId || !clientSecret) throw new Error("missing client_id/client_secret");
  if (!parsed.installed) {
    console.warn(
      '⚠ client type is "web", expected "Desktop app" ("installed"). Loopback redirect may be rejected — recreate the client as Desktop app if the consent screen errors.'
    );
  }
} catch (error) {
  fail(`cannot parse ${secretPath}: ${error.message}`);
}

const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const state = randomBytes(16).toString("base64url");

const { code, redirectUri } = await new Promise((resolve, reject) => {
  let boundRedirectUri;
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname !== "/") {
      res.writeHead(404).end();
      return;
    }
    const err = url.searchParams.get("error");
    const returnedState = url.searchParams.get("state");
    const authCode = url.searchParams.get("code");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    if (err || returnedState !== state || !authCode) {
      res.end("<h3>Authorization failed — check the terminal.</h3>");
      server.close();
      reject(new Error(err ?? "state mismatch or missing code"));
      return;
    }
    res.end("<h3>Houge Gmail authorized — you can close this tab.</h3>");
    server.close();
    resolve({ code: authCode, redirectUri: boundRedirectUri });
  });

  server.listen(0, "127.0.0.1", () => {
    boundRedirectUri = `http://127.0.0.1:${server.address().port}`;
    const authUrl = new URL(AUTH_ENDPOINT);
    authUrl.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: boundRedirectUri,
      response_type: "code",
      scope: SCOPE,
      access_type: "offline",
      prompt: "consent",
      login_hint: expectedIdentity,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256"
    }).toString();

    console.log(`\nOpening browser for consent (sign in as ${expectedIdentity}).`);
    console.log(`If it does not open, visit:\n\n${authUrl}\n`);
    execFile("open", [authUrl.toString()], () => {});
  });
}).catch((error) => fail(`consent flow failed: ${error.message}`));

const tokenResponse = await fetch(TOKEN_ENDPOINT, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    code_verifier: verifier,
    grant_type: "authorization_code",
    redirect_uri: redirectUri
  })
});
const tokens = await tokenResponse.json();
if (!tokenResponse.ok || !tokens.refresh_token) {
  fail(`token exchange failed (${tokenResponse.status}): ${JSON.stringify({ ...tokens, access_token: undefined })}`);
}

const profileResponse = await fetch(PROFILE_ENDPOINT, {
  headers: { authorization: `Bearer ${tokens.access_token}` }
});
const profile = await profileResponse.json();
if (!profileResponse.ok) fail(`token works but profile check failed (${profileResponse.status})`);
if ((paco ? String(profile.emailAddress).toLowerCase() : profile.emailAddress) !== expectedIdentity) {
  fail(
    `authorized as ${profile.emailAddress}, expected ${expectedIdentity} — wrong Google account was signed in. Revoke at myaccount.google.com/permissions and re-run.`
  );
}

console.log(`\n✓ Authorized as ${profile.emailAddress} (${profile.messagesTotal} messages, read-only scope).`);

const mask = (v) => `${v.slice(0, 6)}…(${v.length} chars)`;
if (paco) {
  const line = "HOUGE_PACO_GMAIL_REFRESH_TOKEN";
  writeFileSync(envFile, upsertEnvLine(readFileSync(envFile, "utf8"), line, tokens.refresh_token));
  console.log(`✓ Wrote ${line}=${mask(tokens.refresh_token)} to ${envFile} (replacing any earlier line).`);
  console.log("Restart the daemon (launchctl kickstart) to load it.");
  process.exit(0);
}

const envLines =
  `\n# Houge Gmail identity (ADR 0008) — written by scripts/gmail-auth.mjs\n` +
  `HOUGE_GMAIL_CLIENT_ID=${clientId}\n` +
  `HOUGE_GMAIL_CLIENT_SECRET=${clientSecret}\n` +
  `HOUGE_GMAIL_REFRESH_TOKEN=${tokens.refresh_token}\n`;

if (existsSync(".env")) {
  appendFileSync(".env", envLines);
  console.log(`✓ Appended to ./.env:`);
  console.log(`  HOUGE_GMAIL_CLIENT_ID=${clientId}`);
  console.log(`  HOUGE_GMAIL_CLIENT_SECRET=${mask(clientSecret)}`);
  console.log(`  HOUGE_GMAIL_REFRESH_TOKEN=${mask(tokens.refresh_token)}`);
  console.log(`\nIf this is not the mini, move those three lines to the mini's .env.`);
} else {
  console.log(`\nNo ./.env here — add these lines to the mini's .env yourself:\n${envLines}`);
}
