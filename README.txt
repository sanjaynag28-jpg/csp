========================================================
  CSP Automation Helper (v0.2.15) - DigiPay Web & Lite
  100% Free GitHub Auto-Update + Remote Key Control
========================================================

[गोपनीयता / PRIVACY]
- ग्राहक का Mobile, Aadhaar या Bank डेटा कभी किसी सर्वर पर नहीं जाता।
- सारा डेटा सिर्फ़ आपके अपने Chrome की temporary session memory में रहता है।
- Extension सिर्फ़ GitHub की config.json फ़ाइल पढ़ता है (Read-Only)।

--------------------------------------------------------
PART 1: ADMIN (आपके लिए — 1 बार GitHub सेटअप, 100% फ्री)
--------------------------------------------------------
1. https://github.com पर फ्री अकाउंट बनाएँ और नया Public Repository बनाएँ
   (उदाहरण: csp-automation, branch: main)।

2. GitHub Repo pehle se set hai: "sanjaynag28-jpg/csp" (branch: main).
   Agar kabhi repo badalna ho to sirf 2 jagah update karein:
   (a) background.js (line 14: const GITHUB_REPO = "...")
   (b) Update.bat    (line 7:  set "GITHUB_REPO=...")

3. ये 6 फ़ाइलें अपने GitHub Repo में Upload (Commit) कर दें:
   - manifest.json
   - background.js
   - content.js
   - styles.css
   - config.json
   - README.txt
   (ध्यान दें: csp-auto-log.txt कभी Upload न करें!)

4. दोस्त को देने के लिए ये फ़ाइलें ZIP बनाकर भेज दें:
   - manifest.json, background.js, content.js, styles.css, README.txt
   - Update.bat, Update.ps1, AutoUpdateSilent.vbs, Setup-AutoUpdate.bat, Remove-AutoUpdate.bat
   (config.json दोस्त को देने की ज़रूरत नहीं है — वह सिर्फ़ GitHub पर रहेगी।)

--- किसी दोस्त को चालू / बंद / Expiry कैसे कंट्रोल करें ---
GitHub पर config.json खोलकर Edit (पेंसिल आइकन) करें और Commit कर दें:
- नया दोस्त जोड़ना (सुरक्षित तरीका — SHA-256 hash):
    1. Key तय करें, जैसे: CSP-DOST3-1234
    2. Windows PowerShell में यह command चलाएँ:
       [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes("CSP-HELPER-V1:CSP-DOST3-1234"))).Replace("-","").ToLower()
    3. config.json की "keyHashes" में यह entry जोड़ें:
       "यहाँ_आया_हुआ_hash": { "active": true, "expires": "2026-12-31", "name": "Ramesh CSP", "plan": "Standard" }
    (असली Key कभी config.json या GitHub पर न लिखें।)
- किसी एक दोस्त को तुरंत बंद करना:
    उसकी Key में "active": false कर दें (5 मिनट में उसका Extension लॉक हो जाएगा)।
- सबको एक साथ बंद करना:
    "globalEnabled": false कर दें।
- नया अपडेट सभी दोस्तों तक पहुँचाना:
    manifest.json और config.json दोनों में version बढ़ा दें (जैसे "0.2.13"),
    और बदली हुई फ़ाइलें GitHub पर Upload कर दें — दोस्तों के PC पर Auto-Update
    हर 15 मिनट में अपने आप नई फ़ाइलें डाउनलोड कर लेगा और Extension खुद
    Chrome में Reload हो जाएगा (कोई manual काम नहीं)।
    (या Publish-To-GitHub.ps1 चला दें — वह सब files अपने आप upload कर देता है।)

--------------------------------------------------------
PART 2: DOST (इंस्टॉल करने वाले के लिए — सिर्फ़ 1 बार)
--------------------------------------------------------
1. मिली हुई ZIP फ़ाइल को Extract करके एक पक्के फ़ोल्डर में रख लें
   (जैसे D:\CSP-Automation — इस फ़ोल्डर को बाद में Delete न करें)।
2. Chrome में खोलें: chrome://extensions
3. ऊपर दाएँ तरफ़ "Developer mode" ON करें।
4. "Load unpacked" दबाएँ और D:\CSP-Automation फ़ोल्डर चुनें।
5. फ़ोल्डर के अंदर "Setup-AutoUpdate.bat" पर 1 बार डबल-क्लिक करें
   (इससे हर 15 मिनट और Windows स्टार्ट होने पर अपडेट अपने आप हो जाएगा)।
6. DigiPay खोलें, अपनी मिली हुई Access Key (जैसे CSP-DOST1-7429) डालकर "✓ Verify" दबाएँ।

(अगर कभी ऑटो-अपडेट हटाना हो, तो Remove-AutoUpdate.bat पर डबल-क्लिक कर दें।)
