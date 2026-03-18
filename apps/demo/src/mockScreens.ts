import type { ScreenData, TerminalProtocol } from 'green-screen-react'

function pad(line: string, cols: number): string {
  return line.padEnd(cols).slice(0, cols)
}

function buildScreen(lines: string[], rows: number, cols: number, cursorRow: number, cursorCol: number, fields?: ScreenData['fields']): ScreenData {
  const padded = Array.from({ length: rows }, (_, i) => pad(lines[i] ?? '', cols))
  return {
    content: padded.join('\n'),
    cursor_row: cursorRow,
    cursor_col: cursorCol,
    rows,
    cols,
    fields: fields ?? [{ row: cursorRow, col: cursorCol, length: cols - cursorCol, is_input: true, is_protected: false }],
  }
}

// ── TN5250 Screen Tree ──────────────────────────────────────

export interface MockScreenNode {
  screen: ScreenData
  /** Maps typed input (after Enter) to a screen id */
  inputNav?: Record<string, string>
  /** Maps F-key names to a screen id. '_back' = go to parent */
  keyNav?: Record<string, string>
  /** Parent screen id (for F3/F12 back navigation) */
  parent?: string
}

const R = 24, C = 80

// ── Root: IBM i Main Menu ──
const mainMenuLines = [
  '  MAIN                                                    SYSTEM1       ',
  '                          IBM i Main Menu                               ',
  '                                                                        ',
  '  Select one of the following:                                          ',
  '                                                                        ',
  '      1. User tasks                                                     ',
  '      2. Programming                                                    ',
  '      3. System status                                                  ',
  '                                                                        ',
  '     90. Sign off                                                       ',
  '                                                                        ',
  '                                                                        ',
  '                                                                        ',
  '                                                                        ',
  '                                                                        ',
  '                                                                        ',
  '                                                                        ',
  '                                                                        ',
  '                                                                        ',
  '  Selection or command                                                  ',
  '  ===>                                                                  ',
  '                                                                        ',
  '  F3=Exit   F4=Prompt   F9=Retrieve   F12=Cancel                        ',
  '  F13=Information Assistant   F23=Set initial menu                      ',
]

// ── User Tasks ──
const userTasksLines = [
  '  TASKS                                                   SYSTEM1       ',
  '                          User Tasks                                    ',
  '                                                                        ',
  '  Select one of the following:                                          ',
  '                                                                        ',
  '      1. Display messages                                               ',
  '      2. Send a message                                                 ',
  '      3. Work with printer output                                       ',
  '      4. Change your password                                           ',
  '                                                                        ',
  '                                                                        ',
  '                                                                        ',
  '                                                                        ',
  '                                                                        ',
  '                                                                        ',
  '                                                                        ',
  '                                                                        ',
  '                                                                        ',
  '                                                                        ',
  '  Selection or command                                                  ',
  '  ===>                                                                  ',
  '                                                                        ',
  '  F3=Exit   F4=Prompt   F9=Retrieve   F12=Cancel                        ',
  '                                                                        ',
]

// ── Display Messages ──
const displayMessagesLines = [
  '  DSPMSG                                                  SYSTEM1       ',
  '                       Display Messages                                 ',
  '                                                                        ',
  '  Messages for user:  QUSER                                             ',
  '                                                                        ',
  '  03/15/26  09:15:22  From: QSYSOPR                                    ',
  '    System backup completed successfully.                               ',
  '  03/15/26  08:30:05  From: ADMIN                                      ',
  '    Scheduled maintenance window: Sunday 02:00-06:00 AM.                ',
  '  03/14/26  16:45:33  From: QSYSOPR                                    ',
  '    Job QPADEV0001 submitted to job queue QBATCH.                       ',
  '  03/14/26  11:20:10  From: HELPDESK                                   ',
  '    Your ticket #4521 has been resolved.                                ',
  '                                                                        ',
  '                                                                        ',
  '                                                                        ',
  '                                                                        ',
  '                                                                        ',
  '                                                                        ',
  '                                                        Bottom           ',
  '  Press Enter to continue.                                              ',
  '                                                                        ',
  '  F3=Exit   F5=Refresh   F12=Cancel                                     ',
  '                                                                        ',
]

// ── Send a Message ──
const sendMessageLines = [
  '  SNDMSG                                                  SYSTEM1       ',
  '                       Send a Message                                   ',
  '                                                                        ',
  '  Type message, press Enter to send.                                    ',
  '                                                                        ',
  '  To user  . . . . . :                                                  ',
  '  Message  . . . . . :                                                  ',
  '                                                                        ',
  '                                                                        ',
  '                                                                        ',
  '                                                                        ',
  '                                                                        ',
  '                                                                        ',
  '                                                                        ',
  '                                                                        ',
  '                                                                        ',
  '                                                                        ',
  '                                                                        ',
  '                                                                        ',
  '                                                                        ',
  '                                                                        ',
  '                                                                        ',
  '  F3=Exit   F5=Refresh   F12=Cancel                                     ',
  '                                                                        ',
]

// ── Programming ──
const programmingLines = [
  '  PROGRAM                                                 SYSTEM1       ',
  '                       Programming                                      ',
  '                                                                        ',
  '  Select one of the following:                                          ',
  '                                                                        ',
  '      1. PDM  - Programming Development Manager                         ',
  '      2. SEU  - Source Entry Utility                                     ',
  '      3. Work with objects                                              ',
  '                                                                        ',
  '                                                                        ',
  '                                                                        ',
  '                                                                        ',
  '                                                                        ',
  '                                                                        ',
  '                                                                        ',
  '                                                                        ',
  '                                                                        ',
  '                                                                        ',
  '                                                                        ',
  '  Selection or command                                                  ',
  '  ===>                                                                  ',
  '                                                                        ',
  '  F3=Exit   F4=Prompt   F9=Retrieve   F12=Cancel                        ',
  '                                                                        ',
]

// ── PDM ──
const pdmLines = [
  '  WRKMBRPDM                                               SYSTEM1       ',
  '               Work with Members Using PDM                              ',
  '                                                                        ',
  '  File  . . . . . :  QRPGLESRC                                         ',
  '    Library . . . :  MYLIB         Position to  . . . . .               ',
  '                                                                        ',
  '  Type options, press Enter.                                            ',
  '    2=Edit   4=Delete   5=Display   7=Rename   8=Display description    ',
  '                                                                        ',
  '  Opt  Member      Type        Text                                     ',
  '       CUSTMAINT   RPGLE       Customer maintenance program             ',
  '       ORDRENTRY   RPGLE       Order entry module                       ',
  '       RPTPRINT    RPGLE       Daily report printer                     ',
  '       UTLDATE     RPGLE       Date utility functions                   ',
  '                                                                        ',
  '                                                                        ',
  '                                                                        ',
  '                                                                        ',
  '                                                        Bottom           ',
  '  Selection or command                                                  ',
  '  ===>                                                                  ',
  '                                                                        ',
  '  F3=Exit   F5=Refresh   F6=Create   F12=Cancel                         ',
  '                                                                        ',
]

// ── SEU ──
const seuLines = [
  '  SEU                                                     SYSTEM1       ',
  '                  Source Entry Utility (SEU)                             ',
  '                                                                        ',
  '  Type choices, press Enter.                                            ',
  '                                                                        ',
  '  Source file  . . . :                                                   ',
  '    Library . . . . :  *LIBL                                            ',
  '  Source member  . . :                                                   ',
  '  Source type  . . . :                                                   ',
  '  Option  . . . . . :             B=Browse   E=Edit   P=Print           ',
  '                                                                        ',
  '                                                                        ',
  '                                                                        ',
  '                                                                        ',
  '                                                                        ',
  '                                                                        ',
  '                                                                        ',
  '                                                                        ',
  '                                                                        ',
  '                                                                        ',
  '                                                                        ',
  '                                                                        ',
  '  F3=Exit   F4=Prompt   F5=Refresh   F12=Cancel                         ',
  '                                                                        ',
]

// ── Work with Objects ──
const workObjectsLines = [
  '  WRKOBJ                                                  SYSTEM1       ',
  '                    Work with Objects                                    ',
  '                                                                        ',
  '  Library  . . . :  MYLIB                                               ',
  '                                                                        ',
  '  Type options, press Enter.                                            ',
  '    2=Change   4=Delete   5=Display   7=Rename   8=Description          ',
  '                                                                        ',
  '  Opt  Object      Type     Attribute   Text                            ',
  '       CUSTMAINT   *PGM     RPGLE       Customer maintenance            ',
  '       CUSTFILE    *FILE    PF          Customer master file             ',
  '       ORDFILE     *FILE    PF          Order detail file                ',
  '       RPTPRT      *PGM     RPGLE       Report printing                 ',
  '       MYLIB       *LIB                 Application library              ',
  '                                                                        ',
  '                                                                        ',
  '                                                                        ',
  '                                                        Bottom           ',
  '                                                                        ',
  '  Selection or command                                                  ',
  '  ===>                                                                  ',
  '                                                                        ',
  '  F3=Exit   F5=Refresh   F12=Cancel                                     ',
  '                                                                        ',
]

// ── System Status ──
const systemStatusLines = [
  '  WRKSYSSTS                                               SYSTEM1       ',
  '                     Work with System Status                            ',
  '                                                       03/15/26  15:30 ',
  '  % CPU used  . . . . . . :        12.4                                ',
  '  % DB capability  . . . :         45.2                                ',
  '  Elapsed time . . . . . :      08:15:33                               ',
  '  Jobs in system . . . . :           482                               ',
  '  % perm addresses  . . :          8.12                                ',
  '  % temp addresses  . . :          3.45                                ',
  '                                                                        ',
  '  System    Pool    Reserved   Max     -----DB------  ---Non-DB---      ',
  '  Pool      Size(M)  Size(M)  Active   Fault  Pages  Fault  Pages      ',
  '   1        2048.0     512.0    ***      .0     12.5    .0     3.2      ',
  '   2        4096.0       .0     125      .2     45.8    .1    18.4      ',
  '   3        1024.0       .0      35      .0      8.2    .0     2.1      ',
  '   4         512.0       .0      10      .0      1.5    .0      .4      ',
  '                                                                        ',
  '                                                                        ',
  '                                                                        ',
  '                                                        Bottom           ',
  '  Press Enter to continue.                                              ',
  '                                                                        ',
  '  F3=Exit   F5=Refresh   F12=Cancel                                     ',
  '                                                                        ',
]

// ── Sign Off ──
const signOffLines = [
  '                                                                        ',
  '                                                                        ',
  '                                                                        ',
  '                                                                        ',
  '                                                                        ',
  '                                                                        ',
  '                                                                        ',
  '                                                                        ',
  '                     System:   SYSTEM1                                  ',
  '                     Subsystem:QINTER                                   ',
  '                     Display:  QPADEV0001                               ',
  '                                                                        ',
  '                     You have been signed off.                          ',
  '                     Thank you for using the system.                    ',
  '                                                                        ',
  '                                                                        ',
  '                                                                        ',
  '                                                                        ',
  '                                                                        ',
  '                                                                        ',
  '                                                                        ',
  '                                                                        ',
  '                                                                        ',
  '                                                                        ',
]

// ── Build the Screen Tree ──

// Send Message has two input fields
const sendMsgFields: ScreenData['fields'] = [
  { row: 5, col: 24, length: 20, is_input: true, is_protected: false },
  { row: 6, col: 24, length: 50, is_input: true, is_protected: false },
]

// SEU has input fields
const seuFields: ScreenData['fields'] = [
  { row: 5, col: 22, length: 20, is_input: true, is_protected: false },
  { row: 6, col: 22, length: 20, is_input: true, is_protected: false },
  { row: 7, col: 22, length: 20, is_input: true, is_protected: false },
  { row: 8, col: 22, length: 20, is_input: true, is_protected: false },
  { row: 9, col: 22, length: 10, is_input: true, is_protected: false },
]

export const tn5250ScreenTree: Record<string, MockScreenNode> = {
  main: {
    screen: buildScreen(mainMenuLines, R, C, 20, 8),
    inputNav: { '1': 'userTasks', '2': 'programming', '3': 'systemStatus', '90': 'signOff' },
    keyNav: { 'F3': 'signOff' },
  },
  userTasks: {
    screen: buildScreen(userTasksLines, R, C, 20, 8),
    inputNav: { '1': 'displayMessages', '2': 'sendMessage', '3': 'printerOutput', '4': 'changePassword' },
    keyNav: { 'F3': '_back', 'F12': '_back' },
    parent: 'main',
  },
  displayMessages: {
    screen: buildScreen(displayMessagesLines, R, C, 20, 2),
    keyNav: { 'F3': '_back', 'F12': '_back', 'F5': '_self', 'ENTER': '_back' },
    parent: 'userTasks',
  },
  sendMessage: {
    screen: buildScreen(sendMessageLines, R, C, 5, 24, sendMsgFields),
    keyNav: { 'F3': '_back', 'F12': '_back', 'ENTER': '_back' },
    parent: 'userTasks',
  },
  printerOutput: {
    screen: buildScreen(userTasksLines, R, C, 20, 8), // reuse parent for stub
    keyNav: { 'F3': '_back', 'F12': '_back' },
    parent: 'userTasks',
  },
  changePassword: {
    screen: buildScreen(userTasksLines, R, C, 20, 8),
    keyNav: { 'F3': '_back', 'F12': '_back' },
    parent: 'userTasks',
  },
  programming: {
    screen: buildScreen(programmingLines, R, C, 20, 8),
    inputNav: { '1': 'pdm', '2': 'seu', '3': 'workObjects' },
    keyNav: { 'F3': '_back', 'F12': '_back' },
    parent: 'main',
  },
  pdm: {
    screen: buildScreen(pdmLines, R, C, 20, 8),
    keyNav: { 'F3': '_back', 'F12': '_back', 'F5': '_self', 'F6': '_self' },
    parent: 'programming',
  },
  seu: {
    screen: buildScreen(seuLines, R, C, 5, 22, seuFields),
    keyNav: { 'F3': '_back', 'F12': '_back', 'F4': '_self' },
    parent: 'programming',
  },
  workObjects: {
    screen: buildScreen(workObjectsLines, R, C, 20, 8),
    keyNav: { 'F3': '_back', 'F12': '_back', 'F5': '_self' },
    parent: 'programming',
  },
  systemStatus: {
    screen: buildScreen(systemStatusLines, R, C, 20, 2),
    keyNav: { 'F3': '_back', 'F12': '_back', 'F5': '_self', 'ENTER': '_self' },
    parent: 'main',
  },
  signOff: {
    screen: buildScreen(signOffLines, R, C, 23, 0),
    keyNav: { 'ENTER': 'main' },
  },
}

// Legacy single-screen export (kept for backward compat)
export const mockScreens: Record<TerminalProtocol, ScreenData> = {
  tn5250: tn5250ScreenTree.main.screen,
  tn3270: tn5250ScreenTree.main.screen,
  vt: tn5250ScreenTree.main.screen,
  hp6530: tn5250ScreenTree.main.screen,
}
