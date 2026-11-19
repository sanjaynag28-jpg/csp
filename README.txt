========================================================
  CSP ऑटोमेशन हेल्पर (v0.2.15) - DigiPay Web और Lite
  मुफ़्त GitHub ऑटो-अपडेट + रिमोट कंट्रोल
========================================================

[निजता]
- ग्राहक का मोबाइल, आधार या बैंक डेटा किसी सर्वर पर नहीं जाता।
- सारा डेटा सिर्फ़ आपके Chrome की अस्थायी मेमोरी में रहता है।
- एक्सटेंशन GitHub से सिर्फ़ config.json पढ़ता है (Read-Only)।

--------------------------------------------------------
भाग 1: एडमिन (सिर्फ़ आपके लिए)
--------------------------------------------------------
1. GitHub रिपॉज़िटरी पहले से सेट है: sanjaynag28-jpg/csp (ब्रांच: main)।
   कभी बदलनी हो तो background.js और Update.bat में नाम अपडेट करें।

2. नया दोस्त जोड़ना (असली Key कभी GitHub पर न लिखें):
   (क) Key तय करें, जैसे: CSP-DOST3-1234
   (ख) PowerShell में यह कमांड चलाएँ:
       [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes("CSP-HELPER-V1:CSP-DOST3-1234"))).Replace("-","").ToLower()
   (ग) config.json की keyHashes में यह लाइन जोड़ें:
       "यहाँ_हैश": { "active": true, "expires": "2026-12-31", "name": "दोस्त का नाम", "plan": "Standard", "autoLockLocalCsc": true }
   (घ) Commit करें — बदलाव 5 मिनट में लागू हो जाएगा।

3. Key चालू / बंद करना:
   - किसी एक दोस्त की Key: उसकी entry में "active": false कर दें।
   - सभी दोस्तों की Key: "globalEnabled": false कर दें।
   (बदलाव 5 मिनट में सभी PC पर लागू होता है।)

4. नया अपडेट भेजना:
   - manifest.json और config.json दोनों में version बढ़ाएँ (जैसे 0.2.16)।
   - बदली हुई फ़ाइलें GitHub पर अपलोड करें।
   - दोस्तों के PC पर 15 मिनट के अंदर अपडेट और एक्सटेंशन Reload अपने आप हो जाएगा।

5. सूचना (Notification) भेजना:
   - Admin-Panel.ps1 → Notification Center से title और message भरकर भेजें।
   - या config.json की "notification" सेटिंग में सीधे भर दें।

--------------------------------------------------------
भाग 2: दोस्त (सिर्फ़ एक बार इंस्टॉल)
--------------------------------------------------------
1. ZIP को किसी पक्के फ़ोल्डर में Extract करें (जैसे D:\CSP-Automation)।
   इस फ़ोल्डर को बाद में Delete न करें।
2. Chrome में chrome://extensions खोलें।
3. "Developer mode" ON करें।
4. "Load unpacked" दबाकर फ़ोल्डर चुनें।
5. "Setup-AutoUpdate.bat" पर एक बार डबल-क्लिक करें।
   (हर 15 मिनट और Windows स्टार्ट होने पर अपडेट अपने आप होगा।)
6. DigiPay खोलें और मिली हुई Access Key डालकर "✓ Verify" दबाएँ।

ऑटो-अपडेट हटाना हो तो "Remove-AutoUpdate.bat" चलाएँ।
