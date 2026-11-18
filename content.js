(() => {
  const prevPanel = document.getElementById("csp-helper-panel");
  const prevPos = prevPanel ? {
    left: prevPanel.style.left,
    top: prevPanel.style.top,
    right: prevPanel.style.right
  } : null;
  const wasHotReloaded = !!(window.__cspHelperCleanup || window.__cspHelperLoadedV025 || prevPanel);

  if (typeof window.__cspHelperCleanup === "function") {
    try { window.__cspHelperCleanup(); } catch (_) { }
  } else if (prevPanel) {
    prevPanel.remove();
  }
  window.__cspHelperLoadedV025 = true;

  const HOST = location.hostname.toLowerCase();
  const PORTAL = HOST.includes("csccloud.in") ? "web"
    : HOST.includes("digipaylite.in") ? "lite"
      : "other";
  const IS_DIGIPAY_WEB = PORTAL === "web";
  const IS_DIGIPAY_LITE = PORTAL === "lite";

  const norm = s => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
  const visible = el => {
    if (!el || !(el.offsetWidth || el.offsetHeight || el.getClientRects().length)) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none" && parseFloat(cs.opacity || "1") > 0.05;
  };
  const inPanel = el => !!el?.closest?.("#csp-helper-panel,#csp-helper-settings");
  const AUTO_SAVE_BLUR_DELAY_MS = 800;    // Wait 0.8s after leaving a field
  const MAX_LOGS = 300;
  let pendingLogs = [];
  let logFlushTimer = null;
  let saveTimer = null;
  let tabFillTimer = null;
  let popupSweepTimer = null;
  let selectedBank = "";
  let bankCategory = "";
  let suppressAutoSave = false;
  let lastFillAt = 0;
  let lastSavedSignature = "";
  let lastActiveTab = "";
  let autoSkipPopups = true;
  let extensionEnabled = false; // Stay completely stopped until loadPrefs() confirms enabled!
  let licenseAllowed = true;
  let licenseState = {allowed: true, configured: false, reason: "local", message: "", key: "", name: "", expires: "", notice: "", latestVersion: "", updateAvailable: false};
  let hooksAttached = false;
  let preferredDevice = "";
  let panelMode = "panel"; // "panel" (box) or "bar" (bottom single-line strip)
  let fontSizePx = 14;     // 12..19 px (bigger, crisp default)
  let autoSaveDelayMs = 2000; // 0 (manual only) or 1000..4000 ms
  let autoLogMode = "errors"; // "errors" (only on WARN/ERROR) | "off" | "always"
  let savedBoxPos = null;
  let autoClosedChangePwd = false;
  let autoNavigatedToAeps = false;
  let autoNavigatingNow = false;
  let closedLoginPopupThisLoad = false;
  let lastDeviceAutoSelectAt = 0;
  let lastConnectClickAt = 0;
  let lastVerifyClickAt = 0;
  let deviceConnectInProgress = false;
  let connectClickedOnThisScreen = false;
  let chooseDeviceEnteredAt = 0;
  let userOpenedProfileAt = 0;
  let lastTxAt = 0;
  let lastTxTab = "";
  let lastFilledTab = "";
  let pauseAutoUntilTabSwitch = false;

  async function loadPrefs() {
    try {
      const r = await chrome.storage.local.get([
        "cspAutoSkipPopups", "cspPreferredDevice", "cspPanelMode",
        "cspFontSizePx", "cspAutoSaveDelayMs", "cspExtensionEnabled", "cspAutoLogMode",
        "cspLicenseStatus"
      ]);
      if (typeof r.cspAutoSkipPopups === "boolean") autoSkipPopups = r.cspAutoSkipPopups;
      extensionEnabled = typeof r.cspExtensionEnabled === "boolean" ? r.cspExtensionEnabled : true;
      if (typeof r.cspPreferredDevice === "string") preferredDevice = r.cspPreferredDevice;
      if (r.cspPanelMode === "bar" || r.cspPanelMode === "panel") panelMode = r.cspPanelMode;
      if (typeof r.cspFontSizePx === "number" && r.cspFontSizePx >= 12 && r.cspFontSizePx <= 19) fontSizePx = r.cspFontSizePx;
      if (typeof r.cspAutoSaveDelayMs === "number" && r.cspAutoSaveDelayMs >= 0 && r.cspAutoSaveDelayMs <= 10000) autoSaveDelayMs = r.cspAutoSaveDelayMs;
      if (r.cspAutoLogMode === "off" || r.cspAutoLogMode === "errors" || r.cspAutoLogMode === "always") autoLogMode = r.cspAutoLogMode;
      if (r.cspLicenseStatus && typeof r.cspLicenseStatus === "object") {
        licenseState = {...licenseState, ...r.cspLicenseStatus};
        licenseAllowed = licenseState.allowed !== false;
      }
    } catch (_) { }
  }
  async function savePrefs(patch) {
    try { await chrome.storage.local.set(patch); } catch (_) { }
  }

  function formatLogTime(ts = Date.now()) {
    const d = new Date(ts);
    const pad = (n, w = 2) => String(n).padStart(w, "0");
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
  }

  function maskPII(val) {
    const s = String(val || "").trim();
    if (!s) return "";
    const digits = s.replace(/\D/g, "");
    if (digits.length >= 6) return `len=${digits.length}(${digits.slice(0, 2)}**${digits.slice(-2)})`;
    return `len=${s.length}`;
  }

  let pendingLogsUrgent = false;

  async function flushLogs() {
    clearTimeout(logFlushTimer);
    logFlushTimer = null;
    if (!pendingLogs.length) return;
    const batch = pendingLogs.splice(0, pendingLogs.length);
    const urgent = pendingLogsUrgent;
    pendingLogsUrgent = false;
    const r = await send("CSP_LOG_PUSH", { entries: batch, urgent });
    if (!r.ok) {
      // Fallback directly to chrome.storage.local if background didn't answer
      try {
        const { cspDebugLogs } = await chrome.storage.local.get("cspDebugLogs");
        const list = Array.isArray(cspDebugLogs) ? cspDebugLogs : [];
        list.push(...batch);
        if (list.length > MAX_LOGS) list.splice(0, list.length - MAX_LOGS);
        await chrome.storage.local.set({ cspDebugLogs: list });
      } catch (_) { }
    }
  }

  function logEvent(level, event, details = null) {
    const line = `[${formatLogTime()}] [${level}] [${PORTAL}] ${event}` +
      (details ? ` | ${typeof details === "string" ? details : JSON.stringify(details)}` : "");
    pendingLogs.push(line);
    if (level === "ERROR" || level === "WARN") pendingLogsUrgent = true;
    if (pendingLogs.length >= 15 || pendingLogsUrgent) {
      flushLogs();
    } else if (!logFlushTimer) {
      logFlushTimer = setTimeout(flushLogs, 800);
    }
  }

  async function getAllLogsText() {
    await flushLogs();
    let list = [];
    try {
      const { cspDebugLogs } = await chrome.storage.local.get("cspDebugLogs");
      if (Array.isArray(cspDebugLogs)) list = cspDebugLogs;
    } catch (_) { }
    const ver = (() => { try { return chrome.runtime.getManifest().version; } catch (_) { return "0.2.5"; } })();
    const header = [
      `=== CSP Automation Helper Log (v${ver}) ===`,
      `Exported: ${new Date().toLocaleString()}`,
      `Page: ${location.origin}${location.pathname}`,
      `AutoSkip: ${autoSkipPopups} | PreferredDevice: ${preferredDevice || "none"}`,
      `Total Entries: ${list.length}`,
      `================================================`
    ];
    return [...header, ...list].join("\n");
  }

  async function copyLogs() {
    const text = await getAllLogsText();
    try {
      await navigator.clipboard.writeText(text);
      showStatus("✓ लॉग कॉपी हो गया! अब चैट में Paste कर दें।");
    } catch (_) {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;opacity:0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      showStatus("✓ लॉग कॉपी हो गया! अब चैट में Paste कर दें।");
    }
  }

  async function downloadLogs() {
    await flushLogs();
    const r = await send("CSP_LOG_EXPORT_NOW");
    if (r.ok) {
      showStatus("✓ लॉग Downloads/CSP-Automation/csp-auto-log.txt में सेव हो गया।");
      return;
    }
    const text = await getAllLogsText();
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "csp-auto-log.txt";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showStatus("✓ लॉग Downloads/csp-auto-log.txt में सेव हो गया।");
  }

  async function clearLogs() {
    pendingLogs = [];
    pendingLogsUrgent = false;
    clearTimeout(logFlushTimer);
    logFlushTimer = null;
    await send("CSP_LOG_CLEAR");
    try { await chrome.storage.local.remove("cspDebugLogs"); } catch (_) { }
    showStatus("✓ पुराने लॉग साफ कर दिए गए।");
  }

  const onWinError = e => {
    if (String(e?.filename || "").includes("content.js") || String(e?.message || "").includes("csp")) {
      logEvent("ERROR", "window:error", { msg: e.message, line: e.lineno, col: e.colno });
    }
  };
  const onUnhandledRejection = e => {
    const reason = String(e?.reason?.stack || e?.reason?.message || e?.reason || "");
    if (reason.includes("content.js") || reason.includes("chrome-extension")) {
      logEvent("ERROR", "window:rejection", reason.slice(0, 240));
    }
  };
  window.addEventListener("error", onWinError);
  window.addEventListener("unhandledrejection", onUnhandledRejection);

  const send = (type, data) => new Promise(resolve => {
    try {
      chrome.runtime.sendMessage({ type, data }, r => {
        if (chrome.runtime.lastError) return resolve({ ok: false });
        resolve(r || { ok: false });
      });
    } catch (_) {
      resolve({ ok: false });
    }
  });
  async function getData() {
    const r = await send("CSP_SESSION_GET");
    return r.data || {};
  }
  async function saveData(patch) {
    const old = await getData();
    const next = { ...old, ...patch, savedAt: Date.now() };
    const r = await send("CSP_SESSION_SAVE", next);
    if (r.ok) {
      selectedBank = next.bank ?? "";
      bankCategory = next.bankCategory ?? "";
      lastSavedSignature = JSON.stringify([next.mobile || "", next.aadhaar || "", next.bank || "", next.bankCategory || ""]);
      renderMemory(next, true);
      showStatus("✓ डेटा अपने आप सेव हो गया।");
      logEvent("INFO", "save:ok", {
        mobile: maskPII(next.mobile),
        aadhaar: maskPII(next.aadhaar),
        bankCategory: next.bankCategory || "",
        bank: next.bank || ""
      });
    } else {
      showStatus("डेटा सेव नहीं हो पाया। दोबारा प्रयास करें।");
      logEvent("ERROR", "save:fail", { keys: Object.keys(patch || {}) });
    }
    return r.ok;
  }

  function ownFieldText(el) {
    const parts = [];
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l) parts.push(l.innerText);
    }
    if (el.labels) [...el.labels].forEach(l => parts.push(l.innerText));
    parts.push(el.getAttribute("aria-label"), el.getAttribute("placeholder"), el.getAttribute("name"), el.id);
    return norm(parts.join(" "));
  }

  function nearbyText(el) {
    const parts = [ownFieldText(el)];
    let node = el.parentElement;
    for (let i = 0; node && i < 4; i++, node = node.parentElement) {
      if (node.tagName === "FORM") break;
      const inputsInside = node.querySelectorAll('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), textarea');
      if (inputsInside.length > 1) break;
      if (node.innerText) parts.push(node.innerText.slice(0, 200));
    }
    return norm(parts.join(" "));
  }

  function isAmountField(el) {
    return /amount|रकम|राशि|rs\.?\s*100/i.test(nearbyText(el));
  }

  function isAadhaarLikeField(el) {
    const t = ownFieldText(el) + " " + nearbyText(el);
    return !/password|पासवर्ड/i.test(t) && /aadhaar|aadhar|\bvid\b|आधार|uid/i.test(t);
  }

  function isPasswordField(el) {
    const t = ownFieldText(el) + " " + nearbyText(el);
    if (/password|पासवर्ड/i.test(t)) return true;
    // Allow masked Aadhaar / VID input (type="password") on DigiPay Web
    return (el?.type || "").toLowerCase() === "password" && !isAadhaarLikeField(el);
  }

  function isDigiPayWeb() {
    return IS_DIGIPAY_WEB;
  }

  function isLoginPage() {
    return /login|signin|auth/i.test(location.pathname);
  }

  function isAepsFormPage() {
    if (isLoginPage()) return false;
    if (IS_DIGIPAY_WEB) {
      // Strict URL check for DigiPay Web (digipayweb.csccloud.in)
      const path = location.pathname.toLowerCase();
      if (!/\/aeps\/(balance-enquiry|cash-withdrawal|mini-statement|cash-deposit)/i.test(path)) return false;
      if (/receipt|status|result|summary/i.test(path)) return false;
      return true;
    }
    if (IS_DIGIPAY_LITE) {
      // Strict URL + form check for DigiPay Lite (digipaylite.in)
      if (isChooseDevicePage()) return false;
      const bodyTxt = norm((document.body?.innerText || "").slice(0, 6000));
      const hasFormCue = /enter aadhaar|mobile no\.|select bank/i.test(bodyTxt);
      if (!hasFormCue) return false;
      const tabs = [...document.querySelectorAll('[role="tab"],.mat-tab-label,.mdc-tab,.nav-link,button,a')]
        .filter(el => visible(el) && !inPanel(el))
        .map(el => norm(el.innerText || el.textContent))
        .filter(t => t && t.length <= 35);
      return tabs.some(t => /balance enquiry|cash withdrawal|mini statement/i.test(t));
    }
    return false;
  }

  function visibleTextInputs() {
    return [...document.querySelectorAll('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"]), textarea')]
      .filter(el => visible(el) && !inPanel(el) && !el.disabled && !isPasswordField(el))
      .filter(el => !el.closest('header,.navbar,nav'))
      .filter(el => !["search"].includes((el.type || "").toLowerCase()) &&
        !el.matches('[role="combobox"]') &&
        !/search|bank search|select bank|search service|type here to search/i.test(norm((el.placeholder || "") + " " + (el.getAttribute("aria-label") || ""))));
  }

  function findField(kind, excludeEl = null) {
    const fields = visibleTextInputs().filter(el => el !== excludeEl && !isAmountField(el));
    const patterns = kind === "mobile"
      ? [/mobile/, /phone/, /मोबाइल/, /contact number/]
      : [/aadhaar/, /aadhar/, /\bvid\b/, /आधार/, /uid/];

    // 1. Direct accessible label, placeholder, name, or id.
    let found = fields.find(el => patterns.some(re => re.test(ownFieldText(el))));
    if (found) return found;

    // 2. Nearest single-field wrapper label text.
    found = fields.find(el => patterns.some(re => re.test(nearbyText(el))));
    if (found) return found;

    // 3. Fallback layout: Mobile is first and Aadhaar is second.
    const likely = fields.filter(el => {
      const t = nearbyText(el);
      return !/amount|bank|search|otp|pin|password|account|ifsc/i.test(t);
    });
    if (kind === "mobile" && likely.length >= 1) return likely[0];
    if (kind === "aadhaar") {
      if (excludeEl && likely.length >= 1) return likely[0];
      if (!excludeEl && likely.length >= 2) return likely[1];
    }
    return null;
  }

  function setNativeValue(el, value, dispatchBlur = true) {
    const prev = el.value;
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, value); else el.value = value;
    try { el._valueTracker?.setValue(prev); } catch (_) { }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    if (dispatchBlur) el.dispatchEvent(new Event("blur", { bubbles: true }));
  }

  async function fillInputReliably(el, value, manual = false) {
    if ((!manual && !extensionEnabled) || !el || !value) return false;
    const wantDigits = value.replace(/\D/g, "");
    el.focus();
    setNativeValue(el, value, false);
    await sleep(60);
    if (!manual && !extensionEnabled) return false;
    if (el.value.replace(/\D/g, "") === wantDigits) {
      el.dispatchEvent(new Event("blur", { bubbles: true }));
      return true;
    }

    // Fallback 1: Genuine browser insertText (1 digit at a time) — passes React onBeforeInput / inputType==="insertText" anti-paste checks
    el.focus();
    try { el.select?.(); } catch (_) { }
    try { document.execCommand("delete", false); } catch (_) { }
    setNativeValue(el, "", false);
    await sleep(30);
    if (!manual && !extensionEnabled) return false;

    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;

    for (const ch of value) {
      if (!manual && !extensionEnabled) return false;
      const code = /^[0-9]$/.test(ch) ? `Digit${ch}` : "";
      const keyCode = ch.charCodeAt(0);
      const keyOpts = { bubbles: true, cancelable: true, key: ch, code, keyCode, which: keyCode };
      el.dispatchEvent(new KeyboardEvent("keydown", keyOpts));
      el.dispatchEvent(new KeyboardEvent("keypress", keyOpts));

      const beforeLen = (el.value || "").length;
      let inserted = false;
      try { inserted = document.execCommand("insertText", false, ch); } catch (_) { }
      if (!inserted || (el.value || "").length === beforeLen) {
        const prev = el.value || "";
        const nextVal = prev + ch;
        try {
          el.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, data: ch, inputType: "insertText" }));
        } catch (_) { }
        if (setter) setter.call(el, nextVal); else el.value = nextVal;
        try { el._valueTracker?.setValue(prev); } catch (_) { }
        try {
          el.dispatchEvent(new InputEvent("input", { bubbles: true, data: ch, inputType: "insertText" }));
        } catch (_) {
          el.dispatchEvent(new Event("input", { bubbles: true }));
        }
      }
      el.dispatchEvent(new KeyboardEvent("keyup", keyOpts));
      await sleep(18);
    }
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
    return el.value.replace(/\D/g, "") === wantDigits;
  }

  function realClick(el) {
    if (!el) return;
    try { el.scrollIntoView({ block: "nearest", inline: "nearest" }); } catch (_) { }
    const opts = { bubbles: true, cancelable: true, view: window };
    try { el.dispatchEvent(new PointerEvent("pointerdown", opts)); } catch (_) { }
    try { el.dispatchEvent(new MouseEvent("mousedown", opts)); } catch (_) { }
    try { el.focus?.(); } catch (_) { }
    try { el.dispatchEvent(new PointerEvent("pointerup", opts)); } catch (_) { }
    try { el.dispatchEvent(new MouseEvent("mouseup", opts)); } catch (_) { }
    try { el.click(); } catch (_) { }
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function showStatus(message) {
    const el = document.getElementById("csp-helper-status");
    if (el) {
      el.textContent = message;
      el.title = message;
    }
  }

  function renderMemory(data, saved = false) {
    const box = document.getElementById("csp-helper-memory-details");
    const state = document.getElementById("csp-helper-memory-state");
    if (box) {
      box.replaceChildren();
      const rows = [
        ["Mobile", data.mobile || "नहीं मिला"],
        ["Aadhaar", data.aadhaar || "नहीं मिला"],
        ["Bank Mode", data.bankCategory || (data.bank ? "Other" : "नहीं चुना")],
        ["Bank Name", data.bank || "नहीं चुना"]
      ];
      rows.forEach(([k, v]) => {
        const row = document.createElement("div");
        row.className = "csp-helper-memory-row";
        const a = document.createElement("span"); a.textContent = k;
        const b = document.createElement("strong"); b.textContent = v; b.title = v;
        row.append(a, b); box.append(row);
      });
    }
    if (state) {
      const has = !!(data.mobile || data.aadhaar || data.bank);
      state.textContent = has
        ? (saved ? "✓ डेटा सेव है" : "डेटा उपलब्ध")
        : "अभी कोई डेटा सेव नहीं है";
      state.classList.toggle("saved", has);
    }
  }

  async function refreshMemory() {
    const d = await getData();
    renderMemory(d, !!(d.mobile || d.aadhaar || d.bank));
  }

  function isCustomerField(el) {
    if (!el || inPanel(el) || !isAepsFormPage()) return false;
    const mobileEl = findField("mobile");
    const aadhaarEl = findField("aadhaar", mobileEl);
    return el === mobileEl || el === aadhaarEl;
  }

  let liveAadhaarDigits = "";

  function isMaskedValue(val) {
    return /[xX*•]/.test(String(val || ""));
  }

  function formatAadhaarDigits(digits) {
    if (digits.length === 12) return `${digits.slice(0, 4)}-${digits.slice(4, 8)}-${digits.slice(8, 12)}`;
    return digits;
  }

  function pickValidMobile(raw, fallback) {
    const s = (raw || "").trim();
    if (!s || isMaskedValue(s)) return fallback || "";
    const digits = s.replace(/\D/g, "");
    if (digits.length < 10 && (fallback || "").replace(/\D/g, "").length >= 10) return fallback;
    return s;
  }

  function pickValidAadhaar(raw, fallback) {
    const s = (raw || "").trim();
    // If DigiPay Lite masked the input live as user typed (e.g., XXXX-XXXX-5855), use live keystroke buffer
    if (s && isMaskedValue(s)) {
      const trailingDigits = s.replace(/\D/g, "");
      if (liveAadhaarDigits.length >= 12 && (!trailingDigits || liveAadhaarDigits.endsWith(trailingDigits))) {
        logEvent("INFO", "save:capturedMaskedAadhaar", { digitsLen: liveAadhaarDigits.length });
        return formatAadhaarDigits(liveAadhaarDigits);
      }
      logEvent("INFO", "save:skipMaskedAadhaar", { rawLen: s.length, bufLen: liveAadhaarDigits.length });
      return fallback || "";
    }
    if (!s) return fallback || "";
    const digits = s.replace(/\D/g, "");
    if (digits.length >= 12) liveAadhaarDigits = digits;
    if (digits.length < 12 && (fallback || "").replace(/\D/g, "").length >= 12) return fallback;
    return s;
  }

  async function autoSaveFields() {
    if (suppressAutoSave || !isAepsFormPage()) return;
    const mobileEl = findField("mobile");
    const aadhaarEl = findField("aadhaar", mobileEl);
    const old = await getData();
    const rawMobile = mobileEl?.value?.trim() || "";
    const rawAadhaar = aadhaarEl?.value?.trim() || "";
    const mobile = pickValidMobile(rawMobile, old.mobile);
    const aadhaar = pickValidAadhaar(rawAadhaar, old.aadhaar);
    const domBank = readCurrentlySelectedBankFromDOM(mobileEl, aadhaarEl);
    const bank = (bankCategory !== "Major" && domBank) ? domBank : (selectedBank || domBank || old.bank || "");
    const category = (bankCategory !== "Major" && domBank) ? "Other" : (bankCategory || old.bankCategory || "");
    const signature = JSON.stringify([mobile, aadhaar, bank, category]);
    if (signature === lastSavedSignature) {
      if (mobile || aadhaar || bank) showStatus("✓ डेटा पहले से सेव है।");
      return;
    }
    if (!mobile && !aadhaar && !bank) return;
    await saveData({ mobile, aadhaar, bank, bankCategory: category });
  }

  function scheduleAutoSave(delay = autoSaveDelayMs, typing = false) {
    if (suppressAutoSave || autoSaveDelayMs === 0) return;
    clearTimeout(saveTimer);
    if (typing) {
      const sec = Math.round(delay / 1000);
      showStatus(`टाइपिंग पूरी होने का इंतज़ार… (${sec} सेकंड बाद सेव होगा)`);
    }
    saveTimer = setTimeout(autoSaveFields, delay);
  }

  const onKeyDown = e => {
    if (suppressAutoSave || !isAepsFormPage() || inPanel(e.target)) return;
    if (!e.target?.matches?.("input,textarea")) return;
    const mobileEl = findField("mobile");
    const aadhaarEl = findField("aadhaar", mobileEl);
    if (e.target !== aadhaarEl) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (/^[0-9]$/.test(e.key)) {
      const val = aadhaarEl.value || "";
      const allSelected = aadhaarEl.selectionStart === 0 && aadhaarEl.selectionEnd === val.length && val.length > 0;
      if (!val || allSelected) liveAadhaarDigits = "";
      if (liveAadhaarDigits.length < 16) liveAadhaarDigits += e.key;
    } else if (e.key === "Backspace" || e.key === "Delete") {
      const val = aadhaarEl.value || "";
      const allSelected = aadhaarEl.selectionStart === 0 && aadhaarEl.selectionEnd === val.length;
      if (val.length <= 1 || allSelected) liveAadhaarDigits = "";
      else liveAadhaarDigits = liveAadhaarDigits.slice(0, -1);
    }
  };
  const onPaste = e => {
    if (suppressAutoSave || !isAepsFormPage() || inPanel(e.target)) return;
    const mobileEl = findField("mobile");
    const aadhaarEl = findField("aadhaar", mobileEl);
    if (e.target !== aadhaarEl) return;
    const pasted = (e.clipboardData?.getData("text") || "").replace(/\D/g, "");
    if (pasted.length >= 12) liveAadhaarDigits = pasted.slice(0, 16);
  };
  const onInput = e => {
    if (e.target.matches?.("input,textarea") && isCustomerField(e.target)) {
      pauseAutoUntilTabSwitch = false;
      if ((e.target.value || "").trim() === "") {
        const mobileEl = findField("mobile");
        const aadhaarEl = findField("aadhaar", mobileEl);
        if (e.target === aadhaarEl) liveAadhaarDigits = "";
      }
      scheduleAutoSave(autoSaveDelayMs, true);
    }
  };
  const onFieldChange = e => {
    if (!e.target?.matches?.("input,textarea") || !isAepsFormPage()) return;
    if (isCustomerField(e.target)) {
      scheduleAutoSave(AUTO_SAVE_BLUR_DELAY_MS, false);
      return;
    }
    const mobileEl = findField("mobile");
    const aadhaarEl = findField("aadhaar", mobileEl);
    const bankInput = findBankInput(findBankToggle("Other"), mobileEl, aadhaarEl);
    if (bankInput && e.target === bankInput) {
      const val = bankInput.value?.trim();
      if (val && val.length >= 3) rememberBankOption(val);
    }
  };
  const onFocusOut = e => {
    if (!e.target?.matches?.("input,textarea") || !isAepsFormPage()) return;
    if (isCustomerField(e.target)) {
      scheduleAutoSave(AUTO_SAVE_BLUR_DELAY_MS, false);
      return;
    }
    const mobileEl = findField("mobile");
    const aadhaarEl = findField("aadhaar", mobileEl);
    const bankInput = findBankInput(findBankToggle("Other"), mobileEl, aadhaarEl);
    if (bankInput && e.target === bankInput) {
      const val = bankInput.value?.trim();
      if (val && val.length >= 3) setTimeout(() => rememberBankOption(bankInput.value?.trim()), 150);
    }
  };

  function clickTab(label, manual = true) {
    if (!licenseAllowed) return false;
    if (!manual && !extensionEnabled) return false;
    const wanted = norm(label);
    const selectors = ['[role="tab"]', '.mat-tab-label', '.mdc-tab', '[data-bs-toggle="tab"]', '[data-toggle="tab"]', '.nav-link', '.nav-tabs a', '.nav-item a', 'button', 'a'];
    let candidates = [...new Set(selectors.flatMap(s => [...document.querySelectorAll(s)]))]
      .filter(el => visible(el) && !inPanel(el))
      .map(el => ({ el, text: norm(el.innerText || el.textContent) }))
      .filter(x => x.text === wanted || x.text.includes(wanted));
    // Fallback for DigiPay Web pill tabs / dashboard cards rendered as div/span/li
    if (!candidates.length) {
      candidates = [...document.querySelectorAll('div,span,li,p')]
        .filter(el => visible(el) && !inPanel(el))
        .map(el => ({ el, text: norm(el.innerText || el.textContent), depth: el.querySelectorAll("*").length }))
        .filter(x => x.text === wanted && x.depth <= 3)
        .sort((a, b) => a.depth - b.depth);
    }
    if (!candidates.length) {
      // On DigiPay Web (e.g. /receipt or collapsed sidebar), expand AePS Services or navigate to exact route
      if (IS_DIGIPAY_WEB) {
        const routeMap = {
          "balance enquiry": "/aeps/balance-enquiry",
          "cash withdrawal": "/aeps/cash-withdrawal",
          "mini statement": "/aeps/mini-statement",
          "cash deposit": "/aeps/cash-deposit"
        };
        const aepsMenu = findSidebarItem("AePS Services");
        if (aepsMenu) {
          realClick(aepsMenu);
          setTimeout(() => {
            const sub = findSidebarItem(label);
            if (sub) {
              pauseAutoUntilTabSwitch = false;
              lastFilledTab = "";
              realClick(sub);
              logEvent("INFO", "tab:sidebarClick", { label, manual });
              if (manual || extensionEnabled) setTimeout(() => autoFillCurrentForm(manual, true), 700);
            } else if (routeMap[wanted]) {
              logEvent("INFO", "tab:routeNav", { label, route: routeMap[wanted], manual });
              location.href = routeMap[wanted];
            }
          }, 300);
          return true;
        }
        if (routeMap[wanted]) {
          logEvent("INFO", "tab:routeNav", { label, route: routeMap[wanted], manual });
          location.href = routeMap[wanted];
          return true;
        }
      }
      logEvent("WARN", "tab:notFound", { label, path: location.pathname });
      return false;
    }
    candidates.sort((a, b) => Number(b.text === wanted) - Number(a.text === wanted) || a.text.length - b.text.length);
    pauseAutoUntilTabSwitch = false;
    lastFilledTab = "";
    realClick(candidates[0].el);
    logEvent("INFO", "tab:click", { label, matched: candidates[0].text, manual });
    if (manual || extensionEnabled) setTimeout(() => autoFillCurrentForm(manual, true), 700);
    return true;
  }

  const MAJOR_BANKS = ["SBI", "ICICI", "Kotak", "PNB", "BOB", "Paytm"];
  const OPTION_SELECTOR = 'mat-option,[role="option"],ngb-typeahead-window button,typeahead-container button,.dropdown-item,.mat-option,.mat-mdc-option,.ng-option,.ant-select-item-option,.select2-results__option,.MuiAutocomplete-option,.MuiMenuItem-root,[class*="option"],[class*="Option"],[class*="menu-item"],[class*="list-item"],[role="listbox"] > *,.cdk-overlay-pane li,.cdk-overlay-pane button,li';

  function isOtherText(t) {
    return /^(bank\s+)?others?(\s+banks?)?$/i.test(norm(t));
  }

  function findBankToggle(text) {
    const wanted = norm(text);
    const matchText = wanted === "other"
      ? t => isOtherText(t)
      : t => norm(t) === wanted;

    // 1. Standard clickable elements
    const primary = [...document.querySelectorAll('button,a,[role="button"],[role="radio"],label')]
      .filter(el => visible(el) && !inPanel(el) && !el.closest('nav,[role="tablist"],.navbar,.sidebar,aside,header'))
      .filter(el => matchText(el.innerText || el.textContent));
    if (primary.length) return primary[0];

    // 2. Card / chip / custom div, span, p, li (prefer innermost/smallest match)
    const fallback = [...document.querySelectorAll('div,span,p,li')]
      .filter(el => visible(el) && !inPanel(el) && !el.closest('nav,[role="tablist"],.navbar,.sidebar,aside,header'))
      .filter(el => {
        const t = norm(el.innerText || el.textContent);
        return t && t.length <= 30 && matchText(t);
      });
    if (!fallback.length) return null;
    fallback.sort((a, b) => a.querySelectorAll("*").length - b.querySelectorAll("*").length);
    return fallback[0];
  }

  function findBankInput(otherEl, mobileEl, aadhaarEl) {
    const inputs = [...document.querySelectorAll('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"]):not([type="password"])')]
      .filter(el => visible(el) && !inPanel(el) && !el.disabled && !isPasswordField(el) && el !== mobileEl && el !== aadhaarEl && !isAmountField(el))
      .filter(el => !el.closest('nav,.navbar,.sidebar,aside,header'))
      .filter(el => !/search service|type here to search/i.test(ownFieldText(el)));

    if (!inputs.length) return null;

    // 1. Direct bank/search attributes or nearby "Select Bank" label
    const explicit = inputs.find(el => /select\s*bank|bank|search|choose/i.test(
      norm(ownFieldText(el) + " " + nearbyText(el) + " " + (el.getAttribute("role") || ""))
    ));
    if (explicit) return explicit;

    // 2. Geometrically directly below the "Other" bank chip
    if (otherEl && visible(otherEl)) {
      const or = otherEl.getBoundingClientRect();
      const below = inputs
        .map(el => ({ el, r: el.getBoundingClientRect() }))
        .filter(x => x.r.top >= or.top - 5 && x.r.top <= or.bottom + 160)
        .sort((a, b) => a.r.top - b.r.top);
      if (below.length) return below[0].el;
    }

    // 3. Visible input below Aadhaar field (before Amount)
    if (aadhaarEl && visible(aadhaarEl)) {
      const ar = aadhaarEl.getBoundingClientRect();
      const afterAadhaar = inputs
        .map(el => ({ el, r: el.getBoundingClientRect() }))
        .filter(x => x.r.top > ar.bottom - 5)
        .sort((a, b) => a.r.top - b.r.top);
      if (afterAadhaar.length) return afterAadhaar[0].el;
    }
    return null;
  }

  function optionElementFrom(target) {
    const opt = target.closest?.(OPTION_SELECTOR);
    if (!opt || inPanel(opt)) return null;
    if (opt.closest('nav,[role="tablist"],.nav,.nav-tabs,.navbar,.sidebar,aside,header')) return null;
    if (opt.matches('[role="tab"],.nav-item,.nav-link,.mat-tab-label,.mdc-tab') || opt.querySelector?.('[role="tab"],.nav-link')) return null;
    const txt = (opt.innerText || opt.textContent || "").trim();
    if (!txt || txt.length > 140 || txt.split("\n").length > 3) return null;
    return opt;
  }

  function readCurrentlySelectedBankFromDOM(mobileEl = null, aadhaarEl = null) {
    // Native <select>
    const selects = [...document.querySelectorAll("select")].filter(el => visible(el) && !inPanel(el));
    for (const sel of selects) {
      const opt = sel.selectedOptions?.[0];
      const val = (opt?.textContent || "").trim();
      if (val && opt?.value && !/^(select|choose|--)/i.test(val)) return val;
    }
    // Bank autocomplete / text input right below "Other"
    const mEl = mobileEl || findField("mobile");
    const aEl = aadhaarEl || findField("aadhaar", mEl);
    const bankInput = findBankInput(findBankToggle("Other"), mEl, aEl);
    if (bankInput) {
      const val = (bankInput.value || "").trim();
      if (val && val.length >= 3 && !/^(select|choose|other|--)/i.test(val)) return val;
    }
    // Custom dropdown selected value (ng-select, react-select, select2, ant-select, mat-select)
    const valueEls = [...document.querySelectorAll('.ng-value-label,[class*="singleValue"],.select2-selection__rendered,.ant-select-selection-item,.mat-select-value-text,.mat-mdc-select-value-text')]
      .filter(el => visible(el) && !inPanel(el));
    for (const el of valueEls) {
      const val = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
      if (val && val.length >= 2 && val.length <= 120 && !/^(select|choose|other|--)/i.test(val)) return val;
    }
    return "";
  }

  async function rememberBankOption(name) {
    if (suppressAutoSave || !isAepsFormPage()) return;
    const clean = (name || "").replace(/\s+/g, " ").trim();
    if (!clean || clean.length < 2 || clean.length > 120) return;
    if (/^(others?(\s+banks?)?|select.*bank|choose.*bank|bank|balance enquiry|cash withdrawal|mini statement|aadhaar pay|dashboard|home|logout|profile|reports?|--.*|rs\.?\s*\d[\d,]*|\d[\d,]*)$/i.test(clean)) return;
    if (clean === selectedBank && bankCategory === "Other") return;
    selectedBank = clean;
    bankCategory = "Other";
    // "Other" is the required category toggle; the chosen bank is a separate value.
    await saveData({ bank: clean, bankCategory: "Other" });
  }

  // Capture bank dropdown selection on mousedown BEFORE React/Angular/Select2 closes & unmounts the menu
  const onMouseDown = e => {
    if (suppressAutoSave || inPanel(e.target) || !isAepsFormPage()) return;
    const opt = optionElementFrom(e.target);
    if (opt && visible(opt)) {
      const optTxt = (opt.innerText || opt.textContent || "").trim().split("\n")[0];
      if (!isOtherText(optTxt) && !MAJOR_BANKS.some(x => norm(x) === norm(optTxt))) {
        setTimeout(() => rememberBankOption(optTxt), 60);
      }
    }
  };

  const onClick = e => {
    if (suppressAutoSave || inPanel(e.target)) return;

    // Track if user clicked top-right profile menu (so manual Change Password isn't auto-closed)
    if (e.target.closest?.('header,.navbar,[class*="header" i],[class*="profile" i]')) {
      userOpenedProfileAt = Date.now();
    }

    // Track if user clicked CAPTURE / Customer scan and proceed -> pause auto-actions until user switches tab!
    const actionBtn = e.target.closest?.('button,a,[role="button"],input[type="button"],input[type="submit"]');
    const actionTxt = norm(actionBtn?.innerText || actionBtn?.value || "");
    if (e.isTrusted && /^connect device$/i.test(actionTxt) && isChooseDevicePage()) {
      connectClickedOnThisScreen = true;
      lastConnectClickAt = Date.now();
      logEvent("INFO", "device:userConnectClick");
      showStatus("⏳ 'Connect Device' दबाया गया — डिवाइस कनेक्ट होने का इंतज़ार…");
      return;
    }
    if (e.isTrusted && /please verify identity/i.test(actionTxt) && isChooseDevicePage()) {
      lastVerifyClickAt = Date.now();
      logEvent("INFO", "device:userVerifyClick");
      return;
    }
    if (/^(capture|customer scan and proceed|scan and proceed|proceed|submit|withdraw|check balance)$/i.test(actionTxt) && isAepsFormPage()) {
      lastTxAt = Date.now();
      lastTxTab = getActiveTabSignature();
      lastFilledTab = lastTxTab;
      pauseAutoUntilTabSwitch = true;
      clearTimeout(tabFillTimer);
      logEvent("INFO", "tx:triggered", { btn: actionTxt, tab: lastTxTab });
      return;
    }

    const clickable = e.target.closest?.('button,a,[role="button"],[role="tab"],[role="radio"],label,.mat-tab-label,.mdc-tab,li,div');
    const txt = norm(clickable?.innerText || "");
    const insideModal = !!e.target.closest?.('.modal,[role="dialog"],.swal2-popup,.swal-modal,.mat-dialog-container,.mat-mdc-dialog-container');
    if (!insideModal && txt && txt.length <= 30 && /^(balance enquiry|cash withdrawal|mini statement|cash deposit)$/i.test(txt)) {
      const currentTab = getActiveTabSignature();
      if (txt !== currentTab) {
        pauseAutoUntilTabSwitch = false;
        lastFilledTab = "";
        if (extensionEnabled) setTimeout(() => autoFillCurrentForm(false), 700);
      }
      return;
    }

    if (!isAepsFormPage()) return;

    // Check bank toggle ("Other" or Major banks) even if rendered as div/span/card
    const chipEl = clickable || e.target.closest?.('div,span,p,li');
    const chipTxt = norm(chipEl?.innerText || "");
    if (chipTxt && chipTxt.length <= 30) {
      if (isOtherText(chipTxt)) {
        bankCategory = "Other";
        const wasMajor = MAJOR_BANKS.some(x => norm(x) === norm(selectedBank));
        if (wasMajor) selectedBank = "";
        saveData(wasMajor ? { bankCategory: "Other", bank: "" } : { bankCategory: "Other" });
        return;
      }
      const major = MAJOR_BANKS.find(x => norm(x) === chipTxt);
      if (major) {
        selectedBank = major;
        bankCategory = "Major";
        saveData({ bank: major, bankCategory: "Major" });
        return;
      }
    }

    const opt = optionElementFrom(e.target);
    if (opt && visible(opt)) {
      const optTxt = (opt.innerText || opt.textContent || "").trim().split("\n")[0];
      setTimeout(() => rememberBankOption(optTxt), 80);
    }
  };

  const onSelectChange = e => {
    if (suppressAutoSave || inPanel(e.target) || !isAepsFormPage()) return;
    if (e.target instanceof HTMLSelectElement) {
      const val = e.target.selectedOptions?.[0]?.textContent?.trim();
      if (val && !/^(select|choose|--)/i.test(val)) rememberBankOption(val);
    }
  };

  function findBankOptionElement(bankName) {
    const wanted = norm(bankName);
    if (!wanted) return null;
    const candidates = [...document.querySelectorAll(OPTION_SELECTOR)]
      .filter(el => visible(el) && !inPanel(el) && !el.closest('nav,[role="tablist"],.nav,.nav-tabs,.navbar,.sidebar,aside,header'))
      .map(el => {
        const raw = (el.innerText || el.textContent || "").trim();
        const full = norm(raw);
        const firstLine = norm(raw.split("\n")[0]);
        return { el, full, firstLine, len: full.length };
      })
      .filter(x => x.full && x.len <= 140);

    // 1. Exact match on full text or first line
    const exact = candidates.find(x => x.full === wanted || x.firstLine === wanted);
    if (exact) return exact.el;

    // 2. Partial match fallback (shortest match first)
    if (wanted.length >= 4) {
      const partial = candidates
        .filter(x => x.full.includes(wanted) || wanted.includes(x.firstLine))
        .sort((a, b) => a.len - b.len);
      if (partial.length) return partial[0].el;
    }
    return null;
  }

  function findBankDropdownTrigger(mobileEl, aadhaarEl) {
    // 1. Custom select / combobox widgets
    const customSelectors = [
      'ng-select', 'mat-select', '[role="combobox"]', '[aria-haspopup="listbox"]',
      '.select2-selection', '[class*="select__control"]', '[class*="Select-control"]',
      '.ant-select-selector', '.MuiAutocomplete-root', '.MuiSelect-select',
      'input[type="search"]', 'input[placeholder*="bank" i]', 'input[aria-label*="bank" i]'
    ].join(',');
    const widgets = [...document.querySelectorAll(customSelectors)]
      .filter(el => visible(el) && !inPanel(el) && el !== mobileEl && el !== aadhaarEl)
      .filter(el => !el.closest('nav,.navbar,.sidebar,aside,header'))
      .filter(el => !/search service|type here to search/i.test(ownFieldText(el)));
    if (widgets.length) {
      const bankNamed = widgets.find(el => /bank|select|search/i.test(norm(
        (el.innerText || "") + " " + (el.getAttribute("placeholder") || "") + " " +
        (el.getAttribute("aria-label") || "") + " " + (el.id || "") + " " + (el.className || "")
      )));
      return bankNamed || widgets[0];
    }

    // 2. Generic button/div/input with bank/select placeholder or label
    const generic = [...document.querySelectorAll('button,div[class*="select" i],div[class*="dropdown" i],input')]
      .filter(el => visible(el) && !inPanel(el) && el !== mobileEl && el !== aadhaarEl)
      .filter(el => !el.closest('nav,.navbar,.sidebar,aside,header'))
      .find(el => /select\s*(a\s*)?bank|choose\s*bank|search\s*bank|enter\s*bank|--\s*select/i.test(norm(
        (el.innerText || "") + " " + (el.getAttribute("placeholder") || "") + " " + (el.getAttribute("aria-label") || "")
      )));
    return generic || null;
  }

  function tryNativeSelect(bankName) {
    const wanted = norm(bankName);
    const selects = [...document.querySelectorAll("select")].filter(el => visible(el) && !inPanel(el));
    for (const sel of selects) {
      const opts = [...sel.options];
      const match = opts.find(o => norm(o.textContent) === wanted) ||
        (wanted.length >= 4 && opts.find(o => norm(o.textContent).includes(wanted)));
      if (match) {
        sel.value = match.value;
        sel.dispatchEvent(new Event("input", { bubbles: true }));
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
    }
    return false;
  }

  function typeIntoAutocomplete(inputEl, text) {
    inputEl.focus();
    setNativeValue(inputEl, text, false);
    try {
      inputEl.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
    } catch (_) { }
    inputEl.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: text.slice(-1) || "a" }));
    inputEl.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: text.slice(-1) || "a" }));
  }

  async function selectBankFromOpenDropdown(bankName, otherEl, mobileEl, aadhaarEl) {
    if (tryNativeSelect(bankName)) return true;

    let optionEl = findBankOptionElement(bankName);
    if (optionEl) {
      realClick(optionEl);
      return true;
    }

    // 1. DigiPay Lite autocomplete/typeahead input directly below the "Other" bank chip
    const bankInput = findBankInput(otherEl, mobileEl, aadhaarEl);
    if (bankInput) {
      realClick(bankInput);
      await sleep(150);
      optionEl = findBankOptionElement(bankName);
      if (optionEl) {
        realClick(optionEl);
        return true;
      }

      // Type full bank name (without blur!) and wait for autocomplete options
      typeIntoAutocomplete(bankInput, bankName);
      for (let attempt = 0; attempt < 5; attempt++) {
        await sleep(220);
        optionEl = findBankOptionElement(bankName);
        if (optionEl) {
          realClick(optionEl);
          return true;
        }
      }

      // Retry with shorter prefix (first 2 words) in case autocomplete filters better on partial text
      const shortQuery = bankName.split(/\s+/).slice(0, 2).join(" ");
      if (shortQuery && shortQuery.length >= 3 && shortQuery !== bankName) {
        typeIntoAutocomplete(bankInput, "");
        await sleep(100);
        typeIntoAutocomplete(bankInput, shortQuery);
        for (let attempt = 0; attempt < 4; attempt++) {
          await sleep(220);
          optionEl = findBankOptionElement(bankName);
          if (optionEl) {
            realClick(optionEl);
            return true;
          }
        }
        // If no dropdown options exist at all (plain input / datalist), restore full bank name
        setNativeValue(bankInput, bankName, true);
      }
      return norm(bankInput.value) === norm(bankName);
    }

    // 2. Fallback: custom select/combobox widget (ng-select, react-select, mat-select, select2)
    const trigger = findBankDropdownTrigger(mobileEl, aadhaarEl);
    if (!trigger) return false;

    const innerInput = trigger.matches("input") ? trigger : trigger.querySelector?.('input:not([type="hidden"])');
    realClick(trigger);
    if (innerInput && innerInput !== trigger) realClick(innerInput);
    await sleep(300);

    optionEl = findBankOptionElement(bankName);
    if (optionEl) {
      realClick(optionEl);
      return true;
    }

    const searchInput = (innerInput && visible(innerInput) ? innerInput : null) ||
      (document.activeElement?.matches?.("input") && !inPanel(document.activeElement) && document.activeElement !== mobileEl && document.activeElement !== aadhaarEl ? document.activeElement : null) ||
      [...document.querySelectorAll('input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"])')]
        .filter(el => visible(el) && !inPanel(el) && el !== mobileEl && el !== aadhaarEl && !isAmountField(el))
        .find(el => /search|bank|filter/i.test(norm((el.getAttribute("placeholder") || "") + " " + (el.getAttribute("aria-label") || "") + " " + (el.className || ""))));

    if (searchInput) {
      typeIntoAutocomplete(searchInput, bankName);
      for (let attempt = 0; attempt < 5; attempt++) {
        await sleep(250);
        optionEl = findBankOptionElement(bankName);
        if (optionEl) {
          realClick(optionEl);
          return true;
        }
      }
    }
    return false;
  }

  async function applyBank(data, mobileEl, aadhaarEl, manual = false) {
    if (!manual && !extensionEnabled) return false;
    if (!data.bank && !data.bankCategory) return false;

    const majorFullNames = {
      sbi: "State Bank of India",
      pnb: "Punjab National Bank",
      bob: "Bank of Baroda",
      icici: "ICICI Bank",
      kotak: "Kotak Mahindra Bank",
      paytm: "Paytm Payments Bank"
    };

    // Portal 1: DigiPay Web (digipayweb.csccloud.in) -> direct React-Select "Bank Option*" dropdown (no Major/Other chips)
    if (IS_DIGIPAY_WEB) {
      if (!data.bank) return false;
      const queryName = majorFullNames[norm(data.bank)] || data.bank;
      for (let round = 0; round < 2; round++) {
        if (round > 0) await sleep(350);
        if (await selectBankFromOpenDropdown(queryName, null, mobileEl, aadhaarEl)) {
          logEvent("INFO", "bank:applied", { portal: "web", bank: queryName, round });
          return true;
        }
      }
      logEvent("WARN", "bank:applyFailed", { portal: "web", bank: queryName });
      return false;
    }

    // Portal 2: DigiPay Lite (digipaylite.in) -> Major bank chips OR "Other" chip + autocomplete input below it
    const isOther = data.bankCategory === "Other" || (data.bank && !MAJOR_BANKS.some(x => norm(x) === norm(data.bank)));
    if (isOther) {
      const other = findBankToggle("Other");
      const alreadyHasBankField = !!(
        findBankInput(other, mobileEl, aadhaarEl) ||
        [...document.querySelectorAll("select")].some(el => visible(el) && !inPanel(el))
      );
      if (other && !alreadyHasBankField) {
        realClick(other);
        const radio = other.querySelector?.('input[type="radio"]') ||
          (other.htmlFor ? document.getElementById(other.htmlFor) : null);
        if (radio && radio.type === "radio" && !radio.checked) {
          radio.checked = true;
          radio.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }
      if (!data.bank) return !!(other || alreadyHasBankField);

      for (let round = 0; round < 2; round++) {
        await sleep(alreadyHasBankField && round === 0 ? 150 : 400);
        if (await selectBankFromOpenDropdown(data.bank, other, mobileEl, aadhaarEl)) {
          logEvent("INFO", "bank:applied", { portal: "lite", mode: "Other", bank: data.bank, round });
          return true;
        }
        if (round === 0 && other) realClick(other);
      }
      logEvent("WARN", "bank:applyFailed", {
        portal: "lite",
        mode: "Other",
        bank: data.bank,
        otherFound: !!other,
        alreadyHasBankField,
        bankInputFound: !!findBankInput(other, mobileEl, aadhaarEl)
      });
      return false;
    }

    const major = findBankToggle(data.bank);
    if (major) {
      realClick(major);
      logEvent("INFO", "bank:applied", { portal: "lite", mode: "Major", bank: data.bank });
      return true;
    }
    logEvent("WARN", "bank:majorNotFound", { portal: "lite", bank: data.bank });
    return false;
  }

  function isTransactionModalText(txt) {
    return /transaction\s*(success|successful|failed|failure|status|declined|pending|id|receipt)|available balance|ledger balance|print receipt|download receipt|\brrn\b|\butr\b|\bstan\b|insufficient\s*(balance|fund)|biometric.*(mismatch|failed)|authentication failed|response code|bank remark|new transaction/i.test(txt || "");
  }

  function isTransactionResultVisible() {
    const modals = findVisibleModals();
    for (const m of modals) {
      const t = norm(m.innerText || m.textContent);
      if (isTransactionModalText(t)) return true;
    }
    const path = norm(location.pathname + " " + location.hash);
    if (/receipt|result|status|summary|invoice/i.test(path)) return true;
    return false;
  }

  async function autoFillCurrentForm(isManual = false, silent = false) {
    if (!licenseAllowed) return;
    if (!isManual && !extensionEnabled) return;
    if (!isAepsFormPage()) {
      if (isManual && !silent) showStatus("पहले AEPS फॉर्म (Balance Enquiry / Cash Withdrawal) खोलें।");
      return;
    }
    if (!isManual) {
      if (isTransactionResultVisible()) {
        pauseAutoUntilTabSwitch = true;
        lastTxAt = Date.now();
        return;
      }
      const currentTab = getActiveTabSignature();
      if (pauseAutoUntilTabSwitch && (!currentTab || currentTab === lastTxTab)) return;
      if (currentTab && currentTab === lastFilledTab) return;
      if (Date.now() - lastTxAt < 4000 && (!currentTab || currentTab === lastTxTab)) return;
    }
    const now = Date.now();
    if (!isManual && now - lastFillAt < 400) return;
    lastFillAt = now;
    const data = await getData();
    if (!data || (!data.mobile && !data.aadhaar && !data.bank && !data.bankCategory)) {
      if (isManual && !silent) showStatus("मेमोरी में कोई ग्राहक डेटा सेव नहीं है। पहले 'याद रखें' दबाएँ।");
      return;
    }
    const mobileEl = findField("mobile");
    const aadhaarEl = findField("aadhaar", mobileEl);
    let count = 0;
    let bankOK = false;
    let mobileStatus = !mobileEl ? "notFound" : (!data.mobile ? "noData" : "alreadyMatched");
    let aadhaarStatus = !aadhaarEl ? "notFound" : (!data.aadhaar ? "noData" : (isMaskedValue(data.aadhaar) ? "maskedData" : "alreadyMatched"));
    suppressAutoSave = true;
    clearTimeout(saveTimer);
    try {
      if (mobileEl && data.mobile && mobileEl.value.replace(/\D/g, "") !== data.mobile.replace(/\D/g, "")) {
        const mobVal = mobileEl.maxLength === 10 ? data.mobile.replace(/\D/g, "") : data.mobile;
        const ok = await fillInputReliably(mobileEl, mobVal, isManual);
        mobileStatus = ok ? "filled" : `failed(afterLen=${(mobileEl.value || "").length})`;
        if (ok) count++;
      }
      if (aadhaarEl && data.aadhaar && !isMaskedValue(data.aadhaar)) {
        const curRaw = aadhaarEl.value || "";
        const wantDigits = data.aadhaar.replace(/\D/g, "");
        const curDigits = curRaw.replace(/\D/g, "");
        const alreadyMatches = curDigits === wantDigits ||
          (isMaskedValue(curRaw) && curRaw.replace(/[-\s]/g, "").length === wantDigits.length && curDigits.length >= 4 && wantDigits.endsWith(curDigits));
        if (!alreadyMatches) {
          // DigiPay Web masked Aadhaar / VID input expects plain digits (no hyphens) via MAIN-world React handler
          const needPlainDigits = isDigiPayWeb() || aadhaarEl.type === "password" || aadhaarEl.maxLength === 12 || aadhaarEl.maxLength === 16;
          const aadhaarVal = needPlainDigits ? wantDigits : data.aadhaar;
          let ok = false;
          if (IS_DIGIPAY_WEB) {
            const mainRes = await send("CSP_FILL_AADHAAR_MAIN", {digits: aadhaarVal, manual: isManual});
            ok = !!mainRes?.ok;
            logEvent(ok ? "INFO" : "WARN", "aadhaar:mainWorld", mainRes);
            aadhaarStatus = ok ? `filled(${mainRes.method})` : `failed(${mainRes.method || mainRes.reason},afterLen=${mainRes.afterLen ?? 0})`;
          }
          if (!ok) {
            ok = await fillInputReliably(aadhaarEl, aadhaarVal, isManual);
            aadhaarStatus = ok ? "filled" : `failed(type=${aadhaarEl.type},max=${aadhaarEl.maxLength},ph=${aadhaarEl.placeholder || ""},afterLen=${(aadhaarEl.value || "").length})`;
          }
          if (ok) count++;
        }
      }
      if (data.bank || data.bankCategory) bankOK = await applyBank(data, mobileEl, aadhaarEl, isManual);
    } finally {
      setTimeout(() => { suppressAutoSave = false; }, 500);
    }
    const filledTab = getActiveTabSignature();
    if (count || bankOK) {
      if (filledTab) lastFilledTab = filledTab;
      pauseAutoUntilTabSwitch = false;
    }
    logEvent(count || bankOK ? "INFO" : "WARN", "autofill:done", {
      tab: filledTab,
      manual: isManual,
      mobileStatus,
      aadhaarStatus,
      filledFields: count,
      bankOK,
      bankMode: data.bankCategory || "",
      bank: data.bank || ""
    });
    if (count || bankOK) showStatus(`✓ दूसरे फॉर्म में ${count} फील्ड${bankOK ? " और बैंक" : ""} भरे गए। कृपया जाँचें।`);
    else if (isManual && !silent) showStatus("✓ डेटा पहले से भरा है (या फील्ड नहीं मिले)। कृपया जाँचें।");
    renderMemory(data, true);
  }

  async function rememberManually() {
    clearTimeout(saveTimer);
    if (!licenseAllowed) return;
    if (!isAepsFormPage()) {
      showStatus("पहले AEPS फॉर्म (Balance Enquiry / Cash Withdrawal) खोलें।");
      return;
    }
    const old = await getData();
    const mobileEl = findField("mobile");
    const aadhaarEl = findField("aadhaar", mobileEl);
    const mobile = pickValidMobile(mobileEl?.value?.trim(), old.mobile);
    const aadhaar = pickValidAadhaar(aadhaarEl?.value?.trim(), old.aadhaar);
    const domBank = readCurrentlySelectedBankFromDOM(mobileEl, aadhaarEl);
    const bank = (bankCategory !== "Major" && domBank) ? domBank : (selectedBank || domBank || old.bank || "");
    const category = (bankCategory !== "Major" && domBank) ? "Other" : (bankCategory || old.bankCategory || "");
    await saveData({mobile, aadhaar, bank, bankCategory: category});
  }

  async function fillManually() {
    await autoFillCurrentForm(true);
  }

  let lastDeviceHintAt = 0;

  function findVisibleModals() {
    const selectors = [
      '.modal.show', '.modal[style*="display: block"]', '[role="dialog"]',
      '.swal2-popup', '.swal-modal',
      '.mat-dialog-container', '.mat-mdc-dialog-container', '.cdk-overlay-pane',
      '[class*="modal-dialog" i]', '[class*="modal-content" i]', '[class*="popup" i]'
    ].join(',');
    return [...document.querySelectorAll(selectors)].filter(el => {
      if (!visible(el) || inPanel(el)) return false;
      const r = el.getBoundingClientRect();
      return r.width >= 220 && r.height >= 120;
    });
  }

  function findModalCloseButton(modal) {
    // 1. Explicit close button selectors
    const explicit = [...modal.querySelectorAll('button.close,.btn-close,[aria-label*="close" i],[title*="close" i],.close-btn,.modal-close,i.fa-times,i.fa-close,.fa-xmark,mat-icon')]
      .filter(el => visible(el) && !inPanel(el))
      .find(el => {
        if (el.tagName === "MAT-ICON") return /close|clear|cancel/i.test(norm(el.innerText || el.textContent));
        return true;
      });
    if (explicit) return explicit.closest?.("button,a,[role='button']") || explicit;

    // 2. Text-based X or Close button inside modal
    const textBtn = [...modal.querySelectorAll('button,a,span,div,i')]
      .filter(el => visible(el) && !inPanel(el))
      .filter(el => {
        const t = norm(el.innerText || el.textContent);
        return /^(×|✕|✖|x|close)$/.test(t) && el.querySelectorAll("*").length <= 2;
      });
    if (textBtn.length) return textBtn[0];

    // 3. Top-right small icon/SVG/image close button in banner modal
    const mr = modal.getBoundingClientRect();
    const corner = [...modal.querySelectorAll('button,span,div,a,i,svg,img')]
      .filter(el => visible(el) && !inPanel(el))
      .filter(el => {
        const r = el.getBoundingClientRect();
        return r.width > 8 && r.width <= 48 && r.height > 8 && r.height <= 48 &&
          r.right >= mr.right - 65 && r.top <= mr.top + 65;
      });
    return corner[0] || null;
  }

  function dismissBlockingPopups(manual = false) {
    if (!licenseAllowed) return "";
    if (!manual && !extensionEnabled) return "";
    const modals = findVisibleModals();
    for (const modal of modals) {
      const txt = norm(modal.innerText || modal.textContent);

      // 0. DigiPay "Kindly Choose <Mantra/Startek/Morpho/...> Device..." popup -> click Okay & select that exact device!
      const devHint = txt.match(/kindly choose\s+(mantra|startek|morpho|tatvik|precision|iris)/i);
      if (devHint) {
        if (!manual && Date.now() - lastDeviceHintAt < 4000) continue;
        const okBtn = [...modal.querySelectorAll('button,a,[role="button"]')]
          .filter(el => visible(el) && !inPanel(el))
          .find(el => /^(okay|ok)$/i.test(norm(el.innerText || el.textContent)));
        if (okBtn) {
          const deviceWord = devHint[1].toLowerCase();
          lastDeviceHintAt = Date.now();
          realClick(okBtn);
          logEvent("INFO", "device:hintOkay", {deviceWord, manual});
          setTimeout(async () => {
            if (!manual && !extensionEnabled) return;
            const card = [...document.querySelectorAll('button,div,li,a,label,span')]
              .filter(el => visible(el) && !inPanel(el))
              .filter(el => {
                const t = cleanTextWithoutIcons(el);
                return t.includes(deviceWord) && t.includes("device") && t.length <= 35;
              })
              .sort((a, b) => a.querySelectorAll("*").length - b.querySelectorAll("*").length)[0];
            if (card && (manual || extensionEnabled)) {
              realClick(card.closest?.('button,li,a,label,div') || card);
              logEvent("INFO", "device:hintCardClicked", {deviceWord, manual});
              connectClickedOnThisScreen = false;
              lastConnectClickAt = 0;
              await sleep(650);
              if (manual || extensionEnabled) selectSavedDeviceIfOnChooseDevice(manual);
            }
          }, 350);
          return `डिवाइस पॉपअप (${devHint[1]}) 'Okay' किया गया।`;
        }
      }

      // NEVER touch Transaction Success / Failed / Receipt popups!
      if (isTransactionModalText(txt)) {
        pauseAutoUntilTabSwitch = true;
        lastTxAt = Date.now();
        continue;
      }

      // 1. "Change Password" reminder modal -> click its Close button (only on Dashboard, never on AEPS form)
      if (!isAepsFormPage() && /change password/i.test(txt) && /old password/i.test(txt)) {
        if (!manual && (autoClosedChangePwd || Date.now() - userOpenedProfileAt < 12000)) continue;
        const closeBtn = [...modal.querySelectorAll('button,a,[role="button"]')]
          .filter(el => visible(el) && !inPanel(el))
          .find(el => /^close$/i.test(norm(el.innerText || el.textContent)));
        if (closeBtn) {
          realClick(closeBtn);
          autoClosedChangePwd = true;
          logEvent("INFO", "popup:closed", { type: "ChangePassword", manual });
          return "Change Password popup बंद किया गया।";
        }
      }

      // 2. Promotional / announcement image banner popups (ONLY on Dashboard, NEVER on AEPS transaction page!)
      if (!isAepsFormPage()) {
        const hasInputs = modal.querySelectorAll('input:not([type="hidden"]),select,textarea').length > 0;
        const hasBannerImg = [...modal.querySelectorAll('img')].some(img => {
          const r = img.getBoundingClientRect();
          return r.width >= 240 && r.height >= 140;
        });
        const isAnnouncementText = /kyc process|cashout imps|sbi is now live|wallet top up|good news|important notice/i.test(txt);
        if ((!hasInputs && hasBannerImg) || isAnnouncementText) {
          const closeBtn = findModalCloseButton(modal);
          if (closeBtn) {
            realClick(closeBtn);
            logEvent("INFO", "popup:closed", { type: "Announcement", manual });
            return "Announcement popup बंद किया गया।";
          }
        }
      }
    }
    return "";
  }

  function isChooseDevicePage() {
    return [...document.querySelectorAll('h1,h2,h3,h4,h5,div,span')]
      .filter(el => visible(el) && !inPanel(el))
      .some(el => /^choose device$/i.test(norm(el.innerText || el.textContent)));
  }

  function findActionBtn(pattern) {
    return [...document.querySelectorAll('button,a,[role="button"],input[type="button"],input[type="submit"]')]
      .filter(el => visible(el) && !inPanel(el) && !el.disabled)
      .find(el => pattern.test(norm(el.innerText || el.textContent || el.value))) || null;
  }

  function hasVisiblePageText(pattern) {
    return [...document.querySelectorAll('div,span,p,h1,h2,h3,h4,h5,label,li,[role="alert"],[role="status"]')]
      .filter(el => visible(el) && !inPanel(el))
      .some(el => {
        if (el.children.length > 6) return false;
        const t = norm(el.innerText || el.textContent);
        return t.length > 0 && t.length <= 120 && pattern.test(t);
      });
  }

  function isDeviceLoadingOrConnecting() {
    const loaderSelectors = [
      '.spinner', '.spinner-border', '.spinner-grow', '.loader', '.loading',
      'mat-spinner', 'mat-progress-spinner', '.mat-progress-spinner',
      '.ngx-spinner-overlay', '[class*="spinner" i]', '[class*="loader" i]',
      '[class*="loading" i]', '[role="progressbar"]'
    ].join(',');
    const hasSpinner = [...document.querySelectorAll(loaderSelectors)]
      .some(el => visible(el) && !inPanel(el));
    if (hasSpinner) return true;
    return hasVisiblePageText(/connecting|please wait|searching device|scanning device|checking device|initializing|discovering/i);
  }

  // Compare DigiPay Lite Choose Device screen against the 3 known screen states:
  // 1) "aeps"         -> Unified AEPS form (Balance Enquiry / Cash Withdrawal / CAPTURE)
  // 2) "connected"    -> "Device is connected" / "Data Saved" green toast OR "Please Verify Identity" button
  // 3) "connecting"   -> Loader/spinner OR Connect Device already clicked & waiting for RD service
  // 4) "disconnected" -> "Device is not Connected" + "Connect Device" button visible
  function getChooseDeviceScreenState() {
    if (isAepsFormPage()) return { state: "aeps", verifyBtn: null, connectBtn: null };
    if (!isChooseDevicePage()) return { state: "other", verifyBtn: null, connectBtn: null };

    const verifyBtn = findActionBtn(/please verify identity/i);
    const hasConnectedToast = hasVisiblePageText(/\bdevice\s+is\s+connected\b|\bdata\s+saved\b/i);
    if (verifyBtn || hasConnectedToast) {
      return { state: "connected", verifyBtn, connectBtn: null, hasConnectedToast };
    }

    const connectBtn = findActionBtn(/^connect device$/i);
    const hasNotConnected = hasVisiblePageText(/\bdevice\s+is\s+not\s+connected\b/i);
    if (isDeviceLoadingOrConnecting()) {
      return { state: "connecting", verifyBtn: null, connectBtn, reason: "loader" };
    }
    if (connectBtn && (hasNotConnected || !hasConnectedToast)) {
      return { state: "disconnected", verifyBtn: null, connectBtn, hasNotConnected };
    }
    return { state: "connecting", verifyBtn: null, connectBtn: null, reason: "transition" };
  }

  async function selectSavedDeviceIfOnChooseDevice(manual = false) {
    if (!licenseAllowed) return false;
    if (!manual && !extensionEnabled) return false;
    if (!isChooseDevicePage()) {
      connectClickedOnThisScreen = false;
      chooseDeviceEnteredAt = 0;
      return false;
    }
    if (!chooseDeviceEnteredAt) chooseDeviceEnteredAt = Date.now();
    if (deviceConnectInProgress) return true;

    let screen = getChooseDeviceScreenState();

    // STATE 1: Already connected ("Device is connected" / "Data Saved" toast OR "Please Verify Identity" button)
    // -> NEVER click "Connect Device"! Wait briefly for Verify button if toast appeared first, then click once.
    if (screen.state === "connected") {
      deviceConnectInProgress = true;
      try {
        let verifyBtn = screen.verifyBtn;
        if (!verifyBtn) {
          showStatus("✓ डिवाइस कनेक्ट हो गया — 'Please Verify Identity' का इंतज़ार…");
          for (let w = 0; w < 12; w++) {
            await sleep(300);
            if ((!manual && !extensionEnabled) || isAepsFormPage() || !isChooseDevicePage()) return true;
            verifyBtn = findActionBtn(/please verify identity/i);
            if (verifyBtn) break;
          }
        }
        if (verifyBtn && (manual || Date.now() - lastVerifyClickAt >= 12000)) {
          lastVerifyClickAt = Date.now();
          realClick(verifyBtn);
          logEvent("INFO", "device:verifyClick", {manual, step: "connectedState"});
          showStatus("✓ डिवाइस कनेक्ट है — 'Please Verify Identity' क्लिक किया गया।");
        }
        return true;
      } finally {
        deviceConnectInProgress = false;
      }
    }

    // STATE 2: Connecting / loader / transitional DOM -> WAIT patiently, do NOT click Connect Device!
    if (screen.state === "connecting") {
      showStatus("⏳ डिवाइस कनेक्ट हो रहा है, इंतज़ार कर रहे हैं…");
      return true;
    }

    // STATE 3: Disconnected ("Device is not Connected" + "Connect Device")
    if (screen.state === "disconnected" && screen.connectBtn) {
      // If we ALREADY clicked Connect Device on this Choose Device screen (or user clicked it),
      // DO NOT click it again automatically — RD service can take 5-20s while screen still shows "Device is not Connected"!
      if (!manual && (connectClickedOnThisScreen || Date.now() - lastConnectClickAt < 30000)) {
        return true;
      }

      deviceConnectInProgress = true;
      try {
        // Grace wait (1.8s) on first entry to Choose Device: sometimes DigiPay auto-connects without needing a click!
        if (!manual) {
          const elapsed = Date.now() - chooseDeviceEnteredAt;
          if (elapsed < 1800) {
            showStatus("⏳ डिवाइस स्टेटस जाँच रहे हैं…");
            await sleep(1800 - elapsed);
            if (!extensionEnabled || isAepsFormPage() || !isChooseDevicePage()) return true;
            screen = getChooseDeviceScreenState();
            if (screen.state === "connected") {
              if (screen.verifyBtn && Date.now() - lastVerifyClickAt >= 12000) {
                lastVerifyClickAt = Date.now();
                realClick(screen.verifyBtn);
                logEvent("INFO", "device:verifyClick", {manual: false, step: "autoConnectedDuringGrace"});
                showStatus("✓ डिवाइस अपने आप कनेक्ट हो गया — 'Please Verify Identity' क्लिक किया।");
              }
              return true;
            }
            if (screen.state !== "disconnected" || !screen.connectBtn || connectClickedOnThisScreen) {
              return true;
            }
          }
        }

        // Click "Connect Device" EXACTLY ONCE, then compare screen state every 500ms for up to 30 seconds
        connectClickedOnThisScreen = true;
        lastConnectClickAt = Date.now();
        realClick(screen.connectBtn);
        logEvent("INFO", "device:connectClick", {manual, hasNotConnected: !!screen.hasNotConnected});
        showStatus("⏳ 'Connect Device' 1 बार क्लिक किया — डिवाइस कनेक्ट होने का इंतज़ार…");

        for (let i = 0; i < 60; i++) {
          await sleep(500);
          if (!manual && !extensionEnabled) return true;
          if (isAepsFormPage() || !isChooseDevicePage()) {
            connectClickedOnThisScreen = false;
            chooseDeviceEnteredAt = 0;
            return true;
          }

          // If "Kindly Choose <Device> Device..." popup appears during scan, handle it immediately
          const hintMsg = dismissBlockingPopups(manual);
          if (hintMsg) {
            showStatus("✓ " + hintMsg);
            return true;
          }

          const cur = getChooseDeviceScreenState();
          if (cur.state === "aeps") {
            connectClickedOnThisScreen = false;
            chooseDeviceEnteredAt = 0;
            return true;
          }
          if (cur.state === "connected") {
            let vBtn = cur.verifyBtn;
            if (!vBtn) {
              for (let w = 0; w < 10; w++) {
                await sleep(300);
                if ((!manual && !extensionEnabled) || isAepsFormPage() || !isChooseDevicePage()) return true;
                vBtn = findActionBtn(/please verify identity/i);
                if (vBtn) break;
              }
            }
            if (vBtn && (manual || Date.now() - lastVerifyClickAt >= 12000)) {
              lastVerifyClickAt = Date.now();
              realClick(vBtn);
              logEvent("INFO", "device:verifyClick", {manual, step: "afterConnect", waitMs: (i + 1) * 500});
              showStatus("✓ डिवाइस कनेक्ट हो गया — 'Please Verify Identity' क्लिक किया।");
            }
            return true;
          }
        }
        logEvent("WARN", "device:verifyTimeout", {waitedSec: 30});
        showStatus("डिवाइस कनेक्ट नहीं हुआ (30 सेकंड इंतज़ार किया)। डिवाइस चेक करके फिर कोशिश करें।");
        return true;
      } finally {
        deviceConnectInProgress = false;
      }
    }
    return false;
  }

  function cleanTextWithoutIcons(el) {
    if (!el) return "";
    const clone = el.cloneNode(true);
    clone.querySelectorAll?.('mat-icon,.material-icons,.material-icons-outlined,.fa,.fas,.far,.fab,i,svg').forEach(n => n.remove());
    return norm(clone.innerText || clone.textContent).replace(/[→↓↑←❯›▸▾]/g, "").trim();
  }

  function isDashboardPage() {
    if (isAepsFormPage() || isChooseDevicePage()) return false;
    const bodyTxt = norm(document.body?.innerText || "");
    return /earning commission|earnings report|earning by item type|no\.?\s*of\s*txn|wallet & transactions|payout \(bank transfer\)|registered devices/i.test(bodyTxt) ||
      /dashboard/i.test(location.href);
  }

  function findSidebarItem(label) {
    const wanted = norm(label);
    const all = [...document.querySelectorAll('a,button,li,div,span,p')]
      .filter(el => visible(el) && !inPanel(el))
      .filter(el => {
        const r = el.getBoundingClientRect();
        return r.left < 320 && r.width > 15 && r.height > 10 && r.height < 120;
      });

    // 1. Exact match after stripping icon text — keep innermost or direct a/button so click bubbles through div -> li
    const exact = all
      .filter(el => cleanTextWithoutIcons(el) === wanted)
      .sort((a, b) => a.querySelectorAll("*").length - b.querySelectorAll("*").length);
    if (exact.length) {
      return exact[0].closest?.('a,button,[role="button"]') || exact[0];
    }

    // 2. Fallback: raw text ends with or equals wanted (short elements only)
    const fallback = all
      .filter(el => {
        const t = norm(el.innerText || el.textContent).replace(/[→↓↑←❯›▸▾]/g, "").trim();
        return t && t.length <= wanted.length + 22 && (t === wanted || t.endsWith(" " + wanted));
      })
      .sort((a, b) => a.querySelectorAll("*").length - b.querySelectorAll("*").length);
    if (fallback.length) {
      return fallback[0].closest?.('a,button,[role="button"]') || fallback[0];
    }
    return null;
  }

  async function goToUnifiedAeps(fromAuto = false) {
    if (!licenseAllowed) return;
    if (fromAuto && !extensionEnabled) return;
    if (autoNavigatingNow) return;
    autoNavigatingNow = true;
    try {
      showStatus("AEPS पेज खोल रहे हैं…");
      // Step 1: Close any stacked popups (banners + Change Password)
      for (let i = 0; i < 8; i++) {
        if (fromAuto && !extensionEnabled) return;
        const closed = dismissBlockingPopups(!fromAuto);
        if (!closed) break;
        await sleep(380);
      }
      if (fromAuto && !extensionEnabled) return;

      if (isAepsFormPage()) {
        showStatus("✓ आप पहले से AEPS पेज पर हैं।");
        return;
      }

      if (isChooseDevicePage()) {
        await selectSavedDeviceIfOnChooseDevice(!fromAuto);
        return;
      }

      // DigiPay Web (digipayweb.csccloud.in): Sidebar has "AePS Services" -> "Balance Enquiry" (or Dashboard icon)
      if (isDigiPayWeb()) {
        let balItem = findSidebarItem("Balance Enquiry");
        if (!balItem) {
          const aepsMenu = findSidebarItem("AePS Services");
          if (aepsMenu) {
            showStatus("Sidebar में 'AePS Services' खोल रहे हैं…");
            realClick(aepsMenu);
            for (let w = 0; w < 5; w++) {
              await sleep(250);
              if (fromAuto && !extensionEnabled) return;
              balItem = findSidebarItem("Balance Enquiry");
              if (balItem) break;
            }
          }
        }
        if (fromAuto && !extensionEnabled) return;
        if (balItem) {
          autoNavigatedToAeps = true;
          realClick(balItem);
          logEvent("INFO", "nav:digipayWebAeps", {via: "sidebar", fromAuto});
          showStatus("✓ DigiPay Balance Enquiry खुल रहा है…");
        } else if (clickTab("Balance Enquiry", !fromAuto)) {
          autoNavigatedToAeps = true;
          logEvent("INFO", "nav:digipayWebAeps", {via: "card", fromAuto});
          showStatus("✓ DigiPay Balance Enquiry खुल रहा है…");
        } else {
          logEvent("WARN", "nav:digipayWebNotFound", {fromAuto});
          showStatus("DigiPay में 'AePS Services / Balance Enquiry' नहीं मिला।");
          return;
        }
        for (let i = 0; i < 8; i++) {
          await sleep(350);
          if (fromAuto && !extensionEnabled) return;
          if (isAepsFormPage()) {
            showStatus("✓ DigiPay AEPS खुल गया।");
            if (!fromAuto || extensionEnabled) setTimeout(() => autoFillCurrentForm(!fromAuto, true), 450);
            return;
          }
        }
        return;
      }

      // DigiPay Lite (digipaylite.in): Open Services -> Unified AEPS in left sidebar
      let aepsItem = findSidebarItem("Unified AEPS");
      if (!aepsItem) {
        const servicesItem = findSidebarItem("Services");
        if (servicesItem) {
          showStatus("Sidebar में 'Services' खोल रहे हैं…");
          realClick(servicesItem);
          for (let w = 0; w < 5; w++) {
            await sleep(250);
            if (fromAuto && !extensionEnabled) return;
            aepsItem = findSidebarItem("Unified AEPS");
            if (aepsItem) break;
          }
          if (!aepsItem && (!fromAuto || extensionEnabled) && servicesItem.parentElement && !inPanel(servicesItem.parentElement)) {
            realClick(servicesItem.parentElement);
            for (let w = 0; w < 4; w++) {
              await sleep(250);
              if (fromAuto && !extensionEnabled) return;
              aepsItem = findSidebarItem("Unified AEPS");
              if (aepsItem) break;
            }
          }
        }
      }
      if (fromAuto && !extensionEnabled) return;
      if (aepsItem) {
        autoNavigatedToAeps = true;
        realClick(aepsItem);
        logEvent("INFO", "nav:aepsClicked", {fromAuto});
        showStatus("✓ 'Unified AEPS' खोला गया, Choose Device का इंतज़ार…");
        for (let i = 0; i < 10; i++) {
          await sleep(400);
          if (fromAuto && !extensionEnabled) return;
          if (isChooseDevicePage()) {
            await selectSavedDeviceIfOnChooseDevice(!fromAuto);
            return;
          }
          if (isAepsFormPage()) {
            logEvent("INFO", "nav:aepsOpened", {fromAuto});
            showStatus("✓ Unified AEPS खुल गया।");
            return;
          }
        }
        logEvent("WARN", "nav:aepsWaitTimeout", {fromAuto});
      } else {
        logEvent("WARN", "nav:aepsNotFound", {fromAuto, hasServices: !!findSidebarItem("Services")});
        showStatus("Sidebar में 'Unified AEPS' नहीं मिला।");
      }
    } finally {
      autoNavigatingNow = false;
    }
  }

  function schedulePopupAndDeviceCheck() {
    if (!licenseAllowed || !extensionEnabled || !autoSkipPopups || autoNavigatingNow || isLoginPage()) return;
    if (isTransactionResultVisible()) return;
    clearTimeout(popupSweepTimer);
    popupSweepTimer = setTimeout(() => {
      if (!licenseAllowed || !extensionEnabled || isTransactionResultVisible() || isLoginPage()) return;

      // DigiPay Web (digipayweb.csccloud.in): NO login banner popups, NO Choose Device -> only auto-open AEPS from /dashboard
      if (IS_DIGIPAY_WEB) {
        if (!autoNavigatedToAeps && isDashboardPage()) {
          if (findSidebarItem("AePS Services") || findSidebarItem("Balance Enquiry")) {
            goToUnifiedAeps(true);
          }
        }
        return;
      }

      // DigiPay Lite (digipaylite.in): Close login banners/Change Password -> Services -> Unified AEPS -> Connect Device -> Verify Identity
      if (IS_DIGIPAY_LITE) {
        const msg = dismissBlockingPopups(false);
        if (msg) {
          closedLoginPopupThisLoad = true;
          autoNavigatedToAeps = false;
          showStatus("✓ " + msg);
          schedulePopupAndDeviceCheck();
          return;
        }
        if (!autoNavigatedToAeps && (isDashboardPage() || closedLoginPopupThisLoad)) {
          if (findSidebarItem("Services") || findSidebarItem("Unified AEPS")) {
            goToUnifiedAeps(true);
            return;
          }
        }
        if (isChooseDevicePage()) {
          selectSavedDeviceIfOnChooseDevice(false);
        } else {
          connectClickedOnThisScreen = false;
          chooseDeviceEnteredAt = 0;
        }
      }
    }, 450);
  }

  function btn(label, fn, cls = "", shortLabel = "", title = "") {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "csp-helper-btn " + cls;
    b.textContent = label;
    b.dataset.fullLabel = label;
    b.dataset.shortLabel = shortLabel || label;
    b.title = title || label;
    b.addEventListener("click", fn);
    return b;
  }

  function applyPanelAppearance(panel) {
    if (!panel) return;
    panel.style.setProperty("--csp-fs", fontSizePx + "px");
    const settingsBox = document.getElementById("csp-helper-settings");
    if (settingsBox) settingsBox.style.setProperty("--csp-fs", fontSizePx + "px");
  }

  function applyEnabledState(panel = document.getElementById("csp-helper-panel")) {
    if (panel) {
      panel.classList.toggle("csp-manual-mode", !extensionEnabled);
      const pwrBtn = panel.querySelector("#csp-helper-power");
      if (pwrBtn) {
        pwrBtn.textContent = extensionEnabled ? "⚡ Auto" : "✋ Manual";
        pwrBtn.title = extensionEnabled
          ? "अभी Auto मोड चालू है — क्लिक करके Manual मोड (Stop Auto) करें"
          : "अभी Manual मोड चालू है (सिर्फ क्लिक पर काम) — क्लिक करके Auto मोड करें";
        pwrBtn.classList.toggle("is-manual", !extensionEnabled);
      }
    }
    const settingsBox = document.getElementById("csp-helper-settings");
    if (settingsBox) {
      const autoBtn = settingsBox.querySelector('[data-workmode="auto"]');
      const manualBtn = settingsBox.querySelector('[data-workmode="manual"]');
      if (autoBtn) autoBtn.classList.toggle("active-auto", extensionEnabled);
      if (manualBtn) manualBtn.classList.toggle("active-manual", !extensionEnabled);
      const hint = settingsBox.querySelector("#csp-set-workmode-hint");
      if (hint) {
        hint.classList.toggle("is-manual", !extensionEnabled);
        hint.textContent = extensionEnabled
          ? "✓ अभी Auto मोड चालू है — याद रखना, भरना और पॉपअप सब अपने आप होगा।"
          : "✋ अभी Manual मोड चालू है — डेटा हमेशा अपने आप याद होगा, पर भरना/टैब/पॉपअप सिर्फ़ बटन क्लिक करने पर होगा।";
      }
    }
  }

  let rememberHooksAttached = false;
  function attachRememberHooks() {
    if (rememberHooksAttached) return;
    rememberHooksAttached = true;
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("paste", onPaste, true);
    document.addEventListener("input", onInput, true);
    document.addEventListener("change", onFieldChange, true);
    document.addEventListener("focusout", onFocusOut, true);
    document.addEventListener("mousedown", onMouseDown, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("change", onSelectChange, true);
  }

  function detachRememberHooks() {
    clearTimeout(saveTimer);
    if (!rememberHooksAttached) return;
    rememberHooksAttached = false;
    document.removeEventListener("keydown", onKeyDown, true);
    document.removeEventListener("paste", onPaste, true);
    document.removeEventListener("input", onInput, true);
    document.removeEventListener("change", onFieldChange, true);
    document.removeEventListener("focusout", onFocusOut, true);
    document.removeEventListener("mousedown", onMouseDown, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("change", onSelectChange, true);
  }

  function attachPageHooks() {
    if (hooksAttached) return;
    hooksAttached = true;
    observer.observe(document.documentElement, {subtree:true, childList:true, attributes:true, attributeFilter:["class","aria-selected","aria-current"]});
  }

  function detachPageHooks() {
    clearTimeout(tabFillTimer);
    clearTimeout(popupSweepTimer);
    observer.disconnect();
    hooksAttached = false;
  }

  let lastDetectedCscId = "";
  let lastVerifiedCscId = ""; // last CSC ID already sent to background (stops repeated GitHub checks)
  let cscPollTimer = null;

  function detectPageCscId() {
    if (isLoginPage()) return "";
    // Scan ONLY top header/navbar elements (never form inputs / customer Aadhaar!)
    const els = [...document.querySelectorAll('header *,nav *,.navbar *,.topbar *,[class*="header" i] *,[class*="profile" i] *,span,div,button,a,p,strong,b')]
      .filter(el => visible(el) && !inPanel(el) && !el.matches?.("input,textarea,select"))
      .filter(el => {
        if (el.children.length > 4) return false;
        const r = el.getBoundingClientRect();
        return r.top >= -5 && r.top <= 115 && r.height > 8 && r.height <= 90 && r.left >= 180;
      });

    for (const el of els) {
      const txt = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
      if (!txt || txt.length > 90 || /₹|\bW1\b|\bW2\b|\.\d{2}\b/i.test(txt)) continue;
      // 1. DigiPay Web header: "Sanjay Nag (411632300012)"
      const paren12 = txt.match(/\((\d{12})\)/);
      if (paren12) return paren12[1];
      // 2. DigiPay Lite header: "01411632300012" (01 + 12-digit CSC ID)
      const lite14 = txt.match(/\b01(\d{12})\b/);
      if (lite14) return lite14[1];
      // 3. Standalone 12-digit CSC ID in top-right profile bar
      const plain12 = txt.match(/\b(\d{12})\b/);
      if (plain12) return plain12[1];
    }
    return "";
  }

  async function syncDetectedCscId() {
    const id = detectPageCscId();
    if (!id) return "";
    const changed = id !== lastDetectedCscId;
    lastDetectedCscId = id;
    // Sirf tab check karo jab CSC ID badla ho, pehla login verify baaki ho,
    // ya pichhli baar mismatch hua ho (page load par 1 baar). Har 3.5 sec
    // baar-baar check karne se GitHub config fetch loop ban raha tha.
    const needVerify = changed || licenseState?.reason === "csc_waiting" || licenseState?.reason === "csc_mismatch";
    if (needVerify && id !== lastVerifiedCscId) {
      const res = await send("CSP_LICENSE_SET_CSCID", {cscId: id});
      if (res?.status) {
        lastVerifiedCscId = id;
        licenseState = {...licenseState, ...res.status};
        applyLicenseState();
      }
    }
    return id;
  }

  function formatDaysLeftLabel(expires, daysLeft) {
    if (!expires) return "असीमित (Unlimited)";
    if (typeof daysLeft === "number") {
      if (daysLeft < 0 || (daysLeft === 0 && licenseState?.reason === "expired")) return `${expires} (समाप्त ❌)`;
      if (daysLeft === 0) return `${expires} (आज अंतिम दिन ⚠)`;
      if (daysLeft > 3650) return `${expires} (Lifetime ✓)`;
      return `${expires} (${daysLeft} दिन बाकी)`;
    }
    return expires;
  }

  function renderLicenseCard(cardEl) {
    if (!cardEl) return;
    cardEl.replaceChildren();
    const st = licenseState || {};
    cardEl.classList.toggle("is-active", !!licenseAllowed && !!st.configured);
    cardEl.classList.toggle("is-locked", !licenseAllowed);

    const statusLabels = {
      local: "🖥 Local Mode",
      active: st.offlineGrace ? "✅ Active (Offline Grace)" : "✅ Active (चालू)",
      no_key: "🔑 Access Key नहीं डाली",
      invalid_key: "❌ गलत Access Key",
      key_disabled: "⏸ Admin द्वारा बंद",
      expired: "⏰ लाइसेंस समाप्त (Expired)",
      csc_waiting: "🔑 DigiPay लॉगिन बाकी",
      csc_mismatch: "🔒 दूसरी CSC ID पर लॉक",
      global_disabled: "⏸ मेंटेनेंस (बंद)",
      network_error: "🌐 सर्वर / इंटरनेट एरर"
    };
    const verStr = st.localVersion
      ? (st.updateAvailable && st.latestVersion ? `v${st.localVersion} → 🔔 v${st.latestVersion}` : `v${st.localVersion} (✓ लेटेस्ट)`)
      : `v${chrome.runtime.getManifest().version}`;
    const rows = [
      ["स्टेटस", statusLabels[st.reason] || (licenseAllowed ? "✅ चालू" : "🔒 बंद")],
      ["यूज़र का नाम", st.name || (st.configured ? "रजिस्टर नहीं" : "Local User")],
      ["Access Key", st.key || "नहीं डाली"],
      ["CSC ID लॉक", st.cscLockLabel || (lastDetectedCscId ? `🆔 ${lastDetectedCscId}` : "जाँच रहे हैं…")],
      ["प्लान", st.plan || (st.configured ? "Standard" : "Local")],
      ["वैधता (Expiry)", st.configured ? formatDaysLeftLabel(st.expires, st.daysLeft) : "असीमित"],
      ["वर्ज़न", verStr]
    ];
    if (st.phone) rows.splice(2, 0, ["मोबाइल / ID", st.phone]);
    if (st.checkedAt) {
      const t = new Date(st.checkedAt);
      const pad = n => String(n).padStart(2, "0");
      rows.push(["आखिरी जाँच", `${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`]);
    }
    rows.forEach(([k, v]) => {
      const r = document.createElement("div");
      r.className = "csp-lic-row";
      const s = document.createElement("span"); s.textContent = k;
      const b = document.createElement("strong"); b.textContent = v; b.title = v;
      r.append(s, b);
      cardEl.append(r);
    });
    if (st.message) {
      const m = document.createElement("div");
      m.className = "csp-lic-msg" + (licenseAllowed ? " ok" : "");
      m.textContent = st.message;
      cardEl.append(m);
    }
  }

  function applyLicenseState(panel = document.getElementById("csp-helper-panel")) {
    licenseAllowed = licenseState?.allowed !== false;
    if (!licenseAllowed) {
      detachPageHooks();
      detachRememberHooks();
    } else {
      attachRememberHooks();
      if (extensionEnabled) {
        attachPageHooks();
      } else {
        detachPageHooks();
      }
    }
    if (panel) {
      panel.classList.toggle("csp-locked-mode", !licenseAllowed);
      const lockMsg = panel.querySelector("#csp-lock-msg");
      if (lockMsg) {
        lockMsg.textContent = licenseState?.message || "🔑 कृपया अपनी Access Key डालकर '✓ Verify' दबाएँ।";
        lockMsg.title = lockMsg.textContent;
      }
      const lockInput = panel.querySelector("#csp-lock-key");
      if (lockInput && !lockInput.value && licenseState?.key) {
        lockInput.value = licenseState.key;
      }
      const badgeEl = panel.querySelector("#csp-helper-user-badge");
      if (badgeEl) {
        if (licenseAllowed && licenseState?.configured && licenseState?.key) {
          const expShort = licenseState.expires
            ? (typeof licenseState.daysLeft === "number" && licenseState.daysLeft <= 3650 ? ` · ${licenseState.expires} (${licenseState.daysLeft}d)` : ` · ${licenseState.expires}`)
            : "";
          badgeEl.textContent = `👤 ${licenseState.name || licenseState.key} (${licenseState.key})${expShort}`;
          badgeEl.classList.add("show");
        } else {
          badgeEl.classList.remove("show");
        }
      }
      const noticeEl = panel.querySelector("#csp-helper-notice");
      if (noticeEl) {
        const parts = [];
        let isWarn = false;
        if (licenseState?.updateAvailable && licenseState?.latestVersion) {
          parts.push(`🔔 नया अपडेट v${licenseState.latestVersion} उपलब्ध`);
        }
        if (licenseAllowed && typeof licenseState?.daysLeft === "number" && licenseState.daysLeft >= 0 && licenseState.daysLeft <= 7) {
          parts.push(`⚠ लाइसेंस ${licenseState.daysLeft === 0 ? "आज" : `${licenseState.daysLeft} दिन में`} समाप्त होगा (${licenseState.expires})`);
          isWarn = true;
        }
        if (licenseState?.notice) parts.push(licenseState.notice);
        const msg = parts.join(" · ");
        noticeEl.textContent = msg;
        noticeEl.classList.toggle("warn", isWarn);
        noticeEl.classList.toggle("show", !!msg && licenseAllowed);
      }
    }
    renderLicenseCard(document.getElementById("csp-set-lic-card"));
    const setKeyIn = document.getElementById("csp-set-key-input");
    if (setKeyIn && document.activeElement !== setKeyIn && licenseState?.key) {
      setKeyIn.value = licenseState.key;
    }
  }

  function setExtensionEnabled(nextVal, persist = true) {
    extensionEnabled = !!nextVal;
    if (licenseAllowed && extensionEnabled) {
      attachPageHooks();
      lastActiveTab = getActiveTabSignature();
    } else {
      detachPageHooks();
    }
    if (persist) savePrefs({cspExtensionEnabled: extensionEnabled});
    applyEnabledState();
    logEvent("INFO", extensionEnabled ? "mode:auto" : "mode:manual");
    showStatus(extensionEnabled
      ? "⚡ Auto मोड चालू — याद रखना, भरना और पॉपअप सब अपने आप होंगे।"
      : "✋ Manual मोड चालू — डेटा हमेशा अपने आप याद होगा; भरने/खोलने के लिए बटन (AEPS, Balance, Cash, भरें) दबाएँ।");
  }

  function applyPanelMode(panel) {
    if (!panel) return;
    const isBar = panelMode === "bar";
    if (isBar) {
      if (panel.style.left || panel.style.top) {
        savedBoxPos = {left: panel.style.left, top: panel.style.top, right: panel.style.right};
      }
      panel.style.left = "";
      panel.style.top = "";
      panel.style.right = "";
    } else if (savedBoxPos) {
      if (savedBoxPos.left) panel.style.left = savedBoxPos.left;
      if (savedBoxPos.top) panel.style.top = savedBoxPos.top;
      if (savedBoxPos.right) panel.style.right = savedBoxPos.right;
    }
    panel.classList.toggle("csp-bar-mode", isBar);
    applyPanelAppearance(panel);
    applyEnabledState(panel);
    const titleEl = panel.querySelector("#csp-helper-title");
    if (titleEl) {
      const tag = IS_DIGIPAY_WEB ? "Web" : (IS_DIGIPAY_LITE ? "Lite" : "");
      titleEl.textContent = isBar ? (tag ? `CSP ${tag}` : "CSP") : (tag ? `CSP (${tag})` : "CSP Automation");
    }
    const modeBtn = panel.querySelector("#csp-helper-mode");
    if (modeBtn) {
      modeBtn.textContent = isBar ? "⬆ बॉक्स" : "⬇ पट्टी";
      modeBtn.title = isBar ? "बॉक्स मोड में बदलें" : "नीचे एक लाइन पट्टी मोड में बदलें";
    }
    const autoChk = panel.querySelector("#csp-helper-autoskip");
    if (autoChk) autoChk.checked = autoSkipPopups;
    const autoText = panel.querySelector("#csp-helper-autoskip-label");
    if (autoText) autoText.textContent = isBar ? "Auto" : "Login Popups बंद + Auto AEPS";
    panel.querySelectorAll("button.csp-helper-btn").forEach(b => {
      b.textContent = isBar ? (b.dataset.shortLabel || b.dataset.fullLabel) : (b.dataset.fullLabel || b.textContent);
    });
    const settingsBox = document.getElementById("csp-helper-settings");
    if (settingsBox) settingsBox.classList.toggle("csp-settings-above-bar", isBar);
  }

  function toggleSettingsModal() {
    const existing = document.getElementById("csp-helper-settings");
    if (existing) {
      existing.remove();
      return;
    }
    const panel = document.getElementById("csp-helper-panel");
    const box = document.createElement("aside");
    box.id = "csp-helper-settings";
    box.style.setProperty("--csp-fs", fontSizePx + "px");
    if (panelMode === "bar") box.classList.add("csp-settings-above-bar");

    box.innerHTML = `
      <div class="csp-set-head">
        <strong>⚙ CSP सेटिंग्स</strong>
        <button type="button" id="csp-set-close" title="बंद करें">×</button>
      </div>
      <div class="csp-set-row">
        <label>कार्य मोड (Work Mode)</label>
        <div class="csp-set-seg">
          <button type="button" data-workmode="auto" class="${extensionEnabled ? "active-auto" : ""}">⚡ Auto (अपने आप)</button>
          <button type="button" data-workmode="manual" class="${!extensionEnabled ? "active-manual" : ""}">✋ Manual (सिर्फ क्लिक पर)</button>
        </div>
        <div id="csp-set-workmode-hint" class="csp-set-mode-hint ${!extensionEnabled ? "is-manual" : ""}">
          ${extensionEnabled
            ? "✓ अभी Auto मोड चालू है — याद रखना, भरना और पॉपअप सब अपने आप होगा।"
            : "✋ अभी Manual मोड चालू है — डेटा हमेशा अपने आप याद होगा, पर भरना/टैब/पॉपअप सिर्फ़ बटन क्लिक करने पर होगा।"}
        </div>
      </div>
      <div class="csp-set-row">
        <label>डिस्प्ले मोड</label>
        <div class="csp-set-seg">
          <button type="button" data-mode="panel" class="${panelMode === "panel" ? "active" : ""}">⬆ बॉक्स</button>
          <button type="button" data-mode="bar" class="${panelMode === "bar" ? "active" : ""}">⬇ नीचे पट्टी</button>
        </div>
      </div>
      <div class="csp-set-row">
        <label>टेक्स्ट साइज़: <strong id="csp-set-fs-val">${fontSizePx}px</strong></label>
        <div class="csp-set-range">
          <button type="button" id="csp-set-fs-dec">A-</button>
          <input type="range" id="csp-set-fs" min="12" max="19" step="1" value="${fontSizePx}">
          <button type="button" id="csp-set-fs-inc">A+</button>
        </div>
      </div>
      <div class="csp-set-row">
        <label>Auto-Save समय (टाइप रुकने पर)</label>
        <select id="csp-set-delay">
          <option value="1000" ${autoSaveDelayMs === 1000 ? "selected" : ""}>1 सेकंड</option>
          <option value="2000" ${autoSaveDelayMs === 2000 ? "selected" : ""}>2 सेकंड (डिफ़ॉल्ट)</option>
          <option value="3000" ${autoSaveDelayMs === 3000 ? "selected" : ""}>3 सेकंड</option>
          <option value="4000" ${autoSaveDelayMs === 4000 ? "selected" : ""}>4 सेकंड</option>
          <option value="0" ${autoSaveDelayMs === 0 ? "selected" : ""}>बंद (सिर्फ 'याद रखें' बटन से)</option>
        </select>
      </div>
      <label class="csp-set-check">
        <input type="checkbox" id="csp-set-autoskip" ${autoSkipPopups ? "checked" : ""}>
        <span>Login Popups अपने आप बंद + Auto AEPS</span>
      </label>
      <div class="csp-set-sep"></div>
      <div class="csp-set-row">
        <label>ऑटो लॉग फाइल सेव</label>
        <select id="csp-set-logmode">
          <option value="errors" ${autoLogMode === "errors" ? "selected" : ""}>सिर्फ Error / Problem आने पर (डिफ़ॉल्ट)</option>
          <option value="off" ${autoLogMode === "off" ? "selected" : ""}>बंद (सिर्फ Manual बटन से)</option>
          <option value="always" ${autoLogMode === "always" ? "selected" : ""}>हमेशा (हर एक्टिविटी पर)</option>
        </select>
      </div>
      <div class="csp-set-row">
        <label>डिबग लॉग टूल्स</label>
        <div class="csp-set-logs" id="csp-set-logs"></div>
      </div>
      <div class="csp-set-sep"></div>
      <div class="csp-set-row">
        <label>🪪 यूज़र और लाइसेंस जानकारी (License)</label>
        <div id="csp-set-lic-card" class="csp-lic-card"></div>
        <div class="csp-set-key-row">
          <input type="text" id="csp-set-key-input" placeholder="Access Key डालें (जैसे DOST1)" value="${licenseState?.key || ""}">
          <button type="button" id="csp-set-key-save" class="csp-helper-btn">✓ Verify</button>
        </div>
        <div class="csp-set-key-actions">
          <button type="button" id="csp-set-key-check" class="csp-helper-btn">🔄 स्टेटस चेक</button>
          <button type="button" id="csp-set-key-logout" class="csp-helper-btn danger-btn">🚪 Key हटाएँ</button>
        </div>
      </div>
      <button type="button" id="csp-set-reset" class="csp-set-reset">डिफ़ॉल्ट सेटिंग्स रीसेट करें</button>
    `;

    document.documentElement.appendChild(box);
    box.querySelector("#csp-set-close").addEventListener("click", () => box.remove());
    box.querySelectorAll("[data-workmode]").forEach(b => {
      b.addEventListener("click", () => {
        setExtensionEnabled(b.dataset.workmode === "auto", true);
      });
    });

    // Mode buttons
    box.querySelectorAll("[data-mode]").forEach(b => {
      b.addEventListener("click", () => {
        panelMode = b.dataset.mode;
        savePrefs({cspPanelMode: panelMode});
        box.querySelectorAll("[data-mode]").forEach(x => x.classList.toggle("active", x.dataset.mode === panelMode));
        applyPanelMode(panel);
        logEvent("INFO", "settings:mode", {mode: panelMode});
        showStatus(panelMode === "bar" ? "✓ नीचे पट्टी मोड सेव हो गया।" : "✓ बॉक्स मोड सेव हो गया।");
      });
    });

    // Font size controls
    const fsInput = box.querySelector("#csp-set-fs");
    const fsVal = box.querySelector("#csp-set-fs-val");
    const updateFontSize = val => {
      fontSizePx = Math.max(12, Math.min(19, Number(val) || 14));
      fsInput.value = String(fontSizePx);
      fsVal.textContent = `${fontSizePx}px`;
      savePrefs({cspFontSizePx: fontSizePx});
      applyPanelAppearance(panel);
      logEvent("INFO", "settings:fontSize", {fontSizePx});
    };
    fsInput.addEventListener("input", () => updateFontSize(fsInput.value));
    box.querySelector("#csp-set-fs-dec").addEventListener("click", () => updateFontSize(fontSizePx - 1));
    box.querySelector("#csp-set-fs-inc").addEventListener("click", () => updateFontSize(fontSizePx + 1));

    // Auto-save delay
    box.querySelector("#csp-set-delay").addEventListener("change", e => {
      autoSaveDelayMs = Number(e.target.value);
      savePrefs({cspAutoSaveDelayMs: autoSaveDelayMs});
      logEvent("INFO", "settings:autoSaveDelay", {autoSaveDelayMs});
      showStatus(autoSaveDelayMs === 0 ? "✓ Auto-Save बंद (सिर्फ 'याद रखें' बटन काम करेगा)।" : `✓ Auto-Save समय ${autoSaveDelayMs / 1000} सेकंड सेव हुआ।`);
    });

    // Auto skip toggle
    box.querySelector("#csp-set-autoskip").addEventListener("change", e => {
      autoSkipPopups = !!e.target.checked;
      savePrefs({cspAutoSkipPopups: autoSkipPopups});
      const mainChk = document.getElementById("csp-helper-autoskip");
      if (mainChk) mainChk.checked = autoSkipPopups;
      logEvent("INFO", "settings:autoSkip", {enabled: autoSkipPopups});
      if (autoSkipPopups) schedulePopupAndDeviceCheck();
      showStatus(autoSkipPopups ? "✓ Login Popups + Auto AEPS चालू किया गया।" : "Login Popups + Auto AEPS बंद किया गया।");
    });

    // Auto log file mode
    box.querySelector("#csp-set-logmode").addEventListener("change", e => {
      autoLogMode = e.target.value;
      savePrefs({cspAutoLogMode: autoLogMode});
      const labels = {
        errors: "सिर्फ Error/Problem आने पर",
        off: "बंद (Manual)",
        always: "हमेशा (हर एक्टिविटी पर)"
      };
      showStatus(`✓ ऑटो लॉग सेव: ${labels[autoLogMode] || autoLogMode} (स्थायी सेव)`);
    });

    // Log buttons inside settings
    box.querySelector("#csp-set-logs").append(
      btn("📋 लॉग कॉपी", copyLogs, "subtle", "📋 कॉपी", "लॉग कॉपी करें"),
      btn("⬇ लॉग सेव", downloadLogs, "subtle", "⬇ सेव", "Downloads में सेव करें"),
      btn("🗑 साफ", clearLogs, "subtle", "🗑 साफ", "पुराने लॉग साफ करें")
    );

    // Access Key & Remote Status controls
    const keyInput = box.querySelector("#csp-set-key-input");
    const saveKeyBtn = box.querySelector("#csp-set-key-save");
    const checkKeyBtn = box.querySelector("#csp-set-key-check");
    const logoutKeyBtn = box.querySelector("#csp-set-key-logout");
    const runKeyAction = async (mode) => {
      const cardEl = box.querySelector("#csp-set-lic-card");
      if (mode === "save" && !(keyInput?.value || "").trim()) {
        licenseState = {...licenseState, message: "🔑 कृपया पहले अपनी Access Key लिखें।"};
        renderLicenseCard(cardEl);
        return;
      }
      if (saveKeyBtn) saveKeyBtn.disabled = true;
      if (checkKeyBtn) checkKeyBtn.disabled = true;
      if (logoutKeyBtn) logoutKeyBtn.disabled = true;
      try {
        const curCsc = detectPageCscId() || lastDetectedCscId;
        let res;
        if (mode === "save") res = await send("CSP_LICENSE_SET_KEY", {key: keyInput?.value || "", cscId: curCsc});
        else if (mode === "logout") res = await send("CSP_LICENSE_CLEAR_KEY");
        else res = await send("CSP_LICENSE_CHECK_NOW", {cscId: curCsc});
        if (res?.ok && res?.status) {
          licenseState = {...licenseState, ...res.status};
          applyLicenseState(panel);
          if (licenseAllowed) {
            refreshMemory();
            showStatus(licenseState.message || `✅ रजिस्ट्रेशन सफल! (${licenseState.name || licenseState.key})`);
          }
        } else {
          licenseState = {...licenseState, message: "⚠ Extension से संपर्क नहीं हो पाया — कृपया पेज रिफ्रेश या chrome://extensions में Reload (↻) करें।"};
          renderLicenseCard(cardEl);
        }
      } finally {
        if (saveKeyBtn) saveKeyBtn.disabled = false;
        if (checkKeyBtn) checkKeyBtn.disabled = false;
        if (logoutKeyBtn) logoutKeyBtn.disabled = false;
      }
    };
    saveKeyBtn?.addEventListener("click", () => runKeyAction("save"));
    keyInput?.addEventListener("keydown", e => { if (e.key === "Enter") runKeyAction("save"); });
    checkKeyBtn?.addEventListener("click", () => runKeyAction("check"));
    logoutKeyBtn?.addEventListener("click", () => {
      if (keyInput) keyInput.value = "";
      runKeyAction("logout");
    });
    applyLicenseState(panel);

    // Reset button
    box.querySelector("#csp-set-reset").addEventListener("click", () => {
      fontSizePx = 14;
      autoSaveDelayMs = 2000;
      autoSkipPopups = true;
      autoLogMode = "errors";
      savePrefs({cspFontSizePx: fontSizePx, cspAutoSaveDelayMs: autoSaveDelayMs, cspAutoSkipPopups: autoSkipPopups, cspAutoLogMode: autoLogMode});
      applyPanelMode(panel);
      box.remove();
      showStatus("✓ सेटिंग्स डिफ़ॉल्ट पर रीसेट हो गईं (14px, 2s, Error-only log)।");
    });
  }

  function makeDraggable(panel, handle) {
    let dragging = false, sx = 0, sy = 0, left = 0, top = 0;
    handle.addEventListener("pointerdown", e => {
      if (panel.classList.contains("csp-bar-mode")) return;
      if (e.target.closest("button")) return;
      const r = panel.getBoundingClientRect(); dragging = true; sx = e.clientX; sy = e.clientY; left = r.left; top = r.top;
      panel.style.right = "auto"; handle.setPointerCapture(e.pointerId); e.preventDefault();
    });
    handle.addEventListener("pointermove", e => {
      if (!dragging) return;
      panel.style.left = Math.max(0, Math.min(innerWidth - panel.offsetWidth, left + e.clientX - sx)) + "px";
      panel.style.top = Math.max(0, Math.min(innerHeight - 60, top + e.clientY - sy)) + "px";
    });
    const stop = () => {
      if (dragging && !panel.classList.contains("csp-bar-mode")) {
        savedBoxPos = {left: panel.style.left, top: panel.style.top, right: panel.style.right};
      }
      dragging = false;
    };
    handle.addEventListener("pointerup", stop); handle.addEventListener("pointercancel", stop);
  }

  function buildPanel() {
    if (document.getElementById("csp-helper-panel")) return;
    const panel = document.createElement("section"); panel.id = "csp-helper-panel";
    panel.innerHTML = `
      <div class="csp-helper-head" id="csp-helper-drag">
        <strong id="csp-helper-title">CSP Automation</strong>
        <div class="csp-helper-head-actions">
          <button id="csp-helper-power" type="button" class="csp-helper-power-btn" title="Auto / Manual मोड बदलें">⚡ Auto</button>
          <button id="csp-helper-mode" type="button" class="csp-helper-mode-btn" title="डिस्प्ले मोड बदलें">⬇ पट्टी</button>
          <button id="csp-helper-settings-btn" type="button" class="csp-helper-mode-btn" title="सेटिंग्स (मोड, टेक्स्ट साइज़, लॉग)">⚙</button>
          <button id="csp-helper-close" type="button" title="बंद करें">×</button>
        </div>
      </div>
      <div id="csp-helper-user-badge"></div>
      <div id="csp-helper-notice"></div>
      <div id="csp-helper-lockbox">
        <div id="csp-lock-msg" class="csp-lock-msg">🔑 कृपया अपनी Access Key डालकर '✓ Verify' दबाएँ।</div>
        <div class="csp-lock-form">
          <input type="text" id="csp-lock-key" placeholder="Access Key डालें">
          <button type="button" id="csp-lock-verify">✓ Verify</button>
        </div>
      </div>
      <div class="csp-helper-grid" id="csp-helper-tabs"></div>
      <label class="csp-helper-toggle" title="Login Popups अपने आप बंद करें और Unified AEPS खोलें"><input type="checkbox" id="csp-helper-autoskip" ${autoSkipPopups ? "checked" : ""}> <span id="csp-helper-autoskip-label">Login Popups बंद + Auto AEPS</span></label>
      <div class="csp-helper-sep"></div>
      <div class="csp-helper-subtitle">याद की गई जानकारी</div>
      <div id="csp-helper-memory-state" class="csp-helper-memory-state">मेमोरी जाँच रहे हैं…</div>
      <div id="csp-helper-memory-details" class="csp-helper-memory-details"></div>
      <div class="csp-helper-grid" id="csp-helper-customer"></div>
      <div class="csp-helper-logs" id="csp-helper-logs"></div>
      <p id="csp-helper-status" role="status">Mobile/Aadhaar टाइप करें। डेटा अपने आप सेव होगा। Other चुनकर सूची से बैंक चुनें।</p>
      <small>सेव होने पर ✓ पुष्टि दिखेगी। डेटा Chrome session memory में रहता है। ग्राहक की अनुमति लें और काम पूरा होने पर Clear करें।</small>`;
    document.documentElement.appendChild(panel);
    panel.querySelector("#csp-helper-close").addEventListener("click", () => { document.getElementById("csp-helper-settings")?.remove(); panel.remove(); });
    panel.querySelector("#csp-helper-power").addEventListener("click", () => setExtensionEnabled(!extensionEnabled, true));
    panel.querySelector("#csp-helper-settings-btn").addEventListener("click", toggleSettingsModal);
    panel.querySelector("#csp-helper-mode").addEventListener("click", () => {
      panelMode = panelMode === "bar" ? "panel" : "bar";
      savePrefs({cspPanelMode: panelMode});
      applyPanelMode(panel);
      logEvent("INFO", "ui:modeSwitch", {mode: panelMode});
      showStatus(panelMode === "bar" ? "✓ नीचे पट्टी मोड सेव हो गया।" : "✓ बॉक्स मोड सेव हो गया।");
    });
    makeDraggable(panel, panel.querySelector("#csp-helper-drag"));
    panel.querySelector("#csp-helper-autoskip").addEventListener("change", e => {
      autoSkipPopups = !!e.target.checked;
      savePrefs({cspAutoSkipPopups: autoSkipPopups});
      logEvent("INFO", "pref:autoSkip", {enabled: autoSkipPopups});
      if (autoSkipPopups) schedulePopupAndDeviceCheck();
      showStatus(autoSkipPopups ? "✓ Login Popups अपने आप बंद होंगे।" : "Login Popups auto-close बंद कर दिया गया।");
    });
    panel.querySelector("#csp-helper-tabs").append(
      btn("Popups बंद → Unified AEPS खोलें", () => goToUnifiedAeps(false), "success", "AEPS", "Popups बंद करके Unified AEPS खोलें"),
      btn("Balance Enquiry · Alt+1", () => showStatus(clickTab("Balance Enquiry", true) ? "Balance Enquiry चुना गया।" : "Balance Enquiry टैब नहीं मिला।"), "", "Balance", "Balance Enquiry (Alt+1)"),
      btn("Cash Withdrawal · Alt+2", () => showStatus(clickTab("Cash Withdrawal", true) ? "Cash Withdrawal चुना गया।" : "Cash Withdrawal टैब नहीं मिला।"), "", "Cash", "Cash Withdrawal (Alt+2)")
    );
    panel.querySelector("#csp-helper-customer").append(
      btn("याद रखें", rememberManually, "", "याद रखें", "वर्तमान फॉर्म का डेटा याद रखें"),
      btn("दूसरे फॉर्म में भरें", fillManually, "", "भरें", "याद किया गया डेटा इस फॉर्म में भरें"),
      btn("ग्राहक डेटा साफ करें", async () => { clearTimeout(saveTimer); liveAadhaarDigits = ""; await send("CSP_SESSION_CLEAR"); selectedBank = ""; bankCategory = ""; lastSavedSignature = ""; renderMemory({}, false); logEvent("INFO", "session:cleared"); showStatus("ग्राहक डेटा साफ कर दिया गया।"); }, "danger", "साफ", "याद किया गया ग्राहक डेटा साफ करें")
    );
    panel.querySelector("#csp-helper-logs").append(
      btn("📋 लॉग कॉपी", copyLogs, "subtle", "📋", "लॉग कॉपी करें"),
      btn("⬇ लॉग सेव", downloadLogs, "subtle", "⬇", "लॉग फाइल Downloads में सेव करें"),
      btn("लॉग साफ", clearLogs, "subtle", "🗑", "पुराने लॉग साफ करें")
    );
    const lockInput = panel.querySelector("#csp-lock-key");
    const lockBtn = panel.querySelector("#csp-lock-verify");
    const verifyLockKey = async () => {
      const msgEl = panel.querySelector("#csp-lock-msg");
      const rawKey = (lockInput?.value || "").trim().toUpperCase();
      if (!rawKey) {
        if (msgEl) msgEl.textContent = "🔑 कृपया पहले अपनी Access Key लिखें (जैसे DOST1)।";
        lockInput?.focus();
        return;
      }
      if (lockBtn) {
        lockBtn.disabled = true;
        lockBtn.textContent = "⏳ जाँच…";
      }
      if (msgEl) msgEl.textContent = `⏳ Access Key ('${rawKey}') वेरिफाई कर रहे हैं…`;
      try {
        const curCsc = detectPageCscId() || lastDetectedCscId;
        const res = await send("CSP_LICENSE_SET_KEY", {key: rawKey, cscId: curCsc});
        if (res?.ok && res?.status) {
          licenseState = {...licenseState, ...res.status};
          applyLicenseState(panel);
          if (licenseAllowed) {
            refreshMemory();
            showStatus(licenseState.message || `✅ रजिस्ट्रेशन सफल! नाम: ${licenseState.name || licenseState.key} · वैधता: ${licenseState.expires || "Unlimited"}`);
          }
        } else if (msgEl) {
          msgEl.textContent = "⚠ Extension से संपर्क नहीं हो पाया — कृपया पेज रिफ्रेश या chrome://extensions में 1 बार Reload (↻) करें।";
        }
      } finally {
        if (lockBtn) {
          lockBtn.disabled = false;
          lockBtn.textContent = "✓ Verify";
        }
      }
    };
    lockBtn?.addEventListener("click", verifyLockKey);
    lockInput?.addEventListener("keydown", e => { if (e.key === "Enter") verifyLockKey(); });
    applyPanelMode(panel);
    applyLicenseState(panel);
    refreshMemory();
  }

  function togglePanel() {
    const p = document.getElementById("csp-helper-panel");
    if (p) { document.getElementById("csp-helper-settings")?.remove(); p.remove(); } else buildPanel();
  }

  function getActiveTabSignature() {
    if (!isAepsFormPage() || isTransactionResultVisible()) return "";
    const activeTexts = [...document.querySelectorAll('[role="tab"][aria-selected="true"],.mat-tab-label-active,.mdc-tab--active,.nav-link.active,.nav-link[aria-current="page"],[data-bs-toggle="tab"].active')]
      .filter(el => visible(el) && !inPanel(el))
      .map(el => norm(el.innerText || el.textContent));
    const serviceMatch = activeTexts.find(t => /balance enquiry|cash withdrawal|mini statement|cash deposit/i.test(t));
    if (serviceMatch) {
      const m = serviceMatch.match(/balance enquiry|cash withdrawal|mini statement|cash deposit/i);
      if (m) return norm(m[0]);
    }
    const route = norm(location.pathname + " " + location.hash);
    if (/balance[-_\s]?enquiry/i.test(route)) return "balance enquiry";
    if (/cash[-_\s]?withdrawal/i.test(route)) return "cash withdrawal";
    if (/mini[-_\s]?statement/i.test(route)) return "mini statement";
    if (/cash[-_\s]?deposit/i.test(route)) return "cash deposit";
    return "";
  }

  lastActiveTab = getActiveTabSignature();

  const observer = new MutationObserver(mutations => {
    if (!licenseAllowed || !extensionEnabled) return;
    if (mutations.every(m => inPanel(m.target))) return;
    if (isTransactionResultVisible()) {
      pauseAutoUntilTabSwitch = true;
      lastTxAt = Date.now();
      return;
    }
    schedulePopupAndDeviceCheck();
    const active = getActiveTabSignature();
    if (active && active !== lastActiveTab) {
      lastActiveTab = active;
      pauseAutoUntilTabSwitch = false;
      lastFilledTab = "";
      clearTimeout(tabFillTimer);
      tabFillTimer = setTimeout(() => {
        if (!licenseAllowed || !extensionEnabled) return;
        const focused = document.activeElement;
        if (focused && !inPanel(focused) && focused.matches?.("input,textarea")) return;
        autoFillCurrentForm(false);
      }, 650);
    }
  });

  const onStorageChanged = (changes, area) => {
    if (area !== "local") return;
    const panel = document.getElementById("csp-helper-panel");
    if (changes.cspLicenseStatus && changes.cspLicenseStatus.newValue && typeof changes.cspLicenseStatus.newValue === "object") {
      licenseState = {...licenseState, ...changes.cspLicenseStatus.newValue};
      applyLicenseState(panel);
    }
    if (changes.cspExtensionEnabled && typeof changes.cspExtensionEnabled.newValue === "boolean") {
      if (changes.cspExtensionEnabled.newValue !== extensionEnabled) {
        setExtensionEnabled(changes.cspExtensionEnabled.newValue, false);
      }
    }
    if (changes.cspPanelMode && (changes.cspPanelMode.newValue === "bar" || changes.cspPanelMode.newValue === "panel")) {
      panelMode = changes.cspPanelMode.newValue;
      applyPanelMode(panel);
    }
    if (changes.cspFontSizePx && typeof changes.cspFontSizePx.newValue === "number") {
      fontSizePx = changes.cspFontSizePx.newValue;
      applyPanelAppearance(panel);
    }
    if (changes.cspAutoSaveDelayMs && typeof changes.cspAutoSaveDelayMs.newValue === "number") {
      autoSaveDelayMs = changes.cspAutoSaveDelayMs.newValue;
    }
    if (changes.cspAutoSkipPopups && typeof changes.cspAutoSkipPopups.newValue === "boolean") {
      autoSkipPopups = changes.cspAutoSkipPopups.newValue;
      const chk = document.getElementById("csp-helper-autoskip");
      if (chk) chk.checked = autoSkipPopups;
    }
    if (changes.cspAutoLogMode && typeof changes.cspAutoLogMode.newValue === "string") {
      autoLogMode = changes.cspAutoLogMode.newValue;
    }
  };
  try { chrome.storage.onChanged.addListener(onStorageChanged); } catch (_) {}

  const onRuntimeMessage = msg => {
    if (msg?.type !== "CSP_COMMAND") return;
    if (msg.command === "toggle-panel") togglePanel();
    if (!licenseAllowed) return;
    if (msg.command === "balance-enquiry") {
      if (!document.getElementById("csp-helper-panel")) buildPanel();
      clickTab("Balance Enquiry", true);
    }
    if (msg.command === "cash-withdrawal") {
      if (!document.getElementById("csp-helper-panel")) buildPanel();
      clickTab("Cash Withdrawal", true);
    }
  };
  chrome.runtime.onMessage.addListener(onRuntimeMessage);

  window.__cspHelperCleanup = () => {
    flushLogs();
    clearInterval(cscPollTimer);
    cscPollTimer = null;
    detachPageHooks();
    detachRememberHooks();
    window.removeEventListener("error", onWinError);
    window.removeEventListener("unhandledrejection", onUnhandledRejection);
    try { chrome.storage.onChanged.removeListener(onStorageChanged); } catch (_) {}
    try { chrome.runtime.onMessage.removeListener(onRuntimeMessage); } catch (_) {}
    document.getElementById("csp-helper-settings")?.remove();
    document.getElementById("csp-helper-panel")?.remove();
  };

  loadPrefs().then(async () => {
    const initialCsc = detectPageCscId();
    if (initialCsc) lastDetectedCscId = initialCsc;
    const licRes = await send("CSP_LICENSE_GET", {cscId: initialCsc});
    if (licRes?.status) {
      licenseState = {...licenseState, ...licRes.status};
      licenseAllowed = licenseState.allowed !== false;
    }
    logEvent("INFO", "init", {
      path: location.pathname,
      hotReload: wasHotReloaded,
      workMode: extensionEnabled ? "auto" : "manual",
      license: licenseState?.reason || "local",
      autoSkipPopups,
      preferredDevice: preferredDevice || "none",
      panelMode
    });
    if (prevPos) savedBoxPos = prevPos;
    buildPanel();
    if (prevPos && panelMode === "panel") {
      const p = document.getElementById("csp-helper-panel");
      if (p) {
        if (prevPos.left) p.style.left = prevPos.left;
        if (prevPos.top) p.style.top = prevPos.top;
        if (prevPos.right) p.style.right = prevPos.right;
      }
    }
    applyLicenseState();
    syncDetectedCscId();
    clearInterval(cscPollTimer);
    cscPollTimer = setInterval(() => { syncDetectedCscId(); }, 3500);
    refreshMemory();
    if (licenseAllowed) {
      if (extensionEnabled) {
        lastActiveTab = getActiveTabSignature();
        schedulePopupAndDeviceCheck();
        if (wasHotReloaded) showStatus("✓ Extension अपडेट हो गया (⚡ Auto मोड)।");
      } else {
        showStatus("✋ Manual मोड चालू — डेटा हमेशा अपने आप याद होगा; भरने के लिए बटन दबाएँ।");
      }
    }
  });
})();
