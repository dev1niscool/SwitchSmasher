import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createRCMPayload, bufferToHex, fetchPayload } from '../src/lib/payloadBuilder';
import { executePayload, launchPayload, requestDevice } from '../src/lib/rcmDevice';
import { INTERMEZZO } from '../src/lib/constants';
import type { USBDevice, USBDeviceRequestOptions } from '../src/types';

function fakeDevice() {
  const calls: string[] = [];
  const packets: Uint8Array[] = [];
  const device: USBDevice = {
    configuration: null,
    async open() { calls.push('open'); },
    async close() { calls.push('close'); },
    async selectConfiguration(value) {
      calls.push(`configure:${value}`);
      device.configuration = { configurationValue: value };
    },
    async claimInterface(value) { calls.push(`claim:${value}`); },
    async releaseInterface() {},
    async transferIn(endpoint, size) {
      calls.push(`read:${endpoint}:${size}`);
      return { status: 'ok', data: new DataView(new ArrayBuffer(size)) };
    },
    async transferOut(endpoint, data) {
      calls.push(`write:${endpoint}`);
      const bytes = ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data);
      packets.push(bytes.slice());
      return { status: 'ok', bytesWritten: data.byteLength };
    },
    async controlTransferIn(setup, size) {
      calls.push('trigger');
      assert.deepEqual(setup, { requestType: 'standard', recipient: 'interface', request: 0, value: 0, index: 0 });
      assert.equal(size, 0x7000);
      return { status: 'ok' };
    },
  };
  return { device, calls, packets };
}

function mockUSB(t: TestContext, request: (options: USBDeviceRequestOptions) => Promise<USBDevice>) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { usb: { requestDevice: request } } });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'navigator', original);
    else Reflect.deleteProperty(globalThis, 'navigator');
  });
}

const noLog = () => {};

test('RCM packet preserves header, addresses, intermezzo, payload and zero padding', () => {
  const payload = Uint8Array.from([0x12, 0x34, 0xab, 0xcd]);
  const bytes = createRCMPayload(payload);
  const view = new DataView(bytes.buffer);
  assert.equal(bytes.length % 0x1000, 0);
  assert.equal(view.getUint32(0, true), 0x30298);
  assert.ok(bytes.slice(4, 0x2a8).every((value) => value === 0));
  for (let offset = 0x2a8; offset < 0xf2a8; offset += 4) {
    assert.equal(view.getUint32(offset, true), 0x4001f000);
  }
  assert.deepEqual(bytes.slice(0xf2a8, 0xf2a8 + INTERMEZZO.length), INTERMEZZO);
  assert.deepEqual(bytes.slice(0x102a8, 0x102a8 + payload.length), payload);
  assert.ok(bytes.slice(0x102a8 + payload.length).every((value) => value === 0));
  assert.throws(() => createRCMPayload(new Uint8Array()), /empty/);
});

test('hex output respects DataView offset and length', () => {
  const bytes = Uint8Array.from([0xff, 0x00, 0x0a, 0x80, 0xff]);
  assert.equal(bufferToHex(new DataView(bytes.buffer, 1, 3)), '000a80');
});

test('device chooser is restricted to the Switch APX identifier', async (t) => {
  const { device } = fakeDevice();
  mockUSB(t, async (options) => {
    assert.deepEqual(options.filters, [{ vendorId: 0x0955, productId: 0x7321 }]);
    return device;
  });
  assert.equal(await requestDevice(), device);
});

test('chooser opens immediately before an asynchronous payload loader; cleanup closes device', async (t) => {
  const { device, calls } = fakeDevice();
  mockUSB(t, async () => { calls.push('chooser'); return device; });
  const pending = executePayload(async () => { calls.push('load'); return new Uint8Array([42]); }, noLog);
  assert.deepEqual(calls, ['chooser']);
  await pending;
  assert.deepEqual(calls.slice(0, 6), ['chooser', 'load', 'open', 'configure:1', 'claim:0', 'read:1:16']);
  assert.deepEqual(calls.slice(-2), ['trigger', 'close']);
});

test('cancelled chooser never loads or opens a device', async (t) => {
  let loaded = false;
  mockUSB(t, async () => { throw new DOMException('No device selected', 'NotFoundError'); });
  await assert.rejects(executePayload(async () => { loaded = true; return new Uint8Array([1]); }, noLog), /No device/);
  assert.equal(loaded, false);
});

test('failed payload loading still closes the selected device', async (t) => {
  const { device, calls } = fakeDevice();
  mockUSB(t, async () => device);
  await assert.rejects(executePayload(async () => { throw new Error('download failed'); }, noLog), /download failed/);
  assert.deepEqual(calls, ['close']);
});

test('configuration is reused and packet count is always odd before triggering', async () => {
  for (const size of [1, 4096]) {
    const { device, calls, packets } = fakeDevice();
    device.configuration = { configurationValue: 1 };
    const payload = new Uint8Array(size).fill(0x42);
    const expected = createRCMPayload(payload);
    await launchPayload(device, payload, noLog);
    assert.ok(!calls.includes('configure:1'));
    assert.equal(packets.length % 2, 1);
    assert.deepEqual(Buffer.concat(packets).subarray(0, expected.length), Buffer.from(expected));
    assert.ok(packets.every((packet) => packet.length === 0x1000));
    if (expected.length / 0x1000 % 2 === 0) {
      assert.ok(packets.at(-1)!.every((value) => value === 0));
    }
  }
});

for (const failure of ['stall', 'short', 'padding'] as const) {
  test(`${failure} write stops before trigger and closes the connection`, async (t) => {
    const { device, calls } = fakeDevice();
    const payload = new Uint8Array(4096);
    const count = createRCMPayload(payload).length / 4096;
    let writes = 0;
    device.transferOut = async (_endpoint, data) => {
      writes++;
      if (failure === 'padding' && writes <= count) return { status: 'ok', bytesWritten: data.byteLength };
      return { status: failure === 'short' ? 'ok' : 'stall', bytesWritten: failure === 'short' ? 1 : 0 };
    };
    mockUSB(t, async () => device);
    await assert.rejects(executePayload(payload, noLog), /USB write failed/);
    assert.ok(!calls.includes('trigger'));
    assert.equal(calls.at(-1), 'close');
  });
}

test('failed device ID read prevents writes', async () => {
  const { device, packets } = fakeDevice();
  device.transferIn = async () => ({ status: 'stall' });
  await assert.rejects(launchPayload(device, new Uint8Array([1]), noLog), /device ID/);
  assert.equal(packets.length, 0);
});

test('expected trigger disconnect is reported without claiming hardware success', async () => {
  const { device } = fakeDevice();
  const logs: string[] = [];
  device.controlTransferIn = async () => { throw new DOMException('disconnected', 'NetworkError'); };
  await launchPayload(device, new Uint8Array([1]), (message) => logs.push(message));
  assert.ok(logs.some((message) => message.includes('Check your Switch')));
  assert.ok(logs.every((message) => !message.includes('successfully')));
});

test('unexpected trigger security errors propagate and cleanup runs', async (t) => {
  const { device, calls } = fakeDevice();
  device.controlTransferIn = async () => { throw new DOMException('blocked', 'SecurityError'); };
  mockUSB(t, async () => device);
  await assert.rejects(executePayload(new Uint8Array([1]), noLog), /blocked/);
  assert.equal(calls.at(-1), 'close');
});

test('HTTP failure does not get treated as a binary payload', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('missing', { status: 404, statusText: 'Not Found' }));
  await assert.rejects(fetchPayload('/missing.bin'), /Not Found/);
});
