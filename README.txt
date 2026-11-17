========================================================
  CSP Automation Helper (v0.2.6) - DigiPay Web & Lite
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

2. सिर्फ़ इन 2 जगह पर "YOUR_GITHUB_USERNAME/csp-automation" बदलकर अपना
   "आपका_username/csp-automation" लिख दें:
   (a) background.js (लाइन 14 पर: const GITHUB_REPO = "...")
   (b) Update.bat    (लाइन 6 पर:  set "GITHUB_REPO=...")

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
- नया दोस्त जोड़ना:
    "DOST3": { "active": true, "expires": "2026-12-31", "name": "Ramesh CSP" }
- किसी एक दोस्त को तुरंत बंद करना:
    उसकी Key में "active": false कर दें (5 मिनट में उसका Extension लॉक हो जाएगा)।
- सबको एक साथ बंद करना:
    "globalEnabled": false कर दें।
- नया अपडेट सभी दोस्तों तक पहुँचाना:
    manifest.json और config.json दोनों में version बढ़ा दें (जैसे "0.2.7"),
    और बदली हुई फ़ाइलें GitHub पर Upload कर दें — दोस्तों के PC पर Auto-Update
    अपने आप नई फ़ाइलें डाउनलोड करके Chrome में लोड कर देगा!

--------------------------------------------------------
PART 2: DOST (इंस्टॉल करने वाले के लिए — सिर्फ़ 1 बार)
--------------------------------------------------------
1. मिली हुई ZIP फ़ाइल को Extract करके एक पक्के फ़ोल्डर में रख लें
   (जैसे D:\CSP-Automation — इस फ़ोल्डर को बाद में Delete न करें)।
2. Chrome में खोलें: chrome://extensions
3. ऊपर दाएँ तरफ़ "Developer mode" ON करें।
4. "Load unpacked" दबाएँ और D:\CSP-Automation फ़ोल्डर चुनें।
5. फ़ोल्डर के अंदर "Setup-AutoUpdate.bat" पर 1 बार डबल-क्लिक करें
   (इससे हर 2 घंटे और Windows स्टार्ट होने पर अपडेट अपने आप हो जाएगा)।
6. DigiPay खोलें, अपनी मिली हुई Access Key (जैसे DOST1) डालकर "✓ Verify" दबाएँ।

(अगर कभी ऑटो-अपडेट हटाना हो, तो Remove-AutoUpdate.bat पर डबल-क्लिक कर दें।)
