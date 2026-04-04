#!/usr/bin/env python3
"""
بوت أخبار جلسة السوق — 3 مصادر
Bloomberg + أرقام + الشرق بلومبرغ
يرسل للسيرفر عشان يعالج ويلخص بـ Claude
"""
import os, json, urllib.request
from datetime import datetime

SITE_URL = os.environ.get("SITE_URL", "https://jalsoq.com")
API_SECRET = os.environ.get("API_SECRET", "")

def trigger():
    payload = json.dumps({"api_secret": API_SECRET}).encode()
    req = urllib.request.Request(
        f"{SITE_URL}/api/admin/fetch-news-all",
        data=payload,
        headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.loads(r.read())
    except Exception as e:
        print(f"❌ Error: {e}")
        return None

print(f"\n{'='*50}")
print(f"🤖 بوت الأخبار — {datetime.now().strftime('%Y-%m-%d %H:%M')}")
print(f"{'='*50}\n")

result = trigger()
if result:
    print(f"✅ {json.dumps(result, ensure_ascii=False)}")
else:
    print("❌ فشل الاتصال")
