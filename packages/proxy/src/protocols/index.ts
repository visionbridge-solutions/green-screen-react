export { ProtocolHandler } from './types.js';
export type { ProtocolType, ProtocolOptions, ScreenData } from './types.js';
export { TN5250Handler } from './tn5250-handler.js';
export { TN3270Handler } from './tn3270-handler.js';
export { VTHandler } from './vt-handler.js';
export { HP6530Handler } from './hp6530-handler.js';

import { ProtocolHandler } from './types.js';
import type { ProtocolType } from './types.js';
import { TN5250Handler } from './tn5250-handler.js';
import { TN3270Handler } from './tn3270-handler.js';
import { VTHandler } from './vt-handler.js';
import { HP6530Handler } from './hp6530-handler.js';

/**
 * Create a protocol handler for the given protocol type.
 * Throws if the protocol is not yet implemented.
 */
export function createProtocolHandler(protocol: ProtocolType = 'tn5250'): ProtocolHandler {
  switch (protocol) {
    case 'tn5250':
      return new TN5250Handler();
    case 'tn3270':
      return new TN3270Handler();
    case 'vt':
      return new VTHandler();
    case 'hp6530':
      return new HP6530Handler();
    default:
      throw new Error(`Protocol "${protocol}" is not yet implemented. Supported: tn5250, tn3270, vt, hp6530`);
  }
}
