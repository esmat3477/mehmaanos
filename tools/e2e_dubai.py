"""Dubai end-to-end: manager applies UAE preset in the admin UI, adds Arabic names, guest orders in Arabic on a phone.
Start a fresh server first:  PORT=3999 DATA_DIR=/tmp/dxb node server.js   (this script signs up restaurant 'dubai')
Then:  python tools/e2e_dubai.py   (expects ORDER 8400 400 AED inclusive, overflow 0, errors [])
Screenshots are written to /tmp/dxb_*.png"""
import asyncio, json, urllib.request
from playwright.async_api import async_playwright
ROOT='http://127.0.0.1:3999'; B=ROOT+'/r/dubai'
def http(m,p,body=None,c=None,base=None):
    r=urllib.request.Request((base or B)+p,method=m,data=json.dumps(body).encode() if body is not None else None,headers={'content-type':'application/json',**({'cookie':c} if c else {})})
    with urllib.request.urlopen(r) as x: return json.loads(x.read() or b'{}'), (x.headers.get('set-cookie') or '').split(';')[0]
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(); errs=[]
        http('POST','/api/signup',{'restaurantName':'Kabul Darbar Dubai','slug':'dubai','country':'AF','ownerName':'Owner','contact':'o@example.com','pin':'900100','demoMenu':True,'terms':True},base=ROOT)
        # Manager sets up Dubai through the real admin UI
        a=await (await b.new_context(viewport={'width':1280,'height':900})).new_page(); a.on('pageerror',lambda e:errs.append(str(e)))
        a.on('dialog', lambda d: asyncio.ensure_future(d.accept()))
        await a.goto(B+'/login'); await a.fill('#pin','900100'); await a.click('button.primary'); await a.wait_for_url('**/r/dubai/admin*')
        await a.click('button:has-text("Settings")'); await a.click('text=UAE / Dubai'); await a.wait_for_timeout(800)
        await a.click('button:has-text("Settings")'); await a.wait_for_selector('text=Country, currency'); await a.screenshot(path='/tmp/dxb_settings.png')
        _, ck = http('POST','/api/login',{'pin':'900100'})
        menu,_=http('GET','/api/admin/menu',c=ck)
        AR={'kabuli':('كابلي بلاو','أرز مع لحم الضأن والجزر والزبيب',4200),'mantu':('منتو','زلابية لحم مطهوة على البخار مع صلصة العدس واللبن',3500),'bolani':('بولاني','خبز رقيق محشو بالبطاطس والكراث',1800),'naan':('خبز أفغاني','خبز تنور طازج',500),'doogh':('دوغ','مشروب لبن بالنعناع',1200)}
        for it in menu['items']:
            if it['id'] in AR:
                n,d,pr=AR[it['id']]; it['name']['ar']=n; it['desc']['ar']=d
                http('POST','/api/admin/items',{**it,'price':pr},ck)
        for c,n in [('starters','المقبلات'),('mains','الأطباق الرئيسية'),('bread','الخبز والمقبلات الجانبية'),('drinks','المشروبات'),('dessert','الحلويات')]:
            cat=[x for x in menu['categories'] if x['id']==c][0]; cat['name']['ar']=n; http('POST','/api/admin/categories',cat,ck)
        await a.click('button:has-text("Menu")'); await a.wait_for_selector('text=AED'); await a.screenshot(path='/tmp/dxb_menu.png')
        url=http('GET','/api/admin/tables',c=ck)[0]['tables'][0]['url']
        # Guest on iPhone in Arabic
        g=await (await b.new_context(viewport={'width':390,'height':844},is_mobile=True,locale='ar-AE')).new_page(); g.on('pageerror',lambda e:errs.append(str(e)))
        await g.goto(url); await g.wait_for_selector('.item'); await g.select_option('.langsel','ar'); await g.wait_for_timeout(300)
        await g.click('text=الأطباق الرئيسية'); await g.click('.item >> nth=0 >> button.primary'); await g.click('.item >> nth=0 >> button.primary')
        await g.click('.cartbar button'); await g.wait_for_selector('.sheet'); await g.screenshot(path='/tmp/dxb_cart_ar.png')
        await g.click('.sheet button.primary >> nth=-1'); await g.wait_for_selector('.pill'); await g.screenshot(path='/tmp/dxb_status_ar.png')
        for lang,f in [('ur','ur'),('hi','hi')]:
            await g.select_option('.langsel',lang); await g.wait_for_timeout(300); await g.screenshot(path=f'/tmp/dxb_{f}.png')
        st,_=http('GET','/api/state',c=ck); o=st['orders'][0]
        print('ORDER', o['total'], o['tax'], o['currency'], o['taxMode'])
        rep,_=http('GET','/api/admin/report?date='+o['createdAt'][:10]+'&tz=0',c=ck); print('REPORT taxAccepted',rep['orders']['taxAccepted'])
        print('overflow', await g.evaluate('document.documentElement.scrollWidth - innerWidth')); print('errors',errs); await b.close()
asyncio.run(main())
