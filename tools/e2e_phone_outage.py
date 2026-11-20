"""Browser tests: phones, slow network, dropped connections, server restart.
Run:  pip install playwright && python tools/e2e_phone_outage.py
Starts its own server on port 3997 with a temp data folder."""
import asyncio, json, os, signal, subprocess, sys, tempfile, time, urllib.request
from playwright.async_api import async_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = 3997; B = f'http://127.0.0.1:{PORT}'
DATA = tempfile.mkdtemp(prefix='mos-e2e-')
ENV = {**os.environ, 'PORT': str(PORT), 'DATA_DIR': DATA, 'ADMIN_PIN': '9001', 'STAFF_PIN': '9002', 'KITCHEN_PIN': '9003'}
results = []

def start():
    p = subprocess.Popen(['node', 'server.js'], cwd=ROOT, env=ENV, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(80):
        try: urllib.request.urlopen(B + '/healthz'); return p
        except Exception: time.sleep(0.1)
    raise RuntimeError('server did not start')

def check(name, ok, info=''):
    results.append((name, bool(ok), info)); print(('PASS ' if ok else 'FAIL ') + name + (f'  ({info})' if info else ''))

def http(method, path, body=None, cookie=None):
    req = urllib.request.Request(B + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={'content-type': 'application/json', **({'cookie': cookie} if cookie else {})})
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read() or b'{}'), (r.headers.get('set-cookie') or '').split(';')[0]

PHONES = {
    'iPhone 13 (Safari size, Chromium engine)': dict(viewport={'width': 390, 'height': 844}, device_scale_factor=3, is_mobile=True, has_touch=True,
        user_agent='Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'),
    'Low-end Android 360px': dict(viewport={'width': 360, 'height': 640}, device_scale_factor=2, is_mobile=True, has_touch=True,
        user_agent='Mozilla/5.0 (Linux; Android 10; SM-A105F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36'),
}

async def main():
    srv = start()
    try:
        _, admin = http('POST', '/api/login', {'pin': '9001'})
        tables = http('GET', '/api/admin/tables', cookie=admin)[0]['tables']
        url = lambda i: tables[i]['url']
        orders_for = lambda tid: [o for o in http('GET', '/api/state', cookie=admin)[0]['orders'] if o['tableId'] == tid]

        async with async_playwright() as pw:
            br = await pw.chromium.launch()
            # 1. Phones on slow 3G, all three languages
            for i, (name, opts) in enumerate(PHONES.items()):
                ctx = await br.new_context(**opts); pg = await ctx.new_page()
                errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
                cdp = await ctx.new_cdp_session(pg)
                await cdp.send('Network.emulateNetworkConditions', {'offline': False, 'latency': 400, 'downloadThroughput': 50000, 'uploadThroughput': 20000})
                t0 = time.time(); await pg.goto(url(i)); await pg.wait_for_selector('.item'); load = time.time() - t0
                check(f'{name}: menu loads on slow 3G', load < 8, f'{load:.1f}s')
                for lang in ['دری', 'پښتو', 'EN']:
                    await pg.click(f'#langs >> text={lang}')
                    over = await pg.evaluate('document.documentElement.scrollWidth - window.innerWidth')
                    check(f'{name}: no sideways scrolling in {lang}', over <= 1, f'overflow {over}px')
                small = await pg.evaluate("""[...document.querySelectorAll('button')].filter(b=>b.offsetParent && b.getBoundingClientRect().height<36).map(b=>b.textContent.trim()).slice(0,5)""")
                check(f'{name}: buttons big enough to tap (>=36px)', not small, ','.join(small))
                await pg.click('.item >> nth=0 >> button.primary')
                if await pg.query_selector('.sheet'): await pg.click('.sheet button.primary')
                await pg.click('text=Review order'); await pg.click('text=Send order')
                await pg.wait_for_selector('.pill', timeout=15000)
                check(f'{name}: order sent and status shown', len(orders_for(tables[i]['id'])) == 1)
                check(f'{name}: no script errors', not errs, '; '.join(errs)[:120])
                await ctx.close()

            # 2. Phone offline when guest presses Send, then back online
            ctx = await br.new_context(**PHONES['Low-end Android 360px']); pg = await ctx.new_page()
            await pg.goto(url(2)); await pg.wait_for_selector('.item')
            await pg.click('text=Main dishes'); await pg.click('.item >> nth=0 >> button.primary')
            await pg.click('text=Review order')
            await ctx.set_offline(True); await pg.click('text=Send order'); await pg.wait_for_timeout(800)
            check('Offline send: guest told it was not sent, cart kept', await pg.is_visible('text=Send order') and len(orders_for(tables[2]['id'])) == 0)
            await ctx.set_offline(False); await pg.click('text=Send order'); await pg.wait_for_selector('.pill')
            check('Offline send: retry after reconnect creates exactly 1 order', len(orders_for(tables[2]['id'])) == 1)
            await ctx.close()

            # 3. Order reaches the server but the reply is lost (worst case), guest presses Send again
            ctx = await br.new_context(**PHONES['Low-end Android 360px']); pg = await ctx.new_page()
            state = {'n': 0}
            async def lose_reply(route):
                state['n'] += 1
                if state['n'] == 1:
                    await route.fetch(); await route.abort('connectionreset')   # server got it, phone did not
                else:
                    await route.continue_()
            await pg.route('**/orders', lambda r: asyncio.ensure_future(lose_reply(r)) if r.request.method == 'POST' else asyncio.ensure_future(r.continue_()))
            await pg.goto(url(3)); await pg.wait_for_selector('.item')
            await pg.click('.item >> nth=1 >> button.primary'); await pg.click('text=Review order')
            await pg.click('text=Send order'); await pg.wait_for_timeout(800)
            await pg.click('text=Send order'); await pg.wait_for_selector('.pill')
            n = len(orders_for(tables[3]['id']))
            check('Lost reply + guest retries: kitchen gets exactly 1 order (no duplicate)', n == 1, f'{n} orders')
            await ctx.close()

            # 4. Server restart in the middle of service
            kctx = await br.new_context(viewport={'width': 1280, 'height': 800}); kpg = await kctx.new_page()
            await kpg.goto(B + '/login'); await kpg.fill('#pin', '9003'); await kpg.click('button.primary'); await kpg.wait_for_url('**/kitchen')
            before = len(http('GET', '/api/state', cookie=admin)[0]['orders'])
            srv.send_signal(signal.SIGTERM); srv.wait(timeout=5)
            await kpg.wait_for_timeout(1500)
            check('Server down: kitchen screen shows "reconnecting"', 'reconnecting' in (await kpg.text_content('#conn') or ''))
            srv = start()
            after = len(http('GET', '/api/state', cookie=admin)[0]['orders'])
            check('Server restart: all orders still there', after == before, f'{before} -> {after}')
            # accept a pending order, kitchen must show it after reconnect without reload
            pend = [o for o in http('GET', '/api/state', cookie=admin)[0]['orders'] if o['status'] == 'PendingApproval'][0]
            http('POST', f"/api/orders/{pend['id']}/status", {'to': 'Accepted'}, admin)
            try: await kpg.wait_for_selector(f"text=#{pend['no']}", timeout=8000); ok = True
            except Exception: ok = False
            check('After restart: kitchen reconnects and shows new ticket without reload', ok)
            await br.close()
    finally:
        srv.terminate()
    failed = [r for r in results if not r[1]]
    print(f'\n{len(results) - len(failed)}/{len(results)} passed')
    sys.exit(1 if failed else 0)

asyncio.run(main())
