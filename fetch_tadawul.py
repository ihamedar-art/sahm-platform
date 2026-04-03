#!/usr/bin/env python3
"""
جالب أخبار تداول التلقائي — يشتغل كل يوم الساعة 9 صباحاً
يجيب آخر إعلانات الشركات من تداول السعودية
ويرسلها لـ API جلسة السوق كمسودات تنتظر الموافقة
"""

import os
import json
import time
import urllib.request
import urllib.parse
import urllib.error
from datetime import datetime

SITE_URL = os.environ.get("SITE_URL", "https://jalsoq.com")
API_SECRET = os.environ.get("API_SECRET", "")
ANTHROPIC_KEY = os.environ.get("ANTHROPIC_API_KEY", "")

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "ar,en;q=0.9",
    "Referer": "https://www.saudiexchange.sa/",
}

def fetch_url(url, extra_headers={}):
    req = urllib.request.Request(url, headers={**HEADERS, **extra_headers})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.read().decode("utf-8", errors="ignore")
    except Exception as e:
        print(f"❌ Error fetching {url}: {e}")
        return None

def get_tadawul_token():
    """نجيب الـ session token من الصفحة الرئيسية"""
    html = fetch_url("https://www.saudiexchange.sa/wps/portal/saudiexchange/newsandreports/issuer-news/issuer-announcements?locale=ar")
    if not html:
        return None
    import re
    # نبحث عن الـ token في الـ HTML
    match = re.search(r'/wps/portal/saudiexchange/newsandreports/issuer-news/issuer-announcements/(!ut/p/z1/[^"\']+)NJgetAnnouncementListData=/', html)
    if match:
        return match.group(1)
    return None

def fetch_announcements():
    """نجيب الإعلانات من تداول"""
    print("🔍 جاري جلب token من تداول...")
    token = get_tadawul_token()
    
    if not token:
        print("⚠️ ما قدرنا نجيب token — نجرب URL مباشر")
        # نجرب جلب الصفحة الرئيسية ونستخرج الإعلانات من الـ HTML
        html = fetch_url("https://www.saudiexchange.sa/wps/portal/saudiexchange/newsandreports/issuer-news/issuer-announcements?locale=ar")
        if not html:
            return []
        return parse_html_announcements(html)
    
    api_url = f"https://www.saudiexchange.sa/wps/portal/saudiexchange/newsandreports/issuer-news/issuer-announcements/{token}p0/IZ7_5A602H80O0HTC060SG6UT81DI1=CZ6_5A602H80O0HTC060SG6UT81D26=NJgetAnnouncementListData=/"
    
    print(f"📡 جاري جلب الإعلانات...")
    data = fetch_url(api_url, {"Accept": "application/json"})
    if not data:
        return []
    
    try:
        result = json.loads(data)
        announcements = result.get("announcementList", [])
        print(f"✅ تم جلب {len(announcements)} إعلان")
        return announcements[:10]  # أول 10 إعلانات فقط
    except:
        return []

def parse_html_announcements(html):
    """استخراج الإعلانات من الـ HTML مباشرة"""
    import re
    announcements = []
    # نبحث عن announcementList في الـ HTML
    match = re.search(r'"announcementList"\s*:\s*(\[.*?\])', html, re.DOTALL)
    if match:
        try:
            announcements = json.loads(match.group(1))
            print(f"✅ استخرجنا {len(announcements)} إعلان من HTML")
            return announcements[:10]
        except:
            pass
    print("⚠️ ما قدرنا نستخرج إعلانات من HTML")
    return []

def summarize_with_claude(announcement):
    """Claude يلخص الإعلان"""
    if not ANTHROPIC_KEY:
        return {
            "title": announcement.get("TITLE", "") + " — " + announcement.get("SHORT_DESC", "")[:50],
            "summary": announcement.get("SHORT_DESC", ""),
            "source": "تداول السعودية",
            "symbol": "$" + announcement.get("SYMBOL", "") if announcement.get("SYMBOL") else ""
        }
    
    prompt = f"""أنت محرر أخبار مالية سعودي. لخص هذا الإعلان من تداول السعودية.
أرجع JSON فقط بدون أي نص خارجه:
{{"title":"عنوان واضح أقل من 80 حرف","summary":"ملخص 50-100 كلمة يشمل اسم الشركة والحدث الرئيسي","source":"تداول السعودية","symbol":"$XXXX أو فارغ"}}

الإعلان:
الشركة: {announcement.get('TITLE','')} ({announcement.get('SYMBOL','')})
النص: {announcement.get('SHORT_DESC','')}
التاريخ: {announcement.get('newsDateStr','')}"""

    try:
        payload = json.dumps({
            "model": "claude-sonnet-4-20250514",
            "max_tokens": 500,
            "messages": [{"role": "user", "content": prompt}]
        }).encode()
        
        req = urllib.request.Request(
            "https://api.anthropic.com/v1/messages",
            data=payload,
            headers={
                "Content-Type": "application/json",
                "x-api-key": ANTHROPIC_KEY,
                "anthropic-version": "2023-06-01"
            }
        )
        with urllib.request.urlopen(req, timeout=20) as r:
            data = json.loads(r.read())
            raw = data["content"][0]["text"].replace("```json","").replace("```","").strip()
            return json.loads(raw)
    except Exception as e:
        print(f"⚠️ Claude error: {e}")
        return {
            "title": announcement.get("TITLE", "") + ": " + announcement.get("SHORT_DESC", "")[:60],
            "summary": announcement.get("SHORT_DESC", ""),
            "source": "تداول السعودية",
            "symbol": "$" + announcement.get("SYMBOL", "") if announcement.get("SYMBOL") else ""
        }

def send_to_jalsat(news_item):
    """نرسل الخبر لـ API جلسة السوق كمسودة"""
    payload = json.dumps({
        "title": news_item["title"],
        "summary": news_item["summary"],
        "source": news_item["source"],
        "stock_symbols": news_item.get("symbol", ""),
        "is_draft": True,
        "draft_source": "tadawul_bot",
        "api_secret": API_SECRET
    }).encode()
    
    req = urllib.request.Request(
        f"{SITE_URL}/api/admin/news-draft",
        data=payload,
        headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            result = json.loads(r.read())
            return result.get("success", False)
    except Exception as e:
        print(f"❌ Error sending to jalsat: {e}")
        return False

def main():
    print(f"\n{'='*50}")
    print(f"🤖 بوت أخبار تداول — {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    print(f"{'='*50}\n")
    
    announcements = fetch_announcements()
    
    if not announcements:
        print("❌ ما فيه إعلانات")
        return
    
    success_count = 0
    for i, ann in enumerate(announcements[:5]):  # أول 5 فقط
        print(f"\n📋 معالجة {i+1}/5: {ann.get('TITLE','')}")
        
        summarized = summarize_with_claude(ann)
        print(f"   العنوان: {summarized['title'][:60]}...")
        
        if send_to_jalsat(summarized):
            success_count += 1
            print(f"   ✅ تم الإرسال")
        else:
            print(f"   ❌ فشل الإرسال")
        
        time.sleep(2)  # نتحاشى الـ rate limiting
    
    print(f"\n{'='*50}")
    print(f"✅ تم: {success_count}/5 خبر أُرسل للمراجعة")
    print(f"{'='*50}\n")

if __name__ == "__main__":
    main()
