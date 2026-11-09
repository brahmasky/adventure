import { googleApiGetJson, type GoogleApiDeps, type GoogleApiQuery } from "../capabilities/google-api.js";
import type { GoogleAuthClient } from "../capabilities/google-auth.js";
import { ADDRESS_RE, type GmailMetadata } from "./envelope.js";

export type GmailErr = { ok: false; kind: "auth" | "not_found" | "unavailable"; status?: number };
type Ref = { id: string; threadId: string };

const BASE = "/gmail/v1/users/me";
const MAX_PAGES = 50;

function classify(r: { error: string; status?: number }): GmailErr {
  const status = r.status;
  const kind = status === 401 || status === 403 || r.error.startsWith("google auth auth_failed") ? "auth" : status === 404 ? "not_found" : "unavailable";
  return status === undefined ? { ok: false, kind } : { ok: false, kind, status };
}

const rec = (v: unknown): Record<string, unknown> | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

function ref(v: unknown): Ref | undefined {
  const m = rec(v);
  return m && typeof m.id === "string" && m.id !== "" && typeof m.threadId === "string" ? { id: m.id, threadId: m.threadId } : undefined;
}

export async function historyRange(start: string, deps: GoogleApiDeps, auth: GoogleAuthClient): Promise<{ ok: true; ids: Ref[]; historyId: string } | GmailErr> {
  const ids: Ref[] = [];
  const seen = new Set<string>();
  let historyId = start;
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const query: Record<string, string> = { startHistoryId: start, maxResults: "500", historyTypes: "messageAdded", labelId: "INBOX" };
    if (pageToken) query.pageToken = pageToken;
    const r = await googleApiGetJson(`${BASE}/history`, query, deps, auth);
    if (!r.ok) return classify(r);
    const body = rec(r.json);
    for (const h of Array.isArray(body?.history) ? body.history : []) {
      const added = rec(h)?.messagesAdded;
      for (const a of Array.isArray(added) ? added : []) {
        const m = ref(rec(a)?.message);
        if (m && !seen.has(m.id)) { seen.add(m.id); ids.push(m); }
      }
    }
    if (typeof body?.historyId === "string") historyId = body.historyId;
    pageToken = typeof body?.nextPageToken === "string" && body.nextPageToken !== "" ? body.nextPageToken : undefined;
    if (!pageToken) return { ok: true, ids, historyId };
  }
  return { ok: false, kind: "unavailable" };
}

export async function getMetadata(id: string, deps: GoogleApiDeps, auth: GoogleAuthClient): Promise<{ ok: true; m: GmailMetadata } | GmailErr> {
  const query: GoogleApiQuery = [["format", "metadata"], ["metadataHeaders", "From"], ["metadataHeaders", "Subject"], ["metadataHeaders", "Date"]];
  const r = await googleApiGetJson(`${BASE}/messages/${id}`, query, deps, auth);
  if (!r.ok) return classify(r);
  const m = rec(r.json);
  if (!m || typeof m.id !== "string" || typeof m.threadId !== "string") return { ok: false, kind: "unavailable" };
  return { ok: true, m: m as unknown as GmailMetadata };
}

export async function profileHistoryId(deps: GoogleApiDeps, auth: GoogleAuthClient): Promise<{ ok: true; historyId: string } | GmailErr> {
  const r = await googleApiGetJson(`${BASE}/profile`, undefined, deps, auth);
  if (!r.ok) return classify(r);
  const h = rec(r.json)?.historyId;
  return typeof h === "string" && h !== "" ? { ok: true, historyId: h } : { ok: false, kind: "unavailable" };
}

export async function listInbox(q: string, cap: number, deps: GoogleApiDeps, auth: GoogleAuthClient): Promise<{ ok: true; ids: Ref[]; more: boolean } | GmailErr> {
  const ids: Ref[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const query: Record<string, string> = { q, labelIds: "INBOX", maxResults: String(Math.min(Math.max(cap, 1), 500)) };
    if (pageToken) query.pageToken = pageToken;
    const r = await googleApiGetJson(`${BASE}/messages`, query, deps, auth);
    if (!r.ok) return classify(r);
    const body = rec(r.json);
    for (const v of Array.isArray(body?.messages) ? body.messages : []) {
      const m = ref(v);
      if (m && ids.length < cap) ids.push(m);
      else if (m) return { ok: true, ids, more: true };
    }
    pageToken = typeof body?.nextPageToken === "string" && body.nextPageToken !== "" ? body.nextPageToken : undefined;
    if (!pageToken) return { ok: true, ids, more: false };
    if (ids.length >= cap) return { ok: true, ids, more: true };
  }
  return { ok: true, ids, more: true };
}

export async function sentTo(address: string, deps: GoogleApiDeps, auth: GoogleAuthClient): Promise<{ ok: true; found: boolean } | GmailErr> {
  if (!ADDRESS_RE.test(address)) return { ok: true, found: false };
  const r = await googleApiGetJson(`${BASE}/messages`, { q: `in:sent to:"${address}"`, maxResults: "1" }, deps, auth);
  if (!r.ok) return classify(r);
  const msgs = rec(r.json)?.messages;
  return { ok: true, found: Array.isArray(msgs) && msgs.length > 0 };
}
