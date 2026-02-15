import streamlit as st
import requests
from bs4 import BeautifulSoup
from urllib.parse import urlparse
import re

st.set_page_config(page_title="TS4 Mod Analyzer", layout="centered")
st.title("🎮 TS4 Mod Analyzer")
st.caption("Phase 1: Identity Extraction")

def fetch_page(url):
    try:
        r = requests.get(url, timeout=10, headers={
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        })
        return r.text
    except Exception:
        return None

def extract_identity(html, url):
    if not html:
        return {"error": "Failed to fetch page"}
    
    soup = BeautifulSoup(html, 'html.parser')
    parsed = urlparse(url)
    
    title = soup.find('title')
    pagetitle = title.get_text(strip=True) if title else None
    
    ogtitle = None
    for meta in soup.find_all('meta'):
        if meta.get('property') == 'og:title':
            ogtitle = meta.get('content', '').strip()
    
    slug = parsed.path.strip('/').replace('-', ' ')
    domain = parsed.netloc.replace('www.', '')
    
    blocked = 'cloudflare' in html.lower() or 'just a moment' in html.lower()
    
    rawname = ogtitle or pagetitle or slug
    modname = re.sub(r'\s+', ' ', rawname).strip().title() if rawname else 'Unknown'
    
    return {
        "url": url,
        "modname": modname,
        "pagetitle": pagetitle,
        "ogtitle": ogtitle,
        "domain": domain,
        "slug": slug,
        "isblocked": blocked
    }

url_input = st.text_input("🔗 URL do Mod:")

if st.button("Analisar", type="primary"):
    if url_input.strip():
        with st.spinner("Extraindo identidade..."):
            html = fetch_page(url_input.strip())
            identity = extract_identity(html, url_input.strip())
            
            if "error" in identity:
                st.error(identity["error"])
            else:
                st.success(f"**Mod identificado:** {identity['modname']}")
                with st.expander("🔍 Debug Técnico"):
                    st.json(identity)
    else:
        st.warning("Cole uma URL!")

st.markdown("---")
st.caption("v1.0.0 Phase 1 | @UnpaidSimmer")
