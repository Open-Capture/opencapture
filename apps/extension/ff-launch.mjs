import { firefox } from "@playwright/test";
import { writeFileSync } from "node:fs";

const ctx = await firefox.launchPersistentContext("/tmp/oc-ff-profile", {
  headless: false,
  viewport: null,
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto("https://www.linkedin.com/feed/");
console.log("Firefox ready. Log in and open the messaging dock.");

const SNAP = () => page.evaluate(() => {
  const CONSENT = /cookie|consent|gdpr|ccpa|cmplz|onetrust|cookiebot|didomi|osano|truste|usercentrics|klaro|termly|quantcast|privacy-?(banner|notice|bar)/i;
  const CHAT = /msg-overlay|intercom|drift-|drift_|crisp-client|zendesk|zopim|tawk|livechat|live-chat|hubspot-messages|freshchat|helpscout|olark|smartsupp|chat-?(widget|bubble|launcher|window)/i;
  const deep = (node, cap) => {
    const found = []; const walk = (cur) => {
      if (found.length >= cap) return;
      if (cur.shadowRoot) walk(cur.shadowRoot);
      for (const el of cur.querySelectorAll("*")) { if (found.length >= cap) return; found.push(el); if (el.shadowRoot) walk(el.shadowRoot); }
    }; walk(node); return found;
  };
  const own = (e) => `${e.id} ${typeof e.className === "string" ? e.className : ""} ${e.getAttribute?.("aria-label") || ""}`;
  const sig = (e) => [own(e), ...deep(e, 24).map(own)].join(" ");
  const painted = (e) => {
    const o = e.getBoundingClientRect();
    if (o.width >= 40 && o.height >= 8) return { top:o.top,left:o.left,width:o.width,height:o.height };
    let t=Infinity,l=Infinity,b=-Infinity,r=-Infinity,f=0;
    for (const c of deep(e,64)) { const q=c.getBoundingClientRect(); if(q.width<1||q.height<1) continue;
      t=Math.min(t,q.top); l=Math.min(l,q.left); b=Math.max(b,q.bottom); r=Math.max(r,q.right); f=1; }
    return f?{top:t,left:l,width:r-l,height:b-t}:{top:o.top,left:o.left,width:o.width,height:o.height};
  };
  const vw=innerWidth, vh=innerHeight;
  let scroller=null,best=0;
  for (const e of document.body.querySelectorAll("*")) {
    if (e.scrollHeight - e.clientHeight < 50) continue;
    const st=getComputedStyle(e); if (st.overflowY!=="auto"&&st.overflowY!=="scroll") continue;
    const r=e.getBoundingClientRect(); if (r.width<vw*0.5||r.height<vh*0.5) continue;
    const a=r.width*r.height; if(a>best){best=a;scroller=e;}
  }
  const sr = scroller ? scroller.getBoundingClientRect() : null;
  const view = sr ? {top:sr.top,left:sr.left,width:sr.width,height:sr.height} : {top:0,left:0,width:vw,height:vh};
  const rows=[];
  for (const el of document.body.querySelectorAll("*")) {
    const st=getComputedStyle(el);
    if (st.display==="none"||st.visibility==="hidden") continue;
    const pinnedByPosition = st.position==="fixed"||st.position==="sticky";
    const staysInner = scroller && st.position!=="static" && !scroller.contains(el);
    if (!pinnedByPosition && !staysInner) continue;
    const p=painted(el); if (p.width<40||p.height<8) continue;
    if (p.top+p.height<=view.top||p.top>=view.top+view.height) continue;
    if (p.left+p.width<=view.left||p.left>=view.left+view.width) continue;
    const s=sig(el);
    const overlay = CONSENT.test(s)||CHAT.test(s);
    const tall = p.height > view.height*0.5, wide = p.width > view.width*0.4;
    rows.push({ cls:String(el.className||"").slice(0,28), pos:st.position,
      box:`${Math.round(p.width)}x${Math.round(p.height)}@${Math.round(p.left)},${Math.round(p.top)}`,
      overlay, tall, wide, treatedAsContent: !overlay && tall && wide });
  }
  return { loggedIn: !location.pathname.includes("login"), viewport:`${vw}x${vh}`, dpr:devicePixelRatio,
           scroller: scroller ? `${Math.round(view.width)}x${Math.round(view.height)}@${Math.round(view.left)},${Math.round(view.top)}` : "NONE",
           rows };
});

for (;;) {
  try {
    const snap = await SNAP();
    writeFileSync("/tmp/ff-diag.json", JSON.stringify(snap, null, 1));
  } catch {}
  await new Promise((r) => setTimeout(r, 5000));
}
