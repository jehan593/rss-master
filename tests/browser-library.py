"""Optional UI checks: PYTHONPATH must include playwright; uses mocked account data."""
import functools
import http.server
import pathlib
import os
import threading
from playwright.sync_api import sync_playwright

root = pathlib.Path(__file__).resolve().parent.parent
server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(root)))
threading.Thread(target=server.serve_forever, daemon=True).start()
mock = '''window.__rpc=[]; window.__feeds=[]; window.__folders=[];
window.supabase={createClient:()=>({auth:{getSession:async()=>({data:{session:null}}),onAuthStateChange:()=>{}},
from:(table)=>{const q={select:()=>q,eq:()=>q,order:()=>q,range:()=>q,then:(resolve)=>Promise.resolve({data:table==='feeds'?window.__feeds:table==='folders'?window.__folders:[],error:null}).then(resolve)};return q;},
rpc:async(name,args)=>{if(args.item_kind==='folder' && args.new_url!==null) return {error:{message:'Enter an HTTP(S) feed URL'}};window.__rpc.push({name,args}); return {error:null};}})};'''
try:
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ.get('RSS_TEST_BROWSER'))
        for width, mobile in [(1280, False), (390, True), (320, True)]:
            context = browser.new_context(viewport={'width':width,'height':850}, is_mobile=mobile, has_touch=mobile)
            page = context.new_page()
            errors=[]
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.route('https://cdn.jsdelivr.net/**', lambda route: route.fulfill(content_type='application/javascript', body=mock))
            page.goto(f'http://127.0.0.1:{server.server_port}')
            page.wait_for_function("document.getElementById('library-tree').children.length > 0")
            fixture = '''() => {
              session={user:{id:'test-user'}};
              folders=window.__folders=[{id:'folder-a',name:'Technology',parent_id:null,position:0},{id:'folder-b',name:'Nested',parent_id:'folder-a',position:1}];
              feeds=window.__feeds=[{id:'feed-a',title:'Example feed',url:'https://example.com/rss',folder_id:'folder-b',position:2},{id:'feed-b',title:'Root feed',url:'https://example.org/rss',folder_id:null,position:3}];
              articles=[{id:'article-a',feed_id:'feed-a',guid:'a',title:'Nested article',published_at:new Date().toISOString()}];
              renderFeedSidebar();renderArticles();
            }'''
            page.evaluate(fixture)
            if mobile:
                assert not page.locator('#navigation-sidebar').is_visible()
                page.locator('#mobile-library-btn').click()
            assert page.locator('#navigation-sidebar').is_visible()
            assert page.locator('#current-feed-label').evaluate('el=>el.tagName') == 'H2'
            assert page.locator('#feed-switcher-btn').count() == 0
            assert page.locator('#library-tree .feed-color-dot').count() == 0
            assert page.locator('[data-id="feed-a"] .library-item-icon').evaluate("el=>el.style.color.length > 0")
            if mobile:
                assert page.evaluate('document.activeElement.id') == 'sidebar-close-btn'
                assert not page.locator('#library-search').evaluate('el=>el===document.activeElement')
            assert float(page.locator('#navigation-sidebar').evaluate("el=>getComputedStyle(el).fontSize.replace('px','')")) == 11
            if not mobile:
                assert page.locator('#navigation-sidebar').bounding_box()['width'] >= 300
            parent_label = page.locator('[data-id="folder-a"] .fs-name').bounding_box()
            child_label = page.locator('[data-id="folder-b"] .fs-name').bounding_box()
            feed_label = page.locator('[data-id="feed-a"] .fs-name').bounding_box()
            assert child_label['x'] > parent_label['x']
            assert feed_label['x'] > child_label['x']
            row = page.locator('[data-id="folder-a"]')
            assert row.bounding_box()['height'] <= (36 if mobile else 28)
            assert row.locator('.folder-toggle').evaluate("el=>getComputedStyle(el).borderTopStyle") == 'solid'
            assert page.locator('.tabs-wrap').count() == 0
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            page.locator('[data-id="folder-a"] .library-select').click()
            assert page.locator('#articles-list').inner_text().find('Nested article') >= 0
            if mobile:
                assert not page.locator('#navigation-sidebar').is_visible()
                page.locator('#mobile-library-btn').click()
            row=page.locator('[data-id="feed-a"]')
            if mobile:
                row.locator('.library-more').click()
            else:
                row.click(button='right')
            page.get_by_role('menuitem', name='Edit', exact=True).click()
            assert page.locator('#library-url').input_value() == 'https://example.com/rss'
            page.locator('#library-name').fill('Updated feed')
            assert not page.locator('#library-parent').is_visible()
            assert page.locator('#library-before').count() == 0
            page.locator('#library-save').click()
            page.wait_for_function('window.__rpc.length === 1')
            assert page.evaluate('window.__rpc[0].args.destination') == 'folder-b'
            assert page.evaluate('window.__rpc[0].args.new_name') == 'Updated feed'
            if mobile:
                page.locator('#mobile-library-btn').click()
            page.locator('[data-id="folder-a"] .library-more').click()
            page.get_by_role('menuitem', name='Rename', exact=True).click()
            assert not page.locator('#library-parent').is_visible()
            assert page.locator('#library-parent option[value="folder-a"]').count() == 0
            assert page.locator('#library-parent option[value="folder-b"]').count() == 0
            page.keyboard.press('Escape')
            if mobile:
                page.locator('#mobile-library-btn').click()
                source = page.locator('[data-id="feed-b"] .library-drag-handle').bounding_box()
                target = page.locator('[data-id="folder-b"]').bounding_box()
                cdp = context.new_cdp_session(page)
                x, y = source['x'] + source['width']/2, source['y'] + source['height']/2
                tx, ty = target['x'] + target['width']/2, target['y'] + target['height']/2
                cdp.send('Input.dispatchTouchEvent', {'type':'touchStart','touchPoints':[{'x':x,'y':y}]})
                for step in range(1,6):
                    cdp.send('Input.dispatchTouchEvent', {'type':'touchMove','touchPoints':[{'x':x+(tx-x)*step/5,'y':y+(ty-y)*step/5}]})
                cdp.send('Input.dispatchTouchEvent', {'type':'touchEnd','touchPoints':[]})
                page.wait_for_function('window.__rpc.length === 2')
                assert page.evaluate('window.__rpc[1].args.destination') == 'folder-b'
                page.locator('#navigation-sidebar').get_by_role('button', name='Settings').click()
                page.locator('#mobile-library-btn').click()
                assert page.locator('#navigation-sidebar').is_visible()
            else:
                page.locator('[data-id="feed-b"]').drag_to(page.locator('[data-id="folder-b"]'))
                page.wait_for_function('window.__rpc.length === 2')
                assert page.evaluate('window.__rpc[1].args.destination') == 'folder-b'
            page.locator('#navigation-sidebar').get_by_role('button', name='Create folder', exact=True).click()
            assert not page.locator('#library-url').is_visible()
            assert page.locator('#library-before').count() == 0
            page.locator('#library-name').fill('New folder')
            page.locator('#library-save').click()
            page.wait_for_function('window.__rpc.length === 3')
            assert page.evaluate('window.__rpc[2].args.new_url') is None
            assert page.locator('#library-modal-backdrop').is_hidden()
            if mobile:
                page.locator('#mobile-library-btn').click()
            page.locator('[data-id="feed-a"] .library-more').click()
            page.get_by_role('menuitem', name='Move to folder…', exact=True).click()
            assert not page.locator('#library-name').is_visible()
            assert not page.locator('#library-url').is_visible()
            page.locator('#library-parent').select_option('')
            page.locator('#library-save').click()
            page.wait_for_function('window.__rpc.length === 4')
            assert page.evaluate('window.__rpc[3].args.destination') is None
            assert page.evaluate('window.__rpc[3].args.new_url') is None
            if mobile:
                page.locator('#mobile-library-btn').click()
            page.locator('#navigation-sidebar').get_by_role('button', name='Add feed', exact=True).click()
            assert page.locator('#add-feed-modal-backdrop').is_visible()
            assert page.locator('#section-feeds').count() == 0
            assert page.locator('#new-feed-folder').is_visible()
            page.keyboard.press('Escape')
            if mobile:
                page.locator('#mobile-library-btn').click()
            page.locator('#navigation-sidebar').get_by_role('button', name='Settings').click()
            assert page.locator('#section-settings').get_by_role('button', name='Import OPML').is_visible()
            assert page.locator('#navigation-sidebar').get_by_role('button', name='Import / export').count() == 0
            if mobile:
                page.locator('#mobile-library-btn').click()
                source = page.locator('[data-id="folder-a"] .library-drag-handle').bounding_box()
                target = page.locator('[data-id="feed-b"]').bounding_box()
                x, y = source['x'] + source['width']/2, source['y'] + source['height']/2
                tx, ty = target['x'] + target['width']/2, target['y'] + 3
                cdp.send('Input.dispatchTouchEvent', {'type':'touchStart','touchPoints':[{'x':x,'y':y}]})
                for step in range(1,6):
                    cdp.send('Input.dispatchTouchEvent', {'type':'touchMove','touchPoints':[{'x':x+(tx-x)*step/5,'y':y+(ty-y)*step/5}]})
                cdp.send('Input.dispatchTouchEvent', {'type':'touchEnd','touchPoints':[]})
            else:
                target = page.locator('[data-id="feed-b"]').bounding_box()
                page.locator('[data-id="folder-a"]').drag_to(page.locator('[data-id="feed-b"]'), target_position={'x':target['width']/2,'y':3})
            page.wait_for_function('window.__rpc.length === 5')
            assert page.evaluate('window.__rpc[4].args.item_kind') == 'folder'
            assert page.evaluate('window.__rpc[4].args.destination') is None
            assert page.evaluate('window.__rpc[4].args.before_id') == 'feed-b'
            page.locator('[data-id="folder-a"] .folder-toggle').click()
            assert page.locator('[data-id="folder-b"]').count() == 0
            page.reload()
            page.wait_for_function("document.getElementById('library-tree').children.length > 0")
            page.evaluate(fixture)
            if mobile:
                page.locator('#mobile-library-btn').click()
            assert page.locator('[data-id="folder-a"] .folder-toggle').get_attribute('aria-expanded') == 'false'
            assert page.locator('[data-id="folder-b"]').count() == 0
            page.locator('[data-id="folder-a"] .folder-toggle').click()
            page.reload()
            page.wait_for_function("document.getElementById('library-tree').children.length > 0")
            page.evaluate(fixture)
            assert page.locator('[data-id="folder-a"] .folder-toggle').get_attribute('aria-expanded') == 'true'
            assert page.locator('[data-id="folder-b"]').count() == 1
            assert not errors, errors
            print(f'PASS library UI at {width}px (mobile={mobile})')
            context.close()
        browser.close()
finally:
    server.shutdown()
