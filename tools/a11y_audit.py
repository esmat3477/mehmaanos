"""Accessibility audit (axe-core, WCAG 2 A/AA + best practices) of every screen.
Setup:  mkdir -p /tmp/axe && cd /tmp/axe && npm init -y && npm install axe-core@4
Start a fresh server:  PORT=3999 DATA_DIR=/tmp/ax node server.js
Run:    python tools/a11y_audit.py      (expects: TOTAL rule violations: 0)"""
import asyncio, json, urllib.request
from playwright.async_api import async_playwright
SITE='http://127.0.0.1:3999'; B=SITE+'/r/axe'
AXE='/tmp/axe/node_modules/axe-core/axe.min.js'
def http(m,p,body=None,c=None,base=None):
    r=urllib.request.Request((base or B)+p,method=m,data=json.dumps(body).encode() if body is not None else None,headers={'content-type':'application/json',**({'cookie':c} if c else {})})
    with urllib.request.urlopen(r) as x: return json.loads(x.read() or b'{}'), (x.headers.get('set-cookie') or '').split(';')[0]
async def audit(pg, name, out):
    await pg.add_script_tag(path=AXE)
    r = await pg.evaluate("axe.run(document, {runOnly:['wcag2a','wcag2aa','best-practice']}).then(r=>r.violations.map(v=>({id:v.id,impact:v.impact,n:v.nodes.length,help:v.help,t:v.nodes.slice(0,3).map(x=>x.target.join(' '))})))")
    out[name]=r
async def main():
    _,ck=http('POST','/api/signup',{'restaurantName':'Axe','slug':'axe','country':'AE','ownerName':'O','contact':'o@example.com','pin':'600600','demoMenu':True,'terms':True},base=SITE)
    url=http('GET','/api/admin/tables',c=ck)[0]['tables'][0]['url']
    out={}
    async with async_playwright() as p:
        b=await p.chromium.launch()
        pub=await (await b.new_context(bypass_csp=True)).new_page()
        for name,u in [('landing','/'),('signup','/signup'),('platform-login','/platform')]:
            await pub.goto(SITE+u); await pub.wait_for_timeout(400); await audit(pub,name,out)
        await pub.goto(B+'/login'); await audit(pub,'login',out)
        await pub.goto(B+'/guide'); await audit(pub,'guide',out)
        g=await (await b.new_context(viewport={'width':390,'height':844},is_mobile=True,bypass_csp=True)).new_page()
        await g.goto(url); await g.wait_for_selector('.item'); await audit(g,'guest-en',out)
        await g.select_option('.langsel','ar'); await g.wait_for_timeout(200); await audit(g,'guest-ar',out)
        await g.click('.item >> nth=0 >> button.primary'); await g.wait_for_timeout(200); await audit(g,'guest-spice-sheet',out); await g.click('.sheet button.primary'); await g.click('.cartbar button'); await g.wait_for_selector('.sheet'); await audit(g,'guest-cart',out)
        a=await (await b.new_context(viewport={'width':1280,'height':900},bypass_csp=True)).new_page()
        await a.goto(B+'/login'); await a.fill('#pin','600600'); await a.click('button.primary'); await a.wait_for_url('**/admin*'); await a.wait_for_selector('text=+ Add dish')
        for tab in ['Menu','Tables & QR','Staff','Daily report','Settings','System & audit']:
            await a.click(f'.tabs button:has-text("{tab}")'); await a.wait_for_timeout(500); await audit(a,'admin-'+tab,out)
        await a.click('.tabs button:has-text("Menu")'); await a.wait_for_selector('text=+ Add dish'); await a.click('text=+ Add dish'); await a.wait_for_selector('.sheet'); await audit(a,'admin-dish-form',out)
        await a.goto(B+'/staff'); await a.wait_for_timeout(600); await audit(a,'staff',out)
        await a.goto(B+'/kitchen'); await a.wait_for_timeout(600); await audit(a,'kitchen',out)
        await b.close()
    agg={}
    for page,vs in out.items():
        for v in vs:
            k=v['id']; agg.setdefault(k,{'impact':v['impact'],'help':v['help'],'pages':[],'eg':v['t']}); agg[k]['pages'].append(f"{page}({v['n']})")
    for k,v in sorted(agg.items(), key=lambda x:['critical','serious','moderate','minor'].index(x[1]['impact'] or 'minor')):
        print(f"[{v['impact']}] {k}: {v['help']}\n   pages: {', '.join(v['pages'])}\n   e.g. {v['eg'][:2]}")
    print('TOTAL rule violations:', len(agg))
asyncio.run(main())
