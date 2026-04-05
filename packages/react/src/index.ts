// Components
export { GreenScreenTerminal } from './components/GreenScreenTerminal';
export type { GreenScreenTerminalProps } from './components/GreenScreenTerminal';
export { TerminalBootLoader } from './components/TerminalBootLoader';
export type { TerminalBootLoaderProps } from './components/TerminalBootLoader';
export { InlineSignIn } from './components/InlineSignIn';
export type { InlineSignInProps } from './components/InlineSignIn';

// Icons
export { TerminalIcon, WifiIcon, WifiOffIcon, AlertTriangleIcon, RefreshIcon, KeyIcon, MinimizeIcon } from './components/Icons';

// Adapters
export { RestAdapter } from './adapters/RestAdapter';
export type { RestAdapterOptions } from './adapters/RestAdapter';
export { WebSocketAdapter } from './adapters/WebSocketAdapter';
export type { WebSocketAdapterOptions } from './adapters/WebSocketAdapter';
export type {
  TerminalAdapter,
  TerminalProtocol,
  ProtocolProfile,
  ProtocolColorProfile,
  ScreenData,
  ConnectionStatus,
  SendResult,
  ConnectConfig,
  Field,
  FieldValue,
} from './adapters/types';

// Hooks
export { useTypingAnimation } from './hooks/useTypingAnimation';
export {
  useTerminalConnection,
  useTerminalScreen,
  useTerminalInput,
} from './hooks/useTerminal';

// Protocols
export { getProtocolProfile } from './protocols/registry';
export { tn5250Profile } from './protocols/tn5250';
export { tn3270Profile } from './protocols/tn3270';
export { vtProfile } from './protocols/vt';
export { hp6530Profile } from './protocols/hp6530';

// Utilities
export { positionToRowCol, isFieldEntry } from './utils/grid';
export { getRowColorClass, parseHeaderRow } from './utils/rendering';
