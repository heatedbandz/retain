import { marked } from "marked";
import DOMPurify from "dompurify";
/* ---------- helpers ---------- */
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-5);
const clone = o => JSON.parse(JSON.stringify(o));
const md = s => {
  try { return DOMPurify.sanitize(marked.parse(String(s || ""), { breaks: true })); }
  catch { return esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/\n/g, "<br>"); }
};
const pad = n => String(n).padStart(2, "0");
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayStr = () => ymd(new Date());
const parseYmd = s => { const [y, m, d] = String(s).split("-").map(Number); return new Date(y, (m || 1) - 1, d || 1); };
const addDays = (s, n) => { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); };
const daysUntil = s => Math.round((parseYmd(s) - parseYmd(todayStr())) / 86400000);
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
function dueLabel(s) {
  if (!isDate(s)) return "No date";
  const n = daysUntil(s);
  if (n < 0) return n === -1 ? "Due yesterday" : `${-n} days late`;
  if (n === 0) return "Due today";
  if (n === 1) return "Due tomorrow";
  if (n < 7) return "Due " + parseYmd(s).toLocaleDateString(undefined, { weekday: "long" });
  return "Due " + parseYmd(s).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
const dueClass = s => !isDate(s) ? "" : daysUntil(s) < 0 ? "late" : daysUntil(s) === 0 ? "today" : "";
const fmtMin = m => m >= 60 ? (m % 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m / 60}h`) : `${m}m`;
const shortDate = t => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });

const COLORS = ["#2F6FED", "#E0533D", "#1F9D6B", "#C98A00", "#8B5CF6", "#0EA5B7", "#D9468F", "#6B7280"];
const TYPES = { homework: "Homework", test: "Test", quiz: "Quiz", project: "Project", reading: "Reading" };
const TYPE_WEIGHT = { test: 3, project: 2.6, quiz: 2, homework: 1.5, reading: 1 };
const TYPE_MIN = { homework: 30, test: 60, quiz: 30, project: 90, reading: 20 };
const GRADES = [["6", "6th grade"], ["7", "7th grade"], ["8", "8th grade"], ["9", "9th grade"], ["10", "10th grade"], ["11", "11th grade"], ["12", "12th grade"], ["college", "College"], ["other", "Other"]];
const gradeLabel = g => (GRADES.find(x => x[0] === g) || [0, "school"])[1];

/* ---------- state ---------- */
const S = { profile: null, tasks: [], history: [], backend: "local" };
const UI = {
  tab: "today", budget: 60, taskView: "list", calMonth: todayStr().slice(0, 7), showDone: false,
  login: { email: "", age: false, sent: false, busy: false, err: "" },
  quick: "", search: "", nbClass: "all", draft: null, newClass: "", tf: null,
  tutor: null, lesson: null, lessonTopic: "", lessonClass: "", focus: null, confirm: null
};
function newTutor(mode) {
  return { id: null, mode: mode || S.profile?.defaultMode || "learn", startMode: null, classId: "", question: "", image: null, imageUrl: "",
    turns: [], busy: false, ctl: null, hints: 0, topic: "", solved: false, error: "", follow: "", startedAt: 0, taskId: null };
}
UI.tutor = newTutor("learn");
const className = id => S.profile?.classes?.find(c => c.id === id)?.name || "";
const classColor = id => S.profile?.classes?.find(c => c.id === id)?.color || "var(--muted)";

/* ---------- storage: the student's Supabase account, with a copy in this browser for instant loads ---------- */
let SB = null, SESSION = null;
const uid = () => SESSION?.user?.id || "";
const lsKey = () => "retain.v1:" + (uid() || "anon");
function lsLoad() { try { return JSON.parse(localStorage.getItem(lsKey()) || "null"); } catch { return null; } }
function lsSave() { try { localStorage.setItem(lsKey(), JSON.stringify({ profile: S.profile, tasks: S.tasks, history: S.history.slice(0, 150) })); } catch {} }
const queues = {}; let pending = 0;
const run = async p => { const { error } = await p; if (error) throw error; };
function enqueue(key, fn) {
  pending++;
  queues[key] = (queues[key] || Promise.resolve()).then(fn).catch(e => {
    console.warn("save failed", key, e);
    toast("Couldn't save that change. Check your connection.");
  }).finally(() => { pending--; });
  return queues[key];
}
function saveProfile() {
  S.profile.updatedAt = Date.now(); lsSave();
  const data = clone(S.profile);
  enqueue("profile", () => run(SB.from("profiles").upsert({ user_id: uid(), data, updated_at: new Date().toISOString() })));
}
function saveTasks() {
  lsSave(); const items = clone(S.tasks);
  enqueue("tasks", () => run(SB.from("tasks").upsert({ user_id: uid(), items, updated_at: new Date().toISOString() })));
}
function trimEntry(e) {
  const c = clone(e);
  if (c.turns) { c.turns = c.turns.slice(-30).map(t => ({ role: t.role, content: String(t.content).slice(0, 6000), label: t.label || "" })); }
  return c;
}
function saveHistory(entry) {
  const e = trimEntry(entry);
  const i = S.history.findIndex(h => h.id === e.id);
  if (i >= 0) S.history[i] = e; else S.history.unshift(e);
  lsSave();
  enqueue("h:" + e.id, () => run(SB.from("history").upsert({ user_id: uid(), id: e.id, at: e.at, data: e }, { onConflict: "user_id,id" })));
}
function deleteHistory(id) {
  S.history = S.history.filter(h => h.id !== id); lsSave();
  enqueue("h:" + id, () => run(SB.from("history").delete().eq("id", id)));
}
let loaded = false;
async function loadAll() {
  const who = uid(); if (!who) return;
  const [p, t, h] = await Promise.all([
    SB.from("profiles").select("data").maybeSingle(),
    SB.from("tasks").select("items").maybeSingle(),
    SB.from("history").select("data").order("at", { ascending: false }).limit(300)
  ]);
  if (who !== uid() || pending) return;
  if (p.error || t.error || h.error) { console.warn(p.error || t.error || h.error); if (!loaded) toast("Couldn't load your notebook. Check your connection."); return; }
  loaded = true;
  const next = { profile: p.data?.data || null, tasks: t.data?.items || [], history: (h.data || []).map(r => r.data) };
  if (!next.profile && S.profile) return; // brand-new account still finishing setup on this device
  if (JSON.stringify(next) !== JSON.stringify({ profile: S.profile, tasks: S.tasks, history: S.history })) {
    Object.assign(S, next); lsSave(); render();
  }
}
function boot() {
  Object.assign(S, { profile: null, tasks: [], history: [] });
  Object.assign(UI, { tab: "today", draft: null, lesson: null, tf: null, focus: null, confirm: null });
  UI.tutor = newTutor("learn"); loaded = false;
  if (SESSION) {
    const local = lsLoad();
    if (local) { S.profile = local.profile || null; S.tasks = local.tasks || []; S.history = local.history || []; }
    loadAll();
  }
  renderFocus(); renderSheet(); render();
}
export async function start({ supabase }) {
  SB = supabase;
  const { data } = await SB.auth.getSession();
  SESSION = data.session;
  SB.auth.onAuthStateChange((_event, session) => {
    const changed = (session?.user?.id || "") !== uid();
    SESSION = session;
    if (changed) boot();
  });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") loadAll(); });
  boot();
}
async function signOut() { await SB.auth.signOut(); }
async function deleteEverything() {
  try {
    await run(SB.from("history").delete().eq("user_id", uid()));
    await run(SB.from("tasks").delete().eq("user_id", uid()));
    await run(SB.from("profiles").delete().eq("user_id", uid()));
    try { localStorage.removeItem(lsKey()); } catch {}
    await SB.auth.signOut();
  } catch (e) { console.warn(e); toast("Couldn't delete everything. Try again."); }
}

/* ---------- AI: calls go through /api/ai, which checks the sign-in and a daily limit ---------- */
const AI = "on", IMG_OK = true;
const aiReady = Promise.resolve();
async function toB64(file) {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1568 / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    return { media_type: "image/jpeg", data: c.toDataURL("image/jpeg", 0.85).split(",")[1] };
  } catch { throw { code: "image_rejected" }; }
}
async function callAI(input, opts = {}, json = false) {
  const messages = typeof input === "string" ? [{ role: "user", content: input }] : input;
  const images = opts.images ? await Promise.all([].concat(opts.images).slice(0, 3).map(toB64)) : [];
  const { data } = await SB.auth.getSession();
  if (!data.session) throw { code: "session_expired" };
  let res;
  try {
    res = await fetch("/api/ai", {
      method: "POST", signal: opts.signal,
      headers: { "content-type": "application/json", authorization: "Bearer " + data.session.access_token },
      body: JSON.stringify({ messages, images, tier: opts.modelTier || "default", json })
    });
  } catch (e) { throw { code: e?.name === "AbortError" ? "cancelled" : "upstream_error" }; }
  if (!res.ok) {
    let j = {}; try { j = await res.json(); } catch {}
    throw { code: j.code || (res.status === 401 ? "session_expired" : res.status === 429 ? "rate_limited" : "upstream_error"), message: j.message || "" };
  }
  const reader = res.body.getReader(); const dec = new TextDecoder();
  let buf = "", text = "", stop = "";
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const m = JSON.parse(line);
        if (m.d) { text += m.d; opts.onText?.({ text, delta: m.d }); }
        else if (m.error) throw { code: m.error, text };
        else if (m.stop) stop = m.stop;
      }
    }
  } catch (e) {
    if (e?.name === "AbortError" || opts.signal?.aborted) throw { code: "cancelled", text };
    throw e?.code ? e : { code: "upstream_error", text };
  }
  if (stop === "refusal") throw { code: "refused" };
  if (!text.trim()) throw { code: "empty_completion" };
  return { text, truncated: stop === "max_tokens" };
}
export function parseJsonLoose(t) {
  try { return JSON.parse(t); } catch {}
  const f = t.match(/```(?:json)?\s*([\s\S]*?)```/); if (f) { try { return JSON.parse(f[1]); } catch {} }
  const s = t.search(/[[{]/), e = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
  if (s >= 0 && e > s) { try { return JSON.parse(t.slice(s, e + 1)); } catch {} }
  throw { code: "invalid_json", text: t };
}
const SAMPLE = (input, opts) => callAI(input, opts, false);
SAMPLE.json = async (input, opts) => parseJsonLoose((await callAI(input, opts, true)).text);
function errCopy(e) {
  switch (e?.code) {
    case "rate_limited": return "You've used today's tutor limit. It resets tomorrow.";
    case "busy": return "The tutor is busy right now. Try again in a minute.";
    case "session_expired": return "You've been signed out. Sign in again to keep going.";
    case "image_rejected": return "That photo couldn't be used. Try a JPG or PNG, or type the problem instead.";
    case "refused": return "The tutor can't help with that one. Try asking a different way.";
    case "prompt_too_large": return "That's too much at once. Try a shorter piece, or start a new question.";
    case "invalid_json": return "The lesson came back in the wrong shape. Try again.";
    case "cancelled": return "";
    default: return "Couldn't reach the tutor. Check your connection and try again.";
  }
}
function memoryNote(classId) {
  const m = S.profile?.memory || {};
  const str = (m.struggles || []).slice().sort((a, b) => (b.classId === classId) - (a.classId === classId) || b.at - a.at).slice(0, 6)
    .map(s => s.topic + (className(s.classId) ? ` (${className(s.classId)})` : ""));
  const recent = S.history.filter(h => h.topic || h.title).slice(0, 6).map(h => h.topic || h.title);
  if (!str.length && !recent.length) return "";
  return "What you know about this student from earlier sessions (use it to connect ideas and pitch the explanation; don't list it back to them):\n" +
    (str.length ? `- Topics they've found hard: ${str.join("; ")}\n` : "") +
    (recent.length ? `- Recently studied: ${recent.join("; ")}\n` : "");
}
const FORMAT = "Write math in plain text with Unicode symbols (x², √, ×, ÷, ≤, π, ¾ or 3/4). Never use LaTeX or $ signs.";

/* ---------- tutor ---------- */
const MODE_TEXT = {
  learn: "LEARN MODE: the student wants to learn how to do this themselves. Use a hint ladder and do NOT give the final answer unless they ask for the full solution. In this reply: say in one sentence what the problem is asking, name the skill or idea it uses, and give ONE small hint for the first step. End with a short question inviting them to try that step.",
  answer: "ANSWER MODE: the student wants the answer. Start with the final answer in bold on its own line. Then give a short, clear step-by-step explanation of how to get it so they can follow along."
};
const ACTIONS = {
  hint: { label: "Next hint", text: "Give me the next hint: one step further, still without giving the final answer." },
  example: { label: "Show a similar example", text: "Show me a fully worked example of a similar problem (different numbers or details), step by step. Then ask me to try my problem the same way." },
  solution: { label: "Show the full solution", text: "Show the full step-by-step solution to my original problem, with the final answer in bold, and explain why each step works." },
  answer: { label: "Just give me the answer", text: "Just give me the final answer now, in bold, followed by a short explanation of how to get it." },
  differently: { label: "Explain it differently", text: "Explain that again a different way: use a simple analogy or a real-life example, and simpler words." },
  teach: { label: "Teach me how", text: "Now teach me how to do this kind of problem myself. Explain the method in short steps, then give me one similar practice problem to try (without its answer)." },
  practice: { label: "Give me one to practice", text: "Give me one new practice problem like this one, without the answer. I'll reply with my attempt." }
};
function tutorFirstTurn(T) {
  const p = S.profile || {}; const cls = className(T.classId);
  return `You are the tutor inside Retain, a study app. You're helping ${p.name || "a student"}, who is in ${gradeLabel(p.grade)}${cls ? `, with their ${cls} class` : ""}.
Match their grade level: plain words, short paragraphs, warm and encouraging without gushing. Keep replies under about 250 words unless they ask for a full solution.
Markdown is fine (bold, short lists, ### headings for longer answers). ${FORMAT}
If they ask you to write an essay or a whole assignment for them, help them plan and draft it themselves instead.
${memoryNote(T.classId)}
${MODE_TEXT[T.startMode]}

The student's question:
${T.question.trim() || "(See the attached photo.)"}${T.image ? "\n\n(They attached a photo of the problem. Read it carefully.)" : ""}`;
}
async function tutorCall(T) {
  await aiReady;
  if (!SAMPLE) { T.error = "AI help isn't available here."; renderTutorConvo(); return; }
  T.busy = true; T.error = ""; T.ctl = new AbortController();
  const ctl = T.ctl;
  const input = [{ role: "user", content: tutorFirstTurn(T) }, ...T.turns.map(t => ({ role: t.role, content: t.content }))];
  const bot = { role: "assistant", content: "", pending: true };
  T.turns.push(bot);
  renderTutorConvo();
  let raf = 0;
  try {
    const opts = { signal: ctl.signal, cache: false, onText: ({ text }) => {
      bot.content = text;
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; const el = document.getElementById("live"); if (el) { el.innerHTML = md(bot.content); el.classList.remove("thinking"); } });
    } };
    if (T.image && IMG_OK) opts.images = [T.image];
    const { text, truncated } = await SAMPLE(input, opts);
    bot.content = text + (truncated ? "\n\n_(Cut short. Ask me to continue.)_" : "");
    delete bot.pending;
    afterReply(T);
  } catch (e) {
    delete bot.pending;
    if (e?.text && e.code !== "refused") bot.content = e.text + "\n\n_(Interrupted.)_";
    else T.turns.pop();
    T.error = errCopy(e);
  } finally {
    T.busy = false; T.ctl = null;
    if (UI.tutor === T && UI.tab === "tutor") renderTutorConvo();
  }
}
async function afterReply(T) {
  persistTutor(T);
  if (!T.topic && SAMPLE) {
    try {
      const r = await SAMPLE.json(`Name the school topic of this question in 2 to 5 words, like "Solving two-step equations" or "Causes of World War I".
Question: ${T.question.slice(0, 600) || "(photo)"}
Tutor's first reply: ${(T.turns[0]?.content || "").slice(0, 600)}
Reply with only JSON: {"topic": string}`, { modelTier: "quick" });
      if (r && typeof r.topic === "string") { T.topic = r.topic.slice(0, 60); persistTutor(T); if (UI.tutor === T && UI.tab === "tutor") renderTutorHead(); }
    } catch {}
  }
}
function persistTutor(T) {
  if (!T.id) { T.id = newId(); T.startedAt = Date.now(); }
  saveHistory({ id: T.id, kind: "tutor", at: T.startedAt, updatedAt: Date.now(), classId: T.classId || "", topic: T.topic || "",
    mode: T.startMode, question: T.question, hadImage: !!T.image, hints: T.hints, solved: T.solved,
    turns: T.turns.filter(t => !t.pending && t.content) });
}
function noteStruggle(topic, classId, note) {
  if (!topic || !S.profile) return;
  const m = S.profile.memory = S.profile.memory || { struggles: [], wins: [] };
  m.struggles = m.struggles || [];
  const ex = m.struggles.find(s => s.topic.toLowerCase() === topic.toLowerCase());
  if (ex) { ex.at = Date.now(); ex.note = note; ex.count = (ex.count || 1) + 1; }
  else m.struggles.unshift({ id: newId(), topic, classId: classId || "", note, at: Date.now(), count: 1 });
  m.struggles = m.struggles.slice(0, 40);
  saveProfile();
}
function tutorAction(key) {
  const T = UI.tutor; if (T.busy) return;
  const a = ACTIONS[key]; if (!a) return;
  T.turns.push({ role: "user", content: a.text, label: a.label });
  if (key === "hint") T.hints++;
  if (key === "solution" || key === "answer") T.solved = true;
  if (T.startMode === "learn" && (key === "solution" || key === "answer" || (key === "hint" && T.hints === 2)))
    noteStruggle(T.topic, T.classId, key === "hint" ? "Needed several hints" : "Asked for the full solution");
  tutorCall(T);
}
function tutorSend(check) {
  const T = UI.tutor; const v = (T.follow || "").trim(); if (!v || T.busy) return;
  T.turns.push(check
    ? { role: "user", content: `Here's my attempt:\n${v}\n\nCheck my work. If it's right, tell me and say why. If it's wrong, point to the exact step where it went wrong and give a hint to fix it, without giving the full answer.`, label: "Check my work: " + v }
    : { role: "user", content: v, label: v });
  T.follow = "";
  tutorCall(T);
}
function tutorStart() {
  const T = UI.tutor;
  if (!T.question.trim() && !T.image) { toast("Type or paste your question first."); return; }
  T.startMode = T.mode; T.turns = []; T.hints = 0;
  tutorCall(T);
}
function openTutorFor(task) {
  const T = newTutor();
  T.classId = task.classId || ""; T.taskId = task.id;
  T.question = `I'm working on "${task.title}" for ${className(task.classId) || "school"}. I'm stuck. Here's the part I don't get: `;
  UI.tutor = T; UI.focus = null; renderFocus(); setTab("tutor");
  setTimeout(() => { const el = $("#q"); if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }, 30);
}

/* ---------- tasks ---------- */
function localParse(text) {
  let s = " " + text.trim() + " ", due = null;
  const lower = s.toLowerCase();
  const t0 = todayStr();
  const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const short = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  let m;
  if (/\btoday\b|\btonight\b/.test(lower)) due = t0;
  else if (/\btomorrow\b/.test(lower)) due = addDays(t0, 1);
  else if ((m = lower.match(/\bin (\d+) days?\b/))) due = addDays(t0, +m[1]);
  else if (/\bnext week\b/.test(lower)) due = addDays(t0, 7);
  else if ((m = lower.match(/\b(\d{1,2})\/(\d{1,2})\b/))) { const d = new Date(); let c = new Date(d.getFullYear(), +m[1] - 1, +m[2]); if (c < parseYmd(t0)) c.setFullYear(c.getFullYear() + 1); due = ymd(c); }
  else for (let i = 0; i < 7; i++) {
    if (new RegExp(`\\b(${days[i]}|${short[i]})\\b`).test(lower)) { let n = (i - new Date().getDay() + 7) % 7; if (n === 0) n = 7; due = addDays(t0, n); break; }
  }
  let type = "homework";
  if (/\b(test|exam|final|midterm)\b/.test(lower)) type = "test";
  else if (/\bquiz\b/.test(lower)) type = "quiz";
  else if (/\b(project|lab report|presentation|poster|essay)\b/.test(lower)) type = "project";
  else if (/\b(read|reading|chapter)\b/.test(lower)) type = "reading";
  const cls = (S.profile?.classes || []).find(c => lower.includes(c.name.toLowerCase()));
  let title = text.replace(/\s*\b(is\s+)?due\b.*$/i, "").replace(/\s*\b(on|by)\s+(mon|tue|wed|thu|fri|sat|sun)\w*\s*$/i, "").trim() || text.trim();
  return { title: title.slice(0, 120), classId: cls?.id || "", due: due || addDays(t0, 1), type, est: TYPE_MIN[type] };
}
async function quickAdd() {
  const text = UI.quick.trim(); if (!text) return;
  const btn = $("#quick-btn"); if (btn) { btn.disabled = true; btn.textContent = "Adding…"; }
  let t = localParse(text);
  await Promise.race([aiReady, new Promise(r => setTimeout(r, 1500))]);
  if (SAMPLE) {
    try {
      const cls = (S.profile?.classes || []).map(c => `${c.id}: ${c.name}`).join("\n") || "(none)";
      const r = await SAMPLE.json(`Today is ${new Date().toLocaleDateString(undefined, { weekday: "long" })} ${todayStr()}. Turn this student's note into a school task.
Their classes (id: name):
${cls}
Note: "${text}"
Reply with only JSON: {"title": short task title without the date words, "classId": one of the ids above or "", "due": "YYYY-MM-DD", "type": "homework"|"test"|"quiz"|"project"|"reading", "estMinutes": realistic minutes to do it or study tonight}. If no date is given, use tomorrow.`, { modelTier: "quick" });
      if (r && typeof r === "object") {
        if (typeof r.title === "string" && r.title.trim()) t.title = r.title.trim().slice(0, 120);
        if (S.profile.classes.some(c => c.id === r.classId)) t.classId = r.classId;
        if (isDate(r.due)) t.due = r.due;
        if (TYPES[r.type]) t.type = r.type;
        if (Number(r.estMinutes) > 0) t.est = Math.min(600, Math.round(Number(r.estMinutes) / 5) * 5 || 5);
      }
    } catch (e) { if (["not_granted", "sampling_disabled"].includes(e?.code)) errCopy(e); }
  }
  const task = { id: newId(), ...t, done: false, createdAt: Date.now() };
  S.tasks.push(task); saveTasks();
  UI.quick = "";
  render();
  toast(`Added "${task.title}" · ${dueLabel(task.due)}`);
}
function openTaskForm(task, presetDue) {
  UI.tf = task ? clone(task) : { id: "", title: "", classId: S.profile?.classes?.[0]?.id || "", due: presetDue || addDays(todayStr(), 1), type: "homework", est: 30 };
  renderSheet();
}
function saveTaskForm() {
  const f = UI.tf; if (!f.title.trim()) { toast("Give the task a name."); return; }
  f.est = Math.max(5, Number(f.est) || TYPE_MIN[f.type] || 30);
  if (!isDate(f.due)) f.due = addDays(todayStr(), 1);
  if (f.id) { const i = S.tasks.findIndex(t => t.id === f.id); if (i >= 0) S.tasks[i] = { ...S.tasks[i], ...f, title: f.title.trim() }; }
  else S.tasks.push({ ...f, id: newId(), title: f.title.trim(), done: false, createdAt: Date.now() });
  saveTasks(); UI.tf = null; renderSheet(); render(); toast("Saved");
}
function toggleDone(id) {
  const t = S.tasks.find(x => x.id === id); if (!t) return;
  t.done = !t.done; t.doneAt = t.done ? Date.now() : null; saveTasks(); render();
  if (t.done) toast(`Done: ${t.title}`);
}
function score(t) {
  const d = daysUntil(t.due); const w = TYPE_WEIGHT[t.type] || 1;
  return d < 0 ? 100 + w - d * 0.1 : w / (d + 1);
}
function makePlan() {
  const open = S.tasks.filter(t => !t.done).sort((a, b) => score(b) - score(a));
  const now = [], later = []; let used = 0;
  for (const t of open) {
    const m = t.est || 30; const d = daysUntil(t.due);
    if ((d <= 7) && (used + m <= UI.budget || now.length === 0)) { now.push(t); used += m; } else later.push(t);
  }
  return { now, later, used };
}
function exampleWeek() {
  const c = S.profile.classes; const cid = i => c.length ? c[i % c.length].id : "";
  const t0 = todayStr();
  const ex = [
    ["Read chapter 5 and take notes", 0, "reading", 20, 2],
    ["Worksheet: two-step equations", 1, "homework", 30, 0],
    ["Vocabulary quiz, unit 4", 2, "quiz", 20, 1],
    ["Unit 3 test", 4, "test", 60, 0],
    ["Lab report: plant growth", 9, "project", 90, 2]
  ].map(([title, d, type, est, ci]) => ({ id: newId(), title, classId: cid(ci), due: addDays(t0, d), type, est, done: false, example: true, createdAt: Date.now() }));
  S.tasks.push(...ex); saveTasks(); render(); toast("Added an example week. Remove it any time from Me.");
}

/* ---------- lessons ---------- */
async function makeLesson(topic, classId) {
  topic = (topic || "").trim(); if (!topic) { toast("Type a topic to learn."); return; }
  await aiReady;
  if (!SAMPLE) { toast("AI help isn't available here."); return; }
  const ctl = new AbortController();
  const fresh = makeLessonNoCache; makeLessonNoCache = false;
  UI.lesson = { id: newId(), topic, classId: classId || "", busy: true, ctl, data: null, picks: {}, at: Date.now(), error: "" };
  render();
  const p = S.profile || {}; const cls = className(classId);
  try {
    const data = await SAMPLE.json(`Write a short lesson for a student in ${gradeLabel(p.grade)} on: "${topic}"${cls ? ` (for their ${cls} class)` : ""}.
${memoryNote(classId)}
Use plain, friendly words and short paragraphs. ${FORMAT}
Reply with only JSON in exactly this shape:
{"title": string,
 "goal": one sentence saying what they'll be able to do after,
 "sections": [{"heading": string, "body": markdown string of 40 to 120 words}]  (3 or 4 sections, building from the basics up),
 "example": {"problem": string, "steps": [string], "answer": string},
 "mistakes": [string]  (2 or 3 common mistakes to avoid),
 "practice": [{"question": string, "choices": [4 strings], "answer": index 0-3 of the correct choice, "why": one or two sentences explaining the right answer}]  (4 questions, easier to harder, correct answers in varied positions)}`,
      { signal: ctl.signal, cache: fresh ? false : { gcTime: 3600000 } });
    if (!data || !Array.isArray(data.sections) || !Array.isArray(data.practice)) throw { code: "invalid_json" };
    data.practice = data.practice.filter(q => q && Array.isArray(q.choices) && q.choices.length >= 2 && Number.isInteger(Number(q.answer)) && Number(q.answer) < q.choices.length)
      .map(q => ({ ...q, answer: Number(q.answer) }));
    if (UI.lesson?.ctl !== ctl) return;
    UI.lesson.data = data; UI.lesson.busy = false; UI.lesson.ctl = null;
    persistLesson(UI.lesson);
  } catch (e) {
    if (UI.lesson?.ctl !== ctl) return;
    UI.lesson.busy = false; UI.lesson.ctl = null; UI.lesson.error = errCopy(e);
    if (e?.code === "cancelled") UI.lesson = null;
  }
  if (UI.tab === "learn") render();
}
function persistLesson(L) {
  const total = L.data.practice.length; const answered = Object.keys(L.picks).length;
  const right = Object.entries(L.picks).filter(([i, v]) => L.data.practice[i]?.answer === v).length;
  saveHistory({ id: L.id, kind: "lesson", at: L.at, updatedAt: Date.now(), classId: L.classId, topic: L.topic, title: L.data.title || L.topic,
    lesson: L.data, picks: L.picks, score: answered === total ? right : null, total });
}
function pickAnswer(qi, ci) {
  const L = UI.lesson; if (!L?.data || L.picks[qi] !== undefined) return;
  L.picks[qi] = ci;
  const q = L.data.practice[qi];
  if (q.answer !== ci) noteStruggle(L.data.title || L.topic, L.classId, "Missed a practice question");
  persistLesson(L);
  if (Object.keys(L.picks).length === L.data.practice.length) {
    const right = L.data.practice.filter((q, i) => L.picks[i] === q.answer).length;
    if (right === L.data.practice.length) markWin(L.data.title || L.topic);
  }
  render();
}
function markWin(topic) {
  const m = S.profile?.memory; if (!m) return;
  const before = (m.struggles || []).length;
  m.struggles = (m.struggles || []).filter(s => s.topic.toLowerCase() !== topic.toLowerCase());
  if (m.struggles.length !== before) { m.wins = [{ topic, at: Date.now() }, ...(m.wins || [])].slice(0, 40); saveProfile(); toast(`Nice. "${topic}" moved to things you've got.`); }
}

/* ---------- focus ---------- */
const WORK = 25 * 60, BREAK = 5 * 60;
let tick = 0, wake = null;
function startFocus(id) {
  const t = S.tasks.find(x => x.id === id); if (!t) return;
  UI.focus = { id, phase: "work", left: WORK, running: false, end: 0, rounds: 0 };
  renderFocus();
}
function focusToggle() {
  const F = UI.focus; if (!F) return;
  if (F.running) { F.left = Math.max(0, Math.round((F.end - Date.now()) / 1000)); F.running = false; clearInterval(tick); releaseWake(); }
  else { F.end = Date.now() + F.left * 1000; F.running = true; clearInterval(tick); tick = setInterval(focusTick, 500); grabWake(); }
  renderFocus();
}
function focusTick() {
  const F = UI.focus; if (!F || !F.running) return clearInterval(tick);
  F.left = Math.max(0, Math.round((F.end - Date.now()) / 1000));
  if (F.left <= 0) {
    beep();
    if (F.phase === "work") { F.rounds++; F.phase = "break"; F.left = BREAK; toast("Time for a 5-minute break."); }
    else { F.phase = "work"; F.left = WORK; toast("Break's over. Back to it."); }
    F.end = Date.now() + F.left * 1000;
    renderFocus(); return;
  }
  const c = $("#clock"); if (c) c.textContent = mmss(F.left);
  const b = $("#fbar"); if (b) b.style.width = (100 - F.left / (F.phase === "work" ? WORK : BREAK) * 100) + "%";
}
const mmss = s => `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
function exitFocus() { clearInterval(tick); releaseWake(); UI.focus = null; renderFocus(); render(); }
async function grabWake() { try { wake = await navigator.wakeLock?.request("screen"); } catch {} }
function releaseWake() { try { wake?.release(); } catch {} wake = null; }
let actx = null;
function beep() {
  try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); const o = actx.createOscillator(), g = actx.createGain();
    o.frequency.value = 880; g.gain.setValueAtTime(.15, actx.currentTime); g.gain.exponentialRampToValueAtTime(.001, actx.currentTime + .8);
    o.connect(g).connect(actx.destination); o.start(); o.stop(actx.currentTime + .8); } catch {}
}

/* ---------- render ---------- */
function setTab(t) { UI.tab = t; UI.confirm = null; render(); window.scrollTo(0, 0); }
function renderSync() {
  const el = $("#sync"); el.hidden = !SESSION; el.classList.add("cloud");
  el.querySelector("span").textContent = "Saved to your account";
}
function render() {
  const ae = document.activeElement; const fid = ae?.id; let sel = null;
  try { sel = fid && "selectionStart" in ae ? [ae.selectionStart, ae.selectionEnd] : null; } catch {}
  renderSync();
  const tabs = $("#tabs");
  if (!SESSION) { tabs.hidden = true; $("#view").innerHTML = viewLogin(); }
  else if (!S.profile) { tabs.hidden = true; $("#view").innerHTML = viewMe(true); }
  else {
    tabs.hidden = false;
    tabs.querySelectorAll(".tab").forEach(b => b.setAttribute("aria-current", b.dataset.tab === UI.tab ? "page" : "false"));
    const v = { today: viewToday, tutor: viewTutor, tasks: viewTasks, learn: viewLearn, notebook: viewNotebook, me: () => viewMe(false) }[UI.tab] || viewToday;
    $("#view").innerHTML = v();
  }
  if (fid) { const el = document.getElementById(fid); if (el && el !== document.activeElement) { el.focus({ preventScroll: true }); try { if (sel) el.setSelectionRange(sel[0], sel[1]); } catch {} } }
}
const classDot = id => `<span class="dot" style="background:${esc(classColor(id))}"></span>`;
const classOptions = (sel, none = "No class") => `<option value="">${esc(none)}</option>` + (S.profile?.classes || []).map(c => `<option value="${esc(c.id)}"${c.id === sel ? " selected" : ""}>${esc(c.name)}</option>`).join("");

function viewToday() {
  const p = S.profile; const now = new Date();
  const { now: plan, later, used } = makePlan();
  const open = S.tasks.filter(t => !t.done);
  const overdue = open.filter(t => daysUntil(t.due) < 0);
  const next7 = open.filter(t => { const d = daysUntil(t.due); return d >= 0 && d <= 7; });
  const heavy = next7.filter(t => t.type === "test" || t.type === "project");
  const load = next7.reduce((a, t) => a + (t.est || 30), 0);
  const doneWeek = S.tasks.filter(t => t.done && t.doneAt && Date.now() - t.doneAt < 7 * 86400000).length;
  const evening = now.getHours() >= 15;
  let banners = "";
  if (overdue.length) banners += `<div class="banner bad"><div><b>${overdue.length} ${overdue.length === 1 ? "thing is" : "things are"} past due.</b>They're at the top of your plan. If one no longer matters, open Tasks and delete it.</div></div>`;
  if (heavy.length >= 2 || load > UI.budget * 5) {
    const counts = ["test", "project", "quiz"].map(k => { const n = next7.filter(t => t.type === k).length; return n ? `${n} ${TYPES[k].toLowerCase()}${n > 1 ? (k === "quiz" ? "zes" : "s") : ""}` : ""; }).filter(Boolean).join(", ");
    banners += `<div class="banner warn"><div><b>Busy week ahead: ${esc(counts || fmtMin(load) + " of work")}.</b>About ${fmtMin(load)} of work in the next 7 days. A little each day now keeps it from piling up at the end.</div></div>`;
  }
  const budgets = [30, 60, 90, 120, 180].map(m => `<button class="chip" data-act="budget" data-m="${m}" aria-pressed="${UI.budget === m}">${fmtMin(m)}</button>`).join("");
  const week = Array.from({ length: 7 }, (_, i) => {
    const d = addDays(todayStr(), i); const items = open.filter(t => t.due === d);
    const hv = items.some(t => t.type === "test" || t.type === "project");
    return `<div class="wd${hv ? " heavy" : ""}${i === 0 ? " is-today" : ""}" title="${esc(items.map(t => t.title).join(", "))}"><div class="small muted">${parseYmd(d).toLocaleDateString(undefined, { weekday: "short" })}</div><div class="n">${items.length}</div></div>`;
  }).join("");
  const planHtml = plan.length ? `<ol class="plan">${plan.map(t => `<li>
      <div class="t"><b>${esc(t.title)}</b><div class="meta">${classDot(t.classId)}${esc(className(t.classId) || "No class")} · ${TYPES[t.type] || "Task"} · ~${fmtMin(t.est || 30)} · <span class="due ${dueClass(t.due)}">${dueLabel(t.due)}</span>${t.example ? ' <span class="tag ex">Example</span>' : ""}</div></div>
      <div class="acts"><button class="btn primary small" data-act="focus" data-id="${t.id}">Start</button><button class="btn small" data-act="done" data-id="${t.id}">Done</button><button class="btn ghost small" data-act="help" data-id="${t.id}">Get help</button></div>
    </li>`).join("")}</ol>
    <div class="fit"><span class="mono">${fmtMin(used)}</span> planned of <span class="mono">${fmtMin(UI.budget)}</span><span class="bar"><i style="width:${Math.min(100, used / UI.budget * 100)}%"></i></span></div>`
    : `<div class="empty"><h3>${open.length ? "Nothing urgent today." : "Your plan is empty."}</h3><p class="muted">${open.length ? "Everything open is more than a week away. Get a head start, or enjoy the break." : "Add what's due and Retain will turn it into a short list for each day."}</p>
       <div class="row"><button class="btn primary" data-act="tab" data-tab="tasks">Add assignments</button>${open.length ? "" : '<button class="btn" data-act="example">Load an example week</button>'}</div></div>`;
  const laterHtml = later.length ? `<details class="card"><summary><b>Can wait</b> <span class="muted">(${later.length})</span></summary><div class="tlist" style="margin-top:10px">${later.map(taskRow).join("")}</div></details>` : "";
  const struggles = (p.memory?.struggles || []).slice(0, 3);
  return `<section class="today-head">
      <p class="eyebrow">${now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</p>
      <h1>Hi ${esc(p.name || "there")}. Here's the plan for <mark>${evening ? "tonight" : "today"}</mark>.</h1>
    </section>
    ${banners}
    <div class="cols">
      <section class="stack">
        <div class="row"><span class="small muted" style="font-weight:700">Time I have ${evening ? "tonight" : "today"}:</span>${budgets}</div>
        ${planHtml}
        ${laterHtml}
      </section>
      <aside class="stack">
        <div class="card stack"><h3>Next 7 days</h3><div class="week">${week}</div><p class="small muted">Shaded days have a test or project.</p></div>
        <div class="card stack"><div class="spread"><h3>This week</h3><span class="score">${doneWeek}</span></div><p class="small muted">${doneWeek ? "tasks finished in the last 7 days. Keep going." : "Finish a task and it shows up here."}</p></div>
        ${struggles.length ? `<div class="card stack"><h3>Worth a review</h3>${struggles.map(s => `<div class="struggle"><div><b>${esc(s.topic)}</b><div class="meta">${esc(className(s.classId) || "")}</div></div><button class="btn small" data-act="review" data-topic="${esc(s.topic)}" data-class="${esc(s.classId)}">Review</button></div>`).join("")}</div>` : ""}
      </aside>
    </div>`;
}
function taskRow(t) {
  return `<div class="trow${t.done ? " done" : ""}">
    <button class="check${t.done ? " on" : ""}" data-act="done" data-id="${t.id}" aria-label="${t.done ? "Mark not done" : "Mark done"}"></button>
    <div class="t"><b>${esc(t.title)}</b><div class="meta">${classDot(t.classId)}${esc(className(t.classId) || "No class")} · ${TYPES[t.type] || "Task"} · ~${fmtMin(t.est || 30)} · <span class="due ${t.done ? "" : dueClass(t.due)}">${dueLabel(t.due)}</span>${t.example ? ' <span class="tag ex">Example</span>' : ""}</div></div>
    <div class="acts">${t.done ? "" : `<button class="btn ghost small" data-act="help" data-id="${t.id}">Help</button><button class="btn ghost small" data-act="learn-task" data-id="${t.id}">Learn</button>`}<button class="btn ghost small" data-act="edit" data-id="${t.id}">Edit</button></div>
  </div>`;
}
function viewTasks() {
  const open = S.tasks.filter(t => !t.done).sort((a, b) => a.due.localeCompare(b.due));
  const done = S.tasks.filter(t => t.done).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));
  const groups = [["Late", t => daysUntil(t.due) < 0], ["Today", t => daysUntil(t.due) === 0], ["Tomorrow", t => daysUntil(t.due) === 1], ["This week", t => daysUntil(t.due) > 1 && daysUntil(t.due) <= 7], ["Later", t => daysUntil(t.due) > 7]];
  const list = open.length ? groups.map(([name, f]) => { const items = open.filter(f); return items.length ? `<div class="gh"><h3>${name}</h3><span class="small muted">${items.length}</span></div><div class="tlist">${items.map(taskRow).join("")}</div>` : ""; }).join("")
    : `<div class="empty"><h3>No assignments yet.</h3><p class="muted">Type one above the way you'd say it, like "Spanish worksheet due Thursday".</p><button class="btn" data-act="example">Load an example week</button></div>`;
  const doneHtml = done.length ? `<details ${UI.showDone ? "open" : ""} data-act-toggle="showDone"><summary class="gh"><h3>Done</h3><span class="small muted">${done.length}</span></summary><div class="tlist">${done.slice(0, 50).map(taskRow).join("")}</div></details>` : "";
  return `<div class="spread"><div class="stack" style="gap:4px"><p class="eyebrow">Assignments</p><h1>Everything that's due</h1></div>
      <div class="seg" role="group" aria-label="View"><button data-act="tview" data-v="list" aria-pressed="${UI.taskView === "list"}">List</button><button data-act="tview" data-v="cal" aria-pressed="${UI.taskView === "cal"}">Calendar</button></div></div>
    <form class="card stack" data-form="quick">
      <label class="f" for="quick">Quick add</label>
      <div class="row" style="flex-wrap:nowrap"><input type="text" id="quick" data-bind="quick" value="${esc(UI.quick)}" placeholder='e.g. "Bio lab report due Friday" or "math test next Tuesday"' autocomplete="off"><button class="btn primary" id="quick-btn" type="submit">Add</button></div>
      <div class="row"><button class="btn ghost small" type="button" data-act="new-task">Add with details</button></div>
    </form>
    ${UI.taskView === "cal" ? viewCalendar() : `<section>${list}${doneHtml}</section>`}`;
}
function viewCalendar() {
  const [y, m] = UI.calMonth.split("-").map(Number);
  const first = new Date(y, m - 1, 1); const start = new Date(first); start.setDate(1 - first.getDay());
  const heads = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(d => `<div class="h">${d}</div>`).join("");
  let cells = "";
  for (let i = 0; i < 42; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i); const ds = ymd(d);
    if (i >= 35 && d.getMonth() !== m - 1) break;
    const items = S.tasks.filter(t => t.due === ds);
    cells += `<div class="cd${d.getMonth() !== m - 1 ? " out" : ""}${ds === todayStr() ? " is-today" : ""}" role="button" tabindex="0" data-act="cal-day" data-d="${ds}" aria-label="${d.toLocaleDateString()}: ${items.length} tasks">
      <span class="dn">${d.getDate()}</span>${items.slice(0, 3).map(t => `<span class="cchip${t.done ? " done" : ""}" style="--c:${esc(classColor(t.classId))}" data-act="edit" data-id="${t.id}" title="${esc(t.title)}">${esc(t.title)}</span>`).join("")}${items.length > 3 ? `<span class="small muted">+${items.length - 3}</span>` : ""}</div>`;
  }
  return `<section class="card stack cal-card"><div class="spread"><h2>${first.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</h2>
    <div class="row"><button class="btn small" data-act="cal-nav" data-n="-1" aria-label="Previous month">‹</button><button class="btn small" data-act="cal-today">Today</button><button class="btn small" data-act="cal-nav" data-n="1" aria-label="Next month">›</button></div></div>
    <div class="cal-wrap"><div class="cal">${heads}${cells}</div></div><p class="small muted">Tap a day to add something due then. Tap a task to edit it.</p></section>`;
}
function renderSheet() {
  const f = UI.tf; const el = $("#sheet");
  if (!f) { el.innerHTML = ""; return; }
  el.innerHTML = `<div class="sheet-bg" data-act="sheet-close"><form class="sheet" data-form="task" role="dialog" aria-label="${f.id ? "Edit task" : "New task"}">
    <div class="spread"><h2>${f.id ? "Edit task" : "New task"}</h2><button type="button" class="btn ghost small" data-act="sheet-close">Close</button></div>
    <label class="f">What is it?<input type="text" id="tf-title" data-bind="tf.title" value="${esc(f.title)}" placeholder="Chapter 7 questions"></label>
    <div class="grid2">
      <label class="f">Class<select id="tf-class" data-bind="tf.classId">${classOptions(f.classId)}</select></label>
      <label class="f">Type<select id="tf-type" data-bind="tf.type">${Object.entries(TYPES).map(([k, v]) => `<option value="${k}"${k === f.type ? " selected" : ""}>${v}</option>`).join("")}</select></label>
      <label class="f">Due<input type="date" id="tf-due" data-bind="tf.due" value="${esc(f.due)}"></label>
      <label class="f">Minutes it'll take<input type="number" id="tf-est" min="5" step="5" data-bind="tf.est" value="${esc(f.est)}"></label>
    </div>
    <div class="spread">${f.id ? (UI.confirm === "task" ? `<div class="row"><span class="small">Delete this task?</span><button type="button" class="btn small danger" data-act="task-del">Delete</button><button type="button" class="btn ghost small" data-act="confirm-cancel">Keep</button></div>` : `<button type="button" class="btn ghost danger small" data-act="task-del-ask">Delete</button>`) : "<span></span>"}
      <button class="btn primary" type="submit">Save</button></div>
  </form></div>`;
  setTimeout(() => { const t = $("#tf-title"); if (t && !f.id) t.focus(); }, 20);
}

function viewTutor() {
  return `<div id="tutor-head">${tutorHeadHtml()}</div><div id="tutor-body">${tutorBodyHtml()}</div>`;
}
function tutorHeadHtml() {
  const T = UI.tutor; const active = T.turns.length > 0;
  return `<div class="spread"><div class="stack" style="gap:4px"><p class="eyebrow">Tutor${T.topic ? " · " + esc(T.topic) : ""}</p><h1>${active ? (T.startMode === "learn" ? "Let's work through it" : "Here's your answer") : "What are you stuck on?"}</h1></div>
    ${active ? `<button class="btn" data-act="tutor-new">New question</button>` : ""}</div>`;
}
function tutorBodyHtml() {
  const T = UI.tutor;
  if (!T.turns.length) {
    const tasks = S.tasks.filter(t => !t.done).sort((a, b) => a.due.localeCompare(b.due)).slice(0, 4);
    return `<form class="card stack" data-form="ask">
      <div class="modecard" role="group" aria-label="How do you want help?">
        <button type="button" data-act="mode" data-m="learn" aria-pressed="${T.mode === "learn"}"><b>Help me learn it</b><span>Hints one step at a time, so you can solve it yourself.</span></button>
        <button type="button" data-act="mode" data-m="answer" aria-pressed="${T.mode === "answer"}"><b>Just the answer</b><span>The answer first, with a short explanation of how to get it.</span></button>
      </div>
      <label class="f" for="q">Your question</label>
      <textarea id="q" data-bind="q" placeholder="Type or paste the problem. For example: Solve 3x + 7 = 22">${esc(T.question)}</textarea>
      ${T.imageUrl ? `<div class="row"><img class="thumb" src="${T.imageUrl}" alt="Photo of the problem"><button type="button" class="btn ghost small" data-act="img-clear">Remove photo</button></div>` : ""}
      <div class="row">
        <select id="q-class" data-bind="q-class" style="max-width:220px" aria-label="Class">${classOptions(T.classId, "Which class?")}</select>
        ${IMG_OK ? `<label class="btn" for="q-img" style="display:inline-flex">Add a photo</label><input type="file" id="q-img" accept="image/*" hidden>` : ""}
        <button class="btn primary" type="submit" style="margin-left:auto"${AI === "loading" ? "" : ""}>Ask</button>
      </div>
    </form>
    ${tasks.length ? `<section class="stack"><h3>Stuck on one of these?</h3><div class="row">${tasks.map(t => `<button class="chip" data-act="help" data-id="${t.id}">${classDot(t.classId)}${esc(t.title)}</button>`).join("")}</div></section>` : ""}
    <p class="small muted">Everything you ask is saved to your Notebook, and the tutor remembers what you've found hard before.</p>`;
  }
  return `<div class="convo" id="convo">${convoHtml()}</div>`;
}
function convoHtml() {
  const T = UI.tutor;
  const first = `<div class="msg user"><div class="lbl">${T.startMode === "learn" ? "Help me learn it" : "Just the answer"}${className(T.classId) ? " · " + esc(className(T.classId)) : ""}</div>${esc(T.question)}${T.imageUrl ? `<div><img class="thumb" src="${T.imageUrl}" alt="Photo of the problem"></div>` : T.hadImage ? '<div class="small muted">(Photo not kept)</div>' : ""}</div>`;
  const msgs = T.turns.map((t, i) => t.role === "user" ? `<div class="msg user">${esc(t.label || t.content)}</div>`
    : `<div class="msg bot"><div class="who">Retain tutor</div><div class="prose${t.pending && !t.content ? " thinking" : ""}"${t.pending ? ' id="live"' : ""}>${t.pending && !t.content ? "Thinking" : md(t.content)}</div></div>`).join("");
  const last = T.turns[T.turns.length - 1];
  let acts = "";
  if (T.busy) acts = `<div class="acts"><button class="btn" data-act="tutor-stop">Stop</button></div>`;
  else if (last?.role === "user") acts = `<div class="acts"><button class="btn primary" data-act="tutor-retry">Try again</button></div>`;
  else {
    const learn = T.startMode === "learn" && !T.solved;
    const keys = learn ? ["hint", "example", "differently", "solution"] : ["differently", "teach", "practice"];
    acts = `${learn ? `<div class="ladder" aria-label="Hints used"><span>Hints</span>${[0, 1, 2, 3].map(i => `<i class="${i <= T.hints ? "on" : ""}"></i>`).join("")}</div>` : ""}
      <div class="acts">${keys.map(k => `<button class="btn${k === "hint" ? " primary" : ""}" data-act="ta" data-k="${k}">${ACTIONS[k].label}</button>`).join("")}${learn ? `<button class="btn ghost" data-act="ta" data-k="answer">Just give me the answer</button>` : ""}</div>`;
  }
  const err = T.error ? `<div class="banner bad"><div>${esc(T.error)}</div></div>` : "";
  const composer = T.busy ? "" : `<form class="composer stack" data-form="follow"><div class="row comp-row">
      <input type="text" id="follow" data-bind="followup" value="${esc(T.follow)}" placeholder="${T.startMode === "learn" && !T.solved ? "Type your attempt or a question" : "Ask a follow-up"}" autocomplete="off">
      <button class="btn" type="submit">Send</button>${T.startMode === "learn" ? `<button class="btn primary" type="button" data-act="check">Check my work</button>` : ""}</div></form>`;
  return first + msgs + err + acts + composer;
}
function renderTutorConvo() {
  if (UI.tab !== "tutor") return;
  const body = $("#tutor-body"); if (!body) return;
  const hadFocus = document.activeElement?.id === "follow";
  body.innerHTML = tutorBodyHtml(); renderTutorHead();
  const live = $("#live") || body.querySelector(".msg.bot:last-of-type");
  if (UI.tutor.busy && live) live.scrollIntoView({ block: "nearest", behavior: "smooth" });
  if (hadFocus || (!UI.tutor.busy && UI.tutor.turns.length)) { const f = $("#follow"); if (f && hadFocus) f.focus({ preventScroll: true }); }
}
function renderTutorHead() { const h = $("#tutor-head"); if (h) h.innerHTML = tutorHeadHtml(); }

function viewLearn() {
  const L = UI.lesson;
  if (L) {
    if (L.busy) return `<div class="stack"><p class="eyebrow">Lesson</p><h1>${esc(L.topic)}</h1><div class="card stack"><p class="thinking">Writing your lesson</p><p class="small muted">This usually takes under a minute.</p><div><button class="btn" data-act="lesson-stop">Stop</button></div></div></div>`;
    if (L.error) return `<div class="stack"><p class="eyebrow">Lesson</p><h1>${esc(L.topic)}</h1><div class="banner bad"><div>${esc(L.error)}</div></div><div class="row"><button class="btn primary" data-act="lesson-retry">Try again</button><button class="btn" data-act="lesson-close">Back</button></div></div>`;
    return lessonHtml(L);
  }
  const p = S.profile;
  const fromTasks = S.tasks.filter(t => !t.done).sort((a, b) => a.due.localeCompare(b.due)).slice(0, 5);
  const review = (p.memory?.struggles || []).slice(0, 6);
  const past = S.history.filter(h => h.kind === "lesson").slice(0, 6);
  return `<div class="stack" style="gap:4px"><p class="eyebrow">Learn</p><h1>Learn any topic in a few minutes</h1></div>
    <form class="card stack" data-form="lesson">
      <label class="f" for="lt">What do you want to learn?</label>
      <div class="row" style="flex-wrap:nowrap"><input type="text" id="lt" data-bind="lesson-topic" value="${esc(UI.lessonTopic)}" placeholder="e.g. Photosynthesis, slope-intercept form, the French Revolution" autocomplete="off"></div>
      <div class="row"><select id="lc" data-bind="lesson-class" style="max-width:220px" aria-label="Class">${classOptions(UI.lessonClass, "Which class?")}</select><button class="btn primary" type="submit" style="margin-left:auto">Make my lesson</button></div>
      <p class="small muted">Each lesson explains the idea, works an example, lists common mistakes, then quizzes you with 4 questions.</p>
    </form>
    ${review.length ? `<section class="stack"><h3>Things to review</h3><div class="row">${review.map(s => `<button class="chip" data-act="review" data-topic="${esc(s.topic)}" data-class="${esc(s.classId)}">${classDot(s.classId)}${esc(s.topic)}</button>`).join("")}</div></section>` : ""}
    ${fromTasks.length ? `<section class="stack"><h3>For your assignments</h3><div class="row">${fromTasks.map(t => `<button class="chip" data-act="learn-task" data-id="${t.id}">${classDot(t.classId)}${esc(t.title)}</button>`).join("")}</div></section>` : ""}
    ${past.length ? `<section class="stack"><h3>Your recent lessons</h3><div class="entries">${past.map(entryHtml).join("")}</div></section>` : ""}`;
}
function lessonHtml(L) {
  const d = L.data; const total = d.practice.length; const answered = Object.keys(L.picks).length;
  const right = d.practice.filter((q, i) => L.picks[i] === q.answer).length;
  return `<div class="spread"><div class="stack" style="gap:4px"><p class="eyebrow">Lesson${className(L.classId) ? " · " + esc(className(L.classId)) : ""}</p><h1>${esc(d.title || L.topic)}</h1></div><button class="btn" data-act="lesson-close">All lessons</button></div>
  <article class="card lesson">
    ${d.goal ? `<p><mark>Goal:</mark> ${esc(d.goal)}</p>` : ""}
    ${d.sections.map(s => `<section class="lesson-sec"><h2>${esc(s.heading)}</h2><div class="prose">${md(s.body)}</div></section>`).join("")}
    ${d.example ? `<section class="example"><p class="eyebrow">Worked example</p><p><b>${esc(d.example.problem)}</b></p><ol>${(d.example.steps || []).map(s => `<li class="prose">${md(s)}</li>`).join("")}</ol><p>Answer: <b>${esc(d.example.answer)}</b></p></section>` : ""}
    ${Array.isArray(d.mistakes) && d.mistakes.length ? `<section class="lesson-sec"><h2>Watch out for</h2><ul class="prose">${d.mistakes.map(m => `<li>${esc(m)}</li>`).join("")}</ul></section>` : ""}
  </article>
  <section class="card stack"><div class="spread"><h2>Check yourself</h2>${answered === total ? `<span class="score">${right}/${total}</span>` : `<span class="small muted">${answered} of ${total} answered</span>`}</div>
    ${d.practice.map((q, i) => { const pick = L.picks[i]; const did = pick !== undefined;
      return `<div class="q"><p><b>${i + 1}.</b> ${esc(q.question)}</p><div class="choices">${q.choices.map((c, ci) => `<button class="choice${did && ci === q.answer ? " right" : ""}${did && ci === pick && pick !== q.answer ? " wrong" : ""}" data-act="pick" data-q="${i}" data-c="${ci}"${did ? " disabled" : ""}><span class="k">${"ABCD"[ci] || ci + 1}</span><span>${esc(c)}</span></button>`).join("")}</div>
      ${did ? `<div class="why">${pick === q.answer ? "<b>Right.</b> " : "<b>Not quite.</b> "}${esc(q.why || "")}</div>` : ""}</div>`; }).join("")}
    ${answered === total ? `<div class="banner ${right === total ? "info" : "warn"}"><div><b>${right === total ? "All correct. This one's saved as something you've got." : "Saved to your Notebook as something to review."}</b>${right === total ? "" : "Ask the tutor about the ones you missed, or try a fresh lesson later."}</div></div>
      <div class="acts"><button class="btn primary" data-act="lesson-tutor">Ask the tutor about this</button><button class="btn" data-act="lesson-again">New lesson on this topic</button></div>` : ""}
  </section>`;
}

function entryHtml(h) {
  const isL = h.kind === "lesson";
  const ex = isL ? (h.lesson?.goal || "") : (h.question || "");
  const sc = isL && h.score != null ? ` · ${h.score}/${h.total}` : "";
  const confirming = UI.confirm === "h:" + h.id;
  return `<div class="entry"><div class="t" data-act="open-entry" data-id="${esc(h.id)}" role="button" tabindex="0">
      <div class="meta"><span class="tag">${isL ? "Lesson" : "Tutor"}</span>${className(h.classId) ? classDot(h.classId) + esc(className(h.classId)) + " · " : ""}${shortDate(h.updatedAt || h.at)}${sc}</div>
      <b>${esc(h.title || h.topic || (h.question || "").slice(0, 80) || "Question")}</b><div class="ex">${esc(ex)}</div></div>
    <div class="acts">${confirming ? `<button class="btn small danger" data-act="h-del" data-id="${esc(h.id)}">Delete</button><button class="btn ghost small" data-act="confirm-cancel">Keep</button>` : `<button class="btn ghost small" data-act="h-del-ask" data-id="${esc(h.id)}" aria-label="Delete">Delete</button>`}</div></div>`;
}
function filteredHistory() {
  const q = UI.search.trim().toLowerCase();
  return S.history.filter(h => (UI.nbClass === "all" || h.classId === UI.nbClass) && (!q ||
    [h.topic, h.title, h.question, ...(h.turns || []).map(t => t.content), h.lesson ? JSON.stringify(h.lesson) : ""].join(" ").toLowerCase().includes(q)));
}
function viewNotebook() {
  const p = S.profile; const struggles = p.memory?.struggles || []; const wins = p.memory?.wins || [];
  const chips = [["all", "All classes"], ...(p.classes || []).map(c => [c.id, c.name])].map(([id, n]) => `<button class="chip" data-act="nb-class" data-id="${esc(id)}" aria-pressed="${UI.nbClass === id}">${id !== "all" ? classDot(id) : ""}${esc(n)}</button>`).join("");
  return `<div class="stack" style="gap:4px"><p class="eyebrow">Notebook</p><h1>Everything you've asked and learned</h1></div>
  <div class="cols">
    <section class="stack">
      <input type="search" id="nb-search" data-bind="search" value="${esc(UI.search)}" placeholder="Search your notebook, like &quot;fractions&quot; or &quot;Civil War&quot;" aria-label="Search notebook">
      <div class="row">${chips}</div>
      <div class="entries" id="nb-list">${nbListHtml()}</div>
    </section>
    <aside class="stack">
      <div class="card"><h3>What Retain remembers</h3><p class="small muted" style="margin:4px 0 8px">The tutor uses this to explain things in a way that fits you. Remove anything that's no longer true.</p>
        ${struggles.length ? struggles.map(s => `<div class="struggle"><div><b>${esc(s.topic)}</b><div class="meta">${className(s.classId) ? classDot(s.classId) + esc(className(s.classId)) + " · " : ""}${esc(s.note || "")}</div></div><div class="acts"><button class="btn small" data-act="review" data-topic="${esc(s.topic)}" data-class="${esc(s.classId)}">Review</button><button class="btn ghost small" data-act="got-it" data-id="${esc(s.id)}">Got it</button></div></div>`).join("")
          : `<p class="small">Nothing yet. When you need several hints or miss a practice question, the topic shows up here so you can come back to it.</p>`}
      </div>
      ${wins.length ? `<div class="card stack"><h3>Things you've got</h3><div class="row">${wins.slice(0, 12).map(w => `<span class="chip" style="cursor:default">${esc(w.topic)}</span>`).join("")}</div></div>` : ""}
    </aside>
  </div>`;
}
function nbListHtml() {
  const list = filteredHistory();
  if (!S.history.length) return `<div class="empty"><h3>Your notebook is empty.</h3><p class="muted">Ask the tutor a question or make a lesson, and it's saved here automatically.</p><button class="btn primary" data-act="tab" data-tab="tutor">Ask the tutor</button></div>`;
  if (!list.length) return `<p class="muted">Nothing matches. Try a different word or class.</p>`;
  return list.slice(0, 100).map(entryHtml).join("");
}

function viewLogin() {
  const L = UI.login;
  return `<section class="stack" style="gap:10px;max-width:640px"><p class="eyebrow">Retain</p>
      <h1>Homework help, a plan for tonight, and a notebook that <mark>remembers</mark>.</h1>
      <p class="muted">Ask the tutor for hints or answers, keep every assignment in one list, learn any topic in a few minutes, and always know what to do next.</p></section>
    <form class="card stack" data-form="login" style="max-width:480px">
      ${L.sent ? `<div class="banner info"><div><b>Check your email.</b>We sent a sign-in link to ${esc(L.email)}. Open it on this device to finish signing in.</div></div>` : ""}
      <label class="f">Email<input type="email" id="login-email" data-bind="login.email" value="${esc(L.email)}" placeholder="you@example.com" autocomplete="email" required></label>
      <label class="row small" style="gap:8px;flex-wrap:nowrap"><input type="checkbox" id="login-age" data-bind="login.age"${L.age ? " checked" : ""}> I'm 13 or older</label>
      <button class="btn primary" type="submit"${L.busy ? " disabled" : ""}>${L.busy ? "Sending…" : "Email me a sign-in link"}</button>
      <button class="btn" type="button" data-act="login-google">Continue with Google</button>
      ${L.err ? `<p class="small" style="color:var(--bad)">${esc(L.err)}</p>` : ""}
      <p class="small muted">No password needed. <a href="/privacy">How we handle your data</a></p>
    </form>`;
}
async function loginEmail() {
  const L = UI.login; L.err = "";
  if (!L.age) { L.err = "Retain is for students 13 and older for now."; render(); return; }
  if (!/^\S+@\S+\.\S+$/.test(L.email.trim())) { L.err = "Enter a valid email address."; render(); return; }
  L.busy = true; render();
  const { error } = await SB.auth.signInWithOtp({ email: L.email.trim(), options: { emailRedirectTo: location.origin } });
  L.busy = false; L.sent = !error; L.err = error ? "Couldn't send the link. Check the address and try again." : ""; render();
}
async function loginGoogle() {
  const L = UI.login;
  if (!L.age) { L.err = "Retain is for students 13 and older for now."; render(); return; }
  const { error } = await SB.auth.signInWithOAuth({ provider: "google", options: { redirectTo: location.origin } });
  if (error) { L.err = "Google sign-in isn't working right now. Use your email instead."; render(); }
}
function viewMe(first) {
  if (!UI.draft) UI.draft = S.profile ? clone(S.profile) : { name: "", grade: "9", classes: [], memory: { struggles: [], wins: [] }, defaultMode: "learn" };
  const d = UI.draft;
  const exCount = S.tasks.filter(t => t.example).length;
  return `${first ? `<section class="stack" style="gap:8px;max-width:640px"><p class="eyebrow">Welcome to Retain</p><h1>Your schoolwork, your tutor, and your plan, all in <mark>one place</mark>.</h1><p class="muted">Set up your classes first. It takes a minute, and everything else builds on it.</p></section>` : `<div class="stack" style="gap:4px"><p class="eyebrow">Me</p><h1>You and your classes</h1></div>`}
  <form class="card stack" data-form="profile" style="max-width:640px">
    <div class="grid2">
      <label class="f">Your first name<input type="text" id="d-name" data-bind="draft.name" value="${esc(d.name)}" placeholder="Alex" autocomplete="given-name"></label>
      <label class="f">Grade<select id="d-grade" data-bind="draft.grade">${GRADES.map(([v, l]) => `<option value="${v}"${v === d.grade ? " selected" : ""}>${l}</option>`).join("")}</select></label>
    </div>
    <div class="stack" style="gap:8px"><span class="f" style="font-size:.85rem;font-weight:700;color:var(--muted)">Your classes</span>
      ${d.classes.length ? `<div class="row">${d.classes.map(c => `<span class="chip" style="cursor:default">${`<span class="dot" style="background:${esc(c.color)}"></span>`}${esc(c.name)}<button type="button" class="btn ghost small" style="padding:0 4px" data-act="class-del" data-id="${esc(c.id)}" aria-label="Remove ${esc(c.name)}">×</button></span>`).join("")}</div>` : `<p class="small muted">No classes yet. Add the ones you take, like Algebra 1, Biology, English 9.</p>`}
      <div class="row" style="flex-wrap:nowrap"><input type="text" id="new-class" data-bind="new-class" value="${esc(UI.newClass)}" placeholder="Class name" autocomplete="off"><button type="button" class="btn" data-act="class-add">Add class</button></div>
    </div>
    <label class="f">When you ask the tutor, start with<select id="d-mode" data-bind="draft.defaultMode"><option value="learn"${d.defaultMode !== "answer" ? " selected" : ""}>Help me learn it</option><option value="answer"${d.defaultMode === "answer" ? " selected" : ""}>Just the answer</option></select></label>
    <div class="row"><button class="btn primary" type="submit">${first ? "Start using Retain" : "Save"}</button></div>
  </form>
  ${first ? "" : `<section class="card stack" style="max-width:640px"><h3>Your account</h3>
    <p class="small">Signed in as <b>${esc(SESSION?.user?.email || "")}</b>. Your classes, tasks and notebook are private to you and follow you to any device where you sign in.</p>
    <div class="row">${exCount ? `<button class="btn" data-act="clear-examples">Remove ${exCount} example task${exCount > 1 ? "s" : ""}</button>` : `<button class="btn" data-act="example">Load an example week</button>`}<button class="btn" data-act="sign-out">Sign out</button></div>
    ${UI.confirm === "wipe" ? `<div class="banner bad"><div><b>Delete everything?</b>This erases your classes, tasks and notebook for good and signs you out.<div class="row" style="margin-top:8px"><button class="btn danger" data-act="wipe">Delete everything</button><button class="btn ghost" data-act="confirm-cancel">Keep my data</button></div></div></div>` : `<div><button class="btn ghost danger small" data-act="wipe-ask">Delete my data</button></div>`}
    <p class="small muted"><a href="/privacy">How Retain handles your data</a></p>
  </section>`}`;
}

function renderFocus() {
  const el = $("#focus"); const F = UI.focus;
  if (!F) { el.hidden = true; el.innerHTML = ""; return; }
  const t = S.tasks.find(x => x.id === F.id); if (!t) { UI.focus = null; el.hidden = true; return; }
  const total = F.phase === "work" ? WORK : BREAK;
  el.hidden = false;
  el.innerHTML = `<div class="focus-in" role="dialog" aria-label="Focus mode">
    <p class="meta" style="justify-content:center">${classDot(t.classId)}${esc(className(t.classId) || "No class")} · <span class="due ${dueClass(t.due)}">${dueLabel(t.due)}</span></p>
    <h2>${esc(t.title)}</h2>
    <span class="phase${F.phase === "break" ? " brk" : ""}">${F.phase === "work" ? "Focus" : "Break"}${F.rounds ? ` · round ${F.rounds + (F.phase === "work" ? 1 : 0)}` : ""}</span>
    <div class="clock" id="clock">${mmss(F.left)}</div>
    <div class="fbar"><i id="fbar" style="width:${100 - F.left / total * 100}%"></i></div>
    <div class="acts" style="justify-content:center">
      <button class="btn primary" data-act="f-toggle">${F.running ? "Pause" : F.left < total ? "Resume" : F.phase === "work" ? "Start 25 minutes" : "Start break"}</button>
      ${F.phase === "work" ? `<button class="btn" data-act="f-skip">Take a break now</button>` : `<button class="btn" data-act="f-skip">Skip break</button>`}
    </div>
    <p class="small muted">Just this one thing. Everything else can wait.</p>
    <div class="acts" style="justify-content:center">
      <button class="btn" data-act="f-done">I finished it</button>
      <button class="btn ghost" data-act="help" data-id="${t.id}">Stuck? Ask the tutor</button>
      <button class="btn ghost" data-act="learn-task" data-id="${t.id}">Learn this first</button>
      <button class="btn ghost" data-act="f-exit">Exit focus</button>
    </div></div>`;
}

let toastT = 0;
function toast(msg) { const el = $("#toast"); el.textContent = msg; el.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => el.hidden = true, 3200); }

/* ---------- events ---------- */
const BINDS = {
  "q": v => UI.tutor.question = v, "q-class": v => UI.tutor.classId = v, "followup": v => UI.tutor.follow = v,
  "quick": v => UI.quick = v, "search": v => { UI.search = v; const l = $("#nb-list"); if (l) l.innerHTML = nbListHtml(); },
  "lesson-topic": v => UI.lessonTopic = v, "lesson-class": v => UI.lessonClass = v, "new-class": v => UI.newClass = v
};
function onBind(e) {
  const b = e.target.dataset?.bind; if (!b) return;
  const v = e.target.type === "checkbox" ? e.target.checked : e.target.value;
  if (BINDS[b]) return BINDS[b](v);
  if (b.startsWith("login.")) UI.login[b.slice(6)] = v;
  if (b.startsWith("tf.") && UI.tf) UI.tf[b.slice(3)] = v;
  if (b.startsWith("draft.") && UI.draft) UI.draft[b.slice(6)] = v;
}
document.addEventListener("input", onBind);
document.addEventListener("change", e => {
  onBind(e);
  if (e.target.id === "q-img") {
    const f = e.target.files?.[0]; if (!f) return;
    const T = UI.tutor; if (T.imageUrl) URL.revokeObjectURL(T.imageUrl);
    T.image = f; T.imageUrl = URL.createObjectURL(f); render();
  }
});
document.addEventListener("toggle", e => { if (e.target.dataset?.actToggle === "showDone") UI.showDone = e.target.open; }, true);
document.addEventListener("submit", e => {
  const f = e.target.dataset?.form; if (!f) return;
  e.preventDefault();
  if (f === "quick") quickAdd();
  else if (f === "task") saveTaskForm();
  else if (f === "ask") tutorStart();
  else if (f === "follow") tutorSend(false);
  else if (f === "lesson") makeLesson(UI.lessonTopic, UI.lessonClass);
  else if (f === "profile") saveProfileForm();
  else if (f === "login") loginEmail();
});
function addClass() {
  const n = UI.newClass.trim(); if (!n) return;
  const d = UI.draft; d.classes.push({ id: newId(), name: n.slice(0, 40), color: COLORS[d.classes.length % COLORS.length] });
  UI.newClass = ""; render(); const el = $("#new-class"); if (el) el.focus();
}
function saveProfileForm() {
  const d = UI.draft; if (UI.newClass.trim()) addClass();
  if (!d.name.trim()) { toast("Add your first name."); return; }
  const first = !S.profile;
  S.profile = { ...d, name: d.name.trim() }; saveProfile();
  UI.draft = null; UI.tutor = newTutor();
  if (first) { UI.tab = "today"; toast(`Welcome, ${S.profile.name}.`); } else toast("Saved");
  render();
}
document.addEventListener("keydown", e => {
  if (e.key === "Escape") { if (UI.tf) { UI.tf = null; renderSheet(); } }
  if (e.key === "Enter" && e.target.id === "new-class") { e.preventDefault(); addClass(); }
  if ((e.key === "Enter" || e.key === " ") && e.target.matches?.('[role="button"][data-act]')) { e.preventDefault(); e.target.click(); }
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && e.target.id === "q") { e.preventDefault(); tutorStart(); }
});
document.addEventListener("click", e => {
  const el = e.target.closest("[data-act]"); if (!el) return;
  const a = el.dataset.act, id = el.dataset.id;
  const task = id ? S.tasks.find(t => t.id === id) : null;
  if (a === "sheet-close" && e.target !== el) return; // clicks inside the sheet
  e.stopPropagation();
  switch (a) {
    case "tab": setTab(el.dataset.tab); break;
    case "budget": UI.budget = +el.dataset.m; render(); break;
    case "focus": startFocus(id); break;
    case "done": toggleDone(id); break;
    case "help": if (task) openTutorFor(task); break;
    case "learn-task": if (task) { UI.focus = null; renderFocus(); UI.lessonTopic = task.title; UI.lessonClass = task.classId || ""; setTab("learn"); makeLesson(task.title, task.classId); } break;
    case "review": UI.lessonTopic = el.dataset.topic; UI.lessonClass = el.dataset.class || ""; setTab("learn"); makeLesson(el.dataset.topic, el.dataset.class); break;
    case "example": if (!S.profile) break; exampleWeek(); break;
    case "clear-examples": S.tasks = S.tasks.filter(t => !t.example); saveTasks(); render(); toast("Example tasks removed"); break;
    case "tview": UI.taskView = el.dataset.v; render(); break;
    case "new-task": openTaskForm(null); break;
    case "edit": if (task) openTaskForm(task); break;
    case "cal-day": openTaskForm(null, el.dataset.d); break;
    case "cal-nav": { const [y, m] = UI.calMonth.split("-").map(Number); const d = new Date(y, m - 1 + Number(el.dataset.n), 1); UI.calMonth = ymd(d).slice(0, 7); render(); break; }
    case "cal-today": UI.calMonth = todayStr().slice(0, 7); render(); break;
    case "sheet-close": UI.tf = null; UI.confirm = null; renderSheet(); break;
    case "task-del-ask": UI.confirm = "task"; renderSheet(); break;
    case "task-del": S.tasks = S.tasks.filter(t => t.id !== UI.tf.id); saveTasks(); UI.tf = null; UI.confirm = null; renderSheet(); render(); toast("Task deleted"); break;
    case "confirm-cancel": UI.confirm = null; if (UI.tf) renderSheet(); else render(); break;
    case "mode": UI.tutor.mode = el.dataset.m; render(); break;
    case "img-clear": { const T = UI.tutor; if (T.imageUrl) URL.revokeObjectURL(T.imageUrl); T.image = null; T.imageUrl = ""; render(); break; }
    case "ta": tutorAction(el.dataset.k); break;
    case "check": tutorSend(true); break;
    case "tutor-stop": UI.tutor.ctl?.abort(); break;
    case "tutor-retry": tutorCall(UI.tutor); break;
    case "tutor-new": UI.tutor.ctl?.abort(); UI.tutor = newTutor(); render(); break;
    case "lesson-stop": UI.lesson?.ctl?.abort(); break;
    case "lesson-retry": makeLesson(UI.lesson.topic, UI.lesson.classId); break;
    case "lesson-close": UI.lesson = null; render(); break;
    case "lesson-again": { const L = UI.lesson; makeLessonFresh(L.topic, L.classId); break; }
    case "lesson-tutor": { const L = UI.lesson; const T = newTutor("learn"); T.classId = L.classId; const missed = L.data.practice.filter((q, i) => L.picks[i] !== q.answer).map(q => q.question);
      T.question = missed.length ? `I just did a lesson on ${L.data.title || L.topic} and got these wrong:\n${missed.map(q => "- " + q).join("\n")}\nCan you help me understand them?` : `I just did a lesson on ${L.data.title || L.topic}. Can you give me a harder problem to try?`;
      UI.tutor = T; setTab("tutor"); break; }
    case "pick": pickAnswer(+el.dataset.q, +el.dataset.c); break;
    case "open-entry": openEntry(id); break;
    case "h-del-ask": UI.confirm = "h:" + id; refreshEntries(); break;
    case "h-del": deleteHistory(id); UI.confirm = null; refreshEntries(); toast("Deleted"); break;
    case "nb-class": UI.nbClass = id; render(); break;
    case "got-it": { const m = S.profile.memory; const s = m.struggles.find(x => x.id === id); if (s) markWin(s.topic); render(); break; }
    case "class-add": addClass(); break;
    case "class-del": UI.draft.classes = UI.draft.classes.filter(c => c.id !== id); render(); break;
    case "f-toggle": focusToggle(); break;
    case "f-skip": { const F = UI.focus; F.phase = F.phase === "work" ? "break" : "work"; if (F.phase === "break") F.rounds++; F.left = F.phase === "work" ? WORK : BREAK; F.end = Date.now() + F.left * 1000; renderFocus(); break; }
    case "f-done": { const t = S.tasks.find(x => x.id === UI.focus.id); if (t && !t.done) toggleDone(t.id); exitFocus(); break; }
    case "f-exit": exitFocus(); break;
    case "login-google": loginGoogle(); break;
    case "sign-out": signOut(); break;
    case "wipe-ask": UI.confirm = "wipe"; render(); break;
    case "wipe": deleteEverything(); break;
  }
});
function refreshEntries() { if (UI.tab === "notebook") { const l = $("#nb-list"); if (l) l.innerHTML = nbListHtml(); } else render(); }
function makeLessonFresh(topic, classId) { makeLessonNoCache = true; makeLesson(topic, classId); }
let makeLessonNoCache = false;
function openEntry(id) {
  const h = S.history.find(x => x.id === id); if (!h) return;
  if (h.kind === "lesson" && h.lesson) {
    UI.lesson = { id: h.id, topic: h.topic, classId: h.classId, busy: false, data: clone(h.lesson), picks: clone(h.picks || {}), at: h.at, error: "" };
    setTab("learn");
  } else {
    const T = newTutor(h.mode); Object.assign(T, { id: h.id, startMode: h.mode || "learn", mode: h.mode || "learn", classId: h.classId || "", question: h.question || "", topic: h.topic || "",
      hints: h.hints || 0, solved: !!h.solved, startedAt: h.at, hadImage: h.hadImage, turns: clone(h.turns || []) });
    UI.tutor = T; setTab("tutor");
  }
}

