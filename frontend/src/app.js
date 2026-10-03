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
  if (row.status === "pending") return "待处理";
  if (row.status === "processing") return "处理中";
  return "—";
}

function fmtElevation(v) {
  return v === null || v === undefined ? "—" : `${v}`;
}

function fmtTime(iso) {
  if (!iso) return "—";
  return iso.replace("T", " ").slice(0, 19);
}

const state = {
  token: localStorage.getItem(TOKEN_KEY) || "",
  user: null,
  view: "overview",
  loginForm: { username: "surveyor", password: "surv123456" },
  submitForm: { span_code: "", microstrain: "" },
  lockForm: { span_code: "", elevation_m: "" },
  rows: [],
  elev: { pending: [], locked: [] },
  detail: null,
  error: "",
  msg: "",
  lockError: "",
  lockMsg: "",
  demo: null,
  loading: false,
  lockLoading: false,
  demoLoading: false,
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
  if (!res.ok) {
    const err = new Error(data.detail || res.statusText);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function loadReadings() {
  if (!state.token) return;
  try {
    state.rows = await api("/api/readings");
    state.error = "";
  } catch {
    state.error = "加载列表失败，请重新登录";
  }
}

async function loadElevations() {
  if (!state.token) return;
  try {
    state.elev = await api("/api/elevations");
  } catch {
    /* 保留旧数据，下一轮轮询再试 */
  }
}

async function pollOnce() {
  await loadReadings();
  await loadElevations();
  m.redraw();
}

function startPolling() {
  if (state.timer) clearInterval(state.timer);
  if (!state.token) return;
  state.timer = setInterval(pollOnce, 3000);
}

function switchView(view) {
  state.view = view;
  state.error = "";
  state.msg = "";
  state.lockError = "";
  state.lockMsg = "";
  if (view === "elevations") loadElevations().then(() => m.redraw());
  m.redraw();
}

function logout() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  state.token = "";
  state.user = null;
  state.rows = [];
  state.elev = { pending: [], locked: [] };
  state.detail = null;
  if (state.timer) clearInterval(state.timer);
  m.redraw();
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
    await loadReadings();
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
    const data = await api("/api/elevations/lock", {
      method: "POST",
      body: JSON.stringify({
        span_code: state.lockForm.span_code,
        elevation_m: parseFloat(state.lockForm.elevation_m),
      }),
    });
    state.lockMsg = data.message || "已锁定";
    state.lockForm = { span_code: "", elevation_m: "" };
    await loadElevations();
  } catch (err) {
    state.lockError = err.message || "锁定失败";
  } finally {
    state.lockLoading = false;
    m.redraw();
  }
}

async function runBlockedDemo() {
  state.demo = null;
  state.demoLoading = true;
  try {
    await loadElevations();
    const span = state.elev.pending[0];
    if (!span) {
      state.demo = { note: "当前没有待锁跨段：全部跨段均已锁定，无法演示挡回。" };
      return;
    }
    await api("/api/readings", {
      method: "POST",
      body: JSON.stringify({ span_code: span, microstrain: 150 }),
    });
    state.demo = { note: `跨段「${span}」未被挡回（不符合预期，请检查后台）。` };
  } catch (err) {
    state.demo = { status: err.status, detail: err.message };
  } finally {
    state.demoLoading = false;
    m.redraw();
  }
}

function loginView() {
  return m("div.wrap", [
    m("h1", "桥梁应变班交台"),
    m(
      "p.sub",
      "先锁测点高程，再报微应变读数；后台工人认领队列后判定合格或越界。"
    ),
    m("div.card", [
      m(
        "form",
        {
          onsubmit: async (e) => {
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
              await pollOnce();
              startPolling();
            } catch {
              state.error = "用户名或密码错误";
            } finally {
              state.loading = false;
              m.redraw();
            }
          },
        },
        [
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
            m(
              "button",
              { type: "submit", disabled: state.loading },
              "登录"
            ),
          ]),
          state.error ? m("p.err", state.error) : null,
        ]
      ),
      m(
        "p.sub",
        { style: { marginBottom: 0 } },
        "测量员 surveyor / surv123456 · 复核员 reviewer / rev123456"
      ),
    ]),
  ]);
}

function topbar(isWriter) {
  return m("div.topbar", [
    m("div", [
      m("h1", "桥梁应变班交台"),
      m("p.sub", "先锁高程，再报微应变：80～220 με 为合格，否则为越界。"),
    ]),
    m("div.nav", [
      m(
        "button.navbtn",
        {
          type: "button",
          class: state.view === "overview" ? "active" : "",
          onclick: () => switchView("overview"),
        },
        "读数总览"
      ),
      m(
        "button.navbtn",
        {
          type: "button",
          class: state.view === "elevations" ? "active" : "",
          onclick: () => switchView("elevations"),
        },
        "高程锁定"
      ),
      m(
        "span.user",
        `${state.user?.username}（${isWriter ? "测量员" : "复核员"}）`
      ),
      m("button.secondary", { type: "button", onclick: logout }, "退出"),
    ]),
  ]);
}

function overviewView(isWriter) {
  return m("div", [
    isWriter
      ? m("div.card", [
          m("h2", { style: { marginTop: 0, fontSize: "1.1rem" } }, "提交读数"),
          m(
            "p.sub",
            "跨段须先在「高程锁定」专页锁定测点高程，未锁定的报送会被整笔退回。"
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
              m(
                "button",
                { type: "submit", disabled: state.loading },
                "提交"
              ),
            ]),
            state.error ? m("p.err", state.error) : null,
            state.msg ? m("p.ok", state.msg) : null,
          ]),
        ])
      : null,
    m("div.card", [
      m("h2", { style: { marginTop: 0, fontSize: "1.1rem" } }, "读数列表"),
      m("p.sub", "高程为报送时随单冻结的测点高程；点击行可打开单据详情。"),
      m("table", [
        m("thead", [
          m("tr", [
            m("th", "编号"),
            m("th", "跨段"),
            m("th", "微应变"),
            m("th", "高程（米）"),
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
                m(
                  "tr.clickable",
                  {
                    key: r.id,
                    onclick: () => {
                      state.detail = r;
                    },
                  },
                  [
                    m("td", r.id),
                    m("td", r.span_code),
                    m("td", r.microstrain),
                    m("td", fmtElevation(r.elevation_m)),
                    m("td", [
                      m(
                        "span",
                        { class: verdictClass(r.verdict, r.status) },
                        displayVerdict(r)
                      ),
                    ]),
                    m("td", r.reason || "—"),
                    m("td", r.status),
                    m("td", r.created_by),
                  ]
                )
              )
            : [m("tr", m("td", { colspan: 8 }, "暂无数据"))]
        ),
      ]),
    ]),
  ]);
}

function elevationsView(isWriter) {
  return m("div", [
    m("div.card", [
      m("h2", { style: { marginTop: 0, fontSize: "1.1rem" } }, "待锁表"),
      m(
        "p.sub",
        "以下跨段尚未锁定测点高程；锁定前无论网页还是直连接口报送微应变，都会被整笔退回。"
      ),
      state.elev.pending.length
        ? m("table", [
            m("thead", [
              m("tr", [
                m("th", "跨段编号"),
                m("th", "状态"),
                isWriter ? m("th", "操作") : null,
              ]),
            ]),
            m(
              "tbody",
              state.elev.pending.map((code) =>
                m("tr", { key: code }, [
                  m("td", code),
                  m("td", m("span.tag.wait", "待锁定")),
                  isWriter
                    ? m(
                        "td",
                        m(
                          "button.small",
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
            ),
          ])
        : m("p.sub", { style: { marginBottom: 0 } }, "全部跨段均已锁定。"),
    ]),
    isWriter
      ? m("div.card", [
          m("h2", { style: { marginTop: 0, fontSize: "1.1rem" } }, "锁定高程"),
          m(
            "p.sub",
            "每个跨段只允许锁成一笔；两人撞同一跨时另一笔当场拒绝。锁定后报送的新单随单冻结该高程。"
          ),
          m("form", { onsubmit: submitLock }, [
            m("div.row", [
              m("label", [
                "跨段编号",
                m("input", {
                  required: true,
                  placeholder: "例如 跨中甲",
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
                  step: "0.01",
                  value: state.lockForm.elevation_m,
                  oninput: (e) => {
                    state.lockForm.elevation_m = e.target.value;
                  },
                }),
              ]),
              m(
                "button",
                { type: "submit", disabled: state.lockLoading },
                "锁定"
              ),
            ]),
            state.lockError ? m("p.err", state.lockError) : null,
            state.lockMsg ? m("p.ok", state.lockMsg) : null,
          ]),
        ])
      : null,
    m("div.card", [
      m("h2", { style: { marginTop: 0, fontSize: "1.1rem" } }, "已锁清单"),
      m("table", [
        m("thead", [
          m("tr", [
            m("th", "跨段编号"),
            m("th", "高程（米）"),
            m("th", "锁定人"),
            m("th", "锁定时间"),
          ]),
        ]),
        m(
          "tbody",
          state.elev.locked.length
            ? state.elev.locked.map((l) =>
                m("tr", { key: l.id }, [
                  m("td", l.span_code),
                  m("td", fmtElevation(l.elevation_m)),
                  m("td", l.locked_by),
                  m("td", fmtTime(l.locked_at)),
                ])
              )
            : [m("tr", m("td", { colspan: 4 }, "暂无锁定记录"))]
        ),
      ]),
    ]),
    m("div.card", [
      m("h2", { style: { marginTop: 0, fontSize: "1.1rem" } }, "挡回样例"),
      m(
        "p.sub",
        "未锁跨段无论从网页表单还是直连接口报送，都会整笔退回并写清尚未锁定高程。以未锁跨段为例："
      ),
      m(
        "pre.sample",
        'POST /api/readings  {"span_code":"支座乙","microstrain":150}\n' +
          '→ 409  {"detail":"跨段「支座乙」尚未锁定测点高程，整笔退回；请先在「高程锁定」专页完成锁定后再报送"}'
      ),
      isWriter
        ? m(
            "button",
            {
              type: "button",
              disabled: state.demoLoading,
              onclick: runBlockedDemo,
            },
            "现场试报首个待锁跨段"
          )
        : null,
      state.demo
        ? state.demo.note
          ? m("p.sub", state.demo.note)
          : m(
              "pre.sample.rejected",
              `HTTP ${state.demo.status}\n${state.demo.detail}`
            )
        : null,
    ]),
  ]);
}

function detailModal() {
  const d = state.detail;
  if (!d) return null;
  const rows = [
    ["编号", d.id],
    ["跨段", d.span_code],
    ["微应变（με）", d.microstrain],
    ["高程（米）", fmtElevation(d.elevation_m)],
    ["结论", displayVerdict(d)],
    ["说明", d.reason || "—"],
    ["状态", d.status],
    ["提交人", d.created_by],
    ["提交时间", fmtTime(d.created_at)],
    ["办结时间", fmtTime(d.processed_at)],
  ];
  return m(
    "div.modal-mask",
    {
      onclick: () => {
        state.detail = null;
      },
    },
    m(
      "div.modal",
      {
        onclick: (e) => e.stopPropagation(),
      },
      [
        m("h2", { style: { marginTop: 0, fontSize: "1.1rem" } }, `读数单 #${d.id}`),
        m(
          "table",
          m(
            "tbody",
            rows.map(([k, v]) =>
              m("tr", { key: k }, [m("th", k), m("td", `${v}`)])
            )
          )
        ),
        m(
          "p.sub",
          "高程在报送入队时随单冻结，之后改动锁定专页数字不影响本单。"
        ),
        m(
          "button.secondary",
          {
            type: "button",
            onclick: () => {
              state.detail = null;
            },
          },
          "关闭"
        ),
      ]
    )
  );
}

const App = {
  oninit() {
    pollOnce();
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
      topbar(isWriter),
      state.view === "elevations"
        ? elevationsView(isWriter)
        : overviewView(isWriter),
      detailModal(),
    ]);
  },
};

export default App;
