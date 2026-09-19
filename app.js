const state = {
  backendUrl: "",
  token: localStorage.getItem("angelconsole_token") || "",
  user: null,
  unlocked: false,
  socket: null,
  currentDirectory: "/",
  currentFile: "",
  currentFileDirty: false
};

const $ = (id) => document.getElementById(id);

async function init() {
  await loadBackendUrl();
  bindEvents();
  if (state.token) {
    await refreshMe();
  } else {
    showView("login");
  }
}

async function loadBackendUrl() {
  try {
    const res = await fetch("backend.json", { cache: "no-store" });
    if (res.ok) {
      const data = await res.json();
      state.backendUrl = String(data.url || "").replace(/\/+$/, "");
    }
  } catch {}
  if (!state.backendUrl) state.backendUrl = location.origin;
}

function apiUrl(path) {
  return `${state.backendUrl}${path}`;
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  if (options.body && !(options.body instanceof FormData)) headers["Content-Type"] = "application/json";
  const res = await fetch(apiUrl(path), {
    ...options,
    headers,
    body: options.body && !(options.body instanceof FormData) ? JSON.stringify(options.body) : options.body
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { ok: res.ok, raw: text };
  }
  if (!res.ok || data?.ok === false) {
    const err = new Error(data?.error || data?.raw || res.statusText);
    err.status = res.status;
    throw err;
  }
  return data;
}

function bindEvents() {
  $("loginForm").addEventListener("submit", onLogin);
  $("unlockForm").addEventListener("submit", onUnlock);
  $("logoutButton").addEventListener("click", logout);
  $("logoutFromUnlock").addEventListener("click", logout);
  $("commandForm").addEventListener("submit", sendCommand);
  document.querySelectorAll("[data-power]").forEach((button) => {
    button.addEventListener("click", () => sendPower(button.dataset.power));
  });
  $("tabConsole").addEventListener("click", () => showPanel("console"));
  $("tabFiles").addEventListener("click", () => showPanel("files"));
  $("tabAccounts").addEventListener("click", () => showPanel("accounts"));
  $("fileUpButton").addEventListener("click", goUpDirectory);
  $("fileRefreshButton").addEventListener("click", () => loadFiles(state.currentDirectory));
  $("newFolderButton").addEventListener("click", createFolder);
  $("uploadInput").addEventListener("change", uploadSelectedFile);
  $("saveFileButton").addEventListener("click", saveCurrentFile);
  $("fileEditor").addEventListener("input", () => {
    state.currentFileDirty = true;
    updateEditorTitle();
  });
  $("createAccountForm").addEventListener("submit", createAccount);
  $("resetAccountForm").addEventListener("submit", resetAccount);
}

async function onLogin(event) {
  event.preventDefault();
  setMessage("loginMessage", "");
  try {
    const data = await api("/api/login", {
      method: "POST",
      body: {
        username: $("loginUsername").value.trim(),
        password: $("loginPassword").value
      }
    });
    state.token = data.token;
    state.user = data.user;
    state.unlocked = !!data.unlocked;
    localStorage.setItem("angelconsole_token", state.token);
    await refreshMe();
  } catch (err) {
    setMessage("loginMessage", readableError(err.message));
  }
}

async function refreshMe() {
  try {
    const data = await api("/api/me");
    state.user = data.user;
    state.unlocked = !!data.unlocked;
    $("serverTitle").textContent = data.serverName || "AngelConsole";
    $("userLine").textContent = `${state.user.username} 로그인됨`;
    document.querySelectorAll(".owner-only").forEach((el) => el.classList.toggle("hidden", !state.user.owner));
    if (state.unlocked) {
      showView("main");
      connectConsole();
      await loadFiles(state.currentDirectory);
      if (state.user.owner) await loadAccounts();
    } else {
      showView("unlock");
    }
  } catch {
    state.token = "";
    localStorage.removeItem("angelconsole_token");
    showView("login");
  }
}

async function onUnlock(event) {
  event.preventDefault();
  setMessage("unlockMessage", "");
  try {
    await api("/api/unlock", { method: "POST", body: { password: $("adminPassword").value } });
    state.unlocked = true;
    await refreshMe();
  } catch (err) {
    setMessage("unlockMessage", readableError(err.message));
  }
}

async function logout() {
  try {
    if (state.token) await api("/api/logout", { method: "POST" });
  } catch {}
  localStorage.removeItem("angelconsole_token");
  state.token = "";
  state.user = null;
  state.unlocked = false;
  if (state.socket) state.socket.close();
  showView("login");
}

function showView(name) {
  $("loginView").classList.toggle("hidden", name !== "login");
  $("unlockView").classList.toggle("hidden", name !== "unlock");
  $("mainView").classList.toggle("hidden", name !== "main");
}

function showPanel(name) {
  const map = {
    console: ["consolePanel", "tabConsole"],
    files: ["filesPanel", "tabFiles"],
    accounts: ["accountsPanel", "tabAccounts"]
  };
  Object.values(map).forEach(([panel, tab]) => {
    $(panel).classList.remove("active");
    $(tab).classList.remove("active");
  });
  $(map[name][0]).classList.add("active");
  $(map[name][1]).classList.add("active");
  if (name === "files") loadFiles(state.currentDirectory);
  if (name === "accounts" && state.user?.owner) loadAccounts();
}

function connectConsole() {
  if (state.socket && state.socket.readyState <= WebSocket.OPEN) return;
  const wsUrl = apiUrl("/ws").replace(/^http:/, "ws:").replace(/^https:/, "wss:");
  state.socket = new WebSocket(wsUrl);
  state.socket.addEventListener("open", () => {
    setConsoleStatus("인증 중");
    state.socket.send(JSON.stringify({ type: "auth", token: state.token }));
  });
  state.socket.addEventListener("message", (event) => {
    const data = JSON.parse(event.data);
    if (data.type === "ready") setConsoleStatus("연결됨");
    if (data.type === "status") setConsoleStatus(readableError(data.message));
    if (data.type === "power") setConsoleStatus(data.status || "상태 변경");
    if (data.type === "console") appendConsole(data.line);
    if (data.type === "error") appendConsole(`[오류] ${readableError(data.message)}`);
  });
  state.socket.addEventListener("close", () => {
    setConsoleStatus("연결 끊김");
    if (state.token && state.unlocked) setTimeout(connectConsole, 3000);
  });
}

function sendCommand(event) {
  event.preventDefault();
  const command = $("commandInput").value.trim();
  if (!command || !state.socket || state.socket.readyState !== WebSocket.OPEN) return;
  state.socket.send(JSON.stringify({ type: "command", command }));
  $("commandInput").value = "";
}

function sendPower(signal) {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) return;
  state.socket.send(JSON.stringify({ type: "power", signal }));
}

function appendConsole(line) {
  const log = $("consoleLog");
  log.textContent += `${line}\n`;
  log.scrollTop = log.scrollHeight;
}

function setConsoleStatus(text) {
  $("consoleStatus").textContent = text;
}

async function loadFiles(directory) {
  setMessage("fileMessage", "");
  try {
    const data = await api(`/api/files/list?directory=${encodeURIComponent(directory || "/")}`);
    state.currentDirectory = data.directory || "/";
    $("currentPath").textContent = state.currentDirectory;
    renderFiles(data.items || []);
  } catch (err) {
    setMessage("fileMessage", readableError(err.message));
  }
}

function renderFiles(items) {
  const list = $("fileList");
  list.innerHTML = "";
  const sorted = [...items].sort((a, b) => {
    if (a.isFile !== b.isFile) return a.isFile ? 1 : -1;
    return a.name.localeCompare(b.name, "ko");
  });
  for (const item of sorted) {
    const tr = document.createElement("tr");
    const nameTd = document.createElement("td");
    const nameButton = document.createElement("button");
    nameButton.type = "button";
    nameButton.className = "file-name-button";
    nameButton.textContent = `${item.isFile ? "[FILE]" : "[DIR]"} ${item.name}`;
    nameButton.addEventListener("click", () => item.isFile ? openFile(item.name) : openDirectory(item.name));
    nameTd.appendChild(nameButton);

    const sizeTd = document.createElement("td");
    sizeTd.textContent = item.isFile ? formatBytes(item.size) : "-";

    const dateTd = document.createElement("td");
    dateTd.textContent = item.modifiedAt ? new Date(item.modifiedAt).toLocaleString() : "-";

    const actionTd = document.createElement("td");
    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "danger small-button";
    deleteButton.textContent = "삭제";
    deleteButton.addEventListener("click", () => deletePath(item.name));
    actionTd.appendChild(deleteButton);

    tr.append(nameTd, sizeTd, dateTd, actionTd);
    list.appendChild(tr);
  }
}

function pathJoin(directory, name) {
  const base = directory === "/" ? "" : directory;
  return `${base}/${name}`.replace(/\/+/g, "/");
}

function openDirectory(name) {
  loadFiles(pathJoin(state.currentDirectory, name));
}

function goUpDirectory() {
  if (state.currentDirectory === "/") return;
  const parts = state.currentDirectory.split("/").filter(Boolean);
  parts.pop();
  loadFiles(parts.length ? `/${parts.join("/")}` : "/");
}

async function openFile(name) {
  if (state.currentFileDirty && !confirm("저장하지 않은 내용이 있습니다. 다른 파일을 열까요?")) return;
  const file = pathJoin(state.currentDirectory, name);
  setMessage("fileMessage", "");
  try {
    const data = await api(`/api/files/read?file=${encodeURIComponent(file)}`);
    state.currentFile = data.file;
    state.currentFileDirty = false;
    $("fileEditor").disabled = false;
    $("fileEditor").value = data.content || "";
    $("saveFileButton").disabled = false;
    updateEditorTitle();
  } catch (err) {
    state.currentFile = "";
    $("fileEditor").disabled = true;
    $("saveFileButton").disabled = true;
    $("fileEditor").value = "";
    updateEditorTitle();
    setMessage("fileMessage", readableError(err.message));
  }
}

async function saveCurrentFile() {
  if (!state.currentFile) return;
  setMessage("fileMessage", "");
  try {
    await api("/api/files/write", {
      method: "POST",
      body: { file: state.currentFile, content: $("fileEditor").value }
    });
    state.currentFileDirty = false;
    updateEditorTitle();
    setMessage("fileMessage", "저장했습니다.");
  } catch (err) {
    setMessage("fileMessage", readableError(err.message));
  }
}

function updateEditorTitle() {
  $("editorTitle").textContent = state.currentFile
    ? `${state.currentFile}${state.currentFileDirty ? " *" : ""}`
    : "파일을 선택하세요";
}

async function createFolder() {
  const name = prompt("새 폴더 이름");
  if (!name) return;
  setMessage("fileMessage", "");
  try {
    await api("/api/files/folder", { method: "POST", body: { directory: state.currentDirectory, name } });
    await loadFiles(state.currentDirectory);
  } catch (err) {
    setMessage("fileMessage", readableError(err.message));
  }
}

async function deletePath(name) {
  const target = pathJoin(state.currentDirectory, name);
  if (!confirm(`${target}\n삭제할까요?`)) return;
  setMessage("fileMessage", "");
  try {
    await api("/api/files/delete", { method: "POST", body: { path: target } });
    if (state.currentFile === target) {
      state.currentFile = "";
      state.currentFileDirty = false;
      $("fileEditor").value = "";
      $("fileEditor").disabled = true;
      $("saveFileButton").disabled = true;
      updateEditorTitle();
    }
    await loadFiles(state.currentDirectory);
  } catch (err) {
    setMessage("fileMessage", readableError(err.message));
  }
}

async function uploadSelectedFile(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  setMessage("fileMessage", "업로드 중...");
  try {
    const contentBase64 = await fileToBase64(file);
    await api("/api/files/upload", {
      method: "POST",
      body: { directory: state.currentDirectory, filename: file.name, contentBase64 }
    });
    setMessage("fileMessage", "업로드했습니다.");
    await loadFiles(state.currentDirectory);
  } catch (err) {
    setMessage("fileMessage", readableError(err.message));
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("file_read_failed"));
    reader.onload = () => {
      const result = String(reader.result || "");
      resolve(result.includes(",") ? result.split(",").pop() : result);
    };
    reader.readAsDataURL(file);
  });
}

async function loadAccounts() {
  if (!state.user?.owner) return;
  try {
    const data = await api("/api/accounts");
    const list = $("accountList");
    list.innerHTML = "";
    for (const user of data.users || []) {
      const li = document.createElement("li");
      li.textContent = `${user.username}${user.owner ? " (주인)" : ""}`;
      list.appendChild(li);
    }
  } catch (err) {
    setMessage("accountMessage", readableError(err.message));
  }
}

async function createAccount(event) {
  event.preventDefault();
  try {
    await api("/api/accounts", {
      method: "POST",
      body: {
        username: $("newAccountUsername").value.trim(),
        password: $("newAccountPassword").value
      }
    });
    event.target.reset();
    setMessage("accountMessage", "계정을 만들었습니다.");
    await loadAccounts();
  } catch (err) {
    setMessage("accountMessage", readableError(err.message));
  }
}

async function resetAccount(event) {
  event.preventDefault();
  try {
    await api("/api/accounts/reset", {
      method: "POST",
      body: {
        username: $("resetAccountUsername").value.trim(),
        password: $("resetAccountPassword").value
      }
    });
    event.target.reset();
    setMessage("accountMessage", "비밀번호를 바꿨습니다.");
  } catch (err) {
    setMessage("accountMessage", readableError(err.message));
  }
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function setMessage(id, text) {
  $(id).textContent = text || "";
}

function readableError(message) {
  const map = {
    login_required: "로그인이 필요합니다.",
    unlock_required: "관리자 잠금 해제가 필요합니다.",
    owner_required: "천사 계정만 사용할 수 있습니다.",
    invalid_login: "아이디 또는 비밀번호가 틀렸습니다.",
    invalid_admin_password: "관리자 비밀번호가 틀렸습니다.",
    user_exists: "이미 있는 계정입니다.",
    user_not_found: "계정을 찾을 수 없습니다.",
    bad_path: "허용되지 않는 경로입니다.",
    bad_name: "허용되지 않는 이름입니다.",
    cannot_delete_root: "최상위 폴더는 삭제할 수 없습니다.",
    binary_or_unsupported_file: "텍스트 편집기로 열 수 없는 파일입니다.",
    binary_file_blocked: "바이너리 파일은 편집기로 열 수 없습니다.",
    empty_file: "빈 파일은 업로드할 수 없습니다.",
    upload_url_missing: "업로드 주소를 가져오지 못했습니다.",
    pterodactyl_config_missing: "서버 API 설정이 필요합니다.",
    console_not_ready: "콘솔 연결 준비 중입니다.",
    console_connected: "콘솔 연결됨"
  };
  if (map[message]) return map[message];
  if (message?.startsWith("file_too_large_")) return "파일 크기가 제한보다 큽니다.";
  return message || "요청을 처리하지 못했습니다.";
}

init();
