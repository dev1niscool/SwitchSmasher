#!/usr/bin/env python3
"""Browser smoke checks. Requires Python Playwright and Chromium (no USB hardware).

Run a local server, then:
  python tests/browser-smoke.py http://127.0.0.1:5173/SwitchSmasher/
Optional screenshot: --screenshot /tmp/switch-smasher.png
"""
import argparse
import json
import re
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('url')
parser.add_argument('--screenshot')
parser.add_argument('--chromium', default='/usr/bin/chromium')
args = parser.parse_args()

MOCK_USB = r'''
window.usbEvents = [];
window.usbMode = MODE;
const originalFetch = window.fetch.bind(window);
window.fetch = (...args) => {
  window.usbEvents.push(['fetch', String(args[0])]);
  return originalFetch(...args);
};
const device = {
  configuration: null,
  manufacturerName: 'Nintendo', productName: 'APX',
  async open() { window.usbEvents.push(['open']); },
  async selectConfiguration(value) {
    window.usbEvents.push(['configure', value]);
    this.configuration = { configurationValue: value };
  },
  async claimInterface(value) { window.usbEvents.push(['claim', value]); },
  async releaseInterface(value) { window.usbEvents.push(['release', value]); },
  async transferIn(endpoint, length) {
    window.usbEvents.push(['read', endpoint, length]);
    return {status:'ok', data: new DataView(new ArrayBuffer(length))};
  },
  async transferOut(endpoint, data) {
    window.usbEvents.push(['write', endpoint, data.byteLength]);
    if (window.usbMode === 'failure') return { status:'stall', bytesWritten:0 };
    return { status:'ok', bytesWritten:data.byteLength };
  },
  async controlTransferIn(setup, length) {
    window.usbEvents.push(['trigger', setup, length]);
    throw new DOMException('Device disconnected', 'NetworkError');
  },
  async close() { window.usbEvents.push(['close']); }
};
Object.defineProperty(navigator, 'usb', {configurable:true, value: {
  async requestDevice(options) {
    window.usbEvents.push(['request', options, navigator.userActivation.isActive]);
    if (window.usbMode === 'cancel') throw new DOMException('No device selected', 'NotFoundError');
    return device;
  },
  async getDevices() { return []; }
}});
'''

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=args.chromium, headless=True, args=['--no-sandbox'])
    errors = []

    def page_for(mode='happy', viewport=None, no_usb=False, manifest_failure=False):
        page = browser.new_page(viewport=viewport or {'width':1280,'height':1000})
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('console', lambda message: errors.append(message.text) if message.type == 'error' and not (manifest_failure and 'Failed to load resource' in message.text) else None)
        page.on('requestfailed', lambda request: errors.append(f'Failed request: {request.url}'))
        page.on('response', lambda response: errors.append(f'HTTP {response.status}: {response.url}') if response.status >= 400 and not (manifest_failure and response.url.endswith('payloads/manifest.json')) else None)
        if no_usb:
            page.add_init_script("Object.defineProperty(navigator, 'usb', {value:undefined,configurable:true});")
        else:
            page.add_init_script(MOCK_USB.replace('MODE', json.dumps(mode)))
        if manifest_failure:
            page.route('**/payloads/manifest.json', lambda route: route.fulfill(status=503, body='Unavailable'))
        page.goto(args.url)
        expect(page.get_by_role('heading', name='Switch Smasher', exact=True)).to_be_visible()
        return page

    page = page_for()
    manifest = page.request.get(args.url + 'payloads/manifest.json').json()
    hekate_latest = manifest['hekate']['latest']
    fusee_latest = manifest['fusee']['latest']
    hekate_previous = next(item for item in manifest['hekate']['versions'] if item['version'] != hekate_latest)
    def release_url(kind, version):
        return next(item['url'] for item in manifest[kind]['versions'] if item['version'] == version)
    expect(page).to_have_title('Switch Smasher')
    assert page.locator('header p').count() == 0, 'Subtitle must be removed'
    footer = page.get_by_text('Current Hekate on Switch: Hekate 6.5.4', exact=True)
    expect(footer).to_be_visible()
    assert 'text-gray-400' in footer.get_attribute('class')
    assert page.get_by_role('link', name='Source Code').get_attribute('href') == 'https://github.com/dev1niscool/SwitchSmasher'
    expect(page.get_by_label('Hekate version')).to_have_value(hekate_latest)
    assert page.get_by_role('link',name='Release notes').get_attribute('href') == release_url('hekate', hekate_latest)
    page.get_by_label('Hekate version').select_option(hekate_previous['version'])
    assert page.get_by_role('link',name='Release notes').get_attribute('href') == hekate_previous['url']
    page.reload()
    expect(page.get_by_label('Hekate version')).to_have_value(hekate_previous['version'])
    page.get_by_role('radio', name=re.compile('Atmosphere')).check()
    expect(page.get_by_label('Atmosphere version')).to_have_value(fusee_latest)
    assert page.get_by_role('link',name='Release notes').get_attribute('href') == release_url('fusee', fusee_latest)
    page.reload()
    expect(page.get_by_label('Atmosphere version')).to_have_value(fusee_latest)
    page.get_by_role('radio', name=re.compile('Custom')).check()
    launch = page.get_by_role('button',name='Launch Payload', exact=True)
    expect(launch).to_be_disabled()
    page.get_by_label('Custom Payload File').set_input_files({'name':'test.bin','mimeType':'application/octet-stream','buffer':b'1234'})
    expect(launch).to_be_enabled()
    page.get_by_role('button',name='Clear file').click()
    expect(launch).to_be_disabled()
    page.get_by_role('radio',name=re.compile('Hekate')).check()
    page.get_by_label('Instructions',exact=True).check()
    expect(page.get_by_text('Enter RCM Mode',exact=True)).to_be_visible()
    page.get_by_label('Instructions',exact=True).uncheck()
    if args.screenshot:
        page.screenshot(path=args.screenshot, full_page=True, animations="disabled")
    manifest = page.request.get(args.url + 'payloads/manifest.json').json()
    for kind in ('hekate', 'fusee'):
        for version in manifest[kind]['versions']:
            response = page.request.get(args.url + f'payloads/{kind}/' + version['file'])
            assert response.ok and len(response.body()) > 0, f"Missing payload: {version['file']}"
    print('PASS: branding, footer, version/release links, persistence, custom selection, instructions, all bundled payload downloads')
    page.close()

    page = page_for()
    page.get_by_role('button',name='Launch Payload', exact=True).click()
    expect(page.get_by_role('log')).to_contain_text('Launch request sent. Check your Switch to confirm the result.')
    events = page.evaluate('window.usbEvents')
    names = [event[0] for event in events]
    request = next(event for event in events if event[0]=='request')
    assert request[1] == {'filters':[{'vendorId':0x0955,'productId':0x7321}]}
    assert request[2] is True, 'Chooser must run during user activation'
    payload_fetch = next(i for i,event in enumerate(events) if event[0]=='fetch' and str(event[1]).endswith('.bin'))
    assert names.index('request') < payload_fetch < names.index('open') < names.index('configure') < names.index('claim') < names.index('read') < names.index('write') < names.index('trigger') < names.index('close')
    assert all(event[2]==4096 for event in events if event[0]=='write')
    assert next(event for event in events if event[0]=='trigger')[2] == 0x7000
    page.close()
    print('PASS: USB chooser activation, APX filter, payload download, configuration, packet transfer, trigger, cleanup')

    page = page_for('cancel')
    page.get_by_role('button',name='Launch Payload', exact=True).click()
    expect(page.get_by_role('button',name='Failed - Try Again')).to_be_enabled()
    assert page.evaluate("window.usbEvents.filter(e => e[0] === 'open').length") == 0
    page.evaluate("window.usbMode='happy'")
    page.get_by_role('button',name='Failed - Try Again').click()
    expect(page.get_by_role('log')).to_contain_text('Launch request sent.')
    assert page.evaluate("window.usbEvents.filter(e => e[0] === 'request').length") == 2
    page.close()
    print('PASS: chooser cancellation and immediate retry')

    page = page_for('failure')
    page.get_by_role('button',name='Launch Payload', exact=True).click()
    expect(page.get_by_role('button',name='Failed - Try Again')).to_be_enabled()
    assert page.evaluate("window.usbEvents.filter(e => e[0] === 'trigger').length") == 0
    assert page.evaluate("window.usbEvents.filter(e => e[0] === 'close').length") == 1
    page.close()
    print('PASS: stalled write fails without triggering and closes device')

    page = page_for()
    page.get_by_role('radio', name=re.compile('Custom')).check()
    page.get_by_label('Custom Payload File').set_input_files({'name':'empty.bin','mimeType':'application/octet-stream','buffer':b''})
    page.get_by_role('button',name='Launch Payload',exact=True).click()
    expect(page.get_by_role('log')).to_contain_text('The payload file is empty')
    assert page.evaluate("window.usbEvents.filter(e => e[0] === 'request').length") == 0
    page.get_by_label('Custom Payload File').set_input_files({'name':'test.txt','mimeType':'text/plain','buffer':b'invalid'})
    page.get_by_role('button',name='Failed - Try Again').click()
    expect(page.get_by_role('log')).to_contain_text('Choose a .bin payload file')
    assert page.evaluate("window.usbEvents.filter(e => e[0] === 'request').length") == 0
    page.get_by_label('Custom Payload File').set_input_files({'name':'test.bin','mimeType':'application/octet-stream','buffer':b'1234'})
    page.get_by_role('button',name='Failed - Try Again').click()
    expect(page.get_by_role('log')).to_contain_text('Launch request sent.')
    page.close()
    print('PASS: empty/non-bin rejection and valid custom launch')

    page = page_for(manifest_failure=True)
    expect(page.get_by_text('Failed to load payload manifest:', exact=False)).to_be_visible()
    expect(page.get_by_role('button',name='Launch Payload',exact=True)).to_be_disabled()
    page.get_by_role('radio', name=re.compile('Custom')).check()
    page.get_by_label('Custom Payload File').set_input_files({'name':'test.bin','mimeType':'application/octet-stream','buffer':b'1234'})
    page.get_by_role('button',name='Launch Payload',exact=True).click()
    expect(page.get_by_role('log')).to_contain_text('Launch request sent.')
    page.close()
    print('PASS: custom launch remains available when manifest fails')

    page = page_for(no_usb=True)
    expect(page.get_by_text('WebUSB Not Supported',exact=True)).to_be_visible()
    expect(page.get_by_role('button',name='Launch Payload',exact=True)).to_be_disabled()
    page.close()
    print('PASS: unsupported browser')

    page = page_for(viewport={'width':390,'height':844})
    expect(page.get_by_label('Hekate version')).to_be_visible()
    assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), 'Mobile page overflows'
    if args.screenshot:
        target = Path(args.screenshot)
        page.screenshot(path=str(target.with_name(target.stem+'-mobile'+target.suffix)), full_page=True, animations='disabled')
    page.close()
    print('PASS: mobile layout')

    assert not errors, f'Browser runtime errors: {errors}'
    browser.close()
    print('All browser checks passed; USB was simulated, not tested on physical hardware.')
