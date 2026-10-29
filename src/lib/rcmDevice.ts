/** WebUSB communication with a Switch in RCM mode. */
import type { USBDevice, USBInTransferResult } from '../types';
import { NVIDIA_VENDOR_ID, RCM_PRODUCT_ID, PACKET_SIZE, VULNERABILITY_LENGTH } from './constants';
import { createRCMPayload, bufferToHex } from './payloadBuilder';

export type LogCallback = (message: string, type?: 'info' | 'success' | 'error' | 'warning') => void;
export type PayloadLoader = () => Promise<Uint8Array>;

export function isWebUSBSupported(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.usb;
}

export async function requestDevice(): Promise<USBDevice> {
  if (!isWebUSBSupported()) {
    throw new Error('WebUSB is not supported in this browser');
  }
  return navigator.usb!.requestDevice({
    filters: [{ vendorId: NVIDIA_VENDOR_ID, productId: RCM_PRODUCT_ID }],
  });
}

async function writePacket(device: USBDevice, data: Uint8Array<ArrayBuffer>): Promise<void> {
  const result = await device.transferOut(1, data);
  if (result.status !== 'ok' || result.bytesWritten !== data.byteLength) {
    throw new Error(`USB write failed (${result.status}, ${result.bytesWritten}/${data.byteLength} bytes)`);
  }
}

async function writePayload(device: USBDevice, data: Uint8Array, log: LogCallback): Promise<number> {
  let writeCount = 0;
  for (let offset = 0; offset < data.length; offset += PACKET_SIZE) {
    const chunk = data.slice(offset, offset + PACKET_SIZE);
    await writePacket(device, chunk);
    writeCount++;
    if (writeCount % 16 === 0) {
      log(`Sending payload... ${Math.round(((offset + chunk.length) / data.length) * 100)}%`, 'info');
    }
  }
  return writeCount;
}

export async function launchPayload(device: USBDevice, payload: Uint8Array, log: LogCallback): Promise<void> {
  // Validate and construct before touching the device. Preserve upstream RCM bytes.
  const rcmPayload = createRCMPayload(payload);
  await device.open();
  if (device.configuration?.configurationValue !== 1) {
    await device.selectConfiguration(1);
  }
  log(`Connected to ${device.manufacturerName || 'Unknown'} ${device.productName || 'Device'}`, 'success');
  await device.claimInterface(0);

  const deviceID = await device.transferIn(1, 16);
  if (deviceID.status !== 'ok' || deviceID.data?.byteLength !== 16) {
    throw new Error('Could not read the RCM device ID. Reconnect your Switch and try again.');
  }
  log(`Device ID: ${bufferToHex(deviceID.data)}`, 'info');
  log('Sending payload...', 'info');
  const writeCount = await writePayload(device, rcmPayload, log);

  // An odd number of packets selects the higher DMA buffer.
  if (writeCount % 2 === 0) {
    log('Switching to higher buffer...', 'info');
    await writePacket(device, new Uint8Array(PACKET_SIZE));
  }
  log('Payload sent!', 'success');
  log('Triggering vulnerability...', 'info');

  // The Switch may disconnect or stop answering after this request. Neither a
  // disconnect nor a timeout proves that the payload actually started.
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race<USBInTransferResult | null>([
      device.controlTransferIn({
        requestType: 'standard', recipient: 'interface', request: 0x00, value: 0x00, index: 0x00,
      }, VULNERABILITY_LENGTH),
      new Promise<null>((resolve) => { timeout = setTimeout(() => resolve(null), 1000); }),
    ]);
    if (!response) {
      log('The device stopped responding after the launch request. Check your Switch.', 'warning');
    } else if (response.status !== 'ok') {
      log(`The launch request returned ${response.status}. Check your Switch before retrying.`, 'warning');
    }
  } catch (error) {
    if (!(error instanceof Error) || error.name !== 'NetworkError') throw error;
    log('The USB connection ended after the launch request. Check your Switch.', 'warning');
  } finally {
    clearTimeout(timeout);
  }
  log('Launch request sent. Check your Switch to confirm the result.', 'info');
}

/**
 * Invoke directly from a click handler. Request the chooser before awaiting the
 * loader so slow downloads cannot consume the browser's user-activation window.
 */
export async function executePayload(payload: Uint8Array | PayloadLoader, log: LogCallback): Promise<void> {
  if (!isWebUSBSupported()) {
    throw new Error('WebUSB is not supported. Please use Chrome, Edge, or Opera on Linux, macOS, Android, or ChromeOS.');
  }
  log('Requesting access to USB device...', 'info');
  const device = await requestDevice();
  try {
    const bytes = typeof payload === 'function' ? await payload() : payload;
    await launchPayload(device, bytes, log);
  } finally {
    try {
      await device.close();
    } catch {
      // Closing a device that disconnected after the request is expected.
    }
  }
}
