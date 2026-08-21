import { render } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";

/* ------------------------------------------------------------------ api */

const TOKEN_KEY = "toren.console.token";
const getToken = () => localStorage.getItem(TOKEN_KEY) ?? "";
const setToken = (t) => localStorage.setItem(TOKEN_KEY, t);
const clearToken = () => localStorage.removeItem(TOKEN_KEY);

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: {
      authorization: `Bearer ${getToken()}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json.error ?? `${res.status}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

/* ------------------------------------------------------------ utilities */

const short = (id) => (id ?? "").slice(0, 8);
const ago = (iso) => {
  if (!iso) return "—";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

function usePoll(fn, ms, deps) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    const run = async () => { try { await fn(); } catch { /* surfaced elsewhere */ } if (alive) setTick((t) => t + 1); };
    run();
    const iv = setInterval(run, ms);
    return () => { alive = false; clearInterval(iv); };
  }, deps ?? []);
  return tick;
}

function copy(text) { navigator.clipboard?.writeText(text); }

const StatusChip = ({ status, waiting }) => {
  const s = waiting ? "waiting_approval" : status;
  return <span class={`chip chip-${s}`}>{s === "waiting_approval" ? "awaiting approval" : s}</span>;
};

const Mark = () => (
  <svg viewBox="0 0 64 104" width="15" height="25" aria-hidden="true">
    <defs><mask id="cm"><rect width="64" height="104" fill="white" /><rect x="-16" y="47" width="96" height="8" fill="black" transform="rotate(-12 32 52)" /></mask></defs>
    <rect x="12" y="4" width="40" height="96" rx="7" fill="currentColor" mask="url(#cm)" />
  </svg>
);

/* ---------------------------------------------------------------- login */

function Login({ onIn }) {
  const [value, setValue] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr("");
    setToken(value.trim());
    try {
      await api("GET", "/runs");
      onIn();
    } catch {
      clearToken();
      setErr("That credential was refused. Paste the admin token (TOREN_API_TOKEN) or an issued API key.");
    } finally { setBusy(false); }
  };

  return (
    <div class="login-wrap">
      <form class="login-card" onSubmit={submit}>
        <div class="login-brand"><Mark /> <b>TOREN</b> <span class="dwg">CONSOLE</span></div>
        <h1>Present credentials.</h1>
        <p class="muted">The admin token unlocks everything, including key management. An issued API key (<code>trn_…</code>) operates runs and approvals only.</p>
        <input
          type="password" autofocus placeholder="TOREN_API_TOKEN  ·  trn_…"
          value={value} onInput={(e) => setValue(e.currentTarget.value)}
        />
        {err && <div class="form-err">{err}</div>}
        <button class="btn-primary" disabled={busy || !value.trim()}>{busy ? "Checking…" : "Enter the console"}</button>
        <p class="fine">Tip: <code>toren dev</code> prints a pre-authenticated link.</p>
      </form>
    </div>
  );
}

/* ----------------------------------------------------------------- runs */

function RunsPage({ nav }) {
  const [runs, setRuns] = useState(null);
  const [showNew, setShowNew] = useState(false);
  // Sessions live on their own page — an open conversation parked on input
  // reads as a stuck "running" job in this table otherwise.
  usePoll(async () => setRuns((await api("GET", "/runs")).runs.filter((r) => r.mode !== "session")), 2500);

  return (
    <div class="page">
      <div class="page-head">
        <div>
          <div class="overline">SHT 01 · OPERATIONS</div>
          <h1>Runs</h1>
        </div>
        <div class="head-actions">
          <span class="live-dot" title="polling every 2.5s"><i />LIVE</span>
          <button class="btn-primary" onClick={() => setShowNew(true)}>+ New run</button>
        </div>
      </div>

      {runs === null ? <div class="empty">Loading…</div> : runs.length === 0 ? (
        <div class="empty">
          <b>No runs yet.</b>
          <span>Start one here, or from the CLI: <code>toren run . --input '"hello"'</code></span>
        </div>
      ) : (
        <table class="sheet-table">
          <thead><tr><th>Run</th><th>Agent</th><th>Status</th><th>Started</th></tr></thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.runId} class="rowlink" onClick={() => nav(`#/runs/${r.runId}`)}>
                <td class="mono">{short(r.runId)}<span class="dim">…</span></td>
                <td>{r.agent}</td>
                <td><StatusChip status={r.status} /></td>
                <td class="dim">{ago(r.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {showNew && <NewRun onClose={() => setShowNew(false)} nav={nav} />}
    </div>
  );
}

function NewRun({ onClose, nav }) {
  const [input, setInput] = useState("");
  const [agent, setAgent] = useState("");
  const [agents, setAgents] = useState([]);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api("GET", "/agent").then((r) => {
      const names = r.agent?.crews ? Object.keys(r.agent.crews) : [r.agent?.name].filter(Boolean);
      setAgents(names);
      setAgent(r.agent?.default ?? names[0] ?? "");
    }).catch(() => {});
  }, []);
  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setErr("");
    try {
      const { runId } = await api("POST", "/runs", { input, ...(agent ? { agent } : {}) });
      onClose(); nav(`#/runs/${runId}`);
    } catch (ex) { setErr(String(ex.message)); } finally { setBusy(false); }
  };
  return (
    <div class="modal-back" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <form class="modal" onSubmit={submit}>
        <div class="overline">NEW RUN</div>
        <h2>Give the agent its input</h2>
        {agents.length > 1 && (
          <div class="agent-select">
            {agents.map((n) => (
              <button type="button" key={n} class={`agent-opt${n === agent ? " on" : ""}`} onClick={() => setAgent(n)}>{n}</button>
            ))}
          </div>
        )}
        <p class="muted">Passed verbatim as the workflow's <code>ctx.input</code> string; many agents expect JSON, e.g. <code>["topic a","topic b"]</code>.</p>
        <textarea rows="4" autofocus placeholder='["research this","and this"]' value={input} onInput={(e) => setInput(e.currentTarget.value)} />
        {err && <div class="form-err">{err}</div>}
        <div class="modal-actions">
          <button type="button" class="btn-ghost" onClick={onClose}>Cancel</button>
          <button class="btn-primary" disabled={busy || !input.trim()}>{busy ? "Starting…" : "Start run"}</button>
        </div>
      </form>
    </div>
  );
}

/* ----------------------------------------------------------- run detail */

const EVENT_TONE = {
  LlmCallCompleted: "teal", ToolCallCompleted: "teal", TaskCompleted: "teal",
  WaveSettled: "teal", RunCompleted: "teal",
  RunFailed: "signal", TaskFailed: "signal", StreamInvalidated: "signal",
  ApprovalRequested: "amber",
};

function EventRow({ e }) {
  const tone = EVENT_TONE[e.type] ?? "ink";
  const usage = e.payload?.usage;
  return (
    <details class="ev">
      <summary>
        <span class="ev-seq">{String(e.seq).padStart(3, "0")}</span>
        <span class={`ev-type ev-${tone}`}>{e.type}</span>
        {usage && <span class="ev-usage">{usage.inputTokens}▸{usage.outputTokens} tok</span>}
      </summary>
      <pre class="ev-payload">{JSON.stringify(e.payload, null, 2)}</pre>
    </details>
  );
}

function Stream({ name, events }) {
  return (
    <div class="stream">
      <div class="stream-head">{name} <span class="dim">· {events.length} events</span></div>
      {events.map((e) => <EventRow key={`${name}:${e.seq}`} e={e} />)}
    </div>
  );
}

function RunPage({ runId, isAdmin }) {
  const [data, setData] = useState(null);
  const [events, setEvents] = useState(null);
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");

  usePoll(async () => {
    setData(await api("GET", `/runs/${runId}`));
    setEvents(await api("GET", `/runs/${runId}/events`));
  }, 2500, [runId]);

  if (!data) return <div class="page"><div class="empty">Loading…</div></div>;
  const run = data.run;
  const approvals = data.approvals ?? [];

  const resolve = async (a, granted) => {
    setErr("");
    try {
      await api("POST", `/runs/${runId}/approvals`, { taskId: a.taskId, stepId: a.stepId, granted, by: "console", comment: note || undefined });
      setNote("");
    } catch (ex) { setErr(String(ex.message)); }
  };

  return (
    <div class="page">
      <div class="page-head">
        <div>
          <div class="overline">RUN <span class="mono">{short(runId)}</span> <button class="copy" onClick={() => copy(runId)} title="copy full id">⧉</button></div>
          <h1 class="h-run">{run.agent} <StatusChip status={run.status} waiting={approvals.length > 0} /></h1>
        </div>
        <span class="live-dot"><i />LIVE</span>
      </div>

      {approvals.length > 0 && (
        <div class="approve-card">
          <div class="overline signal">HELD FOR APPROVAL · ZERO COMPUTE WHILE PARKED</div>
          {approvals.map((a) => (
            <div class="approve-row" key={`${a.taskId}:${a.stepId}`}>
              <div class="approve-what">
                <b>{a.tool}</b>
                <pre class="ev-payload inline">{JSON.stringify(a.args, null, 2)}</pre>
              </div>
              <div class="approve-actions">
                <input placeholder="comment for the agent (optional)" value={note} onInput={(e) => setNote(e.currentTarget.value)} />
                <button class="btn-primary" onClick={() => resolve(a, true)}>Approve</button>
                <button class="btn-deny" onClick={() => resolve(a, false)}>Deny</button>
              </div>
            </div>
          ))}
          {err && <div class="form-err">{err}</div>}
        </div>
      )}

      <div class="io-grid">
        <div class="io-pane"><div class="io-label">INPUT</div><pre>{run.input ?? "—"}</pre></div>
        <div class="io-pane"><div class="io-label">{run.status === "failed" ? "ERROR" : "OUTPUT"}</div>
          <pre class={run.status === "failed" ? "err-text" : ""}>{run.error ?? run.output ?? (run.status === "running" ? "… still working" : "—")}</pre></div>
      </div>

      {(data.waves ?? []).length > 0 && (
        <div class="waves">
          {data.waves.map((w) => (
            <span class={`wave-pill${w.done ? " done" : ""}`} key={w.name}>
              WAVE {w.name} <b>{w.settled}/{w.tasks}</b>
            </span>
          ))}
        </div>
      )}

      <div class="overline" style="margin-top:26px">EVENT LOG · THE SOURCE OF TRUTH</div>
      {events && (
        <div class="streams">
          <Stream name="run" events={events.run ?? []} />
          {Object.entries(events.tasks ?? {}).map(([t, es]) => <Stream key={t} name={`task:${t}`} events={es} />)}
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- agent */

function AgentPage() {
  const [info, setInfo] = useState(null);
  const [runs, setRuns] = useState([]);
  useEffect(() => {
    api("GET", "/agent").then((r) => setInfo(r.agent));
    api("GET", "/runs").then((r) => setRuns(r.runs.filter((x) => x.mode !== "session"))).catch(() => {});
  }, []);

  if (!info) return <div class="page"><div class="empty">Loading…</div></div>;
  // fleet shape { default, crews: {name: crewInfo} } or legacy single crewInfo
  const crews = info.crews ?? { [info.name]: info };
  const crewNames = Object.keys(crews);

  return (
    <div class="page">
      <div class="page-head">
        <div>
          <div class="overline">SHT 03 · SPECIFICATION</div>
          <h1>{crewNames.length === 1 ? crewNames[0] : `${crewNames.length} process agents`}</h1>
        </div>
      </div>

      {crewNames.map((crewName) => {
        const crew = crews[crewName];
        const agents = crew.agents ?? {};
        const ROOT = agents.main ? "main" : crewName;
        const order = [ROOT, ...Object.keys(agents).filter((k) => k !== ROOT)].filter((k) => agents[k]);
        const crewRuns = runs.filter((r) => r.agent === crewName);
        const stats = {
          total: crewRuns.length,
          completed: crewRuns.filter((r) => r.status === "completed").length,
          failed: crewRuns.filter((r) => r.status === "failed").length,
          running: crewRuns.filter((r) => r.status === "running").length,
        };
        return (
          <div class="crew" key={crewName}>
            {crewNames.length > 1 && <div class="crew-title">{crewName}{info.default === crewName && <span class="dwg" style="margin-left:10px">DEFAULT</span>}</div>}
            <div class="stat-strip">
              <div class="stat"><b>{stats.total}</b><span>runs</span></div>
              <div class="stat"><b class="teal">{stats.completed}</b><span>completed</span></div>
              <div class="stat"><b class="signal">{stats.failed}</b><span>failed</span></div>
              <div class="stat"><b>{stats.running}</b><span>in flight</span></div>
            </div>
            {order.map((ref) => {
              const a = agents[ref];
              return (
                <div class="agent-card" key={ref}>
                  <div class="agent-head">
                    <span class="agent-ref">{ref === ROOT ? "ROOT AGENT" : `SUBAGENT · ${ref}`}</span>
                    <span class="model-chip">{a.model}</span>
                    <span class="dim">max {a.maxSteps} steps · {a.maxTokens} tok · prompt {a.systemChars} chars</span>
                  </div>
                  {a.env.length > 0 && (
                    <div class="agent-env">ENV: {a.env.map((n) => <code key={n}>{n}</code>)} <span class="dim">(names only; values never leave the worker)</span></div>
                  )}
                  {a.tools.length === 0 ? (
                    <div class="dim" style="padding: 4px 0 2px">No tools; pure model reasoning.</div>
                  ) : (
                    <table class="tool-table">
                      <thead><tr><th>Tool</th><th>Description</th><th>Effects</th><th>Approval</th></tr></thead>
                      <tbody>
                        {a.tools.map((t) => (
                          <tr key={t.name}>
                            <td class="mono">{t.name}</td>
                            <td class="dim">{t.description}</td>
                            <td class="mono dim">{t.effects}</td>
                            <td>{t.approval === "always"
                              ? <span class="chip chip-waiting_approval" style="animation:none">gated</span>
                              : <span class="dim">auto</span>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------- sessions */

function SessionsPage({ nav }) {
  const [sessions, setSessions] = useState(null);
  const [agents, setAgents] = useState([]);
  const [showNew, setShowNew] = useState(false);
  usePoll(async () => setSessions((await api("GET", "/sessions")).sessions), 3000);
  useEffect(() => {
    api("GET", "/agent").then((r) => {
      setAgents(r.agent?.crews ? Object.keys(r.agent.crews) : [r.agent?.name].filter(Boolean));
    }).catch(() => {});
  }, []);

  return (
    <div class="page">
      <div class="page-head">
        <div>
          <div class="overline">SHT 05 · CONVERSATIONS</div>
          <h1>Sessions</h1>
        </div>
        <div class="head-actions">
          <span class="live-dot"><i />LIVE</span>
          <button class="btn-primary" onClick={() => setShowNew(true)}>+ New session</button>
        </div>
      </div>
      {sessions === null ? <div class="empty">Loading…</div> : sessions.length === 0 ? (
        <div class="empty"><b>No conversations yet.</b><span>Sessions park at zero compute between turns, and they never re-pay a completed one.</span></div>
      ) : (
        <table class="sheet-table">
          <thead><tr><th>Session</th><th>Agent</th><th>Status</th><th>Started</th></tr></thead>
          <tbody>
            {sessions.map((s) => (
              <tr key={s.runId} class="rowlink" onClick={() => nav(`#/sessions/${s.runId}`)}>
                <td class="mono">{short(s.runId)}<span class="dim">…</span></td>
                <td>{s.agent}</td>
                <td><StatusChip status={s.status === "running" ? "active" : s.status} /></td>
                <td class="dim">{ago(s.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {showNew && <NewSession agents={agents} onClose={() => setShowNew(false)} nav={nav} />}
    </div>
  );
}

function NewSession({ agents, onClose, nav }) {
  const [agent, setAgent] = useState(agents[0] ?? "");
  const [message, setMessage] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setErr("");
    try {
      const { runId } = await api("POST", "/sessions", { agent: agent || undefined, message });
      onClose(); nav(`#/sessions/${runId}`);
    } catch (ex) { setErr(String(ex.message)); } finally { setBusy(false); }
  };
  return (
    <div class="modal-back" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <form class="modal" onSubmit={submit}>
        <div class="overline">NEW SESSION</div>
        <h2>Start a conversation</h2>
        {agents.length > 1 && (
          <div class="agent-select">
            {agents.map((n) => <button type="button" key={n} class={`agent-opt${n === agent ? " on" : ""}`} onClick={() => setAgent(n)}>{n}</button>)}
          </div>
        )}
        <textarea rows="3" autofocus placeholder="First message to the agent…" value={message} onInput={(e) => setMessage(e.currentTarget.value)} />
        {err && <div class="form-err">{err}</div>}
        <div class="modal-actions">
          <button type="button" class="btn-ghost" onClick={onClose}>Cancel</button>
          <button class="btn-primary" disabled={busy || !message.trim()}>Start</button>
        </div>
      </form>
    </div>
  );
}

function ChatPage({ runId }) {
  const [session, setSession] = useState(null);
  const [draft, setDraft] = useState("");
  const [err, setErr] = useState("");
  const [attachments, setAttachments] = useState([]);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef(null);
  const endRef = useRef(null);
  const lastCount = useRef(0);
  usePoll(async () => setSession(await api("GET", `/sessions/${runId}`)), 2000, [runId]);
  useEffect(() => {
    const n = session?.transcript?.length ?? 0;
    if (n > lastCount.current) { lastCount.current = n; endRef.current?.scrollIntoView({ behavior: "smooth" }); }
  }, [session]);

  if (!session) return <div class="page"><div class="empty">Loading…</div></div>;
  const open = session.state === "awaiting_input";
  const working = session.state === "working";

  const sendMsg = async (close) => {
    setErr("");
    try {
      await api("POST", `/sessions/${runId}/messages`,
        close ? { close: true } : { message: draft, channel: "console", ...(attachments.length ? { files: attachments.map((a) => a.fileId) } : {}) });
      if (!close) { setDraft(""); setAttachments([]); }
      setSession({ ...session, state: "working" });
    } catch (ex) { setErr(String(ex.message)); }
  };

  const attachFile = async (file) => {
    setErr(""); setUploading(true);
    try {
      const b64 = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).split(",")[1]);
        r.onerror = reject;
        r.readAsDataURL(file);
      });
      const up = await api("POST", "/files", { name: file.name, content_base64: b64 });
      setAttachments((a) => [...a, up]);
    } catch (ex) { setErr(String(ex.message)); }
    finally { setUploading(false); if (fileRef.current) fileRef.current.value = ""; }
  };

  return (
    <div class="page chat-page">
      <div class="page-head">
        <div>
          <div class="overline">SESSION <span class="mono">{short(runId)}</span> <button class="copy" onClick={() => copy(runId)} title="copy full id">⧉</button></div>
          <h1 class="h-run">{session.agent} <StatusChip status={session.state === "awaiting_input" ? "running" : session.state} /></h1>
        </div>
        {open && <button class="btn-deny sm" onClick={() => sendMsg(true)}>End session</button>}
      </div>

      <div class="chat">
        {session.transcript.map((t) => (
          <div key={t.seq} class={`bubble ${t.role}`}>
            <div class="bubble-meta">{t.role === "user" ? `YOU${t.channel ? ` · ${t.channel.toUpperCase()}` : ""}` : session.agent.toUpperCase()}</div>
            <div class="bubble-text">{t.text}</div>
          </div>
        ))}
        {working && <div class="bubble assistant thinking"><div class="bubble-meta">{session.agent.toUpperCase()}</div><div class="bubble-text">working<span class="dots">…</span></div></div>}
        <div ref={endRef} />
      </div>

      {err && <div class="form-err">{err}</div>}
      {session.state === "completed" ? (
        <div class="chat-closed">Session ended. The full transcript is durable, and it never re-paid a turn.</div>
      ) : (
        <div>
          {attachments.length > 0 && (
            <div class="attach-row">
              {attachments.map((a) => (
                <span key={a.fileId} class="attach-chip">
                  {a.name} · {a.pages}p
                  <button type="button" class="attach-x" onClick={() => setAttachments(attachments.filter((x) => x.fileId !== a.fileId))}>×</button>
                </span>
              ))}
            </div>
          )}
          <form class="chat-input" onSubmit={(e) => { e.preventDefault(); if (draft.trim()) sendMsg(false); }}>
            <input type="file" ref={fileRef} style="display:none" accept=".pdf,.docx,.xlsx,.xls,.txt,.md,.csv,.json,.yaml,.yml,.html,.xml,.log"
              onChange={(e) => { const f = e.currentTarget.files?.[0]; if (f) attachFile(f); }} />
            <button type="button" class="btn-ghost attach-btn" title="Attach a file (pdf, docx, xlsx, text)"
              disabled={!open || uploading} onClick={() => fileRef.current?.click()}>{uploading ? "…" : "📎"}</button>
            <input
              placeholder={open ? "Your message…" : "The agent is working; it has the floor"}
              disabled={!open}
              value={draft} onInput={(e) => setDraft(e.currentTarget.value)}
            />
            <button class="btn-primary" disabled={!open || !draft.trim()}>Send</button>
          </form>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ schedules */

const until = (iso) => {
  const s = (new Date(iso).getTime() - Date.now()) / 1000;
  if (s <= 0) return "due";
  if (s < 90) return `in ${Math.round(s)}s`;
  if (s < 5400) return `in ${Math.round(s / 60)}m`;
  return `in ${Math.round(s / 3600)}h`;
};

function SchedulesPage() {
  const [schedules, setSchedules] = useState(null);
  const [agents, setAgents] = useState([]);
  const [form, setForm] = useState({ agent: "", cron: "", input: "", name: "" });
  const [err, setErr] = useState("");
  usePoll(async () => setSchedules((await api("GET", "/schedules")).schedules), 5000);
  useEffect(() => {
    api("GET", "/agent").then((r) => {
      const names = r.agent?.crews ? Object.keys(r.agent.crews) : [r.agent?.name].filter(Boolean);
      setAgents(names);
      setForm((f) => ({ ...f, agent: r.agent?.default ?? names[0] ?? "" }));
    }).catch(() => {});
  }, []);

  const create = async (e) => {
    e.preventDefault(); setErr("");
    try {
      await api("POST", "/schedules", { ...form, name: form.name || form.cron });
      setForm((f) => ({ ...f, cron: "", input: "", name: "" }));
    } catch (ex) { setErr(String(ex.message)); }
  };
  const act = async (id, verb) => {
    setErr("");
    try { verb === "rm" ? await api("DELETE", `/schedules/${id}`) : await api("POST", `/schedules/${id}/${verb}`); }
    catch (ex) { setErr(String(ex.message)); }
  };

  return (
    <div class="page">
      <div class="page-head">
        <div>
          <div class="overline">SHT 04 · TIMETABLE</div>
          <h1>Schedules</h1>
        </div>
        <span class="live-dot"><i />LIVE</span>
      </div>

      <form class="sched-form" onSubmit={create}>
        {agents.length > 1 && (
          <div class="agent-select">
            {agents.map((n) => <button type="button" key={n} class={`agent-opt${n === form.agent ? " on" : ""}`} onClick={() => setForm((f) => ({ ...f, agent: n }))}>{n}</button>)}
          </div>
        )}
        <div class="sched-row">
          <input placeholder='cron: "0 9 * * *"' value={form.cron} onInput={(e) => setForm((f) => ({ ...f, cron: e.currentTarget.value }))} />
          <input placeholder='input: ["topic"]' value={form.input} onInput={(e) => setForm((f) => ({ ...f, input: e.currentTarget.value }))} />
          <input placeholder="name (optional)" value={form.name} onInput={(e) => setForm((f) => ({ ...f, name: e.currentTarget.value }))} />
          <button class="btn-primary" disabled={!form.cron.trim() || !form.input.trim()}>Schedule</button>
        </div>
      </form>
      {err && <div class="form-err">{err}</div>}

      {schedules === null ? <div class="empty">Loading…</div> : schedules.length === 0 ? (
        <div class="empty"><b>Nothing scheduled.</b><span>Cron-triggered runs fire from the workers: exactly once, crash-safe.</span></div>
      ) : (
        <table class="sheet-table">
          <thead><tr><th>Name</th><th>Agent</th><th>Cron</th><th>Next fire</th><th>Last fired</th><th /></tr></thead>
          <tbody>
            {schedules.map((s) => (
              <tr key={s.id} class={s.enabled ? "" : "row-dead"}>
                <td>{s.name}</td>
                <td>{s.agent}</td>
                <td class="mono">{s.cron} <span class="dim">{s.tz}</span></td>
                <td>{s.enabled ? <b class="mono">{until(s.nextFireAt)}</b> : <span class="chip chip-cancelled">paused</span>}</td>
                <td class="dim">{ago(s.lastFiredAt)}</td>
                <td class="sched-actions">
                  <button class="btn-ghost sm" onClick={() => act(s.id, s.enabled ? "pause" : "resume")}>{s.enabled ? "Pause" : "Resume"}</button>
                  <button class="btn-deny sm" onClick={() => act(s.id, "rm")}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------- keys */

function KeysPage() {
  const [keys, setKeys] = useState(null);
  const [name, setName] = useState("");
  const [minted, setMinted] = useState(null);
  const [err, setErr] = useState("");
  const reload = async () => setKeys((await api("GET", "/keys")).keys);
  useEffect(() => { reload().catch((e) => setErr(String(e.message))); }, []);

  const create = async (e) => {
    e.preventDefault(); setErr("");
    try {
      const { key } = await api("POST", "/keys", { name });
      setMinted(key); setName(""); await reload();
    } catch (ex) { setErr(String(ex.message)); }
  };
  const revoke = async (id) => {
    setErr("");
    try { await api("DELETE", `/keys/${id}`); await reload(); } catch (ex) { setErr(String(ex.message)); }
  };

  return (
    <div class="page">
      <div class="page-head">
        <div>
          <div class="overline">SHT 02 · ACCESS</div>
          <h1>API keys</h1>
        </div>
      </div>

      <form class="key-form" onSubmit={create}>
        <input placeholder="key name, e.g. ci-pipeline" value={name} onInput={(e) => setName(e.currentTarget.value)} />
        <button class="btn-primary" disabled={!name.trim()}>Issue key</button>
      </form>

      {minted && (
        <div class="minted">
          <div class="overline signal">SECRET · SHOWN ONCE, STORE IT NOW</div>
          <div class="minted-row">
            <code>{minted.secret}</code>
            <button class="btn-ghost" onClick={() => copy(minted.secret)}>Copy</button>
            <button class="btn-ghost" onClick={() => setMinted(null)}>Dismiss</button>
          </div>
        </div>
      )}
      {err && <div class="form-err">{err}</div>}

      {keys && (
        <table class="sheet-table">
          <thead><tr><th>Key</th><th>Name</th><th>Last used</th><th>Status</th><th /></tr></thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k.id} class={k.revokedAt ? "row-dead" : ""}>
                <td class="mono">{k.prefix}…</td>
                <td>{k.name}</td>
                <td class="dim">{ago(k.lastUsedAt)}</td>
                <td>{k.revokedAt ? <span class="chip chip-failed">revoked</span> : <span class="chip chip-completed">active</span>}</td>
                <td>{!k.revokedAt && <button class="btn-deny sm" onClick={() => revoke(k.id)}>Revoke</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- shell */

function App() {
  const [authed, setAuthed] = useState(() => {
    const m = location.hash.match(/#token=(.+)$/);
    if (m) { setToken(decodeURIComponent(m[1])); history.replaceState(null, "", location.pathname + "#/runs"); }
    return Boolean(getToken());
  });
  const [route, setRoute] = useState(location.hash || "#/runs");
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    const on = () => setRoute(location.hash || "#/runs");
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);

  useEffect(() => {
    if (!authed) return;
    api("GET", "/keys").then(() => setIsAdmin(true)).catch((e) => setIsAdmin(e.status !== 403 ? false : false));
  }, [authed]);

  const nav = (h) => { location.hash = h; };
  if (!authed) return <Login onIn={() => { setAuthed(true); nav("#/runs"); }} />;

  const runMatch = route.match(/^#\/runs\/(.+)$/);
  const sessionMatch = route.match(/^#\/sessions\/(.+)$/);
  return (
    <div class="shell">
      <header class="topbar">
        <a class="brand" href="#/runs"><Mark /> <b>TOREN</b> <span class="dwg">CONSOLE · DWG № TRN-003</span></a>
        <nav>
          <a class={route.startsWith("#/runs") ? "on" : ""} href="#/runs">Runs</a>
          <a class={route.startsWith("#/sessions") ? "on" : ""} href="#/sessions">Sessions</a>
          <a class={route === "#/agent" ? "on" : ""} href="#/agent">Agent</a>
          {isAdmin && <a class={route === "#/schedules" ? "on" : ""} href="#/schedules">Schedules</a>}
          {isAdmin && <a class={route === "#/keys" ? "on" : ""} href="#/keys">API keys</a>}
        </nav>
        <div class="topbar-right">
          <span class="role">{isAdmin ? "ADMIN" : "KEY"}</span>
          <button class="btn-ghost sm" onClick={() => { clearToken(); location.reload(); }}>Sign out</button>
        </div>
      </header>
      {sessionMatch ? <ChatPage runId={sessionMatch[1]} />
        : route.startsWith("#/sessions") ? <SessionsPage nav={nav} />
        : runMatch ? <RunPage runId={runMatch[1]} isAdmin={isAdmin} />
        : route === "#/agent" ? <AgentPage />
        : route === "#/schedules" && isAdmin ? <SchedulesPage />
        : route === "#/keys" && isAdmin ? <KeysPage />
        : <RunsPage nav={nav} />}
      <footer class="foot">TOREN CONSOLE · single deployment · credentials never leave this browser</footer>
    </div>
  );
}

render(<App />, document.getElementById("root"));
