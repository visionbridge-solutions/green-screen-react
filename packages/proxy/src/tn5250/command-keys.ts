/**
 * SOH key-mask decoding — the on-the-wire surfacing of the DDS CAnn/CFnn
 * keyword distinction (lib5250 dbuffer.c:193-318).
 *
 * The 5250 Start-of-Header carries, in header bytes 4-6 (0-indexed), a bitmask
 * over the 24 command (function) keys. For each F-key the host enabled:
 *   - bit CLEAR (0) → the key was defined CF (Command Function): pressing it
 *     returns control to the program WITH the modified field data (the typed
 *     input IS transmitted), and
 *   - bit SET (1) → the key was defined CA (Command Attention): pressing it
 *     returns control WITHOUT the modified data — the host silently DISCARDS
 *     whatever the operator just typed.
 * Non-function AID keys (Enter, Page, etc.) always transmit.
 *
 * An integrator that commits typed data with a CA key loses it with no host
 * error (the host never received it). Surfacing the CA set lets the integrator
 * avoid that — prefer Enter / a CF key, or flag the dropped entry.
 *
 * F-key → mask position: F1-F8 → byte 6 (bits 7..0), F9-F16 → byte 5,
 * F17-F24 → byte 4. Matches lib5250 exactly:
 *   ``result = ((header_data[byte] & (0x80 >> bit)) == 0)``.
 */
import { AID, KEY_TO_AID } from './constants.js';

const AID_KEY_MASK: Record<number, [number, number]> = {
  [AID.F1]: [6, 7], [AID.F2]: [6, 6], [AID.F3]: [6, 5], [AID.F4]: [6, 4],
  [AID.F5]: [6, 3], [AID.F6]: [6, 2], [AID.F7]: [6, 1], [AID.F8]: [6, 0],
  [AID.F9]: [5, 7], [AID.F10]: [5, 6], [AID.F11]: [5, 5], [AID.F12]: [5, 4],
  [AID.F13]: [5, 3], [AID.F14]: [5, 2], [AID.F15]: [5, 1], [AID.F16]: [5, 0],
  [AID.F17]: [4, 7], [AID.F18]: [4, 6], [AID.F19]: [4, 5], [AID.F20]: [4, 4],
  [AID.F21]: [4, 3], [AID.F22]: [4, 2], [AID.F23]: [4, 1], [AID.F24]: [4, 0],
};

/**
 * True when pressing ``aidByte`` transmits the screen's modified field data
 * (CF / Enter / any non-function key), false when the host defined it CA. Falls
 * back to ``true`` (transmit) when there is no SOH key mask (header < 7 bytes)
 * or the AID isn't a function key — the safe default that never claims a key
 * drops data without positive evidence.
 */
export function aidTransmitsData(headerData: number[] | undefined, aidByte: number): boolean {
  if (!headerData || headerData.length <= 6) return true;
  const mapping = AID_KEY_MASK[aidByte];
  if (!mapping) return true; // non-F-key AIDs always transmit
  const [byteIdx, bit] = mapping;
  // bit CLEAR = send data (CF); bit SET = don't send (CA)
  return (headerData[byteIdx] & (0x80 >> bit)) === 0;
}

/**
 * The function-key NAMES (e.g. ``["F6", "F12"]``, ascending) the host marked CA
 * on the current screen — pressing any of them will NOT transmit typed input.
 * Empty when no SOH key mask is present (older host frame / display-only
 * screen), in which case the integrator treats every key as transmitting.
 */
export function commandKeysWithoutData(headerData: number[] | undefined): string[] {
  if (!headerData || headerData.length <= 6) return [];
  const out: string[] = [];
  for (const [name, aid] of Object.entries(KEY_TO_AID)) {
    if (aid in AID_KEY_MASK && !aidTransmitsData(headerData, aid)) out.push(name);
  }
  return out.sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
}
