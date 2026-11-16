import { createClient } from "@supabase/supabase-js";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export const runtime = "nodejs";
export const maxDuration = 30;

// Reads a student's Canvas calendar feed (the private .ics link Canvas gives every student under
// Calendar > Calendar Feed) and returns their assignments. No school admin setup is needed.

const FEED_PATH = /^\/feeds\/calendars\/user_[A-Za-z0-9]{20,80}\.ics$/;
const MAX_BYTES = 5_000_000;

function fail(code: string, status: number, message: string) {
  return Response.json({ code, message }, { status });
}

function privateAddress(ip: string) {
  if (ip.includes(":")) {
    const v = ip.toLowerCase();
    if (v.startsWith("::ffff:")) return privateAddress(v.slice(7));
    return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe8") || v.startsWith("fe9") || v.startsWith("fea") || v.startsWith("feb");
  }
  const [a, b] = ip.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

/** Only lets the server fetch a real Canvas feed link on a public host. */
async function checkFeedUrl(raw: string): Promise<URL | string> {
  let u: URL;
  try { u = new URL(raw.trim().replace(/^webcal:\/\//i, "https://")); } catch { return "That doesn't look like a link."; }
  if (u.protocol !== "https:") return "Use the https link Canvas gives you.";
  if (u.username || u.password || (u.port && u.port !== "443")) return "That isn't a Canvas calendar feed link.";
  if (!FEED_PATH.test(u.pathname)) return "That isn't a Canvas calendar feed link. It should end in .ics.";
  if (isIP(u.hostname)) return "That isn't a Canvas calendar feed link.";
  try {
    const addrs = await lookup(u.hostname, { all: true });
    if (!addrs.length || addrs.some(a => privateAddress(a.address))) return "That link's website can't be reached.";
  } catch { return "That link's website can't be found."; }
  return u;
}

async function fetchFeed(start: URL): Promise<string | { code: string; message: string; status: number }> {
  let url = start;
  for (let hop = 0; hop < 4; hop++) {
    const res = await fetch(url, { redirect: "manual", headers: { accept: "text/calendar" }, signal: AbortSignal.timeout(15_000) });
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get("location"); if (!next) break;
      const checked = await checkFeedUrl(new URL(next, url).toString());
      if (typeof checked === "string") return { code: "bad_feed", message: checked, status: 400 };
      url = checked; continue;
    }
    if (res.status === 401 || res.status === 403 || res.status === 404) return { code: "feed_gone", message: "Canvas didn't accept that link. Copy a fresh one from your Canvas calendar.", status: 400 };
    if (!res.ok || !res.body) return { code: "upstream_error", message: "Canvas didn't answer. Try again in a minute.", status: 502 };
    const reader = res.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length; if (size > MAX_BYTES) { reader.cancel(); return { code: "too_large", message: "That calendar is too big to read.", status: 413 }; }
      chunks.push(value);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    if (!text.includes("BEGIN:VCALENDAR")) return { code: "bad_feed", message: "That link didn't return a calendar.", status: 400 };
    return text;
  }
  return { code: "upstream_error", message: "Canvas sent too many redirects.", status: 502 };
}

type Assignment = { uid: string; title: string; course: string; due: string; allDay: boolean; url: string };

const unescapeText = (s: string) => s.replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1").trim();

/** Turns DTSTART into an ISO time (or YYYY-MM-DD for all-day items) so the browser can use the student's own time zone. */
function parseWhen(params: string, value: string): { due: string; allDay: boolean } | null {
  const d = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!d) return null;
  const [, y, mo, da, h, mi, se, z] = d;
  if (!h || /VALUE=DATE(?!-)/i.test(params)) return { due: `${y}-${mo}-${da}`, allDay: true };
  // Canvas sends UTC ("Z"). A time with a TZID is kept as a wall-clock time, which is right for nearly every school.
  return { due: `${y}-${mo}-${da}T${h}:${mi}:${se}${z ? "Z" : ""}`, allDay: false };
}

function parseIcs(text: string): Assignment[] {
  const lines = text.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "").split(/\r?\n/);
  const out: Assignment[] = [];
  let ev: Record<string, { params: string; value: string }> | null = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") { ev = {}; continue; }
    if (line === "END:VEVENT") {
      if (ev) {
        const uid = ev.UID?.value || ""; const when = ev.DTSTART && parseWhen(ev.DTSTART.params, ev.DTSTART.value);
        // Canvas marks assignments (and quizzes and discussions with due dates) as event-assignment-<id>.
        if (/assignment/i.test(uid) && when) {
          const summary = unescapeText(ev.SUMMARY?.value || "Assignment");
          const m = summary.match(/^(.*?)\s*\[([^\]]+)\]\s*$/);
          const url = ev.URL?.value || "";
          out.push({ uid: uid.slice(0, 200), title: (m ? m[1] : summary).slice(0, 160) || "Assignment", course: (m ? m[2] : "").slice(0, 80), ...when, url: /^https:\/\//.test(url) ? url.slice(0, 500) : "" });
        }
      }
      ev = null; continue;
    }
    if (!ev) continue;
    const i = line.indexOf(":"); if (i < 0) continue;
    const [name, ...params] = line.slice(0, i).split(";");
    ev[name.toUpperCase()] = { params: params.join(";"), value: line.slice(i + 1) };
  }
  return out;
}

export async function POST(req: Request) {
  const auth = req.headers.get("authorization") || "";
  if (!auth.startsWith("Bearer ")) return fail("session_expired", 401, "Sign in again.");
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  const { data: userData } = await supabase.auth.getUser(auth.slice(7));
  if (!userData.user) return fail("session_expired", 401, "Sign in again.");

  let body: { url?: unknown };
  try { body = await req.json(); } catch { return fail("invalid_request", 400, "Body must be JSON"); }
  if (typeof body.url !== "string" || body.url.length > 600) return fail("bad_feed", 400, "Paste your Canvas calendar feed link.");
  const checked = await checkFeedUrl(body.url);
  if (typeof checked === "string") return fail("bad_feed", 400, checked);

  let text: Awaited<ReturnType<typeof fetchFeed>>;
  try { text = await fetchFeed(checked); } catch { return fail("upstream_error", 502, "Canvas didn't answer. Try again in a minute."); }
  if (typeof text !== "string") return fail(text.code, text.status, text.message);
  const assignments = parseIcs(text);
  return Response.json({ assignments: assignments.slice(0, 1000) }, { headers: { "cache-control": "no-store" } });
}
