// Components
export { GreenScreenTerminal, TN5250Terminal } from './components/GreenScreenTerminal';
export type { GreenScreenTerminalProps, TN5250TerminalProps } from './components/GreenScreenTerminal';
export { TerminalBootLoader } from './components/TerminalBootLoader';
export type { TerminalBootLoaderProps } from './components/TerminalBootLoader';

// Adapters
export { RestAdapter } from './adapters/RestAdapter';
export type { RestAdapterOptions } from './adapters/RestAdapter';
export type {
  TerminalAdapter,
  TN5250Adapter,
  TerminalProtocol,
  ProtocolProfile,
  ProtocolColorProfile,
  ScreenData,
  ConnectionStatus,
  SendResult,
  Field,
} from './adapters/types';

// Hooks
export { useTypingAnimation } from './hooks/useTypingAnimation';
export {
  useTerminalConnection,
  useTerminalScreen,
  useTerminalInput,
  useTN5250Connection,
  useTN5250Screen,
  useTN5250Terminal,
} from './hooks/useTN5250';

// Protocols
export { getProtocolProfile } from './protocols/registry';
export { tn5250Profile } from './protocols/tn5250';
export { tn3270Profile } from './protocols/tn3270';
export { vtProfile } from './protocols/vt';
export { hp6530Profile } from './protocols/hp6530';

// Utilities
export { positionToRowCol, isFieldEntry } from './utils/grid';
export { getRowColorClass, parseHeaderRow } from './utils/rendering';
