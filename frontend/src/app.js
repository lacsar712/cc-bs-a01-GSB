import m from "mithril";

const TOKEN_KEY = "bridge_strain_token";
const USER_KEY = "bridge_strain_user";

function verdictClass(verdict, status) {
  if (verdict === "合格") return "tag pass";
  if (verdict === "越界") return "tag fail";
  if (status === "pending" || status === "processing") return "tag wait";
  return "tag wait";
}

function displayVerdict(row) {
  if (row.verdict) return row.verdict;
  if (row.status === "pending") return "候审中";
  if (row.status === "processing") return "判定中";
  return "—";
}

function displayStatus(row) {
  if (row.status === "pending") return "候审";
  if (row.status === "processing") return "判定中";
  if (row.status === "done") return "已办结";
  return row.status;
}

function displayElevation(value) {
  return value === null || value === undefined ? "—" : `${value} m`;
}

function displayTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

const state = {
  token: localStorage.getItem(TOKEN_KEY) || "",
  user: null,
  view: "overview",
  loginForm: { username: "surveyor", password: "surv123456" },
  submitForm: { span_code: "", microstrain: "" },
  lockForm: { span_code: "", elevation_m: "" },
  rows: [],
  locks: [],
  pendingSpans: [],
  error: "",
  msg: "",
  lockError: "",
  lockMsg: "",
  loading: false,
  lockLoading: false,
  timer: null,
};

try {
  state.user = JSON.parse(localStorage.getItem(USER_KEY) || "null");
} catch {
  state.user = null;
}

async function api(path, opts = {}) {
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const res = await fetch(path, { ...opts, headers });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { detail: text };
  }
  if (!res.ok) throw new Error(data.detail || res.statusText);
  return data;
}

async function loadAll() {
  if (!state.token) return;
  try {
    const [rows, lockData] = await Promise.all([
      api("/api/readings"),
      api("/api/elevation-locks"),
    ]);
    state.rows = rows;
    state.locks = lockData.locks || [];
    state.pendingSpans = lockData.pending || [];
    state.error = "";
  } catch {
    state.error = "加载数据失败，请重新登录";
  }
  m.redraw();
}

function startPolling() {
  if (state.timer) clearInterval(state.timer);
  if (!state.token) return;
  state.timer = setInterval(loadAll, 3000);
}

function switchView(view) {
  state.view = view;
  state.error = "";
  state.msg = "";
  state.lockError = "";
  state.lockMsg = "";
  loadAll();
}

async function submitLogin(e) {
  e.preventDefault();
  state.error = "";
  state.loading = true;
  try {
    const data = await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify(state.loginForm),
    });
    state.token = data.access_token;
    state.user = { username: data.username, role: data.role };
    localStorage.setItem(TOKEN_KEY, state.token);
    localStorage.setItem(USER_KEY, JSON.stringify(state.user));
    await loadAll();
    startPolling();
  } catch {
    state.error = "用户名或密码错误";
  } finally {
    state.loading = false;
    m.redraw();
  }
}

async function submitReading(e) {
  e.preventDefault();
  state.error = "";
  state.msg = "";
  state.loading = true;
  try {
    const data = await api("/api/readings", {
      method: "POST",
      body: JSON.stringify({
        span_code: state.submitForm.span_code,
        microstrain: parseFloat(state.submitForm.microstrain),
      }),
    });
    state.msg = data.message || "已提交";
    state.submitForm = { span_code: "", microstrain: "" };
    await loadAll();
  } catch (err) {
    state.error = err.message || "提交失败";
  } finally {
    state.loading = false;
    m.redraw();
  }
}

async function submitLock(e) {
  e.preventDefault();
  state.lockError = "";
  state.lockMsg = "";
  state.lockLoading = true;
  try {
    const data = await api("/api/elevation-locks", {
      method: "POST",
      body: JSON.stringify({
        span_code: state.lockForm.span_code,
        elevation_m: parseFloat(state.lockForm.elevation_m),
      }),
    });
    state.lockMsg = data.message || "已锁定";
    state.lockForm = { span_code: "", elevation_m: "" };
    await loadAll();
  } catch (err) {
    state.lockError = err.message || "锁定失败";
    await loadAll();
  } finally {
    state.lockLoading = false;
    m.redraw();
  }
}

function logout() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  state.token = "";
  state.user = null;
  state.rows = [];
  state.locks = [];
  state.pendingSpans = [];
  state.view = "overview";
  if (state.timer) clearInterval(state.timer);
  m.redraw();
}

function loginView() {
  return m("div.wrap", [
    m("h1", "桥梁应变班交台"),
    m(
      "p.sub",
      "测量员先在专页锁定跨段高程，再报送微应变读数；后台工人认领候审队列后判定合格或越界。"
    ),
    m("div.card", [
      m("form", { onsubmit: submitLogin }, [
        m("div.row", [
          m("label", [
            "用户名",
            m("input", {
              value: state.loginForm.username,
              oninput: (e) => {
                state.loginForm.username = e.target.value;
              },
            }),
          ]),
          m("label", [
            "密码",
            m("input", {
              type: "password",
              value: state.loginForm.password,
              oninput: (e) => {
                state.loginForm.password = e.target.value;
              },
            }),
          ]),
          m("button", { type: "submit", disabled: state.loading }, "登录"),
        ]),
        state.error ? m("p.err", state.error) : null,
      ]),
      m(
        "p.sub",
        { style: { marginBottom: 0 } },
        "测量员 surveyor / surv123456 · 复核员 reviewer / rev123456"
      ),
    ]),
  ]);
}

function topbarView(isWriter) {
  return m("div.topbar", [
    m("div", [
      m("h1", "桥梁应变班交台"),
      m("p.sub", "先锁高程，再报读数；微应变 80～220 με 为合格，否则为越界。"),
      m("div.nav", [
        m(
          "button",
          {
            type: "button",
            class: state.view === "overview" ? "active" : "",
            onclick: () => switchView("overview"),
          },
          "总览"
        ),
        m(
          "button",
          {
            type: "button",
            class: state.view === "locks" ? "active" : "",
            onclick: () => switchView("locks"),
          },
          "高程锁定"
        ),
      ]),
    ]),
    m("div", [
      `${state.user?.username}（${isWriter ? "测量员" : "复核员"}） `,
      m("button.secondary", { type: "button", onclick: logout }, "退出"),
    ]),
  ]);
}

function overviewView(isWriter) {
  return [
    isWriter
      ? m("div.card", [
          m("h2", { style: { marginTop: 0, fontSize: "1.1rem" } }, "提交读数"),
          m(
            "p.sub",
            "跨段须先在高程锁定专页锁定高程，未锁定的报送将被整笔退回。"
          ),
          m("form", { onsubmit: submitReading }, [
            m("div.row", [
              m("label", [
                "跨段编号",
                m("input", {
                  required: true,
                  placeholder: "例如 跨中甲",
                  value: state.submitForm.span_code,
                  oninput: (e) => {
                    state.submitForm.span_code = e.target.value;
                  },
                }),
              ]),
              m("label", [
                "微应变（με）",
                m("input", {
                  required: true,
                  type: "number",
                  step: "0.1",
                  value: state.submitForm.microstrain,
                  oninput: (e) => {
                    state.submitForm.microstrain = e.target.value;
                  },
                }),
              ]),
              m("button", { type: "submit", disabled: state.loading }, "提交"),
            ]),
            state.error ? m("p.err", state.error) : null,
            state.msg ? m("p.ok", state.msg) : null,
          ]),
        ])
      : null,
    m("div.card", [
      m("h2", { style: { marginTop: 0, fontSize: "1.1rem" } }, "读数列表"),
      m("table", [
        m("thead", [
          m("tr", [
            m("th", "编号"),
            m("th", "跨段"),
            m("th", "微应变"),
            m("th", "冻结高程"),
            m("th", "结论"),
            m("th", "说明"),
            m("th", "状态"),
            m("th", "提交人"),
          ]),
        ]),
        m(
          "tbody",
          state.rows.length
            ? state.rows.map((r) =>
                m("tr", { key: r.id }, [
                  m("td", r.id),
                  m("td", r.span_code),
                  m("td", r.microstrain),
                  m("td", displayElevation(r.elevation_m)),
                  m("td", [
                    m(
                      "span",
                      { class: verdictClass(r.verdict, r.status) },
                      displayVerdict(r)
                    ),
                  ]),
                  m("td", r.reason || "—"),
                  m("td", displayStatus(r)),
                  m("td", r.created_by),
                ])
              )
            : [m("tr", m("td", { colspan: 8 }, "暂无数据"))]
        ),
      ]),
    ]),
  ];
}

function lockFormCard() {
  return m("div.card", [
    m("h2", { style: { marginTop: 0, fontSize: "1.1rem" } }, "锁定高程"),
    m(
      "p.sub",
      "填写跨段号与高程米数后点锁定。同一跨段至多锁成一笔，撞车或重复锁定当场拒。"
    ),
    m("form", { onsubmit: submitLock }, [
      m("div.row", [
        m("label", [
          "跨段编号",
          m("input", {
            required: true,
            placeholder: "例如 跨中甲",
            list: "pending-spans",
            value: state.lockForm.span_code,
            oninput: (e) => {
              state.lockForm.span_code = e.target.value;
            },
          }),
        ]),
        m("label", [
          "高程（米）",
          m("input", {
            required: true,
            type: "number",
            step: "0.001",
            placeholder: "例如 12",
            value: state.lockForm.elevation_m,
            oninput: (e) => {
              state.lockForm.elevation_m = e.target.value;
            },
          }),
        ]),
        m("button", { type: "submit", disabled: state.lockLoading }, "锁定"),
      ]),
      m(
        "datalist",
        { id: "pending-spans" },
        state.pendingSpans.map((code) => m("option", { key: code, value: code }))
      ),
      state.lockError ? m("p.err", state.lockError) : null,
      state.lockMsg ? m("p.ok", state.lockMsg) : null,
    ]),
  ]);
}

function pendingTableCard(isWriter) {
  return m("div.card", [
    m("h2", { style: { marginTop: 0, fontSize: "1.1rem" } }, "待锁表"),
    m("table", [
      m("thead", [
        m("tr", [
          m("th", "跨段编号"),
          m("th", "状态"),
          isWriter ? m("th", "操作") : null,
        ]),
      ]),
      m(
        "tbody",
        state.pendingSpans.length
          ? state.pendingSpans.map((code) =>
              m("tr", { key: code }, [
                m("td", code),
                m("td", [m("span.tag.wait", "待锁定")]),
                isWriter
                  ? m(
                      "td",
                      m(
                        "button.secondary",
                        {
                          type: "button",
                          onclick: () => {
                            state.lockForm.span_code = code;
                          },
                        },
                        "填入锁定表单"
                      )
                    )
                  : null,
              ])
            )
          : [m("tr", m("td", { colspan: isWriter ? 3 : 2 }, "台账跨段均已锁定"))]
      ),
    ]),
  ]);
}

function lockedTableCard() {
  return m("div.card", [
    m("h2", { style: { marginTop: 0, fontSize: "1.1rem" } }, "已锁清单"),
    m("table", [
      m("thead", [
        m("tr", [
          m("th", "跨段编号"),
          m("th", "锁定高程"),
          m("th", "锁定人"),
          m("th", "锁定时间"),
        ]),
      ]),
      m(
        "tbody",
        state.locks.length
          ? state.locks.map((lock) =>
              m("tr", { key: lock.id }, [
                m("td", lock.span_code),
                m("td", displayElevation(lock.elevation_m)),
                m("td", lock.locked_by),
                m("td", displayTime(lock.locked_at)),
              ])
            )
          : [m("tr", m("td", { colspan: 4 }, "暂无锁定记录"))]
      ),
    ]),
  ]);
}

function rejectionSamplesCard() {
  const samples = state.pendingSpans.slice(0, 3).map((code) => ({
    span: code,
    text: `跨段 ${code} 尚未锁定高程，整笔退回：请先在高程锁定专页完成锁定`,
  }));
  return m("div.card", [
    m("h2", { style: { marginTop: 0, fontSize: "1.1rem" } }, "挡回样例"),
    m(
      "p.sub",
      "未锁定高程的跨段直接报送微应变时，网页表单与直连接口（POST /api/readings）两条写口均整笔退回，不入队。"
    ),
    samples.length
      ? m(
          "ul.samples",
          samples.map((s) =>
            m("li", { key: s.span }, [
              m("code", `报送 ${s.span} · 150 με`),
              " → ",
              m("span.reject", s.text),
            ])
          )
        )
      : m("ul.samples", [
          m("li", [
            m("code", "报送 未锁定跨段 · 150 με"),
            " → ",
            m("span.reject", "尚未锁定高程，整笔退回"),
          ]),
        ]),
  ]);
}

function locksView(isWriter) {
  return [
    m("h2.page-title", "高程锁定专页"),
    m(
      "p.sub",
      "每个跨段须先在此锁定测点高程，才允许报送微应变；锁定后高程随报送单冻结，事后改动锁定数字不影响旧单。"
    ),
    isWriter
      ? lockFormCard()
      : m("div.card", [
          m(
            "p.sub",
            { style: { margin: 0 } },
            "复核员仅可翻看锁定表与冻住的高程，不能改锁也不能报送。"
          ),
        ]),
    pendingTableCard(isWriter),
    lockedTableCard(),
    rejectionSamplesCard(),
  ];
}

const App = {
  oninit() {
    loadAll();
    startPolling();
  },
  onremove() {
    if (state.timer) clearInterval(state.timer);
  },
  view() {
    if (!state.token) {
      return loginView();
    }
    const isWriter = state.user?.role === "writer";
    return m("div.wrap", [
      topbarView(isWriter),
      ...(state.view === "locks" ? locksView(isWriter) : overviewView(isWriter)),
    ]);
  },
};

export default App;
