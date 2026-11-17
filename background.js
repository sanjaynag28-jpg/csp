const ALLOWED_PREFIXES = ["https://digipayweb.csccloud.in/", "https://digipaylite.in/"];
const MATCH_URLS = ["https://digipayweb.csccloud.in/*", "https://digipaylite.in/*"];
const WATCH_FILES = ["manifest.json", "background.js", "content.js", "styles.css"];
const UPDATE_ALARM = "csp-auto-update-check";
const REMOTE_CHECK_ALARM = "csp-remote-control-check";
const LOG_FILENAME = "CSP-Automation-v0.2.2/csp-auto-log.txt";
const MAX_LOGS = 400;

// ============================================================
// GitHub Remote Control & Update Settings (100% Free, Read-Only)
// Apna GitHub username/repo neeche 1 jagah set karein:
// Example: "sanjaynag/csp-automation"
// ============================================================
const GITHUB_REPO = "sanjaynag28-jpg/csp";
const GITHUB_BRANCH = "main";
const OFFLINE_GRACE_MS = 2 * 60 * 60 * 1000;

let lastCheckAt = 0;
let lastRemoteCheckAt = 0;
let reinjectPromise = null;
let bgLogChain = Promise.resolve();
let logExportTimer = null;
let lastLogExportAt = 0;
let dirtyLogs = false;
const autoLogDownloadIds = new Set();

function isRemoteControlConfigured() {
  return !!(GITHUB_REPO && !GITHUB_REPO.includes("YOUR_GITHUB_USERNAME") && GITHUB_REPO.includes("/"));
}

function compareVersions(a, b) {
  const pa = String(a || "0").split(".").map(n => parseInt(n, 10) || 0);
  const pb = String(b || "0").split(".").map(n => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

function getTodayIsoDate() {
  const d = new Date();
  const pad = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function calcDaysLeft(expiresIso) {
  if (!expiresIso || !/^\d{4}-\d{2}-\d{2}$/.test(expiresIso)) return null;
  const [y, m, d] = expiresIso.split("-").map(Number);
  const exp = new Date(y, m - 1, d, 23, 59, 59, 999);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.floor((exp.getTime() - today.getTime()) / 86400000);
}

async function hashAccessKey(rawKey) {
  const normalized = "CSP-HELPER-V1:" + String(rawKey || "").trim().toUpperCase();
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function normalizeCscId(rawId) {
  const d = String(rawId || "").replace(/\D/g, "");
  if (d.length === 14 && d.startsWith("01")) return d.slice(2);
  if (d.length === 12) return d;
  return "";
}

async function hashCscId(rawId) {
  const id12 = normalizeCscId(rawId);
  if (id12.length !== 12) return "";
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("CSP-CSCID-V1:" + id12));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function maskCscId(id12) {
  const d = normalizeCscId(id12);
  return d.length === 12 ? `${d.slice(0, 4)}****${d.slice(-4)}` : "";
}

async function checkRemoteControl(force = false, incomingCscId = "") {
  const localVer = chrome.runtime.getManifest().version;
  if (!isRemoteControlConfigured()) {
    const status = {
      allowed: true,
      configured: false,
      reason: "local",
      message: "",
      key: "",
      name: "Local Mode",
      expires: "",
      daysLeft: null,
      plan: "Local",
      phone: "",
      notice: "",
      localVersion: localVer,
      latestVersion: localVer,
      updateAvailable: false,
      checkedAt: Date.now()
    };
    await chrome.storage.local.set({cspLicenseStatus: status});
    return status;
  }

  const now = Date.now();
  if (!force && now - lastRemoteCheckAt < 60000) {
    const {cspLicenseStatus} = await chrome.storage.local.get("cspLicenseStatus");
    if (cspLicenseStatus) return cspLicenseStatus;
  }
  lastRemoteCheckAt = now;

  const {cspAccessKey, cspLicenseStatus: prev, cspKeyRegisteredAt, cspDetectedCscId, cspLocalLockedCscMap} = await chrome.storage.local.get([
    "cspAccessKey", "cspLicenseStatus", "cspKeyRegisteredAt", "cspDetectedCscId", "cspLocalLockedCscMap"
  ]);
  const userKey = String(cspAccessKey || "").trim().toUpperCase();
  const currentCscId = normalizeCscId(incomingCscId || cspDetectedCscId);
  const url = `https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}/config.json?t=${now}`;

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    let res;
    try {
      res = await fetch(url, {cache: "no-store", signal: ctrl.signal});
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const cfg = await res.json();
    const latestVersion = String(cfg?.version || localVer);
    const updateAvailable = compareVersions(latestVersion, localVer) > 0;
    const notice = String(cfg?.notice || "").trim();

    if (cfg?.globalEnabled === false) {
      const status = {
        allowed: false,
        configured: true,
        reason: "global_disabled",
        message: String(cfg?.globalMessage || "⏸ यह Extension अभी मेंटेनेंस के लिए बंद है। कृपया Admin से संपर्क करें।"),
        key: userKey,
        name: prev?.name || "",
        expires: prev?.expires || "",
        daysLeft: calcDaysLeft(prev?.expires || ""),
        plan: prev?.plan || "",
        phone: prev?.phone || "",
        notice,
        localVersion: localVer,
        latestVersion,
        updateAvailable,
        checkedAt: now
      };
      await chrome.storage.local.set({cspLicenseStatus: status});
      return status;
    }

    if (!userKey) {
      const status = {
        allowed: false,
        configured: true,
        reason: "no_key",
        message: "🔑 कृपया अपनी Access Key डालकर '✓ Verify' दबाएँ।",
        key: "",
        name: "",
        expires: "",
        daysLeft: null,
        plan: "",
        phone: "",
        notice,
        localVersion: localVer,
        latestVersion,
        updateAvailable,
        checkedAt: now
      };
      await chrome.storage.local.set({cspLicenseStatus: status});
      return status;
    }

    const hashMap = (cfg && typeof cfg.keyHashes === "object" && cfg.keyHashes) ? cfg.keyHashes : {};
    const keyHash = await hashAccessKey(userKey);
    let entry = hashMap[keyHash] || null;
    if (!entry) {
      const keysMap = (cfg && typeof cfg.keys === "object" && cfg.keys) ? cfg.keys : {};
      const matchedKey = Object.keys(keysMap).find(k => k.trim().toUpperCase() === userKey);
      entry = matchedKey ? keysMap[matchedKey] : null;
    }

    if (!entry) {
      const status = {
        allowed: false,
        configured: true,
        reason: "invalid_key",
        message: `❌ गलत Access Key ('${userKey}')! यह Key रजिस्टर नहीं है। सही Key डालें या Admin से संपर्क करें।`,
        key: userKey,
        name: "",
        expires: "",
        daysLeft: null,
        plan: "",
        phone: "",
        notice,
        localVersion: localVer,
        latestVersion,
        updateAvailable,
        checkedAt: now
      };
      await chrome.storage.local.set({cspLicenseStatus: status});
      return status;
    }

    const expires = String(entry.expires || "").trim();
    const daysLeft = calcDaysLeft(expires);
    const entryName = String(entry.name || userKey);
    const entryPlan = String(entry.plan || "Standard");
    const entryPhone = String(entry.phone || "");

    if (entry.active === false) {
      const status = {
        allowed: false,
        configured: true,
        reason: "key_disabled",
        message: String(entry.message || `⏸ आपकी Access Key ('${userKey}') Admin द्वारा बंद कर दी गई है। चालू कराने के लिए Admin से संपर्क करें।`),
        key: userKey,
        name: entryName,
        expires,
        daysLeft,
        plan: entryPlan,
        phone: entryPhone,
        notice,
        localVersion: localVer,
        latestVersion,
        updateAvailable,
        checkedAt: now
      };
      await chrome.storage.local.set({cspLicenseStatus: status});
      return status;
    }

    if (expires && /^\d{4}-\d{2}-\d{2}$/.test(expires) && getTodayIsoDate() > expires) {
      const status = {
        allowed: false,
        configured: true,
        reason: "expired",
        message: `⏰ आपकी Access Key ('${userKey}') की वैधता ${expires} को समाप्त हो गई है। रिन्यू कराने के लिए Admin से संपर्क करें।`,
        key: userKey,
        name: entryName,
        expires,
        daysLeft: 0,
        plan: entryPlan,
        phone: entryPhone,
        notice,
        localVersion: localVer,
        latestVersion,
        updateAvailable,
        checkedAt: now
      };
      await chrome.storage.local.set({cspLicenseStatus: status});
      return status;
    }

    // CSC ID Lock check (Global GitHub cscIdHash OR local auto-lock on same PC)
    const expectedCscHash = String(entry.cscIdHash || "").trim().toLowerCase();
    const autoLockLocal = entry.autoLockLocalCsc === true;
    const localLockMap = (cspLocalLockedCscMap && typeof cspLocalLockedCscMap === "object") ? {...cspLocalLockedCscMap} : {};
    let cscLockLabel = "🔓 Admin / सभी CSC ID";

    if (expectedCscHash) {
      if (!currentCscId) {
        const status = {
          allowed: false,
          configured: true,
          reason: "csc_waiting",
          message: "🔑 कृपया पहले DigiPay में लॉगिन करें — आपकी CSC ID अपने आप वेरिफाई होगी।",
          key: userKey,
          name: entryName,
          expires,
          daysLeft,
          plan: entryPlan,
          phone: entryPhone,
          cscLockLabel: "🔒 CSC ID वेरिफाई बाकी",
          notice,
          localVersion: localVer,
          latestVersion,
          updateAvailable,
          checkedAt: now
        };
        await chrome.storage.local.set({cspLicenseStatus: status});
        return status;
      }
      const curHash = await hashCscId(currentCscId);
      if (curHash !== expectedCscHash) {
        const status = {
          allowed: false,
          configured: true,
          reason: "csc_mismatch",
          message: `🔒 यह Access Key किसी दूसरी CSC ID के लिए लॉक है! आप इसे अपनी CSC ID (${maskCscId(currentCscId)}) पर नहीं चला सकते।`,
          key: userKey,
          name: entryName,
          expires,
          daysLeft,
          plan: entryPlan,
          phone: entryPhone,
          cscLockLabel: "❌ CSC ID मैच नहीं",
          notice,
          localVersion: localVer,
          latestVersion,
          updateAvailable,
          checkedAt: now
        };
        await chrome.storage.local.set({cspLicenseStatus: status});
        return status;
      }
      cscLockLabel = `🔒 ${maskCscId(currentCscId)} (Verified)`;
    } else if (autoLockLocal) {
      if (currentCscId) {
        const curHash = await hashCscId(currentCscId);
        const savedLocalHash = localLockMap[keyHash];
        if (!savedLocalHash) {
          localLockMap[keyHash] = curHash;
          await chrome.storage.local.set({cspLocalLockedCscMap: localLockMap});
        } else if (savedLocalHash !== curHash) {
          const status = {
            allowed: false,
            configured: true,
            reason: "csc_mismatch",
            message: `🔒 यह Access Key इस PC पर पहले से किसी दूसरी CSC ID पर लॉक है! (आपकी CSC ID: ${maskCscId(currentCscId)})`,
            key: userKey,
            name: entryName,
            expires,
            daysLeft,
            plan: entryPlan,
            phone: entryPhone,
            cscLockLabel: "❌ CSC ID मैच नहीं",
            notice,
            localVersion: localVer,
            latestVersion,
            updateAvailable,
            checkedAt: now
          };
          await chrome.storage.local.set({cspLicenseStatus: status});
          return status;
        }
        cscLockLabel = `🔒 ${maskCscId(currentCscId)} (Auto-Locked)`;
      } else {
        cscLockLabel = "⏳ लॉगिन पर ऑटो-लॉक होगा";
      }
    }

    const regAt = (prev?.key === userKey && cspKeyRegisteredAt) ? cspKeyRegisteredAt : now;
    const status = {
      allowed: true,
      configured: true,
      reason: "active",
      message: `✅ रजिस्ट्रेशन सफल! नाम: ${entryName} · Key: ${userKey}${expires ? ` · वैधता: ${expires}` : ""}`,
      key: userKey,
      name: entryName,
      expires,
      daysLeft,
      plan: entryPlan,
      phone: entryPhone,
      cscLockLabel,
      detectedCscId: currentCscId ? maskCscId(currentCscId) : "",
      notice,
      localVersion: localVer,
      latestVersion,
      updateAvailable,
      registeredAt: regAt,
      checkedAt: now,
      lastVerifiedAt: now
    };
    await chrome.storage.local.set({cspLicenseStatus: status, cspKeyRegisteredAt: regAt});
    return status;
  } catch (err) {
    // Temporary offline grace ONLY if previously verified active within OFFLINE_GRACE_MS
    if (prev && prev.allowed && prev.key === userKey && prev.lastVerifiedAt && (now - prev.lastVerifiedAt < OFFLINE_GRACE_MS)) {
      const graceStatus = {...prev, offlineGrace: true, localVersion: localVer, checkedAt: now};
      await chrome.storage.local.set({cspLicenseStatus: graceStatus});
      return graceStatus;
    }
    const failStatus = {
      allowed: false,
      configured: true,
      reason: "network_error",
      message: "🌐 सर्वर से संपर्क नहीं हो पाया (इंटरनेट जाँचें) — कृपया दोबारा '✓ Verify' दबाएँ।",
      key: userKey,
      name: prev?.name || "",
      expires: prev?.expires || "",
      daysLeft: calcDaysLeft(prev?.expires || ""),
      plan: prev?.plan || "",
      phone: prev?.phone || "",
      notice: "",
      localVersion: localVer,
      latestVersion: localVer,
      updateAvailable: false,
      checkedAt: now
    };
    await chrome.storage.local.set({cspLicenseStatus: failStatus});
    return failStatus;
  }
}

function formatLogHeader(count) {
  const ver = chrome.runtime.getManifest().version;
  return [
    `=== CSP Automation Helper Auto-Log (v${ver}) ===`,
    `Last Saved: ${new Date().toLocaleString()}`,
    `Total Entries: ${count}`,
    `================================================`
  ];
}

async function getAutoLogMode() {
  try {
    const {cspAutoLogMode} = await chrome.storage.local.get("cspAutoLogMode");
    if (cspAutoLogMode === "off" || cspAutoLogMode === "errors" || cspAutoLogMode === "always") {
      return cspAutoLogMode;
    }
  } catch (_) {}
  return "errors"; // Smart default: ONLY auto-save file when ERROR/WARN happens
}

async function exportLogsToDisk(force = false) {
  clearTimeout(logExportTimer);
  logExportTimer = null;
  if (!chrome.downloads?.download) return false;
  if (!force) {
    const mode = await getAutoLogMode();
    if (mode === "off" || !dirtyLogs) {
      dirtyLogs = false;
      return false;
    }
  }
  const now = Date.now();
  if (!force && now - lastLogExportAt < 15000) {
    scheduleLogExport(false);
    return false;
  }
  try {
    const {cspDebugLogs} = await chrome.storage.local.get("cspDebugLogs");
    const list = Array.isArray(cspDebugLogs) ? cspDebugLogs : [];
    if (!list.length && !force) return false;
    const text = [...formatLogHeader(list.length), ...list].join("\n") + "\n";
    const url = "data:text/plain;charset=utf-8," + encodeURIComponent(text);
    dirtyLogs = false;
    lastLogExportAt = Date.now();
    let dlId = null;
    try {
      dlId = await chrome.downloads.download({
        url,
        filename: LOG_FILENAME,
        conflictAction: "overwrite",
        saveAs: false
      });
    } catch (_) {
      dlId = await chrome.downloads.download({
        url,
        filename: "csp-auto-log.txt",
        conflictAction: "overwrite",
        saveAs: false
      });
    }
    if (typeof dlId === "number") autoLogDownloadIds.add(dlId);
    return true;
  } catch (_) {
    return false;
  }
}

function scheduleLogExport(urgent = false) {
  dirtyLogs = true;
  if (logExportTimer) {
    if (!urgent) return;
    clearTimeout(logExportTimer);
  }
  const waitMs = urgent ? 4000 : 25000;
  logExportTimer = setTimeout(() => { exportLogsToDisk(false); }, waitMs);
}

if (chrome.downloads?.onChanged) {
  chrome.downloads.onChanged.addListener(delta => {
    if (!autoLogDownloadIds.has(delta.id)) return;
    if (delta.state?.current === "complete" || delta.state?.current === "interrupted") {
      autoLogDownloadIds.delete(delta.id);
      setTimeout(() => {
        try { chrome.downloads.erase({id: delta.id}); } catch (_) {}
      }, 1500);
    }
  });
}

function appendLogEntries(entries, urgent = false) {
  if (!Array.isArray(entries) || !entries.length) return;
  bgLogChain = bgLogChain.then(async () => {
    try {
      const {cspDebugLogs} = await chrome.storage.local.get("cspDebugLogs");
      const list = Array.isArray(cspDebugLogs) ? cspDebugLogs : [];
      list.push(...entries);
      if (list.length > MAX_LOGS) list.splice(0, list.length - MAX_LOGS);
      await chrome.storage.local.set({cspDebugLogs: list});
      const mode = await getAutoLogMode();
      if (mode === "always" || (mode === "errors" && urgent)) {
        scheduleLogExport(urgent);
      }
    } catch (_) {}
  });
}

function addBgLog(level, event, details = null) {
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  const ts = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
  const line = `[${ts}] [${level}] [bg] ${event}` +
    (details ? ` | ${typeof details === "string" ? details : JSON.stringify(details)}` : "");
  appendLogEntries([line], level === "ERROR" || level === "WARN");
}

function isAllowedUrl(url) {
  return ALLOWED_PREFIXES.some(prefix => (url || "").startsWith(prefix));
}

function simpleHash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

async function computeFilesSignature() {
  const parts = [];
  for (const file of WATCH_FILES) {
    const res = await fetch(chrome.runtime.getURL(file), {cache: "no-store"});
    if (!res.ok) return null;
    const text = await res.text();
    if (!text.trim()) return null;
    if (file === "manifest.json") JSON.parse(text);
    parts.push(`${file}:${text.length}:${simpleHash(text)}`);
  }
  return parts.join("|");
}

async function injectIntoTab(tabId) {
  try {
    await chrome.scripting.insertCSS({target: {tabId}, files: ["styles.css"]});
  } catch (_) {}
  try {
    await chrome.scripting.executeScript({target: {tabId}, files: ["content.js"]});
    return true;
  } catch (_) {
    return false;
  }
}

function reinjectAllDigiPayTabs() {
  if (reinjectPromise) return reinjectPromise;
  reinjectPromise = (async () => {
    try {
      const tabs = await chrome.tabs.query({url: MATCH_URLS});
      let okCount = 0;
      for (const tab of tabs) {
        if (tab.id && await injectIntoTab(tab.id)) okCount++;
      }
      addBgLog("INFO", "reinject:done", {tabs: tabs.length, ok: okCount});
    } catch (err) {
      addBgLog("ERROR", "reinject:fail", String(err?.message || err));
    }
  })().finally(() => {
    setTimeout(() => { reinjectPromise = null; }, 1000);
  });
  return reinjectPromise;
}

function ensureUpdateAlarm() {
  try {
    chrome.alarms.create(REMOTE_CHECK_ALARM, {periodInMinutes: 5});
  } catch (_) {}
  if (chrome.runtime.getManifest().update_url) return;
  try {
    chrome.alarms.create(UPDATE_ALARM, {periodInMinutes: 0.5});
  } catch (_) {
    try { chrome.alarms.create(UPDATE_ALARM, {periodInMinutes: 1}); } catch (_) {}
  }
}

async function restoreTempSessionIfAny() {
  try {
    const {cspTempSession} = await chrome.storage.local.get("cspTempSession");
    if (cspTempSession) {
      await chrome.storage.session.set({cspCustomerSession: cspTempSession});
      await chrome.storage.local.remove("cspTempSession");
    }
  } catch (_) {}
}

async function syncBaselineSignature() {
  if (chrome.runtime.getManifest().update_url) return;
  try {
    const sig = await computeFilesSignature();
    if (sig) await chrome.storage.local.set({cspFilesSig: sig});
  } catch (_) {}
}

async function checkForLocalUpdate(force = false) {
  if (chrome.runtime.getManifest().update_url) return;
  const now = Date.now();
  if (!force && now - lastCheckAt < 2500) return;
  lastCheckAt = now;
  try {
    const currentSig = await computeFilesSignature();
    if (!currentSig) return;
    const {cspFilesSig} = await chrome.storage.local.get("cspFilesSig");
    if (!cspFilesSig) {
      await chrome.storage.local.set({cspFilesSig: currentSig});
      return;
    }
    if (currentSig !== cspFilesSig) {
      const {cspCustomerSession} = await chrome.storage.session.get("cspCustomerSession");
      await chrome.storage.local.set({
        cspFilesSig: currentSig,
        cspAutoReloaded: true,
        ...(cspCustomerSession ? {cspTempSession: cspCustomerSession} : {})
      });
      addBgLog("INFO", "update:reload", "Local file change detected");
      await bgLogChain;
      chrome.runtime.reload();
    }
  } catch (err) {
    addBgLog("ERROR", "update:checkFail", String(err?.message || err));
  }
}

async function sendToActiveTab(message) {
  const [tab] = await chrome.tabs.query({active: true, lastFocusedWindow: true});
  if (!tab?.id || !isAllowedUrl(tab.url)) return;
  try {
    await chrome.tabs.sendMessage(tab.id, message);
  } catch (_) {
    addBgLog("WARN", "command:reinject", {command: message?.command});
    const ok = await injectIntoTab(tab.id);
    if (ok) {
      try { await chrome.tabs.sendMessage(tab.id, message); } catch (_) {}
    }
  }
}

chrome.runtime.onInstalled.addListener(details => {
  ensureUpdateAlarm();
  addBgLog("INFO", "ext:installed", {reason: details?.reason, version: chrome.runtime.getManifest().version});
  (async () => {
    await restoreTempSessionIfAny();
    await syncBaselineSignature();
    await checkRemoteControl(true);
    await chrome.storage.local.remove("cspAutoReloaded");
    await reinjectAllDigiPayTabs();
  })().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  ensureUpdateAlarm();
  checkForLocalUpdate(true);
  checkRemoteControl(true);
});

(async () => {
  ensureUpdateAlarm();
  await restoreTempSessionIfAny();
  await checkRemoteControl(false);
  const {cspAutoReloaded} = await chrome.storage.local.get("cspAutoReloaded");
  if (cspAutoReloaded) {
    await chrome.storage.local.remove("cspAutoReloaded");
    await reinjectAllDigiPayTabs();
  }
})().catch(() => {});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm?.name === UPDATE_ALARM) {
    checkForLocalUpdate(true);
    if (dirtyLogs) exportLogsToDisk(false);
  }
  if (alarm?.name === REMOTE_CHECK_ALARM) {
    checkRemoteControl(true);
  }
});

chrome.tabs.onActivated.addListener(() => {
  checkForLocalUpdate(false);
});

if (chrome.windows?.onFocusChanged) {
  chrome.windows.onFocusChanged.addListener(winId => {
    if (winId !== chrome.windows.WINDOW_ID_NONE) {
      checkForLocalUpdate(false);
      checkRemoteControl(false);
    }
  });
}

chrome.action.onClicked.addListener(() => sendToActiveTab({type: "CSP_COMMAND", command: "toggle-panel"}));
chrome.commands.onCommand.addListener(command => sendToActiveTab({type: "CSP_COMMAND", command}));
async function fillAadhaarInMainWorld(tabId, digits) {
  const results = await chrome.scripting.executeScript({
    target: {tabId},
    world: "MAIN",
    args: [String(digits || "")],
    func: async value => {
      const visible = el => {
        if (!el || !(el.offsetWidth || el.offsetHeight || el.getClientRects().length)) return false;
        const cs = getComputedStyle(el);
        return cs.visibility !== "hidden" && cs.display !== "none" && parseFloat(cs.opacity || "1") > 0.05;
      };
      const inputs = [...document.querySelectorAll('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"])')].filter(visible);
      const el = inputs.find(i => /aadhaar|aadhar|\bvid\b/i.test((i.placeholder || "") + " " + (i.getAttribute("aria-label") || "") + " " + (i.name || "") + " " + (i.id || "")));
      if (!el) return {ok: false, reason: "notFound"};

      const propsKey = Object.keys(el).find(k => k.startsWith("__reactProps$"));
      const getProps = () => (propsKey ? el[propsKey] : null);
      const rProps0 = getProps();
      const handlers = rProps0 ? Object.keys(rProps0).filter(k => k.startsWith("on")) : [];
      const info = {
        type: el.type,
        readOnly: !!el.readOnly,
        hasTracker: !!el._valueTracker,
        handlers,
        className: (el.className || "").slice(0, 60)
      };

      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const want = value.replace(/\D/g, "");

      // Verify React's OWN controlled prop value (not just DOM el.value which gets wiped on next React re-render!)
      const reactValueLen = () => {
        const p = getProps();
        if (p && typeof p.value === "string") return p.value.length;
        return (el.value || "").length;
      };
      const isReactFilled = () => reactValueLen() >= want.length;

      el.focus();

      // Method 1: Re-read fresh React props per digit, calling onKeyDown -> onBeforeInput -> onChange
      if (rProps0 && (typeof rProps0.onChange === "function" || typeof rProps0.onBeforeInput === "function" || typeof rProps0.onKeyDown === "function")) {
        // First clear if needed
        const startProps = getProps();
        if (startProps?.value) {
          if (setter) setter.call(el, ""); else el.value = "";
          try {
            startProps.onChange?.({
              target: el, currentTarget: el, type: "change", bubbles: true,
              preventDefault() {}, stopPropagation() {}, persist() {},
              nativeEvent: {inputType: "deleteContentBackward", data: null}
            });
          } catch (_) {}
          await sleep(25);
        }

        for (let idx = 0; idx < want.length; idx++) {
          const ch = want[idx];
          const curProps = getProps();
          if (!curProps) break;
          const curVal = typeof curProps.value === "string" ? curProps.value : (el.value || "");
          const keyCode = ch.charCodeAt(0);
          const code = `Digit${ch}`;
          let prevented = false;
          const mkEvt = (type, extra = {}) => ({
            target: el,
            currentTarget: el,
            type,
            bubbles: true,
            cancelable: true,
            defaultPrevented: false,
            preventDefault() { prevented = true; this.defaultPrevented = true; },
            stopPropagation() {},
            persist() {},
            ...extra
          });

          try {
            curProps.onKeyDown?.(mkEvt("keydown", {
              key: ch, code, keyCode, which: keyCode, charCode: keyCode,
              ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
              nativeEvent: {key: ch, code, keyCode, which: keyCode}
            }));
          } catch (_) {}

          try {
            curProps.onBeforeInput?.(mkEvt("beforeinput", {
              data: ch, inputType: "insertText",
              nativeEvent: {data: ch, inputType: "insertText"}
            }));
          } catch (_) {}

          if (!prevented) {
            const nextVal = curVal + ch;
            if (setter) setter.call(el, nextVal); else el.value = nextVal;
            try { el._valueTracker?.setValue(curVal); } catch (_) {}
            try {
              curProps.onChange?.(mkEvt("change", {
                nativeEvent: {inputType: "insertText", data: ch}
              }));
            } catch (_) {}
          }
          await sleep(20);
        }
        await sleep(50);
        if (isReactFilled()) {
          return {ok: true, method: "reactFreshProps", reactLen: reactValueLen(), afterLen: (el.value || "").length, info};
        }
      }

      // Method 2: MAIN-world DOM events (keydown -> beforeinput -> setter + _valueTracker -> input -> keyup)
      if (setter) setter.call(el, ""); else el.value = "";
      try { el._valueTracker?.setValue("x"); } catch (_) {}
      el.dispatchEvent(new Event("input", {bubbles: true}));
      await sleep(30);

      for (const ch of want) {
        const keyCode = ch.charCodeAt(0);
        const keyOpts = {bubbles: true, cancelable: true, key: ch, code: `Digit${ch}`, keyCode, which: keyCode};
        const kdOk = el.dispatchEvent(new KeyboardEvent("keydown", keyOpts));
        if (kdOk) {
          const prev = el.value || "";
          const nextVal = prev + ch;
          const biOk = el.dispatchEvent(new InputEvent("beforeinput", {bubbles: true, cancelable: true, data: ch, inputType: "insertText"}));
          if (biOk) {
            if (setter) setter.call(el, nextVal); else el.value = nextVal;
            try { el._valueTracker?.setValue(prev); } catch (_) {}
            try {
              el.dispatchEvent(new InputEvent("input", {bubbles: true, data: ch, inputType: "insertText"}));
            } catch (_) {
              el.dispatchEvent(new Event("input", {bubbles: true}));
            }
          }
        }
        el.dispatchEvent(new KeyboardEvent("keyup", keyOpts));
        await sleep(20);
      }
      await sleep(50);
      if (isReactFilled()) {
        el.dispatchEvent(new Event("change", {bubbles: true}));
        return {ok: true, method: "mainCharByChar", reactLen: reactValueLen(), afterLen: (el.value || "").length, info};
      }

      // Diagnostic snippet (non-PII function source hints) if all methods still rejected
      const fnHints = {};
      const fp = getProps();
      for (const h of ["onKeyDown", "onBeforeInput", "onChange"]) {
        if (typeof fp?.[h] === "function") fnHints[h] = fp[h].toString().replace(/\s+/g, " ").slice(0, 180);
      }
      return {ok: false, method: "allFailed", reactLen: reactValueLen(), afterLen: (el.value || "").length, info, fnHints};
    }
  });
  return results?.[0]?.result || {ok: false, reason: "noResult"};
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handled = [
    "CSP_SESSION_SAVE", "CSP_SESSION_GET", "CSP_SESSION_CLEAR",
    "CSP_LOG_PUSH", "CSP_LOG_EXPORT_NOW", "CSP_LOG_CLEAR",
    "CSP_LICENSE_GET", "CSP_LICENSE_SET_KEY", "CSP_LICENSE_CHECK_NOW", "CSP_LICENSE_CLEAR_KEY", "CSP_LICENSE_SET_CSCID",
    "CSP_FILL_AADHAAR_MAIN"
  ];
  if (!handled.includes(msg?.type)) return false;
  (async () => {
    if (msg.type === "CSP_SESSION_SAVE") {
      await chrome.storage.session.set({cspCustomerSession: msg.data || {}});
      sendResponse({ok: true});
    } else if (msg.type === "CSP_SESSION_GET") {
      const r = await chrome.storage.session.get("cspCustomerSession");
      sendResponse({ok: true, data: r.cspCustomerSession || null});
    } else if (msg.type === "CSP_SESSION_CLEAR") {
      await chrome.storage.session.remove("cspCustomerSession");
      sendResponse({ok: true});
    } else if (msg.type === "CSP_LOG_PUSH") {
      appendLogEntries(msg.data?.entries || [], !!msg.data?.urgent);
      await bgLogChain;
      sendResponse({ok: true});
    } else if (msg.type === "CSP_LOG_EXPORT_NOW") {
      await bgLogChain;
      const ok = await exportLogsToDisk(true);
      sendResponse({ok});
    } else if (msg.type === "CSP_LOG_CLEAR") {
      dirtyLogs = false;
      clearTimeout(logExportTimer);
      logExportTimer = null;
      await chrome.storage.local.remove("cspDebugLogs");
      sendResponse({ok: true});
    } else if (msg.type === "CSP_LICENSE_GET") {
      const csc = normalizeCscId(msg.data?.cscId);
      if (csc) await chrome.storage.local.set({cspDetectedCscId: csc});
      const {cspLicenseStatus} = await chrome.storage.local.get("cspLicenseStatus");
      const status = cspLicenseStatus || await checkRemoteControl(false, csc);
      sendResponse({ok: true, status});
    } else if (msg.type === "CSP_LICENSE_SET_CSCID") {
      const csc = normalizeCscId(msg.data?.cscId);
      if (!csc) return sendResponse({ok: true, changed: false});
      const {cspDetectedCscId, cspLicenseStatus} = await chrome.storage.local.get(["cspDetectedCscId", "cspLicenseStatus"]);
      const changed = csc !== cspDetectedCscId;
      await chrome.storage.local.set({cspDetectedCscId: csc});
      if (changed || cspLicenseStatus?.reason === "csc_waiting" || cspLicenseStatus?.reason === "csc_mismatch" || !cspLicenseStatus?.detectedCscId) {
        const status = await checkRemoteControl(true, csc);
        return sendResponse({ok: true, changed: true, status});
      }
      sendResponse({ok: true, changed: false, status: cspLicenseStatus});
    } else if (msg.type === "CSP_LICENSE_SET_KEY") {
      const key = String(msg.data?.key || "").trim().toUpperCase();
      const csc = normalizeCscId(msg.data?.cscId);
      await chrome.storage.local.set({cspAccessKey: key, ...(csc ? {cspDetectedCscId: csc} : {})});
      const status = await checkRemoteControl(true, csc);
      sendResponse({ok: true, status});
    } else if (msg.type === "CSP_LICENSE_CHECK_NOW") {
      const csc = normalizeCscId(msg.data?.cscId);
      if (csc) await chrome.storage.local.set({cspDetectedCscId: csc});
      const status = await checkRemoteControl(true, csc);
      sendResponse({ok: true, status});
    } else if (msg.type === "CSP_LICENSE_CLEAR_KEY") {
      await chrome.storage.local.remove(["cspAccessKey", "cspKeyRegisteredAt"]);
      const status = await checkRemoteControl(true);
      sendResponse({ok: true, status});
    } else if (msg.type === "CSP_FILL_AADHAAR_MAIN") {
      const {cspExtensionEnabled, cspLicenseStatus} = await chrome.storage.local.get(["cspExtensionEnabled", "cspLicenseStatus"]);
      if (cspLicenseStatus && cspLicenseStatus.allowed === false) return sendResponse({ok: false, reason: "locked"});
      if (cspExtensionEnabled === false && !msg.data?.manual) return sendResponse({ok: false, reason: "manual_only"});
      const tabId = sender?.tab?.id;
      if (!tabId) return sendResponse({ok: false, reason: "noTab"});
      const res = await fillAadhaarInMainWorld(tabId, msg.data?.digits || "");
      sendResponse(res);
    }
  })().catch(err => sendResponse({ok: false, error: String(err?.message || err)}));
  return true;
});
