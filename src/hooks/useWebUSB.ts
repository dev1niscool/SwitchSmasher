/** React state for WebUSB payload transfers. */
import { useState, useCallback, useRef, useEffect } from 'react';
import type { LogEntry, ExecutionState, PayloadManifest, PayloadSelection } from '../types';
import { executePayload, isWebUSBSupported } from '../lib/rcmDevice';
import { fetchPayload, readFileAsArrayBuffer } from '../lib/payloadBuilder';

interface UseWebUSBReturn {
  logs: LogEntry[];
  state: ExecutionState;
  isSupported: boolean;
  execute: (selection: PayloadSelection, manifest: PayloadManifest | null) => Promise<void>;
  clearLogs: () => void;
}

export function useWebUSB(): UseWebUSBReturn {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [state, setState] = useState<ExecutionState>('idle');
  const isSupported = isWebUSBSupported();
  const busy = useRef(false);
  const mounted = useRef(true);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(resetTimer.current);
    };
  }, []);

  const updateState = useCallback((next: ExecutionState) => {
    if (mounted.current) setState(next);
  }, []);

  const addLog = useCallback((message: string, type: LogEntry['type'] = 'info') => {
    if (!mounted.current) return;
    const entry: LogEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
      message, type, timestamp: new Date(),
    };
    setLogs((prev) => [...prev, entry]);
  }, []);

  const clearLogs = useCallback(() => { setLogs([]); }, []);

  const execute = useCallback(async (selection: PayloadSelection, manifest: PayloadManifest | null) => {
    // A ref also blocks a second click before React renders the disabled button.
    if (busy.current) return;
    busy.current = true;
    clearTimeout(resetTimer.current);
    clearLogs();
    updateState('connecting');

    try {
      if (selection.type === 'custom') {
        if (!selection.file) throw new Error('No file selected');
        if (!selection.file.name.toLowerCase().endsWith('.bin')) throw new Error('Choose a .bin payload file');
        if (!selection.file.size) throw new Error('The payload file is empty');
      } else if (!manifest) {
        throw new Error('Payload list is unavailable. Try a custom .bin file or reload the page.');
      }

      // executePayload opens the chooser immediately, before this async loader.
      await executePayload(async () => {
        let payload: Uint8Array;
        if (selection.type === 'custom') {
          addLog(`Loading custom payload: ${selection.file!.name}`, 'info');
          payload = new Uint8Array(await readFileAsArrayBuffer(selection.file!));
        } else {
          const entry = manifest![selection.type];
          const version = selection.version || entry.latest;
          const info = entry.versions.find((item) => item.version === version);
          if (!info) throw new Error(`Version ${version} not found for ${selection.type}`);
          addLog(`Loading ${entry.name} v${version}...`, 'info');
          payload = await fetchPayload(`./payloads/${selection.type}/${info.file}`);
        }
        addLog(`Payload loaded (${payload.byteLength} bytes)`, 'info');
        updateState('sending');
        return payload;
      }, (message, type) => {
        addLog(message, type);
        if (message.startsWith('Triggering')) updateState('triggering');
      });
      updateState('success');
    } catch (error) {
      updateState('error');
      const message = error instanceof Error ? error.message : 'Unknown error occurred';
      addLog(`Error: ${message}`, 'error');
    } finally {
      busy.current = false;
      if (mounted.current) {
        resetTimer.current = setTimeout(() => updateState('idle'), 2000);
      }
    }
  }, [addLog, clearLogs, updateState]);

  return { logs, state, isSupported, execute, clearLogs };
}
