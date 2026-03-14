import type { TerminalProtocol, ProtocolProfile } from '../adapters/types';
import { tn5250Profile } from './tn5250';
import { tn3270Profile } from './tn3270';
import { vtProfile } from './vt';
import { hp6530Profile } from './hp6530';

const profiles: Record<TerminalProtocol, ProtocolProfile> = {
  tn5250: tn5250Profile,
  tn3270: tn3270Profile,
  vt: vtProfile,
  hp6530: hp6530Profile,
};

/**
 * Get a protocol profile by type. Defaults to TN5250 for backward compatibility.
 */
export function getProtocolProfile(protocol?: TerminalProtocol): ProtocolProfile {
  return profiles[protocol || 'tn5250'];
}
